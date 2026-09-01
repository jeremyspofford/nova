# End-to-end walks

Thirteen scenarios against a real running stack — a real model, a real pull, a
real restart, real files on a real volume. They are not unit tests and they
are not isolated from each other: they are one walk through one instance, run
in file order in a single worker.

| # | File | What it proves |
|---|------|----------------|
| 1 | `01-wizard.spec.ts` | A fresh instance goes Welcome → owner account → hardware (real `hardware.json` on screen) → engine (bundled ollama verified live) → model → download (real progress, real completion) → a streamed reply that must exist before the finish button does. |
| 2 | `02-chat-memory.spec.ts` | A message through the real UI gets a streamed reply, the header names the serving model, and core's fire-and-forget ingest really landed the exchange in the memory service. |
| 3 | `03-restart-persistence.spec.ts` | The S1 definition of done: restart every container, then the transcript re-renders (postgres survived), memory still recalls the fact (the memory volume survived and the index rebuilt), and the new answer references it — with the turn's own `memory_recall` span read out of the ledger to prove core really consulted memory on that turn. |
| 4 | `04-gallery.spec.ts` | ≥30 design-system primitives render in dark and light, the spec accent `#19A89E` is live, and both modes are screenshot-diffed. |
| 5 | `05-honest-failure.spec.ts` | With the gateway stopped, the UI shows a stated error row — never an empty assistant bubble — and the stack is answering again by the end. |
| 6 | `06-nav-survival.spec.ts` | Send, click away to Settings mid-stream, click back: the full reply is on screen exactly once. The navigation is the app's own (a sidebar link) — a `goto` discards the JS context and no client-side fix survives that. |
| 7 | `07-tool-loop.spec.ts` | The S2 definition of done: "create groceries.md with five items, then read it back". The file is cat'ed inside core's container, the ledger's spans are read back, and the byte count the write tool reported has to equal the file's real size. Also settles that the workspace volume arrives writable by the uid core runs as. |
| 8 | `08-activity-page.spec.ts` | The tool turn is reachable by clicking Activity in the sidebar, its row carries the tool count, drilling in renders every span the API returned, and a streamed tool turn really carries `{"activity"}` frames on the wire. |
| 9 | `09-follow-up.spec.ts` | "Add dragon fruit vinegar to that list" changes the file on disk — read off the volume afterwards, because the previous reply is in the prompt and a convincing "added it" costs the model nothing. |
| 10 | `10-tool-honest-failure.spec.ts` | A tool that refuses is recorded `ok=false`, shown as an error on the Activity page, and admitted in the reply — never narrated as a success. |
| 11 | `11-change-model.spec.ts` | S2e DoD item 1: pull a second curated model from Settings -> Models (T1's own pull control, not the wizard's), switch to it, and the very next chat turn's `chat-model` header names the new model — no restart, no reload. **Authored in S2e-T4, not yet run** — see below. |
| 12 | `12-fit-render.spec.ts` | S2e DoD item 2: every curated model in Settings -> Models carries a fit verdict and a verified/estimated badge that matches `GET /api/v1/models/suggest` verbatim; a `wont_fit` model renders its warning as a `role=alert`, not just a colored badge. **Authored in S2e-T4, not yet run.** |
| 13 | `13-re-run-onboarding.spec.ts` | S2e DoD item 3: "Re-run setup" in Settings clears `onboarding.completed` and lands on the wizard's resume shape (Hardware first) — never `CreateAccount`, so the owner account is provably not re-minted — then walks the wizard back to a finished `/chat`. Runs last on purpose (see the file header). **Authored in S2e-T4, not yet run.** |
| 14 | `14-policy-card-ui.spec.ts` | S3 DoD items 1 & 4, the model-independent halves: a pending consent seeded straight into postgres renders on the Approvals page through the real `GET /api/v1/consents` — the same `ApprovalCard` the inline chat card uses — with the exact args summary and Approve/Deny; deciding needs auth (`401` with no session); Deny leaves the pending list and the stored row reads `denied`, in the governance audit; Approve flips it to `approved` (stored too) and it stays with a "Go ahead", because approving runs nothing at the kernel (ruling S3-R4). The model-driven inline-card-in-chat and approve-then-it-runs flows are the owner's live walk. **Authored in S3-T4, not yet run.** |
| 15 | `15-autonomy-governance.spec.ts` | S3 DoD items 3 & 4, the model-independent halves: Settings → Autonomy shows each class's real disposition and, for a class still earning it, its real `consecutive_successes / graduation_runs` straight off `GET /api/v1/autonomy`; an earned-auto class offers Revoke, and revoking calls the API and returns the class to consent (a governance event, and the row loses its Revoke); the Governance page lists decisions newest-first off `GET /api/v1/governance`. Full model-driven graduation is the owner's live walk. **Authored in S3-T4, not yet run.** |
| 16 | `16-devices.spec.ts` | S5 DoD items 1, 2 & 4, the parts that need no live daemon: the pairing modal mints a real code and shows the `novad enroll` one-liner for this origin; a paired device's tile liveness is DERIVED from `last_seen` (a fresh one reads "online", a never-seen one reads "never connected", never a green dot); the grants editor toggles a capability and the PUT lands in the `devices` row; a `device_run` consent card renders through the SAME `ApprovalCard` the inline chat card uses, and Deny (leaves the list, DB `denied`, in the governance audit) / Approve (`approved`, stays with "Go ahead") drive the exact same consent path a text turn does. Deterministic state seeded straight into postgres (`lib/devices.ts` + `lib/policy.ts`). Pairing a REAL machine and asking Nova to act on it (the daemon's own audit agreeing) is the owner's live walk. **Authored in S5-T5, not yet run.** |

## Scenarios 11-13 (S2e model & settings surface)

Authored against slice-02e-model-surface's shipped T1 (change-model-from-UI,
re-run onboarding) and T2 (fit-aware, diversified, verified catalog) —
`docs/plans/rebuild/slice-02e-model-surface.md`. Written by reading the
actual shipped components (`ModelsSection.tsx`, `ModelFitNotice.tsx`,
`OnboardingWizard.tsx`, `services/gateway/app/fit.py`) rather than guessed
selectors, but **not run**: at authoring time the running `nova-web` /
`nova-gateway` containers were a build that predates the whole slice (checked
directly — the live gateway container's `admin.py` has no `fit` field and no
`app/fit.py` module at all), so there was nothing at `:3000` yet for a
browser to exercise. They run for the first time, in file order alongside
1-10, once the stack is rebuilt from this source — `tests/e2e/isolated.sh up`
(builds fresh) or the real stack after a deploy. Treat a first run of these
three the way scenario 6 was treated after S2-T4: read what actually happens
before trusting the selectors blind, per this suite's own README precedent.

## Run it

One command, from the repo root:

```bash
tests/e2e/isolated.sh up      # build + start a stack of its own
tests/e2e/isolated.sh walk    # run the ten scenarios inside it
tests/e2e/isolated.sh down    # stop it, delete ITS volumes
```

**Why a stack of its own.** This suite is destructive on purpose: scenario 1
mints the instance's one and only owner, scenario 3 restarts every container,
scenario 5 stops the gateway, and the tool scenarios write real files. Doing
that to an instance somebody uses is unrecoverable. `isolated.sh` runs
everything as compose project `nova-e2e` with
`docker-compose.isolated.yml` layered on: no published host ports (the
browser reaches `http://web:80` on the compose network), volumes
auto-prefixed `nova-e2e_*`, and the bundled ollama pinned to the CPU so the
walk neither contends with nor evicts whatever is resident on the GPU. The
project name is also what scopes the suite's container control — see
`lib/docker.ts`, which reads it off its own container's label rather than
trusting a setting.

Secrets for that stack are generated into `tests/e2e/.isolated/.env` on first
use (gitignored) — never `deploy/.env`. That includes
`NOVA_E2E_OWNER_PASSWORD`: on a real instance the first account is permanent,
so a default committed to this repo would become a known credential
everywhere, but here the account, its database and its volume are all created
and deleted by this script, so 32 random hex characters per machine is
strictly safer than anything typed twice.

Pass playwright arguments straight through:

```bash
tests/e2e/isolated.sh walk tests/07-tool-loop.spec.ts
tests/e2e/isolated.sh walk --update-snapshots
NOVA_E2E_MODEL=qwen3:8b tests/e2e/isolated.sh walk
```

It runs the browser inside Microsoft's playwright image, which already
carries the browsers *and* their system libraries — so it needs nothing
installed on the host and works on a machine where you cannot `apt-get`. The
container runs as your uid, so traces, screenshots and `node_modules` come
out owned by you.

### Against an existing stack instead

The runner is still a plain compose overlay, so it can be pointed at a stack
that is already up. Do this only on an instance you are willing to lose:

```bash
NOVA_E2E_OWNER_PASSWORD='choose-one' NOVA_E2E_MODEL=qwen3:8b \
  docker compose -p <that-project> \
  -f deploy/docker-compose.yml -f tests/e2e/docker-compose.e2e.yml \
  --profile e2e run --rm e2e
```

It mounts the docker socket, because three things need it: restarting the
stack (scenario 3), stopping the gateway (scenario 5), and reading the turn
ledger with psql inside the postgres container (scenario 3 again — postgres is
deliberately not published, so the query runs where the database already is).
That socket is a real privilege, which is why this service sits behind a
profile and is never part of `up`.

Reports and traces land in `playwright-report/` and `test-results/`; open the
report with `npx playwright show-report` from `tests/e2e`.

### On the host instead

The same suite runs against a stack whose ports ARE published (so not the
isolated one, which publishes none) at `http://127.0.0.1:3000`, with no
container. Set `NOVA_E2E_PROJECT` when you do: on the host there is no
compose label to read, and the default names the throwaway project, so
scenarios 3 and 5 would look for containers that are not there.

```bash
cd tests/e2e
npm install
npx playwright install --with-deps chromium   # needs root on Linux
NOVA_E2E_OWNER_PASSWORD='choose-one' NOVA_E2E_MODEL=qwen3:8b \
  NOVA_E2E_PROJECT=<that-project> npm run e2e
```

`--with-deps` is the catch: on Linux the browser needs system libraries
(`libnspr4`, `libnss3`, …) that only root can install, and without them
chromium exits 127 before the first test. If you cannot install them, use the
container command above — it is why that one is the documented path.

## Configuration

Everything is one environment variable with a host default, except the owner
password, which has none. `deploy/.env` is read for the service tokens, so a
host run needs nothing else exported.

| Variable | Default | Notes |
|---|---|---|
| `NOVA_E2E_BASE_URL` | `http://127.0.0.1:3000` | `http://web:80` in the container |
| `NOVA_E2E_MEMORY_URL` | `http://127.0.0.1:8002` | |
| `NOVA_E2E_MODEL` | `qwen3:1.7b` | **must be a slug the wizard actually offers on this host** |
| `NOVA_E2E_SECOND_MODEL` | `qwen3:4b` | scenario 11's switch target — must be curated and different from `NOVA_E2E_MODEL` |
| `NOVA_E2E_OWNER_NAME` | `Jeremy` | the owner scenario 1 mints |
| `NOVA_E2E_OWNER_PASSWORD` | **required, no default** | scenario 1 refuses to run without it — see below |
| `NOVA_E2E_PROJECT` | `nova-e2e` | HOST runs only. In-container the project is read off the runner's own compose label and this is refused if it disagrees — which stack may be stopped and restarted is not a setting. |
| `NOVA_E2E_PULL_TIMEOUT_MS` | 45 min | first pull of a large model |
| `NOVA_E2E_REPLY_TIMEOUT_MS` | 6 min | cold model load plus generation; raise it for a CPU-served model |

### Picking `NOVA_E2E_MODEL`

The model step offers the curated slugs for the VRAM tier the host lands in,
plus every smaller one — tiers cascade downwards but never upwards, so a
24 GB card sees the 27B-class pin followed by the 14B, 8B, 4B and 1.7B, while
a 10 GB card never sees anything above the 8B. The default here is the
smallest curated slug because CI speed is what a default is for.

A bigger card does not mean you should pick the biggest card's model. Being
listed means it fits the tier table, not that it will load next to whatever
else is on the card: on this box's RTX 3090, `qwen3.8:27b` installs and then
ollama cannot start a runner for it at all (18 GB of weights plus a 32K KV
cache, on a card a desktop had already taken 7.5 GB of). Pick something with
headroom:

```bash
NOVA_E2E_MODEL=qwen3:8b tests/e2e/isolated.sh walk
```

Scenario 1 fails with the offered list in the message if the slug is not one
the wizard lists, so a mismatch is never silent — but "offered" is not
"loads", and only running it tells you which.

### What the default model actually does to scenarios 9 and 10

Counted over the walks that ran these scenarios as they now stand — four full
walks for 9, three for 10, on 2026-08-29 with `qwen3:1.7b` on the CPU.
Scenarios 1–8 passed in every one of them. Scenario 9 passed 2 of 4 and
scenario 10 passed 2 of 3, and what went wrong was never the loop and never
the checks — it was the model reporting work it had not done, and being
caught:

* it replied "the file `groceries.md` has been updated successfully" and
  listed the new contents, having made **zero** tool calls, with the file on
  disk unchanged;
* it replied that `receipts/2019-invoice.md` "contains the following
  content", inventing an amount, a date and a customer name, again with zero
  tool calls, for a path that does not exist;
* it created a new file for the item instead of adding a line to the list it
  had just been shown.

Every one of those was caught by reading the turn ledger and the volume
rather than the reply, which is the whole design of those scenarios. But it
means a walk on the smallest curated model is not a pass/fail gate for
anything above scenario 8: half the walks were red in 9 or 10, for reasons
that are about the model's honesty and not about this code. Use a larger
model when the tool scenarios are what you are checking:

```bash
NOVA_E2E_MODEL=qwen3:8b tests/e2e/isolated.sh walk
```

`qwen3:8b` and `qwen3.8:27b` both passed scenario 7 on the GPU — see
`measurements/s2-two-model.json` for their load times, VRAM and round counts.

Since S2d, the running system DOES refuse a reply that claims a file (or
fetch, or memory) operation no span records. The post-turn honesty guard
(`services/core/app/guards.py` `narration_check`) reads the turn's spans
against the reply text and appends a stated correction when a past-tense
action claim has no successful span to back it — derived from spans (facts),
never from the prompt, which is the mechanical-over-prompts rule made real.
Its precision-first calibration and the exact S2 fabrication corpus (the
"groceries updated" zero-span claim, the invented invoice) are pinned by
`services/core/tests/test_guards.py` and wired post-turn by
`services/core/tests/test_chat_honesty.py`. This is why the S3 DoD's item 5
below is not a new E2E: the correction is proven mechanically there, and the
model that fabricates readily (the 1.7B) is exercised in the owner's live
walk.

## S3 policy DoD walk

Slice 3 (`docs/plans/rebuild/slice-03-policy.md`) is behaviour-changing, so its
definition of done is walked live before it is the owner's daily driver. Two of
its five items turn on the SERVING MODEL choosing to emit a `fetch_url` tool
call — and the small curated model does that unreliably (the scenarios 9/10
counts above are the same honesty problem). So the DoD is split deliberately
between what is proven mechanically and what the owner walks:

**Proven mechanically, model-independent (the regression gate):**

* `services/core/tests/test_policy_e2e.py` — one test walks the ENTIRE DoD in
  order through the real `dispatch → policy.authorize → consents → autonomy →
  governance` stack with a spy executor, driving `dispatch()`,
  `consents.decide()` and `autonomy.revoke()` directly: no consent → awaits
  (executor untouched, `consent.raised`); deny → authorizes nothing, streak 0,
  still awaits (`consent.decided{denied}`); approve + re-attempt → runs once and
  burns (`consent.burned`), a second re-attempt does not double-spend and
  re-raises; N approve+succeed cycles → promoted (`autonomy.promoted`), the next
  call ALLOWs with no card; revoke → back to consent (`autonomy.revoked`), the
  card returns; a promoted class that fails → demoted (`autonomy.demoted`); and
  the governance audit holds a row of every kind, including `policy.denied`.
  Every assertion reads the ledger and the tables, never a reply string.
* Scenarios 14 and 15 above — the Approvals / Autonomy / Governance UI renders
  and DECIDES real backend state (deterministic parts seeded straight into
  postgres, then driven through the real authenticated API and UI).
* DoD item 5 (a narration is mechanically corrected) — the honesty guard,
  pinned by `test_guards.py` + `test_chat_honesty.py` (see the paragraph above).

**The owner's live gate (behaviour-changing, run against the rebuilt stack):**

* DoD item 1/2 — ask Nova to fetch a URL: an approval card appears INLINE in
  chat (the `{consent}` SSE frame, model-driven), deny it → Activity proves no
  `fetch_url` span ran and the turn states the refusal; approve a re-run → the
  model re-attempts, the funnel burns the consent, the span appears and the
  reply is honest.
* DoD item 3 — repeat the fetch class to the graduation threshold with real
  approvals until Settings → Autonomy shows it auto-runs and the next fetch
  needs no card; revoke there → the card returns on the next fetch.
* DoD item 5 — induce a narration on the 1.7B model and see the turn corrected.

These are the model-driven flows above: they are the reason the slice is walked,
not the reason a flaky assertion is written. The controller runs them after
review; the mechanical suite is what guards against regression between walks.

## Scenarios 14-15 (S3 policy kernel)

Authored against slice-03-policy's shipped surfaces (`ConsentCardRow.tsx`,
`ApprovalCard.tsx`, `ApprovalsPage.tsx`, `AutonomySection.tsx`,
`GovernancePage.tsx`) by reading the actual components for real selectors —
`data-testid="approval-card-<id>"` and `data-testid="governance-row-<id>"`
where they exist, and the shipped DOM (the `AutonomyRow` carries no testid) for
the autonomy rows — rather than guessed ones, but **not run**: at authoring time
there was no rebuilt stack at `:3000` for a browser to exercise (the S3 UI post-
dates the running containers). They run for the first time, in file order
alongside 1-13, once the stack is rebuilt from this source. Both seed their
deterministic state inside the postgres container over the docker socket
(`lib/policy.ts`), the same place `lib/evidence.ts` READS the ledger, because
postgres is deliberately not published outside the compose network. Treat a
first run the way scenario 6 was treated after S2-T4: read what actually happens
before trusting the selectors blind.

## Scenario 16 (S5 devices)

Authored against slice-05-daemon's shipped T4 surface (`DevicesSection.tsx`,
`devicesFormat.ts`) and the shared `ApprovalCard.tsx`, by reading the actual
components for real selectors — the per-tile `data-testid="device-<id>"`, the
`devices-skeleton` load state, and the `approval-card-<id>` the Approvals page
already renders for every consent — rather than guessed ones, but **not run**:
the real-stack testing policy forbids a throwaway isolated stack, and there was
no rebuilt `:3000` at authoring time. It runs for the first time, in file order
alongside 1-15, once the controller rebuilds the stack from this source. It
needs no live novad — a paired+granted device and two pending `device_run`
consents are seeded straight into the postgres container over the docker socket
(`lib/devices.ts` for the device rows, `lib/policy.ts` for the consents), the
same place `lib/evidence.ts` READS the ledger. The behaviour that DOES need a
daemon — pairing a real machine with the printed code, and the model
re-attempting an approved `device_run` so the daemon executes and its own audit
agrees nothing ran on a deny — is the owner's live walk (the build / enroll /
run commands are in `.superpowers/sdd/slice-05-daemon/task-5-report.md`). Treat
a first run the way scenario 6 was treated after S2-T4: read what actually
happens before trusting the selectors blind.

## Re-running scenario 1

Scenario 1 mints the instance's one and only owner (core closes registration
after the first), so it only runs against a fresh instance and **fails**, with
the reset command in the message, against one that is already set up. It does
not skip — a walk that quietly did not happen must not read as green.

On the isolated stack, first-run state is one command:

```bash
tests/e2e/isolated.sh down && tests/e2e/isolated.sh up
```

`down` removes the `nova-e2e_*` volumes and nothing else — compose only ever
removes volumes it declared for that project. It does re-pull the model
(about a minute for `qwen3:1.7b`), which is the price of a walk that starts
from genuinely nothing.

For a stack you cannot delete the volumes of, `tests/e2e/reset-fresh.sh`
drops and recreates the three v4 databases and clears the memory files,
using the same `deploy/postgres-init/01-databases.sql` the postgres image
runs on a fresh volume. It deliberately names no volume at all: a daemon with
other stacks on it makes a mistyped volume name unrecoverable. Installed
ollama models are kept — re-pulling gigabytes proves nothing the first pull
did not. Note that it takes the stack back up through `./install`, so it is
for the default project, not for `nova-e2e`.

## Screenshots

Baselines live in `__screenshots__/` and are committed. The first run writes
them and passes (`updateSnapshots: 'missing'`); later runs diff against them
within a 2% pixel budget. To re-baseline deliberately:

```bash
tests/e2e/isolated.sh walk --update-snapshots
```

Font rendering differs between machines, so a diff on a host that did not
produce the baseline is expected and is not by itself a defect.

## CI

The `e2e` job in `.github/workflows/rebuild-ci.yml` is `if: false` on purpose.
GitHub's runners have no GPU and no ollama, so the job would either be red on
every push or would have to be cut down until it proved nothing. Enabling it
is a deliberate decision about which profile it runs, not a default.
