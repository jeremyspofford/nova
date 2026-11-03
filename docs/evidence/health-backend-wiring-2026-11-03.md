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

All eleven cherry-picked files, including all eight runtime/test files, have exactly the same
Git blobs as reviewed #285 head `1572f294d319791bfaa73ccf224335eb06eb1bbc`. No integration
source adjustment or new mirror test was needed. Package/lock, UI, router/crawl gates, the
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
inventory flags remain unchanged. Root still owns fresh whole-branch review, ordinary
exact-head all-required CI, matching-head merge/tree checks and authorized preview proof.
