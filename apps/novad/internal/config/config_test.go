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
		ConfigDir:     filepath.Join(home, ".config", "novad"),
		StateDir:      filepath.Join(home, ".local", "state", "novad"),
		ConfigFile:    filepath.Join(home, ".config", "novad", "config.json"),
		KeyFile:       filepath.Join(home, ".config", "novad", "key"),
		DenyRootsFile: filepath.Join(home, ".config", "novad", "deny_roots"),
		AuditFile:     filepath.Join(home, ".local", "state", "novad", "audit.jsonl"),
		Home:          home,
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

func TestDenyRootsFileIsCreatedWithDefaults(t *testing.T) {
	p := testPaths(t)
	dl, err := LoadDenyRoots(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.DenyRootsFile); err != nil {
		t.Errorf("deny_roots file was not created: %v", err)
	}
	// Every default must be present.
	roots := map[string]bool{}
	for _, r := range dl.Roots() {
		roots[r] = true
	}
	for _, want := range DefaultDenyRoots(p) {
		if !roots[want] {
			t.Errorf("default deny root missing: %s", want)
		}
	}
}

func TestForbidsProtectsSshAndCustodyDirs(t *testing.T) {
	p := testPaths(t)
	dl, err := LoadDenyRoots(p)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		path   string
		forbid bool
	}{
		{filepath.Join(p.Home, ".ssh"), true},
		{filepath.Join(p.Home, ".ssh", "id_ed25519"), true},
		{filepath.Join(p.Home, ".gnupg", "secring.gpg"), true},
		{p.KeyFile, true},   // under ConfigDir
		{p.AuditFile, true}, // under StateDir
		{filepath.Join(p.Home, "notes.txt"), false},
		{filepath.Join(p.Home, ".ssh-notes"), false}, // sibling prefix, NOT under .ssh
	}
	for _, c := range cases {
		got, reason := dl.Forbids(c.path)
		if got != c.forbid {
			t.Errorf("Forbids(%q) = %v (%s), want %v", c.path, got, reason, c.forbid)
		}
	}
}

func TestForbidsCatchesADotDotEscape(t *testing.T) {
	p := testPaths(t)
	dl, err := LoadDenyRoots(p)
	if err != nil {
		t.Fatal(err)
	}
	// A path that lexically climbs back into ~/.ssh.
	escape := filepath.Join(p.Home, "safe", "..", ".ssh", "id_ed25519")
	if forbid, _ := dl.Forbids(escape); !forbid {
		t.Errorf("a ..-escape into ~/.ssh must be refused: %s", escape)
	}
}

func TestForbidsCatchesASymlinkedParent(t *testing.T) {
	p := testPaths(t)
	dl, err := LoadDenyRoots(p)
	if err != nil {
		t.Fatal(err)
	}
	// Make ~/.ssh real, then a symlink ~/link -> ~/.ssh; a write to
	// ~/link/authorized_keys must be refused via the resolved parent.
	ssh := filepath.Join(p.Home, ".ssh")
	if err := os.MkdirAll(ssh, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(p.Home, "link")
	if err := os.Symlink(ssh, link); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(link, "authorized_keys") // does not exist yet
	if forbid, reason := dl.Forbids(target); !forbid {
		t.Errorf("a symlinked parent into ~/.ssh must be refused (%s): %s", reason, target)
	}
}
