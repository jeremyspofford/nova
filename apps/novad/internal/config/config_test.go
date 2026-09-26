package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testPaths(t *testing.T) Paths {
	t.Helper()
	home := t.TempDir()
	return Paths{
		ConfigDir:  filepath.Join(home, ".config", "novad"),
		StateDir:   filepath.Join(home, ".local", "state", "novad"),
		ConfigFile: filepath.Join(home, ".config", "novad", "config.json"),
		KeyFile:    filepath.Join(home, ".config", "novad", "key"),
		AuditFile:  filepath.Join(home, ".local", "state", "novad", "audit.jsonl"),
		Home:       home,
	}
}

func TestSaveThenLoadRoundTripsTheKey(t *testing.T) {
	p := testPaths(t)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{DeviceID: "dev-1", Name: "thinkpad", Server: "https://nova.example", CorePubKey: "abc123"}
	if err := Save(p, cfg, priv); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, gotPriv, err := Load(p)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != cfg {
		t.Errorf("config round-trip differs: %+v vs %+v", got, cfg)
	}
	if !gotPriv.Public().(ed25519.PublicKey).Equal(pub) {
		t.Error("loaded key does not match the saved key")
	}
}

func TestEnrolledReportsPresence(t *testing.T) {
	p := testPaths(t)
	if p.Enrolled() {
		t.Error("a fresh path should not be enrolled")
	}
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := Save(p, Config{DeviceID: "d"}, priv); err != nil {
		t.Fatal(err)
	}
	if !p.Enrolled() {
		t.Error("after Save the path should be enrolled")
	}
}

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
