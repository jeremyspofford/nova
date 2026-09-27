# S42a — the agent on every OS

## Status

## What shipped

## Decisions made where the spec was silent

These are for the owner to review; each is visible in the code that implements it.

| # | Where the spec is silent | This plan decides |
|---|---|---|
| P1 | Which facts-frame sections S42a fills | `net.ifaces` (`name`, `mac`, `ipv4_cidr[]`, `up`) plus `unreadable[]`. Later slices add their sections (power, ollama, compute, hold, overlay) to core's allow-list beside their validators. |
| P2 | Two frames feed one jsonb column: merge or replace? | Auth facts **replace** `devices.facts` (a new connection is a fresh truth). A `facts` frame **merges** its sections (`jsonb \|\|`). `facts_at` is the time of the last write. Unknown keys are dropped, so stored facts are only what core validated. |
| P3 | Is `machine_uid` raw or hashed? | `sha256("nova/machine-uid/v1:" + lowercase raw id)`, as hex. The raw id never leaves the machine (machine-id(5)). Sources: Linux `/etc/machine-id` (fallback `/var/lib/dbus/machine-id`), macOS `IOPlatformUUID` from `/usr/sbin/ioreg`, Windows `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`. |
| P4 | How WSL is detected, and what is refused | Detection: the kernel release (`/proc/sys/kernel/osrelease` contains `microsoft`), never environment variables, since the systemd unit inside WSL gets none (r1-wake-critique:114). `distro` comes from `WSL_DISTRO_NAME`, or `""`. **`novad enroll` refuses inside WSL**; `novad run` does not. An in-WSL agent reports `os.wsl`, and core derives every role as `cannot: this machine's Windows agent owns it`. |
| P5 | What "revoked" wipes, and how the agent stops | Core sends `auth_error{reason:"revoked"}` **only** for a revoked row; an unknown id gets a different reason. On that exact reason the agent: deletes `config.json` and `key`; renames `audit.jsonl` to `audit.jsonl.revoked-<unix>` (kept, but never replayed under a new id); exits **78**. `novad.service` gains `RestartPreventExitStatus=78`. `novad run` with no enrollment also exits 78. The live-revoke 4403 close is unchanged: the agent reconnects about 1 s later, meets `revoked` at the handshake, and wipes. |
| P6 | Config and state locations per OS | **Linux:** unchanged (XDG), so enrolled daemons keep working. **macOS:** `~/Library/Application Support/novad` for both. **Windows:** config in `%AppData%\novad` (`os.UserConfigDir`, per the spec); state and audit in `%LocalAppData%\novad` (never roams). Both Windows directories get the D-M11 DACL. |
| P7 | The DACL, exactly | SDDL `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;<user SID>)`: protected, SYSTEM plus the owning user, inherited by files. A Windows-runner test reads it back and fails on any other ACE. |
| P8 | The dispatch table's shape | `caps.Handler func(ctx, caps.Request) caps.Outcome`, where `caps.Request` is `{Args, Deps}`. `caps.Dispatch` stays the entry point (S44's isolation test names it). `caps.Names()` derives the list for S30's `daemon.info`. `facts.refresh` is the first capability added. |
| P9 | shell.exec process groups | **Unix:** `Setpgid` plus a `Cancel` that kills the whole group. **Windows:** `CREATE_NEW_PROCESS_GROUP` plus `Cancel` = `taskkill /T /F /PID`. `WaitDelay` is 5 s everywhere. A context cancelled by a dropped connection (not a deadline) is `ok:false` "cancelled"; it used to be reported `ok:true`, exit -1. Windows adds `WSL_UTF8=1` so `wsl.exe` prints UTF-8. |
| P10 | Toast and app mechanisms | **Windows toast:** WinRT via Windows PowerShell 5.1, a constant `-EncodedCommand` script, the message on stdin as UTF-8, and PowerShell's registered AppUserModelID. **macOS notify:** `osascript` with the message as argv (`on run argv`). **Windows apps:** `Get-StartApps` for the list; launch with `explorer.exe shell:AppsFolder\<AppID>`, falling back to a program on PATH. **macOS apps:** scan `*.app`, launch with `open -a`. |
| P11 | "What's on my desktop" on Windows | `system.info` reports `home=` and `desktop=` (the Desktop known folder, which OneDrive may redirect), so the path is read, never guessed. |
| P12 | Liveness details | The backoff resets after any authenticated session. A ping follows each heartbeat, with a 10 s timeout. A wall-clock gap between heartbeat ticks of more than 2 × the interval ends the session: the machine slept. |
| P13 | Grouping "by machine" in S42a | `machine_status` groups agents by `machine_uid`; an agent with none is its own machine. Engines and agents are linked only in S44. `machine_status` records `{"device", "connected"}` for each agent. The state guard accepts any **ok** span that recorded such a fact, not only `device_*` spans. |
| P14 | Duplicate detection | One check, `devices_duplicate_agents`: non-urgent, key `duplicate_agent:<uid[:12]>`, keyed on `machine_uid` only. A WSL agent plus a Windows agent have different ids by construction, so that pair is caught by the WSL role rule. A pre-S42a WSL agent sends no facts at all, so the owner revokes it by hand in the walk. |
| P15 | Eval device fixture | Cases gain a `devices` declaration (`eval_*` names, facts validated by `device_facts.validate_auth`). `machines.FixturePlant.agents()` overlays it. Nothing is written to `devices`. Device *tools* are not intercepted. |
| P16 | Walk topology | The hub is the mini PC. The Windows agent enrolls over `https://nova.<TAILNET>.ts.net`. The distro is `Ubuntu-26.04`. There is no mini-PC-agent step (no such agent exists). |
| P17 | CI | Turn `rebuild-ci` on (the owner's ruling of 2026-09-21 in `s41/rulings.md`: "both halves or neither"). Watch the first run and record red jobs outside S42a as carries. `-race` runs where the race detector exists (Linux and macOS); Windows runners run plain `go test`. |

## Gates

## CI's first run

## The walk

## The eval
