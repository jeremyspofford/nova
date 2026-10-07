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

**Part 1 (the page, the version, the check) is built.** Part 2 (pull, download
and install) is possible and designed below. It is not built, because it
depends on S30.

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
(the gateway's reading, or the reason it could not be read), and clients.
`GET /api/v1/about` returns it to the page. `nova_about` renders the same dict
as lines she can quote (`about.render`). The page and her words cannot
disagree about what is running.

- Page: `/about`, linked from the account menu as "About Nova".
- Tool: `nova_about` (`reads_only`, `ephemeral`). It is registered, so it is
  hers. The capability guard derives from the registry, so she can no longer
  say "I can't tell which version I am".

---

## Part 2: pulling and installing an update (designed, not built)

### Yes, it is possible

The pieces mostly exist:

- **Something that can act on the host.** The hub's own agent (S42b P23) runs
  on the mini PC beside the stack. It is the device whose socket came through
  the host's own door (`last_transport == "host"`). Core already composes argv
  for it and sends `shell.exec` (`agent_updates.py` does exactly this for agent
  builds).
- **Something that knows the target.** Part 1's check names the exact commit
  to move to.
- **Something that can verify.** After the update, the new core's
  `NOVA_COMMIT` either is the target commit or is not. That is a fact, not a
  sentence.

### Why it is not built yet

1. **The update restarts the thing that asked for it.** `./install` recreates
   core. The turn that started the update dies with it. The update has to run
   detached from the turn, and its result has to be read by the *next* core.
2. **It takes minutes.** Image builds take minutes. `device_run` and the agent
   command path stop at 120 s. That is S30's gap ("jobs that outlive a turn"),
   which is next in the doing lane.
3. **The hub's agent can be restarted by the install.** `install_hub_agent`
   can replace and restart novad. A child started inside novad's systemd
   cgroup dies with it. The update has to be started outside that cgroup
   (`systemd-run --user --unit nova-update …` on Linux; a scheduled task on
   Windows/WSL).

### The design

**`./install update`** (replacing today's stub; infrastructure, in git):

1. Refuse with a stated reason if the tree is dirty, HEAD is not on the
   recorded default branch, or the branch has diverged. Only fast-forward.
2. `./install backup` first (S41). A failed backup stops the update.
3. `git fetch` then `git merge --ff-only origin/<branch>`.
4. Run `cmd_install` (records the new build stamp, `up -d --build`, waits for
   health, verifies the tailnet sidecar, installs the hub's agent).
5. On an unhealthy stack: `git checkout` the previous commit, run
   `cmd_install` again, and exit non-zero naming both commits. Never leave a
   half-updated stack that reads as updated.
6. Write a result file (`deploy/.update-result.json`: from, to, outcome, log
   tail). Exit non-zero on anything but success.

**`nova_update`** (her tool):

1. Read Part 1's check. If nothing is available, say so and stop.
2. Find the hub's agent. If none is paired or it is not connected, say "cannot"
   and give the one command the owner runs instead.
3. Record an `updates` row (from, to, requested by, started at) **before**
   sending, so the next core can decide it.
4. Send `systemd-run … ./install update` through the hub agent's `shell.exec`.
   The tool returns "started: from X to Y". It never returns "updated".
5. **On startup, core decides the open row** (the mechanical part): if its own
   `NOVA_COMMIT` equals the row's target, mark it `confirmed`. Otherwise mark
   it `failed` with the result file's reason. Either way, post an Inbox notice.
   A row still open after 30 minutes is marked `not_confirmed`. Only the new
   core's own stamp confirms an update. No sentence does, which is the same
   rule `agent_updates` follows (P8).

**The page** gets an "Update now" button beside the commit list. It calls the
same function, shows the open row's state, and shows the result once the new
core decides it.

No approval step (owner ruling 2026-09-03). She runs the update when asked;
the controls are the fast-forward-only refusal, the backup, the rollback and
the startup check. Something that can refuse when she is wrong.

### Order

After S30 (jobs that outlive a turn) in the doing lane, because steps 1–3 of
the problem above are S30's problem in its sharpest form. Until then, the page
and `nova_about` say what to run: `git pull && ./install` on the hub.
