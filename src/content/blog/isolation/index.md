---
title: "2.4 · When Sharing Backfires: Isolation and Interference"
description: "Sharing only pays off if one job can't steal another's memory or tail latency; where each sharing mode's isolation breaks."
date: "07/05/2026"
---

2.1 argued for sharing — a whole H100 running one job at ~0.3% of its FLOPs is the dominant fleet waste. 2.2 gave the space-based fix (MIG: hardware-isolated slices), and 2.3 gave the time-based fix (MPS and time-slicing: concurrent access to the full GPU). This post is the counterweight: sharing only pays off if one tenant can't steal another's memory or spike another's tail latency. Isolation is the cost of every sharing mode, and matching the guarantee to the blast radius you can tolerate is the actual engineering decision.

## TL;DR

1. **Sharing interference splits into two axes — memory safety (can a neighbor corrupt or exhaust your HBM?) and performance isolation (can a neighbor spike your p99 without anything crashing?) — and each mode offers a different guarantee on each axis.**
2. **MIG's hardware fence is the floor when you can tolerate zero cross-talk; softer modes (MPS, time-slicing) buy density when you can absorb jitter — the decision is a function of trust boundary and SLA strictness, not just workload size.**

## Axis 1: Memory isolation

Memory interference is the loud failure. It manifests as OOM kills, segfaults, or data corruption — hard to miss, easy to attribute.

| Mode | Memory guarantee | What breaks it |
|---|---|---|
| **MIG** | Hardware-isolated. Each instance has its own memory controllers and HBM slice. One tenant literally cannot address another's memory. | Nothing short of a hardware fault in the memory controller itself. |
| **MPS** | Soft caps. The daemon can enforce a per-client device-memory limit and reject allocations that exceed it. But all clients share one address space. | A client that corrupts memory (wild pointer, buffer overrun) damages the shared space. A crash in one client can bring down the MPS server process — all co-located clients die with it. |
| **Time-slicing** | None. All contexts live in the same 80 GB simultaneously (to avoid costly swap-in/swap-out). No per-context memory limit enforcement. | Any tenant's allocation grows until free HBM is exhausted; the next `cudaMalloc` from any tenant — including well-behaved ones — returns OOM. One bad actor takes everyone down. |

The gradient is clear: MIG → can't touch it; MPS → shouldn't touch it (driver policing, shared fate on crash); time-slicing → nothing stops it.

## Axis 2: Performance isolation — the subtler killer

Performance interference is the quiet failure. Nobody crashes. Monitoring says "healthy." But your p99 serving latency doubled and your SLA is breached. This is the more common production problem, because it's invisible at the process level and only shows up in tail-latency metrics that most teams measure too coarsely.

The mechanism is **contention over shared resources** — specifically the ~3.35 TB/s HBM bandwidth bus and the 132 SMs.

### MIG: isolated

Each MIG instance has its own SM partition and its own memory controller path. Traffic from one instance doesn't traverse another's controllers. A bandwidth-hungry job in one slice cannot slow down reads in another — they're on physically separate data paths.

Result: near-zero cross-talk. Your instance's latency is a function of your workload and your slice's resources, period.

### MPS: shared bus, shared SMs

All MPS clients share the same 132 SMs and the same ~3.35 TB/s memory bus. A long-running kernel from one client occupies SMs that another client's kernel needs; a bandwidth-heavy burst from one client contends with every other client's memory reads on the same bus.

The optional SM percentage cap (`CUDA_MPS_ACTIVE_THREAD_PERCENTAGE`) limits how many SMs a client can *use*, but it doesn't reserve bandwidth or prevent a neighbor's traffic from saturating the shared bus.

Result: your latency is a function of your workload *plus* whatever your neighbors are doing at that instant — especially their bandwidth consumption.

### Time-slicing: frozen during others' turns

Under time-slicing, your context is paused while other tenants run. Your request's end-to-end latency includes not just your own compute, but up to (N−1) other tenants' time-slices before your next turn arrives.

Result: worst-case latency scales linearly with the number of co-located tenants. A 4-tenant GPU means each tenant's effective latency floor is ~4× what it would be alone. For latency-critical serving, this is disqualifying at even modest tenant counts.

## Worked contrast on the canonical H100

Reusing the scenario from 2.3: four 3B BF16 tenants on one H100 (80 GB, ~3.35 TB/s, 132 SMs), each doing decode at ~140 tokens/sec, each consuming ~0.84 TB/s of bandwidth (well below the ceiling individually).

A single decode step for a 3B model takes ~1.8 ms at the bandwidth wall (6 GB weights ÷ 3.35 TB/s). At ~140 tok/s per tenant, each tenant leaves most of the bus idle between tokens — which is why four tenants can stack on one GPU in the first place (aggregate ~3.36 TB/s ≈ bus capacity).

Now: one of the four tenants swaps in a larger 13B model and serves it at a high decode rate. From 1.2 and 2.1, a 13B decode stream reads all 26 GB of weights per token and draws ~3.3 TB/s on its own — nearly the entire bus. This neighbor is genuinely bandwidth-bound, and it contends for the exact resource the other three need: the ~3.35 TB/s pipe.

**Under MPS:** the 13B tenant's reads consume most of the shared bus, leaving the three 3B decode tenants a fraction of their former bandwidth. A decode step that normally completes in ~1.8 ms now waits on a contended pipe — when a tenant's bandwidth share is roughly halved, its memory-bound step takes ~2× as long. No crash, no OOM, no error in any log — just a p99 spike from ~1.8 ms toward ~3.6 ms for the small tenants whenever the bandwidth-hungry neighbor is active.

**Under MIG:** put the bandwidth-hungry tenant in its own slice. Each MIG instance gets a fixed fraction of the memory controllers and its own data path, so the 13B tenant's reads draw only on its slice's share of bandwidth and never cross into the others'. The small tenants' latency doesn't move. The flip side (from 2.2): each slice is capped at its fraction of the ~3.35 TB/s, so isolation also means a slice can't burst above its share.

**Under time-slicing:** the three small tenants are *frozen* while the 13B tenant runs its slice. Their end-to-end latency now includes that entire slice — and a heavy tenant's slice can run long, so a small tenant can wait several multiples of its own ~1.8 ms step before its next turn.

*Numbers are illustrative — actual interference patterns depend on kernel scheduling, bus arbitration, and driver implementation. The mechanism is the point: shared resources create coupled latency even when no one crashes.*

**The utilize-vs-fallback framing, inverted:** In Parts 1 and 2.1–2.3, the fast lane was *sharing* — pack more jobs, reclaim idle capacity. Here, isolation is the fast lane: MIG's hardware fence guarantees the performance you measured in testing is the performance you'll get in production. The fallback — softer isolation modes — is faster to deploy and denser, but you accept that one tenant's burst can degrade another's latency with no crash to detect and no error to catch.

## Decision framework

| Situation | Recommended mode | Why |
|---|---|---|
| **Untrusted tenants** (multi-customer, different teams, external workloads) | MIG | Hardware fence; no trust required. A neighbor can't touch your memory or spike your latency. |
| **Hard p99 SLA** (latency-critical real-time serving, guaranteed response times) | MIG | Isolated bandwidth path; no co-tenant interference in tail latency. |
| **Trusted + bursty + best-effort** (same-team models, elastic traffic, batch tolerance) | MPS | Density without fixed slices; tolerate occasional jitter from neighbors. Soft caps catch leaks; shared fate acceptable because you control all tenants. |
| **Light, simple, trusted** (few small jobs, low operational overhead, no strict SLA) | Time-slicing | Simplest deployment (device plugin config). Accept serialized latency in exchange for zero operational complexity. |
| **Single job saturates the GPU** (large-batch training, high-throughput inference) | Don't share | Back to 2.1's premise: if one job fills the unit, sharing adds contention with no upside. |
| **Stable workload sizes, need strong isolation** | MIG | Pick profiles that fit, leave them static. Pay the granularity cost; buy the guarantee. |
| **Variable workload sizes, need maximum density** | MPS | No fixed profiles to strand capacity; tenants flex up and down dynamically. Pay the shared-fate cost. |

The axes that drive the decision: **trust boundary** (who controls the tenants), **SLA strictness** (best-effort vs hard p99), **workload predictability** (fixed size vs bursty), and **density pressure** (how much idle waste you're willing to tolerate).

## Part 2 wrap

Part 2 packed multiple jobs onto one GPU — the utilization dimension:

- **2.1** established the problem: single-tenant GPU allocation with fractional usage is the dominant fleet waste.
- **2.2** gave the hardware solution: MIG partitions — strong isolation, coarse granularity, static layout.
- **2.3** gave the software solution: MPS and time-slicing — flexible density, no hardware fence.
- **2.4** (this post) completed the picture: sharing is a utilization lever; isolation is its price. The engineering decision is matching the isolation guarantee to the blast radius you can tolerate.

## Part 3 handoff

Part 2 was about fitting MANY jobs onto ONE unit — the within-GPU problem. Part 3 (Job Scheduling) zooms out: given a cluster of many GPUs, how do you place jobs ACROSS them? Gang scheduling (a multi-GPU job needs all its GPUs at once or none), topology-aware placement (put communicating GPUs under the same leaf switch — 1.5's hop-counting problem), bin-packing (fit small jobs into the gaps large jobs leave).

The connection: the scheduler that places jobs across GPUs also decides who co-locates with whom on a shared GPU. Isolation isn't just a per-GPU configuration — it becomes a scheduling input. The cluster scheduler needs to know: "this tenant requires MIG isolation" or "these tenants are trusted and can share via MPS" — and route accordingly.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
