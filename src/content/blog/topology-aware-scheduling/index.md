---
title: "3.4 · Lower Communication Cost for Multi-GPU Jobs: Topology-Aware Placement"
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

This is the workload-placement mirror of [1.3](/blog/topology-nvlink) and [1.5](/blog/inter-node-fabric): 1.3 covered the fast lane inside a node, 1.5 the switch tree between nodes. Here those two facts become a placement decision, and the cost of ignoring them is something you can compute.

**The structure.** The reference cluster: eight p5.48xlarge nodes (8 GPUs each, 64 GPUs total) on a two-leaf spine tree.

```
                 spine
               /       \
           leaf1        leaf2
         / | | \       / | | \
       n1 n2 n3 n4   n5 n6 n7 n8        each n = one p5.48xlarge (8 GPUs)
```

Three tiers, three bandwidths (the 1.3/1.5 numbers): GPU↔GPU inside a node rides NVLink at ~900 GB/s per GPU; node↔node traffic leaves through the node's EFA NICs at ~400 GB/s aggregate per node; cross-spine paths run at the same wire rate but are two hops longer and typically oversubscribed, so the effective share per flow drops further.

**The hops.** Count the path between any two ranks:

| Rank pair | Path | Hops |
|---|---|---|
| Same node | NVLink/NVSwitch | 1 |
| Same leaf | node → leaf → node | 2 |
| Cross spine | node → leaf → spine → leaf → node | 4 |

**The two placements.** A 16-GPU job (16 one-GPU ranks) can land on this cluster two ways:

```
Placement A (packed):     n1 ████████  n2 ████████              2 full nodes, same leaf
Placement B (scattered):  n1 ██ n2 ██ n3 ██ n4 ██ n5 ██ ...     2 ranks on each of 8 nodes,
                                                                 spanning both leaves
```

Both are 16 GPUs. Both pass Filter, both satisfy the gang. The difference only shows up when the ranks talk.

**The calculation.** Every training iteration ends with an all-reduce of the gradients. For a ring all-reduce over N ranks moving G bytes, each rank pushes 2G(N−1)/N through its ring links, and the collective finishes at the pace of the *slowest* link in the ring. Take the series' running 13B-parameter model in BF16: G = 26 GB of gradients.

Calibration first: 8 ranks inside one node, every link NVLink. 2 × 26 GB × (7/8) / 900 GB/s ≈ **50 ms** — the canonical intra-node number from 1.3, falling out of the same formula.

Now the 16-rank job, per-rank traffic 2 × 26 GB × (15/16) ≈ 49 GB:

- **Placement A.** Order the ring to walk all of n1's GPUs, then all of n2's (NCCL does this on its own — it knows node locality). 14 of the 16 ring links are NVLink; only 2 cross between the nodes, one in each direction, and each crossing gets the node's full ~400 GB/s. Slowest link: 400 GB/s. Time ≈ 49 / 400 ≈ **120 ms**.
- **Placement B.** Same ring discipline, but with 2 ranks per node the ring now crosses nodes 8 times, and because the job spans both leaves, some of those crossings traverse the spine — the 4-hop path in the table. Spine capacity is what makes this expensive: leaf-spine fabrics are typically oversubscribed, so a spine crossing gets a fraction of the leaf-level bandwidth. At 2:1 the worst link delivers ~200 GB/s → 49 / 200 ≈ **245 ms**; at 4:1 it's ~100 GB/s → **490 ms**. The collective finishes at the pace of that worst link, so the 14 fast links don't help.

Same 16 GPUs, same job, same bytes: 120 ms versus 245–490 ms of communication per iteration, a 2–4× gap decided entirely by where the ranks landed (compute overlap absorbs some of it, which is why 2–3× wall-clock is the range you see quoted). Nothing in the scheduler output or job logs distinguishes the two placements; the job reports Running either way, and a quietly low MFU is the only symptom. How hard the gap bites scales with communication frequency: tensor-parallel exchanges activations every layer and tolerates a slow link least.

In practice, the reservation layer ([0.1](/blog/four-layer-capacity-model)'s layer 1) can buy you the outer bound. GPU capacity sold as a colocated block (EC2 Capacity Blocks, carved from a single EC2 UltraCluster, are the public example) is placed under one spine by the provider, so the cross-spine worst case above cannot occur inside the block. What remains is the structure beneath it: same node versus same leaf. Providers expose that hierarchy through a topology API (`DescribeInstanceTopology`, or `DescribeCapacityReservationTopology` scoped to a reservation), and Kubernetes on EKS surfaces it as node labels. A topology-aware scheduler, or your own rank-assignment logic, reads that hierarchy to keep the chattiest ranks on the fewest hops.

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

Nothing here auto-discovers the cluster; you declare it. `--nnodes=2` says the world spans two machines and `--node_rank` tells each launcher which one it is, which is why the command runs once per node. `--master_addr` is only a rendezvous point: all 8 processes connect to node 0's IP, receive global ranks 0–7, and exchange addresses there. Each launcher starts 4 processes on its own machine, one per GPU. NCCL then picks the transport per rank pair — same-node pairs ride NVLink, cross-node pairs go out over EFA — which is where the placement cost physically lands.

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
