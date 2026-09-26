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
func TestTheServiceUnitDoesNotRestartARevokedDevice(t *testing.T) {
	body, err := os.ReadFile("novad.service")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "RestartPreventExitStatus=78") {
		t.Fatal("novad.service must carry RestartPreventExitStatus=78 (exitConfig)")
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
