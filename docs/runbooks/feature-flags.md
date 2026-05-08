# Feature Flags Runbook

> Foundation reference for Nova's feature-flag system. For the
> kill-switch-specific operational playbook, see
> [kill-switches.md](kill-switches.md). For system design, see
> `docs/superpowers/specs/2026-05-05-feature-flags-design.md`.

---

## Why flags exist

Three jobs. Everything in the flag system should map to one of them:

1. **Kill switches** — instant, hot-path lever to pause a misbehaving
   subsystem without restarting a container or losing in-flight state.
   (`kill.engram.ingestion`, `kill.cortex.thinking_loop`)

2. **Behavior toggles** — turn a code path on or off across the stack.
   Covers experiments, staged rollouts, and configuration that changes
   during normal operation. (`pipeline.guardrail_strict_mode`,
   `pipeline.outcome_feedback_symmetric`)

3. **Capability / surface gates** — temporarily hide partially-built
   features or surfaces until they're ready. Exists for code that's
   shipped but not yet meant to be visible. (`ui.surface_preset`,
   `brain.enabled`)

What flags are **not** for:

- **`nova:config:*` runtime config** (inference backend, routing
  strategy, screenpipe URL) — those belong in Redis `nova:config:*`
  and are surfaced via Settings UI already.
- **User preferences** that vary per user — those belong in
  `user_settings` (Postgres) once multi-tenant SaaS lands. A flag is a
  global operator knob, not a per-account preference.

---

## The four namespaces

| Pattern | Purpose | Lifetime | Example |
|---|---|---|---|
| `kill.<system>.<thing>` | Emergency kill-switch: pause without restart | Permanent (operational) | `kill.engram.ingestion` |
| `<system>.<behavior>` | Behavior toggle: code-path experiment or rollout | Permanent (config) | `pipeline.guardrail_strict_mode` |
| `feature.<area>.enabled` | Capability gate: hide WIP until launch | **Temporary** — set a delete-by date | `feature.capture.enabled` |
| `ui.<setting>` | UI preset / surface preference | Permanent (UX) | `ui.surface_preset` |

**Enforcement:** naming is convention only in v1. `register_flag()` does
not enforce the prefix. Code review is the gate — PRs adding flags in
the wrong namespace should be sent back.

### `kill.*` — emergency kill-switches

Boolean flags only. Default `false` (system on). Flipping to `true`
pauses the named subsystem at its next loop boundary without losing
in-flight state. These are `CRITICAL_FLAGS` — every write requires a
typed-confirm field in the PATCH body.

Current kill switches: `kill.engram.ingestion`,
`kill.consolidation.cycle`, `kill.cortex.thinking_loop`,
`kill.intel_worker.poll`, `kill.knowledge_worker.crawl`.

See [kill-switches.md](kill-switches.md) for the per-flag playbook.

### `<system>.<behavior>` — behavior toggles

Covers anything that changes how a code path executes but isn't
emergency-stoppage. Can be boolean or enum. Examples:

- `pipeline.guardrail_strict_mode` (bool) — medium-severity findings
  loopback instead of pass-through.
- `pipeline.outcome_feedback_symmetric` (bool) — negative outcomes
  reduce engram activation (AQ-002).
- `pipeline.web_fetch_strict_sanitize` (bool) — strict tool-result
  sanitizer for web content.
- `memory.retrieval_mode` (enum: `inject` | `tools`) — how agents
  receive memory context.

These flags are permanent config. Delete them only when the code path
they guard is removed.

### `feature.<area>.enabled` — capability gates

Boolean. Default `false` (feature hidden). Intended to be short-lived:
the flag ships with the feature code; once the feature is stable and
launched it gets deleted, the default becomes "always on," and callers
can treat the code path as unconditional.

**Hygiene rule: every `feature.*` flag must have a delete-by date in
its `description` field.** Review them quarterly. Flags that have
outlived their launch are dead weight that obscures real config.

```python
register_flag(
    key="feature.capture.enabled",
    type="bool",
    default=False,
    description="Show Capture surfaces in the dashboard. "
                "Delete-by: 2026-Q3 (post-screenpipe-bridge GA).",
)
```

### `ui.*` — UI presets and preferences

Control what the dashboard renders. Can be boolean or enum. These are
permanent — they encode operator intent about surface visibility, not
transient rollout state.

Current `ui.*` flags:

- `ui.surface_preset` (enum: `chat_only` | `standard` | `advanced`,
  default `chat_only`) — coarse dashboard surface visibility tier.
  `chat_only` shows ~6 items; `standard` adds tasks/knowledge/brain;
  `advanced` exposes everything including admin internals.

`ui.*` flags are in `PUBLIC_FLAGS` and readable by the browser without
admin auth. Kill switches are **never** in `PUBLIC_FLAGS`.

---

## `PUBLIC_FLAGS` — the browser allowlist

`GET /api/v1/feature-flags/public` returns flags in this set without
requiring an admin secret. The allowlist lives in
`orchestrator/app/feature_flags_router.py`:

```python
PUBLIC_FLAGS: frozenset[str] = frozenset({
    "ui.surface_preset",
    "brain.enabled",
})
```

**Why the allowlist is small on purpose:**

- Kill-switch state must never reach the browser. An attacker observing
  `kill.engram.ingestion=true` knows an operator is fighting an active
  incident.
- `CRITICAL_FLAGS` overlap with `PUBLIC_FLAGS` is treated as a bug in
  code review.

**How to add a flag to `PUBLIC_FLAGS`:**

1. Confirm the flag carries no operational or security-sensitive signal.
2. Verify it is not in `CRITICAL_FLAGS`.
3. Add the key to the `frozenset` in `feature_flags_router.py`.
4. Add a test asserting the flag is present in `GET /public` and that
   at least one `CRITICAL_FLAGS` member is absent (the negative-case
   test is already in `tests/test_feature_flags.py`).

---

## `useFeatureFlag` — dashboard pattern

The only public read path for flags in the dashboard is the
`useFeatureFlag` hook:

```ts
// dashboard/src/hooks/useFeatureFlag.ts
import { useFeatureFlag } from '@/hooks/useFeatureFlag'

// Boolean flag — safe default is false (feature off)
const brainEnabled = useFeatureFlag<boolean>('brain.enabled', false)

// Enum flag — safe default matches the server-side in-code default
const preset = useFeatureFlag<'chat_only' | 'standard' | 'advanced'>(
  'ui.surface_preset',
  'chat_only',
)
```

**Behavior:**

- All `PUBLIC_FLAGS` are fetched in a single `GET /api/v1/feature-flags/public`
  call on app mount (TanStack Query, `staleTime: 30_000`, `retry: 1`,
  `refetchOnWindowFocus: true`).
- Returns `defaultValue` on fetch failure, missing key, or while the
  request is in-flight — the dashboard starts in the most-restrictive
  state and expands.
- Updating a flag via `PATCH` in the admin UI triggers a TanStack Query
  invalidation; the hook reflects the change within one refetch interval
  (~30 s without a window-focus event, immediately on focus).

**Anti-patterns to avoid:**

```ts
// WRONG — localStorage flag state is not server truth
const preset = useLocalStorage('ui.surface_preset', 'chat_only')

// WRONG — direct fetch bypasses caching and type safety
const res = await fetch('/api/v1/feature-flags/public')

// WRONG — reading admin-auth-gated flags from the public endpoint will 404
const guardrail = useFeatureFlag('pipeline.guardrail_strict_mode', false)
```

---

## Sidebar wiring (`ui.surface_preset`)

Nav items declare their minimum required preset via `presetVisibility?`
on `NavItem`. Items without it are always visible (back-compat: existing
nav items only need the annotation when they should be hidden at some
preset level).

```ts
type SurfacePreset = 'chat_only' | 'standard' | 'advanced'

// In navItems array:
{ to: '/tasks', label: 'Tasks', presetVisibility: ['standard', 'advanced'] }

// In Sidebar.tsx / MobileNav.tsx filter:
const preset = useFeatureFlag('ui.surface_preset', 'chat_only')
const visible = items.filter(
  item => !item.presetVisibility || item.presetVisibility.includes(preset)
)
```

---

## When NOT to use a flag

| Signal | Use instead |
|---|---|
| Config that changes during normal operations (routing strategy, inference backend) | `nova:config:*` Redis key, Dashboard Settings |
| Behavior difference between dev and prod environments | `.env` var or Docker Compose override |
| Per-user preference (dark mode, language) | `user_settings` table |
| Permanent feature enable/disable with no rollback story | Hard-coded or env-var; flags imply runtime toggle |
| A/B testing with statistical bucketing | Separate experimentation layer (out of scope) |

---

## Quarterly hygiene checklist

Run this review quarterly (or before any SaaS launch):

- [ ] Any `feature.*` flags past their delete-by date? Delete the flag
      and remove the guard code.
- [ ] Any `kill.*` flags currently `true` that should have been cleared?
      Investigate and clear.
- [ ] `PUBLIC_FLAGS` still free of `CRITICAL_FLAGS` overlap?
- [ ] Any `<system>.<behavior>` flags whose code path was removed from
      production? Delete the flag row and the `register_flag()` call.
- [ ] Audit log clean? Run the aggregate audit query and confirm no
      unexpected actors.
