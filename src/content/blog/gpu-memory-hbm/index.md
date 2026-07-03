---
title: "1.2 · Memory: HBM Capacity and Bandwidth"
description: "The second thing inside the accelerator: its memory. Two numbers — capacity (does it fit) and bandwidth (can you feed the compute) — and which one limits you depends on the workload, not the chip. This is why the FLOPs ceiling from 1.1 is rarely your speed."
date: "07/01/2026"
---

Second anatomy post. 1.1 was the chip's ability to *calculate*; this is the chip's **memory** — the other facet sitting right on the accelerator package. It's also where 1.1's cliffhanger gets paid off: the reason the FLOPs ceiling is rarely your actual speed lives here.

## TL;DR

The memory on an accelerator (**HBM** — high-bandwidth memory, stacked on the chip) has **two** numbers that answer two different questions:

1. **Capacity (GB)** — *does the job fit?* A hard wall: fit, or you can't run it on that unit.
2. **Bandwidth (TB/s)** — *can you feed the compute fast enough?* The math units from 1.1 are so fast they usually sit idle waiting for data.

The thing to hold onto: **which resource limits you — capacity, bandwidth, or FLOPs — depends on the workload, not just the chip.** The same GPU running the same model can be limited by a different one of the three depending on how you use it.

## Why memory matters

A chip's compute ceiling (1.1) is worthless if the data can't get to the math units, or if the model doesn't fit in the first place. Everything the GPU works on has to live in HBM — model weights, activations, the optimizer state during training, the KV cache during inference — and every number the math units consume has to be *read out of* HBM. So memory shows up as two limits: **how much you can hold** (capacity) and **how fast you can move it** (bandwidth).

The concept that ties bandwidth to speed is **arithmetic intensity**: how much math you do per byte you fetch. Do a lot of math per byte → the math units stay busy → you're **compute-bound**. Do little math per byte → the units starve waiting on memory → you're **memory-bound**.

## Three examples on one chip

All three use one of the p5.48xlarge's H100s (80 GB HBM, ~3.35 TB/s bandwidth, ~990 BF16 TFLOPS). Numbers are rounded, using the standard ≈2×params FLOPs-per-token heuristic.

### 1. Capacity-bound — "it doesn't even fit"

Serving Llama-70B in FP16 on one H100. Weights alone are 70B × 2 bytes = **140 GB** — already larger than the 80 GB on the card. It won't load. FLOPs and bandwidth never enter the conversation; you're forced to shard the model across ≥2 GPUs (which drags in the fabric — 1.3 and 1.5).

Training is hungrier still. A full fine-tune has to hold weights + gradients + an FP32 master copy + the optimizer's two moment buffers — roughly **16 bytes per parameter**. For 70B that's ~1,120 GB, or about 14 H100s' worth of memory *just to hold the job before any compute happens.*

**Capacity sets the minimum number of units a job needs — before scheduling even starts.**

### 2. Bandwidth-bound — "the chip is starved"

LLM decode: generating tokens one at a time (batch 1), with a 13B model (26 GB, fits comfortably on one H100). Every new token has to read *all* the weights out of HBM once:

- Memory: 26 GB ÷ 3.35 TB/s ≈ **7.8 ms per token**
- Compute: 2 × 13B = 26 GFLOP ÷ 990 TFLOPS ≈ **0.026 ms per token**

Memory takes ~300× longer than the math. You're completely bandwidth-bound — capped around ~128 tokens/sec — and a chip with twice the FLOPs would change nothing. Why: each weight is loaded, used for a single multiply, and thrown away. Almost no math per byte (very low arithmetic intensity).

### 3. FLOPs-bound — "finally, the math is the limit"

Same 13B model, same H100 — but now prefill a 2,048-token prompt (or train with a large batch). Each weight read from HBM is now reused across all 2,048 tokens:

- Compute: 2 × 13B × 2,048 ≈ 53 TFLOP ÷ 990 TFLOPS ≈ **54 ms**
- Memory: still read the 26 GB of weights once ≈ **7.8 ms**

Now compute takes ~7× longer than memory — you're **compute-bound**, and the FLOPs ceiling from 1.1 finally decides your speed.

The punchline: *same chip, same model* — going from 1 token (decode) to 2,048 tokens (prefill) flipped the bottleneck from memory to compute. The lever is arithmetic intensity — how many tokens share each weight-load — which for training is essentially your batch size.

## Summary

| Workload | Binding resource | Why |
|---|---|---|
| Load 70B on 1 GPU | **Capacity** | 140 GB > 80 GB — won't fit |
| Decode, batch 1 | **Bandwidth** | reads all weights per token; ~1 op per byte |
| Prefill / big-batch training | **FLOPs** | each weight reused across many tokens |

Capacity is a hard wall — fit or don't. Bandwidth vs FLOPs is a sliding scale set by how much math you do per byte you move.

## This is why the FLOPs ceiling is rarely your speed

Back to 1.1: the spec-sheet TFLOPs is the most the chip *could* do. Example 2 shows why you usually don't get near it — for a huge class of real work (all single-stream inference decode, plus anything with small batches) you're limited by how fast memory can feed the chip, not by the chip's math. The FLOPs number only sets your speed in the compute-bound regime (example 3).

## What it means downstream

- **Capacity → unit count.** "Does it fit" decides how many GPUs a job needs, which becomes a gang-scheduling constraint later (Part 3).
- **Doesn't fit → units must talk.** Sharding a model across GPUs makes the fabric a first-class concern — 1.3 (intra-node) and 1.5 (inter-node).
- **The honest number.** How close you actually run to the compute ceiling has a name — MFU — and memory-boundedness is a big reason it's often low (6.1).

Next: **1.3 — Intra-Node Fabric.** When a model outgrows one GPU (example 1), the links between the GPUs inside the box decide how fast they can split the work.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
