---
title: "0.2 · Why Is My Pod Stuck Pending? Looking into the failure path"
description: "The most common — and most expensive — GPU cluster question. The same 'Pending' can come from any of the four layers; here's how to find which one, before you waste money on the wrong fix."
date: "07/01/2026"
---

This is the second post in a series on GPU capacity and scheduling. [0.1](/blog/four-layer-capacity-model) drew the map — a GPU cluster as four stacked layers. This post puts the map to work on the single most common thing anyone ever says about a GPU cluster: *"my pod is stuck Pending."*

## TL;DR

`Pending` is one word for **four different problems**, one per layer:

- **L1** — there's no GPU pool at all (no reservation, quota is zero).
- **L2** — a node exists but isn't a schedulable, `Ready` node yet.
- **L4** — the pod's request can never fit any node (asks for 8 GPUs, or an affinity rule that matches nothing).
- **L3** — the GPUs are real and `Ready`, but they're all busy right now.

The catch: the scheduler often prints the **same line** — `Insufficient nvidia.com/gpu` — for several of these, so the message alone won't tell you which layer is broken. Each has a *different* fix at a *different* price, and one cheap follow-up question per layer tells them apart. Get it wrong and you can spend real money buying capacity you already had.

## Motivation: the cheap question before the expensive fix

No incident story here — this is foundational, and `Pending` is just the everyday symptom the four-layer map is most useful for. The pattern is real though: "my pod is Pending" sends three people in three directions at once. The capacity owner checks the reservation, the platform engineer restarts the autoscaler, the ML engineer re-reads their YAML — and only one of them is looking at the right layer. The point of this post is to spend thirty seconds finding *which* layer before anyone touches anything.

## Before we start

You'll want to know roughly what a pod and a node are, and that a GPU is a *requestable* resource (`limits: nvidia.com/gpu`). Everything below runs on `kind` (Kubernetes inside Docker) with GPUs *faked* onto the nodes — no GPU hardware, no specific scheduler. By the end you should have a four-question triage you can run in about a minute.

## The mental model: a triage tree

When a pod is `Pending`, walk down — the first "no" is your layer. Each step is one cheap, read-only question:

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

**Why this order?** Each question is cheaper and more certain than the next. *Is there a GPU at all?* and *is the node usable?* are static facts you read straight off `kubectl get nodes` in one shot. *Could this pod ever fit?* is still static — just compare the request to what a node offers. Only the last question, contention, needs you to look at **live** cluster state (what's running right this second). It's also the only cause where the cluster is actually healthy and the fix *costs something* — wait, preempt, or buy more. So you rule out the cheap, structural causes first and conclude "it's just busy" only after the other three are out. Skip the order and you risk "fixing" contention by buying capacity you already had.

| Layer | Cause of `Pending` | The one cheap question | What "no" tells you |
|-------|--------------------|------------------------|---------------------|
| **L1 capacity** | no pool at all | `get nodes`: any GPU anywhere? | nothing to schedule onto — you need capacity (or quota) |
| **L2 provisioning** | node not `Ready`/schedulable | `get nodes`: `Ready`? `SchedulingDisabled`? | capacity exists but isn't usable yet — fix the node, not the pool |
| **L4 workload** | request can't fit any node | request vs node capacity; selector | the YAML is wrong — no amount of capacity helps |
| **L3 scheduling** | GPUs exist but all busy | `get pods -o wide`: others Running? | it's contention — wait, preempt, or add capacity |

## The four causes, walked

**L1 — no pool.** The cluster has no GPU to offer at all: no reservation has been turned into GPU-bearing nodes, or your quota is zero. In the cloud this is `InsufficientInstanceCapacity` / `ZONE_RESOURCE_POOL_EXHAUSTED` / quota 0. The tell is that `kubectl get nodes` shows **no GPU on any node** — there's nothing to grow onto. Fixing this means getting capacity; restarting things won't help.

**L2 — no ready node.** Capacity exists, but the node carrying it isn't a usable `Ready` node *right now* — it's still booting, `NotReady`, cordoned, or draining, or its GPU device plugin hasn't advertised the GPUs yet. The GPU is "there" but the scheduler can't use it. The fix is at the node, not the pool.

**L4 — impossible request.** The pod asks for something **no single node can ever satisfy**: 8 GPUs when the largest node has 1, or a `nodeSelector`/affinity that matches no node. This one stays `Pending` *even on a completely idle cluster* — which is exactly how you spot it. No amount of extra capacity fixes a request that can't fit; the YAML is the bug.

**L3 — contention.** The honest case: GPUs exist, nodes are `Ready`, the request is reasonable — they're just all **busy**. Other pods are `Running` on the GPUs and yours waits its turn. This is the only one of the four where "add capacity," "wait," or "preempt something" are the right moves — and it's the one most often *mistaken* for L1.

## One concept you need first before the demo: taints

The scheduler messages below are full of the word *taint*, so it's worth thirty seconds up front.

A **taint** is a mark on a *node* that says "don't put pods here unless they explicitly say they're OK with it." A pod opts in by carrying a matching **toleration**. No toleration → the scheduler refuses to place that pod on that node. Taints are how Kubernetes keeps certain nodes clear of ordinary work.

Two taints show up in this post, and both are set for you *implicitly* — which is exactly why they're confusing the first time:

- **A node's role can imply a taint.** The control-plane node is automatically tainted `node-role.kubernetes.io/control-plane:NoSchedule` so that ordinary workloads stay off it. Our GPU pods don't tolerate that taint, so the control-plane is *always* excluded for them. That is the `1 node(s) had untolerated taint(s)` clause you'll see in every message below — that one node is the control-plane.
- **`cordon` sets a taint.** `kubectl cordon <node>` marks a node unschedulable; under the hood it adds the taint `node.kubernetes.io/unschedulable:NoSchedule` and the node starts showing as `Ready,SchedulingDisabled`. New pods won't be placed there (pods already running stay put). `kubectl uncordon <node>` removes it. This is the everyday way operators take a node out of rotation without killing what's on it.

So when the scheduler says `0/N nodes are available: ...`, it is listing **every reason each node was ruled out for the one pod it's trying to place** — untolerated taints included. Keep that in mind: those counts are always *about a single pending pod*, not a tally of how many pods failed.

## Demo: break a cluster four ways

We'll manufacture each cause on one small cluster, in the **same order you'd triage them** — no pool (L1), no usable node (L2), impossible request (L4), real contention (L3). Every command and output below is from a real run (`kind` v0.32, Kubernetes v1.36.1); GPUs are faked onto the nodes, so this needs no hardware.

Every scheduler message below starts with `1 node(s) had untolerated taint(s)` — that's the control-plane, excluded by its role taint (see the primer above). The clause that *changes* between causes is the rest of the line, so that's what to read. (I've trimmed the trailing `preemption: ...` text to `…` for width.)

**Setup — a 3-node cluster (1 control-plane + 2 workers).**

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

**Cause L1 — no GPU anywhere.** Fresh `kind` nodes advertise no GPUs, so this *is* the "no pool" state. Check, then submit a pod that wants one GPU:

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

The node table is the whole story: `GPU` is `<none>` everywhere. There is nothing to schedule onto. Remember the message — `2 Insufficient nvidia.com/gpu` — because you'll see it again for completely different reasons.

**Cause L2 — node not schedulable.** Now give each worker a GPU (standing in for the device plugin advertising it once the reserved instance is up), then `cordon` both — capacity exists, but the nodes won't accept work:

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

A *different* message — `2 node(s) were unschedulable`. That's the cordon taint talking: `kubectl get nodes` shows the two workers as `Ready,SchedulingDisabled`, so the scheduler skips them even though their GPUs exist. The capacity is real; the nodes just aren't in rotation. Put them back so the next two causes have somewhere to run, and clean up this pod:

```bash
kubectl uncordon pending-worker pending-worker2
kubectl delete pod l2-unschedulable
```

**Cause L4 — a request that can't fit.** The cluster is now idle with two free GPUs. Ask for 8 GPUs when no node has more than 1:

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

`2 Insufficient nvidia.com/gpu` *again* — the same line L1 printed with no GPUs at all. But the cluster is completely idle, and this pod will stay `Pending` forever: nothing is busy, the request itself just can't fit on a 1-GPU node. The "idle but still Pending" is the tell. A different flavor of impossible request — an affinity rule matching no node — announces itself more clearly:

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

Clear these and move to the last cause:

```bash
kubectl delete pod l4-too-big l4-bad-affinity
```

**Cause L3 — contention.** Both GPUs are real, `Ready`, and free. Submit three one-GPU pods for two GPUs:

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

Read the two outputs together, because this is where people get confused:

- `kubectl get pods -o wide` is the **outcome**: `trn-a` and `trn-b` each grabbed a GPU and are `Running`; only `trn-c` is `Pending`. Scheduling did **not** fail across the board — two of the three pods placed fine.
- The `Events` block is from `describe pod trn-c` — it's the scheduler explaining why it couldn't place **`trn-c` specifically**. `0/3 nodes are available` means *for this one pod*, none of the three nodes works: the control-plane is off-limits (its role taint), and each of the two workers has its single GPU already taken by `trn-a`/`trn-b`. A whole GPU is reserved per pod — stock Kubernetes doesn't split one GPU across pods (that needs MIG / MPS / time-slicing, a later post) — so two pods fill two GPUs and the third has nowhere to go.

And notice the line again: `2 Insufficient nvidia.com/gpu` — *identical* to L1, where there were no GPUs at all. The only thing that tells them apart is `get pods`: here the GPUs exist and are busy; in L1 they were absent.

```bash
kind delete cluster --name pending     # clean up
```

**What you just watched, in triage order:**

| Cause | What we did | What the scheduler said |
|---|---|---|
| **L1** no pool | submit 1-GPU pod, no GPUs anywhere | `2 Insufficient nvidia.com/gpu` |
| **L2** node not schedulable | `cordon` the GPU nodes | `2 node(s) were unschedulable` |
| **L4** impossible request | ask for 8 GPUs / bad selector (idle cluster) | `2 Insufficient nvidia.com/gpu` / `didn't match Pod's node affinity/selector` |
| **L3** contention | 3 one-GPU pods, 2 GPUs, both busy | `2 Insufficient nvidia.com/gpu` |

Three of the four printed the same `Insufficient nvidia.com/gpu` line. The message tells you the scheduler couldn't place the pod — it does *not* tell you why. The triage tree does: one read-only `get nodes` / `get pods -o wide` question per layer separates causes the message itself blurs together.

## What it buys you: the meter never stops

GPU capacity bills by the hour whether or not anything runs on it. A reserved pool — or even one high-end accelerator — costs the same sitting at 0% as it does flat out; idle time is just money you've already committed and gotten nothing back for. So the real price of a `Pending` pod isn't the stuck job. It's the capacity sitting underneath it, earning nothing, for every minute you spend guessing why.

That's what a structured triage actually buys: it shortens that meter-running minute, *and* it stops you paying twice. The expensive way to debug `Pending` is to guess the layer. Read L3 (busy GPUs) as L1 (no GPUs) — easy, since they print the same line — and you "fix" it by buying more capacity you already had, so now you're paying for two idle pools instead of one. Read L1 as L3 and you spend an afternoon tuning a scheduler that was never the bottleneck while the reserved pool keeps burning. A defined four-question pass turns *"something's wrong, page everyone"* into *"it's L2, the node's cordoned"* in under a minute — and that minute matters precisely because the bill doesn't pause while you think.

This is the seam from [0.1](/blog/four-layer-capacity-model) showing its teeth: a paid reservation can sit `Pending` at L1 — billed, never turned into a schedulable node — while the capacity team's dashboard says "active, $X/hr," the platform team's says "N pods Pending," and *no* dashboard shows the idle dollars in between. Naming the stuck layer in a minute, instead of arguing for an hour, is the cheapest money-saving move you have before you've changed anything at all.

## Recap

`Pending` is four problems wearing one word — no pool (L1), no ready node (L2), an impossible request (L4), or plain contention (L3) — and the scheduler's message often can't tell them apart. Walk the tree in order, ask the one cheap question at each layer, and you'll know which one you have before you spend anything fixing the wrong one. The next posts go down into each layer in turn.

---

*This is a personal blog — opinions are mine, not my employer's, and everything here is based on publicly documented features.*
