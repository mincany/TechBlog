---
title: "3.4 · Placement That Respects Topology"
description: "Where a job's ranks land on the fabric decides whether collectives ride NVLink or crawl across spine switches — topology-aware scheduling claims the fast path."
date: "07/09/2026"
---

## Series placement

[3.2](/blog/gang-scheduling) showed how to get N GPUs for a gang-scheduled job. [3.3](/blog/fragmentation-bin-packing) showed how to pack those GPUs onto the fewest nodes so you don't strand capacity. Both posts answer *whether* a job lands. This one asks the question that matters equally: **where** on the fabric those GPUs sit — because a job can be "placed" and still run at a fraction of its potential speed if its ranks are scattered across the wrong switches.

## TL;DR

1. **Distributed training runs at the speed of the slowest link between ranks — topology-aware scheduling keeps communicating ranks close on the fabric so collectives ride NVLink (~900 GB/s) instead of dropping to inter-node EFA (~400 GB/s) or, worse, cross-spine paths where switch-hop latency dominates.**
2. **The failure mode is invisible: no crash, no Pending pod, just a silently low MFU and a training run that takes 2–3× longer than it should — the scheduler must know the fabric hierarchy or it places blind.**

## What it is

Topology-aware scheduling means the scheduler carries a model of the physical fabric hierarchy and uses it as a scoring constraint when placing work. The hierarchy, from fastest to slowest:

| Fabric tier | Approx bandwidth | What lands here |
|---|---|---|
| NVLink domain (intra-node, 8 GPUs) | ~900 GB/s per GPU | Tensor-parallel shards, high-frequency all-reduce |
| EFA / same leaf switch (node-to-node) | ~400 GB/s aggregate (across the node's EFA NICs) | Data-parallel gradient sync across a small group |
| Cross-spine (multiple hops) | Same wire rate, higher latency | Pipeline stages with infrequent communication |

The scheduler scores a candidate placement by how much of the job's communication graph stays in the fastest tier. Kubernetes exposes this through topology labels (`topology.kubernetes.io/zone`, node labels for rack/switch, and the Topology-Aware Scheduling KEP); NVIDIA's Topology Manager and device plugin surface the NVLink domain within a single node. The scheduler doesn't need to understand NCCL internals — it just needs to keep ranks that talk frequently on the same switch or, better, in the same NVLink domain.

## Why it matters

This is the workload-placement mirror of [1.3](/blog/topology-nvlink) and [1.5](/blog/inter-node-fabric).

1.3 established: eight H100s inside a p5.48xlarge talk over NVLink at ~900 GB/s per GPU — an order of magnitude faster than the PCIe host bus. 1.5 established: once traffic leaves the node it hits EFA at ~400 GB/s aggregate, and every additional switch hop adds latency. The canonical contrast: a representative all-reduce completes in ~50 ms when ranks share an NVLink domain versus ~710 ms when forced across PCIe and multiple hops (illustrative — the point is the mechanism, not a benchmark).

Distributed training is communication-bound. Every iteration ends with a collective — an all-reduce that exchanges gradients across all ranks — and that collective runs at the speed of the *slowest* link any two communicating ranks share. Placement decides which links those are.

Take a 16-GPU job on the reference cluster:

**Placement A — 2 full nodes (16 GPUs on 2 × p5.48xlarge).** Within each node, 8 ranks talk over NVLink at ~900 GB/s. Only the reduced cross-node step traverses EFA at ~400 GB/s. Most traffic stays on the fast lane; the fabric is barely a tax.

**Placement B — scattered 1–2 GPUs across 8+ nodes.** Now nearly every rank-to-rank exchange crosses EFA and, worse, multiple switch hops. The collective runs at the slowest tier for the whole job. The bandwidth ratio alone (~900 vs ~400 GB/s) makes the collective step roughly 2× slower; layered switch-hop latency pushes a communication-heavy iteration into the 2–3× range. Same 16 GPUs, same job — an illustrative 2–3× slower wall-clock, purely from where the ranks landed. Nothing in the scheduler output or job logs flags it: the job reports Running, every pod Scheduled, and MFU is the only breadcrumb.

Both placements *fit*. Both pass Filter, both satisfy the gang. Only the topology-aware Score separates the fast lane from the fallback.

## When topology is the bottleneck

Communication-heavy jobs feel it most — tensor-parallel is the chattiest, exchanging activations every layer, and is the least tolerant of a slow link. The failure is **invisible**: no crash, no `Pending` pod, no error in any log. The job runs. It just runs at a fraction of its speed, and the only symptom is a quietly low MFU and a training run that takes longer than the GPU count says it should.

The scheduler can only avoid this if it *knows* the fabric. That means topology labels — node, zone, rack/switch, NVLink domain — attached to nodes and fed to a scoring plugin. Without them the scheduler places blind: it satisfies the count and ignores the connectivity.

## Demo: the same job, two placements, on real hardware

*This demo runs on **two p4d.24xlarge** nodes (8× A100 40 GB each) in a cluster placement group with EFA. It's the one Part 3 demo that needs more than one node — topology-aware placement is inherently about where ranks land across the fabric, which a single node can't show. Output blocks are illustrative and will be replaced with a verbatim capture from a real run — don't treat the numbers as measured yet.*

**What this proves:** an 8-GPU all-reduce runs at one speed when all 8 ranks sit inside a single node (every exchange on NVLink) and a slower speed when the same 8 ranks are split 4+4 across two nodes (half the exchanges cross EFA). Same job, same world size, same message size — only the placement changes. That gap is exactly what a topology-aware scheduler exists to keep you out of.

### Prerequisites — a 2-node cluster that can actually talk fast

1. **Launch two `p4d.24xlarge`** in the **same Availability Zone**, inside a **cluster placement group** (packs them on the same spine for lowest latency), on the **Deep Learning AMI (Ubuntu)** — it ships the NVIDIA driver, CUDA, NCCL, PyTorch, and the `aws-ofi-nccl` plugin that lets NCCL ride EFA. Enable **EFA** on the primary network interface of each (EC2 launch → Advanced network configuration → Elastic Fabric Adapter).
2. **Security group:** add a rule allowing **all traffic from the security group itself** (self-referencing, inbound *and* outbound). NCCL over EFA uses arbitrary ports between the nodes; without the self-referencing allow-all rule the collective silently hangs.
3. **SSH to each as `ubuntu`** and activate PyTorch: `source /opt/pytorch/bin/activate` (or `sudo su - ubuntu`). Note each node's **private IP** (`hostname -i`); call node 0's private IP `$MASTER`.
4. **Confirm EFA is present** on each node: `fi_info -p efa` should list `efa` providers. (If it's empty, EFA wasn't enabled at launch.)
5. **Create the microbench** — paste this on **both** nodes to write `~/allreduce.py` (a fixed all-reduce, so bandwidth is the metric):

```bash
cat > ~/allreduce.py <<'PY'
import time, torch, torch.distributed as dist
dist.init_process_group("nccl")
rank, world = dist.get_rank(), dist.get_world_size()
torch.cuda.set_device(rank % torch.cuda.device_count())
n = 64_000_000                                   # 64M fp32 = 256 MB message
x = torch.ones(n, device="cuda")
for _ in range(5): dist.all_reduce(x)            # warmup
torch.cuda.synchronize(); dist.barrier()
iters = 50; t0 = time.time()
for _ in range(iters): dist.all_reduce(x)
torch.cuda.synchronize(); t = (time.time() - t0) / iters
size = n * 4
algbw = size / t / 1e9
busbw = algbw * 2 * (world - 1) / world          # ring all-reduce bus bandwidth
if rank == 0:
    print(f"world={world}  msg={size/1e6:.0f}MB  {t*1e3:.2f} ms/iter  "
          f"algbw={algbw:.1f} GB/s  busbw={busbw:.1f} GB/s", flush=True)
dist.destroy_process_group()
PY
```

### Step 1 — fast lane: 8 ranks inside one node (all NVLink)

**Why:** establish the intra-node baseline — all 8 ranks on node 0, every exchange on NVSwitch/NVLink.

Run on **node 0 only**:

```bash
NCCL_DEBUG=WARN torchrun --nnodes=1 --nproc_per_node=8 ~/allreduce.py
```

```
world=8  msg=256MB  X.XX ms/iter  algbw=XXX.X GB/s  busbw=XXX.X GB/s     # pending real run
```

All eight ranks are one NVLink hop apart, so the collective runs on the fast tier.

### Step 2 — the fallback: the same 8 ranks split 4+4 across two nodes

**Why:** identical job (world=8, 256 MB), but now four ranks live on node 1, so every cross-node exchange traverses EFA instead of NVLink.

Run on **node 0** and **node 1** at the same time (same command except `--node_rank`), with `$MASTER` = node 0's private IP:

```bash
# node 0
NCCL_DEBUG=WARN torchrun --nnodes=2 --node_rank=0 --nproc_per_node=4 \
  --master_addr=$MASTER --master_port=29500 ~/allreduce.py
# node 1 (in its own shell)
NCCL_DEBUG=WARN torchrun --nnodes=2 --node_rank=1 --nproc_per_node=4 \
  --master_addr=$MASTER --master_port=29500 ~/allreduce.py
```

```
world=8  msg=256MB  Y.YY ms/iter  algbw=YYY.Y GB/s  busbw=YYY.Y GB/s     # pending real run — expect materially lower busbw than Step 1
```

Same 8-GPU all-reduce, same message — the only change is that half the ranks moved to a second node. Bus bandwidth drops from the NVLink tier toward the EFA ceiling, and `ms/iter` rises by the corresponding factor. (Add `NCCL_DEBUG=INFO` and grep for `NET/OFI` to confirm the cross-node ranks are actually on EFA.)

### What the scheduler is choosing between

Nothing here touched a kernel or a NCCL tuning flag — the two runs are the *same* code on the *same* eight GPUs. The only variable was **where the ranks were placed**. Step 1 is what a topology-aware scheduler gives you when it packs a gang into one NVLink domain; Step 2 is the silent tax when it scatters the same gang across the fabric. On a production cluster the same gap opens between a same-leaf and a cross-spine placement — and, as above, nothing but MFU tells you it happened.

### Teardown

Terminate both `p4d.24xlarge` instances when done — they bill per-second while running, and this is a two-node reservation.

## Part 3 wrap

Placing jobs across a cluster has four faces, and they're the four posts of this part:

- **[3.1](/blog/scheduler-core-loop)** — the Watch → Filter → Score → Bind loop every decision runs through.
- **[3.2](/blog/gang-scheduling)** — bind a distributed job all-or-nothing, or deadlock on partial placement.
- **[3.3](/blog/fragmentation-bin-packing)** — pack vs spread decides whether scattered free GPUs can host a big job.
- **[3.4](/blog/topology-aware-scheduling)** — place the pieces close on the fabric, or run at the fallback speed.

## Part 4 handoff

Part 3 assumed a single queue placing jobs on merit. Part 4 — Utilization Engineering — drops that assumption: many teams share one cluster, and the question becomes who gets what, and when. Quotas and fair-share borrowing, priority and preemption, co-locating online serving with offline batch — the multi-tenant levers that decide whether the cluster you've now learned to schedule actually stays full.

---

*Opinions are my own and do not represent my employer. Figures are rounded, from public vendor datasheets and standard back-of-envelope heuristics, and meant to show the mechanism rather than to benchmark a specific deployment. Everything here refers to publicly documented concepts and products.*
