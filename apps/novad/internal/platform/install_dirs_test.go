package platform

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// P1: the user's own folder, and the admin-only copy S42c's helper will run.
func TestTheInstallDirsAreTheOwnersChoice(t *testing.T) {
	dir, err := InstallDir()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"linux":   filepath.Join(".local", "bin"),
		"darwin":  filepath.Join("Library", "Application Support", "Nova"),
		"windows": filepath.Join("Programs", "Nova"),
	}[runtime.GOOS]
	if !strings.HasSuffix(dir, want) {
		t.Fatalf("InstallDir = %q, want …%s", dir, want)
	}
	admin := map[string]string{
		"linux":   "/usr/local/libexec/nova",
		"darwin":  "/Library/Application Support/Nova",
		"windows": filepath.Join("Nova"),
	}[runtime.GOOS]
	if !strings.HasSuffix(AdminInstallDir(), admin) {
		t.Fatalf("AdminInstallDir = %q, want …%s", AdminInstallDir(), admin)
	}
}
