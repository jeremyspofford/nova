package caps

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"novad/internal/state"
)

func distName() string {
	n := "novad-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		n += ".exe"
	}
	return n
}

func hubServing(t *testing.T, build []byte) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agent/dist/"+distName(), func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(build) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

func updateDeps(t *testing.T, base string, supervised bool) *UpdateDeps {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "novad")
	if err := os.WriteFile(bin, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &UpdateDeps{Supervised: supervised, Binary: bin, StateDir: dir, BaseURL: func() string { return base }}
}

func updateArgs(version, sum, path string) map[string]any {
	return map[string]any{"version": version, "sha256": sum, "path": path}
}

func sumOf(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func TestDaemonUpdateStagesAVerifiedBuildAndAsksForARestart(t *testing.T) {
	build := []byte("the hub's build")
	d := updateDeps(t, hubServing(t, build), true)
	out := Dispatch(context.Background(), "daemon.update",
		updateArgs("aaaaaaaaaaaa", sumOf(build), "/api/v1/agent/dist/"+distName()), Deps{Update: d})
	if !out.OK || !out.Restart {
		t.Fatalf("got %+v", out)
	}
	if !strings.Contains(out.Output, "confirmed only when this agent reconnects reporting aaaaaaaaaaaa") {
		t.Fatalf("the result must not claim the update: %q", out.Output)
	}
	if b, _ := os.ReadFile(d.Binary + ".new"); string(b) != string(build) {
		t.Fatal("the build was not staged beside the binary")
	}
	var u state.Update
	if err := state.ReadJSON(filepath.Join(d.StateDir, state.UpdateFile), &u); err != nil ||
		u.Outcome != state.UpdateStaged || u.Version != "aaaaaaaaaaaa" || u.SHA256 != sumOf(build) {
		t.Fatalf("update.json = %+v, %v", u, err)
	}
}

func TestDaemonUpdateRefusesAHashMismatchAndStagesNothing(t *testing.T) {
	d := updateDeps(t, hubServing(t, []byte("tampered")), true)
	out := Dispatch(context.Background(), "daemon.update",
		updateArgs("aaaaaaaaaaaa", sumOf([]byte("what core signed")), "/api/v1/agent/dist/"+distName()), Deps{Update: d})
	if out.OK || out.Restart || !strings.Contains(out.Error, "nothing staged") {
		t.Fatalf("got %+v", out)
	}
	for _, f := range []string{d.Binary + ".new", d.Binary + ".new.part", filepath.Join(d.StateDir, state.UpdateFile)} {
		if _, err := os.Stat(f); err == nil {
			t.Errorf("%s exists after a refused update", f)
		}
	}
}

// P12: a hand-started agent has nobody to start the new build.
func TestDaemonUpdateRefusesWhenNotSupervised(t *testing.T) {
	build := []byte("b")
	d := updateDeps(t, hubServing(t, build), false)
	out := Dispatch(context.Background(), "daemon.update",
		updateArgs("aaaaaaaaaaaa", sumOf(build), "/api/v1/agent/dist/"+distName()), Deps{Update: d})
	if out.OK || !strings.HasPrefix(out.Error, "cannot: this agent was started by hand") {
		t.Fatalf("got %+v", out)
	}
}

func TestDaemonUpdateRefusesAPathThatIsNotThisMachinesHubBuild(t *testing.T) {
	d := updateDeps(t, hubServing(t, []byte("b")), true)
	other := "linux"
	if runtime.GOOS == "linux" {
		other = "darwin"
	}
	for _, path := range []string{"/etc/passwd", "https://evil.example/novad", "/api/v1/agent/dist/novad-" + other + "-amd64"} {
		out := Dispatch(context.Background(), "daemon.update", updateArgs("aaaaaaaaaaaa", strings.Repeat("a", 64), path), Deps{Update: d})
		if out.OK {
			t.Errorf("path %q was accepted", path)
		}
	}
}

func TestDaemonUpdateRefusesAnOversizeDownload(t *testing.T) {
	old := MaxBinaryBytes
	MaxBinaryBytes = 4
	t.Cleanup(func() { MaxBinaryBytes = old })
	build := []byte("longer than four")
	d := updateDeps(t, hubServing(t, build), true)
	out := Dispatch(context.Background(), "daemon.update",
		updateArgs("aaaaaaaaaaaa", sumOf(build), "/api/v1/agent/dist/"+distName()), Deps{Update: d})
	if out.OK || !strings.Contains(out.Error, "cap") {
		t.Fatalf("got %+v", out)
	}
}

// Preflight minor (S42b Task 10): the plan's dist-path regex left .exe
// optional on EVERY goos, so "novad-linux-amd64.exe" would have matched and
// "novad-windows-amd64" (no .exe) would too. .exe is tied to windows only:
// required there, refused everywhere else. Every case here is refused before
// the machine-match check even runs (they are not this process's runtime.GOOS
// pairing, on any OS), so the test needs no runtime.GOOS branching of its own.
func TestDaemonUpdateTiesDotExeToWindowsOnly(t *testing.T) {
	d := updateDeps(t, hubServing(t, []byte("b")), true)
	sum := strings.Repeat("a", 64)
	bad := []string{
		"/api/v1/agent/dist/novad-windows-amd64",    // windows with no .exe
		"/api/v1/agent/dist/novad-windows-arm64",    // windows with no .exe
		"/api/v1/agent/dist/novad-linux-amd64.exe",  // .exe on a non-windows target
		"/api/v1/agent/dist/novad-darwin-arm64.exe", // .exe on a non-windows target
	}
	for _, path := range bad {
		out := Dispatch(context.Background(), "daemon.update", updateArgs("aaaaaaaaaaaa", sum, path), Deps{Update: d})
		if out.OK {
			t.Errorf("path %q was accepted", path)
		}
	}
}
