---
title: "1.5 · Inter-Node Fabric: Beyond the Host"
description: "The last piece: once a job outgrows a single box it crosses the datacenter network — a leaf-spine tree, not a flat wire. Two GPUs one leaf apart are a few switch hops closer than two GPUs across the spine, and a collective runs at the speed of its worst hop. So placement is a throughput decision."
date: "07/01/2026"
---

Fifth and last anatomy post. Everything so far lived inside one p5.48xlarge — the accelerator complex (1.1–1.3) and the host feeding it (1.4). But the largest jobs outgrow a single box: 8 GPUs isn't enough, so they span many boxes and step *beyond the host* onto the datacenter network. The thing worth understanding isn't the network's raw speed — it's that the network is a *tree*, and where your job lands on that tree decides how fast it runs.

## TL;DR

1. **The inter-node network is a tree with a locality gradient** — same box (NVLink) ≫ same leaf (one switch) ≫ across the spine (several switches, shared uplinks). Distance is measured in *hops*.
2. **A collective runs at the speed of its *worst* hop.** So the lever is placement: pack a job's boxes under one leaf so every exchange is a cheap 1-hop, or let them scatter across the spine and every step pays the long way.

## What it is: a leaf-spine tree

Off-box, each p5.48xlarge reaches the others through **EFA — up to 3,200 Gbps ≈ 400 GB/s per node**, shared across its 8 GPUs (~50 GB/s per GPU off-box). Those links form a **tree**: each box connects to a top-of-rack **leaf** switch; every leaf connects up to **spine** switches; the spines tie the datacenter together. The higher you go, the more oversubscribed — spine uplinks carry everyone's traffic, not just yours.

The cost between two GPUs is set by how many switches sit between them — the **hop count**:

<figure style="margin:1.5rem 0;background:#f8fafc;border:1px solid #cbd5e1;border-radius:12px;padding:16px;color:#1e293b;font-family:ui-sans-serif,system-ui,sans-serif;font-size:13px;line-height:1.5">
<div style="text-align:center;font-size:11px;font-weight:700;letter-spacing:.05em;color:#64748b;margin-bottom:8px">LEAF-SPINE TREE — every leaf uplinks to every spine</div>
<div style="display:flex;gap:8px;justify-content:center">
<div style="border:1px solid #cbd5e1;border-radius:6px;padding:6px 16px;background:#fff;font-weight:700">Spine 1</div>
<div style="border:1px solid #cbd5e1;border-radius:6px;padding:6px 16px;background:#fff;font-weight:700">Spine 2</div>
</div>
<div style="text-align:center;color:#dc2626;font-size:11px;margin:4px 0">▲ shared, oversubscribed uplinks ▲</div>
<div style="display:flex;gap:20px;justify-content:center">
<div style="flex:1;border:1px dashed #94a3b8;border-radius:8px;padding:8px;background:#fff">
<div style="text-align:center;font-weight:700;color:#ca8a04">Leaf A</div>
<div style="display:flex;gap:6px;justify-content:center;margin-top:6px">
<div style="border:2px solid #059669;border-radius:6px;padding:5px 7px;background:#ecfdf5;font-weight:700">p5-1</div>
<div style="border:2px solid #059669;border-radius:6px;padding:5px 7px;background:#ecfdf5;font-weight:700">p5-N</div>
</div>
</div>
<div style="flex:1;border:1px dashed #94a3b8;border-radius:8px;padding:8px;background:#fff">
<div style="text-align:center;font-weight:700;color:#ca8a04">Leaf B</div>
<div style="display:flex;gap:6px;justify-content:center;margin-top:6px">
<div style="border:2px solid #dc2626;border-radius:6px;padding:5px 7px;background:#fef2f2;font-weight:700">p5-2</div>
</div>
</div>
</div>
<figcaption style="margin-top:12px;color:#64748b;font-size:12px;line-height:1.5"><b style="color:#059669">p5-1 → p5-N</b> (same leaf): <b>1 hop</b> — p5-1 → Leaf A → p5-N. Full line rate, lowest latency.<br/><b style="color:#dc2626">p5-1 → p5-2</b> (different leaf): <b>3 hops</b> — p5-1 → Leaf A → Spine → Leaf B → p5-2. Crosses the shared, oversubscribed spine.</figcaption>
</figure>

## Counting the hops

Read the two paths straight off the tree:

- **p5-1 ↔ p5-N, same leaf:** the packet enters Leaf A and comes straight back down — **1 switch hop**, at the leaf's full line rate.
- **p5-1 ↔ p5-2, different leaves:** the packet climbs p5-1 → Leaf A → **up to a Spine** → Leaf B → p5-2 — **3 switch hops**, and the middle leg rides spine uplinks shared with the whole datacenter.

That's the entire mechanism of "topology": two GPUs a leaf apart are far cheaper to connect than two GPUs a spine apart, purely by hop count.

## Why the worst hop sets the pace

An all-reduce is a *group* operation — every GPU has to finish its exchange before any of them moves on, and you don't get to choose who talks to whom; the collective mixes all of them. So it runs at the speed of its **slowest** pairing. If your 32-GPU job has 31 GPUs under one leaf and one box across the spine, all 32 wait on those 3-hop links every step.

Which means the lever isn't picking communication partners — it's **placement**: put all of the job's boxes under the *same leaf* so that whatever the collective does, every pairing is a 1-hop exchange and none is ever forced across the spine.

## The decision: same job, two placements

A 32-GPU job — four p5.48xlarge boxes. Same model, same code. The only variable is where the scheduler puts them:

- **All four under one leaf:** every cross-box exchange is 1 hop at full bandwidth. The all-reduce's worst hop is cheap; comms hide under compute.
- **Scattered across leaves and spines:** exchanges climb to 3-hop spine paths on oversubscribed uplinks. By the rule above, that worst hop is now the whole job's speed — every step.

You didn't touch the workload. You changed its hop count, and that alone can turn a comms cost you never notice into the thing that dominates the run.

## When it's the bottleneck

Large-scale distributed training. The more boxes a job spans, the harder it is to keep them all under one leaf, so more of the collective climbs toward the spine. Past some scale the exchange stops overlapping with compute and you're **network-bound** — thousands of GPUs idling between steps. It's the core reason 1,000 GPUs don't give 125× the throughput of 8: the extra GPUs are real, but so is the tax of keeping them in sync across the tree.

## Where this leaves Part 1

None of this is fixed by a faster GPU — the levers are all about *where capacity sits*:

- **Topology-aware scheduling** — a scheduler that knows the leaf-spine layout packs a job under as few leaves as possible instead of scattering it by free-GPU count.
- **Reserving co-located capacity** — claiming a block of topologically-adjacent boxes up front *guarantees* the low-hop path at scale instead of hoping the scheduler finds one. Capacity and placement work — the systems engineer's job, not a kernel flag.
- **Bigger NVLink domains** — wiring more GPUs (rack-scale, UltraServer-class) into one NVLink domain pushes the cheap tier outward, so more of the job stays off the tree entirely.

That's the whole arc of the rest of the series. Part 1 dissected one unit of compute — compute, memory, the in-box fabric, the host, and now the network beyond it — and established the ceilings each part sets. Everything after is how you **place, schedule, share, and reserve** to actually reach them.

Next: **Part 2 — GPU Sharing.** Part 1 was the anatomy of one unit; everything from here is about extracting the most from it — starting with driving a single GPU's utilization so none of it sits idle.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
