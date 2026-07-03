---
title: "1.1 · Compute: FLOPs, Precision, and the 10× Hidden in a Spec Sheet"
description: "This post is only about one thing inside the accelerator: its ability to calculate. The same chip has a ~10× range of 'speed' depending on precision — but that number is a ceiling, and most of the time you never reach it."
date: "07/01/2026"
---

This is the first anatomy post — we crack open the "unit" that 0.1 treated as a black box. A unit of compute has a few distinct parts (compute, memory, the host around it, the fabric between units — the interconnect that wires components into a network, like NVLink), and this post is about exactly one of them: **the chip's ability to calculate.** Memory is 1.2, the in-box NVLink fabric is 1.3, the host around it is 1.4, and the network beyond the box is 1.5. Keep this narrow scope in mind — it matters for the punchline at the end.

Throughout Part 1 I use one concrete box as the running example: a **p5.48xlarge** — 8× NVIDIA H100. It was the first AI-dedicated instance I worked on, so it's the hardware I know best; its numbers (the H100's FLOPs and HBM here, then NVLink and PCIe in later posts) ground every example.

## TL;DR

The compute a chip can do is measured in **FLOPS** (math operations per second), and it matters because training and inference are, underneath, mostly matrix multiply — so more math per second means more model trained or served. The trap: it isn't one number. The *same* die delivers a ~10× range of FLOPS depending on **precision** (how many bits per number) and **sparsity** — and the number on the spec sheet is the most flattering corner, not the one your job runs at.

Two things to hold onto:
1. **Count is not capability** — you schedule by count (`nvidia.com/gpu: 1`), but the work is done by capability.
2. **Lower precision raises the ceiling, not necessarily your speed.**

## What FLOPs is, and why it matters

A **FLOP** is one floating-point operation — a single multiply or add on decimal numbers. **FLOPS** is how many of those a chip can do per second (TFLOPS = trillions/sec, PFLOPS = quadrillions/sec).

Why it's the headline number: training and inference are, underneath, enormous piles of matrix multiplications — nothing but multiplies and adds, by the billions. So "how much math per second" is a reasonable first proxy for "how fast can this chip train or serve a model." That's why every accelerator leads with a big TFLOPS number.

The problem is that the single number hides a choice.

## Precision: fewer bits, more math per second

**Precision** = how many bits you use to store each number:

- FP32 — 32 bits — very exact
- TF32 / BF16 / FP16 — ~16–19 bits — less exact
- FP8 — 8 bits — coarse
- FP4 — 4 bits — very coarse

The trade is simple: **fewer bits per number → the chip can push more of them per second.** Roughly, each time you halve the bits you double the throughput. Coarser numbers, more math per second.

**Sparsity** is the last multiplier: if you arrange the math so half the values are zero, the chip can skip them and roughly double the number *again*. Marketing quotes this "with sparsity" figure; real workloads rarely achieve it.

## One chip, many numbers

Here's one of the p5.48xlarge's H100s (SXM), reading its own public datasheet, peak tensor-core throughput:

| How you count | FLOPS (same chip) |
|---|---|
| FP32 | ~67 TFLOPS |
| TF32 | ~495 TFLOPS |
| BF16 / FP16 (what most training uses) | ~990 TFLOPS (dense) |
| FP8 | ~1,980 TFLOPS (dense) |
| **FP8 + sparsity — the headline** | **~3,960 TFLOPS** |

Same silicon. The datasheet shouts "**~4,000 TFLOPS**" (bottom row), but a real BF16 training step runs at ~990 — a **4× gap on the identical chip**. Line the very top up against plain FP32 and it's ~60×. That's the "10× (and then some) hidden in a spec sheet."

## Count is not capability

A scheduler sees `nvidia.com/gpu: 1`. But in BF16 (dense, peak):

- **A100** → ~312 TFLOPS
- **B200** → ~2,250 TFLOPS

Both report "**1 GPU**." The scheduler treats them as identical — but the B200 is ~7× the compute. So "we have 100 GPUs" tells you almost nothing about how much compute you actually have. You schedule by count; you get work done by capability.

## The ceiling is not your speed

This is the part to internalize, because it's where people go wrong. Everything above is about the **ceiling** — the most math the chip *could* do. Almost no real workload runs at the ceiling:

- **Memory-bound (the common case).** The compute units sit idle waiting for data to arrive from memory. When that's the limit, your speed is set by memory *bandwidth*, not FLOPS — buying a higher-FLOPS chip barely helps. (That's the next post, 1.2.)
- **Poorly utilized.** Small batches, pipeline stalls, waiting on the network — the chip is fed unevenly and coasts. The honest "how close to the ceiling did you actually get" number is **MFU** (Model FLOPs Utilization), and in practice it's often well under half. (That's 6.1.)

So the FLOPS number decides your throughput **only when you're compute-bound.** The rest of the time — which is most of the time — a bigger ceiling changes nothing. Treat the spec-sheet TFLOPS as a *ceiling*, not a *speed*.

## What lowering precision means for training vs inference

Fewer bits = coarser numbers = more rounding error. Who can tolerate that differs sharply:

- **Training is sensitive.** Updates are tiny and errors *compound* over millions of steps, so too few bits can make training unstable or hurt final accuracy. The real practice is **mixed precision**: do the bulk of the math in BF16 (increasingly FP8), while keeping a higher-precision "master copy" of the weights so small updates don't vanish into rounding. **BF16 is the workhorse; FP8 training is newer and needs careful scaling.**
- **Inference is forgiving.** There are no gradient updates, so rounding doesn't snowball — you just run the finished model. So people **quantize** aggressively: FP8, and FP4 on the newest chips, often with only ~1% quality loss. That's why the very-low-precision headline numbers are really *inference* numbers.

The one-liner: **lower precision buys speed and memory savings by giving up numeric fidelity — training can only give up a little, inference can give up a lot.**

## Where this leaves us

Compute is the first facet of the unit, and its headline is a ceiling that (a) depends entirely on the precision you quote and (b) is rarely what actually limits you. The scheduler, meanwhile, can't see any of this — it counts identical "1 GPU"s.

Next: **1.2 — Memory.** Whether you can even *reach* the compute ceiling usually comes down to how fast you can feed the chip, and whether the model fits at all.

---

*Opinions are my own and do not represent my employer. All figures are from public vendor datasheets and refer to peak tensor-core throughput (dense unless noted). Everything here refers to publicly documented concepts and products.*
