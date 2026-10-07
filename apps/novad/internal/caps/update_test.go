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
	"sync"
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

// hubServingAny answers EVERY path under /api/v1/agent/dist/ with build —
// never a 404 for the "wrong" name — so a refused path can only be refused
// by daemon.update's OWN validation, never by coincidentally asking a route
// nobody registered (fix round 1, I1). requests() counts how many times the
// hub was asked at all, proving a refused path never even reaches it.
func hubServingAny(t *testing.T, build []byte) (base string, requests func() int) {
	t.Helper()
	var mu sync.Mutex
	n := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agent/dist/", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		n++
		mu.Unlock()
		_, _ = w.Write(build)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL, func() int { mu.Lock(); defer mu.Unlock(); return n }
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
		u.Outcome != state.UpdateStaged || u.Version != "aaaaaaaaaaaa" || u.SHA256 != sumOf(build) ||
		u.Staged != d.Binary+".new" {
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

// I1 (fix round 1): a mutation that deleted the allowlist regex match, the
// .exe/windows tie, or the machine-match check left the OLD version of this
// suite green — the old hub served only THIS machine's own distName() and
// the sha was a dummy, so a bad path failed later anyway (a 404, or a hash
// mismatch), for the WRONG reason, and the mutation went unnoticed. Now the
// hub serves the real build at ANY dist path and the sha is the real one,
// so only daemon.update's own validation can produce a refusal — proven by
// counting hub requests (must stay zero) and by asserting the exact
// refusal wording each check is responsible for.
func TestDaemonUpdateRefusesABadPathWithoutEverAskingTheHub(t *testing.T) {
	build := []byte("the hub's build")
	other := "linux"
	if runtime.GOOS == "linux" {
		other = "darwin"
	}
	otherPath := "/api/v1/agent/dist/novad-" + other + "-amd64"
	cases := []struct {
		name string
		path string
		want string
	}{
		{"not a dist path at all", "/etc/passwd", "must be one of the hub's agent builds"},
		{"a foreign URL", "https://evil.example/novad", "must be one of the hub's agent builds"},
		{"windows with no .exe", "/api/v1/agent/dist/novad-windows-amd64", "must be one of the hub's agent builds"},
		{"exe on a non-windows target", "/api/v1/agent/dist/novad-linux-amd64.exe", "must be one of the hub's agent builds"},
		{"a validly-formed path for a DIFFERENT machine", otherPath, "cannot: " + otherPath + " is not this machine's build"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			base, requests := hubServingAny(t, build)
			d := updateDeps(t, base, true)
			out := Dispatch(context.Background(), "daemon.update", updateArgs("aaaaaaaaaaaa", sumOf(build), c.path), Deps{Update: d})
			if out.OK {
				t.Fatalf("path %q was accepted", c.path)
			}
			if !strings.Contains(out.Error, c.want) {
				t.Fatalf("error = %q, want it to contain %q", out.Error, c.want)
			}
			if n := requests(); n != 0 {
				t.Fatalf("%d requests reached the hub for a path that must be refused before ever asking it", n)
			}
		})
	}
}

// Fix round 1, Minor 2: a relative or empty Binary/StateDir would stage (or
// record) beside whatever the process's current directory happens to be —
// refused before any network call, same as a bad path.
func TestDaemonUpdateRefusesWhenBinaryOrStateDirIsNotAnAbsolutePath(t *testing.T) {
	build := []byte("b")
	cases := []struct {
		name           string
		binary, stateD string
	}{
		{"empty binary", "", t.TempDir()},
		{"relative binary", "novad", t.TempDir()},
		{"empty state dir", filepath.Join(t.TempDir(), "novad"), ""},
		{"relative state dir", filepath.Join(t.TempDir(), "novad"), "state"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			base, requests := hubServingAny(t, build)
			d := &UpdateDeps{Supervised: true, Binary: c.binary, StateDir: c.stateD, BaseURL: func() string { return base }}
			out := Dispatch(context.Background(), "daemon.update",
				updateArgs("aaaaaaaaaaaa", sumOf(build), "/api/v1/agent/dist/"+distName()), Deps{Update: d})
			if out.OK || !strings.HasPrefix(out.Error, "cannot:") {
				t.Fatalf("got %+v", out)
			}
			if n := requests(); n != 0 {
				t.Fatalf("%d requests reached the hub before the path/binary was even validated", n)
			}
		})
	}
}

// Fix round 1, Minor 3: a redirect must never move the download off the
// locator this connection is on. The primary hub redirects to a SECOND
// server that serves the REAL build, proving the refusal below is because
// the redirect was not followed — not because the real build was
// unreachable some other way.
func TestDaemonUpdateDoesNotFollowARedirectOffTheLocator(t *testing.T) {
	build := []byte("the hub's build")
	elsewhere := hubServing(t, build)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agent/dist/"+distName(), func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere+"/api/v1/agent/dist/"+distName(), http.StatusFound)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	d := updateDeps(t, srv.URL, true)
	out := Dispatch(context.Background(), "daemon.update",
		updateArgs("aaaaaaaaaaaa", sumOf(build), "/api/v1/agent/dist/"+distName()), Deps{Update: d})
	if out.OK {
		t.Fatal("a redirect off the locator must not be followed — the download must refuse, not succeed via the redirect target")
	}
	if _, err := os.Stat(d.Binary + ".new"); err == nil {
		t.Error("nothing must be staged when the download would only succeed by following a redirect")
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

// The .exe/windows tie (preflight minor, S42b Task 10) is covered by
// TestDaemonUpdateRefusesABadPathWithoutEverAskingTheHub above, which
// replaced this test in fix round 1 (I1): the original used a dummy sha and
// a hub serving only distName(), so a mutation that deleted the tie check
// went unnoticed (out.OK stayed false for the wrong reason).
