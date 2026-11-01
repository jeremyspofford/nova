# The orb's fixed semantic states (owner decision, 2026-10-31)

Branch `ui/orb-states`. The owner's decision is binding and recorded in DESIGN-SYSTEM §1 ("The
orb's semantic states"):

> RED is reserved for problems that STOP Nova (the Failed class — work cannot proceed, a dead-man
> switch fired, a security refusal). AMBER is needs-you-but-running: approvals waiting, problems like
> the Health items, degraded capture. This maps 1:1 onto the status vocabulary and it is a SEMANTIC
> rule, not a colour choice, so it survives theming.

## 1. The state set

Fixed, in `src/core/design.ts` (`ORB_STATES`) and `ui/js/status.js` (the same list; a test pins
both): **idle, listening, working, speaking, needs-you, stopped, offline**. `attention` became
`needs-you` and `alert` became `stopped`.

Most urgent first (`orbState`): offline, listening, stopped, needs-you, speaking, working, idle.

## 2. Red versus amber

Before, `orbState()` turned the orb to `alert` (red) whenever **any** problem was open. A problem
record didn't say whether it stops Nova, so the record now does:
- **`problem.stops`**: migration `0021_problem_stops.sql` adds the column (default 0) and carries
  it in the problem's sync triggers. It is registered at version 21 in `ADDED_COLUMNS`
  (`src/core/mesh/sync.ts`). A hub leaves it out for a standby one release behind, which takes the
  problem without it and shows it amber. If a hub doesn't adapt, the standby says once that it is
  behind. Tested in `tests/core/sync-skew.test.ts`. `Log.problem(…, { stops: true })` sets it. A playbook marked
  `stops` sets it on every problem it opens.
- **The UI.** A problem with `stops` makes the orb **stopped**. Every other open problem counts
  with the waiting approvals and makes it **needs-you**. The same split colours:
  - the Health badge (`alert` or `attention`);
  - the problem toast;
  - the System health card (Failed or Needs you);
  - each open problem in Health, which now carries its status (Failed or Needs you).
- **Default amber.** Every problem not listed below is amber, including problems raised before
  this change.

### Problem sources classified as stopped

| Where | What | Why it stops Nova |
|---|---|---|
| `src/core/ledger.ts:586` | "A task failed: …" | The Failed class: the task's work can't proceed |
| `src/core/network/index.ts:331` | "Nova couldn't put … back to the snapshot after …" | The dead-man's switch's revert failed; the person must check the target |
| `src/core/network/index.ts:430` | "Nova lost contact with your devices after …, so it is putting the snapshot back by itself." | The dead-man's switch fired |
| `src/core/network/index.ts:435` | "Nova couldn't start putting … back after …" | The dead-man's switch couldn't start its revert |
| `src/core/receipts.ts:90` (`stops` at :94) | "A model call … while Nova is set to local-only. It was refused." | Security refusal |
| `src/core/mesh/enroll.ts:125` (`stops` at :127) | "Nova turned away … Someone may be guessing codes" | Security refusal |
| `src/core/mesh/enroll.ts:225` | "A request to join … was refused because its check didn't match." | Security refusal |
| `src/core/ingest/screen.ts:360` | "Nova blocked some outside content but couldn't open its ledger entry." | A security refusal (the block) that the person would otherwise not see |
| `src/core/changes/pipeline.ts:838` | "Nova couldn't roll back … Check … by hand." | Work can't proceed: a broken change left in place |
| `src/core/resilience/restart.ts:71` | "Nova couldn't restart itself. Stop it and start it again." | Nova itself is stuck |
| `src/core/resilience/reset.ts:560` | "Nova couldn't restart itself to finish erasing." | Nova itself is stuck mid-erase |
| `src/core/resilience/playbooks.ts:30` (`server-crashed`) | "Nova stopped unexpectedly" (raised by the supervisor) | Nova stopped |
| `src/core/resilience/playbooks.ts:35` (`safe-mode`) | "Nova is held in safe mode" | Nova is held, not running |
| `src/core/resilience/playbooks.ts:43` (`server-unresponsive`) | "Nova stopped answering" | Nova stopped answering |

**Amber on purpose:** everything else. That includes:
- the review's case, files too large for the standby's copy (`src/core/mesh/sync.ts:193`);
- capture outages, which are degraded capture (`src/core/capture/capture.ts:747`, `:753`);
- the local model not answering (`src/core/models/index.ts:639`);
- the standby falling behind or taking over;
- release checks that kept the old release running;
- the supervisor's other services (`service-crashed`, `service-held`, `service-stopped`,
  `service-rolled-back`, M10e). A service of the person's stopping doesn't stop Nova;
- budget guardrails (`src/core/infra/index.ts`). They refuse the plan but are not security
  refusals. An apply they stop also fails its task, and that failure is stopped.

**The pair page** (`ui/js/pair.js`) uses the same states: needs-you while it waits, and stopped
when pairing fails or the hub is the wrong one.

## 3. The visual rules, and the theme check

- **The package format.** A design system declares `orb_states{}`. For each of the seven states
  it gives a colour token, a motion, a light, a mark, and its reduced-motion equivalent:
  `reduced: {light, mark}`. The vocabulary is what the renderer draws:
  - motions: `breathe`, `swirl`, `pulse`, `ripple`, `beckon`, `alarm`, `still`;
  - lights: `soft`, `full`, `bright`, `stark`, `dim`;
  - marks: `none`, `ring`, `dashed`.
- **The rendering.** `generateCss` turns each state's look into custom properties on
  `.orb[data-state="…"]`. Under reduced motion, only the light and the mark are set.
  `ui/styles/components.css` draws them: the four-layer sphere of #254 is unchanged, plus the
  keyframes and the mark.
- **The per-state distinction rule** (`checkOrbStates`, run by `validatePackage`, so by
  `npm run check:themes`, the API's validate route and apply). A package fails when:
  1. it adds a state, removes one, or omits `orb_states`;
  2. a state has no reduced-motion equivalent, or names a motion, light or mark the renderer
     doesn't draw, or anything else (no CSS reaches the page from a package);
  3. two states share motion, light and mark, so they differ by colour alone;
  4. under reduced motion, two states share light and mark;
  5. any other state shares stopped's motion, light, mark, reduced light or reduced mark;
  6. stopped isn't `status/error`, or another state takes `status/error`;
  7. needs-you isn't `orb/attention` or `status/attention`.
- **The built-in look** (all six packages):

  | state | colour | motion | light | mark | reduced (light / mark) |
  |---|---|---|---|---|---|
  | idle | orb/core | breathe | soft | none | soft / none |
  | listening | orb/listening | swirl | full | none | full / none |
  | working | orb/core | pulse | full | none | full / dashed |
  | speaking | orb/core | ripple | bright | none | bright / none |
  | needs-you | orb/attention | beckon (two beats, then a rest) | bright | dashed | bright / dashed |
  | stopped | status/error | alarm (a hard blink, one per `motion/pulse`) | stark | ring | stark / ring |
  | offline | orb/core | still | dim | none | dim / none |

  Before this, three pairs were apart by colour alone:
  - working and stopped had the same pulse;
  - idle and needs-you had the same breathing;
  - in Obsidian, idle and needs-you were also the same colour (`orb/core` = `orb/attention` =
    `#e8b34b`), so there was nothing to tell them apart.
- **The alarm's rate.** It blinks once per `motion/pulse` (1.8 s in every built-in). That is far
  below three flashes a second (WCAG 2.3.1).

## 4. Tests

- **Unit, `tests/orb-states.test.js`:**
  - the state list matches between the system and the UI;
  - every shipped package declares exactly the seven states;
  - each rule in §3 fails a package built to break it;
  - the generated CSS draws every state and its reduced-motion equivalent, with nothing moving;
  - `node scripts/check-themes.js` exits 1 on a package that omits a state.
- **Unit, `tests/ui-logic.test.js`:** red only for a stopping problem; amber for any other,
  including one with no `stops`.
- **UI, `tests/ui/orb-states.test.ts`:**
  - Runs in every installed design system (read from the style reference's list), light and dark,
    with motion and with reduced motion.
  - It renders all seven states at rail size, with each orb's colours forced to one grey, and
    compares them in luminance only, as a 12×12 grid of cell means.
  - With motion, every animation is paused at the same ten moments and the orbs are compared frame
    by frame. Under reduced motion it compares one still frame and checks that nothing runs.
  - It asserts:
    1. every pair differs by at least 0.004;
    2. stopped is at least 0.008 from its nearest state, without colour and in colour;
    3. no other state has stopped's mark, or, with motion, its animation.
- **UI, `tests/ui/ux-review-1.test.ts` F3:** the lit-sphere measurements, for the renamed states.

**Measured** (the `ORB …` lines of a run, every installed design system, light and dark). The
least difference between any two states, with colour taken away:

| | least of any pair | where |
|---|---|---|
| with motion | 0.0103 | speaking and needs-you, Companion Light |
| under reduced motion | 0.0078 | speaking and needs-you, Companion Light |
| stopped and its nearest state | 0.0145 | |

The test caught a real gap on its first run. Under reduced motion, speaking and needs-you were
0.0008 apart on light pages: the dashed ring was drawn in the state's own light, and in grey on a
cream page it had almost no luminance contrast. The mark is now drawn toward the text colour and a
little wider, so it stands out from any page by its brightness.

The stark light first had `saturate(1.3)`, which flattened stopped's highlight in Aurora light
(F3 measured 0.005, wanting 0.04). It is now `contrast(1.2)`, and F3 passes in every state.

## 5. The F3 fix stays

#254's lit sphere is unchanged in structure. The F3 test still measures highlight, shade and glow
falloff in every state and design system.

The flat salmon disc in the UX review was the old alert state, shown because Health had open
problems (files too large for the standby's copy). Under the new rule those problems are amber
needs-you. The depth of the rendering is still the F3 fix.

## 6. Limits

- **The vocabulary is the renderer's.** A theme picks from the motions, lights and marks the CSS
  renderer draws. "A future space theme renders the same states as stellar phenomena": that needs
  a renderer that draws such phenomena. When one exists, it extends the vocabulary, and the same
  rules apply to it.
- **Installed third-party packages without `orb_states`** no longer validate, so Nova shows the
  default design instead and lists them as having problems. The owner's rule says such a theme
  fails. The six built-ins are updated here; a design someone made themselves needs
  `orb_states` added before it applies again.
- **Measurement in CI only.** The UI test measures distinguishability in Chromium's renders. It
  shows that the states differ without hue, not how a person with a particular vision condition
  sees them.

## 7. LEDGER "What changed" (for the coordinator to insert at merge)

**What changed (2026-10-31, orb states):**
- The orb has a fixed set of seven states. Red now means one thing: something stopped Nova, such as
  a task that failed, a safety switch that fired, or a request Nova refused for your security.
- Anything that needs you while Nova keeps running is amber: an approval waiting, a Health item to
  look at, capture running degraded. The review's salmon orb (files too large for the standby's
  copy) would now be amber.
- Every state looks different from the others in more than colour: it moves differently, glows
  differently or has a ring. With reduced motion turned on, the still orbs still look different,
  and the stopped orb is unlike all the others.
- Health shows each open problem as "Failed" or "Needs you", and a problem's notice is red or amber
  to match.
- Every design system must show all seven states and keep these rules, or it can't be applied.
