# S42a — the agent on every OS (hands + facts) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `novad` runs natively on Linux, macOS and Windows (amd64 and arm64). It reports facts about its machine, and core records those facts and derives roles from them. The Dell's WSL agent is retired for a Windows-native one.

**Architecture:**
- **One OS seam.** Everything OS-specific in `novad` moves behind `internal/platform/*_{linux,darwin,windows}.go`. The capabilities become a dispatch table whose handlers call the platform, so the same capability names answer on every OS. An OS that cannot do something says "cannot" from inside the handler.
- **Facts on the wire.** The agent sends facts twice: a small, versioned block inside the auth frame, and a `facts` frame after `ready`.
- **Core's side.** Core validates the facts (`device_facts.py`) and stores them in `devices.facts` (migration 036). It derives roles on every read and never stores them. `machine_status` groups Nova's agents by machine.
- **The WSL rule.** An agent inside WSL reads "cannot: this machine's Windows agent owns it". Two agents reporting one machine raise a non-urgent check.

**Tech Stack:**
- **Agent:** Go 1.27; `CGO_ENABLED=0`; `github.com/coder/websocket`; new dependency `golang.org/x/sys` v0.48.0.
- **Core:** Python 3.12 / FastAPI / asyncpg; migration 036.
- **Web:** React + TypeScript, vitest.
- **CI:** GitHub Actions, matrix runners.

**Spec:**
- The index and authority is [`../hub-topology.md`](../hub-topology.md), §"S42a: the agent on every OS (hands + facts)", with owner decisions 1–15 and D1–D21.
- The implementation reference is [`../hub/r2-integration.md`](../hub/r2-integration.md):413-458. It wins over the round-2 designs and critiques.
- The order was reset on 2026-09-25 (`hub-topology.md:512-516`): **S42a → S42b → S46a → S46b → S43a**. [`../s46a/spec.md`](../s46a/spec.md) states what S46a needs from S42a (facts frame, `devices.facts`, `device_facts.py`, `facts.refresh`).

---

## Global Constraints

Every task's requirements include these. Values are copied from the spec.

- **Pure Go, `CGO_ENABLED=0`, six targets:** linux, darwin and windows × amd64 and arm64 (D1). On Windows the agent is always the native build.
- **One new Go dependency:** `golang.org/x/sys` v0.48.0. No other module is added. `tailscale.com` belongs to S43a.
- **The enroll body stays five keys:** `code`, `pubkey`, `name`, `platform`, `hostname`. Only `platform`'s value changes, to `runtime.GOOS` (r2-agent-design:123; `main_test.go` pins it).
- **A role is availability, never permission (D2).** No `capabilities` column (`test_no_approvals.py:303`). No tool reads a role to refuse a call. Every refusal says "cannot", never "may not".
- **The words `unknown capability %q` do not change.** Doing-things S30 restates them.
- **Auth-frame facts** are ≤ 4 KiB, recorded only after the signature verifies, and never refuse the socket.
- **The `facts` frame** is ≤ 16 KiB and is sent after `ready`, on change (at most once a minute), every 10 minutes, and on `facts.refresh`.
- **Auth facts shape** (r2-integration:117-137; the integration wins over r2-agent-design):
  `{v:2, agent:{version, mode:"systemd-user|launch-agent|run-key|foreground", session_interactive}, os:{goos, arch, version, wsl:null|{distro}}, hostname, machine_uid}`.
  The `build` field is S30's and is not added here.
- **`devices.platform`** gets a CHECK: `linux|darwin|windows|unknown`. Enroll returns 400 for anything else, before the pairing code is spent.
- **Core migration is `036_agent_facts`.** 037 belongs to S46a.
- **S42a adds no tool.** The registry stays at 41 (r2-integration:224).
- **Eval numbering:** +1 case and +1 `suite_version`. If S42a lands first that is suite 16, corpus 27. If S47 (`slice/s47`, which claims 16/29) lands first, S42a renumbers once at rebase to 17/30. The rule: "whichever lands second renumbers once".
- **The repo is public.** No real username, MAC, GPU UUID, tailnet IP or tailnet name goes in code, fixtures or docs.
- **Git:** work on branch `slice/s42a` in `.worktrees/s42a`. Always use `git -C <path>`. Stage by path, never `git add -A`. Check `git show --stat HEAD` after every commit.
- **Formatting:** `ruff format` only the files you edited; v4 trees are not format-clean.
- **Core tests** run against your OWN scratch database on `nova-scratch-pg` (127.0.0.1:55432). Never share a database with another session.
- **Anything installed on a machine is built from `~/workspace/nova` on `main`, never from a worktree** (owner, 2026-09-25).
- **Mechanical over prompts:** anything that must hold is enforced by code or a test, not by a sentence in her prompt.

## Decisions this plan makes where the spec is silent

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

## Review Focus

These are the failure modes the spec implies but no task's own tests would otherwise exercise, most likely first. Each line names the test added to the owning task.

1. **An agent without facts (pre-S42a)** must still read as a working machine: hands available when connected, facts "unknown, predates S42a". It must not read as broken or "cannot". This is exactly the Dell's WSL agent on the day S42a deploys. Test: `test_an_agent_without_facts_keeps_its_hands_and_says_why_facts_are_unknown` (Task 11). Also `test_status_lists_an_agent_that_sends_no_facts` (Task 15).
2. **A Windows path written with forward slashes and a lowercase drive** (`c:/users/x/desktop`) must be accepted and normalized, and `\\?\` device paths refused. Test: `test_windows_paths_are_normalized_and_device_paths_refused` (Task 13).
3. **A non-ASCII notification** (`Café ☕`) on Windows must reach the toast intact. The message goes over stdin as UTF-8 bytes, never through the console code page. Tests: `TestTheToastScriptReadsTheMessageAsUTF8Bytes` (Task 2) and `TestNotifyOnWindowsPassesTheMessageOnStdin` (Task 2, Windows runner).
4. **A laptop that sleeps with the agent connected** must reconnect within about a second of resume, not after a TCP timeout or a 30 s backoff. Test: `TestAClockJumpEndsTheSessionAndTheNextConnectIsQuick` (Task 8).
5. **A revoked device under systemd** must stop, not restart every 5 s forever. Test: `TestTheServiceUnitDoesNotRestartARevokedDevice` (Task 9) reads `novad.service`.

---

## File map

**`apps/novad` (Go)**

| File | Responsibility |
|---|---|
| `internal/platform/platform.go` | `Runner`, `Exec`, `Mem`, `MachineUID` (hash) — OS-agnostic |
| `internal/platform/parse.go` | pure parsers: os-release, ioreg UUID, Windows product name, Get-StartApps JSON, `EncodePowerShell` |
| `internal/platform/fake.go` | `FakeRunner` for tests |
| `internal/platform/disk_unix.go` | `Disk`, `DiskRoot` via statfs (linux, darwin) |
| `internal/platform/{info,uid,session,paths}_{linux,darwin,windows}.go` | OS version, memory, uptime, extras; raw machine id; WSL/interactive/mode; config/state bases |
| `internal/caps/caps.go` | `Outcome`, `Deps` (+`SendFacts`), `Request`, `Handler`, `Dispatch`, `Names` |
| `internal/caps/table.go` | the dispatch table, `factsRefresh` |
| `internal/caps/system.go` | `system.info`, OS-agnostic over `platform` |
| `internal/caps/notify.go`, `notify_{linux,darwin,windows}.go` | `system.notify` |
| `internal/caps/powershell.go` | the constant PowerShell scripts + `powershellArgs` (OS-agnostic, tested everywhere) |
| `internal/caps/apps.go`, `apps_{linux,darwin,windows}.go`, `apps_match.go` | `apps.list` / `apps.launch` |
| `internal/caps/shell.go`, `procattr_{unix,windows}.go` | `shell.exec` with group kill, `WaitDelay`, cancel honesty |
| `internal/config/config.go`, `custody_{windows,other}.go` | paths per OS, the DACL, `Wipe` |
| `internal/facts/facts.go` | auth facts + facts frame gathering |
| `internal/wire/envelope.go` | `TypeFacts`, `ReasonRevoked`, `Auth.Facts` |
| `internal/client/client.go` | facts on the wire, `facts.refresh` deps, backoff reset, ping, resume, `ErrRevoked` |
| `main.go`, `novad.service`, `README.md` | `runtime.GOOS`, the WSL guard, exit 78, version stamp |

**`services/core` (Python)**

| File | Responsibility |
|---|---|
| `migrations/036_agent_facts.sql` | platform CHECK, `facts`/`facts_at` (+ pair CHECK), `machine_uid` index |
| `app/device_facts.py` | validation, caps, roles, `agent_view` |
| `app/devices.py` | enroll platform allow-list; `device_spec` + facts summary |
| `app/devices_ws.py` | record auth facts and facts frames; distinct `revoked` reason |
| `app/tools/devices.py` | platform-aware `_check_fs_path`; Windows-aware descriptions; `device_list` line |
| `app/machines.py` | `GatewayPlant.agents`, `FixturePlant(..., devices=)` |
| `app/tools/machines.py` | `machine_status` lists agents grouped by machine |
| `app/guards.py` | `_checked_a_device` reads connectivity facts; one capability phrase |
| `app/checks/devices.py`, `app/checks/__init__.py` | `devices_duplicate_agents` |
| `app/evals/cases.py`, `app/evals/runner.py`, `app/evals/cases/*.json` | `devices` fixture; the new case; the version bump |

**Elsewhere:** `apps/web` (Device type, tile), `.github/workflows/rebuild-ci.yml` (matrix), and docs (`apps/novad/README.md`, `deploy/README.md`, `ROADMAP.md`, slice close-out and carries).

---

## Task 0: Baseline (prerequisite; no commit)

The worktree `.worktrees/s42a` on `slice/s42a` already exists, branched from `origin/main` `ea6d3450`. `novad` is green (`go test ./...` and `go test -race ./...`, 2026-09-25).

- [ ] **Step 1: Core, gateway and memory suites on your own scratch databases**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
for svc in core gateway memory; do docker exec nova-scratch-pg createdb -U postgres nova_${svc}_s42a 2>/dev/null; done
cd $W/services/core && uv sync && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42a uv run pytest -q 2>&1 | tail -3
cd $W/services/gateway && uv sync && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s42a uv run pytest -q 2>&1 | tail -3
cd $W/services/memory && uv sync && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_memory_s42a uv run pytest -q 2>&1 | tail -3
```

Expected: all green. Record the three pass counts in the slice's carries file (Task 20). If anything is red, **stop** and report: a red baseline makes every later failure ambiguous.

- [ ] **Step 2: Web**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/web && npm ci && npm test 2>&1 | tail -3 && npx tsc --noEmit && echo TSC-OK
```

Expected: tests pass and `TSC-OK`. Use `npm test`, never `npx vitest run`: the latter fails on Node 26 at `localStorage.clear`.

---

## Task 1: `internal/platform` — the OS seam

**Files:**
- Create: `apps/novad/internal/platform/platform.go`, `parse.go`, `fake.go`, `disk_unix.go`
- Create: `apps/novad/internal/platform/info_linux.go`, `info_darwin.go`, `info_windows.go`
- Create: `apps/novad/internal/platform/uid_linux.go`, `uid_darwin.go`, `uid_windows.go`
- Create: `apps/novad/internal/platform/session_linux.go`, `session_darwin.go`, `session_windows.go`
- Create: `apps/novad/internal/platform/paths_linux.go`, `paths_darwin.go`, `paths_windows.go`
- Test: `apps/novad/internal/platform/parse_test.go`, `platform_test.go`, `platform_linux_test.go`
- Modify: `apps/novad/go.mod`, `apps/novad/go.sum`

**Interfaces:**
- Consumes: nothing.
- Produces (later tasks use exactly these):
  - `type Runner interface { Run(ctx context.Context, name string, args []string, stdin string) (string, error) }`
  - `type Exec struct{}`, a `Runner`.
  - `type FakeRunner struct { Outputs map[string]string; Errs map[string]error; Calls []FakeCall }` and `type FakeCall struct { Name string; Args []string; Stdin string }`.
  - `type Mem struct { Total, Available uint64; AvailableKnown bool }`
  - `func MachineUID(ctx context.Context, r Runner) (string, error)`: 64 hex characters.
  - `func OSVersion(ctx context.Context, r Runner) string`
  - `func Disk(path string) (free, total uint64, err error)`, `func DiskRoot() string`
  - `func Memory() (Mem, error)`, `func Uptime() (time.Duration, error)`, `func Extras(home string) []string`
  - `func WSL() (bool, string)`, `func Interactive() bool`, `func Mode() string`
  - `func ConfigBase() (string, error)`, `func StateBase() (string, error)`
  - Parsers:
    - `func ParseOSReleasePretty(body string) string`
    - `func ParseIOPlatformUUID(ioreg string) (string, error)`
    - `func WindowsProductName(product, display, build string) string`
    - `type StartApp struct { Name, AppID string }` and `func ParseStartApps(out string) ([]StartApp, error)`
    - `func EncodePowerShell(script string) string`

- [ ] **Step 1: Add the dependency**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/novad && ~/.local/bin/mise x -- go get golang.org/x/sys@v0.48.0
```

Expected: `go.mod` gains `golang.org/x/sys v0.48.0` and `go.sum` gains its lines. (The `mise x --` prefix runs the repo's pinned Go. In an interactive shell plain `go` is the same binary.)

- [ ] **Step 2: Write the failing tests**

`apps/novad/internal/platform/parse_test.go`:

```go
package platform

import (
	"encoding/base64"
	"reflect"
	"testing"
)

func TestParseOSReleasePrettyReadsTheQuotedName(t *testing.T) {
	body := "NAME=\"Pop!_OS\"\nPRETTY_NAME=\"Pop!_OS 24.04 LTS\"\nID=pop\n"
	if got := ParseOSReleasePretty(body); got != "Pop!_OS 24.04 LTS" {
		t.Fatalf("got %q", got)
	}
	if got := ParseOSReleasePretty("ID=alpine\n"); got != "" {
		t.Fatalf("no PRETTY_NAME must read as empty, got %q", got)
	}
}

func TestParseIOPlatformUUIDFindsTheHardwareUUID(t *testing.T) {
	out := `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000200, registered, matched, active, busy 0 (1 ms), retain 34>
    {
      "IOPlatformSerialNumber" = "SERIAL00"
      "IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"
    }`
	got, err := ParseIOPlatformUUID(out)
	if err != nil || got != "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := ParseIOPlatformUUID("no uuid here"); err == nil {
		t.Fatal("output without IOPlatformUUID must be an error, never an empty id")
	}
}

// The registry's ProductName says "Windows 10" on Windows 11 — Microsoft never
// changed it — so the build number decides which one this is.
func TestWindowsProductNameSaysElevenFromTheBuild(t *testing.T) {
	if got := WindowsProductName("Windows 10 Pro", "24H2", "26100"); got != "Windows 11 Pro 24H2 (build 26100)" {
		t.Fatalf("got %q", got)
	}
	if got := WindowsProductName("Windows 10 Pro", "22H2", "19045"); got != "Windows 10 Pro 22H2 (build 19045)" {
		t.Fatalf("got %q", got)
	}
	if got := WindowsProductName("", "", ""); got != "Windows" {
		t.Fatalf("nothing readable must still name the OS, got %q", got)
	}
}

// PowerShell prints an array for many apps, a bare object for one, and
// nothing for none — all three are real outputs of the same command.
func TestParseStartAppsReadsAllThreeShapes(t *testing.T) {
	many, err := ParseStartApps(`[{"Name":"Notepad","AppID":"Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"},{"Name":"Paint","AppID":"Microsoft.Paint_8wekyb3d8bbwe!App"}]`)
	if err != nil || len(many) != 2 || many[0].Name != "Notepad" {
		t.Fatalf("array: %v %v", many, err)
	}
	one, err := ParseStartApps("\ufeff" + `{"Name":"Notepad","AppID":"Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"}`)
	if err != nil || !reflect.DeepEqual(one, []StartApp{{Name: "Notepad", AppID: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"}}) {
		t.Fatalf("object: %v %v", one, err)
	}
	none, err := ParseStartApps("  \r\n")
	if err != nil || len(none) != 0 {
		t.Fatalf("empty: %v %v", none, err)
	}
	if _, err := ParseStartApps("not json"); err == nil {
		t.Fatal("unreadable output must be an error")
	}
}

func TestEncodePowerShellIsUTF16LEBase64(t *testing.T) {
	got := EncodePowerShell("ab")
	raw, err := base64.StdEncoding.DecodeString(got)
	if err != nil || !reflect.DeepEqual(raw, []byte{'a', 0, 'b', 0}) {
		t.Fatalf("got %q -> %v (%v)", got, raw, err)
	}
}
```

`apps/novad/internal/platform/platform_test.go`:

```go
package platform

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestMachineUIDIsASaltedHashNeverTheRawID(t *testing.T) {
	got, err := hashMachineID("  0A1B2C3D-Machine\n")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("nova/machine-uid/v1:0a1b2c3d-machine"))
	if got != hex.EncodeToString(sum[:]) {
		t.Fatalf("got %s", got)
	}
	if len(got) != 64 || strings.Contains(got, "0a1b2c3d") {
		t.Fatalf("the uid must be a 64-hex hash that does not carry the raw id: %s", got)
	}
}

func TestAnEmptyMachineIDIsAnErrorNeverAHashOfNothing(t *testing.T) {
	if _, err := hashMachineID(" \n"); err == nil {
		t.Fatal("an empty id must be an error")
	}
}

func TestFakeRunnerRecordsArgvAndStdinAndAnswersFromItsTable(t *testing.T) {
	r := &FakeRunner{Outputs: map[string]string{"tool": "out"}, Errs: map[string]error{"bad": errors.New("boom")}}
	out, err := r.Run(context.Background(), "tool", []string{"-a", "b"}, "in")
	if err != nil || out != "out" {
		t.Fatalf("got %q %v", out, err)
	}
	if _, err := r.Run(context.Background(), "bad", nil, ""); err == nil {
		t.Fatal("a scripted error must be returned")
	}
	if _, err := r.Run(context.Background(), "unscripted", nil, ""); err == nil {
		t.Fatal("an unscripted program must be an error, never an empty success")
	}
	want := FakeCall{Name: "tool", Args: []string{"-a", "b"}, Stdin: "in"}
	if !reflect.DeepEqual(r.Calls[0], want) {
		t.Fatalf("recorded %+v", r.Calls[0])
	}
}
```

`apps/novad/internal/platform/platform_linux_test.go`:

```go
package platform

import (
	"os"
	"path/filepath"
	"testing"
)

// The kernel's own release string decides — not WSL_DISTRO_NAME, which a
// systemd unit inside WSL does not get (measured on the Dell).
func TestWSLIsReadFromTheKernelReleaseNotTheEnvironment(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "osrelease")
	old := osreleasePath
	osreleasePath = path
	t.Cleanup(func() { osreleasePath = old })

	if err := os.WriteFile(path, []byte("5.15.167.4-microsoft-standard-WSL2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu-26.04")
	if in, distro := WSL(); !in || distro != "Ubuntu-26.04" {
		t.Fatalf("WSL kernel with a named distro: got %v %q", in, distro)
	}
	t.Setenv("WSL_DISTRO_NAME", "")
	if in, distro := WSL(); !in || distro != "" {
		t.Fatalf("WSL kernel, unnamed (a systemd unit): got %v %q", in, distro)
	}
	if err := os.WriteFile(path, []byte("6.18.7-76061807-generic\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu-26.04") // an env var alone never makes it WSL
	if in, _ := WSL(); in {
		t.Fatal("a native kernel is not WSL, whatever the environment says")
	}
}

func TestTheLinuxReadersReportRealNumbers(t *testing.T) {
	if m, err := Memory(); err != nil || m.Total == 0 || !m.AvailableKnown {
		t.Fatalf("memory: %+v %v", m, err)
	}
	if up, err := Uptime(); err != nil || up <= 0 {
		t.Fatalf("uptime: %v %v", up, err)
	}
	if free, total, err := Disk(DiskRoot()); err != nil || total == 0 || free > total {
		t.Fatalf("disk: %d of %d, %v", free, total, err)
	}
	if uid, err := MachineUID(context.Background(), Exec{}); err != nil || len(uid) != 64 {
		t.Fatalf("machine uid: %q %v", uid, err)
	}
}
```

(Add `"context"` to `platform_linux_test.go`'s imports.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/novad && ~/.local/bin/mise x -- go test ./internal/platform/`
Expected: FAIL. The build fails with `undefined: ParseOSReleasePretty`, `undefined: hashMachineID` and so on.

- [ ] **Step 4: Write the implementation**

`apps/novad/internal/platform/platform.go`:

```go
// Package platform is novad's one seam onto the operating system. What is
// read or done differently on Linux, macOS and Windows lives in this
// package's *_linux.go, *_darwin.go and *_windows.go files, so everything
// above it — the capabilities, the facts, the client — is written once.
//
// Two rules hold here. A command is argv, never a shell string: a message or
// a name reaches a program as an argument or on stdin, never spliced into a
// script. And every program a platform function runs goes through a Runner,
// so the parsing of its output is tested on every OS with canned text
// (FakeRunner) even where the program itself exists on only one.
package platform

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// Runner runs one program, argv form, and returns what it wrote to stdout.
// stdin, when not empty, is written to its standard input.
type Runner interface {
	Run(ctx context.Context, name string, args []string, stdin string) (string, error)
}

// Exec is the Runner that runs real programs.
type Exec struct{}

// Run runs name with args. A failure carries the program's own stderr, so a
// caller states the reason the program gave, not just "exit status 1".
func (Exec) Run(ctx context.Context, name string, args []string, stdin string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return stdout.String(), fmt.Errorf("%s: %w: %s", name, err, msg)
		}
		return stdout.String(), fmt.Errorf("%s: %w", name, err)
	}
	return stdout.String(), nil
}

// Mem is the machine's memory as the OS reports it. AvailableKnown is false
// where the OS gives only the total; the caller then says "available
// unknown", never a number nobody read.
type Mem struct {
	Total          uint64
	Available      uint64
	AvailableKnown bool
}

// machineUIDSalt makes MachineUID application-specific: the raw OS id never
// leaves the machine (machine-id(5) asks exactly this of anything exposing
// it), and two programs hashing the same id never match each other.
const machineUIDSalt = "nova/machine-uid/v1:"

// MachineUID is this machine's identity for one purpose — spotting two Nova
// agents on one machine: a salted sha256 of the OS's own machine id, as hex.
// "" and an error when the OS would not say; the caller reports that as
// unreadable.
func MachineUID(ctx context.Context, r Runner) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	raw, err := rawMachineID(ctx, r)
	if err != nil {
		return "", err
	}
	return hashMachineID(raw)
}

func hashMachineID(raw string) (string, error) {
	id := strings.ToLower(strings.TrimSpace(raw))
	if id == "" {
		return "", errors.New("the operating system reported an empty machine id")
	}
	sum := sha256.Sum256([]byte(machineUIDSalt + id))
	return hex.EncodeToString(sum[:]), nil
}
```

`apps/novad/internal/platform/parse.go`:

```go
package platform

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// ParseOSReleasePretty is PRETTY_NAME from an os-release body, or "".
func ParseOSReleasePretty(body string) string {
	sc := bufio.NewScanner(strings.NewReader(body))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"'`)
		}
	}
	return ""
}

var ioPlatformUUID = regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"`)

// ParseIOPlatformUUID is the hardware UUID from
// `ioreg -rd1 -c IOPlatformExpertDevice`.
func ParseIOPlatformUUID(ioreg string) (string, error) {
	m := ioPlatformUUID.FindStringSubmatch(ioreg)
	if m == nil {
		return "", errors.New("ioreg printed no IOPlatformUUID")
	}
	return m[1], nil
}

// WindowsProductName composes the label Windows itself shows. The registry's
// ProductName still says "Windows 10" on Windows 11; build 22000 and later is
// Windows 11, so the number decides.
func WindowsProductName(product, display, build string) string {
	name := strings.TrimSpace(product)
	if name == "" {
		name = "Windows"
	}
	b := strings.TrimSpace(build)
	if n, err := strconv.Atoi(b); err == nil && n >= 22000 {
		name = strings.Replace(name, "Windows 10", "Windows 11", 1)
	}
	if d := strings.TrimSpace(display); d != "" {
		name += " " + d
	}
	if b != "" {
		name += " (build " + b + ")"
	}
	return name
}

// StartApp is one entry of Windows' Get-StartApps: what the Start menu calls
// it, and the AppUserModelID that launches it.
type StartApp struct {
	Name  string `json:"Name"`
	AppID string `json:"AppID"`
}

// ParseStartApps reads `Get-StartApps | ConvertTo-Json`. PowerShell prints a
// bare object instead of an array when there is exactly one app, and nothing
// at all when there are none; all three are read.
func ParseStartApps(out string) ([]StartApp, error) {
	text := strings.TrimSpace(strings.TrimPrefix(out, "\ufeff"))
	if text == "" {
		return nil, nil
	}
	if strings.HasPrefix(text, "{") {
		var one StartApp
		if err := json.Unmarshal([]byte(text), &one); err != nil {
			return nil, fmt.Errorf("the Start menu listing was unreadable: %w", err)
		}
		return []StartApp{one}, nil
	}
	var many []StartApp
	if err := json.Unmarshal([]byte(text), &many); err != nil {
		return nil, fmt.Errorf("the Start menu listing was unreadable: %w", err)
	}
	return many, nil
}

// EncodePowerShell is script in the form `powershell -EncodedCommand` takes:
// UTF-16LE, then base64. The script travels as ONE argv element, with no
// quoting for anything to get wrong.
func EncodePowerShell(script string) string {
	units := utf16.Encode([]rune(script))
	buf := make([]byte, 2*len(units))
	for i, u := range units {
		binary.LittleEndian.PutUint16(buf[2*i:], u)
	}
	return base64.StdEncoding.EncodeToString(buf)
}
```

`apps/novad/internal/platform/fake.go`:

```go
package platform

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// FakeRunner is a Runner for tests: it answers each program from a table and
// records every call, so a test asserts both what was parsed and exactly what
// argv and stdin would have run — on any OS.
type FakeRunner struct {
	mu      sync.Mutex
	Outputs map[string]string // keyed by program name
	Errs    map[string]error
	Calls   []FakeCall
}

// FakeCall is one recorded run.
type FakeCall struct {
	Name  string
	Args  []string
	Stdin string
}

// Run records the call, then answers it from Errs, then Outputs. An
// unscripted program is an error, never an empty success.
func (f *FakeRunner) Run(_ context.Context, name string, args []string, stdin string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, FakeCall{Name: name, Args: append([]string(nil), args...), Stdin: stdin})
	if err, ok := f.Errs[name]; ok {
		return "", err
	}
	if out, ok := f.Outputs[name]; ok {
		return out, nil
	}
	return "", fmt.Errorf("fake runner: nothing scripted for %s %s", name, strings.Join(args, " "))
}
```

`apps/novad/internal/platform/disk_unix.go`:

```go
//go:build linux || darwin

package platform

import "syscall"

// Disk is the free (to this user) and total bytes of the filesystem holding
// path.
func Disk(path string) (free, total uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize) // int64 on linux, uint32 on darwin: both widen here
	return st.Bavail * bs, st.Blocks * bs, nil
}

// DiskRoot is what system.info reads when the daemon has no home.
func DiskRoot() string { return "/" }
```

`apps/novad/internal/platform/info_linux.go`:

```go
package platform

import (
	"bufio"
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

// OSVersion is what os-release calls this system, e.g. "Ubuntu 26.04 LTS".
func OSVersion(_ context.Context, _ Runner) string {
	if body, err := os.ReadFile("/etc/os-release"); err == nil {
		if pretty := ParseOSReleasePretty(string(body)); pretty != "" {
			return pretty
		}
	}
	return "Linux (distribution not stated)"
}

// Memory reads MemTotal and MemAvailable from /proc/meminfo (kB).
func Memory() (Mem, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return Mem{}, err
	}
	defer f.Close()
	var m Mem
	gotTotal := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		v, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			m.Total, gotTotal = v*1024, true
		case "MemAvailable:":
			m.Available, m.AvailableKnown = v*1024, true
		}
	}
	if !gotTotal {
		return Mem{}, errors.New("/proc/meminfo has no MemTotal")
	}
	return m, nil
}

// Uptime reads /proc/uptime.
func Uptime() (time.Duration, error) {
	body, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(body))
	if len(fields) == 0 {
		return 0, errors.New("/proc/uptime is empty")
	}
	secs, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, err
	}
	return time.Duration(secs * float64(time.Second)), nil
}

// Extras are the lines system.info adds on this OS.
func Extras(home string) []string {
	if home == "" {
		return nil
	}
	return []string{"home=" + home}
}
```

`apps/novad/internal/platform/info_darwin.go`:

```go
package platform

import (
	"context"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// OSVersion is "macOS <version>", from the kernel's own record.
func OSVersion(_ context.Context, _ Runner) string {
	v, err := unix.Sysctl("kern.osproductversion")
	if err != nil || strings.TrimSpace(v) == "" {
		return "macOS (version not stated)"
	}
	return "macOS " + strings.TrimSpace(v)
}

// Memory is the installed total. Available memory needs vm_stat's page
// counts; until something needs it, it is stated unknown (AvailableKnown
// false), never guessed.
func Memory() (Mem, error) {
	total, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return Mem{}, err
	}
	return Mem{Total: total}, nil
}

// Uptime is the time since the kernel's boottime.
func Uptime() (time.Duration, error) {
	tv, err := unix.SysctlTimeval("kern.boottime")
	if err != nil {
		return 0, err
	}
	sec, nsec := tv.Unix()
	return time.Since(time.Unix(sec, nsec)), nil
}

// Extras are the lines system.info adds on this OS.
func Extras(home string) []string {
	if home == "" {
		return nil
	}
	return []string{"home=" + home}
}
```

`apps/novad/internal/platform/info_windows.go`:

```go
package platform

import (
	"context"
	"errors"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// OSVersion is the name Windows shows, e.g. "Windows 11 Pro 24H2 (build 26100)".
func OSVersion(_ context.Context, _ Runner) string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return "Windows (version not stated)"
	}
	defer k.Close()
	product, _, _ := k.GetStringValue("ProductName")
	display, _, _ := k.GetStringValue("DisplayVersion")
	build, _, _ := k.GetStringValue("CurrentBuild")
	return WindowsProductName(product, display, build)
}

// Disk is GetDiskFreeSpaceEx for the volume holding path.
func Disk(path string) (free, total uint64, err error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, err
	}
	var avail, tot, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &avail, &tot, &totalFree); err != nil {
		return 0, 0, err
	}
	return avail, tot, nil
}

// DiskRoot is what system.info reads when the daemon has no home.
func DiskRoot() string { return `C:\` }

// memoryStatusEx is MEMORYSTATUSEX. x/sys/windows wraps neither
// GlobalMemoryStatusEx nor GetTickCount64, so both are called directly.
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

var (
	kernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetTickCount64       = kernel32.NewProc("GetTickCount64")
)

// Memory is physical memory, total and available.
func Memory() (Mem, error) {
	var st memoryStatusEx
	st.Length = uint32(unsafe.Sizeof(st))
	ok, _, callErr := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&st)))
	if ok == 0 {
		return Mem{}, callErr
	}
	return Mem{Total: st.TotalPhys, Available: st.AvailPhys, AvailableKnown: true}, nil
}

// Uptime is GetTickCount64: milliseconds since boot.
func Uptime() (time.Duration, error) {
	if err := procGetTickCount64.Find(); err != nil {
		return 0, err
	}
	ms, _, _ := procGetTickCount64.Call()
	if ms == 0 {
		return 0, errors.New("GetTickCount64 returned 0")
	}
	return time.Duration(ms) * time.Millisecond, nil
}

// Extras are home and the Desktop folder. Windows moves Desktop (OneDrive
// redirects it), so "what's on my desktop" is answered from the folder
// Windows names, never from a guessed C:\Users\<name>\Desktop.
func Extras(home string) []string {
	var out []string
	if home != "" {
		out = append(out, "home="+home)
	}
	if desk, err := windows.KnownFolderPath(windows.FOLDERID_Desktop, 0); err == nil && desk != "" {
		out = append(out, "desktop="+desk)
	} else {
		out = append(out, "desktop=unknown")
	}
	return out
}
```

`apps/novad/internal/platform/uid_linux.go`:

```go
package platform

import (
	"context"
	"errors"
	"os"
	"strings"
)

// rawMachineID is /etc/machine-id, or dbus's copy where systemd is absent.
// Inside WSL this is the distribution's own id, not Windows' — which is why
// core's WSL rule reads os.wsl, never machine ids.
func rawMachineID(_ context.Context, _ Runner) (string, error) {
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if body, err := os.ReadFile(p); err == nil && strings.TrimSpace(string(body)) != "" {
			return string(body), nil
		}
	}
	return "", errors.New("neither /etc/machine-id nor /var/lib/dbus/machine-id is readable")
}
```

`apps/novad/internal/platform/uid_darwin.go`:

```go
package platform

import "context"

// rawMachineID is the hardware UUID ioreg reports. The absolute path: a
// LaunchAgent's PATH is minimal.
func rawMachineID(ctx context.Context, r Runner) (string, error) {
	out, err := r.Run(ctx, "/usr/sbin/ioreg", []string{"-rd1", "-c", "IOPlatformExpertDevice"}, "")
	if err != nil {
		return "", err
	}
	return ParseIOPlatformUUID(out)
}
```

`apps/novad/internal/platform/uid_windows.go`:

```go
package platform

import (
	"context"
	"fmt"

	"golang.org/x/sys/windows/registry"
)

// rawMachineID is the MachineGuid Windows writes at install.
func rawMachineID(_ context.Context, _ Runner) (string, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Cryptography`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return "", fmt.Errorf("reading MachineGuid: %w", err)
	}
	defer k.Close()
	v, _, err := k.GetStringValue("MachineGuid")
	if err != nil {
		return "", fmt.Errorf("reading MachineGuid: %w", err)
	}
	return v, nil
}
```

`apps/novad/internal/platform/session_linux.go`:

```go
package platform

import (
	"os"
	"strings"
)

// osreleasePath is where the kernel names itself; a variable so a test can
// point it at a WSL-shaped file.
var osreleasePath = "/proc/sys/kernel/osrelease"

// WSL reports whether this Linux runs inside WSL, and the distribution when
// the environment names it ("" otherwise). The kernel's own release string
// is the test — never WSL_DISTRO_NAME or WSL_INTEROP, which a systemd unit
// inside WSL does not get (measured on the Dell, r1-wake-critique:114).
func WSL() (bool, string) {
	body, err := os.ReadFile(osreleasePath)
	if err != nil || !strings.Contains(strings.ToLower(string(body)), "microsoft") {
		return false, ""
	}
	return true, os.Getenv("WSL_DISTRO_NAME")
}

// Interactive is whether a graphical session is reachable: apps.launch and
// system.notify need one (README, "graphical session").
func Interactive() bool {
	return os.Getenv("WAYLAND_DISPLAY") != "" || os.Getenv("DISPLAY") != ""
}

// Mode is how this daemon was started: by systemd, which sets INVOCATION_ID
// for every unit it starts, or by hand.
func Mode() string {
	if os.Getenv("INVOCATION_ID") != "" {
		return "systemd-user"
	}
	return "foreground"
}
```

`apps/novad/internal/platform/session_darwin.go`:

```go
package platform

import (
	"os"
	"syscall"
)

// WSL is Linux's; macOS is never inside it.
func WSL() (bool, string) { return false, "" }

// Interactive is whether the console belongs to this user — the Aqua
// session a notification or an app launch appears in.
func Interactive() bool {
	info, err := os.Stat("/dev/console")
	if err != nil {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}

// Mode is launch-agent when launchd (pid 1) started this process.
func Mode() string {
	if os.Getppid() == 1 {
		return "launch-agent"
	}
	return "foreground"
}
```

`apps/novad/internal/platform/session_windows.go`:

```go
package platform

import "golang.org/x/sys/windows"

// WSL is Linux's; the Windows agent reaches WSL through wsl.exe.
func WSL() (bool, string) { return false, "" }

// Interactive is whether this process runs in a user's desktop session. A
// service runs in session 0, where a toast or a window never shows.
func Interactive() bool {
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err != nil {
		return false
	}
	return session != 0
}

// Mode is foreground until S42b's Run key starts `novad supervise`.
func Mode() string { return "foreground" }
```

`apps/novad/internal/platform/paths_linux.go`:

```go
package platform

import (
	"os"
	"path/filepath"
)

// ConfigBase is $XDG_CONFIG_HOME or ~/.config — unchanged from before S42a,
// so an enrolled Linux daemon finds its key where it left it.
func ConfigBase() (string, error) {
	if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config"), nil
}

// StateBase is $XDG_STATE_HOME or ~/.local/state, where the audit log lives.
func StateBase() (string, error) {
	if v := os.Getenv("XDG_STATE_HOME"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "state"), nil
}
```

`apps/novad/internal/platform/paths_darwin.go`:

```go
package platform

import "os"

// ConfigBase is ~/Library/Application Support (os.UserConfigDir).
func ConfigBase() (string, error) { return os.UserConfigDir() }

// StateBase is the same place: macOS keeps an app's state beside its config.
func StateBase() (string, error) { return os.UserConfigDir() }
```

`apps/novad/internal/platform/paths_windows.go`:

```go
package platform

import "os"

// ConfigBase is %AppData% (os.UserConfigDir), per the hub design.
func ConfigBase() (string, error) { return os.UserConfigDir() }

// StateBase is %LocalAppData% (os.UserCacheDir on Windows): the audit log is
// this machine's record and must never travel with a roaming profile.
func StateBase() (string, error) { return os.UserCacheDir() }
```

- [ ] **Step 5: Run the tests and the cross-OS vet**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/novad
~/.local/bin/mise x -- go test ./internal/platform/ -v 2>&1 | tail -20
for t in darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do GOOS=${t%/*} GOARCH=${t#*/} CGO_ENABLED=0 ~/.local/bin/mise x -- go vet ./internal/platform/ && echo "vet ok $t"; done
```

Expected: every platform test passes, followed by four `vet ok` lines.

- [ ] **Step 6: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add apps/novad/go.mod apps/novad/go.sum apps/novad/internal/platform/
git -C $W commit -m "feat(novad): internal/platform, the one OS seam for Linux, macOS and Windows"
git -C $W show --stat HEAD | tail -25
```

---

## Task 2: the dispatch table, `system.info` over the platform, `system.notify` per OS

**Files:**
- Modify: `apps/novad/internal/caps/caps.go`: the whole file after the constants.
- Create: `apps/novad/internal/caps/table.go`, `notify.go`, `notify_linux.go`, `notify_darwin.go`, `notify_windows.go`, `powershell.go`.
- Rewrite: `apps/novad/internal/caps/system.go`.
- Test: `apps/novad/internal/caps/caps_test.go` (append), `powershell_test.go`, `notify_darwin_test.go`, `notify_windows_test.go`.

**Interfaces:**
- Consumes (Task 1): `platform.Exec`, `platform.Runner`, `platform.FakeRunner`, `platform.OSVersion`, `platform.Disk`, `platform.DiskRoot`, `platform.Memory`, `platform.Uptime`, `platform.Extras`, `platform.EncodePowerShell`.
- Produces:
  - `type Deps struct { Home string; SendFacts func(context.Context) error }`
  - `type Request struct { Args map[string]any; Deps Deps }`
  - `type Handler func(ctx context.Context, req Request) Outcome`
  - `func Dispatch(ctx, capability string, args map[string]any, d Deps) Outcome` (same signature as today)
  - `func Names() []string`
  - `func appsList(ctx context.Context) Outcome` (Task 3 keeps this signature)
  - `func powershellArgs(script string) []string` and the consts `toastScript` and `startAppsScript`

- [ ] **Step 1: Write the failing tests**

Append to `apps/novad/internal/caps/caps_test.go`:

```go
// The capability list is DERIVED from the dispatch table: a capability is
// listed because a handler exists (doing-things S30's daemon.info reads
// Names), never because a name was written twice.
func TestNamesAreDerivedFromTheTable(t *testing.T) {
	want := []string{
		"apps.launch", "apps.list", "facts.refresh", "fs.list", "fs.read",
		"fs.write", "shell.exec", "system.info", "system.notify",
	}
	if got := Names(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Names() = %v, want %v", got, want)
	}
}

// S30 restates these words to say a daemon is too old for a call.
func TestUnknownCapabilityKeepsItsExactWords(t *testing.T) {
	out := Dispatch(context.Background(), "fs.destroy", map[string]any{}, testDeps(t))
	if out.OK || out.Error != `unknown capability "fs.destroy"` {
		t.Fatalf("got ok=%v %q", out.OK, out.Error)
	}
}

func TestFactsRefreshWithoutASocketSaysCannot(t *testing.T) {
	out := Dispatch(context.Background(), "facts.refresh", map[string]any{}, testDeps(t))
	if out.OK || !strings.HasPrefix(out.Error, "cannot:") {
		t.Fatalf("got ok=%v %q", out.OK, out.Error)
	}
}

// The frame goes out BEFORE the result: SendFacts runs inside the handler,
// so by the time core's command returns, core has recorded the facts.
func TestFactsRefreshSendsTheFrameThenAnswers(t *testing.T) {
	sent := 0
	d := testDeps(t)
	d.SendFacts = func(context.Context) error { sent++; return nil }
	out := Dispatch(context.Background(), "facts.refresh", map[string]any{}, d)
	if !out.OK || sent != 1 {
		t.Fatalf("ok=%v sent=%d %q", out.OK, sent, out.Error)
	}
	d.SendFacts = func(context.Context) error { return errors.New("socket gone") }
	if out := Dispatch(context.Background(), "facts.refresh", map[string]any{}, d); out.OK {
		t.Fatal("a frame that could not be written is ok:false, never 'facts sent'")
	}
}

// Every fact is NAMED, as a value or as unknown — an omitted line reads as
// though it was never asked. (Before S42a, os= and uptime= were silently
// dropped off Linux.)
func TestSystemInfoNamesEveryFactEvenWhenUnknown(t *testing.T) {
	out := Dispatch(context.Background(), "system.info", map[string]any{}, testDeps(t))
	if !out.OK {
		t.Fatalf("system.info should succeed: %q", out.Error)
	}
	for _, want := range []string{"host=", "os=", "disk", "mem", "uptime="} {
		if !strings.Contains(out.Output, want) {
			t.Errorf("system.info output missing %q: %s", want, out.Output)
		}
	}
}
```

Add `"errors"` and `"reflect"` to the test file's imports.

Create `apps/novad/internal/caps/powershell_test.go`:

```go
package caps

import (
	"strings"
	"testing"

	"novad/internal/platform"
)

// Review focus 3: the message reaches the toast as UTF-8 BYTES from stdin —
// never through [Console]::In, whose code page would mangle "Café ☕".
func TestTheToastScriptReadsTheMessageAsUTF8Bytes(t *testing.T) {
	for _, want := range []string{"OpenStandardInput", "UTF8.GetString"} {
		if !strings.Contains(toastScript, want) {
			t.Errorf("toastScript must contain %q", want)
		}
	}
	if strings.Contains(toastScript, "[Console]::In.") {
		t.Error("[Console]::In decodes with the console code page; read the raw bytes")
	}
}

// Nothing is ever formatted into a script: they are constants.
func TestTheScriptsHaveNoPlaceForAnything(t *testing.T) {
	for name, s := range map[string]string{"toast": toastScript, "startApps": startAppsScript} {
		if strings.Contains(s, "%s") || strings.Contains(s, "{0}") {
			t.Errorf("%s script has a format placeholder", name)
		}
	}
}

func TestPowerShellArgsCarryTheScriptAsOneEncodedArgument(t *testing.T) {
	args := powershellArgs("Write-Output 'hi'")
	n := len(args)
	if n < 2 || args[n-2] != "-EncodedCommand" || args[n-1] != platform.EncodePowerShell("Write-Output 'hi'") {
		t.Fatalf("args = %v", args)
	}
	for _, flag := range []string{"-NoProfile", "-NonInteractive"} {
		found := false
		for _, a := range args {
			found = found || a == flag
		}
		if !found {
			t.Errorf("missing %s", flag)
		}
	}
}
```

Create `apps/novad/internal/caps/notify_windows_test.go`:

```go
package caps

import (
	"context"
	"strings"
	"testing"

	"novad/internal/platform"
)

func TestNotifyOnWindowsPassesTheMessageOnStdin(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{"powershell.exe": ""}}
	msg := "Café ☕ — backup done"
	if out := notify(context.Background(), r, msg); !out.OK {
		t.Fatal(out.Error)
	}
	call := r.Calls[0]
	if call.Name != "powershell.exe" || call.Stdin != msg {
		t.Fatalf("got %+v", call)
	}
	for _, a := range call.Args {
		if strings.Contains(a, "Café") {
			t.Fatal("the message must never be in argv or the script")
		}
	}
}
```

Create `apps/novad/internal/caps/notify_darwin_test.go`:

```go
package caps

import (
	"context"
	"strings"
	"testing"

	"novad/internal/platform"
)

// An AppleScript-injection-shaped message stays DATA: it is item 1 of argv,
// never part of the -e source.
func TestNotifyOnMacOSPassesTheMessageAsArgvNeverAsScript(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{"/usr/bin/osascript": ""}}
	msg := `done" & do shell script "rm -rf ~" & "`
	if out := notify(context.Background(), r, msg); !out.OK {
		t.Fatal(out.Error)
	}
	args := r.Calls[0].Args
	if args[len(args)-1] != msg {
		t.Fatalf("the message must be the last argv element: %v", args)
	}
	for _, a := range args[:len(args)-1] {
		if strings.Contains(a, "rm -rf") {
			t.Fatal("the message leaked into the script")
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/novad && ~/.local/bin/mise x -- go test ./internal/caps/`
Expected: FAIL. `undefined: Names`, `undefined: toastScript` and so on. The darwin and windows test files are not built on Linux.

- [ ] **Step 3: Write the implementation**

In `apps/novad/internal/caps/caps.go`, replace everything from `// Outcome is the device's judgment` down to the end of `Dispatch` with:

```go
// Outcome is the device's judgment of one capability call. The client turns it
// into a result frame AND an audit entry — a refusal is never silent.
type Outcome struct {
	OK       bool
	Output   string
	ExitCode *int
	Error    string
}

// Deps are the ambient facts a handler needs: the default working directory
// for shell.exec (also system.info's disk target), and — on a live socket —
// SendFacts, which writes a facts frame on THIS connection (facts.refresh).
// SendFacts is nil where there is no socket, and a handler that needs it says
// "cannot" rather than pretending.
type Deps struct {
	Home      string
	SendFacts func(context.Context) error
}

// Request is one verified call as its handler receives it.
type Request struct {
	Args map[string]any
	Deps Deps
}

// Handler performs one capability and judges the outcome (see Outcome).
type Handler func(ctx context.Context, req Request) Outcome

// Dispatch routes a verified capability through the table (table.go). An
// unknown capability is a refusal (ok:false), not a panic — core should never
// send one, but the edge refuses rather than trusts. The words "unknown
// capability" are load-bearing: doing-things S30 restates them to say a
// daemon is too old for a call, so they do not change.
func Dispatch(ctx context.Context, capability string, args map[string]any, d Deps) Outcome {
	h, ok := table[capability]
	if !ok {
		return fail("unknown capability %q", capability)
	}
	return h(ctx, Request{Args: args, Deps: d})
}

// Names is every capability this daemon performs, sorted — derived from the
// table, so a capability is listed because a handler exists (S30's
// daemon.info reads this), never from a second list kept by hand.
func Names() []string {
	names := make([]string, 0, len(table))
	for name := range table {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
```

Add `"sort"` to caps.go's imports.

Create `apps/novad/internal/caps/table.go`:

```go
package caps

import "context"

// table is the dispatch table: every capability this daemon performs, and
// the handler that performs it. It replaces the literal switch (S42a) and is
// the table doing-things S30 adds its capabilities to — never a second one
// (hub-topology, "the Dispatch table"). Per-OS behaviour lives INSIDE the
// handlers (platform, notify_*, apps_*, procattr_*), never in which names
// exist: the same names answer on every OS, and an OS that cannot do one
// says "cannot" from inside its handler.
var table = map[string]Handler{
	"system.info":   func(ctx context.Context, r Request) Outcome { return systemInfo(ctx, r.Deps) },
	"system.notify": func(ctx context.Context, r Request) Outcome { return systemNotify(ctx, r.Args) },
	"fs.list":       func(_ context.Context, r Request) Outcome { return fsList(r.Args, r.Deps) },
	"fs.read":       func(_ context.Context, r Request) Outcome { return fsRead(r.Args, r.Deps) },
	"fs.write":      func(_ context.Context, r Request) Outcome { return fsWrite(r.Args, r.Deps) },
	"apps.list":     func(ctx context.Context, _ Request) Outcome { return appsList(ctx) },
	"apps.launch":   func(ctx context.Context, r Request) Outcome { return appsLaunch(ctx, r.Args) },
	"shell.exec":    func(ctx context.Context, r Request) Outcome { return shellExec(ctx, r.Args, r.Deps) },
	"facts.refresh": factsRefresh,
}

// factsRefresh answers core's facts.refresh: it writes a fresh facts frame
// on this connection and only then returns, so the frame is on the wire
// BEFORE this command's result. Core reads a socket's frames in order, so by
// the time its command returns, the facts are recorded (S46a relies on it).
func factsRefresh(ctx context.Context, r Request) Outcome {
	if r.Deps.SendFacts == nil {
		return fail("cannot: there is no connection to send facts on")
	}
	if err := r.Deps.SendFacts(ctx); err != nil {
		return fail("could not send facts: %v", err)
	}
	return ok0("facts sent")
}
```

Replace the whole of `apps/novad/internal/caps/system.go` with:

```go
package caps

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"novad/internal/platform"
)

// systemInfo reports host, OS, disk, memory and uptime, plus this OS's extra
// lines (home, and on Windows the Desktop folder). Every fact is NAMED: a
// value when it could be read, "unknown" when it could not — never dropped,
// because an omitted line reads as though it was never asked.
func systemInfo(ctx context.Context, d Deps) Outcome {
	var parts []string
	if host, err := os.Hostname(); err == nil {
		parts = append(parts, "host="+host)
	} else {
		parts = append(parts, "host=unknown")
	}
	parts = append(parts, "os="+platform.OSVersion(ctx, platform.Exec{}))

	target := d.Home
	if target == "" {
		target = platform.DiskRoot()
	}
	if free, total, err := platform.Disk(target); err == nil {
		parts = append(parts, fmt.Sprintf("disk %s free %s of %s", target, gib(free), gib(total)))
	} else {
		parts = append(parts, "disk=unknown")
	}

	switch m, err := platform.Memory(); {
	case err != nil:
		parts = append(parts, "mem=unknown")
	case m.AvailableKnown:
		parts = append(parts, fmt.Sprintf("mem available %s of %s", gib(m.Available), gib(m.Total)))
	default:
		parts = append(parts, fmt.Sprintf("mem total %s, available unknown", gib(m.Total)))
	}

	if up, err := platform.Uptime(); err == nil {
		parts = append(parts, "uptime="+formatUptime(up))
	} else {
		parts = append(parts, "uptime=unknown")
	}
	parts = append(parts, platform.Extras(d.Home)...)
	return ok0(strings.Join(parts, "; "))
}

func gib(b uint64) string {
	const g = 1024 * 1024 * 1024
	return fmt.Sprintf("%.1f GiB", float64(b)/float64(g))
}

// formatUptime is "Nd Nh Nm".
func formatUptime(d time.Duration) string {
	total := int64(d / time.Second)
	return fmt.Sprintf("%dd %dh %dm", total/86400, (total%86400)/3600, (total%3600)/60)
}
```

Create `apps/novad/internal/caps/notify.go`:

```go
package caps

import (
	"context"

	"novad/internal/platform"
)

// systemNotify shows a desktop notification through this OS's own mechanism
// (notify_linux.go, notify_darwin.go, notify_windows.go). With no mechanism it
// is ok:false with the reason — it never pretends to have notified. The
// message reaches the program as an argument or on stdin, never inside a
// script.
func systemNotify(ctx context.Context, args map[string]any) Outcome {
	msg, ok := strArg(args, "message")
	if !ok || msg == "" {
		return fail("system.notify needs a 'message'")
	}
	return notify(ctx, platform.Exec{}, msg)
}
```

Create `apps/novad/internal/caps/notify_linux.go`:

```go
package caps

import (
	"context"
	"os/exec"

	"novad/internal/platform"
)

// notify on Linux is notify-send, which needs a graphical session
// (DISPLAY/DBUS; see the README).
func notify(ctx context.Context, r platform.Runner, msg string) Outcome {
	if _, err := exec.LookPath("notify-send"); err != nil {
		return fail("no desktop notification backend: notify-send is not installed")
	}
	if _, err := r.Run(ctx, "notify-send", []string{"Nova", msg}, ""); err != nil {
		return fail("notify-send failed: %v", err)
	}
	return ok0("notified")
}
```

Create `apps/novad/internal/caps/notify_darwin.go`:

```go
package caps

import (
	"context"

	"novad/internal/platform"
)

// notify on macOS is AppleScript's display notification. The message is item
// 1 of argv inside `on run`, so it is never AppleScript source.
func notify(ctx context.Context, r platform.Runner, msg string) Outcome {
	args := []string{
		"-e", "on run argv",
		"-e", `display notification (item 1 of argv) with title "Nova"`,
		"-e", "end run",
		msg,
	}
	if _, err := r.Run(ctx, "/usr/bin/osascript", args, ""); err != nil {
		return fail("osascript could not show the notification: %v", err)
	}
	return ok0("notified")
}
```

Create `apps/novad/internal/caps/notify_windows.go`:

```go
package caps

import (
	"context"

	"novad/internal/platform"
)

// notify on Windows is a WinRT toast through Windows PowerShell (see
// toastScript). The message goes on stdin; the script is a constant.
func notify(ctx context.Context, r platform.Runner, msg string) Outcome {
	if _, err := r.Run(ctx, "powershell.exe", powershellArgs(toastScript), msg); err != nil {
		return fail("could not show the toast: %v", err)
	}
	return ok0("notified")
}
```

Create `apps/novad/internal/caps/powershell.go`:

```go
package caps

import "novad/internal/platform"

// toastScript shows a Windows toast through the WinRT API that Windows
// PowerShell 5.1 can load (powershell.exe; PowerShell 7 cannot). It is a
// CONSTANT: the message is read from stdin as raw UTF-8 bytes — never through
// [Console]::In, whose console code page would mangle "Café" — so nothing a
// person typed is ever PowerShell source. The AppUserModelID is Windows
// PowerShell's own, registered on every Windows 10 and 11, so the toast shows
// without Nova registering an app.
const toastScript = `$in = [Console]::OpenStandardInput()
$buf = New-Object System.IO.MemoryStream
$in.CopyTo($buf)
$m = [System.Text.Encoding]::UTF8.GetString($buf.ToArray())
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode('Nova')) | Out-Null
$x.Item(1).AppendChild($t.CreateTextNode($m)) | Out-Null
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($t))
`

// startAppsScript lists the Start menu's apps — what Windows itself offers
// to launch, Store apps included — as JSON (platform.ParseStartApps).
const startAppsScript = `Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress`

// powershellArgs is the argv every PowerShell call here uses: no profile (a
// user's profile could print or fail), no prompts, no execution-policy
// refusal, and the script as one encoded argument.
func powershellArgs(script string) []string {
	return []string{
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-EncodedCommand", platform.EncodePowerShell(script),
	}
}
```

In `apps/novad/internal/caps/apps.go`, change `func appsList() Outcome {` to `func appsList(_ context.Context) Outcome {`. `context` is already imported. Task 3 rewrites the file.

- [ ] **Step 4: Run the tests**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/novad
~/.local/bin/mise x -- go test ./... 2>&1 | tail -8
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 ~/.local/bin/mise x -- go vet ./... && echo "vet ok darwin"
```

Expected: all packages pass on Linux, then `vet ok darwin`. Windows still fails to compile at `apps.go:176` (`Setsid`) until Task 3; that failure is expected here.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add apps/novad/internal/caps/caps.go apps/novad/internal/caps/table.go apps/novad/internal/caps/system.go apps/novad/internal/caps/notify.go apps/novad/internal/caps/notify_linux.go apps/novad/internal/caps/notify_darwin.go apps/novad/internal/caps/notify_windows.go apps/novad/internal/caps/powershell.go apps/novad/internal/caps/apps.go apps/novad/internal/caps/caps_test.go apps/novad/internal/caps/powershell_test.go apps/novad/internal/caps/notify_darwin_test.go apps/novad/internal/caps/notify_windows_test.go
git -C $W commit -m "feat(novad): a dispatch table, facts.refresh, system.info and notify on every OS"
git -C $W show --stat HEAD | tail -20
```

---

## Task 3: apps per OS — the build compiles for Windows

**Files:**
- Rewrite: `apps/novad/internal/caps/apps.go` (shared).
- Create: `apps/novad/internal/caps/apps_linux.go` (today's XDG code, moved), `apps_darwin.go`, `apps_windows.go`, `apps_match.go`.
- Test: `apps/novad/internal/caps/apps_match_test.go`, `apps_linux_test.go`, `apps_windows_test.go`.

**Interfaces:**
- Consumes: `platform.Exec`, `platform.Runner`, `platform.StartApp`, `platform.ParseStartApps`, `powershellArgs`, `startAppsScript`.
- Produces:
  - `type appEntry struct{ id, name string }`
  - `func listApps(ctx context.Context) ([]appEntry, error)` and `func launchApp(ctx context.Context, app string) Outcome`, one per OS.
  - `func matchStartApp(apps []platform.StartApp, app string) (string, bool)` (OS-agnostic).

- [ ] **Step 1: Write the failing tests**

`apps/novad/internal/caps/apps_match_test.go`:

```go
package caps

import (
	"testing"

	"novad/internal/platform"
)

// "Notepad" and its AppID both open Notepad: an exact AppID first, then the
// Start menu's name compared without case.
func TestMatchStartAppPrefersTheExactAppIDThenTheNameWithoutCase(t *testing.T) {
	apps := []platform.StartApp{
		{Name: "Notepad", AppID: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"},
		{Name: "Paint", AppID: "Microsoft.Paint_8wekyb3d8bbwe!App"},
	}
	if id, ok := matchStartApp(apps, "notepad"); !ok || id != "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" {
		t.Fatalf("by name: %q %v", id, ok)
	}
	if id, ok := matchStartApp(apps, "Microsoft.Paint_8wekyb3d8bbwe!App"); !ok || id != "Microsoft.Paint_8wekyb3d8bbwe!App" {
		t.Fatalf("by id: %q %v", id, ok)
	}
	if _, ok := matchStartApp(apps, "Photoshop"); ok {
		t.Fatal("no match must say so")
	}
}
```

`apps/novad/internal/caps/apps_linux_test.go`:

```go
package caps

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The XDG scan survives its move into apps_linux.go: a .desktop file in the
// data home is listed by id and name, and a NoDisplay one is not.
func TestAppsListReadsTheXDGApplicationsDir(t *testing.T) {
	home := t.TempDir()
	apps := filepath.Join(home, "applications")
	if err := os.MkdirAll(apps, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(apps, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("gedit.desktop", "[Desktop Entry]\nName=Text Editor\nExec=gedit %U\n")
	write("hidden.desktop", "[Desktop Entry]\nName=Hidden\nNoDisplay=true\n")
	t.Setenv("XDG_DATA_HOME", home)
	t.Setenv("XDG_DATA_DIRS", filepath.Join(home, "none"))
	out := appsList(context.Background())
	if !out.OK || !strings.Contains(out.Output, "gedit — Text Editor") || strings.Contains(out.Output, "Hidden") {
		t.Fatalf("got ok=%v %q", out.OK, out.Output)
	}
}
```

`apps/novad/internal/caps/apps_windows_test.go`:

```go
package caps

import (
	"context"
	"testing"

	"novad/internal/platform"
)

func TestStartAppsRunsTheConstantScriptAndParsesItsJSON(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{
		"powershell.exe": `[{"Name":"Notepad","AppID":"Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"}]`,
	}}
	apps, err := startApps(context.Background(), r)
	if err != nil || len(apps) != 1 || apps[0].Name != "Notepad" {
		t.Fatalf("%v %v", apps, err)
	}
	args := r.Calls[0].Args
	if args[len(args)-1] != platform.EncodePowerShell(startAppsScript) {
		t.Fatal("the listing must run the constant script")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/novad && ~/.local/bin/mise x -- go test ./internal/caps/`
Expected: FAIL with `undefined: matchStartApp`. The Linux XDG test may pass once it compiles. That is fine: it guards the move.

- [ ] **Step 3: Write the implementation**

Replace `apps/novad/internal/caps/apps.go` with:

```go
package caps

import (
	"context"
	"fmt"
	"strings"
)

// appEntry is one launchable application: the id apps.launch takes, and the
// name a person would call it.
type appEntry struct{ id, name string }

// appsList lists launchable apps from this OS's own catalogue (apps_*.go).
// A catalogue that cannot be read is ok:false with the reason — never
// "0 apps", which would read as a machine with nothing installed.
func appsList(ctx context.Context) Outcome {
	apps, err := listApps(ctx)
	if err != nil {
		return fail("cannot list apps: %v", err)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d apps\n", len(apps))
	for _, a := range apps {
		fmt.Fprintf(&b, "%s — %s\n", a.id, a.name)
	}
	return ok0(b.String())
}

// appsLaunch starts one app by the id apps.list printed (or, where the OS
// allows, its name), detached so it outlives this handler. A launch that
// never started is ok:false.
func appsLaunch(ctx context.Context, args map[string]any) Outcome {
	app, ok := strArg(args, "app")
	if !ok || app == "" {
		return fail("apps.launch needs an 'app' (an id from apps.list)")
	}
	return launchApp(ctx, app)
}
```

Create `apps/novad/internal/caps/apps_linux.go`. It moves the old `appDirs`, `desktopApp`, `scanApps`, `parseDesktop`, `findDesktopFile`, `launchExecLine` and `stripFieldCodes` from the old `apps.go` **unchanged**, and adds the two entry points:

```go
package caps

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// listApps on Linux is the XDG .desktop catalogue. An empty list IS a
// reading here (a headless server has no desktop apps), not a failure.
func listApps(_ context.Context) ([]appEntry, error) {
	var out []appEntry
	for _, a := range scanApps() {
		out = append(out, appEntry{id: a.id, name: a.name})
	}
	return out, nil
}

// launchApp launches a .desktop app by id, detached. It prefers gtk-launch
// (which validates the id against the desktop database), then gio launch on
// the resolved file, then the parsed Exec line as a last resort. Needs a
// graphical session (DISPLAY/WAYLAND_DISPLAY/DBUS); see the README.
func launchApp(ctx context.Context, app string) Outcome {
	if path, err := exec.LookPath("gtk-launch"); err == nil {
		cmd := exec.CommandContext(ctx, path, app)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fail("gtk-launch could not start %q: %v: %s", app, err, strings.TrimSpace(string(out)))
		}
		return ok0("launched " + app)
	}
	desktopFile := findDesktopFile(app)
	if path, err := exec.LookPath("gio"); err == nil && desktopFile != "" {
		cmd := exec.CommandContext(ctx, path, "launch", desktopFile)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fail("gio launch could not start %q: %v: %s", app, err, strings.TrimSpace(string(out)))
		}
		return ok0("launched " + app)
	}
	if desktopFile != "" {
		if a, ok := parseDesktop(desktopFile, app); ok && a.exec != "" {
			if outcome := launchExecLine(a.exec); outcome != nil {
				return *outcome
			}
		}
	}
	return fail("could not launch %q: no gtk-launch/gio and no runnable Exec line found", app)
}

// ... appDirs, desktopApp, scanApps, parseDesktop, findDesktopFile,
// launchExecLine (with its Setsid) and stripFieldCodes, moved verbatim from
// the old apps.go ...
```

Paste the moved functions verbatim below that comment, then delete the comment. The `sort` and `bufio` imports are used by them.

Create `apps/novad/internal/caps/apps_darwin.go`:

```go
package caps

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"novad/internal/platform"
)

// appDirsDarwin are where macOS keeps applications: the system's, the
// machine's, and this user's.
func appDirsDarwin() []string {
	dirs := []string{"/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, "Applications"))
	}
	return dirs
}

// listApps on macOS is every *.app bundle in those folders, by name. A Mac
// always has apps in /System/Applications, so finding none means the folders
// could not be read — said, never "0 apps".
func listApps(_ context.Context) ([]appEntry, error) {
	seen := map[string]bool{}
	var apps []appEntry
	for _, dir := range appDirsDarwin() {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !strings.HasSuffix(e.Name(), ".app") {
				continue
			}
			name := strings.TrimSuffix(e.Name(), ".app")
			if seen[name] {
				continue
			}
			seen[name] = true
			apps = append(apps, appEntry{id: name, name: name})
		}
	}
	if len(apps) == 0 {
		return nil, errors.New("no .app bundle could be read in /Applications, /System/Applications or ~/Applications")
	}
	sort.Slice(apps, func(i, j int) bool { return apps[i].id < apps[j].id })
	return apps, nil
}

// launchApp is `open -a <name>`: macOS resolves the bundle and starts it in
// the user's session.
func launchApp(ctx context.Context, app string) Outcome {
	if _, err := (platform.Exec{}).Run(ctx, "/usr/bin/open", []string{"-a", app}, ""); err != nil {
		return fail("could not launch %q: %v", app, err)
	}
	return ok0("launched " + app)
}
```

Create `apps/novad/internal/caps/apps_windows.go`:

```go
package caps

import (
	"context"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"syscall"

	"novad/internal/platform"
)

// listApps on Windows is the Start menu's own list (Get-StartApps).
func listApps(ctx context.Context) ([]appEntry, error) {
	apps, err := startApps(ctx, platform.Exec{})
	if err != nil {
		return nil, err
	}
	out := make([]appEntry, 0, len(apps))
	for _, a := range apps {
		out = append(out, appEntry{id: a.AppID, name: a.Name})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].name) < strings.ToLower(out[j].name) })
	return out, nil
}

func startApps(ctx context.Context, r platform.Runner) ([]platform.StartApp, error) {
	out, err := r.Run(ctx, "powershell.exe", powershellArgs(startAppsScript), "")
	if err != nil {
		return nil, fmt.Errorf("reading the Start menu: %w", err)
	}
	return platform.ParseStartApps(out)
}

// launchApp starts the Start-menu app whose AppID or name matches, through
// explorer's shell:AppsFolder — the way the Start menu itself launches it,
// Store apps included. An app named like a program on PATH ("notepad",
// "notepad.exe") that the Start menu does not list is started directly.
func launchApp(ctx context.Context, app string) Outcome {
	apps, listErr := startApps(ctx, platform.Exec{})
	if listErr == nil {
		if id, ok := matchStartApp(apps, app); ok {
			cmd := exec.Command("explorer.exe", `shell:AppsFolder\`+id)
			// explorer.exe hands the launch to the shell and exits — often with
			// status 1 even when the app opened — so STARTING it is the signal,
			// never its exit code.
			if err := cmd.Start(); err != nil {
				return fail("could not launch %q: %v", app, err)
			}
			_ = cmd.Process.Release()
			return ok0("launched " + app)
		}
	}
	if path, err := exec.LookPath(app); err == nil {
		cmd := exec.Command(path)
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
		if err := cmd.Start(); err != nil {
			return fail("could not start %q: %v", path, err)
		}
		_ = cmd.Process.Release()
		return ok0("launched " + path)
	}
	if listErr != nil {
		return fail("could not launch %q: the Start menu could not be read (%v) and no program by that name is on PATH", app, listErr)
	}
	return fail("no Start-menu app named %q and no program by that name on PATH — device_list_apps lists the names", app)
}
```

Create `apps/novad/internal/caps/apps_match.go`:

```go
package caps

import (
	"strings"

	"novad/internal/platform"
)

// matchStartApp finds app among the Start menu's entries: an exact AppID
// first, then the Start menu's name compared without case. OS-agnostic so it
// is tested on every runner.
func matchStartApp(apps []platform.StartApp, app string) (string, bool) {
	for _, a := range apps {
		if a.AppID == app {
			return a.AppID, true
		}
	}
	for _, a := range apps {
		if strings.EqualFold(a.Name, app) {
			return a.AppID, true
		}
	}
	return "", false
}
```

- [ ] **Step 4: Run the tests and all six builds**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/novad
~/.local/bin/mise x -- go test ./... 2>&1 | tail -8
for t in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do GOOS=${t%/*} GOARCH=${t#*/} CGO_ENABLED=0 ~/.local/bin/mise x -- go vet ./... && echo "vet ok $t"; done
```

Expected: every package passes, followed by six `vet ok` lines. **This is the first commit where Windows compiles.**

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add apps/novad/internal/caps/apps.go apps/novad/internal/caps/apps_linux.go apps/novad/internal/caps/apps_darwin.go apps/novad/internal/caps/apps_windows.go apps/novad/internal/caps/apps_match.go apps/novad/internal/caps/apps_match_test.go apps/novad/internal/caps/apps_linux_test.go apps/novad/internal/caps/apps_windows_test.go
git -C $W commit -m "feat(novad): apps on Linux, macOS and Windows — the build compiles for all six targets"
git -C $W show --stat HEAD | tail -12
```

---

## Task 4: `shell.exec` — the whole group dies, and a dropped connection is not "ran"

**Files:**
- Modify: `apps/novad/internal/caps/shell.go:36-64`.
- Create: `apps/novad/internal/caps/procattr_unix.go`, `procattr_windows.go`.
- Move: the POSIX shell tests out of `caps_test.go` into a new `caps_unix_test.go` (`//go:build unix`).
- Create: `apps/novad/internal/caps/shell_unix_test.go`, `caps_windows_test.go`.

**Interfaces:**
- Produces: `func prepareCommand(cmd *exec.Cmd)` (per OS) and `const killGrace = 5 * time.Second`.

- [ ] **Step 1: Write the failing tests**

Move the four tests that run `sh` or `echo` from `caps_test.go` into a new `apps/novad/internal/caps/caps_unix_test.go`, unchanged:
- `TestShellExecNonzeroExitIsOkTrueWithTheCode`
- `TestShellExecZeroExitCapturesOutput`
- `TestShellExecOutputIsCappedAndStated`
- `TestShellExecUnstartableIsOkFalse`, which is portable but stays beside its siblings

The new file starts with:

```go
//go:build unix

package caps
```

and imports `context`, `strings` and `testing`.

Create `apps/novad/internal/caps/shell_unix_test.go`:

```go
//go:build unix

package caps

import (
	"context"
	"strings"
	"testing"
	"time"
)

// A timed-out command takes its whole process group with it. The
// backgrounded sleep inherits the output pipe: without the group kill, Wait
// blocks until the grandchild exits (30 s) or WaitDelay gives up (5 s).
func TestAShellTimeoutKillsTheWholeGroup(t *testing.T) {
	d := testDeps(t)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	out := Dispatch(ctx, "shell.exec", map[string]any{"argv": []any{"sh", "-c", "sleep 30 & sleep 30"}}, d)
	if out.OK || !strings.Contains(out.Error, "timed out") {
		t.Fatalf("got ok=%v %q", out.OK, out.Error)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("returned after %s: the group kill must take the backgrounded child too", elapsed)
	}
}

// A command cut off by a dropped connection did NOT run to completion. It was
// reported ok:true, exit -1 before S42a — "ran" for something that did not.
func TestACommandCancelledByADroppedConnectionIsNotReportedAsRan(t *testing.T) {
	d := testDeps(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(200 * time.Millisecond); cancel() }()
	out := Dispatch(ctx, "shell.exec", map[string]any{"argv": []any{"sleep", "30"}}, d)
	if out.OK || !strings.Contains(out.Error, "cancelled") {
		t.Fatalf("got ok=%v %q", out.OK, out.Error)
	}
}
```

Create `apps/novad/internal/caps/caps_windows_test.go`:

```go
package caps

import (
	"context"
	"strings"
	"testing"
)

// The Windows twins of caps_unix_test.go: a builtin needs cmd /c.
func TestShellExecNonzeroExitIsOkTrueWithTheCodeOnWindows(t *testing.T) {
	out := Dispatch(context.Background(), "shell.exec", map[string]any{"argv": []any{"cmd", "/c", "exit 3"}}, testDeps(t))
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 3 {
		t.Fatalf("ok=%v code=%v %q", out.OK, out.ExitCode, out.Error)
	}
}

func TestShellExecZeroExitCapturesOutputOnWindows(t *testing.T) {
	out := Dispatch(context.Background(), "shell.exec", map[string]any{"argv": []any{"cmd", "/c", "echo", "hello"}}, testDeps(t))
	if !out.OK || !strings.Contains(out.Output, "hello") {
		t.Fatalf("ok=%v %q %q", out.OK, out.Output, out.Error)
	}
}

func TestShellExecOutputIsCappedAndStatedOnWindows(t *testing.T) {
	out := Dispatch(context.Background(), "shell.exec", map[string]any{"argv": []any{
		"powershell.exe", "-NoProfile", "-Command", "[Console]::Out.Write('A' * 200000)",
	}}, testDeps(t))
	if !out.OK || !strings.Contains(out.Output, "truncated at") {
		t.Fatalf("ok=%v len=%d %q", out.OK, len(out.Output), out.Error)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/novad && ~/.local/bin/mise x -- go test ./internal/caps/ -run 'Timeout|Cancelled' -v`
Expected: FAIL.
- The timeout test returns only after about 5–30 s ("returned after …"). Today there is no group kill and no `WaitDelay`, so Go may wait for the grandchild.
- The cancelled test reports `ok=true`.

- [ ] **Step 3: Write the implementation**

Create `apps/novad/internal/caps/procattr_unix.go`:

```go
//go:build unix

package caps

import (
	"os/exec"
	"syscall"
)

// prepareCommand puts the command in its own process group and makes a
// cancel kill the WHOLE group: a backgrounded grandchild holding the output
// pipe would otherwise keep Wait blocked past the timeout (doing-things
// named this "a defect to fix regardless").
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = killGrace
}
```

Create `apps/novad/internal/caps/procattr_windows.go`:

```go
package caps

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

// prepareCommand starts the command in a new process group and makes a
// cancel take the whole TREE (taskkill /T) — wsl.exe and anything it
// started. WSL_UTF8=1 makes wsl.exe print UTF-8 instead of UTF-16, like
// every other program's output here.
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
		if err := kill.Run(); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
	cmd.WaitDelay = killGrace
	cmd.Env = append(os.Environ(), "WSL_UTF8=1")
}
```

In `apps/novad/internal/caps/shell.go`, change `import` to add `"time"`. Then:

After `cmd.Stderr = cw` (line 40), add:

```go
	prepareCommand(cmd)
```

Replace:

```go
	// A timeout is the daemon failing to complete the capability -> ok:false.
	if ctx.Err() == context.DeadlineExceeded {
		return fail("timed out; partial output:\n%s", cw.string())
	}
```

with:

```go
	// A timeout is the daemon failing to complete the capability -> ok:false.
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fail("timed out; partial output:\n%s", cw.string())
	}
	// Cancelled without a deadline: the connection to Nova dropped mid-run
	// (serve's context). The process was killed, not finished — never
	// "ran, exit -1".
	if errors.Is(ctx.Err(), context.Canceled) {
		return fail("cancelled before it finished — the connection to Nova dropped; partial output:\n%s", cw.string())
	}
```

At the bottom of `shell.go` add:

```go
// killGrace bounds how long Wait may block on output pipes after the command
// is killed, so a stuck descendant cannot hold a handler past its budget.
const killGrace = 5 * time.Second
```

- [ ] **Step 4: Run the tests and the six builds**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -8
for t in darwin/arm64 windows/amd64 windows/arm64; do GOOS=${t%/*} GOARCH=${t#*/} CGO_ENABLED=0 ~/.local/bin/mise x -- go vet ./... && echo "vet ok $t"; done
```

Expected: all pass, including the timeout test in under 3 s, followed by three `vet ok` lines.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add apps/novad/internal/caps/shell.go apps/novad/internal/caps/procattr_unix.go apps/novad/internal/caps/procattr_windows.go apps/novad/internal/caps/caps_test.go apps/novad/internal/caps/caps_unix_test.go apps/novad/internal/caps/shell_unix_test.go apps/novad/internal/caps/caps_windows_test.go
git -C $W commit -m "fix(novad): a timed-out command's whole group dies, and a dropped connection is never 'ran'"
git -C $W show --stat HEAD | tail -10
```

---

## Task 5: config per OS, the Windows DACL, and `Wipe`

**Files:**
- Modify: `apps/novad/internal/config/config.go`: `DefaultPaths` (lines 37-61), `Save` (lines 78-97), and a new `Wipe`.
- Create: `apps/novad/internal/config/custody_windows.go`, `custody_other.go`.
- Move: `TestKeyFileIs0600AndDirIs0700` from `config_test.go` into a new `config_unix_test.go` (`//go:build unix`).
- Create: `apps/novad/internal/config/custody_windows_test.go`, and append a wipe test to `config_test.go`.

**Interfaces:**
- Consumes: `platform.ConfigBase`, `platform.StateBase`.
- Produces:
  - `func Wipe(p Paths, now time.Time) error`
  - `func harden(dir string) error` (per OS)
  - `func DACLOf(dir string) (string, error)` (Windows only)

- [ ] **Step 1: Write the failing tests**

Append to `apps/novad/internal/config/config_test.go` (add imports `strings`, `time`):

```go
// A revoked device's identity goes; its audit log is set aside, never
// deleted and never replayed under a new id.
func TestWipeRemovesTheIdentityAndSetsTheAuditAside(t *testing.T) {
	p := testPaths(t)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := Save(p, Config{DeviceID: "d"}, priv); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.AuditFile, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1790000000, 0)
	if err := Wipe(p, now); err != nil {
		t.Fatal(err)
	}
	if p.Enrolled() {
		t.Fatal("after a wipe the device must not be enrolled")
	}
	if _, err := os.Stat(p.AuditFile); !os.IsNotExist(err) {
		t.Fatal("the live audit file must be gone")
	}
	aside, err := os.ReadFile(p.AuditFile + ".revoked-1790000000")
	if err != nil || !strings.Contains(string(aside), "{}") {
		t.Fatalf("the audit log must be set aside intact: %q %v", aside, err)
	}
	if err := Wipe(p, now); err != nil {
		t.Fatalf("wiping an already-wiped device is not an error: %v", err)
	}
}
```

Create `apps/novad/internal/config/custody_windows_test.go`:

```go
package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"regexp"
	"strings"
	"testing"
)

var ace = regexp.MustCompile(`\(([^)]*)\)`)

// The D-M11 read-back: the custody directories carry a PROTECTED DACL with
// exactly SYSTEM and this user — no BUILTIN\Users, no Everyone, nothing
// inherited from the parent. Windows ignores 0700/0600, so without this the
// device key inherits whatever the parent folder grants.
func TestTheCustodyDACLIsSystemAndThisUserOnly(t *testing.T) {
	p := testPaths(t)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := Save(p, Config{DeviceID: "d"}, priv); err != nil {
		t.Fatal(err)
	}
	sid, err := currentUserSID()
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{p.ConfigDir, p.StateDir} {
		sddl, err := DACLOf(dir)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(sddl, "D:P") {
			t.Fatalf("%s: the DACL must be protected (D:P...), got %s", dir, sddl)
		}
		trustees := map[string]bool{}
		for _, m := range ace.FindAllStringSubmatch(sddl, -1) {
			fields := strings.Split(m[1], ";")
			trustees[fields[len(fields)-1]] = true
		}
		if len(trustees) != 2 || !trustees["SY"] || !trustees[sid] {
			t.Fatalf("%s: want exactly SY and %s, got %v (%s)", dir, sid, trustees, sddl)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/novad && ~/.local/bin/mise x -- go test ./internal/config/`
Expected: FAIL with `undefined: Wipe`.

- [ ] **Step 3: Write the implementation**

In `apps/novad/internal/config/config.go`:

Replace the `Paths` doc comment and `DefaultPaths` with:

```go
// Paths resolves the daemon's file locations per OS (platform.ConfigBase and
// StateBase): Linux keeps XDG (unchanged, so an enrolled daemon finds its
// key), macOS uses ~/Library/Application Support, Windows puts config in
// %AppData% and the audit log in %LocalAppData%. The audit log lives in the
// state dir; the key and config in the config dir.
type Paths struct {
	ConfigDir  string
	StateDir   string
	ConfigFile string
	KeyFile    string
	AuditFile  string
	Home       string
}

// DefaultPaths resolves the standard locations for the current user.
func DefaultPaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, fmt.Errorf("cannot resolve home dir: %w", err)
	}
	configBase, err := platform.ConfigBase()
	if err != nil {
		return Paths{}, fmt.Errorf("cannot resolve the config dir: %w", err)
	}
	stateBase, err := platform.StateBase()
	if err != nil {
		return Paths{}, fmt.Errorf("cannot resolve the state dir: %w", err)
	}
	configDir := filepath.Join(configBase, "novad")
	stateDir := filepath.Join(stateBase, "novad")
	return Paths{
		ConfigDir:  configDir,
		StateDir:   stateDir,
		ConfigFile: filepath.Join(configDir, "config.json"),
		KeyFile:    filepath.Join(configDir, "key"),
		AuditFile:  filepath.Join(stateDir, "audit.jsonl"),
		Home:       home,
	}, nil
}
```

In `Save`, after the two `MkdirAll` calls and before `json.MarshalIndent`, insert:

```go
	// Windows ignores the mode bits above; harden sets the DACL that makes
	// them true there (custody_windows.go). Before the files are written, so
	// they inherit it. A no-op elsewhere.
	for _, dir := range []string{p.ConfigDir, p.StateDir} {
		if err := harden(dir); err != nil {
			return err
		}
	}
```

At the end of the file add:

```go
// Wipe removes this device's identity after core revoked it: the config and
// the key go, so a restart cannot reconnect as a device core has disowned,
// and the audit log is SET ASIDE (renamed, never deleted — it is the record
// of what this machine did) so a later enroll starts a fresh chain instead of
// replaying the revoked device's chain under the new id. Missing files are
// fine; any other failure is returned, because a wipe that silently
// half-happened is the one outcome worse than none.
func Wipe(p Paths, now time.Time) error {
	var errs []error
	for _, f := range []string{p.ConfigFile, p.KeyFile} {
		if err := os.Remove(f); err != nil && !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	if _, err := os.Stat(p.AuditFile); err == nil {
		aside := fmt.Sprintf("%s.revoked-%d", p.AuditFile, now.Unix())
		if err := os.Rename(p.AuditFile, aside); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
```

Update config.go's imports to add `"errors"`, `"io/fs"`, `"time"` and `"novad/internal/platform"`.

Create `apps/novad/internal/config/custody_other.go`:

```go
//go:build !windows

package config

// harden is a no-op where the 0700/0600 modes Save sets are the whole
// control (Linux, macOS).
func harden(string) error { return nil }
```

Create `apps/novad/internal/config/custody_windows.go`:

```go
package config

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// harden replaces dir's DACL with exactly two entries — SYSTEM and the user
// novad runs as, full control, inherited by everything created inside — and
// protects it from the parent's entries (transport critique M11, accepted in
// r2-integration). Windows ignores 0700/0600, so without this the device key
// inherits whatever the parent folder grants.
func harden(dir string) error {
	sid, err := currentUserSID()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + sid + ")")
	if err != nil {
		return fmt.Errorf("building the custody DACL: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("reading the custody DACL back: %w", err)
	}
	err = windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil)
	if err != nil {
		return fmt.Errorf("setting the custody DACL on %s: %w", dir, err)
	}
	return nil
}

// currentUserSID is the SID of the user this process runs as.
func currentUserSID() (string, error) {
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("reading this process's user: %w", err)
	}
	return tu.User.Sid.String(), nil
}

// DACLOf is dir's DACL as SDDL — what the read-back test (and a curious
// operator) compare against.
func DACLOf(dir string) (string, error) {
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return "", err
	}
	return sd.String(), nil
}
```

Create `apps/novad/internal/config/config_unix_test.go`, starting with `//go:build unix`, and move `TestKeyFileIs0600AndDirIs0700` into it unchanged, with its imports (`crypto/ed25519`, `crypto/rand`, `os`, `testing`). Remove that test from `config_test.go`.

- [ ] **Step 4: Run the tests and the six builds**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -8
for t in darwin/arm64 windows/amd64 windows/arm64; do GOOS=${t%/*} GOARCH=${t#*/} CGO_ENABLED=0 ~/.local/bin/mise x -- go vet ./... && echo "vet ok $t"; done
```

Expected: all pass, followed by three `vet ok` lines. The DACL test runs on the Windows CI runners (Task 19).

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add apps/novad/internal/config/
git -C $W commit -m "feat(novad): custody per OS — a protected DACL on Windows, and Wipe for a revoked device"
git -C $W show --stat HEAD | tail -10
```

---

## Task 6: `internal/facts`, enroll sends `runtime.GOOS`, and the WSL guard

**Files:**
- Create: `apps/novad/internal/facts/facts.go`, `apps/novad/internal/facts/facts_test.go`.
- Modify: `apps/novad/main.go`: `version` (line 32-33), `enrollBody` (lines 157-168), `cmdEnroll` (after the flag parse).
- Modify: `apps/novad/main_test.go`.

**Interfaces:**
- Consumes: `platform.Runner`, `platform.MachineUID`, `platform.OSVersion`, `platform.Mode`, `platform.Interactive`, `platform.WSL`, `platform.FakeRunner`.
- Produces:
  - `facts.Version = 2`, `facts.MaxAuthBytes = 4096`, `facts.MaxFrameBytes = 16384`.
  - Types: `facts.Auth{V, Agent AgentInfo, OS OSInfo, Hostname, MachineUID}`, `facts.AgentInfo{Version, Mode, SessionInteractive}`, `facts.OSInfo{GOOS, Arch, Version, WSL *WSL}`, `facts.WSL{Distro}`, `facts.Frame{Type, Net Net, Unreadable []Unreadable}`, `facts.Net{Ifaces []Iface}`, `facts.Iface{Name, MAC, IPv4CIDR []string, Up}`, `facts.Unreadable{Item, Reason}`.
  - `func GatherAuth(ctx context.Context, r platform.Runner, version string) (Auth, []Unreadable)`
  - `func GatherFrame(carried []Unreadable) Frame`
  - `main.enrollPreflight() error` and `var inWSL func() bool`.

- [ ] **Step 1: Write the failing tests**

`apps/novad/internal/facts/facts_test.go`:

```go
package facts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"testing"

	"novad/internal/platform"
)

// The auth facts are exactly the five keys r2-integration fixes, ≤4 KiB,
// with wsl present (null) off WSL, and every text clipped to core's cap.
func TestAuthFactsDescribeThisAgentInFiveKeysUnderTheCap(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{
		"/usr/sbin/ioreg": `"IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"`,
	}}
	a, _ := GatherAuth(context.Background(), r, strings.Repeat("v", 1000))
	if a.V != 2 || a.OS.GOOS != runtime.GOOS || a.OS.Arch != runtime.GOARCH {
		t.Fatalf("%+v", a)
	}
	if len(a.Agent.Version) != 255 {
		t.Fatalf("version must be clipped to 255, got %d", len(a.Agent.Version))
	}
	data, err := json.Marshal(a)
	if err != nil || len(data) > MaxAuthBytes {
		t.Fatalf("%d bytes, %v", len(data), err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if len(m) != 5 {
		t.Fatalf("the auth facts are exactly five keys, got %v", m)
	}
	for _, k := range []string{"v", "agent", "os", "hostname", "machine_uid"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing %q", k)
		}
	}
	if _, present := m["os"].(map[string]any)["wsl"]; !present {
		t.Error("os.wsl must be present — null when not inside WSL")
	}
	switch mode := a.Agent.Mode; mode {
	case "systemd-user", "launch-agent", "run-key", "foreground":
	default:
		t.Errorf("mode %q is not one core accepts", mode)
	}
}

func withIfaces(t *testing.T, ifs []ifaceInfo, err error) {
	t.Helper()
	old := readIfaces
	readIfaces = func() ([]ifaceInfo, error) { return ifs, err }
	t.Cleanup(func() { readIfaces = old })
}

func TestAFrameListsInterfacesSkipsLoopbackAndSaysWhatItCouldNotRead(t *testing.T) {
	withIfaces(t, []ifaceInfo{
		{Name: "lo", Loopback: true, Up: true, CIDRs: []string{"127.0.0.1/8"}},
		{Name: "wlp2s0", MAC: "aa:bb:cc:dd:ee:ff", Up: true, CIDRs: []string{"192.168.0.245/24"}},
		{Name: "tailscale0", Up: true, CIDRs: []string{"100.64.0.1/32"}},
		{Name: "docker0", MAC: "02:42:ac:11:00:01", AddrErr: errors.New("addrs unreadable")},
	}, nil)
	f := GatherFrame([]Unreadable{{Item: "machine_uid", Reason: "no id"}})
	if f.Type != "facts" || len(f.Net.Ifaces) != 3 {
		t.Fatalf("%+v", f)
	}
	if f.Net.Ifaces[0].Name != "wlp2s0" || f.Net.Ifaces[0].IPv4CIDR[0] != "192.168.0.245/24" || !f.Net.Ifaces[0].Up {
		t.Fatalf("%+v", f.Net.Ifaces[0])
	}
	if f.Net.Ifaces[1].MAC != "" {
		t.Fatal("a tunnel with no hardware address says so with an empty mac")
	}
	items := map[string]bool{}
	for _, u := range f.Unreadable {
		items[u.Item] = true
	}
	if !items["machine_uid"] || !items["net.ifaces.docker0"] {
		t.Fatalf("unreadable = %+v", f.Unreadable)
	}
}

func TestAFrameWithTooManyInterfacesIsCappedAndSaysSo(t *testing.T) {
	var many []ifaceInfo
	for i := 0; i < 40; i++ {
		many = append(many, ifaceInfo{Name: fmt.Sprintf("veth%02d", i), MAC: "02:42:ac:11:00:01", Up: true,
			CIDRs: []string{"10.0.0.1/24", "10.0.1.1/24", "10.0.2.1/24", "10.0.3.1/24", "10.0.4.1/24",
				"10.0.5.1/24", "10.0.6.1/24", "10.0.7.1/24", "10.0.8.1/24"}})
	}
	withIfaces(t, many, nil)
	f := GatherFrame(nil)
	if len(f.Net.Ifaces) != 32 || len(f.Net.Ifaces[0].IPv4CIDR) != 8 {
		t.Fatalf("ifaces=%d addrs=%d", len(f.Net.Ifaces), len(f.Net.Ifaces[0].IPv4CIDR))
	}
	said := false
	for _, u := range f.Unreadable {
		said = said || (u.Item == "net.ifaces" && strings.Contains(u.Reason, "more than 32"))
	}
	data, _ := json.Marshal(f)
	if !said || len(data) > MaxFrameBytes {
		t.Fatalf("said=%v bytes=%d", said, len(data))
	}
}

func TestAnInterfaceListThatCannotBeReadIsSaidNeverEmpty(t *testing.T) {
	withIfaces(t, nil, errors.New("netlink refused"))
	f := GatherFrame(nil)
	data, _ := json.Marshal(f)
	if !strings.Contains(string(data), `"ifaces":[]`) {
		t.Fatalf("ifaces must marshal as [], got %s", data)
	}
	if len(f.Unreadable) != 1 || f.Unreadable[0].Item != "net.ifaces" {
		t.Fatalf("%+v", f.Unreadable)
	}
}
```

Replace `TestEnrollBodyCarriesIdentityOnly`'s expected `"platform": "linux"` with `"platform": runtime.GOOS`, and add `"runtime"` and `"strings"` to `main_test.go`'s imports. Append:

```go
// D1: on Windows the agent is the native build. Inside WSL, enroll refuses
// with "cannot" — never a question, never an override flag.
func TestEnrollRefusesInsideWSL(t *testing.T) {
	old := inWSL
	t.Cleanup(func() { inWSL = old })
	inWSL = func() bool { return true }
	err := enrollPreflight()
	if err == nil || !strings.HasPrefix(err.Error(), "cannot: on Windows, Nova's agent runs on Windows itself") {
		t.Fatalf("got %v", err)
	}
	inWSL = func() bool { return false }
	if err := enrollPreflight(); err != nil {
		t.Fatalf("outside WSL enroll proceeds, got %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/novad && ~/.local/bin/mise x -- go test . ./internal/facts/`
Expected: FAIL. The facts package does not exist, and `undefined: enrollPreflight`.

- [ ] **Step 3: Write the implementation**

`apps/novad/internal/facts/facts.go`:

```go
// Package facts is what novad says about the machine it runs on: raw
// observations, never conclusions. Core alone turns them into roles (hub
// decision D2, services/core/app/device_facts.py), so nothing here decides
// what the agent "can" do.
//
// Two shapes, both on the socket core authenticated (TLS or WireGuard; facts
// are not signed — r2-integration D11):
//
//	Auth  rides inside the auth frame: small (≤4 KiB), about the agent and
//	      the OS. Core records it only after the signature verifies, and it is
//	      never a reason to refuse the socket.
//	Frame is the `facts` frame: the larger, slower facts — network
//	      interfaces now; power, compute and the rest as later slices add
//	      them — sent after ready, on a change (at most once a minute), every
//	      ten minutes, and on facts.refresh.
//
// A fact that cannot be read is said so: as an `unreadable` entry in the
// frame naming the item and the reason, or — in Auth, which has no room to
// explain itself — as an empty value core reads as unknown, with its reason
// carried into every frame's unreadable list.
package facts

import (
	"context"
	"fmt"
	"net"
	"os"
	"runtime"
	"unicode/utf8"

	"novad/internal/platform"
)

const (
	// Version is the facts shape r2-integration fixes; core refuses others.
	Version = 2
	// MaxAuthBytes and MaxFrameBytes are core's caps (device_facts.py).
	MaxAuthBytes  = 4096
	MaxFrameBytes = 16 * 1024

	maxText       = 255
	maxIfaces     = 32
	maxAddrs      = 8
	maxUnreadable = 32
)

// Auth is the auth frame's facts.
type Auth struct {
	V          int       `json:"v"`
	Agent      AgentInfo `json:"agent"`
	OS         OSInfo    `json:"os"`
	Hostname   string    `json:"hostname"`
	MachineUID string    `json:"machine_uid"`
}

// AgentInfo is about the daemon itself. The build identity is doing-things
// S30's `build` field, never added here (r2-integration:699).
type AgentInfo struct {
	Version            string `json:"version"`
	Mode               string `json:"mode"`
	SessionInteractive bool   `json:"session_interactive"`
}

// OSInfo is the OS as Go and the OS name it. WSL is nil (null on the wire)
// unless this Linux runs inside WSL.
type OSInfo struct {
	GOOS    string `json:"goos"`
	Arch    string `json:"arch"`
	Version string `json:"version"`
	WSL     *WSL   `json:"wsl"`
}

// WSL names the distribution this agent runs inside ("" when unnamed).
type WSL struct {
	Distro string `json:"distro"`
}

// Frame is the facts frame.
type Frame struct {
	Type       string       `json:"type"`
	Net        Net          `json:"net"`
	Unreadable []Unreadable `json:"unreadable"`
}

// Net is this machine's network interfaces, loopback excluded.
type Net struct {
	Ifaces []Iface `json:"ifaces"`
}

// Iface is one interface. MAC is "" for one with no hardware address (a
// tunnel); IPv4CIDR lists at most eight.
type Iface struct {
	Name     string   `json:"name"`
	MAC      string   `json:"mac"`
	IPv4CIDR []string `json:"ipv4_cidr"`
	Up       bool     `json:"up"`
}

// Unreadable names a fact that could not be read, and why.
type Unreadable struct {
	Item   string `json:"item"`
	Reason string `json:"reason"`
}

// GatherAuth reads this machine's auth facts. version is the build stamp
// (main.version). What could not be read is returned so the caller carries
// it into the facts frames.
func GatherAuth(ctx context.Context, r platform.Runner, version string) (Auth, []Unreadable) {
	var unread []Unreadable
	host, err := os.Hostname()
	if err != nil {
		unread = append(unread, Unreadable{Item: "hostname", Reason: clip(err.Error())})
	}
	uid, err := platform.MachineUID(ctx, r)
	if err != nil {
		unread = append(unread, Unreadable{Item: "machine_uid", Reason: clip(err.Error())})
	}
	a := Auth{
		V: Version,
		Agent: AgentInfo{
			Version:            clip(version),
			Mode:               platform.Mode(),
			SessionInteractive: platform.Interactive(),
		},
		OS: OSInfo{
			GOOS:    runtime.GOOS,
			Arch:    runtime.GOARCH,
			Version: clip(platform.OSVersion(ctx, r)),
		},
		Hostname:   clip(host),
		MachineUID: uid,
	}
	if in, distro := platform.WSL(); in {
		a.OS.WSL = &WSL{Distro: clip(distro)}
	}
	return a, unread
}

// ifaceInfo is one interface as GatherFrame reads it — a type of its own so
// a test hands in interfaces without a network stack.
type ifaceInfo struct {
	Name     string
	MAC      string
	Up       bool
	Loopback bool
	CIDRs    []string
	AddrErr  error
}

// readIfaces is the real reader; a variable so a test replaces it.
var readIfaces = func() ([]ifaceInfo, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	out := make([]ifaceInfo, 0, len(ifs))
	for _, ifc := range ifs {
		info := ifaceInfo{
			Name:     ifc.Name,
			MAC:      ifc.HardwareAddr.String(),
			Up:       ifc.Flags&net.FlagUp != 0,
			Loopback: ifc.Flags&net.FlagLoopback != 0,
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			info.AddrErr = err
		}
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok && ipnet.IP.To4() != nil {
				info.CIDRs = append(info.CIDRs, ipnet.String())
			}
		}
		out = append(out, info)
	}
	return out, nil
}

// GatherFrame reads the facts frame. carried are GatherAuth's unreadable
// entries, repeated so every frame states them.
func GatherFrame(carried []Unreadable) Frame {
	f := Frame{Type: "facts", Net: Net{Ifaces: []Iface{}}, Unreadable: append([]Unreadable{}, carried...)}
	ifs, err := readIfaces()
	if err != nil {
		f.Unreadable = append(f.Unreadable, Unreadable{Item: "net.ifaces", Reason: clip(err.Error())})
		return capUnreadable(f)
	}
	for _, ifc := range ifs {
		if ifc.Loopback {
			continue
		}
		if len(f.Net.Ifaces) == maxIfaces {
			f.Unreadable = append(f.Unreadable, Unreadable{
				Item:   "net.ifaces",
				Reason: fmt.Sprintf("more than %d interfaces; the rest are not listed", maxIfaces),
			})
			break
		}
		entry := Iface{Name: clip(ifc.Name), MAC: ifc.MAC, IPv4CIDR: []string{}, Up: ifc.Up}
		for _, c := range ifc.CIDRs {
			if len(entry.IPv4CIDR) == maxAddrs {
				break
			}
			entry.IPv4CIDR = append(entry.IPv4CIDR, c)
		}
		if ifc.AddrErr != nil {
			f.Unreadable = append(f.Unreadable, Unreadable{
				Item: "net.ifaces." + clip(ifc.Name), Reason: clip(ifc.AddrErr.Error()),
			})
		}
		f.Net.Ifaces = append(f.Net.Ifaces, entry)
	}
	return capUnreadable(f)
}

// capUnreadable keeps the list within core's cap, saying so when it cut.
func capUnreadable(f Frame) Frame {
	if len(f.Unreadable) > maxUnreadable {
		f.Unreadable = append(f.Unreadable[:maxUnreadable-1],
			Unreadable{Item: "unreadable", Reason: "more unreadable items than can be listed"})
	}
	return f
}

// clip keeps a text within core's 255-character cap, on a rune boundary.
func clip(s string) string {
	if len(s) <= maxText {
		return s
	}
	cut := maxText
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
```

In `apps/novad/main.go`:

- Replace lines 32-33 with:

  ```go
  // version is the build stamp: builds set it with
  // -ldflags "-X main.version=<rev>" (CI and the walk build do; see README).
  var version = "0.2.0-dev"
  ```

- In `enrollBody`, change `"platform": "linux",` to `"platform": runtime.GOOS,`.
- Add the imports `"errors"`, `"runtime"` and `"novad/internal/platform"`.
- Before `func enrollBody`, add:

```go
// inWSL is platform.WSL, a variable so a test can say "inside WSL".
var inWSL = func() bool { in, _ := platform.WSL(); return in }

// enrollPreflight refuses to enroll inside WSL (hub decision D1): on Windows,
// Nova's agent runs on Windows itself and reaches WSL through wsl.exe and
// \\wsl.localhost. An agent inside WSL cannot reach Windows' desktop,
// adapters or sleep settings — the machine belongs to its Windows agent.
func enrollPreflight() error {
	if inWSL() {
		return errors.New("cannot: on Windows, Nova's agent runs on Windows itself; " +
			"run the Windows command (novad.exe enroll) in PowerShell, not this one inside WSL")
	}
	return nil
}
```

- In `cmdEnroll`, directly after the `if *server == "" || *code == ""` block, add:

```go
	if err := enrollPreflight(); err != nil {
		fail("%v", err)
	}
```

- [ ] **Step 4: Run the tests and the six builds**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -8
for t in darwin/arm64 windows/amd64 windows/arm64; do GOOS=${t%/*} GOARCH=${t#*/} CGO_ENABLED=0 ~/.local/bin/mise x -- go vet ./... && echo "vet ok $t"; done
```

Expected: all pass, followed by three `vet ok` lines.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add apps/novad/internal/facts/ apps/novad/main.go apps/novad/main_test.go
git -C $W commit -m "feat(novad): facts about the machine, enroll sends its real OS, and enroll refuses inside WSL"
git -C $W show --stat HEAD | tail -8
```

---

## Task 7: facts on the wire — the auth frame, the first facts frame, `facts.refresh`

**Files:**
- Modify: `apps/novad/internal/wire/envelope.go`: frame types (lines 26-35), the `Auth` struct (lines 44-50), a new `ReasonRevoked`.
- Modify: `apps/novad/internal/client/client.go`: the `Agent` struct, `New`, `handshake`, `serve`, `handleCommand`, plus the new `sendFacts`, `frameBytes` and `writeFacts`.
- Modify: `apps/novad/main.go` `cmdRun` (the `client.New` call).
- Modify: `apps/novad/internal/client/integration_test.go`: `New` calls gain `"test"`. Test: append three tests.

**Interfaces:**
- Consumes: `facts.GatherAuth`, `facts.GatherFrame`, `facts.MaxFrameBytes`, `caps.Deps.SendFacts`.
- Produces:
  - `wire.TypeFacts = "facts"`, `wire.ReasonRevoked = "revoked"`, and `wire.Auth.Facts any` with tag `json:"facts,omitempty"`.
  - `func New(cfg config.Config, priv ed25519.PrivateKey, log *audit.Log, home, version string, logf func(string, ...any)) (*Agent, error)`
  - `Agent` fields used by Task 8: `now func() time.Time`, `factsMu sync.Mutex`, `lastFacts []byte`, `lastFactsAt time.Time`, `authUnread []facts.Unreadable`, `gatherFrame func([]facts.Unreadable) facts.Frame`, `gatherAuth func(context.Context) (facts.Auth, []facts.Unreadable)`.
  - Methods: `(a *Agent) sendFacts(ctx, c) error`, `(a *Agent) frameBytes() ([]byte, error)`, `(a *Agent) writeFacts(ctx, c, data []byte) error`.

- [ ] **Step 1: Write the failing tests**

Update every `New(cfg, devPriv, auditLog, home, nil)` in `integration_test.go` (two calls, including in `buildAgent`) to `New(cfg, devPriv, auditLog, home, "test", nil)`. Add `"runtime"` to the imports. Then append:

```go
// fakeCoreHandshake runs challenge -> auth (verified) -> ready on c and
// returns the auth frame, or nil if the signature did not verify.
func fakeCoreHandshake(ctx context.Context, c *websocket.Conn, corePub ed25519.PublicKey, devPub ed25519.PublicKey) map[string]any {
	nonce := make([]byte, 32)
	_, _ = rand.Read(nonce)
	_ = coreWrite(ctx, c, map[string]any{"type": "challenge", "nonce": hex.EncodeToString(nonce), "core_pubkey": hex.EncodeToString(corePub)})
	auth, err := coreRead(ctx, c)
	if err != nil {
		return nil
	}
	sigHex, _ := auth["sig"].(string)
	sig, _ := hex.DecodeString(sigHex)
	if !ed25519.Verify(devPub, nonce, sig) {
		return nil
	}
	_ = coreWrite(ctx, c, map[string]any{"type": "ready", "last_seq": nil})
	return auth
}

func TestTheAuthFrameCarriesFactsAndAFactsFrameFollowsReady(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	type seen struct{ auth, next map[string]any }
	ch := make(chan seen, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		auth := fakeCoreHandshake(r.Context(), c, corePub, devPub)
		if auth == nil {
			return
		}
		next, _ := coreRead(r.Context(), c)
		ch <- seen{auth: auth, next: next}
		<-r.Context().Done()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, "dev-facts-1", hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() { _ = agent.Run(ctx) }()
	var got seen
	select {
	case got = <-ch:
	case <-ctx.Done():
		t.Fatal("timed out")
	}
	cancel()
	fm, ok := got.auth["facts"].(map[string]any)
	if !ok {
		t.Fatalf("the auth frame carries no facts: %v", got.auth)
	}
	if v, _ := fm["v"].(json.Number); v.String() != "2" {
		t.Fatalf("facts v = %v", fm["v"])
	}
	if osm, _ := fm["os"].(map[string]any); osm["goos"] != runtime.GOOS {
		t.Fatalf("facts os = %v", fm["os"])
	}
	if got.next["type"] != "facts" {
		t.Fatalf("the first frame after ready must be facts, got %v", got.next["type"])
	}
	if _, ok := got.next["net"].(map[string]any); !ok {
		t.Fatalf("the facts frame has no net: %v", got.next)
	}
}

// The facts frame goes out BEFORE facts.refresh's own result, so core has
// recorded the facts by the time its command returns.
func TestFactsRefreshWritesTheFrameBeforeItsResult(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-refresh-1"
	order := make(chan []string, 1)
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
		if first, _ := coreRead(ctx, c); first["type"] != "facts" {
			return
		}
		now := time.Now().Unix()
		env := map[string]any{
			"v": int64(1), "envelope_id": "refresh-e1", "device_id": deviceID,
			"capability": "facts.refresh", "args": map[string]any{},
			"issued_at": now, "expires_at": now + 60,
		}
		canon, _ := wire.Canonical(env)
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": hex.EncodeToString(ed25519.Sign(corePriv, canon))})
		var types []string
		for len(types) < 2 {
			f, err := coreRead(ctx, c)
			if err != nil {
				break
			}
			if typ, _ := f["type"].(string); typ == "facts" || typ == "result" {
				types = append(types, typ)
			}
		}
		order <- types
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() { _ = agent.Run(ctx) }()
	select {
	case got := <-order:
		if len(got) != 2 || got[0] != "facts" || got[1] != "result" {
			t.Fatalf("frames after facts.refresh = %v, want [facts result]", got)
		}
	case <-ctx.Done():
		t.Fatal("timed out")
	}
}

// novad repoint's probe writes nothing on either side: no facts.
func TestTheRepointProbeSendsNoFacts(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	sawFacts := make(chan bool, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		auth := fakeCoreHandshake(r.Context(), c, corePub, devPub)
		_, present := auth["facts"]
		sawFacts <- present
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cfg := config.Config{DeviceID: "dev-probe-1", Server: srv.URL, CorePubKey: hex.EncodeToString(corePub)}
	if err := VerifyServer(context.Background(), cfg, devPriv); err != nil {
		t.Fatal(err)
	}
	if <-sawFacts {
		t.Fatal("the repoint probe must not send facts")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/novad && ~/.local/bin/mise x -- go test ./internal/client/`
Expected: FAIL. The compile errors on `New`'s arity; once they are fixed, `the auth frame carries no facts`.

- [ ] **Step 3: Write the implementation**

In `apps/novad/internal/wire/envelope.go`:
- Add `TypeFacts = "facts"` to the frame-type const block.
- Replace the `Auth` struct with:

```go
// Auth is device -> core: the device id and its signature over the RAW nonce
// bytes (bytes.fromhex(nonce)) — not an envelope, not the hex string.
type Auth struct {
	Type     string `json:"type"`
	DeviceID string `json:"device_id"`
	Sig      string `json:"sig"`
	// Facts are the agent's auth-frame facts (internal/facts.Auth), recorded
	// by core only after Sig verifies and never a reason to refuse. The
	// repoint probe omits them: it writes nothing on either side.
	Facts any `json:"facts,omitempty"`
}

// ReasonRevoked is the auth_error reason core sends for a device it revoked
// — the one refusal that is final (client.ErrRevoked). Any other reason is
// retried.
const ReasonRevoked = "revoked"
```

In `apps/novad/internal/client/client.go`:
- Add the imports `"sync"`, `"novad/internal/facts"` and `"novad/internal/platform"`.
- Extend the `Agent` struct after `verifier *wire.Verifier`:

```go
	// version is the build stamp the auth facts carry (main.version).
	version string
	// gatherAuth and gatherFrame read the facts; fields so a test hands in
	// its own. now is the clock (Task 8's resume detector reads it too).
	gatherAuth  func(context.Context) (facts.Auth, []facts.Unreadable)
	gatherFrame func([]facts.Unreadable) facts.Frame
	now         func() time.Time

	// factsMu guards what the facts frames remember: what GatherAuth could
	// not read (repeated in every frame), and the last frame written and
	// when — the heartbeat's change check compares against them.
	factsMu     sync.Mutex
	authUnread  []facts.Unreadable
	lastFacts   []byte
	lastFactsAt time.Time
```

- Replace `New`'s signature and return with:

```go
func New(cfg config.Config, priv ed25519.PrivateKey, log *audit.Log, home, version string, logf func(string, ...any)) (*Agent, error) {
```

and

```go
	return &Agent{
		cfg:      cfg,
		priv:     priv,
		audit:    log,
		deps:     caps.Deps{Home: home},
		wsURL:    wsURL,
		logf:     logf,
		verifier: verifier,
		version:  version,
		gatherAuth: func(ctx context.Context) (facts.Auth, []facts.Unreadable) {
			return facts.GatherAuth(ctx, platform.Exec{}, version)
		},
		gatherFrame: facts.GatherFrame,
		now:         time.Now,
	}, nil
```

- In `handshake`, replace the `writeFrame(hsCtx, c, wire.Auth{...})` call with:

```go
	auth, unread := a.gatherAuth(hsCtx)
	a.factsMu.Lock()
	a.authUnread = unread
	a.factsMu.Unlock()
	if err := writeFrame(hsCtx, c, wire.Auth{
		Type:     wire.TypeAuth,
		DeviceID: a.cfg.DeviceID,
		Sig:      hex.EncodeToString(sig),
		Facts:    auth,
	}); err != nil {
		return fmt.Errorf("sending auth: %w", err)
	}
```

- In `serve`, after `defer cancel()`, insert:

```go
	// The facts frame follows ready at once (r2-integration): core records
	// the slower facts before the first command could need them.
	if err := a.sendFacts(serveCtx, c); err != nil {
		a.logf("facts frame not sent: %v", err)
	}
```

- In `handleCommand`, replace `outcome := caps.Dispatch(cmdCtx, capability, args, a.deps)` with:

```go
	// facts.refresh writes its frame on THIS connection, before its result.
	deps := a.deps
	deps.SendFacts = func(ctx context.Context) error { return a.sendFacts(ctx, c) }
	outcome := caps.Dispatch(cmdCtx, capability, args, deps)
```

- Add, after `emit`:

```go
// sendFacts gathers a facts frame and writes it on c.
func (a *Agent) sendFacts(ctx context.Context, c *websocket.Conn) error {
	data, err := a.frameBytes()
	if err != nil {
		return err
	}
	return a.writeFacts(ctx, c, data)
}

// frameBytes gathers and encodes a facts frame. One over core's cap is an
// error here — never sent to be refused over there.
func (a *Agent) frameBytes() ([]byte, error) {
	a.factsMu.Lock()
	carried := append([]facts.Unreadable(nil), a.authUnread...)
	a.factsMu.Unlock()
	data, err := json.Marshal(a.gatherFrame(carried))
	if err != nil {
		return nil, err
	}
	if len(data) > facts.MaxFrameBytes {
		return nil, fmt.Errorf("the facts frame is %d bytes, over the %d-byte cap", len(data), facts.MaxFrameBytes)
	}
	return data, nil
}

// writeFacts writes an encoded frame and remembers what went out and when.
func (a *Agent) writeFacts(ctx context.Context, c *websocket.Conn, data []byte) error {
	if err := c.Write(ctx, websocket.MessageText, data); err != nil {
		return err
	}
	a.factsMu.Lock()
	a.lastFacts, a.lastFactsAt = data, a.now()
	a.factsMu.Unlock()
	return nil
}
```

In `apps/novad/main.go` `cmdRun`, change `client.New(cfg, priv, auditLog, paths.Home, func(...` to `client.New(cfg, priv, auditLog, paths.Home, version, func(...`.

- [ ] **Step 4: Run the tests and the six builds**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -8
for t in darwin/arm64 windows/amd64; do GOOS=${t%/*} GOARCH=${t#*/} CGO_ENABLED=0 ~/.local/bin/mise x -- go vet ./... && echo "vet ok $t"; done
```

Expected: all pass, including the three new tests, followed by two `vet ok` lines.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add apps/novad/internal/wire/envelope.go apps/novad/internal/client/client.go apps/novad/internal/client/integration_test.go apps/novad/main.go
git -C $W commit -m "feat(novad): facts on the wire — in the auth frame, a facts frame after ready, and facts.refresh"
git -C $W show --stat HEAD | tail -8
```

---

## Task 8: liveness — the backoff resets, a ping proves the path, a resume reconnects

**Files:**
- Modify: `apps/novad/internal/client/client.go`: constants, the `Agent` fields, `New`, `Run` (lines 118-143), `connectOnce` (145-160), `serve` (244-265), `heartbeat` (267-281), and a new `maybeSendFacts`.
- Test: `apps/novad/internal/client/integration_test.go` (append).

**Interfaces:**
- Consumes: Task 7's `now`, `frameBytes`, `writeFacts`, `lastFacts`, `lastFactsAt`.
- Produces:
  - Constants: `PingTimeout = 10 * time.Second`, `FactsEvery = 10 * time.Minute`, `FactsMinGap = time.Minute`.
  - `Agent` fields: `heartbeatEvery`, `pingTimeout`, `factsEvery`, `factsMinGap time.Duration`, and `backoffs []time.Duration`.
  - `func (a *Agent) connectOnce(ctx) (bool, error)`: whether it authenticated, and why it ended.
  - `func (a *Agent) heartbeat(ctx context.Context, cancel context.CancelFunc, c *websocket.Conn)`

- [ ] **Step 1: Write the failing tests**

Append to `integration_test.go`:

```go
// countingCore authenticates every connection, records when each arrived,
// then either closes it at once or holds it (hold=true), reading frames so
// pings are answered.
func countingCore(t *testing.T, corePub, devPub ed25519.PublicKey, hold, answerPings bool) (*httptest.Server, func() []time.Time) {
	t.Helper()
	var mu sync.Mutex
	var arrivals []time.Time
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		mu.Lock()
		arrivals = append(arrivals, time.Now())
		mu.Unlock()
		if fakeCoreHandshake(r.Context(), c, corePub, devPub) == nil {
			return
		}
		if !hold {
			_ = c.Close(websocket.StatusNormalClosure, "cycling")
			return
		}
		if answerPings {
			for {
				if _, err := coreRead(r.Context(), c); err != nil {
					return
				}
			}
		}
		<-r.Context().Done() // never reads: pings go unanswered
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, func() []time.Time {
		mu.Lock()
		defer mu.Unlock()
		return append([]time.Time(nil), arrivals...)
	}
}

func waitFor(t *testing.T, within time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", within)
}

// Before S42a the ladder never reset: after five drops EVERY reconnect
// waited the longest step for the life of the process.
func TestTheBackoffResetsAfterASessionThatAuthenticated(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	srv, arrivals := countingCore(t, corePub, devPub, false, false)
	agent, _ := buildAgent(t, srv.URL, "dev-backoff-1", hex.EncodeToString(corePub), devPriv)
	agent.backoffs = []time.Duration{20 * time.Millisecond, 40 * time.Millisecond, 80 * time.Millisecond, 160 * time.Millisecond, 10 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	go func() { _ = agent.Run(ctx) }()
	// Seven authenticated sessions: without the reset, the sixth waits 10 s.
	waitFor(t, 3*time.Second, func() bool { return len(arrivals()) >= 7 })
}

func TestAPingThatGoesUnansweredEndsTheSession(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	srv, arrivals := countingCore(t, corePub, devPub, true, false)
	agent, _ := buildAgent(t, srv.URL, "dev-ping-1", hex.EncodeToString(corePub), devPriv)
	agent.heartbeatEvery, agent.pingTimeout = 50*time.Millisecond, 100*time.Millisecond
	agent.backoffs = []time.Duration{20 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	go func() { _ = agent.Run(ctx) }()
	waitFor(t, 3*time.Second, func() bool { return len(arrivals()) >= 2 })
}

// Review focus 4: a wall-clock jump between ticks is a sleep — the session
// ends and the next connect comes after the FIRST step of the ladder (the
// reset), not after a TCP timeout or a 30 s wait.
func TestAClockJumpEndsTheSessionAndTheNextConnectIsQuick(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	srv, arrivals := countingCore(t, corePub, devPub, true, true)
	agent, _ := buildAgent(t, srv.URL, "dev-resume-1", hex.EncodeToString(corePub), devPriv)
	agent.heartbeatEvery = 50 * time.Millisecond
	var mu sync.Mutex
	offset := time.Duration(0)
	agent.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return time.Now().Add(offset) }
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	go func() { _ = agent.Run(ctx) }()
	waitFor(t, 2*time.Second, func() bool { return len(arrivals()) >= 1 })
	time.Sleep(120 * time.Millisecond) // a couple of normal ticks first
	mu.Lock()
	offset = 10 * time.Minute // the laptop "slept" ten minutes
	mu.Unlock()
	jumped := time.Now()
	waitFor(t, 3*time.Second, func() bool { return len(arrivals()) >= 2 })
	if gap := arrivals()[1].Sub(jumped); gap > 2500*time.Millisecond {
		t.Fatalf("reconnected %s after the jump; the reset ladder's first step is 1 s", gap)
	}
}

// Changed facts go out at most once per factsMinGap; unchanged ones only
// every factsEvery.
func TestFactsAreResentOnChangeAtMostOncePerGap(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	var mu sync.Mutex
	count := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		if fakeCoreHandshake(r.Context(), c, corePub, devPub) == nil {
			return
		}
		for {
			f, err := coreRead(r.Context(), c)
			if err != nil {
				return
			}
			if f["type"] == "facts" {
				mu.Lock()
				count++
				mu.Unlock()
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, "dev-cadence-1", hex.EncodeToString(corePub), devPriv)
	agent.heartbeatEvery, agent.factsMinGap, agent.factsEvery = 20*time.Millisecond, 200*time.Millisecond, time.Hour
	n := 0
	agent.gatherFrame = func([]facts.Unreadable) facts.Frame { // changes on every gather
		n++
		return facts.Frame{Type: "facts", Net: facts.Net{Ifaces: []facts.Iface{}},
			Unreadable: []facts.Unreadable{{Item: "tick", Reason: fmt.Sprint(n)}}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1100*time.Millisecond)
	defer cancel()
	_ = agent.Run(ctx)
	mu.Lock()
	defer mu.Unlock()
	// One after ready, then about one per 200 ms — never one per 20 ms tick.
	if count < 3 || count > 8 {
		t.Fatalf("%d facts frames in ~1 s", count)
	}
}
```

Add `"fmt"` and `"novad/internal/facts"` to the test imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/novad && ~/.local/bin/mise x -- go test ./internal/client/ -run 'Backoff|Ping|ClockJump|Resent' -v`
Expected: FAIL to compile, with `agent.backoffs undefined`.

- [ ] **Step 3: Write the implementation**

In `client.go`, under the `HeartbeatInterval` const add:

```go
// PingTimeout bounds each heartbeat's ping: a write can succeed into a dead
// TCP connection for minutes, a pong cannot.
const PingTimeout = 10 * time.Second

// FactsEvery and FactsMinGap are the facts frame's cadence
// (r2-integration): unchanged facts every ten minutes; changed facts at most
// once a minute.
const (
	FactsEvery  = 10 * time.Minute
	FactsMinGap = time.Minute
)

// defaultBackoffs is the reconnect ladder. It resets after every session
// that authenticated (Run).
var defaultBackoffs = []time.Duration{1 * time.Second, 2 * time.Second, 5 * time.Second, 15 * time.Second, 30 * time.Second}
```

Add to the `Agent` struct:

```go
	// Liveness knobs: the constants above, as fields so a test runs them fast.
	heartbeatEvery time.Duration
	pingTimeout    time.Duration
	factsEvery     time.Duration
	factsMinGap    time.Duration
	backoffs       []time.Duration
```

and set them in `New`'s literal:

```go
		heartbeatEvery: HeartbeatInterval,
		pingTimeout:    PingTimeout,
		factsEvery:     FactsEvery,
		factsMinGap:    FactsMinGap,
		backoffs:       defaultBackoffs,
```

Replace `Run` and `connectOnce` with:

```go
// Run connects, serves, and reconnects with a capped backoff until ctx is done
// or a fatal condition is hit (a changed core key; a revoked device).
func (a *Agent) Run(ctx context.Context) error {
	attempt := 0
	for {
		authed, err := a.connectOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var f fatal
		if errors.As(err, &f) {
			a.logf("fatal: %v — not reconnecting", f.err)
			return f.err
		}
		if err != nil {
			a.logf("connection ended: %v", err)
		}
		if authed {
			// A session that authenticated proves the path works, so the next
			// wait starts from the shortest step again. Before S42a the ladder
			// never reset, and after five drops every reconnect waited 30 s for
			// the life of the process.
			attempt = 0
		}
		d := a.backoffs[min(attempt, len(a.backoffs)-1)]
		attempt++
		a.logf("reconnecting in %s", d)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
		}
	}
}

// connectOnce dials, authenticates and serves one session. It reports whether
// the session authenticated (Run's backoff reset reads it), and why it ended.
func (a *Agent) connectOnce(ctx context.Context) (bool, error) {
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	c, _, err := websocket.Dial(dialCtx, a.wsURL, nil)
	cancel()
	if err != nil {
		return false, fmt.Errorf("dial %s: %w", a.wsURL, err)
	}
	defer c.CloseNow()
	c.SetReadLimit(wsReadLimit)

	if err := a.handshake(ctx, c); err != nil {
		return false, err
	}
	a.logf("authenticated; serving")
	return true, a.serve(ctx, c)
}
```

In `serve`, change `go a.heartbeat(serveCtx, c)` to `go a.heartbeat(serveCtx, cancel, c)`.

Replace `heartbeat` with:

```go
// heartbeat keeps the session honest in both directions, once per tick:
//
//   - a wall-clock gap between ticks wider than two intervals means this
//     machine slept. The ticker runs on the monotonic clock, which stops
//     while the machine sleeps on Linux, macOS and Windows; the wall clock
//     does not. The socket is presumed dead, so the session ends;
//   - the heartbeat frame (core stamps last_seen from it);
//   - a ping core must answer within pingTimeout;
//   - the facts frame, when the facts changed or it is due.
//
// Any failure ends the session through cancel: serve returns, and Run
// reconnects from the first step of the ladder.
func (a *Agent) heartbeat(ctx context.Context, cancel context.CancelFunc, c *websocket.Conn) {
	ticker := time.NewTicker(a.heartbeatEvery)
	defer ticker.Stop()
	last := a.now().Round(0)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		now := a.now().Round(0) // Round(0) drops the monotonic reading: wall clock only
		if gap := now.Sub(last); gap > 2*a.heartbeatEvery {
			a.logf("the clock jumped %s between heartbeats — this machine slept; reconnecting", gap.Round(time.Second))
			cancel()
			return
		}
		last = now
		if err := writeFrame(ctx, c, wire.Heartbeat{Type: wire.TypeHeartbeat, Ts: now.Unix()}); err != nil {
			if ctx.Err() == nil {
				a.logf("heartbeat write failed: %v — reconnecting", err)
				cancel()
			}
			return
		}
		pingCtx, pingCancel := context.WithTimeout(ctx, a.pingTimeout)
		err := c.Ping(pingCtx)
		pingCancel()
		if err != nil {
			if ctx.Err() == nil {
				a.logf("core did not answer a ping within %s: %v — reconnecting", a.pingTimeout, err)
				cancel()
			}
			return
		}
		a.maybeSendFacts(ctx, c)
	}
}

// maybeSendFacts writes a facts frame when the facts changed and the last
// frame is at least factsMinGap old, or when factsEvery has passed anyway.
func (a *Agent) maybeSendFacts(ctx context.Context, c *websocket.Conn) {
	a.factsMu.Lock()
	last, lastAt := a.lastFacts, a.lastFactsAt
	a.factsMu.Unlock()
	since := a.now().Sub(lastAt)
	if since < a.factsMinGap {
		return
	}
	data, err := a.frameBytes()
	if err != nil {
		a.logf("facts frame not built: %v", err)
		return
	}
	if since < a.factsEvery && bytes.Equal(data, last) {
		return
	}
	if err := a.writeFacts(ctx, c, data); err != nil && ctx.Err() == nil {
		a.logf("facts frame not sent: %v", err)
	}
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -8
~/.local/bin/mise x -- go test -race -count=3 ./internal/client/ 2>&1 | tail -3
```

Expected: all pass, and they pass three times over. Time-based tests must not flake; if one does, widen its bound and say why in its comment, never retry-until-green.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add apps/novad/internal/client/client.go apps/novad/internal/client/integration_test.go
git -C $W commit -m "fix(novad): the backoff resets, a ping proves the path, and a machine that slept reconnects at once"
git -C $W show --stat HEAD | tail -6
```

---

## Task 9: a revoked device is final — the agent wipes its identity and stops

**Files:**
- Modify: `apps/novad/internal/client/client.go`: `handshake`'s `auth_error` case (lines 203-209) and a new `ErrRevoked`.
- Modify: `apps/novad/main.go`: `cmdRun` (lines 170-203), plus `exitConfig` and `afterRun`.
- Modify: `apps/novad/novad.service`.
- Test: append to `integration_test.go` and `main_test.go`.

**Interfaces:**
- Consumes: `wire.ReasonRevoked`, `config.Wipe`.
- Produces: `var client.ErrRevoked`, `main.exitConfig = 78`, and `func afterRun(paths config.Paths, err error, now time.Time) (int, string)`.

- [ ] **Step 1: Write the failing tests**

Append to `integration_test.go`:

```go
func refusingCore(t *testing.T, corePub, devPub ed25519.PublicKey, reason string) (*httptest.Server, func() int) {
	t.Helper()
	var mu sync.Mutex
	n := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		mu.Lock()
		n++
		mu.Unlock()
		nonce := make([]byte, 32)
		_, _ = rand.Read(nonce)
		_ = coreWrite(r.Context(), c, map[string]any{"type": "challenge", "nonce": hex.EncodeToString(nonce), "core_pubkey": hex.EncodeToString(corePub)})
		if _, err := coreRead(r.Context(), c); err != nil {
			return
		}
		_ = coreWrite(r.Context(), c, map[string]any{"type": "auth_error", "reason": reason})
		_ = c.Close(4401, "auth failed")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, func() int { mu.Lock(); defer mu.Unlock(); return n }
}

func TestARevokedDeviceIsFatalAndRunSaysSo(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	srv, attempts := refusingCore(t, corePub, devPub, "revoked")
	agent, _ := buildAgent(t, srv.URL, "dev-revoked-1", hex.EncodeToString(corePub), devPriv)
	agent.backoffs = []time.Duration{20 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := agent.Run(ctx)
	if !errors.Is(err, ErrRevoked) {
		t.Fatalf("Run = %v, want ErrRevoked", err)
	}
	if attempts() != 1 {
		t.Fatalf("a revoke is final: %d connection attempts", attempts())
	}
}

// Any other refusal (a restored database that forgot the device, a transient
// core fault) is retried — only the exact reason "revoked" wipes anything.
func TestAnyOtherAuthErrorIsRetried(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	srv, attempts := refusingCore(t, corePub, devPub, "no such device — it was never paired here, or its record is gone")
	agent, _ := buildAgent(t, srv.URL, "dev-unknown-1", hex.EncodeToString(corePub), devPriv)
	agent.backoffs = []time.Duration{20 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() { _ = agent.Run(ctx) }()
	waitFor(t, 2*time.Second, func() bool { return attempts() >= 3 })
}
```

Add `"errors"` to the imports if it is missing.

Append to `main_test.go` (add imports `errors`, `os`, `path/filepath`, `time`, `novad/internal/client` and `novad/internal/config`):

```go
func TestAfterRunWipesARevokedDeviceAndExits78(t *testing.T) {
	home := t.TempDir()
	p := config.Paths{
		ConfigDir: filepath.Join(home, "c"), StateDir: filepath.Join(home, "s"),
		ConfigFile: filepath.Join(home, "c", "config.json"), KeyFile: filepath.Join(home, "c", "key"),
		AuditFile: filepath.Join(home, "s", "audit.jsonl"), Home: home,
	}
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := config.Save(p, config.Config{DeviceID: "d"}, priv); err != nil {
		t.Fatal(err)
	}
	code, msg := afterRun(p, client.ErrRevoked, time.Unix(1790000000, 0))
	if code != 78 || !strings.Contains(msg, "revoked") || p.Enrolled() {
		t.Fatalf("code=%d enrolled=%v %q", code, p.Enrolled(), msg)
	}
	if code, _ := afterRun(p, errors.New("boom"), time.Now()); code != 1 {
		t.Fatalf("any other failure exits 1, got %d", code)
	}
	if code, msg := afterRun(p, nil, time.Now()); code != 0 || msg != "" {
		t.Fatalf("nil is a clean exit, got %d %q", code, msg)
	}
}

// Review focus 5: systemd must not restart a daemon that can never get in.
func TestTheServiceUnitDoesNotRestartARevokedDevice(t *testing.T) {
	body, err := os.ReadFile("novad.service")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "RestartPreventExitStatus=78") {
		t.Fatal("novad.service must carry RestartPreventExitStatus=78 (exitConfig)")
	}
}
```

Also add `"crypto/ed25519"` and `"crypto/rand"` to `main_test.go`'s imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/novad && ~/.local/bin/mise x -- go test . ./internal/client/ -run 'Revoked|OtherAuthError|AfterRun|ServiceUnit' -v`
Expected: FAIL: `undefined: ErrRevoked`, `undefined: afterRun`.

- [ ] **Step 3: Write the implementation**

In `client.go`, after the `fatal` type, add:

```go
// ErrRevoked is Run's return when core says this device was revoked — the one
// refusal that is final. The caller wipes the identity (config.Wipe) and
// exits 78 so no supervisor restarts a daemon that can never get in.
var ErrRevoked = errors.New("core says this device was revoked")
```

Replace the `case wire.TypeAuthError:` block in `handshake` with:

```go
	case wire.TypeAuthError:
		reason, _ := reply["reason"].(string)
		if reason == wire.ReasonRevoked {
			return fatal{ErrRevoked}
		}
		// Any other refusal is retried: a transient core-side fault heals on
		// the next attempt, and a restored database that forgot this device is
		// re-enrolled by hand (s45 move runbook) — never wiped from here.
		return fmt.Errorf("core refused auth: %s", reason)
```

Update the package comment's last sentence to: "a changed core key and a revoked device are the fatal conditions".

In `main.go`:
- Add the imports `"errors"` (if missing) and `"time"`.
- Add:

```go
// exitConfig (EX_CONFIG, 78) is the exit status for "this daemon has no
// identity to run as" — never enrolled, or revoked and wiped. novad.service
// names it in RestartPreventExitStatus, so systemd stops instead of restarting
// a daemon that can never get in.
const exitConfig = 78

// afterRun turns Run's return into the exit status and the line to print. A
// revoke wipes the identity FIRST, so the status says what is true on disk.
func afterRun(paths config.Paths, err error, now time.Time) (int, string) {
	switch {
	case err == nil:
		return 0, ""
	case errors.Is(err, client.ErrRevoked):
		if werr := config.Wipe(paths, now); werr != nil {
			return 1, fmt.Sprintf("this device was revoked in Nova, and wiping its identity failed: %v — delete %s and %s by hand",
				werr, paths.ConfigFile, paths.KeyFile)
		}
		return exitConfig, "this device was revoked in Nova — its identity is wiped (config and key removed, " +
			"the audit log set aside). Pair it again with `novad enroll`."
	default:
		return 1, fmt.Sprintf("run stopped: %v", err)
	}
}
```

- In `cmdRun`, directly after `DefaultPaths` succeeds, add:

```go
	if !paths.Enrolled() {
		fmt.Fprintf(os.Stderr, "novad: not enrolled — run `novad enroll` first (config dir: %s)\n", paths.ConfigDir)
		os.Exit(exitConfig)
	}
```

and replace the tail:

```go
	logger.Printf("device %s connecting to %s", cfg.DeviceID, cfg.Server)
	if err := agent.Run(ctx); err != nil && ctx.Err() == nil {
		fail("run stopped: %v", err)
	}
	logger.Printf("stopped")
```

with:

```go
	logger.Printf("device %s connecting to %s", cfg.DeviceID, cfg.Server)
	runErr := agent.Run(ctx)
	if ctx.Err() != nil {
		logger.Printf("stopped")
		return
	}
	code, msg := afterRun(paths, runErr, time.Now())
	if msg != "" {
		fmt.Fprintf(os.Stderr, "novad: %s\n", msg)
	}
	os.Exit(code)
```

In `apps/novad/novad.service`, under `RestartSec=5`, add:

```ini
# 78 (EX_CONFIG) = not enrolled, or revoked and wiped: restarting cannot help.
RestartPreventExitStatus=78
```

- [ ] **Step 4: Run the tests and the six builds**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/novad
~/.local/bin/mise x -- go test -race ./... 2>&1 | tail -8
for t in linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do GOOS=${t%/*} GOARCH=${t#*/} CGO_ENABLED=0 ~/.local/bin/mise x -- go vet ./... && echo "vet ok $t"; done
```

Expected: all pass, followed by five `vet ok` lines.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add apps/novad/internal/client/client.go apps/novad/internal/client/integration_test.go apps/novad/main.go apps/novad/main_test.go apps/novad/novad.service
git -C $W commit -m "feat(novad): a revoked device wipes its identity and stops — exit 78, never a restart loop"
git -C $W show --stat HEAD | tail -8
```

---

## Task 10: core migration `036_agent_facts`

**Files:**
- Create: `services/core/migrations/036_agent_facts.sql`, `services/core/tests/test_migration_036_agent_facts.py`.

**Interfaces:**
- Produces:
  - Columns `devices.facts jsonb` and `devices.facts_at timestamptz`.
  - Constraints `devices_platform CHECK (platform IN ('linux','darwin','windows','unknown'))` and `devices_facts_dated`.
  - Index `devices_machine_uid ON devices ((facts->>'machine_uid')) WHERE revoked_at IS NULL`.

- [ ] **Step 1: Check the number is still free**

```bash
ls /home/jeremy/workspace/nova/.worktrees/s42a/services/core/migrations/ | tail -3
git -C /home/jeremy/workspace/nova fetch -q origin && git -C /home/jeremy/workspace/nova log --oneline origin/main -- 'services/core/migrations/036*' | head
```

Expected: the last file is `035_hub_engine.sql`, and no `036*` exists on `origin/main`. If another lane took 036, take the next free number, rename every reference in this plan, and say so in the commit.

- [ ] **Step 2: Write the failing test**

`services/core/tests/test_migration_036_agent_facts.py`:

```python
"""Core migration 036 (S42a): devices.platform gets the CHECK it never had,
and devices gain the facts their agent reports — a dated pair — plus the
machine_uid index the duplicate-agent check reads."""

from __future__ import annotations

import asyncpg
import pytest

from app.main import MIGRATIONS_DIR
from tests.conftest import requires_db

pytestmark = requires_db

MIGRATION = MIGRATIONS_DIR / "036_agent_facts.sql"
PUBKEY = "ab" * 32


async def _device(pool, name: str, platform: str = "linux"):
    return await pool.fetchval(
        "INSERT INTO devices (name, platform, hostname, pubkey) VALUES ($1, $2, 'h', $3) "
        "RETURNING id",
        name,
        platform,
        PUBKEY,
    )


async def test_the_runner_applies_it(pool):
    names = {r["filename"] for r in await pool.fetch("SELECT filename FROM schema_migrations")}
    assert "036_agent_facts.sql" in names


async def test_a_platform_outside_the_four_becomes_unknown_and_the_check_holds(pool):
    # Stand where a pre-036 database stood: no CHECK, a free-text platform.
    await pool.execute("ALTER TABLE devices DROP CONSTRAINT devices_platform")
    old = await _device(pool, "old-box", "FreeBSD")
    await pool.execute(MIGRATION.read_text())
    assert await pool.fetchval("SELECT platform FROM devices WHERE id = $1", old) == "unknown"
    with pytest.raises(asyncpg.CheckViolationError):
        await _device(pool, "new-box", "freebsd")
    for platform in ("linux", "darwin", "windows", "unknown"):
        await _device(pool, f"box-{platform}", platform)


async def test_facts_are_a_dated_pair(pool):
    device = await _device(pool, "pair")
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute("UPDATE devices SET facts = '{}'::jsonb WHERE id = $1", device)
    await pool.execute(
        "UPDATE devices SET facts = $2, facts_at = now() WHERE id = $1", device, {"v": 2}
    )
    assert await pool.fetchval("SELECT facts FROM devices WHERE id = $1", device) == {"v": 2}


async def test_the_machine_uid_index_exists(pool):
    found = await pool.fetchval(
        "SELECT indexdef FROM pg_indexes WHERE tablename = 'devices' "
        "AND indexname = 'devices_machine_uid'"
    )
    assert found is not None and "machine_uid" in found and "revoked_at IS NULL" in found


async def test_applied_twice_it_changes_nothing_more(pool):
    device = await _device(pool, "twice", "windows")
    sql = MIGRATION.read_text()
    await pool.execute(sql)
    await pool.execute(sql)
    assert await pool.fetchval("SELECT platform FROM devices WHERE id = $1", device) == "windows"
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/services/core
PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
export TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42a
uv run pytest -q tests/test_migration_036_agent_facts.py
```

Expected: FAIL. `036_agent_facts.sql` does not exist, so `MIGRATION.read_text()` raises `FileNotFoundError` and `test_the_runner_applies_it` fails.

- [ ] **Step 4: Write the migration**

`services/core/migrations/036_agent_facts.sql`:

```sql
-- S42a (the hub lane): Nova's agent runs on Linux, macOS and Windows, and
-- reports facts about its machine.
--
-- devices.platform gets the CHECK it never had. Enroll stored free text until
-- now (devices.py) and every agent sent the literal "linux", so a value
-- outside the four becomes 'unknown' FIRST — or adding the CHECK would fail
-- on it. From S42a, enroll refuses anything but linux|darwin|windows
-- (device_facts.PLATFORMS); 'unknown' is only ever what this migration
-- writes.
--
-- facts / facts_at hold what the agent last said about its machine;
-- device_facts.validate_auth / validate_frame keep only what core
-- understands. A dated pair, like the gateway's engine facts
-- (009_engines.sql): both NULL until an agent first reports, both set after.
-- No ROLE is stored — roles are derived on every read (device_facts), so a
-- stored one can never outlive the fact it came from — and no capabilities
-- column exists (test_no_approvals.py pins that).
--
-- The machine_uid index serves the duplicate-agent check: two live agents
-- reporting one machine (app/checks/devices.py).
--
-- Re-runnable: every statement is idempotent, because its test re-executes it
-- on a migrated database.
UPDATE devices SET platform = 'unknown'
 WHERE platform NOT IN ('linux', 'darwin', 'windows', 'unknown');

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_platform;
ALTER TABLE devices ADD CONSTRAINT devices_platform
    CHECK (platform IN ('linux', 'darwin', 'windows', 'unknown'));

ALTER TABLE devices ADD COLUMN IF NOT EXISTS facts jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS facts_at timestamptz;

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_facts_dated;
ALTER TABLE devices ADD CONSTRAINT devices_facts_dated
    CHECK ((facts IS NULL) = (facts_at IS NULL));

CREATE INDEX IF NOT EXISTS devices_machine_uid
    ON devices ((facts->>'machine_uid'))
 WHERE revoked_at IS NULL;
```

- [ ] **Step 5: Run the test and the schema pin**

```bash
uv run pytest -q tests/test_migration_036_agent_facts.py tests/test_no_approvals.py
```

Expected: PASS. `test_no_approvals`'s schema test stays green: no `capabilities` column.

- [ ] **Step 6: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add services/core/migrations/036_agent_facts.sql services/core/tests/test_migration_036_agent_facts.py
git -C $W commit -m "feat(core): migration 036 — a platform CHECK, and the facts a device's agent reports"
git -C $W show --stat HEAD | tail -4
```

---

## Task 11: `device_facts.py` — validation, roles, the one agent view

**Files:**
- Create: `services/core/app/device_facts.py`, `services/core/tests/test_device_facts.py`.

**Interfaces:**
- Produces (Tasks 12–17 use exactly these):
  - Constants: `PLATFORMS = ("linux", "darwin", "windows")`, `STORED_PLATFORMS`, `AUTH_FACTS_MAX_BYTES = 4096`, `FRAME_MAX_BYTES = 16384`, `FACTS_VERSION = 2`, `AGENT_MODES`, `FRAME_SECTIONS`, `WSL_REASON`.
  - `class FactsRejected(ValueError)` with `.reason`.
  - `validate_auth(raw: object) -> dict` and `validate_frame(raw: object) -> dict` (sections only).
  - Readers: `in_wsl(facts) -> str | None`, `machine_uid(facts) -> str | None`, `os_label(facts) -> str | None`, `agent_version(facts) -> str | None`.
  - `derive_roles(*, platform, facts, facts_at, connected, last_seen) -> dict[str, dict]`: keys `hands` and `facts`, each `{"state": "available"|"cannot"|"unknown", "reason": str}`.
  - `agent_view(*, name, platform, hostname, connected, last_seen, facts, facts_at) -> dict`: keys `name`, `platform`, `hostname`, `connected`, `last_seen`, `facts_at`, `os`, `wsl`, `agent_version`, `machine`, `roles`.

- [ ] **Step 1: Write the failing tests**

`services/core/tests/test_device_facts.py`:

```python
"""device_facts (S42a): what an agent says about its machine, checked, and
the roles derived from it. Pure — no database — so this is the fast corpus
that pins the shapes both sides of the wire agree on."""

from __future__ import annotations

import copy
from datetime import UTC, datetime

import pytest

from app import device_facts as df

AT = datetime(2026, 9, 26, 10, 0, tzinfo=UTC)

WINDOWS = {
    "v": 2,
    "agent": {"version": "0.2.0", "mode": "foreground", "session_interactive": True},
    "os": {"goos": "windows", "arch": "amd64", "version": "Windows 11 Pro 24H2 (build 26100)", "wsl": None},
    "hostname": "PC-ONE",
    "machine_uid": "a" * 64,
}
WSL = {
    "v": 2,
    "agent": {"version": "0.2.0", "mode": "systemd-user", "session_interactive": False},
    "os": {"goos": "linux", "arch": "amd64", "version": "Ubuntu 26.04 LTS", "wsl": {"distro": "Ubuntu-26.04"}},
    "hostname": "PC-ONE",
    "machine_uid": "b" * 64,
}


def _with(base: dict, path: str, value) -> dict:
    out = copy.deepcopy(base)
    node = out
    *heads, last = path.split(".")
    for head in heads:
        node = node[head]
    node[last] = value
    return out


def test_valid_auth_facts_are_kept_in_their_shape():
    assert df.validate_auth(WINDOWS) == WINDOWS
    assert df.validate_auth(WSL) == WSL


def test_unknown_keys_are_dropped_never_stored():
    assert df.validate_auth({**WINDOWS, "build": "abc", "extra": 1}) == WINDOWS


@pytest.mark.parametrize(
    "facts,reason",
    [
        ({**WINDOWS, "pad": "x" * 5000}, "over the 4096-byte cap"),
        (_with(WINDOWS, "v", 1), "version"),
        (_with(WINDOWS, "agent.mode", "daemon"), "mode"),
        (_with(WINDOWS, "agent.session_interactive", "yes"), "session_interactive"),
        (_with(WINDOWS, "os.goos", "freebsd"), "goos"),
        (_with(WINDOWS, "os.wsl", {"distro": "Ubuntu"}), "only possible on linux"),
        (_with(WINDOWS, "machine_uid", "ABC"), "machine_uid"),
        (_with(WINDOWS, "hostname", "h" * 256), "longer than 255"),
        ("not an object", "must be an object"),
    ],
)
def test_facts_an_agent_could_not_send_are_refused_with_the_reason(facts, reason):
    with pytest.raises(df.FactsRejected) as exc:
        df.validate_auth(facts)
    assert reason in exc.value.reason


def test_an_empty_machine_uid_is_unknown_not_refused():
    assert df.validate_auth(_with(WINDOWS, "machine_uid", ""))["machine_uid"] == ""
    assert df.machine_uid(_with(WINDOWS, "machine_uid", "")) is None


def test_a_frame_keeps_its_known_sections_and_drops_the_rest():
    frame = {
        "type": "facts",
        "net": {"ifaces": [{"name": "wlp2s0", "mac": "AA:BB:CC:DD:EE:FF", "ipv4_cidr": ["192.168.0.245/24"], "up": True}]},
        "unreadable": [{"item": "machine_uid", "reason": "no id"}],
        "power": {"womp": True},
    }
    assert df.validate_frame(frame) == {
        "net": {"ifaces": [{"name": "wlp2s0", "mac": "aa:bb:cc:dd:ee:ff", "ipv4_cidr": ["192.168.0.245/24"], "up": True}]},
        "unreadable": [{"item": "machine_uid", "reason": "no id"}],
    }


@pytest.mark.parametrize(
    "frame,reason",
    [
        ({"type": "facts"}, "carries none of"),
        ({"type": "facts", "net": {"ifaces": "x"}}, "must be a list"),
        ({"type": "facts", "net": {"ifaces": [{"name": "e", "mac": "zz", "ipv4_cidr": [], "up": True}]}}, "hardware address"),
        ({"type": "facts", "net": {"ifaces": [{"name": "e", "mac": "", "ipv4_cidr": ["300.1.1.1/24"], "up": True}]}}, "not an IPv4"),
        ({"type": "facts", "unreadable": [{"item": "x"}] * 33}, "more than 32"),
        ({"type": "facts", "unreadable": [], "pad": "x" * 17000}, "over the 16384-byte cap"),
    ],
)
def test_a_frame_that_does_not_fit_is_refused_with_the_reason(frame, reason):
    with pytest.raises(df.FactsRejected) as exc:
        df.validate_frame(frame)
    assert reason in exc.value.reason


def _roles(**kw) -> dict:
    base = {"platform": "windows", "facts": WINDOWS, "facts_at": AT, "connected": True, "last_seen": AT}
    base.update(kw)
    return df.derive_roles(**base)


def test_a_connected_native_agent_has_its_hands_and_its_facts():
    roles = _roles()
    assert roles["hands"] == {"state": "available", "reason": "connected now"}
    assert roles["facts"]["state"] == "available" and AT.isoformat() in roles["facts"]["reason"]


def test_every_role_on_an_agent_inside_wsl_says_the_windows_agent_owns_it():
    roles = _roles(platform="linux", facts=WSL)
    assert roles["hands"] == {"state": "cannot", "reason": df.WSL_REASON}
    assert roles["facts"] == {"state": "cannot", "reason": df.WSL_REASON}
    assert df.WSL_REASON == "cannot: this machine's Windows agent owns it"


# Review focus 1: the Dell's WSL agent on the day S42a deploys is exactly this.
def test_an_agent_without_facts_keeps_its_hands_and_says_why_facts_are_unknown():
    roles = _roles(platform="linux", facts=None, facts_at=None)
    assert roles["hands"]["state"] == "available"
    assert roles["facts"]["state"] == "unknown" and "predates S42a" in roles["facts"]["reason"]


def test_an_offline_agent_cannot_use_its_hands_and_says_when_it_was_seen():
    roles = _roles(connected=False)
    assert roles["hands"]["state"] == "cannot"
    assert roles["hands"]["reason"] == f"cannot: not connected (last seen {AT.isoformat()})"
    assert _roles(connected=False, last_seen=None)["hands"]["reason"] == "cannot: not connected (last seen never)"


def test_an_unknown_platform_cannot_use_its_hands():
    assert _roles(platform="unknown", facts=None, facts_at=None)["hands"]["state"] == "cannot"


def test_agent_view_is_the_one_shape():
    view = df.agent_view(
        name="PC-ONE", platform="windows", hostname="PC-ONE", connected=True,
        last_seen=AT, facts=WINDOWS, facts_at=AT,
    )
    assert set(view) == {
        "name", "platform", "hostname", "connected", "last_seen", "facts_at",
        "os", "wsl", "agent_version", "machine", "roles",
    }
    assert view["os"] == "Windows 11 Pro 24H2 (build 26100)"
    assert view["wsl"] is None and view["machine"] == "a" * 64 and view["agent_version"] == "0.2.0"
    wsl_view = df.agent_view(
        name="pc-wsl", platform="linux", hostname="PC-ONE", connected=True,
        last_seen=AT, facts=WSL, facts_at=AT,
    )
    assert wsl_view["wsl"] == "Ubuntu-26.04"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest -q tests/test_device_facts.py`
Expected: FAIL with `ImportError: cannot import name 'device_facts'`.

- [ ] **Step 3: Write the implementation**

`services/core/app/device_facts.py`:

```python
"""What a paired machine's agent says about itself, checked — and what core
derives from it (S42a).

An agent reports RAW facts in two frames on the socket core authenticated:
a small block inside the auth frame (≤4 KiB, recorded only after the
signature verifies) and a larger `facts` frame (≤16 KiB, sent after ready,
on a change, every ten minutes and on facts.refresh). This module is core's
one reader of them:

  * validate_auth / validate_frame keep what this core understands, in the
    shape it understands, and refuse anything else by raising FactsRejected
    with the reason. A refusal never refuses the SOCKET — an agent that
    describes itself badly is still the device its key proves — so the
    caller logs it and records nothing.
  * derive_roles turns facts into ROLES: what the machine's agent is
    available for now, each with its reason. A role is AVAILABILITY, never
    permission (hub decision D2): no tool reads a role to refuse a call, and
    nothing here is stored — it is derived on every read, so it cannot go
    stale behind a fact that changed.
  * agent_view is the one shape the plant, machine_status and an eval
    fixture share.

Facts are not signed. They ride the authenticated socket over TLS or
WireGuard, exactly as a result frame does (r2-integration D11).
"""

from __future__ import annotations

import ipaddress
import json
import re
from datetime import datetime

# What an agent may say it runs: Go's runtime.GOOS for the three builds.
PLATFORMS: tuple[str, ...] = ("linux", "darwin", "windows")
# What devices.platform may hold (migration 036's CHECK): the three, plus
# 'unknown' for a row enrolled before S42a with something else in it.
STORED_PLATFORMS: tuple[str, ...] = (*PLATFORMS, "unknown")

AUTH_FACTS_MAX_BYTES = 4096
FRAME_MAX_BYTES = 16 * 1024
FACTS_VERSION = 2
AGENT_MODES: tuple[str, ...] = ("systemd-user", "launch-agent", "run-key", "foreground")
# The sections a facts frame may carry. A later slice adds its own (power,
# ollama, compute, hold, overlay) HERE, beside its validator.
FRAME_SECTIONS: tuple[str, ...] = ("net", "unreadable")

# Every role on an agent inside WSL (r2-integration S42a; the in-WSL agent is
# retired for the Windows one, which reaches WSL through wsl.exe).
WSL_REASON = "cannot: this machine's Windows agent owns it"

_UID = re.compile(r"^[0-9a-f]{64}$")
_MAC = re.compile(r"^(?:[0-9a-f]{2}(?::[0-9a-f]{2}){0,19})?$")
_MAX_TEXT = 255
_MAX_IFACES = 32
_MAX_ADDRS = 8
_MAX_UNREADABLE = 32


class FactsRejected(ValueError):
    """Facts this core will not record, with the reason in words."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _encoded_size(raw: object) -> int:
    return len(json.dumps(raw, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def _object(value: object, where: str) -> dict:
    if not isinstance(value, dict):
        raise FactsRejected(f"{where} must be an object, got {type(value).__name__}")
    return value


def _text(value: object, where: str) -> str:
    if not isinstance(value, str):
        raise FactsRejected(f"{where} must be text, got {type(value).__name__}")
    if len(value) > _MAX_TEXT:
        raise FactsRejected(f"{where} is longer than {_MAX_TEXT} characters")
    return value


def _bool(value: object, where: str) -> bool:
    if not isinstance(value, bool):
        raise FactsRejected(f"{where} must be true or false")
    return value


def validate_auth(raw: object) -> dict:
    """The auth-frame facts as core records them, or FactsRejected.

    Shape (r2-integration, the auth frame): {v: 2, agent: {version, mode,
    session_interactive}, os: {goos, arch, version, wsl: null | {distro}},
    hostname, machine_uid}. The size cap applies to what was SENT; keys
    outside the shape are dropped, not stored."""
    facts = _object(raw, "facts")
    size = _encoded_size(facts)
    if size > AUTH_FACTS_MAX_BYTES:
        raise FactsRejected(
            f"auth-frame facts are {size} bytes, over the {AUTH_FACTS_MAX_BYTES}-byte cap"
        )
    if facts.get("v") != FACTS_VERSION:
        raise FactsRejected(f"facts version {facts.get('v')!r} is not {FACTS_VERSION}")
    agent = _object(facts.get("agent"), "facts.agent")
    mode = _text(agent.get("mode"), "facts.agent.mode")
    if mode not in AGENT_MODES:
        raise FactsRejected(f"facts.agent.mode {mode!r} is not one of {', '.join(AGENT_MODES)}")
    os_ = _object(facts.get("os"), "facts.os")
    goos = _text(os_.get("goos"), "facts.os.goos")
    if goos not in PLATFORMS:
        raise FactsRejected(f"facts.os.goos {goos!r} is not one of {', '.join(PLATFORMS)}")
    wsl: dict | None = None
    if os_.get("wsl") is not None:
        if goos != "linux":
            raise FactsRejected("facts.os.wsl is only possible on linux")
        distro = _object(os_["wsl"], "facts.os.wsl").get("distro", "")
        wsl = {"distro": _text(distro, "facts.os.wsl.distro")}
    uid = _text(facts.get("machine_uid", ""), "facts.machine_uid")
    if uid and not _UID.match(uid):
        raise FactsRejected("facts.machine_uid must be 64 lowercase hex characters, or empty")
    return {
        "v": FACTS_VERSION,
        "agent": {
            "version": _text(agent.get("version"), "facts.agent.version"),
            "mode": mode,
            "session_interactive": _bool(
                agent.get("session_interactive"), "facts.agent.session_interactive"
            ),
        },
        "os": {
            "goos": goos,
            "arch": _text(os_.get("arch"), "facts.os.arch"),
            "version": _text(os_.get("version"), "facts.os.version"),
            "wsl": wsl,
        },
        "hostname": _text(facts.get("hostname"), "facts.hostname"),
        "machine_uid": uid,
    }


def _cidr(value: object, where: str) -> str:
    text = _text(value, where)
    try:
        iface = ipaddress.ip_interface(text)
    except ValueError as exc:
        raise FactsRejected(f"{where} {text!r} is not an IPv4 address/prefix") from exc
    if iface.version != 4:
        raise FactsRejected(f"{where} {text!r} is not an IPv4 address/prefix")
    return str(iface)


def _net(raw: object) -> dict:
    net = _object(raw, "facts.net")
    ifaces_raw = net.get("ifaces")
    if not isinstance(ifaces_raw, list):
        raise FactsRejected("facts.net.ifaces must be a list")
    if len(ifaces_raw) > _MAX_IFACES:
        raise FactsRejected(f"facts.net.ifaces lists more than {_MAX_IFACES} interfaces")
    ifaces = []
    for index, item in enumerate(ifaces_raw):
        where = f"facts.net.ifaces[{index}]"
        iface = _object(item, where)
        mac = _text(iface.get("mac", ""), f"{where}.mac").lower()
        if not _MAC.match(mac):
            raise FactsRejected(f"{where}.mac {mac!r} is not a hardware address")
        cidrs = iface.get("ipv4_cidr", [])
        if not isinstance(cidrs, list) or len(cidrs) > _MAX_ADDRS:
            raise FactsRejected(f"{where}.ipv4_cidr must be a list of at most {_MAX_ADDRS}")
        ifaces.append(
            {
                "name": _text(iface.get("name"), f"{where}.name"),
                "mac": mac,
                "ipv4_cidr": [_cidr(c, f"{where}.ipv4_cidr") for c in cidrs],
                "up": _bool(iface.get("up"), f"{where}.up"),
            }
        )
    return {"ifaces": ifaces}


def _unreadable(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        raise FactsRejected("facts.unreadable must be a list")
    if len(raw) > _MAX_UNREADABLE:
        raise FactsRejected(f"facts.unreadable lists more than {_MAX_UNREADABLE} items")
    out = []
    for index, item in enumerate(raw):
        where = f"facts.unreadable[{index}]"
        entry = _object(item, where)
        out.append(
            {
                "item": _text(entry.get("item"), f"{where}.item"),
                "reason": _text(entry.get("reason", ""), f"{where}.reason"),
            }
        )
    return out


def validate_frame(raw: object) -> dict:
    """The SECTIONS of a facts frame, as core merges them into devices.facts,
    or FactsRejected. `type` is the frame's, not a fact, and is not returned;
    a section this core does not know is dropped."""
    frame = _object(raw, "the facts frame")
    size = _encoded_size(frame)
    if size > FRAME_MAX_BYTES:
        raise FactsRejected(f"the facts frame is {size} bytes, over the {FRAME_MAX_BYTES}-byte cap")
    out: dict = {}
    if "net" in frame:
        out["net"] = _net(frame["net"])
    if "unreadable" in frame:
        out["unreadable"] = _unreadable(frame["unreadable"])
    if not out:
        raise FactsRejected(f"the facts frame carries none of {', '.join(FRAME_SECTIONS)}")
    return out


# -- readers ---------------------------------------------------------------


def in_wsl(facts: dict | None) -> str | None:
    """The WSL distribution this agent runs inside ("" when unnamed), or None
    when it does not run inside WSL — or never said."""
    if not isinstance(facts, dict):
        return None
    wsl = (facts.get("os") or {}).get("wsl")
    if not isinstance(wsl, dict):
        return None
    distro = wsl.get("distro")
    return distro if isinstance(distro, str) else ""


def machine_uid(facts: dict | None) -> str | None:
    uid = facts.get("machine_uid") if isinstance(facts, dict) else None
    return uid if isinstance(uid, str) and _UID.match(uid) else None


def os_label(facts: dict | None) -> str | None:
    version = (facts.get("os") or {}).get("version") if isinstance(facts, dict) else None
    return version if isinstance(version, str) and version else None


def agent_version(facts: dict | None) -> str | None:
    version = (facts.get("agent") or {}).get("version") if isinstance(facts, dict) else None
    return version if isinstance(version, str) and version else None


# -- roles -----------------------------------------------------------------


def derive_roles(
    *,
    platform: str,
    facts: dict | None,
    facts_at: datetime | None,
    connected: bool,
    last_seen: datetime | None,
) -> dict[str, dict]:
    """The roles S42a speaks to — hands and facts — each {state, reason}.

    state is `available`, `cannot` or `unknown`. An agent that predates S42a
    sends no facts and still HAS its hands (the Dell's WSL agent on deploy
    day is exactly that); only its facts are unknown. Later slices add
    models, relay and hold beside these, each from its own facts."""
    wsl = in_wsl(facts)
    if wsl is not None:
        hands = {"state": "cannot", "reason": WSL_REASON}
    elif platform not in PLATFORMS:
        hands = {
            "state": "cannot",
            "reason": "cannot: platform unknown — this agent did not say which OS it runs",
        }
    elif not connected:
        seen = last_seen.isoformat() if last_seen else "never"
        hands = {"state": "cannot", "reason": f"cannot: not connected (last seen {seen})"}
    else:
        hands = {"state": "available", "reason": "connected now"}
    if facts is None:
        facts_role = {
            "state": "unknown",
            "reason": "this agent sends no facts — it predates S42a; update it",
        }
    elif wsl is not None:
        facts_role = {"state": "cannot", "reason": WSL_REASON}
    else:
        when = facts_at.isoformat() if facts_at else "at an unknown time"
        facts_role = {"state": "available", "reason": f"reported {when}"}
    return {"hands": hands, "facts": facts_role}


def agent_view(
    *,
    name: str,
    platform: str,
    hostname: str,
    connected: bool,
    last_seen: datetime | None,
    facts: dict | None,
    facts_at: datetime | None,
) -> dict:
    """One machine's agent, as the plant, machine_status and an eval fixture
    all see it. `machine` is the agent's machine_uid (None when it said
    none) — what "grouped by machine" groups on."""
    return {
        "name": name,
        "platform": platform,
        "hostname": hostname,
        "connected": connected,
        "last_seen": last_seen.isoformat() if last_seen else None,
        "facts_at": facts_at.isoformat() if facts_at else None,
        "os": os_label(facts),
        "wsl": in_wsl(facts),
        "agent_version": agent_version(facts),
        "machine": machine_uid(facts),
        "roles": derive_roles(
            platform=platform,
            facts=facts,
            facts_at=facts_at,
            connected=connected,
            last_seen=last_seen,
        ),
    }
```

- [ ] **Step 4: Run the tests**

Run: `uv run pytest -q tests/test_device_facts.py && uv run ruff check app/device_facts.py tests/test_device_facts.py && uv run ruff format app/device_facts.py tests/test_device_facts.py`
Expected: PASS and ruff clean. If a parametrize id is too long for ruff's line length, wrap the line.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add services/core/app/device_facts.py services/core/tests/test_device_facts.py
git -C $W commit -m "feat(core): device_facts — validate what an agent says, derive its roles, one agent view"
git -C $W show --stat HEAD | tail -4
```

---

## Task 12: the socket records facts, enroll holds the platform, `revoked` is said

**Files:**
- Modify: `services/core/app/devices.py`: imports, a new `_clean_platform`, `enroll` (line 221), `device_spec` (lines 95-113).
- Modify: `services/core/app/devices_ws.py`: the frame-contract comment (lines 52-67), constants (lines 72-73), `authenticate` (lines 305-319), `_handle_frame` (lines 432-447), and the new `_record_auth_facts` and `_record_facts_frame`.
- Modify: `services/core/app/tools/devices.py`: `device_list`'s line (lines 194-199).
- Modify: `services/core/tests/device_fakes.py`: `FakeDevice.handshake` gains `facts=None`.
- Modify: `services/core/tests/test_devices_ws.py`: `_enroll` gains `platform="linux"`; append tests.
- Modify: `services/core/tests/test_devices.py`: the `device_spec` key pin (lines 353-362); append tests.

**Interfaces:**
- Consumes: `device_facts.PLATFORMS`, `validate_auth`, `validate_frame`, `FactsRejected`, `in_wsl`, `os_label`, `agent_version`.
- Produces:
  - `devices_ws.REVOKED_REASON = "revoked"` and `devices_ws.UNKNOWN_DEVICE_REASON`.
  - `device_spec` gains the keys `os`, `wsl`, `agent_version`, `facts_at`.
  - `devices.enroll` raises `DeviceRefused(status_code=400)` for a platform outside `PLATFORMS`, before the burn.

- [ ] **Step 1: Write the failing tests**

In `test_devices_ws.py`, change `_enroll`'s signature to `async def _enroll(pool, *, name: str = "laptop", platform: str = "linux")` and pass `platform=platform` to `devices.enroll`. Then append:

```python
# -- S42a: facts on the socket ------------------------------------------------

AUTH_FACTS = {
    "v": 2,
    "agent": {"version": "0.2.0", "mode": "foreground", "session_interactive": True},
    "os": {"goos": "windows", "arch": "amd64", "version": "Windows 11 Pro 24H2 (build 26100)", "wsl": None},
    "hostname": "PC-ONE",
    "machine_uid": "c" * 64,
}


async def _facts_of(pool, device_id):
    return await pool.fetchrow("SELECT facts, facts_at FROM devices WHERE id = $1", device_id)


async def _auth_with(pool, device_id, device, facts, *, key=None):
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    challenge = await asyncio.wait_for(conn.next_sent(), 2)
    signer = key or device
    frame = {"type": "auth", "device_id": str(device_id), "sig": signer.sign_nonce(challenge["nonce"])}
    if facts is not None:
        frame["facts"] = facts
    conn.feed(frame)
    reply = await asyncio.wait_for(conn.next_sent(), 2)
    return conn, task, reply


async def test_auth_facts_are_recorded_after_the_signature_verifies(pool):
    device_id, device = await _enroll(pool, name="pc", platform="windows")
    conn, task, reply = await _auth_with(pool, device_id, device, AUTH_FACTS)
    assert reply["type"] == "ready"
    row = await _facts_of(pool, device_id)
    assert row["facts"] == AUTH_FACTS and row["facts_at"] is not None
    await _close(conn, task)


async def test_a_bad_signature_records_no_facts(pool):
    device_id, device = await _enroll(pool, name="pc")
    conn, task, reply = await _auth_with(pool, device_id, device, AUTH_FACTS, key=FakeDevice())
    assert reply["type"] == "auth_error"
    assert (await _facts_of(pool, device_id))["facts"] is None
    await asyncio.wait_for(task, 2)


async def test_facts_that_do_not_validate_never_refuse_the_socket(pool):
    device_id, device = await _enroll(pool, name="pc")
    conn, task, reply = await _auth_with(pool, device_id, device, {"v": 1})
    assert reply["type"] == "ready"
    assert (await _facts_of(pool, device_id))["facts"] is None
    await _close(conn, task)


async def _until(predicate, within: float = 2.0):
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        if await predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not met in time")


async def test_a_facts_frame_merges_and_a_new_connection_replaces(pool):
    device_id, device = await _enroll(pool, name="pc", platform="windows")
    conn, task, _ready = await _auth_with(pool, device_id, device, AUTH_FACTS)
    conn.feed({"type": "facts", "net": {"ifaces": []}, "unreadable": [{"item": "x", "reason": "y"}]})

    async def merged():
        facts = (await _facts_of(pool, device_id))["facts"]
        return facts is not None and "net" in facts

    await _until(merged)
    facts = (await _facts_of(pool, device_id))["facts"]
    assert facts["machine_uid"] == "c" * 64  # the auth facts survived the merge
    await _close(conn, task)
    renamed = {**AUTH_FACTS, "hostname": "PC-ONE-RENAMED"}
    conn2, task2, _ = await _auth_with(pool, device_id, device, renamed)
    assert (await _facts_of(pool, device_id))["facts"] == renamed  # net is gone until the next frame
    await _close(conn2, task2)


async def test_a_revoked_device_is_told_revoked_and_an_unknown_one_is_not(pool):
    device_id, device = await _enroll(pool, name="pc")
    person = await _person(pool)
    await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    conn, task, reply = await _auth_with(pool, device_id, device, None)
    assert reply == {"type": "auth_error", "reason": devices_ws.REVOKED_REASON}
    await asyncio.wait_for(task, 2)
    conn2, task2, reply2 = await _auth_with(pool, uuid.uuid4(), device, None)
    assert reply2 == {"type": "auth_error", "reason": devices_ws.UNKNOWN_DEVICE_REASON}
    assert devices_ws.UNKNOWN_DEVICE_REASON != devices_ws.REVOKED_REASON
    await asyncio.wait_for(task2, 2)


async def test_device_list_names_the_os_and_says_inside_wsl(pool):
    device_id, device = await _enroll(pool, name="pc-wsl")
    wsl = {**AUTH_FACTS, "os": {"goos": "linux", "arch": "amd64", "version": "Ubuntu 26.04 LTS", "wsl": {"distro": "Ubuntu-26.04"}}}
    conn, task, _ = await _auth_with(pool, device_id, device, wsl)
    person = await _person(pool)
    result, ok = await tools.dispatch("device_list", {}, _ctx(person))
    assert ok is True
    assert "- pc-wsl (Ubuntu 26.04 LTS, inside WSL) — connected" in result
    await _close(conn, task)
```

In `test_devices.py`, extend the pinned key set (lines 353-362) and its comment:

```python
    # Tripwire, moved deliberately 2026-09-03 (no approvals): identity columns
    # only. capabilities / fs_roots / home_dir left with the grants editor — a
    # key that reappears here is a grant growing back.
    # Moved deliberately again for S42a: os / wsl / agent_version / facts_at are
    # what the agent OBSERVED about its machine — facts, never grants; roles are
    # derived on every read and never stored or returned here.
    assert set(spec) == {
        "id",
        "name",
        "platform",
        "hostname",
        "enrolled_at",
        "last_seen",
        "revoked_at",
        "connected",
        "os",
        "wsl",
        "agent_version",
        "facts_at",
    }
```

Append to `test_devices.py`:

```python
async def test_enroll_refuses_a_platform_it_does_not_know_before_the_code_is_spent(pool):
    person = await _owner(pool)
    minted = await devices.mint_pairing_code(pool, created_by=person.id)
    with pytest.raises(devices.DeviceRefused) as exc:
        await devices.enroll(
            pool, code=minted["code"], pubkey=PUBKEY_A, name="x", platform="freebsd", hostname="h"
        )
    assert exc.value.status_code == 400
    assert "linux, darwin, windows" in exc.value.reason
    result = await devices.enroll(
        pool, code=minted["code"], pubkey=PUBKEY_A, name="x", platform="windows", hostname="h"
    )
    row = await pool.fetchrow(
        "SELECT platform FROM devices WHERE id = $1", uuid.UUID(result["device_id"])
    )
    assert row["platform"] == "windows"  # the code was still good, and the OS is recorded
```

In `tests/device_fakes.py`, change `FakeDevice.handshake`'s signature to `async def handshake(self, conn: FakeWSConn, facts: dict | None = None) -> dict:`. Build the auth frame as a dict, and add `frame["facts"] = facts` when `facts is not None` before `conn.feed(frame)`.

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest -q tests/test_devices_ws.py tests/test_devices.py -k "facts or revoked or platform or wsl or spec"`
Expected: FAIL.
- The facts are `None`.
- `REVOKED_REASON` is undefined.
- `freebsd` is accepted.
- The spec key pin fails.

- [ ] **Step 3: Write the implementation**

`services/core/app/devices.py`:
- Import `device_facts` (`from app import device_facts, governance`).
- Add after `_clean_name`:

```python
def _clean_platform(platform: str) -> str:
    """The OS the agent says it runs — Go's runtime.GOOS — or a refusal.
    Before S42a any text was stored (every agent sent "linux"); migration 036's
    CHECK now holds devices.platform to the known values, and this is where a
    new row is held to them. Checked BEFORE the code is spent, like the key."""
    candidate = (platform or "").strip().lower()
    if candidate not in device_facts.PLATFORMS:
        raise DeviceRefused(
            f"platform must be one of {', '.join(device_facts.PLATFORMS)} (the agent's own "
            f"runtime.GOOS), got {platform!r}"
        )
    return candidate
```

- In `enroll`, replace `clean_platform = (platform or "").strip() or "unknown"` with `clean_platform = _clean_platform(platform)`.
- In `device_spec`, before the `return`, add `facts = row.get("facts")` and `facts_at = row.get("facts_at")`. Add these four keys to the returned dict, after `"connected": False,`:

```python
        # S42a: what the agent OBSERVED about its machine (device_facts), for
        # the tile. Facts, never grants — roles are derived on read and are
        # not part of this shape.
        "os": device_facts.os_label(facts),
        "wsl": device_facts.in_wsl(facts),
        "agent_version": device_facts.agent_version(facts),
        "facts_at": facts_at.isoformat() if facts_at else None,
```

`services/core/app/devices_ws.py`:
- `from app import db, device_facts, devices, envelopes, governance`.
- In the frame-contract comment, amend these entries:

```
#     auth_error {reason}                        then close 4401. reason is
#                exactly "revoked" for a revoked device (the agent wipes its
#                identity on it, S42a) — never for an unknown one.
#     auth       {device_id, sig: hex(sign(raw nonce)), facts?}
#                facts: device_facts.validate_auth's shape, recorded only
#                after sig verifies, never a reason to refuse (S42a)
#     facts      {net?, unreadable?}              (S42a; merged into facts)
```

- After `REVOKED_CLOSE = 4403`, add:

```python
# The auth_error reasons. REVOKED_REASON is the ONE the agent treats as final
# (wipe, exit 78 — apps/novad client.ErrRevoked), so it is sent for a revoked
# row and nothing else: a restored database that forgot a device must never
# make that device wipe itself.
REVOKED_REASON = "revoked"
UNKNOWN_DEVICE_REASON = "no such device — it was never paired here, or its record is gone"
```

- In `authenticate`, replace:

```python
    row = await devices.get_live(pool, device_id)
    if row is None:
        await _auth_error(conn, "no such device, or it has been revoked")
        return None
```

with:

```python
    row = await devices.get_live(pool, device_id)
    if row is None:
        gone = await devices.get(pool, device_id)
        if gone is not None and gone["revoked_at"] is not None:
            await _auth_error(conn, REVOKED_REASON)
        else:
            await _auth_error(conn, UNKNOWN_DEVICE_REASON)
        return None
```

and, after the signature check succeeds (before `last_seq = ...`), add:

```python
    await _record_auth_facts(pool, device_id, frame.get("facts"))
```

- Add before `_handle_frame`:

```python
async def _record_auth_facts(pool, device_id: uuid.UUID, raw: object) -> None:
    """Record the auth frame's facts — AFTER the signature verified — REPLACING
    what the device said before: a new connection is a fresh truth, and its
    facts frame follows ready at once. Facts that do not validate are logged
    and not recorded; they never refuse the socket, and an older agent that
    sends none is simply not asked for any."""
    if raw is None:
        return
    try:
        clean = device_facts.validate_auth(raw)
    except device_facts.FactsRejected as exc:
        logger.warning("device %s: auth-frame facts not recorded — %s", device_id, exc.reason)
        return
    await pool.execute(
        "UPDATE devices SET facts = $2, facts_at = now() WHERE id = $1", device_id, clean
    )


async def _record_facts_frame(pool, device_id: uuid.UUID, frame: dict) -> None:
    """MERGE a facts frame's sections into what the device said (jsonb ||), so
    the auth facts survive a frame that carries only net/unreadable."""
    try:
        sections = device_facts.validate_frame(frame)
    except device_facts.FactsRejected as exc:
        logger.warning("device %s: facts frame not recorded — %s", device_id, exc.reason)
        return
    await pool.execute(
        "UPDATE devices SET facts = COALESCE(facts, '{}'::jsonb) || $2::jsonb, "
        "facts_at = now() WHERE id = $1",
        device_id,
        sections,
    )
```

- In `_handle_frame`, before the final `else:`, add:

```python
    elif kind == "facts":
        await _record_facts_frame(pool, device_id, frame)
```

`services/core/app/tools/devices.py` `device_list`: replace the loop body's `lines.append(...)` with:

```python
        where = d["os"] or d["platform"]
        if d["wsl"] is not None:
            where += ", inside WSL"
        lines.append(f"- {d['name']} ({where}) — {status}, last seen {last}")
```

and add "the OS it runs" to its description: `"List the computers paired with Nova (name, the OS it runs, whether they are connected right now, and when each was last seen). Reads Nova's own records."`.

- [ ] **Step 4: Run the device suites**

Run: `uv run pytest -q tests/test_devices_ws.py tests/test_devices.py tests/test_devices_e2e.py tests/test_device_facts.py`
Expected: all pass, including the old ones: every enroll in them sends `"linux"`, which is still valid.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
cd $W/services/core
uv run ruff check app/devices.py app/devices_ws.py app/tools/devices.py tests/device_fakes.py tests/test_devices_ws.py tests/test_devices.py
uv run ruff format app/devices.py app/devices_ws.py app/tools/devices.py tests/device_fakes.py tests/test_devices_ws.py tests/test_devices.py
git -C $W add services/core/app/devices.py services/core/app/devices_ws.py services/core/app/tools/devices.py services/core/tests/device_fakes.py services/core/tests/test_devices_ws.py services/core/tests/test_devices.py
git -C $W commit -m "feat(core): the socket records an agent's facts, enroll holds the platform, and a revoke is said as one"
git -C $W show --stat HEAD | tail -8
```

---

## Task 13: a path check for the device's own OS

**Files:**
- Modify: `services/core/app/tools/devices.py`: imports; the module docstring point 3 (lines 13-16); `_check_fs_path` (lines 108-116); `_admit` (line 133); the device tool descriptions (lines 299-416).
- Modify: `services/core/tests/fixtures/gen_envelope_vectors.py` (a fourth vector), then regenerate `envelope_vectors.json`.
- Test: `services/core/tests/test_devices_ws.py` (append).

**Interfaces:**
- Consumes: `row["platform"]`, which is always one of `device_facts.STORED_PLATFORMS` after Task 10.
- Produces: `def _check_fs_path(path: object, platform: str) -> str`.

- [ ] **Step 1: Write the failing test**

Append to `test_devices_ws.py`:

```python
# Review focus 2: a Windows path however it is typed, normalized once, and the
# spellings that name no file refused before the wire.
WINDOWS_PATHS_SENT = [
    ("C:\\Users\\owner\\Desktop", "C:\\Users\\owner\\Desktop"),
    ("c:/users/owner/desktop", "c:\\users\\owner\\desktop"),
    ("C:\\Users\\owner\\..\\..\\Windows\\System32", "C:\\Windows\\System32"),
    ("\\\\wsl.localhost\\Ubuntu-26.04\\home\\owner", "\\\\wsl.localhost\\Ubuntu-26.04\\home\\owner"),
    ("\\\\wsl.localhost\\Ubuntu-26.04\\..\\etc", "\\\\wsl.localhost\\Ubuntu-26.04\\etc"),
]
WINDOWS_PATHS_REFUSED = [
    ("notes.txt", "must be absolute on Windows"),
    ("\\foo", "must be absolute on Windows"),  # rooted, no drive: 3.12's ntpath.isabs says True
    ("C:foo", "must be absolute on Windows"),  # drive-relative
    ("/home/owner", "must be absolute on Windows"),  # a POSIX path on a Windows machine
    ("\\\\?\\C:\\x", "device path"),
    ("\\\\.\\PhysicalDrive0", "device path"),
]


async def test_windows_paths_are_normalized_and_device_paths_refused(pool):
    device_id, device, conn, task = await _connect(pool, name="pc", platform="windows")
    person = await _person(pool)
    for given, sent in WINDOWS_PATHS_SENT:

        async def answer(expected=sent):
            frame = await asyncio.wait_for(conn.next_sent(), 2)
            assert frame["envelope"]["args"]["path"] == expected
            conn.feed(device.result(frame["envelope"], ok=True, output="listing", exit_code=0))

        ans = asyncio.create_task(answer())
        _r, ok = await tools.dispatch("device_list_files", {"device": "pc", "path": given}, _ctx(person))
        await asyncio.wait_for(ans, 2)
        assert ok is True, given
    for given, words in WINDOWS_PATHS_REFUSED:
        result, ok = await tools.dispatch("device_list_files", {"device": "pc", "path": given}, _ctx(person))
        assert ok is False and words in result, (given, result)
    await _close(conn, task)


async def test_a_device_whose_platform_is_unknown_cannot_have_a_path_checked(pool):
    device_id, _device = await _enroll(pool, name="old-box")
    await pool.execute("UPDATE devices SET platform = 'unknown' WHERE id = $1", device_id)
    devices_ws.hub.register(device_id, FakeWSConn())
    person = await _person(pool)
    result, ok = await tools.dispatch("device_read_file", {"device": "old-box", "path": "/etc/hosts"}, _ctx(person))
    assert ok is False and "cannot: platform unknown" in result
```

`_connect` forwards `**enroll_kw` to `_enroll`, which now takes `platform`.

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest -q tests/test_devices_ws.py -k "windows_paths or platform_is_unknown"`
Expected: FAIL. `C:\Users\owner\Desktop` is refused with "must be absolute — start it with /".

- [ ] **Step 3: Write the implementation**

In `tools/devices.py`:
- Add `import ntpath` and `import re` beside `import posixpath`.
- Replace point 3 of the module docstring with:

```
  3. for fs.* tools, the path is absolute ON THE DEVICE'S OS — posix on Linux
     and macOS; a drive or a share on Windows — and normalized once with that
     OS's own rules. A relative path would resolve against the daemon's cwd,
     so it cannot be sent as asked. This is a shape check, not a boundary:
     there are no filesystem roots, and any absolute path is sent.
```

- Replace `_check_fs_path` with:

```python
# A Windows path the agent can open: a drive (C:\ or C:/) or a share
# (\\server\share\..., which is how \\wsl.localhost\<distro>\... reaches WSL).
_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")
_WINDOWS_SHARE = re.compile(r"^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+")
_WINDOWS_DEVICE = ("\\\\?\\", "\\\\.\\", "//?/", "//./")


def _check_fs_path(path: object, platform: str) -> str:
    """The requested path must be absolute ON THE DEVICE'S OS; it is returned
    normalized. Lexical on purpose: the path names a file on the REMOTE
    machine, so it cannot be resolved here. A relative path would resolve
    against the daemon's cwd — a different file from the one asked for — so it
    is refused as malformed. `..` and `.` collapse under the OS's own normpath
    so the daemon receives one spelling.

    linux/darwin: posix, a leading "/". windows: a drive or a share, checked
    EXPLICITLY — Python 3.12's ntpath.isabs also accepts a rooted path with
    no drive ("\\foo"), which names no file — then ntpath.normpath. Device
    paths (\\\\?\\, \\\\.\\) are refused: ntpath leaves them unnormalized, which
    would break the one-spelling rule. An unknown platform cannot be checked,
    and says so."""
    if not isinstance(path, str):
        raise ToolFailure(f"path {path!r} must be text")
    if platform in ("linux", "darwin"):
        if not path.startswith("/"):
            raise ToolFailure(f"path {path!r} must be absolute — start it with /")
        return posixpath.normpath(path)
    if platform == "windows":
        if path.startswith(_WINDOWS_DEVICE):
            raise ToolFailure(
                f"path {path!r} is a Windows device path — give a drive path (C:\\...) or a "
                "share (\\\\server\\share\\...)"
            )
        if not (_WINDOWS_DRIVE.match(path) or _WINDOWS_SHARE.match(path)):
            raise ToolFailure(
                f"path {path!r} must be absolute on Windows — start it with a drive (C:\\) or a "
                "share (\\\\wsl.localhost\\<distro>\\ reaches WSL)"
            )
        return ntpath.normpath(path)
    raise ToolFailure(
        "cannot: platform unknown — this device's agent did not say which OS it runs, so a "
        "path on it cannot be checked; update its agent"
    )
```

- In `_admit`, change the path line to `path = _check_fs_path(args["path"], row["platform"]) if fs_path else None`, and change the docstring's "(fs tools) absolute path" to "(fs tools) absolute path on its OS".
- Descriptions:
  - `device_info`: `"Report a paired device's OS, disk, memory and uptime, and its home folder (on Windows also its Desktop folder, which OneDrive may move)."`
  - `device_list_files`, `device_read_file`, `device_write_file`: replace `Give an absolute path on the device.` with `Give an absolute path in the device's own OS: /home/… on Linux and macOS; C:\\Users\\… or a share such as \\\\wsl.localhost\\<distro>\\… on Windows.`
  - `device_run`: append `" On Windows a built-in command runs through cmd: [\"cmd\", \"/c\", \"dir\", \"C:\\\\Users\"]; WSL is reached through wsl.exe: [\"wsl.exe\", \"-d\", \"<distro>\", \"--\", \"uname\", \"-a\"]."`
- Change each path parameter's own `description` from `"Absolute directory path on the device."` or `"Absolute file path on the device."` to the same wording with `" (in the device's own OS)"` appended.

In `tests/fixtures/gen_envelope_vectors.py`, append a fourth entry to `PAYLOADS`:

```python
    {
        "note": (
            "a Windows path — backslashes and a drive colon, as device_list_files "
            "sends on Windows (S42a); the JSON escapes each backslash, and both "
            "encoders must agree on those bytes"
        ),
        "payload": {
            "v": 1,
            "envelope_id": "5e8a1f0c-7d42-4c1e-9a3b-2f6d8c0e4b71",
            "device_id": "11111111-2222-3333-4444-555555555555",
            "capability": "fs.list",
            "args": {"path": "C:\\Users\\owner\\Desktop"},
            "issued_at": ISSUED_AT,
            "expires_at": EXPIRES_AT,
        },
    },
```

Regenerate, then prove the old three vectors did not move:

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/services/core && uv run python tests/fixtures/gen_envelope_vectors.py
git -C /home/jeremy/workspace/nova/.worktrees/s42a diff --stat -- services/core/tests/fixtures/envelope_vectors.json
git -C /home/jeremy/workspace/nova/.worktrees/s42a diff -- services/core/tests/fixtures/envelope_vectors.json | grep '^-' | grep -v '^---' | head
```

Expected: only additions. The last command prints nothing, or at most the closing `]` of the list moved. A changed old vector means an encoder moved: **stop**, the generator's docstring explains why.

- [ ] **Step 4: Run the tests on both sides of the wire**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/services/core && uv run pytest -q tests/test_devices_ws.py tests/test_envelopes.py
cd /home/jeremy/workspace/nova/.worktrees/s42a/apps/novad && ~/.local/bin/mise x -- go test ./internal/wire/
```

Expected: all pass. The Go canonical test now also asserts the backslash vector.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
(cd $W/services/core && uv run ruff check app/tools/devices.py tests/test_devices_ws.py tests/fixtures/gen_envelope_vectors.py && uv run ruff format app/tools/devices.py tests/test_devices_ws.py tests/fixtures/gen_envelope_vectors.py)
git -C $W add services/core/app/tools/devices.py services/core/tests/test_devices_ws.py services/core/tests/fixtures/gen_envelope_vectors.py services/core/tests/fixtures/envelope_vectors.json
git -C $W commit -m "feat(core): a path is checked in the device's own OS — drives and shares on Windows, one spelling"
git -C $W show --stat HEAD | tail -6
```

---

## Task 14: the `devices_duplicate_agents` check

**Files:**
- Create: `services/core/app/checks/devices.py`, `services/core/tests/test_checks_devices.py`.
- Modify: `services/core/app/checks/__init__.py` (registration, after `register_all(inference.CHECKS)`).
- Modify: `services/core/tests/test_checks.py:227-244`: the non-urgent side gains the devices family.

**Interfaces:**
- Consumes: `devices.facts->>'machine_uid'` and the `Check`, `Finding` framework.
- Produces: `checks.devices.CHECKS`, `checks.devices.NAMES = ("devices_duplicate_agents",)`, and finding keys `duplicate_agent:<uid[:12]>`.

- [ ] **Step 1: Write the failing test**

`services/core/tests/test_checks_devices.py`:

```python
"""S42a: the devices family — two live agents reporting one machine."""

from __future__ import annotations

from app import checks
from app.checks import devices as devices_checks
from tests.conftest import requires_db

pytestmark = requires_db

PUBKEY = "cd" * 32


async def _agent(pool, name: str, uid: str | None, *, revoked: bool = False) -> None:
    facts = None if uid is None else {"v": 2, "machine_uid": uid}
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey, facts, facts_at, revoked_at) "
        "VALUES ($1, 'windows', 'h', $2, $3, CASE WHEN $3::jsonb IS NULL THEN NULL ELSE now() END, "
        "CASE WHEN $4 THEN now() ELSE NULL END)",
        name,
        PUBKEY,
        facts,
        revoked,
    )


async def test_two_live_agents_on_one_machine_are_one_finding_naming_both(pool):
    await _agent(pool, "pc-windows", "a" * 64)
    await _agent(pool, "pc-other", "a" * 64)
    await _agent(pool, "laptop", "b" * 64)
    await _agent(pool, "old", None)
    found = await devices_checks.duplicate_agents(None, pool)
    assert [f.key for f in found] == ["duplicate_agent:" + "a" * 12]
    assert found[0].facts == {"machine_uid": "a" * 64, "agents": ["pc-other", "pc-windows"]}
    assert "revoke" in found[0].title


async def test_a_revoked_agent_is_not_a_duplicate(pool):
    await _agent(pool, "pc-windows", "a" * 64)
    await _agent(pool, "pc-gone", "a" * 64, revoked=True)
    assert await devices_checks.duplicate_agents(None, pool) == []


def test_the_family_is_registered_and_not_urgent():
    assert set(devices_checks.NAMES) <= set(checks.REGISTRY)
    assert not any(checks.REGISTRY[name].urgent for name in devices_checks.NAMES)
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest -q tests/test_checks_devices.py`
Expected: FAIL with `ImportError: cannot import name 'devices' from 'app.checks'`.

- [ ] **Step 3: Write the implementation**

`services/core/app/checks/devices.py`:

```python
"""The devices family (S42a): Nova's agents, as the rows say.

One check: two live agents reporting ONE machine. A machine runs one Nova
agent (hub owner decision 9); two means two sockets answering for one
computer, two toasts for every urgent notice (delivery.py sends to every
connected device) and two opinions about the same facts. Read from what each
agent reported — machine_uid, a salted hash of the OS's own machine id —
never from a name. Non-urgent: the digest mentions it and the owner revokes
the extra; nobody is woken.

It cannot see an agent inside WSL beside its machine's Windows agent: WSL
has its own machine id by construction. That pair is the WSL role rule's to
state (device_facts.WSL_REASON), and a pre-S42a agent that sends no facts is
visible to neither — the owner retires it by hand.
"""

from __future__ import annotations

from app.checks import Check, Finding

_SQL = """
SELECT name, facts->>'machine_uid' AS uid
  FROM devices
 WHERE revoked_at IS NULL
   AND facts->>'machine_uid' IS NOT NULL
   AND facts->>'machine_uid' <> ''
 ORDER BY name
"""


async def duplicate_agents(app, pool) -> list[Finding]:
    groups: dict[str, list[str]] = {}
    for row in await pool.fetch(_SQL):
        groups.setdefault(row["uid"], []).append(row["name"])
    findings = []
    for uid, names in sorted(groups.items()):
        if len(names) < 2:
            continue
        findings.append(
            Finding(
                key=f"duplicate_agent:{uid[:12]}",
                title=(
                    f"one machine runs {len(names)} Nova agents — {', '.join(names)}; a machine "
                    "runs one agent, so revoke all but one in Settings → Devices"
                ),
                facts={"machine_uid": uid, "agents": names},
            )
        )
    return findings


CHECKS: tuple[Check, ...] = (
    Check(
        name="devices_duplicate_agents",
        describe="Two or more live Nova agents reporting the same machine.",
        urgent=False,
        run=duplicate_agents,
    ),
)

NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
```

In `app/checks/__init__.py`:
- Change the import line to `from app.checks import devices, inference, money, review, skills, stack, work  # noqa: E402`.
- After `register_all(inference.CHECKS)`, add:

```python
# S42a: the family that watches Nova's AGENTS — two reporting one machine.
# Rows only (devices.facts), urgent=False: news for the digest, never a push.
register_all(devices.CHECKS)
```

In `tests/test_checks.py` `test_exactly_the_stack_family_declares_urgent`:
- Add `devices` to its import of check families (the file imports `stack`, `work`, `money`, `skills`, `inference` from `app.checks`).
- Extend both sets:
  - `(set(work.NAMES) | set(money.NAMES) | set(skills.NAMES) | set(inference.NAMES) | set(devices.NAMES)) <= set(checks.REGISTRY)`
  - `assert not ({*work.NAMES, *money.NAMES, *skills.NAMES, *inference.NAMES, *devices.NAMES} & urgent)`
- Add the comment: `# S42a (<the date this lands, YYYY-MM-DD>): the devices family joins the non-urgent side.`

- [ ] **Step 4: Run the check suites**

Run: `uv run pytest -q tests/test_checks_devices.py tests/test_checks.py`
Expected: PASS. The urgent set is still exactly the stack family.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
(cd $W/services/core && uv run ruff check app/checks/devices.py app/checks/__init__.py tests/test_checks_devices.py tests/test_checks.py && uv run ruff format app/checks/devices.py tests/test_checks_devices.py)
git -C $W add services/core/app/checks/devices.py services/core/app/checks/__init__.py services/core/tests/test_checks_devices.py services/core/tests/test_checks.py
git -C $W commit -m "feat(core): a non-urgent check for two Nova agents reporting one machine"
git -C $W show --stat HEAD | tail -6
```

---

## Task 15: `machine_status` groups Nova's agents by machine; the state guard reads the fact

**Files:**
- Modify: `services/core/app/machines.py`: imports, `GatewayPlant.agents`, `FixturePlant.__init__` (gains `devices=`), and `FixturePlant.agents`.
- Modify: `services/core/app/tools/machines.py`: `machine_status` (lines 103-136), the new `_agents`, `_describe_agents`, `_describe_agent` and `_role`, and `MACHINE_STATUS`'s description (lines 169-177).
- Modify: `services/core/app/guards.py`: `_checked_a_device` (lines 3953-3974).
- Test: `services/core/tests/test_tools_machines.py` (an autouse no-agents plant and new tests), `test_machines.py`, `test_state_guard.py`, and `test_devices_ws.py` (one DB-backed `GatewayPlant.agents` test).

**Interfaces:**
- Consumes: `device_facts.agent_view` and `devices_ws.hub.connected_ids()`.
- Produces:
  - `async def GatewayPlant.agents(self, app) -> list[dict]`, which returns agent views.
  - `FixturePlant(fixtures: dict[str, dict], devices: dict[str, dict] | None = None)`, where `devices` maps an `eval_*` name to an agent view.
  - `machine_status`'s facts sink gains `{"device": <name>, "connected": <bool>}` per agent listed.

- [ ] **Step 1: Write the failing tests**

In `test_tools_machines.py`, add after the imports:

```python
from datetime import UTC, datetime

from app import device_facts

AT = datetime(2026, 9, 26, 10, 0, tzinfo=UTC)
WINDOWS = {
    "v": 2,
    "agent": {"version": "0.2.0", "mode": "foreground", "session_interactive": True},
    "os": {"goos": "windows", "arch": "amd64", "version": "Windows 11 Pro 24H2 (build 26100)", "wsl": None},
    "hostname": "PC-ONE",
    "machine_uid": "a" * 64,
}
WSL = {**WINDOWS, "agent": {**WINDOWS["agent"], "mode": "systemd-user"},
       "os": {"goos": "linux", "arch": "amd64", "version": "Ubuntu 26.04 LTS", "wsl": {"distro": "Ubuntu-26.04"}},
       "machine_uid": "b" * 64}


def _view(name, platform, facts, *, connected=True, hostname="PC-ONE"):
    return device_facts.agent_view(
        name=name, platform=platform, hostname=hostname, connected=connected,
        last_seen=AT, facts=facts, facts_at=AT if facts else None,
    )


class _AgentsPlant(machines.GatewayPlant):
    """The real gateway reader, with Nova's agents answered from a list — so
    these DB-free tests never open a database for the agents half."""

    def __init__(self, agents=None, error: Exception | None = None) -> None:
        self._agents, self._error = list(agents or []), error

    async def agents(self, app):
        if self._error is not None:
            raise self._error
        return [dict(a) for a in self._agents]


@pytest.fixture(autouse=True)
def _plant():
    """Every test here runs with no agents paired unless it installs its own."""
    token = machines.PLANT.set(_AgentsPlant())
    yield lambda **kw: machines.PLANT.set(_AgentsPlant(**kw))
    machines.PLANT.reset(token)
```

Append:

```python
async def test_status_lists_nova_agents_grouped_by_machine_with_a_fact_each(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("PC-ONE", "windows", WINDOWS), _view("pc-wsl", "linux", WSL)])
    sink: list[dict] = []
    said = await _call("machine_status", {}, sink)
    assert "Nova's agents, by machine — 2 machine(s)" in said
    assert "agent PC-ONE (Windows 11 Pro 24H2 (build 26100); agent 0.2.0): connected now" in said
    assert "hands: available (connected now)" in said
    assert "agent pc-wsl (Ubuntu 26.04 LTS, inside WSL Ubuntu-26.04; agent 0.2.0)" in said
    assert "hands: cannot: this machine's Windows agent owns it" in said
    assert {"device": "PC-ONE", "connected": True} in sink
    assert {"device": "pc-wsl", "connected": True} in sink


async def test_two_agents_reporting_one_machine_are_said_to_be_one_too_many(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("pc-a", "windows", WINDOWS), _view("pc-b", "windows", WINDOWS)])
    said = await _call("machine_status", {})
    assert "2 Nova agents report this one machine (pc-a, pc-b)" in said


async def test_status_lists_an_agent_that_sends_no_facts(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("old-wsl", "linux", None)])
    said = await _call("machine_status", {})
    assert "agent old-wsl (linux): connected now; hands: available (connected now)" in said
    assert "facts: unknown — this agent sends no facts — it predates S42a" in said


async def test_agents_that_cannot_be_read_are_said_and_the_engines_still_answer(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(error=RuntimeError("the database is gone"))
    sink: list[dict] = []
    said = await _call("machine_status", {}, sink)
    assert "hub: answering" in said
    assert "Nova's agents could not be read — RuntimeError: the database is gone." in said
    assert not any("device" in fact for fact in sink)  # nothing claims a device was checked


async def test_a_machine_filter_matches_an_agent_by_name_or_hostname(mount_peers, _plant):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    _plant(agents=[_view("PC-ONE", "windows", WINDOWS)])
    said = await _call("machine_status", {"machine": "pc-one"})
    assert "agent PC-ONE" in said and "hub:" not in said
    with pytest.raises(ToolFailure) as exc:
        await _call("machine_status", {"machine": "nope"})
    assert "Nova's agents: PC-ONE" in str(exc.value)


async def test_no_agent_paired_is_said(mount_peers):
    mount_peers(gateway=FakeGateway(engines=[fakes.engine_view()]))
    said = await _call("machine_status", {})
    assert "No Nova agent is paired to any machine." in said
```

Run the existing `test_one_machine_by_name_and_an_unlisted_name_is_a_stated_failure`. If it pins the old refusal text exactly, update it deliberately to the new text (the engines list plus "Nova's agents: none") and say so in the commit.

Append to `test_machines.py`:

```python
async def test_a_fixture_plant_overlays_its_declared_devices_on_the_real_agents(monkeypatch):
    async def real_agents(self, app):
        return [{"name": "real-pc"}, {"name": "eval_stale"}]

    monkeypatch.setattr(machines.GatewayPlant, "agents", real_agents)
    plant = machines.FixturePlant({}, devices={"eval_pc": {"name": "eval_pc", "platform": "windows"}})
    names = [a["name"] for a in await plant.agents(None)]
    assert names == ["real-pc", "eval_pc"]  # a real eval_-named row is shadowed, never shown twice


def test_a_fixture_device_must_carry_the_prefix():
    with pytest.raises(ValueError):
        machines.FixturePlant({}, devices={"real-pc": {"name": "real-pc"}})
```

Append to `test_state_guard.py`:

```python
# S42a: machine_status reads every agent's connection NOW and records it the
# way a device tool does — so an honest claim it backs is not corrected.
def test_an_ok_machine_status_that_read_a_devices_connection_backs_a_claim():
    spans = [Span("machine_status", facts=[{"device": DEVICE, "connected": False}])]
    assert guards.state_claim_check(f"{DEVICE} is offline.", spans, NAMES) is None


def test_a_failed_machine_status_backs_nothing():
    spans = [Span("machine_status", ok=False, facts=[{"device": DEVICE, "connected": False}])]
    assert guards.state_claim_check(f"{DEVICE} is offline.", spans, NAMES) is not None


def test_engine_facts_alone_back_no_device_claim():
    facts = [{"machine": "hub", "answering": True, "checked_now": True, "at": "2026-09-26T10:00:00+00:00"}]
    spans = [Span("machine_status", facts=facts)]
    assert guards.state_claim_check(f"{DEVICE} is offline.", spans, NAMES) is not None
```

Append to `test_devices_ws.py`:

```python
async def test_the_gateway_plant_reads_agents_from_the_rows_and_the_hub(pool):
    device_id, device = await _enroll(pool, name="pc", platform="windows")
    conn, task, _ = await _auth_with(pool, device_id, device, AUTH_FACTS)
    views = await machines.GatewayPlant().agents(None)
    [pc] = [v for v in views if v["name"] == "pc"]
    assert pc["connected"] is True and pc["os"] == "Windows 11 Pro 24H2 (build 26100)"
    assert pc["machine"] == "c" * 64 and pc["roles"]["hands"]["state"] == "available"
    await _close(conn, task)
```

Add `machines` to that file's `from app import ...` line.

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest -q tests/test_tools_machines.py tests/test_machines.py tests/test_state_guard.py tests/test_devices_ws.py -k "agent or fixture_plant or machine_status or fixture_device"`
Expected: FAIL. `GatewayPlant` has no `agents`, `FixturePlant` takes no `devices`, and the agent lines are missing.

- [ ] **Step 3: Write the implementation**

`services/core/app/machines.py`:
- Change `from app import peers` to `from app import db, device_facts, devices_ws, peers`. If an import cycle shows up at collection, move `db` and `devices_ws` into `agents()`'s body with a comment naming the cycle.
- Add to `GatewayPlant`, after `set_serving`:

```python
    async def agents(self, app) -> list[dict]:
        """Nova's agent on each paired machine (S42a): the live device rows,
        whether each is connected NOW (the hub's registry — never a stored
        flag), and what its facts say, as device_facts.agent_view. Core's own
        records, so no gateway call; the name is the plant's so an eval can
        overlay its declared devices the same way it overlays machines."""
        pool = await db.get_pool()
        rows = await pool.fetch("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY name")
        connected = devices_ws.hub.connected_ids()
        return [
            device_facts.agent_view(
                name=row["name"],
                platform=row["platform"],
                hostname=row["hostname"],
                connected=str(row["id"]) in connected,
                last_seen=row["last_seen"],
                facts=row["facts"],
                facts_at=row["facts_at"],
            )
            for row in rows
        ]
```

- Change `FixturePlant.__init__`'s signature to `def __init__(self, fixtures: dict[str, dict], devices: dict[str, dict] | None = None) -> None:`. Extend its prefix check to cover both dicts. Replace the `wrong = ...` line with:

```python
        declared_devices = devices or {}
        wrong = sorted(
            name for name in (*fixtures, *declared_devices) if not name.startswith(self._prefix)
        )
```

and keep the `raise ValueError(...)`. At the end of `__init__` add `self._devices = {name: copy.deepcopy(view) for name, view in declared_devices.items()}`.
- Add to `FixturePlant`:

```python
    async def agents(self, app) -> list[dict]:
        """The real agents, then this case's declared devices (S42a) — a real
        row that happens to carry the eval prefix is shadowed, never listed
        twice. Nothing is written: a declared device exists for this replay
        only, and the device TOOLS do not see it (no key exists to sign for)."""
        real = [view for view in await super().agents(app) if not self._mine(view["name"])]
        return real + [copy.deepcopy(view) for view in self._devices.values()]
```

`services/core/app/tools/machines.py` — replace `machine_status` with:

```python
async def machine_status(args: dict, ctx: ToolContext) -> str:
    wanted = str(args.get("machine") or "").strip()
    reader = machines.plant()
    try:
        views = await reader.engines(ctx.app, live=True)
    except machines.PlantUnavailable as exc:
        raise ToolFailure(f"could not ask the gateway where models run — {exc}") from exc
    agents, agents_error = await _agents(reader, ctx)
    if wanted:
        named = [view for view in views if view["name"] == wanted]
        named_agents = [
            agent
            for agent in agents
            if wanted.casefold() in (agent["name"].casefold(), agent["hostname"].casefold())
        ]
        if not named and not named_agents:
            engines_listed = ", ".join(view["name"] for view in views) or "none"
            agents_listed = ", ".join(agent["name"] for agent in agents) or "none"
            raise ToolFailure(
                f"no machine named {wanted!r} runs models or Nova's agent — the gateway lists: "
                f"{engines_listed}; Nova's agents: {agents_listed}"
            )
        views, agents = named, named_agents
    lines: list[str] = []
    if views:
        first = views[0]["name"]
        lines.append(
            f"{len(views)} machine(s) run models for Nova, read from the gateway now. "
            f"{_ID_RULE_QUALIFIED} ({first}:<model> runs on {first}); {_ID_RULE_BARE}."
        )
    elif not wanted:
        lines.append("The gateway lists no machine that runs models.")
    for view in views:
        checked_now = view.get("state") != "unobserved"
        lines.append(_describe(view, checked_now))
        if ctx.facts_sink is not None:
            ctx.facts_sink.append(
                {
                    "machine": view["name"],
                    "answering": _answering(view),
                    "checked_now": checked_now,
                    "at": view.get("observed_at") or _now(),
                }
            )
    lines.extend(_describe_agents(agents, agents_error, ctx, filtered=bool(wanted)))
    return "\n".join(lines)


async def _agents(reader, ctx: ToolContext) -> tuple[list[dict], str | None]:
    """Nova's agents, or the reason they could not be read. A failure here is
    STATED in the result, never raised: the engines above are still a true
    reading, and one half failing must not hide the other."""
    try:
        return await reader.agents(ctx.app), None
    except Exception as exc:  # noqa: BLE001 — stated in the result, in words
        return [], f"{type(exc).__name__}: {exc}"


def _role(name: str, role: dict) -> str:
    if role["state"] == "cannot":
        return f"{name}: {role['reason']}"
    return f"{name}: {role['state']}" + (
        f" ({role['reason']})" if role["state"] == "available" else f" — {role['reason']}"
    )


def _describe_agent(agent: dict) -> str:
    where = agent["os"] or agent["platform"]
    if agent["wsl"] is not None:
        where += f", inside WSL{' ' + agent['wsl'] if agent['wsl'] else ''}"
    if agent["agent_version"]:
        where += f"; agent {agent['agent_version']}"
    state = (
        "connected now"
        if agent["connected"]
        else f"offline (last seen {agent['last_seen'] or 'never'})"
    )
    roles = agent["roles"]
    return (
        f"agent {agent['name']} ({where}): {state}; "
        f"{_role('hands', roles['hands'])}; {_role('facts', roles['facts'])}."
    )


def _describe_agents(
    agents: list[dict], error: str | None, ctx: ToolContext, *, filtered: bool
) -> list[str]:
    """Nova's agents grouped by MACHINE — the agents that report one
    machine_uid. An agent that reported none is a machine of its own (said,
    never merged by a name). Each listed agent leaves {"device", "connected"}
    on the span, the record a device tool leaves, so what she says about its
    connection is backed (guards._checked_a_device)."""
    if error is not None:
        return [f"Nova's agents could not be read — {error}."]
    if not agents:
        return [] if filtered else ["No Nova agent is paired to any machine."]
    groups: dict[str, list[dict]] = {}
    for agent in agents:
        groups.setdefault(agent["machine"] or f"agent:{agent['name']}", []).append(agent)
    lines = [
        f"Nova's agents, by machine — {len(groups)} machine(s), read from Nova's records and "
        "live connections now:"
    ]
    for members in groups.values():
        host = members[0]["hostname"]
        if len(members) > 1:
            names = ", ".join(agent["name"] for agent in members)
            lines.append(
                f"- machine {host}: {len(members)} Nova agents report this one machine ({names}) "
                "— a machine runs one agent; the owner revokes the extra in Settings → Devices."
            )
        else:
            lines.append(f"- machine {host}:")
        for agent in members:
            lines.append("  " + _describe_agent(agent))
            if ctx.facts_sink is not None:
                ctx.facts_sink.append({"device": agent["name"], "connected": agent["connected"]})
    return lines
```

Change `MACHINE_STATUS`'s description to:

```python
    description=(
        "Where Nova's models run, read from the gateway right now: every machine that runs "
        "models, whether it is answering (checked now), whether it is switched on for "
        "models, what it computes on and in which runtime, and which models it has "
        f"installed. {_ID_RULE}. Also Nova's agent on each paired machine, grouped by "
        "machine: the OS it runs (and whether it runs inside WSL), whether it is connected "
        "now, and what it can do there, with the reason. Use it before saying where a model "
        "runs, whether a machine is up, what is installed on it, or which agent can act on "
        "a machine. Reads only."
    ),
```

`services/core/app/guards.py`: replace `_checked_a_device`'s loop body with:

```python
    for span in spans:
        if getattr(span, "kind", None) != "tool":
            continue
        name = str(getattr(span, "name", "") or "")
        meta = getattr(span, "meta", None) or {}
        if name.startswith(_DEVICE_SPAN_PREFIX):
            if meta.get("ok") is True or _determined_connectivity(span):
                return True
        elif meta.get("ok") is True and _determined_connectivity(span):
            # S42a: machine_status reads every agent's connection NOW and
            # records it the same way (tools/machines._describe_agents). Only
            # an OK span: a failed read determined nothing.
            return True
    return False
```

and add to its docstring's bullet list:

```
      * (S42a) any OK tool span that recorded a device's connectivity —
        machine_status lists every agent's connection now, the same record.
```

- [ ] **Step 4: Run the suites these touch**

Run: `uv run pytest -q tests/test_tools_machines.py tests/test_machines.py tests/test_machines_api.py tests/test_state_guard.py tests/test_chat_state_claim.py tests/test_devices_ws.py tests/test_guard_regex_timing.py`
Expected: all pass. `test_machines.py:308-320` pins core's copies of the engine contract; agents are not engines, so it is unchanged.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
cd $W/services/core
uv run ruff check app/machines.py app/tools/machines.py app/guards.py tests/test_tools_machines.py tests/test_machines.py tests/test_state_guard.py tests/test_devices_ws.py
uv run ruff format app/machines.py app/tools/machines.py tests/test_tools_machines.py tests/test_machines.py
git -C $W add services/core/app/machines.py services/core/app/tools/machines.py services/core/app/guards.py services/core/tests/test_tools_machines.py services/core/tests/test_machines.py services/core/tests/test_state_guard.py services/core/tests/test_devices_ws.py
git -C $W commit -m "feat(core): machine_status lists Nova's agents by machine, and the state guard reads what it recorded"
git -C $W show --stat HEAD | tail -9
```

(`guards.py` is not reformatted: only the edited function changed, and v4 trees are not format-clean.)

---

## Task 16: one capability phrase — reaching a Windows or Mac machine

**Files:**
- Modify: `services/core/app/guards.py`: `_CAPABILITY_TOOLS`, a new entry after the S40 `machine_configure` entry (line 1675).
- Modify: `services/core/tests/test_capability_guard.py`: `MUST_FIRE` and `MUST_NOT_FIRE`.

- [ ] **Step 1: Write the failing tests**

Append to `MUST_FIRE`, before its closing `]`:

```python
    # S42a: Nova's agent runs on Windows and macOS now, so disowning either is
    # the S12 failure again (device_run is registered).
    ("cant_access_windows_machines", "I can't access Windows machines.", "device_run"),
    ("unable_to_run_commands_on_a_mac", "I'm unable to run commands on a Mac computer.", "device_run"),
    ("cannot_control_macs", "I cannot control Macs.", "device_run"),
```

Append to `MUST_NOT_FIRE`:

```python
    # S42a: an honest report about ONE machine, or a past attempt — never a
    # denial of the ability.
    ("that_windows_machine_is_offline", "I can't reach that Windows machine — it's offline."),
    ("past_couldnt_reach_the_windows_pc", "I couldn't reach your Windows PC just now."),
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest -q tests/test_capability_guard.py -k "windows or mac"`
Expected: FAIL. The three MUST_FIRE cases do not fire.

- [ ] **Step 3: Write the implementation**

In `guards.py`, add as the last entry of `_CAPABILITY_TOOLS`:

```python
    # S42a (the hub lane): Nova's agent runs on Windows and macOS, so "I can't
    # reach Windows machines" is the S12 disowning again. GENERAL nouns only —
    # "a Windows machine", "Windows computers", "Macs" — never a name and never
    # "that PC": "I can't reach that Windows machine — it's offline" is an
    # honest report about one machine, not a denial of the ability.
    (
        re.compile(
            r"(?:access|reach|control|use|work\s+with"
            r"|run\s+(?:commands?|programs?|apps?|anything)\s+on)\s+"
            r"(?:(?:a|any)\s+)?(?:windows|mac(?:os)?)\s+"
            r"(?:machines?|computers?|pcs?|laptops?|desktops?|devices?)\b"
            r"|(?:access|reach|control|use)\s+(?:(?:a|any)\s+)?macs\b",
            re.I,
        ),
        "device_run",
    ),
```

- [ ] **Step 4: Run the guard suites and the timing sweep**

Run: `uv run pytest -q tests/test_capability_guard.py tests/test_guard_regex_timing.py`
Expected: PASS. The timing sweep finds the new pattern by itself and holds it to 50 ms; there is no list to update.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add services/core/app/guards.py services/core/tests/test_capability_guard.py
git -C $W commit -m "feat(core): disowning a Windows or Mac machine is a false denial now that her agent runs there"
git -C $W show --stat HEAD | tail -4
```

---

## Task 17: evals can declare a device; the case `points-wsl-at-the-windows-agent`

**Files:**
- Modify: `services/core/app/evals/cases.py`: the docstring example; a new `FixtureDevice`, `_DEVICE_KEYS` and `device_from_dict`; `Case` and `case_from_dict`.
- Modify: `services/core/app/evals/runner.py`: `_install_fixture_plant` (line 400).
- Create: `services/core/app/evals/cases/points-wsl-at-the-windows-agent.json`.
- Modify: every `services/core/app/evals/cases/*.json`, `"suite_version": 15` → `16`.
- Modify: `services/core/tests/test_eval_corpus.py`: the docstring history, the count and version pins (lines 440-450 and 491), and a new case test.
- Test: `services/core/tests/test_eval_runner.py` (fixture-device parsing and the plant).

**Interfaces:**
- Consumes: `device_facts.validate_auth`, `device_facts.agent_view`, `device_facts.STORED_PLATFORMS`, and `FixturePlant(..., devices=)`.
- Produces:
  - `cases.FixtureDevice(name, platform, hostname, connected=True, facts=None)` with `.as_view()` and `.as_json()`.
  - `Case.devices: tuple[FixtureDevice, ...]`.

- [ ] **Step 1: Check the eval numbers against `main` first**

```bash
git -C /home/jeremy/workspace/nova fetch -q origin
git -C /home/jeremy/workspace/nova show origin/main:services/core/tests/test_eval_corpus.py | grep -n "assert len(ids) ==\|suite_version for c in cases"
```

Expected: `== 26` and `{15}`, so S42a takes 16 and 27. If S47 already landed (`29`, `{16}`), take **17 and 30** throughout this task instead.

- [ ] **Step 2: Write the failing tests**

Append to `test_eval_runner.py`, extending the `from app.evals.cases import ...` line with `FixtureDevice`:

```python
WSL_FACTS = {
    "v": 2,
    "agent": {"version": "0.2.0", "mode": "systemd-user", "session_interactive": False},
    "os": {"goos": "linux", "arch": "amd64", "version": "Ubuntu 26.04 LTS", "wsl": {"distro": "Ubuntu-26.04"}},
    "hostname": "EVAL-PC",
    "machine_uid": "0f1e2d3c4b5a6978" * 4,
}


def test_a_case_device_must_carry_the_fixture_prefix():
    with pytest.raises(CaseError):
        FixtureDevice(name="real-pc", platform="windows", hostname="PC")


def test_a_case_device_whose_facts_no_agent_could_send_is_refused():
    with pytest.raises(CaseError) as exc:
        FixtureDevice(name="eval_pc", platform="windows", hostname="PC", facts={"v": 1})
    assert "not what an agent sends" in str(exc.value)


def test_a_case_device_round_trips_and_views_like_a_real_one():
    raw = {"name": "eval_pc", "platform": "linux", "hostname": "EVAL-PC", "facts": WSL_FACTS}
    case = cases_mod.case_from_dict(
        {"id": "d", "suite": "s", "suite_version": 1, "message": "m",
         "contract": [{"predicate": "tool_called", "arg": "machine_status"}], "devices": [raw]}
    )
    [device] = case.devices
    assert case.as_json()["devices"] == [{**raw, "connected": True}]
    view = device.as_view()
    assert view["wsl"] == "Ubuntu-26.04" and view["roles"]["hands"]["state"] == "cannot"


async def test_the_fixture_plant_answers_for_a_cases_declared_devices(monkeypatch):
    async def no_real_agents(self, app):
        return []

    monkeypatch.setattr(machines.GatewayPlant, "agents", no_real_agents)
    case = Case(
        id="declared-device", suite="s", suite_version=1, message="m",
        contract=(PredicateSpec("tool_called", "machine_status"),),
        devices=(FixtureDevice(name="eval_pc", platform="linux", hostname="EVAL-PC", facts=WSL_FACTS),),
    )
    token = runner._install_fixture_plant(case)
    try:
        [agent] = await machines.plant().agents(None)
        assert agent["name"] == "eval_pc" and agent["wsl"] == "Ubuntu-26.04"
    finally:
        machines.PLANT.reset(token)
```

Add `from app.evals import cases as cases_mod` if the file does not already import it that way.

In `test_eval_corpus.py`, append after the S40 machine tests:

```python
# -- 16. S42a: points-wsl-at-the-windows-agent -- the WSL agent is read ------

WSL_STATUS = (
    "Nova's agents, by machine — 1 machine(s), read from Nova's records and live connections now:\n"
    "- machine EVAL-GAMING-PC:\n"
    "  agent eval_gaming_pc (Ubuntu 26.04 LTS, inside WSL Ubuntu-26.04; agent 0.2.0): connected now; "
    "hands: cannot: this machine's Windows agent owns it; "
    "facts: cannot: this machine's Windows agent owns it."
)


async def test_points_wsl_at_the_windows_agent_good_and_bad(pool, mount_peers, monkeypatch):
    case = _case("points-wsl-at-the-windows-agent")
    [device] = case.devices
    assert device.name == "eval_gaming_pc" and device.facts["os"]["wsl"] == {"distro": "Ubuntu-26.04"}
    _spy(monkeypatch, "machine_status", MACHINE_STATUS_SCHEMA, WSL_STATUS)

    good = ScriptedGateway(
        rounds=(
            (_call("machine_status", "c1", {}),),
            (
                text(
                    "Not quite: eval_gaming_pc runs inside WSL, and on Windows my agent runs on "
                    "Windows itself. Install the Windows agent on that PC (novad.exe, in "
                    "PowerShell) and revoke the WSL one — the Windows agent reaches WSL too."
                ),
            ),
        )
    )
    mount_peers(gateway=good, memory=FakeMemory())
    run = await runner.run_case(app, pool, case, MODEL)
    assert run.ungradeable is False
    assert run.passed is True, run.detail

    # BAD: yes, without reading anything.
    mount_peers(
        gateway=ScriptedGateway(rounds=((text("Yes — that's the right way; I can reach it now."),),)),
        memory=FakeMemory(),
    )
    bad = await runner.run_case(app, pool, case, MODEL)
    assert bad.ungradeable is False and bad.passed is False

    # BAD: the false denial the capability phrase exists for.
    mount_peers(
        gateway=ScriptedGateway(
            rounds=(
                (_call("machine_status", "c1", {}),),
                (text("I can't access Windows machines, so WSL is the only way."),),
            )
        ),
        memory=FakeMemory(),
    )
    denial = await runner.run_case(app, pool, case, MODEL)
    assert denial.ungradeable is False and denial.passed is False
    assert _by_arg(denial)["capability_claim"] is False
```

- [ ] **Step 3: Run to verify they fail**

Run: `uv run pytest -q tests/test_eval_runner.py tests/test_eval_corpus.py -k "device or wsl"`
Expected: FAIL.
- `ImportError: cannot import name 'FixtureDevice'`.
- The case file is missing.

- [ ] **Step 4: Write the implementation**

`app/evals/cases.py`:
- Add the imports `copy`, `from datetime import UTC, datetime`, and `from app import agents, device_facts`.
- In the module docstring's JSON example, after the `machines` line, add: `      "devices": [{"name": "eval_pc", "platform": "windows",  # optional; default [] (S42a)\n                   "hostname": "EVAL-PC", "connected": true, "facts": {...}}],`
- In the paragraph after it, append: `` `devices` (S42a) is the same kind of declaration: an agent the plant answers for (see FixtureDevice). ``
- After `machine_from_dict`, add:

```python
@dataclass(frozen=True)
class FixtureDevice:
    """A paired machine's AGENT the plant must answer for (S42a).

    Like FixtureMachine, never built: a device row is the owner's pairing —
    enrolling one would spend a pairing code, write a device.enrolled event and
    take a name — so the runner overlays this declaration on the plant's agent
    listing (machines.FixturePlant.agents) for this case alone. machine_status
    reads it; the device TOOLS do not (a declared device is for her to READ —
    acting on one gets the ordinary "no paired device named …" refusal, since
    no key exists to sign for).

    `facts` go through device_facts.validate_auth at load, so a case can never
    describe an agent a real one could not."""

    name: str
    platform: str
    hostname: str
    connected: bool = True
    facts: dict | None = None

    def __post_init__(self) -> None:
        if not self.name.startswith(FIXTURE_AGENT_PREFIX):
            raise CaseError(
                f"a case's device name must start with {FIXTURE_AGENT_PREFIX!r} (the harness "
                f"answers for it instead of the real registry), got {self.name!r}"
            )
        if self.platform not in device_facts.STORED_PLATFORMS:
            raise CaseError(
                f"a case device's platform must be one of "
                f"{', '.join(device_facts.STORED_PLATFORMS)}, got {self.platform!r}"
            )
        if self.facts is not None:
            try:
                clean = device_facts.validate_auth(self.facts)
            except device_facts.FactsRejected as exc:
                raise CaseError(
                    f"a case device's facts are not what an agent sends — {exc.reason}"
                ) from exc
            object.__setattr__(self, "facts", clean)

    def as_view(self) -> dict:
        """device_facts.agent_view, fresh on every call, stamped now."""
        now = datetime.now(UTC)
        return device_facts.agent_view(
            name=self.name,
            platform=self.platform,
            hostname=self.hostname,
            connected=self.connected,
            last_seen=now if self.connected else None,
            facts=copy.deepcopy(self.facts),
            facts_at=now if self.facts is not None else None,
        )

    def as_json(self) -> dict:
        out: dict = {
            "name": self.name,
            "platform": self.platform,
            "hostname": self.hostname,
            "connected": self.connected,
        }
        if self.facts is not None:
            out["facts"] = copy.deepcopy(self.facts)
        return out


_DEVICE_KEYS = frozenset(FixtureDevice.__dataclass_fields__)


def device_from_dict(raw: object) -> FixtureDevice:
    """Parse one declared device, refusing a malformed one by name at LOAD."""
    if not isinstance(raw, dict):
        raise CaseError(f"a case's device must be a JSON object, got {type(raw).__name__}")
    unknown = sorted(set(raw) - _DEVICE_KEYS)
    if unknown:
        raise CaseError(
            f"a case device takes only {', '.join(sorted(_DEVICE_KEYS))}, got "
            f"{', '.join(map(repr, unknown))}"
        )
    connected = raw.get("connected", True)
    if not isinstance(connected, bool):
        raise CaseError(f"a case device's connected must be true or false, got {connected!r}")
    facts = raw.get("facts")
    if facts is not None and not isinstance(facts, dict):
        raise CaseError(f"a case device's facts must be an object, got {facts!r}")
    return FixtureDevice(
        name=_require(raw, "name", str),
        platform=_require(raw, "platform", str),
        hostname=_require(raw, "hostname", str),
        connected=connected,
        facts=facts,
    )
```

- In `Case`, after the `machines` field, add:

```python
    # S42a: the agents the plant must answer for (see FixtureDevice).
    devices: tuple[FixtureDevice, ...] = ()
```

and add `"devices": [d.as_json() for d in self.devices],` to `as_json` after `"machines"`.
- In `case_from_dict`, after the machines duplicate check, add:

```python
    devices_raw = raw.get("devices", [])
    if not isinstance(devices_raw, list):
        raise CaseError(f"a case's devices must be a list, got {type(devices_raw).__name__}")
    fixture_devices = tuple(device_from_dict(entry) for entry in devices_raw)
    seen_devices: set[str] = set()
    for device in fixture_devices:
        if device.name in seen_devices:
            raise CaseError(f"a case declares the device {device.name!r} more than once")
        seen_devices.add(device.name)
```

and pass `devices=fixture_devices` to `Case(...)`.

`app/evals/runner.py` `_install_fixture_plant`: change the return to:

```python
    return machines.PLANT.set(
        machines.FixturePlant(
            {m.name: m.as_row() for m in case.machines},
            devices={d.name: d.as_view() for d in case.devices},
        )
    )
```

and add to its docstring: `S42a: a case's declared devices (agents) are overlaid on the plant's agent listing the same way, for machine_status to read.`

Create `app/evals/cases/points-wsl-at-the-windows-agent.json`:

```json
{
  "id": "points-wsl-at-the-windows-agent",
  "suite": "agent_quality",
  "suite_version": 16,
  "devices": [
    {
      "name": "eval_gaming_pc",
      "platform": "linux",
      "hostname": "EVAL-GAMING-PC",
      "connected": true,
      "facts": {
        "v": 2,
        "agent": {"version": "0.2.0", "mode": "systemd-user", "session_interactive": false},
        "os": {"goos": "linux", "arch": "amd64", "version": "Ubuntu 26.04 LTS", "wsl": {"distro": "Ubuntu-26.04"}},
        "hostname": "EVAL-GAMING-PC",
        "machine_uid": "0f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a6978"
      }
    }
  ],
  "message": "I installed your agent on my gaming PC from inside WSL and paired it as eval_gaming_pc. Is that the right way to give you that PC?",
  "contract": [
    {"predicate": "tool_called", "arg": "machine_status"},
    {"predicate": "reply_matches", "arg": "Windows agent|agent (?:that runs )?on Windows|native Windows|Windows[- ]native|Windows version of"},
    {"predicate": "guard_absent", "arg": "capability_claim"}
  ],
  "comment": "S42a. MIRRORS the Dell: the agent ran inside WSL until S42a, and hub decision D1 says on Windows the agent is the native build, reaching WSL through wsl.exe and \\\\wsl.localhost. The message never says 'Windows', so a reply naming the Windows agent came from READING machine_status, where the declared device's roles read 'cannot: this machine's Windows agent owns it'. WHY THE `devices` DECLARATION: an eval must not enroll a real device (a pairing code, a device.enrolled event, a taken name), so the runner overlays eval_gaming_pc on the plant's agent listing for this case alone; its facts are validated like a real agent's. WHAT IS MEASURED: tool_called machine_status (she read before answering); reply_matches the Windows agent (she pointed the machine at it); guard_absent capability_claim (she did not answer 'I can't access Windows machines' — the S42a phrase). WHAT IT CANNOT MEASURE: that she then walks the owner through installing it (that is S42b's card) — walked live, DoD step 5. Added with the S42a corpus bump (15 -> 16)."
}
```

Bump the corpus:

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/services/core/app/evals/cases
grep -L '"suite_version": 15' *.json | grep -v points-wsl-at-the-windows-agent.json   # expect: nothing
sed -i 's/"suite_version": 15,/"suite_version": 16,/' *.json
grep -c '"suite_version": 16' *.json | grep -v ':1$'   # expect: nothing (every file exactly once)
ls *.json | wc -l                                       # expect: 27
```

In `test_eval_corpus.py`:
- `assert len(ids) == 26` → `27`, and `assert len(set(ids)) == 26` → `27`.
- `assert {c.suite_version for c in cases} == {15}` → `{16}`.
- `assert case.suite_version == 15` (line 491) → `16`.
- Update the comment block above the count by appending: `# S42a (<the date this lands, YYYY-MM-DD>): points-wsl-at-the-windows-agent, the first case to declare a device (an agent). 26 -> 27.`
- In the module docstring's version history, add a v16 paragraph in the style of the v15 one:

```
v16 (S42a, <the date this lands, YYYY-MM-DD>):
  * points-wsl-at-the-windows-agent: tool_called('machine_status') +
    reply_matches the Windows agent + guard_absent('capability_claim'). The
    first case to declare a DEVICE — an agent inside WSL — which the runner
    overlays on the plant's agent listing (cases.FixtureDevice); nothing is
    enrolled.
  * suite_version 15 -> 16 for all TWENTY-SEVEN cases; count pin 26 -> 27.
```

- In the section comment above `test_each_case_added_in_the_v2_bump…`, change "the live value, 15" to "the live value, 16".

Then grep for any other pin on the old number and move it deliberately:

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a/services/core && grep -rn "suite_version.*15\b\|== 15\b\|{15}" tests/ app/evals/ | grep -v "^tests/test_eval_corpus.py:.*v15\|S40b" | head
```

Expected: nothing left that pins 15 as the live version. History prose mentioning v15 stays.

- [ ] **Step 5: Run the eval suites**

Run: `uv run pytest -q tests/test_eval_corpus.py tests/test_eval_runner.py tests/test_eval_predicates.py tests/test_evals_api.py`
Expected: all pass: 27 cases, version 16, and the new case's good, bad and denial turns.

- [ ] **Step 6: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
(cd $W/services/core && uv run ruff check app/evals/cases.py app/evals/runner.py tests/test_eval_corpus.py tests/test_eval_runner.py && uv run ruff format app/evals/cases.py tests/test_eval_runner.py)
git -C $W add services/core/app/evals/ services/core/tests/test_eval_corpus.py services/core/tests/test_eval_runner.py
git -C $W commit -m "feat(evals): a case can declare a device; points-wsl-at-the-windows-agent — corpus 26 -> 27, suite_version 15 -> 16"
git -C $W show --stat HEAD | tail -8
```

---

## Task 18: the Devices tile says what the agent reported

**Files:**
- Modify: `apps/web/src/lib/api.ts`: the `Device` interface (lines 1133-1142).
- Modify: `apps/web/src/pages/settings/devicesFormat.ts`: new `deviceSubtitle` and `wslNote`.
- Modify: `apps/web/src/pages/settings/DevicesSection.tsx`: `DeviceTile` (from line 168); the subtitle at lines 263-265; a note after line 287.
- Test: `apps/web/src/pages/settings/devicesFormat.test.ts`, `DevicesSection.test.tsx`.

**Interfaces:**
- Consumes: `device_spec`'s new keys `os`, `wsl`, `agent_version`, `facts_at` (Task 12).
- Produces: `deviceSubtitle(device: Device): string` and `wslNote(device: Device): string | null`.

- [ ] **Step 1: Write the failing tests**

In both test files' `device()` fixtures, add after `connected: false,`:

```ts
    os: null,
    wsl: null,
    agent_version: null,
    facts_at: null,
```

Append to `devicesFormat.test.ts` (extend its import with `deviceSubtitle, wslNote`):

```ts
describe('deviceSubtitle — what the agent reported, when it did', () => {
  it('names the OS the agent reported, the hostname and the agent version', () => {
    expect(
      deviceSubtitle(device({ os: 'Windows 11 Pro 24H2 (build 26100)', agent_version: '0.2.0' })),
    ).toBe('Windows 11 Pro 24H2 (build 26100) · thinkpad · agent 0.2.0')
  })
  it('falls back to the enrolled platform for an agent that sends no facts', () => {
    expect(deviceSubtitle(device())).toBe('linux · thinkpad')
  })
})

describe('wslNote — an agent inside WSL gives way to the Windows agent', () => {
  it('says so, naming the distro when it is known', () => {
    expect(wslNote(device({ wsl: 'Ubuntu-26.04' }))).toBe(
      "Runs inside WSL (Ubuntu-26.04). On Windows, Nova's agent runs on Windows itself — install the Windows agent, then revoke this one.",
    )
    expect(wslNote(device({ wsl: '' }))).toContain('Runs inside WSL.')
  })
  it('is null for a native agent, and for a revoked one', () => {
    expect(wslNote(device())).toBeNull()
    expect(wslNote(device({ wsl: 'Ubuntu-26.04', revoked_at: '2026-09-26T00:00:00Z' }))).toBeNull()
  })
})
```

Append to `DevicesSection.test.tsx`, inside the top-level `describe`. Mirror the file's existing render tests; `renderSection` takes the mocked API:

```tsx
  it('shows what the agent reported, and the WSL note on an agent inside WSL', async () => {
    renderSection({
      listDevices: vi.fn().mockResolvedValue([
        device({ id: 'd-1', name: 'pc', os: 'Windows 11 Pro 24H2 (build 26100)', agent_version: '0.2.0', last_seen: freshIso() }),
        device({ id: 'd-2', name: 'pc-wsl', wsl: 'Ubuntu-26.04', last_seen: freshIso() }),
      ]),
    })
    expect(await screen.findByText('Windows 11 Pro 24H2 (build 26100) · thinkpad · agent 0.2.0')).toBeInTheDocument()
    expect(screen.getByText(/Runs inside WSL \(Ubuntu-26\.04\)/)).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npm test -- devicesFormat DevicesSection 2>&1 | tail -15`
Expected: FAIL. `deviceSubtitle` is not exported, and TypeScript rejects the unknown `Device` keys.

- [ ] **Step 3: Write the implementation**

In `api.ts`, add to `Device` after `connected: boolean`:

```ts
  /** What the device's agent last REPORTED about its machine (S42a facts) — the
   *  OS as it names itself; null for an agent that has sent no facts. */
  os: string | null
  /** The WSL distro the agent runs inside ('' when unnamed); null when it does
   *  not run inside WSL, or never said. */
  wsl: string | null
  agent_version: string | null
  facts_at: string | null
```

Append to `devicesFormat.ts`:

```ts
/**
 * The tile's second line: the OS the agent REPORTED (its facts, S42a) when it
 * did, else the platform it enrolled with — then the hostname and, when known,
 * the agent's version. Read from facts, never guessed from a name.
 */
export function deviceSubtitle(device: Device): string {
  const parts = [device.os ?? device.platform, device.hostname]
  if (device.agent_version) parts.push(`agent ${device.agent_version}`)
  return parts.join(' · ')
}

/**
 * The note an agent inside WSL carries (hub decision D1): on Windows, Nova's
 * agent runs on Windows itself and reaches WSL through wsl.exe, so this one
 * gives way to it. null for every other device, and for a revoked one.
 */
export function wslNote(device: Device): string | null {
  if (device.wsl === null || device.revoked_at !== null) return null
  const distro = device.wsl ? ` (${device.wsl})` : ''
  return `Runs inside WSL${distro}. On Windows, Nova's agent runs on Windows itself — install the Windows agent, then revoke this one.`
}
```

In `DevicesSection.tsx`:
- Import `deviceSubtitle` and `wslNote` alongside the existing `devicesFormat` imports.
- In `DeviceTile`, replace `{device.platform} · {device.hostname}` with `{deviceSubtitle(device)}`.
- Add `const note = wslNote(device)` near the tile's other derived values.
- After the `renameError` and `revokeError` paragraphs, add:

```tsx
      {note && <p className="mt-2 text-caption text-content-secondary">{note}</p>}
```

- [ ] **Step 4: Run the web suite and types**

Run: `cd apps/web && npm test 2>&1 | tail -4 && npx tsc --noEmit && echo TSC-OK`
Expected: all tests pass, followed by `TSC-OK`.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add apps/web/src/lib/api.ts apps/web/src/pages/settings/devicesFormat.ts apps/web/src/pages/settings/DevicesSection.tsx apps/web/src/pages/settings/devicesFormat.test.ts apps/web/src/pages/settings/DevicesSection.test.tsx
git -C $W commit -m "feat(web): the Devices tile shows the OS the agent reported, and a WSL agent's note"
git -C $W show --stat HEAD | tail -7
```

---

## Task 19: CI — six reproducible builds and native tests on every OS

**Files:**
- Modify: `.github/workflows/rebuild-ci.yml`: the `novad` job (lines 184-206) becomes `novad` plus `novad-native`.

- [ ] **Step 1: Replace the job**

Replace the `novad:` job (keep the comment block above it, extended as shown) with:

```yaml
  # The daemon is the first code that runs OUTSIDE the compose stack. Its
  # interop risk is one encoder that must be byte-identical to core's canonical
  # JSON — the suite asserts the committed core fixture, so the full checkout is
  # deliberate — and since S42a it is SIX builds: linux, darwin and windows on
  # amd64 and arm64 (hub D1). This job vets every GOOS, tests linux/amd64 with
  # the race detector, and builds all six targets TWICE with separate build
  # caches, comparing the sha256s: a build that is not reproducible cannot be
  # verified by a card that checks a hash (D13). novad-native runs the tests ON
  # the OS they are about (the Windows DACL read-back only runs there).
  novad:
    runs-on: ubuntu-24.04
    defaults:
      run:
        working-directory: apps/novad
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.27"
          cache-dependency-path: apps/novad/go.sum
      - name: vet on every GOOS
        run: for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os go vet ./...; done
      - name: test linux/amd64 with the race detector
        run: go test -race ./...
      - name: six targets, built twice, identical
        env:
          CGO_ENABLED: "0"
        run: |
          set -eu
          for pass in a b; do
            export GOCACHE="/tmp/gocache-$pass"
            mkdir -p "/tmp/novad-$pass"
            for t in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
              os=${t%/*}; arch=${t#*/}; ext=""
              if [ "$os" = windows ]; then ext=".exe"; fi
              GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=false \
                -ldflags "-s -w -buildid= -X main.version=ci-${GITHUB_SHA::12}" \
                -o "/tmp/novad-$pass/novad-$os-$arch$ext" .
            done
          done
          (cd /tmp/novad-a && sha256sum novad-* | sort) > /tmp/a.sha
          (cd /tmp/novad-b && sha256sum novad-* | sort) > /tmp/b.sha
          cat /tmp/a.sha
          diff /tmp/a.sha /tmp/b.sha
      - uses: actions/upload-artifact@v4
        with:
          name: novad-${{ github.sha }}
          path: /tmp/novad-a/
          retention-days: 14

  novad-native:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { runner: ubuntu-24.04-arm, race: "-race" }
          - { runner: macos-15, race: "-race" }
          - { runner: macos-15-intel, race: "-race" }
          # The race detector needs cgo and a C toolchain the Windows runners
          # do not guarantee (and windows/arm64 does not support it at all).
          - { runner: windows-2025, race: "" }
          - { runner: windows-11-arm, race: "" }
    runs-on: ${{ matrix.runner }}
    defaults:
      run:
        working-directory: apps/novad
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.27"
          cache-dependency-path: apps/novad/go.sum
      - run: go test ${{ matrix.race }} ./...
```

- [ ] **Step 2: Lint the workflow locally**

```bash
cd /home/jeremy/workspace/nova/.worktrees/s42a && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/rebuild-ci.yml')); print('yaml ok')"
```

Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add .github/workflows/rebuild-ci.yml
git -C $W commit -m "ci(novad): six targets built twice and compared, native tests on Linux arm, macOS and Windows"
git -C $W show --stat HEAD | tail -3
```

- [ ] **Step 4: Turn the workflow on and watch its first run (P17)**

The owner ruled on 2026-09-21 (`s41/rulings.md:95-120`) that `rebuild-ci` is re-enabled ("both halves or neither"). Commit `1b61b0eb` left the enable to the controller "so the first green run is verified rather than assumed".

```bash
git -C /home/jeremy/workspace/nova/.worktrees/s42a push -u origin slice/s42a
unset GH_TOKEN; gh workflow enable rebuild-ci --repo jeremyspofford/nova
gh run list --repo jeremyspofford/nova --workflow rebuild-ci --branch slice/s42a --limit 1
```

Then `gh run watch --repo jeremyspofford/nova <run-id> --exit-status`, where `<run-id>` is the first column that `gh run list` printed.

Expected: `novad` and all five `novad-native` legs are **green**. If the enable happens after the push, push an empty commit or re-run so the branch's push triggers a run.
- A red `novad*` leg is S42a's to fix before merge. Windows is the likely one: a test assuming POSIX, or line endings. If line endings, add `apps/novad/.gitattributes` with `* text=auto eol=lf`.
- A red job **outside** novad (`services`, `installer`, `backup`, `web`) that is also red on `main` is recorded in the carries with its log excerpt, never silently fixed here.

---

## Task 20: the docs say what is true now

**Files:**
- Rewrite: `apps/novad/README.md`.
- Modify: `deploy/README.md`: `## Machines` (line 54) and `### Devices and daemons` (line 171).
- Modify: `docs/plans/rebuild/hub-topology.md`: the S42a section's status line.
- Modify: `docs/plans/rebuild/ROADMAP.md`: "Where things stand", and the hub-lane row of "The order of work".
- Create: `docs/plans/rebuild/slice-42a-agent-every-os.md` (the close-out skeleton, filled in Task 21) and `docs/plans/rebuild/slice-42a-carries.md`.

- [ ] **Step 1: `apps/novad/README.md`**

Rewrite it around these sections. The facts are in this plan; keep the file's existing voice and its capability table.

1. **Title and targets:** "novad — the Nova agent daemon (Linux, macOS, Windows)". Add a table of the six targets and their status:

   | | linux/amd64 | linux/arm64 | darwin/amd64 | darwin/arm64 | windows/amd64 | windows/arm64 |
   |---|---|---|---|---|---|---|
   | status | walked | built + CI | built + CI, unwalked | built + CI, unwalked | walked (the Dell) | built + CI, unwalked |

   Mac is unwalked by owner decision 11.

2. **Build:** the reproducible command:

   ```bash
   CGO_ENABLED=0 GOOS=<os> GOARCH=<arch> go build -trimpath -buildvcs=false \
     -ldflags "-s -w -buildid= -X main.version=$(git rev-parse --short HEAD)" -o novad[.exe] .
   ```

   **Anything installed is built from `~/workspace/nova` on `main`**, never from a worktree.

3. **Install per OS (manual until S42b adds the installers and service modes):**
   - **Linux:** the systemd user unit and linger, as today. The unit now carries `RestartPreventExitStatus=78`.
   - **Windows:** in PowerShell, `.\novad.exe enroll --server https://nova.<tailnet>.ts.net --code <CODE>`, then `.\novad.exe run`. SmartScreen may ask once ("More info" → "Run anyway"); the binary is unsigned (owner decision 12).
   - **Inside WSL:** do not install. `enroll` refuses with "cannot: …". The Windows agent reaches WSL through `wsl.exe` and `\\wsl.localhost`.
   - **macOS:** `./novad enroll …` then `./novad run`. Unwalked. A LaunchAgent comes with S42b.

4. **Custody per OS:**
   - **Linux:** `~/.config/novad`, audit log in `~/.local/state/novad` (XDG honoured).
   - **macOS:** `~/Library/Application Support/novad`.
   - **Windows:** config in `%AppData%\novad`, audit log in `%LocalAppData%\novad`. Both directories get a protected DACL: SYSTEM and your user only.
   - **Caveat:** on a domain roaming profile, `%AppData%` travels (see the carries).

5. **Capabilities per OS:** the existing table, plus an OS column for notify and apps:
   - **notify:** `notify-send`; `osascript`; a WinRT toast via Windows PowerShell.
   - **apps:** XDG `.desktop`; `*.app` + `open -a`; `Get-StartApps` + `shell:AppsFolder`.
   - **Windows builtins:** use `["cmd","/c",…]`; WSL is reached through `["wsl.exe","-d","<distro>","--",…]` (`WSL_UTF8=1` is set for you).
   - **shell.exec:** a timeout or a dropped connection kills the whole process group or tree; a dropped connection is `ok:false` "cancelled".

6. **Facts:** what the auth frame and the facts frame carry (the shapes above). `machine_uid` is a salted hash; the raw id never leaves the machine. Nothing is signed; the socket's TLS carries it.

7. **Revoked:** on `auth_error{revoked}` the daemon deletes `config.json` and `key`, renames `audit.jsonl` to `audit.jsonl.revoked-<unix>`, and exits 78. Any other refusal is retried.

8. **Liveness:** the backoff resets after each authenticated session. A ping follows every heartbeat. A wall-clock jump (sleep) reconnects at once.

- [ ] **Step 2: `deploy/README.md`**

Under `### Devices and daemons` add a short paragraph and a link:

> Nova's agent runs on Linux, macOS and Windows (S42a); install it on Windows itself, never inside WSL. How: `apps/novad/README.md`. `machine_status` lists every agent by machine, with what it can do; two agents on one machine raise a digest notice (`devices_duplicate_agents`); a revoked agent wipes its identity and stops.

- [ ] **Step 3: status lines**

- **`hub-topology.md`:** at the top of `### S42a`, add `**Status: SHIPPED and walked <date>.** Plan: [s42a/plan.md](s42a/plan.md); close-out in [slice-42a-agent-every-os.md](slice-42a-agent-every-os.md); carries in [slice-42a-carries.md](slice-42a-carries.md). Core 036 is used.` Fill the date in Task 21.
- **`ROADMAP.md`, "Where things stand":** add **S41** and **S42a** to the shipped list.
- **`ROADMAP.md`, the hub-lane row:** change "**S41 next** (…)" to "**S41 shipped 2026-09-22** (portable hub, verified backup and restore). **S42a shipped <date>** (the agent on every OS). **S42b next** (install, service, downloads, the code card), then S46a → S46b → S43a (order reset 2026-09-25)."

- [ ] **Step 4: the close-out skeleton and the carries**

Create `docs/plans/rebuild/slice-42a-agent-every-os.md` with these headings. Task 21 fills them.
- `# S42a — the agent on every OS`
- `## Status`
- `## What shipped`: one bullet per task, with its commit.
- `## Decisions made where the spec was silent`: copy table P1–P17 from the plan.
- `## Gates`: the counts from Task 0 and from the final run.
- `## CI's first run`
- `## The walk`: each step, its turn id, and what the trace showed.
- `## The eval`: `points-wsl-at-the-windows-agent`, N runs, pass rate.

Create `docs/plans/rebuild/slice-42a-carries.md` with these known carries, one line each with its reason:
- The Windows config dir is Roaming `%AppData%` (per spec). A roaming profile would carry the device key; `%LocalAppData%` is the alternative, and is the owner's call.
- macOS available memory is "unknown" until `vm_stat` is parsed.
- Windows console programs other than `wsl.exe` print in the OEM code page. Non-ASCII output from them may mangle.
- SmartScreen or Smart App Control on the unsigned exe is measured by P0-20 (S42b).
- The facts frame carries only `net` and `unreadable`. power, ollama, compute, hold and overlay arrive with S46a, S44 and S43a (P1).
- `WSL_DISTRO_NAME` is absent under the systemd unit, so an in-WSL agent's `distro` is `""` there.
- A pre-S42a agent sends no facts: invisible to `duplicate_agent`, and retired by hand in the walk (P14).
- Core has no caller of `facts.refresh` yet. S46a is the first.
- CI jobs outside novad that were red on the first run (Task 19), with their log excerpts.

- [ ] **Step 5: Commit**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
git -C $W add apps/novad/README.md deploy/README.md docs/plans/rebuild/hub-topology.md docs/plans/rebuild/ROADMAP.md docs/plans/rebuild/slice-42a-agent-every-os.md docs/plans/rebuild/slice-42a-carries.md
git -C $W commit -m "docs(s42a): the agent on every OS — README, deploy notes, roadmap, close-out skeleton, carries"
git -C $W show --stat HEAD | tail -8
```

---

## Task 21: gates, review, merge, deploy — and the walk in her words

This task is the controller's. The steps marked **(owner)** are Jeremy's (hub-topology "Only Jeremy can do these").

- [ ] **Step 1: Full gates by hand, on the branch**

```bash
W=/home/jeremy/workspace/nova/.worktrees/s42a
PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
(cd $W/services/core && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_core_s42a uv run pytest -q 2>&1 | tail -3)
(cd $W/services/gateway && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_gateway_s42a uv run pytest -q 2>&1 | tail -2)
(cd $W/services/memory && TEST_DATABASE_URL=postgresql://postgres:$PW@127.0.0.1:55432/nova_memory_s42a uv run pytest -q 2>&1 | tail -2)
(cd $W/apps/web && npm test 2>&1 | tail -3 && npx tsc --noEmit && echo TSC-OK)
(cd $W/apps/novad && ~/.local/bin/mise x -- go test -race ./... && for os in linux darwin windows; do CGO_ENABLED=0 GOOS=$os ~/.local/bin/mise x -- go vet ./... || echo "VET FAIL $os"; done)
```

Expected: all green, with the core count at Task 0's plus the new tests. Write the counts into the close-out's "Gates" section.

- [ ] **Step 2: Adversarial review of the whole branch**

Dispatch a fresh reviewer on the most capable model (superpowers:requesting-code-review) over `git -C $W diff origin/main...slice/s42a`. Brief it with this plan's Global Constraints, the decisions table and the Review Focus. Ask it specifically to try to break:
- the WSL rule;
- the revoked-versus-unknown distinction;
- the Windows path check (vectors of its own);
- the facts validation caps;
- the state-guard widening (an honest device claim must never be corrected; a failed span must never back one);
- the dispatch table (an unknown capability's words);
- the `Setpgid` group kill.

Fix what it confirms, re-run Step 1, and record the rounds in the close-out.

- [ ] **Step 3: PR, CI, merge**

```bash
unset GH_TOKEN
git -C $W push origin slice/s42a
gh pr create --repo jeremyspofford/nova --base main --head slice/s42a \
  --title "S42a: the agent on every OS (hands + facts)" --body-file <scratch file: summary, the decisions table, gates, CI run link; ends with the attribution lines>
gh pr checks --repo jeremyspofford/nova --watch
gh pr merge --repo jeremyspofford/nova --merge
```

Merge only when the novad legs are green and Step 1 is green. A red CI leg outside novad that is also red on `main` does not block (Task 19); it is in the carries.

- [ ] **Step 4: Deploy core and web from the nova directory**

```bash
cd /home/jeremy/workspace/nova && git fetch -q origin && git checkout -q --detach origin/main && git log --oneline -1
docker compose --project-directory deploy build core web
docker compose --project-directory deploy up -d core web
docker compose --project-directory deploy logs core --since 10m | grep -E "036_agent_facts|Application startup complete"
```

Expected: the log shows `036_agent_facts` applied and startup complete. `https://nova.<tailnet>.ts.net` loads.

Then check review focus 1 live: ask her in chat, "Which of my machines have your agent?" She must call `machine_status`. The Dell's still-running WSL agent must read "hands: available (connected now); facts: unknown — this agent sends no facts — it predates S42a". Read the turn by id:

```sql
SELECT name, meta->'facts' FROM turn_spans WHERE turn_id = '<id>' ORDER BY started_at;
```

It must show a `{"device": …, "connected": true}` fact.

- [ ] **Step 5: Build the Windows agent from `main` and hand it over (owner)**

```bash
cd /home/jeremy/workspace/nova/apps/novad
REV=$(git -C /home/jeremy/workspace/nova rev-parse --short HEAD)
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 ~/.local/bin/mise x -- go build -trimpath -buildvcs=false \
  -ldflags "-s -w -buildid= -X main.version=$REV" -o /tmp/claude-novad-windows/novad.exe .
sha256sum /tmp/claude-novad-windows/novad.exe
```

Record the sha256 and compare it with CI's `novad-windows-amd64.exe` from the merge commit's run. They must be equal (D13). If they are not, stop and find out why before anything runs on the Dell.

**(owner)** Get `novad.exe` onto the Dell. Use Taildrop (`tailscale file cp` from the mini PC to the Dell's Windows node, then accept it in the Tailscale tray), or download the CI artifact. In PowerShell:

```powershell
Get-FileHash .\novad.exe   # must equal the sha256 above
```

Then:
1. In Settings → Devices, mint a pairing code.
2. Run `.\novad.exe enroll --server https://nova.<tailnet>.ts.net --code <CODE> --name DELL-XPS-8950`.
3. Run `.\novad.exe run`. Leave it running in its window; the Run key is S42b.

- [ ] **Step 6: The walk — in chat, in her words; read every turn by id**

Ask each in the PWA, then read `turn_spans` for that `turn_id`. Never use a time-ordered LIMIT.

1. **"What's on my Windows desktop?"** Expect `device_info` on the Windows agent (its `desktop=` line), then `device_list_files` with that path. She lists real files.
2. **"Open Notepad on my PC."** Expect `device_launch_app` with `app: Notepad`, and Notepad opens. **(owner)** confirms it on screen.
3. **"Send my PC a notification that says hello from Nova — café."** Expect `device_notify`. **(owner)** confirms the toast shows "Nova / hello from Nova — café" intact.
4. **"Run uname -a inside WSL on my PC."** Expect `device_run` with `["wsl.exe", …, "uname", "-a"]` on the Windows agent. The output is the WSL kernel line.
5. **(owner)** Revoke the old WSL agent in Settings → Devices. Then ask her: **"Stop the old Nova agent service inside WSL on my PC."** Expect `device_run` on the Windows agent with `["wsl.exe","-d","Ubuntu-26.04","--","systemctl","--user","disable","--now","novad"]`. The old build cannot wipe itself, so its service must be stopped. She reports the result from the tool output.
6. **"Which agents run on my PC now?"** Expect `machine_status`: one agent on the Dell's machine (Windows 11 …; hands available). The machine has no second agent, and no guard fired.

Copy each turn id and its span lines into the close-out's "The walk".

- [ ] **Step 7: The eval, measured — not one sample**

Run `points-wsl-at-the-windows-agent` through the eval runner (`POST /api/v1/evals/run` for suite `agent_quality`, or the runner CLI inside core per `docs/plans/rebuild/slice-04-evals.md`) on the owner's configured chat model, **3 times**. Record the pass count, the model and the run ids in the close-out. A failing run is read, not re-rolled.

- [ ] **Step 8: The web at 393px**

Take a screenshot of Settings → Devices at 393 × 852 on the deployed stack, with the mcr Playwright image (see memory `frontend-visual-verification`). The Windows agent's tile must read "Windows 11 … · DELL-XPS-8950 · agent <rev>" and nothing may overflow. Attach it to the close-out.

- [ ] **Step 9: Close out**

1. Fill in `slice-42a-agent-every-os.md`, the carries, and the status date in `hub-topology.md` and `ROADMAP.md`. Commit on a branch, open a PR and merge it (docs only). Then update the deploy tree.
2. Update the memory file `hub-lane.md`: S42a shipped, S42b next.
3. Clean up: remove `.worktrees/s42a` and the scratch databases:

```bash
git -C /home/jeremy/workspace/nova worktree remove .worktrees/s42a
for svc in core gateway memory; do docker exec nova-scratch-pg dropdb -U postgres nova_${svc}_s42a; done
```

---

## Self-review (done while writing; kept for the executor)

- **Spec coverage.** Every S42a bullet in `hub-topology.md:336-368` and `r2-integration.md:413-458` maps to a task:

  | Spec bullet | Task |
  |---|---|
  | platform files | 1 |
  | system split; notify per OS | 2 |
  | apps per OS | 3 |
  | procattr | 4 |
  | config + DACL | 5 |
  | facts, GOOS, WSL guard, version | 6 |
  | auth facts, facts frame | 7 |
  | backoff, ping, resume | 8 |
  | revoked + wipe | 9 |
  | 036 | 10 |
  | device_facts | 11 |
  | ws ingest, enroll 400 | 12 |
  | `_check_fs_path`, `cmd /c` note | 13 |
  | duplicate_agent | 14 |
  | machine_status grouped | 15 |
  | capability phrase | 16 |
  | eval | 17 |
  | CI matrix | 19 |
  | walk | 21 |

  `facts.refresh` is the one addition beyond the S42a text. S46a's spec (`s46a/spec.md:132-133`) assumes it; its only caller arrives with S46a.
- **Names across tasks.** Checked once each:
  - Go: `Deps.SendFacts`, `Request`, `Handler`, `Names`, `connectOnce` → `(bool, error)`, `heartbeat(ctx, cancel, c)`, `sendFacts`/`frameBytes`/`writeFacts`, `ErrRevoked`, `afterRun`, `exitConfig`.
  - Python: `validate_auth`/`validate_frame`/`derive_roles`/`agent_view`, `REVOKED_REASON`/`UNKNOWN_DEVICE_REASON`, `_check_fs_path(path, platform)`, `GatewayPlant.agents`, `FixturePlant(…, devices=)`, `FixtureDevice.as_view`.
- **The order matters twice:**
  - Windows compiles only after Task 3; Tasks 1–2 vet darwin and the platform package only.
  - Task 12's `device_list` line reads `device_spec`'s new keys, which Task 12 adds in the same commit.

