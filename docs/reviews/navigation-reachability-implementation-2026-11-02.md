> Historical checkpoint `7c872496`, before whole-branch findings I1/M1. Its old navigation-entry assertion did not establish zero reloads, and its readiness could accept hidden sibling content. The [fresh review](navigation-whole-branch-review-2026-11-02.md) preserves both findings; the [guarded fix](navigation-final-fix-2026-11-02.md) adds actual negative controls and new source-pinned evidence. Old runs below remain historical, not passes of the corrected guards.

# Task 1 — navigation reachability implementation report

Source checkout: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`. Branch: `codex/navigation-reachability`. Baseline: `6d0a74a58a3a20df7f3718b2ade2413c1ba84e8a`. Final source commit: `7c8724965a34428b5267de3070d5e94895772956` (10 source/test files only).

## Implementation and scope

- Home/aside Devices card keeps its existing single-action pattern and now links to `/topology` with exact text **Machines and services**. There is no added rail item or duplicated Home card.
- Settings > Devices exposes the same text/link in its existing section, using the existing Services section link pattern. Search can find its `devices-topology` target.
- Capture is a normal category beside Devices under **What Nova works with**. The existing Capture renderer/forms move intact from Privacy. `/settings#capture` and its section IDs continue to work; search now correctly says `Capture › Capture`.
- The navigation model accounts for all 11 app views, including Capture and Topology as secondary Settings children. Chrome placements stay unchanged. The fold helper uses the ordinary Capture category.
- The required UI gate is `tests/ui/navigation-reachability.test.ts`; normal `npm run test:ui` already discovers `tests/ui/*.test.ts`, and `.github/workflows/ci.yml` runs that command in its required UI-gate job. No optional job or CI bypass was added. `tests/navigation-registry.test.js` is independently discovered by ordinary `npm test` through `tests/*.test.js`.

Production files: `ui/js/components.js`, `ui/js/nav.js`, `ui/js/settings-ia.js`, `ui/js/surfaces.js`. Covering files: `tests/navigation-registry.test.js`, `tests/support/navigation-registry.js`, `tests/ui/navigation-reachability.test.ts`, `tests/ui/fold-navigation.ts`, `tests/ui-logic.test.js`, `tests/ui-review.test.js`. No API/auth/runtime/dependency, #275, M10j, plan, inventory, LEDGER, PR, push or merge edits were made by this task.

## Independent inventory and oracle

The actual app registration is the `VIEWS` object in `ui/js/app.js`: `home`, `chat`, `tasks`, `memory`, `automations`, `skills`, `activity`, `health`, `settings`, `capture`, `topology`. `routeOf` in `ui/js/nav.js` also recognizes `/new`, `/c/:id`, `/schedules`, and normalized trailing slashes. Onboarding, pairing, and `/styleguide` are separate server/standalone surfaces rather than app `VIEWS`; they are not falsely counted as ordinary post-setup app views.

The test oracle reads the actual production `VIEWS` literal, independently of DESTINATIONS, placement, reachable(), and the old fold helper lists. Its bounded literal reader fails closed if the registration shape changes. Actual browser clicks must produce every registered ID in `body[data-view]`; source/model coverage alone cannot satisfy the gate. The safe crawl only follows genuinely rendered same-origin known-app anchors, plus explicit More/Conversations/New-conversation controls. Exact anchor scope/section IDs are used when clicking.

Each layout boots Home with exactly one `goto`; every subsequent route change is a normal click (rail) or tap (phone). It traverses Settings categories and the real conversation drawer, a dated `/c/2026-11-02-nav001`, `/new`, and the real historical-handoff renderer’s `/schedules#sc-navigation-example` link. This historical fixture does not create or run a schedule. Readiness waits for real loaded Core data, rendered view content, no visible skeleton/waiting/topology-loading nodes, and finite animations, with no arbitrary sleeps. Required Home/Devices/Capture doors are checked and actually clicked independently of the broad crawl.

The fixture uses the existing blank isolated real Core as a stand-in, not an API mock: temporary HOME/NOVA_HOME/file vault, fake agent with no egress, no mesh listener, synthetic conversation only. The browser blocks non-GET and other-origin requests; reports assert zero forbidden requests, browser errors, document reloads after initial Home, and external Core egress. No form values are entered, no form is submitted, no action/mutation/download/capture start/cloud/device/cluster operation is performed by the new gate. The legacy covering tests exercise only their own synthetic fixtures.

## RED before production edits, and honest legacy reachability

Before changing any production file, the new real rendered test ran against the exact baseline source in this checkout. `red.log` and `red/{phone,rail}-report.json` retain the complete RED: each layout reached all 11 views, missing `[]`, and failed solely because all three required ordinary doors were absent. Both fixtures had `healthMesh=true`. The earlier harness-only failures (TypeScript 7 has no old compiler API; More overlays its phone trigger) were corrected without production changes; historical logs remain `harness-initial.log`, `harness-more-overlay.log`, and `red-before-session-family.log` and are not presented as valid product RED.

Topology was already reachable on main via Home > Health > View machines and services, because the fixture’s Health response really includes its mesh check. Settings > Services also really exposed its unconditional topology link. Capture was already reachable via Settings > Privacy and permissions > Open Capture, and returned via Capture settings. No legitimate legacy door was excluded to manufacture an unreachable view. The regression is the requested homes and the undercounted model, not an assertion that main had only nine reachable views.

A later final-harness baseline recheck adds metadata and actual alias-family coverage without changing shared production files: the four changed JS modules are fulfilled with their exact `git show` baseline bytes. `baseline-module-sha256.json` verifies those bytes against the pin and also verifies app.js and index.html remain exactly equal to baseline. `baseline-recheck.test.ts`, `baseline-js/*`, `red-final-harness.log`, and `red-final/*-report.json` preserve this supplemental experiment separately from the original pre-edit RED.

| Run | Layout | Registered / reached | Missing | Required Home / Devices / Capture category | States |
|---|---|---|---|---|---|
| Original unchanged main RED | phone | 11 / 11 | `[]` | False / False / False | 25 |
| Original unchanged main RED | rail | 11 / 11 | `[]` | False / False / False | 25 |
| Pinned main final-harness RED | phone | 11 / 11 | `[]` | False / False / False | 26 |
| Pinned main final-harness RED | rail | 11 / 11 | `[]` | False / False / False | 26 |
| Controlled orphan RED | phone | 12 / 11 | `['orphaned']` | True / True / True | 25 |
| Controlled orphan RED | rail | 12 / 11 | `['orphaned']` | True / True / True | 25 |
| Final source GREEN | phone | 11 / 11 | `[]` | True / True / True | 26 |
| Final source GREEN | rail | 11 / 11 | `[]` | True / True / True | 26 |

## Actual reached paths on final source

These are the recorded paths from Home; reset/replay also uses visible Home navigation. The JSON reports retain every state, visible link, scoped section ID, heading, visible control metadata, and the independent required-door click paths.

### phone

| View | Actual clicks/taps from Home |
|---|---|
| home | Initial Home |
| tasks | All tasks (/tasks; section=home) |
| topology | Machines and services (/topology; section=home) |
| memory | Memory (/memory; section=home) |
| health | Health (/health; section=home) |
| chat | Chat (/chat; section=tabs) |
| automations | More (#more-btn[aria-expanded="false"]; section=control) > Automations (/automations; section=more) |
| skills | More (#more-btn[aria-expanded="false"]; section=control) > Skills (/skills; section=more) |
| activity | More (#more-btn[aria-expanded="false"]; section=control) > Activity (/activity; section=more) |
| settings | More (#more-btn[aria-expanded="false"]; section=control) > Settings (/settings; section=more) |
| capture | More (#more-btn[aria-expanded="false"]; section=control) > Settings (/settings; section=more) > CaptureSources, consent, and what Nova remembers (/settings#capture; section=settings-nav) > Open Capture (/capture; section=capture) |

Independent required-home paths:
- homeTopology: Machines and services (/topology; home)
- devicesTopology: More (#more-btn[aria-expanded="false"]; control) > Settings (/settings; more) > DevicesPhones and computers paired with Nova (/settings#devices; settings-nav) > Machines and services (/topology; devices-topology)
- captureCategory: More (#more-btn[aria-expanded="false"]; control) > Settings (/settings; more) > Capture (/settings#capture; settings-nav) > Open Capture (/capture; capture)

### rail

| View | Actual clicks/taps from Home |
|---|---|
| home | Initial Home |
| chat | Chat (/chat; section=rail) |
| tasks | Tasks (/tasks; section=rail) |
| memory | Memory (/memory; section=rail) |
| automations | Automations (/automations; section=rail) |
| settings | Settings (/settings; section=rail) |
| topology | Machines and services (/topology; section=aside) |
| health | Health (/health; section=aside) |
| skills | More (#more-btn[aria-expanded="false"]; section=control) > Skills (/skills; section=more) |
| activity | More (#more-btn[aria-expanded="false"]; section=control) > Activity (/activity; section=more) |
| capture | Settings (/settings; section=rail) > CaptureSources, consent, and what Nova remembers (/settings#capture; section=settings-nav) > Open Capture (/capture; section=capture) |

Independent required-home paths:
- homeTopology: Machines and services (/topology; aside)
- devicesTopology: Settings (/settings; rail) > DevicesPhones and computers paired with Nova (/settings#devices; settings-nav) > Machines and services (/topology; devices-topology)
- captureCategory: Settings (/settings; rail) > Capture (/settings#capture; settings-nav) > Open Capture (/capture; capture)

## Future-orphan protection

The committed registry test verifies adding a production registration extends the missing-view oracle. The stronger rendered demonstration is retained separately as `orphan-probe.test.ts`, `orphan.log`, and `orphan/*-report.json`: an isolated HTTP fixture overlays a real extra app VIEWS entry, its own hidden DOM root and `/orphaned` route, while adding no navigation door. Both complete rendered crawls reached the original 11 views, kept all required homes true, and failed precisely with registered=12/reached=11/missing=[orphaned]. No shared source file was modified for that experiment. It uses the same gate, not a model-only assertion.

## Validation and exact commands

All paths below are relative to this ignored report directory unless stated otherwise. Every command used the explicit source workdir above. No dependency/browser/image downloads, baseline updates, threshold changes, or authentication weakening were performed. Manual browser calls used cached `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never`, mounted Node `/home/jeremy/.local/share/mise/installs/node/26.3.1`, `CI=1`, and a non-root user. No `NOVA_UI_SHOTS` was set for the M10i covering batch, so its hardcoded tracked screenshots were not rewritten.

Canonical rendered command (RED and GREEN use the same discovery file; their evidence directories/log names differ):

```sh
docker run --pull=never --rm --init --ipc=host \
  -v /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build:/work -w /work \
  -v /home/jeremy/.local/share/mise/installs/node/26.3.1:/opt/node:ro \
  --user 1000:1000 -e HOME=/tmp -e CI=1 \
  -e NOVA_NAV_EVIDENCE=.superpowers/sdd/navigation-reachability-2026-11-02/green \
  mcr.microsoft.com/playwright:v1.56.1-noble bash -c 'export PATH=/opt/node/bin:$PATH CHROMIUM=$(ls -d /ms-playwright/chromium-*/chrome-linux/chrome | head -1); sh scripts/tripwire.sh node --test --test-concurrency=1 --test-force-exit tests/ui/navigation-reachability.test.ts'
```

For the supplemental experiments, only the explicit test file changes to `.superpowers/sdd/navigation-reachability-2026-11-02/{baseline-recheck,orphan-probe}.test.ts` and the corresponding evidence/log path. Both intentionally exit1.

| Check / raw log | Actual result |
|---|---|
| `green.log`: final canonical rendered gate | 2/2 pass, zero skips; 26states/layout, all11views and all required homes; real conversation/alias paths |
| `green-unit.log`: `node --test tests/navigation-registry.test.js tests/ui-logic.test.js tests/ui-fixes.test.js tests/ui-components.test.js tests/ui-review.test.js` | 52/52 pass, zero skips |
| `typecheck.log`: `npm run typecheck` | pass |
| `tokens.log`: `npm run lint:tokens` | pass; 48UI files |
| `themes.log`: `npm run check:themes` | pass for all6; existing5non-lead packages remain unapproved/6offscale values each; Orb Teal still requires owner rendered review |
| `boundary.log`: `node --test tests/core/api.test.ts` | 12/12 pass, including module boundary |
| `affected-ui.log`: cached container + `sh scripts/tripwire.sh node --test --test-concurrency=1 --test-force-exit --test-timeout=900000 tests/ui/ui-fixes.test.ts tests/ui/posture-sweep.test.ts tests/ui/fold-navigation.test.ts tests/ui/m6a-capture.test.ts tests/ui/m10i-topology.test.ts` | 35/35 pass, zero skips; prior to final Capture group placement adjustment |
| `accessibility-layout.log`: same container/tripwire flags + `tests/ui/m9-contrast.test.ts tests/ui/m9-targets.test.ts tests/ui/fold-postures.test.ts` | 7tests:6pass,1initial Settings-position baseline failure. The364combination matrix, derived bands, safe area, all-look contrast and both hit-area tests passed. |
| `baselines-final.log`: same container/tripwire + `node --test --test-concurrency=1 --test-force-exit --test-name-pattern="fold postures match" tests/ui/fold-postures.test.ts` | 1/1 pass on final Capture-beside-Devices placement, unchanged baselines/2%threshold; WebKit cover1.75%, inner8201.14%. |
| `npm-test.log` + `npm-test-attempt-process.txt`: ordinary `npm test` | Did not finish: owned fresh-user child remained at367s with no completion line; terminated only owned child/runner, exit143. Not claimed passing. |
| `npm-test-bounded.log`: `sh scripts/test.sh --test-force-exit --test-timeout=180000 'tests/*.test.js' 'tests/core/*.test.ts' 'tests/acceptance/*.test.ts' 'tests/supervisor/*.test.ts' 'tests/chaos/*.test.ts' 'tests/ingest/*.test.ts' 'tests/ingest/*.test.js'` | 1626tests:1607pass,5fail,14existing opt-in skips; not ordinary npm-test proof. See failures below. |
| `isolated-named-tests.log`: `timeout 300s sh scripts/test.sh --test-concurrency=1 tests/core/design-api.test.ts tests/core/provider-guard.test.ts tests/ingest/round2.test.js tests/skills-api.test.js tests/acceptance/fresh-user.test.ts tests/acceptance/m6a-capture.test.ts` | 43/43 pass, zero skips,43.82s; ordinary runner, no force-exit, no concurrent browser checks. |

The bounded full run’s five named failures were:

1. `tests/core/design-api.test.ts:164` — mode/profile event check read `action` from undefined.
2. `tests/core/provider-guard.test.ts:170` — expected refusal after201changedfiles, got provider-ended-without-result.
3. `tests/ingest/round2.test.js:87` — N1b20freefollows timed out.
4. `tests/skills-api.test.js:81` — email-summary flow timed out.
5. `tests/ui-review.test.js:155` — obsolete Privacy-and-permissions Capture search path. This in-scope expectation was corrected to the new category and the focused52test run passes.

The first four were not silently called pre-existing: the controller-requested serial ordinary-runner check passed all43 tests, including the four named cases plus fresh-user and acceptance Capture, without concurrent browser load. This supports a load/concurrent-fixture hypothesis but does not establish a deterministic cause or erase the original failures. The initial ordinary fresh-user stall and guarded full results remain visible regardless of the isolated outcome. Exact-head public CI must still run ordinary `npm test` and `npm run test:ui`; the guarded equivalent and focused reruns do not replace required CI. No unrelated fixture/source fixes were made.

The initial Capture-under-You placement moved Settings list content enough to fail three existing screenshots (Chromium cover3.19%, WebKit cover4.17%, WebKit inner8202.06%; limit2%). The final placement beside Devices in the appropriate existing group preserves the top group and passes the original baseline check. Original failed shares remain in `accessibility-layout.log`; there was no mask, threshold, image regeneration, or hidden-link workaround.

## Evidence limits and handoff

Final screenshots: `green/{phone,rail}-home.png`, `green/{phone,rail}-home-devices.png` (actual scrolled Devices card), `green/{phone,rail}-settings-list.png` (Capture ordinary category), `green/{phone,rail}-settings-devices.png`, and `green/{phone,rail}-settings-capture.png`. These are neutral ignored workspace evidence, not replacements for tracked baselines. The shared Devices card is already a live styleguide specimen at `/styleguide?entry=devices`; root owns final matched-composition/slop packaging.

The gate proves visible navigation entries and real route changes, not completion of every feature behind them. Visible headings/control metadata are evidence only of those rendered controls. Collapsed native details, absent conditional device/task/service data, model/provider connections, saved credentials, capture sources, approvals, and other operations remain unproven by this blank crawl. No form or effectful control is exercised. Phone and rail arrangement parity does not claim an installed iPhone hardware check.

Implementation source is committed; all owned test processes and writes have ended before handoff. Source ownership is explicitly released to the controller. Root handles independent review, inventory, LEDGER, PR, push and merge. Ordinary exact-head required CI remains an integration condition, not a locally claimed pass.
