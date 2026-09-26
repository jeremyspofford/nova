package caps

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The XDG scan survives its move into apps_linux.go: a .desktop file in the
// data home is listed by id and name, and a NoDisplay one is not.
func TestAppsListReadsTheXDGApplicationsDir(t *testing.T) {
	home := t.TempDir()
	apps := filepath.Join(home, "applications")
	if err := os.MkdirAll(apps, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(apps, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("gedit.desktop", "[Desktop Entry]\nName=Text Editor\nExec=gedit %U\n")
	write("hidden.desktop", "[Desktop Entry]\nName=Hidden\nNoDisplay=true\n")
	t.Setenv("XDG_DATA_HOME", home)
	t.Setenv("XDG_DATA_DIRS", filepath.Join(home, "none"))
	out := appsList(context.Background())
	if !out.OK || !strings.Contains(out.Output, "gedit — Text Editor") || strings.Contains(out.Output, "Hidden") {
		t.Fatalf("got ok=%v %q", out.OK, out.Output)
	}
}
