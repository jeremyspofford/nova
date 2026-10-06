package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"novad/internal/client"
	"novad/internal/config"
	"novad/internal/install"
	"novad/internal/platform"
	"novad/internal/state"
	"novad/internal/supervise"
)

// The enroll body is identity only: the pairing code plus what this machine
// will be known by. There is no per-device grant, root or home_dir to seed on
// core's side — a paired device runs whatever core signs. A field added here
// would be the first step back toward a settings row core has to approve, so
// the exact key set is pinned.
func TestEnrollBodyCarriesIdentityOnly(t *testing.T) {
	raw, err := enrollBody("A1B2C3D4", "ab"+"cd", "laptop", "thinkpad")
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]string
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"code":     "A1B2C3D4",
		"pubkey":   "abcd",
		"name":     "laptop",
		"platform": runtime.GOOS,
		"hostname": "thinkpad",
	}
	for k, v := range want {
		if body[k] != v {
			t.Errorf("enroll body[%q] = %q, want %q", k, body[k], v)
		}
	}
	if len(body) != len(want) {
		t.Errorf("enroll body has %d keys, want %d: %v", len(body), len(want), body)
	}
	if _, present := body["home_dir"]; present {
		t.Error("home_dir is gone with the fs-roots suggestion it fed; the enroll body must not carry it")
	}
}

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

// P5 / Review focus 5: a revoke wipes the identity and afterRun says so, at
// exit 78 — never 1 — so RestartPreventExitStatus=78 stops the supervisor
// from looping on a device that can never get back in.
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
// Fix round 1, folded-in item: the directive must be an ACTIVE line inside
// [Service] — not merely somewhere in the file's bytes, where a comment
// naming it (novad.service carries one) or a line in the wrong section would
// pass a bare substring check without the directive doing anything.
//
// S42b (Task 8): supervise, not `novad run`, is now the parent ExecStart
// starts, and P3 moves the restart-suppression itself onto Restart=on-failure
// (supervise exits 0 — not a systemd "failure" — when the agent can never get
// in), with RestartPreventExitStatus=78 kept as a second line of defense for
// an agent from before S42b that a hand-written unit still runs directly. Both
// new checks stay in this test's own section-aware style — never a bare
// strings.Contains over the whole file — so the same "wrong section, or just
// a comment" false pass this test was written to close cannot reopen for
// them.
func TestTheServiceUnitDoesNotRestartARevokedDevice(t *testing.T) {
	body, err := os.ReadFile("novad.service")
	if err != nil {
		t.Fatal(err)
	}
	section := ""
	foundPreventExit := false
	foundExecStartsSupervise := false
	foundRestartOnFailure := false
	for _, line := range strings.Split(string(body), "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]"):
			section = trimmed
		case trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";"):
			// blank or comment: not an active directive
		case section == "[Service]" && trimmed == "RestartPreventExitStatus=78":
			foundPreventExit = true
		case section == "[Service]" && strings.HasPrefix(trimmed, "ExecStart=") && strings.HasSuffix(trimmed, "supervise --mode systemd-user"):
			foundExecStartsSupervise = true
		case section == "[Service]" && trimmed == "Restart=on-failure":
			foundRestartOnFailure = true
		}
	}
	if !foundPreventExit {
		t.Fatal("novad.service must carry an ACTIVE RestartPreventExitStatus=78 line inside [Service] (exitConfig) — not merely the text somewhere in the file")
	}
	if !foundExecStartsSupervise {
		t.Errorf("novad.service must carry an ACTIVE ExecStart line inside [Service] that starts supervise --mode systemd-user:\n%s", body)
	}
	if !foundRestartOnFailure {
		t.Errorf("novad.service must carry an ACTIVE Restart=on-failure line inside [Service] — Restart=always would restart a supervisor that stopped for good:\n%s", body)
	}
}

// Self-review requirement on this task: a wipe that only PARTLY succeeds
// must still exit 78, never 1 — restarting cannot help either way, because
// core will refuse this same device again at the very next handshake, and
// the message must say what could NOT be removed rather than claim a clean
// wipe. ConfigFile is pointed at a non-empty directory so os.Remove fails
// deterministically regardless of the user running the test (a permission
// bit would not fail for root, a non-empty directory always does).
func TestAfterRunKeepsExit78EvenWhenTheWipeOnlyPartlySucceeds(t *testing.T) {
	home := t.TempDir()
	configFile := filepath.Join(home, "config-is-a-dir")
	if err := os.MkdirAll(configFile, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configFile, "child"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := config.Paths{
		ConfigDir:  home,
		StateDir:   home,
		ConfigFile: configFile,
		KeyFile:    filepath.Join(home, "key-never-existed"),
		AuditFile:  filepath.Join(home, "audit-never-existed.jsonl"),
		Home:       home,
	}
	code, msg := afterRun(p, client.ErrRevoked, time.Now())
	if code != 78 {
		t.Fatalf("a partly-failed wipe must still exit 78 (restarting cannot help), got %d: %q", code, msg)
	}
	if !strings.Contains(msg, "failed") {
		t.Fatalf("the message must say the wipe failed, got %q", msg)
	}
	if strings.Contains(msg, "its identity is wiped") {
		t.Fatalf("a partly-failed wipe must never be reported as a clean wipe, got %q", msg)
	}
}

// TestAfterFailedWipeNamesOnlyWhatIsStillThere moved to main_unix_test.go
// (CI follow-up): its ENOTDIR fault-injection technique is Unix-only — see
// that file's comment for why, and main_windows_test.go for the Windows
// twin.

// Fix round 1, folded-in item: the success message must say the audit log
// was set aside ONLY when one existed, and must name where it went — never
// a blanket claim (a device that never ran has no audit.jsonl at all) or
// something unverifiable (which of possibly several audit.jsonl.revoked-*
// names is THIS wipe's).
func TestAfterRunNamesWhereTheAuditLogWentOnlyWhenOneExisted(t *testing.T) {
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
	if err := os.WriteFile(p.AuditFile, []byte(`{"seq":0}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	wantAside := p.AuditFile + ".revoked-1790000001"
	_, msg := afterRun(p, client.ErrRevoked, time.Unix(1790000001, 0))
	if !strings.Contains(msg, wantAside) {
		t.Fatalf("the message must name where the audit log went (%s), got %q", wantAside, msg)
	}
	if _, err := os.Stat(wantAside); err != nil {
		t.Fatalf("the audit log was not actually renamed to %s: %v", wantAside, err)
	}

	// A device that never ran: no audit.jsonl was ever created.
	home2 := t.TempDir()
	p2 := config.Paths{
		ConfigDir: filepath.Join(home2, "c"), StateDir: filepath.Join(home2, "s"),
		ConfigFile: filepath.Join(home2, "c", "config.json"), KeyFile: filepath.Join(home2, "c", "key"),
		AuditFile: filepath.Join(home2, "s", "audit.jsonl"), Home: home2,
	}
	_, priv2, _ := ed25519.GenerateKey(rand.Reader)
	if err := config.Save(p2, config.Config{DeviceID: "d2"}, priv2); err != nil {
		t.Fatal(err)
	}
	_, msg2 := afterRun(p2, client.ErrRevoked, time.Now())
	if strings.Contains(msg2, "audit log") {
		t.Fatalf("no audit log ever existed — the message must not claim one was set aside, got %q", msg2)
	}
}

// TestCheckEnrolledDistinguishesMissingFromAnyOtherError moved to
// main_unix_test.go (CI follow-up): its ENOTDIR fault-injection technique is
// Unix-only — see that file's comment for why, and main_windows_test.go for
// the Windows twin.

func TestStatusLinesSayWhatTheStatusFilesSay(t *testing.T) {
	dir := t.TempDir()
	since := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	exit1 := 1
	for name, v := range map[string]any{
		state.AgentStatusFile:      state.AgentStatus{PID: 7, Version: "0123456789ab", Mode: "run-key", State: state.StateReady, Server: "https://nova.fake-tailnet.ts.net", Since: since},
		state.SupervisorStatusFile: state.SupervisorStatus{PID: 6, Version: "0123456789ab", Restarts: 2, LastExit: &exit1, Since: since},
		state.UpdateFile:           state.Update{Version: "fedcba987654", Outcome: state.UpdateRolledBack, Reason: "the new build did not connect within 2m0s", At: since},
	} {
		if err := state.WriteJSON(filepath.Join(dir, name), v); err != nil {
			t.Fatal(err)
		}
	}
	joined := strings.Join(statusLines(dir), "\n")
	for _, want := range []string{
		"agent:       ready since 2026-09-28T12:00:00Z (pid 7, run-key, build 0123456789ab) via https://nova.fake-tailnet.ts.net",
		"supervisor:  pid 6, 2 restarts, last exit 1",
		"last update: rolled_back fedcba987654 at 2026-09-28T12:00:00Z — the new build did not connect within 2m0s",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in:\n%s", want, joined)
		}
	}
	none := strings.Join(statusLines(t.TempDir()), "\n")
	if none != "agent:       no status yet (it has not run since S42b's build)" {
		t.Errorf("no status file must be said, and nothing else, got:\n%s", none)
	}
}

// Task 32, L61: a status file that is there but cannot be read is said to be
// unreadable, with why — never "no status yet (it has not run since S42b's
// build)", the confident cause of a file that was never written. The
// supervisor's and the update's files are not left out silently either.
func TestAnUnreadableStatusFileIsNeverReadAsOneNeverWritten(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{state.AgentStatusFile, state.SupervisorStatusFile, state.UpdateFile} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("not json\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	joined := strings.Join(statusLines(dir), "\n")
	if strings.Contains(joined, "no status yet") || strings.Contains(joined, "has not run") {
		t.Fatalf("an unreadable status file was read as one never written:\n%s", joined)
	}
	for _, want := range []string{
		"agent:       status unknown — " + filepath.Join(dir, state.AgentStatusFile) + " is unreadable: ",
		"supervisor:  status unknown — " + filepath.Join(dir, state.SupervisorStatusFile) + " is unreadable: ",
		"last update: unknown — " + filepath.Join(dir, state.UpdateFile) + " is unreadable: ",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in:\n%s", want, joined)
		}
	}
}

func TestAStagedUpdateExitsSeventyFiveForTheSupervisor(t *testing.T) {
	code, msg := afterRun(config.Paths{}, client.ErrRestartForUpdate, time.Now())
	if code != exitUpdateStaged || !strings.Contains(msg, "the supervisor") {
		t.Fatalf("afterRun = %d %q", code, msg)
	}
}

// Fix round 1, Minor 1: exitUpdateStaged is named FROM
// supervise.ExitUpdateStaged — the value supervise itself consumes at the
// OS boundary — so a pin on the literal here would never catch it drifting
// from what supervise actually expects.
func TestExitUpdateStagedIsTheSupervisorsOwnConstant(t *testing.T) {
	if exitUpdateStaged != supervise.ExitUpdateStaged {
		t.Fatalf("exitUpdateStaged = %d, supervise.ExitUpdateStaged = %d", exitUpdateStaged, supervise.ExitUpdateStaged)
	}
}

// Fix round 1, Minor 2: main.go used to discard os.Executable's error and
// hand daemon.update a silently empty Binary — surfaced now as a real
// failure at startup instead of a mysterious later refusal.
func TestSelfBinarySurfacesAFailedExecutablePathLookup(t *testing.T) {
	old := executablePath
	t.Cleanup(func() { executablePath = old })

	executablePath = func() (string, error) { return "", errors.New("boom") }
	if _, err := selfBinary(); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("selfBinary() error = %v, want it to surface the underlying failure", err)
	}

	executablePath = func() (string, error) { return "/opt/novad/novad", nil }
	self, err := selfBinary()
	if err != nil || self != "/opt/novad/novad" {
		t.Fatalf("selfBinary() = %q, %v", self, err)
	}
}

func TestInstallExitCodes(t *testing.T) {
	if installExit(nil) != 0 || installExit(fmt.Errorf("x: %w", install.ErrNeedsCode)) != 3 || installExit(errors.New("boom")) != 1 {
		t.Fatal("install exits 0, 3 (a code is needed) or 1")
	}
}

// Controller ruling: the usage names every install flag, --restart-later
// included (P11 runs it; a person reading the usage should find it).
func TestTheUsageNamesTheInstallVerbsAndTheirFlags(t *testing.T) {
	for _, want := range []string{
		"novad install [--hub <url>]... [--code <code>] [--name <name>] [--if-missing] [--restart-later]\n",
		"novad uninstall [--forget]\n",
	} {
		if !strings.Contains(usageText(), want) {
			t.Errorf("the usage is missing %q:\n%s", want, usageText())
		}
	}
}

// Review focus 4: a second copy of one identity is refused by run.lock, and
// when it is the child a supervisor started — the one install's restart
// started — the refusal is written into the agent's status before run fails:
// install waits on that file, and names the holder from it.
func TestARefusedRunLockIsWrittenIntoTheStatusForInstallToName(t *testing.T) {
	t.Setenv(platform.SupervisorEnv, strconv.Itoa(os.Getppid())) // this process is its supervisor's child
	dir := t.TempDir()
	first, err := state.Acquire(filepath.Join(dir, state.RunLockFile))
	if err != nil {
		t.Fatal(err)
	}
	released := false
	t.Cleanup(func() { // a held lock would stop Windows removing dir
		if !released {
			_ = first.Release()
		}
	})
	var said string
	var why error
	record := func(st, _ string, e error) { said, why = st, e }
	if lock, err := holdIdentity(dir, record); err == nil {
		_ = lock.Release()
		t.Fatal("a second holder of the identity must be refused")
	}
	var held *state.HeldError
	if said != state.StateStopped || !errors.As(why, &held) || held.PID != os.Getpid() {
		t.Fatalf("status %q, error %v — the refusal must reach the status, naming the holder", said, why)
	}

	_ = first.Release()
	released = true
	said, why = "", nil
	lock, err := holdIdentity(dir, record)
	if err != nil {
		t.Fatal(err)
	}
	_ = lock.Release()
	if said != "" || why != nil {
		t.Fatalf("a lock that was taken wrote a status: %q %v", said, why)
	}
}

// Fix round 1 (controller ruling; P5): agent-status.json is the running
// holder's. Supervise's swap confirmation and install --if-missing decide on
// it, so a copy started by hand that is refused the lock writes NOTHING
// there — its refusal, naming the holder's pid, is on its own stderr. That
// holds for a copy started from a terminal, and for one started through the
// agent's own hands, which inherits NOVA_SUPERVISOR_PID but is not that
// supervisor's child. The control proves the same writer does rewrite the
// file for the supervisor's own child, so the byte-identical check is not
// vacuous.
func TestAHandStartedCopyRefusedTheLockLeavesTheHoldersStatusAlone(t *testing.T) {
	for _, tc := range []struct {
		name, supervisorPID string
	}{
		{"started from a terminal", ""},
		{"started through the agent's hands, the variable inherited", strconv.Itoa(os.Getpid())},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(platform.SupervisorEnv, tc.supervisorPID)
			dir, statusPath := heldIdentity(t)
			before := readFile(t, statusPath)
			lock, err := holdIdentity(dir, agentStatusWriter(dir, log.New(io.Discard, "", 0)))
			if err == nil {
				_ = lock.Release()
				t.Fatal("a second holder of the identity must be refused")
			}
			var held *state.HeldError
			if !errors.As(err, &held) || held.PID != os.Getpid() {
				t.Fatalf("the refusal must name the holder's pid for stderr: %v", err)
			}
			if after := readFile(t, statusPath); !bytes.Equal(before, after) {
				t.Fatalf("a copy started by hand rewrote the holder's status:\nbefore %s\nafter  %s", before, after)
			}
		})
	}

	t.Run("control: the supervisor's own child", func(t *testing.T) {
		t.Setenv(platform.SupervisorEnv, strconv.Itoa(os.Getppid()))
		dir, statusPath := heldIdentity(t)
		before := readFile(t, statusPath)
		if lock, err := holdIdentity(dir, agentStatusWriter(dir, log.New(io.Discard, "", 0))); err == nil {
			_ = lock.Release()
			t.Fatal("a second holder of the identity must be refused")
		}
		var got state.AgentStatus
		if err := state.ReadJSON(statusPath, &got); err != nil {
			t.Fatal(err)
		}
		if bytes.Equal(before, readFile(t, statusPath)) || got.State != state.StateStopped ||
			!strings.Contains(got.Error, fmt.Sprintf("another novad (pid %d)", os.Getpid())) {
			t.Fatalf("the supervisor's child must write its refusal, naming the holder: %+v", got)
		}
	})
}

// heldIdentity is a state dir whose run.lock this test process holds, with
// the holder's own status in it: connected.
func heldIdentity(t *testing.T) (dir, statusPath string) {
	t.Helper()
	dir = t.TempDir()
	first, err := state.Acquire(filepath.Join(dir, state.RunLockFile))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Release() }) // a held lock would stop Windows removing dir
	statusPath = filepath.Join(dir, state.AgentStatusFile)
	holder := state.AgentStatus{V: 1, PID: os.Getpid(), Version: "aaaaaaaaaaaa", Mode: "systemd-user",
		State: state.StateReady, Server: "https://nova.fake-tailnet.ts.net", Since: time.Now().UTC()}
	if err := state.WriteJSON(statusPath, holder); err != nil {
		t.Fatal(err)
	}
	return dir, statusPath
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The code reaches install by --code or NOVA_PAIRING_CODE, and never goes
// further: the variable leaves this process's environment, so no program
// install starts (on Windows the supervisor it starts detached, and every
// command the agent runs after it) inherits it.
func TestThePairingCodeFromTheEnvironmentGoesNoFurther(t *testing.T) {
	t.Setenv(pairingCodeEnv, "ABCD-2345")
	if got := pairingCode(""); got != "ABCD-2345" {
		t.Fatalf("pairingCode = %q", got)
	}
	if v, set := os.LookupEnv(pairingCodeEnv); set {
		t.Fatalf("%s is still in the environment: %q", pairingCodeEnv, v)
	}
	t.Setenv(pairingCodeEnv, "WXYZ-6789")
	if got := pairingCode("ABCD-2345"); got != "ABCD-2345" {
		t.Fatalf("--code must win over the environment, got %q", got)
	}
	if _, set := os.LookupEnv(pairingCodeEnv); set {
		t.Fatalf("%s is still in the environment after --code", pairingCodeEnv)
	}
}
