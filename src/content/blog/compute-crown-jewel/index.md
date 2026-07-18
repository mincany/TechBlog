---
title: "0.0 · Compute: the Crown Jewel of AI Infrastructure"
description: "Compute is expensive and scarce, but paid GPUs are not automatically useful GPUs. This series looks at the capacity and scheduling systems that close that gap."
date: "06/28/2026"
---

AI infrastructure covers data pipelines, storage, networking, training frameworks, inference runtimes, and the systems that supply and place accelerators. This series focuses on the last category: the capacity and scheduling layer.

## TL;DR

Compute is expensive and scarce, but **paying for a GPU does not mean it is doing useful work**. AI companies are trying to get more training and inference from every accelerator-hour, while capacity providers are trying to keep scarce hardware available, placeable, and shared. This series looks at the systems that close that gap.

## Why focus on compute

xAI initially built its Colossus cluster with 100,000 H100s and later reported roughly **230,000 GPUs, including 30,000 GB200s**, for training Grok ([Tom's Hardware, 2025](https://www.tomshardware.com/tech-industry/artificial-intelligence/elon-musk-says-xai-is-targeting-50-million-h100-equivalent-ai-gpus-in-five-years-230k-gpus-including-30k-gb200s-already-reportedly-operational-for-training-grok)). Anthropic CEO Dario Amodei has said that models in training now cost closer to **$1 billion**, with later generations potentially reaching **$10 billion or more** ([TIME, 2025](https://time.com/6984292/cost-artificial-intelligence-compute-epoch-report/)). The estimates vary, but at that scale even a small gap between capacity paid for and work completed is expensive.

Accelerators have a different cost shape from storage and networking. A reserved GPU costs the same whether a job is running on it or not. Additional capacity often requires reservations, allocation queues, and long planning horizons. Storage and networking can usually grow in smaller increments. Scarce accelerators are harder to acquire quickly and expensive to leave unused.

Acquiring capacity is only half the problem. A reservation can exist without becoming a running node. A scheduler can leave GPUs idle because free capacity is fragmented across the cluster. Even after placement, a workload may use only part of the device. Each layer between "capacity paid for" and "work completed" can lose useful time.

AI companies work on model architecture, batching, parallelism, and serving to increase useful work per accelerator-hour. Capacity providers have a different set of levers: reservations, provisioning, placement, sharing, and reclaim. Both reduce the gap between capacity paid for and work completed.

**Utilization is a systems question.** It starts with how accelerators are supplied and ends with whether a running workload is using what it was given.

## Scope

I use GPUs as the running example because their architecture and system behavior are well documented. Most of the ideas also apply to TPUs, Trainium, and other accelerators.

Networking and storage matter when they constrain accelerator time. If an all-reduce cannot stay on the fast GPU fabric, communication determines step time. If a data loader stalls, storage throughput determines how long the GPU waits. I treat those paths as part of the compute system rather than covering the full networking or storage stack separately.

The series goes deepest on capacity and scheduling, which is the layer I work on and want to understand more deeply. Kernel tuning, training, and inference appear when they change how the surrounding system should allocate or operate the hardware.

## How the series is organized

The series starts with the hardware unit, then moves outward to the scheduler, the shared cluster, and the capacity plan:

```
   $  CAPACITY YOU PAY FOR
   │
   │  Part 0   vocabulary: the 4-layer model and the Pending failure path
   │  Part 1   the compute unit: GPU, HBM, fabric, host, and network
   │  Part 2   sharing one GPU: MIG, MPS, time-slicing, and isolation
   │  Part 3   placing work: the scheduler loop, gangs, fragmentation, and topology
   │  Part 4   sharing the cluster: fair-share, preemption, co-location, tidal, elastic
   │  Part 5   keeping work alive: checkpointing, reclaim, and fail-slow hardware
   │  Part 6   measuring and buying: utilization, idle cost, reservations, forecast
   │  Part 7   the thesis: capacity supply and scheduling are one problem
   ▼
      USEFUL WORK DONE
```

The numbering is the intended reading order, but each post focuses on one mechanism. **0.1** introduces the four-layer model used throughout the rest of the series.

---

*Opinions are my own and do not represent my employer. Everything here refers to publicly documented concepts and products.*
