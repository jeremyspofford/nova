# Evidence index and interpretation

Read [REPORT.md](REPORT.md) first, then [BACKLOG.md](BACKLOG.md), [COVERAGE.csv](COVERAGE.csv) and [KNOWLEDGE-PLAN.md](KNOWLEDGE-PLAN.md). [BACKLOG.csv](BACKLOG.csv) is the sortable triage index; the Markdown backlog contains the full acceptance/reproduction records. [REQUEST.txt](REQUEST.txt) preserves the audit-only scope. [BASELINE.md](BASELINE.md) records the source/runtime boundary. `evidence/MANIFEST.json` contains file sizes and SHA256 checksums for this package, excluding itself.

All evidence is tied to frozen merged source `d948aa0a442a9f930b86f4516eeea21981b76714`. The source may be examined in the parent worktree; source paths/line numbers in findings refer to that commit, not future main. No source finding is labeled deployed because the owner host was inaccessible.

## Consequential reproductions

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| [privacy-mode-race.json](evidence/privacy-mode-race.json), `diagnostics/privacy-mode-race.mjs` | Live policy tightened to local-only, then a synthetic cloud-class fallback received the canary; starting-local-only control made zero remote-route requests | A real cloud account was not contacted; no owner data was disclosed |
| [data-forget-probe.log](evidence/data-forget-probe.log), `diagnostics/data-forget-probe.mjs` | Corrected fact's older day-note wording remains searchable; directly forgotten note reappears from an existing fixture backup | It does not imply every core memory deletion path fails; unrelated recovery tests passed |
| [data-capture-forget-probe.log](evidence/data-capture-forget-probe.log) | Global completion wording ignores an owed backup deletion; actual cleanup succeeds when the fixture folder returns | Not a failure of eventual owed-backup cleanup |
| [data-recall-probe.log](evidence/data-recall-probe.log) | Promoted capture enters actor context without additional recall screen; removed note remains in subsequent prompt snapshot | No malicious model behavior or real cloud disclosure was tested |
| [privacy-context-disclosure.json](evidence/privacy-context-disclosure.json) | A synthetic cloud-class actor receives a private-file canary in its context | File residence on local disk is not proof of local processing; this is not a claim of unauthorized real disclosure |
| [product-memory-browser.json](evidence/product-memory-browser.json), [image](evidence/product-memory-race.png) | Older controlled GET response visibly overwrites newer Memory state in the real UI | Not proof of backend resurrection; the regression test should add an actual synthetic forget |
| [product-workflows.json](evidence/product-workflows.json) | Actual browser Keep/Drop/edit/forget/Undo, settings, schedule, theme and device-model journeys; incorrect imported-source attribution after Keep | Schedule enable/pause is not a run/content-quality test; no model installation or real device pairing |
| [visual-mark-fallback.json](evidence/visual-mark-fallback.json), [image](evidence/visual-mark-fallback.png) | Idle/thinking are pixel-identical in forced Canvas2D/reduced-motion rendering | Different hashes for other states are not a perceptual accessibility certification |
| [product-probes.json](evidence/product-probes.json) | Current pipeline generation misclassifies named design records; wrong import-path constant; independent Memory loader race | Does not establish every milestone's gate is falsely reported |
| [graph-schema.json](evidence/graph-schema.json) | All 27 SQLite migrations run; no generic graph tables | Relational provenance is present; no claim that SQLite is unsuitable |

## Browser evidence

- `ui-sweep.json` and `screens/desktop-*`, `phone-*`, `cover-*`: initial route rendering, body text, geometry, tagged axe results and screenshots. Only the 51 non-`?cat=` rows count toward the route sweep.
- `ui-settings-sweep.json`:39 valid hash-category visits. The earlier query-string category attempts are retained for transparency and are **not** category coverage.
- `ui-supplement.json`: Nebula light phone samples, the `/schedules` alias and root styleguide.
- `setup-workflow.json`, `setup-initial.json`, `setup-finish.png`: real rendered first-run interaction, invalid timezone, reload, verified welcome task.
- `ui-workflows.json`, `workflow-*.png`: separate fixture's synthetic chat/memory and failure recovery, long draft persistence, deterministic task creation/evidence, invalid target, Back and keyboard palette.
- `ui-workflows-initial-harness.json`: earlier harness iteration. Its malformed task body was correctly rejected; a selector/wait error was fixed in the diagnostic, not in product code. Do not count these as app defects.
- `product-workflow-*.png` and `product-workflows.json`: browser actions in another isolated home. The raw hidden-selector timeout is explicitly annotated and resolved; provenance mislabel is a distinct confirmed app issue.
- `ui-performance.json`: twelve timed fresh-context local samples with exact conditions. Screenshot wait durations are not performance data.
- `qa-ui/navigation/`: actual Home-start click/tap crawler,14/14 registered views, phone and rail reports. `qa-ui-check.log` includes Settings, offline/recovery and fold results.
- `qa-m9-shots/`: audit-generated hinge/text-zoom shots copied away from tracked paths. `qa-m9-screenshot-restoration.json` records restoration of only those generated baseline files.
- `qa-prose-width.json`, `qa-prose-width-default.json`, `qa-prose-840.png`: optional-pane narrow-tablet measurement, separately bounded as NOVA-046.

Screenshots establish appearance. Use their associated JSON, API read-backs or test assertions for behavior. Viewports are browser emulation, not physical devices. Reduced motion was used for the principal appearance sweep; motion/no-WebGL controls are identified separately.

## Existing checks and remote records

| Record | Result |
|---|---|
| `qa-check-summary.json`, `qa-check.log` | Local check exit 1:2,214 pass,40 fail,15 skip; one stalled owned fixture interrupted. Full qualification in QA contribution. |
| `qa-ui-summary.json`, `qa-ui-check.log` | Focused Chromium8 pass / 1 fail; narrow optional-pane prose measure is the failing assertion. |
| `privacy-targeted-tests.log` |87 existing synthetic privacy/security tests passed. |
| `data-existing-tests.log`, `data-ledger-screen-tests.log` |139 existing data/capture/backup/verification tests passed in two targeted sets; filenames in the data contribution are authoritative. |
| `qa-ci-runs.json`, `qa-ci-jobs.json` | Retrieved successful exact-baseline GitHub CI; not a local rerun. |
| `qa-ci-accessibility.log` |23 nodes flagged in the advisory report while required CI passed. |
| `qa-docker-environment.json`, `qa-docker-readiness.json` | Rootless cgroup/process-list capability mismatch; execution refuses safely, readiness preflight incomplete. |
| `qa-extra-checks.json`, `qa-install-summary.json`, `qa-npm-audit.json` | Generated docs/pointers, syntax, isolated dependency install and current advisory query. |
| `runtime-version.json`, `runtime-health.json` | Audit instance source commit and Health; owner host is not represented. |
| `pr207-*` | Read-only PR metadata/selected source patches. Open draft design reference; no mutation. |

Raw evidence uses UTC timestamps. User-facing assessment date uses America/New_York. Synthetic names, content and paths are fixtures; no real owner home or backup was used. Temporary runtime homes and generated credentials are deliberately excluded from the deliverable.

## Reproduction boundary

Diagnostic scripts live in `diagnostics/` and import the parent repository at the pinned source. Most use existing temporary-home/loopback fixtures and need Node26 plus installed dependencies. Browser scripts need `/usr/bin/chromium` or their documented path; some exploratory scripts assume this audit's CDP/port4418 instance, which is stopped at completion. Read each script's header and BASELINE before reusing it. Do not point them at a shared preview home.

Do not execute the repository's parked real research/model evals, use real credentials, or ingest the restricted threat model to reproduce these findings. The source's ordinary tests contain opt-in real-call cases; keep all such flags unset. Implementation belongs to the builder after review consolidation.
