---
title: "3.3 · Keeping Big Jobs Placeable: Fragmentation and Bin-Packing"
description: "Free GPUs you can't use because they're scattered: how placement policy decides whether big jobs ever fit."
date: "07/08/2026"
---

## Series placement

In [3.1](/blog/scheduler-core-loop) we saw how the scheduler's Score step ranks feasible nodes — filtering says "this node *can* run the pod," scoring says "this node *should*." In [3.2](/blog/gang-scheduling) we saw that gang scheduling raises the bar: you need N GPUs free *simultaneously*, often across few nodes. But both posts sidestepped a question that decides real-world schedulability more than either filter or gang logic alone: **how you placed all the small jobs before the big one arrived.**

That placement history — accumulated over hours of routine work — is what determines whether a fresh 8-GPU request finds a home or sits Pending while the cluster dashboard shows 40% of GPUs idle. The mechanism is external fragmentation, and the policy lever is bin-pack vs spread.

## TL;DR

1. **Fragmentation strands paid capacity.** A cluster at 60% allocation can reject an 8-GPU job if its free GPUs are scattered as ones and twos across every node — you're paying for capacity you cannot schedule.
2. **Pack vs spread is a bet on your future job-size mix.** Bin-packing keeps large contiguous holes available for big jobs; spreading maximizes isolation and thermal headroom but guarantees fragmentation under mixed workloads.

## What it is

External fragmentation for GPUs: aggregate free capacity exceeds a job's request, but no single node holds enough contiguous free slots. The phenomenon is identical to memory fragmentation in an OS — except here the "allocation unit" is a whole GPU and the "address space" is a node's 8-slot array.

The scheduler's scoring policy controls which end of the spectrum you land on:

| Policy | Kubernetes name | Behavior | Who benefits |
|--------|----------------|----------|--------------|
| **Bin-pack** (most-allocated) | `NodeResourcesFit` with `MostAllocated` strategy | Fill occupied nodes before opening new ones | Future large jobs — keeps empty nodes available |
| **Spread** (least-allocated) | `NodeResourcesFit` with `LeastAllocated` strategy | Balance load across all nodes evenly | Running workloads — thermal headroom, blast-radius isolation |

Both are *scoring* strategies — they don't change which nodes pass the filter. They change the *order* in which feasible nodes are preferred. The difference is invisible until a large job arrives and discovers there's nowhere contiguous left to land.

## Why it matters

Worked example on our reference cluster: **10 nodes × 8 GPUs = 80 GPUs** (p5.48xlarge, 8× H100 per node).

A stream of 32 single-GPU inference pods arrives. Same load, two policies, two outcomes.

**Spread (least-allocated):** the scheduler distributes pods roughly evenly — 3–4 per node, leaving 4–5 free GPUs on every node, and crucially no node with 8 free. Cluster allocation: 32/80 = 40%.

Now an 8-GPU training job arrives. Filter needs one node with 8 free GPUs. Every node has only ~5 free → **every node fails the fit check.** The job is `Pending` — rejected on a cluster that is 60% idle. 48 GPUs free, none of them usable.

**Bin-pack (most-allocated):** the same 32 pods land densely — 4 nodes filled (8 pods each), 6 nodes untouched. Same 40% utilization, same 48 GPUs free. Now the 8-GPU job hits Filter: six nodes have 8 free. It places instantly.

Identical hardware, identical load, identical free-GPU count — the *scoring policy* alone decided whether the big job ran or sat `Pending`. That is fragmentation: the fast lane (a contiguous 8-GPU hole) is available under one policy and stranded under the other. The stranded 40% is capacity you paid for and can't sell to the job that needs it.

## The cost of each policy

Neither policy is free:

| | Bin-pack (most-allocated) | Spread (least-allocated) |
|---|---|---|
| Big-job schedulability | High — keeps whole nodes open | Low — fragments contiguous space |
| Blast radius | Concentrated — one node failure hits many jobs | Isolated — roughly one job per node |
| Thermal / power headroom | Tight — full nodes run hot | Loose — load spread out |
| Replica / HA spread | Poor — co-locates replicas | Good — replicas land apart |

The blast-radius row isn't abstract: bin-pack those 32 jobs onto 4 nodes and one node failure takes out ~25% of running work; spread them and a node failure costs ~9%. Bin-pack optimizes for the future big job; spread optimizes for the currently-running small jobs' isolation and resilience. Gang scheduling ([3.2](/blog/gang-scheduling)) sharpens the trade-off: the more your workload leans on large gangs, the more spread's fragmentation costs you, because a gang needs contiguous free GPUs to form at all.

## When fragmentation is the bottleneck

The pain shows up with a **mixed workload** — many small jobs plus occasional large gangs — on whole-GPU allocation. The tell: big jobs start queuing behind fragmentation while the dashboard shows plenty of spare GPUs. Utilization looks healthy; schedulability is broken.

Levers, cheapest first:

- **Bias scoring toward bin-pack** so free capacity accumulates as whole nodes instead of scattered singles.
- **Defragment** by preempting and repacking small jobs to open contiguous space — at the cost of disrupting running work (Part 4's preemption).
- **Shrink the allocation unit** with fractional sharing (Part 2's MIG/MPS): if a small job takes a *slice* instead of a whole GPU, it stops fragmenting whole-GPU space in the first place — sub-GPU defrag — provided the nodes already expose MIG slices or run MPS, since MIG can't be repartitioned on the fly (2.2).

## Demo: pack vs spread decides schedulability

*Same local `kind` setup as [3.2](/blog/gang-scheduling)'s demo — a 3-worker cluster, each worker advertising 2 fake `nvidia.com/gpu` (6 total), pods are `pause` containers holding a GPU slot. No physical GPU or Volcano needed here. What's real is the scheduler's scoring: the default LeastAllocated (spread) versus a second scheduler configured MostAllocated (pack).*

**What this proves:** three 1-GPU pods plus one 2-GPU pod on 6 GPUs — the same workload either fits or doesn't, purely by scoring policy. Spread scatters the small pods so the 2-GPU pod finds no node with two free (Pending at 50% idle); pack consolidates them so it lands.

### Prerequisites

The 3-worker cluster with fake GPUs from 3.2's demo (skip the Volcano install — not needed here). To get a second scoring policy, run a second scheduler configured to pack — a Deployment of `registry.k8s.io/kube-scheduler` with a KubeSchedulerConfiguration whose profile is named `pack-scheduler`:

```yaml
scoringStrategy:
  type: MostAllocated
  resources: [{ name: nvidia.com/gpu, weight: 1 }]
```

The default scheduler stays as-is (LeastAllocated / spread); pods opt into packing with `schedulerName: pack-scheduler`.

### Step 1 — spread: the default scheduler scatters the small jobs

**Why:** the default `NodeResourcesFit` uses LeastAllocated, which balances load — it spreads the three 1-GPU pods one per node.

```bash
kubectl apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata: { name: small-a, labels: { app: small } }
spec: { containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "1" } } }] }
---
apiVersion: v1
kind: Pod
metadata: { name: small-b, labels: { app: small } }
spec: { containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "1" } } }] }
---
apiVersion: v1
kind: Pod
metadata: { name: small-c, labels: { app: small } }
spec: { containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "1" } } }] }
YAML
kubectl get pods -o wide | grep small
```

```
small-a   Running   sched-demo-worker3
small-b   Running   sched-demo-worker2
small-c   Running   sched-demo-worker
```

One pod per node. Three GPUs used, three free — but the free ones are scattered one per node.

### Step 2 — the problem: a 2-GPU job can't fit

**Why:** the job needs two GPUs on a single node; every node has only one free.

```bash
kubectl apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata: { name: big-2gpu }
spec: { containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "2" } } }] }
YAML
kubectl get pod big-2gpu
kubectl get event --field-selector involvedObject.name=big-2gpu | grep FailedScheduling
```

```
NAME       STATUS
big-2gpu   Pending
Warning  FailedScheduling  0/4 nodes are available: 1 node(s) had untolerated taint(s),
                           3 Insufficient nvidia.com/gpu.
```

Half the cluster's GPUs are free and the job is still rejected — fragmentation, exactly. The three "Insufficient" nodes each have one free GPU; none has the two this pod needs. (The 1 tainted node is the control-plane.)

### Step 3 — the win: pack the small jobs, and the big one fits

**Why:** re-place the same three small pods with `pack-scheduler` (MostAllocated), which fills nodes before spreading — leaving a whole node open.

```bash
kubectl delete pod small-a small-b small-c big-2gpu
kubectl apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata: { name: small-a, labels: { app: small } }
spec: { schedulerName: pack-scheduler, containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "1" } } }] }
---
apiVersion: v1
kind: Pod
metadata: { name: small-b, labels: { app: small } }
spec: { schedulerName: pack-scheduler, containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "1" } } }] }
---
apiVersion: v1
kind: Pod
metadata: { name: small-c, labels: { app: small } }
spec: { schedulerName: pack-scheduler, containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "1" } } }] }
YAML
kubectl get pods -o wide | grep small
```

```
small-a   Running   sched-demo-worker
small-b   Running   sched-demo-worker     # worker packed full (2/2)
small-c   Running   sched-demo-worker2    # worker3 left entirely free
```

```bash
kubectl apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata: { name: big-2gpu }
spec: { schedulerName: pack-scheduler, containers: [{ name: c, image: registry.k8s.io/pause:3.10, resources: { limits: { nvidia.com/gpu: "2" } } }] }
YAML
kubectl get pod big-2gpu -o wide
```

```
NAME       STATUS    NODE
big-2gpu   Running   sched-demo-worker3    # the whole free node
```

Identical workload, identical 6 GPUs — the only change was the scoring policy. Spread left the cluster half-allocated but unable to host a 2-GPU job; pack consolidated the small pods onto two nodes and left `worker3` wholly free, so the big job placed immediately. That contiguous free node is the fast lane bin-packing keeps open — spread strands it one GPU at a time.

### Teardown

```bash
kind delete cluster --name sched-demo
```

## Where this goes next

**[3.4](/blog/topology-aware-scheduling)** — packing a job onto few nodes is necessary but not sufficient. The GPUs you packed still have to be *close on the fabric*, or a job that "fit" runs slowly anyway. Placement isn't just fitting — it's fitting *well-connected*.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
