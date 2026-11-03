# Health backend activation — 2026-11-03

This change activates already-reviewed backend code without new Health UI. Core owns one Caps
instance; the production runner uses that same instance. Profile timezone, the Core clock,
conservative defaults, existing task/day ceilings and tier-2 resume approval are preserved.
Personal conversations are metered without autonomous caps. `GET /api/v1/caps` and
`PUT /api/v1/caps/limits` use the existing person-access and mutation guards.

`GET /api/v1/diagnostics` reuses the existing person-only route and builder: native JSON
attachment, `no-store`, constructed in memory for each request, never retained as a bundle.
The request-time Era 2 callback returns numeric chat-log, schedule and skill counts.
Chat-log counting uses directory entries only; no transcript, title or kind is read. Empty and
malformed valid logs count; symlinks, directories and invalid names do not. Schedule and skill
counts use their existing views. The scrubber and existing canary assertions are unchanged.

## Provenance

Clean integration base: `0134b074b3c97ed67c4d5765a1ba788be1205145` (controller plan atop
main `ab902518`). Branch: `codex/health-backend-wiring`. The two exact reviewed commits from
#285 were cherry-picked in order with `-x`, without conflict or a missing UI dependency:

| Original | Integration commit | Purpose |
| --- | --- | --- |
| `68b09020730e91d08b89b268abb745c52d66764e` | `eddb30b8` | Production Caps ownership, runner and guarded APIs |
| `19989f5d1921a29c5e41b398dc02e19ecbb189fd` | `254d75ab` | Production diagnostics and directory-only counts |

At the initial integration254d75ab and docs-onlyf9ffbb0c, all eleven cherry-picked files,
including eight runtime/test files, matched reviewed #285 head1572f294 exactly. That equality
is historical: the reviewed security repair4e7278d1 intentionally changes five picked files
and the diagnostics builder; qualification1fa3042c changes one existing test fixture. Exact
current mappings and reviews are linked below. No mirror test was added to the original picks. Package/lock, UI, router/crawl gates, the
controller plan, provider accounting and main's #284 isolation/ledger code remain unchanged.
The two current inventory rows correct stale “inert/unwired” backend descriptions while
retaining app “Not shipped” status, pending Health UI approval/crawl and accounting/privacy
limits. Historical #282 crawl evidence and O14/O15 remain unchanged; no C18/O14 or C19/O15
app-shipped promotion is claimed.

Original reports/reviews and every Task 2/3 raw evidence file remain intact in the original
Health checkout. A byte-verified 45-file snapshot (144,285 bytes) is also retained in the ignored
local audit directory below; the historical Task 3 report is carried unchanged by its source
commit. These are historical results, not new integration runs:

- Caps RED and final-fixture isolated RED: 1 pass / 5 fail (real API 404 and missing Core Caps;
  null negative control passed). Preserved failed corrections: vault-field expectation,
  loopback mesh URL and header-union typecheck. Focused GREEN 13/13; final isolated affected
  GREEN 89/89; compiler passed. Earlier launcher/isolation limits and the retrospective
  invocation transcription remain explicit in the original report/review.
- Diagnostics RED: 0/2, missing count method and actual API 404. Preserved failed corrections:
  intentional scrubbing of the former `session_logs` field, header-union typecheck and lazy
  vault-key assertion timing. Focused GREEN 2/2; existing affected 109/109 and final affected
  111/111; compiler passed. Numeric `chat_logs` was the reviewed resolution; no scrubber
  exception or assertion weakening was added.
- Both backend reviews approved. Task 3's optional Minor M1 remains recorded: its historical
  compiler emitted an npm available-update notice. Future notifier suppression does not
  erase that output or turn it into a source defect.

## Fresh integration verification

The dedicated launcher was saved before execution, derived from the Vault Task 4 fix1 safe
launcher. Cached `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never`, `--network=none`,
uid 1000, read-only filesystem/code/Node 26.3.1, private tmpfs HOME and explicit file-vault mode
were used. Matching installed dependencies were bound read-only from the original Health
checkout into `/workspace/node_modules`; no package install or image pull occurred. The host
launcher environment contains only PATH, private HOME and LANG. Container overrides are
HOME, PATH, TZ, LANG, NOVA_VAULT_KEY and NPM_CONFIG_UPDATE_NOTIFIER=false. Complete argv,
cwd, timestamps, environments, statuses and separate stdout/stderr are retained locally.

| Run | Result |
| --- | --- |
| Runtime smoke, through the tripwire | Exit 0; Node v26.3.1 |
| Caps acceptance/API/composition/ceilings, diagnostics composition/redaction, Core API | Exit 1; 29/30 pass; no skips/cancellations. Only diagnostics build identity failed: null instead of a Git hash. |
| Compiler, `npm run typecheck`, through the tripwire | Exit 0; no compiler errors; ordinary npm invocation notices only |
| Git-boundary probe | Exit 128; the worktree's external host Git directory is absent inside the container |
| Read-only minimal Git identity probe | Exit 0; actual tested head `254d75a` |
| Diagnostics composition file only after harness correction | Exit 0; 2/2 pass; no skips/cancellations |

The original passing checks were not broadly repeated. The failed diagnostics assertion is
unchanged. The corrected harness overlays only `/workspace/.git` with a read-only pointer to
own local evidence containing the actual tested detached HEAD and its SHA-1-validated commit
object, empty refs and minimal local config. No shared Git directory, credential helper,
owner HOME or inherited Git environment is mounted. Both launcher versions and the failed
attempt are retained. Every smoke, test, compiler and probe run reported the tripwire never
fired. Exact source comparisons and `git diff --check` pass.

Local audit root:
[`.superpowers/sdd/health-backend-wiring-2026-11-03`](../../.superpowers/sdd/health-backend-wiring-2026-11-03/).
The [full task report](../../.superpowers/sdd/health-backend-wiring-2026-11-03/task-1-report.md)
records exact commands, outputs and scope. Under `evidence/task-1/`, `source-blobs.json` records
all exact blob IDs; `original-health-manifest.json` records original paths and SHA-256 hashes;
`original-health/` holds the unchanged reports, reviews, original launchers and RED/GREEN
history. These local ignored artifacts are not hosted CI evidence.

## Limits and remaining gates

Accounting scope is `this-node-runner`, `provider_reports_included:false`. Provider-managed
reports already held separately by Models are excluded from Caps day/month totals and live
caps; other-node spend is excluded too. Estimated and unpriced usage stays labeled. Durable
provider-report reconciliation is a Track 1 follow-up; this change creates no second store.

Diagnostics preserves documented hostname/IP/model/runtime metadata and can retain arbitrary
personal words in included log/problem messages or configured names when they are neither
known secrets nor secret-shaped. Named canary boundaries do not guarantee universal removal
of personal free text. Only synthetic data/runtime/hardware/private homes were used here;
no real owner data, keychain, service, model, provider, cloud, device, account or preview action
was performed.

Rendered-entry approval, Health controls, browser save/download interactions and the Home
phone/rail crawl remain in #285. W1/W2 are not completed by this backend change. App-shipped
inventory flags remain unchanged. Whole-branch review and the scoped repairs are complete as recorded below. Ordinary
exact-head all-required CI, matching-head merge/tree checks and authorized preview proof
remain required and are recorded on the PR before completion is reported.

## Current reviewed fixes and qualification

Whole-branch review found a real diagnostics disclosure: if a populated vault could not be read,
the mounted endpoint returned200 with an encoded known credential and a warning. The single
reviewed production fix4e7278d1 requires a complete known-secret scan before included metadata
is read; scan failure returns fixed non-sensitive503/no-store/no attachment. Empty/readable
vaults remain valid, and redaction matching/encodings are unchanged. It also removes phantom
Health limits copy without changing ceilings/resume. Real key-loss and incomplete-source REDs
failed0/10, copyRED0/1; final focused28/28 and compiler passed. I1/M1 were independently closed.

The stricter contract exposed an existing token/epoch test using /nonexistent as its home. Root
adjudicated a smallest test-only qualification change1fa3042c: use its existing private paired
Core/home inside try/finally; every original token/environment/summary/epoch assertion remains.
Named RED1failed, GREEN1passed, compiler passed, all239src entries unchanged. Fresh independent
qualification review approved R1 with0Critical/Important/Minor. No second production fix wave
or weakened fail-closed behavior was used.

[Complete reports, reviews and new raw evidence](health-backend-wiring-2026-11-03/README.md)
and [all current artifact hashes](health-backend-wiring-2026-11-03/manifest.json). Historical
current-equality language above is pinned to the initial integration; the fix report lists every
intentional changed blob. No app controls, rendered approval or new crawl success is inferred.

## Rulings I made, with costs

Ruling: separate reviewed backend W1/W2 from owner-gated285 controls, because activating automatic caps and guarded existing APIs needs no new visual entry; do not infer rendered approval. Cost if wrong: one additional PR/CI and later patch deduplication; Health UI/crawl remains incomplete,285 preserved. Existing accounting/privacy limitations and all tests/reviews retained.

Ruling: refine Task1 inventory-edit condition to correct stale current backend status as well as false UI implications; C18/C19 must no longer call the active caps inert or mounted diagnostics unwired. Why: owner requires truthful capability claims as wiring lands, while original plan wording was too narrow. Cost if wrong: readers may confuse backend activation with completed UI; preserve explicit app-Not-shipped flags, pending285 controls/crawl, and untouched historical282 evidence. This records the immediately preceding concrete correction request; no code/test/approval gate is changed.

Ruling: extend backend exact-copy scope only for finalreviewI1 required known-secret enumeration failure refusal + tests/docs, and fix M1 phantom Health availability copy in same wave. Why: newly exposing old builder fail-open produces real credential disclosure, and backend-only release must not point to absent controls. Cost if wrong: backend source now deliberately diverges from reviewed1572 at enumerated fix files; retain original blob proof at its historical pin, fresh regression/review/CI required, no UI gate waiver or scrubber weakening.

Ruling: finalfix required-secret-source failures include list/get/incomplete enumerated Vault entries, existing keyForStandby read failure, unreadable non-ENOENT optional-key-file inspection, and unreadable/incomplete existing mesh secret identity. Confirmed absent optional sources and genuinely empty Vault stay valid; ordinary non-secret probe failures remain warnings. Why: required redaction seeds must be complete before serializing shareable metadata, not merely the one demonstrated path. Cost if wrong: diagnostics returns fixed safe503 until credential/key/identity recovery even when no canary is currently present; validate only actual secret-source contracts/current writer formats, not arbitrary nonsensitive metadata, no new raw APIs or matching-layer changes.

Ruling: R1 is real and load-bearing for ordinary qualification, so carry the smallest test-only fixture alignment into qualification Task2. Use the existing private paired Core p.a.core/p.a.home inside its try/finally instead of the direct stub with /nonexistent; retain every agent-env/token/summarize/epoch ceiling assertion. Why: stricter required identity scan is correct, but old helper-only fixture is no longer a valid Core home and now prevents original security assertions running. Cost if wrong: fixture initializes its existing real private Core earlier; no production relaxation/skip/assertion deletion, no second production fix wave, fresh named-case RED/GREEN and scoped test review required before CI/merge. Source4e must remain byte-identical outside that test.
