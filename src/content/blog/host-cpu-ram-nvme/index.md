---
title: "1.5 · The Host Around the Accelerator: CPU, RAM, and Local NVMe"
description: "The last piece of a unit of compute isn't on the accelerator at all — it's the CPU, system RAM, and local disk feeding it across a thin PCIe straw. When the host starves the GPU, no faster GPU helps — and its fix isn't in this Part. This post closes the anatomy and bridges into the rest of the series."
date: "07/01/2026"
---

This is the last anatomy post, and it's the odd one out. 1.1–1.4 walked a clean spatial zoom: compute and memory **on** the chip (1.1, 1.2), NVLink **across chips in a box** (1.3), the network **across boxes** (1.4). This post is about the plumbing that wraps the accelerator — the **CPU, system RAM, and local NVMe** that feed it. It doesn't sit on that zoom ladder; it's orthogonal support. And unlike the others, its bottleneck has no clean fix inside this Part — which is exactly why it makes the bridge into the rest of the series.

## TL;DR

A GPU doesn't feed itself. Data is read off disk, decoded and shaped on the CPU, staged in system RAM, and shipped across a **PCIe** link into HBM before the math units ever touch it. That whole path is the **host**, and:

1. **The host can starve the GPU.** If the CPU/RAM/disk can't produce and deliver data as fast as the chip consumes it, the chip idles — and a higher-FLOPs GPU (1.1) makes the idle *worse*, not better.
2. **Host-bound has no single fix — and some of it isn't a platform problem at all.** The fixes are scattered across later parts (scheduling, failure recovery, measurement) plus plain data-pipeline engineering. That's the bridge this post builds.

## Meet the box: one p5.48xlarge

Before the failure modes, here's the actual machine and how one training step flows through it. This is a single p5.48xlarge — **8 H100s in one server** (not an UltraServer; just one box), the same H100 we used in 1.1/1.2:

<figure style="margin:1.5rem 0;background:#f8fafc;border:1px solid #cbd5e1;border-radius:12px;padding:16px;color:#1e293b;font-family:ui-sans-serif,system-ui,sans-serif;font-size:13px;line-height:1.4">

  <div style="border:1px dashed #94a3b8;border-radius:8px;padding:8px;background:#fff;text-align:center">
    <b>①  Network storage</b> — S3 / shared filesystem · the full dataset lives here
  </div>
  <div style="text-align:center;color:#64748b;font-size:15px;margin:2px 0">▼ &nbsp;prefetch a chunk</div>

  <div style="border:2px solid #475569;border-radius:12px;padding:12px;background:#fff">
    <div style="font-size:11px;font-weight:700;letter-spacing:.05em;color:#64748b;margin-bottom:8px">THE HOST — feeds the GPUs</div>

    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <div style="flex:1;min-width:120px;border:1px solid #cbd5e1;border-radius:8px;padding:8px;background:#f8fafc">
        <b>②  Local NVMe</b><div style="color:#64748b">30 TB · caches the chunk</div>
      </div>
      <div style="flex:1;min-width:120px;border:1px solid #cbd5e1;border-radius:8px;padding:8px;background:#f8fafc">
        <b>③  CPU · 192 vCPU</b><div style="color:#64748b">decode · augment · collate</div>
      </div>
      <div style="flex:1;min-width:120px;border:1px solid #cbd5e1;border-radius:8px;padding:8px;background:#f8fafc">
        <b>④  System RAM · 2 TiB</b><div style="color:#64748b">batch staged, ready</div>
      </div>
    </div>

    <div style="text-align:center;margin:10px 0">
      <span style="display:inline-block;background:#d97706;color:#fff;font-weight:700;padding:3px 10px;border-radius:4px">⑤  PCIe Gen5 — copy batch host→GPU · ~64 GB/s · the straw</span>
    </div>

    <div style="border:2px solid #2563eb;border-radius:10px;padding:10px;background:#eff6ff">
      <div style="font-size:11px;font-weight:700;color:#2563eb;margin-bottom:6px">⑥  8× H100 — 640 GB HBM total · forward + backward (reads HBM @ 3.35 TB/s)</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center">
        <span style="border:1px solid #cbd5e1;border-radius:5px;padding:4px 7px;background:#fff">H100</span>
        <span style="border:1px solid #cbd5e1;border-radius:5px;padding:4px 7px;background:#fff">H100</span>
        <span style="border:1px solid #cbd5e1;border-radius:5px;padding:4px 7px;background:#fff">H100</span>
        <span style="border:1px solid #cbd5e1;border-radius:5px;padding:4px 7px;background:#fff">H100</span>
        <span style="border:1px solid #cbd5e1;border-radius:5px;padding:4px 7px;background:#fff">H100</span>
        <span style="border:1px solid #cbd5e1;border-radius:5px;padding:4px 7px;background:#fff">H100</span>
        <span style="border:1px solid #cbd5e1;border-radius:5px;padding:4px 7px;background:#fff">H100</span>
        <span style="border:1px solid #cbd5e1;border-radius:5px;padding:4px 7px;background:#fff">H100</span>
      </div>
      <div style="text-align:center;margin-top:6px;color:#059669;font-weight:700">⑦  NVLink ~900 GB/s — the 8 GPUs average gradients with each other (stays in the box)</div>
    </div>

    <div style="text-align:center;margin-top:8px;color:#1e293b">⑧  optimizer updates weights in HBM → <b>loop back to ③</b> for the next batch</div>
  </div>

  <div style="text-align:center;color:#2563eb;font-weight:700;margin-top:6px">▲ &nbsp;⑨  every N steps: checkpoint weights → RAM → NVMe → network storage</div>

  <figcaption style="margin-top:12px;color:#64748b;font-size:12px;line-height:1.5">
    <b style="color:#1e293b">The speed ladder:</b> HBM ~3.35 TB/s (in a GPU) &gt; NVLink ~900 GB/s (GPU↔GPU, this box) &gt; <b style="color:#b45309">PCIe ~64 GB/s (host↔GPU — the straw)</b> &gt; NVMe ~5 GB/s &gt; network. Steps ①–⑤ are the <b style="color:#b45309">host feeding the GPUs</b>; ⑥–⑦ are the GPUs doing the work you pay for. If the host can't keep pace on ①–⑤, the 8 H100s idle.
  </figcaption>
</figure>

Read it top-to-bottom as one training step: data comes off network storage into the NVMe cache (①–②), the CPU turns raw samples into a ready batch in RAM (③–④), that batch crosses the **PCIe straw** into GPU memory (⑤), the 8 H100s run the math (⑥) and average gradients over NVLink (⑦), weights update and the loop repeats (⑧), and occasionally the whole state is checkpointed back down (⑨).

The crucial thing: **training is not a one-time dataset load.** It's this loop over small batches, run millions of times. So the host isn't a startup cost you pay once — it has to keep pace on *every* iteration. Steps ①–⑤ are the host's job; steps ⑥–⑦ are what you're paying for. When the host can't produce batches as fast as the GPUs consume them, the accelerators sit idle waiting.

## Why the host matters

Everything the GPU works on climbs a hierarchy to reach it, and each tier down is ~10× slower:

| Tier | Where it is | Bandwidth (order of magnitude) |
|---|---|---|
| HBM | on the GPU package | ~3.35 TB/s |
| NVLink | GPU ↔ GPU in the box | ~900 GB/s |
| **PCIe Gen5 x16** | **host ↔ GPU link** | **~64 GB/s** |
| Local NVMe SSD | in the server | ~a few–14 GB/s |
| Network storage | across the datacenter | ~1–10 GB/s |

The GPU is at the top, fast and hungry. Everything feeding it is slower, and PCIe is the narrow neck all host data squeezes through. When any tier below HBM is the limit, your job runs at *that tier's* speed — not the GPU's. Here are the three ways that bites.

## Three examples on one host

All three use the box above. Numbers are rounded and illustrative — they show the mechanism, not a benchmark of a specific deployment.

### 1. CPU/RAM-bound — the dataloader can't keep up

Vision-style training. The GPU does the forward/backward pass fast, but every batch first has to be read, JPEG-decoded, resized, augmented, and collated — all on the **CPU** (step ③).

- One H100 chews through a batch at **~2,800 images/sec** (mixed precision).
- CPU decode+augment runs at **~350 images/sec per core**.

Now the CPU:GPU ratio decides everything:

- **14 cores/GPU** → ~4,900 images/sec produced → the CPU keeps the GPU fed. Good.
- **4 cores/GPU** (a thin host, or too many GPUs per box) → ~1,400 images/sec → the GPU is starved to **half its throughput**, waiting on the dataloader.

Same GPU, same model. The only thing that changed is how much CPU sits behind each accelerator — a number the spec sheet's "1 GPU" never mentions.

### 2. Storage-bound — the checkpoint stall

Training a 70B model. From 1.2, a full training checkpoint is weights + gradients + optimizer state ≈ **16 bytes/param → ~1,120 GB** (step ⑨). If the write is synchronous:

- Write to local NVMe at ~5 GB/s → 1,120 GB ÷ 5 ≈ **224 s** — nearly **4 minutes** of every GPU doing nothing.
- Shard the write across 8 nodes → each writes ~140 GB → ~**28 s** stalled.

The GPU's FLOPs are irrelevant here; the stall is set entirely by **storage bandwidth**.

### 3. The PCIe straw — cold-start model load

Bring up a fresh inference replica serving the 13B model from 1.2 (**26 GB** of weights). The weights travel storage → RAM → across PCIe → HBM (steps ①→⑤):

- HBM *could* absorb 26 GB in 26 ÷ 3,350 ≈ **0.008 s**.
- But PCIe Gen5 delivers it at ~64 GB/s → 26 ÷ 64 ≈ **0.4 s** for the host→device copy.
- And if the weights start on network storage at ~2 GB/s → 26 ÷ 2 ≈ **13 s** before the replica serves a single token.

The destination is ~50× faster than the pipe feeding it. For a long training run that one-time load is noise; for autoscaling inference, those seconds *are* your cold-start latency.

## Summary

| Scenario | Binding host resource | Why |
|---|---|---|
| Dataloader can't keep up | CPU cores + RAM | decode/augment throughput < GPU consumption |
| Checkpoint stall | Local NVMe / network storage BW | 100s of GB written synchronously |
| Cold-start load | PCIe link (+ source storage) | weights cross a 64 GB/s straw into 3.35 TB/s HBM |

The GPU can be flawless in all three and still idle — because the thing that limited it was never the GPU. That's the whole reason MFU (how close you run to the compute ceiling — 6.1) is often low: 1.2 showed memory-boundedness as one cause; the host is the other big one.

## So where does the fix live?

Here's the honest part, and the reason this post closes Part 1 instead of sitting in the middle of it. **There is no "Host Sharing" or "Host Scheduling" module.** Unlike compute or memory, the host's bottleneck has no single lever — its fixes are scattered across the rest of the series, and some aren't a platform problem at all:

| Host-bound flavor | Where it gets addressed | Kind of fix |
|---|---|---|
| Dataloader starves GPU | **Part 3 — Job Scheduling**: place by CPU:GPU:RAM ratio, not GPU count alone | Platform (partial) |
| — also | Workload engineering: more dataloader workers, deeper prefetch, GPU-side decode, NVMe caching | **Not a platform lever** — it's on the job owner |
| Checkpoint stall | **Part 5 — Failure Recovery**: async / sharded checkpointing hides the write behind compute | Platform |
| Any host starvation | **Part 6 — Measurement**: low MFU is how you *detect* you're host-bound | Detection, not a fix |
| Wrong box shape | Provisioning: pick an instance with the right CPU:GPU:RAM:NVMe ratio | Procurement |

Two things worth calling out, because they're counterintuitive:

- **GPU sharing (Part 2) doesn't fix host-bound — it can make it *worse*.** Packing more jobs onto one box adds contention for the same CPU, RAM, and PCIe. What sharing *does* do is claw back the idle GPU cycles a host-bound job leaves on the table — it improves cluster utilization, not your job's speed.
- **Cluster sharing (Part 4) is orthogonal.** It's about quota and capacity across teams, not about feeding a chip.

So the host is the seam where "the unit of compute" meets everything the rest of the series is about — scheduling, sharing, recovery, measurement. That's why it's last in Part 1 and first to hand off.

Next: **Part 2 — GPU Sharing.** We've dissected one unit; now we start splitting it — and immediately run into the contention this post just previewed.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
