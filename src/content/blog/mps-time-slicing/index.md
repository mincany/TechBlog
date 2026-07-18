---
title: "2.3 · Sharing in Time: MPS and Time-Slicing"
description: "Pack several sub-saturating jobs onto one GPU — MPS runs them truly concurrently, time-slicing rotates turns — with a step-by-step MPS-vs-time-slicing demo, then the shared-fault-domain cost."
date: "07/04/2026"
---

2.1 established the problem — a whole H100 handed to a job using ~0.3% of its FLOPs is the dominant fleet waste — and presented two strategies: split in space (MIG, covered in 2.2) or share in time. 2.2 showed how MIG carves hardware-isolated slices at the cost of rigid, coarse granularity. This post covers the other prong: **letting multiple jobs share one GPU without physical partitioning** — the flexible path that trades hardware isolation for higher utilization.

## TL;DR

1. **A GPU that one job under-fills can carry several at once: time-slicing rotates whole-GPU turns, MPS runs kernels from many processes truly concurrently on different SMs — no fixed slices, so tenants pack onto one card until it fills.**
2. **MPS beats time-slicing when tenants individually under-fill the GPU (no context-switch dead-time) and beats MIG on flexibility — the price is a shared fault domain: no hardware isolation, so one tenant can OOM or crash the rest.**

## What they are

### Time-slicing

The GPU rapidly context-switches between jobs on a fixed schedule. During each slice, one job's CUDA context occupies *all* the SMs and *all* the HBM. Only one job's kernels are active at any instant — the others are paused, waiting for their turn.

From the outside it looks like multiple GPUs exist (the Kubernetes device plugin advertises N "virtual GPUs" from one physical card). From the inside it's serialized turns with context-switch overhead between them.

- **Concurrency model:** round-robin turns. One active context at a time.
- **Memory:** every job's state lives in HBM simultaneously (to avoid swap), so total memory use is the sum of all tenants. No memory limit enforcement per tenant.
- **Overhead:** context-switch latency on each rotation (on the order of microseconds to low milliseconds depending on the driver and context size). Throughput is bounded by serialization — N jobs on one GPU get at most 1/N of the time, minus switching cost.

### MPS (Multi-Process Service)

MPS is a runtime daemon that funnels multiple CUDA processes into a single shared hardware context. Kernels from different processes can occupy different SMs **at the same instant** — genuine spatial multiplexing in software, without MIG's hardware partitioning.

- **Concurrency model:** simultaneous. Multiple clients' kernels run on different SMs concurrently. No turn-taking.
- **Memory:** all clients share the same 80 GB. MPS supports optional per-client memory limits (soft caps: the GPU driver can reject allocations that exceed the client's limit, but one client's crash can still corrupt the shared address space).
- **SM partitioning:** optional per-client SM percentage caps (e.g., `CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=50`). The cap is a ceiling, not a reservation — idle SMs from other clients aren't redistributed.
- **Overhead:** near zero for kernel dispatch (single hardware context, no context switch). The cost is interference risk: a long-running kernel from one client can delay another's launch on the same SM, and a client fault can bring down the shared MPS server.

## The contrast

| Dimension | Time-slicing | MPS | MIG (from 2.2) |
|---|---|---|---|
| Concurrency | Turns (1 active at a time) | Simultaneous (many active at once) | Partitioned (each slice independent) |
| Isolation | None — shared memory, shared SMs | Soft caps — memory limits, SM% ceiling | Hardware — memory controllers, SM partitions |
| Failure blast radius | OOM/crash affects all tenants | OOM/crash can bring down shared MPS server | Contained to one slice |
| Best workload | Few tenants, moderate per-job GPU use | Many small tenants underfilling SMs | Stable, predictable tenants needing hard guarantees |
| Scheduling complexity | Low (device plugin handles it) | Medium (MPS daemon lifecycle, client caps) | Medium (fixed profile selection, profile changes need drain) |
| Granularity | Any number of tenants | Any number of tenants | 2–7 slices per GPU (fixed profiles) |

## The payoff: four tenants on one card

Back to the p5.48xlarge: one H100, 80 GB HBM, ~3.35 TB/s bandwidth, ~990 BF16 TFLOPS, 132 SMs.

From 2.1, a single 13B BF16 decode stream at batch 1 uses ~0.3% of peak FLOPs but draws ~3.3 TB/s at ~128 tokens/sec — a *continuous* decode stream already sits at the bandwidth wall. That's the catch: a tenant running flat-out has nothing to share. Concurrency only helps when tenants leave the pipe idle part of the time.

Real serving does exactly that. Requests arrive in bursts; between them the SMs and the memory bus sit idle. Consider 4 independent tenants, each serving a 3B BF16 model (6 GB weights) at a moderate ~140 tokens/sec — well below the ~560 tok/s a 3B stream could sustain flat-out (6 GB ÷ 3.35 TB/s ≈ 1.8 ms/token), because real traffic isn't continuous:

- Per-tenant memory: 6 GB weights + ~1 GB KV/activations ≈ 7 GB → 4 × 7 GB = **28 GB** (fits easily in 80 GB)
- Per-tenant bandwidth: ~6 GB/token × ~140 tokens/sec ≈ **0.84 TB/s** — about a quarter of the pipe
- Aggregate: 4 × 0.84 ≈ **3.36 TB/s** — the four together fill a bus each one alone barely touched

**Time-slicing** rotates the four: each gets ~1/4 of the wall-clock, and every rotation pays a context-switch cost. The bus is busy during a tenant's slice and idle across the switch.

**MPS** lets all four issue kernels concurrently onto different SMs. The work is memory-bound, so they don't fight over compute — they share the ~3.35 TB/s bus, but with no switching dead-time between them. When one tenant is between bursts, another's kernels use the bus it left idle. Same bandwidth ceiling, no switching tax, lower per-request latency.

**The utilize-vs-fallback contrast:** each 3B tenant alone uses ~25% of one H100's bandwidth and a sliver of its memory. The fallback — one tenant per GPU — pins each to its own card and leaves ~75% of four cards idle. MPS consolidates all four onto one H100, turning four barely-used cards into one well-used one. The aggregate token rate is bandwidth-capped either way; what you save is three GPUs.

*Numbers are illustrative — actual throughput depends on model architecture, request patterns, and driver version. The mechanism is the point: concurrency reclaims a shared bus that sub-saturating tenants leave idle, up to the bandwidth ceiling (1.2's regime), not past it.*

## Demo: MPS vs time-slicing on one GPU

*The demo runs on a **p4d.24xlarge** (8× A100 40 GB) — slightly smaller HBM and fewer/slower SMs than the p5's H100, but MPS and time-slicing behave identically. Output blocks are illustrative and will be replaced with a verbatim capture from a real run — don't treat the numbers as measured yet.*

**What this proves, in order:** on one whole A100, a single small job under-fills the GPU (headroom); two such jobs under default **time-slicing** serialize and take ~2× as long (the problem); the same two jobs under **MPS** run concurrently and finish in ~1× (the win); then a per-client SM cap and the shared-fault-domain cost (the trade). The worked example above showed the *bandwidth* face of this (memory-bound tenants sharing the bus); this demo shows the *compute* face (small kernels sharing the SMs) — same principle: a tenant that under-fills the GPU leaves room MPS packs another into.

**Where everything runs:** every command runs in an SSH shell on the p4d.24xlarge. MPS uses a *whole* GPU, not a MIG slice — we use GPU 0 in normal mode (if you ran the 2.2 demo, disable MIG first: `sudo nvidia-smi -i 0 -mig 0`).

### Prerequisites — getting the GPU

Same as 2.2: launch a `p4d.24xlarge` (On-Demand, or via a reservation if capacity is tight) on the **Deep Learning AMI (Ubuntu)**, and `ssh -i your-key.pem ubuntu@<instance-public-ip>`. Every command below runs in that shell. Create the workload — paste this as-is to write `~/mps_work.py` (a fixed amount of compute, so wall-time is the metric, sized to *under-fill* the GPU — the regime where sharing helps):

```bash
cat > ~/mps_work.py <<'PY'
# fixed compute; the matmul is small enough to leave SMs idle
import torch, time, argparse
p = argparse.ArgumentParser()
p.add_argument("--name", default="job")
p.add_argument("--iters", type=int, default=4000)
p.add_argument("--size", type=int, default=2048)   # small → one job doesn't fill the SMs
a = p.parse_args()
X = torch.randn(a.size, a.size, dtype=torch.float16, device="cuda")
Y = torch.randn(a.size, a.size, dtype=torch.float16, device="cuda")
torch.cuda.synchronize(); t0 = time.time()
for _ in range(a.iters):
    Z = X @ Y
torch.cuda.synchronize()
print(f"[{a.name}] {a.iters} iters, size {a.size}: {time.time()-t0:.1f}s", flush=True)
PY
```

### Step 0 — confirm a whole GPU, no MPS running

**Why:** MPS and time-slicing both need a whole (non-MIG) GPU; establish the starting point.

```bash
nvidia-smi --query-gpu=index,mig.mode.current --format=csv | head -2
pgrep -a nvidia-cuda-mps-control || echo "no MPS server running"
```

```
index, mig.mode.current
0, Disabled
no MPS server running
```

GPU 0 is whole, MIG off, no MPS daemon — so the default sharing behavior is time-slicing.

### Step 1 — baseline: one job under-fills the GPU

**Why:** measure a single job's wall-time `T` and confirm it leaves SMs idle (headroom to share).

```bash
CUDA_VISIBLE_DEVICES=0 python3 ~/mps_work.py --name solo &
sleep 3; nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader   # sample mid-run
wait
```

```
44 %
[solo] 4000 iters, size 2048: 18.6s
```

One job finishes in ~19 s and the GPU sits around ~45% — most of the card is idle. That idle headroom is what sharing reclaims.

### Step 2 — the problem: two jobs, default time-slicing

**Why:** show that without MPS, two jobs on one GPU serialize rather than overlap.

```bash
CUDA_VISIBLE_DEVICES=0 python3 ~/mps_work.py --name A &
CUDA_VISIBLE_DEVICES=0 python3 ~/mps_work.py --name B &
wait
```

```
[A] 4000 iters, size 2048: 37.2s
[B] 4000 iters, size 2048: 37.5s
```

Both take ~2× the single-job time. The GPU time-slices between the two contexts — only one job's kernels run at any instant — so two jobs cost roughly twice one, even though each alone left ~55% of the SMs idle.

### Step 3 — the win: two jobs under MPS

**Why:** the payoff — MPS lets both processes' kernels run on different SMs at the same instant.

```bash
nvidia-cuda-mps-control -d          # start the MPS daemon
CUDA_VISIBLE_DEVICES=0 python3 ~/mps_work.py --name A &
CUDA_VISIBLE_DEVICES=0 python3 ~/mps_work.py --name B &
wait
```

```
[A] 4000 iters, size 2048: 19.8s
[B] 4000 iters, size 2048: 20.1s
```

Both finish in ~20 s — barely more than a single job, and about **half** the time-sliced 37 s. The difference is serialize-vs-overlap: without MPS the GPU **time-slices** — it runs one process's kernels, pauses them, runs the other's, and the paused job's SMs sit idle, so two jobs cost ~2×. MPS merges both processes into one context, so their kernels occupy different SMs *at the same instant* — the SMs one job leaves idle are filled by the other, with no context-switch dead-time. That only works because each job under-fills the GPU; if one job already saturated every SM, MPS would have nothing to overlap and collapse back to time-slicing's ~2×. Run `nvidia-smi` during the jobs (from a second SSH shell) and you'll see one `nvidia-cuda-mps-server` process holding the GPU with both jobs funneled through it as clients.

### Step 4 — the control lever (and the cost)

**Why:** MPS lets you *bound* a tenant's share so one greedy job can't starve the rest — and it also exposes the thing MPS still can't give you: isolation.

`CUDA_MPS_ACTIVE_THREAD_PERCENTAGE` caps a client to a fraction of the SMs — a ceiling, not a reservation (unused SMs aren't handed back). To see it bite, run the same job uncapped, then capped to 50%, with the MPS daemon still up from Step 3, and compare wall-time:

```bash
CUDA_VISIBLE_DEVICES=0 python3 ~/mps_work.py --name full > /tmp/full.log 2>&1
CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=50 CUDA_VISIBLE_DEVICES=0 python3 ~/mps_work.py --name half > /tmp/half.log 2>&1
tail -1 /tmp/full.log /tmp/half.log
```

```
==> /tmp/full.log <==
[full] 4000 iters, size 2048: 18.4s
==> /tmp/half.log <==
[half] 4000 iters, size 2048: 34.9s
```

Half the SMs, roughly double the wall-time — the cap is real and MPS enforces it. That's the QoS lever: you can hand each tenant a guaranteed ceiling of compute.

**The cost:** what MPS still doesn't give you is *isolation*. All clients share one 40 GB address space and one fault domain — a tenant that leaks memory until `cudaMalloc` fails, or triggers a GPU fault, can starve or crash the shared MPS server and take every co-tenant down with it. MIG's hard partition (2.2) prevented exactly that; MPS trades it away for flexibility. When that shared fate is acceptable — and when it isn't — is 2.4.

### Teardown

```bash
echo quit | nvidia-cuda-mps-control   # stop the MPS daemon
```

## When MPS beats MIG (and when it doesn't)

**MPS wins when:**
- Tenant count and size are unpredictable (can't pre-commit to fixed MIG slices)
- Jobs individually underfill the GPU — small-batch inference, LoRA adapters, preprocessing
- Bursty request patterns mean SMs sit idle between bursts; concurrent tenants absorb the slack
- You want sub-GPU sharing without the operational overhead of MIG profile management

**MPS loses when:**
- Tenants are untrusted — no hardware isolation means a malicious or buggy client can access another's memory or crash the MPS server
- A single tenant already saturates the GPU (large-batch inference, training) — adding concurrency only adds contention
- Latency-critical workloads can't tolerate a neighbor's long kernel delaying their dispatch
- You need hard SLA guarantees — MPS soft caps don't prevent one client from affecting another's tail latency

Time-slicing occupies the simplest-to-deploy position: just tell the device plugin to advertise more virtual GPUs. It works adequately when tenants are well-behaved, usage is light, and you want zero operational overhead beyond the plugin config. It falls short when serialization overhead matters or when many tenants could productively run simultaneously.

## "No hardware isolation" in practice

Both mechanisms leave tenants sharing a single hardware fault domain. What that means concretely:

- **OOM propagation.** One tenant's memory leak grows until the GPU's free HBM is exhausted. The next `cudaMalloc` from *any* tenant — including well-behaved ones — fails. With MPS memory caps, the offending client's allocation can be rejected, but if it corrupts memory before that check, all clients sharing the MPS server are affected.
- **Kernel interference.** Under time-slicing, a tenant that launches a very long kernel holds its time-slice until the kernel completes — starving others of their turn. Under MPS, a long kernel on an SM blocks other clients from launching on that SM until it finishes, creating tail-latency spikes for neighbors.
- **Crash blast radius.** Under MPS, a client that triggers a GPU fault (illegal memory access, unrecoverable ECC error) can crash the MPS server process, taking all concurrent clients down with it. Under time-slicing, a fatal GPU error resets the whole device — same outcome.

For *trusted* workloads under one operator — a platform serving its own models, a team's shared fine-tuning cluster — the efficiency gain outweighs the shared fate; the calculus flips when tenants are untrusted or SLA-bound. When shared fate is acceptable is exactly what 2.4 addresses.

## Where this goes next

We now have three modes on the table: MIG (hard partitions, strong isolation, coarse), MPS (concurrent execution, soft caps, fine-grained), and time-slicing (serialized turns, zero isolation, simplest). Each carves a different trade-off between utilization and safety.

**2.4** examines the isolation question head-on: under what conditions is each mode's blast radius acceptable, how to decide which tenancy model fits a given workload mix, and what "safe to share" means when there's no hardware fence.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
