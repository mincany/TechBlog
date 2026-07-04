---
title: "2.1 · One GPU, Many Jobs: The Case for Sharing"
description: "A whole accelerator handed to a job that uses a sliver of it is the most common waste; the fork between splitting in space and sharing in time."
date: "07/02/2026"
---

Part 1 mapped the anatomy of a single unit of compute — what's inside (1.1 Compute, 1.2 Memory, 1.3 Intra-Node Fabric), what surrounds it (1.4 The Host), and what connects units together (1.5 Inter-Node Fabric). Those posts established the ceilings. Part 2 pivots: we're no longer asking *how fast can one unit go* but **how much of that unit actually gets used** — and what happens when the answer is "not much."

## TL;DR

1. **The most common fleet waste is a whole accelerator handed to a job that uses a sliver of it.** A batch-1 decode job on an H100 touches ~33% of HBM and ~0.3% of peak FLOPs — the rest of the unit sits idle on your bill.
2. **Two strategies exist to pack multiple jobs onto one GPU — split in space (fixed slices) or share in time (concurrent access) — and choosing wrong trades idle waste for interference.**

## The problem: one tenant, fractional use

In most cluster schedulers today, a GPU is the smallest schedulable unit. You request one GPU; you get the whole thing — all 80 GB of HBM, all 132 SMs, all ~990 BF16 TFLOPS. The scheduler marks that unit as occupied and moves on.

This works fine when a single job saturates the hardware. Large-batch training on a 70B model across multiple GPUs hammers every resource — memory full, SMs busy, fabric hot. No sharing needed because nothing is idle.

But a huge portion of real production work looks nothing like that. Inference serving, small fine-tune runs, preprocessing pipelines, evaluation jobs — all commonly use a fraction of what a single H100 provides. The accelerator stays allocated, power stays on, the meter keeps running, and most of the silicon does nothing.

## Why it matters — one worked example

Take the canonical p5.48xlarge: 8× H100, each with 80 GB HBM, ~3.35 TB/s bandwidth, ~990 BF16 TFLOPS.

Consider one H100 running a 13B model in BF16 for single-stream inference (batch size 1) — exactly the bandwidth-bound decode scenario from 1.2:

- **Memory footprint:** 13B × 2 bytes = ~26 GB. That's **33% of the 80 GB** on the card. The remaining 54 GB sits allocated but unused.
- **Compute utilization:** Each token does ~26 GFLOP of work (2 × 13B). At batch 1, you generate ~128 tokens/sec (memory-bound at ~7.8 ms/token). Effective throughput: 128 × 26 GFLOP = ~3.3 TFLOPS. Against the ~990 TFLOPS ceiling, that's **0.3% of peak FLOPs** — the SMs are busy issuing memory loads and waiting, not doing math.
- **Bandwidth utilization:** ~26 GB read per token at ~128 tokens/sec = ~3.3 TB/s, against the 3.35 TB/s ceiling. Bandwidth is the *one* resource this job actually uses; compute and capacity sit almost entirely idle.

The numbers: one H100 allocated to this job leaves **~67% of its memory empty** and **~99.7% of its FLOPs untouched**. Multiply that by the 7 other H100s on this p5.48xlarge whenever they're waiting for work, and the idle fraction dominates the bill.

**The utilize-vs-fallback contrast:** Pack two independent 13B serving instances onto a single H100 — 2 × 26 GB = 52 GB of weights, leaving ~28 GB for KV cache and activations — and one unit serves both streams instead of you paying for two. The fallback — one job per GPU — bills you for a second H100 to do work the first one had room for. Stack more, smaller tenants and the multiple grows.

At fleet scale, this is the dominant waste mode. Not slow fabric, not undersized memory — just whole accelerators sitting mostly idle because the scheduler can't subdivide them.

## The fork: two strategies

The hardware gives you one fast unit. Sharing it among multiple jobs is a system-architecture decision, and it splits into two fundamentally different approaches:

### Split in space — fixed partitions

Carve the GPU into smaller, hardware-isolated pieces. Each piece gets a fixed fraction of memory and SMs. Jobs see a smaller "virtual GPU" and can't touch each other's resources.

NVIDIA's MIG (Multi-Instance GPU) on A100 and H100 is the public implementation. An H100 can be sliced into up to 7 instances (at the smallest slice size), each with its own memory controllers and SM partitions. The slices are real hardware boundaries — one tenant can't access another's HBM, and a runaway kernel in one partition can't steal cycles from another.

The trade-off: rigid. Partitions come in a small set of fixed sizes. If your job needs a bit more than half a GPU, the next slice up hands you far more than that (stranding the difference), or you fall back to the whole GPU and we're back to square one. Exact profiles in 2.2.

### Share in time — concurrent execution

Let multiple jobs run on the *full* GPU by multiplexing access. Jobs share all SMs and all memory, taking turns or running simultaneously.

Two public mechanisms exist:
- **Time-slicing** — the GPU context-switches between jobs rapidly. Each job sees the full GPU during its slice. Simple, but only one job's kernels are active at any instant, so total throughput is bounded by switching overhead.
- **MPS (Multi-Process Service)** — multiple CUDA contexts submit kernels concurrently to the same GPU. Kernels from different jobs actually execute in parallel on different SMs. Higher throughput potential, but no hardware memory isolation between tenants.

The trade-off: flexible (any job mix, no fixed partition sizes), but tenants share a blast radius. A memory leak in one process can OOM everyone. A long-running kernel can starve neighbors of SM time.

## When idle waste is the bottleneck

Sharing becomes urgent when:

- **Inference workloads dominate** — serving jobs are typically memory-light and compute-light per request. A fleet of H100s doing batch-1 decode at <1% SM utilization is burning money.
- **Many small jobs coexist** — fine-tuning LoRA adapters, running evals, preprocessing datasets. Each needs a GPU for minutes but uses a fraction of one.
- **Cost pressure meets SLA** — you want to consolidate onto fewer GPUs to reduce spend, but each tenant still needs predictable latency.

Sharing is *not* the right move when a single job already saturates the unit (large-batch training, high-throughput batch inference with large batches) — you'd only add contention to something already running at capacity.

## Where this goes next

The fork established here — space vs time — structures the rest of Part 2:

- **2.2** dives into MIG: how partitions are defined, what configurations exist on H100, and when fixed slicing is the right trade-off.
- **2.3** covers MPS and time-slicing: the mechanics of concurrent execution, when it outperforms MIG, and what "no hardware isolation" means in practice.
- **2.4** addresses the catch: sharing only pays off if one job can't steal another's memory or tail latency. Isolation — the cost of getting sharing wrong.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
