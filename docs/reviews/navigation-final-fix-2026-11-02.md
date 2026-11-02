# Final review fix wave — I1 and M1

Source checkout: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`; branch `codex/navigation-reachability`; starting BASE `e6ba2e2fbc50caf96e79de6b93f4bde889a535a2`. One sole source writer, no delegation, other worktrees, push, PR, merge, preview, history rewrite or root-document staging. This report and all new raw evidence use `final-fix-*`; prior runs/reports/probes remain historical and were not overwritten.

Commit: `da46f8ec7f8e0557dd58e77b17e4ededb109dc51` — `test: require visible active navigation views and retained documents`. Only the five assigned source files are in this commit; root-owned docs remain unstaged. Ownership is explicitly released below.

## Findings addressed

**I1:** `tests/support/navigation-registry.js` reads both actual production `VIEWS` registration values and the actual `el` DOM-ID mapping. The expected registered view set still comes only from production registration, independently of `DESTINATIONS` and `reachable()`. The reader rejects unsupported registration/element-map shapes, duplicate registrations/mappings, unresolved values and shared view roots. It derives `tasks -> tasks-view`, `chat -> thread`, `settings -> settings-view` and all other roots without an expected-view list or parallel hidden registry. Unit tests include independent literal synthetic IDs, actual registration completeness and fail-closed cases.

The new shared `tests/ui/navigation-support.ts` exports the actual browser predicate used by canonical `drawn()`. It resolves `body[data-view]` through that source-derived map, checks that exact root's visibility (including CSS visibility/opacity), and requires visible relevant content inside it. It never selects the shared scroller, another view or a hidden descendant. Pending markers are checked for actual visibility within the active root, and the `no-anim` readiness marker is checked on the active root. Actual visible empty states remain valid; hidden waiting content in previous views does not block them. Existing Chat/New, Settings, aliases, More and conversations all pass the real crawl. No app marker, runtime abstraction or dependency was added.

`tests/ui/navigation-guards.test.ts` uses synthetic HTML and an intercepted synthetic surfaces-store module, no app/server/owner data, to call that exported predicate directly. It checks empty selected Topology retaining hidden old Home content, hidden active root, hidden active descendant, visible empty-state readiness and active waiting markers. It imports only shared support, never the canonical test module.

**M1:** shared support attaches a Playwright request listener before the initial Home `goto()`. It records only navigation requests for the page's main frame over that Page's lifetime. `drawn()` asserts exactly one request before/after readiness on every real transition, and canonical completion checks again. Fresh raw reports include the actual request URL list. No performance-entry assertion is used as retained-document proof. The guard-negative probe separately performs actual history/hash transitions (one request), then an actual reload (two requests); the new assertion rejects it although the new document's performance navigation-entry count is one. Direct synthetic probe URLs are guard controls, never coverage paths.

Only five source files changed: `tests/navigation-registry.test.js`, `tests/support/navigation-registry.js`, `tests/ui/navigation-reachability.test.ts`, `tests/ui/navigation-support.ts`, `tests/ui/navigation-guards.test.ts`. The six actual app sources used by the gate are byte-identical to BASE, including all four production UI changes already present at `7c872496`. Complete hashes/byte counts are in `final-fix-source-sha256.json`.

## RED → GREEN proof

Before changing predicate behavior, the original `drawn()` browser predicate was moved unchanged into shared support, with canonical `drawn()` calling that same function. `final-fix-original-drawn.txt` retains the original source excerpt. The negative tests called that exported function, not a copied approximation. At this RED stage the existing document assertion was likewise moved unchanged into the shared function.

- `final-fix-guards-red.log`: four tests, one pass/three fail, exit 1. Empty active Topology accepted hidden previous Home (`true !== false`); hidden active root accepted (`true !== false`); actual reload not rejected (`Missing expected rejection`). The visible empty-state control passed. Native no-Kubernetes tripwire never fired.
- `final-fix-oracle-red.log`: initial root-reader contract tests against a deliberately empty new reader stub; four tests, two pass/two fail, exit 1. Independent synthetic IDs were absent and malformed mappings did not throw. This is separate root-reader TDD evidence, not the I1 browser proof.
- `final-fix-guards-green.log`: initial corrected predicate/document guard, four/four pass, exit 0, no skips; tripwire never fired.
- `final-fix-canonical.log`: final exact source, six/six pass, zero failures/skips, exit 0; four guard controls plus phone/rail canonical crawls. Raw negative counter: `same-document requests=1 reload requests=2 current navigation entries=1`. The old timing metric would still have returned one on the replaced document, while the new guard rejects it.

## Actual guarded reachability and controls

All use isolated real Core, fake agent, temporary home, `NOVA_AGENT_EGRESS=none`, service workers blocked, same-origin GET-only crawl route guard and native actual no-Kubernetes tripwire. No canonical form/service action is submitted. A neutral synthetic conversation and completed historical handoff exercise real `/new`, `/c/:id`, `/schedules#...` families without starting scheduled work. Exactly one initial Home `goto()` per canonical layout; subsequent transitions remain actual visible phone taps or rail clicks through real app doors, Home replay and More/conversation controls. No router-function calls, URL jumps or forced interactions were added to coverage.

| New raw checkpoint | Layout | Registered / reached | Missing | Home / Devices / Capture homes | States | Lifetime main-document requests |
|---|---|---|---|---|---|---|
| `final-fix-canonical/*-report.json` | phone | 11 / 11 | [] | true / true / true | 26 | 1 |
| same | rail | 11 / 11 | [] | true / true / true | 26 | 1 |
| `final-fix-orphan/*-report.json` | phone | 12 / 11 | [orphaned] | true / true / true | 26 | 1 |
| same | rail | 12 / 11 | [orphaned] | true / true / true | 26 | 1 |
| `final-fix-baseline/*-report.json` | phone | 11 / 11 | [] | false / false / false | 26 | 1 |
| same | rail | 11 / 11 | [] | false / false / false | 26 | 1 |

Every row has `healthMesh=true` and zero forbidden requests. `final-fix-summary.json` mechanically checks these counters, required families and request lists against the raw reports. Canonical browser-error and Core-egress assertions pass. All browser/control runs say tripwire never fired.

The new `final-fix-orphan.test.ts` is derived from the complete revised canonical crawl and uses the same final shared helper. Only its isolated HTTP fixture adds an actual app registration, el mapping, DOM root and route, with no door; the expected registry/root map reads the mutated actual app source. It fails exactly at missing-view coverage in both layouts, not root-reader setup. Its initial screenshot-only suppression condition is retained as executed; it does not change any navigation/readiness/coverage predicate. The original `orphan-probe.test.ts` and original orphan evidence remain separate.

The new `final-fix-baseline.test.ts` is likewise derived from the revised canonical crawl with exact pinned original modules served by its isolated route fixture. `final-fix-baseline-bytes.json` verifies all six involved app/index/module bytes against original main `6d0a74a58a3a20df7f3718b2ade2413c1ba84e8a`: four served original modules plus unchanged actual app.js/index.html. Both layouts fail specifically the three required homes while reaching all eleven rendered views, including Topology through the existing buried paths. The baseline is not manufactured as an unreachable Topology. Both negative-control commands intentionally exit 1, two failed tests each.

The original `NOVA_NAV_EVIDENCE` opt-in screenshot behavior is unchanged in committed source. Fresh ignored images of unchanged UI were automatically captured for some runs; they are not a new rendered-design approval or a rewrite of tracked baselines. No mask, threshold or baseline changes occurred.

## Exact commands and covering checks

Every command used the explicit source workdir above. Browser commands used cached image `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never`, mounted existing Node 26.3.1, non-root user and no downloads. Common Docker invocation (replace only the stated test list, evidence folder and raw-log output):

```sh
docker run --pull=never --rm --init --ipc=host \
  -v /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build:/work -w /work \
  -v /home/jeremy/.local/share/mise/installs/node/26.3.1:/opt/node:ro \
  --user 1000:1000 -e HOME=/tmp -e CI=1 \
  -e NOVA_NAV_EVIDENCE=.superpowers/sdd/navigation-reachability-2026-11-02/final-fix-canonical \
  mcr.microsoft.com/playwright:v1.56.1-noble bash -c 'export PATH=/opt/node/bin:$PATH CHROMIUM=$(ls -d /ms-playwright/chromium-*/chrome-linux/chrome | head -1); sh scripts/tripwire.sh node --test --test-concurrency=1 --test-force-exit tests/ui/navigation-reachability.test.ts tests/ui/navigation-guards.test.ts' \
  > .superpowers/sdd/navigation-reachability-2026-11-02/final-fix-canonical.log 2>&1
```

- RED and first GREEN guard runs: omit the evidence env variable; test list only `tests/ui/navigation-guards.test.ts`; logs `final-fix-guards-{red,green}.log`.
- Orphan: evidence `final-fix-orphan`; test `.superpowers/sdd/navigation-reachability-2026-11-02/final-fix-orphan.test.ts`; raw `final-fix-orphan.log`, intentional exit 1.
- Baseline: evidence `final-fix-baseline`; test `.superpowers/sdd/navigation-reachability-2026-11-02/final-fix-baseline.test.ts`; raw `final-fix-baseline.log`, intentional exit 1.
- Earlier supplemental browser batch: evidence `final-fix-green`; test list `tests/ui/navigation-reachability.test.ts tests/ui/navigation-guards.test.ts tests/ui/m10b-settings.test.ts`; raw `final-fix-browser.log`, seven/seven pass, zero skips, exit 0. Final canonical raw above is authoritative for final reports/request fields.
- Root-reader RED: `/home/jeremy/.local/share/mise/installs/node/26.3.1/bin/node --test tests/navigation-registry.test.js > .superpowers/sdd/navigation-reachability-2026-11-02/final-fix-oracle-red.log 2>&1`, expected exit 1.
- Final focused ordinary unit command: `PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/tripwire.sh node --test tests/navigation-registry.test.js tests/ui-logic.test.js tests/ui-fixes.test.js tests/ui-review.test.js > .superpowers/sdd/navigation-reachability-2026-11-02/final-fix-unit-tripwire.log 2>&1`: 39/39 pass, no skips, exit 0, tripwire never fired. Actual Settings category/search tests are in ui-fixes/ui-review; no made-up Settings suite is counted.
- `PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH npm run typecheck > .superpowers/sdd/navigation-reachability-2026-11-02/final-fix-typecheck-complete.log 2>&1`: exit 0.
- `git diff --check > .superpowers/sdd/navigation-reachability-2026-11-02/final-fix-diff-check-final.log 2>&1`: exit 0, empty log.

Earlier diagnostics are retained: initial unit run `final-fix-unit.log` was 19/19 but mistakenly named a nonexistent `tests/settings-ia.test.js`; it provides no Settings-suite proof. The later actual 39-test runs above supply the intended coverage. `final-fix-oracle-settings-green.log` is the first actual 39/39 run; the final tripwire run adds the native tripwire check. First two typecheck logs (`final-fix-typecheck.log`, `final-fix-typecheck-final.log`) failed on the new fixture Locator's HTMLElement/SVGElement type and inferred optional strings; those source type errors were corrected before final verification. `final-fix-typecheck-green.log` and the final complete log pass. One mistyped workdir command was rejected before execution and caused no edit or test run.

## Scope, limits and security

The earlier covering browser batch mistakenly included the existing M10b Settings test outside this wave's intended navigation-only checks. It started a local stand-in shop and temporary Core, generated per-test fake username/password, saved that fake sign-in through the PWA and forgot it through the existing confirmation sheet; it verified the synthetic vault then held no sign-ins. It used no real credentials, account, owner data or external service. This bounded scope error was reported to the controller and was not repeated. The canonical crawl and all new negative probes remain navigation-only; setup API writes and synthetic session seeding are fixture initialization already authorized by the brief.

No production UI, API/auth policy, real tools/services/cloud resources, owner credentials/data, dependency, image baseline, threshold or retry behavior changed. No effectful real action or live feature/security guarantee is claimed. No full npm or unrelated browser batch was rerun; the prior known ordinary/bounded failures remain in their original logs. Final ordinary public CI, scoped independent rereview, root-owned claims/doc qualification, publication, merge and preview integration remain controller work. Old timing-based “no reload” claims require the controller's historical qualification; only these new request-tracked reports support that improved guard measurement.

## Changed source hashes

| File | SHA-256 |
|---|---|
| `tests/navigation-registry.test.js` | `a6254c2193afa8ad742d35f59049bc92b215d56dabf6b1f296873d9d6ea26d3a` |
| `tests/support/navigation-registry.js` | `2832848a145b7e528ef241a49b0237862994e13d1ee3a93c065c23e92b1c716c` |
| `tests/ui/navigation-reachability.test.ts` | `880152fdf5c43ba889047b98d369a470c360986c45e3ed6574545fded299dca1` |
| `tests/ui/navigation-support.ts` | `edc596a4e86fa8a82639abba44dcbbd49eb38d65a662ec68a7718e001b74dfef` |
| `tests/ui/navigation-guards.test.ts` | `998ba7d57e34b7c33e150af03479df11f17243aafdf993d32e4e20f5a1c06acb` |

## Ownership release

All owned browser/Core/stand-in-shop commands have completed (Docker containers used `--rm`); all owned exec sessions returned final exit codes. Source hashes were rechecked after commit and all five assigned files are clean. `final-fix-release-status.txt` records the remaining root-owned document changes only. No further source commands or writes are pending. **RELEASE source ownership** to the controller after this final report write.
