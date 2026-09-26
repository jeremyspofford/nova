//go:build unix

package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"testing"
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
