---
title: "1.1 · Compute: FLOPs, Precision, and the 10× Hidden in a Spec Sheet"
description: "The same chip delivers a ~10× range of throughput depending on precision. The spec-sheet number is a ceiling, and most workloads never touch it."
date: "07/01/2026"
---

This is the first anatomy post. In 0.1 we treated the "unit" as a black box; now we crack it open. A unit of compute has distinct parts (compute, memory, the host around it, the interconnect fabric between units), and this post covers exactly one: **the chip's ability to calculate.** Memory is 1.2, the in-box NVLink fabric is 1.3, the host is 1.4, the network beyond the box is 1.5.

Throughout Part 1 I use one concrete box as the running example: a **p5.48xlarge** (8× NVIDIA H100). It was the first AI-dedicated instance I worked on, so it's the hardware I know best. Its numbers ground every worked example in the series.

## TL;DR

Compute throughput is measured in FLOPS (math operations per second). The same H100 die delivers anywhere from ~67 TFLOPS (FP32) to ~3,960 TFLOPS (FP8 + sparsity) depending on precision and sparsity. The upper endpoint assumes sparsity, which real workloads rarely achieve cleanly. **The spec-sheet headline is the most flattering corner, not the one your workload runs at.** Most real training happens at BF16 (~990 TFLOPS peak), and even that is a ceiling you rarely reach because memory bandwidth or poor utilization bottleneck you first. A scheduler sees none of this: it counts "1 GPU" regardless of capability.

## FLOPs: what it measures and why it's the headline

A FLOP is one floating-point operation (a multiply or add on floating-point values). FLOPS is how many of those a chip executes per second. Training and inference are, at bottom, enormous piles of matrix multiplications, so "math per second" is a reasonable first proxy for throughput.

Every accelerator leads with a big TFLOPS number. The problem is that a single number hides a choice.

## Precision: fewer bits, more math per second

Precision is how many bits store each number:

- FP32 (32 bits, very exact)
- TF32 / BF16 / FP16 (16–19 bits, less exact)
- FP8 (8 bits, coarse)
- FP4 (4 bits, very coarse)

Fewer bits per number means the chip can push more of them per second. Roughly, halving the bits doubles the throughput.

**Sparsity** is a separate multiplier: if half the values are zero, the chip can skip them and roughly double throughput again. Marketing quotes this figure; real workloads rarely achieve it cleanly.

## One chip, many numbers

Here is one H100 (SXM) from the p5.48xlarge, reading its public datasheet (peak tensor-core throughput):

| Precision | FLOPS (same chip) |
|---|---|
| FP32 | ~67 TFLOPS |
| TF32 | ~495 TFLOPS |
| BF16 / FP16 (most training) | **~990 TFLOPS** (dense) |
| FP8 | ~1,980 TFLOPS (dense) |
| FP8 + sparsity (the headline) | ~3,960 TFLOPS |

Same silicon. The datasheet shouts ~4,000 TFLOPS (bottom row), but a real BF16 training step runs at ~990, a 4× gap on the identical chip. Compare sparse FP8 with plain FP32 and the range is ~60×, well beyond the 10× in the title.

## Count is not capability

A scheduler sees `nvidia.com/gpu: 1`. But in BF16 dense peak:

- **A100:** ~312 TFLOPS
- **B200:** ~2,250 TFLOPS

Both report "1 GPU." The B200 is ~7× the compute. "We have 100 GPUs" tells you almost nothing about how much work you can do. You schedule by count; you get throughput by capability.

## The ceiling is not your speed

Everything above describes the ceiling. Almost no real workload runs there:

- **Memory-bound (the common case).** Compute units sit idle waiting for data from memory. When that's the limit, your speed is set by memory bandwidth, not FLOPS. A higher-FLOPS chip barely helps. (1.2 covers this.)
- **Poorly utilized.** Small batches, pipeline stalls, network waits. The chip is fed unevenly and coasts. The honest metric is **MFU** (Model FLOPs Utilization), and in practice it's often well under half. (6.1 returns to this metric.)

FLOPS decides throughput only when you're compute-bound. The rest of the time, a bigger ceiling changes nothing.

## Training vs inference: who can afford fewer bits

Fewer bits means more rounding error. The tolerance differs:

- **Training is sensitive.** Gradient updates are tiny and errors compound over millions of steps. Too few bits makes training unstable or hurts final accuracy. The standard practice is mixed precision: bulk math in BF16 (increasingly FP8), with a higher-precision master copy of the weights so small updates don't vanish. BF16 is the workhorse; FP8 training is newer and needs careful scaling.
- **Inference is forgiving.** No gradient updates, so rounding doesn't snowball. People quantize aggressively (FP8, FP4 on newer chips) with often ~1% quality loss. The very-low-precision headline numbers are really inference numbers.

Lower precision buys speed and memory savings by giving up numeric fidelity. Training can only give up a little; inference can give up a lot.

## Where this leaves us

Compute is the first facet of the unit, and its headline is a ceiling that depends entirely on precision and is rarely what actually limits you. The scheduler can't see any of this.

Next: **1.2 · Memory.** Whether you reach the compute ceiling usually comes down to how fast you can feed the chip, and whether the model fits at all.

---

*Opinions are my own and do not represent my employer. All figures are from public vendor datasheets and refer to peak tensor-core throughput (dense unless noted). Everything here refers to publicly documented concepts and products.*
