---
title: "0.2 · Why Is My Pod Stuck Pending? Looking into the failure path"
description: "The same 'Pending' can come from any of the four layers. The scheduler often prints the same line for all of them, so the message alone won't tell you which one is broken."
date: "07/01/2026"
---

This is the second post in a series on GPU capacity and scheduling. [0.1](/blog/four-layer-capacity-model) drew the map. This post puts it to work on the single most common thing anyone says about a GPU cluster: *"my pod is stuck Pending."*

## TL;DR

`Pending` is one word for **four different problems**, one per layer. The scheduler often prints the same line for several of them, so the message won't tell you which layer is broken. Each layer has a different fix at a different cost. A structured triage, one cheap read-only question per layer, separates them in under a minute.

## Motivation

`Pending` tells us that the scheduler has not placed a pod. It does not tell us why. The cluster may have no GPU capacity, a GPU node may be unusable, the request may be impossible for any node shape, or every suitable GPU may simply be busy.

Those cases need different owners and different fixes. Before restarting an autoscaler, changing YAML, preempting work, or adding capacity, the first task is to identify the layer. The triage below does that with one read-only question per layer.

## Prerequisites

You'll want to know roughly what a pod and a node are, and that a GPU is a requestable resource (`limits: nvidia.com/gpu`). Everything below runs on `kind` (Kubernetes inside Docker) with GPUs faked onto the nodes. No GPU hardware, no specific scheduler.

## The triage tree

When a pod is `Pending`, walk down. The first "no" is your layer. Each step is one cheap, read-only question:

```
                          pod stuck Pending
                                 │
        ┌────────────────────────▼───────────────────────────┐
        │ Is there a GPU on ANY node?                          │── no ─▶  L1  no pool / no capacity
        │   kubectl get nodes -o ...nvidia.com/gpu             │         (cloud: InsufficientInstanceCapacity, quota 0)
        └────────────────────────┬───────────────────────────┘
                                 │ yes
        ┌────────────────────────▼───────────────────────────┐
        │ Are the GPU nodes Ready & schedulable?               │── no ─▶  L2  node NotReady / cordoned / draining
        │   kubectl get nodes   (Ready? SchedulingDisabled?)   │
        └────────────────────────┬───────────────────────────┘
                                 │ yes
        ┌────────────────────────▼───────────────────────────┐
        │ Could this pod EVER fit one node?                    │── no ─▶  L4  impossible request
        │   request ≤ a node's capacity? selector matches?    │         (8 GPUs on 1-GPU nodes; bad nodeSelector)
        └────────────────────────┬───────────────────────────┘
                                 │ yes
        ┌────────────────────────▼───────────────────────────┐
        │ Are the GPUs simply busy right now?                  │── yes ▶  L3  contention
        │   kubectl get pods -o wide  (others Running on them) │
        └──────────────────────────────────────────────────────┘
```

**Why this order?** The first two questions are static facts you read off `kubectl get nodes` in one shot. The third is still static: compare the request to what a node offers. Only the last question needs live cluster state. It is the only cause where the existing cluster is healthy and the question is how to handle contention: wait, preempt, or add capacity. Rule out structural causes first; conclude "just busy" only after the other three are gone.

| Layer | Cause of `Pending` | The one cheap question | What "no" tells you |
|-------|--------------------|------------------------|---------------------|
| **L1 capacity** | no pool at all | `get nodes`: any GPU anywhere? | nothing to schedule onto |
| **L2 provisioning** | node not `Ready`/schedulable | `get nodes`: `Ready`? `SchedulingDisabled`? | capacity exists but isn't usable yet |
| **L4 workload** | request can't fit any node | request vs node capacity; selector | the YAML is wrong |
| **L3 scheduling** | GPUs exist but all busy | `get pods -o wide`: others Running? | contention: wait, preempt, or add capacity |

## The four causes

**L1: no pool.** The cluster has no GPU to offer at all. No reservation has been turned into GPU-bearing nodes, or your quota is zero. In the cloud this is `InsufficientInstanceCapacity` / `ZONE_RESOURCE_POOL_EXHAUSTED` / quota 0. The tell: `kubectl get nodes` shows no GPU on any node. Restarting things won't help; you need capacity.

**L2: no ready node.** Capacity exists, but the node carrying it isn't usable right now. It's still booting, `NotReady`, cordoned, or draining, or the GPU device plugin hasn't advertised the GPUs yet. The GPU is "there" but the scheduler can't use it. The fix is at the node, not the pool.

**L4: impossible request.** The pod asks for something no single node can satisfy: 8 GPUs when the largest node has 1, or a `nodeSelector` that matches nothing. This stays `Pending` even on a completely idle cluster, which is exactly how you spot it. Adding more nodes of the same shape will not fix a request that cannot fit one node.

**L3: contention.** GPUs exist, nodes are `Ready`, the request is reasonable. They're all busy. Other pods are `Running` on the GPUs and yours waits its turn. **This is the case where existing capacity is healthy but insufficient for current demand.** Waiting, preempting lower-priority work, or adding capacity can resolve it. It is also the case most often mistaken for L1.

## Taints (needed for the demo output)

The scheduler messages below mention taints, so a quick primer.

A **taint** is a mark on a node that says "don't place pods here unless they carry a matching toleration." Two taints appear in this post:

- **Control-plane role taint.** The control-plane node is automatically tainted `node-role.kubernetes.io/control-plane:NoSchedule`. Our GPU pods don't tolerate it, so the control-plane is always excluded. That is the `1 node(s) had untolerated taint(s)` clause in every message below.
- **Cordon taint.** `kubectl cordon <node>` adds `node.kubernetes.io/unschedulable:NoSchedule` and the node shows `Ready,SchedulingDisabled`. New pods won't be placed there; running pods stay put. `kubectl uncordon` removes it.

When the scheduler says `0/N nodes are available: ...`, it lists every reason each node was ruled out **for the one pod it's trying to place**. Those counts are per-pod, not aggregate.

## Demo: break a cluster four ways

We manufacture each cause on one small cluster, in triage order: no pool (L1), no usable node (L2), impossible request (L4), real contention (L3). Every command and output below is from a real run (kind v0.32, Kubernetes v1.36.1); GPUs are faked onto the nodes, so no hardware is needed.

Every scheduler message starts with `1 node(s) had untolerated taint(s)` (the control-plane, excluded by its role taint). The clause that changes between causes is the rest of the line. Trailing `preemption: ...` text is trimmed to `…` for width.

**Setup: a 3-node cluster (1 control-plane + 2 workers).**

```bash
cat > kind-pending.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF

kind create cluster --name pending --config kind-pending.yaml
kubectl wait --for=condition=Ready nodes --all --timeout=120s
```

```
node/pending-control-plane condition met
node/pending-worker condition met
node/pending-worker2 condition met
```

**L1: no GPU anywhere.** Fresh nodes advertise no GPUs, so this already *is* the "no pool" state:

```bash
kubectl get nodes -o 'custom-columns=NODE:.metadata.name,GPU:.status.capacity.nvidia\.com/gpu'
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: l1-no-capacity }
spec:
  containers:
  - name: c
    image: busybox
    command: ["sh","-c","sleep 3600"]
    resources: { limits: { nvidia.com/gpu: "1" } }
EOF
kubectl describe pod l1-no-capacity | sed -n '/Events:/,$p'
```

```
NODE                    GPU
pending-control-plane   <none>
pending-worker          <none>
pending-worker2         <none>

Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  4s    default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient nvidia.com/gpu. …
```

The node table tells the story: `GPU` is `<none>` everywhere. There is nothing to schedule onto. Remember the message, `2 Insufficient nvidia.com/gpu`, because you'll see it again for different reasons.

**L2: node not schedulable.** Give each worker a GPU (standing in for the device plugin), then cordon both. Capacity exists, but the nodes won't accept work:

```bash
for n in pending-worker pending-worker2; do
  kubectl patch node "$n" --subresource=status --type=json \
    -p '[{"op":"add","path":"/status/capacity/nvidia.com~1gpu","value":"1"}]'
  kubectl wait --for=jsonpath='{.status.allocatable.nvidia\.com/gpu}'=1 node/"$n" --timeout=30s
  kubectl cordon "$n"
done
kubectl get nodes
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: l2-unschedulable }
spec:
  containers:
  - name: c
    image: busybox
    command: ["sh","-c","sleep 3600"]
    resources: { limits: { nvidia.com/gpu: "1" } }
EOF
kubectl describe pod l2-unschedulable | sed -n '/Events:/,$p'
```

```
NAME                    STATUS                     ROLES           AGE   VERSION
pending-control-plane   Ready                      control-plane   35s   v1.36.1
pending-worker          Ready,SchedulingDisabled   <none>          21s   v1.36.1
pending-worker2         Ready,SchedulingDisabled   <none>          21s   v1.36.1

Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  4s    default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) were unschedulable. …
```

A different message: `2 node(s) were unschedulable`. The two workers show `Ready,SchedulingDisabled`, so the scheduler skips them even though their GPUs exist. Put them back and clean up:

```bash
kubectl uncordon pending-worker pending-worker2
kubectl delete pod l2-unschedulable
```

**L4: a request that can't fit.** The cluster is idle with two free GPUs. Ask for 8 GPUs when no node has more than 1:

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: l4-too-big }
spec:
  containers:
  - name: c
    image: busybox
    command: ["sh","-c","sleep 3600"]
    resources: { limits: { nvidia.com/gpu: "8" } }
EOF
kubectl describe pod l4-too-big | sed -n '/Events:/,$p'
```

```
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  4s    default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient nvidia.com/gpu. …
```

`2 Insufficient nvidia.com/gpu` again, the same line L1 printed with no GPUs at all. But the cluster is completely idle, and this pod will stay `Pending` forever: the request can't fit on a 1-GPU node. A different flavor of impossible request (bad affinity) announces itself more clearly:

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: l4-bad-affinity }
spec:
  nodeSelector: { disktype: ssd-nonexistent }
  containers:
  - name: c
    image: busybox
    command: ["sh","-c","sleep 3600"]
    resources: { limits: { nvidia.com/gpu: "1" } }
EOF
kubectl describe pod l4-bad-affinity | sed -n '/Events:/,$p'
```

```
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  5s    default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match Pod's node affinity/selector. …
```

Clean up:

```bash
kubectl delete pod l4-too-big l4-bad-affinity
```

**L3: contention.** Both GPUs are real, `Ready`, and free. Submit three one-GPU pods for two GPUs:

```bash
for p in trn-a trn-b trn-c; do
  kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata: { name: $p }
spec:
  containers:
  - name: c
    image: busybox
    command: ["sh","-c","sleep 3600"]
    resources: { limits: { nvidia.com/gpu: "1" } }
EOF
done
kubectl get pods -o wide
kubectl describe pod trn-c | sed -n '/Events:/,$p'
```

```
NAME    READY   STATUS    RESTARTS   AGE   NODE
trn-a   1/1     Running   0          12s   pending-worker2
trn-b   1/1     Running   0          12s   pending-worker
trn-c   0/1     Pending   0          12s   <none>

Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  11s   default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient nvidia.com/gpu. …
```

Two things to read together:

- `kubectl get pods -o wide` shows the outcome: `trn-a` and `trn-b` each grabbed a GPU and are `Running`. Only `trn-c` is `Pending`. Scheduling didn't fail across the board.
- The `Events` block is from `describe pod trn-c`. It explains why the scheduler couldn't place **this one pod**: the control-plane is off-limits (role taint), and each worker's single GPU is already taken. A whole GPU is reserved per pod (stock Kubernetes doesn't split one GPU across pods; that needs MIG/MPS/time-slicing, a later post), so two pods fill two GPUs and the third has nowhere to go.

The line is `2 Insufficient nvidia.com/gpu`, identical to L1. The only thing that tells them apart is `get pods -o wide`: here the GPUs exist and are busy; in L1 they were absent.

```bash
kind delete cluster --name pending
```

**Summary of all four causes:**

| Cause | What we did | What the scheduler said |
|---|---|---|
| **L1** no pool | submit 1-GPU pod, no GPUs anywhere | `2 Insufficient nvidia.com/gpu` |
| **L2** not schedulable | `cordon` the GPU nodes | `2 node(s) were unschedulable` |
| **L4** impossible request | ask for 8 GPUs / bad selector (idle cluster) | `2 Insufficient nvidia.com/gpu` / `didn't match Pod's node affinity/selector` |
| **L3** contention | 3 one-GPU pods, 2 GPUs, both busy | `2 Insufficient nvidia.com/gpu` |

Three of the four printed the same `Insufficient nvidia.com/gpu` line. The message tells you the scheduler couldn't place the pod. It does not tell you why. The triage tree does: one read-only question per layer separates causes the message blurs together.

## Why this matters: the meter never stops

GPU capacity bills by the hour whether or not anything runs on it. A reserved pool costs the same sitting idle as it does flat out. So the real price of a `Pending` pod isn't the stuck job. It's the capacity underneath it, earning nothing, for every minute you spend guessing which layer is broken.

Misidentifying the layer is how you pay twice. Read L3 (busy GPUs) as L1 (no GPUs), and you buy capacity you already had, paying for two idle pools instead of one. Read L1 as L3 and you spend an afternoon tuning a scheduler that was never the bottleneck while the reserved pool keeps burning.

This is the seam from [0.1](/blog/four-layer-capacity-model): **a paid reservation can sit billed at L1, never turned into a schedulable node**, while the capacity team's dashboard says "active, $X/hr," the platform team's says "N pods Pending," and no dashboard shows the idle dollars in between. Naming the stuck layer in a minute is the cheapest money-saving move you have before you've changed anything.

## What's next

The next posts go down into each layer in turn.

---

*This is a personal blog. Opinions are mine, not my employer's, and everything here is based on publicly documented features.*
