package config

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
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
	if !reflect.DeepEqual(got, cfg) {
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
	wantAside := p.AuditFile + ".revoked-1790000000"
	gotAside, err := Wipe(p, now)
	if err != nil {
		t.Fatal(err)
	}
	if gotAside != wantAside {
		t.Fatalf("Wipe returned aside path %q, want %q", gotAside, wantAside)
	}
	if p.Enrolled() {
		t.Fatal("after a wipe the device must not be enrolled")
	}
	// Enrolled() is false if EITHER file is missing, so it cannot tell a
	// clean wipe from one that left the other behind — check both by name.
	if _, err := os.Stat(p.ConfigFile); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("config.json must be gone, got err=%v", err)
	}
	if _, err := os.Stat(p.KeyFile); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("key must be gone, got err=%v", err)
	}
	if _, err := os.Stat(p.AuditFile); !os.IsNotExist(err) {
		t.Fatal("the live audit file must be gone")
	}
	aside, err := os.ReadFile(p.AuditFile + ".revoked-1790000000")
	if err != nil || !strings.Contains(string(aside), "{}") {
		t.Fatalf("the audit log must be set aside intact: %q %v", aside, err)
	}
	if secondAside, err := Wipe(p, now); err != nil {
		t.Fatalf("wiping an already-wiped device is not an error: %v", err)
	} else if secondAside != "" {
		t.Fatalf("nothing was live to set aside the second time, got %q", secondAside)
	}
}

// A second wipe in the same unix second (or a set-aside name a previous
// wipe already left behind) must not destroy an earlier set-aside audit
// log: os.Rename REPLACES an existing destination on both Unix and Windows,
// so Wipe must pick a name that does not exist yet.
func TestWipeDoesNotClobberAnExistingSetAside(t *testing.T) {
	p := testPaths(t)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := Save(p, Config{DeviceID: "d"}, priv); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.AuditFile, []byte(`{"live":true}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1790000000, 0)
	existing := p.AuditFile + ".revoked-1790000000"
	priorContent := []byte(`{"earlier":true}` + "\n")
	if err := os.WriteFile(existing, priorContent, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Wipe(p, now); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(existing)
	if err != nil || !bytes.Equal(got, priorContent) {
		t.Fatalf("the earlier set-aside must be byte-identical afterwards: %q %v", got, err)
	}
	moved, err := os.ReadFile(existing + "-1")
	if err != nil || !strings.Contains(string(moved), `"live":true`) {
		t.Fatalf("the live audit log must move to the next free name (-1): %q %v", moved, err)
	}
}

// Task 32, L223: Save rewrites the config and the key on every keep (each
// update), so a write that fails partway — a crash, a full disk — must leave
// the pairing on disk exactly as it was, never a torn config or key that
// even `install --code` cannot read past. Nothing half-written is left
// beside them either.
func TestASaveThatFailsPartwayLeavesThePairingWhole(t *testing.T) {
	p := testPaths(t)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := Save(p, Config{DeviceID: "d1", Name: "laptop", Server: "https://a.example", CorePubKey: strings.Repeat("ab", 32)}, priv); err != nil {
		t.Fatal(err)
	}
	cfgBefore, keyBefore := readFile(t, p.ConfigFile), readFile(t, p.KeyFile)

	was := writeAll
	t.Cleanup(func() { writeAll = was })
	writeAll = func(f *os.File, body []byte) error {
		_, _ = f.Write(body[:len(body)/2])
		return errors.New("no space left on device")
	}
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	if err := Save(p, Config{DeviceID: "d2", Name: "laptop", Server: "https://b.example", CorePubKey: strings.Repeat("cd", 32)}, other); err == nil {
		t.Fatal("a write that failed must be an error")
	}
	if got := readFile(t, p.ConfigFile); !bytes.Equal(got, cfgBefore) {
		t.Fatalf("the config was torn by a failed write:\n%s", got)
	}
	if got := readFile(t, p.KeyFile); !bytes.Equal(got, keyBefore) {
		t.Fatalf("the key was torn by a failed write: %q", got)
	}
	if _, _, err := Load(p); err != nil {
		t.Fatalf("the pairing no longer loads: %v", err)
	}
	entries, err := os.ReadDir(p.ConfigDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != "config.json" && e.Name() != "key" {
			t.Errorf("left behind beside the pairing: %s", e.Name())
		}
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

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
