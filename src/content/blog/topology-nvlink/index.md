---
title: "1.3 · Intra-Node Fabric: NVLink and NVSwitch"
description: "The third component: the links between the GPUs inside one box. On a p5.48xlarge, 8 GPUs aren't 8 independent cards — NVLink wires them into one unit. The catch is that your software has to actually use that fast lane, or it silently falls back to a path ~14× slower."
date: "07/01/2026"
---

Third anatomy post. 1.1 and 1.2 were about a single chip — its compute and its memory. But 1.2's first example already forced the issue: a 70B model doesn't fit on one H100, so you *have* to split it across several GPUs. The moment a job spans more than one GPU, a new thing decides your speed — the **link between them**. Inside a single box that link is **NVLink**.

Same running example as the rest of Part 1: a **p5.48xlarge** — 8× H100, ~900 GB/s NVLink between the GPUs, ~64 GB/s PCIe to the host.

## TL;DR

The 8 GPUs in a p5.48xlarge are wired to each other by a dedicated high-bandwidth mesh — **NVLink**, connected all-to-all through **NVSwitch**. Two things to hold onto, and the second is the one that matters as a software engineer:

1. **8 GPUs in a box are one tightly-coupled unit, not 8 independent cards** — because NVLink lets them exchange data ~14× faster than the PCIe path to the host (1.5).
2. **That fast lane isn't automatic — your software has to take it.** Set the job up right and the GPUs talk over NVLink; get it wrong and the exact same job silently falls back to the ~14×-slower host path. Same hardware, wildly different throughput.

## What NVLink and NVSwitch are

PCIe (1.5) connects the host to each GPU at ~64 GB/s — fine for *feeding* a GPU, far too slow for GPUs to *collaborate*. So the 8 GPUs get a second, much faster network wiring them directly to each other:

- **NVLink** — direct GPU-to-GPU links. On a p5.48xlarge, each H100 has ~900 GB/s of NVLink bandwidth.
- **NVSwitch** — an on-board switch so every GPU reaches every other GPU at full NVLink speed, not just its neighbors. All-to-all, no detour through the host.

| Link | Connects | Bandwidth (per GPU) |
|---|---|---|
| HBM | inside one GPU | ~3.35 TB/s |
| **NVLink (+ NVSwitch)** | **GPU ↔ GPU, same box** | **~900 GB/s** |
| PCIe Gen5 x16 | host ↔ GPU | ~64 GB/s |

The gap that matters: **GPU-to-GPU over NVLink is ~14× faster than the host link.** That's the fast lane the hardware hands you. The rest of this post is about the fact that you have to *claim* it.

## Why it matters: split work means constant talking

You split a job across the 8 GPUs for one of two reasons, and both make them talk every step:

- **The model fits, but you want to go faster (data parallelism).** Each GPU holds a full copy of the model and trains on a different slice of the batch. After every step they must **average their gradients** so all copies stay identical — an *all-reduce* across all 8 GPUs.
- **The model doesn't fit (tensor / pipeline parallelism).** From 1.2 — a 70B model is too big for one H100 — so a single layer's math is split across GPUs, and they exchange *activations* many times per step.

Either way, the GPUs repeatedly stop computing and exchange data. Which lane that exchange travels on — NVLink or the host PCIe path — is set by how you configured the job.

## Worked example: the same all-reduce, two lanes

Data-parallel training of a 13B model (BF16) on the p5.48xlarge. Each GPU trains on its own slice of the batch, so each ends up with its own gradient — the size of the weights, 13B × 2 bytes = **26 GB**. **All-reduce** is the step that sums those 8 gradients and hands every GPU back the identical average, so all copies stay in sync. To do it, each GPU pushes its numbers out and pulls everyone else's in; the traffic that crosses each GPU's link to finish is ≈ 1.75 × 26 ≈ **45 GB** — more than the gradient itself, because the data makes several hops around the ring. The only variable is *which* link it crosses:

- **On the NVLink lane** (900 GB/s): 45 ÷ 900 ≈ **50 ms** per step spent syncing.
- **Fallen back to the host PCIe lane** (64 GB/s): 45 ÷ 64 ≈ **710 ms**.

Same box, same model, same code shape. If the forward+backward compute for that step is ~200 ms, then the NVLink sync (50 ms) tucks neatly under it and nearly disappears — while the PCIe fallback (710 ms) *dwarfs* the actual work, and you spend most of every step watching 8 expensive GPUs wait on each other.

**Which lane you get is a software choice.** The GPUs are wired for NVLink either way, but the all-reduce only travels it if you use an NVLink-aware collective library (**NCCL**, the framework default on GPU), one process per GPU, peer-to-peer left on. Get that right and the 50 ms path is automatic; get it wrong and you're mysteriously ~14× slower, with no error to tell you why. The exact setup is later-parts material — the point is the win is yours to claim or lose in software.

## When the fabric is the bottleneck

Even when you're correctly on NVLink, the comms cost isn't free — it grows with how you split the work:

- **More GPUs** → the all-reduce spans more participants and the communication fraction of each step climbs.
- **Tensor parallelism** exchanges activations *inside every layer, twice* per step — far more traffic, and sensitive to **latency**, not just bandwidth. That's why it's almost always kept **within a single node**: it only stays cheap while the GPUs are on the fast, low-latency NVLink mesh.

When the exchange stops overlapping with compute — too many participants, too much per-layer traffic — you're **communication-bound**: GPUs idle, waiting to talk. NVLink raises the ceiling on how much you can split before that happens; using it correctly is what lets you reach that ceiling.

## Where this goes next

The reframe to keep: **a p5.48xlarge is not 8 GPUs, it's one NVLink domain** — a pool of GPUs fast enough to share work as if they were one larger accelerator, *provided your software gets on the NVLink lane.*

That covers the accelerator itself — compute, memory, and the mesh binding the 8 GPUs. But those GPUs don't run in a vacuum: a host machine feeds them, and eventually a job outgrows the box entirely.

Next: **1.4 — The Host.** The CPU, RAM, and disk wrapped around the accelerator, and how they can starve it — then 1.5 leaves the box.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
