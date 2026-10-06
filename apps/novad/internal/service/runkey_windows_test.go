package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows/registry"

	"novad/internal/config"
)

// The Run-key write is read back; a scratch key keeps the runner's real Run
// key untouched.
func TestInstallWritesTheRunKeyAndReadsItBack(t *testing.T) {
	scratch := fmt.Sprintf(`Software\NovaTest\Run-%d`, os.Getpid())
	t.Cleanup(func() { _ = registry.DeleteKey(registry.CURRENT_USER, scratch) })
	m := &runKey{paths: config.Paths{StateDir: t.TempDir()}, keyPath: scratch, value: RunKeyValue}
	bin := `C:\Users\Jane Doe\AppData\Local\Programs\Nova\novad.exe`
	if err := m.Install(bin); err != nil {
		t.Fatal(err)
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, scratch, registry.QUERY_VALUE)
	if err != nil {
		t.Fatal(err)
	}
	got, _, err := k.GetStringValue(RunKeyValue)
	k.Close()
	if err != nil || got != RunKeyCommand(bin) {
		t.Fatalf("Run value = %q, %v", got, err)
	}
	if !m.Installed() {
		t.Fatal("Installed after Install")
	}
	if stopErr, err := m.Uninstall(nil); stopErr != nil || err != nil {
		t.Fatalf("stop %v, removal %v", stopErr, err)
	}
	if m.Installed() {
		t.Fatal("the value is gone after Uninstall")
	}
}

// Task 32, L245: the Run key says up front that it can never schedule a
// delayed restart, and RestartLater answers with exactly that refusal.
func TestTheRunKeyRefusesARestartLaterUpFront(t *testing.T) {
	var m Manager = &runKey{paths: config.Paths{StateDir: t.TempDir()}, keyPath: RunKeyPath, value: RunKeyValue}
	r, ok := m.(RestartLaterRefuser)
	if !ok {
		t.Fatal("the Run key must say up front that it cannot restart later")
	}
	refusal := r.RestartLaterRefusal()
	if refusal == nil || !strings.HasPrefix(refusal.Error(), "cannot: ") {
		t.Fatalf("refusal %v", refusal)
	}
	if err := m.RestartLater(context.Background(), time.Second); err == nil || err.Error() != refusal.Error() {
		t.Fatalf("RestartLater = %v, want %v", err, refusal)
	}
}

// Fix round 1, Important 1: Uninstall must not swallow a real OpenKey error
// as "no key, no value" — only errors.Is(err, registry.ErrNotExist) may be
// read that way. A key path with an embedded NUL fails inside OpenKey's own
// UTF-16 conversion, before any registry call is even made — a real,
// deterministic, non-ErrNotExist error on every machine, unlike trying to
// provoke a genuine Win32 registry failure.
func TestUninstallReturnsARealErrorInsteadOfSwallowingIt(t *testing.T) {
	m := &runKey{paths: config.Paths{StateDir: t.TempDir()}, keyPath: "Software\x00Nova", value: RunKeyValue}
	_, err := m.Uninstall(context.Background())
	if err == nil {
		t.Fatal("a real OpenKey error must be returned, not swallowed as \"no key\"")
	}
	if errors.Is(err, registry.ErrNotExist) {
		t.Fatalf("this is not \"the key does not exist\" — got %v", err)
	}
}

// The one case Uninstall MAY still read as "nothing to do": a key that was
// never created (never ErrNotExist's neighbor cases — a real error).
func TestUninstallOnAKeyThatWasNeverCreatedIsFine(t *testing.T) {
	scratch := fmt.Sprintf(`Software\NovaTest\NeverCreated-%d`, os.Getpid())
	m := &runKey{paths: config.Paths{StateDir: t.TempDir()}, keyPath: scratch, value: RunKeyValue}
	if stopErr, err := m.Uninstall(context.Background()); stopErr != nil || err != nil {
		t.Fatalf("a key that was never created must be fine, got stop %v, removal %v", stopErr, err)
	}
}
