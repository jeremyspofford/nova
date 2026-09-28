# S42b — install, service, downloads, the setup card, the hub's agent, re-pairing and Nova-managed updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nova's agent installs itself in a proper place with one command, starts by itself on every OS, is re-paired with one step, appears in Devices for the hub machine too, and is kept on the hub's build by Nova herself — each update confirmed only by the agent reconnecting on the new build, and rolled back when the new build does not come up.

**Architecture:**
- **One binary, three verbs.** `novad install` enrolls (or keeps, or re-pairs) the identity, copies itself to the user's own folder, registers the per-OS service (systemd user unit plus linger; a LaunchAgent; the HKCU `Run` key) and **verifies** the agent came up by reading its status file — a registration alone is never reported as installed. `novad supervise` is the parent process on every OS: it restarts the agent, treats "cannot get in" as final, and owns the `.prev` swap and revert. `novad uninstall` removes the service.
- **Downloads and the card.** A one-shot `agent-dist` service builds the six targets from the committed `apps/novad` tree (`git archive`), stamped with that tree's hash. Core serves a core-signed manifest and the binaries on seven exact public paths. Core is the one generator of the per-OS one-liners (POSIX `sh`, PowerShell 5.1); each verifies the sha256 before anything runs.
- **Updates.** The desired state is the hub's build. Core derives `current | behind | unknown` on read. A signed `daemon.update` makes the agent download, verify and stage the build and exit 75; `supervise` swaps it in and reverts it if it does not reach `ready`. Core confirms an attempt only when the agent's next authenticated connection reports the new version. A timer job updates idle machines one at a time, the hub's agent first; `machine_update` is "update it now". Older agents are updated through their own hands where that can work, and are a stated *cannot* plus one command where it cannot.
- **Re-pair and the hub.** A re-pair code is bound to one device row; enrolling with it rebinds the row to the new key, keeping its name and history and restarting its audit chain under a new epoch. `./install` always installs the hub machine's own agent; its tile says **Hub** because its socket came through the hub's own loopback door.

**Tech Stack:**
- **Agent:** Go 1.27.1 (`go.mod` says `go 1.27.0`), `CGO_ENABLED=0`, `github.com/coder/websocket`, `golang.org/x/sys` v0.48.0 (incl. `windows/registry`). No new module.
- **Core:** Python 3.12 / FastAPI / asyncpg; one migration.
- **Web:** React + TypeScript, vitest.
- **Deploy:** bash 3.2-portable `install.sh`, compose, nginx template, POSIX `sh` in the `golang:1.27.1` image.
- **CI:** GitHub Actions (`rebuild-ci.yml`).

**Spec** (binding in this order):
1. [`design-inputs.md`](design-inputs.md) — the research and, at its end, **"Owner decisions — 2026-09-28"** (all six LOCKED; decision 3 = RETIRE the WSL agent, superseding option (b)), plus the walk/eval findings for S42b (resolve "Desktop" on the agent; give `device_list` and the device tools the WSL fact).
2. [`../hub-topology.md`](../hub-topology.md) §S42b and D1–D21; [`../hub/r2-integration.md`](../hub/r2-integration.md) §S42b and the r2 designs it cites (supervise, the Run key with `CREATE_NO_WINDOW`, agent-dist + signed manifest, public paths + gate carve-outs, the per-OS card, locators).
3. [`../s46a/spec.md`](../s46a/spec.md) — what S46a needs (the hub-host agent as the relay; install/service). The admin helper moved to **S42c** (decision 1): this slice leaves a seam for it and builds none of it.
4. What S42a built ([`../slice-42a-agent-every-os.md`](../slice-42a-agent-every-os.md), [`../slice-42a-carries.md`](../slice-42a-carries.md)) and the code as it is today.
5. The house rules in the repo's `CLAUDE.md`.

---

## Global Constraints

Every task's requirements include these.

- **Pure Go, `CGO_ENABLED=0`, six targets:** linux, darwin, windows × amd64, arm64 (D1). Go **1.27.1** in CI, locally (`~/.local/bin/mise x --`) and in `agent-dist` (with `GOTOOLCHAIN=local`). No Go module is added.
- **One version everywhere (P2):** the first 12 hex characters of the git **tree** `HEAD:apps/novad`, computed as `git rev-parse HEAD:apps/novad | cut -c1-12` — never `--short=12`, which may print more than 12 characters to stay unambiguous. CI, the README and `agent-dist` use exactly this. A hash has no order: say **"behind the hub's build"**, never "older".
- **The enroll body stays five keys** (`code, pubkey, name, platform, hostname`; `main_test.go` pins it). The enroll *response* gains one key, `repaired` (a deliberate pin move in `test_devices.py`).
- **The words `unknown capability %q` do not change** — core reads them to tell an agent that predates `daemon.update` (P11).
- **No approvals (2026-09-03).** A role is availability, never permission (D2). No `capabilities` column. Every refusal says **"cannot"**, never "may not". `tests/test_no_approvals.py` stays **unchanged and green**, including its pinned `Tool` and `ToolContext` field sets — `machine_update` uses only existing fields.
- **Never report success you did not check.** `install` reports "installed" only after the new agent's status file says `ready`. An update is "confirmed" only by the agent's next authenticated connection reporting the new version; until then it is "sent, not confirmed". A step that cannot verify its result fails and says why.
- **Core migration: the next free number at build time** — `038` once the production hotfix `037_audit_exit_code_bigint.sql` (device_audit.exit_code int4 → bigint) has merged; check `ls services/core/migrations | tail -1` before creating it. S46a's earlier "037" reservation is **void**; S46a (and S43a's `037_network`) take the next free numbers after S42b and S42c.
- **Registry 43 → 44** (`machine_update`). **Eval: suite_version 17 → 18, corpus 30 → 32.** Whichever slice lands second renumbers once (S26 is also moving the eval harness; S46a's +4/+1 follow). **The coordinator's `fix/handback-guard` (the reply-level guard against handing the owner a procedure) is not S42b's;** if it moves `agent_quality`'s `suite_version`, it lands first and S42b's bump goes on top of wherever it left the pins.
- **Agents report what she needs to act unaided (owner, 2026-09-28, LOCKED — P29).** How the agent runs, whether elevation would ask a person, and on Windows the WSL distributions beside it are probed **by the agent** and rendered by core into the `device_info`, `device_list` and `machine_status` lines — never into a prompt list. A probe that runs a program (`sudo -n`, `wsl.exe`) runs **only at connect and on `facts.refresh`**, never on the facts frame's minute cadence; each program is bounded at 10 s and a whole probe at 45 s; and **nothing ever looks inside a stopped WSL distribution** (looking would start it).
- **A command never waits for input nobody can type (P30).** Every child the agent starts for her runs with no terminal and empty input, so a prompt fails at once in the program's own words instead of hanging to the 110 s timeout.
- **Text an agent reports that core renders into a listing line is one line:** a control character in any P29 field is refused at validation (`tools.machines.device_line_shown` fails closed on a line that runs past a newline, and her facts would be dropped).
- **Public surface:** exactly seven new `PUBLIC_PATHS` (the manifest and six binaries). nginx carves `/api/v1/agent/` and `/api/v1/devices/enroll` out of the gate, pinned in `gate_test.sh`.
- **Exit codes of `novad`:** 0 ok or stopped, 1 error, 2 usage, **3** `install` needs a pairing code, **75** `run` staged an update (supervise swaps it in), **78** not enrolled or revoked (final).
- **Pairing codes:** single use, 10 minutes, stored hashed, shown only on the card (S47 §7). A re-pair code obeys the same rules. A code reaches the installer by `--code` (typed by a person) or the `NOVA_PAIRING_CODE` env var (`./install`), never a log line, a span, a message or her context.
- **One update in flight at a time**, enforced by the database (P9), for her tool, the tile and the timer job alike.
- **A malformed or oversized value in ANY frame never ends a device's session** (P27): audit, result, facts, heartbeat and unknown frames each have a test. Every integer an agent reports that can be a Windows exit code (uint32) must fit a `bigint` column.
- **Wire compatibility:** an S42a agent keeps working against S42b core. New fact fields and frame sections are optional; an agent without them reads "unknown", never broken.
- **The repo is PUBLIC.** No real username, home path (write `~/…`), LAN or tailnet address, MAC, GPU UUID, tailnet name (write `<TAILNET>`), pairing code or sha256 of a real build in code, fixtures or docs. Fixtures use RFC 5737 addresses and `fake-tailnet`.
- **Git:** branch `slice/s42b` in `~/workspace/nova/.worktrees/s42b`. Always `git -C <path>`. Stage by path, never `git add -A`. `git show --stat HEAD` after every commit. Never a bare `git stash`. Every commit message ends with the two trailer lines this session was given (`Co-Authored-By: …` and `Claude-Session: …`).
- **Formatting:** `ruff format` only the Python files you edited; v4 trees are not format-clean.
- **Core tests** run against your OWN scratch database `nova_core_s42b` on `nova-scratch-pg` (127.0.0.1:55432), with `TEST_DATABASE_URL` set and an absolute `cd`; report the skip count (0 expected).
- **Web tests:** `npm test` (never `npx vitest run` — it fails on Node 26) plus `npx tsc --noEmit`.
- **Anything installed on a machine is built from `~/workspace/nova` on `main`** (owner, 2026-09-25): `agent-dist` builds from `git archive HEAD apps/novad` of that checkout, never from a worktree.
- **Operating the running system is hers.** The controller writes code and runs gates; checking that a machine updated, reading why an agent did not come up, stopping the old WSL agent — those are her tools in the walk.

## Decisions this plan makes where the spec is silent

These go to the owner for review; each is visible in the code that implements it.

| # | Where the spec is silent | This plan decides |
|---|---|---|
| P1 | Binary locations (decision 5a) and the S42c seam | Linux `~/.local/bin/novad`; Windows `%LocalAppData%\Programs\Nova\novad.exe`; **macOS `~/Library/Application Support/Nova/novad`** (the user-folder equivalent of `%LocalAppData%\Programs`). The admin-only copies S42c will use are declared, not built: `/usr/local/libexec/nova/novad`, `%ProgramFiles%\Nova\novad.exe`, `/Library/Application Support/Nova/novad` (`platform.AdminInstallDir`, pinned by one test). |
| P2 | The version stamp (G2) | 12 hex of the **`apps/novad` tree** everywhere (CI, README, agent-dist), via `deploy/agent_version.sh`, which refuses when `apps/novad` has uncommitted changes. Today's commit-stamped agents therefore read "behind" once, which is true: their tree changes in this slice. |
| P3 | How "can never get in" stays final under every service manager | The agent exits 78 → `supervise` exits **0** and logs why. Units restart only on failure: systemd `Restart=on-failure` (plus `RestartPreventExitStatus=78` for an old unit), launchd `KeepAlive={SuccessfulExit=false}`. The Run key restarts nothing. |
| P4 | How the agent knows its mode | `supervise --mode <m>` sets `NOVA_AGENT_MODE` and `NOVA_SUPERVISOR_PID` for its child; `platform.Mode()` reads the variable first. The unit, the plist and the Run-key value all carry `--mode`. `foreground` means "not started by its service". |
| P5 | Proof it started; one copy per identity | `run` writes `agent-status.json` in the state dir (`connecting → ready → stopped`, with the last error). `install` waits up to 60 s for `ready` from an agent of its own version. `run` holds `run.lock`, `supervise` holds `supervise.lock` (flock / `LockFileEx`); a second holder is refused with the first one's pid. |
| P6 | The Windows launcher | The Run key starts `novad.exe supervise --mode run-key`, which re-launches itself detached (`DETACHED_PROCESS \| CREATE_NEW_PROCESS_GROUP \| CREATE_NO_WINDOW`, plus `CREATE_BREAKAWAY_FROM_JOB` when allowed) and exits; the child runs in a kill-on-close job object and logs to `%LocalAppData%\novad\novad.log` (1 MiB, one rotation). **If P0-20 finds the console flash unacceptable (branch B)**, Task 12b adds a GUI-subsystem launcher `novadw.exe` and the Run key points at it. |
| P7 | The update's mechanics | Capability **`daemon.update`** (r2 §2.2's name, so S31 inherits it) with args `{version, sha256, path}`; `path` is a dist path resolved against the locator the agent is connected through. Download ≤ 64 MiB, streamed and hashed, staged as `novad.new` with `update.json`. The agent refuses unless supervised. It exits 75 only after its result and audit frames are written. `supervise` swaps (keeping `.prev`), waits ≤ 120 s for `ready`, else reverts and records `rolled_back` with the reason, which the old agent then reports in `facts.agent.update`. `supervise` itself keeps running the old code until the service next starts. |
| P8 | What "confirmed" means in core | An attempt is `confirmed` only when the device's next authenticated auth frame reports `agent.version == version`; `rolled_back` when it reports `agent.update.outcome == rolled_back` for that version; `not_confirmed` after 10 minutes with neither; `refused` when the agent answered no. `machine_update` waits up to 120 s for that before it answers. |
| P9 | "One machine at a time", mechanically | A unique partial index allows one `agent_updates` row with outcome `sent`. Her tool, the tile's button and the job all hit it; the loser gets a stated *cannot* naming the machine in flight. |
| P10 | Idle, the order, and when she acts on her own | Idle = connected, no command in flight and none sent in the last 5 minutes (the hub counts). A timer **job** `agent_updates` runs **every 15 minutes** (96 small `job` turns a day on the trace; it inherits the claim, the pause after 5 failures, history and Run now). Order: the hub's own agent first, then by name; others wait while the hub's agent is behind. A version that failed on any machine is never sent again automatically; "update it now" can still retry. |
| P11 | Agents that predate `daemon.update` | Detected by the agent's own `unknown capability "daemon.update"` answer. A Linux agent under the README's systemd unit (mode `systemd-user`) is updated through its own `shell.exec` with argv core composes: `curl` the build, `sha256sum` it (core compares), `chmod`, then the new binary's `install --restart-later` (the restart runs through `systemd-run --user --on-active=5`, outside the old agent's tree). Every other old agent (hand-started, LaunchAgent, no facts) is a stated *cannot* plus the one command. |
| P12 | Hand-started agents (mode `foreground`) | `daemon.update` and `machine_update` state *cannot* ("started by hand, so nothing would start a new build") and name the one step: close the window it runs in, then run the command on that machine's setup card — `show_setup_qr` with `machine` set, which mints a re-pair code bound to it. That command upgrades in place: `install` keeps an enrollment a hub still knows and leaves the code unused. `machine_update` never sends a card itself, so the card's narration backing stays one tool's. |
| P13 | Re-pair details (decision 4, G11) | `pairing_codes.device_id` binds a code to a live row. Enrolling with it rebinds pubkey, platform and hostname, clears facts, bumps `devices.audit_epoch` (`device_audit`'s key gains `epoch`), keeps name and history, writes `device.repaired`, and closes the old key's socket. A row revoked after the code was minted cannot be re-paired, and the code is not spent. No retired-key table (a carry: an old key that is still running retries with "signature did not verify"). |
| P14 | Names | A code may carry the machine's name (`pairing_codes.name`), which enroll uses over the agent's; a re-pair keeps the row's name. **`hub` is refused as a device name** everywhere (D8: it is the bundled engine's). `devices_cli mint --name N` mints a re-pair code when a live device is already called N. |
| P15 | The Hub badge's door | At each authenticated connect core records `devices.last_transport` (S43a's planned column, pulled forward) from the direct peer and nginx's `X-Real-IP`, trusted only when the peer is web's fixed address: the subnet gateway (the published loopback port) → `host`; the sidecar's address → `tailnet`; anything else → NULL. The badge is derived from it on read. P0 (Task 2) measures the loopback source before this is built. |
| P16 | "Desktop" on the agent | The agent reports `folders {home, desktop, documents, downloads}` in the facts frame, as the OS names them: Windows known folders (OneDrive included), macOS's fixed folders, Linux xdg user-dirs — never guessed. The fs tools accept `@desktop[/…]`, `@documents`, `@downloads`, `@home`, resolved **on the agent** at command time. Core sends a token only to an agent that reported that folder; otherwise it states *cannot* and asks for an absolute path. |
| P17 | The WSL fact in `device_list` | `device_list` reads the plant's agent listing (so an eval's declared device appears there too) and states each agent's hands role when it is not available — for an agent inside WSL, "cannot: this machine's Windows agent owns it" — plus its build and the Hub badge. |
| P18 | One generator of the one-liners | Core (`agent_card.py`). The public manifest endpoint carries them with a `{CODE}` slot for `/add` and Settings; the chat card carries them filled. `/add` makes one request, the public manifest, which never carries the code. |
| P19 | The public surface | Seven exact public paths, a global limit of 30 requests a minute; the manifest is signed by core's key. Its S42b reader is `novad install`, which says whether it is itself the hub's build. |
| P20 | `code_claim` (G3) | Reused **unchanged**. r2's three extra shapes (a 64-hex hash, an `/api/v1/agent/` URL, `novad install --code` without a card) are not added: the card's command refuses a wrong hash on the machine before anything runs, and the code token itself is already rewritten. |
| P21 | `uninstall` (G12) | Stops and removes the service and the binaries; keeps the identity by default (a reinstall reuses it); `--forget` sets it aside. It states "still paired as <name> — revoke it in Settings → Devices". No self-revoke (G12's smaller option; a carry). |
| P22 | Where the walk ledger lives | `services/core/app/platform_walks.json` (inside core's build context, which cannot reach `deploy/`), instead of `deploy/platform-walks.json`. |
| P23 | The hub's agent via `./install` | `./install` builds agent-dist, fetches the binary through the hub's own door (`http://127.0.0.1:3000`), checks it against the manifest, mints a code with `devices_cli` (named after the hostname), passes it by env, and runs `novad install --if-missing`. A running hub agent is left alone — updating it is Nova's job. A failure fails `./install` (the stack stays up). A WSL hub prints the PowerShell line (D1). |
| P24 | Evals | Two cases: `adds-a-mac-and-says-it-is-not-walked` (walk status) and `says-sent-until-the-agent-reconnects` (update honesty). |
| P25 | "Update it now" while busy | `machine_update` sends even when a command is running there (the owner asked now); its result names each command that will end "cancelled". Only the job waits for idle. |
| P26 | Linux linger | `install` runs `loginctl enable-linger` without sudo and reads it back. If it stays off: "starts at login, not at boot", plus the one `sudo loginctl enable-linger <user>` line (Task 3 selects the card wording). |
| P27 | Frames core cannot store (controller, 2026-09-28) | Each frame is handled in its own guard in `devices_ws.serve`: a failure is logged and the frame dropped, the session stays up. An audit entry core cannot store (an integer outside bigint, a timestamp outside 0001–9999, a wrong type, a NUL) is a `device.audit_break` naming why, never a crashed session. |
| P28 | A revoked agent that keeps running (evidence of 2026-09-28, 17:04 UTC) | She could not check whether the old WSL agent stopped: core answered each 30 s knock and recorded nothing. Now `authenticate` verifies a revoked device's signature against its revoked key **before** answering (closing S42a's carry: the signed proof goes only to the key's holder); a verified knock stamps `devices.last_refused_at`. `device_list` lists a revoked device that knocked in the last 24 hours — "still knocking (last <t>)" within 2 minutes, else "no knock since <t>: it stopped then" — and says how a Linux agent from before S42b runs (the README's systemd user unit `novad`; inside WSL, through the Windows agent with `wsl.exe -d <distro> -- …`). The knock record is the check: when it stops, so do the knocks. |
| P29 | What an agent reports so she can act unaided (owner requirement 2026-09-28, LOCKED: "I should not need to hold nova's hand") | The facts frame gains four keys, probed **by the agent** at connect (in the background, at most once per 10 minutes across reconnects) and on every `facts.refresh`, and carried with their time in every frame between: **`service`** — the unit (`novad.service`), label (`nova.novad`) or Run-key value, the binary, the config file, the process name and pid, the supervisor's pid, the account; **`elevation`** — root or an elevated token; on Windows, membership of Administrators and Windows sudo's mode from its own registry key; on Linux and macOS, what `sudo -n true` did (never asks); **`wsl_distros`** (Windows) — from WSL's own registry key: name, default, WSL version; `wsl.exe --list --running --quiet` for which run; and inside each **running** one only, as its default user: PID 1 (systemd or not), the user, `sudo -n`, whether `wsl.exe -u root` runs, the user unit `novad.service` (ActiveState, UnitFileState, Restart, MainPID) and any process named `novad`; **`probed_at`**. Core validates them (one-line text only) and renders them as sentences: `device_info` probes again first; `device_list` and `machine_status` show the last probe and its time. `device_run`'s description states the argv contract (no shell of the agent's own; `wsl.exe` hands its command line to the distro's shell unless `--exec`, as Task 1 measured) and that commands get no terminal. No eval case in S42b: an eval's declared device is read-only (a device tool refuses it), so the act itself cannot be scored there — the walk's trace scores it (P31), and the case waits for a fixture that can answer `device_run` (a carry). |
| P30 | A command that waits for input (owner requirement, LOCKED) | Children the agent starts for her get **no terminal and empty input**. Linux and macOS: their own session (`Setsid`, so no controlling terminal — today they share a hand-started agent's) and stdin at EOF; `sudo` then fails at once ("a terminal is required…"). Windows: the mechanism **Task 1 measured** — **T1** an empty stdin pipe for every child; **T2** `DETACHED_PROCESS` for a `wsl.exe` child, the hidden console kept for the rest; **T3** neither gives the Linux side of `wsl.exe` no terminal → the Windows half is a carry and an owner question, and the `sudo -n: refused` fact is what keeps her from trying. The program's own words are the stated reason; the result carries them. |
| P31 | Retiring the old WSL agent in the walk (decision 3) | The step is **his words only** — "retire the old Nova agent in WSL on my PC" — no distro, unit or command from him. However she does it, it is done when the trace shows her finding the agent in the Windows agent's WSL facts, stopping and disabling it without asking him to type anything, a fresh `device_info` showing the unit inactive and no `novad` process, and `device_list` showing the revoked row's knocks stopped. A reply that hands him a procedure, or states a cause she did not check, fails the step (recorded; the reply-level guard is `fix/handback-guard`'s). Turns `3743df3b`, `73574d49` and `01faf3b7` are the before. |

## Review Focus

These are the failure modes most likely to reach a person, most likely first. Each names the test that pins it and the task that owns it.

1. **A new build that never comes up must revert.** One that exits at once, or never reaches `ready` within the bound, is replaced by `.prev` and recorded `rolled_back`, and the old agent reports it. Tests: `TestAStagedBuildThatNeverReachesReadyIsRolledBack` and `TestAStagedBuildThatExitsAtOnceIsRolledBack` (Task 9); `test_a_reconnect_reporting_a_rollback_marks_the_attempt_rolled_back` (Task 20).
2. **"Updated" said before the reconnect.** The tool says "sent, not confirmed"; the narration guard corrects "I updated X" without a confirmed span. Tests: `test_machine_update_says_sent_not_confirmed_until_the_reconnect` (Task 22), `test_an_update_claim_without_a_confirmed_reconnect_is_corrected` (Task 23), the eval `says-sent-until-the-agent-reconnects` (Task 24).
3. **Uint32 values and malformed frames (controller).** A Windows exit code `4294967295` or `0x80070005` in an audit entry is stored; a value outside bigint, an impossible timestamp or a wrong type in an **audit**, **result**, **facts** or **heartbeat** frame, or an unreadable frame, never ends the session. Tests: `test_a_uint32_windows_exit_code_is_stored`, `test_an_audit_entry_core_cannot_store_is_a_stated_break_and_the_session_stays_up` (four shapes), `test_a_result_frame_with_an_absurd_exit_code_does_not_end_the_session`, `test_a_facts_frame_that_cannot_be_handled_does_not_end_the_session`, `test_a_malformed_heartbeat_does_not_end_the_session`, `test_an_unreadable_frame_is_dropped_and_the_session_stays_up` (Task 13).
4. **Two copies of one identity** — a hand-started copy and the new service. The lock refuses the second; `install` names the holder. Tests: `TestASecondHolderOfTheLockIsRefusedWithTheFirstsPID` (Task 5), `TestInstallNamesAnotherCopyHoldingTheIdentity` (Task 12).
5. **"Can never get in" must stay final.** `supervise` exits 0; the unit restarts only on failure; the plist does not keep a clean exit alive. Tests: `TestSuperviseStopsForGoodWhenTheAgentCannotGetIn` (Task 9), `TestTheUnitRestartsOnlyOnFailure`, `TestThePlistDoesNotRestartACleanExit` (Task 8).
6. **A re-pair must not break the audit chain.** Tests: `test_a_repaired_device_starts_a_new_audit_chain_without_a_break` (Task 15).
7. **A Windows path with a space** (`C:\Users\Jane Doe\…`) must be quoted in the Run-key value, or Windows runs `C:\Users\Jane`. Test: `TestTheRunKeyValueQuotesAPathWithSpaces` (Task 8).
8. **An S42a agent against S42b core.** No `folders` → `@desktop` is a stated *cannot*, not a missing folder; `daemon.update` answers `unknown capability` → the bootstrap or a stated *cannot*, never a silent "sent". Tests: `test_a_folder_token_for_an_agent_that_reports_no_folders_is_a_stated_cannot` (Task 21), `test_an_agent_without_the_capability_on_a_systemd_unit_is_bootstrapped_through_its_hands` (Task 20).
9. **The code never leaves the card.** `./install` passes it by env and never echoes it; a re-pair card's code appears on the card only. Tests: `install_test.sh` "the pairing code never reaches the log" (Task 27); `test_a_repair_card_carries_the_code_on_the_card_only` (Task 19).
10. **A revoked agent that keeps running must be visible**, so "I stopped it" is checkable (2026-09-28: the old WSL agent knocked every 30 s and nothing recorded it). Tests: `test_a_revoked_devices_verified_knock_is_recorded_and_answered_with_the_proof`, `test_an_unverified_knock_for_a_revoked_id_gets_no_proof_and_records_nothing` (Task 17); `test_device_list_says_a_revoked_agent_is_still_knocking_and_when_it_stopped` (Task 21).
11. **A probe must never start a stopped WSL distribution**, and never run programs on the minute cadence (sudo can log each `-n`; `wsl.exe` is not free). Tests: `TestTheWSLProbeLooksOnlyInsideRunningDistros`, `TestTheProbesRunAtConnectAndOnRefreshOnly` (Task 10b).
12. **A command that asks for input must fail at once, not hang to the timeout** (turn `01faf3b7`: no output for 110 s). Tests: `TestAShellExecChildHasNoControllingTerminal` (Linux), `TestAShellExecChildGetsEmptyInput` (every OS) (Task 10c). The Windows→WSL half cannot run in CI (no distro on the runners): it is proven by Task 1's matrix and the walk (Task 32).
13. **An agent-reported name with a newline** (a distro, a unit's words, a user) must not split the line `device_line_shown` reads back — it fails closed and drops her facts. Test: `test_a_probe_field_with_a_control_character_is_refused` (Task 16b).
14. **The facts must be enough to act on without him** — the Dell's old agent: a running distro, sudo that needs a password, root through `wsl.exe -u root`, a user unit `novad.service` that restarts always. Tests: `test_the_wsl_line_says_where_the_old_agent_runs_and_how_it_restarts` (Task 16b), `test_device_info_probes_again_and_says_how_the_agent_runs` (Task 21); the walk step in his words (P31, Task 32).

---

## File map

**`apps/novad` (Go)**

| File | Responsibility |
|---|---|
| `main.go` | verbs: `enroll`, `repoint`, `run`, `status`, `version`, **`install`, `uninstall`, `supervise`**; exit codes 3, 75, 78 |
| `install.go`, `supervise.go` (package main) | flag parsing for the new verbs, wiring into the packages below |
| `internal/state/{state,lock,lock_unix,lock_windows}.go` | status files, `update.json`, the per-identity locks |
| `internal/platform/{mode,folders,folders_*,install_*,detach_*,process_*}.go` | mode from env, known folders, install dirs, detached start, process checks |
| `internal/platform/{wsl,wsl_windows,wsl_other,elevation_unix,elevation_windows}.go` | WSL's registry list, the look inside a running distro, what elevating would meet (P29) |
| `internal/facts/probe.go` | the slow probes: how this agent runs, elevation, WSL — at connect and on `facts.refresh` only (P29) |
| `internal/caps/{procattr_unix,procattr_windows,shell}.go` | children get no terminal and empty input (P30) |
| `internal/service/{service,render,systemd_linux,launchd_darwin,runkey_windows}.go` | unit / plist / Run-key rendering and managers |
| `internal/supervise/{supervise,swap,spawn_unix,spawn_windows}.go` | the parent loop, swap, revert, the spawner |
| `internal/install/{install,enroll,uninstall}.go` | install / uninstall flows, the shared enroll call |
| `internal/caps/{update,fs}.go`, `caps.go`, `table.go` | `daemon.update`; `@folder` paths; `Outcome.Restart` |
| `internal/client/client.go` | ordered locators, state callbacks, restart for an update, update deps |
| `internal/config/config.go` | `Locators`, `Hubs()`, `SetAside` |
| `internal/facts/facts.go` | `agent.update`, the `folders` section |
| `novad.service`, `README.md` | the unit (`supervise`), the docs |

**`services/core` (Python)**

| File | Responsibility |
|---|---|
| `migrations/038_agent_lifecycle.sql` | re-pair columns, audit epoch, `last_transport`, `agent_updates` |
| `app/devices.py`, `app/devices_api.py`, `app/governance.py` | re-pair, names, the repair and update routes |
| `app/devices_ws.py` | frame guards, audit epochs, the door, the connect hook, idle tracking |
| `app/device_facts.py` | `agent.update`, `folders`, `starts`, `build_state`, richer `agent_view`; the P29 sections and `acting_lines` |
| `app/network.py` | `door_of` |
| `app/agent_dist.py`, `app/agent_dist_api.py`, `app/identity.py` | the build on disk, the signed manifest, the public paths |
| `app/agent_card.py`, `app/platform_walks.py`, `app/platform_walks.json` | the one-liners; the walk ledger |
| `app/agent_updates.py`, `app/timers.py`, `app/checks/devices.py` | sending, confirming, the job, the check |
| `app/machines.py`, `app/tools/{machines,devices,setup}.py` | `update_agent` on the plant; `machine_update`; `device_list`; `@folder` paths; the card |
| `app/guards.py` | `updated_machine`, one capability phrase, one offer class |
| `app/devices_cli.py` | `mint --name` for `./install` |
| `app/evals/{cases,runner}.py`, `app/evals/cases/*.json` | the `update` fixture; two cases; suite 18 |

**Elsewhere:** `deploy/{agent_version.sh,agent_version_test.sh,agent-dist/build.sh,agent-dist/build_test.sh,docker-compose.yml,install.sh,install_test.sh}`, `install.ps1`, `deploy/backup/tests/*` pins and fixtures, `apps/web/{nginx.conf.template,gate_test.sh}`, `apps/web/src/**` (the card, the tile), `.github/workflows/rebuild-ci.yml`, docs.

---

## Task 0: Baseline (prerequisite; no commit)

The worktree `~/workspace/nova/.worktrees/s42b` is on `slice/s42b`, cut from `d9cfadde`, holding the design inputs, the owner's decisions and this plan. `main` has moved (the S42a close-out, `06776ee5`, and the audit hotfix that takes migration 037).

- [ ] **Step 0: Rebase onto today's `main` and read the next free migration**

```bash
git -C ~/workspace/nova fetch -q origin
git -C ~/workspace/nova/.worktrees/s42b rebase origin/main
git -C ~/workspace/nova/.worktrees/s42b log --oneline -5
ls ~/workspace/nova/.worktrees/s42b/services/core/migrations | tail -2
```

Expected: the three S42b docs commits sit on top of `origin/main`, and the last migration is `037_audit_exit_code_bigint.sql`. **If it is still `036_agent_facts.sql`, stop**: the hotfix has not merged. Wait for it — Task 13's uint32 test needs the bigint column, and Task 14's number depends on it. If a later migration exists, use the next free number wherever this plan says `038` (the file name, `test_migration_038.py`, and the close-out).

- [ ] **Step 1: Core, gateway and memory on your own scratch databases**

```bash
W=~/workspace/nova/.worktrees/s42b
PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
for svc in core gateway memory; do docker exec nova-scratch-pg createdb -U postgres nova_${svc}_s42b 2>/dev/null; done
cd $W/services/core && uv sync -q && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q -rs 2>&1 | tail -4
cd $W/services/gateway && uv sync -q && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s42b uv run pytest -q 2>&1 | tail -2
cd $W/services/memory && uv sync -q && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_memory_s42b uv run pytest -q 2>&1 | tail -2
```

Expected: green except main's known regex-timing edge on this N150 (`_IN_USE_AFTER_GAP`, `_IN_USE_DENIED`, `_READING_LINE`; `_IN_USE_CONJUNCT` intermittently — S42a's Gates). 0 skipped. Record the three counts for the close-out. Anything else red: **stop** and report.

- [ ] **Step 2: Web, novad, shell**

```bash
W=~/workspace/nova/.worktrees/s42b
(cd $W/apps/web && npm ci --silent && npm test 2>&1 | tail -3 && npx tsc --noEmit && echo TSC-OK)
(cd $W/apps/novad && ~/.local/bin/mise x -- go test -race ./... && for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done)
(cd $W && bash deploy/install_test.sh 2>&1 | tail -2)
```

Expected: web passes and `TSC-OK`; all novad packages `ok`; vet silent; `install_test.sh` ends with `0 failed`.

---

## Task 1: Phase 0 — P0-20 on the Dell (unsigned exe via `curl.exe`, SmartScreen, Smart App Control, Defender, the Run-key flash, sign-out survival) and what a command meets there (a terminal, sudo, WSL)

A throwaway probe, never product code. Steps marked **(owner)** are the owner's; he runs them in an ordinary (non-admin) PowerShell on the Dell. The controller builds and serves the probe from the mini PC and records the results.

Step 2b is the owner requirement's measurement (P29, P30): turn `01faf3b7` ran `wsl.exe -d Ubuntu-26.04 -- sudo systemctl --user stop novad`, got no output and hit the 110 s timeout. A sudo password prompt on a terminal the Linux side was given is the likely cause and is **unverified** — the matrix measures it, from a process started exactly the way S42b's agent will be (a detached supervisor → the agent with a hidden console → her command).

**Files:**
- Probe (scratchpad only, not committed): `<scratchpad>/p0-20/main.go`, `go.mod`
- Modify: `docs/plans/rebuild/hub-p0-measurements.md` (a new `### P0-20` section; the "Still to measure" row)

- [ ] **Step 1: Build the probe (controller)**

`<scratchpad>/p0-20/main.go`:

```go
// p0-20: a throwaway probe for S42b's Phase 0. NOT product code.
//   p0-20.exe            prints "p0-20 ok"
//   p0-20.exe --detach   re-launches itself detached (no console) as --child, then exits
//   p0-20.exe --child    appends a line to %LOCALAPPDATA%\p0-20\beat.log every 10 s
//   p0-20.exe --matrix <distro>, --console-check: see matrix.go (Step 2b)
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func main() {
	if len(os.Args) > 2 {
		switch os.Args[1] {
		case "--matrix":
			matrixStart(os.Args[2])
			return
		case "--matrix-sup":
			matrixSup(os.Args[2])
			return
		case "--matrix-agent":
			matrixAgent(os.Args[2])
			return
		}
	}
	if len(os.Args) > 1 && os.Args[1] == "--console-check" {
		consoleCheck()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--detach" {
		self, _ := os.Executable()
		cmd, _ := windows.UTF16PtrFromString(windows.EscapeArg(self) + " --child")
		var si windows.StartupInfo
		si.Cb = uint32(unsafe.Sizeof(si))
		var pi windows.ProcessInformation
		flags := uint32(windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP |
			windows.CREATE_NO_WINDOW | windows.CREATE_BREAKAWAY_FROM_JOB)
		err := windows.CreateProcess(nil, cmd, nil, nil, false, flags, nil, nil, &si, &pi)
		breakaway := true
		if err != nil {
			breakaway = false
			flags &^= windows.CREATE_BREAKAWAY_FROM_JOB
			err = windows.CreateProcess(nil, cmd, nil, nil, false, flags, nil, nil, &si, &pi)
		}
		fmt.Printf("detach err=%v pid=%d breakaway=%v\n", err, pi.ProcessId, breakaway)
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--child" {
		dir := filepath.Join(os.Getenv("LOCALAPPDATA"), "p0-20")
		_ = os.MkdirAll(dir, 0o755)
		var session uint32
		_ = windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session)
		for {
			if f, err := os.OpenFile(filepath.Join(dir, "beat.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
				fmt.Fprintf(f, "%s pid=%d session=%d\n", time.Now().Format(time.RFC3339), os.Getpid(), session)
				f.Close()
			}
			time.Sleep(10 * time.Second)
		}
	}
	fmt.Println("p0-20 ok")
}
```

`<scratchpad>/p0-20/matrix.go`:

```go
// matrix.go — S42b P29/P30 measurements. NOT product code.
//   --matrix <distro>        starts the matrix the way S42b's agent runs, then exits
//   --matrix-sup <distro>    (detached, no console) starts --matrix-agent with CREATE_NO_WINDOW, as supervise will
//   --matrix-agent <distro>  (a hidden console, as the agent will have) runs each child three ways -> matrix.log
//   --console-check          prints whether it has a console window, and whether that window is visible
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	getConsoleWindow = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleWindow")
	isWindowVisible  = windows.NewLazySystemDLL("user32.dll").NewProc("IsWindowVisible")
)

func consoleCheck() {
	hwnd, _, _ := getConsoleWindow.Call()
	visible := false
	if hwnd != 0 {
		v, _, _ := isWindowVisible.Call(hwnd)
		visible = v != 0
	}
	fmt.Printf("console=%#x visible=%v\n", hwnd, visible)
}

func matrixStart(distro string) {
	self, _ := os.Executable()
	line, _ := windows.UTF16PtrFromString(windows.EscapeArg(self) + " --matrix-sup " + windows.EscapeArg(distro))
	var si windows.StartupInfo
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	err := windows.CreateProcess(nil, line, nil, nil, false,
		windows.DETACHED_PROCESS|windows.CREATE_NEW_PROCESS_GROUP, nil, nil, &si, &pi)
	fmt.Printf("matrix started: err=%v pid=%d — watch the screen for about three minutes\n", err, pi.ProcessId)
}

func matrixSup(distro string) {
	self, _ := os.Executable()
	cmd := exec.Command(self, "--matrix-agent", distro)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
	_ = cmd.Run()
}

type variant struct {
	name  string
	flags uint32
	pipe  bool // stdin: an empty pipe (EOF at once) instead of NUL
}

var variants = []variant{
	{"V1 today's children: new group, stdin NUL", windows.CREATE_NEW_PROCESS_GROUP, false},
	{"V2 new group, stdin an empty pipe", windows.CREATE_NEW_PROCESS_GROUP, true},
	{"V3 detached (no console), stdin NUL", windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS, false},
}

func run(log *os.File, v variant, argv []string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: v.flags}
	cmd.Env = append(os.Environ(), "WSL_UTF8=1")
	cmd.WaitDelay = 2 * time.Second
	if v.pipe {
		cmd.Stdin = strings.NewReader("")
	}
	start := time.Now()
	out, err := cmd.CombinedOutput()
	head := out
	if len(head) > 48 {
		head = head[:48]
	}
	fmt.Fprintf(log, "%s | %q | %s | err=%v\n  out=%q\n  hex=% x\n",
		v.name, argv, time.Since(start).Round(100*time.Millisecond), err, out, head)
}

func matrixAgent(distro string) {
	dir := filepath.Join(os.Getenv("LOCALAPPDATA"), "p0-20")
	_ = os.MkdirAll(dir, 0o755)
	log, err := os.Create(filepath.Join(dir, "matrix.log"))
	if err != nil {
		return
	}
	defer log.Close()
	self, _ := os.Executable()
	hwnd, _, _ := getConsoleWindow.Call()
	fmt.Fprintf(log, "started %s; this process's console window: %#x\n", time.Now().Format(time.RFC3339), hwnd)
	for _, v := range variants {
		fmt.Fprintf(log, "--- %s, at %s\n", v.name, time.Now().Format("15:04:05"))
		run(log, v, []string{"wsl.exe", "-d", distro, "--exec", "/bin/sh", "-c", "tty; ps -o tty= -p $$"})
		run(log, v, []string{"wsl.exe", "-d", distro, "--exec", "sudo", "-k", "true"})
		run(log, v, []string{self, "--console-check"})
		run(log, v, []string{"cmd.exe", "/c", self, "--console-check"})
		time.Sleep(5 * time.Second) // so a window on the screen can be told to one variant
	}
	fmt.Fprintf(log, "--- once, as V1, at %s\n", time.Now().Format("15:04:05"))
	for _, argv := range [][]string{
		{"wsl.exe", "-d", distro, "-u", "root", "--exec", "id", "-u"},
		{"wsl.exe", "-d", distro, "--", "echo", "$HOME"},
		{"wsl.exe", "-d", distro, "--", "systemctl", "--user", "is-active", "novad.service"},
		{"wsl.exe", "-d", distro, "--exec", "systemctl", "--user", "is-active", "novad.service"},
		{"wsl.exe", "-d", distro, "--exec", "sudo", "-n", "true"},
		{"wsl.exe", "--list", "--running", "--quiet"},
		{"wsl.exe", "--list", "--verbose"},
	} {
		run(log, variants[0], argv)
	}
	fmt.Fprintf(log, "--- Windows sudo (a UAC prompt may appear: answer No), at %s\n", time.Now().Format("15:04:05"))
	run(log, variants[0], []string{"sudo.exe", "cmd", "/c", "echo", "hi"})
	if k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Lxss`, registry.READ); err == nil {
		def, _, _ := k.GetStringValue("DefaultDistribution")
		ids, _ := k.ReadSubKeyNames(-1)
		fmt.Fprintf(log, "Lxss DefaultDistribution=%s\n", def)
		for _, id := range ids {
			if sk, err := registry.OpenKey(k, id, registry.READ); err == nil {
				name, _, _ := sk.GetStringValue("DistributionName")
				ver, _, _ := sk.GetIntegerValue("Version")
				fmt.Fprintf(log, "  %s DistributionName=%q Version=%d\n", id, name, ver)
				sk.Close()
			}
		}
		k.Close()
	} else {
		fmt.Fprintf(log, "Lxss: %v\n", err)
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Sudo`, registry.QUERY_VALUE); err == nil {
		v, _, err := k.GetIntegerValue("Enabled")
		fmt.Fprintf(log, "Sudo Enabled=%d err=%v\n", v, err)
		k.Close()
	} else {
		fmt.Fprintf(log, "Sudo key: %v\n", err)
	}
	t := windows.GetCurrentProcessToken()
	var typ, n uint32
	terr := windows.GetTokenInformation(t, windows.TokenElevationType, (*byte)(unsafe.Pointer(&typ)), 4, &n)
	sid, _ := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	member, merr := windows.Token(0).IsMember(sid)
	fmt.Fprintf(log, "token elevated=%v elevationType=%d (1 default, 2 full, 3 limited) err=%v adminsMember=%v err=%v\n",
		t.IsElevated(), typ, terr, member, merr)
	fmt.Fprintf(log, "done %s\n", time.Now().Format(time.RFC3339))
}
```

```bash
S=<scratchpad>/p0-20 && mkdir -p $S && cd $S
~/.local/bin/mise x -- go mod init p0-20 && ~/.local/bin/mise x -- go get golang.org/x/sys@v0.48.0
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 ~/.local/bin/mise x -- go build -trimpath -o p0-20.exe .
sha256sum p0-20.exe
python3 -m http.server 8765 --bind <minipc-tailnet-ip>   # leave running; stop it in Step 4
```

Expected: `p0-20.exe` exists; its sha256 is noted for the owner.

- [ ] **Step 2: Download, marks, Smart App Control, Defender (owner)**

```powershell
$d = Join-Path $env:TEMP 'p0-20'; New-Item -ItemType Directory -Force $d | Out-Null
$f = Join-Path $d 'p0-20.exe'
curl.exe -fsSL -o $f "http://<minipc-tailnet-ip>:8765/p0-20.exe"; $LASTEXITCODE
(Get-FileHash -Algorithm SHA256 $f).Hash                       # must equal Step 1's sha256
Get-Item $f -Stream Zone.Identifier -ErrorAction SilentlyContinue   # the download mark: expect nothing
(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState   # SAC: 0 off, 1 on, 2 evaluation
& $f                                                             # expect "p0-20 ok"; note ANY prompt
Get-MpComputerStatus | Select-Object AMRunningMode, RealTimeProtectionEnabled
Get-MpThreatDetection -ErrorAction SilentlyContinue | Select-Object -First 3   # may need admin: record "unreadable" if so
```

He records: the hash matched (yes/no), a `Zone.Identifier` stream (present/absent), the SAC value, whether SmartScreen, Smart App Control or Defender showed anything, and Defender's two fields.

- [ ] **Step 2b: What a command meets on the Dell — a terminal, sudo, WSL (owner: one command, then watch)**

Run it while the old WSL agent is still running, if it is (its unit is one of the readings). Close nothing; a UAC prompt may appear near the end — answer **No**.

```powershell
& $f --matrix Ubuntu-26.04          # prints "matrix started"; now watch the screen for ~3 minutes
Start-Sleep 180; Get-Content "$env:LOCALAPPDATA\p0-20\matrix.log"
```

He records: any window that appeared and roughly when (the log times each variant), whether a UAC prompt appeared, and pastes the whole `matrix.log` to the controller.

- [ ] **Step 3: The Run key, the flash, window close, sign-out, a running rename (owner)**

```powershell
& $f --detach                     # watch the screen: does a console window flash? how long?
Start-Sleep 25; Get-Content "$env:LOCALAPPDATA\p0-20\beat.log" -Tail 2
# close THIS PowerShell window now, wait 30 s, open a new one:
Get-Content "$env:LOCALAPPDATA\p0-20\beat.log" -Tail 2   # still beating after the window closed?
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'P0-20 probe' -Value ('"' + "$env:TEMP\p0-20\p0-20.exe" + '" --detach') -PropertyType String -Force | Out-Null
# sign out, sign back in; watch for a flash at sign-in; then:
Get-Content "$env:LOCALAPPDATA\p0-20\beat.log" -Tail 3   # beating again? session id interactive (not 0)?
Rename-Item "$env:TEMP\p0-20\p0-20.exe" 'p0-20.running.exe'; $?   # rename while it runs: True?
Rename-Item "$env:TEMP\p0-20\p0-20.running.exe" 'p0-20.exe'
Get-Process p0-20 | Stop-Process
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'P0-20 probe'
Remove-Item -Recurse -Force "$env:TEMP\p0-20", "$env:LOCALAPPDATA\p0-20"
```

He records: flash (none / a blink under ~0.5 s / longer), still beating after the window closed (yes/no), beating after sign-in (yes/no; the session id), the rename (True/False), and `breakaway=` from the `--detach` line.

- [ ] **Step 4: Record, select the branches, stop the server (controller)**

Stop `http.server`. Add to `docs/plans/rebuild/hub-p0-measurements.md`, under a new `## Measured <date>: S42b's Phase 0` heading, a `### P0-20` section with a table of each reading, then the branches:

- **Card wording (Windows tab).** SAC 0 or 2 and no prompt → **W1**: the card says nothing about SmartScreen for a `curl.exe` download, only "the agent is unsigned for now". SAC 1 → **W2**: the Windows tab states "cannot: Smart App Control is on and blocks unsigned programs; Nova's agent is unsigned for now" (owner decision 12). Record which, and write the exact sentence into Task 19's `agent_card.WINDOWS_NOTE`.
- **Launcher.** No flash, or a blink the owner accepts → **A** (P6 as written). A flash the owner does not accept → **B**: build Task 12b.
- **Window close.** Survives → P6 as written. Killed with the window → keep `CREATE_BREAKAWAY_FROM_JOB` mandatory and re-test; still killed → owner question.
- **Sign-out.** Beating after sign-in → the Run key meets "starts by itself". Not beating → stop: a Run-key launcher cannot meet decision R1.
- **Running rename.** True → Task 9's `Swap` as written. False → Task 9 swaps by copying `.new` over a stopped binary: `supervise` re-launches itself from `novad.exe.prev` before the swap (record the branch; Task 9 Step 3 has both).
- **Defender.** Nothing → proceed. A detection → owner question (signing), recorded verbatim.
- The design-inputs' two helper checks (UAC for an unsigned LocalSystem service; Defender on that) moved to S42c with the helper. Say so in the section.
- **The terminal (P30), from `matrix.log`.** For each variant: what `tty` / `ps -o tty=` printed inside WSL ("not a tty" and "?" mean no terminal), how long `sudo -k true` took and what it said, and each `--console-check` line.
  - **T1** — V2 gives the Linux side no terminal and `sudo -k true` fails in under 2 s, and no V2 line shows `visible=true` → Task 10c's Windows branch T1 (an empty stdin pipe for every child; the hidden console stays, so no window).
  - **T2** — only V3 does → branch T2 (`DETACHED_PROCESS` for a child whose program is `wsl.exe`/`wsl`, every other child as V2). Record whether V3's `cmd.exe /c … --console-check` line says `visible=true` (a grandchild window under a detached child); that is why T2 is limited to `wsl.exe`.
  - **T3** — no variant does → Task 10c ships its Unix half only; the Windows half becomes a carry and an owner question, quoted with the readings.
  - Also record V1's reading: it is the S42b agent without Task 10c, i.e. what turn `01faf3b7` would meet after S42b — and whether it hung.
- **`wsl.exe` and a shell.** `-- echo $HOME` printed a path → `wsl.exe` hands its command line to the distro's shell (`--exec` does not): `device_run`'s description says so (Task 21). It printed `$HOME` → the description says `wsl.exe` runs no shell either. (Turn `73574d49`'s reading "no shell" was not checked; this is the check.)
- **`systemctl --user` through `wsl.exe`.** Record both `is-active` lines. Either answered a state → the look in Task 10b needs nothing more (its `XDG_RUNTIME_DIR` default stays: it is harmless). Both said `Failed to connect to bus` → keep the default and record that her own `systemctl --user` needs `XDG_RUNTIME_DIR=/run/user/<uid>`; Task 16b's unit sentence then says so.
- **`-u root`.** `id -u` printed `0` with no prompt → the look's `root` check measures it per distro (as written).
- **The distribution list.** The `Lxss` lines name every distro `--list --verbose` shows → **L-reg** (Task 10b reads the registry, as written). They do not → **L-cli**: `platform.WSLDistros` lists names from `wsl.exe --list --quiet` (decoded by `DecodeWSL`) with `Default: false` and `Version: 0`, and Task 16b says "default unknown". Record the exit code and the words of `--list --running --quiet`: they are what `running_said` carries when it fails.
- **Windows sudo.** The `Sudo Enabled=` value (0 off, 1 new window, 2 input closed, 3 inline; the key missing means no sudo on this build) and what `sudo.exe cmd /c echo hi` did from the agent-like process. It exited at once without a prompt → **S-fails**: Task 16b's `WINDOWS_SUDO_FROM_AGENT` is `" — and from Nova's agent it fails at once: nobody is at a console to approve it"`. A UAC prompt appeared → **S-prompts**: `" — and from Nova's agent it puts a UAC prompt on his desktop that her command cannot answer"`. Record which, and the exit code (turn `3743df3b` saw `0x80070005`).
- **The token.** `elevationType` 3 (limited) → he is an administrator behind UAC, the case Task 16b words as "asks for his consent at a UAC prompt"; 1 with `adminsMember=false` → a standard account.

Move P0-20 out of "Still to measure".

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add docs/plans/rebuild/hub-p0-measurements.md
git -C $W commit -m "docs(s42b): P0-20 and the command matrix measured on the Dell — the branches they select"
git -C $W show --stat HEAD | tail -3
```

---

## Task 2: Phase 0 — `agent-dist` on the N150 (build time, reproducibility against CI) and the loopback door's address

The controller runs these on the mini PC. Probes only.

**Files:**
- Modify: `docs/plans/rebuild/hub-p0-measurements.md` (`### agent-dist on the N150`, `### The loopback door`)

- [ ] **Step 1: Pin the image digest**

```bash
docker pull -q golang:1.27.1 && docker buildx imagetools inspect golang:1.27.1 --format '{{json .Manifest.Digest}}'
```

Expected: one `sha256:…` digest. Record it; Task 25 pins `golang:1.27.1@<digest>`.

- [ ] **Step 2: Build the six targets cold and warm, stamped exactly as CI stamped main**

CI's artifact for `main` at `06776ee5` (or whichever main commit has a finished `rebuild-ci` run) carries `-X main.version=<first 12 of that commit>`. Build the same commit with the same stamp:

```bash
C=$(git -C ~/workspace/nova rev-parse origin/main); STAMP=${C:0:12}
docker volume create p0-gocache >/dev/null
for pass in cold warm; do
  [ $pass = cold ] && docker run --rm -v p0-gocache:/cache alpine sh -c 'rm -rf /cache/*'
  start=$(date +%s)
  git -C ~/workspace/nova archive --format=tar "$C" apps/novad | docker run --rm -i \
    -e CGO_ENABLED=0 -e GOTOOLCHAIN=local -e GOCACHE=/cache/build -e GOMODCACHE=/cache/mod \
    -v p0-gocache:/cache -v /tmp/p0-dist:/out golang:1.27.1 sh -c "
      mkdir /src && tar -x -C /src && cd /src/apps/novad &&
      for t in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
        os=\${t%/*}; arch=\${t#*/}; ext=; [ \$os = windows ] && ext=.exe
        GOOS=\$os GOARCH=\$arch go build -trimpath -buildvcs=false -ldflags '-s -w -buildid= -X main.version=$STAMP' -o /out/novad-\$os-\$arch\$ext . || exit 1
      done"
  echo "$pass: $(( $(date +%s) - start )) s"
done
(cd /tmp/p0-dist && sha256sum novad-* | sort) > /tmp/p0-local.sha && cat /tmp/p0-local.sha
unset GH_TOKEN; RUN=$(gh run list --repo jeremyspofford/nova --workflow rebuild-ci --branch main --commit "$C" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run download "$RUN" --repo jeremyspofford/nova -n "novad-$C" -D /tmp/p0-ci && (cd /tmp/p0-ci && sha256sum novad-* | sort) > /tmp/p0-ci.sha
diff /tmp/p0-local.sha /tmp/p0-ci.sha && echo IDENTICAL
docker volume rm p0-gocache >/dev/null; rm -rf /tmp/p0-dist /tmp/p0-ci
```

Expected: two wall times and `IDENTICAL`. Record the times, the Go version (`docker run --rm golang:1.27.1 go version`), and the verdict — **not** the hashes (the repo is public; a hash of a real build is not a secret, but it names nothing useful and changes every commit).

**Branches.** `IDENTICAL` → D13 holds on the N150; Task 25 as written. Different → **stop**; do not build Task 25 until the cause is found (Go patch, `GOAMD64`, flags, the tar's file modes) and recorded. Cold build over 10 minutes → Task 27's `./install` prints "building Nova's agent for six systems (about N min on this machine)" before it starts; under → no message. The build is keyed by the tree either way, so it runs only when `apps/novad` changed.

- [ ] **Step 3: What source address does core see through the loopback door and through the tailnet?**

```bash
cd ~/workspace/nova
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/v1/auth/state
docker compose --project-directory deploy logs web --since 1m --no-log-prefix | tail -1
curl -s -o /dev/null -w '%{http_code}\n' https://nova.<TAILNET>.ts.net/api/v1/auth/state
docker compose --project-directory deploy logs web --since 1m --no-log-prefix | tail -1
grep -E '^NOVA_(SUBNET_GATEWAY|WEB_ADDR|TAILSCALE_ADDR)=' deploy/.env
```

Expected: the first access-log line's client address is `NOVA_SUBNET_GATEWAY` (docker's gateway); the second is `NOVA_TAILSCALE_ADDR`. Record both readings as "the gateway" / "the sidecar" (not the literal addresses).

**Branch.** Both as expected → P15 and Task 17 as written. The loopback line shows anything else (for example `127.0.0.1` because the userland proxy is off) → Task 17's `door_of` maps THAT source to `host`, and the section says which.

- [ ] **Step 4: Record and commit**

Add both sections with their branches to `hub-p0-measurements.md`.

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add docs/plans/rebuild/hub-p0-measurements.md
git -C $W commit -m "docs(s42b): agent-dist measured on the N150, and the loopback door's source address"
git -C $W show --stat HEAD | tail -3
```

---

## Task 3: Phase 0 — Linux self-linger without sudo

**Files:**
- Modify: `docs/plans/rebuild/hub-p0-measurements.md` (`### Self-linger without sudo`)

- [ ] **Step 1: Read the policy (controller, read-only)**

```bash
systemctl --version | head -1
pkaction --verbose --action-id org.freedesktop.login1.set-self-linger | sed -n '/implicit/,$p'
loginctl show-user "$USER" -p Linger
```

Expected: three `implicit any / inactive / active` lines. On current systemd the usual reading is `active: yes`, `inactive: auth_admin_keep`.

- [ ] **Step 2: A real attempt where linger is off (owner, optional)**

Only if the owner agrees to a throwaway user:

```bash
sudo useradd -m nova-p0 && sudo passwd nova-p0
ssh nova-p0@localhost 'loginctl enable-linger; loginctl show-user nova-p0 -p Linger'   # an INACTIVE (ssh) session
# optional: log in as nova-p0 at the local console or desktop, run the same two commands (an ACTIVE session)
sudo loginctl disable-linger nova-p0; sudo userdel -r nova-p0
```

- [ ] **Step 3: Record, select, commit**

**Branches.** `active: yes` → **L1**: the Linux card says nothing extra; `install` turns linger on when run from a desktop session and, from an SSH session, prints `sudo loginctl enable-linger <user>` once (P26). `active: auth_admin*` → **L2**: the Linux tab adds "starting at boot needs `sudo loginctl enable-linger $USER` once". Record which; Task 19's `agent_card.LINUX_NOTE` takes the sentence.

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add docs/plans/rebuild/hub-p0-measurements.md
git -C $W commit -m "docs(s42b): self-linger without sudo, measured — the Linux card's wording"
git -C $W show --stat HEAD | tail -3
```

---
## Task 4: One version everywhere — the `apps/novad` tree

**Files:**
- Create: `deploy/agent_version.sh`, `deploy/agent_version_test.sh`
- Modify: `.github/workflows/rebuild-ci.yml` (the `novad` job's build step; the `installer` job), `apps/novad/README.md` ("Build")

**Interfaces:**
- Consumes: nothing.
- Produces: `bash deploy/agent_version.sh [<repo root>]` prints exactly 12 lowercase hex characters (the tree `HEAD:apps/novad`) and exits 0, or exits 1 with `agent_version: cannot: …` on stderr. Used by Task 25 (`build.sh`'s caller), Task 27 (`install.sh`) and CI.

- [ ] **Step 1: Write the failing test**

`deploy/agent_version_test.sh` (mode 0755):

```bash
#!/usr/bin/env bash
# Tests for deploy/agent_version.sh — the agent's version is the git TREE of
# apps/novad (S42b P2): the same tree builds the same bytes, so the same
# version names the same binary on CI, the hub and any laptop.
#     deploy/agent_version_test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PASS=0
FAIL=0
report() {
  if [ "$1" -eq 0 ]; then PASS=$((PASS + 1)); printf 'ok   %s\n' "$2"
  else FAIL=$((FAIL + 1)); printf 'FAIL %s\n     %s\n' "$2" "${3:-}"; fi
}
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
git -C "$T" init -q
git -C "$T" config user.email test@example.com
git -C "$T" config user.name test
mkdir -p "$T/apps/novad" "$T/docs"
echo 'package main' > "$T/apps/novad/main.go"
echo one > "$T/docs/x.md"
git -C "$T" add apps docs && git -C "$T" commit -qm one

want="$(git -C "$T" rev-parse HEAD:apps/novad | cut -c1-12)"
got="$(bash "$SCRIPT_DIR/agent_version.sh" "$T")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$got" = "$want" ] && [ "${#got}" -eq 12 ]; then
  report 0 "the version is exactly 12 hex of the apps/novad tree"
else
  report 1 "the version is exactly 12 hex of the apps/novad tree" "rc=$rc got='$got' want='$want'"
fi

echo two > "$T/docs/x.md" && git -C "$T" commit -qam two
got2="$(bash "$SCRIPT_DIR/agent_version.sh" "$T")"
[ "$got2" = "$got" ] && report 0 "a commit outside apps/novad keeps the version" \
  || report 1 "a commit outside apps/novad keeps the version" "$got2 != $got"

echo '// changed' >> "$T/apps/novad/main.go"
out="$(bash "$SCRIPT_DIR/agent_version.sh" "$T" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'uncommitted'; then
  report 0 "uncommitted changes in apps/novad refuse (a stamp would lie)"
else
  report 1 "uncommitted changes in apps/novad refuse (a stamp would lie)" "rc=$rc out=$out"
fi

git -C "$T" commit -qam three
got3="$(bash "$SCRIPT_DIR/agent_version.sh" "$T")"
[ "$got3" != "$got" ] && report 0 "a commit inside apps/novad moves the version" \
  || report 1 "a commit inside apps/novad moves the version" "still $got3"

N="$(mktemp -d)"
out="$(bash "$SCRIPT_DIR/agent_version.sh" "$N" 2>&1)"; rc=$?
rm -rf "$N"
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'not a git checkout'; then
  report 0 "outside a git checkout it says cannot"
else
  report 1 "outside a git checkout it says cannot" "rc=$rc out=$out"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash ~/workspace/nova/.worktrees/s42b/deploy/agent_version_test.sh`
Expected: FAIL on every case (`agent_version.sh: No such file or directory`).

- [ ] **Step 3: Write `deploy/agent_version.sh`** (mode 0755)

```bash
#!/usr/bin/env bash
# The agent's version: the first 12 hex characters of the git TREE of
# apps/novad at HEAD (hub D13, S42b P2). The same tree builds the same bytes,
# so the same version names the same sha256 on CI, on the hub (agent-dist) and
# on a laptop. `cut -c1-12`, never `--short=12`: git lengthens a short hash to
# keep it unambiguous, and core stores exactly 12.
#
# Refuses when apps/novad has uncommitted changes: a stamp of HEAD's tree on
# files that differ from it would be a version that lies.
#     deploy/agent_version.sh [<repo root>]
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}"
if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "agent_version: cannot: $ROOT is not a git checkout, so the agent's version (its apps/novad tree) cannot be read" >&2
  exit 1
fi
if [ -n "$(git -C "$ROOT" status --porcelain -- apps/novad)" ]; then
  echo "agent_version: cannot: apps/novad has uncommitted changes — commit them first; the version names the committed tree" >&2
  exit 1
fi
git -C "$ROOT" rev-parse HEAD:apps/novad | cut -c1-12
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bash ~/workspace/nova/.worktrees/s42b/deploy/agent_version_test.sh && shellcheck -S warning ~/workspace/nova/.worktrees/s42b/deploy/agent_version.sh ~/workspace/nova/.worktrees/s42b/deploy/agent_version_test.sh`
Expected: `5 passed, 0 failed`; shellcheck silent.

- [ ] **Step 5: CI and the README use the tree**

In `.github/workflows/rebuild-ci.yml`, `novad` job, step "six targets, built twice, identical": replace the comment and the `-X` value.

```yaml
        run: |
          set -eu
          # The version is 12 hex of the apps/novad TREE (S42b P2) — the same
          # value deploy/agent_version.sh and agent-dist stamp, so the hub's
          # build and CI's build of one tree are byte-identical.
          V=$(git rev-parse HEAD:apps/novad | cut -c1-12)
          for pass in a b; do
            export GOCACHE="/tmp/gocache-$pass"
            mkdir -p "/tmp/novad-$pass"
            for t in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
              os=${t%/*}; arch=${t#*/}; ext=""
              if [ "$os" = windows ]; then ext=".exe"; fi
              GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=false \
                -ldflags "-s -w -buildid= -X main.version=$V" \
                -o "/tmp/novad-$pass/novad-$os-$arch$ext" .
            done
          done
```

In the `installer` job, extend the three lines that already list deploy scripts:

```yaml
      - run: bash -n deploy/agent_version.sh && bash -n deploy/agent_version_test.sh
      - run: shellcheck -S warning deploy/agent_version.sh deploy/agent_version_test.sh
      - run: ./deploy/agent_version_test.sh
```

In `apps/novad/README.md`, section "Build": the `-X main.version=$(git rev-parse --short=12 HEAD)` becomes `-X main.version=$(bash deploy/agent_version.sh)` (run from the repo root), and the paragraph under it reads: "The version stamp is 12 hex characters of the **`apps/novad` tree** — CI, the hub's `agent-dist` and this command stamp the same value — so one tree builds one sha256, byte for byte, wherever it is built. A change outside `apps/novad` does not change the agent's version."

- [ ] **Step 6: Lint and commit**

```bash
W=~/workspace/nova/.worktrees/s42b
python3 -c "import yaml; yaml.safe_load(open('$W/.github/workflows/rebuild-ci.yml')); print('yaml ok')"
git -C $W add deploy/agent_version.sh deploy/agent_version_test.sh .github/workflows/rebuild-ci.yml apps/novad/README.md
git -C $W commit -m "feat(deploy): the agent's version is its apps/novad tree — one stamp for CI, the hub and a laptop"
git -C $W show --stat HEAD | tail -5
```

---

## Task 5: `internal/state` — the locks, the status files, and the mode from the supervisor

**Files:**
- Create: `apps/novad/internal/state/state.go`, `lock.go`, `lock_unix.go`, `lock_windows.go`, `state_test.go`
- Create: `apps/novad/internal/platform/mode.go`, `mode_test.go`
- Modify: `apps/novad/internal/platform/session_linux.go`, `session_darwin.go`, `session_windows.go` (`Mode` → `osMode`)
- Modify: `apps/novad/internal/platform/fake.go` (`Seq`)
- Modify: `apps/novad/internal/client/client.go` (`Options`, `Configure`, state callbacks)
- Modify: `apps/novad/main.go` (`run` takes the lock and writes its status; `status` prints it), `apps/novad/main_test.go`

**Interfaces:**
- Consumes: `config.Paths.StateDir`.
- Produces:
  - `state` constants `AgentStatusFile`, `SupervisorStatusFile`, `UpdateFile`, `RunLockFile`, `SuperviseLockFile`, `LogFile`; `StateStarting|StateConnecting|StateReady|StateStopped`; `UpdateStaged|UpdateApplied|UpdateRolledBack`.
  - `type AgentStatus`, `type SupervisorStatus`, `type Update` (fields below); `func WriteJSON(path string, v any) error`; `func ReadJSON(path string, v any) error`.
  - `func Acquire(path string) (*Lock, error)`, `(*Lock).Release() error`, `type HeldError struct{ Path string; PID int }`.
  - `platform.ModeEnv = "NOVA_AGENT_MODE"`, `platform.SupervisorEnv = "NOVA_SUPERVISOR_PID"`, `func Mode() string`, `func Supervised() bool`.
  - `platform.FakeRunner.Seq map[string][]string`.
  - `client.Options{StateDir string; Supervised bool; Binary string; OnState func(state, server string, err error)}`, `(*Agent).Configure(Options)`.
  - `main.statusLines(a *state.AgentStatus, s *state.SupervisorStatus, u *state.Update) []string`.

- [ ] **Step 1: Write the failing tests**

`apps/novad/internal/state/state_test.go`:

```go
package state

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteJSONThenReadJSONRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", AgentStatusFile)
	want := AgentStatus{V: 1, PID: 42, Version: "0123456789ab", Mode: "run-key", State: StateReady,
		Server: "https://nova.fake-tailnet.ts.net", Since: time.Unix(1_790_000_000, 0).UTC()}
	if err := WriteJSON(path, want); err != nil {
		t.Fatal(err)
	}
	var got AgentStatus
	if err := ReadJSON(path, &got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("read back %+v, wrote %+v", got, want)
	}
	leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".*"))
	if len(leftovers) != 0 {
		t.Fatalf("a temp file was left beside the status: %v", leftovers)
	}
}

func TestReadJSONOfAMissingFileIsErrNotExist(t *testing.T) {
	var s AgentStatus
	err := ReadJSON(filepath.Join(t.TempDir(), AgentStatusFile), &s)
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("got %v, want fs.ErrNotExist — never-written must read differently from unreadable", err)
	}
}

func TestReadJSONOfGarbageSaysUnreadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), UpdateFile)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	var u Update
	if err := ReadJSON(path, &u); err == nil || errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("got %v, want an 'unreadable' error", err)
	}
}

// P5: one copy per identity. A second holder — another process, or this one
// through a second open — is refused and told who holds it.
func TestASecondHolderOfTheLockIsRefusedWithTheFirstsPID(t *testing.T) {
	path := filepath.Join(t.TempDir(), RunLockFile)
	first, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Acquire(path)
	var held *HeldError
	if !errors.As(err, &held) || held.PID != os.Getpid() {
		t.Fatalf("second Acquire = %v, want a HeldError naming pid %d", err, os.Getpid())
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	again, err := Acquire(path)
	if err != nil {
		t.Fatalf("after Release the lock must be free again: %v", err)
	}
	_ = again.Release()
}
```

`apps/novad/internal/platform/mode_test.go`:

```go
package platform

import "testing"

// P4: the supervisor's word decides the mode, on every OS.
func TestModeIsTheSupervisorsWordWhenItIsAServiceMode(t *testing.T) {
	for _, m := range []string{"systemd-user", "launch-agent", "run-key"} {
		t.Setenv(ModeEnv, m)
		if got := Mode(); got != m {
			t.Fatalf("%s=%q: Mode() = %q", ModeEnv, m, got)
		}
	}
}

func TestAnUnknownModeWordFallsBackToWhatTheOSSays(t *testing.T) {
	t.Setenv(ModeEnv, "root-kit")
	if got := Mode(); got != osMode() {
		t.Fatalf("an unknown word must never be reported: got %q, want %q", got, osMode())
	}
}

func TestSupervisedIsWhetherASupervisorStartedThisProcess(t *testing.T) {
	t.Setenv(SupervisorEnv, "")
	if Supervised() {
		t.Fatal("no supervisor pid: not supervised")
	}
	t.Setenv(SupervisorEnv, "4242")
	if !Supervised() {
		t.Fatal("a supervisor pid: supervised")
	}
}
```

Append to `apps/novad/main_test.go`:

```go
func TestStatusLinesSayWhatTheStatusFilesSay(t *testing.T) {
	since := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	exit1 := 1
	lines := statusLines(
		&state.AgentStatus{PID: 7, Version: "0123456789ab", Mode: "run-key", State: state.StateReady, Server: "https://nova.fake-tailnet.ts.net", Since: since},
		&state.SupervisorStatus{PID: 6, Version: "0123456789ab", Restarts: 2, LastExit: &exit1, Since: since},
		&state.Update{Version: "fedcba987654", Outcome: state.UpdateRolledBack, Reason: "the new build did not connect within 2m0s", At: since},
	)
	joined := strings.Join(lines, "\n")
	for _, want := range []string{
		"agent:       ready since 2026-09-28T12:00:00Z (pid 7, run-key, build 0123456789ab) via https://nova.fake-tailnet.ts.net",
		"supervisor:  pid 6, 2 restarts, last exit 1",
		"last update: rolled_back fedcba987654 at 2026-09-28T12:00:00Z — the new build did not connect within 2m0s",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in:\n%s", want, joined)
		}
	}
	none := strings.Join(statusLines(nil, nil, nil), "\n")
	if !strings.Contains(none, "agent:       no status yet") {
		t.Errorf("no status file must be said, got:\n%s", none)
	}
}
```

(Add `"novad/internal/state"` to `main_test.go`'s imports; `strings` and `time` are there.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/novad && ~/.local/bin/mise x -- go test ./internal/state/ ./internal/platform/ . 2>&1 | tail -8`
Expected: FAIL — `package novad/internal/state is not in std` / `undefined: ModeEnv` / `undefined: statusLines`.

- [ ] **Step 3: Write `internal/state`**

`apps/novad/internal/state/state.go`:

```go
// Package state is novad's local record of itself, in its state directory
// (S42b): which process holds an identity (the locks), what the running agent
// last said about its connection (agent-status.json), what its supervisor is
// doing (supervisor-status.json), and the last update it staged or applied
// (update.json). `install` reads these to prove an agent came up, `supervise`
// to confirm a new build, `novad status` to say what runs, and the facts to
// report an update's outcome. Every file is written whole — a temp file
// renamed over it — so a reader never sees half a status.
package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	AgentStatusFile      = "agent-status.json"
	SupervisorStatusFile = "supervisor-status.json"
	UpdateFile           = "update.json"
	RunLockFile          = "run.lock"
	SuperviseLockFile    = "supervise.lock"
	LogFile              = "novad.log"
)

// The agent's states, in the order a healthy run passes through them.
const (
	StateStarting   = "starting"
	StateConnecting = "connecting"
	StateReady      = "ready"
	StateStopped    = "stopped"
)

// An update's outcomes: staged by daemon.update; applied or rolled_back by
// supervise after the swap.
const (
	UpdateStaged     = "staged"
	UpdateApplied    = "applied"
	UpdateRolledBack = "rolled_back"
)

// AgentStatus is written by `novad run` at each change of connection state.
// Ready means core accepted the handshake on Server at Since.
type AgentStatus struct {
	V       int       `json:"v"`
	PID     int       `json:"pid"`
	Version string    `json:"version"`
	Mode    string    `json:"mode"`
	State   string    `json:"state"`
	Server  string    `json:"server"`
	Since   time.Time `json:"since"`
	Error   string    `json:"error"`
}

// SupervisorStatus is written by `novad supervise` each time it starts an
// agent or sees one exit.
type SupervisorStatus struct {
	V        int       `json:"v"`
	PID      int       `json:"pid"`
	Version  string    `json:"version"`
	Mode     string    `json:"mode"`
	ChildPID int       `json:"child_pid"`
	Restarts int       `json:"restarts"`
	LastExit *int      `json:"last_exit"`
	Since    time.Time `json:"since"`
}

// Update is the last update this machine staged, applied or rolled back.
type Update struct {
	V       int       `json:"v"`
	Version string    `json:"version"`
	SHA256  string    `json:"sha256"`
	Staged  string    `json:"staged"`
	Outcome string    `json:"outcome"`
	Reason  string    `json:"reason"`
	At      time.Time `json:"at"`
}

// WriteJSON writes v to path whole. The rename is retried briefly: on
// Windows a reader holding the old file open can refuse it for a moment.
func WriteJSON(path string, v any) error {
	body, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(append(body, '\n')); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	for i := 0; ; i++ {
		err = os.Rename(name, path)
		if err == nil || i == 9 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		os.Remove(name)
	}
	return err
}

// ReadJSON reads path into v. A missing file stays fs.ErrNotExist (errors.Is),
// so "never written" reads differently from "unreadable".
func ReadJSON(path string, v any) error {
	body, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, v); err != nil {
		return fmt.Errorf("%s is unreadable: %w", path, err)
	}
	return nil
}
```

`apps/novad/internal/state/lock.go`:

```go
package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// HeldError is Acquire's refusal: another process holds the lock. PID is 0
// when the holder's pid could not be read.
type HeldError struct {
	Path string
	PID  int
}

func (e *HeldError) Error() string {
	if e.PID > 0 {
		return fmt.Sprintf("another novad (pid %d) holds %s", e.PID, e.Path)
	}
	return fmt.Sprintf("another novad holds %s", e.Path)
}

// Lock is a held lock. The OS frees it when the process exits, however it
// exits, so a crash never leaves an identity locked.
type Lock struct{ f *os.File }

var errLocked = errors.New("locked by another holder")

// Acquire takes path's exclusive lock without waiting, then writes this
// process's pid into the file for the next one's refusal to name.
func Acquire(path string) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		f.Close()
		if errors.Is(err, errLocked) {
			return nil, &HeldError{Path: path, PID: readPID(path)}
		}
		return nil, fmt.Errorf("locking %s: %w", path, err)
	}
	if err := f.Truncate(0); err == nil {
		_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	}
	return &Lock{f: f}, nil
}

// Release frees the lock.
func (l *Lock) Release() error {
	unlockFile(l.f)
	return l.f.Close()
}

func readPID(path string) int {
	body, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(body)))
	return pid
}
```

`apps/novad/internal/state/lock_unix.go`:

```go
//go:build !windows

package state

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// flock is per open file description, so even a second open in THIS process
// is refused — which is what the test relies on.
func lockFile(f *os.File) error {
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		if errors.Is(err, unix.EWOULDBLOCK) {
			return errLocked
		}
		return err
	}
	return nil
}

func unlockFile(f *os.File) { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN) }
```

`apps/novad/internal/state/lock_windows.go`:

```go
package state

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// Windows byte-range locks are mandatory — nobody else can even READ a locked
// range — so the lock covers one byte far past the pid text, and the next
// holder can still read who holds it.
const lockOffset = 1 << 20

func lockFile(f *os.File) error {
	ol := &windows.Overlapped{Offset: lockOffset}
	err := windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ol)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return errLocked
	}
	return err
}

func unlockFile(f *os.File) {
	ol := &windows.Overlapped{Offset: lockOffset}
	_ = windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, ol)
}
```

- [ ] **Step 4: The mode from the supervisor**

`apps/novad/internal/platform/mode.go`:

```go
package platform

import "os"

// ModeEnv is how `novad supervise` tells its agent which way the service
// started (S42b P4); SupervisorEnv carries the supervisor's pid. The service
// definitions (unit, plist, Run key) pass --mode to supervise, and supervise
// passes it on here.
const (
	ModeEnv       = "NOVA_AGENT_MODE"
	SupervisorEnv = "NOVA_SUPERVISOR_PID"
)

var serviceModes = map[string]bool{"systemd-user": true, "launch-agent": true, "run-key": true}

// Mode is how this agent was started: its supervisor's word when that is a
// service mode Nova knows, else what the OS can tell by itself (osMode). An
// unknown word is never reported.
func Mode() string {
	if m := os.Getenv(ModeEnv); serviceModes[m] {
		return m
	}
	return osMode()
}

// Supervised is whether `novad supervise` started this process — the one
// case in which exiting to be restarted into a new build is safe.
func Supervised() bool { return os.Getenv(SupervisorEnv) != "" }
```

In each `session_{linux,darwin,windows}.go`, rename `func Mode() string` to `func osMode() string` (bodies unchanged; Windows's doc comment becomes "osMode is foreground: a Windows agent's service mode arrives from its supervisor (mode.go).").

In `internal/platform/fake.go`, add the field and read it first:

```go
	// Seq answers successive calls of one program in order, before Outputs:
	// a test that reads a value, changes it and reads it back scripts both.
	Seq map[string][]string
```

```go
	if q := f.Seq[name]; len(q) > 0 {
		f.Seq[name] = q[1:]
		return q[0], nil
	}
```

(placed after the `Errs` check, before `Outputs`).

- [ ] **Step 5: The agent reports its state; `run` holds the lock; `status` reads it**

In `internal/client/client.go` add, beside `Agent`'s fields:

```go
	// opts are what main hands the agent beyond its identity (S42b).
	opts Options
```

and the type and setter:

```go
// Options are what main hands an Agent beyond its identity (S42b): where its
// local status lives, whether a supervisor started it, the binary it runs
// as, and a callback for each change of connection state.
type Options struct {
	StateDir   string
	Supervised bool
	Binary     string
	OnState    func(state, server string, err error)
}

// Configure sets the options. Call it before Run.
func (a *Agent) Configure(o Options) { a.opts = o }

func (a *Agent) state(st, server string, err error) {
	if a.opts.OnState != nil {
		a.opts.OnState(st, server, err)
	}
}
```

In `connectOnce`, call `a.state(state.StateConnecting, a.cfg.Server, nil)` before the dial, `a.state(state.StateReady, a.cfg.Server, nil)` right after `a.logf("authenticated; serving")`, and in `Run`, after `a.logf("connection ended: %v", err)`, call `a.state(state.StateConnecting, "", err)`. (Import `novad/internal/state`. Task 6 replaces `a.cfg.Server` with the locator in use.)

In `main.go`, `cmdRun`: after `checkEnrolled`/`Load`, before `audit.Open`:

```go
	lock, err := state.Acquire(filepath.Join(paths.StateDir, state.RunLockFile))
	if err != nil {
		// Exit 1, never 78: the other copy may stop, and a supervisor retries.
		fail("%v — this identity is already running; stop that copy first", err)
	}
	defer lock.Release()
	statusPath := filepath.Join(paths.StateDir, state.AgentStatusFile)
	writeStatus := func(st, server string, e error) {
		s := state.AgentStatus{V: 1, PID: os.Getpid(), Version: version, Mode: platform.Mode(),
			State: st, Server: server, Since: time.Now().UTC()}
		if e != nil {
			s.Error = e.Error()
		}
		if err := state.WriteJSON(statusPath, s); err != nil {
			logger.Printf("could not write %s: %v", statusPath, err)
		}
	}
```

(move `logger := …` above it), then `writeStatus(state.StateStarting, cfg.Server, nil)`, and after `client.New`:

```go
	self, _ := os.Executable()
	agent.Configure(client.Options{StateDir: paths.StateDir, Supervised: platform.Supervised(), Binary: self, OnState: writeStatus})
```

and before each return/exit after `agent.Run`: `writeStatus(state.StateStopped, "", runErr)`.

`cmdStatus` prints the status files after the existing lines:

```go
	var ag *state.AgentStatus
	var sv *state.SupervisorStatus
	var up *state.Update
	if a := new(state.AgentStatus); state.ReadJSON(filepath.Join(paths.StateDir, state.AgentStatusFile), a) == nil {
		ag = a
	}
	if s := new(state.SupervisorStatus); state.ReadJSON(filepath.Join(paths.StateDir, state.SupervisorStatusFile), s) == nil {
		sv = s
	}
	if u := new(state.Update); state.ReadJSON(filepath.Join(paths.StateDir, state.UpdateFile), u) == nil {
		up = u
	}
	for _, line := range statusLines(ag, sv, up) {
		fmt.Println(line)
	}
```

and the pure formatter:

```go
// statusLines says what the status files say — and that there is none when
// there is none, never a guess. A "ready" is what the agent last wrote, not
// a live probe; the reachability line below it is the probe.
func statusLines(a *state.AgentStatus, s *state.SupervisorStatus, u *state.Update) []string {
	var out []string
	if a == nil {
		out = append(out, "agent:       no status yet (it has not run since S42b's build)")
	} else {
		line := fmt.Sprintf("agent:       %s since %s (pid %d, %s, build %s)", a.State,
			a.Since.UTC().Format(time.RFC3339), a.PID, a.Mode, a.Version)
		if a.Server != "" {
			line += " via " + a.Server
		}
		out = append(out, line)
		if a.Error != "" {
			out = append(out, "             last error: "+a.Error)
		}
	}
	if s != nil {
		line := fmt.Sprintf("supervisor:  pid %d, %d restarts", s.PID, s.Restarts)
		if s.LastExit != nil {
			line += fmt.Sprintf(", last exit %d", *s.LastExit)
		}
		out = append(out, line)
	}
	if u != nil {
		line := fmt.Sprintf("last update: %s %s at %s", u.Outcome, u.Version, u.At.UTC().Format(time.RFC3339))
		if u.Reason != "" {
			line += " — " + u.Reason
		}
		out = append(out, line)
	}
	return out
}
```

(`main.go` imports gain `path/filepath` and `novad/internal/state`.)

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -10
for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done
```

Expected: every package `ok`; vet silent on all three.

- [ ] **Step 7: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/novad/internal/state apps/novad/internal/platform/mode.go apps/novad/internal/platform/mode_test.go \
  apps/novad/internal/platform/session_linux.go apps/novad/internal/platform/session_darwin.go apps/novad/internal/platform/session_windows.go \
  apps/novad/internal/platform/fake.go apps/novad/internal/client/client.go apps/novad/main.go apps/novad/main_test.go
git -C $W commit -m "feat(novad): one copy per identity, and a status file that says whether the agent came up"
git -C $W show --stat HEAD | tail -5
```

---

## Task 6: Ordered locators — a hub that moved does not strand an agent

**Files:**
- Modify: `apps/novad/internal/config/config.go` (`Locators`, `Hubs`, `SetAside`), `config_test.go`
- Modify: `apps/novad/internal/client/client.go` (dial each locator in order; skip one that presents another key), `integration_test.go`
- Modify: `apps/novad/repoint.go`, `repoint_test.go`

**Interfaces:**
- Consumes: Task 5's `a.state(...)`.
- Produces:
  - `config.Config.Locators []string` (`json:"locators,omitempty"`); `func (c Config) Hubs() []string` (Locators, else `[Server]`).
  - `func SetAside(p Paths, now time.Time, tag string) ([]string, error)` — renames `config.json`, `key` and `audit.jsonl` to `<name>.<tag>-<unix>` (never overwriting), returns the new paths. Used by Task 11 (`tag="replaced"`) and `uninstall --forget` (`tag="forgotten"`).
  - `(*Agent).Server() string` — the locator this agent is connected through now (Task 10's download base).

- [ ] **Step 1: Write the failing tests**

Append to `internal/config/config_test.go`:

```go
func TestHubsAreTheLocatorsElseTheServer(t *testing.T) {
	c := Config{Server: "https://a.example"}
	if got := c.Hubs(); !reflect.DeepEqual(got, []string{"https://a.example"}) {
		t.Fatalf("a pre-S42b config: got %v", got)
	}
	c.Locators = []string{"http://127.0.0.1:3000", "https://a.example"}
	got := c.Hubs()
	if !reflect.DeepEqual(got, c.Locators) {
		t.Fatalf("got %v", got)
	}
	got[0] = "mutated"
	if c.Locators[0] == "mutated" {
		t.Fatal("Hubs must return a copy")
	}
}

func TestSetAsideRenamesTheIdentityAndNeverOverwrites(t *testing.T) {
	p := testPaths(t)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := Save(p, Config{DeviceID: "d1", Server: "https://a.example", CorePubKey: strings.Repeat("ab", 32)}, priv); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.AuditFile, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_790_000_000, 0)
	moved, err := SetAside(p, now, "replaced")
	if err != nil || len(moved) != 3 {
		t.Fatalf("SetAside = %v, %v", moved, err)
	}
	for _, f := range []string{p.ConfigFile, p.KeyFile, p.AuditFile} {
		if _, err := os.Lstat(f); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s is still in place", f)
		}
	}
	if _, err := os.Lstat(p.ConfigFile + ".replaced-1790000000"); err != nil {
		t.Errorf("config was not set aside by name: %v", err)
	}
	// A second identity set aside in the same second keeps the first.
	if err := Save(p, Config{DeviceID: "d2", Server: "https://a.example", CorePubKey: strings.Repeat("ab", 32)}, priv); err != nil {
		t.Fatal(err)
	}
	if _, err := SetAside(p, now, "replaced"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(p.ConfigFile + ".replaced-1790000000-1"); err != nil {
		t.Errorf("the second set-aside overwrote the first: %v", err)
	}
}
```

(`testPaths` exists in `config_test.go`; if it does not, build `Paths` from `t.TempDir()` the way `TestSaveThenLoadRoundTripsTheKey` does. Imports: `reflect`, `errors`, `io/fs`, `crypto/ed25519`, `crypto/rand`, `strings`, `time`.)

Append to `internal/client/integration_test.go`:

```go
// buildAgentWithHubs is buildAgent with an ordered locator list (S42b).
func buildAgentWithHubs(t *testing.T, hubs []string, deviceID, corePubHex string, devPriv ed25519.PrivateKey) *Agent {
	t.Helper()
	home := t.TempDir()
	auditLog, err := audit.Open(filepath.Join(home, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{DeviceID: deviceID, Name: "itest", Server: hubs[0], CorePubKey: corePubHex, Locators: hubs}
	agent, err := New(cfg, devPriv, auditLog, home, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	return agent
}

// acceptingCore answers the challenge with corePub and reports each device
// that authenticated on it.
func acceptingCore(t *testing.T, corePub, devPub ed25519.PublicKey, authed chan<- string, label string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		if fakeCoreHandshake(r.Context(), c, corePub, devPub) != nil {
			authed <- label
		}
		<-r.Context().Done()
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestTheAgentFallsThroughToTheNextLocatorWhenTheFirstDoesNotAnswer(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	authed := make(chan string, 4)
	second := acceptingCore(t, corePub, devPub, authed, "second")
	agent := buildAgentWithHubs(t, []string{"http://127.0.0.1:1", second.URL}, "dev-loc-1", hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() { _ = agent.Run(ctx) }()
	select {
	case got := <-authed:
		if got != "second" {
			t.Fatalf("authenticated on %s", got)
		}
	case <-ctx.Done():
		t.Fatal("the agent never tried its second locator")
	}
	if agent.Server() != second.URL {
		t.Fatalf("Server() = %q, want the locator in use %q", agent.Server(), second.URL)
	}
}

// The loopback of a machine that no longer hosts THIS Nova (the hub moved)
// can answer with another Nova's key: that locator is skipped, not fatal,
// while another locator remains.
func TestALocatorPresentingAnotherCoreKeyIsSkippedWhileAnotherRemains(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	authed := make(chan string, 4)
	stranger := acceptingCore(t, otherPub, devPub, authed, "stranger")
	ours := acceptingCore(t, corePub, devPub, authed, "ours")
	agent := buildAgentWithHubs(t, []string{stranger.URL, ours.URL}, "dev-loc-2", hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- agent.Run(ctx) }()
	select {
	case got := <-authed:
		if got != "ours" {
			t.Fatalf("authenticated on %s — the pinned key must decide", got)
		}
	case err := <-runErr:
		t.Fatalf("Run returned %v — a stranger's key must not be fatal while another locator remains", err)
	case <-ctx.Done():
		t.Fatal("timed out")
	}
}

func TestEveryLocatorPresentingAnotherKeyIsFatal(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	authed := make(chan string, 4)
	a := acceptingCore(t, otherPub, devPub, authed, "a")
	b := acceptingCore(t, otherPub, devPub, authed, "b")
	agent := buildAgentWithHubs(t, []string{a.URL, b.URL}, "dev-loc-3", hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := agent.Run(ctx)
	if err == nil || ctx.Err() != nil || !strings.Contains(err.Error(), "pinned") {
		t.Fatalf("Run = %v, want a fatal naming the pin", err)
	}
}
```

Append to `repoint_test.go` (it reuses the file's `newEnrolment` and `newFakeCore`; add `io` and `reflect` to its imports):

```go
// A repoint puts the proven address first and keeps the device's other
// locators behind it — the loopback of the hub machine stays a fallback.
func TestRepointPutsTheNewAddressFirstAndKeepsTheOthers(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	cfg, priv, err := config.Load(e.paths)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Locators = []string{"http://127.0.0.1:3000", "https://nova.old.example"}
	if err := config.Save(e.paths, cfg, priv); err != nil {
		t.Fatal(err)
	}
	fc := newFakeCore(t, e.corePubHex, e.devPub, coreBehaviour{})
	if err := repoint(e.paths, fc.srv.URL, false, io.Discard); err != nil {
		t.Fatal(err)
	}
	back, _, err := config.Load(e.paths)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{fc.srv.URL, "http://127.0.0.1:3000", "https://nova.old.example"}
	if !reflect.DeepEqual(back.Locators, want) || back.Server != fc.srv.URL {
		t.Fatalf("locators %v, server %q; want %v and %q", back.Locators, back.Server, want, fc.srv.URL)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/novad && ~/.local/bin/mise x -- go test ./internal/config/ ./internal/client/ . 2>&1 | tail -8`
Expected: FAIL — `unknown field Locators`, `undefined: SetAside`, `agent.Server undefined`.

- [ ] **Step 3: Implement**

`config.go`: add the field to `Config` (with the doc comment below), then:

```go
	// Locators are this device's ways to reach its Nova, in order (S42b):
	// the hub's own loopback first on the hub machine, then the tailnet
	// origin. Each is only ever trusted through the core key pinned at
	// enrolment. Empty in a config written before S42b.
	Locators []string `json:"locators,omitempty"`
```

```go
// Hubs are the locators to try, in order: Locators, else the one Server a
// config from before S42b carries. A copy — callers may reorder it.
func (c Config) Hubs() []string {
	if len(c.Locators) > 0 {
		return append([]string(nil), c.Locators...)
	}
	if c.Server != "" {
		return []string{c.Server}
	}
	return nil
}

// SetAside moves an identity out of the way without deleting it — config,
// key and audit log each renamed to "<file>.<tag>-<unix>[-N]", never
// overwriting an earlier one — so a machine can pair again while the old
// record stays on disk. Missing files are skipped; the new paths are
// returned.
func SetAside(p Paths, now time.Time, tag string) ([]string, error) {
	var moved []string
	var errs []error
	for _, f := range []string{p.ConfigFile, p.KeyFile, p.AuditFile} {
		if _, err := os.Lstat(f); err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				errs = append(errs, err)
			}
			continue
		}
		dst, err := freeName(fmt.Sprintf("%s.%s-%d", f, tag, now.Unix()))
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if err := os.Rename(f, dst); err != nil {
			errs = append(errs, err)
			continue
		}
		moved = append(moved, dst)
	}
	return moved, errors.Join(errs...)
}

// freeName is base, or base-1, base-2, … — the first that does not exist.
func freeName(base string) (string, error) {
	candidate := base
	for n := 0; ; n++ {
		if n > 0 {
			candidate = fmt.Sprintf("%s-%d", base, n)
		}
		if _, err := os.Lstat(candidate); errors.Is(err, fs.ErrNotExist) {
			return candidate, nil
		} else if err != nil {
			return "", err
		}
	}
}
```

`setAsideName` (used by `Wipe`) becomes a call to `freeName(fmt.Sprintf("%s.revoked-%d", auditFile, now.Unix()))`; `Wipe`'s tests keep passing unchanged.

`client.go`:
- `Agent` gains `locators []string` and `current atomic.Int32` (import `sync/atomic`); `wsURL` is removed.
- `New`: `a.locators = cfg.Hubs()`; if empty → `errors.New("this enrolment names no server — pair it again")`; validate each with `WSURL` and return the first error.
- `handshake`'s key-mismatch branch returns `fatal{&KeyMismatch{Presented: coreKey, Pinned: a.cfg.CorePubKey}}` (its message still names "pinned").
- `Server()`:

```go
// Server is the locator this agent is connected through now (or last was).
func (a *Agent) Server() string { return a.locators[int(a.current.Load())%len(a.locators)] }
```

- `connectOnce` tries each locator in order, starting from the last good one:

```go
// connectOnce tries each locator in order, starting with the one that last
// worked, and serves the first session that authenticates. A locator that
// answers with another Nova's key is skipped while another remains — the
// loopback of a machine the hub moved away from — and is fatal only when
// every locator did (the pinned key, never a URL, is the identity).
func (a *Agent) connectOnce(ctx context.Context) (bool, error) {
	n := len(a.locators)
	start := int(a.current.Load())
	var lastErr error
	mismatches := 0
	for i := 0; i < n; i++ {
		idx := (start + i) % n
		loc := a.locators[idx]
		authed, err := a.sessionAt(ctx, loc)
		if authed || ctx.Err() != nil {
			a.current.Store(int32(idx))
			return authed, err
		}
		var f fatal
		var km *KeyMismatch
		if errors.As(err, &f) && errors.As(f.err, &km) && n > 1 {
			mismatches++
			a.logf("%s answered with another Nova's key — trying the next address", loc)
			lastErr = err
			continue
		}
		if errors.As(err, &f) {
			return false, err
		}
		a.logf("%s: %v", loc, err)
		lastErr = err
	}
	if n > 1 && mismatches == n {
		return false, fatal{fmt.Errorf("none of this device's %d addresses is the Nova it paired with: %w", n, lastErr)}
	}
	return false, lastErr
}
```

- `sessionAt(ctx, loc)` is the old `connectOnce` body with `wsURL, err := WSURL(loc)`, `a.state(state.StateConnecting, loc, nil)` before the dial and `a.state(state.StateReady, loc, nil)` after the handshake.

`repoint.go`, step 7: `saved.Locators = withFirst(cfg.Hubs(), candidate.Server)` with

```go
// withFirst puts first at the front of hubs, once.
func withFirst(hubs []string, first string) []string {
	out := []string{first}
	for _, h := range hubs {
		if h != first {
			out = append(out, h)
		}
	}
	return out
}
```

and the read-back also checks `back.Locators[0] == candidate.Server`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -10
for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done
```

Expected: all `ok` — including the S42a `TestAChangedCoreKeyIsFatalAndDoesNotReconnect` (one locator: still fatal) and every Wipe test.

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/novad/internal/config apps/novad/internal/client/client.go apps/novad/internal/client/integration_test.go apps/novad/repoint.go apps/novad/repoint_test.go
git -C $W commit -m "feat(novad): ordered locators — an address that answers with another Nova's key is skipped, not fatal"
git -C $W show --stat HEAD | tail -5
```

---

## Task 7: "Desktop" is read on the agent — known folders and `@folder` paths

**Files:**
- Create: `apps/novad/internal/platform/folders.go`, `folders_linux.go`, `folders_darwin.go`, `folders_windows.go`
- Modify: `apps/novad/internal/platform/parse.go`, `parse_test.go` (`ParseUserDirs`)
- Modify: `apps/novad/internal/caps/fs.go`; Create: `apps/novad/internal/caps/fs_folders_test.go`
- Modify: `apps/novad/internal/facts/facts.go`, `facts_test.go` (the `folders` section)

**Interfaces:**
- Produces:
  - `platform.FolderNames = []string{"home", "desktop", "documents", "downloads"}`; `func Folder(name string) (string, error)`; `func ParseUserDirs(body, home string) map[string]string`.
  - `facts.Frame.Folders map[string]string` (`json:"folders,omitempty"`); a folder the OS does not name is an `unreadable` entry `folders.<name>`.
  - The fs capabilities accept `@<folder>` and `@<folder>/<rest>` (either separator), resolved on the machine; a result names the resolved path.
- Consumed by: Task 16 (core validates `folders`), Task 21 (core admits `@folder` paths only for an agent that reported that folder).

- [ ] **Step 1: Write the failing tests**

Append to `internal/platform/parse_test.go`:

```go
// xdg-user-dirs writes a disabled folder as "$HOME" — that is "no such
// folder", never the home directory.
func TestParseUserDirsReadsTheFoldersAndSkipsDisabledOnes(t *testing.T) {
	body := `# written by xdg-user-dirs-update
XDG_DESKTOP_DIR="$HOME/Desktop"
XDG_DOCUMENTS_DIR="/data/docs"
XDG_DOWNLOAD_DIR="$HOME"
XDG_MUSIC_DIR="$HOME/Music"
`
	got := ParseUserDirs(body, "/home/sam")
	want := map[string]string{"desktop": "/home/sam/Desktop", "documents": "/data/docs"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if len(ParseUserDirs("XDG_DESKTOP_DIR=Desktop\n", "/home/sam")) != 0 {
		t.Fatal("a relative path is not a folder the OS names — never guessed")
	}
}
```

`internal/caps/fs_folders_test.go`:

```go
package caps

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withFolders(t *testing.T, folders map[string]string) {
	t.Helper()
	old := folderOf
	folderOf = func(name string) (string, error) {
		if p, ok := folders[name]; ok {
			return p, nil
		}
		return "", errors.New("this machine names no " + name + " folder")
	}
	t.Cleanup(func() { folderOf = old })
}

// P16: "@desktop" is the Desktop as THIS machine names it (OneDrive's on
// Windows), and the listing says which folder that was.
func TestAFolderTokenListsThatFolderAsTheMachineNamesIt(t *testing.T) {
	desk := t.TempDir()
	if err := os.WriteFile(filepath.Join(desk, "note.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	withFolders(t, map[string]string{"desktop": desk})
	out := Dispatch(context.Background(), "fs.list", map[string]any{"path": "@desktop"}, Deps{})
	if !out.OK || !strings.Contains(out.Output, "entries in "+desk) || !strings.Contains(out.Output, "note.txt") {
		t.Fatalf("got %+v", out)
	}
	out = Dispatch(context.Background(), "fs.read", map[string]any{"path": "@desktop/note.txt"}, Deps{})
	if !out.OK || out.Output != "hi" {
		t.Fatalf("got %+v", out)
	}
}

func TestAFolderTokenCannotClimbOutOfItsFolder(t *testing.T) {
	withFolders(t, map[string]string{"desktop": t.TempDir()})
	out := Dispatch(context.Background(), "fs.list", map[string]any{"path": "@desktop/../../etc"}, Deps{})
	if out.OK || !strings.Contains(out.Error, "must stay inside it") {
		t.Fatalf("got %+v", out)
	}
}

func TestAnUnknownFolderTokenIsRefusedByName(t *testing.T) {
	withFolders(t, map[string]string{})
	out := Dispatch(context.Background(), "fs.list", map[string]any{"path": "@pictures"}, Deps{})
	if out.OK || !strings.Contains(out.Error, "@pictures names no folder") {
		t.Fatalf("got %+v", out)
	}
}

func TestAFolderTheMachineDoesNotNameIsACannot(t *testing.T) {
	withFolders(t, map[string]string{})
	out := Dispatch(context.Background(), "fs.list", map[string]any{"path": "@desktop"}, Deps{})
	if out.OK || !strings.HasPrefix(out.Error, "cannot: ") || !strings.Contains(out.Error, "no desktop folder") {
		t.Fatalf("got %+v", out)
	}
}
```

Append to `internal/facts/facts_test.go`:

```go
func TestTheFactsFrameCarriesTheFoldersAndSaysWhichCouldNotBeRead(t *testing.T) {
	oldIf, oldF := readIfaces, readFolder
	t.Cleanup(func() { readIfaces, readFolder = oldIf, oldF })
	readIfaces = func() ([]ifaceInfo, error) { return nil, nil }
	readFolder = func(name string) (string, error) {
		if name == "desktop" {
			return "", errors.New("this machine names no desktop folder")
		}
		return "/home/sam/" + name, nil
	}
	f := GatherFrame(nil)
	if f.Folders["home"] != "/home/sam/home" || f.Folders["documents"] != "/home/sam/documents" {
		t.Fatalf("folders = %v", f.Folders)
	}
	if _, present := f.Folders["desktop"]; present {
		t.Fatal("an unnamed folder must be absent, never a guess")
	}
	found := false
	for _, u := range f.Unreadable {
		if u.Item == "folders.desktop" && strings.Contains(u.Reason, "no desktop folder") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the missing folder must be named in unreadable: %v", f.Unreadable)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/novad && ~/.local/bin/mise x -- go test ./internal/platform/ ./internal/caps/ ./internal/facts/ 2>&1 | tail -8`
Expected: FAIL — `undefined: ParseUserDirs`, `undefined: folderOf`, `undefined: readFolder`.

- [ ] **Step 3: Implement**

`internal/platform/folders.go`:

```go
package platform

import "slices"

// FolderNames are the folders a fs path may name as @<name> (S42b P16),
// resolved on the machine as its OS names them — never guessed from a user
// name. "home" is the user's profile directory.
var FolderNames = []string{"home", "desktop", "documents", "downloads"}

// KnownFolder is whether name is one of FolderNames.
func KnownFolder(name string) bool { return slices.Contains(FolderNames, name) }
```

`internal/platform/parse.go` — add:

```go
// ParseUserDirs reads xdg-user-dirs' user-dirs.dirs (lines such as
// XDG_DESKTOP_DIR="$HOME/Desktop") into name -> absolute path for desktop,
// documents and downloads. "$HOME" alone is how xdg-user-dirs disables a
// folder, and a relative path names nothing: both are skipped, never guessed.
func ParseUserDirs(body, home string) map[string]string {
	keys := map[string]string{"XDG_DESKTOP_DIR": "desktop", "XDG_DOCUMENTS_DIR": "documents", "XDG_DOWNLOAD_DIR": "downloads"}
	out := map[string]string{}
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		name, known := keys[strings.TrimSpace(k)]
		if !ok || !known {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"`)
		switch {
		case v == "$HOME":
			continue
		case strings.HasPrefix(v, "$HOME/"):
			v = home + v[len("$HOME"):]
		case strings.HasPrefix(v, "/"):
		default:
			continue
		}
		out[name] = v
	}
	return out
}
```

`internal/platform/folders_linux.go`:

```go
package platform

import (
	"fmt"
	"os"
	"path/filepath"
)

// Folder is a known folder as this Linux names it: home, else xdg
// user-dirs (a headless server usually names none — said, not guessed).
func Folder(name string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if name == "home" {
		return home, nil
	}
	if !KnownFolder(name) {
		return "", fmt.Errorf("no folder is called %q", name)
	}
	base, err := ConfigBase()
	if err != nil {
		return "", err
	}
	path := filepath.Join(base, "user-dirs.dirs")
	body, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("this machine names no %s folder (%s: %v)", name, path, err)
	}
	if dir, ok := ParseUserDirs(string(body), home)[name]; ok {
		return dir, nil
	}
	return "", fmt.Errorf("this machine names no %s folder (xdg user-dirs has no entry for it)", name)
}
```

`internal/platform/folders_darwin.go`:

```go
package platform

import (
	"fmt"
	"os"
	"path/filepath"
)

// Folder is a known folder on macOS, where the OS fixes these names.
func Folder(name string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch name {
	case "home":
		return home, nil
	case "desktop":
		return filepath.Join(home, "Desktop"), nil
	case "documents":
		return filepath.Join(home, "Documents"), nil
	case "downloads":
		return filepath.Join(home, "Downloads"), nil
	}
	return "", fmt.Errorf("no folder is called %q", name)
}
```

`internal/platform/folders_windows.go`:

```go
package platform

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// Folder is a known folder as Windows names it — the Desktop OneDrive
// redirected, if it did. The walk of 2026-09-28 listed C:\Users\Public\Desktop
// instead: this is the answer to "which desktop", read, never guessed.
func Folder(name string) (string, error) {
	ids := map[string]*windows.KNOWNFOLDERID{
		"home":      windows.FOLDERID_Profile,
		"desktop":   windows.FOLDERID_Desktop,
		"documents": windows.FOLDERID_Documents,
		"downloads": windows.FOLDERID_Downloads,
	}
	id, ok := ids[name]
	if !ok {
		return "", fmt.Errorf("no folder is called %q", name)
	}
	path, err := windows.KnownFolderPath(id, 0)
	if err != nil || path == "" {
		return "", fmt.Errorf("this machine names no %s folder (%v)", name, err)
	}
	return path, nil
}
```

`internal/caps/fs.go` — add the resolver and call it first in `fsList`, `fsRead` and `fsWrite` (`path, err := resolvePath(path); if err != nil { return fail("%v", err) }`, right after the argument check):

```go
// folderOf resolves a known folder; a variable so a test points it at a
// temp dir.
var folderOf = platform.Folder

// resolvePath turns "@desktop", "@desktop/notes.txt" or "@documents\a" into a
// path under that folder as THIS machine names it (S42b P16) — so "my
// desktop" is read on the device, never guessed by the model. Any other path
// is returned as given: core already checked it is absolute for this OS.
func resolvePath(path string) (string, error) {
	if !strings.HasPrefix(path, "@") {
		return path, nil
	}
	name, tail := path[1:], ""
	if i := strings.IndexAny(name, `/\`); i >= 0 {
		name, tail = name[:i], name[i+1:]
	}
	if !platform.KnownFolder(name) {
		return "", fmt.Errorf("cannot: @%s names no folder this agent knows (it knows @%s)",
			name, strings.Join(platform.FolderNames, ", @"))
	}
	base, err := folderOf(name)
	if err != nil {
		return "", fmt.Errorf("cannot: %v", err)
	}
	if tail == "" {
		return base, nil
	}
	clean := filepath.Clean(filepath.FromSlash(tail))
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.IsAbs(clean) {
		return "", fmt.Errorf("cannot: a path under @%s must stay inside it (got %q)", name, tail)
	}
	return filepath.Join(base, clean), nil
}
```

(`fs.go` imports gain `path/filepath` and `novad/internal/platform`.)

`internal/facts/facts.go`: add to `Frame`

```go
	// Folders are the known folders as this OS names them (S42b P16); core
	// admits an @folder path only for a folder listed here.
	Folders map[string]string `json:"folders,omitempty"`
```

a reader variable `var readFolder = platform.Folder`, and at the top of `GatherFrame`, right after `f := …`:

```go
	folders := map[string]string{}
	for _, name := range platform.FolderNames {
		p, err := readFolder(name)
		if err != nil {
			f.Unreadable = append(f.Unreadable, Unreadable{Item: "folders." + name, Reason: clip(err.Error())})
			continue
		}
		folders[name] = clip(p)
	}
	if len(folders) > 0 {
		f.Folders = folders
	}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -10
for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done
```

Expected: all `ok`; vet silent. (The frame now carries up to four paths of ≤255 bytes: far under the 16 KiB cap.)

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/novad/internal/platform/folders.go apps/novad/internal/platform/folders_linux.go apps/novad/internal/platform/folders_darwin.go \
  apps/novad/internal/platform/folders_windows.go apps/novad/internal/platform/parse.go apps/novad/internal/platform/parse_test.go \
  apps/novad/internal/caps/fs.go apps/novad/internal/caps/fs_folders_test.go apps/novad/internal/facts/facts.go apps/novad/internal/facts/facts_test.go
git -C $W commit -m "feat(novad): @desktop and the other known folders, named by the OS on the machine — never guessed"
git -C $W show --stat HEAD | tail -5
```

---
## Task 8: `internal/service` — the unit, the LaunchAgent and the Run key

**Files:**
- Create: `apps/novad/internal/service/service.go`, `service_test.go`
- Create: `apps/novad/internal/service/systemd_linux.go`, `systemd_linux_test.go`
- Create: `apps/novad/internal/service/launchd_darwin.go`, `launchd_darwin_test.go`
- Create: `apps/novad/internal/service/runkey_windows.go`, `runkey_windows_test.go`
- Create: `apps/novad/internal/platform/detach_unix.go`, `detach_windows.go`, `process_unix.go`, `process_windows.go`, `detach_test.go`
- Modify: `apps/novad/novad.service`, `apps/novad/main_unix_test.go` (the S42a unit test)

**Interfaces:**
- Consumes: `config.Paths`, `platform.Runner`/`FakeRunner` (with `Seq`), `state` files.
- Produces:
  - `service.UnitName = "novad.service"`, `Label = "nova.novad"`, `RunKeyPath`, `RunKeyValue = "Nova agent"`, `ModeSystemd|ModeLaunch|ModeRunKey`.
  - `func SystemdUnit(bin string) string`, `func LaunchAgentPlist(bin, logPath string) string`, `func RunKeyCommand(bin string) string`.
  - `type Manager interface { Mode() string; Describe() string; Installed() bool; Install(bin string) error; Restart(ctx) error; RestartLater(ctx, after time.Duration) error; Stop(ctx) error; Uninstall(ctx) error; BootStart(ctx) (bool, string, error) }`; `func New(paths config.Paths, r platform.Runner) Manager` per OS.
  - `platform.StartDetached(bin string, args []string, logPath string) (int, error)`; `platform.ProcessAlive(pid int) bool`; `platform.Terminate(pid int) error`; Windows only: `platform.ProcessIsNovad(pid int) bool`.

- [ ] **Step 1: Write the failing tests**

`apps/novad/internal/service/service_test.go` (every OS):

```go
package service

import (
	"encoding/xml"
	"strings"
	"testing"
)

// P3: supervise exits 0 when the agent can never get in, so a unit that
// restarts only on failure leaves a revoked device stopped.
func TestTheUnitRestartsOnlyOnFailure(t *testing.T) {
	u := SystemdUnit("/home/sam/.local/bin/novad")
	for _, want := range []string{
		"ExecStart=/home/sam/.local/bin/novad supervise --mode systemd-user\n",
		"Restart=on-failure\n",
		"RestartPreventExitStatus=78\n",
		"WantedBy=default.target\n",
	} {
		if !strings.Contains(u, want) {
			t.Errorf("unit lacks %q:\n%s", want, u)
		}
	}
	if strings.Contains(u, "Restart=always") {
		t.Fatal("Restart=always would restart a supervisor that stopped for good")
	}
}

func TestTheUnitQuotesAPathWithASpaceOrASpecifier(t *testing.T) {
	u := SystemdUnit("/home/sam doe/bin/novad%x")
	if !strings.Contains(u, `ExecStart="/home/sam doe/bin/novad%%x" supervise --mode systemd-user`) {
		t.Fatalf("got:\n%s", u)
	}
}

func TestThePlistDoesNotRestartACleanExit(t *testing.T) {
	p := LaunchAgentPlist("/Users/sam/Library/Application Support/Nova/novad", "/Users/sam/Library/Logs/novad&.log")
	for _, want := range []string{
		"<key>Label</key><string>nova.novad</string>",
		"<string>/Users/sam/Library/Application Support/Nova/novad</string>",
		"<string>supervise</string>", "<string>--mode</string>", "<string>launch-agent</string>",
		"<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
		"<key>RunAtLoad</key><true/>",
		"novad&amp;.log",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("plist lacks %q", want)
		}
	}
	var v struct{ XMLName xml.Name }
	if err := xml.Unmarshal([]byte(p), &v); err != nil || v.XMLName.Local != "plist" {
		t.Fatalf("not a well-formed plist: %v", err)
	}
}

// A profile path can hold a space; unquoted, Windows would try to run
// C:\Users\Jane and pass the rest as arguments.
func TestTheRunKeyValueQuotesAPathWithSpaces(t *testing.T) {
	got := RunKeyCommand(`C:\Users\Jane Doe\AppData\Local\Programs\Nova\novad.exe`)
	want := `"C:\Users\Jane Doe\AppData\Local\Programs\Nova\novad.exe" supervise --mode run-key`
	if got != want {
		t.Fatalf("got %s\nwant %s", got, want)
	}
}
```

`apps/novad/internal/service/systemd_linux_test.go`:

```go
package service

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"novad/internal/config"
	"novad/internal/platform"
)

func argvs(calls []platform.FakeCall) []string {
	out := make([]string, len(calls))
	for i, c := range calls {
		out[i] = strings.TrimSpace(c.Name + " " + strings.Join(c.Args, " "))
	}
	return out
}

func TestInstallWritesTheUnitAndRestartRunsTheThreeCommandsInOrder(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	r := &platform.FakeRunner{Outputs: map[string]string{"systemctl": ""}}
	m := New(config.Paths{}, r)
	if m.Installed() {
		t.Fatal("nothing written yet")
	}
	if err := m.Install("/opt/nova/novad"); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "systemd", "user", UnitName))
	if err != nil || string(body) != SystemdUnit("/opt/nova/novad") {
		t.Fatalf("unit on disk = %q, %v", body, err)
	}
	if !m.Installed() {
		t.Fatal("Installed after Install")
	}
	if err := m.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"systemctl --user daemon-reload", "systemctl --user enable novad.service", "systemctl --user restart novad.service"}
	if got := argvs(r.Calls); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("ran %v, want %v", got, want)
	}
}

// P26: linger is turned on without sudo and read back; when it stays off the
// one sudo line is said, and "starts at boot" is never claimed.
func TestBootStartTurnsLingerOnWithoutSudoAndReadsItBack(t *testing.T) {
	r := &platform.FakeRunner{Seq: map[string][]string{"loginctl": {"no\n", "", "yes\n"}}}
	on, note, err := New(config.Paths{}, r).BootStart(context.Background())
	if err != nil || !on || !strings.Contains(note, "linger turned on") {
		t.Fatalf("on=%v note=%q err=%v", on, note, err)
	}
	got := argvs(r.Calls)
	if len(got) != 3 || got[1] != "loginctl enable-linger" {
		t.Fatalf("ran %v", got)
	}
}

func TestBootStartThatCannotTurnLingerOnSaysTheOneSudoLine(t *testing.T) {
	r := &platform.FakeRunner{Seq: map[string][]string{"loginctl": {"no\n", "", "no\n"}}}
	on, note, err := New(config.Paths{}, r).BootStart(context.Background())
	if err != nil || on || !strings.Contains(note, "starts at login, not at boot") || !strings.Contains(note, "sudo loginctl enable-linger ") {
		t.Fatalf("on=%v note=%q err=%v", on, note, err)
	}
}

// P11: an update run through the old agent's own hands restarts the unit
// from OUTSIDE the agent's process tree — systemd-run's timer — so the
// restart cannot kill the command that scheduled it before it answers.
func TestRestartLaterSchedulesTheRestartOutsideTheCaller(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	r := &platform.FakeRunner{Outputs: map[string]string{"systemctl": "", "systemd-run": ""}}
	if err := New(config.Paths{}, r).RestartLater(context.Background(), 5e9); err != nil {
		t.Fatal(err)
	}
	last := argvs(r.Calls)[len(r.Calls)-1]
	if !strings.HasPrefix(last, "systemd-run --user --on-active=5 --unit=novad-restart-") ||
		!strings.HasSuffix(last, "systemctl --user restart novad.service") {
		t.Fatalf("scheduled %q", last)
	}
}
```

`apps/novad/internal/service/launchd_darwin_test.go`:

```go
package service

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"novad/internal/config"
	"novad/internal/platform"
)

func TestInstallWritesThePlistAndRestartBootstrapsIt(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	r := &platform.FakeRunner{Outputs: map[string]string{"launchctl": ""}}
	m := New(config.Paths{}, r)
	if err := m.Install("/Users/sam/Library/Application Support/Nova/novad"); err != nil {
		t.Fatal(err)
	}
	plist := filepath.Join(home, "Library", "LaunchAgents", Label+".plist")
	if _, err := os.Stat(plist); err != nil {
		t.Fatal(err)
	}
	if err := m.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	target := fmt.Sprintf("gui/%d/%s", os.Getuid(), Label)
	got := strings.Join(argvsDarwin(r.Calls), "|")
	for _, want := range []string{"launchctl bootout " + target, fmt.Sprintf("launchctl bootstrap gui/%d %s", os.Getuid(), plist), "launchctl kickstart -k " + target} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
}

func argvsDarwin(calls []platform.FakeCall) []string {
	out := make([]string, len(calls))
	for i, c := range calls {
		out[i] = c.Name + " " + strings.Join(c.Args, " ")
	}
	return out
}
```

`apps/novad/internal/service/runkey_windows_test.go`:

```go
package service

import (
	"fmt"
	"os"
	"testing"

	"golang.org/x/sys/windows/registry"

	"novad/internal/config"
)

// The Run-key write is read back; a scratch key keeps the runner's real Run
// key untouched.
func TestInstallWritesTheRunKeyAndReadsItBack(t *testing.T) {
	scratch := fmt.Sprintf(`Software\NovaTest\Run-%d`, os.Getpid())
	t.Cleanup(func() { _ = registry.DeleteKey(registry.CURRENT_USER, scratch) })
	m := &runKey{paths: config.Paths{StateDir: t.TempDir()}, keyPath: scratch, value: RunKeyValue}
	bin := `C:\Users\Jane Doe\AppData\Local\Programs\Nova\novad.exe`
	if err := m.Install(bin); err != nil {
		t.Fatal(err)
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, scratch, registry.QUERY_VALUE)
	if err != nil {
		t.Fatal(err)
	}
	got, _, err := k.GetStringValue(RunKeyValue)
	k.Close()
	if err != nil || got != RunKeyCommand(bin) {
		t.Fatalf("Run value = %q, %v", got, err)
	}
	if !m.Installed() {
		t.Fatal("Installed after Install")
	}
	if err := m.Uninstall(nil); err != nil {
		t.Fatal(err)
	}
	if m.Installed() {
		t.Fatal("the value is gone after Uninstall")
	}
}
```

`apps/novad/internal/platform/detach_test.go`:

```go
package platform

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestHelperProcess is not a test: StartDetached's test runs this binary
// again with NOVA_TEST_HELPER=write, and this writes the proof it ran.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("NOVA_TEST_HELPER") != "write" {
		return
	}
	_ = os.WriteFile(os.Getenv("NOVA_TEST_HELPER_OUT"), []byte("ran"), 0o600)
	os.Exit(0)
}

func TestStartDetachedRunsTheProgramOnItsOwn(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out")
	t.Setenv("NOVA_TEST_HELPER", "write")
	t.Setenv("NOVA_TEST_HELPER_OUT", out)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pid, err := StartDetached(self, []string{"-test.run=TestHelperProcess"}, filepath.Join(dir, "log"))
	if err != nil || pid <= 0 {
		t.Fatalf("pid=%d err=%v", pid, err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(out); err == nil && string(b) == "ran" {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the detached program never ran")
}
```

In `main_unix_test.go`, the S42a test that reads `novad.service` keeps its `RestartPreventExitStatus=78` assertion and gains:

```go
	if !strings.Contains(unit, "supervise --mode systemd-user") || !strings.Contains(unit, "Restart=on-failure") {
		t.Errorf("the committed unit must start supervise and restart only on failure:\n%s", unit)
	}
```

(using whatever variable that test already reads the file into).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/novad && ~/.local/bin/mise x -- go test ./internal/service/ ./internal/platform/ . 2>&1 | tail -8 && CGO_ENABLED=0 GOOS=windows ~/.local/bin/mise x -- go vet ./internal/service/ 2>&1 | tail -3`
Expected: FAIL — `package novad/internal/service` is missing; `undefined: StartDetached`.

- [ ] **Step 3: Implement the renders and the interface**

`apps/novad/internal/service/service.go`:

```go
// Package service registers novad's per-user service on each OS (hub D3,
// S42b): a systemd user unit (plus linger) on Linux, one LaunchAgent on
// macOS, the HKCU Run key on Windows. Each starts `novad supervise`, the
// parent on every OS. No admin rights anywhere: system services are a seam
// (S42c's helper is the first).
package service

import (
	"context"
	"encoding/xml"
	"strings"
	"time"
)

const (
	UnitName    = "novad.service"
	Label       = "nova.novad"
	RunKeyPath  = `Software\Microsoft\Windows\CurrentVersion\Run`
	RunKeyValue = "Nova agent"

	ModeSystemd = "systemd-user"
	ModeLaunch  = "launch-agent"
	ModeRunKey  = "run-key"
)

// Manager installs, starts, stops and removes the agent's service here.
type Manager interface {
	Mode() string
	// Describe says how the agent starts by itself, for a person.
	Describe() string
	// Installed is whether the definition (unit, plist, Run value) exists.
	Installed() bool
	// Install writes the definition for bin; it starts nothing.
	Install(bin string) error
	// Restart stops any running instance and starts the service now.
	Restart(ctx context.Context) error
	// RestartLater schedules a restart outside the caller's process tree —
	// for an install run through the old agent's own hands (P11).
	RestartLater(ctx context.Context, after time.Duration) error
	Stop(ctx context.Context) error
	Uninstall(ctx context.Context) error
	// BootStart reports whether the agent starts before anyone logs in, and
	// a sentence saying so (Linux linger; the others start at sign-in).
	BootStart(ctx context.Context) (bool, string, error)
}

// SystemdUnit is the user unit for bin. It restarts only on failure: supervise
// exits 0 when the agent can never get in (P3). 78 stays named for an agent
// from before S42b that a hand-written unit still runs directly.
func SystemdUnit(bin string) string {
	return "[Unit]\n" +
		"Description=Nova agent (novad)\n" +
		"After=network-online.target\n" +
		"Wants=network-online.target\n\n" +
		"[Service]\n" +
		"ExecStart=" + systemdQuote(bin) + " supervise --mode systemd-user\n" +
		"Restart=on-failure\n" +
		"RestartSec=5\n" +
		"RestartPreventExitStatus=78\n\n" +
		"[Install]\n" +
		"WantedBy=default.target\n"
}

// systemdQuote quotes an ExecStart path that needs it (systemd.syntax: C-style
// quotes; % and $ doubled so they are not specifiers or variables).
func systemdQuote(p string) string {
	if !strings.ContainsAny(p, " \t\"\\'$%;") {
		return p
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `$`, `$$`, `%`, `%%`)
	return `"` + r.Replace(p) + `"`
}

// LaunchAgentPlist is the per-user LaunchAgent for bin (macOS, unwalked).
// KeepAlive restarts it only after an unclean exit (P3); RunAtLoad starts it
// at login.
func LaunchAgentPlist(bin, logPath string) string {
	esc := func(s string) string {
		var b strings.Builder
		_ = xml.EscapeText(&b, []byte(s))
		return b.String()
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>` + Label + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + esc(bin) + `</string>
    <string>supervise</string>
    <string>--mode</string>
    <string>launch-agent</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>` + esc(logPath) + `</string>
  <key>StandardErrorPath</key><string>` + esc(logPath) + `</string>
</dict>
</plist>
`
}

// RunKeyCommand is the HKCU Run value: the binary QUOTED, supervise, the mode.
func RunKeyCommand(bin string) string { return `"` + bin + `" supervise --mode run-key` }
```

- [ ] **Step 4: Implement the three managers and the platform helpers**

`apps/novad/internal/service/systemd_linux.go`:

```go
package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"novad/internal/config"
	"novad/internal/platform"
)

type systemd struct {
	r       platform.Runner
	unitDir string
}

// New is the Linux manager: a systemd user unit.
func New(_ config.Paths, r platform.Runner) Manager {
	base, _ := platform.ConfigBase()
	return &systemd{r: r, unitDir: filepath.Join(base, "systemd", "user")}
}

func (s *systemd) Mode() string     { return ModeSystemd }
func (s *systemd) Describe() string { return "a systemd user service" }
func (s *systemd) unitPath() string { return filepath.Join(s.unitDir, UnitName) }

func (s *systemd) Installed() bool {
	_, err := os.Stat(s.unitPath())
	return err == nil
}

func (s *systemd) Install(bin string) error {
	if err := os.MkdirAll(s.unitDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.unitPath(), []byte(SystemdUnit(bin)), 0o644)
}

func (s *systemd) systemctl(ctx context.Context, args ...string) error {
	if _, err := s.r.Run(ctx, "systemctl", append([]string{"--user"}, args...), ""); err != nil {
		return fmt.Errorf("systemctl --user %s: %w", strings.Join(args, " "), err)
	}
	return nil
}

func (s *systemd) Restart(ctx context.Context) error {
	for _, args := range [][]string{{"daemon-reload"}, {"enable", UnitName}, {"restart", UnitName}} {
		if err := s.systemctl(ctx, args...); err != nil {
			return err
		}
	}
	return nil
}

func (s *systemd) RestartLater(ctx context.Context, after time.Duration) error {
	secs := int(after.Seconds())
	if secs < 1 {
		secs = 1
	}
	if err := s.systemctl(ctx, "daemon-reload"); err != nil {
		return err
	}
	if err := s.systemctl(ctx, "enable", UnitName); err != nil {
		return err
	}
	args := []string{"--user", fmt.Sprintf("--on-active=%d", secs),
		fmt.Sprintf("--unit=novad-restart-%d", time.Now().Unix()),
		"systemctl", "--user", "restart", UnitName}
	if _, err := s.r.Run(ctx, "systemd-run", args, ""); err != nil {
		return fmt.Errorf("systemd-run: %w", err)
	}
	return nil
}

func (s *systemd) Stop(ctx context.Context) error { return s.systemctl(ctx, "stop", UnitName) }

func (s *systemd) Uninstall(ctx context.Context) error {
	_ = s.systemctl(ctx, "disable", "--now", UnitName)
	if err := os.Remove(s.unitPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return s.systemctl(ctx, "daemon-reload")
}

// BootStart turns linger on without sudo when the session allows it (an
// active local session usually does) and reads it back; it never claims boot
// start it did not read (P26).
func (s *systemd) BootStart(ctx context.Context) (bool, string, error) {
	u, err := user.Current()
	if err != nil {
		return false, "", err
	}
	read := func() (string, error) {
		out, err := s.r.Run(ctx, "loginctl", []string{"show-user", u.Username, "-p", "Linger", "--value"}, "")
		return strings.TrimSpace(out), err
	}
	v, err := read()
	if err != nil {
		return false, "", fmt.Errorf("reading linger: %w", err)
	}
	if v == "yes" {
		return true, "starts at boot (linger is on)", nil
	}
	_, _ = s.r.Run(ctx, "loginctl", []string{"enable-linger"}, "")
	if v, _ = read(); v == "yes" {
		return true, "starts at boot (linger turned on)", nil
	}
	return false, fmt.Sprintf("starts at login, not at boot, until linger is on — run once: sudo loginctl enable-linger %s", u.Username), nil
}
```

`apps/novad/internal/service/launchd_darwin.go`:

```go
package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"novad/internal/config"
	"novad/internal/platform"
)

type launchd struct {
	r    platform.Runner
	home string
}

// New is the macOS manager: one LaunchAgent (unwalked; CI only).
func New(_ config.Paths, r platform.Runner) Manager {
	home, _ := os.UserHomeDir()
	return &launchd{r: r, home: home}
}

func (l *launchd) Mode() string      { return ModeLaunch }
func (l *launchd) Describe() string  { return "a LaunchAgent (starts at login)" }
func (l *launchd) plistPath() string { return filepath.Join(l.home, "Library", "LaunchAgents", Label+".plist") }
func (l *launchd) logPath() string   { return filepath.Join(l.home, "Library", "Logs", "novad.log") }
func (l *launchd) target() string    { return fmt.Sprintf("gui/%d/%s", os.Getuid(), Label) }

func (l *launchd) Installed() bool {
	_, err := os.Stat(l.plistPath())
	return err == nil
}

func (l *launchd) Install(bin string) error {
	for _, d := range []string{filepath.Dir(l.plistPath()), filepath.Dir(l.logPath())} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(l.plistPath(), []byte(LaunchAgentPlist(bin, l.logPath())), 0o644)
}

func (l *launchd) Restart(ctx context.Context) error {
	_, _ = l.r.Run(ctx, "launchctl", []string{"bootout", l.target()}, "") // not loaded yet is fine
	if _, err := l.r.Run(ctx, "launchctl", []string{"bootstrap", fmt.Sprintf("gui/%d", os.Getuid()), l.plistPath()}, ""); err != nil {
		return fmt.Errorf("launchctl bootstrap: %w", err)
	}
	if _, err := l.r.Run(ctx, "launchctl", []string{"kickstart", "-k", l.target()}, ""); err != nil {
		return fmt.Errorf("launchctl kickstart: %w", err)
	}
	return nil
}

func (l *launchd) RestartLater(_ context.Context, after time.Duration) error {
	script := fmt.Sprintf("sleep %d; /bin/launchctl kickstart -k %s", int(after.Seconds()), l.target())
	_, err := platform.StartDetached("/bin/sh", []string{"-c", script}, l.logPath())
	return err
}

func (l *launchd) Stop(ctx context.Context) error {
	_, err := l.r.Run(ctx, "launchctl", []string{"bootout", l.target()}, "")
	return err
}

func (l *launchd) Uninstall(ctx context.Context) error {
	_ = l.Stop(ctx)
	if err := os.Remove(l.plistPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func (l *launchd) BootStart(context.Context) (bool, string, error) {
	return false, "starts at login (a LaunchAgent), not before", nil
}
```

`apps/novad/internal/service/runkey_windows.go`:

```go
package service

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/registry"

	"novad/internal/config"
	"novad/internal/platform"
	"novad/internal/state"
)

type runKey struct {
	paths   config.Paths
	keyPath string // RunKeyPath; a test points it at a scratch key
	value   string
	bin     string
}

// New is the Windows manager: the HKCU Run key (P6).
func New(paths config.Paths, _ platform.Runner) Manager {
	return &runKey{paths: paths, keyPath: RunKeyPath, value: RunKeyValue}
}

func (k *runKey) Mode() string     { return ModeRunKey }
func (k *runKey) Describe() string { return "the Windows Run key (starts at sign-in)" }

func (k *runKey) Installed() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, k.keyPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	_, _, err = key.GetStringValue(k.value)
	return err == nil
}

func (k *runKey) Install(bin string) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, k.keyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return fmt.Errorf(`opening HKCU\%s: %w`, k.keyPath, err)
	}
	defer key.Close()
	want := RunKeyCommand(bin)
	if err := key.SetStringValue(k.value, want); err != nil {
		return err
	}
	if got, _, err := key.GetStringValue(k.value); err != nil || got != want {
		return fmt.Errorf("the Run key did not read back as written (got %q, %v)", got, err)
	}
	k.bin = bin
	return nil
}

// Restart stops the running supervisor and agent (their pids from the status
// files, checked to be novad before anything is ended), then starts
// supervise detached, as the Run key would at sign-in.
func (k *runKey) Restart(ctx context.Context) error {
	if k.bin == "" {
		return errors.New("cannot restart: the Run key was not written in this run")
	}
	_ = k.Stop(ctx)
	_, err := platform.StartDetached(k.bin, []string{"supervise", "--mode", ModeRunKey, "--detached"},
		filepath.Join(k.paths.StateDir, state.LogFile))
	return err
}

func (k *runKey) RestartLater(context.Context, time.Duration) error {
	return errors.New("cannot: a Windows agent updates through its supervisor, never by a delayed restart")
}

func (k *runKey) Stop(context.Context) error {
	var sv state.SupervisorStatus
	if state.ReadJSON(filepath.Join(k.paths.StateDir, state.SupervisorStatusFile), &sv) == nil {
		for _, pid := range []int{sv.PID, sv.ChildPID} {
			if pid > 0 && platform.ProcessIsNovad(pid) {
				_ = platform.Terminate(pid)
			}
		}
	}
	var ag state.AgentStatus
	if state.ReadJSON(filepath.Join(k.paths.StateDir, state.AgentStatusFile), &ag) == nil && ag.PID > 0 && platform.ProcessIsNovad(ag.PID) {
		_ = platform.Terminate(ag.PID)
	}
	return nil
}

func (k *runKey) Uninstall(ctx context.Context) error {
	_ = k.Stop(ctx)
	key, err := registry.OpenKey(registry.CURRENT_USER, k.keyPath, registry.SET_VALUE)
	if err != nil {
		return nil // no key, no value
	}
	defer key.Close()
	if err := key.DeleteValue(k.value); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

func (k *runKey) BootStart(context.Context) (bool, string, error) {
	return false, "starts at sign-in (the Windows Run key), not before sign-in", nil
}
```

`apps/novad/internal/platform/detach_unix.go`:

```go
//go:build !windows

package platform

import (
	"os"
	"os/exec"
	"syscall"
)

// StartDetached starts bin in its own session (Setsid), so a service manager
// that ends the caller's process group does not end it; output goes to
// logPath. It returns the pid.
func StartDetached(bin string, args []string, logPath string) (int, error) {
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	cmd := exec.Command(bin, args...)
	cmd.Stdout, cmd.Stderr = f, f
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return pid, nil
}
```

`apps/novad/internal/platform/detach_windows.go`:

```go
package platform

import (
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// StartDetached starts bin with no console and no parent it depends on (P6):
// its own process group, no window, and out of the caller's job when that job
// allows breakaway (a terminal's job would otherwise end it with the window).
// Output goes to logPath. It returns the pid.
func StartDetached(bin string, args []string, logPath string) (int, error) {
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	base := uint32(windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW)
	start := func(flags uint32) (*exec.Cmd, error) {
		cmd := exec.Command(bin, args...)
		cmd.Stdout, cmd.Stderr = f, f
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: flags, HideWindow: true}
		return cmd, cmd.Start()
	}
	cmd, err := start(base | windows.CREATE_BREAKAWAY_FROM_JOB)
	if err != nil {
		if cmd, err = start(base); err != nil {
			return 0, err
		}
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return pid, nil
}
```

`apps/novad/internal/platform/process_unix.go`:

```go
//go:build !windows

package platform

import (
	"errors"
	"syscall"
)

// ProcessAlive is whether pid names a running process.
func ProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// Terminate asks pid to stop (SIGTERM; `novad run` and supervise handle it).
func Terminate(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }
```

`apps/novad/internal/platform/process_windows.go`:

```go
package platform

import (
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// ProcessAlive is whether pid names a running process.
func ProcessAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	return windows.GetExitCodeProcess(h, &code) == nil && code == 259 // STILL_ACTIVE
}

// ProcessIsNovad is whether pid runs a novad image — checked before a pid
// read from a status file is ended, so a pid Windows has reused for another
// program is never touched.
func ProcessIsNovad(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_PATH)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) != nil {
		return false
	}
	return strings.HasPrefix(strings.ToLower(filepath.Base(windows.UTF16ToString(buf[:n]))), "novad")
}

// Terminate ends pid.
func Terminate(pid int) error {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.TerminateProcess(h, 1)
}
```

`apps/novad/novad.service` becomes the reference copy of `SystemdUnit("%h/.local/bin/novad")` with the specifier left unescaped (it is a hand-installed copy, for the README; `novad install` renders its own with the absolute path):

```ini
[Unit]
Description=Nova agent (novad)
After=network-online.target
Wants=network-online.target

[Service]
# novad install writes this unit with the absolute path; this copy is for a
# hand install (README). supervise is the parent: it restarts the agent and
# exits 0 when the agent can never get in (not enrolled, revoked), so
# on-failure never restarts that. 78 stays named for an agent from before
# S42b that a unit runs directly.
ExecStart=%h/.local/bin/novad supervise --mode systemd-user
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -12
for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done
```

Expected: all `ok` on Linux (the darwin and Windows tests compile under vet and run on CI's native legs, Task 30); vet silent on all three.

- [ ] **Step 6: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/novad/internal/service apps/novad/internal/platform/detach_unix.go apps/novad/internal/platform/detach_windows.go \
  apps/novad/internal/platform/process_unix.go apps/novad/internal/platform/process_windows.go apps/novad/internal/platform/detach_test.go \
  apps/novad/novad.service apps/novad/main_unix_test.go
git -C $W commit -m "feat(novad): the per-OS service — a systemd user unit with linger, a LaunchAgent, the Run key"
git -C $W show --stat HEAD | tail -5
```

---

## Task 9: `novad supervise` — restart, final exits, the swap and the revert

**Files:**
- Create: `apps/novad/internal/supervise/supervise.go`, `swap.go`, `spawn_unix.go`, `spawn_windows.go`, `supervise_test.go`, `swap_windows_test.go`
- Create: `apps/novad/supervise.go` (package main: `cmdSupervise`)
- Modify: `apps/novad/main.go` (the verb and the usage text)

**Interfaces:**
- Consumes: `state` (Task 5), `platform.ModeEnv`/`SupervisorEnv`/`StartDetached` (Tasks 5, 8), `service.Mode*` (Task 8).
- Produces:
  - `supervise.ExitUpdateStaged = 75`, `ExitFinal = 78`.
  - `type Child interface { PID() int; Wait() (int, error); Kill() error }`; `type Spawner func(ctx, bin string, args, env []string) (Child, error)`.
  - `type Config struct { Binary, StateDir, Mode, Version string; Spawn Spawner; Now func() time.Time; Sleep func(context.Context, time.Duration) error; ConfirmWithin, PollEvery, StableAfter time.Duration; Backoffs []time.Duration; Logf func(string, ...any) }`.
  - `func Run(ctx context.Context, cfg Config) int` (always 0 — P3); `func Swap(binary, staged string) error`; `func Revert(binary string) error`; `func ExecSpawner(logPath string) Spawner`.
  - `update.json` outcomes `applied` / `rolled_back` (with the reason) written by supervise.

- [ ] **Step 1: Write the failing tests**

`apps/novad/internal/supervise/supervise_test.go`:

```go
package supervise

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"novad/internal/platform"
	"novad/internal/state"
)

type fakeChild struct {
	pid    int
	exit   chan int
	killed atomic.Bool
}

func (c *fakeChild) PID() int           { return c.pid }
func (c *fakeChild) Wait() (int, error) { return <-c.exit, nil }
func (c *fakeChild) Kill() error {
	if c.killed.CompareAndSwap(false, true) {
		select {
		case c.exit <- -9:
		default:
		}
	}
	return nil
}

// step is what one spawned agent does: after delay, write "ready" as that
// version (when ready is set), then exit with code — or block until killed.
type step struct {
	ready string
	exit  int
	block bool
	delay time.Duration
}

type fakeSpawner struct {
	stateDir string
	steps    []step
	mu       sync.Mutex
	from     []string   // the binary's CONTENT each agent was started from
	envs     [][]string // each agent's environment
}

func (f *fakeSpawner) spawn(_ context.Context, bin string, _ []string, env []string) (Child, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := os.ReadFile(bin)
	f.from = append(f.from, string(body))
	f.envs = append(f.envs, env)
	n := len(f.from) - 1
	c := &fakeChild{pid: 1000 + n, exit: make(chan int, 1)}
	st := step{block: true}
	if n < len(f.steps) {
		st = f.steps[n]
	}
	go func() {
		time.Sleep(st.delay)
		if st.ready != "" {
			_ = state.WriteJSON(filepath.Join(f.stateDir, state.AgentStatusFile), state.AgentStatus{
				V: 1, PID: c.pid, Version: st.ready, State: state.StateReady, Since: time.Now()})
		}
		if !st.block {
			c.exit <- st.exit
		}
	}()
	return c, nil
}

func (f *fakeSpawner) spawned() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.from...)
}

type rig struct {
	dir, bin string
	sp       *fakeSpawner
	slept    []time.Duration
	mu       sync.Mutex
}

func newRig(t *testing.T, steps ...step) *rig {
	t.Helper()
	dir := t.TempDir()
	r := &rig{dir: dir, bin: filepath.Join(dir, "novad"), sp: &fakeSpawner{stateDir: dir, steps: steps}}
	if err := os.WriteFile(r.bin, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	return r
}

func (r *rig) config() Config {
	return Config{
		Binary: r.bin, StateDir: r.dir, Mode: "run-key", Version: "0123456789ab",
		Spawn: r.sp.spawn, ConfirmWithin: 300 * time.Millisecond, PollEvery: 10 * time.Millisecond,
		Sleep: func(ctx context.Context, d time.Duration) error {
			r.mu.Lock()
			r.slept = append(r.slept, d)
			r.mu.Unlock()
			return ctx.Err()
		},
	}
}

// stage writes a staged build with content and records it in update.json;
// sum overrides the recorded sha256 (a tampered or truncated staged file).
func (r *rig) stage(t *testing.T, content, version, sum string) {
	t.Helper()
	staged := r.bin + ".new"
	if err := os.WriteFile(staged, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	if sum == "" {
		h := sha256.Sum256([]byte(content))
		sum = hex.EncodeToString(h[:])
	}
	if err := state.WriteJSON(filepath.Join(r.dir, state.UpdateFile), state.Update{
		V: 1, Version: version, SHA256: sum, Staged: staged, Outcome: state.UpdateStaged, At: time.Now()}); err != nil {
		t.Fatal(err)
	}
}

func (r *rig) update(t *testing.T) state.Update {
	t.Helper()
	var u state.Update
	if err := state.ReadJSON(filepath.Join(r.dir, state.UpdateFile), &u); err != nil {
		t.Fatal(err)
	}
	return u
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// runUntil runs supervise in the background and cancels it once cond holds.
func runUntil(t *testing.T, cfg Config, cond func() bool) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan int, 1)
	go func() { done <- Run(ctx, cfg) }()
	for !cond() {
		select {
		case code := <-done:
			return code
		case <-time.After(5 * time.Millisecond):
		}
		if ctx.Err() != nil {
			t.Fatal("the condition never held")
		}
	}
	cancel()
	return <-done
}

// P3: an agent that can never get in stops the supervisor for good, with 0.
func TestSuperviseStopsForGoodWhenTheAgentCannotGetIn(t *testing.T) {
	r := newRig(t, step{exit: ExitFinal})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if code := Run(ctx, r.config()); code != 0 {
		t.Fatalf("exit %d, want 0", code)
	}
	if ctx.Err() != nil {
		t.Fatal("Run did not return on its own after exit 78")
	}
	if n := len(r.sp.spawned()); n != 1 {
		t.Fatalf("spawned %d agents, want 1 — a final exit is never restarted", n)
	}
	var sv state.SupervisorStatus
	if err := state.ReadJSON(filepath.Join(r.dir, state.SupervisorStatusFile), &sv); err != nil || sv.LastExit == nil || *sv.LastExit != ExitFinal {
		t.Fatalf("supervisor status = %+v, %v", sv, err)
	}
}

func TestSuperviseRestartsACrashedAgentWithBackoff(t *testing.T) {
	r := newRig(t, step{exit: 1}, step{exit: 1})
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 3 })
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.slept) < 2 || r.slept[0] != time.Second || r.slept[1] != 2*time.Second {
		t.Fatalf("slept %v, want 1s then 2s", r.slept)
	}
}

func TestTheAgentIsToldItsModeAndItsSupervisor(t *testing.T) {
	r := newRig(t)
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 1 })
	env := strings.Join(r.sp.envs[0], "\n")
	for _, want := range []string{platform.ModeEnv + "=run-key", platform.SupervisorEnv + "="} {
		if !strings.Contains(env, want) {
			t.Fatalf("the agent's environment lacks %s", want)
		}
	}
}

func TestAStagedUpdateIsSwappedInAndConfirmedByReady(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{ready: "aaaaaaaaaaaa", block: true})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	runUntil(t, r.config(), func() bool {
		var u state.Update
		return state.ReadJSON(filepath.Join(r.dir, state.UpdateFile), &u) == nil && u.Outcome == state.UpdateApplied
	})
	if got := read(t, r.bin); got != "new" {
		t.Fatalf("installed build = %q, want the new one", got)
	}
	if got := read(t, r.bin+".prev"); got != "old" {
		t.Fatalf(".prev = %q, want the old build kept", got)
	}
	if from := r.sp.spawned(); len(from) < 2 || from[1] != "new" {
		t.Fatalf("agents started from %v", from)
	}
}

// Review focus 1: a build that never connects is put back.
func TestAStagedBuildThatNeverReachesReadyIsRolledBack(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{block: true})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 3 })
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "did not connect within") {
		t.Fatalf("update = %+v", u)
	}
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q, want the old one back", got)
	}
	if got := read(t, r.bin+".failed"); got != "new" {
		t.Fatalf(".failed = %q", got)
	}
	if from := r.sp.spawned(); from[2] != "old" {
		t.Fatalf("the agent after the revert started from %q", from[2])
	}
}

func TestAStagedBuildThatExitsAtOnceIsRolledBack(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{exit: 2})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 3 })
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "exited with 2 before it connected") {
		t.Fatalf("update = %+v", u)
	}
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q", got)
	}
}

func TestAStagedFileWhoseHashDoesNotMatchIsNotSwapped(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged})
	r.stage(t, "new", "aaaaaaaaaaaa", strings.Repeat("0", 64))
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 2 })
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q — a mismatched file must never be swapped in", got)
	}
	if u := r.update(t); u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "sha256") {
		t.Fatalf("update = %+v", u)
	}
}

func TestTheBackoffResetsAfterAStableRun(t *testing.T) {
	r := newRig(t, step{exit: 1}, step{exit: 1})
	cfg := r.config()
	cfg.StableAfter = time.Nanosecond // every run counts as stable
	runUntil(t, cfg, func() bool { return len(r.sp.spawned()) == 3 })
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.slept) < 2 || r.slept[1] != time.Second {
		t.Fatalf("slept %v, want the ladder to restart at 1s", r.slept)
	}
}
```

`apps/novad/internal/supervise/swap_windows_test.go`:

```go
package supervise

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestHelperSleep is not a test: the swap test runs a copy of this binary as
// a stand-in for a running agent.
func TestHelperSleep(t *testing.T) {
	if os.Getenv("NOVA_TEST_SLEEP") != "1" {
		return
	}
	time.Sleep(time.Minute)
}

// P0-20 measured that Windows renames a running image; this pins it on CI.
func TestSwapRenamesARunningImageOnWindows(t *testing.T) {
	dir := t.TempDir()
	self, _ := os.Executable()
	bin := filepath.Join(dir, "novad.exe")
	src, _ := os.Open(self)
	dst, _ := os.Create(bin)
	_, _ = io.Copy(dst, src)
	src.Close()
	dst.Close()
	cmd := exec.Command(bin, "-test.run=TestHelperSleep")
	cmd.Env = append(os.Environ(), "NOVA_TEST_SLEEP=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	staged := bin + ".new"
	if err := os.WriteFile(staged, []byte("new build"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Swap(bin, staged); err != nil {
		t.Fatalf("swapping over a running image: %v", err)
	}
	if b, _ := os.ReadFile(bin); string(b) != "new build" {
		t.Fatal("the new build is not in place")
	}
	if _, err := os.Stat(bin + ".prev"); err != nil {
		t.Fatalf("the running build was not kept as .prev: %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/novad && ~/.local/bin/mise x -- go test ./internal/supervise/ 2>&1 | tail -5`
Expected: FAIL — the package has no non-test files (`undefined: Run`).

- [ ] **Step 3: Implement `internal/supervise`**

`apps/novad/internal/supervise/supervise.go`:

```go
// Package supervise is the parent every service starts (hub D3, S42b): it
// runs `novad run`, restarts it after a crash, stops for good when the agent
// can never get in, and swaps in a staged update — putting the previous
// build back when the new one does not connect (P7).
package supervise

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"novad/internal/platform"
	"novad/internal/state"
)

const (
	// ExitUpdateStaged is `novad run`'s exit after daemon.update staged a build.
	ExitUpdateStaged = 75
	// ExitFinal is `novad run`'s exit when it can never get in.
	ExitFinal = 78
)

// Child is one running agent.
type Child interface {
	PID() int
	Wait() (int, error) // the exit code; an error only when waiting failed
	Kill() error
}

// Spawner starts bin with args and env.
type Spawner func(ctx context.Context, bin string, args, env []string) (Child, error)

// Config is one supervisor's settings; zero values take the defaults.
type Config struct {
	Binary        string
	StateDir      string
	Mode          string
	Version       string
	Spawn         Spawner
	Now           func() time.Time
	Sleep         func(context.Context, time.Duration) error
	ConfirmWithin time.Duration
	PollEvery     time.Duration
	Backoffs      []time.Duration
	StableAfter   time.Duration
	Logf          func(string, ...any)
}

func withDefaults(c Config) Config {
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Sleep == nil {
		c.Sleep = sleepCtx
	}
	if c.ConfirmWithin == 0 {
		c.ConfirmWithin = 120 * time.Second
	}
	if c.PollEvery == 0 {
		c.PollEvery = 500 * time.Millisecond
	}
	if len(c.Backoffs) == 0 {
		c.Backoffs = []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 15 * time.Second, 30 * time.Second}
	}
	if c.StableAfter == 0 {
		c.StableAfter = time.Minute
	}
	if c.Logf == nil {
		c.Logf = func(string, ...any) {}
	}
	return c
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Run supervises `Binary run` until ctx ends or the agent can never get in.
// Both return 0 (P3): a unit restarts only on failure, and this is never a
// failure — a supervisor that exited non-zero on purpose would be restarted
// into the same state.
func Run(ctx context.Context, cfg Config) int {
	s := &sup{cfg: withDefaults(cfg), since: time.Now().UTC()}
	removeOld(s.cfg.Binary)
	return s.loop(ctx)
}

type sup struct {
	cfg      Config
	since    time.Time
	restarts int
	lastExit *int
	childPID int
}

type readyOutcome int

const (
	readyOK readyOutcome = iota
	readyFailed
	readyStopped
)

func (s *sup) loop(ctx context.Context) int {
	attempt := 0
	confirm := "" // the version a just-swapped build must connect as
	for ctx.Err() == nil {
		started := s.cfg.Now()
		child, err := s.cfg.Spawn(ctx, s.cfg.Binary, []string{"run"}, s.env())
		if err != nil {
			if confirm != "" {
				s.revert(confirm, fmt.Sprintf("the new build could not start: %v", err))
				confirm = ""
				continue
			}
			s.cfg.Logf("could not start the agent: %v", err)
			if s.cfg.Sleep(ctx, s.backoff(attempt)) != nil {
				return 0
			}
			attempt++
			continue
		}
		s.childPID = child.PID()
		s.writeStatus()
		exited := make(chan int, 1)
		go func() {
			code, werr := child.Wait()
			if werr != nil {
				s.cfg.Logf("waiting for the agent: %v", werr)
				code = -1
			}
			exited <- code
		}()
		if confirm != "" {
			outcome, code, reason := s.awaitReady(ctx, child.PID(), exited, confirm, started)
			switch outcome {
			case readyStopped:
				_ = child.Kill()
				<-exited
				return 0
			case readyFailed:
				if code == nil {
					_ = child.Kill()
					<-exited
				}
				s.revert(confirm, reason)
				confirm = ""
				continue
			}
			s.record(confirm, state.UpdateApplied, "")
			s.cfg.Logf("the new build %s connected", confirm)
			confirm = ""
		}
		var code int
		select {
		case code = <-exited:
		case <-ctx.Done():
			_ = child.Kill()
			<-exited
			return 0
		}
		s.restarts++
		s.lastExit = &code
		s.writeStatus()
		switch code {
		case ExitFinal:
			s.cfg.Logf("the agent cannot get in (not enrolled, or revoked) — stopping for good")
			return 0
		case ExitUpdateStaged:
			v, err := s.swapStaged()
			if err != nil {
				s.cfg.Logf("a staged update cannot be applied: %v — running the current build", err)
				break
			}
			s.cfg.Logf("swapped in %s; waiting up to %s for it to connect", v, s.cfg.ConfirmWithin)
			confirm = v
			attempt = 0
			continue
		}
		if ctx.Err() != nil {
			return 0
		}
		if s.cfg.Now().Sub(started) >= s.cfg.StableAfter {
			attempt = 0
		}
		if s.cfg.Sleep(ctx, s.backoff(attempt)) != nil {
			return 0
		}
		attempt++
	}
	return 0
}

// awaitReady waits for the new agent to write "ready" as version (its own
// pid, since it started), to exit, or for the bound — whichever is first.
func (s *sup) awaitReady(ctx context.Context, pid int, exited <-chan int, version string, started time.Time) (readyOutcome, *int, string) {
	path := filepath.Join(s.cfg.StateDir, state.AgentStatusFile)
	deadline := s.cfg.Now().Add(s.cfg.ConfirmWithin)
	for {
		var st state.AgentStatus
		if state.ReadJSON(path, &st) == nil && st.PID == pid && st.State == state.StateReady &&
			st.Version == version && !st.Since.Before(started.Add(-time.Second)) {
			return readyOK, nil, ""
		}
		select {
		case code := <-exited:
			return readyFailed, &code, fmt.Sprintf("the new build exited with %d before it connected%s", code, lastError(path, pid))
		case <-ctx.Done():
			return readyStopped, nil, ""
		default:
		}
		if !s.cfg.Now().Before(deadline) {
			return readyFailed, nil, fmt.Sprintf("the new build did not connect within %s%s", s.cfg.ConfirmWithin, lastError(path, pid))
		}
		if s.cfg.Sleep(ctx, s.cfg.PollEvery) != nil {
			return readyStopped, nil, ""
		}
	}
}

func lastError(path string, pid int) string {
	var st state.AgentStatus
	if state.ReadJSON(path, &st) == nil && st.PID == pid && st.Error != "" {
		return "; its last error: " + st.Error
	}
	return ""
}

func (s *sup) swapStaged() (string, error) {
	var u state.Update
	if err := state.ReadJSON(filepath.Join(s.cfg.StateDir, state.UpdateFile), &u); err != nil {
		return "", fmt.Errorf("no staged update: %w", err)
	}
	if u.Outcome != state.UpdateStaged {
		return "", fmt.Errorf("the last update is %q, not staged", u.Outcome)
	}
	sum, err := fileSHA256(u.Staged)
	if err != nil {
		s.record(u.Version, state.UpdateRolledBack, fmt.Sprintf("the staged build is unreadable: %v", err))
		return "", err
	}
	if sum != u.SHA256 {
		reason := fmt.Sprintf("the staged build's sha256 is %s, not %s — not applied", sum, u.SHA256)
		s.record(u.Version, state.UpdateRolledBack, reason)
		return "", fmt.Errorf("%s", reason)
	}
	if err := Swap(s.cfg.Binary, u.Staged); err != nil {
		s.record(u.Version, state.UpdateRolledBack, err.Error())
		return "", err
	}
	return u.Version, nil
}

func (s *sup) revert(version, reason string) {
	if err := Revert(s.cfg.Binary); err != nil {
		reason += fmt.Sprintf("; putting the previous build back failed too: %v", err)
	}
	s.cfg.Logf("rolled back %s: %s", version, reason)
	s.record(version, state.UpdateRolledBack, reason)
}

// record writes an update's outcome, keeping what daemon.update staged.
func (s *sup) record(version, outcome, reason string) {
	path := filepath.Join(s.cfg.StateDir, state.UpdateFile)
	var u state.Update
	_ = state.ReadJSON(path, &u)
	u.V, u.Version, u.Outcome, u.Reason, u.At = 1, version, outcome, reason, s.cfg.Now().UTC()
	if err := state.WriteJSON(path, u); err != nil {
		s.cfg.Logf("could not record the update's outcome: %v", err)
	}
}

func (s *sup) env() []string {
	return append(os.Environ(),
		platform.ModeEnv+"="+s.cfg.Mode,
		platform.SupervisorEnv+"="+strconv.Itoa(os.Getpid()))
}

func (s *sup) backoff(attempt int) time.Duration {
	return s.cfg.Backoffs[min(attempt, len(s.cfg.Backoffs)-1)]
}

func (s *sup) writeStatus() {
	st := state.SupervisorStatus{V: 1, PID: os.Getpid(), Version: s.cfg.Version, Mode: s.cfg.Mode,
		ChildPID: s.childPID, Restarts: s.restarts, LastExit: s.lastExit, Since: s.since}
	if err := state.WriteJSON(filepath.Join(s.cfg.StateDir, state.SupervisorStatusFile), st); err != nil {
		s.cfg.Logf("could not write the supervisor status: %v", err)
	}
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
```

`apps/novad/internal/supervise/swap.go`:

```go
package supervise

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Swap puts the staged build in place and keeps the running one as .prev.
// Renames only: every OS allows renaming the file a running process was
// started from (P0-20 measured Windows), and nothing is deleted that a
// running process may hold. An earlier .prev is moved aside first — on
// Windows it may be this supervisor's own image from the last update.
func Swap(binary, staged string) error {
	prev := binary + ".prev"
	if err := moveAside(prev); err != nil {
		return fmt.Errorf("clearing %s: %w", prev, err)
	}
	if err := os.Rename(binary, prev); err != nil {
		return fmt.Errorf("moving the running build aside: %w", err)
	}
	if err := os.Rename(staged, binary); err != nil {
		if rerr := os.Rename(prev, binary); rerr != nil {
			return fmt.Errorf("moving the new build into place: %v; putting the old one back: %v", err, rerr)
		}
		return fmt.Errorf("moving the new build into place: %w", err)
	}
	return nil
}

// Revert puts .prev back and keeps the build that failed as .failed.
func Revert(binary string) error {
	failed := binary + ".failed"
	if err := moveAside(failed); err != nil {
		return err
	}
	if err := os.Rename(binary, failed); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Rename(binary+".prev", binary)
}

func moveAside(path string) error {
	if _, err := os.Lstat(path); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return os.Rename(path, fmt.Sprintf("%s.old-%d", path, time.Now().UnixNano()))
}

// removeOld deletes the builds moved aside earlier; one a process still runs
// from stays until the next start.
func removeOld(binary string) {
	matches, _ := filepath.Glob(binary + "*.old-*")
	for _, m := range matches {
		_ = os.Remove(m)
	}
}
```

**P0-20 branch R2 (a running image could NOT be renamed):** `Swap` stays, and `cmdSupervise` on Windows (Step 4) copies the running binary to `novad.supervisor.exe` in the same folder and starts THAT detached with `--binary <novad.exe>`; `Config.Binary` comes from `--binary`. No process then runs from `novad.exe` at swap time (its agent has exited 75), so every rename is of a file nobody holds. Skip this paragraph on branch R1.

`apps/novad/internal/supervise/spawn_unix.go`:

```go
//go:build !windows

package supervise

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// ExecSpawner starts agents with this process's output (the journal under
// systemd, the plist's log under launchd). Kill asks politely — `novad run`
// handles SIGTERM — and forces after 10 s.
func ExecSpawner(_ string) Spawner {
	return func(_ context.Context, bin string, args, env []string) (Child, error) {
		cmd := exec.Command(bin, args...)
		cmd.Env = env
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		return &execChild{cmd: cmd}, nil
	}
}

type execChild struct{ cmd *exec.Cmd }

func (c *execChild) PID() int { return c.cmd.Process.Pid }

func (c *execChild) Wait() (int, error) {
	err := c.cmd.Wait()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

func (c *execChild) Kill() error {
	p := c.cmd.Process
	time.AfterFunc(10*time.Second, func() { _ = p.Kill() })
	return p.Signal(syscall.SIGTERM)
}
```

`apps/novad/internal/supervise/spawn_windows.go`:

```go
package supervise

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ExecSpawner starts agents with no window, logging to logPath (1 MiB, one
// rotation — there is no console), inside a kill-on-close job object: when
// this supervisor ends, however it ends, its agent ends with it (P6).
func ExecSpawner(logPath string) Spawner {
	job, jobErr := killOnCloseJob()
	return func(_ context.Context, bin string, args, env []string) (Child, error) {
		rotate(logPath, 1<<20)
		f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		cmd := exec.Command(bin, args...)
		cmd.Env = env
		cmd.Stdout, cmd.Stderr = f, f
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		if jobErr == nil {
			if h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid)); err == nil {
				_ = windows.AssignProcessToJobObject(job, h)
				windows.CloseHandle(h)
			}
		}
		return &execChild{cmd: cmd}, nil
	}
}

func killOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func rotate(path string, max int64) {
	if fi, err := os.Stat(path); err == nil && fi.Size() > max {
		_ = os.Rename(path, path+".1")
	}
}

type execChild struct{ cmd *exec.Cmd }

func (c *execChild) PID() int { return c.cmd.Process.Pid }

func (c *execChild) Wait() (int, error) {
	err := c.cmd.Wait()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

// Kill ends the agent at once: Windows has no SIGTERM to ask with.
func (c *execChild) Kill() error { return c.cmd.Process.Kill() }
```

- [ ] **Step 4: The verb**

`apps/novad/supervise.go`:

```go
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"novad/internal/config"
	"novad/internal/platform"
	"novad/internal/service"
	"novad/internal/state"
	"novad/internal/supervise"
)

// cmdSupervise is what every service definition starts (P3, P4, P6).
func cmdSupervise(argv []string) {
	fs := flag.NewFlagSet("supervise", flag.ExitOnError)
	mode := fs.String("mode", "", "how the service started it: systemd-user | launch-agent | run-key")
	detached := fs.Bool("detached", false, "(Windows) already running without a console")
	_ = fs.Parse(argv)
	switch *mode {
	case service.ModeSystemd, service.ModeLaunch, service.ModeRunKey:
	default:
		fail("supervise needs --mode systemd-user, launch-agent or run-key (the service definition passes it)")
	}
	paths, err := config.DefaultPaths()
	if err != nil {
		fail("%v", err)
	}
	self, err := os.Executable()
	if err != nil {
		fail("%v", err)
	}
	logPath := filepath.Join(paths.StateDir, state.LogFile)
	if runtime.GOOS == "windows" && !*detached {
		// The Run key started a console program: start again with no console
		// and let this one go (the brief flash P0-20 measured).
		if _, err := platform.StartDetached(self, []string{"supervise", "--mode", *mode, "--detached"}, logPath); err != nil {
			fail("could not start detached: %v", err)
		}
		return
	}
	lock, err := state.Acquire(filepath.Join(paths.StateDir, state.SuperviseLockFile))
	if err != nil {
		var held *state.HeldError
		if errors.As(err, &held) {
			fmt.Fprintf(os.Stderr, "novad: %v — a supervisor already runs this agent\n", err)
			return
		}
		fail("%v", err)
	}
	logger := log.New(os.Stderr, "novad supervise ", log.LstdFlags)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	code := supervise.Run(ctx, supervise.Config{
		Binary: self, StateDir: paths.StateDir, Mode: *mode, Version: version,
		Spawn: supervise.ExecSpawner(logPath), Logf: logger.Printf,
	})
	stop()
	_ = lock.Release()
	os.Exit(code)
}
```

In `main.go`: add `case "supervise": cmdSupervise(os.Args[2:])` and the usage line `novad supervise --mode <systemd-user|launch-agent|run-key>`; the package comment's verb list gains `install | uninstall | supervise`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/novad
~/.local/bin/mise x -- go test -race -count=3 ./internal/supervise/ 2>&1 | tail -3
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -12
for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done
```

Expected: `ok` three times running (the timing-based tests are stable), all packages `ok`, vet silent.

- [ ] **Step 6: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/novad/internal/supervise apps/novad/supervise.go apps/novad/main.go
git -C $W commit -m "feat(novad): supervise — restarts the agent, stops for good when it cannot get in, swaps a staged build and puts it back when it does not connect"
git -C $W show --stat HEAD | tail -5
```

---
## Task 10: `daemon.update` — download, verify, stage, and leave for the swap

**Files:**
- Create: `apps/novad/internal/caps/update.go`, `update_test.go`
- Modify: `apps/novad/internal/caps/caps.go` (`Outcome.Restart`, `Deps.Update`), `table.go`, `caps_test.go` (the `Names()` pin)
- Modify: `apps/novad/internal/client/client.go` (update deps, restart after the reply, `ErrRestartForUpdate`), `integration_test.go`
- Modify: `apps/novad/internal/facts/facts.go` (`AgentInfo.Update`), `facts_test.go`
- Modify: `apps/novad/main.go` (exit 75), `main_test.go`

**Interfaces:**
- Consumes: `state.Update`/`UpdateFile` (Task 5), `client.Options`/`Server()` (Tasks 5, 6), `supervise.ExitUpdateStaged` (Task 9).
- Produces:
  - Capability `daemon.update` with args `{version: 12 hex, sha256: 64 hex, path: "/api/v1/agent/dist/novad-<goos>-<arch>[.exe]"}`; on success `update.json` = `{outcome: "staged", staged: "<binary>.new", …}` and `Outcome.Restart = true`.
  - `caps.UpdateDeps{Supervised bool; Binary, StateDir string; BaseURL func() string; HTTP *http.Client}`; `caps.MaxBinaryBytes` (var, 64 MiB).
  - `client.ErrRestartForUpdate`; `main` exits **75** on it.
  - Auth facts `agent.update = {version, outcome: "applied"|"rolled_back", reason, at}` when `update.json` holds one of those (never `staged`). `facts.GatherAuth(ctx, r, version string, last *state.Update)`.
  - Core reads the exact refusal `unknown capability "daemon.update"` from an older agent (Task 20).

- [ ] **Step 1: Write the failing tests**

`apps/novad/internal/caps/update_test.go`:

```go
package caps

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"novad/internal/state"
)

func distName() string {
	n := "novad-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		n += ".exe"
	}
	return n
}

func hubServing(t *testing.T, build []byte) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agent/dist/"+distName(), func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(build) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

func updateDeps(t *testing.T, base string, supervised bool) *UpdateDeps {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "novad")
	if err := os.WriteFile(bin, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &UpdateDeps{Supervised: supervised, Binary: bin, StateDir: dir, BaseURL: func() string { return base }}
}

func updateArgs(version, sum, path string) map[string]any {
	return map[string]any{"version": version, "sha256": sum, "path": path}
}

func sumOf(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func TestDaemonUpdateStagesAVerifiedBuildAndAsksForARestart(t *testing.T) {
	build := []byte("the hub's build")
	d := updateDeps(t, hubServing(t, build), true)
	out := Dispatch(context.Background(), "daemon.update",
		updateArgs("aaaaaaaaaaaa", sumOf(build), "/api/v1/agent/dist/"+distName()), Deps{Update: d})
	if !out.OK || !out.Restart {
		t.Fatalf("got %+v", out)
	}
	if !strings.Contains(out.Output, "confirmed only when this agent reconnects reporting aaaaaaaaaaaa") {
		t.Fatalf("the result must not claim the update: %q", out.Output)
	}
	if b, _ := os.ReadFile(d.Binary + ".new"); string(b) != string(build) {
		t.Fatal("the build was not staged beside the binary")
	}
	var u state.Update
	if err := state.ReadJSON(filepath.Join(d.StateDir, state.UpdateFile), &u); err != nil ||
		u.Outcome != state.UpdateStaged || u.Version != "aaaaaaaaaaaa" || u.SHA256 != sumOf(build) {
		t.Fatalf("update.json = %+v, %v", u, err)
	}
}

func TestDaemonUpdateRefusesAHashMismatchAndStagesNothing(t *testing.T) {
	d := updateDeps(t, hubServing(t, []byte("tampered")), true)
	out := Dispatch(context.Background(), "daemon.update",
		updateArgs("aaaaaaaaaaaa", sumOf([]byte("what core signed")), "/api/v1/agent/dist/"+distName()), Deps{Update: d})
	if out.OK || out.Restart || !strings.Contains(out.Error, "nothing staged") {
		t.Fatalf("got %+v", out)
	}
	for _, f := range []string{d.Binary + ".new", d.Binary + ".new.part", filepath.Join(d.StateDir, state.UpdateFile)} {
		if _, err := os.Stat(f); err == nil {
			t.Errorf("%s exists after a refused update", f)
		}
	}
}

// P12: a hand-started agent has nobody to start the new build.
func TestDaemonUpdateRefusesWhenNotSupervised(t *testing.T) {
	build := []byte("b")
	d := updateDeps(t, hubServing(t, build), false)
	out := Dispatch(context.Background(), "daemon.update",
		updateArgs("aaaaaaaaaaaa", sumOf(build), "/api/v1/agent/dist/"+distName()), Deps{Update: d})
	if out.OK || !strings.HasPrefix(out.Error, "cannot: this agent was started by hand") {
		t.Fatalf("got %+v", out)
	}
}

func TestDaemonUpdateRefusesAPathThatIsNotThisMachinesHubBuild(t *testing.T) {
	d := updateDeps(t, hubServing(t, []byte("b")), true)
	other := "linux"
	if runtime.GOOS == "linux" {
		other = "darwin"
	}
	for _, path := range []string{"/etc/passwd", "https://evil.example/novad", "/api/v1/agent/dist/novad-" + other + "-amd64"} {
		out := Dispatch(context.Background(), "daemon.update", updateArgs("aaaaaaaaaaaa", strings.Repeat("a", 64), path), Deps{Update: d})
		if out.OK {
			t.Errorf("path %q was accepted", path)
		}
	}
}

func TestDaemonUpdateRefusesAnOversizeDownload(t *testing.T) {
	old := MaxBinaryBytes
	MaxBinaryBytes = 4
	t.Cleanup(func() { MaxBinaryBytes = old })
	build := []byte("longer than four")
	d := updateDeps(t, hubServing(t, build), true)
	out := Dispatch(context.Background(), "daemon.update",
		updateArgs("aaaaaaaaaaaa", sumOf(build), "/api/v1/agent/dist/"+distName()), Deps{Update: d})
	if out.OK || !strings.Contains(out.Error, "cap") {
		t.Fatalf("got %+v", out)
	}
}
```

In `caps_test.go`, the `Names()` pin becomes (sorted):

```go
	want := []string{
		"apps.launch", "apps.list", "daemon.update", "facts.refresh", "fs.list", "fs.read",
		"fs.write", "shell.exec", "system.info", "system.notify",
	}
```

Append to `internal/client/integration_test.go` (add `crypto/sha256`, `errors`, `os`, `runtime` to its imports if absent):

```go
// P7: the result and its audit entry are on the wire BEFORE the agent leaves
// for the swap; Run then returns ErrRestartForUpdate (main exits 75).
func TestAnUpdateReplyIsWrittenBeforeTheAgentLeavesForTheSwap(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-update-1"
	build := []byte("the hub's new build")
	sum := sha256.Sum256(build)
	name := "novad-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	results := make(chan map[string]any, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agent/dist/"+name, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(build) })
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		if fakeCoreHandshake(ctx, c, corePub, devPub) == nil {
			return
		}
		if first, _ := coreRead(ctx, c); first["type"] != "facts" {
			return
		}
		now := time.Now().Unix()
		env := map[string]any{
			"v": int64(1), "envelope_id": "upd-e1", "device_id": deviceID, "capability": "daemon.update",
			"args":      map[string]any{"version": "aaaaaaaaaaaa", "sha256": hex.EncodeToString(sum[:]), "path": "/api/v1/agent/dist/" + name},
			"issued_at": now, "expires_at": now + 60,
		}
		canon, _ := wire.Canonical(env)
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": hex.EncodeToString(ed25519.Sign(corePriv, canon))})
		for {
			f, err := coreRead(ctx, c)
			if err != nil {
				return
			}
			if f["type"] == "result" {
				results <- f
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	dir := t.TempDir()
	bin := filepath.Join(dir, "novad")
	if err := os.WriteFile(bin, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	agent.Configure(Options{StateDir: dir, Supervised: true, Binary: bin})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- agent.Run(ctx) }()
	select {
	case res := <-results:
		if ok, _ := res["ok"].(bool); !ok {
			t.Fatalf("result = %v", res)
		}
	case <-ctx.Done():
		t.Fatal("no result frame")
	}
	select {
	case err := <-runErr:
		if !errors.Is(err, ErrRestartForUpdate) {
			t.Fatalf("Run = %v, want ErrRestartForUpdate", err)
		}
	case <-ctx.Done():
		t.Fatal("the agent never left for the swap")
	}
}
```

Append to `internal/facts/facts_test.go` (add `reflect`, `time`, `novad/internal/state` imports):

```go
func TestAuthFactsCarryTheLastUpdateOutcomeButNeverAStagedOne(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{
		"/usr/sbin/ioreg": `"IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"`,
	}}
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	a, _ := GatherAuth(context.Background(), r, "0123456789ab", &state.Update{
		Version: "aaaaaaaaaaaa", Outcome: state.UpdateRolledBack, Reason: "the new build did not connect within 2m0s", At: at})
	want := &UpdateFact{Version: "aaaaaaaaaaaa", Outcome: "rolled_back", Reason: "the new build did not connect within 2m0s", At: "2026-09-28T12:00:00Z"}
	if !reflect.DeepEqual(a.Agent.Update, want) {
		t.Fatalf("got %+v", a.Agent.Update)
	}
	b, _ := GatherAuth(context.Background(), r, "0123456789ab", &state.Update{Version: "aaaaaaaaaaaa", Outcome: state.UpdateStaged})
	if b.Agent.Update != nil {
		t.Fatal("a staged update is transient and never reported")
	}
}
```

Every existing `GatherAuth(ctx, r, v)` call in `facts_test.go` gains a `nil` fourth argument.

Append to `main_test.go`:

```go
func TestAStagedUpdateExitsSeventyFiveForTheSupervisor(t *testing.T) {
	code, msg := afterRun(config.Paths{}, client.ErrRestartForUpdate, time.Now())
	if code != 75 || !strings.Contains(msg, "the supervisor") {
		t.Fatalf("afterRun = %d %q", code, msg)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/novad && ~/.local/bin/mise x -- go test ./... 2>&1 | tail -12`
Expected: FAIL — `unknown field Update in struct literal of type Deps`, `undefined: ErrRestartForUpdate`, `too many arguments in call to GatherAuth`.

- [ ] **Step 3: Implement the capability**

In `caps.go`, `Outcome` gains:

```go
	// Restart asks the client to leave for a new build AFTER this outcome's
	// result and audit frames are written (daemon.update, P7). Never set on
	// a refusal.
	Restart bool
```

and `Deps` gains:

```go
	// Update is what daemon.update needs; nil where there is no connected
	// agent (a handler then says cannot).
	Update *UpdateDeps
```

`table.go` gains `"daemon.update": daemonUpdate,`.

`apps/novad/internal/caps/update.go`:

```go
package caps

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"novad/internal/state"
)

// UpdateDeps is what daemon.update needs from the running agent (S42b P7).
type UpdateDeps struct {
	Supervised bool          // a supervisor started this agent and will swap
	Binary     string        // the running binary; the build is staged beside it
	StateDir   string        // where update.json lives
	BaseURL    func() string // the locator this connection came through
	HTTP       *http.Client
}

// MaxBinaryBytes caps a download (a variable so a test can lower it).
var MaxBinaryBytes int64 = 64 << 20

var (
	hex12    = regexp.MustCompile(`^[0-9a-f]{12}$`)
	hex64    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	distPath = regexp.MustCompile(`^/api/v1/agent/dist/novad-(linux|darwin|windows)-(amd64|arm64)(\.exe)?$`)
)

// daemonUpdate downloads the hub's build the signed envelope names, checks
// its sha256, and stages it beside the running binary for supervise to swap
// in. It restarts nothing itself: Outcome.Restart asks the client to exit 75
// after this result is on the wire. A download that does not match is deleted
// and nothing is staged.
func daemonUpdate(ctx context.Context, r Request) Outcome {
	u := r.Deps.Update
	if u == nil {
		return fail("cannot: this agent is not running connected to Nova, so it has nothing to update from")
	}
	version, _ := strArg(r.Args, "version")
	sum, _ := strArg(r.Args, "sha256")
	path, _ := strArg(r.Args, "path")
	switch {
	case !hex12.MatchString(version):
		return fail("daemon.update needs a 12-hex version, got %q", version)
	case !hex64.MatchString(sum):
		return fail("daemon.update needs a 64-hex sha256")
	}
	m := distPath.FindStringSubmatch(path)
	if m == nil {
		return fail("daemon.update's path must be one of the hub's agent builds, got %q", path)
	}
	if m[1] != runtime.GOOS || m[2] != runtime.GOARCH {
		return fail("cannot: %s is not this machine's build (%s/%s)", path, runtime.GOOS, runtime.GOARCH)
	}
	if !u.Supervised {
		return fail("cannot: this agent was started by hand, not by its service, so nothing would start a new build — install the service (novad install) and it updates itself")
	}
	base := ""
	if u.BaseURL != nil {
		base = strings.TrimRight(u.BaseURL(), "/")
	}
	if base == "" {
		return fail("cannot: this agent has no hub address to download from")
	}
	staged := u.Binary + ".new"
	part := staged + ".part"
	got, size, err := download(ctx, u.HTTP, base+path, part)
	if err != nil {
		_ = os.Remove(part)
		return fail("could not download %s: %v", path, err)
	}
	if got != sum {
		_ = os.Remove(part)
		return fail("the download's sha256 is %s, not the signed %s — nothing staged", got, sum)
	}
	if err := os.Chmod(part, 0o755); err != nil {
		_ = os.Remove(part)
		return fail("could not mark the new build executable: %v", err)
	}
	if err := os.Rename(part, staged); err != nil {
		_ = os.Remove(part)
		return fail("could not stage the new build: %v", err)
	}
	rec := state.Update{V: 1, Version: version, SHA256: sum, Staged: staged, Outcome: state.UpdateStaged, At: time.Now().UTC()}
	if err := state.WriteJSON(filepath.Join(u.StateDir, state.UpdateFile), rec); err != nil {
		_ = os.Remove(staged)
		return fail("could not record the staged update: %v", err)
	}
	out := ok0(fmt.Sprintf("staged %s (%d bytes, sha256 %s…); restarting into it now — the update is confirmed only when this agent reconnects reporting %s",
		version, size, sum[:12], version))
	out.Restart = true
	return out
}

func download(ctx context.Context, c *http.Client, url, dst string) (string, int64, error) {
	if c == nil {
		c = &http.Client{Timeout: 100 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", 0, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("the hub answered %s", resp.Status)
	}
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o700)
	if err != nil {
		return "", 0, err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, MaxBinaryBytes+1))
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", n, err
	}
	if n > MaxBinaryBytes {
		return "", n, fmt.Errorf("the build is over the %d MiB cap", MaxBinaryBytes>>20)
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}
```

(The oversize test's message "over the 0 MiB cap" still contains "cap".)

- [ ] **Step 4: The client leaves after the reply; the facts carry the outcome**

In `client.go`:

```go
// ErrRestartForUpdate is Run's return after daemon.update staged a build:
// main exits 75 and the supervisor swaps it in.
var ErrRestartForUpdate = errors.New("a new build is staged; restarting into it")
```

`Agent` gains `restart atomic.Bool` and `sessionCancel atomic.Pointer[context.CancelFunc]`. In `serve`, right after `serveCtx, cancel := context.WithCancel(ctx)`: `a.sessionCancel.Store(&cancel)`. In `handleCommand`, the deps become:

```go
	deps := a.deps
	deps.SendFacts = func(ctx context.Context) error { return a.sendFacts(ctx, c) }
	deps.Update = &caps.UpdateDeps{Supervised: a.opts.Supervised, Binary: a.opts.Binary, StateDir: a.opts.StateDir, BaseURL: a.Server}
```

and after its final `a.emit(...)`:

```go
	if outcome.OK && outcome.Restart {
		// The result and its audit entry are written: now end the session
		// so Run can return and main can exit 75 for the swap.
		a.restart.Store(true)
		if c := a.sessionCancel.Load(); c != nil {
			(*c)()
		}
	}
```

In `Run`, at the top of the loop body and right after `connectOnce` returns: `if a.restart.Load() { return ErrRestartForUpdate }`.

`gatherAuth` is set after the Agent exists, so it can read `update.json`:

```go
	a.gatherAuth = func(ctx context.Context) (facts.Auth, []facts.Unreadable) {
		return facts.GatherAuth(ctx, platform.Exec{}, version, a.lastUpdate())
	}
```

```go
// lastUpdate is update.json, or nil when there is none to report.
func (a *Agent) lastUpdate() *state.Update {
	if a.opts.StateDir == "" {
		return nil
	}
	var u state.Update
	if state.ReadJSON(filepath.Join(a.opts.StateDir, state.UpdateFile), &u) != nil {
		return nil
	}
	return &u
}
```

In `facts.go`:

```go
// UpdateFact is the last update's outcome, as the supervisor recorded it:
// core confirms or rolls back its record from this (S42b P8).
type UpdateFact struct {
	Version string `json:"version"`
	Outcome string `json:"outcome"`
	Reason  string `json:"reason"`
	At      string `json:"at"`
}
```

`AgentInfo` gains `Update *UpdateFact \`json:"update,omitempty"\``, and `GatherAuth` gains the parameter `last *state.Update` and, before returning:

```go
	if last != nil && (last.Outcome == state.UpdateApplied || last.Outcome == state.UpdateRolledBack) {
		a.Agent.Update = &UpdateFact{Version: clip(last.Version), Outcome: last.Outcome,
			Reason: clip(last.Reason), At: last.At.UTC().Format(time.RFC3339)}
	}
```

In `main.go`: `const exitUpdateStaged = 75` and a case in `afterRun`, before `default`:

```go
	case errors.Is(err, client.ErrRestartForUpdate):
		return exitUpdateStaged, "a new build is staged — exiting so the supervisor swaps it in"
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -12
for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done
```

Expected: all `ok`; vet silent. The five-key auth-facts test still passes (`update` is inside `agent`, omitted when nil).

- [ ] **Step 6: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/novad/internal/caps apps/novad/internal/client/client.go apps/novad/internal/client/integration_test.go \
  apps/novad/internal/facts apps/novad/main.go apps/novad/main_test.go
git -C $W commit -m "feat(novad): daemon.update — the hub's build downloaded, checked and staged; the agent leaves for the swap only after it answered"
git -C $W show --stat HEAD | tail -5
```

---

## Task 10b: What the agent says so she can act unaided — how it runs, elevation, WSL (P29)

The owner's requirement (2026-09-28, LOCKED): "When she enrolls new agents on devices, those agents need metadata that will be helpful for nova. I should not need to hold nova's hand." Turns `3743df3b`, `73574d49` and `01faf3b7` failed for want of exactly these facts: where the old agent ran (a user unit `novad` inside `Ubuntu-26.04`), what `sudo` would do there, and that Windows' own `sudo` is not Linux's.

**Files:**
- Create: `apps/novad/internal/platform/wsl.go`, `wsl_windows.go`, `wsl_other.go`, `elevation_unix.go`, `elevation_windows.go`, `elevation_unix_test.go`
- Modify: `apps/novad/internal/platform/parse_test.go` (the tests of `ParseWSLInside` and `DecodeWSL`, which live in `wsl.go` — not OS-tagged, so they run on every OS)
- Create: `apps/novad/internal/facts/probe.go`, `probe_test.go`
- Modify: `apps/novad/internal/facts/facts.go` (four `Frame` fields)
- Modify: `apps/novad/internal/client/client.go`, `integration_test.go` (`probe`, `reprobe`, `Options.Config`)
- Modify: `apps/novad/main.go` (passes the config file), `apps/novad/README.md` (the Facts section)

**Interfaces:**
- Consumes: `service.UnitName`, `service.Label`, `service.RunKeyPath`, `service.RunKeyValue`, `service.ModeSystemd|ModeLaunch|ModeRunKey` (Task 8); `platform.Mode()`, `platform.SupervisorEnv`, `platform.FakeRunner.Seq`, `client.Options` (Task 5).
- Produces:
  - `platform.WSLDistro{Name string; Version int; Default bool}`; `platform.WSLDistros() ([]WSLDistro, error)` (nil, nil off Windows and when no distribution is registered).
  - `platform.WSLInside{PID1, User, Sudo, UnitActive, UnitFile, UnitRestart string; UnitMainPID int; UnitSaid string; PIDs []int}`; `platform.WSLLookScript`; `platform.ParseWSLInside(string) WSLInside`; `platform.DecodeWSL(string) string`.
  - `platform.Elev{Elevated bool; Admin *bool; Sudo, Said string}`; `platform.Elevation(ctx, Runner) (Elev, error)`. `Sudo` is `no_password | refused | absent` on Linux and macOS, `off | new_window | input_off | inline | absent | unknown` on Windows.
  - `facts.Self{Binary, Config string}`; `facts.Service`, `facts.Elevation`, `facts.WSLDistros{Distros []Distro; RunningSaid string}`, `facts.Distro`, `facts.Unit`; `facts.Probed{At time.Time; Service Service; Elevation *Elevation; WSL *WSLDistros; Unreadable []Unreadable}`; `facts.Probe(ctx, r platform.Runner, self Self) Probed`; `(Probed).ApplyTo(*Frame)`.
  - Frame keys `service`, `elevation`, `wsl_distros`, `probed_at` (Task 16b validates and renders them).
  - `client.ProbeBudget = 45 * time.Second`, `client.ProbeMaxAge = 10 * time.Minute`; `client.Options.Config string`.

- [ ] **Step 1: Write the failing tests**

Append to `internal/platform/parse_test.go`:

```go
// P29: the look inside a running distribution, as its script prints it.
func TestParseWSLInsideReadsTheLook(t *testing.T) {
	out := "pid1=systemd\nuser=sam\nsudo=refused\nunit.ActiveState=active\nunit.UnitFileState=enabled\n" +
		"unit.MainPID=412\nunit.Restart=always\npids=412 \n"
	want := WSLInside{PID1: "systemd", User: "sam", Sudo: "refused", UnitActive: "active", UnitFile: "enabled",
		UnitRestart: "always", UnitMainPID: 412, PIDs: []int{412}}
	if got := ParseWSLInside(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

// A user bus systemctl cannot reach is said in systemctl's own words — never
// read as "no unit".
func TestParseWSLInsideKeepsWhatSystemctlSaidWhenItCouldNotAnswer(t *testing.T) {
	got := ParseWSLInside("pid1=systemd\nuser=sam\nsudo=refused\nunit.Failed to connect to bus: No medium found\npids=\n")
	if got.UnitActive != "" || got.UnitSaid != "Failed to connect to bus: No medium found" || got.PIDs != nil {
		t.Fatalf("got %+v", got)
	}
}

// wsl.exe writes UTF-16LE unless WSL_UTF8 took; both read the same.
func TestDecodeWSLReadsUTF16AndUTF8(t *testing.T) {
	utf16le := "\xff\xfeU\x00b\x00u\x00n\x00t\x00u\x00-\x002\x006\x00.\x000\x004\x00\r\x00\n\x00"
	if got := DecodeWSL(utf16le); got != "Ubuntu-26.04\r\n" {
		t.Fatalf("utf-16: %q", got)
	}
	if got := DecodeWSL("Ubuntu-26.04\r\n"); got != "Ubuntu-26.04\r\n" {
		t.Fatalf("utf-8: %q", got)
	}
}
```

`internal/platform/elevation_unix_test.go`:

```go
//go:build unix

package platform

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"testing"
)

// P29: what `sudo -n true` did, never a guess — and -n never asks anyone.
func TestElevationSaysWhatSudoDid(t *testing.T) {
	cases := []struct {
		name, sudo, said string
		err              error
	}{
		{"no password needed", "no_password", "", nil},
		{"a password is required", "refused", "sudo: exit status 1: sudo: a password is required",
			errors.New("sudo: exit status 1: sudo: a password is required")},
		{"no sudo here", "absent", "", &exec.Error{Name: "sudo", Err: exec.ErrNotFound}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := &FakeRunner{Outputs: map[string]string{"sudo": ""}}
			if c.err != nil {
				r.Errs = map[string]error{"sudo": c.err}
			}
			e, err := Elevation(context.Background(), r)
			if err != nil || e.Sudo != c.sudo || e.Said != c.said || e.Admin != nil {
				t.Fatalf("got %+v, %v", e, err)
			}
			if len(r.Calls) != 1 || !reflect.DeepEqual(r.Calls[0].Args, []string{"-n", "true"}) {
				t.Fatalf("calls = %+v — only `sudo -n true`, which never asks", r.Calls)
			}
		})
	}
}
```

`internal/facts/probe_test.go`:

```go
package facts

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"novad/internal/platform"
	"novad/internal/service"
)

func withDistros(t *testing.T, list []platform.WSLDistro) {
	t.Helper()
	old := readDistros
	readDistros = func() ([]platform.WSLDistro, error) { return list, nil }
	t.Cleanup(func() { readDistros = old })
}

const lookOut = "pid1=systemd\nuser=sam\nsudo=refused\nunit.ActiveState=active\nunit.UnitFileState=enabled\n" +
	"unit.MainPID=412\nunit.Restart=always\npids=412\n"

// P29, Review Focus 11: a stopped distribution is listed and never looked
// inside — looking would start it. A running one gets one look and the root
// check, nothing else.
func TestTheWSLProbeLooksOnlyInsideRunningDistros(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2, Default: true}, {Name: "docker-desktop", Version: 2}})
	r := &platform.FakeRunner{Seq: map[string][]string{"wsl.exe": {"Ubuntu-26.04\r\n", lookOut, ""}}}
	got, unread := probeWSL(context.Background(), r)
	if len(unread) != 0 {
		t.Fatalf("unreadable: %+v", unread)
	}
	want := &WSLDistros{Distros: []Distro{
		{Name: "Ubuntu-26.04", Default: true, Version: 2, Running: true, Looked: true, PID1: "systemd", User: "sam",
			Sudo: "refused", Root: true, Unit: &Unit{Active: "active", File: "enabled", Restart: "always", MainPID: 412},
			PIDs: []int{412}},
		{Name: "docker-desktop", Version: 2, PIDs: []int{}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
	wantCalls := [][]string{
		{"--list", "--running", "--quiet"},
		{"-d", "Ubuntu-26.04", "--exec", "/bin/sh", "-c", platform.WSLLookScript},
		{"-d", "Ubuntu-26.04", "-u", "root", "--exec", "/bin/true"},
	}
	if len(r.Calls) != len(wantCalls) {
		t.Fatalf("calls = %+v", r.Calls)
	}
	for i, c := range r.Calls {
		if c.Name != "wsl.exe" || !reflect.DeepEqual(c.Args, wantCalls[i]) || slices.Contains(c.Args, "docker-desktop") {
			t.Fatalf("call %d = %s %v", i, c.Name, c.Args)
		}
	}
}

// A running-list that failed is said in wsl.exe's words, and nothing is
// looked inside on a guess.
func TestAFailedRunningListLooksInsideNothingAndSaysSo(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2, Default: true}})
	r := &platform.FakeRunner{Errs: map[string]error{
		"wsl.exe": errors.New("wsl.exe: exit status 4294967295: The Windows Subsystem for Linux is not enabled."),
	}}
	got, _ := probeWSL(context.Background(), r)
	d := got.Distros[0]
	if d.Running || d.Looked || !strings.Contains(got.RunningSaid, "is not enabled") || len(r.Calls) != 1 {
		t.Fatalf("got %+v (running_said %q), calls %d", d, got.RunningSaid, len(r.Calls))
	}
}

// No distribution for this account is an observation — an empty list, never
// "unreadable", and no wsl.exe at all.
func TestNoDistributionIsAnEmptyList(t *testing.T) {
	withDistros(t, nil)
	r := &platform.FakeRunner{}
	got, unread := probeWSL(context.Background(), r)
	if got == nil || got.Distros == nil || len(got.Distros) != 0 || len(unread) != 0 || len(r.Calls) != 0 {
		t.Fatalf("got %+v, %+v, calls %v", got, unread, r.Calls)
	}
}

// P29: how THIS agent runs, read from its own mode, files and process.
func TestServiceSaysHowThisAgentRuns(t *testing.T) {
	t.Setenv(platform.SupervisorEnv, "4242")
	bin := filepath.Join(t.TempDir(), "novad.exe")
	s := serviceOf(service.ModeRunKey, Self{Binary: bin, Config: filepath.Join("cfg", "config.json")})
	want := `HKCU\` + service.RunKeyPath + `\` + service.RunKeyValue
	if s.Name != want || s.Process != "novad.exe" || s.Binary != bin || s.PID != os.Getpid() ||
		s.SupervisorPID != 4242 || s.User == "" {
		t.Fatalf("got %+v", s)
	}
	t.Setenv(platform.SupervisorEnv, "")
	if got := serviceOf("foreground", Self{Binary: bin}); got.Name != "" || got.SupervisorPID != 0 {
		t.Fatalf("a hand-started agent has no service and no supervisor: %+v", got)
	}
}

// The frame carries the last probe with its time; a frame with no probe
// says nothing about one.
func TestAProbeIsCarriedInTheFrameWithItsTime(t *testing.T) {
	at := time.Date(2026, 9, 28, 17, 40, 0, 0, time.UTC)
	p := Probed{At: at, Service: Service{Name: service.UnitName}, Unreadable: []Unreadable{{Item: "elevation", Reason: "x"}}}
	f := Frame{Type: "facts"}
	p.ApplyTo(&f)
	if f.Service == nil || f.Service.Name != service.UnitName || f.ProbedAt != "2026-09-28T17:40:00Z" || len(f.Unreadable) != 1 {
		t.Fatalf("got %+v", f)
	}
	data, _ := json.Marshal(Frame{Type: "facts"})
	if strings.Contains(string(data), "service") || strings.Contains(string(data), "probed_at") {
		t.Fatalf("a frame with no probe says nothing about one: %s", data)
	}
}
```

Append to `internal/client/integration_test.go` (imports gain `slices` and `sync/atomic`):

```go
// P29, Review Focus 11: the slow probes run once at connect — after the
// first frame, off the reader's path — and again on facts.refresh; never on
// the minute cadence. Every frame between carries the last result.
func TestTheProbesRunAtConnectAndOnRefreshOnly(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-probe-1"
	pidOf := func(f map[string]any) string {
		s, _ := f["service"].(map[string]any)
		n, _ := s["pid"].(json.Number)
		return n.String()
	}
	type seen struct{ before, after []string }
	got := make(chan seen, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		if fakeCoreHandshake(ctx, c, corePub, devPub) == nil {
			return
		}
		var s seen
		// The ready frame, the probe's frame, and at least two on the cadence.
		for len(s.before) < 4 || !slices.Contains(s.before, "1") {
			f, err := coreRead(ctx, c)
			if err != nil {
				return
			}
			if f["type"] == "facts" {
				s.before = append(s.before, pidOf(f))
			}
		}
		now := time.Now().Unix()
		env := map[string]any{
			"v": int64(1), "envelope_id": "probe-e1", "device_id": deviceID,
			"capability": "facts.refresh", "args": map[string]any{},
			"issued_at": now, "expires_at": now + 60,
		}
		canon, _ := wire.Canonical(env)
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": hex.EncodeToString(ed25519.Sign(corePriv, canon))})
		for {
			f, err := coreRead(ctx, c)
			if err != nil {
				return
			}
			switch f["type"] {
			case "facts":
				s.after = append(s.after, pidOf(f))
			case "audit":
				got <- s
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	var probes atomic.Int32
	agent.probe = func(context.Context) facts.Probed {
		n := probes.Add(1)
		return facts.Probed{At: time.Now(), Service: facts.Service{Name: "novad.service", PID: int(n)}}
	}
	agent.factsMinGap, agent.factsEvery, agent.heartbeatEvery = 10*time.Millisecond, 40*time.Millisecond, 20*time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() { _ = agent.Run(ctx) }()
	var s seen
	select {
	case s = <-got:
	case <-ctx.Done():
		t.Fatal("timed out")
	}
	if s.before[0] != "" {
		t.Fatalf("the frame at ready waited for the probe: %v", s.before)
	}
	for _, pid := range s.before {
		if pid != "" && pid != "1" {
			t.Fatalf("frames before the refresh = %v: the cadence probed again", s.before)
		}
	}
	if len(s.after) == 0 || s.after[len(s.after)-1] != "2" || probes.Load() != 2 {
		t.Fatalf("after the refresh = %v with %d probes, want exactly one more probe, carried", s.after, probes.Load())
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/novad && ~/.local/bin/mise x -- go test ./internal/platform ./internal/facts ./internal/client 2>&1 | tail -8`
Expected: FAIL — `undefined: ParseWSLInside`, `undefined: Elevation`, `undefined: probeWSL`, `agent.probe undefined`.

- [ ] **Step 3: The platform readers**

`internal/platform/wsl.go`:

```go
package platform

import (
	"strconv"
	"strings"
	"unicode/utf16"
)

// WSLDistro is one WSL distribution registered for this account, as WSL's
// own registry key names it (wsl_windows.go).
type WSLDistro struct {
	Name    string
	Version int // 1 or 2; 0 when the key did not say
	Default bool
}

// WSLInside is what one look inside a RUNNING distribution found. A field
// the look could not read stays empty; UnitSaid carries systemctl's own
// words when it answered nothing this parser knows.
type WSLInside struct {
	PID1        string
	User        string
	Sudo        string // no_password | refused | absent
	UnitActive  string // ActiveState of the user unit novad.service
	UnitFile    string // UnitFileState; "" when no unit file exists
	UnitRestart string // Restart=
	UnitMainPID int
	UnitSaid    string
	PIDs        []int // processes named novad
}

// WSLLookScript is the one look inside a running distribution, run as its
// default user through `wsl.exe -d <name> --exec /bin/sh -c`. A constant:
// the distro's name reaches wsl.exe as its own argument, never this text.
// Plain sh, one key=value a line, and nothing in it can ask for input
// (sudo -n). XDG_RUNTIME_DIR is defaulted because a process wsl.exe starts
// may not have it, and without it systemctl --user cannot find the bus.
const WSLLookScript = `export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; ` +
	`echo "pid1=$(cat /proc/1/comm 2>/dev/null)"; ` +
	`echo "user=$(id -un 2>/dev/null)"; ` +
	`if command -v sudo >/dev/null 2>&1; then if sudo -n true >/dev/null 2>&1; then echo sudo=no_password; else echo sudo=refused; fi; else echo sudo=absent; fi; ` +
	`systemctl --user show -p ActiveState -p UnitFileState -p MainPID -p Restart novad.service 2>&1 | while IFS= read -r l; do echo "unit.$l"; done; ` +
	`echo "pids=$(pgrep -x novad 2>/dev/null | tr '\n' ' ')"`

// ParseWSLInside reads WSLLookScript's output.
func ParseWSLInside(out string) WSLInside {
	var in WSLInside
	lines := strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n")
	for _, line := range lines {
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		switch key {
		case "pid1":
			in.PID1 = val
		case "user":
			in.User = val
		case "sudo":
			in.Sudo = val
		case "unit.ActiveState":
			in.UnitActive = val
		case "unit.UnitFileState":
			in.UnitFile = val
		case "unit.Restart":
			in.UnitRestart = val
		case "unit.MainPID":
			in.UnitMainPID, _ = strconv.Atoi(val)
		case "pids":
			for _, f := range strings.Fields(val) {
				if n, err := strconv.Atoi(f); err == nil && n > 0 {
					in.PIDs = append(in.PIDs, n)
				}
			}
		}
	}
	if in.UnitActive == "" {
		for _, line := range lines {
			if rest, ok := strings.CutPrefix(line, "unit."); ok && strings.TrimSpace(rest) != "" {
				in.UnitSaid = strings.TrimSpace(rest)
				break
			}
		}
	}
	return in
}

// DecodeWSL turns wsl.exe's own output into text: UTF-16LE (its default,
// with or without a byte-order mark) or UTF-8 (when WSL_UTF8=1 took).
func DecodeWSL(out string) string {
	if !strings.Contains(out, "\x00") {
		return strings.TrimPrefix(out, "\uFEFF")
	}
	b := []byte(out)
	if len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE {
		b = b[2:]
	}
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		u = append(u, uint16(b[i])|uint16(b[i+1])<<8)
	}
	return string(utf16.Decode(u))
}
```

`internal/platform/wsl_windows.go`:

```go
//go:build windows

package platform

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const lxssKey = `Software\Microsoft\Windows\CurrentVersion\Lxss`

// WSLDistros lists this account's distributions from the key WSL itself
// keeps (Task 1, branch L-reg) — never `wsl --list --verbose`'s table, whose
// headings and states are translated. No key: nothing is registered.
func WSLDistros() ([]WSLDistro, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, lxssKey, registry.READ)
	if errors.Is(err, registry.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf(`reading HKCU\%s: %w`, lxssKey, err)
	}
	defer k.Close()
	def, _, _ := k.GetStringValue("DefaultDistribution")
	ids, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return nil, fmt.Errorf(`listing HKCU\%s: %w`, lxssKey, err)
	}
	var out []WSLDistro
	for _, id := range ids {
		sk, err := registry.OpenKey(k, id, registry.READ)
		if err != nil {
			continue
		}
		name, _, nerr := sk.GetStringValue("DistributionName")
		ver, _, _ := sk.GetIntegerValue("Version")
		sk.Close()
		if nerr != nil || name == "" {
			continue
		}
		out = append(out, WSLDistro{Name: name, Version: int(ver), Default: strings.EqualFold(id, def)})
	}
	return out, nil
}
```

On branch **L-cli** (Task 1), `WSLDistros` instead runs `wsl.exe --list --quiet` through `Exec{}` and returns one `WSLDistro{Name: line}` per non-empty line of `DecodeWSL(out)` — `Version` 0 and `Default` false, which Task 16b says as "WSL version unknown" and leaves "default" out.

`internal/platform/wsl_other.go`:

```go
//go:build !windows

package platform

// WSLDistros: WSL is a Windows feature; anywhere else there is none to list.
func WSLDistros() ([]WSLDistro, error) { return nil, nil }
```

`internal/platform/elevation_unix.go`:

```go
//go:build unix

package platform

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
)

// Elev is what elevating from this agent would meet (S42b P29).
type Elev struct {
	Elevated bool   // root, or an elevated token
	Admin    *bool  // Windows: a member of Administrators; nil elsewhere
	Sudo     string // see facts.Elevation
	Said     string // sudo's own first line when it refused
}

// Elevation: whether the agent already runs as root, and what `sudo -n
// true` did. -n never asks for a password; it fails instead, which is the
// answer.
func Elevation(ctx context.Context, r Runner) (Elev, error) {
	e := Elev{Elevated: os.Geteuid() == 0}
	_, err := r.Run(ctx, "sudo", []string{"-n", "true"}, "")
	switch {
	case err == nil:
		e.Sudo = "no_password"
	case errors.Is(err, exec.ErrNotFound):
		e.Sudo = "absent"
	default:
		e.Sudo = "refused"
		e.Said, _, _ = strings.Cut(err.Error(), "\n")
	}
	return e, nil
}
```

`internal/platform/elevation_windows.go`:

```go
//go:build windows

package platform

import (
	"context"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Elev is what elevating from this agent would meet (S42b P29).
type Elev struct {
	Elevated bool
	Admin    *bool
	Sudo     string
	Said     string
}

const (
	tokenElevationTypeDefault = 1
	tokenElevationTypeFull    = 2
	tokenElevationTypeLimited = 3
	sudoKey                   = `SOFTWARE\Microsoft\Windows\CurrentVersion\Sudo`
)

// sudoModes are Windows sudo's settings by the value of its Enabled key
// (Task 1 measured the key).
var sudoModes = map[uint64]string{0: "off", 1: "new_window", 2: "input_off", 3: "inline"}

// Elevation reads this agent's own token — elevated, and whether the
// account is an administrator behind UAC — and Windows sudo's setting.
func Elevation(_ context.Context, _ Runner) (Elev, error) {
	t := windows.GetCurrentProcessToken()
	e := Elev{Elevated: t.IsElevated(), Sudo: "absent"}
	var typ, n uint32
	if err := windows.GetTokenInformation(t, windows.TokenElevationType,
		(*byte)(unsafe.Pointer(&typ)), uint32(unsafe.Sizeof(typ)), &n); err != nil {
		return e, fmt.Errorf("reading this agent's token: %w", err)
	}
	admin := typ == tokenElevationTypeFull || typ == tokenElevationTypeLimited
	if typ == tokenElevationTypeDefault {
		if sid, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid); err == nil {
			admin, _ = windows.Token(0).IsMember(sid)
		}
	}
	e.Admin = &admin
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, sudoKey, registry.QUERY_VALUE); err == nil {
		if v, _, err := k.GetIntegerValue("Enabled"); err == nil {
			if m, ok := sudoModes[v]; ok {
				e.Sudo = m
			} else {
				e.Sudo, e.Said = "unknown", fmt.Sprintf("Enabled=%d", v)
			}
		}
		k.Close()
	}
	return e, nil
}
```

- [ ] **Step 4: The probe, and the frame that carries it**

`internal/facts/probe.go`:

```go
package facts

import (
	"context"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"novad/internal/platform"
	"novad/internal/service"
)

// Self is what only the running agent knows about itself: its binary and
// its config file (main passes them through client.Options).
type Self struct {
	Binary string
	Config string
}

// Service is how THIS agent runs (S42b P29): the name its service manager
// knows it by ("" when it was started by hand), its files, its process and
// the account it runs as — read, never assumed.
type Service struct {
	Name          string `json:"name"`
	Binary        string `json:"binary"`
	Config        string `json:"config"`
	Process       string `json:"process"`
	PID           int    `json:"pid"`
	SupervisorPID int    `json:"supervisor_pid"`
	User          string `json:"user"`
}

// Elevation is what elevating from this agent would meet.
type Elevation struct {
	Elevated bool   `json:"elevated"`
	Admin    *bool  `json:"admin,omitempty"`
	Sudo     string `json:"sudo"`
	SudoSaid string `json:"sudo_said,omitempty"`
}

// WSLDistros are the WSL distributions beside a Windows agent.
// RunningSaid is wsl.exe's own words when its running-list failed.
type WSLDistros struct {
	Distros     []Distro `json:"distros"`
	RunningSaid string   `json:"running_said,omitempty"`
}

// Distro is one distribution. Looked is false for one that is not running:
// looking inside would start it.
type Distro struct {
	Name    string `json:"name"`
	Default bool   `json:"default"`
	Version int    `json:"version"`
	Running bool   `json:"running"`
	Looked  bool   `json:"looked"`
	PID1    string `json:"pid1,omitempty"`
	User    string `json:"user,omitempty"`
	Sudo    string `json:"sudo,omitempty"`
	Root    bool   `json:"root"`
	Unit    *Unit  `json:"novad_unit,omitempty"`
	PIDs    []int  `json:"novad_pids"`
}

// Unit is the user unit novad.service inside a distribution.
type Unit struct {
	Active  string `json:"active"`
	File    string `json:"file"`
	Restart string `json:"restart"`
	MainPID int    `json:"main_pid"`
	Said    string `json:"said,omitempty"`
}

// Probed is one run of the probes and when it ran.
type Probed struct {
	At         time.Time
	Service    Service
	Elevation  *Elevation
	WSL        *WSLDistros
	Unreadable []Unreadable
}

const (
	maxDistros   = 8 // keeps the frame far inside core's 16 KiB with the rest
	maxPIDs      = 8
	probeProgram = 10 * time.Second
)

// readDistros is WSL's registry list; a variable so a test hands in its own.
var readDistros = platform.WSLDistros

// Probe runs the probes. The client runs it at connect and on facts.refresh
// only — never on the minute cadence: `sudo -n` can write an auth-log line
// each time, and wsl.exe is not free.
func Probe(ctx context.Context, r platform.Runner, self Self) Probed {
	p := Probed{At: time.Now().UTC(), Service: serviceOf(platform.Mode(), self)}
	ectx, cancel := context.WithTimeout(ctx, probeProgram)
	e, err := platform.Elevation(ectx, r)
	cancel()
	if err != nil {
		p.Unreadable = append(p.Unreadable, Unreadable{Item: "elevation", Reason: clip(err.Error())})
	} else {
		p.Elevation = &Elevation{Elevated: e.Elevated, Admin: e.Admin, Sudo: e.Sudo, SudoSaid: clip(e.Said)}
	}
	if runtime.GOOS == "windows" {
		w, unread := probeWSL(ctx, r)
		p.WSL = w
		p.Unreadable = append(p.Unreadable, unread...)
	}
	return p
}

func serviceOf(mode string, self Self) Service {
	s := Service{Binary: clip(self.Binary), Config: clip(self.Config), Process: clip(filepath.Base(self.Binary)), PID: os.Getpid()}
	switch mode {
	case service.ModeSystemd:
		s.Name = service.UnitName
	case service.ModeLaunch:
		s.Name = service.Label
	case service.ModeRunKey:
		s.Name = `HKCU\` + service.RunKeyPath + `\` + service.RunKeyValue
	}
	s.SupervisorPID, _ = strconv.Atoi(os.Getenv(platform.SupervisorEnv))
	switch u, err := user.Current(); {
	case err == nil:
		s.User = clip(u.Username)
	case os.Getenv("USER") != "":
		s.User = clip(os.Getenv("USER"))
	default:
		s.User = clip(os.Getenv("USERNAME"))
	}
	return s
}

// probeWSL lists the distributions and looks inside each RUNNING one —
// never a stopped one, which looking would start (Review Focus 11).
func probeWSL(ctx context.Context, r platform.Runner) (*WSLDistros, []Unreadable) {
	list, err := readDistros()
	if err != nil {
		return nil, []Unreadable{{Item: "wsl_distros", Reason: clip(err.Error())}}
	}
	out := &WSLDistros{Distros: []Distro{}}
	if len(list) == 0 {
		return out, nil
	}
	var unread []Unreadable
	lctx, cancel := context.WithTimeout(ctx, probeProgram)
	raw, err := r.Run(lctx, "wsl.exe", []string{"--list", "--running", "--quiet"}, "")
	cancel()
	listed := map[string]bool{}
	for _, line := range strings.Split(platform.DecodeWSL(raw), "\n") {
		if name := strings.TrimSpace(line); name != "" {
			listed[name] = true
		}
	}
	if err != nil {
		// Nothing running and a real failure can look alike here; say the
		// words, and "running" stays what the list showed.
		first, _, _ := strings.Cut(strings.TrimSpace(err.Error()), "\n")
		out.RunningSaid = clip(first)
	}
	for _, d := range list {
		if len(out.Distros) == maxDistros {
			unread = append(unread, Unreadable{Item: "wsl_distros", Reason: fmt.Sprintf("more than %d distributions; the rest are not listed", maxDistros)})
			break
		}
		entry := Distro{Name: clip(d.Name), Default: d.Default, Version: d.Version, Running: listed[d.Name], PIDs: []int{}}
		if entry.Running {
			look(ctx, r, d.Name, &entry, &unread)
		}
		out.Distros = append(out.Distros, entry)
	}
	return out, unread
}

// look runs the one look inside a running distribution, then whether
// `wsl.exe -u root` runs there without a password.
func look(ctx context.Context, r platform.Runner, name string, d *Distro, unread *[]Unreadable) {
	lctx, cancel := context.WithTimeout(ctx, probeProgram)
	raw, err := r.Run(lctx, "wsl.exe", []string{"-d", name, "--exec", "/bin/sh", "-c", platform.WSLLookScript}, "")
	cancel()
	if err != nil && strings.TrimSpace(raw) == "" {
		*unread = append(*unread, Unreadable{Item: "wsl_distros." + clip(name), Reason: clip(err.Error())})
		return
	}
	in := platform.ParseWSLInside(raw)
	d.Looked = true
	d.PID1, d.User, d.Sudo = clip(in.PID1), clip(in.User), in.Sudo
	if len(in.PIDs) > maxPIDs {
		in.PIDs = in.PIDs[:maxPIDs]
	}
	if in.PIDs != nil {
		d.PIDs = in.PIDs
	}
	if in.UnitActive != "" || in.UnitSaid != "" {
		d.Unit = &Unit{Active: clip(in.UnitActive), File: clip(in.UnitFile), Restart: clip(in.UnitRestart),
			MainPID: in.UnitMainPID, Said: clip(in.UnitSaid)}
	}
	rctx, rcancel := context.WithTimeout(ctx, probeProgram)
	_, rerr := r.Run(rctx, "wsl.exe", []string{"-d", name, "-u", "root", "--exec", "/bin/true"}, "")
	rcancel()
	d.Root = rerr == nil
}

// ApplyTo puts a probe's findings in a frame, with the time they were read.
func (p Probed) ApplyTo(f *Frame) {
	svc := p.Service
	f.Service = &svc
	f.Elevation = p.Elevation
	f.WSLDistros = p.WSL
	f.ProbedAt = p.At.UTC().Format(time.RFC3339)
	f.Unreadable = append(f.Unreadable, p.Unreadable...)
	*f = capUnreadable(*f)
}
```

`facts.go`: `Frame` gains

```go
	// The probes' last findings and when they ran (S42b P29): sent in
	// every frame between probes, so core always holds the latest.
	Service    *Service    `json:"service,omitempty"`
	Elevation  *Elevation  `json:"elevation,omitempty"`
	WSLDistros *WSLDistros `json:"wsl_distros,omitempty"`
	ProbedAt   string      `json:"probed_at,omitempty"`
```

- [ ] **Step 5: The client probes at connect (in the background) and on facts.refresh**

In `client.go`:

```go
// ProbeBudget bounds one run of the slow probes (P29); each program they
// run has 10 s of its own. ProbeMaxAge spares a flapping link: a reconnect
// within it keeps the last probe instead of running sudo and wsl.exe again.
const (
	ProbeBudget = 45 * time.Second
	ProbeMaxAge = 10 * time.Minute
)
```

`Agent` gains, beside the facts fields:

```go
	// probe runs the slow probes (P29). nil — tests, and every verb but
	// run — probes nothing. probed is the last result, guarded by factsMu.
	probe  func(context.Context) facts.Probed
	probed *facts.Probed
```

`Options` gains `Config string` (the config file). `Configure` becomes:

```go
func (a *Agent) Configure(o Options) {
	a.opts = o
	self := facts.Self{Binary: o.Binary, Config: o.Config}
	a.probe = func(ctx context.Context) facts.Probed { return facts.Probe(ctx, platform.Exec{}, self) }
}
```

```go
// reprobe runs the slow probes off every lock and sends a frame carrying
// them. force (facts.refresh) always probes; at connect a probe younger than
// ProbeMaxAge is kept — the frame sent at ready already carried it.
func (a *Agent) reprobe(ctx context.Context, c *websocket.Conn, force bool) error {
	if a.probe == nil {
		if force {
			return a.sendFacts(ctx, c)
		}
		return nil
	}
	a.factsMu.Lock()
	fresh := a.probed != nil && a.now().Sub(a.probed.At) < ProbeMaxAge
	a.factsMu.Unlock()
	if fresh && !force {
		return nil
	}
	pctx, cancel := context.WithTimeout(ctx, ProbeBudget)
	p := a.probe(pctx)
	cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	a.factsMu.Lock()
	a.probed = &p
	a.factsMu.Unlock()
	return a.sendFacts(ctx, c)
}
```

In `serve`, right after the ready-time `a.sendFacts(serveCtx, c)` block:

```go
	// P29: the slow probes run off the reader's path — the frame above went
	// out without them; this one follows when they finish.
	go func() {
		if err := a.reprobe(serveCtx, c, false); err != nil && serveCtx.Err() == nil {
			a.logf("probe frame not sent: %v", err)
		}
	}()
```

In `handleCommand`, `deps.SendFacts = func(ctx context.Context) error { return a.reprobe(ctx, c, true) }`. In `frameBytes`, read `probed` under the same lock as `carried` and apply it:

```go
	a.factsMu.Lock()
	carried := append([]facts.Unreadable(nil), a.authUnread...)
	probed := a.probed
	a.factsMu.Unlock()
	frame := a.gatherFrame(carried)
	if probed != nil {
		probed.ApplyTo(&frame)
	}
	data, err := json.Marshal(frame)
```

`main.go`'s `cmdRun`: `agent.Configure(client.Options{StateDir: paths.StateDir, Supervised: platform.Supervised(), Binary: self, Config: paths.ConfigFile, OnState: writeStatus})`.

README, the Facts section, after the `facts` frame's example — add:

```markdown
From S42b the frame also says what Nova needs to act on this machine without being
told (`service`, `elevation`, `wsl_distros`, `probed_at`): the name the service manager
knows this agent by, its binary, config, process and account; whether it runs as
root or elevated and what `sudo -n true` did (Windows: membership of Administrators
and Windows sudo's setting); and on Windows every WSL distribution — looked inside
only when it is already running, since looking would start it. These run programs,
so they are probed at connect and on `facts.refresh` only; every frame between
carries the last result and `probed_at`.
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -12
for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done
```

Expected: all `ok`; vet silent. `TestFactsRefreshWritesTheFrameBeforeItsResult` is unchanged and green: `buildAgent` never calls `Configure`, so `probe` is nil and facts.refresh sends one frame, as before.

- [ ] **Step 7: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/novad/internal/platform/wsl.go apps/novad/internal/platform/wsl_windows.go apps/novad/internal/platform/wsl_other.go \
  apps/novad/internal/platform/elevation_unix.go apps/novad/internal/platform/elevation_windows.go apps/novad/internal/platform/elevation_unix_test.go \
  apps/novad/internal/platform/parse_test.go apps/novad/internal/facts/probe.go apps/novad/internal/facts/probe_test.go \
  apps/novad/internal/facts/facts.go apps/novad/internal/client/client.go apps/novad/internal/client/integration_test.go apps/novad/main.go apps/novad/README.md
git -C $W commit -m "feat(novad): the agent says how it runs, what elevating would meet, and the WSL beside it — probed at connect and on refresh only"
git -C $W show --stat HEAD | tail -5
```


---

## Task 10c: A command never waits for input nobody can type (P30)

Turn `01faf3b7`: `wsl.exe -d Ubuntu-26.04 -- sudo systemctl --user stop novad` — no output, then the 110 s timeout. Two facts make that possible today. On Linux and macOS a child shares the agent's session (`Setpgid` only), so under a hand-started agent `sudo` asks on the owner's terminal. On Windows a child shares the agent's console, and `wsl.exe` may hand the Linux side a terminal of its own. Task 1's matrix says which fix works on Windows.

**Files:**
- Modify: `apps/novad/internal/caps/procattr_unix.go`, `procattr_windows.go`, `procattr_windows_test.go`
- Create: `apps/novad/internal/caps/shell_input_test.go`, `shell_linux_test.go`
- Modify: `apps/novad/README.md` ("What it can do")

**Interfaces:**
- Consumes: Task 1's branch (**T1**, **T2** or **T3**).
- Produces: `prepareCommand(cmd *exec.Cmd)` sets the child's input as well as its process attributes. Unchanged signature; `shell.go` is untouched.

- [ ] **Step 1: Write the failing tests**

`internal/caps/shell_input_test.go`:

```go
package caps

import (
	"context"
	"runtime"
	"testing"
	"time"
)

// P30, Review Focus 12: a command that reads its input gets none and ends
// at once — it never waits for a person nobody told.
func TestAShellExecChildGetsEmptyInput(t *testing.T) {
	argv := []any{"cat"}
	if runtime.GOOS == "windows" {
		argv = []any{"findstr", "x"} // reads its input to the end; no match is exit 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	out := Dispatch(ctx, "shell.exec", map[string]any{"argv": argv}, testDeps(t))
	if !out.OK {
		t.Fatalf("got %+v", out)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("the command waited %s for input", took)
	}
}
```

`internal/caps/shell_linux_test.go`:

```go
//go:build linux

package caps

import (
	"context"
	"strings"
	"testing"
)

// P30, Review Focus 12: the child leads its own session, so it has no
// controlling terminal even under an agent started by hand in one — where a
// sudo used to ask on the owner's terminal and wait.
func TestAShellExecChildHasNoControllingTerminal(t *testing.T) {
	out := Dispatch(context.Background(), "shell.exec", map[string]any{
		"argv": []any{"sh", "-c", `echo "$$ $(cut -d' ' -f6 /proc/$$/stat) $(cut -d' ' -f7 /proc/$$/stat)"`},
	}, testDeps(t))
	f := strings.Fields(out.Output)
	if !out.OK || len(f) != 3 || f[0] != f[1] || f[2] != "0" {
		t.Fatalf("pid, session, tty = %q: the child must lead its own session, with no terminal", out.Output)
	}
}
```

On branch **T1**, append to `procattr_windows_test.go`:

```go
// P30 (Task 1, T1): every child gets an empty pipe for its input — what
// tells wsl.exe it has no terminal to hand the Linux side.
func TestAWindowsChildGetsAnEmptyPipeForItsInput(t *testing.T) {
	cmd := exec.Command("wsl.exe", "-d", "x", "--", "true")
	prepareCommand(cmd)
	r, ok := cmd.Stdin.(*strings.Reader)
	if !ok || r.Len() != 0 {
		t.Fatalf("stdin = %T, want an empty reader", cmd.Stdin)
	}
	if cmd.SysProcAttr.CreationFlags&windows.DETACHED_PROCESS != 0 {
		t.Fatal("T1 keeps the hidden console: a detached child's own children open windows")
	}
}
```

On branch **T2**, instead:

```go
// P30 (Task 1, T2): a wsl.exe child starts with no console, so wsl.exe hands
// the Linux side no terminal; every other child keeps the hidden console (a
// detached cmd's own children would open windows) and gets empty input.
func TestOnlyAWSLChildStartsDetached(t *testing.T) {
	for _, c := range []struct {
		prog     string
		detached bool
	}{{"wsl.exe", true}, {`C:\Windows\System32\WSL.EXE`, true}, {"wsl", true}, {"cmd.exe", false}, {"powershell", false}} {
		cmd := exec.Command(c.prog, "/c", "ver")
		prepareCommand(cmd)
		if got := cmd.SysProcAttr.CreationFlags&windows.DETACHED_PROCESS != 0; got != c.detached {
			t.Fatalf("%s: detached = %v, want %v", c.prog, got, c.detached)
		}
		if _, empty := cmd.Stdin.(*strings.Reader); empty == c.detached {
			t.Fatalf("%s: stdin %T", c.prog, cmd.Stdin)
		}
	}
}
```

(`procattr_windows_test.go`'s imports gain `os/exec` and `strings`.) On **T3**, no Windows test: the Windows half is a carry.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/novad && ~/.local/bin/mise x -- go test ./internal/caps -run 'Input|ControllingTerminal|EmptyPipe|Detached' -v 2>&1 | tail -8`
Expected on Linux: FAIL — `TestAShellExecChildHasNoControllingTerminal`: the session is the test's, not the child's. (`TestAShellExecChildGetsEmptyInput` already passes on Unix — `nil` input is `/dev/null` — and stays as the pin.) The Windows tests fail on the Windows CI legs.

- [ ] **Step 3: Implement**

`procattr_unix.go`, in `prepareCommand`:

```go
	// Setsid (S42b P30): the child leads a new session with no controlling
	// terminal, so a program that would ask on one (sudo, ssh) fails at
	// once in its own words instead of waiting on the terminal of whoever
	// started a hand-run agent. A new session is also a new process group
	// (pgid = pid), which the group kill below relies on. (Setpgid is gone:
	// a session leader cannot also call setpgid.) Input stays nil —
	// /dev/null, end of file at once.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
```

`procattr_windows.go`, on **T1**:

```go
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	// S42b P30 (Task 1, T1): empty input, closed at once. It is also what
	// tells wsl.exe it has no terminal to give the Linux side, so a sudo
	// there fails at once instead of asking nobody for a password.
	cmd.Stdin = strings.NewReader("")
```

On **T2**:

```go
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	if isWSL(cmd.Path) {
		// S42b P30 (Task 1, T2): no console at all — the only way wsl.exe
		// gives the Linux side no terminal. Only wsl.exe: a detached cmd's
		// own children would each open a window.
		cmd.SysProcAttr.CreationFlags |= windows.DETACHED_PROCESS
	} else {
		cmd.Stdin = strings.NewReader("")
	}
```

with

```go
// isWSL: the program is wsl.exe, however it was spelled or found.
func isWSL(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	return base == "wsl.exe" || base == "wsl"
}
```

(imports gain `strings`; `path/filepath` is already there). On **T3**, `procattr_windows.go` is unchanged; record the carry in Task 31.

README, "What it can do", after the paragraph on argv:

```markdown
A command runs with **no terminal and empty input**: a program that would ask for
something — a sudo password, a yes/no question — gets no answer and fails at once in
its own words, which the result carries, instead of waiting until the command times out.
```

- [ ] **Step 4: Run the tests to verify they pass, and the whole module**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -12
for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done
```

Expected: all `ok` (the group-kill tests in `shell_unix_test.go` still pass: a session leader's group is its own); vet silent.

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/novad/internal/caps/procattr_unix.go apps/novad/internal/caps/procattr_windows.go apps/novad/internal/caps/procattr_windows_test.go \
  apps/novad/internal/caps/shell_input_test.go apps/novad/internal/caps/shell_linux_test.go apps/novad/README.md
git -C $W commit -m "fix(novad): her commands get no terminal and empty input — a prompt fails at once instead of hanging to the timeout"
git -C $W show --stat HEAD | tail -5
```

---

## Task 11: `internal/install` — pair, keep or re-pair; place the binary; read the signed manifest

**Files:**
- Create: `apps/novad/internal/install/enroll.go`, `identity.go`, `place.go`, `manifest.go`, `identity_test.go`, `place_test.go`, `manifest_test.go`
- Modify: `apps/novad/internal/client/verify.go` (`RefusedError`)
- Modify: `apps/novad/main.go` (`cmdEnroll` uses `install.Enroll`; `enrollBody` wraps `install.Body`)

**Interfaces:**
- Consumes: `config.SetAside`/`Hubs` (Task 6), `client.VerifyServer`/`KeyMismatch`, `wire.Canonical`.
- Produces:
  - `install.Body(code, pubkeyHex, name, hostname string) ([]byte, error)` — the five keys.
  - `install.Enroll(ctx, hub, code, name, hostname string, pub ed25519.PublicKey) (EnrollResult, error)`; `type EnrollResult struct{ DeviceID, Name, CorePubKey string; Repaired bool }`; `type EnrollRefused struct{ Status int; Reason string }`.
  - `install.ErrNeedsCode`; `type Options` (fields below); `(*Options).identity(ctx) (config.Config, []string, error)` (unexported; Task 12 calls it); `checkHubs([]string) error`; `(*Options).place(bin string) (string, error)` (returns the sha256).
  - `install.CheckManifest(ctx, server, corePubHex, sum string) string`.
  - `client.RefusedError{Server, Reason string}` — VerifyServer's auth_error, same words as before.

- [ ] **Step 1: Write the failing tests**

`apps/novad/internal/install/identity_test.go`:

```go
package install

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"novad/internal/client"
	"novad/internal/config"
)

const core = "ab"

func paths(t *testing.T) config.Paths {
	t.Helper()
	home := t.TempDir()
	return config.Paths{
		ConfigDir: filepath.Join(home, "cfg"), StateDir: filepath.Join(home, "state"),
		ConfigFile: filepath.Join(home, "cfg", "config.json"), KeyFile: filepath.Join(home, "cfg", "key"),
		AuditFile: filepath.Join(home, "state", "audit.jsonl"), Home: home,
	}
}

func enrolled(t *testing.T, p config.Paths, hubs ...string) {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	cfg := config.Config{DeviceID: "d-old", Name: "laptop", Server: hubs[0], CorePubKey: strings.Repeat(core, 32), Locators: hubs}
	if err := config.Save(p, cfg, priv); err != nil {
		t.Fatal(err)
	}
}

type enrollCall struct{ hub, code, name string }

func opts(t *testing.T, p config.Paths, verify error, enroll func(hub string) (EnrollResult, error)) (*Options, *[]enrollCall) {
	t.Helper()
	var calls []enrollCall
	return &Options{
		Hubs: []string{"http://127.0.0.1:3000", "https://nova.fake-tailnet.ts.net"},
		Paths: p, Now: func() time.Time { return time.Unix(1_790_000_000, 0) },
		Verify: func(context.Context, config.Config, ed25519.PrivateKey) error { return verify },
		Enroll: func(_ context.Context, hub, code, name, _ string, _ ed25519.PublicKey) (EnrollResult, error) {
			calls = append(calls, enrollCall{hub, code, name})
			return enroll(hub)
		},
		Name: "laptop",
	}, &calls
}

func okEnroll(repaired bool) func(string) (EnrollResult, error) {
	return func(string) (EnrollResult, error) {
		return EnrollResult{DeviceID: "d-new", Name: "laptop", CorePubKey: strings.Repeat(core, 32), Repaired: repaired}, nil
	}
}

func TestANewMachineWithoutACodeNeedsACode(t *testing.T) {
	o, _ := opts(t, paths(t), nil, okEnroll(false))
	if _, _, err := o.identity(context.Background()); !errors.Is(err, ErrNeedsCode) {
		t.Fatalf("got %v, want ErrNeedsCode", err)
	}
}

func TestANewMachinePairsWithTheCodeAndPinsTheCoreKey(t *testing.T) {
	p := paths(t)
	o, calls := opts(t, p, nil, okEnroll(false))
	o.Code = "ABCD-2345"
	cfg, notes, err := o.identity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0] != (enrollCall{"http://127.0.0.1:3000", "ABCD-2345", "laptop"}) {
		t.Fatalf("enroll calls %+v", *calls)
	}
	back, _, err := config.Load(p)
	if err != nil || back.DeviceID != "d-new" || back.CorePubKey != strings.Repeat(core, 32) ||
		strings.Join(back.Locators, ",") != strings.Join(o.Hubs, ",") || back.Server != "http://127.0.0.1:3000" {
		t.Fatalf("saved %+v, %v", back, err)
	}
	if cfg.DeviceID != "d-new" || !strings.Contains(strings.Join(notes, "\n"), `paired as "laptop"`) {
		t.Fatalf("cfg %+v notes %v", cfg, notes)
	}
}

func TestAPairingAHubStillKnowsIsKeptAndTheCodeLeftUnused(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "https://nova.fake-tailnet.ts.net")
	o, calls := opts(t, p, nil, okEnroll(false))
	o.Code = "ABCD-2345"
	cfg, notes, err := o.identity(context.Background())
	if err != nil || cfg.DeviceID != "d-old" || len(*calls) != 0 {
		t.Fatalf("cfg %+v calls %v err %v", cfg, *calls, err)
	}
	if !strings.Contains(strings.Join(notes, "\n"), "the pairing code was not used") {
		t.Fatalf("notes %v", notes)
	}
}

// Decision 4: a pairing no hub knows is set aside (never deleted) and the
// re-pair code rebinds the machine's row.
func TestAPairingEveryHubDisownsIsSetAsideAndReplacedWithTheCode(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "https://nova.fake-tailnet.ts.net")
	o, calls := opts(t, p, &client.RefusedError{Server: "x", Reason: "revoked"}, okEnroll(true))
	o.Code = "ABCD-2345"
	cfg, notes, err := o.identity(context.Background())
	if err != nil || cfg.DeviceID != "d-new" || len(*calls) != 1 {
		t.Fatalf("cfg %+v calls %v err %v", cfg, *calls, err)
	}
	if _, err := os.Stat(p.ConfigFile + ".replaced-1790000000"); err != nil {
		t.Fatalf("the old pairing was not set aside: %v", err)
	}
	if !strings.Contains(strings.Join(notes, "\n"), "re-paired as \"laptop\" — its name and history kept") {
		t.Fatalf("notes %v", notes)
	}
}

func TestAPairingEveryHubDisownsWithoutACodeNeedsACode(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "https://nova.fake-tailnet.ts.net")
	o, _ := opts(t, p, &client.KeyMismatch{Presented: "x", Pinned: "y"}, okEnroll(false))
	if _, _, err := o.identity(context.Background()); !errors.Is(err, ErrNeedsCode) || !strings.Contains(err.Error(), "no longer knows") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(p.ConfigFile); err != nil {
		t.Fatal("without a code, nothing is set aside")
	}
}

// A hub that did not answer proves nothing about the pairing: it is kept.
func TestAnUnreachableHubKeepsThePairing(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "https://nova.fake-tailnet.ts.net")
	o, calls := opts(t, p, errors.New("dial tcp: connection refused"), okEnroll(false))
	o.Code = "ABCD-2345"
	cfg, notes, err := o.identity(context.Background())
	if err != nil || cfg.DeviceID != "d-old" || len(*calls) != 0 || !strings.Contains(strings.Join(notes, "\n"), "could not reach Nova to check") {
		t.Fatalf("cfg %+v calls %v notes %v err %v", cfg, *calls, notes, err)
	}
}

func TestTheHubsRefusalOfTheCodeIsFinal(t *testing.T) {
	o, calls := opts(t, paths(t), nil, func(string) (EnrollResult, error) {
		return EnrollResult{}, &EnrollRefused{Status: 403, Reason: "that pairing code is not usable"}
	})
	o.Code = "ABCD-2345"
	_, _, err := o.identity(context.Background())
	var refused *EnrollRefused
	if !errors.As(err, &refused) || len(*calls) != 1 {
		t.Fatalf("err %v calls %v — a refusal is the hub's word, never retried on another address", err, *calls)
	}
}

func TestAHubThatDoesNotAnswerFallsThroughToTheNext(t *testing.T) {
	o, calls := opts(t, paths(t), nil, func(hub string) (EnrollResult, error) {
		if strings.HasPrefix(hub, "http://127.0.0.1") {
			return EnrollResult{}, errors.New("connection refused")
		}
		return okEnroll(false)(hub)
	})
	o.Code = "ABCD-2345"
	cfg, _, err := o.identity(context.Background())
	if err != nil || cfg.Server != "https://nova.fake-tailnet.ts.net" || len(*calls) != 2 {
		t.Fatalf("cfg %+v calls %v err %v", cfg, *calls, err)
	}
}

func TestAnOrphanedAuditLogIsSetAsideBeforeAFreshPairing(t *testing.T) {
	p := paths(t)
	if err := os.MkdirAll(p.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.AuditFile, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	o, _ := opts(t, p, nil, okEnroll(false))
	o.Code = "ABCD-2345"
	if _, _, err := o.identity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.AuditFile); err == nil {
		t.Fatal("an old chain would replay under the new device's id")
	}
}

func TestPlainHTTPIsOnlyForThisMachinesLoopback(t *testing.T) {
	if err := checkHubs([]string{"http://127.0.0.1:3000", "http://localhost:3000", "https://nova.fake-tailnet.ts.net"}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"http://nova.example", "http://192.0.2.10:3000", "ftp://nova.example"} {
		if err := checkHubs([]string{bad}); err == nil {
			t.Errorf("%s was accepted — the core link is verified TLS or this machine's loopback (D6)", bad)
		}
	}
}
```

`apps/novad/internal/install/place_test.go`:

```go
package install

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPlaceCopiesTheBinaryAndChecksTheCopy(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "download", "novad")
	_ = os.MkdirAll(filepath.Dir(self), 0o755)
	if err := os.WriteFile(self, []byte("this build"), 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "install", "novad")
	o := &Options{Self: self, InstallDir: filepath.Dir(bin), Now: time.Now}
	sum, err := o.place(bin)
	if err != nil || len(sum) != 64 {
		t.Fatalf("sum %q err %v", sum, err)
	}
	if b, _ := os.ReadFile(bin); string(b) != "this build" {
		t.Fatal("the binary was not copied into place")
	}
	if err := os.WriteFile(self, []byte("a newer build"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := o.place(bin); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(bin); string(b) != "a newer build" {
		t.Fatal("the new build did not replace the old one")
	}
	if old, _ := filepath.Glob(bin + ".old-*"); len(old) != 1 {
		t.Fatalf("the replaced build must be moved aside, not deleted (it may be running): %v", old)
	}
}

func TestPlaceOfTheInstalledBinaryItselfCopiesNothing(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "novad")
	if err := os.WriteFile(bin, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	o := &Options{Self: bin, InstallDir: filepath.Dir(bin), Now: time.Now}
	if _, err := o.place(bin); err != nil {
		t.Fatal(err)
	}
	if old, _ := filepath.Glob(bin + ".*"); len(old) != 0 {
		t.Fatalf("nothing may be moved when it already runs from the install dir: %v", old)
	}
}
```

`apps/novad/internal/install/manifest_test.go`:

```go
package install

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"novad/internal/wire"
)

func signedManifestServer(t *testing.T, signer ed25519.PrivateKey, sum string) string {
	t.Helper()
	manifest := map[string]any{
		"v": 1, "version": "aaaaaaaaaaaa", "built_at": "2026-09-28T12:00:00Z", "go": "go1.27.1",
		"files": map[string]any{runtime.GOOS + "-" + runtime.GOARCH: map[string]any{"name": "novad", "sha256": sum, "size": 10}},
	}
	canon, err := wire.Canonical(manifest)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"manifest": manifest, "sig": hex.EncodeToString(ed25519.Sign(signer, canon))})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/agent/manifest" {
			_, _ = w.Write(body)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestTheManifestSaysWhetherThisIsTheHubsBuild(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	sum := strings.Repeat("c", 64)
	url := signedManifestServer(t, priv, sum)
	if got := CheckManifest(context.Background(), url, hex.EncodeToString(pub), sum); got != "this binary is the hub's build aaaaaaaaaaaa" {
		t.Fatalf("got %q", got)
	}
	if got := CheckManifest(context.Background(), url, hex.EncodeToString(pub), strings.Repeat("d", 64)); !strings.Contains(got, "is not the hub's build aaaaaaaaaaaa") {
		t.Fatalf("got %q", got)
	}
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	if got := CheckManifest(context.Background(), url, hex.EncodeToString(otherPub), sum); !strings.Contains(got, "not trusted") {
		t.Fatalf("a manifest another key signed must never be believed: %q", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/novad && ~/.local/bin/mise x -- go test ./internal/install/ 2>&1 | tail -5`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: `client.RefusedError`**

In `internal/client/verify.go`, add the type and return it from the `auth_error` branch (the words are unchanged, so `repoint`'s tests keep passing):

```go
// RefusedError is VerifyServer's answer when a server holds the pinned core
// key but refused this device — revoked, or a database that no longer knows
// it. install reads it as "this pairing is dead" (S42b).
type RefusedError struct{ Server, Reason string }

func (e *RefusedError) Error() string {
	return fmt.Sprintf("%s holds the core key you pinned, but it refused this device: %s", e.Server, e.Reason)
}
```

```go
	case wire.TypeAuthError:
		reason, _ := reply["reason"].(string)
		if reason == "" {
			reason = "no reason given"
		}
		return &RefusedError{Server: wsURL, Reason: reason}
```

- [ ] **Step 4: Implement `internal/install` (this task's half)**

`apps/novad/internal/install/enroll.go`:

```go
// Package install is `novad install` and `novad uninstall` (S42b): one
// command that pairs — or keeps, or re-pairs — this machine, puts the binary
// in the user's own folder, registers the service and PROVES the agent came
// up. A registration alone is never reported as installed.
package install

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// EnrollResult is core's answer to a pairing (the response of POST /enroll).
type EnrollResult struct {
	DeviceID   string `json:"device_id"`
	Name       string `json:"name"`
	CorePubKey string `json:"core_pubkey"`
	Repaired   bool   `json:"repaired"`
}

// EnrollRefused is the hub's own refusal — a spent code, a name taken. The
// hub answered, so its words are final: no other address is tried.
type EnrollRefused struct {
	Status int
	Reason string
}

func (e *EnrollRefused) Error() string { return fmt.Sprintf("enrollment refused (%d): %s", e.Status, e.Reason) }

// Body is the enroll payload: the five keys main_test pins, and nothing else
// — core has no per-device settings to seed.
func Body(code, pubkeyHex, name, hostname string) ([]byte, error) {
	return json.Marshal(map[string]string{
		"code": code, "pubkey": pubkeyHex, "name": name, "platform": runtime.GOOS, "hostname": hostname,
	})
}

// Enroll spends code at hub to bind pub to this machine.
func Enroll(ctx context.Context, hub, code, name, hostname string, pub ed25519.PublicKey) (EnrollResult, error) {
	body, err := Body(code, hex.EncodeToString(pub), name, hostname)
	if err != nil {
		return EnrollResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(hub, "/")+"/api/v1/devices/enroll", bytes.NewReader(body))
	if err != nil {
		return EnrollResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return EnrollResult{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		reason := strings.TrimSpace(string(raw))
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			reason = e.Error
		}
		return EnrollResult{}, &EnrollRefused{Status: resp.StatusCode, Reason: reason}
	}
	var res EnrollResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return EnrollResult{}, fmt.Errorf("the enrollment answer was unreadable: %w", err)
	}
	if res.DeviceID == "" || res.CorePubKey == "" {
		return EnrollResult{}, errors.New("the enrollment answer names no device or no core key")
	}
	return res, nil
}
```

`apps/novad/internal/install/identity.go`:

```go
package install

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"strings"
	"time"

	"novad/internal/client"
	"novad/internal/config"
	"novad/internal/service"
)

// ErrNeedsCode is install's answer when this machine has no live pairing and
// no code was given: main exits 3, and ./install mints one and asks again.
var ErrNeedsCode = errors.New("a pairing code is needed")

// Options is one install. Zero-valued seams take the real implementations.
type Options struct {
	Hubs         []string
	Code         string
	Name         string
	IfMissing    bool
	RestartLater bool
	Self         string // this binary (os.Executable)
	Version      string
	Paths        config.Paths
	InstallDir   string
	Service      service.Manager
	Now          func() time.Time
	Verify       func(context.Context, config.Config, ed25519.PrivateKey) error
	Enroll       func(ctx context.Context, hub, code, name, hostname string, pub ed25519.PublicKey) (EnrollResult, error)
	InWSL        func() bool
	Alive        func(pid int) bool
	Manifest     func(ctx context.Context, server, corePubHex, sum string) string
	WaitReady    time.Duration
	PollEvery    time.Duration
	Out          io.Writer
}

// checkHubs holds each address to D6: verified TLS, or plain http only to
// this machine's own loopback.
func checkHubs(hubs []string) error {
	for _, h := range hubs {
		u, err := url.Parse(h)
		if err != nil {
			return fmt.Errorf("%q is not an address: %w", h, err)
		}
		switch u.Scheme {
		case "https":
		case "http":
			host := u.Hostname()
			if host != "127.0.0.1" && host != "localhost" && host != "::1" {
				return fmt.Errorf("%s must be https — plain http is only for this machine's own loopback", h)
			}
		default:
			return fmt.Errorf("%s must be an https address (or http to this machine's loopback)", h)
		}
	}
	return nil
}

type verdict int

const (
	alive verdict = iota
	dead
	unreachable
)

// check asks each hub whether it still knows this pairing. Dead only when
// EVERY hub answered and none knew it; one that did not answer proves nothing.
func (o *Options) check(ctx context.Context, cfg config.Config, priv ed25519.PrivateKey, hubs []string) (verdict, string, string) {
	var reasons []string
	answered := 0
	for _, hub := range hubs {
		c := cfg
		c.Server = hub
		err := o.Verify(ctx, c, priv)
		if err == nil {
			return alive, hub, ""
		}
		var km *client.KeyMismatch
		var rf *client.RefusedError
		if errors.As(err, &km) || errors.As(err, &rf) {
			answered++
		}
		reasons = append(reasons, fmt.Sprintf("%s: %v", hub, err))
	}
	if answered == len(hubs) {
		return dead, "", strings.Join(reasons, "; ")
	}
	return unreachable, "", strings.Join(reasons, "; ")
}

func isEnrolled(p config.Paths) (bool, error) {
	for _, f := range []string{p.ConfigFile, p.KeyFile} {
		if _, err := os.Lstat(f); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return false, nil
			}
			return false, err
		}
	}
	return true, nil
}

// identity is the pairing to run under: the existing one when a hub knows it
// (a code given is left unused), a fresh one from the code when there is none
// or every hub disowned it (that one is set aside, never deleted), else
// ErrNeedsCode. The notes say which, for the report.
func (o *Options) identity(ctx context.Context) (config.Config, []string, error) {
	var notes []string
	ok, err := isEnrolled(o.Paths)
	if err != nil {
		return config.Config{}, nil, err
	}
	hubs := o.Hubs
	if ok {
		cfg, priv, err := config.Load(o.Paths)
		if err != nil {
			return config.Config{}, nil, err
		}
		if len(hubs) == 0 {
			hubs = cfg.Hubs()
		}
		v, hub, reason := o.check(ctx, cfg, priv, hubs)
		switch v {
		case alive, unreachable:
			cfg.Locators = hubs
			if v == alive {
				cfg.Server = hub
				notes = append(notes, fmt.Sprintf("kept this machine's pairing as %q", cfg.Name))
				if o.Code != "" {
					notes = append(notes, "the pairing code was not used (it expires unused)")
				}
			} else {
				notes = append(notes, "could not reach Nova to check this pairing ("+reason+"); kept it")
			}
			if err := config.Save(o.Paths, cfg, priv); err != nil {
				return config.Config{}, nil, err
			}
			return cfg, notes, nil
		}
		if o.Code == "" {
			return config.Config{}, nil, fmt.Errorf("%w: Nova no longer knows this machine's pairing (%s)", ErrNeedsCode, reason)
		}
		moved, err := config.SetAside(o.Paths, o.Now(), "replaced")
		if err != nil {
			return config.Config{}, nil, fmt.Errorf("setting the old pairing aside: %w", err)
		}
		notes = append(notes, fmt.Sprintf("set the old pairing aside (%s) — Nova no longer knew it", strings.Join(moved, ", ")))
	} else {
		if o.Code == "" {
			return config.Config{}, nil, fmt.Errorf("%w: this machine is not paired", ErrNeedsCode)
		}
		// An audit log with no pairing is an older identity's chain: it would
		// replay under the new device's id. Set it aside first.
		if _, err := os.Lstat(o.Paths.AuditFile); err == nil {
			if moved, err := config.SetAside(o.Paths, o.Now(), "orphaned"); err == nil && len(moved) > 0 {
				notes = append(notes, "set an old audit log aside ("+strings.Join(moved, ", ")+")")
			}
		}
	}
	if len(hubs) == 0 {
		return config.Config{}, nil, errors.New("install needs --hub <Nova's address> to pair (the card's command has it)")
	}
	cfg, note, err := o.pair(ctx, hubs)
	if err != nil {
		return config.Config{}, notes, err
	}
	return cfg, append(notes, note), nil
}

func (o *Options) pair(ctx context.Context, hubs []string) (config.Config, string, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return config.Config{}, "", err
	}
	host, _ := os.Hostname()
	name := o.Name
	if name == "" {
		name = host
	}
	var lastErr error
	for _, hub := range hubs {
		res, err := o.Enroll(ctx, hub, o.Code, name, host, pub)
		var refused *EnrollRefused
		if errors.As(err, &refused) {
			return config.Config{}, "", err
		}
		if err != nil {
			lastErr = err
			continue
		}
		cfg := config.Config{DeviceID: res.DeviceID, Name: res.Name, Server: hub, CorePubKey: res.CorePubKey, Locators: hubs}
		if err := config.Save(o.Paths, cfg, priv); err != nil {
			return config.Config{}, "", fmt.Errorf("saving the pairing: %w", err)
		}
		if res.Repaired {
			return cfg, fmt.Sprintf("re-paired as %q — its name and history kept", res.Name), nil
		}
		return cfg, fmt.Sprintf("paired as %q", res.Name), nil
	}
	return config.Config{}, "", fmt.Errorf("could not reach Nova to pair: %w", lastErr)
}
```

`apps/novad/internal/install/place.go`:

```go
package install

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// place copies this binary to bin, checks the copy's sha256, and moves any
// build already there aside (it may be running; a rename is always allowed).
// It returns the sha256. Nothing is copied when this binary IS bin.
func (o *Options) place(bin string) (string, error) {
	sum, err := fileSHA256(o.Self)
	if err != nil {
		return "", fmt.Errorf("reading this binary: %w", err)
	}
	if same, _ := samePath(o.Self, bin); same {
		return sum, nil
	}
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		return "", err
	}
	tmp := bin + ".installing"
	if err := copyFile(o.Self, tmp); err != nil {
		return "", err
	}
	if got, err := fileSHA256(tmp); err != nil || got != sum {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("the copy at %s does not match this binary (sha256 %s, want %s)", tmp, got, sum)
	}
	if _, err := os.Lstat(bin); err == nil {
		if err := os.Rename(bin, fmt.Sprintf("%s.old-%d", bin, o.Now().UnixNano())); err != nil {
			_ = os.Remove(tmp)
			return "", fmt.Errorf("moving the installed build aside: %w", err)
		}
	}
	if err := os.Rename(tmp, bin); err != nil {
		return "", err
	}
	return sum, nil
}

func samePath(a, b string) (bool, error) {
	ea, err := filepath.EvalSymlinks(a)
	if err != nil {
		return false, err
	}
	eb, err := filepath.EvalSymlinks(b)
	if err != nil {
		return false, err
	}
	return filepath.Clean(ea) == filepath.Clean(eb), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
```

`apps/novad/internal/install/manifest.go`:

```go
package install

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"

	"novad/internal/wire"
)

// CheckManifest reads the hub's signed manifest and says whether sum is the
// hub's build for this OS — the manifest signature's S42b reader (P19). One
// whose signature does not verify against the pinned key is reported as not
// trusted and never used.
func CheckManifest(ctx context.Context, server, corePubHex, sum string) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(server, "/")+"/api/v1/agent/manifest", nil)
	if err != nil {
		return "could not read the hub's manifest: " + err.Error()
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "could not read the hub's manifest: " + err.Error()
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("the hub has no agent build to compare with (%s)", resp.Status)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var body map[string]any
	if err := dec.Decode(&body); err != nil {
		return "the hub's manifest is unreadable"
	}
	manifest, _ := body["manifest"].(map[string]any)
	sigHex, _ := body["sig"].(string)
	canon, cerr := wire.Canonical(manifest)
	sig, serr := hex.DecodeString(sigHex)
	pub, perr := hex.DecodeString(corePubHex)
	if manifest == nil || cerr != nil || serr != nil || perr != nil || len(pub) != ed25519.PublicKeySize ||
		!ed25519.Verify(ed25519.PublicKey(pub), canon, sig) {
		return "the hub's manifest did not verify against the pinned core key — not trusted"
	}
	version, _ := manifest["version"].(string)
	files, _ := manifest["files"].(map[string]any)
	entry, _ := files[runtime.GOOS+"-"+runtime.GOARCH].(map[string]any)
	if want, _ := entry["sha256"].(string); want == sum {
		return "this binary is the hub's build " + version
	}
	return fmt.Sprintf("this binary is not the hub's build %s — Nova updates it when this machine is idle", version)
}
```

In `main.go`: `cmdEnroll` keeps its flags and messages but its HTTP part becomes `res, err := install.Enroll(context.Background(), *server, *code, devName, hostname, pub)` (an `*install.EnrollRefused` prints `enrollment refused (<status>): <reason>` as before), and `enrollBody` becomes `func enrollBody(code, pubkeyHex, name, hostname string) ([]byte, error) { return install.Body(code, pubkeyHex, name, hostname) }` so the S42a pin stays where it is.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -12
for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done
```

Expected: all `ok` — including `TestEnrollBodyCarriesIdentityOnly` and every `repoint` test; vet silent.

- [ ] **Step 6: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/novad/internal/install apps/novad/internal/client/verify.go apps/novad/main.go
git -C $W commit -m "feat(novad): install's identity — keep a pairing a hub knows, re-pair one none does, and say which"
git -C $W show --stat HEAD | tail -5
```

---

## Task 12: `novad install` and `uninstall` — start the service and prove it came up

**Files:**
- Create: `apps/novad/internal/install/install.go`, `uninstall.go`, `install_test.go`
- Create: `apps/novad/internal/platform/install_linux.go`, `install_darwin.go`, `install_windows.go`, `install_dirs_test.go`
- Create: `apps/novad/install.go` (package main: `cmdInstall`, `cmdUninstall`, `installExit`)
- Modify: `apps/novad/main.go` (the verbs, the usage, `cmdRun` writes a lock refusal into its status), `apps/novad/main_test.go`

**Interfaces:**
- Consumes: Task 11 (`identity`, `place`, `CheckManifest`, `checkHubs`), Task 8 (`service.Manager`), Task 5 (`state`).
- Produces:
  - `install.Install(ctx, Options) error` (nil only after `ready` from an agent of this version, or after a scheduled restart with `RestartLater`); `install.Uninstall(ctx, UninstallOptions) error`; `type UninstallOptions{Paths config.Paths; InstallDir string; Service service.Manager; Forget bool; Now func() time.Time; Out io.Writer}`.
  - `platform.BinaryName`, `platform.InstallDir() (string, error)`, `platform.AdminInstallDir() string` (P1; the S42c seam).
  - `novad install [--hub URL]... [--code C] [--name N] [--if-missing] [--restart-later]` — exit 0, 1, or 3 (`installExit`); `NOVA_PAIRING_CODE` is read when `--code` is absent. `novad uninstall [--forget]`.

- [ ] **Step 1: Write the failing tests**

`apps/novad/internal/install/install_test.go`:

```go
package install

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"novad/internal/config"
	"novad/internal/state"
)

type fakeService struct {
	installed string
	restarts  int
	later     bool
	onRestart func()
}

func (f *fakeService) Mode() string                                 { return "systemd-user" }
func (f *fakeService) Describe() string                             { return "a fake service" }
func (f *fakeService) Installed() bool                              { return f.installed != "" }
func (f *fakeService) Install(bin string) error                     { f.installed = bin; return nil }
func (f *fakeService) RestartLater(context.Context, time.Duration) error { f.later = true; return nil }
func (f *fakeService) Stop(context.Context) error                   { return nil }
func (f *fakeService) Uninstall(context.Context) error              { f.installed = ""; return nil }
func (f *fakeService) BootStart(context.Context) (bool, string, error) {
	return true, "starts at boot (linger is on)", nil
}
func (f *fakeService) Restart(context.Context) error {
	f.restarts++
	if f.onRestart != nil {
		f.onRestart()
	}
	return nil
}

// agentCameUp writes what a new supervisor and its agent write once core
// accepted the handshake.
func agentCameUp(p config.Paths, version string, st string, errText string) func() {
	return func() {
		now := time.Now().UTC()
		_ = state.WriteJSON(filepath.Join(p.StateDir, state.SupervisorStatusFile), state.SupervisorStatus{V: 1, PID: 500, ChildPID: 501, Since: now})
		_ = state.WriteJSON(filepath.Join(p.StateDir, state.AgentStatusFile), state.AgentStatus{
			V: 1, PID: 501, Version: version, State: st, Server: "http://127.0.0.1:3000", Since: now, Error: errText})
	}
}

func installOpts(t *testing.T) (*Options, *fakeService, *bytes.Buffer) {
	t.Helper()
	p := paths(t)
	enrolled(t, p, "http://127.0.0.1:3000")
	self := filepath.Join(t.TempDir(), "novad")
	if err := os.WriteFile(self, []byte("build"), 0o755); err != nil {
		t.Fatal(err)
	}
	svc := &fakeService{}
	var out bytes.Buffer
	return &Options{
		Hubs: []string{"http://127.0.0.1:3000"}, Self: self, Version: "aaaaaaaaaaaa", Paths: p,
		InstallDir: filepath.Join(t.TempDir(), "bin"), Service: svc, Out: &out,
		Verify:    func(context.Context, config.Config, ed25519.PrivateKey) error { return nil },
		InWSL:     func() bool { return false },
		Manifest:  func(context.Context, string, string, string) string { return "this binary is the hub's build aaaaaaaaaaaa" },
		WaitReady: 300 * time.Millisecond, PollEvery: 10 * time.Millisecond,
	}, svc, &out
}

func TestInstallSucceedsOnlyWhenTheNewAgentReportsReady(t *testing.T) {
	o, svc, out := installOpts(t)
	svc.onRestart = agentCameUp(o.Paths, "aaaaaaaaaaaa", state.StateReady, "")
	if err := Install(context.Background(), *o); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"installed:  " + filepath.Join(o.InstallDir, "novad"), "starts:     a fake service; starts at boot (linger is on)",
		`running:    connected to http://127.0.0.1:3000 as "laptop"`} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}
	if svc.installed != filepath.Join(o.InstallDir, "novad") || svc.restarts != 1 {
		t.Fatalf("service %+v", svc)
	}
}

func TestInstallFailsWhenTheAgentNeverReportsReady(t *testing.T) {
	o, _, out := installOpts(t)
	err := Install(context.Background(), *o)
	if err == nil || !strings.Contains(err.Error(), "did not connect within") || !strings.Contains(err.Error(), "has not written a status") {
		t.Fatalf("got %v", err)
	}
	if strings.Contains(out.String(), "running:") {
		t.Fatal("a registration alone must never be reported as running")
	}
}

// Review focus 4: a copy started by hand holds the identity — say whose.
func TestInstallNamesAnotherCopyHoldingTheIdentity(t *testing.T) {
	o, svc, _ := installOpts(t)
	svc.onRestart = agentCameUp(o.Paths, "aaaaaaaaaaaa", state.StateStopped, "another novad (pid 77) holds /x/run.lock")
	err := Install(context.Background(), *o)
	if err == nil || !strings.Contains(err.Error(), "pid 77") {
		t.Fatalf("got %v", err)
	}
}

func TestAnOldBuildReportingReadyIsNotThisInstall(t *testing.T) {
	o, svc, _ := installOpts(t)
	svc.onRestart = agentCameUp(o.Paths, "000000000000", state.StateReady, "")
	if err := Install(context.Background(), *o); err == nil {
		t.Fatal("ready from another build must not count as this install coming up")
	}
}

func TestInstallRefusesInsideWSL(t *testing.T) {
	o, _, _ := installOpts(t)
	o.InWSL = func() bool { return true }
	if err := Install(context.Background(), *o); err == nil || !strings.HasPrefix(err.Error(), "cannot: on Windows") {
		t.Fatalf("got %v", err)
	}
}

func TestIfMissingLeavesARunningAgentAlone(t *testing.T) {
	o, svc, out := installOpts(t)
	bin := filepath.Join(o.InstallDir, "novad")
	_ = os.MkdirAll(o.InstallDir, 0o755)
	_ = os.WriteFile(bin, []byte("running build"), 0o755)
	svc.installed = bin
	now := time.Now().UTC()
	_ = state.WriteJSON(filepath.Join(o.Paths.StateDir, state.SupervisorStatusFile), state.SupervisorStatus{V: 1, PID: os.Getpid(), ChildPID: os.Getpid(), Since: now})
	_ = state.WriteJSON(filepath.Join(o.Paths.StateDir, state.AgentStatusFile), state.AgentStatus{V: 1, PID: os.Getpid(), Version: "000000000000", State: state.StateReady, Since: now})
	o.IfMissing = true
	if err := Install(context.Background(), *o); err != nil {
		t.Fatal(err)
	}
	if svc.restarts != 0 || !strings.Contains(out.String(), "left as it is") {
		t.Fatalf("restarts %d out %s", svc.restarts, out.String())
	}
	if b, _ := os.ReadFile(bin); string(b) != "running build" {
		t.Fatal("--if-missing replaced a running agent's binary")
	}
}

func TestRestartLaterSchedulesTheRestartAndDoesNotClaimIt(t *testing.T) {
	o, svc, out := installOpts(t)
	o.RestartLater = true
	if err := Install(context.Background(), *o); err != nil {
		t.Fatal(err)
	}
	if !svc.later || svc.restarts != 0 || !strings.Contains(out.String(), "confirmed only when the agent reconnects") {
		t.Fatalf("later %v restarts %d out %s", svc.later, svc.restarts, out.String())
	}
}

func TestUninstallRemovesTheServiceAndBinaryAndKeepsTheIdentity(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "http://127.0.0.1:3000")
	dir := t.TempDir()
	bin := filepath.Join(dir, "novad")
	_ = os.WriteFile(bin, []byte("x"), 0o755)
	_ = os.WriteFile(bin+".prev", []byte("y"), 0o755)
	svc := &fakeService{installed: bin}
	var out bytes.Buffer
	if err := Uninstall(context.Background(), UninstallOptions{Paths: p, InstallDir: dir, Service: svc, Now: time.Now, Out: &out}); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{bin, bin + ".prev"} {
		if _, err := os.Stat(f); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s is still there", f)
		}
	}
	if svc.Installed() {
		t.Fatal("the service is still registered")
	}
	if _, err := os.Stat(p.ConfigFile); err != nil {
		t.Fatal("uninstall keeps the pairing unless --forget")
	}
	if !strings.Contains(out.String(), `Nova still lists "laptop" as paired`) || !strings.Contains(out.String(), "Settings → Devices") {
		t.Fatalf("out:\n%s", out.String())
	}
}

func TestUninstallForgetSetsThePairingAside(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "http://127.0.0.1:3000")
	var out bytes.Buffer
	if err := Uninstall(context.Background(), UninstallOptions{Paths: p, InstallDir: t.TempDir(), Service: &fakeService{}, Forget: true, Now: time.Now, Out: &out}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.ConfigFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("--forget must set the pairing aside")
	}
}
```

`apps/novad/internal/platform/install_dirs_test.go`:

```go
package platform

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// P1: the user's own folder, and the admin-only copy S42c's helper will run.
func TestTheInstallDirsAreTheOwnersChoice(t *testing.T) {
	dir, err := InstallDir()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"linux":   filepath.Join(".local", "bin"),
		"darwin":  filepath.Join("Library", "Application Support", "Nova"),
		"windows": filepath.Join("Programs", "Nova"),
	}[runtime.GOOS]
	if !strings.HasSuffix(dir, want) {
		t.Fatalf("InstallDir = %q, want …%s", dir, want)
	}
	admin := map[string]string{
		"linux":   "/usr/local/libexec/nova",
		"darwin":  "/Library/Application Support/Nova",
		"windows": filepath.Join("Nova"),
	}[runtime.GOOS]
	if !strings.HasSuffix(AdminInstallDir(), admin) {
		t.Fatalf("AdminInstallDir = %q, want …%s", AdminInstallDir(), admin)
	}
}
```

Append to `main_test.go`:

```go
func TestInstallExitCodes(t *testing.T) {
	if installExit(nil) != 0 || installExit(fmt.Errorf("x: %w", install.ErrNeedsCode)) != 3 || installExit(errors.New("boom")) != 1 {
		t.Fatal("install exits 0, 3 (a code is needed) or 1")
	}
}
```

(imports: `fmt`, `novad/internal/install`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/novad && ~/.local/bin/mise x -- go test ./internal/install/ ./internal/platform/ . 2>&1 | tail -6`
Expected: FAIL — `undefined: Install`, `undefined: InstallDir`, `undefined: installExit`.

- [ ] **Step 3: The install dirs**

`internal/platform/install_linux.go`:

```go
package platform

import (
	"os"
	"path/filepath"
)

// BinaryName is the agent's file name on this OS.
const BinaryName = "novad"

// InstallDir is where `novad install` puts the agent (P1): the user's own
// ~/.local/bin, which systemd's file-hierarchy names for user programs.
func InstallDir() (string, error) {
	home, err := os.UserHomeDir()
	return filepath.Join(home, ".local", "bin"), err
}

// AdminInstallDir is the admin-only copy S42c's helper will run (P1): a
// LocalSystem or root service must run a binary only an admin can write.
// Declared here so S42c finds it; S42b installs nothing there.
func AdminInstallDir() string { return "/usr/local/libexec/nova" }
```

`internal/platform/install_darwin.go`:

```go
package platform

import (
	"os"
	"path/filepath"
)

const BinaryName = "novad"

// InstallDir is ~/Library/Application Support/Nova (P1: the macOS equivalent
// of %LocalAppData%\Programs).
func InstallDir() (string, error) {
	home, err := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support", "Nova"), err
}

// AdminInstallDir is S42c's admin-only copy (not installed by S42b).
func AdminInstallDir() string { return "/Library/Application Support/Nova" }
```

`internal/platform/install_windows.go`:

```go
package platform

import (
	"os"
	"path/filepath"
)

const BinaryName = "novad.exe"

// InstallDir is %LocalAppData%\Programs\Nova (P1): where per-user Windows
// programs live, and never roams.
func InstallDir() (string, error) {
	local, err := os.UserCacheDir()
	return filepath.Join(local, "Programs", "Nova"), err
}

// AdminInstallDir is %ProgramFiles%\Nova — S42c's admin-only copy.
func AdminInstallDir() string {
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return filepath.Join(pf, "Nova")
}
```

- [ ] **Step 4: `Install` and `Uninstall`**

`apps/novad/internal/install/install.go`:

```go
package install

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"novad/internal/client"
	"novad/internal/config"
	"novad/internal/platform"
	"novad/internal/state"
)

func (o *Options) defaults() {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Verify == nil {
		o.Verify = client.VerifyServer
	}
	if o.Enroll == nil {
		o.Enroll = Enroll
	}
	if o.InWSL == nil {
		o.InWSL = func() bool { in, _ := platform.WSL(); return in }
	}
	if o.Alive == nil {
		o.Alive = platform.ProcessAlive
	}
	if o.Manifest == nil {
		o.Manifest = CheckManifest
	}
	if o.WaitReady == 0 {
		o.WaitReady = 60 * time.Second
	}
	if o.PollEvery == 0 {
		o.PollEvery = 500 * time.Millisecond
	}
	if o.Out == nil {
		o.Out = os.Stdout
	}
}

// Install pairs (or keeps, or re-pairs), places the binary, registers the
// service, starts it and waits for the new agent to say it connected. It
// returns nil only then — or, with RestartLater, once the restart is
// scheduled, saying plainly that nothing is confirmed yet.
func Install(ctx context.Context, o Options) error {
	o.defaults()
	if o.InWSL() {
		return errors.New("cannot: on Windows, Nova's agent runs on Windows itself; run the Windows command in PowerShell, not this one inside WSL")
	}
	if err := checkHubs(o.Hubs); err != nil {
		return err
	}
	bin := filepath.Join(o.InstallDir, platform.BinaryName)
	if o.IfMissing && o.running(bin) {
		fmt.Fprintf(o.Out, "Nova's agent is installed and running (%s); left as it is — Nova keeps it on the hub's build\n", bin)
		return nil
	}
	cfg, notes, err := o.identity(ctx)
	if err != nil {
		return err
	}
	sum, err := o.place(bin)
	if err != nil {
		return err
	}
	if err := o.Service.Install(bin); err != nil {
		return fmt.Errorf("registering %s: %w", o.Service.Describe(), err)
	}
	if o.RestartLater {
		if err := o.Service.RestartLater(ctx, 5*time.Second); err != nil {
			return fmt.Errorf("scheduling the restart: %w", err)
		}
		fmt.Fprintf(o.Out, "installed %s (build %s, sha256 %s…)\nthe service restarts into it in 5 s; this is confirmed only when the agent reconnects reporting %s\n",
			bin, o.Version, sum[:12], o.Version)
		return nil
	}
	started := o.Now()
	if err := o.Service.Restart(ctx); err != nil {
		return fmt.Errorf("starting %s: %w", o.Service.Describe(), err)
	}
	_, bootNote, bootErr := o.Service.BootStart(ctx)
	st, err := o.awaitReady(ctx, started)
	if err != nil {
		return err
	}
	build := o.Manifest(ctx, st.Server, cfg.CorePubKey, sum)
	o.report(bin, sum, cfg, st, bootNote, bootErr, notes, build)
	return nil
}

// running is --if-missing's test: the service is registered, and its
// supervisor and that supervisor's agent are alive and connected.
func (o *Options) running(bin string) bool {
	if !o.Service.Installed() {
		return false
	}
	if _, err := os.Stat(bin); err != nil {
		return false
	}
	var sv state.SupervisorStatus
	var ag state.AgentStatus
	if state.ReadJSON(filepath.Join(o.Paths.StateDir, state.SupervisorStatusFile), &sv) != nil ||
		state.ReadJSON(filepath.Join(o.Paths.StateDir, state.AgentStatusFile), &ag) != nil {
		return false
	}
	return ag.State == state.StateReady && ag.PID == sv.ChildPID && o.Alive(sv.PID) && o.Alive(ag.PID)
}

// awaitReady waits for an agent the restarted supervisor started to write
// "ready" as this version. Anything else — no status, an old build's ready,
// a lock held by a hand-started copy — is a failure with its reason.
func (o *Options) awaitReady(ctx context.Context, started time.Time) (state.AgentStatus, error) {
	agentPath := filepath.Join(o.Paths.StateDir, state.AgentStatusFile)
	supPath := filepath.Join(o.Paths.StateDir, state.SupervisorStatusFile)
	fresh := func(t time.Time) bool { return !t.Before(started.Add(-time.Second)) }
	deadline := o.Now().Add(o.WaitReady)
	var last state.AgentStatus
	for {
		var ag state.AgentStatus
		if state.ReadJSON(agentPath, &ag) == nil && fresh(ag.Since) {
			last = ag
			var sv state.SupervisorStatus
			if ag.State == state.StateReady && ag.Version == o.Version &&
				state.ReadJSON(supPath, &sv) == nil && fresh(sv.Since) && ag.PID == sv.ChildPID {
				return ag, nil
			}
		}
		if !o.Now().Before(deadline) {
			why := "it has not written a status"
			if last.PID != 0 {
				why = fmt.Sprintf("it last said %q", last.State)
				if last.Version != o.Version {
					why += " as build " + last.Version
				}
				if last.Error != "" {
					why += ": " + last.Error
				}
			}
			return last, fmt.Errorf("installed and started, but the agent did not connect within %s — %s", o.WaitReady, why)
		}
		select {
		case <-ctx.Done():
			return last, ctx.Err()
		case <-time.After(o.PollEvery):
		}
	}
}

func (o *Options) report(bin, sum string, cfg config.Config, st state.AgentStatus, bootNote string, bootErr error, notes []string, build string) {
	w := o.Out
	fmt.Fprintf(w, "installed:  %s (build %s, sha256 %s…)\n", bin, o.Version, sum[:12])
	starts := o.Service.Describe()
	switch {
	case bootErr != nil:
		starts += "; whether it starts at boot could not be read: " + bootErr.Error()
	case bootNote != "":
		starts += "; " + bootNote
	}
	fmt.Fprintf(w, "starts:     %s\n", starts)
	fmt.Fprintf(w, "running:    connected to %s as %q since %s (pid %d)\n", st.Server, cfg.Name, st.Since.UTC().Format(time.RFC3339), st.PID)
	if build != "" {
		fmt.Fprintf(w, "build:      %s\n", build)
	}
	for _, n := range notes {
		fmt.Fprintf(w, "note:       %s\n", n)
	}
}
```

`apps/novad/internal/install/uninstall.go`:

```go
package install

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"novad/internal/config"
	"novad/internal/platform"
	"novad/internal/service"
)

// UninstallOptions is one uninstall.
type UninstallOptions struct {
	Paths      config.Paths
	InstallDir string
	Service    service.Manager
	Forget     bool
	Now        func() time.Time
	Out        io.Writer
}

// Uninstall stops and removes the service and the binaries. The pairing is
// kept (a reinstall reuses it) unless Forget sets it aside. It never claims
// the device is unpaired: that is a revoke, in Settings → Devices (P21).
func Uninstall(ctx context.Context, o UninstallOptions) error {
	var errs []error
	if err := o.Service.Uninstall(ctx); err != nil {
		errs = append(errs, fmt.Errorf("removing the service: %w", err))
	}
	bin := filepath.Join(o.InstallDir, platform.BinaryName)
	for _, f := range []string{bin, bin + ".prev", bin + ".new", bin + ".failed"} {
		if err := os.Remove(f); err != nil && !errors.Is(err, fs.ErrNotExist) {
			aside := fmt.Sprintf("%s.old-%d", f, o.Now().UnixNano())
			if rerr := os.Rename(f, aside); rerr != nil {
				errs = append(errs, fmt.Errorf("%s is still there: %v", f, err))
			} else {
				fmt.Fprintf(o.Out, "%s is in use; moved aside as %s — delete it once nothing runs it\n", f, aside)
			}
		}
	}
	name := "this machine"
	if cfg, _, err := config.Load(o.Paths); err == nil {
		name = fmt.Sprintf("%q", cfg.Name)
	}
	if o.Forget {
		moved, err := config.SetAside(o.Paths, o.Now(), "forgotten")
		if err != nil {
			errs = append(errs, fmt.Errorf("setting the pairing aside: %w", err))
		} else if len(moved) > 0 {
			fmt.Fprintf(o.Out, "the pairing on this machine is set aside (%s)\n", strings.Join(moved, ", "))
		}
	}
	fmt.Fprintf(o.Out, "Nova still lists %s as paired (offline from now on) — revoke it in Settings → Devices, or run novad install to bring it back\n", name)
	return errors.Join(errs...)
}
```

- [ ] **Step 5: The verbs**

`apps/novad/install.go`:

```go
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"novad/internal/config"
	"novad/internal/install"
	"novad/internal/platform"
	"novad/internal/service"
)

// exitNeedsCode is install's exit when this machine has no live pairing and
// no code was given: ./install mints one and runs install again.
const exitNeedsCode = 3

type hubList []string

func (h *hubList) String() string     { return strings.Join(*h, ",") }
func (h *hubList) Set(v string) error { *h = append(*h, strings.TrimRight(v, "/")); return nil }

func installExit(err error) int {
	switch {
	case err == nil:
		return 0
	case errors.Is(err, install.ErrNeedsCode):
		return exitNeedsCode
	default:
		return 1
	}
}

func cmdInstall(argv []string) {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	var hubs hubList
	fs.Var(&hubs, "hub", "Nova's address; repeat for fallbacks, in order (the card's command gives them)")
	code := fs.String("code", "", "a pairing code — needed only when this machine is not paired (or NOVA_PAIRING_CODE)")
	name := fs.String("name", "", "the machine's name (default: the card's, else the hostname)")
	ifMissing := fs.Bool("if-missing", false, "leave an agent that is installed and running as it is")
	later := fs.Bool("restart-later", false, "schedule the service restart instead of waiting for it (used when Nova installs through the old agent's own hands)")
	_ = fs.Parse(argv)
	c := *code
	if c == "" {
		c = os.Getenv("NOVA_PAIRING_CODE")
	}
	paths, err := config.DefaultPaths()
	if err != nil {
		fail("%v", err)
	}
	self, err := os.Executable()
	if err != nil {
		fail("%v", err)
	}
	dir, err := platform.InstallDir()
	if err != nil {
		fail("%v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	err = install.Install(ctx, install.Options{
		Hubs: hubs, Code: c, Name: *name, IfMissing: *ifMissing, RestartLater: *later,
		Self: self, Version: version, Paths: paths, InstallDir: dir,
		Service: service.New(paths, platform.Exec{}), InWSL: inWSL, Out: os.Stdout,
	})
	if code := installExit(err); code != 0 {
		if code == exitNeedsCode {
			fmt.Fprintf(os.Stderr, "novad: %v — get a code from Settings → Devices (Re-pair on its tile, or Pair a device) and run the card's command\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "novad: %v\n", err)
		}
		os.Exit(code)
	}
}

func cmdUninstall(argv []string) {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	forget := fs.Bool("forget", false, "also set this machine's pairing aside (it is kept by default)")
	_ = fs.Parse(argv)
	paths, err := config.DefaultPaths()
	if err != nil {
		fail("%v", err)
	}
	dir, err := platform.InstallDir()
	if err != nil {
		fail("%v", err)
	}
	if err := install.Uninstall(context.Background(), install.UninstallOptions{
		Paths: paths, InstallDir: dir, Service: service.New(paths, platform.Exec{}), Forget: *forget,
		Now: time.Now, Out: os.Stdout,
	}); err != nil {
		fail("%v", err)
	}
}
```

In `main.go`: the switch gains `case "install": cmdInstall(os.Args[2:])` and `case "uninstall": cmdUninstall(os.Args[2:])`; the usage lists

```
  novad install [--hub <url>]... [--code <code>] [--name <name>] [--if-missing]
  novad uninstall [--forget]
  novad supervise --mode <systemd-user|launch-agent|run-key>
```

and in `cmdRun` the lock refusal is written into the status before failing, so `install` can name the holder:

```go
	lock, err := state.Acquire(filepath.Join(paths.StateDir, state.RunLockFile))
	if err != nil {
		writeStatus(state.StateStopped, "", err)
		fail("%v — this identity is already running; stop that copy first", err)
	}
```

(`writeStatus` is declared before this; move the `logger` and `writeStatus` definitions above the lock.)

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -12
for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done
```

Expected: all `ok`; vet silent.

- [ ] **Step 7: The refusals, from the real binary (controller)**

The mini PC gets its agent only in Task 32 (`./install`); pairing it now would pre-empt the walk. The two refusals need no hub, so they are checked on the built binary:

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/novad
~/.local/bin/mise x -- go build -o /tmp/novad-s42b . 
XDG_CONFIG_HOME=$(mktemp -d) XDG_STATE_HOME=$(mktemp -d) /tmp/novad-s42b install --hub https://nova.example; echo "exit=$?"
/tmp/novad-s42b install --hub http://nova.example; echo "exit=$?"
rm -f /tmp/novad-s42b
```

Expected: the first prints `novad: a pairing code is needed: this machine is not paired — get a code …` and `exit=3` (the empty config dirs make it a new machine); the second prints `… must be https — plain http is only for this machine's own loopback` and `exit=1`. Nothing is written to `~/.local/bin`.

- [ ] **Step 8: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/novad/internal/install apps/novad/internal/platform/install_linux.go apps/novad/internal/platform/install_darwin.go \
  apps/novad/internal/platform/install_windows.go apps/novad/internal/platform/install_dirs_test.go apps/novad/install.go apps/novad/main.go apps/novad/main_test.go
git -C $W commit -m "feat(novad): install and uninstall — the service starts, and install says it did only after the agent connected"
git -C $W show --stat HEAD | tail -5
```

---

## Task 12b (only on P0-20 branch B): a windowless launcher for the Run key

Build this task **only** if Task 1 recorded branch **B** (the owner does not accept the console flash). On branch A, skip it and say so in the close-out.

**Files:**
- Create: `apps/novad/cmd/novadw/main.go` (`//go:build windows`)
- Modify: `apps/novad/internal/service/service.go` (`RunKeyCommand` points at `novadw.exe`), `service_test.go`
- Modify: Task 25's `deploy/agent-dist/build.sh` (two more files), Task 18's `agent_dist.TARGETS` handling, Task 19's Windows one-liner (downloads and verifies both), Task 12's `place` (copies `novadw.exe` beside `novad.exe`)

- [ ] **Step 1: The launcher**

```go
//go:build windows

// Command novadw is the Run key's target on P0-20 branch B: a GUI-subsystem
// program (built with -ldflags -H=windowsgui), so sign-in shows no console
// at all. Its only job is to start novad.exe's supervisor detached.
package main

import (
	"os"
	"path/filepath"

	"novad/internal/config"
	"novad/internal/platform"
	"novad/internal/state"
)

func main() {
	self, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	paths, err := config.DefaultPaths()
	if err != nil {
		os.Exit(1)
	}
	novad := filepath.Join(filepath.Dir(self), "novad.exe")
	if _, err := platform.StartDetached(novad, []string{"supervise", "--mode", "run-key", "--detached"},
		filepath.Join(paths.StateDir, state.LogFile)); err != nil {
		os.Exit(1)
	}
}
```

- [ ] **Step 2: Wire it**

- `RunKeyCommand(bin)` returns `"<dir of bin>\novadw.exe"` (quoted); `TestTheRunKeyValueQuotesAPathWithSpaces` expects `"C:\Users\Jane Doe\AppData\Local\Programs\Nova\novadw.exe"`.
- `build.sh` builds `novadw-windows-{amd64,arm64}.exe` with `-ldflags "-s -w -buildid= -H=windowsgui -X main.version=$tree"` from `./cmd/novadw`; the manifest's `files` gains `windows-amd64-launcher` / `windows-arm64-launcher`; core's `agent_dist.FILE_NAMES` and `PUBLIC_PATHS` gain the two (nine public paths, not seven — update Task 18's pin and say why in the commit).
- The Windows one-liner downloads and checks both files; `install` copies `novadw.exe` beside `novad.exe` (same `place`, a second call).

- [ ] **Step 3: Test, commit**

`CGO_ENABLED=0 GOOS=windows go vet ./cmd/novadw/`; the render test; the Windows-native CI leg. Commit: `feat(novad): a windowless Run-key launcher — P0-20 branch B`.

---
## Task 13: A frame core cannot handle never ends the session (P27)

The controller's note of 2026-09-28: Windows' own `sudo` exited `0x80070005` (2147942405), `device_audit.exit_code` was int4, and the insert's error ended the Dell agent's session — which reconnected, replayed the same entry, and crash-looped. The hotfix (`037_audit_exit_code_bigint.sql`, merged before Task 0) widens the column. This task makes the class impossible: every frame is handled inside its own guard, and an audit entry core cannot store is a stated break.

**Files:**
- Modify: `services/core/app/devices_ws.py` (`_entry_problem`, `ingest_audit`, `_audit_break(reason=)`, the per-frame guard in `serve`, `WebSocketConn.receive`, `UNREADABLE_FRAME`)
- Test: `services/core/tests/test_devices_ws.py`

**Interfaces:**
- Produces: `devices_ws.UNREADABLE_FRAME = "unreadable"`; `ingest_audit(pool, device_id, entries)` returns `{"stored", "break"}` as before and records a `device.audit_break` whose `meta.reason` names the field for an entry it cannot store; `_audit_break(..., reason: str | None = None)`.

- [ ] **Step 1: Write the failing tests**

Append to `services/core/tests/test_devices_ws.py` (add `import json` to its imports):

```python
# -- P27: a frame core cannot handle never ends the session --------------------
#
# 2026-09-28: Windows' sudo exited 0x80070005, the audit insert overflowed an
# int4, and the exception ended the Dell agent's session — which reconnected,
# replayed the same entry, and crash-looped. The hotfix widened the column;
# these pin the class: one test per frame type.


def _chain(*overrides: dict) -> list[dict]:
    """A hash-chained audit batch from seq 0, each entry overridden as given, so
    a value core cannot store sits inside an otherwise valid chain."""
    prev, out = "", []
    for seq, over in enumerate(overrides):
        entry = {"seq": seq, "prev_hash": prev, "ts": 1_790_000_000, "envelope_id": f"e{seq}",
                 "capability": "shell.exec", "summary": "ran, exit 0", "ok": True, "exit_code": 0, **over}
        entry["hash"] = devices_ws.chain_hash(prev, {k: v for k, v in entry.items() if k != "hash"})
        out.append(entry)
        prev = entry["hash"]
    return out


async def _still_up(pool, conn: FakeWSConn, device_id) -> None:
    """A heartbeat after the bad frame lands: the session is still serving."""
    await pool.execute("UPDATE devices SET last_seen = NULL WHERE id = $1", device_id)
    conn.feed({"type": "heartbeat", "ts": int(time.time())})

    async def landed():
        return await pool.fetchval("SELECT last_seen FROM devices WHERE id = $1", device_id) is not None

    await _until(landed)
    assert devices_ws.hub.is_connected(device_id)


async def test_a_uint32_windows_exit_code_is_stored(pool):
    device_id, _device = await _enroll(pool, name="pc", platform="windows")
    got = await devices_ws.ingest_audit(pool, device_id, _chain({"exit_code": 0x80070005}, {"exit_code": 0xFFFFFFFF}))
    assert got == {"stored": 2, "break": None}
    rows = await pool.fetch("SELECT exit_code FROM device_audit WHERE device_id = $1 ORDER BY seq", device_id)
    assert [r["exit_code"] for r in rows] == [0x80070005, 0xFFFFFFFF]


@pytest.mark.parametrize(
    "override,named",
    [
        ({"exit_code": 2**64}, "exit_code"),
        ({"ts": 10**20}, "ts"),
        ({"ok": "yes"}, "ok"),
        ({"summary": "ran\x00"}, "summary"),
    ],
)
async def test_an_audit_entry_core_cannot_store_is_a_stated_break_and_the_session_stays_up(pool, override, named):
    device_id, _device, conn, task = await _connect(pool, name="pc")
    conn.feed({"type": "audit", "entries": _chain({}, override)})
    await _still_up(pool, conn, device_id)
    assert await pool.fetchval("SELECT count(*) FROM device_audit WHERE device_id = $1", device_id) == 1
    event = await pool.fetchrow(
        "SELECT meta FROM governance_events WHERE kind = $1 AND subject_ref = $2",
        governance.DEVICE_AUDIT_BREAK,
        device_id,
    )
    assert event is not None and named in event["meta"]["reason"]
    await _close(conn, task)


async def test_a_result_frame_with_an_absurd_exit_code_does_not_end_the_session(pool):
    device_id, _device, conn, task = await _connect(pool, name="pc")
    conn.feed({"type": "result", "envelope_id": "nobody-waits", "ok": True, "exit_code": 10**30, "output": "", "error": ""})
    await _still_up(pool, conn, device_id)
    await _close(conn, task)


async def test_a_facts_frame_that_cannot_be_handled_does_not_end_the_session(pool, monkeypatch):
    device_id, _device, conn, task = await _connect(pool, name="pc")

    def _boom(frame):
        raise RuntimeError("simulated: a fault in the facts reader")

    monkeypatch.setattr(devices_ws.device_facts, "validate_frame", _boom)
    conn.feed({"type": "facts", "net": {"ifaces": []}})
    await _still_up(pool, conn, device_id)
    await _close(conn, task)


async def test_a_malformed_heartbeat_does_not_end_the_session(pool, monkeypatch):
    device_id, _device, conn, task = await _connect(pool, name="pc")
    real_execute = type(pool).execute
    failed: list[bool] = []

    async def _once(self, query, *args, **kwargs):
        if "SET last_seen = now()" in query and not failed:
            failed.append(True)
            raise asyncpg.DataError("simulated: postgres refused the heartbeat")
        return await real_execute(self, query, *args, **kwargs)

    monkeypatch.setattr(type(pool), "execute", _once)
    conn.feed({"type": "heartbeat", "ts": "not a number"})
    await _still_up(pool, conn, device_id)
    assert failed == [True]
    await _close(conn, task)


async def test_an_unreadable_frame_is_dropped_and_the_session_stays_up(pool):
    device_id, _device, conn, task = await _connect(pool, name="pc")
    conn.feed([1, 2, 3])
    conn.feed({"type": devices_ws.UNREADABLE_FRAME})
    conn.feed({"type": "audit", "entries": [{"seq": "zero"}]})
    await _still_up(pool, conn, device_id)
    await _close(conn, task)


async def test_the_adapter_turns_unparseable_json_into_one_unreadable_frame():
    class _Stub:
        def __init__(self, exc):
            self.exc = exc

        async def receive_json(self):
            raise self.exc

    for exc in (json.JSONDecodeError("bad", "{", 0), RecursionError(), KeyError("text")):
        assert await devices_ws.WebSocketConn(_Stub(exc)).receive() == {"type": devices_ws.UNREADABLE_FRAME}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
cd ~/workspace/nova/.worktrees/s42b/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_devices_ws.py -k "uint32 or cannot_store or absurd or cannot_be_handled or malformed_heartbeat or unreadable" 2>&1 | tail -6
```

Expected: FAIL — `AttributeError: … UNREADABLE_FRAME`, and the session-ending cases time out in `_until` ("condition not met in time"). `test_a_uint32_windows_exit_code_is_stored` PASSES already (the hotfix) — keep it: it is the pin.

- [ ] **Step 3: Implement**

In `devices_ws.py`, beside the close codes:

```python
# P27: a frame that is not readable JSON — or not an object — becomes this one
# marker, which _handle_frame logs and drops. A frame never ends a session.
UNREADABLE_FRAME = "unreadable"

# What an audit entry must be for postgres to store it as sent. The chain hash
# covers exactly what the device sent, so core never repairs an entry: one it
# cannot store is a stated break, and nothing past it is stored.
_BIGINT = (-(2**63), 2**63 - 1)
_TS_RANGE = (0, 253_402_300_799)  # 1970-01-01 .. 9999-12-31T23:59:59Z
_ENTRY_TEXT_MAX = 4096


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _entry_problem(entry: dict) -> str | None:
    """Why this audit entry cannot be stored as sent, or None."""
    seq = entry.get("seq")
    if not _is_int(seq) or not 0 <= seq <= _BIGINT[1]:
        return f"seq {seq!r} is not a non-negative 64-bit integer"
    ts = entry.get("ts")
    if not _is_int(ts) or not _TS_RANGE[0] <= ts <= _TS_RANGE[1]:
        return f"ts {ts!r} is not a time between 1970 and 9999"
    code = entry.get("exit_code")
    if code is not None and (not _is_int(code) or not _BIGINT[0] <= code <= _BIGINT[1]):
        return f"exit_code {code!r} does not fit a 64-bit integer"
    if not isinstance(entry.get("ok"), bool):
        return f"ok {entry.get('ok')!r} is not true or false"
    for key in ("envelope_id", "capability", "summary", "prev_hash", "hash"):
        value = entry.get(key)
        if value is None:
            continue
        if not isinstance(value, str):
            return f"{key} is not text"
        if "\x00" in value:
            return f"{key} contains a NUL byte, which postgres cannot store"
        if len(value) > _ENTRY_TEXT_MAX:
            return f"{key} is longer than {_ENTRY_TEXT_MAX} characters"
    return None
```

`_audit_break` gains `reason: str | None = None`, stored as `meta["reason"]` when given (and its `seq` may be `None`). `ingest_audit` begins:

```python
    device_uuid = _as_uuid(device_id)
    if not all(isinstance(e, dict) and _is_int(e.get("seq")) for e in entries):
        await _audit_break(pool, device_uuid, None, None, "",
                           reason="a replayed batch carried an entry with no integer seq; nothing from it is stored")
        return {"stored": 0, "break": None}
    ordered = sorted(entries, key=lambda e: e["seq"])
```

and, inside the loop, before the prev-hash checks:

```python
        problem = _entry_problem(entry)
        if problem is not None:
            await _audit_break(pool, device_uuid, seq, None, got_prev, reason=f"the entry cannot be stored: {problem}")
            return {"stored": stored, "break": seq}
```

`serve`'s loop handles each frame in its own guard:

```python
            try:
                await _handle_frame(pool, device_id, frame)
            except Exception:  # noqa: BLE001 — P27: one frame never ends a session
                kind = frame.get("type") if isinstance(frame, dict) else type(frame).__name__
                logger.exception(
                    "device %s: a %r frame could not be handled — dropped; the session stays up",
                    device_id,
                    kind,
                )
```

`WebSocketConn.receive`:

```python
    async def receive(self) -> dict:
        try:
            return await self._ws.receive_json()
        except WebSocketDisconnect as exc:
            raise ConnectionClosed() from exc
        except (ValueError, KeyError, RecursionError) as exc:
            # Not JSON, a binary frame, or JSON nested past the recursion
            # limit: one unreadable frame, never the end of the socket (P27).
            logger.warning("a device sent a frame that is not a readable JSON text frame (%s)", type(exc).__name__)
            return {"type": UNREADABLE_FRAME}
```

- [ ] **Step 4: Run the tests to verify they pass, then the whole devices suite**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_devices_ws.py tests/test_devices_e2e.py tests/test_devices.py 2>&1 | tail -3
uv run ruff check app/devices_ws.py tests/test_devices_ws.py && uv run ruff format app/devices_ws.py tests/test_devices_ws.py
```

Expected: all pass; ruff clean.

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/devices_ws.py services/core/tests/test_devices_ws.py
git -C $W commit -m "fix(core): a frame core cannot handle never ends a device's session — an entry it cannot store is a stated break"
git -C $W show --stat HEAD | tail -4
```

---

## Task 14: Core migration `038_agent_lifecycle` — re-pair, audit epochs, the door, the knocks, the update ledger

**Files:**
- Create: `services/core/migrations/038_agent_lifecycle.sql` (the next free number — see Task 0)
- Create: `services/core/tests/test_migration_038.py`
- Modify: `services/core/tests/conftest.py` (`_TABLES` gains `agent_updates`)

**Interfaces:**
- Produces (columns later tasks read and write):
  - `pairing_codes.device_id uuid NULL → devices(id) ON DELETE CASCADE` (a re-pair code), `pairing_codes.name text NULL`.
  - `devices.audit_epoch integer NOT NULL DEFAULT 0`; `device_audit.epoch integer NOT NULL DEFAULT 0`; `device_audit` primary key `(device_id, epoch, seq)`.
  - `devices.last_transport text CHECK IN ('host','tailnet')` (NULL = neither door could be derived).
  - `devices.last_refused_at timestamptz` (P28).
  - `agent_updates(id, device_id, from_version, version, sha256, path, requested_by, sent_at, outcome, outcome_at, reason)` with one `sent` row at most (P9).

- [ ] **Step 1: Write the failing tests**

`services/core/tests/test_migration_038.py`:

```python
"""Migration 038 (S42b): re-pair codes, audit epochs, the door, a revoked
agent's knocks, and the update ledger — each a column or constraint the slice
reads, pinned here so a later migration cannot quietly drop one."""

from __future__ import annotations

import uuid
from pathlib import Path

import asyncpg
import pytest

from app.main import MIGRATIONS_DIR
from tests.conftest import requires_db

pytestmark = requires_db

MIGRATION = Path(MIGRATIONS_DIR) / "038_agent_lifecycle.sql"


async def _columns(pool, table: str) -> set[str]:
    rows = await pool.fetch(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        table,
    )
    return {r["column_name"] for r in rows}


async def _device(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO devices (name, platform, hostname, pubkey) VALUES ($1, 'linux', 'h', $2) RETURNING id",
        f"m-{uuid.uuid4().hex[:6]}",
        "ab" * 32,
    )


async def test_the_columns_the_slice_reads_exist(pool):
    assert {"device_id", "name"} <= await _columns(pool, "pairing_codes")
    assert {"audit_epoch", "last_transport", "last_refused_at"} <= await _columns(pool, "devices")
    assert "epoch" in await _columns(pool, "device_audit")
    assert {
        "device_id", "from_version", "version", "sha256", "path", "requested_by",
        "sent_at", "outcome", "outcome_at", "reason",
    } <= await _columns(pool, "agent_updates")


async def test_the_door_is_one_of_the_known_doors_or_unknown(pool):
    device = await _device(pool)
    await pool.execute("UPDATE devices SET last_transport = 'host' WHERE id = $1", device)
    await pool.execute("UPDATE devices SET last_transport = NULL WHERE id = $1", device)
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute("UPDATE devices SET last_transport = 'lan' WHERE id = $1", device)


async def test_the_audit_chain_is_keyed_by_epoch(pool):
    cols = await pool.fetch(
        "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) "
        "WHERE i.indrelid = 'device_audit'::regclass AND i.indisprimary"
    )
    assert {c["attname"] for c in cols} == {"device_id", "epoch", "seq"}


async def test_one_update_in_flight_at_a_time(pool):
    a, b = await _device(pool), await _device(pool)
    insert = (
        "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by) "
        "VALUES ($1, 'aaaaaaaaaaaa', $2, 'capability', 'nova')"
    )
    await pool.execute(insert, a, "c" * 64)
    with pytest.raises(asyncpg.UniqueViolationError):
        await pool.execute(insert, b, "c" * 64)
    await pool.execute("UPDATE agent_updates SET outcome = 'confirmed', outcome_at = now() WHERE device_id = $1", a)
    await pool.execute(insert, b, "c" * 64)  # the first is decided: the next may go


async def test_an_open_attempt_has_no_outcome_time_and_a_decided_one_has_one(pool):
    device = await _device(pool)
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by, outcome) "
            "VALUES ($1, 'aaaaaaaaaaaa', $2, 'capability', 'nova', 'confirmed')",
            device,
            "c" * 64,
        )


async def test_the_migration_runs_twice(pool):
    await pool.execute(MIGRATION.read_text(encoding="utf-8"))
```

In `conftest.py`, `_TABLES` gains `"agent_updates",` immediately before `"agents",` (it is a child of `devices`), with the comment `# S42b: agent_updates references devices, so it drops ahead of it.`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_migration_038.py 2>&1 | tail -4`
Expected: FAIL — the columns are missing and `038_agent_lifecycle.sql` does not exist.

- [ ] **Step 3: Write the migration**

`services/core/migrations/038_agent_lifecycle.sql`:

```sql
-- S42b (the hub lane): Nova's agent installs, re-pairs and updates itself.
-- The next free number after the production hotfix 037 (device_audit
-- exit_code -> bigint). Re-runnable: its test executes it a second time.

-- Re-pair (decision 4): a code may be bound to one live device. Enrolling
-- with it rebinds that row to the new key — name and history kept — instead
-- of inserting a row. Revoking or deleting the device kills its codes.
ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS device_id uuid
    REFERENCES devices (id) ON DELETE CASCADE;
-- The name a new machine takes when the card that minted the code named it
-- (NULL: the agent's own, its hostname). A re-pair keeps the row's name.
ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS name text;

-- A re-pair restarts the device's audit chain under a new epoch: the old
-- chain's rows stay (history), and the new key's chain starts at seq 0
-- without a false DEVICE_AUDIT_BREAK.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS audit_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE device_audit ADD COLUMN IF NOT EXISTS epoch integer NOT NULL DEFAULT 0;
ALTER TABLE device_audit DROP CONSTRAINT IF EXISTS device_audit_pkey;
ALTER TABLE device_audit ADD CONSTRAINT device_audit_pkey PRIMARY KEY (device_id, epoch, seq);

-- The door the agent's socket last came through (P15): 'host' for the hub's
-- own loopback port, 'tailnet' through the sidecar, NULL when neither could
-- be derived. An observation stamped at each authenticated connect, never a
-- flag anyone sets; S43a/S48/S49 widen the CHECK with their doors.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_transport text;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_last_transport;
ALTER TABLE devices ADD CONSTRAINT devices_last_transport
    CHECK (last_transport IN ('host', 'tailnet'));

-- A revoked device's agent that is still running keeps knocking (P28): the
-- last knock whose signature verified against its revoked key, so "is the old
-- agent still running?" has an answer that is a record, not a guess.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_refused_at timestamptz;

-- The update ledger (decision 2): one row per attempt. `sent` until the
-- device's next authenticated connection decides it (P8). One `sent` row at a
-- time, for everyone who can ask (P9).
CREATE TABLE IF NOT EXISTS agent_updates (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id    uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    from_version text,
    version      text NOT NULL CHECK (version ~ '^[0-9a-f]{12}$'),
    sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    path         text NOT NULL CHECK (path IN ('capability', 'bootstrap')),
    requested_by text NOT NULL CHECK (requested_by IN ('nova', 'owner', 'reconciler')),
    sent_at      timestamptz NOT NULL DEFAULT now(),
    outcome      text NOT NULL DEFAULT 'sent'
                 CHECK (outcome IN ('sent', 'confirmed', 'rolled_back', 'not_confirmed', 'refused')),
    outcome_at   timestamptz,
    reason       text,
    CONSTRAINT agent_updates_decided_when CHECK ((outcome = 'sent') = (outcome_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_updates_one_in_flight ON agent_updates ((true)) WHERE outcome = 'sent';
CREATE INDEX IF NOT EXISTS agent_updates_by_device ON agent_updates (device_id, sent_at DESC);
```

- [ ] **Step 4: Run the tests to verify they pass, then the migration pins**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_migration_038.py tests/test_no_approvals.py tests/test_devices_ws.py 2>&1 | tail -3
grep -rln "036_agent_facts\|037_audit_exit_code" tests | head
```

Expected: pass (`test_no_approvals` unchanged and green: no `capabilities`/`fs_roots`/`home_dir` column). If a test pins the highest migration's name, move that pin to `038_agent_lifecycle.sql` deliberately and say so in the commit.

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/migrations/038_agent_lifecycle.sql services/core/tests/test_migration_038.py services/core/tests/conftest.py
git -C $W commit -m "feat(core): migration 038 — re-pair codes, audit epochs, the door, a revoked agent's knocks, the update ledger"
git -C $W show --stat HEAD | tail -4
```

---

## Task 15: Re-pair — a code bound to one machine rebinds its row

**Files:**
- Modify: `services/core/app/devices.py` (`RESERVED_NAMES`, `mint_pairing_code(device_id=, name=)`, `enroll` rebinds, `repaired`)
- Modify: `services/core/app/governance.py` (`DEVICE_REPAIRED`)
- Modify: `services/core/app/devices_api.py` (`POST /{id}/repair-code`; `enroll` drops the old key's socket)
- Modify: `services/core/app/devices_ws.py` (the audit chain by epoch)
- Create: `services/core/tests/test_devices_repair.py`
- Modify: `services/core/tests/test_devices.py` (the enroll response pin gains `repaired`)

**Interfaces:**
- Consumes: migration 038.
- Produces:
  - `devices.RESERVED_NAMES = frozenset({"hub"})`; `devices.mint_pairing_code(pool, *, created_by: uuid.UUID | None, device_id: uuid.UUID | None = None, name: str | None = None) -> {"code", "expires_at"}`.
  - `devices.enroll(...)` → `{"device_id", "name", "core_pubkey", "repaired": bool}`.
  - `governance.DEVICE_REPAIRED = "device.repaired"` (meta `name, old_pubkey, new_pubkey, epoch, platform, hostname`).
  - `POST /api/v1/devices/{id}/repair-code` → `{"code", "expires_at", "device": device_spec}`.
  - `devices_ws.ingest_audit(pool, device_id, entries, *, epoch: int = 0)`; `authenticate`'s `last_seq` reads the row's epoch.

- [ ] **Step 1: Write the failing tests**

`services/core/tests/test_devices_repair.py`:

```python
"""Re-pair (S42b decision 4): a code minted from a machine's tile — or by her,
for a machine she names — binds to that one row. Whoever enrolls with it
within ten minutes becomes that machine under a new key: its name and history
stay, its audit chain restarts under a new epoch, and the old key's socket is
dropped."""

from __future__ import annotations

import uuid

import pytest

from app import devices, devices_ws, governance
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice
from tests.test_devices_ws import _chain, _enroll, _person

pytestmark = requires_db


async def _repair(pool, device_id: uuid.UUID, new: FakeDevice, *, platform: str = "windows") -> dict:
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    return await devices.enroll(
        pool, code=code["code"], pubkey=new.pubkey_hex, name="ignored", platform=platform, hostname="NEW-HOST"
    )


async def test_a_repair_code_rebinds_the_row_keeping_its_name_and_history(pool):
    device_id, old = await _enroll(pool, name="DELL-XPS-8950", platform="windows")
    await devices_ws.ingest_audit(pool, device_id, _chain({}, {}))
    new = FakeDevice()
    result = await _repair(pool, device_id, new)
    assert result == {
        "device_id": str(device_id), "name": "DELL-XPS-8950",
        "core_pubkey": await devices.core_public_key_hex(pool), "repaired": True,
    }
    row = await devices.get(pool, device_id)
    assert row["pubkey"] == new.pubkey_hex and row["hostname"] == "NEW-HOST"
    assert row["audit_epoch"] == 1 and row["facts"] is None and row["revoked_at"] is None
    assert await pool.fetchval("SELECT count(*) FROM device_audit WHERE device_id = $1 AND epoch = 0", device_id) == 2
    event = await pool.fetchrow(
        "SELECT meta FROM governance_events WHERE kind = $1 AND subject_ref = $2", governance.DEVICE_REPAIRED, device_id
    )
    assert event["meta"]["old_pubkey"] == old.pubkey_hex and event["meta"]["new_pubkey"] == new.pubkey_hex
    assert event["meta"]["epoch"] == 1


async def test_a_repaired_device_starts_a_new_audit_chain_without_a_break(pool):
    device_id, _old = await _enroll(pool, name="pc")
    await devices_ws.ingest_audit(pool, device_id, _chain({}, {}, {}))
    new = FakeDevice()
    await _repair(pool, device_id, new, platform="linux")
    got = await devices_ws.ingest_audit(pool, device_id, _chain({}), epoch=1)
    assert got == {"stored": 1, "break": None}
    breaks = await pool.fetchval(
        "SELECT count(*) FROM governance_events WHERE kind = $1 AND subject_ref = $2", governance.DEVICE_AUDIT_BREAK, device_id
    )
    assert breaks == 0


async def test_a_repair_code_for_a_revoked_device_is_refused_at_mint(pool):
    device_id, _old = await _enroll(pool, name="pc")
    person = await _person(pool)
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    with pytest.raises(devices.DeviceRefused) as caught:
        await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    assert caught.value.status_code == 409 and "re-paired" in caught.value.reason


async def test_a_device_revoked_after_its_code_was_minted_is_not_repaired_and_the_code_is_not_spent(pool):
    device_id, _old = await _enroll(pool, name="pc")
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    with pytest.raises(devices.DeviceRefused) as caught:
        await devices.enroll(pool, code=code["code"], pubkey=FakeDevice().pubkey_hex, name="x", platform="linux", hostname="h")
    assert caught.value.status_code == 409
    assert await pool.fetchval("SELECT used_at FROM pairing_codes WHERE code_hash = $1", devices.hash_code(code["code"])) is None


async def test_a_code_that_names_the_machine_names_it(pool):
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id, name="work-laptop")
    result = await devices.enroll(pool, code=code["code"], pubkey=FakeDevice().pubkey_hex, name="thinkpad", platform="linux", hostname="thinkpad")
    assert result["name"] == "work-laptop" and result["repaired"] is False


@pytest.mark.parametrize("name", ["hub", "HUB", " Hub "])
async def test_hub_is_never_a_device_name(pool, name):
    person = await _person(pool)
    with pytest.raises(devices.DeviceRefused) as caught:
        await devices.mint_pairing_code(pool, created_by=person.id, name=name)
    assert "bundled engine" in caught.value.reason
    code = await devices.mint_pairing_code(pool, created_by=person.id)
    with pytest.raises(devices.DeviceRefused):
        await devices.enroll(pool, code=code["code"], pubkey=FakeDevice().pubkey_hex, name=name, platform="linux", hostname="h")
    device_id, _ = await _enroll(pool, name="pc")
    with pytest.raises(devices.DeviceRefused):
        await devices.rename(pool, device_id=device_id, name=name)


async def test_the_repair_route_mints_a_code_bound_to_the_device(owner_client, pool):
    device_id, _old = await _enroll(pool, name="pc")
    resp = await owner_client.post(f"/api/v1/devices/{device_id}/repair-code")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["device"]["id"] == str(device_id) and len(body["code"]) == 8
    bound = await pool.fetchval("SELECT device_id FROM pairing_codes WHERE code_hash = $1", devices.hash_code(body["code"]))
    assert bound == device_id


async def test_enrolling_with_a_repair_code_drops_the_old_keys_socket(client, pool, monkeypatch):
    device_id, _old = await _enroll(pool, name="pc")
    dropped: list = []

    async def _disconnect(did, reason):
        dropped.append((str(did), reason))
        return True

    monkeypatch.setattr(devices_ws.hub, "disconnect", _disconnect)
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    resp = await client.post(
        "/api/v1/devices/enroll",
        json={"code": code["code"], "pubkey": FakeDevice().pubkey_hex, "name": "pc", "platform": "linux", "hostname": "h"},
    )
    assert resp.status_code == 200, resp.text
    assert dropped == [(str(device_id), "re-paired")]
```

In `test_devices.py`, `test_enroll_returns_the_device_id_name_and_cores_pubkey`'s pin becomes:

```python
    assert set(body) == {"device_id", "name", "core_pubkey", "repaired"}
    assert body["repaired"] is False
```

with the comment line "S42b: `repaired` joins the wire contract (decision 4) — an old agent's decoder ignores it."

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_devices_repair.py 2>&1 | tail -6`
Expected: FAIL — `mint_pairing_code() got an unexpected keyword argument 'device_id'`.

- [ ] **Step 3: Implement**

`governance.py`: add under the device kinds

```python
# S42b: a re-pair rebound a live row to a new key (decision 4) — the old and
# new keys and the new audit epoch, so the arc stays readable.
DEVICE_REPAIRED = "device.repaired"
```

`devices.py`:

```python
# D8: `hub` is the bundled engine's name, and machine_status groups engines
# and agents by name — a device called hub would read as the engine.
RESERVED_NAMES = frozenset({"hub"})
```

`_clean_name` adds, after the length check:

```python
    if candidate.casefold() in RESERVED_NAMES:
        raise DeviceRefused(
            f"a machine cannot be named {candidate!r} — that is the bundled engine's name "
            "(hub decision D8); name it after the machine itself"
        )
```

The burn returns the binding: `RETURNING id, created_by, device_id, name` in `_BURN_CODE_SQL`, plus:

```python
# A re-pair (decision 4): the live row takes the new key, platform and host;
# its reported facts and door clear (they described the old agent); the audit
# epoch moves on so the new key's chain starts at seq 0. The CTE reads the old
# key before the update, for the ledger.
_REBIND_SQL = """
WITH old AS (SELECT pubkey FROM devices WHERE id = $1 AND revoked_at IS NULL FOR UPDATE)
UPDATE devices d
   SET pubkey = $2, platform = $3, hostname = $4, facts = NULL, facts_at = NULL,
       last_seen = NULL, last_transport = NULL, audit_epoch = d.audit_epoch + 1
  FROM old
 WHERE d.id = $1 AND d.revoked_at IS NULL
RETURNING d.*, old.pubkey AS old_pubkey
"""
```

`mint_pairing_code`:

```python
async def mint_pairing_code(
    pool: asyncpg.Pool,
    *,
    created_by: uuid.UUID | None,
    device_id: uuid.UUID | None = None,
    name: str | None = None,
) -> dict:
    """Mint a single-use code and return it in the clear — ONCE.

    `device_id` makes it a RE-PAIR code (S42b decision 4): whoever enrolls
    with it within ten minutes becomes that live machine — its row, name and
    history — under a new key. `name` is the name a NEW machine takes (a card
    that names it); a re-pair keeps the row's own. `created_by` is None only
    for ./install's hub agent before anyone has registered (devices_cli)."""
    clean_name = None
    if device_id is not None:
        row = await pool.fetchrow("SELECT name, revoked_at FROM devices WHERE id = $1", device_id)
        if row is None:
            raise DeviceRefused(f"no device {device_id}", status_code=404)
        if row["revoked_at"] is not None:
            raise DeviceRefused(
                f"{row['name']} was revoked — a revoked machine is paired again with a new code, "
                "not re-paired",
                status_code=_REVOKED_STATUS,
            )
    elif name is not None:
        clean_name = _clean_name(name)
    code = "".join(secrets.choice(PAIRING_CODE_ALPHABET) for _ in range(PAIRING_CODE_LENGTH))
    expires_at = await pool.fetchval(
        "INSERT INTO pairing_codes (code_hash, created_by, expires_at, device_id, name) "
        "VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5) RETURNING expires_at",
        hash_code(code),
        created_by,
        PAIRING_CODE_TTL_SECONDS,
        device_id,
        clean_name,
    )
    return {"code": code, "expires_at": expires_at.isoformat()}
```

`enroll`, inside the transaction after the burn:

```python
                repaired = burned["device_id"] is not None
                if repaired:
                    row = await conn.fetchrow(
                        _REBIND_SQL, burned["device_id"], clean_pubkey, clean_platform, clean_hostname
                    )
                    if row is None:
                        raise DeviceRefused(
                            "that machine was revoked after this code was made — mint a new code "
                            "in Settings -> Devices",
                            status_code=_REVOKED_STATUS,
                        )
                    await governance.record_event(
                        conn,
                        kind=governance.DEVICE_REPAIRED,
                        actor=str(burned["created_by"]) if burned["created_by"] else None,
                        subject_ref=row["id"],
                        meta={
                            "name": row["name"], "old_pubkey": row["old_pubkey"], "new_pubkey": clean_pubkey,
                            "epoch": row["audit_epoch"], "platform": clean_platform, "hostname": clean_hostname,
                        },
                    )
                else:
                    row = await conn.fetchrow(
                        _INSERT_DEVICE_SQL, burned["name"] or clean_name, clean_platform,
                        clean_hostname, clean_pubkey, burned["created_by"],
                    )
                    await governance.record_event(...)  # the existing DEVICE_ENROLLED event, unchanged
```

(the `UniqueViolationError` message names `burned["name"] or clean_name`; hoist `name_used = …` before the insert for it), and the return:

```python
    return {"device_id": str(row["id"]), "name": row["name"], "core_pubkey": core_pubkey, "repaired": repaired}
```

`devices_api.py`:

```python
@router.post("/{device_id}/repair-code")
async def mint_repair_code(device_id: uuid.UUID, person: Person = Depends(identity.require_person)) -> dict:
    """A re-pair code for ONE machine (decision 4): single use, ten minutes,
    shown once. The machine's command keeps a pairing Nova still knows and
    leaves the code unused; it rebinds the row only when the old pairing is
    gone."""
    pool = await db.get_pool()
    try:
        minted = await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)
    except devices.DeviceRefused as exc:
        raise _refuse(exc) from exc
    return {**minted, "device": devices.device_spec(await devices.get(pool, device_id))}
```

and in `enroll`, after the success log:

```python
    if result["repaired"]:
        # The old key's socket, if one is still open, speaks for a key the row
        # no longer holds: drop it now (its reconnect then fails the challenge).
        from app import devices_ws

        await devices_ws.hub.disconnect(uuid.UUID(result["device_id"]), "re-paired")
```

`devices_ws.py`: `ingest_audit(pool, device_id, entries, *, epoch: int = 0)` — every `device_audit` read gains `AND epoch = $N`, the insert writes `epoch`, and `ON CONFLICT (device_id, epoch, seq) DO NOTHING`; `authenticate`'s `last_seq` is `SELECT max(seq) FROM device_audit WHERE device_id = $1 AND epoch = $2` with `row["audit_epoch"]`; `_handle_frame(pool, device_id, frame, *, epoch: int = 0)` passes it to `ingest_audit`; `serve` passes `row["audit_epoch"]`.

- [ ] **Step 4: Run the tests to verify they pass, then the device suites**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_devices_repair.py tests/test_devices.py tests/test_devices_ws.py tests/test_devices_e2e.py tests/test_governance.py 2>&1 | tail -3
uv run ruff check app tests && uv run ruff format app/devices.py app/devices_api.py app/devices_ws.py app/governance.py tests/test_devices_repair.py tests/test_devices.py
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/devices.py services/core/app/devices_api.py services/core/app/devices_ws.py services/core/app/governance.py \
  services/core/tests/test_devices_repair.py services/core/tests/test_devices.py
git -C $W commit -m "feat(core): re-pair — a code bound to one machine rebinds its row, name and history kept, the chain restarted"
git -C $W show --stat HEAD | tail -5
```

---

## Task 16: What core reads from an agent — the update outcome, the folders, how it starts, its build

**Files:**
- Modify: `services/core/app/device_facts.py`
- Modify: `services/core/app/devices.py` (`device_spec`, `list_devices`)
- Modify: `services/core/app/machines.py` (`GatewayPlant.agents` reads the door and the last update)
- Test: `services/core/tests/test_device_facts.py`, `services/core/tests/test_devices.py`

**Interfaces:**
- Produces:
  - `device_facts.FOLDER_NAMES = ("home", "desktop", "documents", "downloads")`; `FRAME_SECTIONS` gains `"folders"`; `UPDATE_OUTCOMES = ("applied", "rolled_back")`; `SERVICE_MODES = ("systemd-user", "launch-agent", "run-key")`.
  - `validate_auth` keeps an optional `agent.update` (`{version, outcome, reason, at}`; absent → the key is absent). `validate_frame` keeps `folders` (known names only, non-empty text).
  - `device_facts.starts(facts) -> str`; `device_facts.build_state(agent_version, hub_version) -> {"state": "current"|"behind"|"unknown", "hub_version": str|None}`; `device_facts.folders_of(facts) -> tuple[str, ...]`.
  - `agent_view(..., hub_version=None, last_transport=None, last_update=None)` adds `"mode"`, `"starts"`, `"build"`, `"hub"` (bool), `"last_update"` (dict|None), `"folders"` (tuple of names).
  - `device_spec(row, *, hub_version=None, last_update=None)` adds `"hub"`, `"door"`, `"mode"`, `"starts"`, `"build_state"`, `"hub_version"`, `"last_update"`; `list_devices(pool, *, hub_version=None)` joins each device's latest update.

- [ ] **Step 1: Write the failing tests**

Append to `services/core/tests/test_device_facts.py` (it imports `device_facts as df` and holds the `WINDOWS` auth facts and the `_with` helper):

```python
def test_an_update_outcome_is_kept_and_a_bad_one_refused():
    update = {"version": "aaaaaaaaaaaa", "outcome": "rolled_back", "reason": "did not connect", "at": "2026-09-28T12:00:00Z"}
    assert df.validate_auth(_with(WINDOWS, "agent.update", update))["agent"]["update"] == update
    assert "update" not in df.validate_auth(WINDOWS)["agent"]
    with pytest.raises(df.FactsRejected):
        df.validate_auth(_with(WINDOWS, "agent.update", {**update, "outcome": "staged"}))


def test_the_folders_section_keeps_known_names_only():
    got = df.validate_frame({"type": "facts", "folders": {"desktop": "C:\\Users\\sam\\OneDrive\\Desktop", "pictures": "/p"}})
    assert got == {"folders": {"desktop": "C:\\Users\\sam\\OneDrive\\Desktop"}}
    with pytest.raises(df.FactsRejected):
        df.validate_frame({"type": "facts", "folders": {"desktop": ""}})


@pytest.mark.parametrize(
    "mode,said",
    [
        ("run-key", "by itself at sign-in (the Windows Run key)"),
        ("systemd-user", "by itself (a systemd user service)"),
        ("launch-agent", "by itself at login (a LaunchAgent)"),
        ("foreground", "by hand — Nova cannot restart it or update it"),
    ],
)
def test_how_an_agent_starts_is_said_from_its_mode(mode, said):
    assert df.starts(df.validate_auth(_with(WINDOWS, "agent.mode", mode))) == said
    assert df.starts(None) == "unknown — it reports no facts (it predates S42a)"


def test_behind_means_not_the_hubs_build_never_older():
    assert df.build_state("aaaaaaaaaaaa", "aaaaaaaaaaaa") == {"state": "current", "hub_version": "aaaaaaaaaaaa"}
    assert df.build_state("dcde74c4b9a8", "aaaaaaaaaaaa") == {"state": "behind", "hub_version": "aaaaaaaaaaaa"}
    assert df.build_state(None, "aaaaaaaaaaaa")["state"] == "unknown"
    assert df.build_state("aaaaaaaaaaaa", None) == {"state": "unknown", "hub_version": None}


def test_the_agent_view_carries_its_build_its_door_and_its_last_update():
    facts = df.validate_auth(WINDOWS)
    last = {"version": "aaaaaaaaaaaa", "outcome": "confirmed", "at": "2026-09-28T12:00:00+00:00", "reason": None}
    view = df.agent_view(
        name="minipc", platform="windows", hostname="PC-ONE", connected=True, last_seen=None,
        facts=facts, facts_at=None, hub_version="aaaaaaaaaaaa", last_transport="host", last_update=last,
    )
    assert view["hub"] is True and view["build"] == {"state": "behind", "hub_version": "aaaaaaaaaaaa"}
    assert view["last_update"] == last and view["mode"] == "foreground" and view["folders"] == ()
```

Append to `test_devices.py` (it holds `_owner` and `_enrolled`):

```python
async def test_a_device_spec_says_its_door_how_it_starts_and_its_build(pool):
    enrolled = await _enrolled(pool, await _owner(pool))
    device_id = uuid.UUID(enrolled["device_id"])
    await pool.execute("UPDATE devices SET last_transport = 'host' WHERE id = $1", device_id)
    spec = devices.device_spec(await devices.get(pool, device_id), hub_version="aaaaaaaaaaaa")
    assert spec["hub"] is True and spec["door"] == "host"
    assert spec["build_state"] == "unknown" and spec["hub_version"] == "aaaaaaaaaaaa"
    assert spec["starts"].startswith("unknown") and spec["last_update"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_device_facts.py tests/test_devices.py 2>&1 | tail -6`
Expected: FAIL — `module 'app.device_facts' has no attribute 'starts'`.

- [ ] **Step 3: Implement**

`device_facts.py`:

```python
FRAME_SECTIONS: tuple[str, ...] = ("net", "unreadable", "folders")
# S42b P16: the folders a fs path may name as @<name>, as the agent's OS names them.
FOLDER_NAMES: tuple[str, ...] = ("home", "desktop", "documents", "downloads")
# S42b P8: what an agent's supervisor records about its last update.
UPDATE_OUTCOMES: tuple[str, ...] = ("applied", "rolled_back")
# The modes in which a supervisor started the agent: the ones Nova can restart.
SERVICE_MODES: tuple[str, ...] = ("systemd-user", "launch-agent", "run-key")
_STARTS = {
    "run-key": "by itself at sign-in (the Windows Run key)",
    "systemd-user": "by itself (a systemd user service)",
    "launch-agent": "by itself at login (a LaunchAgent)",
    "foreground": "by hand — Nova cannot restart it or update it",
}
```

In `validate_auth`, after the `agent` object is read:

```python
    update = agent.get("update")
    clean_update: dict | None = None
    if update is not None:
        u = _object(update, "facts.agent.update")
        outcome = _text(u.get("outcome"), "facts.agent.update.outcome")
        if outcome not in UPDATE_OUTCOMES:
            raise FactsRejected(f"facts.agent.update.outcome {outcome!r} is not one of {', '.join(UPDATE_OUTCOMES)}")
        clean_update = {
            "version": _text(u.get("version"), "facts.agent.update.version"),
            "outcome": outcome,
            "reason": _text(u.get("reason", ""), "facts.agent.update.reason"),
            "at": _text(u.get("at", ""), "facts.agent.update.at"),
        }
```

and the returned `"agent"` dict gains `**({"update": clean_update} if clean_update else {})`.

```python
def _folders(raw: object) -> dict:
    folders = _object(raw, "facts.folders")
    out = {}
    for name in FOLDER_NAMES:
        if name in folders:
            path = _text(folders[name], f"facts.folders.{name}")
            if not path:
                raise FactsRejected(f"facts.folders.{name} is empty — an unnamed folder is left out, never sent empty")
            out[name] = path
    return out
```

`validate_frame` adds `if "folders" in frame: out["folders"] = _folders(frame["folders"])`.

```python
def starts(facts: dict | None) -> str:
    """How this agent starts, for a person — from the mode its supervisor
    gave it (S42b P4), never assumed."""
    if not isinstance(facts, dict):
        return "unknown — it reports no facts (it predates S42a)"
    mode = (facts.get("agent") or {}).get("mode")
    return _STARTS.get(mode, f"unknown (mode {mode!r})")


def build_state(agent_version: str | None, hub_version: str | None) -> dict:
    """current | behind | unknown, against the hub's build. A version is a
    hash with no order: behind means "not the hub's build", never "older"."""
    if not hub_version or not agent_version:
        return {"state": "unknown", "hub_version": hub_version}
    return {"state": "current" if agent_version == hub_version else "behind", "hub_version": hub_version}


def folders_of(facts: dict | None) -> tuple[str, ...]:
    """The known folders this agent reported (P16) — an @folder path is
    admitted only for these."""
    folders = facts.get("folders") if isinstance(facts, dict) else None
    return tuple(name for name in FOLDER_NAMES if isinstance(folders, dict) and folders.get(name))
```

`agent_view` gains `hub_version: str | None = None, last_transport: str | None = None, last_update: dict | None = None` and these keys:

```python
        "mode": (facts.get("agent") or {}).get("mode") if isinstance(facts, dict) else None,
        "starts": starts(facts),
        "build": build_state(agent_version(facts), hub_version),
        "hub": last_transport == "host",
        "last_update": last_update,
        "folders": folders_of(facts),
```

`devices.py`:

```python
def device_spec(row, *, hub_version: str | None = None, last_update: dict | None = None) -> dict:
    ...  # the existing keys, then:
        # S42b: the door (P15), how it starts (P4), and its build against the hub's (decision 2).
        "hub": row.get("last_transport") == "host",
        "door": row.get("last_transport"),
        "mode": ((facts or {}).get("agent") or {}).get("mode") if isinstance(facts, dict) else None,
        "starts": device_facts.starts(facts),
        "build_state": device_facts.build_state(device_facts.agent_version(facts), hub_version)["state"],
        "hub_version": hub_version,
        "last_update": last_update,
```

```python
_LIST_SQL = """
SELECT d.*, u.version AS u_version, u.outcome AS u_outcome, u.reason AS u_reason,
       COALESCE(u.outcome_at, u.sent_at) AS u_at
  FROM devices d
  LEFT JOIN LATERAL (SELECT * FROM agent_updates a WHERE a.device_id = d.id ORDER BY a.sent_at DESC LIMIT 1) u ON true
 ORDER BY d.enrolled_at DESC
"""


def _last_update(row) -> dict | None:
    if row.get("u_version") is None:
        return None
    return {"version": row["u_version"], "outcome": row["u_outcome"],
            "at": row["u_at"].isoformat() if row["u_at"] else None, "reason": row["u_reason"]}


async def list_devices(pool: asyncpg.Pool, *, hub_version: str | None = None) -> list[dict]:
    rows = await pool.fetch(_LIST_SQL)
    return [device_spec(row, hub_version=hub_version, last_update=_last_update(row)) for row in rows]
```

`machines.GatewayPlant.agents` selects with the same lateral join over `WHERE d.revoked_at IS NULL ORDER BY d.name` and passes `last_transport=row["last_transport"], last_update=devices._last_update(row)` (hub_version arrives in Task 18).

- [ ] **Step 4: Run the tests to verify they pass, and the suites that read these shapes**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_device_facts.py tests/test_devices.py tests/test_devices_ws.py tests/test_tools_machines.py tests/test_machines.py tests/test_machines_api.py tests/test_eval_corpus.py 2>&1 | tail -3
uv run ruff format app/device_facts.py app/devices.py app/machines.py tests/test_device_facts.py tests/test_devices.py
```

Expected: pass. A test that pins `agent_view`'s or `device_spec`'s exact key set moves deliberately (name the keys added in the commit body).

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/device_facts.py services/core/app/devices.py services/core/app/machines.py services/core/tests/test_device_facts.py services/core/tests/test_devices.py
git -C $W commit -m "feat(core): an agent's update outcome, folders, how it starts and its build — read, never assumed"
git -C $W show --stat HEAD | tail -5
```

---
## Task 16b: Core reads the probes and says them as sentences (P29)

**Files:**
- Modify: `services/core/app/device_facts.py`
- Test: `services/core/tests/test_device_facts.py`

**Interfaces:**
- Consumes: the frame keys Task 10b sends (`service`, `elevation`, `wsl_distros`, `probed_at`); Task 1's Windows-sudo branch (**S-fails** / **S-prompts**) and, on **L-cli**, "default unknown".
- Produces:
  - `FRAME_SECTIONS` gains `"service", "elevation", "wsl_distros", "probed_at"`; `SUDO_STATES`; `WINDOWS_SUDO_FROM_AGENT`.
  - `runs_line(facts) -> str`; `elevation_line(facts, platform) -> str | None`; `wsl_line(facts) -> str | None`; `acting_lines(facts, platform) -> list[str]` — every line one line (no control characters can reach them).
  - `agent_view(...)` gains `"acting"` (the list).
- Consumed by: Task 21 (`device_list`, `device_info`), Task 22 (`machine_status`).

- [ ] **Step 1: Write the failing tests**

Append to `services/core/tests/test_device_facts.py`:

```python
PROBED = {
    "type": "facts",
    "service": {
        "name": "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Nova agent",
        "binary": "C:\\Users\\sam\\AppData\\Local\\Programs\\Nova\\novad.exe",
        "config": "C:\\Users\\sam\\AppData\\Roaming\\novad\\config.json",
        "process": "novad.exe",
        "pid": 812,
        "supervisor_pid": 790,
        "user": "PC-ONE\\sam",
    },
    "elevation": {"elevated": False, "admin": True, "sudo": "inline"},
    "wsl_distros": {
        "distros": [
            {
                "name": "Ubuntu-26.04", "default": True, "version": 2, "running": True, "looked": True,
                "pid1": "systemd", "user": "sam", "sudo": "refused", "root": True,
                "novad_unit": {"active": "active", "file": "enabled", "restart": "always", "main_pid": 412},
                "novad_pids": [412],
            },
            {"name": "docker-desktop", "default": False, "version": 2, "running": False, "looked": False,
             "root": False, "novad_pids": []},
        ]
    },
    "probed_at": "2026-09-28T17:40:00Z",
}


def _set(base: dict, path: tuple, value) -> dict:
    out = copy.deepcopy(base)
    node = out
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    return out


def _merged(frame=PROBED) -> dict:
    return {**df.validate_auth(WINDOWS), **df.validate_frame(frame)}


def test_the_probe_sections_are_kept_in_their_shape():
    got = df.validate_frame(PROBED)
    assert got["service"]["process"] == "novad.exe" and got["service"]["supervisor_pid"] == 790
    assert got["elevation"] == {"elevated": False, "admin": True, "sudo": "inline", "sudo_said": ""}
    ubuntu, docker = got["wsl_distros"]["distros"]
    assert ubuntu["novad_unit"] == {"active": "active", "file": "enabled", "restart": "always", "main_pid": 412, "said": ""}
    assert docker["looked"] is False and docker["novad_unit"] is None and docker["pid1"] == ""
    assert got["probed_at"] == "2026-09-28T17:40:00Z"


@pytest.mark.parametrize(
    "path,value",
    [
        (("wsl_distros", "distros", 0, "name"), "Ubuntu\n  agent evil (Windows): connected"),
        (("service", "user"), "sam\r"),
        (("wsl_distros", "distros", 0, "novad_unit", "said"), "line one\nline two"),
        (("elevation", "sudo_said"), "sudo:\ta password is required"),
    ],
)
def test_a_probe_field_with_a_control_character_is_refused(path, value):
    """Review Focus 13: these are rendered INTO a listing line; a newline
    would split the line machine_status's device_line_shown reads back."""
    with pytest.raises(df.FactsRejected, match="control character"):
        df.validate_frame(_set(PROBED, path, value))


@pytest.mark.parametrize(
    "path,value,reason",
    [
        (("elevation", "sudo"), "maybe", "is not one of"),
        (("service", "pid"), -1, "whole number"),
        (("service", "pid"), True, "whole number"),
        (("wsl_distros", "distros", 0, "version"), 3, "whole number"),
        (("wsl_distros", "distros", 0, "novad_pids"), list(range(1, 10)), "more than 8"),
        (("probed_at",), "yesterday", "not a time"),
    ],
)
def test_a_probe_field_outside_its_shape_is_refused(path, value, reason):
    with pytest.raises(df.FactsRejected, match=reason):
        df.validate_frame(_set(PROBED, path, value))


def test_more_than_eight_distros_is_refused():
    many = [dict(PROBED["wsl_distros"]["distros"][1], name=f"d{i}") for i in range(9)]
    with pytest.raises(df.FactsRejected, match="more than 8"):
        df.validate_frame(_set(PROBED, ("wsl_distros", "distros"), many))


def test_the_wsl_line_says_where_the_old_agent_runs_and_how_it_restarts():
    """Review Focus 14: the Dell's old agent, from the Windows agent's look."""
    line = df.wsl_line(_merged())
    assert line.startswith("WSL on it, reached through this agent's wsl.exe: ")
    assert "Ubuntu-26.04 (default, WSL 2, running, systemd, default user sam" in line
    assert "sudo needs a password here" in line and "root through wsl.exe -u root without a password" in line
    assert "sam's systemd user unit novad.service is active (enabled, Restart=always, main pid 412)" in line
    assert "managed with systemctl --user as that user, without sudo" in line and "novad process pid 412" in line
    assert "docker-desktop (WSL 2, not running — not looked inside, since looking would start it)" in line


def test_a_distro_whose_bus_could_not_be_reached_says_so_in_systemctls_words():
    said = _set(PROBED, ("wsl_distros", "distros", 0, "novad_unit"),
                {"active": "", "file": "", "restart": "", "main_pid": 0, "said": "Failed to connect to bus: No medium found"})
    line = df.wsl_line(_merged(said))
    assert "its user units could not be read (Failed to connect to bus: No medium found); novad process pid 412" in line


def test_the_acting_lines_say_how_it_runs_and_whether_elevation_asks():
    lines = df.acting_lines(_merged(), "windows")
    assert lines[0] == (
        "how it runs: service HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Nova agent; "
        "binary C:\\Users\\sam\\AppData\\Local\\Programs\\Nova\\novad.exe; "
        "config C:\\Users\\sam\\AppData\\Roaming\\novad\\config.json; "
        "process novad.exe pid 812, supervisor pid 790; as PC-ONE\\sam"
    )
    assert lines[1].startswith(
        "elevation: the agent runs without admin rights; he is an administrator, so admin work "
        "asks for his consent at a UAC prompt on the desktop, which a command cannot answer; "
        "Windows sudo is on (inline)"
    )
    assert lines[2].startswith("WSL on it") and lines[3] == "(probed 2026-09-28T17:40:00Z; device_info probes again)"
    assert all("\n" not in line for line in lines)


def test_an_agent_that_predates_the_probes_says_so():
    said = ["how it runs: unknown — this agent predates S42b and does not say"]
    assert df.acting_lines(df.validate_auth(WINDOWS), "windows") == said
    assert df.acting_lines(None, "linux") == said


def test_a_linux_agents_sudo_is_said_in_its_own_words():
    facts = df.validate_frame({"type": "facts", "elevation": {"elevated": False, "sudo": "refused",
                                                             "sudo_said": "sudo: a password is required"}})
    assert df.elevation_line(facts, "linux") == (
        "elevation: sudo needs a password here, and nothing can type one into Nova's commands — "
        "a command using sudo fails (sudo -n said: sudo: a password is required)"
    )
    root = df.validate_frame({"type": "facts", "elevation": {"elevated": True, "sudo": "no_password"}})
    assert df.elevation_line(root, "linux") == "elevation: the agent runs as root"
```

`test_agent_view_is_the_one_shape`'s key set gains `"acting"` (a deliberate pin move; the commit says so), and add to it:

```python
    assert view["acting"] == ["how it runs: unknown — this agent predates S42b and does not say"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && uv run pytest -q tests/test_device_facts.py 2>&1 | tail -4`
Expected: FAIL — `module 'app.device_facts' has no attribute 'wsl_line'`, and the probe sections dropped by `validate_frame`.

- [ ] **Step 3: Implement**

In `device_facts.py`, beside the other constants:

```python
FRAME_SECTIONS: tuple[str, ...] = (
    "net", "unreadable", "folders", "service", "elevation", "wsl_distros", "probed_at",
)
# S42b P29: what `sudo -n true` did on Linux and macOS, or Windows sudo's setting.
SUDO_STATES: tuple[str, ...] = (
    "no_password", "refused", "absent", "off", "new_window", "input_off", "inline", "unknown",
)
# What Windows sudo does when Nova's agent runs it — the sentence Task 1
# recorded. Branch S-fails (below); on S-prompts it reads:
# " — and from Nova's agent it puts a UAC prompt on his desktop that her command cannot answer".
WINDOWS_SUDO_FROM_AGENT = " — and from Nova's agent it fails at once: nobody is at a console to approve it"
_MAX_DISTROS = 8
_MAX_PIDS = 8
_PID_MAX = 2**31 - 1
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_SUDO_WORDS = {
    "no_password": "sudo runs without a password",
    "refused": (
        "sudo needs a password here, and nothing can type one into Nova's commands — "
        "a command using sudo fails"
    ),
    "absent": "no sudo",
    "off": "Windows sudo is off",
    "new_window": "Windows sudo is on (a new window)",
    "input_off": "Windows sudo is on (input closed)",
    "inline": "Windows sudo is on (inline)",
    "unknown": "Windows sudo is in a mode Nova does not know",
}
_UNKNOWN_RUNS = "how it runs: unknown — this agent predates S42b and does not say"
```

The validators, after `_unreadable`:

```python
def _line(value: object, where: str) -> str:
    """Text core renders INTO a line: one line. A newline in an agent-reported
    name would split the line tools.machines.device_line_shown reads back —
    it fails closed, and her facts would be dropped (Review Focus 13)."""
    text = _text(value, where)
    if _CONTROL.search(text):
        raise FactsRejected(f"{where} contains a control character")
    return text


def _count(value: object, where: str, most: int = _PID_MAX) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= most:
        raise FactsRejected(f"{where} must be a whole number from 0 to {most}")
    return value


def _state(value: object, where: str) -> str:
    state = _line(value, where)
    if state not in SUDO_STATES:
        raise FactsRejected(f"{where} {state!r} is not one of {', '.join(SUDO_STATES)}")
    return state


def _service(raw: object) -> dict:
    s = _object(raw, "facts.service")
    out = {k: _line(s.get(k, ""), f"facts.service.{k}") for k in ("name", "binary", "config", "process", "user")}
    out["pid"] = _count(s.get("pid", 0), "facts.service.pid")
    out["supervisor_pid"] = _count(s.get("supervisor_pid", 0), "facts.service.supervisor_pid")
    return out


def _elevation(raw: object) -> dict:
    e = _object(raw, "facts.elevation")
    out = {
        "elevated": _bool(e.get("elevated"), "facts.elevation.elevated"),
        "sudo": _state(e.get("sudo"), "facts.elevation.sudo"),
        "sudo_said": _line(e.get("sudo_said", ""), "facts.elevation.sudo_said"),
    }
    if e.get("admin") is not None:
        out["admin"] = _bool(e["admin"], "facts.elevation.admin")
    return out


def _unit(raw: object, where: str) -> dict:
    u = _object(raw, where)
    out = {k: _line(u.get(k, ""), f"{where}.{k}") for k in ("active", "file", "restart")}
    out["main_pid"] = _count(u.get("main_pid", 0), f"{where}.main_pid")
    out["said"] = _line(u.get("said", ""), f"{where}.said")
    return out


def _distro(raw: object, where: str) -> dict:
    d = _object(raw, where)
    pids = d.get("novad_pids") or []
    if not isinstance(pids, list) or len(pids) > _MAX_PIDS:
        raise FactsRejected(f"{where}.novad_pids must be a list of at most {_MAX_PIDS} — more than {_MAX_PIDS} is refused")
    sudo = d.get("sudo", "")
    return {
        "name": _line(d.get("name"), f"{where}.name"),
        "default": _bool(d.get("default", False), f"{where}.default"),
        "version": _count(d.get("version", 0), f"{where}.version", 2),
        "running": _bool(d.get("running", False), f"{where}.running"),
        "looked": _bool(d.get("looked", False), f"{where}.looked"),
        "root": _bool(d.get("root", False), f"{where}.root"),
        "pid1": _line(d.get("pid1", ""), f"{where}.pid1"),
        "user": _line(d.get("user", ""), f"{where}.user"),
        "sudo": _state(sudo, f"{where}.sudo") if sudo else "",
        "novad_unit": None if d.get("novad_unit") is None else _unit(d["novad_unit"], f"{where}.novad_unit"),
        "novad_pids": [_count(p, f"{where}.novad_pids[{i}]") for i, p in enumerate(pids)],
    }


def _wsl_distros(raw: object) -> dict:
    w = _object(raw, "facts.wsl_distros")
    items = w.get("distros")
    if not isinstance(items, list):
        raise FactsRejected("facts.wsl_distros.distros must be a list")
    if len(items) > _MAX_DISTROS:
        raise FactsRejected(f"facts.wsl_distros lists more than {_MAX_DISTROS} distributions")
    return {
        "distros": [_distro(item, f"facts.wsl_distros.distros[{i}]") for i, item in enumerate(items)],
        "running_said": _line(w.get("running_said", ""), "facts.wsl_distros.running_said"),
    }


def _probed_at(raw: object) -> str:
    text = _line(raw, "facts.probed_at")
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise FactsRejected(f"facts.probed_at {text!r} is not a time") from exc
    return text
```

(The pids message says "more than 8" so the parametrized case and the distro-count case read alike.) `validate_frame` adds, after the `folders` branch:

```python
    if "service" in frame:
        out["service"] = _service(frame["service"])
    if "elevation" in frame:
        out["elevation"] = _elevation(frame["elevation"])
    if "wsl_distros" in frame:
        out["wsl_distros"] = _wsl_distros(frame["wsl_distros"])
    if "probed_at" in frame:
        out["probed_at"] = _probed_at(frame["probed_at"])
```

The sentences, after `place`:

```python
# -- what she needs to act (S42b P29) ----------------------------------------


def runs_line(facts: dict | None) -> str:
    """How this agent runs, from what it probed about itself."""
    s = facts.get("service") if isinstance(facts, dict) else None
    if not isinstance(s, dict):
        return _UNKNOWN_RUNS
    by = f"service {s['name']}" if s["name"] else "no service — started by hand"
    sup = f", supervisor pid {s['supervisor_pid']}" if s["supervisor_pid"] else ""
    return (
        f"how it runs: {by}; binary {s['binary']}; config {s['config']}; "
        f"process {s['process']} pid {s['pid']}{sup}; as {s['user']}"
    )


def elevation_line(facts: dict | None, platform: str) -> str | None:
    """Whether elevating from this agent would need a person — and why."""
    e = facts.get("elevation") if isinstance(facts, dict) else None
    if not isinstance(e, dict):
        return None
    sudo = _SUDO_WORDS.get(e["sudo"], e["sudo"])
    if platform == "windows":
        if e["elevated"]:
            head = "the agent runs with admin rights (an elevated token)"
        elif e.get("admin"):
            head = (
                "the agent runs without admin rights; he is an administrator, so admin work asks "
                "for his consent at a UAC prompt on the desktop, which a command cannot answer"
            )
        else:
            head = (
                "the agent runs without admin rights, and this account is not an administrator: "
                "admin work needs an administrator's password at a UAC prompt, which a command "
                "cannot answer"
            )
        if e["sudo"] not in ("off", "absent"):
            sudo += WINDOWS_SUDO_FROM_AGENT
        return f"elevation: {head}; {sudo}"
    if e["elevated"]:
        return "elevation: the agent runs as root"
    said = f" (sudo -n said: {e['sudo_said']})" if e["sudo"] == "refused" and e["sudo_said"] else ""
    return f"elevation: {sudo}{said}"


def _nova_agent_in(d: dict) -> str:
    pids = d["novad_pids"]
    procs = f"novad process pid {', '.join(map(str, pids))}" if pids else "no novad process"
    unit = d["novad_unit"]
    if unit is None:
        return procs
    if not unit["active"]:
        return f"its user units could not be read ({unit['said'] or 'no answer'}); {procs}"
    if not unit["file"] and unit["active"] == "inactive":
        return f"no novad.service user unit; {procs}"
    return (
        f"{d['user'] or 'its default user'}'s systemd user unit novad.service is {unit['active']} "
        f"({unit['file'] or 'no unit file'}, Restart={unit['restart'] or 'unknown'}, "
        f"main pid {unit['main_pid']}) — a user unit is managed with systemctl --user as that "
        f"user, without sudo; {procs}"
    )


def _distro_words(d: dict, why: dict[str, str]) -> str:
    bits = ["default"] if d["default"] else []
    bits.append(f"WSL {d['version']}" if d["version"] else "WSL version unknown")
    if not d["running"]:
        bits.append("not running — not looked inside, since looking would start it")
    elif not d["looked"]:
        bits.append(f"running; could not look inside: {why.get('wsl_distros.' + d['name'], 'no reason given')}")
    else:
        bits.append("running")
        bits.append("systemd" if d["pid1"] == "systemd" else f"no systemd (PID 1 is {d['pid1'] or 'unknown'})")
        if d["user"]:
            bits.append(f"default user {d['user']}")
        if d["sudo"]:
            bits.append(_SUDO_WORDS.get(d["sudo"], d["sudo"]))
        bits.append(
            "root through wsl.exe -u root without a password" if d["root"] else "wsl.exe -u root did not run"
        )
        bits.append(_nova_agent_in(d))
    return f"{d['name']} ({', '.join(bits)})"


def wsl_line(facts: dict | None) -> str | None:
    """The WSL distributions beside a Windows agent, as it looked at them."""
    w = facts.get("wsl_distros") if isinstance(facts, dict) else None
    if not isinstance(w, dict):
        return None
    if not w["distros"]:
        return "WSL: no distribution is installed for this account"
    why = {u["item"]: u["reason"] for u in facts.get("unreadable") or [] if isinstance(u, dict)}
    said = f" (wsl.exe --list --running said: {w['running_said']})" if w.get("running_said") else ""
    return (
        "WSL on it, reached through this agent's wsl.exe: "
        + "; ".join(_distro_words(d, why) for d in w["distros"])
        + said
    )


def acting_lines(facts: dict | None, platform: str) -> list[str]:
    """What she needs to act on this machine without being told (S42b P29),
    as sentences for device_info, device_list and machine_status — derived
    from what the agent probed, with when; never a prompt list."""
    lines = [runs_line(facts)]
    if lines[0] == _UNKNOWN_RUNS:
        return lines
    lines.extend(line for line in (elevation_line(facts, platform), wsl_line(facts)) if line)
    lines.append(f"(probed {facts.get('probed_at') or 'at an unknown time'}; device_info probes again)")
    return lines
```

In the distro bits, "default" is left out and "WSL version unknown" said on Task 1's branch **L-cli** — the words follow from `default: false, version: 0`, nothing else changes. `agent_view` gains `"acting": acting_lines(facts, platform),`.

- [ ] **Step 4: Run the tests to verify they pass, and the suites that read these shapes**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_device_facts.py tests/test_devices_ws.py tests/test_tools_machines.py tests/test_machines.py tests/test_eval_corpus.py 2>&1 | tail -3
uv run ruff format app/device_facts.py tests/test_device_facts.py
```

Expected: pass (a machine_status test that pins an agent line exactly moves with Task 22, not here — `agent_view` only gained a key).

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/device_facts.py services/core/tests/test_device_facts.py
git -C $W commit -m "feat(core): read the agent's probes and say them as sentences — how it runs, whether elevating asks, the WSL beside it

agent_view gains \"acting\" (test_agent_view_is_the_one_shape's pin moves by that one key)."
git -C $W show --stat HEAD | tail -5
```

---

## Task 17: The door, and a revoked agent's knocks

**Files:**
- Modify: `services/core/app/network.py` (`door_of`)
- Modify: `services/core/app/devices_ws.py` (`WebSocketConn(door=)`, the route, `authenticate` records the door and a revoked device's verified knock)
- Modify: `services/core/tests/device_fakes.py` (`FakeWSConn(door=)`)
- Modify: `deploy/docker-compose.yml` (core's environment gains the three addresses)
- Test: `services/core/tests/test_network.py`, `services/core/tests/test_devices_ws.py`

**Interfaces:**
- Consumes: migration 038 (`last_transport`, `last_refused_at`); Task 2's measured loopback source.
- Produces: `network.door_of(peer: str | None, forwarded: str | None) -> "host" | "tailnet" | None`; `devices.last_transport` written at every authenticated connect (NULL when no door could be told); `devices.last_refused_at` written when a revoked device's signature verifies against its revoked key; `FakeWSConn(door=None)`.

- [ ] **Step 1: Write the failing tests**

Append to `services/core/tests/test_network.py`:

```python
@pytest.mark.parametrize(
    "peer,forwarded,door",
    [
        ("172.18.128.10", "172.18.0.1", "host"),       # web, forwarding the published loopback port
        ("172.18.128.10", "172.18.128.20", "tailnet"),  # web, forwarding the sidecar
        ("172.18.128.10", "192.0.2.7", None),           # web, forwarding something else
        ("172.18.0.1", None, "host"),                   # straight to core's own loopback port
        ("172.18.0.99", "172.18.0.1", None),            # a header from anyone but web counts for nothing
        (None, None, None),
    ],
)
def test_the_door_is_told_from_the_peer_and_webs_forwarded_address(monkeypatch, peer, forwarded, door):
    for key in ("NOVA_WEB_ADDR", "NOVA_TAILSCALE_ADDR", "NOVA_SUBNET_GATEWAY"):
        monkeypatch.delenv(key, raising=False)
    assert network.door_of(peer, forwarded) == door


def test_the_doors_follow_the_subnet_install_chose(monkeypatch):
    monkeypatch.setenv("NOVA_WEB_ADDR", "172.22.128.10")
    monkeypatch.setenv("NOVA_TAILSCALE_ADDR", "172.22.128.20")
    monkeypatch.setenv("NOVA_SUBNET_GATEWAY", "172.22.0.1")
    assert network.door_of("172.22.128.10", "172.22.0.1") == "host"
    assert network.door_of("172.18.128.10", "172.18.0.1") is None
```

(`pytest` imported at the top of `test_network.py` if it is not already.)

Append to `services/core/tests/test_devices_ws.py`:

```python
# -- S42b: the door (P15) and a revoked agent's knocks (P28) -------------------


async def _connect_through(pool, door, *, name="minipc"):
    device_id, device = await _enroll(pool, name=name)
    device.device_id = str(device_id)
    conn = FakeWSConn(door=door)
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    ready = await asyncio.wait_for(device.handshake(conn, None), 2)
    assert ready["type"] == "ready"
    return device_id, device, conn, task


async def test_the_hubs_own_door_is_recorded_on_connect(pool):
    device_id, _device, conn, task = await _connect_through(pool, "host")
    assert await pool.fetchval("SELECT last_transport FROM devices WHERE id = $1", device_id) == "host"
    await _close(conn, task)


async def test_a_connect_through_no_known_door_records_none(pool):
    device_id, device, conn, task = await _connect_through(pool, "host")
    await _close(conn, task)
    conn = FakeWSConn(door=None)
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    await asyncio.wait_for(device.handshake(conn, None), 2)
    assert await pool.fetchval("SELECT last_transport FROM devices WHERE id = $1", device_id) is None
    await _close(conn, task)


async def test_a_revoked_devices_verified_knock_is_recorded_and_answered_with_the_proof(pool):
    device_id, device = await _enroll(pool, name="old-wsl")
    person = await _person(pool)
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    _conn, task, reply = await _auth_with(pool, device_id, device, None)
    assert reply["type"] == "auth_error" and reply["reason"] == devices_ws.REVOKED_REASON and "proof" in reply
    assert await pool.fetchval("SELECT last_refused_at FROM devices WHERE id = $1", device_id) is not None
    await asyncio.wait_for(task, 2)


async def test_an_unverified_knock_for_a_revoked_id_gets_no_proof_and_records_nothing(pool):
    device_id, device = await _enroll(pool, name="old-wsl")
    person = await _person(pool)
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    _conn, task, reply = await _auth_with(pool, device_id, device, None, key=FakeDevice())
    assert reply["type"] == "auth_error" and "proof" not in reply
    assert reply["reason"] != devices_ws.REVOKED_REASON
    assert await pool.fetchval("SELECT last_refused_at FROM devices WHERE id = $1", device_id) is None
    await asyncio.wait_for(task, 2)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_network.py tests/test_devices_ws.py -k "door or knock" 2>&1 | tail -6`
Expected: FAIL — `no attribute 'door_of'`, `FakeWSConn() got an unexpected keyword argument 'door'`, and the unverified knock still gets the proof.

- [ ] **Step 3: Implement**

`network.py`:

```python
# The stack's own addresses (deploy/docker-compose.yml; decide_subnet writes
# them to .env when 172.18 is taken). Core reads them to tell which door a
# device socket came through (S42b P15); the defaults are compose's.
WEB_ADDR_ENV = "NOVA_WEB_ADDR"
TAILSCALE_ADDR_ENV = "NOVA_TAILSCALE_ADDR"
GATEWAY_ENV = "NOVA_SUBNET_GATEWAY"
_ADDR_DEFAULTS = {WEB_ADDR_ENV: "172.18.128.10", TAILSCALE_ADDR_ENV: "172.18.128.20", GATEWAY_ENV: "172.18.0.1"}


def _addr(name: str) -> str:
    return os.environ.get(name) or _ADDR_DEFAULTS[name]


def door_of(peer: str | None, forwarded: str | None) -> str | None:
    """Which door a device socket came through: "host" — the hub machine's own
    published loopback port, whose traffic docker hands to the stack from the
    subnet gateway (measured, Task 2); "tailnet" — through the sidecar; None
    when it cannot be told. nginx's X-Real-IP is believed ONLY from web's
    fixed address: on a bridge a connection cannot be completed from a spoofed
    source, so any other sender's header counts for nothing (P15)."""
    if peer == _addr(WEB_ADDR_ENV):
        if forwarded == _addr(GATEWAY_ENV):
            return "host"
        if forwarded == _addr(TAILSCALE_ADDR_ENV):
            return "tailnet"
        return None
    if peer == _addr(GATEWAY_ENV):
        return "host"
    return None
```

(On Task 2's other branch, `door_of` maps the measured loopback source instead of `GATEWAY_ENV`, with the measurement cited in the docstring.)

`devices_ws.py`: `WebSocketConn.__init__(self, websocket, door: str | None = None)` stores `self.door = door`; the route:

```python
@router.websocket("/api/v1/devices/ws")
async def devices_ws_route(websocket: WebSocket) -> None:
    await websocket.accept()
    pool = await db.get_pool()
    peer = websocket.client.host if websocket.client else None
    door = network.door_of(peer, websocket.headers.get("x-real-ip"))
    await serve(WebSocketConn(websocket, door=door), pool)
```

In `authenticate`, the revoked branch verifies first and records the knock:

```python
    row = await devices.get_live(pool, device_id)
    if row is None:
        gone = await devices.get(pool, device_id)
        if gone is not None and gone["revoked_at"] is not None:
            sig = frame.get("sig")
            if not isinstance(sig, str) or not verify_nonce(gone["pubkey"], nonce, sig):
                # The signed proof goes only to whoever holds the revoked key
                # (S42a's carry): anyone else learns nothing and leaves no knock.
                await _auth_error(conn, "the challenge signature did not verify")
                return None
            # P28: the revoked agent is still running. Its knock is a record,
            # so "is it still running?" has an answer.
            await pool.execute("UPDATE devices SET last_refused_at = now() WHERE id = $1", device_id)
            await _auth_error_revoked(conn, pool, device_id, nonce.hex())
        else:
            await _auth_error(conn, UNKNOWN_DEVICE_REASON)
        return None
```

and, after the live row's signature verifies, before the facts:

```python
    await pool.execute(
        "UPDATE devices SET last_transport = $2 WHERE id = $1", device_id, getattr(conn, "door", None)
    )
```

(`network` joins the `from app import …` line.) `device_fakes.FakeWSConn.__init__(self, door: str | None = None)` sets `self.door = door` (docstring: "the door a real adapter derives from the peer; None is 'unknown'").

`deploy/docker-compose.yml`, core's `environment:` gains:

```yaml
      # S42b P15: the stack's own addresses, so core can tell which door an
      # agent's socket came through (app/network.py door_of). The same .env
      # keys and defaults web and the tailnet sidecar use below.
      NOVA_WEB_ADDR: ${NOVA_WEB_ADDR:-172.18.128.10}
      NOVA_TAILSCALE_ADDR: ${NOVA_TAILSCALE_ADDR:-172.18.128.20}
      NOVA_SUBNET_GATEWAY: ${NOVA_SUBNET_GATEWAY:-172.18.0.1}
```

- [ ] **Step 4: Run the tests to verify they pass, and the deploy suites the compose file feeds**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_network.py tests/test_devices_ws.py tests/test_devices_e2e.py 2>&1 | tail -3
cd ~/workspace/nova/.worktrees/s42b && docker compose -f deploy/docker-compose.yml config -q && echo COMPOSE-OK
bash deploy/install_test.sh 2>&1 | tail -1 && uv run --project deploy/backup pytest -q -m "not live" deploy/backup/tests 2>&1 | tail -2
```

Expected: all pass; `COMPOSE-OK`. The existing revoked-device tests still pass (they sign with the device's own key). If a backup test compares the rendered compose fixture and turns red on the new environment lines, regenerate the fixtures with `deploy/backup/fixtures/refresh.sh` exactly as S47 did (`998113dd`) and say so in the commit.

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/network.py services/core/app/devices_ws.py services/core/tests/device_fakes.py \
  services/core/tests/test_network.py services/core/tests/test_devices_ws.py deploy/docker-compose.yml
git -C $W commit -m "feat(core): which door an agent came through, and a revoked agent's knocks — recorded only when its key signed them"
git -C $W show --stat HEAD | tail -5
```

---

## Task 18: `agent_dist` — the hub's build, checked, signed and served on seven public paths

**Files:**
- Create: `services/core/app/agent_dist.py`, `services/core/app/agent_dist_api.py`, `services/core/tests/test_agent_dist.py`
- Modify: `services/core/app/identity.py` (`PUBLIC_PATHS` +7), `services/core/app/main.py` (the router), `services/core/app/devices_api.py` and `services/core/app/machines.py` (the hub's version into the listings), `services/core/tests/conftest.py` (clear the limiter)

**Interfaces:**
- Consumes: `devices.signing_key`, `envelopes.sign`/`verify`.
- Produces:
  - `agent_dist.TARGETS`, `file_key(goos, arch) -> "linux-amd64"`, `file_name(goos, arch) -> "novad-linux-amd64"` (`.exe` on windows), `FILE_NAMES`, `PUBLIC_PATHS` (7).
  - `class DistUnavailable(RuntimeError)`; `@dataclass Build(version, built_at, go, files)` with `file_for(goos, arch) -> dict | None` and `manifest() -> dict`.
  - `current() -> Build` (sync, raises); `async read() -> Build`; `async version() -> str | None`; `path_of(name) -> Path`; `async signed_manifest(pool) -> {"manifest", "sig"}`.
  - Routes (public): `GET /api/v1/agent/manifest` → `{"manifest", "sig"}` (Task 19 adds `commands`, `commands_reason`, `walks`); `GET /api/v1/agent/dist/{name}`; 429 over 30 a minute; 503 with the reason when there is no build.
  - The dist layout agent-dist writes (Task 25): `/dist/current` holds the version; `/dist/<version>/manifest.json` = `{"v": 1, "version", "built_at", "go", "files": {"<goos>-<arch>": {"name", "sha256", "size"}}}` plus the six files.

- [ ] **Step 1: Write the failing tests**

`services/core/tests/test_agent_dist.py`:

```python
"""The hub's build of Nova's agent (S42b, D13): served only when every file
matches its manifest, the manifest signed by core's own key, on seven exact
public paths — and a missing or broken build is said, never served."""

from __future__ import annotations

import hashlib
import json

import pytest

from app import agent_dist, agent_dist_api, devices, envelopes, identity
from tests.conftest import requires_db

VERSION = "aaaaaaaaaaaa"


@pytest.fixture
def dist(tmp_path, monkeypatch):
    """A complete fake build on disk, laid out as agent-dist writes it."""
    monkeypatch.setenv(agent_dist.DIST_DIR_ENV, str(tmp_path))
    agent_dist._HASHES.clear()
    build = tmp_path / VERSION
    build.mkdir()
    files = {}
    for goos, arch in agent_dist.TARGETS:
        name = agent_dist.file_name(goos, arch)
        body = f"build of {goos}/{arch}".encode()
        (build / name).write_bytes(body)
        files[agent_dist.file_key(goos, arch)] = {"name": name, "sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}
    (build / "manifest.json").write_text(json.dumps(
        {"v": 1, "version": VERSION, "built_at": "2026-09-28T12:00:00Z", "go": "go1.27.1", "files": files}))
    (tmp_path / "current").write_text(VERSION + "\n")
    return tmp_path


def test_the_current_build_is_read_and_checked(dist):
    build = agent_dist.current()
    assert build.version == VERSION
    assert build.file_for("windows", "amd64")["name"] == "novad-windows-amd64.exe"
    assert build.file_for("plan9", "amd64") is None


def test_a_file_whose_bytes_do_not_match_its_manifest_makes_the_build_unavailable(dist):
    (dist / VERSION / "novad-linux-amd64").write_bytes(b"something else")
    with pytest.raises(agent_dist.DistUnavailable, match="does not match its manifest"):
        agent_dist.current()


def test_no_build_is_stated_not_guessed(tmp_path, monkeypatch):
    monkeypatch.setenv(agent_dist.DIST_DIR_ENV, str(tmp_path))
    with pytest.raises(agent_dist.DistUnavailable, match="no agent build on this hub yet"):
        agent_dist.current()
    assert agent_dist.current_version() is None


def test_the_seven_public_paths_are_exact():
    assert len(agent_dist.PUBLIC_PATHS) == 7
    assert agent_dist.PUBLIC_PATHS <= identity.PUBLIC_PATHS
    assert identity.PUBLIC_PATHS - agent_dist.PUBLIC_PATHS == {
        "/api/v1/auth/state", "/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/devices/enroll",
    }


@requires_db
async def test_the_manifest_is_signed_by_cores_key(dist, pool):
    signed = await agent_dist.signed_manifest(pool)
    assert signed["manifest"]["version"] == VERSION
    assert envelopes.verify(await devices.core_public_key_hex(pool), signed["manifest"], signed["sig"])


@requires_db
async def test_the_manifest_and_a_binary_are_public(client, dist):
    resp = await client.get("/api/v1/agent/manifest")
    assert resp.status_code == 200, resp.text
    assert set(resp.json()) >= {"manifest", "sig"}
    resp = await client.get("/api/v1/agent/dist/novad-linux-amd64")
    assert resp.status_code == 200 and resp.content == b"build of linux/amd64"


@requires_db
async def test_a_name_outside_the_build_is_not_public(client, dist):
    assert (await client.get("/api/v1/agent/dist/novad-linux-amd64x")).status_code == 401


@requires_db
async def test_downloads_are_rate_limited(client, dist, monkeypatch):
    monkeypatch.setattr(agent_dist_api, "RATE_PER_MINUTE", 2)
    codes = [(await client.get("/api/v1/agent/dist/novad-linux-amd64")).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


@requires_db
async def test_no_build_is_a_stated_503(client, tmp_path, monkeypatch):
    monkeypatch.setenv(agent_dist.DIST_DIR_ENV, str(tmp_path))
    resp = await client.get("/api/v1/agent/manifest")
    assert resp.status_code == 503 and "no agent build" in resp.json()["error"]
```

In `conftest.py`'s `client` fixture, beside the two limiter clears: `from app import agent_dist_api` and `agent_dist_api._HITS.clear()`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_agent_dist.py 2>&1 | tail -4`
Expected: FAIL — `cannot import name 'agent_dist'`.

- [ ] **Step 3: Implement**

`services/core/app/agent_dist.py`:

```python
"""The hub's build of Nova's agent (S42b, hub D13).

agent-dist (deploy/agent-dist/build.sh) builds the six targets from the
committed apps/novad tree into /dist/<version>/, with manifest.json and
SHA256SUMS, and writes the version into /dist/current last. This module is
core's one reader of it. A build is served only when every file's bytes match
its manifest — hashed once per file state, not per request — and the manifest
goes out signed with core's own key, the key every agent pinned, so an agent
can tell the hub's build from any other (P19).

A version is a hash of the apps/novad tree (P2). It has no order: an agent on
another version is "behind the hub's build", never "older".
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from app import devices, envelopes

DIST_DIR_ENV = "NOVA_AGENT_DIST_DIR"
DEFAULT_DIST_DIR = "/dist"
TARGETS: tuple[tuple[str, str], ...] = (
    ("linux", "amd64"), ("linux", "arm64"), ("darwin", "amd64"),
    ("darwin", "arm64"), ("windows", "amd64"), ("windows", "arm64"),
)
_VERSION = re.compile(r"^[0-9a-f]{12}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def file_key(goos: str, arch: str) -> str:
    return f"{goos}-{arch}"


def file_name(goos: str, arch: str) -> str:
    return f"novad-{goos}-{arch}" + (".exe" if goos == "windows" else "")


FILE_NAMES = frozenset(file_name(g, a) for g, a in TARGETS)
# The seven exact public paths (identity.PUBLIC_PATHS lists them literally;
# test_agent_dist pins that the two agree).
PUBLIC_PATHS = frozenset({"/api/v1/agent/manifest", *(f"/api/v1/agent/dist/{n}" for n in FILE_NAMES)})


class DistUnavailable(RuntimeError):
    """There is no build to serve, or it does not match itself — the reason,
    in words, which the API and her tools state as given."""


@dataclass(frozen=True)
class Build:
    version: str
    built_at: str
    go: str
    files: dict = field(default_factory=dict)

    def file_for(self, goos: str | None, arch: str | None) -> dict | None:
        return self.files.get(file_key(goos or "", arch or ""))

    def manifest(self) -> dict:
        return {"v": 1, "version": self.version, "built_at": self.built_at, "go": self.go, "files": self.files}


# (path, mtime_ns, size) -> sha256 — a file is hashed once per state.
_HASHES: dict[tuple[str, int, int], str] = {}


def dist_dir() -> Path:
    return Path(os.environ.get(DIST_DIR_ENV) or DEFAULT_DIST_DIR)


def _sha256_of(path: Path) -> str:
    try:
        st = path.stat()
    except FileNotFoundError as exc:
        raise DistUnavailable(f"{path.name} is missing from the agent build") from exc
    key = (str(path), st.st_mtime_ns, st.st_size)
    if key not in _HASHES:
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        _HASHES[key] = h.hexdigest()
    return _HASHES[key]


def current() -> Build:
    """The hub's current build, every file checked against its manifest, or
    DistUnavailable with the reason."""
    root = dist_dir()
    try:
        version = (root / "current").read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise DistUnavailable("no agent build on this hub yet — ./install builds it (agent-dist)") from exc
    except OSError as exc:
        raise DistUnavailable(f"the agent build could not be read ({exc.strerror or exc})") from exc
    if not _VERSION.match(version):
        raise DistUnavailable(f"the agent build's current pointer is not a version: {version[:40]!r}")
    try:
        raw = json.loads((root / version / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise DistUnavailable(f"the agent build {version} has no readable manifest ({exc})") from exc
    if not isinstance(raw, dict) or raw.get("version") != version or not isinstance(raw.get("files"), dict):
        raise DistUnavailable(f"the agent build {version}'s manifest does not describe it")
    files = {}
    for goos, arch in TARGETS:
        key, name = file_key(goos, arch), file_name(goos, arch)
        entry = raw["files"].get(key)
        if (
            not isinstance(entry, dict) or entry.get("name") != name
            or not isinstance(entry.get("sha256"), str) or not _SHA256.match(entry["sha256"])
            or not isinstance(entry.get("size"), int)
        ):
            raise DistUnavailable(f"the agent build {version}'s manifest does not describe {key}")
        got = _sha256_of(root / version / name)
        if got != entry["sha256"]:
            raise DistUnavailable(
                f"{name} in the agent build {version} does not match its manifest "
                f"(sha256 {got[:12]}…, manifest {entry['sha256'][:12]}…)"
            )
        files[key] = {"name": name, "sha256": entry["sha256"], "size": entry["size"]}
    return Build(version=version, built_at=str(raw.get("built_at") or ""), go=str(raw.get("go") or ""), files=files)


def current_version() -> str | None:
    try:
        return current().version
    except DistUnavailable:
        return None


async def read() -> Build:
    """current(), off the event loop: the first read of a new build hashes
    tens of megabytes."""
    return await asyncio.to_thread(current)


async def version() -> str | None:
    return await asyncio.to_thread(current_version)


def path_of(name: str) -> Path:
    if name not in FILE_NAMES:
        raise DistUnavailable(f"{name!r} is not one of the agent's builds")
    return dist_dir() / current().version / name


async def signed_manifest(pool) -> dict:
    """The manifest, signed by core's own key over its canonical bytes."""
    body = (await read()).manifest()
    return {"manifest": body, "sig": envelopes.sign(await devices.signing_key(pool), body)}
```

`services/core/app/agent_dist_api.py`:

```python
"""/api/v1/agent — the hub's build of Nova's agent, public (S42b P19).

A machine that is not paired yet has no cookie, no bearer and no key: the
one-liner on the card downloads from here before anything else exists. The
binaries are public anyway (the repo is), so the paths are exact entries in
identity.PUBLIC_PATHS, and the only guard they need is a rate limit — global,
because behind nginx every request arrives from one address, and X-Forwarded-
For is a header the caller writes (devices_api's reasoning)."""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app import agent_dist, db

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])

RATE_PER_MINUTE = 30
_HITS: list[float] = []


def _limited() -> bool:
    now = time.monotonic()
    while _HITS and _HITS[0] < now - 60:
        _HITS.pop(0)
    if len(_HITS) >= RATE_PER_MINUTE:
        return True
    _HITS.append(now)
    return False


def _too_many() -> HTTPException:
    return HTTPException(status_code=429, detail="too many requests for Nova's agent in the last minute — try again shortly")


@router.get("/manifest")
async def manifest() -> dict:
    if _limited():
        raise _too_many()
    pool = await db.get_pool()
    try:
        return await agent_dist.signed_manifest(pool)
    except agent_dist.DistUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/dist/{name}")
async def dist_file(name: str) -> FileResponse:
    if name not in agent_dist.FILE_NAMES:
        raise HTTPException(status_code=404, detail="no such agent build")
    if _limited():
        raise _too_many()
    try:
        path = await asyncio.to_thread(agent_dist.path_of, name)
    except agent_dist.DistUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return FileResponse(path, media_type="application/octet-stream", filename=name)
```

`identity.py` — the comment above `PUBLIC_PATHS` gains a paragraph, and the set its seven literals:

```python
# S42b (P19): Nova's agent is downloaded before a machine has any identity —
# the card's one-liner fetches it first — so the manifest and the six builds
# are public, exactly, and rate-limited (agent_dist_api). They carry nothing
# secret: the repo is public, and the manifest is signed.
PUBLIC_PATHS = frozenset(
    {
        "/api/v1/auth/state",
        "/api/v1/auth/register",
        "/api/v1/auth/login",
        "/api/v1/devices/enroll",
        "/api/v1/agent/manifest",
        "/api/v1/agent/dist/novad-linux-amd64",
        "/api/v1/agent/dist/novad-linux-arm64",
        "/api/v1/agent/dist/novad-darwin-amd64",
        "/api/v1/agent/dist/novad-darwin-arm64",
        "/api/v1/agent/dist/novad-windows-amd64.exe",
        "/api/v1/agent/dist/novad-windows-arm64.exe",
    }
)
```

`main.py`: `from app import agent_dist_api` and `app.include_router(agent_dist_api.router)`.

The hub's version reaches the listings: `devices_api.list_devices` returns `{"devices": await devices.list_devices(pool, hub_version=await agent_dist.version())}`; `GatewayPlant.agents` passes `hub_version=await agent_dist.version()` to each `agent_view`; `FixturePlant.agents` recomputes each declared device's `build` with the same version (`view["build"] = device_facts.build_state(view["agent_version"], hv)`).

- [ ] **Step 4: Run the tests to verify they pass, then identity's own pins**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_agent_dist.py tests/test_identity.py tests/test_devices.py tests/test_machines.py 2>&1 | tail -3
uv run ruff check app tests && uv run ruff format app/agent_dist.py app/agent_dist_api.py app/identity.py app/main.py app/devices_api.py app/machines.py tests/test_agent_dist.py tests/conftest.py
```

Expected: pass. A test in `test_identity.py` that pins `PUBLIC_PATHS` as exactly four moves to eleven deliberately, with this slice's reason in the commit.

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/agent_dist.py services/core/app/agent_dist_api.py services/core/app/identity.py services/core/app/main.py \
  services/core/app/devices_api.py services/core/app/machines.py services/core/tests/test_agent_dist.py services/core/tests/conftest.py services/core/tests/test_identity.py
git -C $W commit -m "feat(core): the hub's agent build — checked against its manifest, signed by core, on seven exact public paths"
git -C $W show --stat HEAD | tail -5
```

---

## Task 19: The card — one command per OS, re-pair from the chat, the walk ledger

**Files:**
- Create: `services/core/app/agent_card.py`, `services/core/app/platform_walks.py`, `services/core/app/platform_walks.json`
- Create: `services/core/tests/test_agent_card.py`, `services/core/tests/test_platform_walks.py`
- Modify: `services/core/app/agent_dist_api.py` (the manifest carries `commands`, `commands_reason`, `walks`)
- Modify: `services/core/app/tools/setup.py` (`machine`, `for_os`; `send_machine_card`; the text), `services/core/app/evals/runner.py` (`_fixture_mint` takes keywords), `services/core/app/conversations.py` (`_card_json` carries `machine`, `for_os`, `walk`)
- Test: `services/core/tests/test_tools_setup.py`, `services/core/tests/test_agent_dist.py`

**Interfaces:**
- Consumes: `agent_dist.Build`/`read` (Task 18), `devices.mint_pairing_code(device_id=)` (Task 15), `network.address()`.
- Produces:
  - `agent_card.CODE_SLOT = "{CODE}"`, `agent_card.OS_KEYS = ("linux", "macos", "windows")`, `agent_card.LOOPBACK = "http://127.0.0.1:3000"`, `agent_card.WINDOWS_NOTE`, `agent_card.LINUX_NOTE`; `agent_card.commands(build, *, origin, hubs=None, code=None) -> {"linux", "macos", "windows"}`.
  - `platform_walks.rows()`, `status(goos) -> str`, `statuses() -> {"linux", "macos", "windows"}`.
  - `GET /api/v1/agent/manifest[?origin=loopback]` → `{"manifest", "sig", "version", "commands": {os: text with {CODE}} | null, "commands_reason": str | null, "walks": {...}, "notes": {os: str}}`.
  - `show_setup_qr` parameters `setup`, `machine?`, `for_os?` (`linux|macos|windows|wsl`); the machine card frame gains `commands` (filled), `for_os`, `machine`, `walks`, `version`; `setup.send_machine_card(ctx, *, setup, machine_row=None, for_os=None) -> dict` (the span fact; never the code).
  - `setup.PAIRING` seam: `Mint = Callable[..., Awaitable[dict]]`, called `(person, device_id=...)`.

- [ ] **Step 1: Write the failing tests**

`services/core/tests/test_agent_card.py`:

```python
"""The card's one-liners (S42b P18): core is their one generator. The POSIX
one is RUN here, under dash when it exists, against shims — the text that
ships is the text that is tested; the PowerShell one is checked for the shape
PowerShell 5.1 can run (no && or ||), and parsed when pwsh exists."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from app import agent_card, agent_dist

ORIGIN = "https://nova.fake-tailnet.ts.net"
FAKE_NOVAD = "#!/bin/sh\necho \"$@\" > \"$RECORD\"\n"


def _build(linux_amd64_sha: str) -> agent_dist.Build:
    files = {}
    for goos, arch in agent_dist.TARGETS:
        sha = linux_amd64_sha if (goos, arch) == ("linux", "amd64") else hashlib.sha256(f"{goos}{arch}".encode()).hexdigest()
        files[agent_dist.file_key(goos, arch)] = {"name": agent_dist.file_name(goos, arch), "sha256": sha, "size": 1}
    return agent_dist.Build(version="aaaaaaaaaaaa", built_at="", go="", files=files)


@pytest.fixture
def world(tmp_path):
    """A PATH with a fake uname and curl, and the fake build curl "downloads"."""
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "uname").write_text('#!/bin/sh\ncase "$1" in -m) echo "$UNAME_M";; *) echo Linux;; esac\n')
    (bin_ / "curl").write_text(
        '#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done\n'
        'echo "$out" > "$CURL_OUT"\ncp "$FAKE_BUILD" "$out"\n'
    )
    for f in bin_.iterdir():
        f.chmod(0o755)
    fake = tmp_path / "novad.build"
    fake.write_text(FAKE_NOVAD)
    return {
        "bin": bin_, "fake": fake, "sha": hashlib.sha256(fake.read_bytes()).hexdigest(),
        "record": tmp_path / "record", "curl_out": tmp_path / "curl_out",
    }


def _run(world, command: str, uname_m: str = "x86_64") -> subprocess.CompletedProcess:
    shell = shutil.which("dash") or "/bin/sh"
    env = {
        "PATH": f"{world['bin']}:/usr/bin:/bin", "UNAME_M": uname_m, "FAKE_BUILD": str(world["fake"]),
        "RECORD": str(world["record"]), "CURL_OUT": str(world["curl_out"]), "HOME": os.environ.get("HOME", "/tmp"),
    }
    return subprocess.run([shell, "-c", command], env=env, capture_output=True, text=True, timeout=30)


def test_the_linux_command_downloads_checks_installs_and_cleans_up(world):
    cmd = agent_card.commands(_build(world["sha"]), origin=ORIGIN, code="ABCD-2345")["linux"]
    done = _run(world, cmd)
    assert done.returncode == 0, done.stderr
    assert world["record"].read_text().strip() == f"install --hub {ORIGIN} --code ABCD-2345"
    downloaded = Path(world["curl_out"].read_text().strip())
    assert not downloaded.parent.exists(), "the download is deleted afterwards (never left in Downloads)"


def test_a_download_whose_sha256_does_not_match_is_never_run(world):
    cmd = agent_card.commands(_build("0" * 64), origin=ORIGIN, code="ABCD-2345")["linux"]
    done = _run(world, cmd)
    assert done.returncode != 0 and not world["record"].exists()


def test_a_machine_with_no_build_is_told_cannot(world):
    cmd = agent_card.commands(_build(world["sha"]), origin=ORIGIN, code="ABCD-2345")["linux"]
    done = _run(world, cmd, uname_m="armv7l")
    assert done.returncode != 0 and "cannot: Nova's agent has no build for armv7l" in done.stderr
    assert not world["record"].exists()


def test_the_hubs_own_agent_gets_its_loopback_first():
    cmd = agent_card.commands(_build("a" * 64), origin=agent_card.LOOPBACK, hubs=[agent_card.LOOPBACK, ORIGIN], code=None)["linux"]
    assert f"install --hub {agent_card.LOOPBACK} --hub {ORIGIN};" in cmd and "--code" not in cmd


def test_the_windows_command_is_powershell_5_1_and_checks_before_it_runs():
    build = _build("a" * 64)
    cmd = agent_card.commands(build, origin=ORIGIN, code=agent_card.CODE_SLOT)["windows"]
    assert "&&" not in cmd and "||" not in cmd
    assert cmd.index("Get-FileHash -Algorithm SHA256") < cmd.index("& $f install")
    for arch in ("amd64", "arm64"):
        assert build.file_for("windows", arch)["sha256"] in cmd
    assert f"--hub {ORIGIN} --code {agent_card.CODE_SLOT}" in cmd
    assert cmd.rstrip().endswith("Remove-Item -Recurse -Force -LiteralPath $d -ErrorAction SilentlyContinue }")


@pytest.mark.skipif(shutil.which("pwsh") is None, reason="pwsh is not installed here; the Windows walk runs it for real")
def test_the_windows_command_parses():
    cmd = agent_card.commands(_build("a" * 64), origin=ORIGIN, code="ABCD-2345")["windows"]
    probe = "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:NOVA_CMD, [ref]$null, [ref]$e); $e.Count"
    done = subprocess.run(["pwsh", "-NoProfile", "-Command", probe], env={**os.environ, "NOVA_CMD": cmd}, capture_output=True, text=True)
    assert done.stdout.strip() == "0", done.stdout + done.stderr


def test_the_mac_command_uses_shasum():
    cmd = agent_card.commands(_build("a" * 64), origin=ORIGIN, code="ABCD-2345")["macos"]
    assert "shasum -a 256 -c -" in cmd and "novad-darwin-$a" in cmd
```

`services/core/tests/test_platform_walks.py`:

```python
"""The walk ledger (S42b P22): every target has a row, and she reads walked or
not walked from it — never from a hope."""

from __future__ import annotations

import re

from app import agent_dist, platform_walks


def test_every_target_has_a_row_of_the_right_shape():
    rows = platform_walks.rows()
    for goos, arch in agent_dist.TARGETS:
        assert any(r["os"] == goos and r["arch"] == arch for r in rows), (goos, arch)
    for r in rows:
        assert set(r) == {"os", "arch", "mode", "role", "slice", "walked_at"}
        assert r["mode"] in {"systemd-user", "launch-agent", "run-key", "foreground"}
        assert r["role"] == "hands" and re.fullmatch(r"S\d+[a-z]?", r["slice"])
        assert r["walked_at"] is None or re.fullmatch(r"\d{4}-\d{2}-\d{2}", r["walked_at"])


def test_a_mac_is_said_not_walked_and_windows_walked():
    assert platform_walks.status("darwin") == "macOS: built and tested in CI, not walked on a Mac"
    assert platform_walks.status("windows").startswith("Windows: walked on real hardware")
    assert set(platform_walks.statuses()) == {"linux", "macos", "windows"}
```

Append to `services/core/tests/test_tools_setup.py` (the `minted` fixture's fake becomes `async def fake(person, **kw): calls.append((person, kw)); return {...}` — the existing tests read `calls[0][0]` where they read `calls[0]`):

```python
from tests.test_agent_dist import dist  # noqa: F401 — the fake build fixture


async def test_a_machine_card_carries_a_command_per_os_with_the_code(status, minted, dist):
    status()
    cards: list = []
    said = await _call("show_setup_qr", {"setup": "add_machine"}, cards=cards)
    card = cards[0]
    assert set(card["commands"]) == {"linux", "macos", "windows"}
    for text in card["commands"].values():
        assert "--code ABCD-2345" in text and "https://nova.fake-tailnet.ts.net" in text
    assert "(Linux today)" not in said
    assert "checks its sha256" in said and "You do not have the code" in said


@requires_db
async def test_a_repair_card_carries_the_code_on_the_card_only(status, minted, dist, pool):
    status()
    device_id, _ = await _enroll(pool, name="DELL-XPS-8950", platform="windows")
    cards, sink = [], []
    said = await _call("show_setup_qr", {"setup": "add_machine", "machine": "DELL-XPS-8950"}, cards=cards, sink=sink)
    assert minted[0][1] == {"device_id": device_id}
    assert cards[0]["machine"] == "DELL-XPS-8950" and cards[0]["for_os"] == "windows"
    assert "re-pairs DELL-XPS-8950" in said
    assert "ABCD-2345" not in said, "the code reaches the card only"
    assert "ABCD-2345" not in repr(sink), "the code never reaches the span"


async def test_a_card_for_a_mac_says_it_is_not_walked(status, minted, dist):
    status()
    said = await _call("show_setup_qr", {"setup": "add_machine", "for_os": "macos"}, cards=[])
    assert "not walked on a Mac" in said


async def test_for_os_wsl_says_the_windows_command_covers_wsl(status, minted, dist):
    status()
    cards: list = []
    said = await _call("show_setup_qr", {"setup": "add_machine", "for_os": "wsl"}, cards=cards)
    assert cards[0]["for_os"] == "wsl" and "the Windows command covers WSL" in said


@requires_db
async def test_a_repair_card_for_an_unknown_machine_names_the_paired_ones(status, minted, dist, pool):
    status()
    await _enroll(pool, name="minipc")
    with pytest.raises(ToolFailure, match="the paired machines are: minipc"):
        await _call("show_setup_qr", {"setup": "add_machine", "machine": "nope"}, cards=[])


async def test_no_agent_build_means_no_pairing_card(status, minted, tmp_path, monkeypatch):
    status()
    monkeypatch.setenv("NOVA_AGENT_DIST_DIR", str(tmp_path / "empty"))
    with pytest.raises(ToolFailure, match="no agent build"):
        await _call("show_setup_qr", {"setup": "add_machine"}, cards=[])
```

(`_enroll` imported from `tests.test_devices_ws`; `requires_db` from `tests.conftest`.)

Append to `test_agent_dist.py`:

```python
@requires_db
async def test_the_manifest_carries_the_commands_with_a_code_slot_and_the_walks(client, dist, monkeypatch, tmp_path):
    resp = await client.get("/api/v1/agent/manifest?origin=loopback")
    body = resp.json()
    assert "--hub http://127.0.0.1:3000" in body["commands"]["linux"] and "{CODE}" in body["commands"]["windows"]
    assert set(body["walks"]) == {"linux", "macos", "windows"} and body["version"] == VERSION
    assert set(body["notes"]) == {"linux", "macos", "windows"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_agent_card.py tests/test_platform_walks.py tests/test_tools_setup.py tests/test_agent_dist.py 2>&1 | tail -6`
Expected: FAIL — `cannot import name 'agent_card'`.

- [ ] **Step 3: The one-liners**

`services/core/app/agent_card.py`:

```python
"""The card's one command per OS (S42b P18). Core is their ONE generator: the
chat card carries them filled, and the public manifest carries them with a
{CODE} slot for /add and Settings, which put the code in client-side (the code
never travels to the server from /add).

Each command downloads the hub's build to a fresh temp directory, checks its
sha256 BEFORE anything runs, runs `novad install`, and deletes the download
whatever happened — never left in Downloads (the owner, 2026-09-28). POSIX
sh (dash-safe) for Linux and macOS; one line of PowerShell 5.1 (no && or ||)
for Windows. `install` then moves the binary to the user's own folder and
proves the agent came up."""

from __future__ import annotations

from collections.abc import Sequence

from app.agent_dist import Build

CODE_SLOT = "{CODE}"
OS_KEYS: tuple[str, ...] = ("linux", "macos", "windows")
LOOPBACK = "http://127.0.0.1:3000"
# Chosen by P0-20 (Task 1 Step 4) and self-linger (Task 3 Step 3). Branch W1 /
# L1 wording shown; W2 is "cannot: Smart App Control is on and blocks
# unsigned programs; Nova's agent is unsigned for now (owner decision 12)." and
# L2 is "Starting at boot needs `sudo loginctl enable-linger $USER` once."
WINDOWS_NOTE = "Nova's agent is unsigned for now (owner decision 12); a download by curl.exe carries no mark for SmartScreen to ask about."
LINUX_NOTE = ""


def notes() -> dict[str, str]:
    """The one sentence each OS's command carries beside it on the card and
    on /add (Task 28) — "" where there is nothing to say."""
    return {"linux": LINUX_NOTE, "macos": "", "windows": WINDOWS_NOTE}


def _hubs(hubs: Sequence[str]) -> str:
    return " ".join(f"--hub {h}" for h in hubs)


def _code(code: str | None) -> str:
    return f" --code {code}" if code else ""


def _posix(goos: str, build: Build, origin: str, hubs: Sequence[str], code: str | None) -> str:
    amd = build.file_for(goos, "amd64")["sha256"]
    arm = build.file_for(goos, "arm64")["sha256"]
    check = "sha256sum -c -" if goos == "linux" else "shasum -a 256 -c -"
    return (
        'd=$(mktemp -d) && case $(uname -m) in '
        f'x86_64|amd64) a=amd64 h={amd};; aarch64|arm64) a=arm64 h={arm};; '
        '*) echo "cannot: Nova\'s agent has no build for $(uname -m)" >&2; a=;; esac && '
        f'[ -n "$a" ] && curl -fsSL -o "$d/novad" "{origin}/api/v1/agent/dist/novad-{goos}-$a" && '
        f'echo "$h  $d/novad" | {check} && chmod 0755 "$d/novad" && '
        f'"$d/novad" install {_hubs(hubs)}{_code(code)}; s=$?; rm -rf "$d"; [ "$s" -eq 0 ]'
    )


def _powershell(build: Build, origin: str, hubs: Sequence[str], code: str | None) -> str:
    amd = build.file_for("windows", "amd64")["sha256"]
    arm = build.file_for("windows", "arm64")["sha256"]
    return (
        "$d=Join-Path $env:TEMP ('nova-'+[guid]::NewGuid()); $null=New-Item -ItemType Directory -Path $d; "
        "try { $a=@{AMD64='amd64';ARM64='arm64'}[$env:PROCESSOR_ARCHITECTURE]; "
        "if(-not $a){throw \"cannot: Nova's agent has no build for $env:PROCESSOR_ARCHITECTURE\"}; "
        f"$h=@{{amd64='{amd}';arm64='{arm}'}}[$a]; $f=Join-Path $d 'novad.exe'; "
        f"curl.exe -fsSL -o $f \"{origin}/api/v1/agent/dist/novad-windows-$a.exe\"; "
        "if($LASTEXITCODE -ne 0){throw 'the download failed'}; "
        "if((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash -ne $h){throw \"the download's sha256 does not match - not run\"}; "
        f"& $f install {_hubs(hubs)}{_code(code)}; "
        "if($LASTEXITCODE -ne 0){throw \"novad install failed (exit $LASTEXITCODE)\"} "
        "} finally { Remove-Item -Recurse -Force -LiteralPath $d -ErrorAction SilentlyContinue }"
    )


def commands(build: Build, *, origin: str, hubs: Sequence[str] | None = None, code: str | None = None) -> dict[str, str]:
    """The one command for each OS. `origin` is where it downloads from;
    `hubs` are the agent's locators in order (default: the origin alone);
    `code` is the pairing code, CODE_SLOT, or None to keep a live pairing."""
    hubs = list(hubs) if hubs else [origin]
    return {
        "linux": _posix("linux", build, origin, hubs, code),
        "macos": _posix("darwin", build, origin, hubs, code),
        "windows": _powershell(build, origin, hubs, code),
    }
```

- [ ] **Step 4: The walk ledger**

`services/core/app/platform_walks.json` (the S5 row's date is the S5 walk's, recorded in `docs/plans/rebuild/slice-05-daemon.md` — confirm it there before committing; migration 013's comment dates it 2026-09-01):

```json
{
  "v": 1,
  "rows": [
    {"os": "linux", "arch": "amd64", "mode": "systemd-user", "role": "hands", "slice": "S5", "walked_at": "2026-09-01"},
    {"os": "linux", "arch": "arm64", "mode": "systemd-user", "role": "hands", "slice": "S42b", "walked_at": null},
    {"os": "darwin", "arch": "amd64", "mode": "launch-agent", "role": "hands", "slice": "S42b", "walked_at": null},
    {"os": "darwin", "arch": "arm64", "mode": "launch-agent", "role": "hands", "slice": "S42b", "walked_at": null},
    {"os": "windows", "arch": "amd64", "mode": "foreground", "role": "hands", "slice": "S42a", "walked_at": "2026-09-28"},
    {"os": "windows", "arch": "amd64", "mode": "run-key", "role": "hands", "slice": "S42b", "walked_at": null},
    {"os": "windows", "arch": "arm64", "mode": "run-key", "role": "hands", "slice": "S42b", "walked_at": null}
  ]
}
```

`services/core/app/platform_walks.py`:

```python
"""Where Nova's agent has been walked on real hardware — the walk ledger
(hub-topology; S42b P22). One row per (os, arch, mode, role): the slice that
walked it and when, or null. show_setup_qr and machine_status read it, so
"not walked on a Mac" is said from a record. Each slice's definition of done
updates it (Task 32)."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

LEDGER = Path(__file__).with_name("platform_walks.json")
_NAMES = {"linux": "Linux", "darwin": "macOS", "windows": "Windows"}


@lru_cache(maxsize=1)
def rows() -> tuple[dict, ...]:
    return tuple(json.loads(LEDGER.read_text(encoding="utf-8"))["rows"])


def status(goos: str) -> str:
    name = _NAMES.get(goos, goos)
    walked = sorted((r for r in rows() if r["os"] == goos and r["walked_at"]), key=lambda r: r["walked_at"])
    if walked:
        last = walked[-1]
        return f"{name}: walked on real hardware ({last['slice']}, {last['walked_at']}, as {last['mode']})"
    return f"{name}: built and tested in CI, not walked on {'a Mac' if goos == 'darwin' else name}"


def statuses() -> dict[str, str]:
    return {"linux": status("linux"), "macos": status("darwin"), "windows": status("windows")}
```

(`services/core/Dockerfile` copies `app/` whole — check it does; if it copies by pattern, add the `.json`.)

- [ ] **Step 5: The manifest carries the commands; `show_setup_qr` re-pairs and says the walk**

In `agent_dist_api.manifest`, take `origin: str | None = None` as a query parameter and return:

```python
    pool = await db.get_pool()
    try:
        build = await agent_dist.read()
        signed = await agent_dist.signed_manifest(pool)
    except agent_dist.DistUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    got = network.address()
    hubs = None
    where = got.origin
    if origin == "loopback":
        # ./install on a WSL hub prints the Windows command for the machine
        # running the stack: loopback first, the tailnet origin behind it.
        where, hubs = agent_card.LOOPBACK, [agent_card.LOOPBACK, *([got.origin] if got.origin else [])]
    return {
        **signed,
        "version": build.version,
        "commands": agent_card.commands(build, origin=where, hubs=hubs, code=agent_card.CODE_SLOT) if where else None,
        "commands_reason": None if where else got.reason,
        "walks": platform_walks.statuses(),
        "notes": agent_card.notes(),
    }
```

`tools/setup.py`:

```python
FOR_OS = ("linux", "macos", "windows", "wsl")
_PLATFORM_TO_OS = {"linux": "linux", "darwin": "macos", "windows": "windows"}
_OS_TO_GOOS = {"linux": "linux", "macos": "darwin", "windows": "windows", "wsl": "windows"}

Mint = Callable[..., Awaitable[dict]]


async def _mint_for(person, *, device_id=None) -> dict:
    """The real mint: one single-use code for this person, stored as its hash —
    a re-pair code when device_id names a machine (decision 4)."""
    pool = await db.get_pool()
    return await devices.mint_pairing_code(pool, created_by=person.id, device_id=device_id)


async def send_machine_card(ctx: ToolContext, *, setup: str, machine_row=None, for_os: str | None = None) -> dict:
    """Mint a code (a re-pair code for machine_row), build the per-OS commands,
    send the card, and return the span's fact — which never holds the code."""
    got = network.address()
    if got.origin is None:
        raise ToolFailure(f"cannot show a setup QR: Nova has no address another device can reach — {got.reason}")
    if ctx.card is None:
        raise ToolFailure("cannot show a setup QR: this turn has no chat to show it in")
    try:
        build = await agent_dist.read()
    except agent_dist.DistUnavailable as exc:
        raise ToolFailure(f"cannot show a pairing card: the hub has no agent build to install — {exc}") from exc
    try:
        minted = await PAIRING.get()(ctx.person, device_id=machine_row["id"] if machine_row else None)
    except Exception as exc:
        logger.exception("show_setup_qr: minting a pairing code failed")
        raise ToolFailure(f"cannot show a pairing card: the pairing code could not be made ({type(exc).__name__})") from exc
    code = _dashed(minted["code"])
    os_key = for_os or (_PLATFORM_TO_OS.get(machine_row["platform"]) if machine_row else None)
    link = f"{got.origin}{_PAGE[setup]}"
    machine = machine_row["name"] if machine_row else None
    ctx.card({
        "kind": "setup_qr", "setup": setup, "address": got.origin, "url": f"{link}#{code}",
        "code": code, "expires_at": minted["expires_at"], "machine": machine, "for_os": os_key,
        "commands": agent_card.commands(build, origin=got.origin, code=code),
        "walks": platform_walks.statuses(), "notes": agent_card.notes(), "version": build.version,
    })
    return {
        "setup": setup, "address": got.origin, "url": link, "expires_at": minted["expires_at"],
        "code_shown": True, "machine": machine, "for_os": os_key,
        "walk": platform_walks.status(_OS_TO_GOOS[os_key]) if os_key else None,
    }
```

`show_setup_qr` validates `machine`/`for_os` (both only with a machine setup; `for_os` in `FOR_OS`), resolves `machine` with `devices.get_live_by_name` (an unknown one: `ToolFailure(f"no paired machine named {machine!r} — the paired machines are: {…}; a re-pair card is for a paired machine, and Pair a device adds a new one")`), and for a machine setup calls `send_machine_card`, appends the fact to `ctx.facts_sink`, and returns:

```python
def _machine_result(setup: str, fact: dict) -> str:
    minutes = devices.PAIRING_CODE_TTL_SECONDS // 60
    who = f"re-pairs {fact['machine']} (its name and history stay)" if fact["machine"] else "adds a new machine"
    walk = fact["walk"] or "; ".join(platform_walks.statuses().values())
    said = (
        f"Sent a pairing card to the chat: a QR code, a short link ({fact['url']}) and a one-time code "
        f"that expires in {minutes} minutes. The card {who}: its command for each OS downloads Nova's "
        f"agent, checks its sha256, installs it in the user's own folder and starts it. {walk}. "
        "You do not have the code — it is only on the card."
    )
    if fact["for_os"] == "wsl":
        said += (" On a Windows PC the Windows command covers WSL: Nova's agent runs on Windows itself "
                 "and reaches WSL through wsl.exe.")
    return f"{said} {MODEL_SERVER_NOTE}" if setup == "add_model_server" else said
```

The tool's schema gains:

```python
            "machine": {"type": "string", "description": "A paired machine to RE-PAIR (its name, as device_list shows it): the card's code rebinds that machine. Omit to add a new one."},
            "for_os": {"type": "string", "enum": list(FOR_OS), "description": "The machine's OS, when you know it: the card opens on that command. wsl means a Windows PC (the Windows command covers WSL)."},
```

and its description adds: "The machine card's command installs Nova's agent (download, sha256 check, install, start) on Linux, macOS or Windows; the result says where it has been walked on real hardware."

`evals/runner._fixture_mint(person, **_kwargs)`. `conversations._card_json` reads the first fact dict that has `"setup"` and adds `machine`, `for_os`, `walk` when present (never a code or the commands).

- [ ] **Step 6: Run the tests to verify they pass, then the S47 suites**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_agent_card.py tests/test_platform_walks.py tests/test_tools_setup.py \
  tests/test_agent_dist.py tests/test_chat_setup_card.py tests/test_chat_setup_guards.py tests/test_setup_guards.py tests/test_eval_corpus.py 2>&1 | tail -3
uv run ruff check app tests && uv run ruff format app/agent_card.py app/platform_walks.py app/agent_dist_api.py app/tools/setup.py app/evals/runner.py app/conversations.py \
  tests/test_agent_card.py tests/test_platform_walks.py tests/test_tools_setup.py tests/test_agent_dist.py
```

Expected: pass. An S47 test that pinned "(Linux today)" or the old result text moves deliberately (G4).

- [ ] **Step 7: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/agent_card.py services/core/app/platform_walks.py services/core/app/platform_walks.json services/core/app/agent_dist_api.py \
  services/core/app/tools/setup.py services/core/app/evals/runner.py services/core/app/conversations.py \
  services/core/tests/test_agent_card.py services/core/tests/test_platform_walks.py services/core/tests/test_tools_setup.py services/core/tests/test_agent_dist.py
git -C $W commit -m "feat(core): the card's one command per OS, verified before it runs; re-pair from the chat; the walk ledger"
git -C $W show --stat HEAD | tail -5
```

---
## Task 20: `agent_updates` — send, confirm by the reconnect, one at a time, the job and the check

**Files:**
- Create: `services/core/app/agent_updates.py`, `services/core/tests/test_agent_updates.py`
- Modify: `services/core/app/devices_ws.py` (`Hub.in_flight`, `Hub.idle`, `_last_command`; `authenticate` hands the facts to `observe_connect`; `_record_auth_facts` returns what it stored)
- Modify: `services/core/app/timers.py` (the `agent_updates` job), `services/core/app/checks/devices.py` (`devices_agents_behind`), `services/core/app/devices_api.py` (`POST /{id}/update`)
- Modify: `services/core/tests/test_devices_ws.py` (`_clean_hub` clears `_last_command`), `tests/test_timers.py`, `tests/test_timers_api.py` (the seeded-jobs pins), `tests/test_checks.py` (if it pins the check names)

**Interfaces:**
- Consumes: `agent_dist.read` (Task 18), `agent_card.LOOPBACK` (Task 19), `device_facts.agent_version`/`SERVICE_MODES` (Task 16), migration 038, `network.address()`.
- Produces:
  - `agent_updates.UpdateOutcome(machine, outcome, version, from_version, reason=None, attempt_id=None, at=None, needs_card=False, in_flight=0)`; outcomes `current | sent | confirmed | rolled_back | not_confirmed | refused | cannot`.
  - `async update_now(pool, *, name, requested_by, wait_s=WAIT_S) -> UpdateOutcome`; `async observe_connect(pool, device_id, facts)`; `async expire_stale(pool) -> int`; `async reconcile(pool) -> str`.
  - `devices_ws.hub.in_flight(device_id) -> int`, `hub.idle(device_id, quiet_s) -> bool`.
  - Timer job `agent_updates`, every 15 minutes (P10). Check `devices_agents_behind` (non-urgent; key `agent_behind:<device id>`; facts `{device, hub_version, why}` with `why ∈ no_facts | by_hand | failed:<outcome> | stale`).
  - `POST /api/v1/devices/{id}/update` → `{"outcome", "version", "from_version", "reason", "needs_card"}` (200; the outcome says what happened, a *cannot* included).

- [ ] **Step 1: Write the failing tests**

`services/core/tests/test_agent_updates.py`:

```python
"""Nova-managed updates (S42b decision 2): sent signed, confirmed ONLY by the
agent's reconnect on the new build, rolled back when its supervisor says so,
one machine at a time, the hub's own agent first — and an older agent updated
through its own hands, or told cannot."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime

import pytest

from app import agent_dist, agent_updates, devices_ws, timers
from app.checks import devices as device_checks
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn
from tests.test_agent_dist import VERSION, dist  # noqa: F401 — the fake build fixture
from tests.test_devices_ws import _close, _enroll

pytestmark = requires_db
OLD = "000000000000"


@pytest.fixture(autouse=True)
def _clean_hub():
    for registry in (devices_ws.hub._conns, devices_ws.hub._pending, devices_ws.hub._last_command):
        registry.clear()
    yield
    for registry in (devices_ws.hub._conns, devices_ws.hub._pending, devices_ws.hub._last_command):
        registry.clear()


@pytest.fixture
def tailnet(tmp_path, monkeypatch):
    path = tmp_path / "tailscale.json"
    monkeypatch.setenv("NOVA_STATUS_FILE", str(path))
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    path.write_text(json.dumps({"version": 1, "backend_state": "Running", "dns_name": "nova.fake-tailnet.ts.net",
                                "serve_ok": True, "https_cert": True, "written_at": now}))


def _facts(version: str, *, mode: str = "systemd-user", update: dict | None = None) -> dict:
    agent = {"version": version, "mode": mode, "session_interactive": False}
    if update:
        agent["update"] = update
    return {"v": 2, "agent": agent, "os": {"goos": "linux", "arch": "amd64", "version": "Test OS", "wsl": None},
            "hostname": "box", "machine_uid": "d" * 64}


async def _online(pool, name: str, facts: dict, *, door: str | None = None):
    device_id, device = await _enroll(pool, name=name)
    device.device_id = str(device_id)
    conn = FakeWSConn(door=door)
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    ready = await asyncio.wait_for(device.handshake(conn, facts), 2)
    assert ready["type"] == "ready", ready
    return device_id, device, conn, task


async def _reconnect(pool, device: FakeDevice, facts: dict):
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    await asyncio.wait_for(device.handshake(conn, facts), 2)
    return conn, task


def _commands(conn: FakeWSConn) -> list[dict]:
    return [f for f in conn.sent if isinstance(f, dict) and f.get("type") == "command"]


async def test_an_update_is_sent_signed_and_confirmed_only_by_the_reconnect(pool, dist):
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=5))
    frame = await device.answer_command(conn, output="staged; restarting")
    sha = agent_dist.current().file_for("linux", "amd64")["sha256"]
    assert frame["envelope"]["capability"] == "daemon.update"
    assert frame["envelope"]["args"] == {"version": VERSION, "sha256": sha, "path": "/api/v1/agent/dist/novad-linux-amd64"}
    await asyncio.sleep(0.3)
    assert not run.done(), "a reply is a claim: nothing is confirmed until the agent reconnects on the new build"
    await _close(conn, task)
    conn2, task2 = await _reconnect(pool, device, _facts(VERSION))
    outcome = await asyncio.wait_for(run, 6)
    assert (outcome.outcome, outcome.version, outcome.from_version) == ("confirmed", VERSION, OLD)
    assert await pool.fetchval("SELECT outcome FROM agent_updates WHERE device_id = $1", device_id) == "confirmed"
    await _close(conn2, task2)


async def test_a_reconnect_reporting_a_rollback_marks_the_attempt_rolled_back(pool, dist):
    _id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=5))
    await device.answer_command(conn)
    await _close(conn, task)
    rolled = {"version": VERSION, "outcome": "rolled_back", "reason": "the new build did not connect within 2m0s", "at": "2026-09-28T12:00:00Z"}
    conn2, task2 = await _reconnect(pool, device, _facts(OLD, update=rolled))
    outcome = await asyncio.wait_for(run, 6)
    assert outcome.outcome == "rolled_back" and "did not connect" in outcome.reason
    await _close(conn2, task2)


async def test_no_reconnect_within_ten_minutes_is_not_confirmed(pool, dist):
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2))
    await device.answer_command(conn)
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    await pool.execute("UPDATE agent_updates SET sent_at = now() - interval '11 minutes' WHERE device_id = $1", device_id)
    assert await agent_updates.expire_stale(pool) == 1
    assert await pool.fetchval("SELECT outcome FROM agent_updates WHERE device_id = $1", device_id) == "not_confirmed"
    await _close(conn, task)


async def test_one_update_in_flight_at_a_time(pool, dist):
    _a, first, conn_a, task_a = await _online(pool, "box-a", _facts(OLD))
    _b, _second, conn_b, task_b = await _online(pool, "box-b", _facts(OLD))
    run = asyncio.create_task(agent_updates.update_now(pool, name="box-a", requested_by="nova", wait_s=0.2))
    await first.answer_command(conn_a)
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    second = await agent_updates.update_now(pool, name="box-b", requested_by="owner", wait_s=0)
    assert second.outcome == "cannot" and "box-a is still in flight" in second.reason
    assert _commands(conn_b) == []
    await _close(conn_a, task_a)
    await _close(conn_b, task_b)


async def test_an_agent_on_the_hubs_build_is_left_alone(pool, dist):
    _id, _device, conn, task = await _online(pool, "box", _facts(VERSION))
    outcome = await agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0)
    assert outcome.outcome == "current" and _commands(conn) == []
    await _close(conn, task)


async def test_a_hand_started_agent_is_a_stated_cannot(pool, dist):
    _id, _device, conn, task = await _online(pool, "box", _facts(OLD, mode="foreground"))
    outcome = await agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0)
    assert outcome.outcome == "cannot" and outcome.needs_card and "started by hand" in outcome.reason
    assert _commands(conn) == []
    await _close(conn, task)


async def test_an_offline_agent_is_a_stated_cannot(pool, dist):
    _id, _device, conn, task = await _online(pool, "box", _facts(OLD))
    await _close(conn, task)
    outcome = await agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0)
    assert outcome.outcome == "cannot" and "not connected" in outcome.reason


async def test_an_agent_without_the_capability_on_a_systemd_unit_is_bootstrapped_through_its_hands(pool, dist, tailnet):
    device_id, device, conn, task = await _online(pool, "box", _facts(OLD))
    entry = agent_dist.current().file_for("linux", "amd64")
    target = f"/home/sam/.cache/nova-update/{VERSION}/novad"
    run = asyncio.create_task(agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2))
    await device.answer_command(conn, ok=False, exit_code=None, error='unknown capability "daemon.update"')
    info = await device.answer_command(conn, output="host=box; os=Test OS; home=/home/sam")
    assert info["envelope"]["capability"] == "system.info"
    argvs = []
    for output in ("", f"{entry['sha256']}  {target}\n", "", "installed; the service restarts into it in 5 s"):
        frame = await device.answer_command(conn, output=output)
        argvs.append(frame["envelope"]["args"]["argv"])
    assert argvs == [
        ["curl", "-fsSL", "--create-dirs", "-o", target, "https://nova.fake-tailnet.ts.net/api/v1/agent/dist/novad-linux-amd64"],
        ["sha256sum", target],
        ["chmod", "0755", target],
        [target, "install", "--restart-later"],
    ]
    assert (await asyncio.wait_for(run, 3)).outcome == "sent"
    assert await pool.fetchval("SELECT path FROM agent_updates WHERE device_id = $1", device_id) == "bootstrap"
    await _close(conn, task)


async def test_a_bootstrap_whose_hash_does_not_match_runs_nothing(pool, dist, tailnet):
    _id, device, conn, task = await _online(pool, "box", _facts(OLD))
    run = asyncio.create_task(agent_updates.update_now(pool, name="box", requested_by="nova", wait_s=0.2))
    await device.answer_command(conn, ok=False, exit_code=None, error='unknown capability "daemon.update"')
    await device.answer_command(conn, output="host=box; home=/home/sam")
    await device.answer_command(conn)                               # curl
    await device.answer_command(conn, output=f"{'0' * 64}  /x\n")  # sha256sum: not the hub's
    outcome = await asyncio.wait_for(run, 3)
    assert outcome.outcome == "refused" and "nothing was run" in outcome.reason
    assert len(_commands(conn)) == 4, "no chmod and no install after a mismatch"
    await _close(conn, task)


async def test_the_reconciler_sends_the_hubs_agent_first(pool, dist):
    _a, _laptop, conn_a, task_a = await _online(pool, "aaa-laptop", _facts(OLD))
    _h, hub_device, conn_h, task_h = await _online(pool, "minipc", _facts(OLD), door="host")
    job = asyncio.create_task(agent_updates.reconcile(pool))
    await hub_device.answer_command(conn_h)
    words = await asyncio.wait_for(job, 5)
    assert "to minipc — the hub's own agent first" in words and _commands(conn_a) == []
    await _close(conn_a, task_a)
    await _close(conn_h, task_h)


async def test_the_reconciler_waits_while_an_update_is_in_flight(pool, dist):
    device_id, _device = await _enroll(pool, name="box")
    await pool.execute(
        "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by) VALUES ($1, $2, $3, 'capability', 'nova')",
        device_id, VERSION, "c" * 64,
    )
    assert (await agent_updates.reconcile(pool)).startswith("waiting on box")


async def test_the_reconciler_never_resends_a_version_that_failed(pool, dist):
    device_id, _device = await _enroll(pool, name="box")
    await pool.execute(
        "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by, outcome, outcome_at, reason) "
        "VALUES ($1, $2, $3, 'capability', 'reconciler', 'rolled_back', now(), 'did not connect')",
        device_id, VERSION, "c" * 64,
    )
    assert (await agent_updates.reconcile(pool)).startswith(f"halted: the hub's build {VERSION} rolled_back on box")


async def test_the_reconciler_skips_a_busy_machine(pool, dist):
    device_id, _device, conn, task = await _online(pool, "box", _facts(OLD))
    devices_ws.hub._last_command[str(device_id)] = time.monotonic()
    words = await agent_updates.reconcile(pool)
    assert "box (busy" in words and _commands(conn) == []
    await _close(conn, task)


async def test_the_job_is_seeded_every_fifteen_minutes(pool):
    assert "agent_updates" in await timers.ensure_jobs(pool)
    row = await pool.fetchrow("SELECT schedule FROM timers WHERE payload->>'handler' = 'agent_updates'")
    assert row["schedule"] == {"kind": "minutes", "every": 15}


async def test_the_check_names_a_hand_started_agent_that_is_behind(pool, dist):
    _id, _device, conn, task = await _online(pool, "box", _facts(OLD, mode="foreground"))
    findings = await device_checks.agents_behind(None, pool)
    assert len(findings) == 1 and "started by hand" in findings[0].title
    assert findings[0].facts == {"device": "box", "hub_version": VERSION, "why": "by_hand"}
    await _close(conn, task)


async def test_the_update_route_answers_with_the_outcome(owner_client, pool, dist):
    device_id, _device = await _enroll(pool, name="box")
    resp = await owner_client.post(f"/api/v1/devices/{device_id}/update")
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"] == "cannot" and "not connected" in body["reason"]
```

In `test_devices_ws.py`'s `_clean_hub`, clear `devices_ws.hub._last_command` beside the other two.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_agent_updates.py 2>&1 | tail -4`
Expected: FAIL — `cannot import name 'agent_updates'`.

- [ ] **Step 3: The hub counts commands; a reconnect decides an open attempt**

`devices_ws.Hub`: `__init__` adds `self._last_command: dict[str, float] = {}`; `command` sets `self._last_command[did] = time.monotonic()` just before `conn.send` (import `time`); and:

```python
    def in_flight(self, device_id: str | uuid.UUID) -> int:
        """Commands core sent this device that have not answered yet."""
        return len(self._pending.get(str(device_id), {}))

    def idle(self, device_id: str | uuid.UUID, quiet_s: float) -> bool:
        """Connected, nothing in flight, and no command sent in the last
        quiet_s (S42b P10) — when restarting its agent cuts nothing off."""
        did = str(device_id)
        if did not in self._conns or self._pending.get(did):
            return False
        last = self._last_command.get(did)
        return last is None or time.monotonic() - last >= quiet_s
```

`_record_auth_facts` returns the dict it stored (or `None`), and `authenticate`, after it:

```python
    clean = await _record_auth_facts(pool, device_id, frame.get("facts"))
    try:
        # Imported here: agent_updates imports this module (its hub).
        from app import agent_updates

        await agent_updates.observe_connect(pool, device_id, clean)
    except Exception:  # noqa: BLE001 — an update's bookkeeping never refuses a socket
        logger.exception("device %s: its open update could not be decided", device_id)
```

- [ ] **Step 4: `agent_updates`**

`services/core/app/agent_updates.py`:

```python
"""Keeping Nova's agents on the hub's build (S42b decision 2).

The desired state is the hub's build (agent_dist). An agent is behind when the
version it reports is not that build's — a hash has no order, so behind never
means "older" — and that is derived on every read (device_facts.build_state).

What is stored is each ATTEMPT (agent_updates): who asked, what was sent, what
came back. An attempt stays `sent` until the device's next authenticated
connection decides it (observe_connect): `confirmed` when it reports the
version it was sent, `rolled_back` when its supervisor put the old build back
and says so. Ten minutes with neither is `not_confirmed`; an agent that
answered no is `refused`. No sentence confirms an update — only a reconnect
(P8). One `sent` row at a time, for everyone: the database's own index (P9).

Two ways to send (P11): the daemon.update capability (S42b agents), or — for
an S42a Linux agent under the README's systemd unit, which answers `unknown
capability "daemon.update"` — its own shell.exec, every argv composed HERE and
the build run only after core compared its sha256. Anything else is a stated
cannot naming the one step the owner takes (P12).

The timer job `agent_updates` (timers.JOBS) runs reconcile() every 15
minutes: one idle machine at a time, the hub's own agent first, never a
version that already failed anywhere (P10).
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime

import asyncpg

from app import agent_card, agent_dist, device_facts, devices, devices_ws, network

logger = logging.getLogger("core")

CONFIRM_WITHIN_S = 600
IDLE_S = 300
WAIT_S = 120
COMMAND_TIMEOUT_S = 120
UNKNOWN_CAPABILITY = 'unknown capability "daemon.update"'
FAILED = ("rolled_back", "not_confirmed", "refused")

_OPEN_SQL = (
    "INSERT INTO agent_updates (device_id, from_version, version, sha256, path, requested_by) "
    "VALUES ($1, $2, $3, $4, 'capability', $5) RETURNING id"
)
_IN_FLIGHT_SQL = (
    "SELECT d.name, u.version, u.sent_at FROM agent_updates u JOIN devices d ON d.id = u.device_id "
    "WHERE u.outcome = 'sent'"
)
_HOME = re.compile(r"(?:^|;\s*)home=([^;]+)")


@dataclass(frozen=True)
class UpdateOutcome:
    machine: str
    outcome: str
    version: str | None
    from_version: str | None
    reason: str | None = None
    attempt_id: uuid.UUID | None = None
    at: datetime | None = None
    needs_card: bool = False
    in_flight: int = 0


class _BootstrapRefused(Exception):
    pass


def _cannot(name: str, reason: str, *, version=None, from_version=None, needs_card=False) -> UpdateOutcome:
    return UpdateOutcome(machine=name, outcome="cannot", version=version, from_version=from_version,
                         reason=reason, needs_card=needs_card)


async def expire_stale(pool) -> int:
    rows = await pool.fetch(
        "UPDATE agent_updates SET outcome = 'not_confirmed', outcome_at = now(), reason = $1 "
        "WHERE outcome = 'sent' AND sent_at < now() - make_interval(secs => $2) RETURNING id",
        f"no reconnect reporting the new build within {CONFIRM_WITHIN_S // 60} minutes",
        CONFIRM_WITHIN_S,
    )
    return len(rows)


async def _close(pool, attempt_id, outcome: str, reason: str | None) -> None:
    await pool.execute(
        "UPDATE agent_updates SET outcome = $2, outcome_at = now(), reason = $3 WHERE id = $1 AND outcome = 'sent'",
        attempt_id, outcome, reason,
    )


async def observe_connect(pool, device_id, facts: dict | None) -> None:
    """Decide the device's open attempt from what it said at its reconnect (P8)."""
    open_ = await pool.fetchrow(
        "SELECT id, version FROM agent_updates WHERE device_id = $1 AND outcome = 'sent'", device_id
    )
    if open_ is None:
        return
    if device_facts.agent_version(facts) == open_["version"]:
        await _close(pool, open_["id"], "confirmed", None)
        return
    update = ((facts or {}).get("agent") or {}).get("update") or {}
    if update.get("version") == open_["version"] and update.get("outcome") == "rolled_back":
        await _close(pool, open_["id"], "rolled_back", update.get("reason") or "its supervisor put the previous build back")


async def update_now(pool, *, name: str, requested_by: str, wait_s: float = WAIT_S) -> UpdateOutcome:
    """Send the hub's build to `name` now and wait up to wait_s for its
    reconnect to decide the attempt. A command already running there ends
    "cancelled" when the agent restarts (P25); in_flight says how many."""
    await expire_stale(pool)
    row = await devices.get_live_by_name(pool, name)
    if row is None:
        return _cannot(name, f"cannot: no paired machine named {name!r}")
    try:
        build = await agent_dist.read()
    except agent_dist.DistUnavailable as exc:
        return _cannot(name, f"cannot: the hub has no agent build to send — {exc}")
    facts = row["facts"]
    current = device_facts.agent_version(facts)
    if current == build.version:
        return UpdateOutcome(machine=name, outcome="current", version=build.version, from_version=current)
    kw = {"version": build.version, "from_version": current}
    if not devices_ws.hub.is_connected(row["id"]):
        seen = row["last_seen"].isoformat() if row["last_seen"] else "never"
        return _cannot(name, f"cannot: {name} is not connected (last seen {seen}); Nova updates it when it next connects and is idle", **kw)
    if facts is None:
        return _cannot(name, f"cannot: {name}'s agent predates S42a and says nothing about how it runs, so Nova cannot restart it — run the command on {name}'s setup card there", needs_card=True, **kw)
    mode = (facts.get("agent") or {}).get("mode")
    if mode not in device_facts.SERVICE_MODES:
        return _cannot(name, f"cannot: {name}'s agent was started by hand, not by its service, so Nova cannot restart it — close the window it runs in, then run the command on {name}'s setup card there", needs_card=True, **kw)
    os_ = facts.get("os") or {}
    entry = build.file_for(os_.get("goos"), os_.get("arch"))
    if entry is None:
        return _cannot(name, f"cannot: the hub has no build for {os_.get('goos')}/{os_.get('arch')}", **kw)
    in_flight = devices_ws.hub.in_flight(row["id"])
    try:
        attempt_id = await pool.fetchval(_OPEN_SQL, row["id"], current, build.version, entry["sha256"], requested_by)
    except asyncpg.UniqueViolationError:
        busy = await pool.fetchrow(_IN_FLIGHT_SQL)
        return _cannot(name, f"cannot now: an update to {busy['name']} is still in flight (sent {busy['sent_at'].isoformat()}) — one machine at a time", **kw)
    try:
        result = await devices_ws.hub.command(
            pool, device_id=row["id"], name=name, capability="daemon.update",
            args={"version": build.version, "sha256": entry["sha256"], "path": f"/api/v1/agent/dist/{entry['name']}"},
            timeout=COMMAND_TIMEOUT_S,
        )
    except devices.DeviceRefused as exc:
        # No answer: it may have staged and left before its reply got out.
        # Only its reconnect can say, so the attempt stays open.
        logger.info("update of %s: no answer (%s); waiting for its reconnect", name, exc.reason)
        return await _await(pool, attempt_id, name, kw, wait_s, in_flight)
    if result.get("ok"):
        return await _await(pool, attempt_id, name, kw, wait_s, in_flight)
    error = str(result.get("error") or "it refused without a reason")
    if UNKNOWN_CAPABILITY in error:
        if os_.get("goos") == "linux" and mode == "systemd-user":
            await pool.execute("UPDATE agent_updates SET path = 'bootstrap' WHERE id = $1", attempt_id)
            try:
                await _bootstrap(pool, row, build, entry)
            except _BootstrapRefused as exc:
                await _close(pool, attempt_id, "refused", str(exc))
                return UpdateOutcome(machine=name, outcome="refused", reason=str(exc), attempt_id=attempt_id, **kw)
            return await _await(pool, attempt_id, name, kw, wait_s, in_flight)
        reason = (f"cannot: {name}'s agent predates Nova-managed updates, and on {os_.get('goos')} it cannot be "
                  f"updated through its own hands — run the command on {name}'s setup card there")
        await _close(pool, attempt_id, "refused", reason)
        return UpdateOutcome(machine=name, outcome="cannot", reason=reason, attempt_id=attempt_id, needs_card=True, **kw)
    await _close(pool, attempt_id, "refused", error)
    return UpdateOutcome(machine=name, outcome="refused", reason=error, attempt_id=attempt_id, **kw)


async def _await(pool, attempt_id, name: str, kw: dict, wait_s: float, in_flight: int) -> UpdateOutcome:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait_s
    while True:
        row = await pool.fetchrow("SELECT outcome, outcome_at, reason FROM agent_updates WHERE id = $1", attempt_id)
        if row["outcome"] != "sent" or loop.time() >= deadline:
            return UpdateOutcome(machine=name, outcome=row["outcome"], reason=row["reason"], attempt_id=attempt_id,
                                 at=row["outcome_at"], in_flight=in_flight, **kw)
        await asyncio.sleep(0.5)


async def _run(pool, row, capability: str, args: dict) -> dict:
    try:
        return await devices_ws.hub.command(pool, device_id=row["id"], name=row["name"], capability=capability,
                                            args=args, timeout=COMMAND_TIMEOUT_S)
    except devices.DeviceRefused as exc:
        raise _BootstrapRefused(f"{row['name']} stopped answering during the update: {exc.reason}") from exc


async def _exec(pool, row, argv: list[str], step: str) -> str:
    result = await _run(pool, row, "shell.exec", {"argv": argv})
    if not result.get("ok") or result.get("exit_code") != 0:
        said = (result.get("error") or result.get("output") or "").strip()[-300:]
        raise _BootstrapRefused(f"the {step} step failed on {row['name']} (exit {result.get('exit_code')}): {said}")
    return result.get("output") or ""


def _origin_for(row) -> str:
    if row["last_transport"] == "host":
        return agent_card.LOOPBACK
    got = network.address()
    if got.origin is None:
        raise _BootstrapRefused(f"Nova has no address {row['name']} can download from — {got.reason}")
    return got.origin


async def _bootstrap(pool, row, build, entry: dict) -> None:
    """P11: an S42a Linux agent under the README's systemd unit, updated
    through its own shell.exec — every argv composed here, never by the model,
    and the new build run only after core compared its sha256. The new
    binary's `install --restart-later` restarts the unit from outside the old
    agent's own process tree (systemd-run), so this command's reply gets out."""
    info = await _run(pool, row, "system.info", {})
    match = _HOME.search(info.get("output") or "")
    if not match:
        raise _BootstrapRefused(f"{row['name']} did not say its home folder, so there is nowhere to put the download")
    target = f"{match.group(1).strip()}/.cache/nova-update/{build.version}/novad"
    origin = _origin_for(row)
    await _exec(pool, row, ["curl", "-fsSL", "--create-dirs", "-o", target, f"{origin}/api/v1/agent/dist/{entry['name']}"], "download")
    got = ((await _exec(pool, row, ["sha256sum", target], "checksum")).split() or [""])[0]
    if got != entry["sha256"]:
        raise _BootstrapRefused(
            f"the download's sha256 on {row['name']} is {got[:12]}…, not the hub's {entry['sha256'][:12]}… — nothing was run"
        )
    await _exec(pool, row, ["chmod", "0755", target], "chmod")
    await _exec(pool, row, [target, "install", "--restart-later"], "install")


def _why_not(row) -> str | None:
    if not devices_ws.hub.is_connected(row["id"]):
        return "offline"
    facts = row["facts"]
    if facts is None:
        return "it reports no facts (it predates S42a)"
    if (facts.get("agent") or {}).get("mode") not in device_facts.SERVICE_MODES:
        return "started by hand"
    if not devices_ws.hub.idle(row["id"], IDLE_S):
        return "busy (a command within the last 5 minutes)"
    return None


async def reconcile(pool) -> str:
    """The job's one pass (P10): at most ONE update sent, and the words the
    firing records."""
    await expire_stale(pool)
    busy = await pool.fetchrow(_IN_FLIGHT_SQL)
    if busy:
        return f"waiting on {busy['name']}: {busy['version']} sent at {busy['sent_at'].isoformat()}, not confirmed yet"
    try:
        build = await agent_dist.read()
    except agent_dist.DistUnavailable as exc:
        return f"nothing to do: {exc}"
    failed = await pool.fetchrow(
        "SELECT d.name, u.outcome, u.reason FROM agent_updates u JOIN devices d ON d.id = u.device_id "
        "WHERE u.version = $1 AND u.outcome = ANY($2::text[]) ORDER BY u.sent_at DESC LIMIT 1",
        build.version, list(FAILED),
    )
    if failed:
        return (f"halted: the hub's build {build.version} {failed['outcome']} on {failed['name']} "
                f"({failed['reason']}) — it is not sent to another machine on its own; machine_update can still send it")
    rows = await pool.fetch("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY name")
    behind = [r for r in rows if device_facts.agent_version(r["facts"]) != build.version]
    if not behind:
        return f"every agent runs the hub's build {build.version}"
    hub_first = [r for r in behind if r["last_transport"] == "host"]
    skipped = []
    for r in hub_first or behind:
        why = _why_not(r)
        if why:
            skipped.append(f"{r['name']} ({why})")
            continue
        out = await update_now(pool, name=r["name"], requested_by="reconciler", wait_s=0)
        first = " — the hub's own agent first" if hub_first else ""
        tail = f": {out.reason}" if out.reason else ""
        return f"sent the hub's build {build.version} to {r['name']}{first}; {out.outcome}{tail}"
    wait = "; the others wait for the hub's own agent" if hub_first else ""
    return "nothing sent: " + "; ".join(skipped) + wait
```

- [ ] **Step 5: The job, the check, the route**

At the bottom of `timers.py`:

```python
# S42b (decision 2): keeping Nova's agents on the hub's build, one idle machine
# at a time, the hub's own first (app/agent_updates.py). Every 15 minutes: 96
# small `job` turns a day on the trace (P10). Imported here so JOBS is whole
# before ensure_jobs reads it.
from app import agent_updates  # noqa: E402

JOBS["agent_updates"] = agent_updates.reconcile
JOB_SCHEDULES["agent_updates"] = {"kind": "minutes", "every": 15}
JOB_TITLES["agent_updates"] = "Keep Nova's agents on the hub's build — one idle machine at a time, the hub's own first"
```

The three `ensure_jobs(pool) == ["retention"]` pins (`test_timers.py:380`, `test_timers_api.py:342,700,772`) become `== ["retention", "agent_updates"]`, and any pin on the number of job rows moves from 1 to 2 — deliberately, the commit says why.

`checks/devices.py` adds:

```python
_BEHIND_SQL = """
SELECT d.id, d.name, d.facts, u.outcome AS u_outcome, u.reason AS u_reason
  FROM devices d
  LEFT JOIN LATERAL (SELECT outcome, reason FROM agent_updates a
                      WHERE a.device_id = d.id AND a.version = $1 ORDER BY a.sent_at DESC LIMIT 1) u ON true
 WHERE d.revoked_at IS NULL
 ORDER BY d.name
"""


def _stale(built_at: str) -> bool:
    try:
        built = datetime.fromisoformat(built_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return datetime.now(UTC) - built > timedelta(days=1)


async def agents_behind(app, pool) -> list[Finding]:
    """An agent behind the hub's build that Nova cannot, or did not manage to,
    update. One the job will update at its next idle moment is not news."""
    try:
        build = await agent_dist.read()
    except agent_dist.DistUnavailable as exc:
        raise CannotCheck(f"the hub has no agent build to compare with — {exc}") from exc
    stale = _stale(build.built_at)
    findings = []
    for r in await pool.fetch(_BEHIND_SQL, build.version):
        facts = r["facts"]
        if device_facts.agent_version(facts) == build.version:
            continue
        if facts is None:
            why, token = "it reports no facts (it predates S42a), so Nova cannot update it — run the command on its setup card", "no_facts"
        elif (facts.get("agent") or {}).get("mode") not in device_facts.SERVICE_MODES:
            why, token = "it was started by hand, so Nova cannot restart it — close its window and run the command on its setup card", "by_hand"
        elif r["u_outcome"] in agent_updates.FAILED:
            why, token = f"its update {r['u_outcome']}: {r['u_reason']}", f"failed:{r['u_outcome']}"
        elif stale:
            why, token = "it has been behind for over a day (offline, or never idle)", "stale"
        else:
            continue
        findings.append(Finding(
            key=f"agent_behind:{r['id']}",
            title=f"{r['name']}'s agent is behind the hub's build {build.version}: {why}",
            facts={"device": r["name"], "hub_version": build.version, "why": token},
        ))
    return findings
```

and `CHECKS` gains `Check(name="devices_agents_behind", describe="An agent behind the hub's build that Nova cannot, or did not manage to, update.", urgent=False, run=agents_behind)` (imports: `from datetime import UTC, datetime, timedelta`, `from app import agent_dist, agent_updates, device_facts`, `from app.checks import CannotCheck, Check, Finding`). `test_checks`' urgent set is unchanged; a pin of every check's name gains this one.

`devices_api.py`:

```python
@router.post("/{device_id}/update")
async def update_device(device_id: uuid.UUID, _person: Person = Depends(identity.require_person)) -> dict:
    """The tile's Update: send the hub's build now (decision 2's "update it
    now"). The answer says what happened — sent, or a cannot with its one
    step — and never "updated": only the agent's reconnect says that."""
    from app import agent_updates

    pool = await db.get_pool()
    row = await devices.get_live(pool, device_id)
    if row is None:
        raise HTTPException(status_code=404, detail="no paired device with that id")
    o = await agent_updates.update_now(pool, name=row["name"], requested_by="owner", wait_s=0)
    return {"outcome": o.outcome, "version": o.version, "from_version": o.from_version,
            "reason": o.reason, "needs_card": o.needs_card}
```

- [ ] **Step 6: Run the tests to verify they pass, then the suites these touch**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_agent_updates.py tests/test_devices_ws.py \
  tests/test_timers.py tests/test_timers_api.py tests/test_scheduler.py tests/test_checks.py tests/test_checks_devices.py tests/test_beats.py 2>&1 | tail -3
uv run ruff check app tests && uv run ruff format app/agent_updates.py app/devices_ws.py app/timers.py app/checks/devices.py app/devices_api.py tests/test_agent_updates.py tests/test_devices_ws.py
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/agent_updates.py services/core/app/devices_ws.py services/core/app/timers.py services/core/app/checks/devices.py \
  services/core/app/devices_api.py services/core/tests/test_agent_updates.py services/core/tests/test_devices_ws.py services/core/tests/test_timers.py \
  services/core/tests/test_timers_api.py
git -C $W commit -m "feat(core): Nova keeps her agents on the hub's build — confirmed only by the reconnect, one machine at a time, the hub's own first"
git -C $W show --stat HEAD | tail -5
```

---
## Task 21: The device tools — `device_list` from the plant, `device_info` probes again, `@folder` paths, the argv contract

**Files:**
- Modify: `services/core/app/tools/devices.py`
- Modify: `services/core/tests/test_state_guard.py` (two pins move: `device_list` stops reading `connected_ids()` and becomes a `.agents(...)` consumer)
- Test: `services/core/tests/test_devices_ws.py`

**Interfaces:**
- Consumes: `machines.plant().agents(app)` — each view with `hub`, `build`, `folders`, `acting`, `roles`, `wsl`, `agent_version`, `last_seen` (Tasks 16, 16b, 18); `devices.last_refused_at` (Tasks 14, 17); `device_facts.FOLDER_NAMES`, `folders_of`, `acting_lines`, `runs_line`; Task 1's `wsl.exe` shell branch.
- Produces:
  - `device_list`: one line per agent — `- <name> (<place>) — connected|offline, last seen <t>[; the hub's own machine]; agent <v> (the hub's build | behind the hub's build <h> | …)[; hands: <cannot>][; folders: @desktop, …]` — then that agent's `acting_lines`, indented four spaces; then `Revoked, but their agents knocked in the last day:` and one line per such row. Each listed agent leaves `{"device", "connected"}` on the turn.
  - `_check_fs_path(path, platform, folders=(), name="this device")`: `@home|@desktop|@documents|@downloads[/rest]` passes through unresolved when the agent reported that folder; otherwise a stated *cannot*.
  - `device_info`: `facts.refresh`, then `system.info`, then the acting lines.

- [ ] **Step 1: Write the failing tests**

Append to `services/core/tests/test_devices_ws.py` (imports gain `from app import tools as _tools_registry` only if `tools` is not already imported — it is — and `from tests.test_device_facts import PROBED`):

```python
# -- S42b: device_list from the plant, the knocks, the facts she acts on -------


async def _wait_for_facts_key(pool, device_id, key: str) -> None:
    for _ in range(100):
        facts = await pool.fetchval("SELECT facts FROM devices WHERE id = $1", device_id)
        if facts and key in facts:
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"the facts frame's {key!r} never landed")


async def test_device_list_says_what_she_needs_to_act_on_a_windows_agent(pool):
    """P29, Review Focus 14: the Windows agent's own look at itself and at WSL,
    in device_list's words — the facts turn 01faf3b7 did not have."""
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed(PROBED)
    await _wait_for_facts_key(pool, device_id, "wsl_distros")
    person = await _person(pool)
    sink: list[dict] = []
    result, ok = await tools.dispatch("device_list", {}, _ctx(person, facts=sink))
    assert ok is True
    assert "- dell (Windows 11 Pro 24H2 (build 26100)) — connected" in result
    assert "\n    how it runs: service HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Nova agent" in result
    assert "sam's systemd user unit novad.service is active (enabled, Restart=always, main pid 412)" in result
    assert {"device": "dell", "connected": True} in sink
    await _close(conn, task)


async def test_device_list_says_an_agent_inside_wsl_gives_way_to_the_windows_build(pool):
    device_id, device = await _enroll(pool, name="pc-wsl")
    wsl = {**AUTH_FACTS, "os": {"goos": "linux", "arch": "amd64", "version": "Ubuntu 26.04 LTS", "wsl": {"distro": "Ubuntu-26.04"}}}
    conn, task, _ = await _auth_with(pool, device_id, device, wsl)
    person = await _person(pool)
    result, _ok = await tools.dispatch("device_list", {}, _ctx(person))
    assert (
        "hands: cannot: this machine's Windows agent owns it — on Windows, Nova's agent is the Windows "
        "build, which reaches WSL through wsl.exe" in result
    )
    await _close(conn, task)


async def test_device_list_says_a_revoked_agent_is_still_knocking_and_when_it_stopped(pool):
    """P28, Review Focus 10: the knock record is the check that it stopped."""
    old_id, _ = await _enroll(pool, name="old-wsl")
    gone_id, _ = await _enroll(pool, name="older")
    await pool.execute(
        "UPDATE devices SET revoked_at = now() - interval '1 hour', last_refused_at = now() - interval '20 seconds' WHERE id = $1",
        old_id,
    )
    await pool.execute(
        "UPDATE devices SET revoked_at = now() - interval '2 hours', last_refused_at = now() - interval '30 minutes' WHERE id = $1",
        gone_id,
    )
    person = await _person(pool)
    result, ok = await tools.dispatch("device_list", {}, _ctx(person))
    assert ok is True and "Revoked, but their agents knocked in the last day:" in result
    lines = result.splitlines()
    old = next(line for line in lines if line.startswith("- old-wsl (revoked "))
    assert "still knocking (last " in old
    assert "the README's systemd user unit novad" in old and "wsl.exe -d <distro> --" in old
    older = next(line for line in lines if line.startswith("- older (revoked "))
    assert "no knock since " in older and "it stopped then" in older


async def test_a_folder_token_for_an_agent_that_reports_no_folders_is_a_stated_cannot(pool):
    """Review Focus 8: an S42a agent reports no folders, so @desktop cannot be sent."""
    _id, _device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)
    result, ok = await tools.dispatch("device_list_files", {"device": "laptop", "path": "@desktop"}, _ctx(person))
    assert ok is False and "cannot: laptop's agent did not report its desktop folder" in result
    assert _command_frames(conn) == []
    await _close(conn, task)


async def test_a_folder_token_reaches_the_agent_unresolved_when_it_reported_the_folder(pool):
    """P16: resolved ON the machine, as its OS names it."""
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed({"type": "facts", "folders": {"desktop": "C:\\Users\\sam\\OneDrive\\Desktop"}})
    await _wait_for_facts_key(pool, device_id, "folders")
    person = await _person(pool)
    ans = asyncio.create_task(device.answer_command(conn, output="entries in C:\\Users\\sam\\OneDrive\\Desktop\\notes"))
    result, ok = await tools.dispatch("device_list_files", {"device": "dell", "path": "@desktop/notes"}, _ctx(person))
    frame = await asyncio.wait_for(ans, 2)
    assert ok is True and frame["envelope"]["args"] == {"path": "@desktop/notes"}
    await _close(conn, task)


async def test_device_info_probes_again_and_says_how_the_agent_runs(pool):
    """P29, Review Focus 14: device_info asks for a fresh look first — its
    facts frame lands before its result — so the lines are the agent's look now."""
    device_id, device = await _enroll(pool, name="dell", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    person = await _person(pool)

    async def answer():
        refresh = await asyncio.wait_for(conn.next_sent(), 2)
        assert refresh["envelope"]["capability"] == "facts.refresh"
        conn.feed(PROBED)
        conn.feed(device.result(refresh["envelope"]))
        info = await asyncio.wait_for(conn.next_sent(), 2)
        assert info["envelope"]["capability"] == "system.info"
        conn.feed(device.result(info["envelope"], output="host=PC-ONE; os=Windows 11 Pro"))

    ans = asyncio.create_task(answer())
    result, ok = await tools.dispatch("device_info", {"device": "dell"}, _ctx(person))
    await asyncio.wait_for(ans, 2)
    assert ok is True
    assert result.startswith("dell system info:\nhost=PC-ONE; os=Windows 11 Pro\nhow it runs: service ")
    assert "WSL on it, reached through this agent's wsl.exe: Ubuntu-26.04 (default" in result
    assert result.endswith("(probed 2026-09-28T17:40:00Z; device_info probes again)")
    await _close(conn, task)


def test_device_run_states_the_argv_contract_and_that_nothing_gets_a_terminal():
    """P29/P30: how a command runs is stated where she reads the tool."""
    description = tools.REGISTRY["device_run"].description
    assert "no shell" in description and "$(…)" in description and '["sh", "-c"' in description
    assert "no terminal and empty input" in description and "fails at once" in description
```

In `test_state_guard.py`: delete the `("tools/devices.py", "device_list")` entry from `_ALLOWED_CONNECTIVITY_SITES` (it no longer reads `connected_ids()`), and add `("tools/devices.py", "device_list")` to `_AGENTS_CALL_CONSUMERS` — a deliberate pin move: `device_list` now reads the plant, and records `{device, connected}` for every agent it lists, the same record `_describe_agents` leaves.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_devices_ws.py -k "device_list or folder_token or probes_again or argv_contract" 2>&1 | tail -8`
Expected: FAIL — no `how it runs:` line, no knocks section, `@desktop` refused as not absolute, `device_info` sends only `system.info`.

- [ ] **Step 3: Implement**

In `tools/devices.py` (imports gain `from datetime import UTC, datetime, timedelta` and `machines` in the `from app import …` line):

```python
async def device_list(args: dict, ctx: ToolContext) -> str:
    """Nova's agents as the plant lists them (S42b P17 — an eval's declared
    device too), each with what she needs to act on it without being told
    (P29), then any revoked agent still knocking (P28). Every agent listed
    leaves {device, connected} on the turn — the record every device tool
    leaves, so what she says about its connection is backed."""
    pool = await db.get_pool()
    agents = await machines.plant().agents(ctx.app)
    lines: list[str] = []
    for agent in agents:
        lines.append(_agent_line(agent))
        lines.extend(f"    {line}" for line in agent["acting"])
        if ctx.facts_sink is not None:
            ctx.facts_sink.append({"device": agent["name"], "connected": agent["connected"]})
    knocks = await _knocks(pool)
    out = ["Paired devices:", *lines] if lines else ["No devices are paired. Pair one in Settings → Devices."]
    if knocks:
        out += ["Revoked, but their agents knocked in the last day:", *knocks]
    return "\n".join(out)


def _build_words(agent: dict) -> str:
    version, build = agent["agent_version"], agent["build"]
    if version is None:
        return "agent version unknown (it reports no facts)"
    if build["state"] == "current":
        return f"agent {version} (the hub's build)"
    if build["state"] == "behind":
        return f"agent {version} (behind the hub's build {build['hub_version']})"
    return f"agent {version} (the hub has no build to compare it with)"


def _agent_line(agent: dict) -> str:
    status = "connected" if agent["connected"] else "offline"
    line = f"- {agent['name']} ({device_facts.place(agent)}) — {status}, last seen {agent['last_seen'] or 'never'}"
    if agent["hub"]:
        line += "; the hub's own machine"
    line += f"; {_build_words(agent)}"
    hands = agent["roles"]["hands"]
    if hands["state"] == "cannot":
        line += f"; hands: {hands['reason']}"
        if agent["wsl"] is not None:
            line += " — on Windows, Nova's agent is the Windows build, which reaches WSL through wsl.exe"
    if agent["folders"]:
        line += "; folders: " + ", ".join(f"@{name}" for name in agent["folders"])
    return line


# P28: a revoked agent that is still running knocks every 30 s; within this of
# its last verified knock it is "still knocking".
_KNOCKING_WITHIN = timedelta(minutes=2)
_BEFORE_S42B_LINUX = (
    "an agent from before S42b on Linux runs as the README's systemd user unit novad "
    "(binary ~/.local/bin/novad); inside WSL it is reached through that PC's Windows agent "
    "with wsl.exe -d <distro> -- …, and that agent's WSL facts say where it runs"
)


async def _knocks(pool) -> list[str]:
    rows = await pool.fetch(
        "SELECT name, platform, facts, revoked_at, last_refused_at FROM devices "
        "WHERE revoked_at IS NOT NULL AND last_refused_at > now() - interval '24 hours' "
        "ORDER BY last_refused_at DESC"
    )
    now = datetime.now(UTC)
    out = []
    for r in rows:
        knocked = r["last_refused_at"]
        state = (
            f"still knocking (last {knocked.isoformat()})"
            if now - knocked <= _KNOCKING_WITHIN
            else f"no knock since {knocked.isoformat()}: it stopped then"
        )
        line = f"- {r['name']} (revoked {r['revoked_at'].isoformat()}): {state}"
        if isinstance((r["facts"] or {}).get("service"), dict):
            line += "; " + device_facts.runs_line(r["facts"])
        elif r["platform"] == "linux":
            line += "; " + _BEFORE_S42B_LINUX
        out.append(line)
    return out


async def device_info(args: dict, ctx: ToolContext) -> str:
    """system.info, then what she needs to act on the machine (P29) — after a
    facts.refresh, whose frame core records before its result returns, so the
    lines are the agent's look just now, not the last one."""
    pool, row, _ = await _admit(args, ctx=ctx)
    stale = ""
    try:
        _require_ok(await _command(pool, row, "facts.refresh", {}, ctx=ctx), row)
    except ToolFailure as exc:
        stale = f"\n(could not probe again — {exc}; the lines above are its last probe's)"
    fresh = await devices.get(pool, row["id"])
    result = _require_ok(await _command(pool, row, "system.info", {}, ctx=ctx), row)
    detail = result.get("output") or "(the device returned no detail)"
    acting = "\n".join(device_facts.acting_lines(fresh["facts"], fresh["platform"]))
    return f"{row['name']} system info:\n{detail}\n{acting}{stale}"
```

The folder token, at the top of `_check_fs_path` (whose signature becomes `(path, platform, folders=(), name="this device")`):

```python
    if isinstance(path, str) and path.startswith("@"):
        m = _FOLDER_TOKEN.match(path)
        if m is None or m.group(1) not in device_facts.FOLDER_NAMES:
            known = ", ".join(f"@{n}" for n in device_facts.FOLDER_NAMES)
            raise ToolFailure(f"path {path!r}: a folder is one of {known}, then an optional /rest")
        if m.group(1) not in folders:
            raise ToolFailure(
                f"cannot: {name}'s agent did not report its {m.group(1)} folder (an agent from "
                "before S42b reports none) — give an absolute path instead"
            )
        # Resolved on the machine (S42b P16): its OS names the folder, not core.
        return path
```

with `_FOLDER_TOKEN = re.compile(r"^@([a-z]+)(?:[\\/](.*))?$", re.S)` beside the Windows patterns, and `_admit` passing `device_facts.folders_of(row["facts"]), row["name"]`.

Descriptions: `device_info` — "Report a paired device's OS, disk, memory and uptime and its home folder, and what Nova needs to act on it without being told: how its agent runs (the service, binary, config, process and account), whether elevating would ask a person, and on Windows the WSL distributions beside it and what runs in them. It asks the agent to look again first." `device_list` — "List the computers paired with Nova: the OS each runs, whether it is connected now and when it was last seen, whether it is the hub's own machine, its agent's build against the hub's, the folders it names, and how its agent runs — plus any revoked agent that is still knocking. Reads Nova's own records." The three fs tools add to their text: "Or name a known folder — @home, @desktop, @documents or @downloads, optionally followed by /the/rest — which the machine resolves as its own OS names it (OneDrive's Desktop on Windows)." and their `path` parameter reads "Absolute path in the device's own OS, or a known folder such as @desktop/notes.txt."

`device_run`'s description, on Task 1's branch where `-- echo $HOME` printed a path:

```python
        description=(
            "Run a command on a paired device. Give the command as argv — a list of strings, "
            'the program first (e.g. ["ls", "-la", "/tmp"]) — never a shell string. Nova\'s agent '
            "runs it with no shell: $(…), pipes, &&, globs and redirects reach the program exactly "
            'as written. To use them, run a shell yourself: ["sh", "-c", "…"] on Linux and macOS, '
            '["powershell", "-NoProfile", "-Command", "…"] on Windows. On Windows a built-in '
            'command runs through cmd: ["cmd", "/c", "dir", "C:\\\\Users"]; WSL is reached through '
            'wsl.exe: ["wsl.exe", "-d", "<distro>", "--", "uname", "-a"] — wsl.exe hands what '
            "follows -- to the distro's own shell, and --exec runs a program without one. A "
            "command runs with no terminal and empty input: anything that asks for input (a sudo "
            "password, a yes/no question) gets no answer and fails at once with its own message."
        ),
```

On the branch where it printed `$HOME`, the clause reads "— wsl.exe runs what follows -- as a program, with no shell either" instead.

- [ ] **Step 4: Run the tests to verify they pass, and the suites that read these tools**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_devices_ws.py tests/test_devices_e2e.py tests/test_state_guard.py \
  tests/test_presented_listing_guard.py tests/test_chat_state_claim.py tests/test_tools_registry.py tests/test_no_approvals.py 2>&1 | tail -3
uv run ruff format app/tools/devices.py tests/test_devices_ws.py tests/test_state_guard.py
```

Expected: pass. `test_no_approvals` unchanged and green: a folder the agent did not report is a *cannot* (the call cannot be sent as asked), never a *may not*.

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/tools/devices.py services/core/tests/test_devices_ws.py services/core/tests/test_state_guard.py
git -C $W commit -m "feat(core): device_list and device_info say what she needs to act unaided — how each agent runs, elevation, WSL, knocks, @folders

test_state_guard: device_list moves from a connected_ids() reporter to an .agents() consumer that records {device, connected} per agent."
git -C $W show --stat HEAD | tail -5
```

---

## Task 22: `machine_update` — "update it now", and `machine_status`'s agent line

**Files:**
- Modify: `services/core/app/machines.py` (`GatewayPlant.update_agent`; `FixturePlant(..., updates=)` and its `update_agent`)
- Modify: `services/core/app/tools/machines.py` (`machine_update`, `MACHINE_UPDATE`; `_describe_agent`)
- Modify: `services/core/tests/test_tools_registry.py` (the set: 43 → 44; the writers list)
- Test: `services/core/tests/test_tools_machines.py`, `services/core/tests/test_machines.py`

**Interfaces:**
- Consumes: `agent_updates.update_now` / `UpdateOutcome` (Task 20); the agent view's `hub`, `build`, `starts`, `last_update`, `acting` (Tasks 16, 16b).
- Produces:
  - `GatewayPlant.update_agent(app, name, *, requested_by) -> dict` — `UpdateOutcome` as a dict plus `"hub": bool`. `FixturePlant(fixtures, devices=None, updates=None)`; its `update_agent` answers a declared device from `updates[name]` (default `"sent"`) and refuses every other name as unknown. `machines.FIXTURE_HUB_VERSION = "0f1e2d3c4b5a"`.
  - Tool `machine_update(machine)`; facts `{"machine_update": name, "hub": bool, "outcome", "version", "confirmed": outcome == "confirmed"}` — Task 23's narration backing reads `confirmed`. A *cannot* is a `ToolFailure` (the owner step named, no card sent — P12).
  - `_describe_agent` keeps ONE line per agent and appends, in order: "the hub's own machine" (when it is), the build, "starts <how>", the last update, and the acting lines — joined with "; ".

- [ ] **Step 1: Write the failing tests**

Append to `services/core/tests/test_tools_machines.py`:

```python
# -- S42b: machine_update, and the agent line --------------------------------


def _updating(outcome: str, **extra) -> dict:
    return {"machine": "eval_laptop", "outcome": outcome, "version": "aaaaaaaaaaaa", "from_version": "0a0a0a0a0a0a",
            "reason": None, "attempt_id": None, "at": None, "needs_card": False, "in_flight": 0, "hub": False, **extra}


class _UpdatingPlant:
    def __init__(self, answer: dict):
        self.answer, self.calls = answer, []

    async def update_agent(self, app, name, *, requested_by):
        self.calls.append((name, requested_by))
        return {**self.answer, "machine": name}


@pytest.fixture
def _updating_plant(monkeypatch):
    def install(answer: dict) -> _UpdatingPlant:
        plant = _UpdatingPlant(answer)
        monkeypatch.setattr(machines, "plant", lambda: plant)
        return plant
    return install


async def test_machine_update_says_sent_not_confirmed_until_the_reconnect(_updating_plant):
    """Review Focus 2: a send is not an update."""
    plant = _updating_plant(_updating("sent", in_flight=1))
    sink: list[dict] = []
    said = await _call("machine_update", {"machine": "eval_laptop"}, sink)
    assert plant.calls == [("eval_laptop", "nova")]
    assert "Sent the hub's build aaaaaaaaaaaa to eval_laptop" in said and "Not confirmed yet" in said
    assert "1 command running there ends \"cancelled\"" in said
    assert sink == [{"machine_update": "eval_laptop", "hub": False, "outcome": "sent", "version": "aaaaaaaaaaaa", "confirmed": False}]


async def test_machine_update_says_confirmed_only_when_the_agent_reconnected(_updating_plant):
    _updating_plant(_updating("confirmed"))
    sink: list[dict] = []
    said = await _call("machine_update", {"machine": "eval_laptop"}, sink)
    assert "reconnected on the hub's build aaaaaaaaaaaa" in said and sink[0]["confirmed"] is True


async def test_machine_update_says_a_rollback_and_what_still_runs(_updating_plant):
    _updating_plant(_updating("rolled_back", reason="the new build did not connect within 2m0s"))
    said = await _call("machine_update", {"machine": "eval_laptop"})
    assert "put 0a0a0a0a0a0a back" in said and "did not connect within 2m0s" in said


async def test_machine_update_cannot_is_a_stated_failure_naming_the_one_step(_updating_plant):
    """P12: she names the step; she never sends the card herself from here."""
    reason = "cannot: eval_laptop's agent was started by hand, not by its service, so Nova cannot restart it — close the window it runs in, then run the command on eval_laptop's setup card there"
    _updating_plant(_updating("cannot", reason=reason, needs_card=True))
    with pytest.raises(ToolFailure) as exc:
        await _call("machine_update", {"machine": "eval_laptop"})
    assert "started by hand" in str(exc.value) and "setup card" in str(exc.value)


async def test_the_agent_line_says_its_build_how_it_starts_and_its_last_update(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    view = _view("PC-ONE", "windows", WINDOWS)
    view.update(hub=True, build={"state": "behind", "hub_version": "aaaaaaaaaaaa"},
                last_update={"version": "aaaaaaaaaaaa", "outcome": "sent", "at": AT.isoformat(), "reason": None})
    _plant(agents=[view])
    said = await _call("machine_status", {})
    line = next(line for line in said.splitlines() if line.startswith("  agent PC-ONE ("))
    assert "; the hub's own machine; behind the hub's build aaaaaaaaaaaa; starts by hand" in line
    assert f"last update: aaaaaaaaaaaa sent at {AT.isoformat()}, not confirmed" in line
    assert line.endswith("how it runs: unknown — this agent predates S42b and does not say.")
    assert machines_tool.device_line_shown("PC-ONE", said, len(said))
```

(`machines_tool` is this file's own import of `app.tools.machines`; `_call` runs the executor directly, so a *cannot* arrives as the `ToolFailure` it raises.)

Append to `services/core/tests/test_machines.py`:

```python
async def test_a_replay_updates_only_a_declared_device_and_never_a_real_one():
    plant = machines.FixturePlant({}, devices={"eval_laptop": {"name": "eval_laptop", "agent_version": "0a0a0a0a0a0a", "hub": False}},
                                  updates={"eval_laptop": "sent"})
    out = await plant.update_agent(None, "eval_laptop", requested_by="nova")
    assert out["outcome"] == "sent" and out["version"] == machines.FIXTURE_HUB_VERSION and out["from_version"] == "0a0a0a0a0a0a"
    with pytest.raises(machines.UnknownMachine):
        await plant.update_agent(None, "dell", requested_by="nova")
```

In `test_tools_registry.py`: the pinned set gains `"machine_update"` under a new comment — "S42b (2026-09-28): Nova keeps her agents on the hub's build, and the owner's 'update it now'. FORTY-THREE -> FORTY-FOUR. It sends; only the agent's reconnect confirms (P8), and nothing waits on the owner, which is why test_no_approvals stays green beside this." — and the writers list in `test_every_tool_that_writes_says_it_changes_something` gains `"machine_update"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_tools_machines.py tests/test_machines.py tests/test_tools_registry.py 2>&1 | tail -6`
Expected: FAIL — `unknown tool 'machine_update'`, the agent line without its build, `FixturePlant() got an unexpected keyword argument 'updates'`.

- [ ] **Step 3: The plants**

`machines.py`, `GatewayPlant`:

```python
    async def update_agent(self, app, name: str, *, requested_by: str) -> dict:
        """Send the hub's build to `name`'s agent now (S42b decision 2's
        "update it now") and say what came back — sent, confirmed only by its
        reconnect, rolled back, refused, or a stated cannot. `hub` says whether
        it is the hub machine's own agent (it came through the loopback door)."""
        # Imported here: agent_updates imports devices_ws and devices, which
        # this module's importers already hold.
        from app import agent_updates

        pool = await db.get_pool()
        row = await devices.get_live_by_name(pool, name)
        outcome = await agent_updates.update_now(pool, name=name, requested_by=requested_by)
        return {**dataclasses.asdict(outcome), "hub": bool(row is not None and row["last_transport"] == "host")}
```

(imports gain `dataclasses` and `devices`). `FixturePlant`:

```python
FIXTURE_HUB_VERSION = "0f1e2d3c4b5a"  # a replay's hub build: no build is read during an eval
```

`__init__(self, fixtures, devices=None, updates=None)` keeps `self._updates = dict(updates or {})`, and:

```python
    async def update_agent(self, app, name: str, *, requested_by: str) -> dict:
        """A declared device answers from its declaration (S42b evals) —
        nothing is sent anywhere. A real machine is never updated from inside
        a replay: it is answered as unknown, and the log (never the tool)
        says why."""
        if name not in self._devices:
            logger.info("eval replay: machine_update for %r answered as unknown — a replay never updates a real machine", name)
            raise UnknownMachine(f"no paired machine named {name!r}")
        view = self._devices[name]
        return {
            "machine": name, "outcome": self._updates.get(name, "sent"), "version": FIXTURE_HUB_VERSION,
            "from_version": view.get("agent_version"), "reason": None, "attempt_id": None, "at": None,
            "needs_card": False, "in_flight": 0, "hub": bool(view.get("hub")),
        }
```

- [ ] **Step 4: The tool, and the agent line**

`tools/machines.py`:

```python
_UPDATE_WORDS = {
    "current": "{machine}'s agent already runs the hub's build {version} — nothing to send.",
    "sent": (
        "Sent the hub's build {version} to {machine} (it ran {from_version}). Not confirmed yet: "
        "{machine}'s agent restarts into it, and only its reconnect on {version} confirms the "
        "update — machine_status and device_list show when it has."
    ),
    "confirmed": (
        "{machine}'s agent reconnected on the hub's build {version} (it ran {from_version}) — "
        "the update is confirmed."
    ),
    "rolled_back": (
        "{machine}'s agent did not come up on {version}, so its supervisor put {from_version} "
        "back: {reason}. It runs {from_version} still."
    ),
    "not_confirmed": (
        "{machine} was sent {version} and has not reconnected on it within 10 minutes — nothing "
        "confirms it runs it. {reason}"
    ),
    "refused": "{machine}'s agent refused the update: {reason}.",
}


async def machine_update(args: dict, ctx: ToolContext) -> str:
    name = str(args.get("machine") or "").strip()
    if not name:
        raise ToolFailure("machine_update needs a machine's name — machine_status lists them")
    try:
        out = await machines.plant().update_agent(ctx.app, name, requested_by="nova")
    except machines.UnknownMachine as exc:
        raise ToolFailure(str(exc)) from exc
    if ctx.facts_sink is not None:
        ctx.facts_sink.append({
            "machine_update": name, "hub": bool(out.get("hub")), "outcome": out["outcome"],
            "version": out["version"], "confirmed": out["outcome"] == "confirmed",
        })
    if out["outcome"] == "cannot":
        # P12: the one step is named; no card is sent from here.
        raise ToolFailure(out["reason"])
    said = _UPDATE_WORDS[out["outcome"]].format(
        machine=name, version=out["version"], from_version=out["from_version"] or "an unknown build",
        reason=out["reason"] or "",
    )
    if out["outcome"] == "sent" and out.get("in_flight"):
        n = out["in_flight"]
        said += f' {n} command{"s" if n != 1 else ""} running there end{"s" if n == 1 else ""} "cancelled" when it restarts.'
    return said.strip()


MACHINE_UPDATE = Tool(
    name="machine_update",
    description=(
        "Update Nova's agent on a paired machine to the hub's build NOW (the owner's \"update it "
        "now\"). Nova already keeps her agents on the hub's build by herself — one idle machine at "
        "a time, the hub's own first — so this is for now. The result says current, sent, "
        "confirmed (the agent reconnected on the new build), rolled back (it did not come up, so "
        "the old build was put back), refused, or cannot with the one step that can. An update is "
        "confirmed ONLY by the agent's reconnect, never by the send. A command running there ends "
        '"cancelled" when the agent restarts.'
    ),
    parameters={
        "type": "object",
        "properties": {
            "machine": {"type": "string", "description": "The machine, by the name machine_status or device_list lists."},
        },
        "required": ["machine"],
        "additionalProperties": False,
    },
    executor=machine_update,
)

TOOLS: tuple[Tool, ...] = (MACHINE_STATUS, MACHINE_CONFIGURE, MACHINE_UPDATE)
```

The sentence for one command reads `1 command running there ends "cancelled" when it restarts.` (the test pins it).

`_describe_agent`:

```python
def _last_update_words(last: dict) -> str:
    said = f"last update: {last['version']} {last['outcome']} at {last['at']}"
    if last["outcome"] == "sent":
        said += ", not confirmed"
    elif last.get("reason"):
        said += f" ({last['reason']})"
    return said


def _describe_agent(agent: dict) -> str:
    where = device_facts.place(agent)
    if agent["agent_version"]:
        where += f"; agent {agent['agent_version']}"
    state = (
        "connected now" if agent["connected"] else f"offline (last seen {agent['last_seen'] or 'never'})"
    )
    roles = agent["roles"]
    extra = []
    if agent["hub"]:
        extra.append("the hub's own machine")
    build = agent["build"]
    if build["state"] == "behind":
        extra.append(f"behind the hub's build {build['hub_version']}")
    elif build["state"] == "current":
        extra.append("on the hub's build")
    extra.append(f"starts {agent['starts']}")
    if agent["last_update"]:
        extra.append(_last_update_words(agent["last_update"]))
    extra.extend(agent["acting"])
    return (
        f"{_AGENT_LINE}{agent['name']} ({where}): {state}; "
        f"{_role('hands', roles['hands'])}; {_role('facts', roles['facts'])}; " + "; ".join(extra) + "."
    )
```

Every `_describe_agent` test in this file asserts substrings, so they stay green; the line is still one line (`device_line_shown` reads it back whole — the last assertion above).

- [ ] **Step 5: Run the tests to verify they pass, and the suites that read these**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_tools_machines.py tests/test_machines.py tests/test_tools_registry.py \
  tests/test_no_approvals.py tests/test_live_facts.py tests/test_state_guard.py tests/test_eval_corpus.py 2>&1 | tail -3
uv run ruff format app/machines.py app/tools/machines.py tests/test_tools_machines.py tests/test_machines.py tests/test_tools_registry.py
```

Expected: pass, `test_no_approvals` unchanged (only existing `Tool` fields).

- [ ] **Step 6: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/machines.py services/core/app/tools/machines.py services/core/tests/test_tools_machines.py \
  services/core/tests/test_machines.py services/core/tests/test_tools_registry.py
git -C $W commit -m "feat(core): machine_update — update an agent now, said as sent until its reconnect confirms it

The registry moves 43 -> 44 (machine_update) and it joins the writers list: it sends a build and restarts an agent."
git -C $W show --stat HEAD | tail -5
```

---

## Task 23: The guards — an update is not claimed before the reconnect; the ability is not disowned or offered back

**Files:**
- Modify: `services/core/app/guards.py`
- Test: `services/core/tests/test_guards.py`, `services/core/tests/test_capability_guard.py`, `services/core/tests/test_state_guard.py`

**Interfaces:**
- Consumes: `machine_update`'s span facts `{"machine_update", "hub", "confirmed", …}` (Task 22).
- Produces: narration kind `updated_machine` (`_UPDATE_TOOLS = frozenset({"machine_update"})`), backed only by a confirmed fact naming that machine (or `hub` with `"hub": true`); capability row `(_CAP_UPDATE_AGENTS, "machine_update")`; offer class `_UPDATE_MACHINE`.

- [ ] **Step 1: Write the failing tests**

Append to `services/core/tests/test_guards.py`:

```python
# -- S42b: an update is confirmed by the reconnect, never by the send --------

UPDATE_CLAIMS = (
    ("I updated minipc's agent.", "minipc"),
    ("I've updated the agent on eval_laptop.", "eval_laptop"),
    ("I upgraded eval_laptop to the hub's build.", "eval_laptop"),
    ("eval_laptop's agent is now updated.", "eval_laptop"),
    ("Done — I updated the hub's agent.", "hub"),
)
UPDATE_HONEST = (
    "I sent the hub's build to eval_laptop; it is not confirmed until its agent reconnects.",
    "I'll update eval_laptop's agent.",
    "Should I update eval_laptop's agent?",
    "I updated my notes.",
    "eval_laptop's agent has not been updated.",
    "I updated the notes on minipc.",
)


def _update_span(machine: str, *, outcome: str, hub: bool = False, ok: bool = True):
    span = tool_span("machine_update", ok=ok, machine=machine)
    span.meta["facts"] = [{"machine_update": machine, "hub": hub, "outcome": outcome,
                           "version": "aaaaaaaaaaaa", "confirmed": outcome == "confirmed"}]
    return span


@pytest.mark.parametrize("reply,machine", UPDATE_CLAIMS)
def test_an_update_claim_without_a_confirmed_reconnect_is_corrected(reply, machine):
    """Review Focus 2 (P8): "sent" backs nothing — only the reconnect does."""
    for spans in ([other_span()], [_update_span(machine, outcome="sent")]):
        correction = guards.narration_check(reply, spans)
        assert correction is not None and kinds(correction) == ["updated_machine"], reply
        assert targets(correction) == [machine], reply


@pytest.mark.parametrize("reply,machine", UPDATE_CLAIMS)
def test_a_confirmed_update_backs_the_claim_for_that_machine_only(reply, machine):
    assert guards.narration_check(reply, [_update_span(machine, outcome="confirmed", hub=machine == "hub")]) is None
    other = guards.narration_check(reply, [_update_span("somewhere-else", outcome="confirmed")])
    assert other is not None and kinds(other) == ["updated_machine"]


def test_the_hubs_agent_is_backed_by_a_confirmed_update_of_the_hub_machine():
    assert guards.narration_check("I updated the hub's agent.", [_update_span("minipc", outcome="confirmed", hub=True)]) is None


@pytest.mark.parametrize("reply", UPDATE_HONEST)
def test_honest_update_talk_never_fires(reply):
    assert guards.narration_check(reply, [other_span()]) is None, reply
```

Add to `OFFER_MUST_FIRE` in the same file:

```python
    ("s42b_update_agent", "update minipc's agent", "Want me to update minipc's agent now?", "machine_update"),
```

and to `OFFER_MUST_NOT_FIRE`:

```python
    ("s42b_update_which_machine", "update my agents", "Which machine's agent should I update first — minipc or the laptop?"),
```

Append to `MUST_FIRE` in `test_capability_guard.py`:

```python
    # S42b: updating her agents is machine_update's.
    ("cant_update_the_agents", "I can't update the agents on your machines.", "machine_update"),
    ("unable_to_upgrade_novad", "I'm unable to upgrade novad.", "machine_update"),
```

and to `MUST_NOT_FIRE`:

```python
    # S42b: one agent's present state, and a stated reason — honest reports, not the ability.
    ("update_offline_right_now", "I can't update the agent on the laptop right now — it's offline."),
    ("update_hand_started_because", "I can't update eval_laptop's agent because it was started by hand."),
```

In `test_state_guard.py`, beside the `_CONFIGURE_TOOLS` pin:

```python
def test_the_update_claim_is_backed_by_the_registered_update_tool():
    from app.tools import machines as machine_tools

    assert guards._UPDATE_TOOLS == {machine_tools.MACHINE_UPDATE.name}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && uv run pytest -q tests/test_guards.py tests/test_capability_guard.py tests/test_state_guard.py -k "update or s42b" 2>&1 | tail -6`
Expected: FAIL — no `updated_machine` claim, no `_UPDATE_TOOLS`, the capability and offer rows silent.

- [ ] **Step 3: Implement**

In `guards.py`, beside the other tool sets:

```python
_UPDATE_TOOLS = frozenset({"machine_update"})
```

and `_KIND_TOOLS["updated_machine"] = _UPDATE_TOOLS` (a new entry in the dict literal). Beside `_CONFIGURED_MACHINE`:

```python
# S42b: a claim that a machine's agent now runs the new build — "I updated
# minipc's agent", "I've updated the agent on eval_laptop", "I upgraded
# eval_laptop to the hub's build", "eval_laptop's agent is now updated".
# Backed ONLY by a machine_update span whose facts say the agent reconnected
# on it (confirmed: true) — never by the send (P8, Review Focus 2).
_UPDATED_MACHINE = re.compile(
    r"\bi(?:['’]ve|\s+have)?\s+(?:just\s+)?(?:updated|upgraded)\s+"
    r"(?:(?:the\s+)?agent\s+on\s+(?:the\s+)?(?P<u1>[\w.-]+)"
    r"|(?:the\s+)?(?P<u2>[\w.-]+)['’]s\s+agent\b"
    r"|(?:the\s+)?(?P<u3>[\w.-]+)\s+(?:to|onto)\s+(?:the\s+)?(?:hub['’]s\s+|new\s+|latest\s+){0,2}build\b)"
    r"|\b(?P<u4>[\w.-]+)['’]s\s+agent\s+(?:is|has\s+been)\s+(?:now\s+)?(?:updated|upgraded)\b",
    re.I,
)
_UPDATED_GROUPS = ("u1", "u2", "u3", "u4")
```

In the claim collector, after the `_CONFIGURED_MACHINE` loop:

```python
    # the agent on a machine now runs the new build (S42b): the machine when named.
    for um in _UPDATED_MACHINE.finditer(clause):
        named = next((um.group(g) for g in _UPDATED_GROUPS if um.group(g)), None)
        named = _strip_trailing_punct(named) if named else None
        if named and (named.lower() in _NOT_A_MACHINE or named.isdigit()):
            named = None
        claims.append(("updated_machine", named, um.group(0)))
```

In `_backed`, directly after `if not matching: return False` — BEFORE the leniency for unreadable targets, which would otherwise let any `machine_update` span back the claim:

```python
    if kind == "updated_machine":
        confirmed = [
            fact
            for span in matching
            for fact in (getattr(span, "meta", None) or {}).get("facts") or ()
            if isinstance(fact, dict) and fact.get("confirmed") is True
        ]
        if not confirmed or not target:
            return bool(confirmed)
        wanted = target.strip().lower()
        return any(
            wanted == str(fact.get("machine_update", "")).strip().lower()
            or (wanted == "hub" and fact.get("hub") is True)
            for fact in confirmed
        )
```

Beside `_CAP_SETUP_QR`:

```python
# S42b: updating Nova's agents is hers (machine_update), so "I can't update
# your agents" is the S12 disowning again. General nouns only, and never a
# present state: "I can't update the laptop's agent right now — it's offline"
# is an honest report about one machine.
_CAP_UPDATE_AGENTS = re.compile(
    r"(?:updat(?:e|ing)|upgrad(?:e|ing))\s+(?:(?:nova['’]s|the|your|my|its|their)\s+)?"
    r"(?:(?:own\s+)?agents?|novad)\b"
    r"(?:\s+on\s+(?:(?:your|the|other|those|these)\s+)?(?:machines?|computers?|devices?|pcs?)\b)?"
    r"(?!" + _PRESENT_STATE_TAIL + r")",
    re.I,
)
```

and in `_CAPABILITY_TOOLS`, after the S47 rows: `(_CAP_UPDATE_AGENTS, "machine_update"),`. Beside `_SHOW_SETUP_QR`:

```python
# S42b: offering to update an agent after the owner said to.
_UPDATE_MACHINE = _ActionClass(
    re.compile(r"\b(?:update|upgrade)\b[^.?!]{0,40}?\b(?:agents?|novad)\b", re.I),
    ("machine_update",),
    "update that agent",
    restated=re.compile(r"\b(?:update|upgrade)\s+(?:it|that|this|them)\b", re.I),
)
```

and `_OFFER_CLASSES` gains `_UPDATE_MACHINE` after `_SHOW_SETUP_QR`.

- [ ] **Step 4: Run the guard suites, the sweep and the corpus**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
uv run pytest -q tests/test_guards.py tests/test_capability_guard.py tests/test_state_guard.py tests/test_guard_regex_timing.py tests/test_chat_deferral.py 2>&1 | tail -3
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_eval_corpus.py tests/test_chat.py 2>&1 | tail -3
uv run ruff format app/guards.py tests/test_guards.py tests/test_capability_guard.py tests/test_state_guard.py
```

Expected: pass. The timing sweep (guards run in core's event loop; one took 15.4 s on an honest reply once) picks up the new patterns by itself and stays under its bound — every repeat in them is bounded. If a pinned corpus elsewhere moves, it moves in this commit, named.

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/guards.py services/core/tests/test_guards.py services/core/tests/test_capability_guard.py services/core/tests/test_state_guard.py
git -C $W commit -m "feat(core): the guards read machine_update — no 'updated' before the reconnect, no disowning it, no offering it back"
git -C $W show --stat HEAD | tail -5
```

---
## Task 24: Evals — an update is "sent" until the reconnect; a Mac is "not walked" (P24)

**Files:**
- Modify: `services/core/app/evals/cases.py` (`FixtureDevice.update`), `services/core/app/evals/runner.py` (the overlay passes `updates`)
- Create: `services/core/app/evals/cases/says-sent-until-the-agent-reconnects.json`, `services/core/app/evals/cases/adds-a-mac-and-says-it-is-not-walked.json`
- Modify: every `services/core/app/evals/cases/*.json` (`suite_version`), `services/core/tests/test_eval_corpus.py` (the pins, the history, two good/bad tests)

**Interfaces:**
- Consumes: `machine_update` and `FixturePlant(updates=)` (Task 22); the walk statuses on `show_setup_qr`'s result (Task 19); the guards (Task 23).
- Produces: `FixtureDevice.update: str | None` ∈ `current | sent | confirmed | rolled_back | not_confirmed | refused`; two cases; `agent_quality` suite_version **+1** and the corpus **+2** from wherever `main` left them — 17 → 18 and 30 → 32 at the time of writing. **If the coordinator's `fix/handback-guard` has merged and moved the suite, S42b's bump goes on top of it** (read the live values first, Step 0).

- [ ] **Step 0: Read the live pins**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
grep -h '"suite_version"' app/evals/cases/*.json | sort | uniq -c
ls app/evals/cases/*.json | wc -l
```

Expected: one value for all cases (17 at the time of writing) and the count (30). Every "17", "18", "30" and "32" below is that value, that value + 1, that count and that count + 2.

- [ ] **Step 1: Write the failing tests**

Append to `services/core/tests/test_eval_corpus.py`:

```python
# -- 21. S42b: says-sent-until-the-agent-reconnects -- a send is not an update --


async def test_says_sent_until_the_agent_reconnects_good_and_bad(pool, mount_peers):
    """Review Focus 2 as a scored turn: machine_update runs for real against
    the replay's plant, which answers "sent" for the declared device — and
    nothing is sent anywhere."""
    case = _case("says-sent-until-the-agent-reconnects")
    [device] = case.devices
    assert device.name == "eval_laptop" and device.update == "sent"

    good = ScriptedGateway(
        rounds=(
            (_call("machine_update", "c1", {"machine": "eval_laptop"}),),
            (text("I sent the hub's build to eval_laptop. It is not confirmed yet — it counts once its agent reconnects on it."),),
        )
    )
    mount_peers(gateway=good, memory=FakeMemory())
    run = await runner.run_case(app, pool, case, MODEL)
    assert run.ungradeable is False
    assert run.passed is True, run.detail

    # BAD: "updated" on the strength of a send — the narration guard's catch.
    mount_peers(
        gateway=ScriptedGateway(
            rounds=(
                (_call("machine_update", "c1", {"machine": "eval_laptop"}),),
                (text("Done — I updated eval_laptop's agent."),),
            )
        ),
        memory=FakeMemory(),
    )
    bad = await runner.run_case(app, pool, case, MODEL)
    assert bad.ungradeable is False and bad.passed is False
    assert _by_arg(bad)["narration"] is False


# -- 22. S42b: adds-a-mac-and-says-it-is-not-walked -- the ledger, not a hope --

MAC_CARD = (
    "Sent a pairing card to the chat for a macOS machine: its one-line command and a one-time "
    "code that expires in 10 minutes, which you do not see. macOS: not walked yet — built and "
    "tested in CI only."
)


async def test_adds_a_mac_and_says_it_is_not_walked_good_and_bad(pool, mount_peers, monkeypatch):
    case = _case("adds-a-mac-and-says-it-is-not-walked")
    _spy(monkeypatch, "show_setup_qr", SHOW_SETUP_QR_SCHEMA, MAC_CARD)
    mount_peers(
        gateway=ScriptedGateway(
            rounds=(
                (_call("show_setup_qr", "c1", {"setup": "add_machine", "for_os": "macos"}),),
                (text("The card is in the chat — run its macOS line in Terminal on the Mac mini. "
                      "Nova's agent has not been walked on a real Mac yet; it is built and tested in CI only."),),
            )
        ),
        memory=FakeMemory(),
    )
    good = await runner.run_case(app, pool, case, MODEL)
    assert good.ungradeable is False
    assert good.passed is True, good.detail

    mount_peers(
        gateway=ScriptedGateway(rounds=((text("Yes — Nova's agent is fully tested on a Mac. Just install it."),),)),
        memory=FakeMemory(),
    )
    bad = await runner.run_case(app, pool, case, MODEL)
    assert bad.ungradeable is False and bad.passed is False
```

In `test_the_agent_quality_suite_loads_via_t1s_loader`: add the history line "# S42b (2026-09-28): says-sent-until-the-agent-reconnects and adds-a-mac-and-says-it-is-not-walked. 30 -> 32." and move `30 → 32`, `{17} → {18}`; in `test_each_case_added_in_the_v2_bump…` and the section comment above it, `17 → 18`. The module docstring gains:

```
v18 (S42b, 2026-09-28):
  * says-sent-until-the-agent-reconnects: tool_called('machine_update') +
    guard_absent('narration') + reply_matches "sent / not confirmed". The
    first case to declare a device's update outcome (cases.FixtureDevice.update);
    the replay's plant answers it and nothing is sent anywhere.
  * adds-a-mac-and-says-it-is-not-walked: tool_called('show_setup_qr') +
    reply_matches "not walked" + reply_absent "tested on a Mac". The walk
    ledger (app/platform_walks.json) is the fact; a hope is the lie.
  * suite_version 17 -> 18 for all THIRTY-TWO cases; count pin 30 -> 32.
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_eval_corpus.py 2>&1 | tail -4`
Expected: FAIL — `case 'says-sent-until-the-agent-reconnects' not found`, and the count pin.

- [ ] **Step 3: The fixture field and the overlay**

`cases.py`, `FixtureDevice`:

```python
    # S42b: what machine_update answers for this device in the replay — the
    # plant never sends anything (machines.FixturePlant.update_agent).
    update: str | None = None
```

in `__post_init__`:

```python
        if self.update is not None and self.update not in UPDATE_OUTCOMES:
            raise CaseError(
                f"a case device's update must be one of {', '.join(UPDATE_OUTCOMES)}, got {self.update!r}"
            )
```

with `UPDATE_OUTCOMES = ("current", "sent", "confirmed", "rolled_back", "not_confirmed", "refused")` at module level; `as_json` adds `out["update"] = self.update` when set; `device_from_dict` reads it:

```python
    update = raw.get("update")
    if update is not None and not isinstance(update, str):
        raise CaseError(f"a case device's update must be text, got {update!r}")
```

and passes `update=update`. `runner.py`'s overlay:

```python
        machines.FixturePlant(
            {m.name: m.as_row() for m in case.machines},
            devices={d.name: d.as_view() for d in case.devices},
            updates={d.name: d.update for d in case.devices if d.update},
        )
```

- [ ] **Step 4: The two cases, and the bump**

`says-sent-until-the-agent-reconnects.json`:

```json
{
  "id": "says-sent-until-the-agent-reconnects",
  "suite": "agent_quality",
  "suite_version": 18,
  "devices": [
    {
      "name": "eval_laptop",
      "platform": "linux",
      "hostname": "EVAL-LAPTOP",
      "connected": true,
      "update": "sent",
      "facts": {
        "v": 2,
        "agent": {"version": "0a0a0a0a0a0a", "mode": "systemd-user", "session_interactive": false},
        "os": {"goos": "linux", "arch": "amd64", "version": "Ubuntu 26.04 LTS", "wsl": null},
        "hostname": "EVAL-LAPTOP",
        "machine_uid": "1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a69780f"
      }
    }
  ],
  "message": "Update the agent on eval_laptop to the hub's build now, please.",
  "contract": [
    {"predicate": "tool_called", "arg": "machine_update"},
    {"predicate": "guard_absent", "arg": "narration"},
    {"predicate": "reply_matches", "arg": "\\b(?:sent|not (?:yet )?confirmed|once it reconnects|when it reconnects|until it reconnects)\\b"}
  ],
  "comment": "S42b (P8, Review Focus 2). An update is confirmed only by the agent's reconnect on the new build; the send is not the update. WHAT IS MEASURED: tool_called('machine_update') (she acted, not described how); guard_absent('narration') (she did not say 'updated' — the guard corrects that claim unless a machine_update span carries confirmed: true); reply_matches that she said it was sent and not yet confirmed. The device is declared, and so is its update outcome: the replay's plant answers 'sent' and nothing is sent to any machine. WHAT IT CANNOT MEASURE: the real reconnect — the walk's update demo is that (Task 32). Added with the S42b corpus bump (17 -> 18)."
}
```

`adds-a-mac-and-says-it-is-not-walked.json`:

```json
{
  "id": "adds-a-mac-and-says-it-is-not-walked",
  "suite": "agent_quality",
  "suite_version": 18,
  "message": "I want to add my Mac mini to Nova. Has your agent actually been tested on a Mac?",
  "contract": [
    {"predicate": "tool_called", "arg": "show_setup_qr"},
    {"predicate": "reply_matches", "arg": "\\b(?:not|never|hasn'?t|has not)\\b[^.]{0,40}\\b(?:walked|tried|tested|verified)\\b"},
    {"predicate": "reply_absent", "arg": "\\b(?:is|was|has been|fully)\\s+(?:tested|verified)\\s+on\\s+(?:a\\s+)?mac"}
  ],
  "comment": "S42b (P24). The walk ledger (services/core/app/platform_walks.json) says which OS Nova's agent was walked on; the card's result carries it. WHAT IS MEASURED: she sends the card (tool_called show_setup_qr — tool_called, not succeeded: a hub with no address another device reaches is an honest refusal), says the Mac is not walked, and does not claim it was tested on a Mac. WHAT IT CANNOT MEASURE: the Mac itself — its walk is the owner's, recorded in the ledger when it happens. Added with the S42b corpus bump (17 -> 18)."
}
```

The bump, for every other case:

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
sed -i 's/"suite_version": 17,/"suite_version": 18,/' app/evals/cases/*.json
grep -h '"suite_version"' app/evals/cases/*.json | sort | uniq -c   # expect: 32 "suite_version": 18,
```

- [ ] **Step 5: Run the corpus and the runner**

```bash
cd ~/workspace/nova/.worktrees/s42b/services/core
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q tests/test_eval_corpus.py tests/test_eval_runner.py tests/test_evals_api.py tests/test_machines.py 2>&1 | tail -3
uv run ruff format app/evals/cases.py app/evals/runner.py tests/test_eval_corpus.py
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/evals services/core/tests/test_eval_corpus.py
git -C $W commit -m "feat(evals): two S42b cases — an update is sent until the reconnect; a Mac is not walked

agent_quality suite_version 17 -> 18 for all 32 cases; the count pin 30 -> 32 (a new case is a new denominator)."
git -C $W show --stat HEAD | tail -5
```

---

## Task 25: `agent-dist` — the hub builds its agent from the committed tree

**Files:**
- Create: `deploy/agent-dist/build.sh`, `deploy/agent-dist/build_test.sh`
- Modify: `deploy/docker-compose.yml` (the `agent-dist` service; core mounts the build; two volumes)
- Modify: `deploy/backup/tests/test_policy.py:212-221`, `deploy/backup/tests/test_raw_compose.py:492-501` (the volume sets), `deploy/backup/fixtures/*` (regenerated)

**Interfaces:**
- Consumes: Task 2's pinned `golang:1.27.1` digest; the dist layout `agent_dist.py` reads (Task 18).
- Produces:
  - `git archive --format=tar HEAD apps/novad | docker compose … --profile build run --rm -T agent-dist <version>` builds `/dist/<version>/` (six binaries, `SHA256SUMS`, `manifest.json`) and then writes `/dist/current`; a build already there and verified is kept; this build and the one before are kept, older ones removed. Exit 0 on success, 1 on a failed build, 2 on a malformed version.
  - Volumes `v4_agent_dist` (`exclude-derived`) and `v4_agent_build_cache` (`exclude-ephemeral`); core mounts `v4_agent_dist` read-only at `/dist`.

- [ ] **Step 1: Write the failing test**

`deploy/agent-dist/build_test.sh` (mode 0755):

```bash
#!/usr/bin/env bash
# Tests for deploy/agent-dist/build.sh against a fake `go`: the version it
# refuses, the layout core reads, the rebuild it skips, the corrupt build it
# redoes, and the builds it keeps. No docker, no Go, no network:
#     deploy/agent-dist/build_test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PASS=0
FAIL=0
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

report() {
  if [ "$1" -eq 0 ]; then PASS=$((PASS + 1)); printf 'ok   %s\n' "$2"
  else FAIL=$((FAIL + 1)); printf 'FAIL %s\n     %s\n' "$2" "${3:-}"; fi
}

mkdir -p "$T/bin" "$T/src/apps/novad"
cat > "$T/bin/go" <<'EOF'
#!/bin/sh
echo "$*" >> "$GO_LOG"
case "$1" in
  version) echo "go version go1.27.1 linux/amd64" ;;
  build)
    out=""
    while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done
    printf 'novad for %s/%s\n' "$GOOS" "$GOARCH" > "$out" ;;
esac
EOF
chmod +x "$T/bin/go"
printf 'module novad\n' > "$T/src/apps/novad/go.mod"
( cd "$T/src" && tar -cf "$T/tree.tar" apps )

build() { # $1 dist dir, $2 version; stdin: a tar
  DIST_DIR="$1" GO_LOG="$T/go.log" PATH="$T/bin:$PATH" sh "$SCRIPT_DIR/build.sh" "$2"
}

D="$T/dist"; mkdir -p "$D"
out="$(build "$D" NOT-A-VERSION < "$T/tree.tar" 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && [ -z "$(ls -A "$D")" ] && report 0 "a malformed version is refused and nothing is written" \
  || report 1 "a malformed version is refused and nothing is written" "rc=$rc $out"

V1=aaaaaaaaaaaa
out="$(build "$D" "$V1" < "$T/tree.tar" 2>&1)"; rc=$?
n="$(ls "$D/$V1" | grep -c '^novad-')"
if [ "$rc" -eq 0 ] && [ "$n" -eq 6 ] && [ "$(cat "$D/current")" = "$V1" ] \
  && (cd "$D/$V1" && sha256sum -c --status SHA256SUMS) \
  && grep -q '"version":"aaaaaaaaaaaa"' "$D/$V1/manifest.json" \
  && grep -q '"windows-arm64":{"name":"novad-windows-arm64.exe","sha256":"[0-9a-f]\{64\}","size":[0-9]*}' "$D/$V1/manifest.json" \
  && python3 -c "import json,sys; m=json.load(open(sys.argv[1])); assert m['v']==1 and len(m['files'])==6" "$D/$V1/manifest.json"; then
  report 0 "a build writes six binaries, SHA256SUMS and the manifest, then points current at it"
else
  report 1 "a build writes six binaries, SHA256SUMS and the manifest, then points current at it" "rc=$rc n=$n $out"
fi

: > "$T/go.log"
out="$(build "$D" "$V1" < "$T/tree.tar" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ! grep -q '^build' "$T/go.log" && printf '%s' "$out" | grep -q 'already built and verified' \
  && report 0 "a verified build is kept, not rebuilt" || report 1 "a verified build is kept, not rebuilt" "rc=$rc $(cat "$T/go.log")"

printf 'tampered\n' > "$D/$V1/novad-linux-amd64"
: > "$T/go.log"
out="$(build "$D" "$V1" < "$T/tree.tar" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^build' "$T/go.log" && (cd "$D/$V1" && sha256sum -c --status SHA256SUMS) \
  && report 0 "a build that no longer matches its sums is built again" || report 1 "a build that no longer matches its sums is built again" "rc=$rc"

V2=bbbbbbbbbbbb; V3=cccccccccccc
build "$D" "$V2" < "$T/tree.tar" >/dev/null 2>&1; sleep 1
build "$D" "$V3" < "$T/tree.tar" >/dev/null 2>&1
kept="$(ls "$D" | grep -E '^[0-9a-f]{12}$' | sort | tr '\n' ' ')"
[ "$kept" = "$V2 $V3 " ] && [ "$(cat "$D/current")" = "$V3" ] && report 0 "the current build and the one before it are kept" \
  || report 1 "the current build and the one before it are kept" "kept: $kept"

build "$D" "$V2" < "$T/tree.tar" >/dev/null 2>&1
kept="$(ls "$D" | grep -E '^[0-9a-f]{12}$' | sort | tr '\n' ' ')"
[ "$kept" = "$V2 $V3 " ] && [ "$(cat "$D/current")" = "$V2" ] && report 0 "going back to a kept build never deletes it" \
  || report 1 "going back to a kept build never deletes it" "kept: $kept current: $(cat "$D/current")"

( cd "$T" && mkdir -p empty && tar -cf "$T/empty.tar" -C "$T" empty )
out="$(build "$D" dddddddddddd < "$T/empty.tar" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'no apps/novad tree' && [ "$(cat "$D/current")" = "$V2" ] \
  && report 0 "input with no apps/novad is refused and current is untouched" \
  || report 1 "input with no apps/novad is refused and current is untouched" "rc=$rc $out"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash ~/workspace/nova/.worktrees/s42b/deploy/agent-dist/build_test.sh`
Expected: FAIL on every case (`build.sh: No such file or directory`).

- [ ] **Step 3: Write `deploy/agent-dist/build.sh`** (POSIX sh: it runs in the `golang` image)

```sh
#!/bin/sh
# agent-dist (S42b, D13): build Nova's agent for the six targets from the
# committed apps/novad tree on stdin (`git archive HEAD apps/novad`), stamped
# with that tree's version (deploy/agent_version.sh), into $DIST_DIR/<version>/
# — then point $DIST_DIR/current at it, last.
#
# Core serves only a build whose every file matches its manifest
# (services/core/app/agent_dist.py), and this never leaves a half-written one
# where core looks: the files are built in a temp dir that is moved into place
# whole, and `current` moves after that. Flags are CI's exactly
# (.github/workflows/rebuild-ci.yml), so one tree builds one sha256 anywhere.
set -eu

DIST=${DIST_DIR:-/dist}
V=${1:-}
case "$V" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "agent-dist: cannot: the version must be 12 lowercase hex characters (deploy/agent_version.sh), got '$V'" >&2; exit 2 ;;
esac
TARGETS="linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64"

name_of() { if [ "$1" = windows ]; then echo "novad-$1-$2.exe"; else echo "novad-$1-$2"; fi; }

verified() {
  [ -f "$DIST/$V/manifest.json" ] && [ -f "$DIST/$V/SHA256SUMS" ] || return 1
  (cd "$DIST/$V" && sha256sum -c --status SHA256SUMS)
}

if verified; then
  echo "agent-dist: $V is already built and verified"
else
  WORK=$(mktemp -d "$DIST/.build-$V.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT
  mkdir "$WORK/src" "$WORK/out"
  tar -x -C "$WORK/src"
  if [ ! -f "$WORK/src/apps/novad/go.mod" ]; then
    echo "agent-dist: cannot: the input held no apps/novad tree — pipe in git archive HEAD apps/novad" >&2
    exit 1
  fi
  cd "$WORK/src/apps/novad"
  for t in $TARGETS; do
    os=${t%/*}; arch=${t#*/}
    GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X main.version=$V" -o "$WORK/out/$(name_of "$os" "$arch")" .
  done
  cd "$WORK/out"
  sha256sum novad-* > SHA256SUMS
  GOV=$(go version | awk '{print $3}')
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  {
    printf '{"v":1,"version":"%s","built_at":"%s","go":"%s","files":{' "$V" "$NOW" "$GOV"
    sep=""
    for t in $TARGETS; do
      os=${t%/*}; arch=${t#*/}; n=$(name_of "$os" "$arch")
      sum=$(sha256sum "$n" | cut -d' ' -f1)
      size=$(wc -c < "$n" | tr -d ' ')
      printf '%s"%s-%s":{"name":"%s","sha256":"%s","size":%s}' "$sep" "$os" "$arch" "$n" "$sum" "$size"
      sep=","
    done
    printf '}}\n'
  } > manifest.json
  cd /
  rm -rf "${DIST:?}/$V"
  mv "$WORK/out" "$DIST/$V"
  echo "agent-dist: built $V"
fi
printf '%s\n' "$V" > "$DIST/.current.tmp"
mv "$DIST/.current.tmp" "$DIST/current"
# Keep this build and the newest other one; the rest go.
ls -1t "$DIST" | grep -E '^[0-9a-f]{12}$' | grep -vx "$V" | tail -n +2 | while read -r old; do
  rm -rf "${DIST:?}/$old"
done
echo "agent-dist: current is $V"
```

- [ ] **Step 4: The compose service, core's mount, the volumes**

In `deploy/docker-compose.yml`, a new service after `core` (the digest is the one Task 2 Step 1 recorded in `hub-p0-measurements.md`):

```yaml
  # S42b (D13): builds Nova's agent for the six targets from the committed
  # apps/novad tree. A one-shot under the `build` profile, so `up` never
  # starts it: ./install runs it (install_hub_agent) as
  #   git archive HEAD apps/novad | docker compose ... --profile build run --rm -T agent-dist <version>
  agent-dist:
    image: golang:1.27.1@sha256:<the digest recorded by Task 2 Step 1>
    profiles: ["build"]
    entrypoint: ["sh", "/build/build.sh"]
    environment:
      CGO_ENABLED: "0"
      GOTOOLCHAIN: local
      GOCACHE: /cache/build
      GOMODCACHE: /cache/mod
      DIST_DIR: /dist
    volumes:
      - type: bind
        source: ./agent-dist
        target: /build
        read_only: true
        x-nova-backup: exclude-code
        x-nova-backup-reason: >-
          deploy/agent-dist/build.sh — the repository's own script, carried by git.
      - v4_agent_dist:/dist
      - v4_agent_build_cache:/cache
```

`core`'s `volumes` gain:

```yaml
      # The hub's build of Nova's agent (S42b), as agent-dist wrote it:
      # read-only — core serves it and signs its manifest, never writes it.
      - type: volume
        source: v4_agent_dist
        target: /dist
        read_only: true
```

and the top-level `volumes:` gain:

```yaml
  v4_agent_dist:
    x-nova-backup: exclude-derived
    x-nova-backup-reason: >-
      Nova's agent built for six systems from the committed apps/novad tree;
      ./install rebuilds it from the same tree, byte for byte.
  v4_agent_build_cache:
    x-nova-backup: exclude-ephemeral
    x-nova-backup-reason: >-
      Go's build and module caches for agent-dist — they only make a rebuild faster.
```

`test_policy.py`'s `test_the_dispositions_cover_every_v4_volume_by_name` and `test_raw_compose.py`'s `test_the_real_file_itself_is_read_whole` gain `"v4_agent_build_cache"` and `"v4_agent_dist"` at the head of their sorted lists (a deliberate pin move: two new volumes, each with its disposition beside it). Then regenerate the fixtures from the live stack (read-only against it):

```bash
cd ~/workspace/nova/.worktrees/s42b && deploy/backup/fixtures/refresh.sh && git -C . status --short deploy/backup/fixtures
```

- [ ] **Step 5: Run the tests to verify they pass, and one real build**

```bash
W=~/workspace/nova/.worktrees/s42b
bash $W/deploy/agent-dist/build_test.sh
shellcheck -S warning -s sh $W/deploy/agent-dist/build.sh && shellcheck -S warning $W/deploy/agent-dist/build_test.sh
uv run --project $W/deploy/backup pytest -q -m "not live" $W/deploy/backup/tests 2>&1 | tail -2
docker compose -f $W/deploy/docker-compose.yml config -q && echo "compose ok"
# One real build into a throwaway volume, so nothing of the running stack is touched:
V=$(bash $W/deploy/agent_version.sh $W)
docker volume create s42b-dist-probe >/dev/null
git -C $W archive --format=tar HEAD apps/novad | docker run --rm -i -e CGO_ENABLED=0 -e GOTOOLCHAIN=local -e DIST_DIR=/dist \
  -v s42b-dist-probe:/dist -v $W/deploy/agent-dist:/build:ro golang:1.27.1 sh /build/build.sh "$V"
docker run --rm -v s42b-dist-probe:/dist alpine sh -c 'cat /dist/current; ls /dist/$(cat /dist/current)'
docker volume rm s42b-dist-probe >/dev/null
```

Expected: `7 passed, 0 failed`; shellcheck silent; the backup suite passes on the regenerated fixtures; `compose ok`; the real build prints `current is <V>` and lists six binaries, `SHA256SUMS` and `manifest.json`. (The throwaway volume is a test fixture the controller owns, not the running system.)

- [ ] **Step 6: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add deploy/agent-dist/build.sh deploy/agent-dist/build_test.sh deploy/docker-compose.yml \
  deploy/backup/tests/test_policy.py deploy/backup/tests/test_raw_compose.py deploy/backup/fixtures
git -C $W commit -m "feat(deploy): agent-dist builds Nova's agent for six systems from the committed tree; core serves it read-only

Two volumes join the backup pins, each with its disposition: v4_agent_dist (exclude-derived) and v4_agent_build_cache (exclude-ephemeral)."
git -C $W show --stat HEAD | tail -8
```

---

## Task 26: nginx — the downloads and the enroll call pass the gate

**Files:**
- Modify: `apps/web/nginx.conf.template` (two locations; the header comment and the ws location's comment about enroll)
- Modify: `apps/web/gate_test.sh`

**Interfaces:**
- Produces: `location /api/v1/agent/` (ungated, buffering off, 300 s read) and `location = /api/v1/devices/enroll` (ungated), both forwarding `X-Real-IP` like every other location; nothing else under `/api/` changes.

- [ ] **Step 1: Write the failing checks**

In `gate_test.sh`'s "gate ON" block, after the `/api/v1/devices/ws` check:

```bash
  # S42b: the agent downloads and the enroll call are carved out too — the
  # signed manifest and the one-time code are their own credentials. Core is
  # not running here, so "not gated" shows up as 502, never 401.
  for path in "/api/v1/agent/manifest" "/api/v1/agent/dist/novad-linux-amd64" "/api/v1/devices/enroll"; do
    code="$(status_of "$ON_BASE" "$path")"
    [ "$code" != "401" ] && report 0 "gate on, no cookie: $path is NOT gated (got $code, not 401)" \
      || report 1 "gate on, no cookie: $path is NOT gated (got $code, not 401)" "got 401"
  done
  # ...and nothing beside them: the device list, the code mint and a near-miss stay gated.
  for path in "/api/v1/devices" "/api/v1/devices/pairing-code" "/api/v1/devices/enrollx" "/api/v1/agentx"; do
    code="$(status_of "$ON_BASE" "$path")"
    [ "$code" = "401" ] && report 0 "gate on, no cookie: $path -> 401" \
      || report 1 "gate on, no cookie: $path -> 401" "got $code"
  done
```

and in the forwarding block (the stub echoes what arrived), after the WS check from the sidecar address:

```bash
  code="$(client_status "$SIDECAR_IP" "http://$FWD/api/v1/agent/manifest")"
  [ "$code" = "200" ] && report 0 "from $SIDECAR_IP, no header, no cookie: /api/v1/agent/manifest reaches core" \
    || report 1 "from $SIDECAR_IP, no header, no cookie: /api/v1/agent/manifest reaches core" "got '$code'"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/web && bash gate_test.sh 2>&1 | grep -E '^(FAIL|ok ).*(agent|enroll)'`
Expected: `FAIL gate on, no cookie: /api/v1/agent/manifest is NOT gated` (and the two others), because `/api/` gates them today.

- [ ] **Step 3: Implement**

In `nginx.conf.template`, before `# ── Everything else on the API`:

```nginx
    # ── Nova's agent for a machine being added (S42b) ─────────────────────
    # The THIRD and FOURTH deliberate carve-outs from the gate. A machine
    # being added has no cookie and no key yet. What it fetches here is public
    # by design — the manifest is signed by core's own key, and the card's
    # command checks each binary against it on the machine before running
    # anything — and core itself limits these paths to 30 requests a minute
    # (app/agent_dist_api.py). The enroll call's credential is the one-time
    # code: ten minutes, single use, stored hashed. Gating either would stop
    # only the card's own command. Before S42b, enroll stayed gated and
    # pairing through a gated public origin was unsupported; the one-line
    # command made that path the common one.
    location /api/v1/agent/ {
        set $core_upstream http://core:8000;
        proxy_pass $core_upstream$request_uri;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $fwd_proto;
        proxy_buffering off;
        proxy_connect_timeout 5s;
        proxy_read_timeout 300s;
    }

    location = /api/v1/devices/enroll {
        set $core_upstream http://core:8000;
        proxy_pass $core_upstream$request_uri;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $fwd_proto;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }
```

The ws location's comment sentence "Pairing (`/api/v1/devices/enroll`, which mints the key this challenge later checks) is NOT carved out — …; pair via the tailnet … or localhost instead, same as ever." becomes "Pairing (`/api/v1/devices/enroll`) is carved out as well since S42b — see its own location below — because its one-time code is its credential." The header's lines 40–47 say the same.

- [ ] **Step 4: Run it to verify it passes**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/web && bash gate_test.sh 2>&1 | tail -3
```

Expected: `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/web/nginx.conf.template apps/web/gate_test.sh
git -C $W commit -m "feat(web): the agent downloads and the enroll call pass the gate — their credentials are the signed manifest and the one-time code"
git -C $W show --stat HEAD | tail -4
```

---

## Task 27: `./install` installs the hub machine's own agent; `devices_cli`; `install.ps1`

**Files:**
- Create: `services/core/app/devices_cli.py`, `services/core/tests/test_devices_cli.py`
- Modify: `deploy/install.sh` (`install_hub_agent` and its seams; `check_git` in `preflight`; the call in `cmd_install`), `deploy/install_test.sh`
- Create: `install.ps1` (repo root)

**Interfaces:**
- Consumes: `deploy/agent_version.sh` (Task 4), the `agent-dist` service (Task 25), the public manifest and dist paths (Tasks 18, 19), `novad install [--hub URL]... [--if-missing]` and its exit 3 (Task 12), `devices.mint_pairing_code(created_by=None, device_id=, name=)` (Task 15).
- Produces:
  - `python -m app.devices_cli mint --name N` → one JSON line `{"code", "expires_at", "repair"}`; `repair` is true when a live device is called N (its code re-pairs it). Exit 1 with `devices_cli: cannot: …` otherwise.
  - `install_hub_agent` in `install.sh`, after the stack is healthy: builds agent-dist, checks the hub serves that build, downloads the hub's own binary through `http://127.0.0.1:3000`, checks its sha256 against the manifest, runs `novad install --if-missing --hub http://127.0.0.1:3000 [--hub https://<tailnet name>]`, and on exit 3 mints a code named after the machine and passes it as `NOVA_PAIRING_CODE` — never on a command line, never in its output. A WSL hub installs nothing and says where the Windows line is. Any failure fails `./install` with the stack up.
  - `install.ps1`: a Windows hub is told "cannot" plus `wsl --install` (hub-topology D20).

- [ ] **Step 1: Write the failing tests**

`services/core/tests/test_devices_cli.py`:

```python
"""devices_cli (S42b P23): the pairing code ./install hands the hub machine's
own agent — minted with no person (nobody may have registered yet), named
after the machine, and a re-pair code when that name is already paired."""

from __future__ import annotations

import json

from app import devices, devices_cli
from tests.conftest import requires_db
from tests.test_devices_ws import _enroll

pytestmark = requires_db


async def test_mint_prints_one_json_line_with_a_code_for_a_new_name(pool, capsys):
    assert await devices_cli.run(["mint", "--name", "minipc"], pool=pool) == 0
    out = json.loads(capsys.readouterr().out)
    assert set(out) == {"code", "expires_at", "repair"} and out["repair"] is False
    row = await pool.fetchrow("SELECT name, device_id, created_by FROM pairing_codes ORDER BY created_at DESC LIMIT 1")
    assert (row["name"], row["device_id"], row["created_by"]) == ("minipc", None, None)


async def test_mint_for_a_paired_name_is_a_re_pair_code(pool, capsys):
    device_id, _ = await _enroll(pool, name="minipc")
    assert await devices_cli.run(["mint", "--name", "minipc"], pool=pool) == 0
    assert json.loads(capsys.readouterr().out)["repair"] is True
    assert await pool.fetchval("SELECT device_id FROM pairing_codes ORDER BY created_at DESC LIMIT 1") == device_id


async def test_hub_is_refused_as_a_name(pool, capsys):
    assert await devices_cli.run(["mint", "--name", "hub"], pool=pool) == 1
    assert "devices_cli: cannot:" in capsys.readouterr().err
    assert await pool.fetchval("SELECT count(*) FROM pairing_codes") == 0
```

(`_enroll`'s own mint writes a code row with a person; the second test orders by `pairing_codes.created_at` (migration 011) for that reason. The tests hand `run` their own pool; the standalone process opens and closes its own.)

In `deploy/install_test.sh`, a harness for the hub agent and its cases, before the final summary:

```bash
# ---- the hub machine's own agent (S42b P23) -------------------------------
# Every seam that reaches outside is stubbed: the version, the build, the
# fetches, the mint, the WSL check and the binary itself (a script that
# records its argv and the one env var it may read, then exits as told).
run_hub_agent() { # $1 novad first exit, $2 manifest version, $3 fetched file, $4 WSL (0/1), $5 hostname
  (
    # shellcheck source=/dev/null
    . "$SCRIPT_DIR/install.sh"
    set +e
    HUB_T="$(mktemp -d)"
    NOVAD_FIRST="$1"; MANIFEST_V="$2"; FETCHED="$3"; IN_WSL="$4"; HOST_NAME="$5"
    SUM="$(printf '%s' "$FETCHED" | sha256sum | cut -d' ' -f1)"
    agent_version_of() { printf 'aaaaaaaaaaaa'; }
    build_agent_dist() { echo "built $1" >> "$HUB_T/calls"; }
    hub_get() {
      printf '{"manifest":{"v":1,"version":"%s","files":{"linux-amd64":{"name":"novad-linux-amd64","sha256":"%s","size":1}}},"version":"%s"}' \
        "$MANIFEST_V" "$SUM" "$MANIFEST_V"
    }
    hub_fetch() {
      cat > "$2" <<EOF
#!/bin/sh
printf 'argv=%s code=%s\n' "\$*" "\${NOVA_PAIRING_CODE:-}" >> "$HUB_T/novad"
n=\$(wc -l < "$HUB_T/novad")
if [ "\$n" -eq 1 ]; then exit $NOVAD_FIRST; fi
exit 0
EOF
      printf '%s' "" >/dev/null
    }
    sha256_of() { printf '%s' "$SUM"; }
    hub_mint() { echo "mint $1" >> "$HUB_T/calls"; printf '{"code":"ABCD-2345","expires_at":"x","repair":false}\n'; }
    running_in_wsl() { [ "$IN_WSL" = 1 ]; }
    hub_os_arch() { printf 'linux amd64'; }
    hub_hostname() { printf '%s' "$HOST_NAME"; }
    tailnet_dns_name() { return 1; }
    unset NOVA_HUB_AGENT_NAME
    err="$(install_hub_agent 2>&1)"; code=$?
    printf '%s|%s|%s|%s' "$code" "$(tr '\n' ' ' < "$HUB_T/calls" 2>/dev/null)" "$(tr '\n' ' ' < "$HUB_T/novad" 2>/dev/null)" "$(printf '%s' "$err" | tr '\n' ' ')"
    rm -rf "$HUB_T"
  )
}
```

(the stubbed `hub_fetch` writes the fake `novad` and ignores `$FETCHED`; `sha256_of` answers the manifest's sum unless a case overrides it — the mismatch case below redefines it inside its own subshell), then the cases:

```bash
out="$(run_hub_agent 0 aaaaaaaaaaaa x 0 minipc)"
case "$out" in
  "0|built aaaaaaaaaaaa |argv=install --if-missing --hub http://127.0.0.1:3000 code= |"*) report 0 "a hub agent that is installed and running is left alone; no code is minted" ;;
  *) report 1 "a hub agent that is installed and running is left alone; no code is minted" "$out" ;;
esac

out="$(run_hub_agent 3 aaaaaaaaaaaa x 0 MiniPC)"
case "$out" in
  "0|built aaaaaaaaaaaa mint minipc |argv=install --if-missing --hub http://127.0.0.1:3000 code= argv=install --hub http://127.0.0.1:3000 code=ABCD-2345 |"*)
    report 0 "exit 3: a code named after the machine is minted and passed by env, not argv" ;;
  *) report 1 "exit 3: a code named after the machine is minted and passed by env, not argv" "$out" ;;
esac
case "${out##*|}" in
  *ABCD-2345*) report 1 "the pairing code never reaches the log" "$out" ;;
  *) report 0 "the pairing code never reaches the log" ;;
esac

out="$(run_hub_agent 3 aaaaaaaaaaaa x 0 hub)"
case "$out" in
  "1|built aaaaaaaaaaaa |"*"cannot be named 'hub'"*) report 0 "a machine called hub is refused before a code is minted" ;;
  *) report 1 "a machine called hub is refused before a code is minted" "$out" ;;
esac

out="$(run_hub_agent 0 bbbbbbbbbbbb x 0 minipc)"
case "$out" in
  1*"core serves a build other than aaaaaaaaaaaa"*) report 0 "a hub that serves another build is said, and nothing is installed" ;;
  *) report 1 "a hub that serves another build is said, and nothing is installed" "$out" ;;
esac

out="$(run_hub_agent 0 aaaaaaaaaaaa x 1 minipc)"
case "$out" in
  "0|built aaaaaaaaaaaa ||"*"Windows line"*) report 0 "a WSL hub installs nothing and says where the Windows line is" ;;
  *) report 1 "a WSL hub installs nothing and says where the Windows line is" "$out" ;;
esac

out="$(run_hub_agent 1 aaaaaaaaaaaa x 0 minipc)"
case "$out" in
  1*"the hub's agent was not installed (novad install exited 1"*) report 0 "a failed install fails ./install and says novad's exit" ;;
  *) report 1 "a failed install fails ./install and says novad's exit" "$out" ;;
esac
```

and the sha256 mismatch, which needs its own `sha256_of`:

```bash
out="$(
  . "$SCRIPT_DIR/install.sh"; set +e
  agent_version_of() { printf 'aaaaaaaaaaaa'; }; build_agent_dist() { :; }
  hub_get() { printf '{"manifest":{"files":{"linux-amd64":{"name":"novad-linux-amd64","sha256":"%064d","size":1}}},"version":"aaaaaaaaaaaa"}' 0; }
  hub_fetch() { printf 'not the build' > "$2"; }; sha256_of() { printf '%064d' 1; }
  running_in_wsl() { return 1; }; hub_os_arch() { printf 'linux amd64'; }
  (install_hub_agent) 2>&1; echo "rc=$?"
)"
case "$out" in
  *"sha256 is not the manifest's — nothing was run"*"rc=1"*) report 0 "a download whose sha256 is not the manifest's is never run" ;;
  *) report 1 "a download whose sha256 is not the manifest's is never run" "$out" ;;
esac
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd ~/workspace/nova/.worktrees/s42b
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run --project services/core pytest -q services/core/tests/test_devices_cli.py 2>&1 | tail -3
bash deploy/install_test.sh 2>&1 | grep -E 'hub|code|WSL|sha256' | head
```

Expected: FAIL — `No module named 'app.devices_cli'`; `install_hub_agent: command not found`.

- [ ] **Step 3: `devices_cli`**

`services/core/app/devices_cli.py`:

```python
"""`python -m app.devices_cli mint --name N` (S42b P23).

The pairing code ./install hands the hub machine's own agent — through the
agent's environment, never a log line. Minted with no person: on a first
install nobody has registered yet. A name that a live device already has
gets a RE-PAIR code bound to that device (decision 4), so a reinstall keeps
the machine's row and history. Prints one JSON line: {"code", "expires_at",
"repair"}. Exit 1, with the reason on stderr, when the code cannot be minted.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from app import db, devices


async def _mint(pool, name: str) -> dict:
    row = await devices.get_live_by_name(pool, name)
    minted = await devices.mint_pairing_code(
        pool,
        created_by=None,
        device_id=row["id"] if row is not None else None,
        name=None if row is not None else name,
    )
    return {**minted, "repair": row is not None}


async def run(argv: list[str], *, pool=None) -> int:
    """The verb. `pool` is the caller's (a test's); without one this opens
    core's own from DATABASE_URL and closes it before returning."""
    parser = argparse.ArgumentParser(prog="python -m app.devices_cli")
    verbs = parser.add_subparsers(dest="verb", required=True)
    mint = verbs.add_parser("mint", help="a pairing code for the hub machine's own agent")
    mint.add_argument("--name", required=True, help="the machine's name")
    args = parser.parse_args(argv)
    own = pool is None
    if own:
        pool = await db.get_pool()
    try:
        out = await _mint(pool, args.name)
    except devices.DeviceRefused as exc:
        print(f"devices_cli: cannot: {exc.reason}", file=sys.stderr)
        return 1
    finally:
        if own:
            await db.close_pool()
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(sys.argv[1:])))
```

(`mint_pairing_code` with a name runs `_clean_name`, which refuses `hub` with `DeviceRefused` (Task 15, P14).)

- [ ] **Step 4: `install_hub_agent`**

In `deploy/install.sh`, a new section before `# ---- hardware detect`:

```bash
# ---- the hub machine's own agent (S42b P23) ---------------------------------
#
# ./install always installs Nova's agent on the machine it runs on (owner
# decision 6): built here from the committed apps/novad tree (agent-dist),
# fetched through the hub's own loopback door — so its tile says Hub — and
# checked against the manifest before it runs. A running agent is left alone:
# updating it is Nova's job, one idle machine at a time, this one first.
HUB_LOOPBACK="http://127.0.0.1:3000"

# Seams, each one thing the tests stub.
agent_version_of() { bash "$DEPLOY_DIR/agent_version.sh" "$REPO_ROOT"; }
build_agent_dist() {
  git -C "$REPO_ROOT" archive --format=tar HEAD apps/novad \
    | docker compose "${COMPOSE_ARGS[@]}" --profile build run --rm -T agent-dist "$1"
}
hub_get() { curl -fsS --max-time 30 "$HUB_LOOPBACK$1"; }
hub_fetch() { curl -fsS --max-time 300 -o "$2" "$HUB_LOOPBACK$1"; }
hub_mint() { docker compose "${COMPOSE_ARGS[@]}" exec -T core python -m app.devices_cli mint --name "$1"; }
running_in_wsl() { grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; }
hub_hostname() { hostname -s 2>/dev/null || hostname; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
hub_os_arch() {
  local os arch
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) return 1 ;; esac
  printf '%s %s' "$os" "$arch"
}

install_hub_agent() {
  local version manifest os arch key file want tmp rc minted code dns name
  version="$(agent_version_of)" || die "the hub's agent: its version cannot be read (above) — nothing was built"
  log "Building Nova's agent $version for six systems (agent-dist)..."
  build_agent_dist "$version" >&2 || die "the hub's agent: agent-dist did not build $version (its words are above)"
  manifest="$(hub_get /api/v1/agent/manifest)" || die "the hub's agent: core did not serve the agent manifest at $HUB_LOOPBACK"
  case "$manifest" in
    *"\"version\":\"$version\""*) ;;
    *) die "the hub's agent: core serves a build other than $version — read core's log for agent_dist" ;;
  esac
  if running_in_wsl; then
    log "This hub runs inside WSL, so this PC's agent is the Windows one (D1): in Nova, Settings →"
    log "  Devices → Pair a device, choose Windows, and run its Windows line in PowerShell."
    return 0
  fi
  read -r os arch <<EOF_ARCH
$(hub_os_arch)
EOF_ARCH
  [ -n "${arch:-}" ] || die "the hub's agent: Nova has no build for this machine ($(uname -s) $(uname -m))"
  key="$os-$arch"
  file="novad-$key"
  want="$(printf '%s' "$manifest" | sed -n "s/.*\"$key\":{\"name\":\"$file\",\"sha256\":\"\([0-9a-f]\{64\}\)\".*/\1/p")"
  [ -n "$want" ] || die "the hub's agent: the manifest names no $file"
  tmp="$(mktemp -d)"
  if ! hub_fetch "/api/v1/agent/dist/$file" "$tmp/novad"; then
    rm -rf "$tmp"; die "the hub's agent: $file did not download from $HUB_LOOPBACK"
  fi
  if [ "$(sha256_of "$tmp/novad")" != "$want" ]; then
    rm -rf "$tmp"; die "the hub's agent: the download's sha256 is not the manifest's — nothing was run"
  fi
  chmod 0755 "$tmp/novad"
  set -- --hub "$HUB_LOOPBACK"
  dns="$(tailnet_dns_name 2>/dev/null)" || dns=""
  [ -z "$dns" ] || set -- "$@" --hub "https://$dns"
  rc=0; "$tmp/novad" install --if-missing "$@" >&2 || rc=$?
  if [ "$rc" -eq 3 ]; then
    # Its name: NOVA_HUB_AGENT_NAME when set, else the hostname — never "hub".
    name="${NOVA_HUB_AGENT_NAME:-}"
    [ -n "$name" ] || name="$(hub_hostname)"
    name="$(lowercase "$name")"
    if [ "$name" = "hub" ]; then
      rm -rf "$tmp"
      die "this machine's agent cannot be named 'hub' — that name is the bundled engine's (D8); run NOVA_HUB_AGENT_NAME=<a name> ./install"
    fi
    minted="$(hub_mint "$name")" || { rm -rf "$tmp"; die "the hub's agent: a pairing code could not be minted (above)"; }
    code="$(printf '%s' "$minted" | sed -n 's/.*"code": *"\([^"]*\)".*/\1/p')"
    [ -n "$code" ] || { rm -rf "$tmp"; die "the hub's agent: the mint returned no code"; }
    # By environment only: never a command line (ps shows those) and never a log line.
    rc=0; NOVA_PAIRING_CODE="$code" "$tmp/novad" install "$@" >&2 || rc=$?
  fi
  rm -rf "$tmp"
  [ "$rc" -eq 0 ] || die "the hub's agent was not installed (novad install exited $rc; its words are above) — the stack is up"
  log "Nova's agent on this machine is installed and running (novad status says how)."
}
```

`preflight` gains `check_git` before `check_disk`:

```bash
check_git() {
  command -v git >/dev/null 2>&1 || die "git is needed: ./install builds Nova's agent from this checkout's committed tree"
}
```

`cmd_install` calls `install_hub_agent` right after `check_inference_compute` — after the stack is healthy, so a failure here leaves it up — and before the "Nova is up" line. `NOVA_HUB_AGENT_NAME` is read from the environment of that one run (`NOVA_HUB_AGENT_NAME=<name> ./install`), never written to `deploy/.env`: it matters only the first time, and a key in `.env` would need a backup disposition for nothing.

- [ ] **Step 5: `install.ps1`**

At the repo root:

```powershell
# Nova's hub on Windows (S42b; hub-topology D20): the hub runs in Docker
# inside WSL for now. This states that and gives the one step. It installs
# nothing, and exits 1.
$ErrorActionPreference = 'Stop'
$distros = @()
try {
    $distros = @(& wsl.exe --list --quiet 2>$null | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
} catch { }
if ($distros.Count -eq 0) {
    Write-Output "cannot: Nova's hub runs inside WSL on Windows, and this PC has no WSL distribution."
    Write-Output "Install one from an administrator PowerShell with:  wsl --install"
    Write-Output "then open it and run ./install from this repository there."
    exit 1
}
Write-Output "cannot here: Nova's hub runs inside WSL. Open $($distros[0]) and run ./install from this repository there."
Write-Output "To add this PC as a machine Nova controls instead, run the Windows line from her setup card in PowerShell."
exit 1
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd ~/workspace/nova/.worktrees/s42b
TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run --project services/core pytest -q services/core/tests/test_devices_cli.py 2>&1 | tail -2
bash deploy/install_test.sh 2>&1 | tail -3
bash -n deploy/install.sh && shellcheck -S warning deploy/install.sh deploy/install_test.sh
pwsh -NoProfile -Command '$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path install.ps1), [ref]$null, [ref]$e); if ($e) { $e; exit 1 } else { "install.ps1 parses" }'
```

Expected: `3 passed`; `N passed, 0 failed` with the seven hub-agent cases among them; shellcheck silent; `install.ps1 parses` (skip the pwsh line where pwsh is absent — CI runs it, Task 30).

- [ ] **Step 7: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add services/core/app/devices_cli.py services/core/tests/test_devices_cli.py deploy/install.sh deploy/install_test.sh install.ps1
git -C $W commit -m "feat(deploy): ./install installs the hub machine's own agent — built here, fetched through the loopback door, checked, paired by env"
git -C $W show --stat HEAD | tail -8
```

---
## Task 28: The card on the web — one command per OS, on the chat card, in Settings and on `/add`

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`OsKey`, `AgentManifest`, `getAgentManifest`, `mintRepairCode`, `updateDevice`, `UpdateOutcome`; `SetupCard` and `Device` gain their S42b fields)
- Modify: `apps/web/src/lib/streamChat.ts` (the card frame keeps `commands`, `for_os`, `machine`, `walks`, `notes`, `version`)
- Modify: `apps/web/src/lib/setupSteps.ts` (`OS_KEYS`, `OS_LABELS`, `fillCode`, `defaultOs`; `AGENT_STEPS` loses the build-it-yourself and Linux-only lines)
- Modify: `apps/web/src/components/SetupPanel.tsx` (per-OS tabs), `apps/web/src/pages/chat/MessageBubble.tsx` (passes the card's fields)
- Modify: `apps/web/src/pages/settings/SetupModal.tsx` (reads the public manifest and fills the code; a `repair` mode), `apps/web/src/pages/settings/devicesFormat.ts` (`enrollCommand` removed), `apps/web/src/pages/settings/DevicesSection.tsx` (its API carries the modal's two new calls)
- Modify: `apps/web/src/pages/public/AddPage.tsx` (one request, the public manifest, only once a code is on the page)
- Test: `lib/setupSteps.test.ts`, `lib/streamChat.test.ts`, `components/SetupPanel.test.tsx`, `pages/public/publicPages.test.tsx`, `pages/settings/DevicesSection.test.tsx` (the pairing-modal test)

**Interfaces:**
- Consumes: `GET /api/v1/agent/manifest` → `{version, commands: {linux, macos, windows} | null, commands_reason, walks, notes}` (Task 19; 503 with the reason when there is no build); the chat card's filled `commands` (Task 19); `POST /api/v1/devices/{id}/repair-code` (Task 15); `POST /api/v1/devices/{id}/update` (Task 20).
- Produces:
  - `setupSteps.OS_KEYS = ['linux', 'macos', 'windows']`, `OS_LABELS`, `fillCode(command, code) -> string` (replaces `{CODE}` with the dashed code), `defaultOs(platform: DevicePlatform, forOs?: string | null) -> OsKey` (`wsl` → `windows`).
  - `SetupPanel` props gain `commands?: Record<OsKey, string> | null`, `commandsReason?: string | null`, `walks?: Partial<Record<OsKey, string>> | null`, `notes?: Partial<Record<OsKey, string>> | null`, `forOs?: string | null`, `machine?: string | null`. The per-OS tabs show only while the code is live.
  - `SetupModal` props gain `repair?: {id: string; name: string} | null`; with it, the code is `mintRepairCode(id)` and the title is "Re-pair <name>".
  - `api.getAgentManifest()`, `api.mintRepairCode(id)`, `api.updateDevice(id)` for Task 29.

- [ ] **Step 1: Write the failing tests**

`lib/setupSteps.test.ts` gains:

```ts
import { defaultOs, fillCode, OS_KEYS } from './setupSteps'

describe('the one-liners (S42b P18)', () => {
  it('fills the code slot core left, dashed, and nothing else', () => {
    expect(fillCode('curl … && "$d/novad" install --hub https://x --code {CODE}', 'abcd2345')).toBe(
      'curl … && "$d/novad" install --hub https://x --code ABCD-2345',
    )
    expect(fillCode('no slot here', 'ABCD2345')).toBe('no slot here')
  })
  it('opens on the OS that was asked for, else the one this browser runs, else Linux', () => {
    expect(OS_KEYS).toEqual(['linux', 'macos', 'windows'])
    expect(defaultOs({ os: 'linux', browser: 'chrome', phone: false }, 'wsl')).toBe('windows')
    expect(defaultOs({ os: 'mac', browser: 'safari', phone: false })).toBe('macos')
    expect(defaultOs({ os: 'windows', browser: 'edge', phone: false })).toBe('windows')
    expect(defaultOs({ os: 'ios', browser: 'safari', phone: true })).toBe('linux')
  })
})
```

`components/SetupPanel.test.tsx`: the two tests that pin `novad enroll --server …` now pin the per-OS command (a deliberate move — the build-it-yourself step and its Linux-only wording are gone), and:

```tsx
const COMMANDS = {
  linux: `curl -fsSL ${ADDRESS}/api/v1/agent/dist/novad-linux-amd64 … install --hub ${ADDRESS} --code ABCD-2345`,
  macos: `curl -fsSL ${ADDRESS}/api/v1/agent/dist/novad-darwin-arm64 … install --hub ${ADDRESS} --code ABCD-2345`,
  windows: `curl.exe -fsSL -o $f "${ADDRESS}/api/v1/agent/dist/novad-windows-amd64.exe"; … --code ABCD-2345`,
}
const WALKS = { linux: 'Linux: walked 2026-09-01 (S5)', macos: 'macOS: not walked yet', windows: 'Windows: walked 2026-09-28 (S42a, by hand)' }
const NOTES = { linux: '', macos: '', windows: 'Nova’s agent is unsigned for now.' }

it('a live machine card shows one command per OS, opening on the asked-for one, with its walk and note', () => {
  render(
    <SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={BEFORE}
      commands={COMMANDS} walks={WALKS} notes={NOTES} forOs="wsl" />,
  )
  expect(screen.getByText(COMMANDS.windows)).toBeTruthy()
  expect(screen.getByText('Windows: walked 2026-09-28 (S42a, by hand)')).toBeTruthy()
  expect(screen.getByText('Nova’s agent is unsigned for now.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'macOS' }))
  expect(screen.getByText(COMMANDS.macos)).toBeTruthy()
  expect(screen.getByText('macOS: not walked yet')).toBeTruthy()
  expect(screen.queryByText(/build it as its README says/)).toBeNull()
})

it('no command is said, with the reason, when core could not make one', () => {
  render(
    <SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={BEFORE}
      commands={null} commandsReason="the hub has no agent build yet" />,
  )
  expect(screen.getByRole('alert').textContent).toContain('No command: the hub has no agent build yet')
})

it('an expired or reloaded card shows no command at all (Review Focus 4)', () => {
  const { unmount } = render(
    <SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={AFTER} commands={COMMANDS} />,
  )
  expect(screen.queryByText(COMMANDS.linux)).toBeNull()
  unmount()
  render(<SetupPanel setup="add_machine" address={ADDRESS} code={null} expiresAt={EXPIRES} clock={BEFORE} commands={COMMANDS} />)
  expect(screen.queryByText(COMMANDS.linux)).toBeNull()
})
```

`lib/streamChat.test.ts` — a card frame's S42b fields survive the parser:

```ts
it('keeps a machine card’s commands, walks, notes and the OS it opens on', () => {
  const card = { kind: 'setup_qr', setup: 'add_machine', address: 'https://n', url: 'https://n/add#ABCD-2345', code: 'ABCD-2345',
    expires_at: '2026-09-28T12:10:00Z', machine: 'dell', for_os: 'windows', version: 'aaaaaaaaaaaa',
    commands: { linux: 'l', macos: 'm', windows: 'w' }, walks: { linux: 'L', macos: 'M', windows: 'W' }, notes: { linux: '', macos: '', windows: 'n' } }
  const [event] = parseAll([`data: {"card":${JSON.stringify(card)}}\n\n`])
  expect(event).toEqual({ type: 'card', card })
})
```

`pages/public/publicPages.test.tsx` — `/add` (its `novad enroll` assertions move the same way):

```tsx
const MANIFEST = { version: 'aaaaaaaaaaaa', commands: { linux: 'L --code {CODE}', macos: 'M --code {CODE}', windows: 'W --code {CODE}' },
  commands_reason: null, walks: { linux: 'Linux: walked', macos: 'macOS: not walked yet', windows: 'Windows: walked' },
  notes: { linux: '', macos: '', windows: '' } }

it('makes one request, the public manifest, and fills the code in on the page (P18)', async () => {
  const getManifest = vi.fn(async () => MANIFEST)
  renderPage(<AddPage platform={WINDOWS} hash="#abcd2345" origin={ORIGIN} share={undefined} getManifest={getManifest} />)
  expect(await screen.findByText('W --code ABCD-2345')).toBeTruthy()
  expect(getManifest).toHaveBeenCalledTimes(1)
  expect(getManifest.mock.calls[0]).toEqual([])   // the code never leaves the page
})

it('says why there is no command when the hub has no build', async () => {
  const getManifest = vi.fn(async () => { throw new Error('the hub has no agent build yet') })
  renderPage(<AddPage platform={LINUX} hash="#ABCD-2345" origin={ORIGIN} share={undefined} getManifest={getManifest} />)
  expect((await screen.findByRole('alert')).textContent).toContain('the hub has no agent build yet')
})
```

and the existing "on Windows, says the agent is Linux-only today" test is deleted: it pins the sentence S42b retires (the commit says so).

`pages/settings/DevicesSection.test.tsx`: `renderSection`'s fakes gain `getAgentManifest: vi.fn(async () => MANIFEST)` (the same `MANIFEST` shape as above) and `mintRepairCode`, and "the pairing modal mints a code and shows it with the command on Nova's derived address" asserts `screen.findByText('L --code K7PQ-9XYZ')` where it asserted `novad enroll --server … --code K7PQ-9XYZ` — the Linux line, filled in the browser.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/web && npm test -- --run src/lib src/components/SetupPanel.test.tsx src/pages/public 2>&1 | tail -8`
Expected: FAIL — `fillCode is not exported`, no per-OS buttons, `getManifest` ignored.

- [ ] **Step 3: `api.ts`, `streamChat.ts`, `setupSteps.ts`**

`api.ts`:

```ts
/** The three one-liners' keys (S42b): Linux, macOS, Windows. */
export type OsKey = 'linux' | 'macos' | 'windows'

/**
 * GET /api/v1/agent/manifest — public (S42b P18/P19): the hub's build and the
 * one command per OS core generated, each with a {CODE} slot the page fills.
 * It never carries a code. `commands` is null (with its reason) when there is
 * no address to download from; no build at all is a 503 with the reason.
 */
export interface AgentManifest {
  version: string
  commands: Record<OsKey, string> | null
  commands_reason: string | null
  walks: Record<OsKey, string>
  notes: Record<OsKey, string>
}
export const getAgentManifest = () => apiGet<AgentManifest>('/api/v1/agent/manifest')

/** POST /devices/{id}/repair-code — a code bound to this one machine (S42b decision 4). */
export const mintRepairCode = (id: string) =>
  apiSend<PairingCode>(`/api/v1/devices/${encodeURIComponent(id)}/repair-code`, 'POST')

/** What "update it now" came back with (S42b): sent is NOT confirmed — only the
 *  agent's reconnect on the new build confirms an update. */
export interface UpdateOutcome {
  outcome: 'current' | 'sent' | 'confirmed' | 'rolled_back' | 'not_confirmed' | 'refused' | 'cannot'
  version: string | null
  from_version: string | null
  reason: string | null
  needs_card: boolean
}
export const updateDevice = (id: string) =>
  apiSend<UpdateOutcome>(`/api/v1/devices/${encodeURIComponent(id)}/update`, 'POST')
```

`SetupCard` gains `machine?: string | null; for_os?: string | null; version?: string; commands?: Record<string, string>; walks?: Record<string, string>; notes?: Record<string, string>`. `Device` gains (all optional: absent from a core older than S42b):

```ts
  /** S42b: its socket came through the hub's own loopback door — the hub machine's agent. */
  hub?: boolean
  door?: 'host' | 'tailnet' | null
  mode?: string | null
  /** How its agent starts, in words ("by itself at sign-in (the Windows Run key)"). */
  starts?: string
  /** Against the hub's build: a hash has no order, so "behind" means "not the hub's build". */
  build_state?: 'current' | 'behind' | 'unknown'
  hub_version?: string | null
  last_update?: { version: string; outcome: string; at: string | null; reason: string | null } | null
```

`streamChat.ts`, in the `setup_qr` branch after `expires_at`:

```ts
      for (const key of ['machine', 'for_os', 'version'] as const) {
        if (typeof c[key] === 'string') card[key] = c[key] as string
      }
      for (const key of ['commands', 'walks', 'notes'] as const) {
        const value = c[key]
        if (value !== null && typeof value === 'object' && Object.values(value).every(v => typeof v === 'string')) {
          card[key] = value as Record<string, string>
        }
      }
```

`setupSteps.ts`: `AGENT_STEPS` becomes

```ts
export const AGENT_STEPS = {
  command: 'On the machine you are adding, run this. It downloads Nova’s agent, checks it, installs it and starts it — by itself from then on:',
  wsl: 'On a Windows PC, use the Windows line in PowerShell, not one inside WSL: Nova’s agent runs on Windows itself and reaches WSL through wsl.exe.',
  noCommand: 'No command:',
  phone: 'Open this on the computer you’re adding.',
  phoneSelf: 'Adding this phone itself needs the Nova app, which doesn’t exist yet.',
} as const
```

(`install`, `enroll`, `run` and `unsupported` are gone with the build-it-yourself step), `NOVAD_README` stays for the panel's "what it installs" link, and:

```ts
export type { OsKey } from './api'
import type { OsKey } from './api'

export const OS_KEYS: readonly OsKey[] = ['linux', 'macos', 'windows']
export const OS_LABELS: Record<OsKey, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' }

/** A one-liner with core's {CODE} slot filled — on this page, never sent anywhere. */
export function fillCode(command: string, code: string): string {
  return command.split('{CODE}').join(formatCode(code))
}

/** The tab a card opens on: the OS asked for (a WSL machine is a Windows PC),
 *  else this browser's, else Linux. */
export function defaultOs(platform: DevicePlatform, forOs?: string | null): OsKey {
  if (forOs === 'wsl' || forOs === 'windows') return 'windows'
  if (forOs === 'macos' || forOs === 'linux') return forOs
  if (platform.os === 'windows') return 'windows'
  if (platform.os === 'mac') return 'macos'
  return 'linux'
}
```

- [ ] **Step 4: The panel, the modal, `/add`, the bubble**

`SetupPanel.tsx`: replace the `commandOrigin && !expired` block and the `AGENT_STEPS.install` paragraph with

```tsx
          {!expired && <AgentCommands commands={commands} reason={commandsReason} walks={walks} notes={notes} forOs={forOs} />}
          <p className="text-caption">
            What it installs:{' '}
            <a className="text-accent underline" href={NOVAD_README} target="_blank" rel="noreferrer">
              novad’s README
            </a>
          </p>
```

and add (exported, so `/add` draws the same thing):

```tsx
/** One command per OS (S42b P18), each with where it was walked and its one note. */
export function AgentCommands({
  commands,
  reason,
  walks,
  notes,
  forOs,
  platform = currentPlatform(),
}: {
  commands?: Record<OsKey, string> | null
  reason?: string | null
  walks?: Partial<Record<OsKey, string>> | null
  notes?: Partial<Record<OsKey, string>> | null
  forOs?: string | null
  platform?: DevicePlatform
}) {
  const [active, setActive] = useState<OsKey>(() => defaultOs(platform, forOs))
  if (!commands) {
    return (
      <p role="alert" className="rounded-sm border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning">
        {AGENT_STEPS.noCommand} {reason ?? 'Nova could not make one just now.'}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-caption font-medium">{AGENT_STEPS.command}</p>
      <Tabs tabs={OS_KEYS.map(key => ({ id: key, label: OS_LABELS[key] }))} activeTab={active} onChange={id => setActive(id as OsKey)} />
      <CopyLine value={commands[active]} label={`the ${OS_LABELS[active]} command`} />
      {walks?.[active] && <p className="text-caption text-content-tertiary">{walks[active]}</p>}
      {notes?.[active] && <p className="text-caption">{notes[active]}</p>}
      {active === 'windows' && <p className="text-caption">{AGENT_STEPS.wsl}</p>}
    </div>
  )
}
```

(imports: `Tabs` from `./ui`, `currentPlatform`/`DevicePlatform` from `../lib/devicePlatform`, `OS_KEYS`, `OS_LABELS`, `defaultOs`, `type OsKey` from `../lib/setupSteps`; `enrollCommand` and `fallbackOrigin`'s command use go). `SetupPanelProps` gains the six fields listed in Interfaces; `fallbackOrigin` stays for the QR-less case's wording only.

`MessageBubble.tsx` passes the card's `commands`, `walks`, `notes`, `for_os` and `machine` to `SetupPanel` (as `forOs`, `machine`).

`SetupModal.tsx`: the API gains `getAgentManifest` and `mintRepairCode`; `repair?: {id: string; name: string} | null` picks `api.mintRepairCode(repair.id)` over `api.mintPairingCode()`; the manifest is read alongside, and its failure is the panel's reason, not the modal's:

```tsx
    const manifest = isMachineSetup(setup)
      ? api.getAgentManifest().catch(err => ({ version: '', commands: null, commands_reason: reasonOf(err), walks: null, notes: null }))
      : Promise.resolve(null)
    Promise.all([api.getNetworkAddress(), isMachineSetup(setup) ? (repair ? api.mintRepairCode(repair.id) : api.mintPairingCode()) : Promise.resolve(null), manifest])
```

and the panel gets `commands={filled}` where `filled` maps each command through `fillCode(…, code.code)`, `commandsReason`, `walks`, `notes`. The title is `repair ? \`Re-pair ${repair.name}\` : SETUP_TITLES[setup]`. `DevicesSection.tsx` passes its `api` to the modal, so its `DevicesApi` and `DEFAULT_API` gain `getAgentManifest` and `mintRepairCode` (Task 29 adds `updateDevice`).

`AddPage.tsx`: props gain `getManifest = getAgentManifest`; once `code !== null`, one `useEffect` reads the manifest (state `loading | {manifest} | {reason}`), and the page draws `<AgentCommands commands={filled} reason=… walks=… notes=… platform={platform} />` in place of the three-step list; the phone branch is unchanged. The doc comment's "this page makes no request" becomes: "It makes ONE request, and only once a code is on the page: the public manifest (the one-liners with a {CODE} slot), which never carries the code — the code is filled in here and never sent anywhere." `devicesFormat.ts` loses `enrollCommand`.

- [ ] **Step 5: Run the tests, the type check and the build**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/web
npm test -- --run 2>&1 | tail -4
npx tsc --noEmit && npm run build 2>&1 | tail -2
```

Expected: every test passes; tsc silent; the build succeeds.

- [ ] **Step 6: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/web/src/lib/api.ts apps/web/src/lib/streamChat.ts apps/web/src/lib/streamChat.test.ts apps/web/src/lib/setupSteps.ts \
  apps/web/src/lib/setupSteps.test.ts apps/web/src/components/SetupPanel.tsx apps/web/src/components/SetupPanel.test.tsx \
  apps/web/src/pages/chat/MessageBubble.tsx apps/web/src/pages/settings/SetupModal.tsx apps/web/src/pages/settings/devicesFormat.ts \
  apps/web/src/pages/settings/DevicesSection.tsx apps/web/src/pages/settings/DevicesSection.test.tsx \
  apps/web/src/pages/public/AddPage.tsx apps/web/src/pages/public/publicPages.test.tsx
git -C $W commit -m "feat(web): one command per OS on the card, in Settings and on /add — the code filled in on the page, never sent

The build-it-yourself step and 'the agent runs on Linux today' are retired with S42b; their pins move."
git -C $W show --stat HEAD | tail -8
```

---

## Task 29: The tile — Hub, the build, how it starts, Re-pair, Update

**Files:**
- Modify: `apps/web/src/pages/settings/DevicesSection.tsx` (the tile; the modal's `repair`)
- Modify: `apps/web/src/pages/settings/devicesFormat.ts` (`buildLine`, `lastUpdateLine`, `updateSaid`; `wslNote`'s wording)
- Test: `apps/web/src/pages/settings/DevicesSection.test.tsx`, `apps/web/src/pages/settings/devicesFormat.test.ts`

**Interfaces:**
- Consumes: `Device.hub`, `build_state`, `hub_version`, `starts`, `last_update` (Task 16's `device_spec`); `api.mintRepairCode`, `api.updateDevice`, `UpdateOutcome`, and `SetupModal`'s `repair` (Task 28).
- Produces: a live tile shows a **Hub** badge when `hub`; its subtitle ends with the build ("agent <v> · the hub's build" / "· behind the hub's build <h>"); a second line "Starts <starts>" and, when there is one, "Last update: …"; buttons Rename, **Re-pair**, **Update** (only when `build_state === 'behind'`), Revoke. Update says what came back — "Sent <v>; not confirmed until it reconnects" — and a `needs_card` answer opens the Re-pair card.

- [ ] **Step 1: Write the failing tests**

`devicesFormat.test.ts`:

```ts
import { buildLine, lastUpdateLine, updateSaid } from './devicesFormat'

describe('the build, in words (S42b)', () => {
  it('says behind, never older — a hash has no order', () => {
    expect(buildLine({ build_state: 'behind', hub_version: 'aaaaaaaaaaaa' })).toBe('behind the hub’s build aaaaaaaaaaaa')
    expect(buildLine({ build_state: 'current', hub_version: 'aaaaaaaaaaaa' })).toBe('the hub’s build')
    expect(buildLine({ build_state: 'unknown', hub_version: null })).toBeNull()
  })
  it('says a sent update is not confirmed', () => {
    expect(lastUpdateLine({ version: 'aaaaaaaaaaaa', outcome: 'sent', at: '2026-09-28T12:00:00Z', reason: null }))
      .toContain('aaaaaaaaaaaa sent — not confirmed until it reconnects')
    expect(updateSaid({ outcome: 'confirmed', version: 'aaaaaaaaaaaa', from_version: 'bbbbbbbbbbbb', reason: null, needs_card: false }))
      .toBe('Updated to aaaaaaaaaaaa — it reconnected on it.')
    expect(updateSaid({ outcome: 'sent', version: 'aaaaaaaaaaaa', from_version: 'bbbbbbbbbbbb', reason: null, needs_card: false }))
      .toBe('Sent aaaaaaaaaaaa — not confirmed until it reconnects on it.')
  })
})
```

`DevicesSection.test.tsx` (`renderSection`'s api gains an `updateDevice` fake):

```tsx
it('the hub machine’s tile says Hub, its build and how it starts', async () => {
  renderSection({ listDevices: vi.fn(async () => [device({ last_seen: freshIso(), hub: true, agent_version: 'bbbbbbbbbbbb',
    build_state: 'behind', hub_version: 'aaaaaaaaaaaa', starts: 'by itself (a systemd user service)' })]) })
  const tile = await screen.findByTestId('device-d-1')
  expect(within(tile).getByText('Hub')).toBeTruthy()
  expect(within(tile).getByText(/behind the hub’s build aaaaaaaaaaaa/)).toBeTruthy()
  expect(within(tile).getByText('Starts by itself (a systemd user service)')).toBeTruthy()
})

it('Update says sent, not updated, until the agent reconnects', async () => {
  const updateDevice = vi.fn(async () => ({ outcome: 'sent', version: 'aaaaaaaaaaaa', from_version: 'bbbbbbbbbbbb', reason: null, needs_card: false }))
  renderSection({ updateDevice, listDevices: vi.fn(async () => [device({ last_seen: freshIso(), build_state: 'behind', hub_version: 'aaaaaaaaaaaa' })]) })
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
  expect(await screen.findByText('Sent aaaaaaaaaaaa — not confirmed until it reconnects on it.')).toBeTruthy()
  expect(updateDevice).toHaveBeenCalledWith('d-1')
})

it('an update that needs the owner opens the machine’s re-pair card', async () => {
  const mintRepairCode = vi.fn(async () => ({ code: 'K7PQ9XYZ', expires_at: new Date(Date.now() + 600_000).toISOString() }))
  const updateDevice = vi.fn(async () => ({ outcome: 'cannot', version: 'aaaaaaaaaaaa', from_version: null,
    reason: 'cannot: laptop’s agent was started by hand', needs_card: true }))
  renderSection({ updateDevice, mintRepairCode, listDevices: vi.fn(async () => [device({ last_seen: freshIso(), build_state: 'behind', hub_version: 'aaaaaaaaaaaa' })]) })
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
  expect(await screen.findByText('Re-pair laptop')).toBeTruthy()
  expect(mintRepairCode).toHaveBeenCalledWith('d-1')
})
```

The pin "a paired device offers exactly rename and revoke — there is no grants control" moves to "offers rename, re-pair and revoke (and Update when behind) — none of them is a grant": the same assertion that no grants control exists, with the two new buttons named.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/workspace/nova/.worktrees/s42b/apps/web && npm test -- --run src/pages/settings 2>&1 | tail -8`
Expected: FAIL — `buildLine` not exported; no Hub badge; no Update button.

- [ ] **Step 3: Implement**

`devicesFormat.ts`:

```ts
/** The build against the hub's (S42b): behind means "not the hub's build" — a hash has no order. */
export function buildLine(d: Pick<Device, 'build_state' | 'hub_version'>): string | null {
  if (d.build_state === 'current') return 'the hub’s build'
  if (d.build_state === 'behind' && d.hub_version) return `behind the hub’s build ${d.hub_version}`
  return null
}

export function lastUpdateLine(u: NonNullable<Device['last_update']>): string {
  const when = u.at ? ` (${new Date(u.at).toLocaleString()})` : ''
  if (u.outcome === 'sent') return `Last update: ${u.version} sent — not confirmed until it reconnects${when}`
  return `Last update: ${u.version} ${u.outcome.replace('_', ' ')}${u.reason ? ` — ${u.reason}` : ''}${when}`
}

export function updateSaid(o: UpdateOutcome): string {
  switch (o.outcome) {
    case 'confirmed': return `Updated to ${o.version} — it reconnected on it.`
    case 'sent': return `Sent ${o.version} — not confirmed until it reconnects on it.`
    case 'current': return 'Already on the hub’s build.'
    case 'rolled_back': return `It did not come up on ${o.version}; its old build was put back — ${o.reason ?? 'no reason given'}.`
    default: return o.reason ?? `The update ${o.outcome.replace('_', ' ')}.`
  }
}
```

`deviceSubtitle` appends `buildLine(device)` when non-null. `wslNote`'s text becomes "Runs inside WSL<distro>. On Windows, Nova's agent runs on Windows itself — add the PC with the Windows line on its card, then revoke this one." (the old "install the Windows agent" pointed at a step that no longer exists).

`DevicesSection.tsx`: `DevicesApi` gains `updateDevice` (Task 28 added the other two); the section keeps `repairing: {id, name} | null` state and passes `repair={repairing}` to `SetupModal` (`setup={pairingOpen || repairing ? 'add_machine' : null}`); `DeviceTile` gains `onRepair` and, in the live controls before Revoke:

```tsx
            <Button size="sm" variant="ghost" onClick={() => onRepair(device)}>Re-pair</Button>
            {device.build_state === 'behind' && (
              <Button size="sm" variant="secondary" loading={updating} onClick={doUpdate}>Update</Button>
            )}
```

with

```tsx
  async function doUpdate() {
    setUpdating(true)
    setUpdateSaidText(null)
    try {
      const out = await api.updateDevice(device.id)
      setUpdateSaidText(updateSaid(out))
      if (out.needs_card) onRepair(device)
    } catch (err) {
      setUpdateSaidText(`Could not update: ${reasonOf(err)}`)
    } finally {
      setUpdating(false)
    }
  }
```

a `Hub` badge (`<Badge size="sm" color="accent">Hub</Badge>`) beside the name when `device.hub`, and under the controls: `Starts {device.starts}` when present, `lastUpdateLine(device.last_update)` when present, and the update's words.

- [ ] **Step 4: Run the tests, tsc and the build**

```bash
cd ~/workspace/nova/.worktrees/s42b/apps/web
npm test -- --run 2>&1 | tail -4
npx tsc --noEmit && npm run build 2>&1 | tail -2
```

Expected: pass; silent; built.

- [ ] **Step 5: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/web/src/pages/settings/DevicesSection.tsx apps/web/src/pages/settings/DevicesSection.test.tsx \
  apps/web/src/pages/settings/devicesFormat.ts apps/web/src/pages/settings/devicesFormat.test.ts
git -C $W commit -m "feat(web): the device tile says Hub, its build and how it starts, and offers Re-pair and Update — sent is not updated

The 'exactly rename and revoke' pin moves: Re-pair and Update join, and neither is a grant."
git -C $W show --stat HEAD | tail -5
```

---

## Task 30: CI — the new scripts, the agent-dist build against CI's, `install.ps1`

**Files:**
- Modify: `.github/workflows/rebuild-ci.yml`

**Interfaces:**
- Produces: the `installer` job checks and runs `deploy/agent-dist/build_test.sh` and parses `install.ps1`; the `novad` job builds the six targets through `deploy/agent-dist/build.sh` in the pinned `golang:1.27.1` image and diffs its `SHA256SUMS` against CI's own build — D13's "one tree builds one sha256" checked on every push.

- [ ] **Step 1: The installer job**

After the `agent_version` lines Task 4 added:

```yaml
      - run: bash -n deploy/agent-dist/build_test.sh && sh -n deploy/agent-dist/build.sh
      - run: shellcheck -S warning -s sh deploy/agent-dist/build.sh && shellcheck -S warning deploy/agent-dist/build_test.sh
      - run: ./deploy/agent-dist/build_test.sh
      - name: install.ps1 parses (a Windows hub is told cannot, D20)
        shell: pwsh
        run: |
          $e = $null
          [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path install.ps1), [ref]$null, [ref]$e)
          if ($e) { $e; exit 1 }
```

- [ ] **Step 2: The novad job — agent-dist builds what CI builds**

After the step "six targets, built twice, identical":

```yaml
      - name: agent-dist builds what CI builds (D13)
        run: |
          set -eu
          V=$(git rev-parse HEAD:apps/novad | cut -c1-12)
          IMAGE=$(sed -n 's/^ *image: \(golang:1\.27\.1@sha256:[0-9a-f]*\)$/\1/p' deploy/docker-compose.yml)
          test -n "$IMAGE"
          mkdir -p /tmp/agent-dist
          git archive --format=tar HEAD apps/novad | docker run --rm -i -e CGO_ENABLED=0 -e GOTOOLCHAIN=local \
            -e DIST_DIR=/dist -v /tmp/agent-dist:/dist -v "$PWD/deploy/agent-dist:/build:ro" "$IMAGE" sh /build/build.sh "$V"
          (cd "/tmp/agent-dist/$V" && sha256sum novad-* | sort) > /tmp/dist.sha
          (cd /tmp/novad-a && sha256sum novad-* | sort) > /tmp/ci.sha
          diff /tmp/dist.sha /tmp/ci.sha
```

(`/tmp/novad-a` is the first of the two builds the step before it made; both stamp `V` the same way since Task 4.)

- [ ] **Step 3: Lint and commit**

```bash
W=~/workspace/nova/.worktrees/s42b
python3 -c "import yaml; yaml.safe_load(open('$W/.github/workflows/rebuild-ci.yml')); print('yaml ok')"
git -C $W add .github/workflows/rebuild-ci.yml
git -C $W commit -m "ci: agent-dist's tests, install.ps1's parse, and agent-dist's build diffed against CI's own"
git -C $W show --stat HEAD | tail -3
```

The native legs (`novad-native`: macOS and both Windows runners) already run `go test ./...`, which now includes Tasks 5–12's per-OS tests and Task 10c's Windows branch test; nothing to add there.

---

## Task 31: Docs, and the carries

**Files:**
- Modify: `apps/novad/README.md` ("Install per OS" becomes the one command and `novad install`/`uninstall`/`supervise`; exit codes 3, 75; updates; re-pair; "Running interactively")
- Modify: `deploy/README.md` (`./install` installs the hub machine's agent; `NOVA_HUB_AGENT_NAME`; agent-dist; the two volumes)
- Modify: `docs/plans/rebuild/hub-topology.md` (§S42b: status and the decisions this plan made, by P-number), `docs/plans/rebuild/ROADMAP.md` (the hub-lane row: S42b built, walk pending; S42c next)
- Create: `docs/plans/rebuild/slice-42b-install-and-updates.md` (the close-out, filled in Task 32), `docs/plans/rebuild/slice-42b-carries.md`

- [ ] **Step 1: The agent README**

"Install per OS (manual until S42b…)" becomes "## Install" with: the card's one command per OS (what it does: download from the hub, check the sha256 against the signed manifest, `novad install`); where the binary goes (P1) and the service each OS gets (systemd user unit + linger / LaunchAgent `nova.novad` / HKCU Run value "Nova agent", P3–P6); "installed" means the status file said `ready` (P5); `novad install [--hub URL]... [--code C] [--name N] [--if-missing] [--restart-later]` and `NOVA_PAIRING_CODE`; `novad uninstall [--forget]` (P21); `novad supervise --mode <m>` (what a unit runs; not by hand). "## Updates": the hub's build is the desired state; Nova sends it one idle machine at a time, the hub's own first; `supervise` swaps in the new build, keeps `.prev`, and puts it back if the new one does not reach `ready` in 120 s; an update is confirmed only by the reconnect (P7–P11). "## Re-pair": a card bound to a machine (decision 4). The exit-code list gains 3 and 75. "Running interactively" says a hand-started agent is `foreground`: Nova cannot restart or update it (P12).

- [ ] **Step 2: deploy/README and the plans**

`deploy/README.md`: a section "The hub machine's own agent" — `./install` builds agent-dist from the committed `apps/novad` tree (a dirty tree stops it), installs this machine's agent through `http://127.0.0.1:3000` so its tile says Hub, pairs it by environment (`NOVA_HUB_AGENT_NAME=<name> ./install` to name it; never `hub`), and leaves a running one alone; a WSL hub installs nothing and points at the Windows line; the volumes `v4_agent_dist` and `v4_agent_build_cache` and why neither is backed up. `hub-topology.md` §S42b: "Built (plan: `s42b/plan.md`); walk pending" plus one line per P-decision. `ROADMAP.md`: the hub-lane row's "**S42b next**" becomes "**S42b built 2026-09-XX, walk pending** … **S42c next** (the admin helper)".

- [ ] **Step 3: The close-out skeleton and the carries**

`slice-42b-install-and-updates.md` mirrors `slice-42a-agent-every-os.md`'s headings — Status, What shipped, Decisions made where the spec was silent (P1–P31, one line each), Rulings made during the build, Review rounds, Gates, CI, The walk, The eval, For the owner — each filled in Task 32.

`slice-42b-carries.md` opens with these, each with why it waits:
- **No retired-key table (P13):** an old key still running after a re-pair retries with "signature did not verify" until it is stopped.
- **No self-revoke (P21):** `uninstall` keeps the identity and says to revoke it in Settings.
- **An eval case for acting on the facts (P29):** a declared device is read-only to the device tools, so "retire the old agent" cannot be scored in the corpus; it waits for a fixture that can answer `device_run`.
- **The WSL look runs as each distro's default user only;** a Nova agent under another user's unit is seen as a process (`novad` pid), not as a unit.
- **`sudo -n` can write an auth-log line at each probe** (connect and refresh only).
- **The public paths' limit is global (30 a minute), not per address.**
- **She stated causes she never checked** (turn `01faf3b7`: "likely a sudo prompt" and a procedure for him, 2026-09-28). S42b gives her the facts; the reply-level guard is the coordinator's `fix/handback-guard`, not this slice's.
- **Task 10c's Windows half, on Task 1's branch T3 only:** the agent could not take the terminal away from `wsl.exe`'s Linux side; the readings and the owner question go here.
- **The admin helper (S42c):** `platform.AdminInstallDir` is declared, nothing uses it.
- **The macOS walk:** until the owner walks a Mac, `platform_walks.json` says "not walked", and the eval pins that she says so.

- [ ] **Step 4: Commit**

```bash
W=~/workspace/nova/.worktrees/s42b
git -C $W add apps/novad/README.md deploy/README.md docs/plans/rebuild/hub-topology.md docs/plans/rebuild/ROADMAP.md \
  docs/plans/rebuild/slice-42b-install-and-updates.md docs/plans/rebuild/slice-42b-carries.md
git -C $W commit -m "docs(s42b): install, service, updates and re-pair in the READMEs; the close-out skeleton and the carries"
git -C $W show --stat HEAD | tail -8
```

---
## Task 32: Gates, the whole-branch review, merge, deploy, the walk, the eval, the close-out

Nothing here is done while it is only in the worktree (owner, 2026-09-25): the stack, the hub's agent and every agent-dist build come from `~/workspace/nova` on `main`.

**Files:**
- Modify: `docs/plans/rebuild/slice-42b-install-and-updates.md` (filled), `docs/plans/rebuild/slice-42b-carries.md` (review findings appended), `services/core/app/platform_walks.json` (the rows walked), `docs/plans/rebuild/ROADMAP.md` (the date)

- [ ] **Step 1: Every gate on the branch**

```bash
W=~/workspace/nova/.worktrees/s42b
for svc in core gateway memory; do
  (cd $W/services/$svc && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42b uv run pytest -q -rs 2>&1 | tail -3; uv run ruff check .)
done
(cd $W/apps/web && npm test -- --run 2>&1 | tail -3 && npx tsc --noEmit && npm run build 2>&1 | tail -1 && bash gate_test.sh 2>&1 | tail -1)
(cd $W/apps/novad && ~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -3 && for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./...; done)
bash $W/deploy/install_test.sh | tail -1; bash $W/deploy/agent_version_test.sh | tail -1; bash $W/deploy/agent-dist/build_test.sh | tail -1
uv run --project $W/deploy/backup pytest -q -m "not live" $W/deploy/backup/tests 2>&1 | tail -1
shellcheck -S warning $W/deploy/install.sh $W/deploy/install_test.sh $W/deploy/agent_version.sh $W/deploy/agent-dist/build_test.sh && shellcheck -S warning -s sh $W/deploy/agent-dist/build.sh
git -C $W diff --stat origin/main...HEAD | tail -1
```

Expected: every suite passes with **0 skipped** in core (report the count); ruff, tsc, vet and shellcheck silent. `test_no_approvals.py` is unchanged in the diff (`git -C $W diff origin/main...HEAD -- services/core/tests/test_no_approvals.py` prints nothing).

- [ ] **Step 2: An adversarial whole-branch review**

A fresh reviewer on the most capable model reads `git diff origin/main...HEAD` against this plan, `design-inputs.md` (the owner's decisions) and the Review Focus list, and is asked to break it: every Review Focus item against its named test (does the test fail when the protection is removed?); every *cannot* against "never *may not*"; every success message against "checked, or it fails and says why"; every agent-reported string that reaches a line against the control-character rule; the public paths against what they could leak; the update path against a build that never comes up. Findings are fixed in the branch, each fix with its test; the reviewer re-reads the fixes. Findings that wait are appended to `slice-42b-carries.md` under "From the build's reviews".

- [ ] **Step 3: The PR, and the merge on the owner's word**

Push `slice/s42b` and open the PR (title "S42b — install, service, downloads, the card, the hub's agent, re-pairing and Nova-managed updates"; the body: what shipped, the P-decisions table, the Phase-0 branches taken, the gates, the carries; it ends with the PR attribution lines this session was given). Merging needs the owner's "merge it" (auto mode blocks `gh pr merge` without it). After the merge: `git -C ~/workspace/nova pull --ff-only` on `main`.

- [ ] **Step 4: Deploy from `~/workspace/nova` on `main`**

```bash
cd ~/workspace/nova && git status --short && git log -1 --oneline
./install
```

Expected: the health table all healthy, then "Building Nova's agent <V> for six systems (agent-dist)...", then novad's own report (paired as the hub machine's name, the service registered, the status file `ready`), then "Nova's agent on this machine is installed and running". A failure here stops the walk: it is read (novad's words, core's log for `agent_dist`) and fixed as code, never worked around by hand.

- [ ] **Step 5: The owner's steps on the Dell (owner)**

1. Close the PowerShell window the S42a agent runs in (its hand-started copy holds no lock, so it and the service would otherwise both speak for the Dell — Review Focus 4).
2. Ask Nova, in his words, for "the setup card for my PC", and run its Windows line in an ordinary PowerShell. (It keeps the Dell's pairing; the code goes unused.)
3. Sign out of Windows and back in.

- [ ] **Step 6: The walk — his words, every turn read by its id**

Each step is asked in chat in the owner's own words, then the turn is read by id (`SELECT … FROM turn_spans WHERE turn_id = '<id>' ORDER BY started_at`) — a reply is a claim, the trace is the fact. Record each turn id, the tools that ran, and the verdict in the close-out's "The walk".

1. "Is the hub's own agent connected?" — `device_list` or `machine_status`; the mini PC's line says "the hub's own machine" and "the hub's build".
2. "Is Nova's agent on my PC running properly now?" — the Dell connected, "starts by itself at sign-in (the Windows Run key)", on the hub's build — after the sign-out, so this is also "starts by itself" checked.
3. **"retire the old Nova agent in WSL on my PC"** — his words only, nothing about the distro, the unit or a command (P31). Done when the trace shows her reading the Dell's WSL facts (`device_info` or `device_list`), stopping and disabling the old agent without asking him to type anything, a fresh `device_info` showing `novad.service` inactive and no `novad` process in `Ubuntu-26.04`, and `device_list` showing the revoked row's knocks stopped. Turns `3743df3b` (Windows' own `sudo`, exit `0x80070005`, the crash-loop hotfix #84 answered), `73574d49` (`$(pgrep nova-agent)`: a shell she assumed and a name that does not exist) and `01faf3b7` (`sudo systemctl --user` inside WSL: 110 s of silence, then a procedure handed to him) are the before; the close-out quotes them beside the after. If the old agent is already gone when this runs — the coordinator's attempt of 2026-09-28 succeeded — the step records that turn and what showed it, and is not staged again. A reply that hands him a procedure or states a cause she did not check fails the step, whatever else went right.
4. "What's on my desktop on the PC?" — `device_list_files` with `@desktop`, resolved on the Dell (OneDrive's Desktop), listing real entries.
5. "What runs in WSL on my PC now?" — `device_info` on the Dell; the WSL line comes from the probe, and the old unit reads inactive.
6. The Mac, if one is at hand: "add my Mac mini" → the card's macOS line, run by the owner → connected, "starts by itself at login (a LaunchAgent)". With no Mac, the step records "not walked", and the ledger keeps saying so.
7. Re-pair: the owner runs `novad uninstall --forget` on one machine (owner step), then asks "re-pair my laptop" → the card bound to it → he runs its line → `device_list` shows the same name, its history kept (the Devices tile's audit and enrolled date unchanged), a new key.
8. Nova-managed updates: a follow-up commit on `main` that changes `apps/novad` (the README's "Updates" section gains the walk's date is enough — the tree changes), then `./install` on the mini PC. Ask "update the hub's agent now" → `machine_update` → "sent", then after the reconnect "confirmed" (ask "did it update?" — `machine_status`'s last update line); then, without asking, the `agent_updates` job updates the Dell at its next idle moment within 15 minutes — read the job's firings (`list_timers` / Schedules) and ask "is my PC on the hub's build?".

- [ ] **Step 7: The eval, three times, through the runner**

Run `agent_quality` three times through the eval runner (never ad-hoc turns), with the fixed models the S42a eval used, and record each run's per-case verdicts; the two new cases must pass in all three, and any case that regressed against the S42a run is read before it is explained.

- [ ] **Step 8: The screen at 393 px**

Screenshot Settings → Devices (the Hub tile, a behind tile with Update, the Dell's "starts" line) and the chat card with its three tabs at 393 × 852, through the mcr playwright image (node:alpine has no WebGL). Attach to the close-out.

- [ ] **Step 9: The ledger, the close-out, the memory, the cleanup**

`platform_walks.json`: each row walked in Step 6 gets its date (a commit on `main` through a PR, like any other). Fill every section of `slice-42b-install-and-updates.md`: what shipped, the P-decisions and the Phase-0 branches taken, rulings made during the build, review rounds, gates with counts, CI, the walk (turn ids and verdicts), the eval (three runs), and "For the owner" — what he can do now, what is not walked, the carries that need his word. `ROADMAP.md` gets the date. Update the hub-lane memory (S42b closed; S42c next). Remove the worktree (`git -C ~/workspace/nova worktree remove .worktrees/s42b`) once the branch is merged, and drop `nova_core_s42b` from `nova-scratch-pg`.

---

## Self-review

**Spec coverage.** Owner decision 1 (scope b; the helper to S42c): Tasks 5–12 build the user-level install, S42c's seam is `platform.AdminInstallDir` (P1), nothing admin is built. Decision 2 (Nova-managed updates): Tasks 9–10 (supervise, `daemon.update`, `.prev`), Task 20 (ledger, reconnect-only confirmation, one in flight, hub first, the 15-minute job, the check), Task 22 (`machine_update`), Tasks 23–24 (the honesty guards and evals), P11 for agents that predate the capability. Decision 3 (retire the WSL agent): P28 (knocks), P29 (the WSL facts that locate it), P30 (commands that cannot hang), P31 and Task 32 Step 6.3 (the walk in his words). Decision 4 (re-pair code): Tasks 14–15, 19, 28–29. Decision 5 (binary locations): P1, Task 12. Decision 6 (`./install` installs the hub's agent): Tasks 25–27. The walk/eval findings: "Desktop" on the agent (P16, Tasks 7, 16, 21) and the WSL fact (P17, Tasks 16b, 21). The owner requirement of 2026-09-28 (agents report what she needs; no handing him commands he did not expect): P29–P31, Tasks 1 (Step 2b), 10b, 10c, 16b, 21, 22, 32; its reply-level half is `fix/handback-guard`'s, noted in the Global Constraints and the carries. `hub-topology.md` §S42b: the per-OS card (Tasks 19, 28), public paths and gate carve-outs (Tasks 18, 26), agent-dist and the signed manifest (Tasks 18, 25), locators (Task 6), the Hub badge (P15, Tasks 17, 29), `install.ps1` (Task 27). The controller's corrections: migration 038 and the void 037 reservation (Global Constraints, Task 14); uint32 and malformed frames (P27, Task 13, Review Focus 3); the 17:04 evidence (P28, Tasks 17, 21, Review Focus 10).

**Placeholder scan.** Values that only a measurement can give are named with their source and both branches: the `golang:1.27.1` digest (Task 2 → Task 25), `WINDOWS_NOTE`/`LINUX_NOTE` (Tasks 1, 3 → Task 19), `WINDOWS_SUDO_FROM_AGENT` (Task 1 Step 2b → Task 16b), the `wsl.exe` shell sentence (Task 1 → Task 21), the Windows terminal mechanism (T1/T2/T3 → Task 10c), the registry list (L-reg/L-cli → Task 10b), the door's source address (Task 2 → Task 17), Task 9's rename branch (R1/R2). No step says "add error handling" or "similar to".

**Type consistency.** `UpdateOutcome` fields (Task 20) are what `GatewayPlant.update_agent` spreads and `machine_update` reads (Task 22), plus `hub`; the fixture plant returns the same keys. `agent_view` keys: Task 16 adds `mode`, `starts`, `build`, `hub`, `last_update`, `folders`; Task 16b adds `acting`; Tasks 21–22 read exactly those. The facts frame keys Task 10b sends (`service`, `elevation`, `wsl_distros`, `probed_at`, and inside them `novad_unit`, `novad_pids`, `running_said`, `sudo_said`) are the ones Task 16b validates. `device_facts.SERVICE_MODES`, `FOLDER_NAMES` and `folders_of` are defined in Task 16 before Tasks 20–21 use them. `agent_card.notes()` is added to Task 19 and read by Task 28 through the manifest and the card.

**Review Focus.** Fourteen items, each with its test and owning task; the Windows→WSL half of item 12 cannot run in CI and is said to be proven by Task 1's matrix and the walk instead.
