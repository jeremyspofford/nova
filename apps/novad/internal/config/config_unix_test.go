//go:build unix

package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"testing"
	"time"
)

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

// A Wipe that cannot even check whether the audit log is there must fail
// loudly, never report success while the live log stayed exactly where a
// re-enroll would resume and replay it under the new id.
func TestWipeFailsLoudlyWhenTheAuditLogCannotBeChecked(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	p := testPaths(t)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := Save(p, Config{DeviceID: "d"}, priv); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.AuditFile, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p.StateDir, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(p.StateDir, 0o700) })
	if err := Wipe(p, time.Unix(1790000000, 0)); err == nil {
		t.Fatal("Wipe must fail when it cannot check the audit log, not report success")
	}
}
