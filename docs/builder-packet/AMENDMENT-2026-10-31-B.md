# Amendment 2026-10-31-B — Launch Readiness

Owner-approved 2026-10-31. Evidence base: LAUNCH-READINESS-RESEARCH-2026-10-31.md
(delivered with this amendment; per-question findings, sources, and a ranked
Top 10). Where this amendment and the research disagree, this amendment governs.

Sequencing rule for the whole amendment: NOTHING here displaces in-flight work
or the M10e–M10k phase order. Each part names where it lands. Parts 1 and 4 are
small and may run as side PRs; Parts 2 and 6 fold into phases already planned;
Parts 3, 5 and 7 are design-first.

## Part 1 — Tev1 as the local decision provider (Jev seat, local modes)

The ingest gate's screener is a Noul battery answered by a decision provider.
Cloud mode uses the cloud Jev service (when the owner's account exists).
Local-first and local-only modes must NOT send private content to a cloud
service to check whether it is safe. The local seat is filled by **Tev1**
(Together AI, via Ollama):

- Tev1 is served by Ollama at `/v1/systemone`, which follows the TypeSafe Jev
  API, including a native `noul` question type returning P(true). Register it
  behind the existing Jev stub interface as a decision provider; the gate's
  protocol does not change.
- One battery call carries up to 64 questions about the same state — the
  ingest battery runs as a single request.
- Default model: `tev1:4b`. `tev1:0.8b` only where the device's resources
  require it; the device record/health view says which is in use.
- Requires Ollama ≥ 0.35. Below that, the provider reports unavailable in
  plain words; the gate falls back per the rule below.
- LONG CONTENT: Tev1's context is ~2,000 tokens and requests cap at 64 KiB.
  The gate must chunk oversized content and screen EVERY chunk (aggregate by
  worst score per question), never a prefix only. The chunking rule is part
  of the gate's tests.

GATE — the injection eval (this is the point of the part):
- Build an eval set of at least 50 cases run through the ACTUAL ingest
  battery: buried/inline instructions, encoded payloads (base64, unicode
  tricks), fake system/tool messages, exfiltration requests, impersonation,
  multi-chunk payloads (instruction in a later chunk), plus benign controls
  that legitimately resemble instructions (quoted prompts, recipes,
  forwarded how-tos, code samples).
- Measure accuracy AND calibration (reliability bins / ECE) per model size.
- The gate's probability thresholds (pass / quarantine ~0.5 / block) may
  rely on Tev1 only if the eval passes bounds set in the PR (state them;
  suggested: ≥90% detection on attack cases, ≤10% false-positive on benign
  controls, ECE ≤ 0.1 on the battery's noul questions).
- If the eval fails: Tev1 stays ADVISORY (its scores are logged as
  evidence), and the gate's decisions rest on the deterministic layer plus
  quarantine-on-uncertain defaults. That outcome is acceptable and must be
  reported plainly, not tuned around until it passes.
- The deterministic layer (hidden text, SSRF, SPF/DKIM/DMARC, link
  mismatch, attachment scan) and taint tracking are unchanged in all modes.

## Part 2 — First-session value (folds into M10f onboarding)

Research finding (Strong): AI products retain far worse than non-AI
(RevenueCat: 21.1% vs 30.7% annual retention), and the Day-2 killer is an
empty prompt facing empty memory. Home Assistant's counter-pattern is
discovery DURING onboarding plus an auto-populated first screen.

Add to the onboarding flow designed in the M10 orchestration ADR (Point 11):
- DISCOVERY during setup: devices and services on the LAN and on the device
  itself are found and shown as found (with the existing consent rules —
  discovery is not connection).
- IMPORT offer, one step, consent-first: notes/files, calendar, browser
  bookmarks — so memory is not empty on Day 2. Imported content passes the
  ingest gate like any external content.
- A POPULATED first view at the end of setup: what was found, what was
  imported, the device's roles and backend (already designed), and ONE
  suggested first action (intent picker of things Nova is known to do
  well), never a blank chat alone.
- Empty states everywhere follow the pattern: orient, state the value,
  offer exactly one action.
- GATE addition to the fresh-user test: a timed first-win check — a new
  user reaches a first useful outcome in under 15 minutes of setup,
  measured in the test, with the path recorded as evidence.

## Part 3 — A self-update channel for Nova itself (ADR first)

The packet designs updates for Nova's SERVICES (supervisor release slots,
the change pipeline) but not for the Nova PRODUCT on a user's hub. Design
an ADR, then build:

- Signed release artifacts; the hub verifies before staging (same trust
  root as device bundles).
- Pre-update automatic backup (encrypted) taken before ANY update applies;
  setup issues the user a recovery/emergency kit for that encryption key,
  Home-Assistant style. No key in the backup itself (owner decision
  2026-10-31 stands).
- Staged rollout onto the existing release-slot mechanism: new version
  starts in a slot, health-checked, canaried, switched; failed health
  returns to the prior slot automatically.
- A Repairs-style surface in Health after every update: problems found,
  in plain words, with the fix or the rollback offered — never a raw log
  as the primary message.
- Breaking changes are listed in plain words BEFORE the user approves an
  update; update approval tiers follow NOVA-SPEC §6 (a product update is
  tier 3 until the owner configures otherwise).
- Nothing auto-updates silently at launch. Auto-update policy is a
  separate owner decision later.

## Part 4 — The eval harness (golden tasks + model-swap scorecard)

Research finding (Strong, Anthropic's eval guidance): start with 20–50
tasks drawn from REAL failures; keep a regression suite near 100%; grade
outcomes, not vibes.

- A golden task suite in the repo: 20–50 tasks, each with a fixture, the
  expected outcome, and an outcome grader (code first, model grader only
  where code cannot judge). Seeded from real failures already on record:
  the self-knowledge failures (capability questions answered from priors),
  the Screenpipe misdiagnosis, plus the Part 1 injection set as its own
  suite.
- Two suites, kept separate: CAPABILITY (expected <100%, tracks progress)
  and REGRESSION (must stay ~100%; any drop blocks merge like a failing
  test).
- MODEL-SWAP SCORECARD: the suite runs per provider/model. Settings ›
  Models shows each configured model's latest regression pass rate and
  date BEFORE the user switches to it; switching to a model with no
  current scorecard is allowed but says so.
- Every production bug report becomes a task in the suite before its fix
  merges (the fix's PR links the task).

## Part 5 — Hard caps on autonomy cost (design + build, small)

Tiers gate ACTIONS; nothing yet caps cumulative SPEND.

- Per-task ceilings: iterations, tokens, and (where priced) dollars —
  hitting any ceiling stops the task, reports in plain words what was
  spent and why it stopped, and offers resume as a new approval.
- A per-day ceiling across tasks, same behaviour.
- Defaults ship conservative; ceilings are configurable in Settings, and
  the current month-to-date spend (tokens + priced dollars, per provider)
  is visible in Health.
- A loop detector: repeated near-identical tool calls count toward the
  iteration ceiling at an accelerated rate (the documented runaway-loop
  shape), so a stuck loop dies in minutes, not hours.

## Part 6 — Diagnostics bundle + integrity scrubbing (folds into Health)

- ONE-CLICK DIAGNOSTICS: a downloadable bundle (versions, health state,
  recent logs, config) with secrets REDACTED by construction (values
  replaced with a fixed marker, Home Assistant diagnostics pattern;
  canary-secret tests prove no secret pattern survives). The bundle is
  created locally and NEVER sent anywhere by Nova; the user chooses what
  to do with the file.
- INTEGRITY SCRUB: a scheduled job (weekly default) runs SQLite
  integrity_check on Nova's stores and verifies checksums of memory/media
  files; results land in Health as a check with a last-run time; a failure
  raises a Repairs-style item with the restore path — corruption must be
  found by the scrub, not at restore time.
- Disk-health signals already collected per device are surfaced next to
  the scrub result where available.

## Part 7 — Fault matrix + soak (extends the QA harness, Amendment 2026-10-31-A)

The QA harness (Stage 1 complete; Stage 2 per Amendment A) gains a fault
profile, run on a resource-capped instance simulating mini-PC-class
hardware:

- process killed mid-write (power-loss proxy); disk filled during a task;
  model provider unreachable mid-task; hub restarted during a running
  task; clock skewed.
- Each case asserts the DESIGNED behaviour: no corruption (Part 6 scrub
  clean afterwards), tasks resume or fail with a plain-words reason, no
  silent loss.
- A soak run: the harness's core flows repeated against one instance for
  an extended session, watching memory/handle growth; growth beyond a
  stated bound fails the run.

## Part 8 — QA Stage 2 integration with the Service Manager (records the design)

So Stage 2 (Amendment A) is not built supervisor-only:

- The flow catalogue runs through the UI/API surface and stays
  backend-agnostic; the SYSTEM UNDER TEST is provisioned per driver
  profile: supervisor profile at every gate; the K3s profile (simulated
  cluster until the owner approves a real one) at driver-phase gates
  (M10j/M10k) and whenever change-aware mode sees manifest, placement or
  definition changes.
- A harness run report is EVIDENCE in the change pipeline's tests stage,
  alongside a service definition's contract_tests: a promotion that
  touches the console/app surface requires a passing catalogue verdict
  for the target driver, recorded in the Work Ledger entry.
- Device-native workloads are covered deploy-and-probe (install/update
  dry-run, signature check, health probe, one smoke action per device
  class), per the orchestration ADR Point 6 gate — not full flows per
  device.
- First-run verification uses the profile matching the backend chosen in
  onboarding (Part 2 / ADR Point 11).

## What this amendment does NOT do

- No new milestone. Parts land inside M10e–M10k, M9 follow-ups, or side
  PRs as named; anything that cannot fit is reported as a proposed
  milestone, not smuggled in.
- No real cluster, cloud account, or spend (the orchestration ADR's hard
  limits stand).
- No claim in onboarding, docs, or the UI for a capability the eval suite
  (Part 4) cannot demonstrate — the Humane/Rabbit lesson from the
  research: expectation mismatch, not capability, is the launch killer.
