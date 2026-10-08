# The About page, and Nova updating herself

Asked for 2026-10-07 by the owner:

> I want nova to have an about page. I want it to show what nova is about, be
> dynamic and show things like the architecture that is live for that instance
> of nova, in our case we have a dell as a satellite node, a PWA (which nova
> doesn't appear to know about for some reason), and the hub on the mini pc.
> It should also show the released version and commit hash or something to
> know which one it is until we get a better release process in place. I want
> nova to also be able to check if there are any updates to pull, download and
> install. Is that a possible feature too?

**Both parts are built.** Part 1 (the page, the version, the check) merged
in PR #123. Part 2 (pull, download and install, from chat or the page) was
asked for the same day ("go ahead and build the update install part too") and
is built as designed below, without waiting for S30. Its long run is the
installer's own detached job on the hub, which the next core decides.

---

## Part 1: built

### Why she did not know about the PWA

A session row (`sessions`) recorded who signed in and nothing about where.
The installed app on the phone, a laptop's browser and a desktop tab were all
the same anonymous row. Devices are rows because an agent enrolls, and model
machines are rows because the gateway lists them. A client was never a row, so
neither the owner nor she could see one.

Migration `041_session_clients.sql` adds `user_agent`, `display` and
`last_seen_at` to `sessions`. The web app sends `X-Nova-Display: standalone |
browser` on every request (only the page can know `display-mode: standalone`).
`identity.touch_session` writes it, throttled to one write a minute per
session. A change in what the client says it is writes at once. A request that
does not say never erases what an earlier one said. Only the two values are
stored. Nothing reads either one to decide access.

### Which build is running

`./install` now runs `record_build` before `compose_up`. It writes
`NOVA_COMMIT`, `NOVA_VERSION` (`git describe --tags --always --dirty`),
`NOVA_COMMIT_DATE`, `NOVA_DIRTY` and `NOVA_INSTALLED_AT` into `.env`, derived
from the checkout's HEAD. Compose hands them to core. `NOVA_INSTALLED_AT` moves
only when the commit or the dirty flag does, so a re-run on the same commit
leaves `.env` byte-identical and compose has nothing new to recreate core for.
A stack that predates the stamp, or was not brought up from a checkout, says
"unknown build" and why. It never borrows a version from anywhere else.

### Is there anything newer

`about.check_updates` asks GitHub's compare API
(`/repos/{NOVA_REPO}/compare/{NOVA_COMMIT}...{NOVA_REPO_BRANCH}`). It answers
one of: up to date, N commits to pull (listed newest first), running commits
the branch lacks, diverged, or **unknown with the reason** (no stamp, no repo,
a commit never pushed, GitHub unreachable, rate-limited). An unknown is never
drawn as up to date. Results are cached for ten minutes per (repo, branch,
commit). A forced re-check is floored at 30 s, because unauthenticated GitHub
allows 60 requests an hour.

### One read, two readers

`app/about.py` builds one dict: build, updates, hub (tailnet address, its own
agent, the gateway and memory health), the other agents, the model machines
(the gateway's engines and the remote model machines, each with the reason
it could not be read), and clients.
`GET /api/v1/about` returns it to the page. `nova_about` renders the same dict
as lines she can quote (`about.render`). The page and her words cannot
disagree about what is running.

### Machines running models

The "Machines running models" tier (and `nova_about`'s `MODEL MACHINES`
lines) holds two readings, each with its own reason when it cannot be read:

- **The gateway's engines** (`model_machines.machines`): the hub's built-in
  Ollama, with its state and how many models it holds.
- **The remote model machines** (`model_machines.remotes`): every gateway
  provider that is not `builtin` and whose URL is on a machine, not a cloud.
  This is the same selection, through the same helper, that `machine_status`
  uses for its "Remote model machines" (`model_machines.remotes_of`; see
  `deploy/README.md`). The Dell's `dell` and `dell-kev` rows are listed here.
  Each one shows:
  - the gateway's last verdict, read from its providers and walls, never a
    call made now: answering, failing with the gateway's reason, walled
    (with the whole minutes left when the wall has an end), or unknown. It is never "answering" unless the gateway
    said so.
  - the paired device it runs on ("on DELL-XPS-8950"), matched by address
    through `model_machines.place` against the agents' own addresses and the
    tailnet peers, or the words saying why no device is named.
  - its model count ("16 models"), only when the gateway's last listing
    gave one (its "N models listed" note). Otherwise no count is shown,
    never a guess.

The two readings fail apart. A gateway whose providers cannot be read
shows "Remote model machines could not be read: <reason>" while the engine
rows still render, and the reverse. "None." appears only when both lists
were read and both are empty. `nova_about` words each remote line through
`model_machines.remote_words`, the same wording `machine_status` uses, and
records the same per-machine fact (`model_machines.fact_of`) in the turn's
trace.

- Page: `/about`, linked from the account menu as "About Nova".
- Tool: `nova_about` (`reads_only`, `ephemeral`). It is registered, so it is
  hers. The capability guard derives from the registry, so she can no longer
  say "I can't tell which version I am".

---

## Part 2: pulling and installing an update (built)

### How it runs

1. **Start**: `nova_update` (her tool) or **Update now** on `/about`, which
   is the same `nova_updates.start`. It runs only when GitHub says there is
   something to fast-forward to, the hub was brought up clean, the checkout's
   path is known (`NOVA_CHECKOUT`, written by `record_build`), and the hub's
   own agent is connected. Otherwise it fails with the reason. A
   `nova_updates` row is opened as `sent` **before** anything is sent. A
   unique partial index holds one open update at a time.
2. **Send**: one signed `shell.exec` to the hub's own agent. The script is
   composed in core with every value quoted (`launch_script`). It runs
   `./install update --attempt <id>` **detached**: a `systemd-run --user`
   transient unit when there is one (it survives the agent's own restart),
   then system `systemd-run` as root, then `setsid`/`nohup`. Output goes to
   `deploy/.update-<id8>.log` (gitignored). The command answers `started: …`,
   and the tool says **started**, never installed.
3. **`./install update`** (`cmd_update`): it refuses (with a report) a missing
   `NOVA_REPO_BRANCH`, a checkout on another branch, uncommitted tracked
   changes, a failed fetch, or a diverged branch. Already at `origin/<branch>`
   is reported as `up_to_date`. Otherwise it **backs up first** (S41; a failed
   backup refuses with nothing changed), runs `git merge --ff-only`, then
   `cmd_install`. If that install fails, it runs `git reset --keep` back to the
   old commit and installs again, then reports `failed` with which half held.
4. **Decide**: the installer runs `python -m app.updates_cli finish` in the
   core it just brought up. `installed` becomes **confirmed only if that core's
   own `NOVA_COMMIT` is the target**. Otherwise it is recorded as `failed`,
   naming both commits. A `sent` row nobody decides within 45 minutes reads as
   `not_confirmed` (the job died, the host rebooted, core was unreachable),
   with the log's path. A hand-run `./install update` reports too, as
   "by hand on the hub".

`nova_about` and the page both show the latest attempt. While one is in
flight the page re-reads every 10 s, and says "Nova is restarting" when a
read fails during the restart.

### What was checked

- `deploy/install_test.sh`: 26 `cmd_update` cases against real git (a bare
  origin and a clone): fast-forward and install at the new commit, rollback
  and reinstall of the old one, both failing, backup failure, nothing new,
  diverged, dirty, wrong branch, no branch recorded, bad arguments.
- `tests/test_nova_updates.py`: start/refuse/one-at-a-time/stale, finish
  confirmed only by the reporting core's commit, the CLI, the tool, the
  route, and the real launch script run under `sh` (detached, quoted, exact
  argv).
- A live walk in a cloud container with no Docker daemon. Core ran under
  uvicorn and the **real `novad` agent** was built, paired and connected
  through the host door. **Update now** in Chromium led to a signed
  `shell.exec`, then the agent ran the launch script, which detached
  `./install update --attempt …` (a stand-in installer that reports through
  the real `updates_cli`). The page went from "started, not yet reported
  back" to "Updated 6665a73 → eb14e30" by itself. The real installer was
  not run end to end (it needs Docker); its logic is the 26 cases above.

### Still to walk on the hub

Ask her "is there an update? install it". In `turn_spans`, `nova_update`
should run and her reply should say *started*, not done. After the restart,
`nova_about` should show it confirmed. Re-run `./install` once by hand first
so `NOVA_CHECKOUT` is written.
