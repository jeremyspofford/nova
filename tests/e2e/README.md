# Slice 1 end-to-end walks

Five scenarios against a real running stack — a real model, a real pull, a
real restart. They are not unit tests and they are not isolated from each
other: they are one walk through one instance, run in file order in a single
worker.

| # | File | What it proves |
|---|------|----------------|
| 1 | `01-wizard.spec.ts` | A fresh instance goes Welcome → owner account → hardware (real `hardware.json` on screen) → engine (bundled ollama verified live) → model → download (real progress, real completion) → a streamed reply that must exist before the finish button does. |
| 2 | `02-chat-memory.spec.ts` | A message through the real UI gets a streamed reply, the header names the serving model, and core's fire-and-forget ingest really landed the exchange in the memory service. |
| 3 | `03-restart-persistence.spec.ts` | The S1 definition of done: restart every container, then the transcript re-renders (postgres survived), memory still recalls the fact (the memory volume survived and the index rebuilt), and the new answer references it — with the turn's own `memory_recall` span read out of the ledger to prove core really consulted memory on that turn. |
| 4 | `04-gallery.spec.ts` | ≥30 design-system primitives render in dark and light, the spec accent `#19A89E` is live, and both modes are screenshot-diffed. |
| 5 | `05-honest-failure.spec.ts` | With the gateway stopped, the UI shows a stated error row — never an empty assistant bubble — and the stack is answering again by the end. |

## Run it

The stack has to be up first (`./install` from the repo root). Then, from the
repo root:

```bash
docker compose -f deploy/docker-compose.yml -f tests/e2e/docker-compose.e2e.yml \
  --profile e2e run --rm e2e
```

That is the documented command. It runs the browser inside Microsoft's
playwright image, which already carries the browsers *and* their system
libraries — so it needs nothing installed on the host and works on a machine
where you cannot `apt-get`. The container runs as your uid, so traces,
screenshots and `node_modules` come out owned by you; override
`NOVA_E2E_UID` / `NOVA_E2E_GID` / `NOVA_E2E_DOCKER_GID` if yours are not
1000/1000/1001 (`id -u`, `id -g`, `getent group docker`).

It mounts the docker socket, because three things need it: restarting the
stack (scenario 3), stopping the gateway (scenario 5), and reading the turn
ledger with psql inside the postgres container (scenario 3 again — postgres is
deliberately not published, so the query runs where the database already is).
That socket is a real privilege, which is why this service sits behind a
profile and is never part of `up`.

Reports and traces land in `playwright-report/` and `test-results/`; open the
report with `npx playwright show-report` from `tests/e2e`.

### On the host instead

The same suite runs against `http://127.0.0.1:3000` with no container:

```bash
cd tests/e2e
npm install
npx playwright install --with-deps chromium   # needs root on Linux
npm run e2e
```

`--with-deps` is the catch: on Linux the browser needs system libraries
(`libnspr4`, `libnss3`, …) that only root can install, and without them
chromium exits 127 before the first test. If you cannot install them, use the
container command above — it is why that one is the documented path.

## Configuration

Everything is one environment variable with a host default. `deploy/.env` is
read for the service tokens, so a host run needs nothing exported.

| Variable | Default | Notes |
|---|---|---|
| `NOVA_E2E_BASE_URL` | `http://127.0.0.1:3000` | `http://web:80` in the container |
| `NOVA_E2E_MEMORY_URL` | `http://127.0.0.1:8002` | |
| `NOVA_E2E_MODEL` | `qwen3:1.7b` | **must be a slug the wizard actually offers on this host** |
| `NOVA_E2E_OWNER_NAME` | `Jeremy` | the owner scenario 1 mints |
| `NOVA_E2E_OWNER_PASSWORD` | `nova-s1-walk` | |
| `NOVA_E2E_PROJECT` | `nova` | compose project the container control is scoped to |
| `NOVA_E2E_PULL_TIMEOUT_MS` | 45 min | first pull of a large model |
| `NOVA_E2E_REPLY_TIMEOUT_MS` | 6 min | cold model load plus generation |

### Picking `NOVA_E2E_MODEL`

The model step only offers curated slugs for the VRAM tier the host lands in,
and the tiers do not cascade — a 24 GB card is offered the 27B-class pin and
nothing smaller. The default here is the smallest curated slug because CI
speed is what the default is for; on a big-GPU box set it to what the wizard
lists, e.g.

```bash
NOVA_E2E_MODEL=qwen3.8:27b npm run e2e
```

Scenario 1 fails with the offered list in the message if the two disagree, so
this is never a silent mismatch.

## Re-running scenario 1

Scenario 1 mints the instance's one and only owner (core closes registration
after the first), so it only runs against a fresh instance and **fails**, with
the reset command in the message, against one that is already set up. It does
not skip — a walk that quietly did not happen must not read as green.

To get back to first-run state:

```bash
tests/e2e/reset-fresh.sh
```

That drops and recreates the three v4 databases and clears the v4 memory
files, using the same `deploy/postgres-init/01-databases.sql` the postgres
image runs on a fresh volume. It deliberately does not remove docker volumes:
the legacy v3 stack shares this daemon, and `docker compose down -v` /
`docker volume rm` are forbidden here. Installed ollama models are kept —
re-pulling gigabytes proves nothing the first pull did not.

## Screenshots

Baselines live in `__screenshots__/` and are committed. The first run writes
them and passes (`updateSnapshots: 'missing'`); later runs diff against them
within a 2% pixel budget. To re-baseline deliberately:

```bash
npm run e2e -- --update-snapshots
```

Font rendering differs between machines, so a diff on a host that did not
produce the baseline is expected and is not by itself a defect.

## CI

The `e2e` job in `.github/workflows/rebuild-ci.yml` is `if: false` on purpose.
GitHub's runners have no GPU and no ollama, so the job would either be red on
every push or would have to be cut down until it proved nothing. Enabling it
is a deliberate decision about which profile it runs, not a default.
