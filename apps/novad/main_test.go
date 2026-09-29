package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"novad/internal/client"
	"novad/internal/config"
	"novad/internal/state"
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
func TestTheServiceUnitDoesNotRestartARevokedDevice(t *testing.T) {
	body, err := os.ReadFile("novad.service")
	if err != nil {
		t.Fatal(err)
	}
	section := ""
	found := false
	for _, line := range strings.Split(string(body), "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]"):
			section = trimmed
		case trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";"):
			// blank or comment: not an active directive
		case section == "[Service]" && trimmed == "RestartPreventExitStatus=78":
			found = true
		}
	}
	if !found {
		t.Fatal("novad.service must carry an ACTIVE RestartPreventExitStatus=78 line inside [Service] (exitConfig) — not merely the text somewhere in the file")
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
