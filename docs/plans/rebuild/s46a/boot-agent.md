# S46a: the boot agent — the spec (PROPOSED)

**Status:** proposed 2026-10-14. **Not approved.** The owner asked for this on
2026-10-14 (§2) and has not yet chosen between the proposal and its
alternatives (§6). Nothing here is built. The proposal **changes a locked
decision**: hub-topology D3, "How the agent runs" (2026-09-18). That is owner
decision 1 in §10. The cable section (§8) reopens S46a's decision 5, "the Dell
stays on Wi-Fi", and is owner decision 7.

This extends S46a ([`spec.md`](spec.md)), which is paused at T13a (owner,
2026-10-13: "we'll table it ... accept the dell as is for now"). It adds a
second setup family, `boot`, to S46a's setup table (§4.1 there), beside
`wake`. Where this file and `spec.md` disagree, `spec.md` wins until the owner
approves this one.

Read with [`spec.md`](spec.md) §2 (the locked decisions) and §4 (the setup
table, the read-back contract, the admin path), with D3, P6 and P26 in
[`../hub-topology.md`](../hub-topology.md), with S39 in
[`../doing-things.md`](../doing-things.md) (why the Windows agent runs in the
user's session), and with P0-1 in
[`../hub-p0-measurements.md`](../hub-p0-measurements.md).

---

## 1. What happened (2026-10-14)

- **The Dell went silent from 03:05 to 12:57 UTC.** Nearly ten hours.
- **It restarted.** Windows Update is the likely cause. **It is not
  confirmed**: nothing has read the Dell's event log for it yet (B-0, §7).
- **Three things on it start only at sign-in, and nobody signed in:**
  1. **Its agent.** It starts from the HKCU Run key (D3, P6), and a Run key
     runs at sign-in.
  2. **Tailscale.** Its "Run unattended" setting was off, so it did not
     connect before sign-in.
  3. **Ollama.** It starts at sign-in, from its tray app.
- **So nothing of hers could see the Dell, and nothing could fix it.** No
  agent was connected to read why, and her model on the Dell was down.
- **She had no other model.** OpenRouter was walled at the time (fixed
  separately, PR #180), and the hub last-resort switch is off by the owner's
  choice (2026-10-10). So she could not even say what was wrong.
- **It came back when the owner signed in.**

This is the case hub-topology's owner question 2 named on 2026-09-18: "P0-6
shows sign-in is required after a reboot: accept that, or turn on automatic
sign-in?" P0-6 was never measured. The incident measured it.

## 2. What the owner asked (2026-10-14, verbatim)

> "can you have nova do those and code that into her agent when setting up
> machines? ie: if tailnet is the network, then configure it with run
> unattended, also start whatever inference (if needed) software such as
> ollama as a boot-time task, and move the agent to boot."

Then, on how the agent should run at boot and on the desktop:

> "I lean both but need help deciding. Is it possible to have the boot agent
> simply assure that things start properly, and when they do, then the
> desktop agent takes over?"

§5 is the answer proposed to that question: yes, with one change. The boot
agent does not exit once things have started. It stays, idle, and takes back
over when the desktop agent goes away. §6 says why, and what the other
choices cost.

---

## 3. What binds this design

**Locked decisions this proposal changes** (each is an owner decision in
§10):

- **hub-topology D3 (OWNER, 2026-09-18):** "Linux as a systemd user unit plus
  linger; macOS as one LaunchAgent; Windows through an HKCU `Run` key →
  `novad supervise` ... System-service modes are a seam." The proposal adds a
  boot-time instance on Windows and macOS. Linux is unchanged (§4.2).
- **S46a decision 5 (OWNER, 2026-10-05):** "The Dell stays on Wi-Fi. No cable
  is added to make its wake work." Only §8 touches it. The owner also said
  "Ethernet is a future thing" and "no Ethernet now" (2026-10-13). His
  question of 2026-10-14 reopens it, and §8 answers it without deciding it.

**Locked decisions this proposal keeps:**

- **S46a decision 1:** the know-how lives in her agent's code, not her
  prompt. The `boot` family is rows in the setup table.
- **S46a decision 4:** anything installed on a machine is built from the nova
  directory on `main`, never from a worktree.
- **S46a decision 6:** setup runs at install, after the first facts report.
- **S46a decision 9 and S30b:** admin rights come from the standing admin
  path. On Windows that is the elevated task `\Nova\NovaAdmin`, which **runs
  only while the owner is signed in** (interactive token, no stored
  password). This proposal does not change that. Before sign-in, an elevated
  command states *cannot: nobody is signed in*, as it does today.
- **Nova never restarts a machine, and never sleeps one** (2026-09-18,
  2026-10-06). A boot change is proven at a restart she did not cause (§5.7).

**Standing rulings:**

- **No approvals, ever** (2026-09-03, `services/core/tests/test_no_approvals.py`).
  Nothing here asks "may I". A step that cannot run says *cannot* and why.
  Setup applies what the machine's roles need and reports each change with
  its undo.
- **Mechanical over prompts.** "Only one instance serves" is a lock, not a
  sentence. "She said it starts at boot" is a guard reading a boot record,
  not a rule in her prompt.
- **Derived, never hardcoded.** Whether the tailnet is a machine's network,
  and which runtime it serves models from, are read from live state (§5.5).
  No list of machines, runtimes or ports.
- **Never report success you did not check.** Every start at boot is
  followed by a check that the thing answers. A start that was not checked is
  reported as *started, not checked*, never as *up*.
- **The repo is public.** No hostname, address, MAC, tailnet name or username
  in code, tests, fixtures or docs. This file names none.

---

## 4. What exists today (`main` at ab13a534)

### 4.1 How the agent starts, per OS

| OS | Service (D3, P6) | Starts | Source |
|---|---|---|---|
| Windows | HKCU Run value "Nova agent" → `novad supervise --mode run-key`, which relaunches itself detached; the child runs in a kill-on-close job object | **at sign-in only** | `apps/novad/internal/service/runkey_windows.go`; its `BootStart` says "starts at sign-in (the Windows Run key), not before sign-in" |
| macOS | one LaunchAgent, `nova.novad`, `RunAtLoad` | **at login only** | `service/launchd_darwin.go`; `BootStart` says "starts at login (a LaunchAgent), not before" |
| Linux | systemd user unit `novad.service`, `WantedBy=default.target`, plus linger | **at boot, when linger is on** | `service/systemd_linux.go`; `BootStart` reads linger, turns it on without sudo where polkit allows, reads it back (P26) |

### 4.2 Linux already starts at boot

With linger on, the user's systemd manager starts at boot, and its
`default.target` starts the agent. No login is needed. The hub measured
`Linger=yes` (P0-9, 2026-09-21), and a lingering unit kept running across
logouts there. `BootStart` reads linger back on every install and names the
one `sudo loginctl enable-linger <user>` line when it stays off.

So **on Linux the agent needs no second instance.** It already is the boot
agent. Two gaps remain, both outside this proposal's agent change:

- `After=network-online.target` in a *user* unit does not wait for the
  system's network. The agent retries with its backoff (1 s up to 30 s), so
  this costs seconds, not a failure.
- Desktop capabilities (`system.notify`, `apps.launch`) need the graphical
  session's environment, which a unit started at boot does not inherit
  (`apps/novad/README.md`, "Running interactively"). That is unchanged here
  (§9).

On Linux, the runtime and Tailscale are system services. Whether each is
enabled at boot is a fact the `boot` family reads and fixes (§5.4).

### 4.3 What the agent reports, and what core does with two sockets

- **Facts that matter here:** `agent.mode` (`systemd-user`, `launch-agent`,
  `run-key`, `foreground`), `agent.session_interactive` (Windows: not session
  0), `service`, `elevation`, `admin_path`, and `net.ifaces` (name, MAC, IPv4
  addresses, up). **Boot time is not reported yet.** S46a adds it (§4.6
  there); `system.info` has uptime.
- **One copy per identity, by lock** (P5): `run.lock` and `supervise.lock` in
  the state directory. A second copy finds the lock held and exits
  (`state.HeldError`).
- **Core keeps one socket per device, last one wins.** `devices_ws.hub.register`
  replaces an equal-epoch socket with the newer one. It does not close the
  old one. Two live copies of one identity would keep displacing each other.
- **The audit chain is one hash chain per device** (`audit.jsonl`). Core
  re-verifies it on every replay, and a break is a loud `device.audit_break`.
  Two writers would fork it. **So two copies must never serve at once.** The
  lock is what makes that true (§5.2).
- **Jobs outlive the agent** (S30c): on Windows a job breaks away from the
  supervisor's job object (`CREATE_BREAKAWAY_FROM_JOB`) and reports
  `survives_agent`.

### 4.4 What the Dell runs

- **Ollama on Windows is a per-user install** with no admin. It starts from
  its tray app at sign-in. Its models and settings are the user's.
- **The hub reaches the Dell's model as a gateway provider row** (adapter
  `openai-chat`), not an engine (ROADMAP, "Any-runtime engines"). Core finds
  the providers on a machine with `wake._providers_on`, through
  `model_machines.device_of`, from the live provider list, the agents' facts
  and the tailnet peers. Never a name.
- **Tailscale on Windows** runs as a system service from boot. Without
  "Run unattended", it connects only while the profile's owner is signed in.

---

## 5. The proposal

### 5.1 The shape

```
 boot                         sign-in                       sign-out
  │                              │                             │
  ▼                              ▼                             ▼
 BOOT INSTANCE (as the owner, no desktop)                    BOOT INSTANCE
  1. waits for the network                                    takes the lock,
  2. Tailscale up? (where the tailnet is the network)         connects as the
  3. the runtime up? starts it, detached, if not              same device
  4. checks each one ANSWERS, with times
  5. takes the lock, connects as the device ──▶ core
                                 │
                       DESKTOP INSTANCE (Run key / LaunchAgent)
                       asks the boot instance to yield;
                       it finishes or cancels in-flight work,
                       disconnects, releases the lock, waits.
                       The desktop instance takes the lock and connects.
```

**One identity, one Devices row, one audit chain.** Two instances of the same
binary, as the same user, reading the same config and key. **Only the holder
of `run.lock` serves.** The other waits on the lock.

**Why the boot instance stays instead of exiting** (the owner's "simply
assure that things start properly"): if the runtime fails at boot, a helper
that exits leaves nothing of hers connected to see it or fix it until someone
signs in. That is the incident, again, one step later. An instance that stays
connected lets her read why and act, through `device_run`, before anyone
signs in. Once the desktop instance takes over, the boot instance only waits.

### 5.2 One serves at a time

- **The lock decides.** The boot instance runs `supervise --mode boot-task`
  (Windows) or `--mode launch-daemon` (macOS). When `run.lock` is free, it
  takes it and serves. When it is held, it waits on it, and does nothing
  else.
- **Hand-over at sign-in.** The desktop instance starts from the Run key or
  LaunchAgent and finds the lock held by the boot instance. It asks it to
  yield, through the state directory (the plan picks the mechanism after
  B-5). The boot instance:
  1. stops taking commands;
  2. lets a command in flight finish, up to a bound (the plan sets it from
     B-5), then cancels what is left and says so in that command's result:
     "cancelled: the desktop agent took over at sign-in";
  3. closes its socket cleanly, so core unregisters it;
  4. releases the lock and waits.

  The desktop instance takes the lock and connects. Core sees an ordinary
  reconnect of the same device.
- **Take-back at sign-out, or when the desktop instance dies.** A sign-out
  ends the Run-key process and its supervisor. The lock frees. The boot
  instance takes it and connects. A crash of the agent alone is not this
  case: the desktop supervisor restarts its own agent, as today (P3).
- **A boot instance that will not yield** is never killed blind. The desktop
  instance waits, logs why, and keeps asking. The boot instance keeps
  serving, and desktop capabilities say *cannot* (§5.6). Two never serve.
- **Updates.** `daemon.update` swaps the binary under the serving supervisor
  (P7). The waiting instance still runs the old image. When it next takes the
  lock, it first checks the binary's version stamp. If it differs, it
  restarts itself onto the new binary before connecting. A stale version must
  never reconnect and trip core's update job (P10).
- **Jobs** started by either instance keep running across a hand-over, as they
  do across an agent restart (`survives_agent`). B-7 measures this under the
  Task Scheduler.
- **Uninstall** removes both instances, and says which it removed.

### 5.3 What the boot instance does at boot

It follows **the boot plan**, a small file core writes to the agent's config
directory at setup (§5.7), with the same owner-only permissions as the
config. The plan says what this machine needs at boot, derived by core
(§5.5). The boot instance cannot ask core before it has a network, so it
carries what core last derived.

1. **Wait for the network,** up to a bound.
2. **Tailscale, if the plan says the tailnet is this machine's network.** Read
   its state (`tailscale status --json`, `BackendState`). It does not start
   or log in to Tailscale. Unattended mode is a setting made at setup (§5.4).
   It records when Tailscale read `Running`, or what it read at the bound.
3. **The runtime, if the plan names one.** Check whether it answers on the
   port the provider's URL names. If it does not, start it the way the
   setup table's runtime row says, **detached** (out of the agent's job, so a
   hand-over or an agent restart leaves it running), then check again until
   it answers or a bound passes. Retries are bounded. A runtime that never
   answers is reported with what was read: the exit code, the last lines of
   its output, the port's state.
4. **Connect as the device.** Then report each step, with its time since
   boot, in the facts frame's new `boot` section.
5. **Core checks again from the hub's side.** For each provider on the
   machine, it asks the gateway to probe the provider's endpoint (the same
   seam `wake._serving` uses). The agent's local check is the agent's claim.
   The gateway's answer is the fact that matters to her chat.

**If the network never comes up,** nothing of hers can see the machine. The
boot instance writes each step and its failure to its local log, and reports
them when it next connects. That limit is stated, not hidden.

### 5.4 Per OS

| | Windows | macOS | Linux |
|---|---|---|---|
| **Boot instance** | A scheduled task `\Nova\NovaBoot`: trigger *at startup*; runs as the owner, *whether he is signed in or not*; **logon type S4U** (no password stored; B-2 tests it); **limited token**, never highest; no time limit (the default kills a task after 72 h); no battery conditions; restart on failure. Registered through `\Nova\NovaAdmin` at install, while the owner is signed in, and read back from its exported definition. | A LaunchDaemon, `nova.novad.boot`, with `UserName` set to the owner, `RunAtLoad`, `KeepAlive` on failure. Installed through the sudoers admin path, read back with `launchctl print system/...`. **Built and CI-tested, unwalked**: owner decision 11, no Mac is ever paired. | **None.** The user unit plus linger already starts at boot (§4.2). Linger is read back, as P26 does today. |
| **Desktop instance** | Today's Run key, unchanged except that it asks the boot instance to yield (§5.2). | Today's LaunchAgent, the same. | — |
| **Tailscale at boot** | **Unattended mode,** where the tailnet is the network. Fact: the pref behind "Run unattended" (candidate: `ForceDaemon` in `tailscale debug prefs`). Fix, candidate: `tailscale set --unattended=true`, else `tailscale up --unattended` with the current prefs restated. Read back from the pref. Whether it needs elevation is B-1. The service's start type is read too (it should be automatic). | Depends on which Tailscale is installed. The open-source `tailscaled` runs as a LaunchDaemon at boot. The GUI variants are believed to need a signed-in user; this is read, not assumed, and an unfixable variant is a stated *cannot* with the reason. Unwalked. | `tailscaled` is a system unit. Fact: `systemctl is-enabled tailscaled`. Fix: `systemctl enable tailscaled` through the sudoers path, read back. |
| **Runtime at boot** | The boot instance starts it (§5.3, step 3). For Ollama: `ollama serve` from the per-user install, with the user's environment (where it listens, where its models are). What the tray app does at sign-in when a server is already running is B-4. | The boot instance starts it the same way. GPU (Metal) access from a daemon before login is unknown and unwalked. | For Ollama: its installer's system unit, `ollama.service`. Fact: enabled at boot. Fix: enable it through the sudoers path. A runtime run by the user, not a unit, gets the agent's start, as on the other OSes. |

**The setup table's runtime rows.** v1 has one row: Ollama. A row says how
to recognise the runtime (its executable), how to start it headless, and how
to check it answers. The "Any-runtime engines" slice (ROADMAP, owner goal
2026-10-07) adds rows for vLLM, llama.cpp and others. A machine whose model
server matches no row gets a stated *cannot*: "the model server on <machine>
is <executable>; I know how to start Ollama at boot, not that."

### 5.5 What is derived

- **Which machines get the boot instance:** every machine with an agent,
  except the hub, whose agent is the Linux unit and is always on. Proposed;
  owner decision 2 asks whether it should instead be only machines that
  serve models or can be woken.
- **"The tailnet is this machine's network"** holds when either of these
  reads true, never a flag someone sets:
  - its agent reached the hub through the tailnet door at its last connect
    (`devices.last_transport`, P15);
  - a provider on that machine has a base URL that is the machine's tailnet
    address (the same `model_machines.device_of` read that
    `wake._providers_on` uses, with `network.tailnet_peers()`).

  When neither holds, Tailscale is left alone, and setup says why ("<machine>
  reaches the hub over its LAN, and no model of hers is served over the
  tailnet").
- **"This machine serves models"** holds when `_providers_on(machine)` lists
  at least one provider (an engine pointing at it counts the same way, once
  S44 is un-paused).
- **Which runtime**: the process listening on the port the provider's URL
  names, read by the agent (Windows: the listening TCP connection's owning
  process; Linux: `ss -ltnp`; macOS: `lsof`), matched to a runtime row by its
  executable. When nothing is listening (the runtime is down, as during the
  incident), the runtimes installed on the machine, from its facts. When
  neither names a row, a stated *cannot*.
- **The boot plan** is written from these at setup. When they change (a new
  provider, a moved port, a machine that joins the tailnet), core rewrites
  the plan and reads it back. A plan that no longer matches the live state is
  drift (S46a §4.3): a non-urgent notice.

### 5.6 What cannot run while the boot instance serves

- **Desktop capabilities** (`system.notify`, `apps.launch`, and S39's screens
  when they land) need a signed-in desktop. While the boot instance serves,
  each returns *cannot: nobody is signed in on <machine>; <capability> needs
  a signed-in desktop*. The agent decides this from `platform.Interactive()`
  and the instance it is, not from her prompt.
- **Elevated commands** already state *cannot: nobody is signed in* on
  Windows (S30b's task runs only while the owner is). Unchanged.
- **Everything else works headless**: `system.info`, `fs.*`, `shell.exec`,
  jobs, `facts.refresh`, `net.wake` (a relay).
- `machine_status` says which instance is serving: "Dell: serving from its
  boot agent; nobody is signed in."

### 5.7 Nova does it: the `boot` family

The owner asked for her to do this, at setup, in her agent. It is S46a's
setup table with a second family. Everything in S46a §4 applies: facts, named
fixes, parameters from facts, the read-back contract, undo, `machine_changes`,
drift, the admin path for what needs admin.

**Fixes**, each with `apply`, `undo(prior)` and a fresh read-back:

| Fix | What it changes | Admin? |
|---|---|---|
| `boot.agent` | installs the boot instance (§5.4) | Windows and macOS: yes. Linux: none; linger is read back, as P26 does. |
| `boot.tailscale_unattended` | turns on Tailscale's unattended mode (Windows), or enables `tailscaled` at boot (Linux), where §5.5 says the tailnet is the network | per B-1 on Windows; Linux yes |
| `boot.runtime` | writes the boot plan's runtime entry (Windows, macOS), or enables the runtime's system unit (Linux) | Linux yes; otherwise no |
| `boot.plan` | writes the boot plan, read back byte for byte | no |

**A new kind, `boot`.** Like a `firmware` fix (S46a §5.4), a `boot` fix is
*set* when written and read back, but **proven only at the next restart**.
The receipt says "set; proven at the next restart". She never causes that
restart.

**The proof: a boot record.** Core writes one row per observed boot of a
machine with a boot instance, in a new `machine_boots` table, from the first
facts report whose boot time is later than the last one seen:

- the boot time, and when the agent connected, as offsets from boot;
- which instance connected first (`boot` or `desktop`), and whether anyone
  was signed in when it did;
- when Tailscale read `Running`, when the runtime answered locally, and when
  the gateway's probe from the hub answered;
- each step that failed, with what was read;
- the outcome: `came_back` (the boot instance connected before any sign-in,
  and every step in the plan answered), `came_back_partly` (connected, a step
  failed), `not_until_sign_in` (the first connect was the desktop instance
  after a sign-in), or `unknown`, with the reason.

A boot change is **proven** by the first `came_back` row after it. It is
**unproven** until then, and **stale** after any later `boot` change, undo or
drift. The migration takes the next free core number at merge time (above
main's and the live stack's highest; core is at `051` on `main` today).

**When setup runs:** at install, after the first facts report, as S46a §4.5
does for `wake` (decision 6), and when she is asked: "make the Dell come
back on its own after a restart" calls `machine_setup(dell, "boot")`.
`role` gains `"boot"` beside `"wake"`.

**Before any of this is built,** she can already do the three things on the
Dell by hand, through `device_run(elevated)` while the owner is signed in.
Proposed: ask her to, in chat, in the first build step (§11, step 0). That
fixes the Dell sooner, and it is the first measurement. Its downside: no
`machine_changes` rows and no undo, because the table does not exist yet;
setup's later run reads what she set and records it.

### 5.8 Honesty controls

| Claim in a reply | Backed only by | Otherwise |
|---|---|---|
| "*machine* starts at boot" / "comes back on its own after a restart" / "no longer needs a sign-in" | a proven boot record (§5.7) after the machine's last `boot` change | corrected to "set; proven at its next restart" |
| "I set Tailscale to run unattended on *machine*" / "I made Ollama start at boot" | a verified `machine_changes` row for that fix, written in this turn | corrected to what the read-back showed |
| "Tailscale / Ollama is up on *machine*" | a facts reading or gateway probe from this turn | corrected to the last reading, with its time |
| "*machine* came back at *time*" | a `machine_boots` row with that outcome | corrected to the row's outcome |
| "nobody is signed in on *machine*" / "its boot agent is serving" | the current facts | corrected |

- **The guards run at both guard sites, and pass the timing sweep.** Guards
  run in core's event loop.
- **`test_no_approvals.py` stays unchanged and green.** A missing admin path,
  nobody signed in, a runtime with no row and an unknown Tailscale variant
  each give a stated *cannot*. None decides that she *may not*.
- **The capability guard needs no edit.** It reads the live registry.

### 5.9 Security

- **The boot instance runs as the owner with his limited token,** like the
  Run-key agent. It runs whatever core signs, as he would, from boot. That is
  the trust Linux's lingering unit already has today. The Devices page
  already states the agent's reach; it gains one line: "runs from boot, before
  anyone signs in".
- **It has no admin path before sign-in.** S30b's task needs the owner's
  interactive token. Nothing here widens that.
- **No password is stored** with S4U (proposed). Logon type "password" would
  put the owner's Windows password in the machine's LSA secrets. That is the
  fallback only if B-2 shows S4U cannot work, and it is owner decision 3.
- **Unattended Tailscale keeps the machine on the tailnet with nobody signed
  in.** That is the point. The tailnet's own ACLs govern it, unchanged.
- **Commands stay signed** (ed25519 envelopes against the pinned core key),
  and both instances write one audit chain, one at a time (§5.2).

---

## 6. Alternatives, downside first

**A. A start-only boot helper that exits** (the owner's first framing).
*Downside:* when the runtime or Tailscale fails at boot, nothing of hers is
connected to see it or fix it until someone signs in. That is the incident,
moved one step. *Upside:* simplest; no hand-over.

**B. One agent at boot, as a system service, with a small helper in the
desktop session for desktop capabilities.** The usual Windows pattern.
*Downside:* two processes always, a new local channel between them (new
attack surface), and the Windows and macOS agents rebuilt around it; D3's
"system-service modes are a seam" becomes the main path. *Upside:* no
hand-over; one socket for the machine's whole life.

**C. Automatic sign-in at boot** (hub-topology owner question 2).
*Downside:* the owner's password is stored on the machine, and the desktop is
signed in for anyone at the keyboard. It may not work with a passwordless
Microsoft account. *Upside:* nothing to build; every sign-in app starts.

**D. Windows' "use my sign-in info to finish setting up after an update"**
(automatic restart sign-on). *Downside:* it covers only restarts Windows
Update starts. A power cut or a crash still waits for a sign-in. Whether it
covers this incident depends on B-0. *Upside:* a single setting Nova can read
and set.

**E. The boot instance only, no desktop instance.** *Downside:* desktop
capabilities are gone for good on Windows and macOS, and S39 (screens) cannot
be built; `doing-things.md` put the Windows agent in the user's session for
exactly that. *Upside:* one instance, no hand-over.

**F. Accept it** (today's D3). *Downside:* a restart leaves the machine dark
until a sign-in, as on 2026-10-14. *Upside:* nothing to build.

**Proposed: §5,** a boot instance that stays and a desktop instance that
takes over. D can sit beside it as a cheap extra if B-0 shows the restarts
are Windows Update's; that is in owner decision 1.

---

## 7. Measurements first

Each one is taken before the build step it gates, P0-style. **Nova takes them
through her own tools** (`device_run`, `device_run(elevated)`, jobs), and
each turn is read back by turn id. A step she cannot do is a named gap, fixed
as a task, never done for her. Probes that hold machine identifiers stay
outside the repo. **The owner's part:** restarting the Dell, signing in and
out. She never restarts it. Each number is sampled at least three times.

| ID | Measure (machine) | Branch it selects | Gates |
|---|---|---|---|
| B-0 | What restarted the Dell on 2026-10-14 near 03:05 UTC: the System log's restart events (who started it and why, an unexpected shutdown, a power loss) and the update history. | Windows Update → alternative D is worth adding. Power loss or a crash → only the boot instance covers it. Unreadable → stated, and the cause stays "unconfirmed". | nothing; it records the cause |
| B-1 | Tailscale's unattended mode on Windows: read the pref; set it from the agent unelevated, then elevated if that fails; read it back. Then a restart with no sign-in: is the Dell's node online from the hub before sign-in? | Unelevated works → no admin needed. Elevated only → through the admin path. Neither → the owner's step (the tray menu), read back after. | `boot.tailscale_unattended` |
| B-2 | A task *at startup*, S4U, as the owner, limited token, running `novad supervise --mode boot-task`: does it start before sign-in; does it load his profile (the config and key readable under S42a's DACL); does it reach the hub over the tailnet and authenticate; does it survive his sign-in and sign-out; is the no-time-limit setting honoured. Does registering it need admin. With the owner's actual account type. | Works → as proposed. No network or no profile under S4U → owner decision 3 (stored password) or alternative B. Nothing works → §6 again. | `boot.agent` (Windows) |
| B-3 | From that task, before sign-in: `ollama serve` started detached. Does it see the GPU (its `inference compute` line, P0-16), run a one-token generation on the GPU (`size_vram` above zero), read the same models directory and listen where the sign-in Ollama listens. | Works → the boot instance starts it. CPU only → stated, and an owner question. Will not start → a separate task per runtime, or a stated *cannot*. | `boot.runtime` (Windows) |
| B-4 | Sign-in with that server running: does Ollama's tray app adopt it, start a second that fails on the port, or replace it? How long does the model answer nothing? | Adopts → leave the tray app alone. Conflict → setup also removes the tray app's autostart, with undo, or the boot instance stops its server at hand-over; chosen by the measurement. | `boot.runtime` (Windows) |
| B-5 | Two instances of one identity: the waiting one blocks on the lock; the yield; the time from yield to the desktop instance's `ready`; the time from sign-out to the boot instance's `ready`. On core: one Devices row, the old socket unregistered, no `device.audit_break`, no `duplicate_agent` finding. A command in flight at hand-over: what its result says. | Clean → as designed. Core shows two sockets displacing each other → core refuses a second live socket for a device while one is live, with a logged reason, before this ships. | §5.2 |
| B-6 | A cold start from *shut down* with Fast Startup on: does the startup trigger fire, or does the boot instance resume from a hibernated session 0? | Either way it must reconnect. If neither → stated: a cold start with Fast Startup needs a sign-in. S46a already reports Fast Startup. | §5.4 |
| B-7 | A job started by the boot instance: does it survive the hand-over, from inside the Task Scheduler's own process tree? | Yes → as is. No → its result says `survives_agent: false` under the boot instance, and why. | §5.2 |
| B-8 | Linux: the hub's linger and its unit's start time against its boot time. Read only; a hub restart is the owner's. | None expected; a mismatch is a finding. | §4.2 |
| B-9 | macOS: not measurable. No Mac is paired (decision 11). | Rows ship *unwalked* in `deploy/platform-walks.json`. | — |

---

## 8. Waking over a cable

The owner asked on 2026-10-14: "I could hardwire the beelink mini pc to my
dell and get wol?"

**The facts:**

- The hub (the mini PC, Linux) is on Wi-Fi. Its Ethernet port is free.
- The Dell's firmware offers one wake setting, "Wake Up by Integrated LAN".
  It has no Wi-Fi wake setting (S46a §1).
- **Wi-Fi wake was measured, and did not land.** P0-1 trial 1 (2026-09-23)
  sent every variant to the Dell's Wi-Fi with no answer. The S46a walk on
  2026-10-12 recorded two clean `no_answer` attempts. A third was recorded
  `ready`, but the owner had pressed the power button inside its window. That
  is why S46a's T13b reads the wake source before crediting a packet.
- **v1 woke this Dell through its Ethernet MAC.** Found on 2026-10-05: the
  MAC in v1's saved wake settings is the adapter the Windows agent reports as
  "Ethernet" (P0-1, "Added 2026-10-05"). That port was then on the LAN. It
  has had no link since at least 2026-09-18.
- **One Wi-Fi lead is untested:** every attempt sent only broadcasts. A
  unicast magic packet to the Dell's Wi-Fi address is the usual Wi-Fi wake
  path. S46a's tracker lists it as the first thing to try on resume.

**A direct cable is plausible, and untested.** A magic packet is a layer-2
frame. Two machines on one cable need no router or switch. A standard patch
cable works; gigabit ports cross over by themselves.

**What it needs:**

1. **Firmware:** "Wake Up by Integrated LAN" on, and "Deep Sleep Control"
   off. She writes them where Dell's interface exists on this model (open,
   S46a §12.4); otherwise they are the owner's steps from Dell's manual for
   this model (S46a §5.5).
2. **The Dell's Ethernet adapter:** "Wake on Magic Packet" on, and "Allow this
   device to wake the computer" on. These are S46a's `wake.magic_packet` and
   `wake.nic_can_wake` fixes on that adapter. The 2026-10-12 walk read it as
   armed.
3. **An address on each end of the cable.** Today's wake code needs one (see
   below).
4. **The link staying up while the Dell sleeps,** on both ends (C-2).
5. **The wake sent out the cabled port, to the Ethernet MAC,** and credited
   only when the wake source names that adapter (T13b).

**How the wake code picks today** (`services/core/app/wake.py`,
`apps/novad/internal/wake/`):

- **The relay** is a connected agent that came in through the hub's own door
  (`last_transport == "host"`), with an IPv4 interface whose subnet (a /30 or
  wider) holds one of the target's last-reported addresses. **Link-local
  addresses are skipped** on both sides.
- **The adapter** is, by default, the target adapter whose last-reported
  address sits on the relay's subnet. When two subnets match, the choice
  falls to the order of the facts. `adapter=` overrides it.
- **The send** is three packets to that subnet's directed broadcast and three
  to the limited broadcast, UDP 9, from the relay's address on that subnet.
  The agent refuses a broadcast none of its interfaces owns.
- **The MAC** comes from the target's facts and goes only to the relay and the
  private row. Never to a result, span or log.
- **Facts carry no media type.** "Ethernet" is known today only by an
  adapter's name.

**What changes:**

- **Addressing (proposed): a small static subnet on the cable, no gateway on
  either end.** She picks it from the private ranges that neither machine's
  facts use (the LAN, the tailnet, the hub's docker networks), and sets it on
  both ends through each machine's admin path, as a fix with read-back and
  undo. With no gateway, neither machine routes anything else over the cable.
  Then the relay and the send work **unchanged**.
  - *Otherwise (a):* link-local addressing, which both machines fall back to
    with no DHCP. Downside: the wake code skips link-local today, so core and
    the agent both change, and Windows takes a minute to fall back.
  - *Otherwise (b):* raw Ethernet frames out a named interface, no IP at all.
    Downside: it needs a raw-socket capability on the hub (root, or a file
    capability), and a new send path in the agent.
  - *Otherwise (c):* the hub's network manager in "shared" mode, which hands
    the Dell an address over the cable. Downside: it also routes the Dell's
    traffic through the hub, and Windows may prefer the cable for
    everything.
- **A media-type fact** per adapter (`wired`, `wireless`, `other`), read from
  the OS, never from the name. Both the cable fix and T13a need it.
- **T13a: prefer the wired adapter** when both match, and say which adapter
  was used and why. Already in S46a's plan (1 h), plus the fact.
- **T13b: credit a wake only when the wake source names the adapter that was
  sent to.** Already in S46a's plan (3 h).

**Measurements:**

| ID | Measure | Branch |
|---|---|---|
| C-1 | With the cable in: link on both ends, the addresses set, and the Dell's facts listing the cabled adapter with its media type. | No link → cable or port, stated. |
| C-2 | While the Dell sleeps: does the hub's cabled interface keep its carrier and its address? | Loses its address → the hub's profile keeps the address without carrier, else every wake is `relay_cannot`, stated. |
| C-3 | Three wakes, each after at least 5 minutes asleep: a packet capture on the hub's cabled interface shows it left there; the wake source names the Ethernet adapter. | Lands 3 of 3 → wake works on this Dell. Misses → S46a §6.6's honest *cannot*, with this evidence. |

**Downsides of the cable, stated first in any reply about it:** the Dell must
stay within a cable's reach of the hub; both machines carry an extra network
configuration; Windows shows a second, unidentified network; and nothing has
been tested. v1's wake went through the LAN, not a direct cable.

---

## 9. Not in this spec

- Desktop capabilities on Linux through a unit started at boot (the session
  environment). Unchanged.
- The hold (S46b).
- Restarting or sleeping a machine. Never.
- Any-runtime engines beyond the Ollama row.
- Remote unlock of an encrypted disk at boot. A machine whose disk asks for a
  key before Windows starts stays dark until someone types it, and she says
  so.
- Firmware power-on settings, such as "power on when power returns". S46a
  §6.6 lists that as an option for a machine that cannot wake.

---

## 10. Owner decisions needed

1. **Approve the proposal (§5), which changes D3,** or pick an alternative
   from §6. Add D (restart sign-on) beside it if B-0 shows Windows Update
   restarts?
2. **Which machines get the boot instance:** every agent install except the
   hub (proposed), or only machines that serve models or can be woken?
3. **The Windows task's logon:** S4U, with no password stored (proposed). If
   B-2 shows S4U cannot work: a stored password, or fall back to §6?
4. **Who starts the runtime at boot:** the boot instance, detached, from the
   setup table's runtime row (proposed), or a separate startup task per
   runtime?
5. **Order.** On 2026-10-07 S46a was placed after S32b. Proposed: step 0
   (she fixes the Dell by hand-free chat) now; the build after S32.5, as S46a
   resumes: S46a.3's setup-table core, then this family, then the rest of
   S46a.
6. **Windows first, then macOS** (proposed: macOS cannot be walked anyway),
   or every OS in one cut?
7. **The cable (§8).** Reopen decision 5 ("the Dell stays on Wi-Fi, no
   cable")? If yes: a static subnet on the cable (proposed), link-local, raw
   frames, or shared mode? And should the untested Wi-Fi unicast lead be
   tried first?

---

## 11. Build order and estimate

Estimates are for the build and its tests. The owner's restarts and the walk
are on top.

0. **Now, no code:** ask her in chat to set the Dell's Tailscale to run
   unattended, and to start Ollama at boot, through `device_run(elevated)`
   while the owner is signed in. Read the turns by id. This is B-0 and B-1,
   and part of B-3. About 1 h.
1. **Measurements B-2 to B-8** (§7), through her tools, with the owner's
   restarts. About 4 h.
2. **S46a.3's setup-table core,** if not yet built: `machine_changes`,
   `machine_setup`, the read-back contract. About 6 h, counted in S46a.3's
   23.5 h, built first.
3. **Boot facts and parsers,** per OS, on recorded text: the task's and
   daemon's definitions, Tailscale's prefs and state, the runtime's
   listening process, linger, units enabled. About 3 h.
4. **The boot instance in novad:** the modes, waiting on the lock, the yield,
   the take-back, following a new binary, the status file. About 6 h.
5. **Install and uninstall of the boot instance** per OS, through the admin
   path, read back. About 4 h.
6. **The boot sequence:** network, Tailscale, the runtime started detached,
   each checked, bounded retries, the `boot` facts section. About 4 h.
7. **The `boot` family** in the setup table: the four fixes, kind `boot`,
   undo. About 4 h.
8. **Core:** the derivations (§5.5), the boot plan and its drift,
   `machine_boots` and its migration, the gateway's probe after a boot. About
   5 h.
9. **Desktop capabilities say *cannot*** under the boot instance. About 1 h.
10. **Her surfaces:** `machine_setup(machine, "boot")`, `machine_status`
    lines, a notice when a machine came back without a sign-in or a boot
    step failed, the Machines section at 393 px. About 2.5 h.
11. **Guards** (§5.8) with the timing sweep. About 3 h.
12. **Evals,** `suite_version` +1: `sets-a-machine-to-come-back-after-a-restart`,
    `says-boot-start-is-proven-only-after-a-restart`,
    `says-a-desktop-action-cannot-run-before-sign-in`. About 2 h.
13. **Docs:** `apps/novad/README.md`, `deploy/README.md`, D3 in
    `hub-topology.md`, `deploy/platform-walks.json`. About 1.5 h.

**About 40 h for every OS** (range 34 to 48), plus the 6 h of S46a.3's table
core when that is not yet built. **A Windows-first cut is about 30 h**
(macOS rows deferred). The cable (§8), if chosen: about 3 h on top (the
media-type fact, the cable fix on both ends), plus T13a and T13b, already in
S46a's plan at 4 h.

**Pins that move, deliberately, with the reason in the commit:**

- the eval corpus, +3 cases, and `suite_version` +1;
- the tool registry: none, if `machine_setup` lands with S46a.3; `role` only
  gains a value;
- `deploy/platform-walks.json`, the new rows;
- `test_no_approvals` stays **unchanged and green**.

---

## 12. Done when

Walked on the real stack, built from the nova directory at the merge commit,
each turn read back by turn id. Each measured number is sampled three times.

1. **Setup, unasked, at install** (or "make the Dell come back on its own
   after a restart"): receipts for the boot task (its definition read back),
   Tailscale unattended (read back) or why it was left alone, the runtime
   derived from the Dell's provider and written to the boot plan. Each reads
   "set; proven at the next restart".
2. **"Will the Dell come back if it restarts?"** She says it is set and not
   proven. The guard has nothing to correct.
3. **The owner restarts the Dell and does not sign in.** The boot instance
   connects: facts show mode `boot-task`, not interactive, nobody signed in.
   Tailscale reads `Running`, Ollama answers, and the gateway's probe from
   the hub answers, each with its time since boot. The `machine_boots` row
   reads `came_back`. A chat turn served by the Dell's model answers while
   nobody is signed in (`served_by` in the trace).
4. **Before sign-in:** "show a notification on the Dell" and "open Notepad on
   the Dell" each state *cannot: nobody is signed in*.
5. **The owner signs in.** The desktop instance serves within the measured
   hand-over time. One Devices row. No `device.audit_break`. A notification
   works.
6. **The owner signs out.** The boot instance serves again within the
   measured time. Ollama answers throughout, or the gap is measured and
   stated.
7. **An update while the desktop instance serves.** At the next sign-out the
   boot instance connects on the new version, never the old one.
8. **"Undo the Dell's boot setup."** The task is removed, Tailscale's prior
   setting restored, each read back. The next restart reads
   `not_until_sign_in`, and she says so.
9. **The hub:** `machine_status` says it starts at boot because linger is on,
   read now.
10. **B-0 recorded:** what restarted the Dell on 2026-10-14, or that it could
    not be read.
11. **The cable, only if the owner picks it:** C-1 to C-3, with the wake
    source naming the Ethernet adapter on every landed wake.
