---
title: Brain Graph Engine — Migration Away From CPU-Bound Force Layout
date: 2026-05-07
status: design (no implementation commitment)
roles: [frontend, performance, ux-designer]
references:
  perf_pr: "#11 — fix(perf): cut spin-up + eliminate /brain freeze"
  followup_spike: "engineer/brain-perf branch — async cooldown spike"
  current_engine: "3d-force-graph (Three.js + d3-force-3d, CPU O(N²))"
---

# Brain Graph Engine — Migration Away From CPU-Bound Force Layout

## Problem

Nova's `/brain` visualization uses `3d-force-graph` (Three.js + d3-force-3d). The
force-layout simulation runs in JavaScript on the main thread with O(N²) per tick
(d3-force-3d does **not** use a Barnes-Hut quadtree in 3D). Per-tick cost in
operations:

| Nodes | Ops/tick | 100 ticks | 500 ticks |
|---|---|---|---|
| 500 | 250k | 25M | 125M |
| 2,000 | 4M | 400M | 2B |
| 10,000 | 100M | 10B | 50B |
| 50,000 | 2.5B | 250B | 1.25T |

At 10000 nodes (the user's actual engram count) any meaningful layout requires
seconds of compute *per tick*. Even with the async-cooldown spike on this branch,
that exceeds Chrome's main-thread budget per frame and triggers "Page Unresponsive."

**The async-cooldown spike on this branch (`engineer/brain-perf`) bounds the
problem to the 500–2000 node range.** For 5K+ nodes, no amount of tick-spreading
fixes it — the per-tick math itself is too heavy for single-threaded JS on the
main thread.

The user's product ambition: "I really want to get to a point where the number of
nodes does not cause an issue." The current engine architecture cannot deliver
that. A different engine choice can.

## Goals

- `/brain` interactive within 1–2 seconds of mount, regardless of node count up to ~50K
- 60fps interaction (pan, zoom, hover) at all node counts
- Force-layout settles in background without blocking UI
- Render quality at least matches today's Brain visual (orbs, edges, clustering, labels)
- Preserve current Brain features: cluster detection, search highlighting, focus-node zoom, neural-mode visuals, color-by mode (type/source), labels, selection state

## Out of scope

- Replacing engram storage / graph data model (it's a separate layer, this is purely the visualizer)
- Multi-user real-time collab on the graph
- Any backend changes (other than possibly precomputed layouts — see Option C)

## Engine options

### Option A — Web Worker port of d3-force-3d

Keep current Three.js renderer; move force-layout to a Web Worker. Worker computes
positions, posts them back to the main thread per tick. Main thread updates
InstancedMesh positions and renders.

**Pros:**
- Smallest behavior change — same visuals, same forces, same settled output
- Reuses existing Brain.tsx component code
- Open-source path (no license concerns)
- Force-graph maintainers have shipped a worker-mode reference: see [3d-force-graph#243](https://github.com/vasturiano/3d-force-graph) (verify current state)

**Cons:**
- Still O(N²) compute — just unblocks UI but doesn't reduce total compute time
- 10K nodes still takes seconds per tick to compute; hundreds of ticks = minutes wall time even on a worker
- Cluster forces (the `onEngineTick` callback at `ForceGraph3D.tsx:1479-1532`) need to be ported to worker context — they read graph state and modify velocities each tick
- Posting position arrays per tick has serialization cost (60Hz × 10K nodes × 3 coords × 4 bytes = ~7MB/sec — acceptable but not free)

**Capacity:** ~5K nodes interactive, 10K+ workable but slow to settle.

**Effort:** Medium. ~2–3 days.

### Option B — GPU-native force layout (Cosmograph or similar)

Replace the 3d-force-graph engine with a WebGL-shader-based force-layout library.
Forces are computed on the GPU per frame; no main-thread math. Cosmograph
implements Barnes-Hut quadtree force simulation in fragment shaders.

**Pros:**
- Capacity: 100K+ nodes at 60fps (Cosmograph's published benchmarks). User's
  RTX 3060 Ti would handle Nova's projected engram graph for years.
- Layout settles in real-time (no "wait for cooldown")
- Pan/zoom/hover are GPU-accelerated; UI stays smooth regardless of graph size

**Cons:**
- **Cosmograph is primarily 2D.** Nova's Brain is 3D today. Migrating means either:
  - Accept 2D rendering (significant visual change — flag with `ux-designer` role for review)
  - Or use a different 3D-capable GPU library (much smaller field; verify what exists)
- License: Cosmograph has a community edition (Apache-2.0) and commercial editions
  with extra features. Verify the community version is sufficient.
- Different API surface — Brain.tsx's custom rendering (cluster shaders,
  galaxy/nebula backdrops, neural-mode glow, particle effects on edges) would
  need to be re-implemented or dropped.
- Bigger rewrite — most of Brain.tsx and all of ForceGraph3D.tsx would change.

**Capacity:** 50K–500K nodes at 60fps (2D). For 3D, depends on chosen library.

**Effort:** Large. 1–2 weeks for a feature-comparable port; longer with full visual parity.

**Sub-options to evaluate:**
- **Cosmograph 2D** — proven, fast, but visual regression
- **GPU Three.js force-layout** — write our own compute shaders for force math, keep the Three.js scene; preserves all visual features. Highest control, highest effort.
- **vis-network / Sigma.js** — older WebGL graph libs, mostly 2D, smaller communities.
- **react-force-graph-vr** — Three.js WebXR variant; same CPU-bound layout, different rendering. Doesn't solve our problem.

### Option C — Server-side precomputed layouts

`memory-service` computes node positions in Python (numpy/scipy + force-atlas
or similar), stores them in a `engram_layout` table, and serves them via the
existing `/mem/api/v1/engrams/graph/lightweight` endpoint. The frontend just
renders pre-laid-out coordinates with no force simulation at all.

**Pros:**
- Zero CPU work on the frontend for layout — instant render
- Can use any Python library, including GPU-accelerated ones (cuGraph, RAPIDS)
- Supports incremental layout updates as engrams are added/changed (background job)
- Decouples "compute layout" from "render layout" cleanly

**Cons:**
- Layouts go stale as the graph changes; need a refresh strategy
- Initial load: have to wait for memory-service to compute the first layout
- No interactive layout adjustment (drag-to-rearrange would need a fallback)
- New schema, new API endpoint, new background worker, new failure modes
- Doesn't help with rendering 50K+ orbs — that's still a Three.js / GPU concern,
  just no longer compounded by force-layout cost

**Capacity:** Pure render at any node count the GPU can handle (~50K+ orbs).

**Effort:** Medium-Large. 4–7 days.

## Recommendation

**Stack two options for a defense-in-depth fix:**

1. **Option A (Web Worker) — short-term win for the 5K-node range.** Cheap,
   preserves all current visuals, low-risk. Buys time and helps users with
   moderate engram counts (probably most users).

2. **Option B (GPU-native) — long-term scalability.** The only path that handles
   50K+ nodes. Bigger change, but it's the engineering investment that lets
   the Brain feature scale with Nova's growing engram graph indefinitely.

**Skip Option C** unless we hit an unforeseen blocker on A and B. Server-side
precomputed layouts shift complexity to the backend without removing the
fundamental rendering challenges, and require a new background job +
schema migration that aren't justified by the perf win alone.

## Phasing

Recommended sequence of follow-up PRs after the current async-cooldown spike lands:

1. **PR-A1 (Option A, week 1):** port force-layout to a Web Worker.
   Acceptance: 5000 nodes mount within 5s with UI responsive throughout.
2. **PR-A2 (Option A polish):** loading-overlay UX during worker settle. Fade
   in particles/edges as alpha drops below threshold.
3. **(decision gate):** real-user feedback on PR-A1+A2. If 10K+ nodes still
   feel slow, commit to PR-B1.
4. **PR-B1 (Option B, weeks 2–3):** evaluate Cosmograph 2D vs custom GPU
   shaders against the spec's "Goals" section. Pick one. Spike a `/brain`
   visit at 50K synthetic nodes.
5. **PR-B2 (Option B build-out):** full feature parity (clusters, neural mode,
   selection, focus, color modes).
6. **PR-B3 (Option B cutover):** flag the new engine as default behind a
   feature flag (`brain.engine = legacy | gpu`); migrate Brain.tsx; deprecate
   old engine after stability window.

## Acceptance criteria (for any future engine implementation)

- 60 fps pan/zoom at 10K nodes on the user's RTX 3060 Ti via WSL2
- /brain mount-to-interactive ≤ 2 seconds at 10K nodes
- Force-layout settle does not block the UI (no "Page Unresponsive" dialog)
- Visual parity OR documented tradeoffs for: cluster boundaries, neural-mode
  glow, edge particle animation, search highlighting, focus-zoom, color-by mode
- Position cache (or equivalent re-mount fast-path) preserved
- Feature flag for safe rollout (`brain.engine`)

## Risks

- **Visual regression risk** in Option B is real and user-facing. The current
  Brain has distinctive aesthetics (galaxies, nebulae, particle edges) that
  came up explicitly in design polish. A 2D Cosmograph migration would lose
  these. UX-designer role should weigh in before commitment.
- **Underlying d3-force-3d behavior** has been tuned over time
  (`d3AlphaDecay(0.04)`, `d3VelocityDecay(0.4)`, custom cluster forces) — porting
  these to a different engine isn't a 1:1 translation; layouts will look subtly
  different even with care.
- **Library longevity:** Cosmograph is venture-backed; an open-source community
  edition is the safer dependency. Verify the community license terms cover
  Nova's commercial use case.
- **Maintenance:** GPU shader code is harder to debug than JS. If we go custom
  GPU compute (sub-option of B), we're committing to maintaining shaders
  in-house — non-trivial expertise.

## What this spec deliberately does NOT decide

- Which sub-option of Option B (Cosmograph 2D vs custom 3D GPU vs other)
- Whether to do A first then B, or jump straight to B
- The exact API shape of any new component
- Migration mechanics (feature flag rollout, data shape changes, etc.)

These belong in implementation specs once the user has chosen a direction.
