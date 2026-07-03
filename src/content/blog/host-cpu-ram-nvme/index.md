---
title: "1.4 · The Host: Everything Around the Accelerator"
description: "1.1–1.3 were the accelerator itself; this is the machine around it — the CPU, system RAM, and local NVMe that feed the GPUs across a thin PCIe straw. We walk one training step through the host and see where each stage can stall."
date: "07/01/2026"
---

1.1–1.3 covered the accelerator complex — the chip's compute, its memory, and the NVLink mesh binding the 8 GPUs in a box. But those GPUs don't run themselves. A host machine — **CPU, system RAM, and local NVMe** — reads data off disk, shapes it, and feeds it across a PCIe link into the GPUs, all inside the same p5.48xlarge. This post is that host: everything around the accelerator that keeps it fed.

## TL;DR

A GPU doesn't feed itself. Data is read off disk, decoded and shaped on the CPU, staged in system RAM, and shipped across a **PCIe** link into HBM before the math units ever touch it. That whole path is the **host**, and:

1. **The host can starve the GPU.** If the CPU/RAM/disk can't produce and deliver data as fast as the chip consumes it, the chip idles — and a higher-FLOPs GPU (1.1) makes the idle *worse*, not better.
2. **Every stage of a training step can stall for a different reason** — and the fixes live in later parts (scheduling, checkpointing, measurement), not in the hardware.

## Meet the entire host

Here's one p5.48xlarge — **8 H100s in a single server** (not an UltraServer; just one box), the same H100 from 1.1/1.2 — and the full path data travels to reach them:

<figure style="margin:1.5rem 0;background:#f8fafc;border:1px solid #cbd5e1;border-radius:12px;padding:16px;color:#1e293b;font-family:ui-sans-serif,system-ui,sans-serif;font-size:13px;line-height:1.5">
<div style="border:1px dashed #94a3b8;border-radius:8px;padding:8px;background:#fff;text-align:center">① Network storage — S3 / shared filesystem · the full dataset lives here</div>
<div style="text-align:center;color:#64748b;margin:4px 0">▼ prefetch a chunk</div>
<div style="border:1px solid #cbd5e1;border-radius:8px;padding:8px;background:#fff"><b>② Local NVMe · 30 TB</b> <span style="color:#64748b">— caches the chunk so you don't re-hit the network</span></div>
<div style="text-align:center;color:#64748b;margin:4px 0">▼</div>
<div style="border:1px solid #cbd5e1;border-radius:8px;padding:8px;background:#fff"><b>③ CPU · 192 vCPU</b> <span style="color:#64748b">— decode · augment · collate into a batch</span></div>
<div style="text-align:center;color:#64748b;margin:4px 0">▼</div>
<div style="border:1px solid #cbd5e1;border-radius:8px;padding:8px;background:#fff"><b>④ System RAM · 2 TiB</b> <span style="color:#64748b">— batch staged, ready to ship</span></div>
<div style="text-align:center;margin:8px 0"><span style="background:#d97706;color:#fff;font-weight:700;padding:3px 10px;border-radius:4px">⑤ PCIe Gen5 ~64 GB/s — host→GPU · the straw</span></div>
<div style="border:2px solid #2563eb;border-radius:10px;padding:10px;background:#eff6ff"><b style="color:#2563eb">⑥ 8× H100 · 640 GB HBM total</b> <span style="color:#64748b">— forward + backward, reads HBM @ 3.35 TB/s</span><div style="text-align:center;color:#059669;font-weight:700;margin-top:6px">⑦ NVLink ~900 GB/s — the 8 GPUs average gradients with each other (stays in the box)</div></div>
<div style="text-align:center;color:#1e293b;margin-top:8px">⑧ optimizer updates weights in HBM → loop back to ③ for the next batch</div>
<div style="text-align:center;color:#2563eb;font-weight:700;margin-top:6px">▲ ⑨ every N steps: checkpoint weights → RAM → NVMe → network storage</div>
<figcaption style="margin-top:12px;color:#64748b;font-size:12px;line-height:1.5"><b style="color:#1e293b">The speed ladder:</b> HBM ~3.35 TB/s (in a GPU) &gt; NVLink ~900 GB/s (GPU↔GPU, this box) &gt; <b style="color:#b45309">PCIe ~64 GB/s (host↔GPU — the straw)</b> &gt; NVMe ~5 GB/s &gt; network. Steps ①–⑤ are the host feeding the GPUs; ⑥–⑦ are the GPUs doing the work you pay for.</figcaption>
</figure>

The crucial thing: **training is not a one-time dataset load.** It's this loop over small batches, run millions of times. So the host isn't a startup cost you pay once — it has to keep pace on *every* iteration. When it can't produce batches as fast as the GPUs consume them, the accelerators sit idle.

## Walk one training step — and where it stalls

Let's follow a single step through the box, and at each stage name what goes wrong if you do nothing to optimize it. (We'll get to the fixes in later parts — for now, just see the stall.)

**① → ② Get the data local.** The dataset lives on network storage; ideally you prefetch it down to local NVMe.
*Stall:* read straight from S3/network every epoch instead of caching → the network's single-digit GB/s throttles every batch, and the first epoch crawls.

**③ Turn raw bytes into a batch (CPU).** The CPU reads samples, decodes (JPEG/video), augments, and collates.
*Stall:* too few dataloader workers → the CPU can't build batches as fast as the GPUs eat them → GPU utilization sawtooths between 100% and 0%. This is the classic host-bound case.

**④ → ⑤ Stage in RAM, copy across PCIe.** The finished batch sits in system RAM, then crosses the PCIe straw into GPU memory.
*Stall:* unpinned memory and a copy that isn't overlapped with compute → the 64 GB/s straw becomes a visible gap every step instead of hiding under the previous batch's math.

**⑥ Forward + backward on the 8 H100s.** The actual training math.
*Stall:* running in FP32 instead of BF16 leaves most of the H100's math ceiling (1.1) unused; and a batch too small for the model means low arithmetic intensity (1.2) → you're memory-bound and the compute units coast.

**⑦ Gradient sync across the 8 GPUs.** After the backward pass, all 8 must agree on the averaged gradient — over NVLink.
*Stall:* if the sync spills onto PCIe instead of NVLink, or isn't overlapped with the backward pass, 8 expensive GPUs sit waiting on each other.

**⑧ Optimizer step, then loop.** Weights update; back to ③ for the next batch — millions of times.

**⑨ Checkpoint every N steps.** Periodically the whole state (weights + optimizer, ~16 bytes/param from 1.2) is written back down to storage.
*Stall:* a synchronous write of hundreds of GB to disk → every GPU in the job idles for minutes while one process writes.

Notice the pattern: **the GPU can be flawless and still idle at ①, ③, ⑤, ⑦, or ⑨** — because the thing that limited it was never the GPU. That's the whole reason MFU (how close you run to the compute ceiling — 6.1) is so often low.

## Where this goes next

There's no single "fix the host" lever. Each stall above gets addressed somewhere different later in the series — scheduling that places by CPU:GPU ratio (Part 3), checkpoint hygiene (Part 5), the measurement that tells you you're host-bound (Part 6), plus plain data-pipeline engineering that isn't a platform feature at all. For now the point is just to recognize the stalls.

We've now seen the whole single machine — the accelerator and the host feeding it. The last anatomy step is leaving the box.

Next: **1.5 — Inter-Node Fabric.** What happens when a job outgrows one box and the GPUs have to talk over the datacenter network.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
