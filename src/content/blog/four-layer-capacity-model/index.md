---
title: "0.1 · The 4-Layer Mental Model for AI Compute"
titleZh: "算力层的四层心智模型"
description: "A simple model that splits a compute cluster into four layers — reservation, provisioning, scheduling, workload — so 'my pod is Pending' becomes a one-minute diagnosis instead of a three-team argument."
date: "06/29/2026"
---

This is the foundation post for a series I'm writing on GPU capacity and scheduling — the mental model I keep reaching for, and the one the rest of the series builds on.

## TL;DR

A GPU cluster is not one system. It is **four stacked systems**, and almost every painful production incident I have seen comes from confusing two of them. The four layers:

1. **Capacity supply** — a *reserved pool* of hardware you have a claim on.
2. **Provisioning** — turning that pool into *running machines* (nodes).
3. **Scheduling** — placing *units of work* (pods) onto those machines.
4. **Workload** — the training or inference job that actually burns the GPU.

The one idea to hold onto: these are four *different* systems, usually owned by different people — and until you can name them separately, you can't really reason about a GPU cluster at all.

## Motivation: a map before the territory

No war story here — and I want to be upfront about that. This is a foundations piece: the mental model the rest of the series builds on, and honestly the one I wish someone had drawn for me when I was first piecing GPU infrastructure together. The war stories come later — co-location, preemption, reclaim — and this is just the shared vocabulary that makes them land.

The everyday pain it solves: "My pod is Pending" is one of the most common things said about a GPU cluster — and it is almost useless as a description, because *Pending* can mean four completely different things, owned by four different people:

- the capacity team says "the reservation is active, we're paying for it"
- the platform team says "there are pods Pending"
- the scheduler says "I have nothing to place them on"

All three can be true at the same time, and each points at a different layer. Without a shared map, that conversation goes in circles; with one, it resolves in a sentence. The rest of this post is that map. (Actually *debugging* that shared "Pending" symptom is its own post — 0.3; here I just want the map itself.)

## Before we start

You'll get the most from this if you know roughly what a Kubernetes pod and node are, and that a GPU is a *requestable* resource. No specific scheduler required, and the demo runs on `kind` + any container runtime (Docker / Podman / Colima) — no GPU hardware. By the end you should be able to drop any "my pod is stuck" problem onto the right layer in about a minute.

## The mental model (one diagram)

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

Read it bottom-up, because that is the direction capacity actually flows:

| Layer | Noun | Question it answers | Who owns it (typically) |
|-------|------|---------------------|--------------------------|
| **L1 Capacity supply** | a *reserved pool* | "Do I have a claim on hardware at all?" | capacity / FinOps |
| **L2 Provisioning** | a *running machine* | "Is that claim a live, Ready node?" | platform / autoscaler |
| **L3 Scheduling** | a *unit of work* | "Will this pod be placed on a node?" | scheduler / platform |
| **L4 Workload** | the *job* | "Is the placed work actually correct & efficient?" | the ML team |

The trick is that **the symptom almost always shows up at L3** ("my pod is Pending") regardless of which layer is actually broken. L3 is the messenger. The model is how you stop shooting the messenger.

## Walking the layers

**L1 — Capacity supply.** This is the *right to hardware*, not the hardware running. A reservation, a capacity block, a quota grant. Crucial property: **you can be billed at L1 while having nothing at L2.** A reserved pool that is "active" but not yet turned into nodes is pure cost with zero capability. Failures here sound like "insufficient capacity" — every cloud has its own name for it (AWS `InsufficientInstanceCapacity`, GCP `ZONE_RESOURCE_POOL_EXHAUSTED`, Azure `AllocationFailed`) — or simply "quota is zero."

**L2 — Provisioning.** This converts a claim into a `Ready` node. An autoscaler asks L1 for machines and waits 30s–5min for them to boot, join the cluster, and pass health checks. Failures here: nodes stuck `NotReady`, GPU driver/device-plugin not installed yet, launch hanging. From L3's point of view, a node mid-provision *does not exist*.

**L3 — Scheduling.** Given Ready nodes, decide which pod goes where: filter (which nodes *can* fit), score (which is *best*), bind. This is where the rich problems live — gang scheduling, fairness, preemption, topology — and it is the subject of most of this series. But note: **L3 can only place work onto nodes that L2 actually produced from L1's pool.** It cannot conjure capacity.

**L4 — Workload.** The job itself: parallelism, checkpointing, KV-cache, batching. A perfectly scheduled job can still leave a large share of the GPU's FLOPS on the floor — Model FLOPs Utilization (MFU) well below 1.0; even well-tuned large training runs often land around 40–55% — and that is an L4/efficiency problem, not a scheduling one. Different post, different fix.

**A note on the L1↔L3 gap.** These two layers are usually owned by *different teams with different dashboards* — L1's says "reservation active, $X/hr," L3's says "N pods Pending." Neither shows the gap *between* them: paid capacity that never became schedulable. It's an easy gap for everyone to miss, precisely because no single layer owns it.

### Where the model leaks (because no four-box model is the whole truth)

Two honest caveats, so the model doesn't mislead you on the edges:

- **DaemonSets and static pods don't really play the L3 game.** They're placed on every (or a specific) node by design, bypassing the filter/score contest. The "every symptom shows up at L3 as Pending" rule is about *user workloads* competing for scarce GPUs — not system pods.
- **Dynamic Resource Allocation (DRA) blurs L2 and L3.** As DRA matures in Kubernetes (structured-parameter resource claims), some allocation decisions that this model puts at L2/provisioning happen *during* scheduling. The four layers are still a useful map; just know the L2↔L3 line is getting fuzzier, not sharper.

If your problem lives in one of these corners, the model points you to the right neighborhood and then politely steps aside.

## Demo: all four layers on a laptop

Realism note: this runs on `kind` (Kubernetes running inside Docker) with GPUs *faked* onto the nodes — no real hardware. The goal is to see the four layers as four *separate, observable things*, not to benchmark a GPU. Every command and output below is from a real run (kind v0.32, Kubernetes v1.36.1). If you don't know `kubectl`, each step says what it does and what you should see.

The key choice: a **multi-node** cluster, so the scheduler actually has somewhere to *choose between* — that's what makes L3 visible instead of implied.

**Setup — a 3-node cluster (1 control-plane + 2 workers).**

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
# Fresh nodes are briefly NotReady (a self-clearing taint); wait for them.
kubectl wait --for=condition=Ready nodes --all --timeout=90s
```

```
node/layers-control-plane condition met
node/layers-worker condition met
node/layers-worker2 condition met
```

Three machines, zero GPUs. (If a later `apply` says `serviceaccount "default" not found`, the cluster is still booting — wait a few seconds and retry.)

**L1 — capacity supply: the reservation.** Before any GPU exists, you hold a *reservation* — a claim on hardware that hasn't been turned into a running, usable node yet. In the cloud this is an AWS Capacity Block for ML, a GCP future/calendar reservation, or an Azure capacity reservation; for scarce parts like H200 or GB200 you generally **cannot launch a GPU at all without one**. `kind` has no reservation primitive, so the reservation here is represented by the fact that our worker nodes *exist* but advertise **zero** schedulable GPUs — the claim is in place, but nothing is runnable on it yet:

```bash
WORKER=$(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' \
          -o jsonpath='{.items[0].metadata.name}')
kubectl get node "$WORKER" -o jsonpath='gpu=[{.status.capacity.nvidia\.com/gpu}]{"\n"}'
```

```
gpu=[]
```

Empty. The node is there (the reservation is held) but it offers no GPU yet. *This is exactly the gap where a paid reservation can sit burning money — you're holding H200s but nothing is schedulable on them.*

**L2 — provisioning: turn the reservation into a schedulable GPU.** In the cloud, an autoscaler launches the reserved instance, it joins the cluster, and its GPU **device plugin** advertises the GPUs to Kubernetes — that's the step that makes the reserved capacity actually *schedulable*. `kind`'s machine already exists, so we stand in for the device plugin by advertising one GPU on each worker:

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

That `gpu=[]` → `gpu=[1]` flip *is* the L1→L2 boundary: a reservation existing (a claim) versus a node actually offering a GPU the scheduler can place work on. Now we have two workers, one schedulable GPU each.

**L3 — scheduling: the scheduler *chooses* where each pod runs.** Submit three pods, each asking for one GPU:

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

kubectl get pods -o wide      # the NODE column shows the scheduler's decision
```

```
NAME        READY   STATUS    NODE
trainer-a   1/1     Running   layers-worker2
trainer-b   1/1     Running   layers-worker
trainer-c   0/1     Pending   <none>
```

(The real `-o wide` also prints `RESTARTS / AGE / IP / NOMINATED NODE`; trimmed here for width.)

This is L3 doing its real job. Two GPUs across two nodes; the scheduler **placed** `trainer-a` and `trainer-b` on *different* workers — picking a node is the decision — and left `trainer-c` **Pending** because both GPUs are now taken. Placement and Pending are the two faces of the same layer: it puts work where capacity is, and refuses when there's none.

**L4 — workload: run the work *inside* a running pod.** A pod is the slot the scheduler filled; the workload is whatever runs in that slot. We already watched the scheduler place `trainer-a` on a GPU node (that was L3) — so let's run the workload *in that same pod*, without killing or rescheduling anything. `kubectl exec` runs a process inside a running container. Our workload is deliberately trivial — log a timestamp, "work" for three steps, log the time again — a stand-in for a real training script:

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

That's L4: the workload runs on the GPU the pod is holding, and the pod stays up the whole time — `kubectl get pods` still shows `trainer-a` and `trainer-b` `Running`, nothing was torn down. Notice `exec` never touches the scheduler: the placement decision (L3) happened *once*, when the pod was created; the workload just runs in the slot the pod already claimed. That's the real-world shape too — a training pod is scheduled once, then runs many steps inside it.

(The other common pattern is a Kubernetes `Job`, which creates *its own* fresh pod, runs to completion, and reports `Complete` — handy when you want the system to *track* that a task finished. Same four layers; a Job just bundles "schedule a new pod" and "run the work" into one object, where `exec` lets us watch them as two separate things.)

```bash
kind delete cluster --name layers     # clean up
```

**What you just watched, layer by layer:**

| Layer | What we did | What it looked like |
|---|---|---|
| **L1** capacity supply | held a reservation — node exists, GPU not yet schedulable | `gpu=[]` |
| **L2** provisioning | device plugin advertises the GPU on each worker | `gpu=[]` → `gpu=[1]` |
| **L3** scheduling | scheduler placed pods on nodes, refused the 3rd | `trainer-a→worker2`, `trainer-b→worker`, `trainer-c Pending` |
| **L4** workload | ran the workload *inside* the running `trainer-a` (`exec`) | logged a timestamp + 3 steps; pod stayed `Running` |

Four layers, four observable behaviors — not just "a pod needs a GPU." When something breaks, *which* of these four behaviors is missing is the whole diagnostic question — and that is what the four-layer model buys you.

## Where each layer lives in a real stack

The model is abstract on purpose, but it's worth a quick orientation before the rest of the series goes deep. One canonical real system per layer (every cloud and ecosystem has an equivalent):

| Layer | What it is | A real system you'd point at |
|-------|------------|-------------------------------|
| **L1 Capacity supply** | a reserved pool | AWS Capacity Block for ML, GCP future/calendar reservations, Azure capacity reservations |
| **L2 Provisioning** | pool → `Ready` node | Cluster Autoscaler / Karpenter, plus the GPU device plugin |
| **L3 Scheduling** | place / share / preempt | the default kube-scheduler, or Volcano / Kueue for gang and quota |
| **L4 Workload** | the job itself | a training job (PyTorch / JAX) or an inference server (vLLM / Triton) |

Abstract on the left, concrete on the right. The rest of the series takes one layer, and one new idea, at a time — and keeps coming back to the seam between L1 and L3.

## Recap

Four stacked systems — reservation, provisioning, scheduling, workload — each a distinct, observable thing rather than one undifferentiated "GPU cluster." The practical payoff is small but real: when something's wrong, you can say *which* of the four it is instead of guessing. The later posts each zoom into one of them.

---

*This is a personal blog — opinions are mine, not my employer's, and everything here is based on publicly documented features.*
