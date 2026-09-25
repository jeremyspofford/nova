# S46a: machine setup — the spec

**Status:** the approved design, 2026-09-25. The owner approved it in
discussion and asked for it written ("Yes, write the spec"). This file is the
**authority** for S46a's implementation plan: where a plan task disagrees with
it, the task is wrong until this file changes. Decisions marked **OWNER** are
Jeremy's and are locked.

Read with [`../s46/design-basis.md`](../s46/design-basis.md), which covers the
on-demand frame and the two wake policies, and with the S42a, S42b and S46
sections of [`../hub-topology.md`](../hub-topology.md).

---

## 1. Why

On 2026-09-23 the first Wake-on-LAN trial failed. After 5 minutes asleep, the
Dell was sent every magic-packet variant and never answered
([`../hub-p0-measurements.md`](../hub-p0-measurements.md), P0-1 trial 1). The
sender was verified. The cause is on the Dell and not yet known. The next step
was the owner running a PowerShell snippet and reading his BIOS by hand. He
asked instead:

> *"How do we teach nova to be able to do this? we need nova to be able to
> configure systems for users for her installs onto devices properly."*

What she lacks today:

1. **An agent that can reach the settings.** She has hands on a paired device
   (`device_run`, files, apps), but on Windows the agent runs inside WSL and
   without admin rights, and most of these settings need admin.
2. **The know-how, in code.** Which settings a role depends on, on which OS,
   for which network card and sleep state, currently exists in a snippet in a
   chat.
3. **A way to prove it.** A setting that reads back correctly is not a wake
   that landed.

---

## 2. Decisions

**OWNER, 2026-09-25:**

1. **She sets machines up herself, and the know-how lives in her agent's code,
   not in her prompt.** A small local model only has to choose the fix; the
   code knows the platform. The long tail of requests ("set up my printer")
   stays with skills and `device_run`.
2. **Admin rights come from an admin helper installed with the agent.** One OS
   prompt at install; after that she can apply named fixes remotely. The helper
   accepts only named fixes, never arbitrary commands. (Option A of three; B
   was an OS prompt for every fix, C was never changing admin settings.)
3. **Order:** S42a → S42b, which now also installs the helper → **S46a (this)**
   → S46b (wake in chat). S43a, S43b and S44 follow.
4. **Anything installed or run on a machine is built from the nova directory**
   (`~/workspace/nova` on `main`), never from a worktree.

**Standing rulings that bind this slice:**

- **No approvals** (2026-09-03, `services/core/tests/test_no_approvals.py`). A
  fix that cannot run says *cannot* and why. Nothing asks "may I". At install,
  she applies what the machine's roles need and reports each change with its
  undo.
- **Nova never puts a machine to sleep** (2026-09-18). The proof waits for the
  machine to sleep, on its own or because its owner slept it.
- **A wake is never assumed**, and Wi-Fi wake is measured (2026-09-18).
- **Mechanical over prompts; derived, never hardcoded** (root `CLAUDE.md`).
- **The repo is public.** No MAC, address, username, key or home path in code,
  tests, fixtures or docs.

---

## 3. What S46a delivers

The owner says "make the Dell wakeable". She:

1. reads the Dell's real settings;
2. applies the fixes the wake role needs, reading each one back;
3. tells him the firmware step that only he can do, for that make and model.

When he asks her to test it, she wakes the Dell after it next sleeps and
reports the measured result. Every change is recorded with its previous value
and can be undone. **She cannot say a machine will wake until a wake has landed
after its last change.**

S46a is built so that later families (the stay-awake hold, models, networking)
become rows in the same table, not new machinery. **v1 ships one family:
wake.**

**Not in S46a:**

- waking a machine from a chat turn, and the wait/answer-now policies (S46b);
- the hold (moves to S46b, see §11);
- firmware writes (never);
- wake from shutdown and Fast Startup (reported, not fixed);
- putting a machine to sleep (never).

---

## 4. The shape

```
 her tools (core)          core                               the machine
 machine_status  ─┐   readiness derived from facts      user agent (novad, S42a)
 machine_setup   ─┼─▶ signs a fix envelope ──────────▶  forwards it over a local channel
 machine_undo    ─┤   records machine_changes                    │
 machine_wake    ─┘   runs the wake test                admin helper (novad helper, S42b)
                      relay: the hub-host agent sends    applies the fix, reads it back
```

### 4.1 The setup table, in the agent

- It is compiled into `novad`, per OS, in a new `apps/novad/internal/setup/`:
  `wake_windows.go`, `wake_linux.go`, `wake_darwin.go`, and `fake.go` for
  tests.
- A **family** is a named set of facts and fixes.
  - A **fact** is a read-only probe. It returns a typed value, or `unknown`
    with the reason.
  - A **fix** has:
    - a stable name, such as `wake.magic_packet`;
    - the fact it changes and the target value;
    - `apply`, and `undo(prior)`;
    - whether it needs the helper.
- **The read-back contract.** `apply` returns `{before, after, verified}`.
  - `after` is a **fresh read of the fact**, not the value that was written.
  - `verified` is `after == target`.
  - A write that succeeds but does not read back is reported as
    `verified: false`, never as success.
- **Parameters come from facts.** A fix's target is named by what the
  machine's own facts listed: an adapter's interface id, never a free string
  from her. Commands run as argv, never as a string assembled into a shell line
  or a script.
- Setup facts are reported on connect and on `facts.refresh`, in S42a's facts
  frame.
- **S46a also adds `net.wake` to the agent** (specified in the S46 plan): send
  a magic packet from the host, report *sent*. It is what makes an agent a
  relay (§6).

### 4.2 The admin helper

- **What it is.** The same `novad` binary in `helper` mode, running as a
  system service:
  - Windows: a service running as LocalSystem;
  - macOS: a LaunchDaemon;
  - Linux: a system unit.
- **Install.** S42b's `novad install` installs it, with one OS prompt (UAC, an
  admin password, or sudo). `novad uninstall` removes it.
- **What it does not have:** a network listener, a shell, or a file
  capability.
- **Its one local channel:**
  - Windows: a named pipe whose DACL admits only the installing user's SID and
    SYSTEM.
  - Unix: a socket owned by root, mode `0660`, group of the installing user,
    with the peer's credentials checked.
- **It runs a request only if all of these hold:**
  1. It is a core-signed envelope, using the existing ed25519
     `{envelope, sig}`, verified **in the helper** against the pinned core key.
  2. It is fresh (inside the envelope window) and unused (the replay set).
  3. It names a fix in the helper's compiled table.
  4. Its parameters match the machine's current facts.

  Otherwise it answers *cannot*, with the reason.
- **The user agent only forwards.** It cannot mint a request.
- The helper verifies with the same `wire` package as the agent, so the
  committed envelope vectors pin both.
- **When the helper is absent,** a fix returns
  `cannot: the admin helper is not installed on <machine>`, plus the one
  command that installs it. That states a fact. It gates nothing.

### 4.3 Core

- **Facts** live in S42a's `devices.facts`.
- **Readiness.** `device_facts.py` (S42a) gains
  `wake_readiness(facts) -> {state: ready | not_ready | unknown, items}`.
  - Each item is `{fact, value, needs, fixable_by: nova | owner | none, fix?}`.
  - It is derived from facts on every read and never stored.
- **`machine_changes`**, a new table with one row per applied fix: device,
  family, fix, before, after, verified, turn id, applied_at, undone_at,
  undo_after, undo_verified. It is both the undo list and the audit.
- **`wake_attempts`** and **`machine_overrides`** (MAC and relay overrides)
  move here from S46's planned `038_wake`.
- **Migration.** This slice takes the next free core migration: `037` when this
  was written. S43a's planned `037_network` now lands later and renumbers,
  by the plan's rule that whichever lands second renumbers.
- **Drift.** On every facts report, core compares each verified change that is
  not undone against the fresh fact. A mismatch (say, a driver update reset a
  setting):
  - writes a non-urgent notice, `machine_setup_drift`;
  - makes the machine's wake proof stale.

### 4.4 Her tools

Three new tools, and one changed:

- **`machine_status` (changed).** Per machine, it gains one line per role
  family:
  - readiness;
  - the fixes she can make;
  - the owner's steps;
  - the proof: *never tested*, *landed 14 s after the packet on …*, or
    *configured since; not proven*.
- **`machine_setup(machine, role)`.** `role` is an enum; v1 accepts only
  `["wake"]`.
  - It applies, in a fixed order, every fix the role needs whose fact does not
    already read at its target.
  - It returns one receipt line per fix (before → after, verified or not), then
    the owner's steps, then the proof state.
  - It is idempotent: a second run changes nothing, and says so.
- **`machine_undo(machine, change_id | role)`.** Reverts one change, or every
  live change for a role. It reads each one back and marks the rows.
- **`machine_wake(machine, when = "now" | "next_sleep", times = 1, asleep_min = 5)`.**
  - `now` sends a wake through the relay.
  - `next_sleep` arms a test. It runs once the machine has reported going to
    sleep and has stayed asleep for `asleep_min` minutes.
  - `times` and `asleep_min` apply to `next_sleep` only. `times` repeats the
    test, and each repeat waits for the machine to go back to sleep **on its
    own**.
  - It returns straight away with the armed state. Outcomes arrive as attempt
    rows and a notice, and `machine_status` shows them.
  - S46b reuses the same machinery from the turn flow.

### 4.5 When setup runs

1. **When she is asked:** "make the Dell wakeable" calls `machine_setup`.
2. **After a newly installed agent's first facts report,** for every role the
   machine has. For v1's wake role, a machine has the role when **both** of
   these are derived from live state, never from a flag someone sets:
   - its facts show it can sleep, and it is not the hub;
   - the gateway routes a model to it: an engine on it, or a provider whose
     base URL is one of its addresses.

   A thin client or a laptop that serves no model gets no wake setup. What she
   changed at install is reported as a non-urgent notice and in
   `machine_status`, each change with its undo.

### 4.6 Sleep and wake, as the machine states them

- **Going to sleep.** The agent reports it when the OS announces it:
  - Windows: its suspend/resume notification;
  - macOS: IOKit's system power notifications;
  - Linux: logind's `PrepareForSleep`.
- **Resumed** is reported on the way back.
- **"Asleep" means that statement**, never an inference from silence. A
  machine that drops off without saying so is **offline**, and a wake test
  never starts on an offline machine.
- **Answered** means the machine's agent reconnected to core after the packet.
  **Serving** means its model endpoint answered. Both are timestamped in the
  attempt row. The tailnet probe used for P0-1 stood in for these.

---

## 5. The wake family

A fix is only as good as its read-back on real hardware. **Every mechanism
below is a candidate until it has been read on a real machine.** S46a's first
plan task reads the Dell's values through the S42a agent. Every row that has
not been read on real hardware ships labelled *unwalked* in
`deploy/platform-walks.json`.

### Windows — walked on the Dell

**Facts:**

| Fact | Candidate source |
|---|---|
| Sleep states available (S3, Modern Standby) | `powercfg /a` |
| Adapters: media type, interface id, MAC, status | the NetAdapter cmdlets, or native APIs |
| Whether an adapter is armed to wake the machine | `powercfg /devicequery wake_armed` |
| Wake on magic packet, the Windows setting | `Get-NetAdapterPowerManagement` |
| Wake on magic packet, the driver's own keyword | `Get-NetAdapterAdvancedProperty`, by its standardized registry keyword |
| Hibernate after, on AC | `powercfg /query`, sleep subgroup |
| Network in standby (Modern Standby machines only) | the power setting for networking in standby |
| Last wake source; recent sleep and wake events | `powercfg /lastwake`; the System event log |
| Make, model, BIOS vendor and version | CIM `Win32_ComputerSystem`, `Win32_BIOS` |
| The firmware's wake setting, where the vendor exposes it | the vendor's BIOS WMI, or else `unknown: not readable on this model` |

**Fixes,** all through the helper:

- `wake.nic_can_wake` arms the adapter to wake the machine.
- `wake.magic_packet` covers both layers: the Windows setting and the driver
  keyword.
- `wake.network_in_standby` applies to Modern Standby machines only.
- `wake.no_hibernate_on_ac` turns hibernate-after off on AC while the machine
  is a wake target. A machine that moves from sleep into hibernate leaves the
  state its wake was armed for. Battery settings are not touched.

**Walk-through.** Firmware steps come from `deploy/firmware-steps.json`
(vendor and model → the menu path and the value), with a generic fallback:

- which key opens setup at power-on;
- look for "Wake on LAN/WLAN";
- turn off any deep-sleep setting.

She states these steps; she never performs them. Where a vendor exposes the
setting over WMI, it is read again afterwards to confirm.

**Reported, not fixed in v1:** Fast Startup. It matters only for waking from
shutdown.

### Linux — built and tested, not walked

- **Facts:**
  - `ethtool` wake-on;
  - `iw phy … wowlan show`;
  - NetworkManager's `wake-on-lan` and `wake-on-wlan` for each connection;
  - `/sys/power/mem_sleep`;
  - the DMI make and model.
- **Fixes:** NetworkManager's `wake-on-lan magic` or `wake-on-wlan magic` on
  the active connection, which persists. Without NetworkManager, the fix
  answers *cannot*, with the reason.

### macOS — built and tested, not walked

- **Facts:** `pmset -g` (`womp`), and the active interface.
- **Fix:** `pmset -a womp 1`.
- **Wi-Fi caveat:** a Mac waking over Wi-Fi usually depends on a sleep proxy
  on the network. She says so rather than promising it.

---

## 6. The proof: a wake test

1. **Only when asked, she arms `machine_wake(machine, when="next_sleep")`.**
   Nothing wakes a machine to test it on a schedule of its own.
2. **The machine reports going to sleep.** After `asleep_min`, core asks a
   relay to send the magic packet.
   - The relay is any connected agent whose facts put it in the target's
     subnet. By default that is the hub-host agent (S42b).
   - The request is `net.wake`: signed, and sent from the host so that it
     reaches the LAN.
   - The relay reports *sent*. The attempt row is written only then.
3. **Core waits for *answered*, then *serving*,** up to a deadline:
   - 120 s by default, clamped to 30–600 s;
   - once three attempts have landed, `ceil(1.5 × p90)` of them (design basis
     §5).
4. **The outcome goes on the row:** `ready | no_answer | not_asleep | stopped |
   interrupted`. That is the S46 plan's set, minus the values only a turn can
   produce.
   - A series continues only after the machine goes back to sleep on its own.
   - If it has not done so within 15 minutes, the series pauses and says why.
5. **A proof is fresh only if it landed after the machine's last change.** Any
   later change makes it stale, whether it is one of hers, an undo, or drift.

---

## 7. Honesty controls

| Claim in a reply | Backed only by | Otherwise |
|---|---|---|
| "I enabled / turned on / set / armed X on *machine*" | a `machine_changes` row for that machine and fix, `verified`, written in this turn | corrected to what the read-back showed |
| "*machine* will wake / is set up to wake / wakes from sleep" | a fresh landed wake attempt (§6.5) | corrected to "configured, not proven — ask me to test it" |
| "*machine* woke" | an attempt with outcome `ready` (the S46 plan's `_WOKE_MACHINE`) | corrected |
| a fix that did not run | the tool's own `cannot:` result | — |

- **The new guards run at both guard sites** and must pass the timing sweep:
  guards run in core's event loop, and one once took 15.4 s on an honest reply.
- **`test_no_approvals.py` stays unchanged and green.** The helper's closed
  table is a capability boundary, a *cannot*. It never decides that she *may
  not*.
- **The capability guard needs no edit.** It reads the live registry, so
  registering the tools silences it.

---

## 8. Security: a privileged helper

The helper is the most privileged thing Nova installs, so its boundary is the
design:

- **It executes only compiled fixes.** There is no path from a request to
  arbitrary code.
- **Only core can ask.** The signature is verified in the helper against the
  pinned key. The user agent cannot mint requests, so a compromised user
  session gains nothing it did not already have.
- **Parameters must match** the machine's own current facts.
- **The channel is local only.** There is no listener.
- **Every change is recorded,** in `machine_changes` and in the device audit
  chain.
- **Binaries ship unsigned for now** (owner decision 12, 2026-09-18):
  - the UAC prompt shows an unknown publisher;
  - a machine with Smart App Control on answers *cannot* (P0-20).

---

## 9. Testing

- **Agent:** every fix against `fake.go`:
  - apply;
  - a read-back mismatch is reported unverified;
  - undo restores `before`;
  - parameters that are not in the facts are refused.
- **Helper, on a real pipe or socket:**
  - unsigned, expired, replayed, unknown-fix and foreign-facts requests all
    answer *cannot*;
  - a valid request applies;
  - the Windows pipe's DACL is tested on the Windows runner.
- **Core:**
  - readiness derived per OS from fixture facts;
  - the `machine_changes` lifecycle;
  - drift → a notice and a stale proof;
  - the wake-test state machine, with the fixture plant so no packets are
    sent, including the pause when a machine does not re-sleep.
- **Guards:** every claim in §7, backed and unbacked, plus the timing sweep.
- **Evals,** with the fixture plant; `suite_version` moves up one:
  - `sets-up-a-machine-to-wake-when-asked`
  - `says-configured-not-proven-before-a-wake-lands`
  - `tests-the-wake-when-asked-and-reports-a-miss`
  - `undoes-a-setup-change-when-asked`
- **Pins that move, deliberately, with the reason in the commit:**
  - the tool registry, +3;
  - the eval corpus, +4 cases and `suite_version` +1;
  - `test_settings`, if a settings key is added;
  - `deploy/platform-walks.json`.
- **Gates by hand before every push (CI is off):** core, gateway, memory and
  web, and novad on Linux. The Windows runner joins when CI is back.

---

## 10. The walk — definition of done

The agent and the helper come from the hub's agent-dist, built from the nova
directory at the merge commit (owner decision 4). Both machines' nova
directories are pulled to that commit.

1. **"Nova, make the Dell wakeable."** Read the trace by turn id:
   - `machine_setup` ran;
   - each fix has a receipt with its read-back;
   - she named the Dell's firmware step as his.
2. **He does the firmware step at a reboot.** She reads the settings again and
   says what changed, or that the setting is not readable on this model.
3. **"Test the Dell's wake."**
   - He sleeps the Dell.
   - The agent's going-to-sleep arrives.
   - The attempt row records sent, answered, serving and the outcome.
   - She reports it as measured.
4. **If it lands,** "test it five times" runs the P0-1 schedule without him, as
   long as Windows re-sleeps on its own. **If it never lands,** she says so,
   with the evidence, and the owner question from P0-1's W3 branch is asked.
5. **"Undo the hibernate change."** It reverts and reads back.
6. **The Machines section at 393 px** shows readiness, the changes and the
   proof.

---

## 11. Sequencing, and what moves

- **It depends on S42a:** the native Windows agent, its facts frame, and
  `devices.facts`.
- **It depends on S42b:**
  - install and service;
  - **the admin helper**: its install, its channel, its verification, and one
    diagnostic operation that proves the install end to end;
  - the hub-host agent, which is the relay.
- **The planned S46 splits in two:** S46a (this spec) and S46b (wake in chat:
  the turn flow, wait and answer-now, the interim model, the hold).
- **The hold moves from S44 to S46b.** A Windows machine woken over the network
  goes back to sleep within minutes unless something holds it, so wake in chat
  cannot ship without it.
- **P0-1 now gates S46b, not S46a.** On a machine that cannot wake, S46a's
  correct output is an honest *cannot*, with the evidence.

---

## 12. Open, and not blocking the plan

1. Whether this Dell can wake over Wi-Fi from its sleep state at all. The walk
   measures it.
2. The Linux helper: a root system unit, or polkit rules scoped to
   NetworkManager. The plan chooses.
3. Which firmware steps ship beyond the Dell's, which the walk verifies, and
   the wording of the generic fallback.
