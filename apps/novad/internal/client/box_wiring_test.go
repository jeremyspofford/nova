//go:build unix

package client

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"novad/internal/box"
	"novad/internal/config"
)

// Every agent gets one box Manager (S32.2 T5): docker and git run for real,
// as the owner this agent runs as.
func TestNewWiresOneBoxManagerPerAgent(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	cfg := config.Config{DeviceID: "dev-box-1", Server: "http://unused.invalid", CorePubKey: hex.EncodeToString(corePub)}
	a, err := New(cfg, devPriv, nil, t.TempDir(), "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	m := a.deps.Box
	if m == nil {
		t.Fatal("the agent has no box manager")
	}
	if m.Docker != (box.ExecRunner{Bin: "docker"}) || m.Git != (box.ExecRunner{Bin: "git"}) {
		t.Fatalf("seams: docker=%#v git=%#v", m.Docker, m.Git)
	}
	if m.UID != os.Getuid() || m.GID != os.Getgid() || m.Now == nil {
		t.Fatalf("uid=%d gid=%d now=%v, want %d:%d and a clock", m.UID, m.GID, m.Now != nil, os.Getuid(), os.Getgid())
	}
	if b, err2 := New(cfg, devPriv, nil, t.TempDir(), "test", nil); err2 != nil || b.deps.Box == m {
		t.Fatalf("two agents share one manager (err %v)", err2)
	}
}
