# S33: every green commit on `main` deploys itself — the spec

**Status:** a proposal, 2026-10-07. The owner asked for it ("Please look into
how we can setup our pipeline so that when all builds and test finish, we have
a deploy stage process … We cannot have nova deploy a broken nova that cannot
be recovered automatically"), then asked for it written up ("yes please").
**Amended 2026-10-07** with §7's integration stage: a target chain she
configures (`ci`, the hub, or an enrolled server), the deployer measuring
every verdict itself, and a scrubbed, egress-less copy of real data.
**Nothing here is approved yet.** The decisions marked **OPEN** in §9 are the
owner's; everything else follows from rulings already on record, which are
cited where they are used.

Read with S32 and S33 in [`../doing-things.md`](../doing-things.md) (build
identity; deploy by SHA with the verdict outside core), its Q2 and Q4 (where
code goes; what blue/green means on the mini PC), and
[`../nova-codes.md`](../nova-codes.md), whose order puts S33 after S32 and
says what S33 is for: *"Its automatic rollback is what stops a bad change of
hers from leaving her broken with nobody to fix her."*

This spec does not replace S33 in `doing-things.md`. It widens it: S33 as
written deploys a **landing** (her own change, verified by her own suite run
on the hub). This spec adds the second door the owner asked for — **every
commit on `main` that GitHub CI passes** — and pins down what makes either
door safe to leave unattended.

---

## 1. What exists today (2026-10-07)

- **CI runs and is mostly green.** `.github/workflows/rebuild-ci.yml` runs on
  every push to `main` (trigger widened 2026-09-21, workflow re-enabled
  2026-09-27): `services` (core, gateway,
  memory against a throwaway postgres), `installer`, `backup`,
  `backup-macos`, `web` (build, tests, `gate_test.sh`, the topology and
  tailscale tests), `novad`, `novad-native`. Six of the last seven completed
  `main` pushes were green, about 8 minutes each. It builds no deployable
  image and publishes nothing but the novad binaries.
- **Deploying is a person.** `./install` runs `docker compose up -d --build`
  on the hub, from the checkout. `./install update` is a stub
  (`deploy/install.sh:2320`). Images are `nova-<svc>:latest`; the previous
  build survives only if someone tagged it by hand (the S40 rollback in
  `deploy/README.md` did exactly that: `docker tag nova-<svc>:pre-s40 …`).
- **`/status` cannot say what is running.** Core's returns `SERVICE_VERSION`,
  a constant (`services/core/app/main.py:167`). No image carries its commit.
- **Backups and a verified restore exist** (S41): `./install backup`,
  `restore`, `drill`. A bundle carries every database, the carried volumes and
  the core signing key, and its restore checks counts, digests and the key
  fingerprint before it says `restored`.
- **The e2e walk exists and is destructive by design**
  (`tests/e2e/isolated.sh`): it mints the owner, restarts every container,
  stops the gateway, writes files. It can never run against the live
  instance.
- **Migrations run at service start**, forward-only, per database
  (`services/{core,gateway,memory}/app/migrations_runner.py`, three
  `schema_migrations` tables). Two migrations already on `main` are not
  backward-compatible: `services/core/migrations/017_no_approvals.sql` and
  `services/gateway/migrations/003_providers.sql` (they drop or rename). The
  S40 rollback needed a hand `pg_restore` for exactly this reason.
- **A core restart is slow on purpose.** `stop_grace_period: 330s`
  (`deploy/docker-compose.yml`, core) lets a chat turn finish. A deploy that
  recreates core can take five and a half minutes to stop the old one.

## 2. The one rule

**The code that decides a rollback, and the code that performs it, never
depend on — and are never deployed by — the thing they protect.**

Everything below is that rule applied. In particular:

1. **The deployer is a host process**, a systemd unit and timer on the hub —
   never a container in the `nova` compose project, never a tool running
   inside core. Its state is a file on the host (`deploy/state/`, gitignored),
   never a row in Nova's database. It needs only `docker` and images already
   on disk to roll back: no GitHub, no registry, no core.
2. **A new version must prove itself, or it is rolled back.** The trigger is
   "the smoke suite passed within the window", never "a test failed". A
   version that hangs, crash-loops, or never answers is rolled back exactly
   like one that answers wrongly. A deadline with no verdict is a failure.
3. **The rollback path is not updated by the deploy it guards** (§6). One
   commit that breaks `redeploy.sh` must not leave nothing able to recover.
4. **The previous images are always there.** Images are tagged by commit and
   per-service content hash; the deployer never prunes the current tag, the
   previous one, or the last known-good one, whatever disk pressure says. A
   disk-headroom shortfall is a finding, never a reason to prune those three.

This is a check of facts, not an approval: it states that the new version
does not work, and puts back the one that did. Nobody is asked, and nothing
decides who may deploy (owner ruling 2026-09-03,
[`../no-approvals.md`](../no-approvals.md); `tests/test_no_approvals.py`).

## 3. Why not Kubernetes, pods, or Swarm

The owner asked about lightweight Kubernetes on 2026-09-30 ("deploy a new pod
of a service, test it"). The answer recorded then (Q4) stands, and is the
shape this spec builds: **in place by commit now, shaped like a Kubernetes
rollout** — a desired image per service, a health gate, automatic rollback —
so the master plan's optional S20 (a k3s target) can later swap the engine
without changing her tools. The reasons, measured or on record:

- **One node.** The hub is an N150 with 16 GB (`../hub-topology.md`). k3s on
  one node adds a control plane and buys no availability.
- **The orchestrator is not the blocker.** True blue/green under compose OR
  k3s is blocked by the shared database (a new core runs its migrations
  against live data at start) and by singletons: memory's index file, the
  device hub's WebSockets (every `novad` holds one connection to one core),
  and schedulers that would fire twice with two cores up. k3s solves none of
  these; §5 and §7 do.
- **The pod shape strands on restart.** S5b measured it and moved to fixed
  addresses (`../slice-05b-tailnet.md`, revision 2), and
  `deploy/tailnet_topology_test.sh` keeps the strand as a negative control.
- **Swarm** has the closest native feature (`update_config.failure_action:
  rollback`, `order: start-first`), but rejects `ipv4_address`, which the
  tailnet topology depends on, and does not build images.
- **Things that do not belong in a pod at all:** the hub's own `novad` runs
  on the host by design, the bundled ollama owns the GPU where there is one,
  and the tailscale sidecar holds a node identity that must never run twice.

## 4. The pipeline

```
push to main
  └─ rebuild-ci.yml: every existing job
       └─ publish   (needs: every other job)
            build core, gateway, memory, web
            push ghcr.io/jeremyspofford/nova-<svc>:<sha12>  + :h-<content hash>
            write release manifest (sha, per-service hash, migration heads)
            (the synthetic e2e walk ran before this — the integration floor)
hub: nova-deployer.timer (every 2 min)
  └─ newest published manifest on main ≠ current?
       ├─ integration (§7): first runnable target in the chain
       │    scrubbed real data → full walk → verdict bound to image digests
       └─ redeploy.sh <sha>   (only those digests, only on a passed verdict)
            snapshot → migrate-check → pull → up changed → gate → smoke → verdict
                                                                  └─ fail → rollback.sh
```

### 4.1 CI builds the images, the hub pulls them

A new final job, `publish`, `needs:` every other job, so it runs only when all
of them are green. It builds the four images, stamps `NOVA_BUILD_SHA` and the
per-service content hash into each (S32), pushes them to GHCR, and writes a
release manifest beside them: the commit, each service's content hash, and
each database's newest migration filename.

Why CI and not the hub: the bytes deployed are the bytes CI tested; an N150
does not spend minutes compiling `web` while serving; and a rollback target is
a pull away even if the local image store was pruned. **This differs from S32
as written**, which builds on the hub — see §9, decision 1.

A per-service content hash is load-bearing, not cosmetic: a tree-wide tag
would recreate all four services on every deploy, killing gateway
mid-inference and severing every agent through web (S32's own words). Only a
service whose hash changed is recreated.

### 4.2 The hub pulls; GitHub never reaches in

`nova-deployer.timer` asks GHCR for the newest manifest published from
`main`. A newer one than `deploy/state/current.json` starts a deploy. Nothing
on GitHub can reach the hub: no self-hosted runner, no SSH from a hosted
runner over the tailnet. A pull also degrades the right way — with GitHub
down, nothing deploys, and rollback still works from local images.

Deploys are serial: one lock, one deploy at a time. A commit that lands while
a deploy is running waits for the next tick; if three land, only the newest
is deployed (each one's CI already ran on its own).

Her own changes (S32's landings) take the same door: a landing that reaches
`main` is published by CI like any other commit. `deploy_stack` (S33's tool)
becomes "deploy this published commit now" rather than "build this on the
hub", so the two paths cannot diverge.

### 4.3 `redeploy.sh <sha>`, step by step

Each step fails and says why; none falls back to a word that reads as success.

1. **Lock** and write `deploy/state/deployments/<id>.json` with
   `phase: started`. From here on a crash leaves a file that says how far it
   got.
2. **Integration verdict** (§7): the deployer's own record says these exact
   image digests passed integration, on which target, on real or synthetic
   data. No verdict for these digests — run §7 now. A failed one — the deploy
   ends here, live untouched, verdict `failed_integration`.
3. **Snapshot**: an S41 bundle, taken by this host job (not a second dump
   path; `doing-things.md` already settles this). It holds provider keys and
   the core signing key, and lives on the host so a rollback artifact does not
   share a deletion boundary with the data it restores.
4. **Migration check, per database.** Read each `schema_migrations` head;
   compare with the manifest's. Record which migrations this deploy will
   cross, and whether each is marked compatible (§5). Crossing an
   incompatible one is not refused; it changes what rollback means (§5.3),
   and the verdict says so.
5. **Pull** the new images and tag the outgoing ones `:previous` (and keep
   `:known-good`, the last version whose smoke suite passed).
6. **`up -d --no-build`** only the services whose content hash changed.
   Core's 330 s stop is waited out, not cut short.
7. **Health gate**: every recreated container healthy by `docker inspect`,
   within a bound; `/status` (and web's `/build.json`) read back and each
   reports the manifest's SHA and hash; the ollama compute line where a GPU
   is expected (`./install` already reads it).
8. **Smoke suite** (§4.4) against the live stack.
9. **Verdict**: `serving` — write `current.json`, move `:known-good`. Any
   failure in 6–8 — run `rollback.sh` (§6), then the smoke suite again
   against what came back, and write `rolled_back` with the failing step and
   its stated reason. A rollback whose smoke suite also fails writes
   `broken`, stops deploying, and leaves the stack on `:known-good`'s images
   (§6.3).

### 4.4 Two tiers of tests

The existing e2e walk cannot run on live, so tests split by whether they are
allowed to break things.

**Before deploy — destructive, on a throwaway stack.** Two places, both
§7's integration stage:

- **The floor, in CI, always.** The e2e walk (`tests/e2e/isolated.sh up &&
  walk && down`) runs on a hosted runner against the images `publish` is about
  to push, with ollama on the CPU and a small model, on synthetic data. A red
  walk means `publish` does not run, so every published commit has passed it.
  *To check:* runtime and memory on a hosted runner with a CPU model — the
  walk was written against the Dell.
- **The rehearsal, on real data, where the chain says** (§7.2): the same walk
  plus the smoke suite, against a scrubbed copy of live data.

**After deploy — read-mostly, on live.** A new suite, `deploy/smoke/`,
written for this slice. It may write only to things it owns and can name, and
it cleans up by exact name, the way the drill does. Every check is a fact
read back, never a reply's word:

| Check | The fact |
|---|---|
| each service is the new build | `/status` and `/build.json` report the manifest's SHA and hash |
| sign-in works | `POST /api/v1/auth/login` as a dedicated probe account (`nova-smoke`, minted by `./install`, password in `deploy/.env`) |
| a chat turn completes | one turn in a canary conversation; its `turn_spans` rows read back, `status` closed ok, an `llm_call` span present |
| memory answers | a recall on the canary conversation's own note returns it |
| a tool runs | a write then read of `smoke/<deployment id>.txt` in the workspace; byte count equals the file's real size; file removed |
| the hub kept its agents | connected-agent count ≥ the count read before step 6 (an agent that was offline before is not counted) |
| the gateway routes | the gateway's current route for chat names a model (the same read her `route_explain` makes) |

A smoke turn costs a real model call per deploy. It uses chat's own chain, so
a deploy proves the path the owner uses; §9, decision 4.

## 5. The database: what makes rollback actually safe

Rolling back images only works if the old code still runs against the schema
the new code migrated to. Today nothing guarantees that, and twice it was not
true.

### 5.1 Expand/contract, enforced by code

A migration either **expands** (adds a table, a nullable column, a column with
a default, an index) or **contracts** (drops, renames, narrows a type, adds
`NOT NULL` to existing data). A contract may only remove what a deploy at
least one release earlier stopped using. Two lines of code hold this:

- **`tests/test_migrations_compatible.py`** (lint, every CI run): a migration
  containing `DROP`, `RENAME`, `ALTER … TYPE`, or `SET NOT NULL` fails unless
  its file opens with `-- contract: expands in <earlier file>` and that
  earlier file is already on `main`'s published history. `017` and gateway
  `003` are grandfathered by name, nothing else.
- **The N-1 job** (CI, before `publish`): start postgres, apply `main`'s
  migrations, then boot the **previous published release's images** against
  that database and run the smoke suite's read-only checks. Old code on the
  new schema, proven every time — this is the test that makes "roll back by
  retagging" true rather than hoped.

### 5.2 What a rollback does across migrations

- **Only expand migrations crossed** (the normal case once §5.1 holds): roll
  back the images; the extra columns or tables stay and the old code ignores
  them. No data is lost.
- **A contract migration crossed**: retagging is not enough. See §5.3.

### 5.3 The last resort: the bundle

When the deploy crossed a contract migration and fails its gate, the deployer
restores the step-3 bundle and then rolls back the images. That loses whatever
was written between the snapshot and the restore — minutes, since the gate
runs immediately. **Whether this happens unattended is §9, decision 3.**
Today S33 in `doing-things.md` says the tool answers "crossed migration NNN in
<db> — restore the bundle at … first; this tool does not". This spec proposes
that the host deployer may, because the alternative is exactly what the owner
ruled out: a broken Nova nobody recovers.

## 6. The deployer protects itself

### 6.1 A pinned rollback path

`deploy/rollback.sh` is kept small: read `deploy/state/current.json` and the
`:previous` / `:known-good` tags, retag, `up -d --no-build --force-recreate`
the changed services, read health back. It is linted as POSIX `sh`, has its
own test (`deploy/rollback_test.sh`, docker stubbed like `install_test.sh`),
and is changed rarely.

### 6.2 The deployer updates itself in two phases

The unit runs a **copy** of `redeploy.sh` and `rollback.sh` in
`/opt/nova-deployer/<version>/`, never the checkout's live files. When a
deploy brings a new version of either, the deployer does not switch to it
until it has run a drill with it — a no-op deploy of the current SHA, then a
rollback to `:previous`, then forward again, each read back. Only a drill that
passes moves the `/opt/nova-deployer/current` link. A broken deployer in a
commit therefore leaves the old deployer in charge, and says so as a finding.

### 6.3 A watchdog that is not a deploy

The same unit checks the stack's health every tick, deploy or not. For the
first 24 h after a deploy, a stack that stays unhealthy past the gate's bound
is rolled back to `:known-good` even if the deploy's own smoke suite passed —
a fault that shows up an hour later is still this deploy's. After 24 h it is a
finding, not a rollback: by then the cause is more likely the world than the
build. A `broken` verdict stops deploys until a later published commit is
green **and** passes a deploy, which clears it; nothing waits on a person.

## 7. Integration: prove the new version before it touches live

Two full live copies on 16 GB means two cores sharing one database, a split
device hub, a split memory index and two sets of schedulers. Not proposed.

The useful half of blue/green is "prove the new version before it touches
live" — Q4's third option, widened by the owner on 2026-10-07: *"what if we
allow an integration instance for testing? … we could allow nova to configure
where the integration server will be. it could be in ci/cd, the hub, or a
server."* Integration is a stage of every deploy, between `publish` and
`redeploy.sh`, and **where** it runs is configuration.

Integration does not replace §4.4's live smoke suite or §6's rollback. A
version that passed on a copy can still fail on live — other hardware, other
settings, the real agents — so live keeps its own gate.

### 7.1 Targets

| Target | What it proves | What it cannot |
|---|---|---|
| `ci` — a hosted runner | the full walk on synthetic data; free; always available | no GPU, CPU model only, never real data (a bundle holds provider keys and the core signing key, and does not go to GitHub) |
| `hub` — a throwaway project on the hub | migrations and the walk against a scrubbed copy of real data, on the hardware live runs on | shares 16 GB with live: a few minutes of memory per deploy (to measure: the services, plus its own CPU ollama and a small model, §7.4) |
| `<server>` — an enrolled machine (the Dell, a VM) | real data and a real GPU, with no contention with live | the Dell sleeps and wake is paused, so it is often not runnable; a VM costs money; data leaves the hub |

`ci` is the **floor**: it runs on every commit before `publish` (§4.4), so it
has always passed by the time the hub sees a manifest. The configurable part
is the **real-data rehearsal** above it.

### 7.2 The chain, and who sets it

The rehearsal targets form an ordered chain, the same idiom as a routing
role's chain — for example `dell → hub`. On each deploy the deployer walks it
and the first target that **can run now** takes the job: a server that
answers its health probe and has the disk; the hub with the free memory the
rehearsal measured last time plus a margin. A target passed over is recorded
with its reason (`dell: no answer in 30 s`; `hub: 1.8 GB free, needs 3.1 GB`),
the way a routing link says why it was skipped.

**She chooses where, never whether.** Nova sets the chain with a tool (§8);
that is configuration, not a gate, and sits inside the 2026-09-03 ruling.
What no value she can set does is remove the stage: the floor has already
run, and an empty chain means "the floor only", stated on every verdict. When
no rehearsal target in a non-empty chain can run, what happens is §9,
decision 5.

**The setting survives a broken Nova.** She writes the chain as a request
(§8's request directory); the deployer validates it — every entry is `hub` or
an enrolled server's name, no duplicates — copies it into its own state, and
keeps the last valid one. A core that cannot be read, or a request that does
not validate, leaves the deployer on the chain it already had, and the
rejection is a finding with its reason.

### 7.3 The deployer runs the checks itself

A verdict is a fact the deployer measured, never a report it was handed:

- **`hub`**: the deployer starts `nova-int-<8 hex>` (swept by exact name like
  `nova-drill-*`), restores the scrubbed bundle into it (§7.4), runs the walk
  and the smoke suite, and sweeps it.
- **`<server>`**: the server runs its own pinned deployer in integration role
  (the same §6.2 copy and update rules), pulls the candidate digests from GHCR,
  restores the scrubbed bundle, and runs the destructive walk — it needs that
  machine's docker to restart containers, so it cannot run from the hub. Its
  result is signed with the integration deployer's own ed25519 key, enrolled
  on the hub's deployer by the installer — never through core, which is the
  thing under test. Then the **hub's** deployer runs the smoke suite against
  the server's integration address itself, and reads `/status` there to see
  the candidate digests. Both must pass.
- **Bound to digests.** Every verdict names the exact image digests it ran.
  `redeploy.sh` promotes only those digests; a manifest whose digests differ
  from the verdict's has no verdict.

How the hub's deployer reaches an enrolled server is the deployer's own key
over the tailnet, not `novad`: `novad` is paired to core, and core is what is
being replaced.

### 7.4 A copy of Nova must not act on the world

A restore of a real bundle is a working Nova: it holds the core signing key
(it could pose as the hub to every paired device), provider keys, MCP tokens,
scheduled timers, goals, agents and, on a move bundle, the tailnet identity.
An integration copy gets none of that. Two controls, each a line of code
rather than a hope:

1. **A scrubbed bundle, made on the hub, and only it leaves.** `./install
   backup --integration` takes a fresh S41 bundle, restores it into
   throwaway objects (the drill's machinery), scrubs, and dumps a new bundle. The scrub:
   generates a fresh core signing key; empties every credential column;
   switches off timers, goals and agents; revokes every device row; leaves out
   the tailscale volume. "Every credential column" is **derived, never a list**:
   columns are marked in their migration (`COMMENT ON COLUMN … IS
   'nova:secret'`) and the scrub reads the marks from the catalog; a test
   fails when a column whose name says token, secret, password, key or auth
   carries no mark. Before the bundle counts, the deployer reads back: the
   signing-key fingerprint differs from live's; every marked column is empty;
   no timer, goal or agent is enabled. Any one failing — no bundle, no
   rehearsal, and a finding.
2. **No way out.** The integration project's network is `internal: true`: no
   egress at all. It reaches a model only through an ollama on that network
   (its own on a server; on the hub, a CPU ollama in the project, as the e2e
   walk already does). Even a scrub that missed something has nowhere to send
   it. A cloud model in integration is not offered.

### 7.5 What a rehearsal costs

On the hub, a few minutes of memory and CPU per deploy, during which live is
slower; the deployer measures the rehearsal's peak and uses it as the next
run's admission check (§7.2). Disk for one scrubbed bundle, replaced each
time. It needs an exception to the 08-29 "no throwaway stacks" rule (§9,
decision 6). On a server, the transfer of one scrubbed bundle per deploy over
the tailnet.

## 8. Her side

The deployer is outside core by rule (§2), but what it did is hers to read and
act on (`CLAUDE.md`, "the work is her capability"):

- Each deployment's file is reconciled into a `deployments` row by whichever
  core comes up next (S33's lifespan reconciler), so a core that was replaced
  mid-turn still learns the verdict.
- An Inbox notice per deploy: "Deployed abc123" or "Rolled back abc123: the
  smoke turn closed with status error (gateway 502)", with a room.
- Tools (registry +5: S33's three, and two for §7): `deploy_stack` (deploy a
  published commit now), `deploy_verdict` (read a deployment, its integration
  verdict and target included), `deploy_rollback` (ask the deployer to roll
  back to `:known-good`), `integration_configure` (set the rehearsal chain,
  read back from the deployer's own state once it has validated it) and
  `integration_status` (each target: enrolled, runnable now or why not, its
  last verdict). None of them can change the gate, the deadline, the floor, or
  the pinned rollback path.
- **How she asks the host.** Core writes a request file into
  `deploy/state/requests/`, the one directory of the deployer's that core's
  container mounts; the deployer reads nothing from it but request files, so
  core can ask but cannot change the deployer's state. The deployer picks it up on its next tick, validates it, acts, and writes the
  outcome beside it. Nothing the deployer needs in order to roll back is read
  from core.
- A rolled-back deploy is an event S34b's goals can pick up: she investigates
  and fixes on the same landing and deploy path (`nova-codes.md`).

## 9. Decisions for the owner — OPEN

1. **Where images are built.** *Proposed:* CI builds and pushes to GHCR; the
   hub only pulls. *Otherwise:* S32 as written — the hub builds by content
   hash. Downside of the proposal: images leave the machine (to a private
   GHCR package) and the hub needs a pull token. Downside of the other: the
   bytes deployed are not the bytes CI tested, and the N150 builds while
   serving.
2. **How the hub learns of a new commit.** *Proposed:* a 2-minute pull timer.
   *Otherwise:* a self-hosted runner on the hub (faster, but gives GitHub a
   code-execution path onto the hub) or SSH from a hosted runner over the
   tailnet (needs a tailnet key in GitHub secrets).
3. **Unattended bundle restore** when a failed deploy crossed a contract
   migration (§5.3). *Proposed:* yes, automatically, with the lost window
   stated in the verdict. *Otherwise:* stop on the old images and file a
   finding — which leaves Nova broken until someone acts.
4. **The smoke turn's model.** *Proposed:* chat's own chain, so the deploy
   proves the path in use; one real call per deploy. *Otherwise:* a fixed
   cheap model, cheaper but proving less.
5. **When no rehearsal target can run** (§7.2) — the Dell asleep and the
   hub short of memory. *Proposed:* deploy on the CI floor's verdict, stated
   on the verdict and in the Inbox notice ("verified on synthetic data only:
   dell no answer, hub 1.8 GB free"); live's smoke suite and rollback still
   guard. *Otherwise:* wait for a target, up to a bound, then the same — or
   wait without a bound, which stalls every deploy while the Dell sleeps.
6. **The hub as a rehearsal target** (§7.5). Needs an exception to the 08-29
   "no throwaway stacks" rule for `nova-int-*` projects. *Proposed:* yes, as
   the chain's default (`hub`).
7. **Real data off the hub** (§7.1, §7.4). *Proposed:* allowed to an enrolled
   server, only as a scrubbed bundle over the tailnet. *Otherwise:* real-data
   rehearsals on the hub only; servers rehearse on synthetic data.
8. **Enrolling a server** as a target is an installer step on that machine
   (`./install integration-target`), exchanging deployer keys with the hub.
   *Proposed:* the installer, run by a person once per machine, like pairing.
   *Otherwise:* her own hands on that machine through `novad` — faster to
   grow, but then enrolment goes through core.

## 10. Order

1. **S32** — build identity (`NOVA_BUILD_SHA`, content hash, `/status`,
   `/build.json`) and the `publish` job.
2. **§5.1** — the migration lint and the N-1 job. Before anything deploys
   unattended, because they are what make a rollback safe.
3. **§4.4** — `deploy/smoke/` and the probe account; the e2e walk in CI.
4. **§4.3, §6** — `redeploy.sh`, `rollback.sh`, the systemd unit, the
   two-phase self-update, the watchdog.
5. **§8** — her tools, the reconciler, the Inbox notice. Retires "Claude
   deploys" (`nova-codes.md`).
6. **Turn on** the timer. Integration is the CI floor alone at this point.
7. **§7.4** — the `nova:secret` marks and their test, `backup
   --integration`, the read-back. Before any real-data rehearsal.
8. **§7.2, §7.3** — the chain, `hub` as a target, `integration_configure` /
   `integration_status`.
9. Later: enrolled servers (§7.3), once wake works or a VM is chosen; S20's
   k3s engine if it is ever wanted.

## 11. Definition of done

- A commit merged to `main` is serving on the hub, unattended, within
  CI time + 15 minutes; `/status` on every changed service reports its SHA;
  unchanged services were not recreated (their container IDs did not change).
- A commit that breaks chat (pinned as a test branch: core returns 500 on
  every turn) passes unit CI, deploys, fails the smoke turn, and is rolled
  back unattended; the Inbox says why; the previous SHA is serving and its
  smoke suite passed.
- A commit that hangs core at startup is rolled back by the deadline, not by
  a failure it reported.
- A commit that breaks `redeploy.sh` itself leaves the old deployer in charge
  and files a finding; the stack is untouched.
- A migration that drops a column without a `-- contract:` header turns CI
  red; one with the header whose expand is not yet published turns it red too.
- A commit whose migration fails against real data (pinned: a migration
  that adds `NOT NULL` to a column live data leaves empty) passes the CI
  floor, fails the hub rehearsal, and never reaches live; the verdict is
  `failed_integration` with the migration's error, and live's container IDs
  did not change.
- A scrubbed bundle with one credential column left full (pinned: a new
  column named `*_token` with no `nova:secret` mark) turns CI red; a scrub
  whose read-back finds the live signing-key fingerprint refuses the
  rehearsal.
- She is asked "rehearse on the Dell first, then the hub" and the chain reads
  back from the deployer's state as `dell → hub`; with the Dell asleep, the
  next deploy's verdict says `dell: no answer` and names `hub` as the target
  that ran.
- She is asked in chat "what's deployed, and did the last deploy work?" and
  answers from `deploy_verdict`, matching `deploy/state/current.json` and the
  trace.
