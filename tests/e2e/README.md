# End-to-end walks

Ten scenarios against a real running stack — a real model, a real pull, a
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
| 9 | `09-follow-up.spec.ts` | "Add oat milk to that list" changes the file on disk — read off the volume afterwards, because the previous reply is in the prompt and a convincing "added it" costs the model nothing. |
| 10 | `10-tool-honest-failure.spec.ts` | A tool that refuses is recorded `ok=false`, shown as an error on the Activity page, and admitted in the reply — never narrated as a success. |

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
container:

```bash
cd tests/e2e
npm install
npx playwright install --with-deps chromium   # needs root on Linux
NOVA_E2E_OWNER_PASSWORD='choose-one' NOVA_E2E_MODEL=qwen3:8b npm run e2e
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
| `NOVA_E2E_OWNER_NAME` | `Jeremy` | the owner scenario 1 mints |
| `NOVA_E2E_OWNER_PASSWORD` | **required, no default** | scenario 1 refuses to run without it — see below |
| `NOVA_E2E_PROJECT` | `nova` | HOST runs only. In-container the project is read off the runner's own compose label and this is refused if it disagrees — which stack may be stopped and restarted is not a setting. |
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
