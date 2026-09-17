package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"
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

func TestKeyFileIs0600AndDirIs0700(t *testing.T) {
	p := testPaths(t)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := Save(p, Config{DeviceID: "d"}, priv); err != nil {
		t.Fatal(err)
	}
	ki, err := os.Stat(p.KeyFile)
	if err != nil {
		t.Fatal(err)
	}
	if ki.Mode().Perm() != 0o600 {
		t.Errorf("key mode = %o, want 600", ki.Mode().Perm())
	}
	di, err := os.Stat(p.ConfigDir)
	if err != nil {
		t.Fatal(err)
	}
	if di.Mode().Perm() != 0o700 {
		t.Errorf("config dir mode = %o, want 700", di.Mode().Perm())
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
