---
title: "2.2 · Hard Partitions: MIG"
description: "Carve one physical H100 into isolated instances so two workloads run at once on a card a single job would hog — a step-by-step MIG demo, then the rigidity cost."
date: "07/03/2026"
---

2.1 established the fork: a GPU sitting mostly idle under one job can be shared by splitting it in space (fixed slices) or sharing it in time (concurrent access). This is the space prong — NVIDIA's Multi-Instance GPU (MIG), the hardware mechanism that carves one physical GPU into several isolated instances so more than one job runs on it at once.

## TL;DR

1. **MIG turns one under-used H100 into 2–7 hardware-isolated GPUs, so several tenants run in parallel on a card a single job would otherwise hog — real concurrent utilization, each tenant with its own SMs and HBM slice.**
2. **The isolation is absolute — a tenant can't touch another's memory or steal its cycles — and the price is rigidity: a small set of fixed slice sizes, and reconfiguring means draining the whole GPU.**

## What MIG is

MIG (Multi-Instance GPU) is a hardware partitioning feature available on NVIDIA Ampere (A100) and Hopper (H100) GPUs. It divides one physical GPU into multiple *GPU instances*, each of which behaves like a smaller standalone GPU with:

- A **dedicated set of Streaming Multiprocessors (SMs)** — the compute cores.
- A **dedicated HBM slice** — its own portion of high-bandwidth memory, with its own memory controllers and L2 cache partition.
- A **dedicated memory bandwidth path** — traffic from one instance doesn't cross into another's controllers.

This is not virtualization or time-slicing. It's a physical partition at the hardware level. A kernel running in one MIG instance has no mechanism to read, write, or stall memory belonging to another instance. A runaway process in one partition can't OOM its neighbors, can't saturate their bandwidth, and can't monopolize their SMs — because those resources literally aren't addressable from that instance's context.

An H100 exposes **7 compute slices** and **8 memory slices** (each ~10 GB on the 80 GB variant) to MIG. A profile bundles some compute slices with some memory slices, and MIG wires each bundle into an isolated instance.

## How partitions are defined on H100

Profiles follow the naming convention `<compute_slices>g.<memory>gb`. The number before `g` is how many of the 7 compute slices the instance gets. The number after the dot is how much HBM it sees.

The valid profiles on an H100 80 GB (SXM5 or PCIe), per NVIDIA's MIG User Guide:

| Profile | Compute fraction | Memory | L2 cache fraction | Max instances |
|---------|-----------------|--------|-------------------|---------------|
| 1g.10gb | 1/7 of SMs | 10 GB (1/8) | 1/8 | 7 |
| 1g.20gb | 1/7 of SMs | 20 GB (2/8) | 1/8 | 4 |
| 2g.20gb | 2/7 of SMs | 20 GB (2/8) | 2/8 | 3 |
| 3g.40gb | 3/7 of SMs | 40 GB (4/8) | 4/8 | 2 |
| 4g.40gb | 4/7 of SMs | 40 GB (4/8) | 4/8 | 1 |
| 7g.80gb | 7/7 of SMs | 80 GB (full) | Full | 1 |

A few things to notice:

- **You can't freely mix.** The profiles form a partition table — some combinations tile the GPU, others don't. Two `3g.40gb` instances consume all 8 memory slices but leave 1 of 7 compute slices unassignable — stranded by the geometry. And you can't do one `3g.40gb` + five `1g.10gb`: that needs 4 + 5 = 9 memory slices against only 8 available. The layout, not your workload, dictates what's legal.
- **Memory and compute don't scale together.** `1g.20gb` gives double the memory of `1g.10gb` with the *same* 1/7 compute fraction, at the cost of reducing the max instance count from 7 to 4.
- **4g.40gb and 7g.80gb are single-instance.** At these sizes you're just using MIG's isolation framework without actually sharing the GPU.

The partition layout is static: you choose it at configuration time, and it holds until you explicitly destroy and recreate the instances. Changing layouts requires all work on the GPU to finish (drain), a mode switch, and re-creation — effectively a brief reset of that GPU.

## The payoff: two tenants on one card

Take the scenario from 2.1: a 13B BF16 model (26 GB weights) doing batch-1 decode on one H100 (80 GB HBM, ~3.35 TB/s, ~990 BF16 TFLOPS). That job uses ~33% of HBM and ~0.3% of peak FLOPs. Without MIG the other 54 GB and ~99% of the compute sit idle — yet the scheduler sees "GPU occupied" and sends the next job to a second card.

Configure that H100 as two `3g.40gb` instances and each tenant gets 40 GB + 3/7 of the SMs (~424 BF16 TFLOPS nominal) + its own bandwidth path. The 13B model fits in 40 GB with room left for KV cache, so two independent serving replicas run on one card with zero cross-talk. The win: **two tenants on one H100 instead of two H100s each at <35% utilization** — half the hardware for the same served work. Across a full p5.48xlarge that's 16 isolated serving slots on 8 cards.

The rest of this post runs exactly that on a real GPU, so you can watch both tenants make progress at the same time — then shows where the hard partition costs you.

## Demo: two workloads at once on one physical GPU

*The demo runs on a **p4d.24xlarge** (8× A100 40 GB) — slightly smaller HBM and fewer/slower SMs than the p5's H100, but the same MIG architecture, so the mechanism is identical and only the slice sizes scale down (`3g.40gb` → `3g.20gb`). Output blocks are illustrative and will be replaced with a verbatim capture from a real run — don't treat the numbers as measured yet.*

**What this proves, in order:** GPU 0 of the eight first runs a single job that leaves most of the card idle (the problem), then — split into two MIG instances — runs two independent jobs at the same time, each on its own isolated slice (the win), and finally rejects an illegal re-partition (the cost).

**Where everything runs:** every command runs in an SSH shell on the p4d.24xlarge instance itself. `nvidia-smi` runs on the instance, not on your laptop.

### Prerequisites — getting the GPU

1. **Get the capacity.** A `p4d.24xlarge` is 8× A100 40 GB. You can launch it On-Demand in most regions, or reserve it up front with an **On-Demand Capacity Reservation** or **Capacity Block for ML** if capacity is tight. (On a p5 this same demo uses H100s — the only change is the smaller A100 slice sizes.)
2. **Launch one `p4d.24xlarge`** using the **Deep Learning AMI (Ubuntu)** — it ships the NVIDIA driver, CUDA, and PyTorch, so there's nothing to install. Console: EC2 → Launch instance → Deep Learning AMI, instance type `p4d.24xlarge`. CLI equivalent: `aws ec2 run-instances --instance-type p4d.24xlarge --image-id <dlami-id> ...`.
3. **SSH in:** `ssh -i your-key.pem ubuntu@<instance-public-ip>`. Every command below runs in this shell.
4. **Create the workload** — paste this as-is to write `~/workload.py` (a tiny memory-bound loop, like batch-1 decode, that streams weights from HBM each step and prints throughput so progress is visible):

```bash
cat > ~/workload.py <<'PY'
# memory-bound "decode" loop; prints it/s so progress is visible
import torch, time, argparse
p = argparse.ArgumentParser()
p.add_argument("--name", default="job")
p.add_argument("--gb", type=float, default=20.0)   # GB streamed from HBM per step
a = p.parse_args()
n = int(a.gb * 1e9 / 2 / 4096)                      # bf16 [n, 4096] ≈ --gb gigabytes
W = torch.randn(n, 4096, dtype=torch.bfloat16, device="cuda")
x = torch.randn(4096, dtype=torch.bfloat16, device="cuda")
step, t0 = 0, time.time()
while True:
    y = W @ x                                       # streams all of W from HBM each step
    torch.cuda.synchronize()
    step += 1
    if step % 50 == 0:
        print(f"[{a.name}] step {step}  {step/(time.time()-t0):.1f} it/s", flush=True)
PY
```

### Step 0 — confirm the starting state

**Why:** establish that GPU 0 is a whole, un-partitioned A100 before we touch it.

```bash
nvidia-smi --query-gpu=index,name,memory.total,mig.mode.current --format=csv
```

```
index, name, memory.total [MiB], mig.mode.current
0, NVIDIA A100-SXM4-40GB, 40960 MiB, Disabled
1, NVIDIA A100-SXM4-40GB, 40960 MiB, Disabled
... (GPUs 2–7 identical)
```

Eight A100s, MIG disabled on all. We use GPU 0.

### Step 1 — baseline: one job leaves most of the card idle

**Why:** show the underutilization MIG exists to fix — one small job owning a whole 40 GB card.

```bash
CUDA_VISIBLE_DEVICES=0 python3 ~/workload.py --name solo --gb 12 &
sleep 20
nvidia-smi
```

```
[solo] step 50  512.9 it/s
+-----------------------------------------------------------------------------+
| GPU  Name           Memory-Usage         GPU-Util                           |
|  0   A100-SXM4-40GB   12180MiB / 40960MiB   ~30%                            |
|      PID 5821  python3   12 GB                                             |
+-----------------------------------------------------------------------------+
```

One job, ~12 of 40 GB, under a third of the card — but GPU 0 now counts as "occupied," so a scheduler routes the next job elsewhere. Stop it before partitioning (MIG can only be enabled on an idle GPU):

```bash
kill %1
```

### Step 2 — partition GPU 0 into two isolated instances

**Why:** carve the one physical GPU into two hardware-isolated halves so two tenants can each own a guaranteed slice.

```bash
sudo nvidia-smi -i 0 -mig 1                        # enable MIG on GPU 0
sudo nvidia-smi mig -i 0 -cgi 3g.20gb,3g.20gb -C   # create two 3g.20gb instances (+ compute instances)
nvidia-smi -L
```

```
GPU 0: NVIDIA A100-SXM4-40GB (UUID: GPU-1a2b...)
  MIG 3g.20gb  Device 0: (UUID: MIG-aaaa1111-...)
  MIG 3g.20gb  Device 1: (UUID: MIG-bbbb2222-...)
GPU 1: NVIDIA A100-SXM4-40GB (UUID: GPU-3c4d...)
...
```

GPU 0 is now two independent MIG devices, each with its own UUID. (If `-mig 1` reports the change is *pending*, something is still holding GPU 0 — confirm Step 1's job was killed, or `sudo nvidia-smi --gpu-reset -i 0`.)

### Step 3 — the win: two workloads at the same time

**Why:** the payoff — one card now hosts two independent tenants running in parallel, each on its own isolated slice.

```bash
A=$(nvidia-smi -L | grep -oP 'MIG-[0-9a-f-]+' | sed -n 1p)
B=$(nvidia-smi -L | grep -oP 'MIG-[0-9a-f-]+' | sed -n 2p)
CUDA_VISIBLE_DEVICES=$A python3 ~/workload.py --name A --gb 15 &
CUDA_VISIBLE_DEVICES=$B python3 ~/workload.py --name B --gb 15 &
sleep 20
nvidia-smi
```

```
[A] step 50  268.4 it/s
[B] step 50  267.6 it/s
+-----------------------------------------------------------------------------+
| GPU  GI  CI   Memory-Usage           Process                                |
|  0    1   0    15140MiB / 20096MiB     PID 6142  python3  (job A)           |
|  0    2   0    15140MiB / 20096MiB     PID 6143  python3  (job B)           |
+-----------------------------------------------------------------------------+
```

Two independent jobs, two PIDs, on two MIG devices of **one physical GPU** — both making progress at once. Where Step 1 served a single tenant on the whole card, GPU 0 now serves two, hardware-isolated: neither can touch the other's 20 GB or steal its SMs. That is the utilization win.

### Step 4 — the cost: the layout is rigid

**Why:** be honest about the price of the hard partition — you can't reshape it on the fly.

```bash
kill %1 %2
sudo nvidia-smi mig -i 0 -dci && sudo nvidia-smi mig -i 0 -dgi   # tear down to change layout
sudo nvidia-smi mig -i 0 -cgi 3g.20gb,3g.20gb,1g.5gb -C          # try an illegal geometry
```

```
Successfully created GPU instance ID 2 on GPU 0 using profile MIG 3g.20gb (ID 9)
Successfully created GPU instance ID 1 on GPU 0 using profile MIG 3g.20gb (ID 9)
Unable to create a GPU instance on GPU 0 using profile 1g.5gb: Insufficient Resources
Failed to create GPU instances: Insufficient Resources
```

The two `3g.20gb` instances are created; the `1g.5gb` is refused. Here's why, restated from the top so you don't have to scroll back: MIG carves the card into a **fixed grid of 7 compute slices and 8 memory slices** (NVIDIA's MIG spec — the same on A100 and H100; only the per-slice size differs, and on the 40 GB A100 each memory slice is 40 / 8 = 5 GB). A `3g.20gb` instance claims 3 compute + 4 memory slices, so **two of them use 6 of 7 compute and all 8 of 8 memory**. The `1g.5gb` you asked for needs one more memory slice — a 9th — which doesn't exist, so it's rejected *even though a 7th compute slice is still free and idle*. The geometry, not your workload, decides what's legal; and to change the layout you must drain and recreate every instance (the `-dci`/`-dgi` above), not resize in place. That is the rigidity — the price you pay for the hard isolation Step 3 just bought you.

### Teardown

```bash
sudo nvidia-smi mig -i 0 -dci; sudo nvidia-smi mig -i 0 -dgi
sudo nvidia-smi -i 0 -mig 0
```

## The cost: rigidity

The isolation is absolute, and you pay for it in flexibility:

- **Static layout.** Changing the partition scheme means draining all work from the GPU and recreating the instances (Step 4 above) — you can't resize a slice to absorb a burst. In a serving fleet that's a rolling restart.
- **Coarse, fixed sizes.** The smallest slice is 1/7 of compute and 10 GB. A job needing 12 GB jumps to `1g.20gb` and strands 8 GB; the waste moves from "whole GPU idle" to "slice-boundary stranding."
- **No oversubscription.** An idle instance can't lend its SMs to a busy neighbor. Isolation guarantees waste isolation too.

## When MIG fits

MIG is the right tool when tenant isolation is non-negotiable (one customer's job must never touch another's latency, guaranteed by hardware) and workload sizes are known and stable enough to tile into fixed profiles and run for days. It's the wrong tool when sizes vary widely — a mix of 3 GB, 15 GB, and 50 GB models strands capacity at every boundary — or when one model needs to burst into a quiet neighbor's SMs, which the hardware boundary forbids. That flexible, burst-friendly case is the time prong, next.

## Where this goes next

MIG is the space prong — strong isolation, coarse slices, static layout. The natural follow-up is the time prong: what if you keep the GPU whole and let multiple jobs share it concurrently?

**2.3** covers MPS and time-slicing — sharing the full GPU in time rather than carving it in space. Flexible sizing, dynamic workload mixing, and no stranded capacity — at the cost of giving up MIG's hardware isolation guarantees. **2.4** then addresses when sharing of either kind backfires, where MIG's hard boundaries become the strong baseline everyone wishes they'd started from.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
