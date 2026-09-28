# S42b: design inputs

**Status:** research for the owner, 2026-09-28, read at `d9cfadde` (main, with
S42a merged). This is **not a plan and not a spec**. Nothing here is decided
until the owner answers the six questions below. Sources are cited as
`file:line`, relative to `docs/plans/rebuild/` unless a path says otherwise.

The S42a walk on the Dell (2026-09-28) gave this slice four new requirements,
in the owner's words:

1. *"I'm not going to be allowing novad to stay in downloads, and I'm not going
   to run that every time the dell starts up."*
2. *"pairing should be easier if we need to repair"*
3. *"I have one device that is outdated, we need to make updating something
   nova can manage"*
4. *"as well as showing the hub in the devices"*

## Decisions only the owner can make

Each decision lists its options with the downside first, then a recommendation.
No option asks permission, because v4 has no approvals (ruling of 2026-09-03).
Every "updated" claim is backed by the agent's reconnect, never by her sentence.

1. **Scope** — (a) one slice with everything: the largest in the lane, with the privileged helper reviewed inside it; (b) S42b = install, service, card, hub agent, re-pair and updates, then S42c = the admin helper, both before S46a: one more plan-merge-walk cycle; (c) updates wait for doing-things S31: unscheduled, so every novad change means re-running the card on every machine. **Rec: (b).**
2. **When Nova updates an agent behind the hub's build** — (a) only when asked: agents stay behind until someone notices; (b) on her own, at once: a restart cuts off any command in flight, and a bad build hits every machine together; (c) on her own when a machine is idle, one at a time, the hub's agent first, each confirmed by its reconnect and rolled back if it fails: the most to build. **Rec: (c)**, plus a tool for "update it now".
3. **The WSL agent you kept** — (a) update it as is: it then reads "cannot" for every role (S42a's WSL rule) while its commands still run; (b) update it and allow a hands-only second agent inside WSL (models, wake and hold stay with the Windows agent): reopens D1 for hands; (c) retire it instead: reverses your 09-28 choice to keep it. **Rec: (b).**
4. **Re-pairing** — (a) a re-pair stays a new device: the old one is revoked first and its history stays on the old row; (b) a "Re-pair" code from the machine's tile rebinds its row to the new key: whoever uses that code within 10 minutes becomes that machine, name and history included; (c) no code, an agent whose machine id matches a row takes it over: that id is the agent's own unsigned claim. **Rec: (b).**
5. **Where the binary lives** — (a) your user's folders (`~/.local/bin`, `%LocalAppData%\Programs\Nova`) plus an admin-only copy for the helper: two copies to keep in step; (b) one admin-only copy (`Program Files\Nova`, `/usr/local/libexec/nova`): every update needs the helper, so a machine without it cannot update. **Rec: (a).**
6. **The hub in Devices** — (a) `./install` always installs the hub's agent: Nova gets hands on the machine running her own stack, as a docker-group user, so she can stop or break it; (b) opt-in (`./install --agent`): no hub tile and no wake relay for S46a until you opt in; (c) a hub tile without an agent: no hands, no relay, and core cannot read the host from inside its container. **Rec: (a).**

Why these recommendations, briefly:

1. S46a's walk needs the Dell's agent on the new build (`s46a/spec.md:420-422`),
   so updates in S42b make every later walk hers. The helper is the most
   privileged thing Nova installs (`s46a/spec.md:366`) and deserves its own
   review.
2. The owner agreed a reconcile frame for model lists on 2026-09-23
   (`s46/design-basis.md:240`). The same frame fits the agent's own build: the
   desired state is the hub's manifest, and the agent reconciles towards it.
3. It keeps his choice, and earlier rounds designed this exact mode
   (`hub/r2-agent-design.md:69`, `hub/r2-slices-design.md:50`) before
   integration dropped it.
4. It is the one-step re-pair he asked for, and the code keeps today's rules:
   single use, 10 minutes, shown only on the card.
5. The agent can update itself without admin. The helper runs only a binary
   that only an admin can write.
6. He asked to see the hub, the hub's agent is S46a's relay, and his standing
   rule is that operating the running system is hers.

---

## 1. What S42b already specifies, and what each requirement adds

### Already specified (condensed)

| Piece | Source | What it says |
|---|---|---|
| Service per OS | `hub-topology.md:139` (D3), `:376`; `hub/r2-integration.md:49`, `:462` | A systemd user unit plus linger; one LaunchAgent; HKCU `Run` → `novad supervise`, which re-launches itself detached with `CREATE_NO_WINDOW`. `supervise` is the parent on every OS and owns restart and the `.prev` revert. System-service modes are a seam. |
| Verbs | `hub-topology.md:376`; `hub/r2-integration.md:462` | `install` (an idempotent upgrade that keeps identity), `uninstall`, `supervise`. |
| Downloads | `hub-topology.md:149` (D13), `:378`, `:383`; `hub/r2-integration.md:59`, `:465-470` | A one-shot `agent-dist` builder (pinned golang, reproducible) fills `v4_agent_dist`. Core serves a core-signed manifest and the binaries on public, rate-limited paths (`PUBLIC_PATHS` gains seven entries). nginx gate carve-outs are pinned in `gate_test.sh`. GitHub release assets are listed only when their hash matches the hub's (S43b). |
| The card | `hub-topology.md:384`; `hub/r2-integration.md:187-206` | A per-OS one-liner: POSIX `sh` (dash-safe) and PowerShell 5.1. Each verifies the sha256 before it runs anything. Ordered locators: loopback, then the tailnet origin, then the LAN edge. |
| Hub-host agent | `hub-topology.md:380`; `hub/r2-integration.md:467` | `install.sh` runs `novad install --transport host` with a code from `devices_cli mint --transport host`. A WSL hub prints the PowerShell line instead (D1). |
| Windows hub without WSL | `hub-topology.md:381` | An `install.ps1` stub: "cannot", plus `wsl --install`. |
| Walk ledger | `hub-topology.md:171-172`, `:385` | `deploy/platform-walks.json` plus a test. She says "not walked on a Mac" from it. |
| Tool, guards, eval | `hub-topology.md:386-388`; `hub/r2-integration.md:475-490` | `machine_add_code(name?, for_os?)` → 42; `credential_claim` at both guard sites; the `_SETUP_MACHINE` offer class; the eval `adds-a-mac-through-the-card`. **S47 has superseded part of this row; see G3.** |
| Walk | `hub-topology.md:389-392` | Mini PC: the Linux tab, the hash verifies, then the unit and linger. Dell: the PowerShell card with no admin; the Run key survives a sign-out. "Add my MacBook" → she says it is not walked. |
| Admin helper (from S46a) | `s46a/spec.md:48-53`, `:138-167`, `:444-452` | `novad` in `helper` mode as a system service: a Windows LocalSystem service, a LaunchDaemon, or a root unit. `install` installs it with one OS prompt, and `uninstall` removes it. It talks over a local channel only (a named pipe with a DACL, or a root-owned `0660` socket). It runs only a core-signed, fresh, unused envelope that names a compiled fix whose parameters match the machine's facts. S42b delivers its install, its channel, its verification and **one diagnostic operation** that proves the install end to end. |
| Relay (from S46a) | `s46a/spec.md:326-330` | The hub-host agent is the default wake relay. |
| Updating | `hub/r2-integration.md:682`, `:703-706`; `hub-topology.md:610` | **Not in S42b.** "Updating agents before S31 means re-running the card, which upgrades in place." `daemon.update` belongs to doing-things S31: it reverts through `supervise`, and its signed manifest is the same artefact as D13's. |

**What S42a left for S42b:**

- `facts.agent.version` exists: 12 hex characters of the commit
  (`services/core/app/device_facts.py:259-261`). The Devices tile shows it.
- `AGENT_MODES` already includes `run-key` (`device_facts.py:44`). Windows
  reports `foreground` "until S42b's Run key starts `novad supervise`"
  (`apps/novad/internal/platform/session_windows.go:18`).
- A pre-S42a agent sends no facts, and core already tells her "it predates
  S42a; update it" (`device_facts.py:315-319`).
- `enroll` refuses inside WSL, and `run` does not (`slice-42a-agent-every-os.md:131`, P4).
- D13 reproducibility held on the Dell on 2026-09-28: a local `novad.exe`
  matched CI's sha256.
- The device key stays in roaming `%AppData%` (P6, locked).
- P0-20 was carried to this slice (`slice-42a-carries.md:9-10`).

### What each requirement adds

**R1: installed in a proper place, and starts by itself.**

- **Where it runs from.** `novad install` moves the binary to one fixed place
  per OS (decision 5). The one-liner downloads to a temporary directory, never
  to Downloads, and deletes the download afterwards.
- **Proof that it started.** `install` registers the service, starts
  `supervise`, and then **verifies** the service came up. The running agent
  writes a local status after `ready`, and `install` waits for it. If the
  status never appears, `install` fails and says why. A registration alone is
  never reported as "installed".
- **One copy per identity.** A lock per identity stops an old foreground copy
  and the new service from running the same key at once.
- **A final exit stays final.** `supervise` treats exit 78 (not enrolled, or
  revoked) as final on every OS, as `RestartPreventExitStatus=78` already does
  under systemd.
- **She reads it.** `agent.mode` becomes `run-key`, `systemd-user` or
  `launch-agent`, so "starts by itself" is a fact she reads, not an
  assumption.
- **Limit.** A Run key starts at sign-in, not at boot (G6).

**R2: one-step re-pairing.**

- **One command.** The card carries the name, so `--name` is never typed.
  `install` does enroll, service, start and verify in one command, which
  replaces his enroll, run and config edit. `--force` is never needed: a live
  enrollment is kept and upgraded, and a wiped one enrolls fresh.
- **A hub move no longer strands an agent.** The config holds ordered locators
  (`hub/r2-integration.md:204`), each checked against the pinned core key.
  - His 09-28 re-pair was of an agent that had not connected since the hub
    move; core saw no attempt from it (S42a SDD ledger).
  - `novad repoint` (S41) moves an agent without a new code, but only builds
    from 2026-09-21 on have it.
- **Re-pair from the tile.** A "Re-pair" code is bound to one device
  (decision 4). It is minted from that device's tile, or by her through
  `show_setup_qr` with a machine named.

**R3: Nova manages updates.**

- **Desired state.** The desired state is the hub's signed manifest. Core
  compares each agent's reported version on read and derives
  `current | behind | unknown`; nothing is stored. "Behind" means "not the
  hub's build". A hash has no order, so she never says "older".
- **The update envelope.** A signed `agent.update {version, sha256, urls}` is
  S31's `daemon.update`, pulled forward.
  - The agent downloads the build, checks its sha256 and stages it.
  - `supervise` swaps it in, keeps `.prev`, and reverts if the new build does
    not authenticate within a bound.
- **Confirmed only by the reconnect.** An update counts only when the agent
  reconnects reporting the manifest's version. Until then the result reads
  "sent, not confirmed". A guard corrects "I updated X" when that record is
  missing.
- **Surfaces.** A registered tool (named per G10), an "Update" button on the
  Devices tile, a non-urgent check for an agent that is behind, and one eval
  case. Decision 2 sets when she acts on her own.
- **Agents that predate `agent.update`** (both of the Dell's today) are updated
  through their own `shell.exec`, which every v4 build has.
  - Core composes the argv, not the model: download from the hub, check the
    sha256, swap the binary, and restart from outside the agent's own process
    tree (for example `systemd-run --user --on-active=5 systemctl --user
    restart novad`).
  - First, she reads through the agent's hands how it runs.
  - An agent started by hand in a terminal cannot be restarted by her. That
    is a stated *cannot*, plus the one command he runs.
  - It is confirmed the same way: the agent reconnects, and this time it
    reports facts.
- **The helper's own copy** (decision 5a) is updated by the helper itself,
  from a staged file whose sha256 core signs. That is a named operation, like
  any fix.
- **Remote limit.** The helper's *first* install needs someone at the machine
  for its one OS prompt. A UAC prompt cannot be answered remotely.

**R4: the hub in Devices.**

- **Installed by `./install`.** `./install` installs the hub-host agent
  (decision 6) as a systemd user unit. On the mini PC, linger is already on
  and its user is in the docker group (both read 2026-09-28). The code comes
  from a new `devices_cli mint`; `services/core/app/devices_cli` does not
  exist today.
- **The Hub badge is derived.** The tile says "Hub" because the agent's socket
  came through the hub's own loopback door, never because of a stored flag.
  nginx forwards `X-Real-IP`, and traffic from the published loopback port
  arrives from docker's gateway (`apps/web/nginx.conf.template:63`).
- **Its name.** It is named after the machine (its hostname), never `hub`,
  which is the bundled engine's reserved name (D8).
- **Its jobs.** It is S46a's relay (`s46a/spec.md:326-330`) and the first
  machine updated under decision 2c.

---

## 2. Conflicts and gaps

**G1. Updating is outside S42b as written.** `hub/r2-integration.md:682` and
`:703-706`, and `hub-topology.md:610` ("S31 self-update for six targets"), all
leave updates to S31. S31 sits on an unmerged, unpushed doing-things branch
with open owner questions, and it is not scheduled. Every later slice's walk
also needs the Dell's agent on the new build: S46a says "the agent and the
helper come from the hub's agent-dist" (`s46a/spec.md:420-422`). → decision 1.

**G2. The version stamp is not the code's identity.**

- S42a stamps 12 hex characters of the **commit** (`apps/novad/README.md`,
  "Build"; `.github/workflows/rebuild-ci.yml:223` uses `${GITHUB_SHA::12}`).
  D13 keys `agent-dist` by the `apps/novad` **tree** (`hub/r2-integration.md:59`).
- **Read now:** the Dell's Windows agent reports `dcde74c4b9a8`, main is
  `d9cfadde`, and `apps/novad` is the same tree at both commits
  (`f06466148ce1`).
- The consequence: a commit-stamped hub build would mark that agent behind
  today, although its code has not changed. A GitHub release asset would also
  never match the hub's hash.
- **Fix:** stamp the tree hash (`git rev-parse --short=12 HEAD:apps/novad`) in
  CI, the README and `agent-dist` alike. Then the same version means the same
  bytes.

**G3. `machine_add_code` is superseded.**

- S47's approved spec (`s47/spec.md:616-619`) has S42b extend
  `show_setup_qr`'s machine setups (per-OS one-liners, `for_os`, the
  transport) instead of adding a second tool.
- It also has S42b reuse `code_claim` (`s47/spec.md:366-376`) instead of adding
  `credential_claim`. `code_claim` then gains the shapes listed at
  `hub/r2-integration.md:480`: a 64-hex hash, an `/api/v1/agent/` URL, and
  `novad install --code` with no card this turn.
- The registry is already at 43 (S47 took 42 and 43), so the card moves no
  pin. An update tool takes it from 43 to 44.

**G4. S47's text still says "Linux today".** Four strings are false since S42a
merged, and all are hardcoded:

- `services/core/app/tools/setup.py:107` says "(Linux today)".
- `apps/web/src/components/SetupPanel.tsx:172` says "On the machine you are
  adding (Linux today)".
- `apps/web/src/lib/setupSteps.ts:85` says "Windows and macOS arrive with S42a".
- `setupSteps.ts:80` says "A one-line installer replaces this step later".

S42b replaces them with the one-liner, and reads walk status from
`platform-walks.json`.

**G5. `/add` makes no request** (S47 §5), but a verified one-liner needs the
build's sha256. There are two ways to give it one:

- `/add` reads the public manifest. That request carries no code, so the page
  still cannot be used to test a guessed code.
- The QR code's fragment carries the hashes, which makes a denser QR code.

Recommend the manifest read.

**G6. A Run key does not start the agent before sign-in.**

- HKCU `Run` starts a program at sign-in, and may be delayed; it never runs at
  boot (`hub/r2-agent-design.md:68`).
- After a reboot with nobody signed in, the Dell's agent and its Ollama tray
  app are both absent.
- The Run key meets "not by hand", because it starts the agent at every
  sign-in. "Before sign-in" is hub-topology's owner question 2 (P0-6: accept
  it, or turn on automatic sign-in), not a new mechanism: a Windows service
  runs in session 0, where toasts and apps do not show.
- On Linux, linger starts the agent at boot (measured on the mini PC). On
  macOS, a LaunchAgent starts at login (unwalked).

**G7. The kept WSL agent against D1.**

- D1 refuses an agent inside WSL (`hub-topology.md:137`).
- S42a's `derive_roles` gives such an agent "cannot: this machine's Windows
  agent owns it" for every role (`device_facts.py:296-325`). Today it reads
  hands as "available" only because the old build sends no facts, so
  updating it flips hands to "cannot".
- `install` refuses inside WSL while `run` does not, so the agent cannot get
  `supervise` without relaxing D1.
- Nothing starts the WSL distro at Windows sign-in, so the agent runs only
  while WSL does.

→ decision 3.

**G8. The helper makes a system-service mode real.**

- D3 and the seams list (`hub-topology.md:139`, `:604`) call system-service
  modes a seam. S46a needs one, for the helper (`s46a/spec.md:140-146`). The
  agent itself stays per-user.
- A LocalSystem or root service must run a binary that only an admin can
  write. A user-writable binary run as SYSTEM is a privilege escalation.
  → decision 5.
- S46a left "the Linux helper: a root system unit, or polkit rules" to the
  plan (`s46a/spec.md:467-468`). S42b's plan, or S42c's, must choose.
- The hub gets no wake role in v1 (`s46a/spec.md:227`), so the hub's agent can
  install without the helper, and `./install` needs no sudo prompt.

**G9. Loose ends of the hub-host agent.**

1. **A migration.** `pairing_codes.transport` belongs to S43a's migration 037,
   and `devices_cli` does not exist. S42b needs its own core migration,
   **037**. S46a also planned 037 (`s46a/spec.md:181-183`), so it renumbers to
   038 under the rule that whichever lands second renumbers.
2. **Hub moves.** A locator list with only loopback strands the old hub's
   agent after a move (S45). Ordered locators let it fall through to the
   tailnet origin, under the same pinned key.
3. **Linking in `machine_status`.** It lists the `hub` engine and the hub
   machine's agent as unrelated until S44 links engines to agents. S42b can
   link these two, for display only, from the door fact.
4. **Duplicate detection is unchanged.** Pairing the mini PC a second time
   through a card raises `devices_duplicate_agents` (the same `machine_uid`),
   as designed.
5. **On a WSL hub,** `./install` prints the PowerShell line (D1). The mini PC
   runs Linux, so this does not apply here.

**G10. Naming.** The registry already has `update_agent` and `create_agent`,
which manage her sub-agents (S12). A novad-update tool with a similar name
invites "update the Dell's agent" to reach the wrong tool. Name it for
machines, for example `machine_update`.

**G11. Re-pair details.**

- Names are unique among live devices (the partial unique index,
  `services/core/app/devices.py:283-288`). That is why his re-pair needed
  `--name`: the Windows agent already had the machine's name.
- A re-pair that reuses a row must restart core's audit chain for that device
  explicitly. Otherwise core flags `DEVICE_AUDIT_BREAK`
  (`slice-42a-carries.md:71-76`).

**G12. `uninstall` leaves the device row live but offline.** Nothing in any
plan revokes a device from the device side. Either `uninstall` says "revoke
it in Settings → Devices", or S42b adds a self-revoke signed with the device
key. This is small; the plan picks.

---

## 3. Prerequisites and risks

**P0-20 has not been measured.** It is still listed under "Still to measure"
(`hub-p0-measurements.md:105`).

- **Partial evidence only.** On 2026-09-28 the owner ran the unsigned S42a
  `novad.exe` on the Dell, and it enrolled, so Smart App Control is not
  enforcing on that machine. The file arrived by Taildrop, not `curl.exe`, and
  nobody recorded whether SmartScreen prompted.
- **What it gates.** P0-20 gates the card's Windows wording. If Smart App
  Control is on, the card states "cannot" (owner decision 12).

**Measure before building.** These are throwaway probes, recorded in
`hub-p0-measurements.md`:

1. **P0-20 on the Dell.** An unsigned exe fetched with `curl.exe`: SmartScreen,
   Smart App Control's state, Defender, the console flash from the Run key,
   and whether the agent survives a sign-out and sign-in. Add two checks for
   the helper: the UAC prompt for an unsigned exe that registers a LocalSystem
   service, and whether Defender reacts to that.
2. **`agent-dist` on the N150.** The wall time to build six targets (F24's
   rebuild budget, `hub/r2-agent-critique.md:189`), and whether it produces
   the same sha256 as CI for the same stamp.
3. **The Dell's WSL agent.** Which binary it is, where it lives, and what runs
   it: a user unit or a terminal. Read these through its own hands before the
   bootstrap is designed. Also check whether anything keeps the distro running
   after sign-in.
4. **Linux self-linger without sudo,** on a machine where linger is off. The
   mini PC already has it on. The result decides whether the Linux card says
   "needs sudo once".

**Risks.**

- **Unsigned binaries** (owner decision 12). Every update is a new unsigned
  file. Whether SmartScreen or Smart App Control re-checks a file the agent
  fetched itself belongs in P0-20. On macOS, TCC grants may reset after each
  ad-hoc-signed update (assumed, `hub/r2-agent-design.md:291`).
- **A bad build spreads further under automatic updates.** Three things limit
  it: one machine at a time, the hub's agent first, and the `.prev` revert
  when the new build does not reconnect (decision 2c).
- **An update restarts the agent.** A command in flight ends "cancelled", which
  is S42a's honest outcome; the agent's cap is 110 s
  (`apps/novad/internal/client/client.go:42`). This is why option 2c waits
  until the machine is idle.
- **The helper is the most privileged thing Nova installs**
  (`s46a/spec.md:364-380`). Where its binary lives is part of that boundary
  (decision 5).
- **Size.** S42b as written, plus these four requirements, is the largest
  slice in the lane (decision 1).
- **Pins that move, deliberately:**
  - core migration 037, with S46a moving to 038;
  - the tool registry, 43 → 44 with an update tool;
  - the eval `suite_version`, 17 → 18, and the corpus, 30 → 31 or more (S46a's
    +1 and +4 renumber after);
  - `platform-walks.json` and `gate_test.sh`.
- **`test_no_approvals` stays unchanged.** Every refusal says "cannot".

---

## Owner decisions — 2026-09-28

The owner answered "all recommended":

1. **Scope: (b).** S42b = install, service, the card, the hub's agent, re-pairing and
   Nova-managed updates. The admin helper moves to **S42c**. Both land before S46a.
2. **Updates: (c).** Nova updates an agent that is behind the hub's build on her own when
   its machine is idle, one machine at a time, the hub's agent first. Each update is
   confirmed by the agent's reconnect on the new build and rolled back if it fails.
   There is also a tool for "update it now".
3. **The WSL agent: retire it.** The walk on 2026-09-28 proved the Windows agent reaches WSL
   through `wsl.exe` (turn e2cf16ab: `uname -a` inside WSL) and WSL files through
   `\\wsl.localhost\…`. This supersedes option (b) above. D1 stands: one agent per Windows
   machine, the native one.
4. **Re-pairing: (b).** A "Re-pair" code from the machine's tile rebinds its row to the
   new key. The code is single use and lasts 10 minutes; the row keeps its name and history.
5. **Where the binary lives: (a).** The user's folders (`~/.local/bin`,
   `%LocalAppData%\Programs\Nova`, and the macOS equivalent), plus the admin-only copy that
   S42c's helper runs.
6. **The hub in Devices: (a).** `./install` always installs the hub's own agent.

**Also for S42b, from the S42a walk and eval:**
- Resolve "Desktop" on the agent, so she never guesses a path. In the walk she listed
  `C:\Users\Public\Desktop`.
- Give `device_list` and the device tools the WSL fact too. In the eval, the 8B model
  answered from `device_list`, never called `machine_status`, and gave wrong advice in all
  three runs.
