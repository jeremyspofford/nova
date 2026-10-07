# S46a: machine setup — the spec

**Status:** the approved design, 2026-09-25, **amended 2026-10-06**. The owner
approved it in discussion and asked for it written ("Yes, write the spec"); on
2026-10-06 he approved the amendments in §2 (decisions 5 to 11) and asked for
them written in ("yes, write it into the spec"). This file is the **authority**
for S46a's implementation plan: where a plan task disagrees with it, the task
is wrong until this file changes. Decisions marked **OWNER** are Jeremy's and
are locked.

**What the amendment changed:** setup runs at install on **every device that
can be woken**, not only machines that serve a model (§4.5); she changes
**firmware settings herself where the maker lets software change them**, and
walks the user through them where it does not (§5.4); the user's steps come
from **proven steps, then the maker's manual for that exact model, then
generic steps** (§5.5); admin rights come from the **standing admin path
(S30b)**, not the admin helper (§4.2, §8); a machine that cannot wake on its
network gets an honest *cannot* with its options (§6.6); and the order moved
(§11).

Read with [`../s46/design-basis.md`](../s46/design-basis.md), which covers the
on-demand frame and the two wake policies, with the S42a, S42b and S46
sections of [`../hub-topology.md`](../hub-topology.md), and with S30b in
[`../doing-things.md`](../doing-things.md), the admin path this slice now runs
its changes through.

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
   without admin rights, and most of these settings need admin. *(2026-10-06:
   S42a has since shipped the native Windows agent; admin rights are still
   missing until S30b.)*
2. **The know-how, in code.** Which settings a role depends on, on which OS,
   for which network card and sleep state, currently exists in a snippet in a
   chat.
3. **A way to prove it.** A setting that reads back correctly is not a wake
   that landed.

**Found 2026-10-05,** when the owner asked why v4 cannot wake the Dell when
v0.1.0-alpha could:

- **v1 woke the Dell through its Ethernet port.** v1 sent the magic packet from
  its gateway whenever the Dell's Ollama did not answer. The MAC in v1's saved
  wake settings carries the Dell Inc. vendor prefix and matches the adapter
  the Windows agent reports as "Ethernet". The 09-23 trial targeted the Intel
  Wi-Fi adapter.
- **That port has had no link since at least 2026-09-18**
  ([`../hub-topology.md`](../hub-topology.md), measured facts), and the
  agent's last network fact shows it down. **The owner chose to stay on
  Wi-Fi** (decision 5).
- **The XPS 8950's firmware offers no Wi-Fi wake setting.** Dell's service
  manual lists none under Power Options, and owners' reports show only "Wake
  Up by Integrated LAN", a wired option. Windows does list the Wi-Fi card as
  armed to wake (2026-09-18), so whether this Dell can wake over Wi-Fi is
  measured by the walk, not assumed (§12).
- **v4 sends no magic packet anywhere.** The gateway's `wake_on_lan`
  lifecycle only stops it probing an engine. No tool or service sends a wake,
  and her only live agent is on the Dell itself.

The owner's answer, 2026-10-06: *"Can that be part of the setup of a nova agent
on compatible devices, to setup the WoL as much as possible and walk the user
how to do any of the steps to do by the user for their specific device, such
as bios if nova cannot start and modify bios on devices"*. Decisions 6 to 11
are what that became.

---

## 2. Decisions

**OWNER, 2026-09-25:**

1. **She sets machines up herself, and the know-how lives in her agent's code,
   not in her prompt.** A small local model only has to choose the fix; the
   code knows the platform. The long tail of requests ("set up my printer")
   stays with skills and `device_run`.
2. ~~**Admin rights come from an admin helper installed with the agent.** One OS
   prompt at install; after that she can apply named fixes remotely. The helper
   accepts only named fixes, never arbitrary commands. (Option A of three; B
   was an OS prompt for every fix, C was never changing admin settings.)~~
   **Superseded.** On 2026-09-30 the owner paused the helper (S42c) and chose
   a standing admin path instead (S30b, `doing-things.md` Q17), which runs any
   command as admin. Decision 9 puts this slice on it.
3. ~~**Order:** S42a → S42b, which now also installs the helper → **S46a
   (this)** → S46b (wake in chat). S43a, S43b and S44 follow.~~
   **Superseded** by decision 10.
4. **Anything installed or run on a machine is built from the nova directory**
   (`~/workspace/nova` on `main`), never from a worktree.

**OWNER, 2026-10-05 and 2026-10-06** (§1 has the question that led here):

5. **The Dell stays on Wi-Fi.** No cable is added to make its wake work.
6. **Wake setup is part of every agent's setup, on every device that can be
   woken**, not only machines that serve a model. The hub is never set up: it
   is always on. (§4.5)
7. **Firmware: she changes the setting herself where the maker lets software
   change it, and walks the user through it where it does not.** (§5.4)
8. **The user's steps for their exact model come from, in order: steps already
   proven on that model, then the maker's manual for that exact model (cited),
   then generic steps.** A walk-through that ends in a landed wake is saved as
   that model's proven steps. (§5.5)
9. **Admin rights come from the standing admin path, S30b,** which moves ahead
   of this slice. (§4.2)
10. **Order:** S42b → provider balances → S30b → **S46a (this)** → S46c (the
    camera guide) → the doing lane resumes at S29. S46b stays paused. (§11)
11. **S46c, the camera guide, is its own slice, right after this one:** a
    dedicated guide agent that walks a user through steps on a device Nova
    cannot see, the BIOS first, through the phone's camera. One photo per step,
    with live video as an option. It runs on a local model when one that can do
    it is awake (the hub's or any engine's), and on a cloud model otherwise. It
    gets its own spec. (§11)

**Approved with the design, 2026-10-06** (they were in the design section the
owner approved):

- **Nova never restarts a machine herself,** just as she never puts one to
  sleep. A firmware change waits for the machine's next restart, and she says
  so.
- **BitLocker is suspended only when that machine's BitLocker checks firmware
  settings,** and then for one restart. (§5.4)
- **A machine that cannot wake on its network** gets an honest *cannot*, the
  evidence, and the options that would work for it. She does not pick one.
  (§6.6)

**Standing rulings that bind this slice:**

- **No approvals** (2026-09-03, `services/core/tests/test_no_approvals.py`). A
  fix that cannot run says *cannot* and why. Nothing asks "may I". At install,
  she applies what the machine's roles need and reports each change with its
  undo.
- **Nova never puts a machine to sleep** (2026-09-18), **or restarts it**
  (2026-10-06). The proof waits for the machine to sleep, on its own or
  because its owner slept it; a firmware change waits for a restart the same
  way.
- **A wake is never assumed**, and Wi-Fi wake is measured (2026-09-18).
- **Mechanical over prompts; derived, never hardcoded** (root `CLAUDE.md`).
- **The repo is public.** No MAC, address, username, key or home path in code,
  tests, fixtures or docs.

---

## 3. What S46a delivers

*(Amended 2026-10-06.)* A Nova agent is installed on a device that can be
woken, or the owner says "make the Dell wakeable". She:

1. reads the device's real settings, in the operating system and, where the
   maker exposes them, in the firmware;
2. applies the fixes the wake role needs, reading each one back. Operating
   system settings take effect at once. Firmware settings, where the maker
   lets software change them, take effect at the next restart, and she says
   so;
3. tells the user the steps only they can do, for that make and model: a
   firmware setting the maker does not let software change, a firmware (BIOS)
   password she does not hold, or an operating system change when no admin
   path is installed.

When he asks her to test it, she wakes the machine after it next sleeps and
reports the measured result. When he asks her to wake it, she sends a wake
through the relay and reports what came back. Every change is recorded with its
previous value and can be undone. **She cannot say a machine will wake until a
wake has landed after its last change.** A machine that cannot wake on the
network it is on gets an honest *cannot*, the evidence, and the options that
would work for it (§6.6).

S46a is built so that later families (the stay-awake hold, models, networking)
become rows in the same table, not new machinery. **v1 ships one family:
wake.**

**Not in S46a:**

- waking a machine from a chat turn, and the wait/answer-now policies (S46b);
- the hold (moves to S46b, see §11);
- the camera guide (S46c, see §11);
- firmware: any setting outside the wake family, and any firmware update
  (never); on a machine whose maker exposes no supported interface, a
  walk-through instead of a write (§5.5);
- wake from shutdown and Fast Startup (reported, not fixed);
- putting a machine to sleep or restarting it (never).

---

## 4. The shape

```
 her tools (core)          core                               the machine
 machine_status  ─┐   readiness derived from facts      user agent (novad, S42a)
 machine_setup   ─┼─▶ signs a setup request ─────────▶  runs the compiled fix
 machine_undo    ─┤   records machine_changes                    │ elevated when it must be
 machine_wake    ─┘   runs the wake test; finds steps   standing admin path (S30b)
                      relay: the hub-host agent sends    applies it, reads it back
```

*(Amended 2026-10-06: the admin helper is replaced by S30b's standing admin
path, and core finds the user's steps, §5.5.)*

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
    - whether it needs the admin path *(was: the helper; amended 2026-10-06)*;
    - its kind: `os`, which takes effect at once, or `firmware`, which takes
      effect at the next restart (§5.4).
- **The read-back contract.** `apply` returns `{before, after, verified}`.
  - `after` is a **fresh read of the fact**, not the value that was written.
  - `verified` is `after == target`.
  - A write that succeeds but does not read back is reported as
    `verified: false`, never as success.
  - For a `firmware` fix, `after` is the value the firmware reports as
    pending, and the result carries `pending_restart: true`. It is verified
    only when a facts report after the next restart reads it as current
    (§4.3).
- **Parameters come from facts.** A fix's target is named by what the
  machine's own facts listed: an adapter's interface id, never a free string
  from her. Commands run as argv, never as a string assembled into a shell line
  or a script.
- Setup facts are reported on connect and on `facts.refresh`, in S42a's facts
  frame.
- **S46a also adds `net.wake` to the agent** (specified in the S46 plan): send
  a magic packet from the host, report *sent*. It is what makes an agent a
  relay (§6).

### 4.2 Admin rights: the standing admin path *(amended 2026-10-06)*

The admin helper this section used to specify is not built: the owner paused
it on 2026-09-30 (S42c) and chose S30b's standing admin path instead. What
replaces it:

- **What runs elevated.** A fix that needs admin runs through S30b's standing
  admin path on that machine: the elevated service the agent drives on
  Windows, and on Linux and macOS whatever S30b installs there. S46a adds no
  channel of its own.
- **The named fixes stay, as the know-how, not as a boundary.** S30b runs any
  command as admin, so the compiled table no longer keeps anything out. The
  owner dropped that boundary on 2026-09-30 (`doing-things.md`, Q17). What the
  table still does is make setup mechanical: a fixed order, parameters from
  facts, a read-back and an undo for every fix. `machine_setup` runs only the
  table. Anything else she does as admin goes through `device_run(elevated)`
  and is recorded the way S30b records it.
- **Every elevated fix is a span with `elevated: true`** and the machine, as
  S30b requires.
- **When the path is not installed,** a fix that needs it returns
  `cannot: no admin path on <machine>`, and the change becomes one of the
  user's steps (§5.5), with the same read-back once they have done it. That
  states a fact. It gates nothing.
- **On Windows, S46a needs S30b's path to be a service,** not a scheduled
  task. Only a service receives Windows' pre-shutdown notice, and §5.4
  suspends BitLocker there, just before the restart, instead of when the
  firmware change is written.

### 4.3 Core

- **Facts** live in S42a's `devices.facts`.
- **Readiness.** `device_facts.py` (S42a) gains
  `wake_readiness(facts) -> {state: ready | not_ready | unknown, items}`.
  - Each item is `{fact, value, needs, fixable_by: nova | owner | none, fix?}`.
  - It is derived from facts on every read and never stored.
- **`machine_changes`**, a new table with one row per applied fix: device,
  family, fix, before, after, verified, turn id, applied_at, undone_at,
  undo_after, undo_verified. It is both the undo list and the audit.
  *(Amended 2026-10-06.)* It also records:
  - the fix's kind, `os` or `firmware`;
  - for a firmware change, `pending_restart_since`. The change is *pending*
    until the first facts report whose boot time is later than the write
    (§4.6). That report's reading sets `verified`;
  - what was decided about BitLocker for it: not on, not needed (the profile
    does not check firmware settings), or suspended for one restart, and
    whether the suspend ran (§5.4).
- **`machine_steps`** *(new, 2026-10-06)*: steps proven on a model. Key: the
  maker and model as the machine's facts read them, and the family. Value:
  the steps, the firmware version they were proven on, and the wake attempt
  that proved them. Core writes a row when a wake lands on a machine after she
  gave its user firmware steps from the manual or the generic fallback (§5.5).
  It starts empty: nothing is seeded by hand.
- **`wake_attempts`** and **`machine_overrides`** (MAC and relay overrides)
  move here from S46's planned `038_wake`.
- **Migration.** This slice takes the next free core migration when its plan
  is written (`037` when this was first written; by 2026-10-06 main had
  reached `038` with S37a's `mcp_servers`, and S42b adds `039`). Whichever
  lands second renumbers.
- **Drift.** On every facts report, core compares each verified change that is
  not undone against the fresh fact. A mismatch (say, a driver update reset a
  setting):
  - writes a non-urgent notice, `machine_setup_drift`;
  - makes the machine's wake proof stale.

  A firmware change still pending a restart is not checked for drift; it is
  checked from the report that verifies it.

### 4.4 Her tools

Three new tools, and one changed:

- **`machine_status` (changed).** Per machine, it gains one line per role
  family:
  - readiness;
  - the fixes she can make;
  - the user's steps, each with its source: *proven on this model*, *the
    maker's manual* with its link, or *generic* (§5.5);
  - changes waiting on a restart *(2026-10-06)*;
  - the proof: *never tested*, *landed 14 s after the packet on …*, or
    *configured since; not proven*.
- **`machine_setup(machine, role)`.** `role` is an enum; v1 accepts only
  `["wake"]`.
  - It applies, in a fixed order, every fix the role needs whose fact does not
    already read at its target.
  - It returns one receipt line per fix (before → after, verified or not), then
    the user's steps, then the proof state. A firmware fix's line reads *set;
    takes effect at the next restart*, with what was decided about BitLocker.
  - It is idempotent: a second run changes nothing, and says so.
- **`machine_undo(machine, change_id | role)`.** Reverts one change, or every
  live change for a role. It reads each one back and marks the rows. Undoing a
  firmware change writes the prior value the same way, and it too waits for a
  restart.
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

### 4.5 When setup runs *(amended 2026-10-06)*

1. **When she is asked:** "make the Dell wakeable" calls `machine_setup`.
2. **After a newly installed agent's first facts report, on every device that
   can be woken** (decision 6). A device can be woken when its live facts
   show **both** of these, never a flag someone sets:
   - a sleep state it enters: S3 or Modern Standby on Windows, suspend to RAM
     on Linux (`/sys/power/mem_sleep`), sleep on macOS;
   - at least one network adapter that reports it can wake the machine.

   **The hub is never set up**: its agent's facts say it is the hub, and it is
   always on. A laptop is set up like any other device, but a setting that has
   separate plugged-in and battery values is changed only for plugged-in (AC);
   battery values are never touched.
   What she changed at install is reported as a non-urgent notice and in
   `machine_status`, each change with its undo.

   *(Before 2026-10-06 a machine also had to serve a model: an engine on it, or
   a provider whose base URL is one of its addresses. That condition is gone,
   so a machine she only runs jobs on can be woken too.)*

### 4.6 Sleep and wake, as the machine states them

- **Going to sleep.** The agent reports it when the OS announces it:
  - Windows: its suspend/resume notification;
  - macOS: IOKit's system power notifications;
  - Linux: logind's `PrepareForSleep`.
- **Resumed** is reported on the way back.
- **Restarted** *(2026-10-06)*: the agent's facts carry the operating system's
  boot time. A facts report with a boot time later than a pending firmware
  change is what verifies that change (§4.3).
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

### 5.1 Windows — walked on the Dell

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
| Boot time *(2026-10-06)* | CIM `Win32_OperatingSystem.LastBootUpTime` |
| Whether the maker lets software read and change firmware settings, and the wake settings it exposes, with their possible values *(2026-10-06; replaces "the firmware's wake setting")* | Dell: the BIOS WMI under `root\dcim\sysman`; HP: `root\HP\InstrumentedBIOS` (`HP_BIOSEnumeration`, `HP_BIOSSettingInterface`); Lenovo: `root\wmi` (`Lenovo_BiosSetting`, `Lenovo_SetBiosSetting`, `Lenovo_SaveBiosSettings`); otherwise `unknown: not readable on this model` |
| Whether a firmware setup password is set *(2026-10-06)* | the same interfaces' password objects (`HP_BIOSPassword`, `Lenovo_BiosPasswordSettings`, Dell's WMI security objects) |
| BitLocker on the system volume: on or off, and the TPM protector's validation profile *(2026-10-06)* | `manage-bde -protectors -get` for the system volume (admin) |

**Fixes** (kind `os`), all through the admin path *(was: the helper)*:

- `wake.nic_can_wake` arms the adapter to wake the machine.
- `wake.magic_packet` covers both layers: the Windows setting and the driver
  keyword.
- `wake.network_in_standby` applies to Modern Standby machines only.
- `wake.no_hibernate_on_ac` turns hibernate-after off on AC while the machine
  is a wake target. A machine that moves from sleep into hibernate leaves the
  state its wake was armed for. Battery settings are not touched.

**Firmware** (kind `firmware`, 2026-10-06): written where the maker allows
it (§5.4); everything else the user does, from the steps in §5.5. The
`deploy/firmware-steps.json` this section used to name is not built: §5.5
replaces it.

**Reported, not fixed in v1:** Fast Startup. It matters only for waking from
shutdown.

### 5.2 Linux — built and tested, not walked

- **Facts:**
  - `ethtool` wake-on;
  - `iw phy … wowlan show`;
  - NetworkManager's `wake-on-lan` and `wake-on-wlan` for each connection;
  - `/sys/power/mem_sleep`;
  - the DMI make and model;
  - *(2026-10-06)* the kernel's firmware-attributes class, where the maker's
    driver provides it (Dell, HP and Lenovo):
    `/sys/class/firmware-attributes/*/attributes/*/` (`current_value`,
    `possible_values`), `attributes/pending_reboot`, and
    `authentication/*/is_enabled` for a firmware password.
- **Fixes:** NetworkManager's `wake-on-lan magic` or `wake-on-wlan magic` on
  the active connection, which persists. Without NetworkManager, the fix
  answers *cannot*, with the reason. Firmware settings, where the class is
  present, are written to `current_value` as root (§5.4).

### 5.3 macOS — built and tested, not walked

- **Facts:** `pmset -g` (`womp`), and the active interface.
- **Fix:** `pmset -a womp 1`. A Mac has no firmware wake setting to change or
  walk through.
- **Wi-Fi caveat:** a Mac waking over Wi-Fi usually depends on a sleep proxy
  on the network. She says so rather than promising it.

### 5.4 Firmware, where the maker allows it *(new, 2026-10-06; decision 7)*

- **Which machines.** Those whose facts show a maker interface that lets
  software change firmware settings: the Windows rows in §5.1 and the Linux
  class in §5.2. On every other machine, the firmware part of setup is a
  walk-through (§5.5).
- **Which settings.** Only the wake family's, compiled per maker in the
  agent's table: wake on LAN, wake on WLAN where the firmware has it, and the
  deep-sleep setting that blocks wake. The names and values are the maker's
  own, checked against the machine's `possible_values` before every write,
  never assumed. Nothing outside the family is written, and a firmware update
  never is.
- **A firmware password is set:** the fix returns
  `cannot: the firmware has a setup password`, and the change becomes one of
  the user's steps. She never asks for, holds or stores a firmware password.
- **BitLocker.** Before a firmware fix she reads the system volume's BitLocker
  state.
  - A firmware setting change alters PCR 1 ("Core System Firmware data").
    BitLocker's default profiles do not check PCR 1: PCR 7 and 11 when Secure
    Boot is used for integrity, otherwise PCR 0, 2, 4 and 11 (Microsoft,
    "Configure BitLocker"). Under those, nothing is suspended.
  - If BitLocker is on and its profile includes PCR 1, or the profile cannot
    be read, the admin path suspends BitLocker for one restart. It does this
    **at Windows' pre-shutdown notice** (§4.2), not when the change is
    written, so the drive is not left unprotected while the change waits.
  - A restart that skips pre-shutdown (a crash, a power cut) can stop at the
    recovery-key prompt on such a machine. The receipt says so.
  - The receipt states what was read and what was done, and the change row
    records it (§4.3).
  - **Linux:** a root disk unlocked by the TPM (`systemd-cryptenroll`) is read
    the same way. If its policy includes PCR 1, setup leaves the firmware
    setting to the user, with the reason: there is no suspend-for-one-restart
    there.
- **Pending until a restart.** The read-back right after the write is the
  firmware's pending value, so the receipt says *set; takes effect at the next
  restart*. The change is verified when the first facts report after a
  restart reads it as current. If it reads otherwise, the row is marked
  unverified, and she says what she read.
- **She never restarts the machine.** `machine_status` shows the change
  waiting on a restart until one happens.
- **Undo** writes the prior value the same way, and it too waits for a
  restart.
- **Walked only where the hardware exists.** The owner's Dell is a consumer
  model, and whether it exposes Dell's interface at all is open (§12). Until a
  firmware write has been walked on a real machine, the firmware rows ship
  labelled *unwalked* in `deploy/platform-walks.json`.

### 5.5 The user's steps, for their exact model *(new, 2026-10-06; decision 8)*

What the user has to do themselves comes as steps for that make and model:
a firmware setting the maker does not let software change, a firmware
password she does not hold, or an operating system change when no admin path
is installed. The steps come from the first of these that has them:

1. **Proven steps for that model** (`machine_steps`, §4.3): steps that ended
   in a landed wake on a machine of the same maker and model. Shown with when
   and on which firmware version they were proven.
2. **The maker's manual for that exact model.** Core searches the web for
   the maker's documentation for that model, using the maker and model from
   the facts, through the same search and fetch her web tools use (the
   stack's searxng), and fetches it.
   - **The quoted steps are the manual's own words.** Code takes the passage
     around the setting's name from the fetched page, verbatim, with the
     link. No model writes them.
   - **The source is labelled.** A page from a site that is not recognisably
     the maker's (derived from the maker's name and the page's host, not a
     list) is labelled as such.
   - **A manual that shows no such setting is a finding, not a gap.** The
     XPS 8950's lists no Wi-Fi wake setting. She says the maker's manual for
     that model lists none and links it, and §6.6 takes over from there.
3. **Generic steps,** labelled generic: which key opens setup at power-on
   (from the maker, where known), look for "Wake on LAN/WLAN", and turn off any
   deep-sleep setting.

- **She states these steps; she never performs them.** Where the setting is
  readable, she reads it again after the user's restart and says what changed
  (§10, step 2).
- **When a wake lands** after she gave a machine's user steps from the manual
  or the generic fallback, core saves them as that model's proven steps
  (§4.3).
- **S46c walks the same steps with the user through the phone's camera.**
  §5.5 is its input (§11).

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
   A firmware change counts from the restart that applies it.
6. **When a machine cannot wake on its network** *(new, 2026-10-06)*.
   - **The rule, mechanical:** every setting she can read for the adapter the
     machine is on reads at its target, and at least three tests, each after
     at least 5 minutes asleep and with no change between them, all ended
     `no_answer`. The plan sets the exact count. Then readiness reads
     `cannot` for wake on that adapter.
   - **A firmware step she cannot read** is part of the evidence, never
     hidden: either the maker's manual lists no such setting for that medium
     (§5.5), or the *cannot* says plainly that it assumes the user's firmware
     step was done, because she cannot read it on this model.
   - **The evidence goes with it:** the settings as read, what the maker's
     interface or manual offers for that medium (or that it offers nothing),
     and the attempts.
   - **The options come from the machine's own facts,** and she lists them
     without picking one (P0-1's W3 branch is the owner's question):
     - **A wired connection,** when the machine has an Ethernet adapter, named,
       with whether it has a link now.
     - **A smart plug,** when the firmware has a "power on when power returns"
       setting (Dell's "AC Recovery"). The machine then shuts down instead of
       sleeping, and a power cycle starts it. Switching a plug is not
       something she can do today, and she says so.
     - **Leaving it on.**

---

## 7. Honesty controls

| Claim in a reply | Backed only by | Otherwise |
|---|---|---|
| "I enabled / turned on / set / armed X on *machine*" | a `machine_changes` row for that machine and fix, `verified`, written in this turn | corrected to what the read-back showed |
| "*machine* will wake / is set up to wake / wakes from sleep" | a fresh landed wake attempt (§6.5) | corrected to "configured, not proven — ask me to test it" |
| "*machine* woke" | an attempt with outcome `ready` (the S46 plan's `_WOKE_MACHINE`) | corrected |
| a fix that did not run | the tool's own `cannot:` result | — |
| *(2026-10-06)* "I changed / set / turned on *firmware setting* on *machine*" | a `machine_changes` row of kind `firmware` for that machine, written in this turn | corrected to what the read-back showed |
| *(2026-10-06)* "*firmware setting* is on / enabled" while its change is pending | a verified row, read after a restart | corrected to "set; takes effect at the next restart" |
| *(2026-10-06)* "I suspended BitLocker" / "BitLocker is suspended" | the change row's BitLocker record, and the suspend having run | corrected to what the row shows |
| *(2026-10-06)* a quoted menu path or setting name from a maker's manual | the text of the page it cites, as fetched for this machine | the quote is dropped, and the reply says the manual did not show it |
| *(2026-10-06)* "*machine* cannot wake over Wi-Fi / on its network" | §6.6's rule holding for that machine and adapter | corrected to "not proven either way" |

- **The new guards run at both guard sites** and must pass the timing sweep:
  guards run in core's event loop, and one once took 15.4 s on an honest reply.
- **`test_no_approvals.py` stays unchanged and green.** A missing admin path, a
  firmware password and a model with no firmware interface each produce a
  stated *cannot*. None decides that she *may not*. *(Amended 2026-10-06: this
  bullet used to name the helper's closed table.)*
- **The capability guard needs no edit.** It reads the live registry, so
  registering the tools silences it.

---

## 8. Security *(rewritten 2026-10-06: the helper is replaced by S30b)*

- **The admin surface is S30b's,** and the owner accepted it on 2026-09-30
  (`doing-things.md`, Q17): a core compromise is admin on every machine with
  the path, and the Devices page says so. S46a adds no channel of its own.
- **Firmware writes are the reach this slice adds to setup.** Setup writes
  only the wake family's settings, named in the compiled table, with values
  checked against the machine's own `possible_values`. It never writes Secure
  Boot, the TPM, boot order or passwords, and it never updates firmware. The
  table bounds what setup does. It does not bound what an admin path can do,
  and this section does not pretend otherwise.
- **BitLocker** is suspended only under §5.4's rule, only at pre-shutdown, and
  only for one restart.
- **She never sees or stores a firmware password.**
- **Requests stay signed.** Core's setup request reaches the agent as the
  existing ed25519 `{envelope, sig}`, verified against the pinned core key,
  fresh and unused. Its parameters must match the machine's current facts.
- **Every change is recorded,** in `machine_changes` and in the device audit
  chain.
- **Binaries ship unsigned for now** (owner decision 12, 2026-09-18):
  - the UAC prompt (now S30b's install) shows an unknown publisher;
  - a machine with Smart App Control on answers *cannot* (P0-20).

---

## 9. Testing

- **Agent:** every fix against `fake.go`:
  - apply;
  - a read-back mismatch is reported unverified;
  - undo restores `before`;
  - parameters that are not in the facts are refused.
  - *(2026-10-06)* firmware fixes, per maker, against fakes of each interface:
    the pending read-back, a value outside `possible_values` refused, a
    firmware password answering *cannot*, the BitLocker rule (PCR 1 in the
    profile, not in it, unreadable), and an undo that is pending too.
- **Admin path** *(replaces the helper tests, 2026-10-06)*: S30b's own tests
  cover its elevated runner. S46a tests that a fix needing admin goes through
  it, carries `elevated: true`, and answers
  `cannot: no admin path on <machine>` when the path is absent. The
  BitLocker suspend is tested in the service's pre-shutdown handler with a
  simulated notice; a real restart is walked, not run on CI.
- **Core:**
  - readiness derived per OS from fixture facts;
  - the `machine_changes` lifecycle;
  - drift → a notice and a stale proof;
  - the wake-test state machine, with the fixture plant so no packets are
    sent, including the pause when a machine does not re-sleep.
  - *(2026-10-06)* which devices get setup: every device that can be woken,
    never the hub, and a laptop's battery settings never touched;
  - a pending firmware change verified by the first facts with a later boot
    time, unverified when that report reads otherwise, and never drift-checked
    while pending;
  - the steps chain in its order, with the manual lookup run against recorded
    fixture pages, never the live web; the verbatim passage; and the label for
    a page that is not the maker's;
  - `machine_steps` written when a wake lands after manual or generic steps,
    and never otherwise;
  - §6.6's *cannot* rule, and the options derived from fixture facts.
- **Guards:** every claim in §7, backed and unbacked, plus the timing sweep.
  The manual-quote check runs against long pages as well as long replies.
- **Evals,** with the fixture plant; `suite_version` moves up one:
  - `sets-up-a-machine-to-wake-when-asked`
  - `says-configured-not-proven-before-a-wake-lands`
  - `tests-the-wake-when-asked-and-reports-a-miss`
  - `undoes-a-setup-change-when-asked`
  - *(2026-10-06)* `says-a-firmware-change-waits-for-a-restart`
  - *(2026-10-06)* `gives-the-makers-manual-steps-with-the-link`
  - *(2026-10-06)* `says-a-machine-cannot-wake-on-its-network-with-the-evidence`
- **Pins that move, deliberately, with the reason in the commit:**
  - the tool registry, +3;
  - the eval corpus, +7 cases and `suite_version` +1;
  - `test_settings`, if a settings key is added;
  - `deploy/platform-walks.json`.
- **Gates:** CI (`rebuild-ci`, active again since 2026-09-30) runs core,
  gateway, memory and web, and every novad leg including native Windows, on
  each push. *(Amended 2026-10-06: this line used to say CI was off and the
  gates were by hand.)*

---

## 10. The walk — definition of done

The agent comes from the hub's agent-dist, built from the nova directory at
the merge commit (owner decision 4). Both machines' nova directories are pulled
to that commit. *(Amended 2026-10-06: S30b's admin path is installed on the
Dell; there is no helper. The walk now starts at install.)*

1. **Install, unasked.** A fresh agent install on the Dell, through S42b's
   flow. Setup runs after its first facts report without anyone asking. Read
   the trace by its id (an install-time run gets its own, as a scheduled turn
   does):
   - `machine_setup` ran from the install;
   - each operating system fix has a receipt with its read-back;
   - the BitLocker reading, and what was decided;
   - the firmware part: whether the XPS 8950 exposes Dell's interface. If it
     does not, the user's steps come from §5.5. On this model that is Dell's
     manual, cited, which lists no Wi-Fi wake setting.
2. **"Nova, make the Dell wakeable."** Setup runs again and changes nothing,
   and she says so. She names any firmware step as his.
3. **He does any firmware step at a restart.** She reads the settings again
   and says what changed, or that the setting is not readable on this model.
4. **"Test the Dell's wake."**
   - He sleeps the Dell.
   - The agent's going-to-sleep arrives.
   - The attempt row records sent, answered, serving and the outcome.
   - She reports it as measured.
5. **If it lands,** "test it five times" runs the P0-1 schedule without him, as
   long as Windows re-sleeps on its own. **If it never lands,** §6.6 applies:
   she says the Dell cannot wake on Wi-Fi, gives the evidence, and lists its
   options (its Ethernet adapter and whether it has a link, a smart plug with
   AC Recovery, leaving it on). The owner question from P0-1's W3 branch is
   asked.
6. **"Undo the hibernate change."** It reverts and reads back.
7. **A firmware write is walked on a machine whose maker allows it,** when one
   is available. Until then the firmware rows ship *unwalked* (§5.4).
8. **The Machines section at 393 px** shows readiness, the changes (and those
   waiting on a restart), the steps with their sources, and the proof.

---

## 11. Sequencing, and what moves

- **Order (OWNER, 2026-10-06, decision 10):** S42b → provider balances → S30b
  → **S46a** → S46c → the doing lane from S29. S46b stays paused.
- **It depends on S42a:** the native Windows agent, its facts frame, and
  `devices.facts`.
- **It depends on S42b:**
  - install and service;
  - ~~**the admin helper**: its install, its channel, its verification, and one
    diagnostic operation that proves the install end to end;~~ not built: the
    helper (S42c) was paused on 2026-09-30, and S30b replaces it;
  - the hub-host agent, which is the relay.
- **It depends on S30b** *(2026-10-06)*: the standing admin path, as a service
  on Windows (§4.2).
- **S30b moves ahead of S30.** In `doing-things.md` it waited on S30's jobs,
  because an install outlives a turn. Ahead of S30, its elevated `device_run`
  runs inside a turn, and an install that outlives one waits for S30's jobs.
  `doing-things.md` records the move.
- **The planned S46 splits in three:** S46a (this spec), S46b (wake in chat:
  the turn flow, wait and answer-now, the interim model, the hold) and S46c
  (the camera guide, below).
- **The hold moves from S44 to S46b.** A Windows machine woken over the network
  goes back to sleep within minutes unless something holds it, so wake in chat
  cannot ship without it.
- **P0-1 now gates S46b, not S46a.** On a machine that cannot wake, S46a's
  correct output is an honest *cannot*, with the evidence.
- **S46c, the camera guide** *(OWNER, 2026-10-06, decision 11; it gets its own
  spec)*:
  - **A dedicated guide agent:** an agent row (`agents.py`), with its own
    instructions, tool subset and route `agent_<name>`. It walks a user through
    steps on a device Nova cannot see. First: §5.5's firmware steps, while the
    PC is in its firmware setup and its agent is off.
  - **The phone's camera, from the PWA:** one photo per step, with live video
    as an option.
  - **Local first:** it runs on a local model that can do the job when one is
    awake, the hub's or any engine's, and on a cloud model otherwise. Which
    models can is derived from the catalogue's capabilities, never a list, as
    S28's `vision.py` does. The reply says which model saw the picture
    (S28's rule).
  - **A photo of the device's label is not needed where an agent runs.** The
    agent reads the make, model and serial itself. A photo helps only for a
    device with no agent.
  - **Its proof is S46a's:** the setting read back where it is readable, and a
    wake that lands.

---

## 12. Open, and not blocking the plan

1. Whether this Dell can wake over Wi-Fi from its sleep state at all. Its
   firmware offers no Wi-Fi wake setting (§1). The walk measures it, and §6.6
   says what happens if it cannot.
2. ~~The Linux helper: a root system unit, or polkit rules scoped to
   NetworkManager. The plan chooses.~~ The Linux admin path is S30b's choice.
3. ~~Which firmware steps ship beyond the Dell's, which the walk verifies, and
   the wording of the generic fallback.~~ Replaced by §5.5. Still open: how
   often the manual lookup finds the right manual and passage for common
   makers (measured by the eval cases on recorded pages, and on the walk), and
   the wording of the generic fallback.
4. *(2026-10-06)* Whether the XPS 8950, a consumer model, exposes Dell's
   firmware interface at all. The plan's first task reads it.
5. *(2026-10-06)* A plug she can switch, for §6.6's smart-plug option, is not
   designed anywhere. If the owner picks that option for a machine, it is a new
   slice.
