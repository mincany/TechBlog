---
title: "0.0 · Compute: the Crown Jewel of AI Infrastructure"
description: "AI infrastructure is enormous — data, storage, networking, serving. This series zooms into the one slice where the money and the scarcity live: compute. The whole series answers one question — are you getting useful work out of the silicon you pay for?"
date: "06/28/2026"
---

This is the entry post for a series on AI compute capacity and scheduling. Before any of the mechanics, I want to bound the scope: what slice of AI infrastructure this series is about, why that slice, and how the rest of the posts hang together.

## TL;DR

"AI infrastructure" is a huge surface — data pipelines, storage, networking, training frameworks, serving stacks. This series zooms into one slice: **compute**. The reason is simple — compute is the scarce part, the expensive part, and the part everything else waits behind. And across the entire stack, one question quietly decides whether the money was well spent:

**Are you getting useful work out of the silicon you pay for?**

That's the whole series. Every later post is a specific place where the honest answer is "not really," and what you can do about it.

## Why it's the crown jewel

I'll skip the war story — this is a foundations post, and the case is easier to make with public numbers than with anecdotes. Three things make compute the part worth obsessing over.

**It's bought at six-figure-GPU scale.** Frontier training clusters are now measured in hundreds of thousands of accelerators. xAI stood up its Colossus cluster at 100,000 H100s in 2024 and roughly doubled it through 2025, with Elon Musk publicly citing around **230,000 GPUs (including 30,000 GB200s)** running to train Grok ([Tom's Hardware, 2025](https://www.tomshardware.com/tech-industry/artificial-intelligence/elon-musk-says-xai-is-targeting-50-million-h100-equivalent-ai-gpus-in-five-years-230k-gpus-including-30k-gb200s-already-reportedly-operational-for-training-grok)). A cluster like that isn't a line item on the budget; it *is* the budget.

**It's expensive in a way nothing else in the stack is.** GPT-4 reportedly cost over $100 million to train — and that's now the *floor*. Anthropic CEO Dario Amodei has said the models in training today run closer to **$1 billion**, with the next generations heading toward **$10 billion and beyond** ([TIME, 2025](https://time.com/6984292/cost-artificial-intelligence-compute-epoch-report/)). Storage and networking cost real money too, but they don't carry a ten-figure price tag attached to a single artifact.

**The meter never stops, and the supply doesn't flex.** This is the part people underrate. A reserved GPU bills whether or not a job is running on it — idle silicon costs exactly the same as busy silicon. You can't paper over a shortfall by buying more on the spot either: frontier accelerators come with lead times, reservations, and allocation queues. And scale itself fights you — at a hundred thousand GPUs, components fail often enough that training frameworks checkpoint defensively just to survive the run. CPU and RAM you can mostly burst into on demand; compute you have to *commit* to, ahead of time, and then it sits there metering.

Put those together and the asymmetry is the whole point: it's the most expensive resource, the hardest to get more of, and the one that bills you continuously — so the gap between *capacity you paid for* and *useful work you got* is where the money actually leaks.

A scope note before we go further: I'll use the **GPU** as the running example throughout, because it's the most documented and the easiest to reason about. The model holds for any accelerator — TPU, Trainium, and friends. And to be honest about the edges: networking and storage absolutely *can* be the binding constraint in specific regimes (a communication-bound run, a data-loading stall). This series treats those as **properties of the compute unit** — topology in Part 1, communication stalls in Part 6 — not as the spine. The spine is compute.

## What this series is — and how to read it

There's one idea underneath all 28 posts: every dollar of compute either turns into useful work or **leaks away** somewhere between "capacity you paid for" and "work that got done." Each Part of the series goes after one specific leak. Read top to bottom, it runs from the capacity you pay for down to the work that gets done:

```
   $  CAPACITY YOU PAY FOR
   │
   │  Part 0   shared vocabulary — the 4-layer model + the "Pending" failure path
   │  Part 1   what one "unit of compute" actually is
   │  Part 2   scheduling units: the scheduler loop, gang scheduling, fragmentation
   │  Part 3   sharing units across teams: quotas, fair-share, preemption
   │  Part 4   utilization engineering — co-location, oversubscription, tidal, elastic
   │  Part 5   bringing capacity online and giving it back gracefully
   │  Part 6   the workload's-eye view: parallelism as a placement constraint
   │  Part 7   measurement, economics & forecast
   │  Part 8   the thesis: capacity supply and scheduling are one problem
   ▼
      USEFUL WORK DONE
```

Reading order is just the numbering. Next up: **0.1 — the 4-layer mental model**, the vocabulary every other post leans on.

---

*Opinions are my own and do not represent my employer. Everything here refers to publicly documented concepts and products.*
