# Universe — the 3D celestial brain view

Implementation plan (authored 2026-07-16 with Fable; execute with any model,
one phase per session). Decisions marked LOCKED were made by Jeremy on
2026-07-16 — do not relitigate them; flag conflicts instead. Verification
lines are the definition of done: real flow through :5173, and :8080 where
stated.

## Decisions (LOCKED)

- **Build alongside, replace later.** Universe is a NEW theme registered in
  the THEMES registry (`frontend/src/brain/theme.ts`) next to Graph and
  Galaxy. Galaxy stays selectable until Jeremy declares Universe polished;
  only then is Galaxy deleted. Do not modify galaxy.ts beyond the one color
  addition noted in phase 1.
- **True 3D.** WebGL, not canvas-2D. This is the "true Three.js +
  UnrealBloom behind the same theme key" upgrade path ROADMAP.md already
  anticipated for the galaxy — realized as a new key.
- **The celestial mapping** (see table below): Nova and Jeremy are a binary
  star pair at the center; topics are planets; journals are a chronological
  asteroid belt; automations are comets with real periods; disconnected
  memory clusters are their own star systems.

## Why not a force layout

The old v0.1.0-alpha brain used ForceGraph3D; do NOT reach for
3d-force-graph or react-force-graph here. The universe layout is
deterministic orbital mechanics — positions derive from the hierarchy
(system placement, orbit radii, phase angles), and a force simulation would
fight that constantly. Use the raw `three` package with our own layout math.
Mine `git show v0.1.0-alpha` for visual recipes (bloom, glow) only, never
code (repo policy).

## Data inventory (verified against the live API 2026-07-16)

`GET /api/v1/brain/graph?platform=true` (router_chat.py) returns:

- **Memory layer** (from `memory.graph()`, backed by `./data/memory/`):
  nodes of type `topic`, `journal`, `source`, `skill`, plus `soul.md` with
  type `self`. Fields: `id`, `label`, `type`, `mtime`, and optionally
  `description`, `tags`, `source_url`, `learned`. Edges: `kind: "link"`
  (wiki-links resolved by title) and `kind: "tag"` (co-tagged files chained
  member[i]→member[i+1] — an artifact of construction, not real pairwise
  relations).
- **Platform layer**: `core` (id `"nova"`), `agent`, `tool`, `automation`,
  `rule` nodes (some carry `enabled`). Edges: `platform` (nova→agent,
  automation→agent), `grant` (agent→tool), `guard` (rule→tool/agent).
- There is **no user node today** — phase 1 adds one.
- Automations have `interval_minutes` in the DB but it is **not yet on the
  graph node** — phase 3 passes it through.

## The celestial mapping

| Graph thing | Universe object | Treatment |
|---|---|---|
| `core` (nova) + `self` (soul.md) | Primary star (golden) | The star IS Nova; soul.md is not drawn as a separate body. Clicking the star opens `soul.md` (galaxy precedent). Label follows the core node's label (assistant rename works). |
| `user` (new) | Companion star (blue-white) | Binary pair orbiting a shared barycenter at the origin, slow. Click → node detail like any platform node. |
| `topic` | Planet | Orbits its system's star. Size from edge degree, brightness from recency, color hashed from first tag (carry galaxy's domain-color idea). |
| topic linked only to one other topic | Moon | Renders orbiting its parent planet instead of the star. |
| `journal` | Asteroid belt | A ring around the home barycenter, ordered chronologically by date; recent = brighter/larger. No edges needed — this deliberately fixes the known "journals have 0 edges and float" layout problem. Click an asteroid → journal detail. |
| `automation` | Comet | Elliptical orbit in the home system; orbital period visualizes `interval_minutes` (log-scaled). `enabled: false` = dormant (dim, no tail). Perihelion swings near its executor agent (the `platform` edge). |
| `agent` | Inner planet | Tight orbits around the binary pair — they are Nova's own bodies. Dimmed when `enabled: false` (galaxy precedent). |
| `tool` | Moon of its agent | First granting agent is the primary; additional `grant` edges render as faint transfer lines to the other agents. |
| `rule` | Beacon buoy | Small pulsing marker stationed near what it guards; `guard` edges as short dashed arcs. |
| `skill` | Orbital station | Artificial silhouette (e.g. octahedron) in the home system, distinct from natural bodies. |
| `source` | Interstellar visitor | Elongated body with a faint tail pointing away from the home star (it came from outside); positioned near the topic(s) that link to it. |
| Connected component of memory nodes | Star system | See below. |
| Memory topic with zero edges | Rogue planet | Drifts dim in interstellar space between systems — a deliberate visual signal that the memory is orphaned. |

**Star systems.** Compute connected components client-side over the memory
layer's `link` + `tag` edges. The platform layer always belongs to the home
system (it is structurally disjoint from memory edges — that's expected).
Each memory component becomes its own system: a small dim system-star
labelled with the component's dominant shared tag (e.g. "bear-mountain"),
planets orbiting it. Systems sit on a Fibonacci-sphere shell at ~3–4× the
home-system radius with hash-seeded jitter (galaxy's determinism recipe:
mulberry32 seeded from ids, so nothing jumps between renders). Hold
"galaxy" in reserve as a future grouping tier for when there are dozens of
systems — do not build it now.

**Edges drawn vs. edges used.** `tag` edges inform component grouping but
are NOT drawn as lines (they're chain artifacts). `link` edges render as
faint depth-faded arcs within systems. Platform edges render per the table.

**Semantic zoom** (carry galaxy's mechanic): zoomed out → big neon system
names; zoomed in → body labels fade in; hover always labels. `labelMode`
auto/on/off and `labelScale` behave as in galaxy.

## Architecture / integration seams

- **Renderer seam**: `frontend/src/brain/theme.ts` — add
  `universe: { label: 'Universe', create: createUniverse }`. The factory
  signature is `(canvas, opts) => RendererHandle` with
  `setData/resize/destroy` required and `configure/recenter` optional.
  Brain.tsx never changes for registration; theme choice persists via
  `prefs.view` and unknown keys already fall back to `DEFAULT_THEME`
  (Brain.tsx guard: `prefs.view in THEMES`).
- **CRITICAL canvas trap**: Brain.tsx reuses one `<canvas>` element across
  theme switches (`<canvas ref={canvasRef}>`, no key). A canvas that has
  ever had a WebGL context returns `null` from `getContext('2d')` forever
  after — switching Universe → Galaxy/Graph would break both 2D themes.
  Phase 1 MUST add `key={prefs.view}` to the canvas element so React
  remounts a fresh element per theme (the setup effect already re-runs on
  `prefs.view`; note the ref-read inside the effect may need a
  requestAnimationFrame/queueMicrotask nudge or ref-callback pattern if the
  remount races the effect — verify the switch works both directions).
- **Three.js binding**: `new THREE.WebGLRenderer({ canvas, antialias: true })`
  binds the provided canvas directly. `destroy()` must dispose all
  geometries/materials/textures, the composer, and call
  `renderer.dispose()` + `renderer.forceContextLoss()`.
- **Bloom**: EffectComposer + UnrealBloomPass from `three/examples/jsm`
  (a.k.a. `three/addons`) — the exact recipe ROADMAP.md named.
- **Labels**: canvas-texture sprites (in-scene, depth-correct). Default
  chosen over a CSS2D overlay div (which would need parentElement injection
  and cleanup); revisit only if sprite text quality disappoints.
- **Picking**: `THREE.Raycaster` on pointer events; keep galaxy's
  drag-vs-click discrimination (total drag distance < 4px = click) and its
  pointer conventions (drag = orbit, wheel = zoom, slow auto-rotate when
  idle).
- **configure() passthrough** (Brain.tsx already sends these):
  `rotationSpeed` → global orbital time-scale multiplier; `labelMode`,
  `labelScale` as in galaxy.
- **`showPlatform` toggle**: Brain.tsx refetches with `platform=false` —
  platform bodies simply won't be in the data. The belt (journals) and
  memory systems must render fine without them; the home system just has
  its stars and belt.
- **Backend touches** (both in `brain_graph_endpoint`, router_chat.py —
  no migrations):
  - Phase 1: append a user node
    `{"id": "user", "label": "You", "type": "user", "mtime": now,
    "description": ...}` and edge
    `{"source": "nova", "target": "user", "kind": "bond"}`. (A
    `nova.user_name` setting is a phase-4 nicety, not required.)
  - Phase 3: include `interval_minutes` on automation nodes.
  - Extend `GraphNode` in `frontend/src/api.ts` accordingly.

## Phases

### Phase 1 — scaffold: the binary home system

Add the `three` dependency (+`@types/three` if needed). Create
`frontend/src/brain/universe.ts` and register it in THEMES. Fix the canvas
key trap in Brain.tsx. Backend: add the user node + bond edge; add a
`user` color to galaxy.ts's and graph2d.ts's color maps (one line each) so
the older themes don't render the new node in fallback gray. Render:
starfield backdrop, the golden Nova star and blue-white companion orbiting
a shared barycenter, bloom, star labels, camera orbit/zoom/auto-rotate,
raycaster picking (Nova → `soul.md`, user/empty-space per RendererOpts
contract).

**Verify at :5173**: pick Universe in the Brain HUD → binary system renders
and slowly orbits; click Nova opens the soul detail; switch Universe →
Galaxy → Graph → Universe with no blank canvas or console errors (the
context trap); Graph and Galaxy still show the user node (not gray).

### Phase 2 — star systems: memory as planets

Connected components over link+tag edges; per-system dim star + dominant-tag
label; planets with deterministic orbital placement (radius by recency,
phase angle hash-seeded, size by degree, color by first tag); subordinate
topics as moons; rogue planets drifting between systems; `link` edges as
faint arcs; semantic-zoom label crossfade (system names far, body labels
near, hover always); optional faint nebula tint per system.

**Verify at :5173 with live data**: the Bear Mountain topics form one
labelled system, the news/Giants topics another; an unlinked topic renders
as a rogue planet; zooming crossfades system names to planet names; click a
planet → its memory detail.

### Phase 3 — belts, comets, and the platform layer

Journal asteroid belt (chronological ring, recent bright, clickable).
Backend: `interval_minutes` on automation nodes. Automations as comets
(elliptical, period log-scaled from `interval_minutes`, dormant when
disabled, perihelion near the executor agent). Agents as inner planets
(dimmed when disabled), tools as moons with transfer lines for multi-agent
grants, rules as beacon buoys with dashed guard arcs, skills as stations,
sources as interstellar visitors with outward tails.

**Verify at :5173**: journals sit in a readable dated ring and open on
click; a real automation's comet orbit visibly differs for different
intervals; toggling "show platform" off leaves a clean memory-only
universe; disabled agent/automation reads as dormant.

### Phase 4 — polish and (Jeremy's call) galaxy retirement

Tune bloom/exposure; complete configure() passthrough and `recenter()`;
performance guards: cap `devicePixelRatio` at 2, pause the rAF loop when
`document.hidden`, dispose audit on `destroy()` (switch themes repeatedly
and watch for WebGL context-lost warnings); touch support (one-finger
orbit, pinch zoom). Phone path: `docker compose build web && docker compose
up -d web`, then verify on :8080 (baked-build trap). Optional:
`nova.user_name` setting for the companion star's label.

Galaxy retirement happens ONLY when Jeremy says Universe is polished
enough: remove the `galaxy` entry from THEMES and delete galaxy.ts; the
`prefs.view in THEMES` guard already falls back safely for anyone with
`galaxy` persisted. Note for the picker: ROADMAP's Nova-view item renames
the picker to "Nova view" (Graph / Galaxy / Nova); Universe becomes the
Galaxy slot's successor in that lineup.

## Verifying WebGL visually (for implementing sessions)

Screenshots of :5173 work via dockerized chromium
(`docker run … node:alpine` + playwright-core + chromium with swiftshader) —
but `--virtual-time-budget` BREAKS WebGL/rAF rendering; use a real wait
(e.g. `page.waitForTimeout`) before capturing. Screenshots supplement — they
don't replace — the real-flow verification lines above.

## Flagged decisions (defaults chosen, not locked)

- Raw `three` over 3d-force-graph (rationale above).
- Sprite labels over a CSS2D overlay.
- Tag edges cluster but don't draw.
- User node label defaults to "You" (setting deferred to phase 4).
- Systems on a fixed shell (no tag-overlap-proportional distance yet — keep
  layout v1 simple and deterministic).
