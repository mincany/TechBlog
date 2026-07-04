# Part 2 — GPU Sharing · Orchestrated Writing & Review Log

**Series:** Inside AI Infrastructure: The Compute Layer
**Part 2 thesis:** A whole accelerator handed to a job that uses a sliver of it is the most
common waste in the fleet. Part 2 is about the levers that let *many jobs share one unit* so
it stops sitting idle — splitting it in **space** (MIG), sharing it in **time/concurrency**
(MPS, time-slicing), and the isolation cost that decides when sharing actually pays off.

**Author altitude (invariant):** software engineer who *architects the sharing system*, not a
kernel/driver tuner. The recurring move — the hardware gives you one fast unit; your job is to
architect the system that packs multiple claimants onto it without them stealing each other's
memory or tail latency, or you leave it idle. Utilize-vs-fallback framing in every post.

**Format:** Format A (prose / worked example) for all four, matching the verified 1.1–1.5 mold.
Canonical running box: **p5.48xlarge** (8× H100, 80 GB HBM, ~3.35 TB/s, ~990 BF16 TFLOPS).

**Compliance:** public concepts only (MIG, MPS, time-slicing, NVIDIA datasheet numbers, K8s
device plugin, Kubernetes) — all have public docs. No internal service names, APIs, metrics,
customers, or CR/ticket numbers. "Opinions my own" footer on every post.

## Pipeline

Per section: **writer subagent (1 section)** → **adversarial reviewer (senior tech lead:
hardware-utilization lens + standalone readability + big-picture series fit)** → alignment
dialogue documented here → **soft-lock** only after no critical findings. Whole-Part
adversarial reviewer after all four sections locked.

Dependency waves:
1. **2.1** (anchor — defines the space-vs-time fork) — write → review → lock
2. **2.2** ∥ **2.3** (the two prongs) — write in parallel → review each → lock
3. **2.4** (needs 2.2 + 2.3 locked — references all three sharing modes) — write → review → lock
4. **Whole-Part** adversarial review

## Section status

| § | slug | writer | review | lock |
|---|------|--------|--------|------|
| 2.1 | gpu-sharing-problem | ✅ done | ✅ reviewed | 🔒 locked |
| 2.2 | mig-partitioning | 🔄 demo rework | ⏳ re-review pending | 🔓 unlocked |
| 2.3 | mps-time-slicing | 🔄 demo rework | ⏳ re-review pending | 🔓 unlocked |
| 2.4 | isolation | ✅ done | ✅ reviewed | 🔒 locked |

---

## 2.1 · One GPU, Many Jobs: The Case for Sharing

**Writer:** subagent 9340df20. Format A prose worked-example. Opens Part 2, pivots from
"ceilings" (Part 1) to "how much of the unit gets used," establishes the space-vs-time fork.

**Adversarial review:** subagent 31fd7487 (senior tech lead). Findings:

- CRITICAL-1 (H100 "132 SMs" wrong) — **dismissed by reviewer on re-check**: 132 SMs enabled
  is correct per NVIDIA public datasheet (GH100 die = 144, H100 product = 132). No change.
- CRITICAL-2 (3× 13B instances on one H100) — **valid, fixed.** 3×26 GB = 78 GB ignores KV
  cache + CUDA context + activations (~1.5 GB/instance) → ~82 GB, does not fit. Reframed to
  **two** instances (52 GB weights, ~28 GB left for KV cache/activations) — honest, and the
  utilize-vs-fallback contrast still lands.
- CRITICAL-3 ("0.3% SM utilization" mislabeled) — **valid, fixed.** 3.3/990 TFLOPS is % of
  peak FLOPs, not SM occupancy; in memory-bound decode the SMs are occupied-but-starved.
  Changed to "0.3% of peak FLOPs — the SMs are busy issuing memory loads and waiting."
- CRITICAL-4 (MIG "up to 7 instances") — correct but needs nuance; added "(at the smallest
  slice size)."
- MINOR (bandwidth "near saturation" re-derives 1.2 as if a surprise) — tightened to "against
  the 3.35 TB/s ceiling; the one resource this job actually uses."
- MINOR (self-caught): MIG rigidity example conflated a 4/7 compute slice with a 60%-memory
  need (57% vs 50% memory). Reframed to a generic "next slice up over-provisions," deferring
  exact profiles to 2.2.

**Compliance:** clean — only public concepts (MIG, MPS, time-slicing, H100, p5.48xlarge,
NVIDIA datasheets); disclaimer footer present.

**Decision: 🔒 SOFT-LOCK** — all critical findings resolved.

---

## 2.2 · Hard Partitions: MIG

**Writer:** subagent (parallel wave). Format A. The SPACE prong; profile table verified vs
NVIDIA public MIG User Guide.

**Adversarial review:** subagent 2dcd9dac (senior tech lead). Findings:

- CRITICAL-1 ("two 3g.40gb instances fill the GPU") — **valid, fixed.** 3g+3g = 6 of 7
  compute slices; 1 slice stranded even though memory is full. Contradicted the post's own
  rigidity section. Reworded to "consume all 8 memory slices but leave 1 of 7 compute slices
  unassignable — stranded by the geometry," and folded in MINOR-1's WHY (the 3g+5×1g case
  needs 4+5=9 memory slices > 8).
- CRITICAL-2 (profile table max-instance counts) — **reviewer self-corrected: table is
  correct** per NVIDIA docs (1g.10gb=7, 1g.20gb=4, 2g.20gb=3, 3g.40gb=2). No change.
- CRITICAL-2-revised (GPC vs "compute slice" conflation; "GH100 die has 8 GPCs, H100 exposes
  7 active") — **valid, fixed.** Dropped the GPC framing; now consistently "7 compute slices
  and 8 memory slices … a profile bundles some of each," and removed "(GPC groups)."
- CRITICAL-3 ("~424 BF16 TFLOPS" implies exact linear scaling) — **valid, fixed.** Added
  "nominal" (L2/scheduling effects put real per-slice throughput a few % below linear).
- MINOR-2 ("<1% of peak FLOPs" vs 2.1's "0.3%") — **fixed** to "~0.3%" for series coherence.
- MINOR-3 (a MIG instance can still hit a device-level Xid error) — left as-is; the post's
  claim is about memory/SM isolation between instances, which holds. Out of scope for 2.2.

**Compliance:** clean. **Decision: 🔒 SOFT-LOCK.**

### 2.2 revision — 2026-07-04 (user finding: demo showed only the limitation)

**User (Mincan):** the locked 2.2 was prose-only and, worse, it demonstrated MIG by its
*limitation* (rigidity, stranded capacity, "when it's the wrong tool") and never showed the
actual win — that MIG lets you run **2 workloads on 1 GPU instead of 1**. Part 2 is about
utilization; a post that only shows the constraint doesn't help the reader. Also: the write-up
was not detailed enough to execute (where does `nvidia-smi` run? do I need a Capacity Block?
what instance type? where do commands run?).

**Alignment (thread ↔ correction):**
- Conceded in full — this is the recurring "show the win, not the limitation" miss. Saved as
  a global lesson and written into the steering file (§2 "Show the win…", §3 "When a demo is
  required"). Applies to all future utilization/sharing posts, not just this one.
- Reframe applied to 2.2:
  - TL;DR #1 now leads with the win (2–7 tenants in parallel on one card); rigidity demoted
    to the tail of #2.
  - New **Format B demo** is the centerpiece: Step 0 state → Step 1 baseline (one job, card
    mostly idle) → Step 2 partition into two 3g.40gb → **Step 3 the win: two jobs running
    concurrently on one physical GPU, two PIDs on two MIG devices** → Step 4 the cost (illegal
    geometry rejected). Win leads; limitation is Step 4 + one trimmed "cost" section.
  - Full runbook added per the "do not assume" ask: reserve p5.48xlarge (Capacity Block /
    ODCR) → launch on the Deep Learning AMI → SSH in → every command runs in that shell →
    `~/workload.py` provided.
  - The two limitation-heavy sections ("The trade-off" 4 bullets + "When MIG fits/wrong" two
    lists) compressed to a 3-bullet "cost" + a 3-line "when it fits."

**Open — blocks re-lock:** demo output is illustrative pending a **real p5.48xlarge run**
(agent has no GPU; never fabricate output). Mincan launches the instance → captures verbatim
`nvidia-smi -L`, the two-PID `nvidia-smi`, and the rejection → paste replaces the illustrative
blocks → then re-review (utilization-win lens) → re-lock.

**Decision: 🔓 UNLOCKED — win-first rewrite done; awaiting real-run capture + re-review.**

---

## 2.3 · Soft Sharing: MPS and Time-Slicing

**Writer:** subagent (parallel wave). Format A. The TIME/CONCURRENCY prong; MPS vs
time-slicing kept cleanly separated, contrast table includes MIG.

**Adversarial review:** subagent 0b2adad4 (senior tech lead). Findings — all three criticals
traced to ONE root: the worked example used a *saturating* per-tenant rate.

- CRITICAL-1 (4× arithmetic error) — **valid, fixed.** "~6 GB × ~560 tok/s ≈ 0.84 TB/s" is
  wrong (6×560 = 3.36 TB/s). 0.84 TB/s corresponds to ~140 tok/s.
- CRITICAL-2 (conceptual: a single continuous 3B decode stream already saturates ~3.35 TB/s,
  so stacking 4 saturating streams can't give 4× throughput — MPS then equals time-slicing) —
  **valid, fixed.** Reframed the example to *sub-saturating* tenants: each 3B tenant at a
  moderate ~140 tok/s (~0.84 TB/s, ~25% of the pipe), four summing to ~3.36 TB/s. MPS's win is
  now correctly stated as **gap-filling + no context-switch dead-time**, with aggregate
  bandwidth-capped either way — not a false 4× throughput.
- CRITICAL-3 (MPS section said 560 tok/s/tenant while time-slicing section said 140) —
  **fixed.** 140 tok/s is now consistent across both sections.
- MINOR-1 (bridge described bursty case but example demonstrated saturation) — **fixed** by
  the reframe; example now demonstrates the bursty/sub-saturating case.
- MINOR-2 ("buy 4× hardware for same total throughput" wording) — **fixed** to "what you save
  is three GPUs" (consolidating four barely-used cards onto one).

**Compliance:** clean. **Decision: 🔒 SOFT-LOCK.**

### 2.3 revision — 2026-07-04 (same win-first correction as 2.2)

**User (Mincan):** apply the 2.2 treatment to 2.3 — lead with the win, add a detailed,
no-assumptions demo, keep the limitation a short coda.

**Alignment (thread ↔ correction):**
- The locked 2.3 had the right worked example but no demo, and TL;DR #1 trailed off on the
  isolation cost. Reframed:
  - TL;DR #1 now leads with the win (a GPU one job under-fills carries several at once);
    isolation cost moved to the tail of #2.
  - Worked example retitled "The payoff: four tenants on one card" (body kept — it was the
    reviewer-corrected sub-saturating version).
  - New **Format B demo** is the centerpiece: Step 0 whole-GPU/no-MPS → Step 1 baseline (one
    job under-fills, ~40% util) → **Step 2 the problem (two jobs, default time-slicing ≈ 2×)**
    → **Step 3 the win (same two jobs under MPS ≈ 1×, both overlap on idle SMs)** → Step 4 the
    SM-cap lever + shared-fault-domain cost. Win leads; limitation is Step 4 + the trimmed
    isolation coda.
  - Honest workload choice: a *small compute* matmul (`~/mps_work.py`) that under-fills the
    SMs — the regime where MPS actually wins. A saturating (memory-bound) workload would NOT
    show an MPS win (bandwidth-capped either way — the exact trap caught in the original 2.3
    review). Bridged to the worked example as the "compute face" vs its "bandwidth face."
  - Same runbook detail as 2.2 (reserve p5.48xlarge → DLAMI → SSH → whole non-MIG GPU 0).
  - "No hardware isolation" closing tightened to a single sentence handing into 2.4.

**Open — blocks re-lock:** demo output illustrative pending a **real p5.48xlarge run** (never
fabricate). Capture verbatim: Step 1 single-job time + util, Step 2 two-job time-sliced ~2×,
Step 3 two-job MPS ~1×, and the mps-server in `nvidia-smi` → paste replaces the illustrative
blocks → re-review (win lens) → re-lock.

**Decision: 🔓 UNLOCKED — win-first rewrite done; awaiting real-run capture + re-review.**

---

## 2.4 · When Sharing Backfires: Isolation and Interference

**Writer:** subagent 5a67c928. Format A. Part 2 finale: two interference axes (memory +
performance), worked MIG-vs-MPS-vs-time-slicing contention contrast, decision-framework
table, Part 2 wrap + Part 3 handoff.

**Adversarial review:** subagent 16bf0684 (senior tech lead). Verdict FIX-THEN-LOCK.

- CRITICAL-1 (prefill is the WRONG interferer) — **valid, fixed.** Prefill is compute-bound
  (high arithmetic intensity, reuses weights across 2,048 tokens) → contends for SMs/FLOPs,
  not the HBM bus. Co-locating a compute-bound job with memory-bound decode is the
  *complementary* case, which undercuts the interference story. Replaced the interferer with a
  genuinely bandwidth-bound neighbor: a tenant swapping to a 13B model (from 1.2/2.1, 13B
  decode draws ~3.3 TB/s alone) that truly contests the ~3.35 TB/s bus.
- CRITICAL-2 (prefill FLOP 2× wrong: "24.6 TFLOP" vs correct 2×3B×2048 ≈ 12.3) — **fixed** by
  removing the prefill scenario entirely.
- CRITICAL-3 (MIG "each with its own memory controller path" overstated — it's 1/8 of
  controllers, not a full-width path) — **fixed.** Now "a fixed fraction of the memory
  controllers and its own data path," and added the honest flip side: each slice is capped at
  its fraction of the ~3.35 TB/s, so isolation also means no bursting above its share.
- MINOR-2 (`CUDA_MPS_PINNED_DEVICE_MEM_LIMIT` may name pinned *host* memory, not device HBM) —
  **fixed** by softening to "a per-client device-memory limit" (no unverifiable env-var name).
  Kept `CUDA_MPS_ACTIVE_THREAD_PERCENTAGE` in Axis 2 (well-documented, correct for SM%).
- MINOR-1 (the "brief burst" wording already hinted prefill wasn't a sustained hog) — resolved
  by the C1 rewrite.
- M3/M4/M5: canonical numbers consistent, Part 3 handoff good, no meta-framing, voice clean.

**Compliance:** clean. **Decision: 🔒 SOFT-LOCK.**

## All four sections locked → running whole-Part adversarial review next.

## Whole-Part Adversarial Review

**Reviewer:** subagent 642459c1 (senior tech lead). Verdict FIX-THEN-LOCK → now resolved.

- CRITICAL-1 (number discrepancy: "<3% of FLOPs" in 2.1 TL;DR / 2.3 opener / 2.4 opener vs
  "~0.3% of peak FLOPs" in 2.1 body + 2.2 — 10× loose, 3.3/990 = 0.33%) — **fixed.** All three
  "<3%" occurrences harmonized to "~0.3% of peak FLOPs". grep confirms zero "<3%" remain.
- CRITICAL-2 (2.3: is ~128 tok/s peak or normal? tension with the headroom the MPS example
  assumes) — **judged already resolved** by 2.3's worked-example text: "a tenant running
  flat-out has nothing to share. Concurrency only helps when tenants leave the pipe idle part
  of the time. Real serving does exactly that." The reconciliation is explicit in-body; the
  C1 harmonization removes the remaining skim-level ambiguity. No further edit needed.
- MINOR-1 (13B decode derivation restated in 2.1/2.2/2.3) — **accepted as-is.** Each post must
  stand alone; the recaps are one-liners ("the scenario from 2.1"), not full re-derivations.
  Left for readability across independent entry points.
- MINOR-2 (07/04–07/05 publish dates = US holiday weekend) — cosmetic, left as-is (cadence).
- MINOR-3/4/5/6: handoff chain clean, compliance clean, space-vs-time framing consistent,
  isolation ranking identical across 2.3 table + 2.4 axes, no meta-framing/teacherly tone.

**Decision: ✅ PART 2 LOCKED — all four sections written, reviewed, cross-checked, harmonized.**

## Final status

| § | slug | title | state |
|---|------|-------|-------|
| 2.1 | gpu-sharing-problem | One GPU, Many Jobs: The Case for Sharing | 🔒 locked |
| 2.2 | mig-partitioning | Hard Partitions: MIG | 🔓 unlocked — win-first demo added; pending real p5 capture + re-review |
| 2.3 | mps-time-slicing | Soft Sharing: MPS and Time-Slicing | 🔓 unlocked — win-first demo added; pending real p5 capture + re-review |
| 2.4 | isolation | When Sharing Backfires: Isolation and Interference | 🔒 locked |

Pipeline delivered: 5 writer subagents + 5 adversarial reviewers (4 per-section + 1 whole-Part),
16 findings resolved. Not yet done by hand: local render check (`npm run dev`) — the agent's
x64 node can't load arm64 rollup, so the user runs it. Chinese translations deferred per series
policy.
