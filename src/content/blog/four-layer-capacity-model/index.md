---
title: "0.1 · The 4-Layer Mental Model for AI Compute"
titleZh: "算力层的四层心智模型"
description: "A simple model that splits a compute cluster into four layers: reservation, provisioning, scheduling, and workload. The model turns 'my pod is Pending' into a diagnosis instead of a three-team argument."
date: "06/29/2026"
---

The rest of this series uses the same split between capacity supply, provisioning, scheduling, and the workload itself.

## TL;DR

A pod being `Pending` is a scheduler state, not a diagnosis. The underlying problem may be missing capacity, a node that never became usable, contention among schedulable workloads, or a request that cannot fit any node. The **four-layer model** separates those cases so you know which system to inspect before changing anything.

## Motivation

"My pod is Pending" sounds like a scheduling problem. Often it only means the scheduler is where an upstream or downstream problem became visible:

- **L1 capacity:** the required hardware was never available
- **L2 provisioning:** the capacity exists, but no usable node came online
- **L3 scheduling:** suitable nodes exist, but their GPUs are busy or fragmented
- **L4 workload:** the request cannot fit any available node shape

The symptom is shared, but the owners and fixes are different. The model gives each failure a place before the investigation begins. The next post, [0.2](/blog/why-is-my-pod-pending), applies it step by step.

## Prerequisites

You'll get the most from this if you know roughly what a Kubernetes pod and node are, and that a GPU is a *requestable* resource. No specific scheduler required; the demo runs on `kind` + any container runtime (Docker / Podman / Colima) with no GPU hardware.

## The model

```
                         WHAT IT IS              FAILS LOOK LIKE
  ┌─────────────────────────────────────────────────────────────────────┐
  │ L4  WORKLOAD          the training / inference   "loss diverged",     │
  │     (consumes GPUs)   job that burns the GPU      OOM, NCCL hang      │
  ├─────────────────────────────────────────────────────────────────────┤
  │ L3  SCHEDULING        place / share / preempt      pod Pending:       │
  │     (the scheduler)   units of work onto nodes     "no node fits"     │
  ├─────────────────────────────────────────────────────────────────────┤
  │ L2  PROVISIONING      turn the pool into            node NotReady,    │
  │     (autoscaler)      actual running machines       launch stuck      │
  ├─────────────────────────────────────────────────────────────────────┤
  │ L1  CAPACITY SUPPLY   the reserved pool of          "no capacity",    │
  │     (reservations)    hardware you can claim        alloc errors      │
  └─────────────────────────────────────────────────────────────────────┘
            ▲                                                    │
            └──────── the SEAM (L1 ↔ L3): pool ⇄ schedulable ────┘
                      where paid-for capacity goes idle
```

Read bottom-up; that is the direction capacity actually flows:

| Layer | Noun | Question it answers | Who owns it (typically) |
|-------|------|---------------------|--------------------------|
| **L1 Capacity supply** | a *reserved pool* | "Do I have a claim on hardware at all?" | capacity / FinOps |
| **L2 Provisioning** | a *running machine* | "Is that claim a live, Ready node?" | platform / autoscaler |
| **L3 Scheduling** | a *unit of work* | "Will this pod be placed on a node?" | scheduler / platform |
| **L4 Workload** | the *job* | "Is the placed work actually correct & efficient?" | the ML team |

**The symptom almost always shows up at L3** ("my pod is Pending") regardless of which layer is actually broken. L3 is the messenger. The model is how you stop blaming the messenger.

## Walking the layers

**L1, Capacity supply.** The *right to hardware*, not hardware running. A reservation, a capacity block, a quota grant. You can be billed at L1 while having nothing at L2: a reserved pool that is "active" but has no running nodes is pure cost with zero capability. Failures here sound like "insufficient capacity" (AWS `InsufficientInstanceCapacity`, GCP `ZONE_RESOURCE_POOL_EXHAUSTED`, Azure `AllocationFailed`) or simply "quota is zero."

**L2, Provisioning.** Converts a claim into a `Ready` node. An autoscaler asks L1 for machines and waits 30s to 5 min for them to boot, join the cluster, and pass health checks. Failures: nodes stuck `NotReady`, GPU driver or device-plugin not installed, launch hanging. From L3's point of view, a node mid-provision *does not exist*.

**L3, Scheduling.** Given Ready nodes, decide which pod goes where: filter (which nodes *can* fit), score (which is *best*), bind. This is where the rich problems live (gang scheduling, fairness, preemption, topology) and it is the subject of most of this series. But **L3 can only place work onto nodes that L2 actually produced from L1's pool.** It cannot conjure capacity.

**L4, Workload.** The job itself: parallelism, checkpointing, KV-cache, batching. A perfectly scheduled job can still leave a large share of the GPU's FLOPS on the floor. Model FLOPs Utilization (MFU) well below 1.0 is normal; even well-tuned large training runs often land around **40-55%**. That is an L4/efficiency problem, not a scheduling one.

**The L1↔L3 gap.** These two layers are usually owned by different teams with different dashboards. L1's says "reservation active, $X/hr." L3's says "N pods Pending." Neither shows the gap *between* them: paid capacity that never became schedulable. It is easy for everyone to miss because no single layer owns it.

### Where the model leaks

Two caveats so the model doesn't mislead on the edges:

- **DaemonSets and static pods don't play the L3 game.** They are placed on every (or a specific) node by design, bypassing the filter/score contest. The "every symptom shows up at L3 as Pending" rule applies to *user workloads* competing for scarce GPUs, not system pods.
- **Dynamic Resource Allocation (DRA) blurs L2 and L3.** As DRA matures in Kubernetes (structured-parameter resource claims), some allocation decisions that this model puts at L2/provisioning happen *during* scheduling. The four layers are still useful; just know the L2↔L3 boundary is getting fuzzier.

If your problem lives in one of these corners, the model points you to the right neighborhood and then steps aside.

## Demo: all four layers on a laptop

This runs on `kind` (Kubernetes inside Docker) with GPUs *faked* onto the nodes. No real hardware. The goal is to see the four layers as four *separate, observable things*. Every command and output below is from a real run (kind v0.32, Kubernetes v1.36.1).

The key choice: a **multi-node** cluster, so the scheduler has nodes to *choose between* and L3 becomes visible rather than implied.

**Setup: a 3-node cluster (1 control-plane + 2 workers).**

```bash
cat > kind-layers.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF

kind create cluster --name layers --config kind-layers.yaml
kubectl wait --for=condition=Ready nodes --all --timeout=90s
```

```
node/layers-control-plane condition met
node/layers-worker condition met
node/layers-worker2 condition met
```

Three machines, zero GPUs. (If a later `apply` says `serviceaccount "default" not found`, the cluster is still booting; wait a few seconds and retry.)

**L1, Capacity supply: the reservation.** Before any GPU exists, you hold a *reservation*: a claim on hardware that has not been turned into a running, usable node yet. In the cloud this is an AWS Capacity Block for ML, a GCP future/calendar reservation, or an Azure capacity reservation. For scarce parts like H200 or GB200, you generally **cannot launch a GPU at all without one**. `kind` has no reservation primitive, so the reservation here is represented by the fact that workers *exist* but advertise zero schedulable GPUs:

```bash
WORKER=$(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' \
          -o jsonpath='{.items[0].metadata.name}')
kubectl get node "$WORKER" -o jsonpath='gpu=[{.status.capacity.nvidia\.com/gpu}]{"\n"}'
```

```
gpu=[]
```

The node is there (the reservation is held) but it offers no GPU yet. This is the gap where a paid reservation can sit burning money: you hold H200s but nothing is schedulable on them.

**L2, Provisioning: turn the reservation into a schedulable GPU.** In the cloud, an autoscaler launches the reserved instance, it joins the cluster, and its device plugin advertises GPUs to Kubernetes. That is the step that makes reserved capacity actually *schedulable*. Here we stand in for the device plugin by advertising one GPU on each worker:

```bash
for n in $(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' \
            -o jsonpath='{.items[*].metadata.name}'); do
  kubectl patch node "$n" --subresource=status --type=json \
    -p '[{"op":"add","path":"/status/capacity/nvidia.com~1gpu","value":"1"}]'
done

kubectl get node "$WORKER" -o jsonpath='gpu=[{.status.capacity.nvidia\.com/gpu}]{"\n"}'
```

```
node/layers-worker patched
node/layers-worker2 patched
gpu=[1]
```

That `gpu=[]` to `gpu=[1]` flip *is* the L1-to-L2 boundary: a reservation existing versus a node actually offering a GPU the scheduler can place work on. Two workers, one schedulable GPU each.

**L3, Scheduling: the scheduler chooses where each pod runs.** Submit three pods, each asking for one GPU:

```bash
for p in trainer-a trainer-b trainer-c; do
  kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $p
spec:
  containers:
  - name: c
    image: busybox
    command: ["sh", "-c", "sleep 3600"]
    resources:
      limits:
        nvidia.com/gpu: 1
EOF
done

kubectl get pods -o wide
```

```
NAME        READY   STATUS    NODE
trainer-a   1/1     Running   layers-worker2
trainer-b   1/1     Running   layers-worker
trainer-c   0/1     Pending   <none>
```

Two GPUs across two nodes; the scheduler placed `trainer-a` and `trainer-b` on *different* workers and left `trainer-c` Pending because both GPUs are taken. Placement and Pending are two faces of the same layer: it puts work where capacity is, and refuses when there is none.

**L4, Workload: run work inside a running pod.** A pod is the slot the scheduler filled; the workload is whatever runs in that slot. We exec into the pod that was already placed (no rescheduling), since the workload just runs in the slot the pod claimed:

```bash
kubectl exec trainer-a -- sh -c 'echo "[trainer-a] $(date +%H:%M:%S) starting"; for i in 1 2 3; do echo "[trainer-a] step $i"; sleep 1; done; echo "[trainer-a] $(date +%H:%M:%S) done"'
```

```
[trainer-a] 14:53:58 starting
[trainer-a] step 1
[trainer-a] step 2
[trainer-a] step 3
[trainer-a] 14:54:01 done
```

The placement decision (L3) happened once, when the pod was created; the workload just runs inside. `kubectl get pods` still shows `trainer-a` and `trainer-b` as `Running`. (The other common pattern is a Kubernetes `Job`, which creates its own fresh pod, runs to completion, and reports `Complete`. Same four layers; a Job bundles "schedule a new pod" and "run the work" into one object, where `exec` lets us observe them separately.)

```bash
kind delete cluster --name layers
```

**Summary of observable outputs:**

| Layer | What we did | What it looked like |
|---|---|---|
| **L1** capacity supply | held a reservation (node exists, GPU not schedulable) | `gpu=[]` |
| **L2** provisioning | device plugin advertises the GPU | `gpu=[]` to `gpu=[1]` |
| **L3** scheduling | scheduler placed pods, refused the 3rd | `trainer-a`→worker2, `trainer-b`→worker, `trainer-c` Pending |
| **L4** workload | ran work inside the running pod (exec) | timestamps + 3 steps; pod stayed Running |

## Where each layer lives in a real stack

| Layer | What it is | A real system you'd point at |
|-------|------------|-------------------------------|
| **L1 Capacity supply** | a reserved pool | AWS Capacity Block for ML, GCP future/calendar reservations, Azure capacity reservations |
| **L2 Provisioning** | pool to Ready node | Cluster Autoscaler / Karpenter, plus the GPU device plugin |
| **L3 Scheduling** | place / share / preempt | the default kube-scheduler, or Volcano / Kueue for gang and quota |
| **L4 Workload** | the job itself | a training job (PyTorch / JAX) or an inference server (vLLM / Triton) |

The rest of the series takes one layer, and one idea, at a time.

---

*This is a personal blog. Opinions are mine, not my employer's; everything here refers to publicly documented concepts and products.*
