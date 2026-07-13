---
title: "3.1 · How a Scheduler Decides: Watch → Filter → Score → Bind"
description: "The four-phase loop that places every GPU job — and where gang scheduling, fragmentation, and topology-aware placement all live inside it."
date: "07/06/2026"
---

## Where we are

Part 2 asked: how do you fit *more work* onto a single GPU — slicing it with MIG, sharing it with MPS, time-slicing it between pods. All of that assumes the job already *landed* on a node.

Part 3 zooms out. You have a cluster — dozens or hundreds of 8-GPU nodes connected by high-bandwidth fabric. A training job needs 64 GPUs. An inference service needs 1. A batch of fine-tuning runs each need 4. Something has to decide *which nodes* get *which jobs*, and it has to decide fast enough that GPUs don't sit idle between decisions.

That something is the scheduler. This post is its core loop.

## TL;DR

1. **Every scheduling decision is a four-stage pipeline — Watch → Filter → Score → Bind — and every hard problem in Part 3 (gang scheduling, fragmentation, topology) is a failure or extension of exactly one stage.**
2. **A Pending pod doesn't mean you're out of hardware; it means the *decision engine* couldn't find a feasible placement — and knowing which stage rejected it tells you what to fix.**

## What it is

The scheduler watches for unscheduled pods, then runs each through a pipeline:

| Stage | Question it answers | Outcome |
|-------|-------------------|---------|
| **Watch** | "Is there work to place?" | Pod enters the scheduling queue |
| **Filter** | "Which nodes *can* run this?" | Hard constraints eliminate infeasible nodes |
| **Score** | "Which feasible node is *best*?" | Soft preferences rank what's left |
| **Bind** | "Commit the decision." | Pod → Node association persisted to the API server |

Filter is boolean: pass or fail. Score is a gradient: 0–100 per plugin (after normalization), summed across all active scoring plugins. Bind is the point of no return — the scheduler marks those GPUs as claimed (the default scheduler *assumes* the binding in its cache immediately, then persists it to the API server asynchronously), so the next pod is scored against the updated state.

In the default kube-scheduler this loop runs serially per pod. Extensions like Volcano and Kueue batch pods into groups before entering the pipeline, but the four stages remain the skeleton.

## Why it matters

The stages aren't just implementation detail — they're where you intervene:

**Filter (hard constraints)** — "Can this node hold the job at all?"
- Does the node advertise enough `nvidia.com/gpu`?
- Does the node have the right instance type (taint/label match)?
- Is the node cordoned, under pressure, or already full?

If Filter eliminates every node, the pod is Pending. No amount of scoring cleverness helps — you need more capacity (L1) or a different resource request.

**Score (soft preferences)** — "Given multiple feasible nodes, which is cheapest to use?"
- Pack vs. spread: do you fill nodes densely (minimize fragmentation) or spread jobs (maximize fault isolation)?
- Topology: do you prefer nodes on the same network switch, same rack, or same NVLink domain, so a job's pieces communicate on the fast path?
- Pressure: do you steer away from nodes already hot on memory or power?

Every scoring plugin returns 0–100; the scheduler sums them and picks the winner. Nothing here changes *whether* a job can run — only *where* it runs best. That "where" is the entire subject of the next three posts.

**Bind (commit)** — the scheduler writes the pod→node assignment to the API server. Allocatable GPUs on that node drop, and the next pod in the queue sees the reduced state. Bind is the only step that changes the world; Filter and Score are pure computation over a snapshot.

## One worked example — a cluster of p5.48xlarge nodes

Take a small cluster: four p5.48xlarge nodes, 8 H100s each — 32 GPUs total. Two are half-full from earlier work.

| Node | Free GPUs |
|------|-----------|
| node-a | 8 |
| node-b | 4 |
| node-c | 4 |
| node-d | 8 |

**A 1-GPU inference pod arrives.**
- *Watch:* pod enters the queue.
- *Filter:* every node has ≥1 free GPU — all four pass.
- *Score:* a bin-packing policy prefers the most-allocated feasible node, so node-b or node-c (4 free) outscore the empty ones — placing the small job there keeps node-a and node-d wholly free for a future big job.
- *Bind:* pod lands on node-b; node-b drops to 3 free.

**An 8-GPU training pod arrives** (set aside for a moment that a distributed job is really a *group* — that's 3.2's problem).
- *Filter:* it needs 8 GPUs on one node. node-b (3) and node-c (4) fail the fit check; node-a (8) and node-d (8) pass.
- *Score:* both are equal on capacity; a topology plugin (3.4) breaks the tie by fabric locality.
- *Bind:* lands on node-a; node-a drops to 0 free.

Same loop, same four stages — the request size is the only thing that changed which nodes survived Filter.

## When the scheduler — not the hardware — is the bottleneck

A `Pending` pod is the scheduler telling you it couldn't place the work. It comes in two shapes:

- **Filter eliminated every node.** No feasible placement exists: not enough free GPUs anywhere, wrong instance type, every candidate cordoned or tainted. More scoring cleverness can't help — you need capacity (an L1/L2 problem) or a smaller request.
- **It lost a race.** A feasible node existed when the pod was scored, but another pod claimed the slot first; the pod re-enters the scheduling queue and is retried against fresh state — the scheduler's optimistic-concurrency model, which assumes bindings and reconciles on the next cycle.

That distinction is the whole diagnostic value of the loop. The fast lane is a placement that claims a free, well-connected GPU; the fallback is a job that sits `Pending` while capacity you're paying for goes unclaimed — a stalled 8-GPU request is a whole p5.48xlarge node billing at full rate for zero useful work — or one that binds to a poorly-connected node and runs at the fallback speed ([3.4](/blog/topology-aware-scheduling)). Naming *which stage* rejected a pod tells you whether to add capacity, relax a constraint, or fix a scoring policy — before you change anything.

## Where this goes next

The rest of Part 3 is three problems, one per stage of this loop:

- **[3.2](/blog/gang-scheduling)** — a distributed job is N pods only useful together. An all-or-nothing *admission* gate must hold the group before any of it binds, or partial placement deadlocks.
- **[3.3](/blog/fragmentation-bin-packing)** — Score's pack-vs-spread choice decides whether scattered free GPUs can ever host a big job.
- **[3.4](/blog/topology-aware-scheduling)** — a Score plugin that keeps communicating GPUs close on the fabric, so the job you placed runs at the fast-lane speed ([1.5](/blog/inter-node-fabric)'s hop problem, turned into a scheduling input).

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
