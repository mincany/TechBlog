---
title: "3.2 · Whole-Job Placement for Distributed Training: Gang Scheduling"
description: "A distributed training job needs every piece placed simultaneously — partial placement deadlocks and wastes every GPU it grabbed."
date: "07/07/2026"
---

## Series placement

In [3.1](/blog/scheduler-core-loop) we walked through the four-move scheduling loop: Watch → Filter → Score → Bind. One pod, one placement decision. That works when each pod is a self-contained unit of work — inference server, single-GPU fine-tune, batch preprocessor. But a distributed training job isn't one pod. It's N pods that are only useful *together*. Each one runs a shard of the same model, synchronizing gradients via all-reduce every single step ([1.3](/blog/topology-nvlink)). Place nine out of ten and the nine sit idle, burning GPU-hours, waiting for a tenth peer that never arrives.

The single-pod loop doesn't break because it's slow. It breaks because it's *greedy* — it binds pods one at a time without coordinating across the group.

## TL;DR

1. **A distributed job placed partially is worse than not placed at all — idle workers hold GPUs hostage while producing zero useful work, and two partial gangs can permanently deadlock each other.**
2. **Gang scheduling flips the contract: admit all N pods simultaneously or queue the entire group, so every bound GPU is immediately productive.**

## What it is

Gang scheduling (also called co-scheduling) is an admission gate in front of binding: the scheduler treats a group of pods as an atomic unit and holds the whole group — a Permit/admission step before any pod is bound — until all N members can be placed in the same scheduling cycle, or none are. The group re-enters the queue intact.

The plain kube-scheduler doesn't have this concept. It processes pods from the priority queue independently. If a 16-pod job enters the queue, those 16 pods compete with every other pending pod for available slots, one binding at a time. There's no mechanism to say "hold these 16 bindings until all 16 can succeed."

## Why it matters

The failure mode isn't theoretical. Consider a cluster of three p5.48xlarge nodes — 24 GPUs, all free. Each node is one EC2 instance that was already launched and joined the cluster; that provisioning happened at layers 1–2 ([0.1](/blog/four-layer-capacity-model)), and the scheduler only places pods within this fixed pool. Now two distributed training jobs arrive, each needing 16 GPUs: 16 one-GPU pods, two nodes' worth, drawn from the shared pool — jobs consume GPUs, not instances, and one job's pods can span nodes.

**Greedy independent binding** (both jobs submitted together at equal priority, so their pods interleave in the queue and the scheduler alternates bindings — the split is symmetric only because neither job's pods dequeue as an uninterrupted block):
1. Job A's first 12 pods land across 2 nodes (one full, half of another) — 12 GPUs.
2. Job B's first 12 pods grab the remaining 12 GPUs.
3. Job A still needs 4 more pods — no capacity. Job B still needs 4 more pods — no capacity.
4. Neither job can start. Neither will release what it holds — the pods are *waiting*, not *failed*.

Result: **resource deadlock.** 24 GPUs are allocated, 24 GPUs are idle, and zero useful work is happening — each job holds enough to block the other and not enough to run. Neither yields, because from each job's point of view its pods are healthy and waiting. Only an operator killing one job breaks the tie.

Even a job that *isn't* deadlocked pays. A distributed training step is all-reduce-coupled ([1.3](/blog/topology-nvlink)): every worker exchanges gradients with every other worker before the next step begins. A worker with no peers can't make progress — it blocks on a collective that never completes, holding its GPU at 0% useful utilization while the meter runs.

To summarize, the two policies just contrasted — the default scheduler binding pods independently versus gang binding the group as a unit:

| Dimension | Independent binding (default) | Gang binding |
|-----------|------------------------------|--------------|
| Unit of decision | Single pod | PodGroup (N pods) |
| Partial placement | Allowed — some bound, some pending | Forbidden — all or none |
| Deadlock risk | High under contention | Eliminated by design |
| GPU waste on partial | Every bound-but-blocked GPU burns hours | Zero — nothing held |
| Implementation | Built into kube-scheduler | Requires Volcano PodGroup, Kueue, or the Coscheduling plugin |

## The gang fix

Gang binding treats the 16 pods as one PodGroup and only binds them when 16 GPUs are simultaneously available on acceptable nodes:

1. Job A enters; fewer than 16 GPUs are free → the whole group stays queued, holding no *bound* GPUs (a quota admitter like Kueue may still *reserve* against a queue — a different kind of hold, and the source of the backfill trade-off below).
2. Capacity frees up to 24 GPUs. Job A's 16 pods bind in a single cycle across 2 nodes; it runs immediately.
3. Job B waits its turn. When 16 more free up, it binds as a unit.

No GPU is ever held by a job that can't run. The cluster either commits fully to a job or commits nothing — the deadlock is gone by construction. That's the utilize-vs-fallback contrast in one line: the fallback is 24 GPUs burning money at 0% useful work; the win is admission that only ever hands out GPUs that will do work the instant they're bound.

## When gang scheduling is the bottleneck

Gang scheduling trades utilization for correctness: to assemble a large gang, it may hold GPUs idle *on purpose* — refusing to hand a free GPU to a small job because it's reserving room for a 64-GPU job still waiting on its last node. Without a backfill policy, a big pending gang can strand capacity that smaller jobs could have used productively.

The standard answer is **gang + backfill**: reserve for the large gang, but let small, short jobs run in the reserved holes as long as they'll finish before the gang is ready. Volcano and Kueue implement variants of this. The knob to watch is how long you'll hold capacity for a gang that can't yet form — hold too long and you've traded one waste (partial-gang deadlock) for another (reserved-but-idle).

## Demo: gang scheduling on a real cluster

*This runs on a local 3-node `kind` cluster with **fake GPU capacity** — the nodes advertise `nvidia.com/gpu` through a status patch, and the "training" pods are `pause` containers that hold a GPU slot without doing real work. Nothing here needs a physical GPU. What's real is the **scheduling behavior**: the default scheduler binding pods one at a time versus Volcano's all-or-nothing PodGroup. That's the layer this post is about.*

**What this proves, in order:** on a cluster with only 3 GPUs free, a 4-pod job (a) *partially places* under the default scheduler — 3 pods bind and hold GPUs while the 4th is stuck, so three GPUs do zero useful work — and (b) under Volcano gang scheduling holds *nothing* until all 4 can run, then admits all four the instant capacity appears.

### Prerequisites — a cluster that thinks it has GPUs

A 3-worker `kind` cluster, each worker advertising 2 fake GPUs (6 total), plus Volcano:

```bash
kind create cluster --name sched-demo --config - <<'YAML'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes: [{role: control-plane}, {role: worker}, {role: worker}, {role: worker}]
YAML

# advertise 2 fake GPUs per worker (extended resource via the status subresource)
for n in sched-demo-worker sched-demo-worker2 sched-demo-worker3; do
  kubectl patch node $n --subresource=status --type=json -p='[
    {"op":"add","path":"/status/capacity/nvidia.com~1gpu","value":"2"},
    {"op":"add","path":"/status/allocatable/nvidia.com~1gpu","value":"2"}]'
done

# install the Volcano gang scheduler
kubectl apply -f https://raw.githubusercontent.com/volcano-sh/volcano/master/installer/volcano-development.yaml
kubectl -n volcano-system wait --for=condition=Available deploy --all --timeout=180s
```

### Step 1 — occupy 3 of the 6 GPUs

**Why:** create contention so a 4-GPU job cannot fully place — three GPUs free, four needed.

```bash
kubectl apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata: { name: blocker-1, labels: { app: blocker } }
spec: { containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "1" } } }] }
---
apiVersion: v1
kind: Pod
metadata: { name: blocker-2, labels: { app: blocker } }
spec: { containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "1" } } }] }
---
apiVersion: v1
kind: Pod
metadata: { name: blocker-3, labels: { app: blocker } }
spec: { containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "1" } } }] }
YAML
# 3 GPUs held, 3 free
```

### Step 2 — the problem: a 4-pod gang on the default scheduler

**Why:** the default scheduler binds pods independently, so it will place whatever fits and leave the rest Pending — with no notion that the four pods are one job.

```bash
for i in 0 1 2 3; do kubectl apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata: { name: train-$i, labels: { job: train-default } }
spec: { containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "1" } } }] }
YAML
done
kubectl get pods -l job=train-default -o wide
```

```
NAME      STATUS    NODE
train-0   Running   sched-demo-worker2
train-1   Running   sched-demo-worker
train-2   Running   sched-demo-worker2
train-3   Pending   <none>
```

Three pods bound and are holding a GPU each; the fourth is stuck with nowhere to go. The job needs all four to make progress, so those **three GPUs are held at zero useful work** — a real distributed job would have its three placed workers spinning on a collective that the missing fourth rank never joins. Nothing resolves this on its own.

### Step 3 — the win: the same gang under Volcano

**Why:** gang scheduling gates admission on the whole group — it places all N or none, so it never hands out a GPU to a job that can't run yet.

```bash
kubectl delete pod -l job=train-default        # clear the partial placement
kubectl apply -f - <<'YAML'
apiVersion: scheduling.volcano.sh/v1beta1
kind: PodGroup
metadata: { name: train-gang }
spec: { minMember: 4 }
YAML
for i in 0 1 2 3; do kubectl apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: vtrain-$i
  labels: { job: train-gang }
  annotations: { scheduling.k8s.io/group-name: train-gang }
spec:
  schedulerName: volcano
  containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "1" } } }]
YAML
done
kubectl get pods -l job=train-gang
kubectl get podgroup train-gang -o jsonpath='{.status.phase}'
```

```
NAME       STATUS
vtrain-0   Pending
vtrain-1   Pending
vtrain-2   Pending
vtrain-3   Pending      # 4 Pending, 0 Running
Inqueue                 # PodGroup: waiting until all 4 can be placed
```

Only 3 GPUs are free, so Volcano places **none** of the four — the group sits `Inqueue`, holding zero GPUs. Those three free GPUs stay available for other work instead of being stranded by a half-placed job. Now free the contended capacity:

```bash
kubectl delete pod -l app=blocker     # frees 3 GPUs → 6 free, enough for the gang
kubectl get pods -l job=train-gang -o wide
```

```
NAME       STATUS    NODE
vtrain-0   Running   sched-demo-worker3
vtrain-1   Running   sched-demo-worker
vtrain-2   Running   sched-demo-worker2
vtrain-3   Running   sched-demo-worker    # all 4 admitted in one shot
```

The moment 4 GPUs are simultaneously available, Volcano admits the entire group at once. Compare the two end states: the default scheduler left 3 GPUs *held and idle* with the job deadlocked; Volcano held *nothing* until it could run the whole job, then placed all four together. That is the utilize-vs-fallback contrast — the fallback isn't slow, it's capacity billed at zero useful work.

### Teardown

```bash
kind delete cluster --name sched-demo
```

## Where this goes next

- **[3.3](/blog/fragmentation-bin-packing)** — "16 GPUs simultaneously free" quietly assumes you can *find* them together. If your free GPUs are scattered one-per-node, a gang can't form even when the cluster is half-empty. That's fragmentation.
- **[3.4](/blog/topology-aware-scheduling)** — once the gang binds, *where* its members land on the fabric decides whether the all-reduce runs at NVLink speed or crawls across switches.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
