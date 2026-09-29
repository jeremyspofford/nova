package service

import (
	"fmt"
	"os"
	"testing"

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
	if err := m.Uninstall(nil); err != nil {
		t.Fatal(err)
	}
	if m.Installed() {
		t.Fatal("the value is gone after Uninstall")
	}
}
