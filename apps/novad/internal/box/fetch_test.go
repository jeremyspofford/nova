//go:build unix

// Boxes exist only on non-Windows agents (caps wires a box manager there
// alone), and these tests drive Ensure with a real temp checkout, whose
// path is not a POSIX absolute path on Windows.

package box

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

const fChange = "c0ffee"

// The lockfiles and manifests of a repo, plus source and a secret the fetch
// must never see.
var fullRepo = map[string]string{
	"services/core/uv.lock":           "core-lock-v1",
	"services/core/pyproject.toml":    "core-pyproject",
	"services/core/app/main.py":       "SOURCE OF HERS",
	"services/gateway/uv.lock":        "gateway-lock-v1",
	"services/gateway/pyproject.toml": "gateway-pyproject",
	"services/notes/README.md":        "no lockfile here",
	"apps/web/package-lock.json":      "web-lock-v1",
	"apps/web/package.json":           "web-package",
	"apps/web/src/main.ts":            "MORE SOURCE",
	"apps/novad/go.sum":               "go-sum-v1",
	"apps/novad/go.mod":               "go-mod",
	".env":                            "SECRET=hunter2",
}

func sha(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// fetchSetup is a real checkout on disk with the change's worktree holding
// files, a fake docker whose image labels match every lockfile except
// those in differ, and a Manager on both.
func fetchSetup(t *testing.T, files map[string]string, differ ...string) (*Manager, *fakeDocker, Request) {
	t.Helper()
	checkout := t.TempDir()
	req := goodRequest()
	req.Checkout = checkout
	req.Change = fChange
	req.Cwd = Worktree(checkout, fChange)
	req.Limits = Limits{CPUs: 3, MemoryGB: 5, Pids: 700, MaxRunning: 2}
	writeFiles(t, req.Cwd, files)
	d := newFake()
	d.labels = map[string]string{"maintainer": "nova"}
	for _, rel := range []string{"services/core/uv.lock", "services/gateway/uv.lock", "apps/web/package-lock.json", "apps/novad/go.sum"} {
		if body, ok := files[rel]; ok {
			d.labels[LockLabel+rel] = sha(body)
		}
	}
	for _, rel := range differ {
		d.labels[LockLabel+rel] = sha("what main's image was built from")
	}
	m, _ := newManager(d)
	m.UID, m.GID = 1234, 5678
	return m, d, req
}

func ensureOK(t *testing.T, m *Manager, req Request) {
	t.Helper()
	if _, err := m.Ensure(context.Background(), req); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
}

func callIndex(calls [][]string, pred func([]string) bool) int {
	for i, c := range calls {
		if pred(c) {
			return i
		}
	}
	return -1
}

func isFetch(a []string) bool {
	return len(a) > 1 && a[0] == "run" && a[1] == "--rm" && flagVal(a, "--network") == "bridge"
}

func isMarkerRead(a []string) bool {
	return len(a) > 1 && a[0] == "run" && a[1] == "--rm" && flagVal(a, "--network") == "none"
}

func isRunOf(name string) func([]string) bool {
	return func(a []string) bool { return a[0] == "run" && a[1] == "-d" && flagVal(a, "--name") == name }
}

func copyMap(m map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

// C1
func TestReadLocksHashesOnlyTheLockfilesPresent(t *testing.T) {
	wt := t.TempDir()
	writeFiles(t, wt, fullRepo)
	writeFiles(t, wt, map[string]string{"services/x/requirements.lock": "not ours"})
	got, err := ReadLocks(wt)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"services/core/uv.lock":      sha("core-lock-v1"),
		"services/gateway/uv.lock":   sha("gateway-lock-v1"),
		"apps/web/package-lock.json": sha("web-lock-v1"),
		"apps/novad/go.sum":          sha("go-sum-v1"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ReadLocks = %v, want %v", got, want)
	}

	only := t.TempDir()
	writeFiles(t, only, map[string]string{"services/memory/uv.lock": "mem", "services/memory/pyproject.toml": "p"})
	got, err = ReadLocks(only)
	if err != nil || !reflect.DeepEqual(got, map[string]string{"services/memory/uv.lock": sha("mem")}) {
		t.Fatalf("ReadLocks(memory only) = %v, %v", got, err)
	}

	got, err = ReadLocks(filepath.Join(t.TempDir(), "no-such-worktree"))
	if err != nil || len(got) != 0 {
		t.Fatalf("ReadLocks(missing worktree) = %v, %v, want empty and no error", got, err)
	}
}

// C1: a link inside the worktree is hers and is followed.
func TestReadLocksFollowsALinkInsideTheWorktree(t *testing.T) {
	wt := t.TempDir()
	writeFiles(t, wt, map[string]string{"locks/core.lock": "inside", "services/core/pyproject.toml": "p"})
	if err := os.Symlink("../../locks/core.lock", filepath.Join(wt, "services/core/uv.lock")); err != nil {
		t.Fatal(err)
	}
	got, err := ReadLocks(wt)
	if err != nil || !reflect.DeepEqual(got, map[string]string{"services/core/uv.lock": sha("inside")}) {
		t.Fatalf("ReadLocks = %v, %v", got, err)
	}
}

// C1
func TestReadLocksNeverLeavesTheWorktree(t *testing.T) {
	outside := t.TempDir()
	writeFiles(t, outside, map[string]string{
		"secret":                  "OWNER SECRET",
		"web/package-lock.json":   "OWNER SECRET",
		"web/package.json":        "OWNER SECRET",
		"svc/core/uv.lock":        "OWNER SECRET",
		"svc/core/pyproject.toml": "OWNER SECRET",
	})
	link := func(target, at string) func(string) error {
		return func(wt string) error {
			p := filepath.Join(wt, filepath.FromSlash(at))
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			return os.Symlink(target, p)
		}
	}
	cases := []struct {
		name  string
		files map[string]string
		do    func(wt string) error
		names string
	}{
		{"lockfile links out", map[string]string{"services/core/pyproject.toml": "p"},
			link(filepath.Join(outside, "secret"), "services/core/uv.lock"), "services/core/uv.lock"},
		{"manifest links out", map[string]string{"services/core/uv.lock": "l"},
			link(filepath.Join(outside, "secret"), "services/core/pyproject.toml"), "services/core/pyproject.toml"},
		{"web dir links out", nil, link(filepath.Join(outside, "web"), "apps/web"), "apps/web"},
		{"services links out", nil, link(filepath.Join(outside, "svc"), "services"), "services"},
		{"a service links out", nil, link(filepath.Join(outside, "svc/core"), "services/evil"), "services/evil"},
		{"relative escape", map[string]string{"apps/novad/go.mod": "m"},
			link("../../../../"+filepath.Base(outside)+"/secret", "apps/novad/go.sum"), "apps/novad/go.sum"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			wt := t.TempDir()
			writeFiles(t, wt, c.files)
			if err := c.do(wt); err != nil {
				t.Fatal(err)
			}
			got, err := ReadLocks(wt)
			if err == nil {
				t.Fatalf("ReadLocks = %v, want a refusal", got)
			}
			if !strings.Contains(err.Error(), c.names) {
				t.Fatalf("error %q does not name %s", err, c.names)
			}
			if strings.Contains(fmt.Sprint(got), sha("OWNER SECRET")) {
				t.Fatalf("hashed a file outside the worktree: %v", got)
			}
		})
	}
}

// C1
func TestReadLocksRefusesWhatItCannotCopy(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, wt string)
		names string
	}{
		{"no manifest", func(t *testing.T, wt string) {
			writeFiles(t, wt, map[string]string{"services/core/uv.lock": "l"})
		}, "services/core/pyproject.toml"},
		{"no package.json", func(t *testing.T, wt string) {
			writeFiles(t, wt, map[string]string{"apps/web/package-lock.json": "l"})
		}, "apps/web/package.json"},
		{"no go.mod", func(t *testing.T, wt string) {
			writeFiles(t, wt, map[string]string{"apps/novad/go.sum": "l"})
		}, "apps/novad/go.mod"},
		{"lockfile is a dir", func(t *testing.T, wt string) {
			writeFiles(t, wt, map[string]string{"apps/novad/go.sum/x": "l", "apps/novad/go.mod": "m"})
		}, "apps/novad/go.sum"},
		{"too big", func(t *testing.T, wt string) {
			writeFiles(t, wt, map[string]string{"services/core/uv.lock": "", "services/core/pyproject.toml": "p"})
			if err := os.Truncate(filepath.Join(wt, "services/core/uv.lock"), 16<<20+1); err != nil {
				t.Fatal(err)
			}
		}, "services/core/uv.lock"},
		{"bad service name", func(t *testing.T, wt string) {
			writeFiles(t, wt, map[string]string{"services/a'b/uv.lock": "l", "services/a'b/pyproject.toml": "p"})
		}, "a'b"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			wt := t.TempDir()
			c.setup(t, wt)
			got, err := ReadLocks(wt)
			if err == nil || !strings.Contains(err.Error(), c.names) {
				t.Fatalf("ReadLocks = %v, %v; want an error naming %s", got, err, c.names)
			}
		})
	}
	// Exactly at the bound is fine.
	wt := t.TempDir()
	writeFiles(t, wt, map[string]string{"services/core/uv.lock": "", "services/core/pyproject.toml": "p"})
	if err := os.Truncate(filepath.Join(wt, "services/core/uv.lock"), 16<<20); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadLocks(wt); err != nil {
		t.Fatalf("a 16 MiB lockfile refused: %v", err)
	}
}

// C2
func TestEnsureWithLocksMatchingTheImageFetchesNothing(t *testing.T) {
	m, d, req := fetchSetup(t, fullRepo)
	ensureOK(t, m, req)
	if len(d.fetches) != 0 {
		t.Fatalf("fetched %d times, want none", len(d.fetches))
	}
	if i := callIndex(d.calls, func(a []string) bool { return a[0] == "image" && a[1] == "inspect" }); i < 0 {
		t.Fatalf("the image's labels were never read: %q", d.calls)
	}
	if callIndex(d.calls, isMarkerRead) >= 0 {
		t.Fatalf("the marker was read though every lockfile matched the image")
	}
	// A restarted agent (no record, a volume it did not create) has no
	// reason to read the marker either.
	m2, _ := newManager(d)
	ensureOK(t, m2, req)
	if callIndex(d.calls, isMarkerRead) >= 0 || len(d.fetches) != 0 {
		t.Fatalf("a restarted agent read the marker or fetched with every lockfile matching")
	}
}

// C2
func TestEnsureWithoutLockfilesAsksNothingMore(t *testing.T) {
	m, d, req := fetchSetup(t, map[string]string{"README.md": "hi"})
	ensureOK(t, m, req)
	for _, a := range d.calls {
		if a[0] == "image" && a[1] == "inspect" || a[0] == "run" && a[1] == "--rm" {
			t.Fatalf("a worktree without lockfiles cost %q", a)
		}
	}
}

// C2/C5
func TestTheImageLabelsAreReadOncePerTagAndTheirFailureIsNamed(t *testing.T) {
	m, d, req := fetchSetup(t, fullRepo)
	ensureOK(t, m, req)
	ensureOK(t, m, req)
	n := 0
	for _, a := range d.calls {
		if a[0] == "image" && a[1] == "inspect" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("labels read %d times, want once", n)
	}

	m2, d2, req2 := fetchSetup(t, fullRepo)
	d2.fail = func(a []string) bool { return a[0] == "image" && a[1] == "inspect" }
	_, err := m2.Ensure(context.Background(), req2)
	if err == nil || !strings.Contains(err.Error(), "lockfile labels") || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v, want the label read named and docker quoted", err)
	}
	if callIndex(d2.calls, isRunOf(Names(fChange).Box)) >= 0 {
		t.Fatalf("the box started after the labels could not be read")
	}
}

// C3
func TestEnsureFetchesOnlyTheToolWhoseLockDiffers(t *testing.T) {
	newSvc := copyMap(fullRepo)
	newSvc["services/fresh/uv.lock"] = "fresh-lock"
	newSvc["services/fresh/pyproject.toml"] = "fresh-py"
	cases := []struct {
		name   string
		files  map[string]string
		differ []string
		want   []string
		absent []string
	}{
		{"core", fullRepo, []string{"services/core/uv.lock"}, []string{"cd /tmp/w/services/core && uv sync --frozen --no-install-project"},
			[]string{"npm ci", "go mod download", "services/gateway"}},
		{"web", fullRepo, []string{"apps/web/package-lock.json"}, []string{"cd /tmp/w/apps/web && npm ci --ignore-scripts"},
			[]string{"uv sync", "go mod download"}},
		{"novad", fullRepo, []string{"apps/novad/go.sum"}, []string{"cd /tmp/w/apps/novad && go mod download"},
			[]string{"uv sync", "npm ci"}},
		{"two services and web", fullRepo, []string{"services/gateway/uv.lock", "services/core/uv.lock", "apps/web/package-lock.json"},
			[]string{"cd /tmp/w/services/core && uv sync", "cd /tmp/w/services/gateway && uv sync", "npm ci"}, []string{"go mod download"}},
		{"a service the image never saw", newSvc, nil, []string{"cd /tmp/w/services/fresh && uv sync --frozen --no-install-project"},
			[]string{"services/core", "npm ci", "go mod download"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, d, req := fetchSetup(t, c.files, c.differ...)
			if c.differ == nil {
				// Only a nova.lock.<rel> label is a lock label: a bare key
				// equal to the path and the right sum must not match.
				d.labels["services/fresh/uv.lock"] = sha("fresh-lock")
			}
			ensureOK(t, m, req)
			if len(d.fetches) != 1 {
				t.Fatalf("fetched %d times, want once", len(d.fetches))
			}
			argv := d.fetches[0].argv
			script := argv[len(argv)-1]
			for _, w := range c.want {
				if !strings.Contains(script, w) {
					t.Fatalf("script %q lacks %q", script, w)
				}
			}
			for _, a := range c.absent {
				if strings.Contains(script, a) {
					t.Fatalf("script %q runs %q, which did not differ", script, a)
				}
			}
			need := append([]string(nil), c.differ...)
			if c.differ == nil {
				need = []string{"services/fresh/uv.lock"}
			}
			sort.Strings(need)
			if script != FetchScript(need) {
				t.Fatalf("script = %q, want FetchScript(%q) = %q", script, need, FetchScript(need))
			}
			if callIndex(d.calls, isMarkerRead) >= 0 {
				t.Fatalf("read the marker of a cache volume created in this very Ensure")
			}
			f := callIndex(d.calls, isFetch)
			for _, name := range []string{Names(fChange).DB, Names(fChange).Box} {
				if r := callIndex(d.calls, isRunOf(name)); r < 0 || r < f {
					t.Fatalf("%s ran at %d, the fetch at %d: the fetch must come first", name, r, f)
				}
			}
		})
	}
}

// C3
func TestFetchScriptRunsOnlyWhatDiffers(t *testing.T) {
	got := FetchScript([]string{"apps/novad/go.sum", "apps/web/package-lock.json", "services/memory/uv.lock"})
	want := "set -eu\n" +
		"mkdir -p /tmp/w\n" +
		"cp -R /src/. /tmp/w\n" +
		"(cd /tmp/w/apps/novad && go mod download)\n" +
		"(cd /tmp/w/apps/web && npm ci --ignore-scripts)\n" +
		"(cd /tmp/w/services/memory && uv sync --frozen --no-install-project)\n" +
		"cp /tmp/w/.nova-locks /deps/.nova-locks\n"
	if got != want {
		t.Fatalf("FetchScript =\n%s\nwant\n%s", got, want)
	}
}

// C3
func TestEnsureFetchesUnderARunningBox(t *testing.T) {
	m, d, req := fetchSetup(t, fullRepo)
	ensureOK(t, m, req)
	before := len(d.mutations())
	writeFiles(t, req.Cwd, map[string]string{"apps/web/package-lock.json": "web-lock-v2"})
	ensureOK(t, m, req)
	if len(d.fetches) != 1 {
		t.Fatalf("fetched %d times under a running box, want once", len(d.fetches))
	}
	for _, mu := range d.mutations()[before:] {
		if mu != "run "+Names(fChange).Fetch && mu != "run " {
			t.Fatalf("a running box was touched: %q", mu)
		}
	}
}

// C3
func TestTheMarkerSkipsARepeatFetch(t *testing.T) {
	m, d, req := fetchSetup(t, fullRepo, "services/core/uv.lock")
	ensureOK(t, m, req)
	ensureOK(t, m, req)
	if len(d.fetches) != 1 {
		t.Fatalf("fetched %d times for one lockfile, want once", len(d.fetches))
	}
	writeFiles(t, req.Cwd, map[string]string{"services/core/uv.lock": "core-lock-v2"})
	ensureOK(t, m, req)
	writeFiles(t, req.Cwd, map[string]string{"services/gateway/uv.lock": "gateway-lock-v2"})
	ensureOK(t, m, req)
	if len(d.fetches) != 3 {
		t.Fatalf("fetched %d times, want 3", len(d.fetches))
	}
	last := d.fetches[2].argv
	if s := last[len(last)-1]; strings.Contains(s, "services/core") {
		t.Fatalf("the third fetch reran core: %q", s)
	}
	cache := Names(fChange).Cache
	wantMarker := sha("core-lock-v2") + "  services/core/uv.lock\n" + sha("gateway-lock-v2") + "  services/gateway/uv.lock\n"
	if d.markers[cache] != wantMarker {
		t.Fatalf("marker = %q, want %q", d.markers[cache], wantMarker)
	}

	// A new agent has no record: it reads the volume's marker and skips.
	m2, _ := newManager(d)
	m2.UID, m2.GID = 1234, 5678
	ensureOK(t, m2, req)
	if len(d.fetches) != 3 {
		t.Fatalf("a restarted agent fetched again (%d fetches)", len(d.fetches))
	}
	i := callIndex(d.calls, isMarkerRead)
	if i < 0 {
		t.Fatalf("the restarted agent never read the marker")
	}
	if want := MarkerArgs(fChange, tTag, 1234, 5678); !reflect.DeepEqual(d.calls[i], want) {
		t.Fatalf("marker read = %q, want %q", d.calls[i], want)
	}
}

// C3
func TestRemoveForgetsTheFetch(t *testing.T) {
	m, d, req := fetchSetup(t, fullRepo, "apps/novad/go.sum")
	ensureOK(t, m, req)
	if err := m.Remove(context.Background(), fChange); err != nil {
		t.Fatal(err)
	}
	ensureOK(t, m, req)
	if len(d.fetches) != 2 {
		t.Fatalf("fetched %d times, want a fresh fetch into the new volume", len(d.fetches))
	}
}

// C4
func TestFetchArgsAreExactlyTheSpec(t *testing.T) {
	req := goodRequest()
	req.Change = fChange
	req.Limits = Limits{CPUs: 3, MemoryGB: 5, Pids: 700, MaxRunning: 2}
	got := FetchArgs(req, "nova-devbox:t-abc", 1234, 5678, "/tmp/nova-fetch-1", []string{"services/core/uv.lock"})
	want := []string{
		"run", "--rm",
		"--name", "nova-box-c0ffee-fetch",
		"--network", "bridge",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--user", "1234:5678",
		"--memory", "5g",
		"--pids-limit", "700",
		"--cpus", "3",
		"--tmpfs", "/tmp",
		"-e", "HOME=/tmp/home",
		"-e", "UV_CACHE_DIR=/deps/uv",
		"-e", "UV_OFFLINE=false",
		"-e", "UV_LINK_MODE=copy",
		"-e", "npm_config_cache=/deps/npm",
		"-e", "npm_config_offline=false",
		"-e", "GOMODCACHE=/deps/go",
		"-e", "GOPROXY=https://proxy.golang.org,direct",
		"-e", "GOFLAGS=-mod=mod",
		"-e", "GOCACHE=/tmp/gocache",
		"-v", "/tmp/nova-fetch-1:/src:ro",
		"-v", "nova-box-c0ffee-cache:/deps",
		"--label", "nova.box=c0ffee",
		"nova-devbox:t-abc",
		"sh", "-c", FetchScript([]string{"services/core/uv.lock"}),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("FetchArgs =\n%q\nwant\n%q", got, want)
	}
}

// C3/C4
func TestMarkerArgsReadWithNoNetwork(t *testing.T) {
	got := MarkerArgs(fChange, "nova-devbox:t-abc", 1234, 5678)
	want := []string{
		"run", "--rm",
		"--network", "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--user", "1234:5678",
		"-v", "nova-box-c0ffee-cache:/deps:ro",
		"--label", "nova.box=c0ffee",
		"nova-devbox:t-abc",
		"sh", "-c", "cat /deps/.nova-locks 2>/dev/null || true",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("MarkerArgs =\n%q\nwant\n%q", got, want)
	}
}

// C4: what the fetch is given is derived from what it actually got.
func TestTheFetchSeesOnlyLockfilesAndManifests(t *testing.T) {
	m, d, req := fetchSetup(t, fullRepo, "services/core/uv.lock", "apps/web/package-lock.json")
	ensureOK(t, m, req)
	if len(d.fetches) != 1 {
		t.Fatalf("fetched %d times", len(d.fetches))
	}
	rec := d.fetches[0]
	want := map[string]string{
		"services/core/uv.lock":        "core-lock-v1",
		"services/core/pyproject.toml": "core-pyproject",
		"apps/web/package-lock.json":   "web-lock-v1",
		"apps/web/package.json":        "web-package",
		".nova-locks":                  sha("web-lock-v1") + "  apps/web/package-lock.json\n" + sha("core-lock-v1") + "  services/core/uv.lock\n",
	}
	if !reflect.DeepEqual(rec.files, want) {
		t.Fatalf("the fetch saw %v, want %v", rec.files, want)
	}
	if _, err := os.Stat(rec.src); !os.IsNotExist(err) {
		t.Fatalf("the fetch's temp dir %s outlived it (%v)", rec.src, err)
	}
	home, _ := os.UserHomeDir()
	v := vols(rec.argv)
	if len(v) != 2 || v[0] != rec.src+":/src:ro" || v[1] != Names(fChange).Cache+":"+DepsMount {
		t.Fatalf("mounts = %q, want only the temp dir ro and the cache", v)
	}
	for i, a := range rec.argv {
		switch {
		case strings.Contains(a, req.Checkout):
			t.Fatalf("argv[%d] %q names the checkout or worktree", i, a)
		case a == "-p", a == "-P", a == "--publish", a == "--publish-all", a == "--privileged", a == "--cap-add", a == "--device":
			t.Fatalf("argv[%d] %q opens the container", i, a)
		case strings.Contains(a, "docker.sock"), strings.Contains(a, ".secrets"), strings.Contains(a, ".env"):
			t.Fatalf("argv[%d] %q names a host secret", i, a)
		case home != "" && strings.HasPrefix(a, home):
			t.Fatalf("argv[%d] %q is under $HOME", i, a)
		case i > 0 && rec.argv[i-1] == "-e" && !strings.Contains(a, "="):
			t.Fatalf("-e %q passes the host's environment through", a)
		case i > 0 && rec.argv[i-1] == "--network" && a != "bridge":
			t.Fatalf("--network %q", a)
		}
	}
}

// C5
func TestAFailedFetchSaysWhyAndStartsNothing(t *testing.T) {
	m, d, req := fetchSetup(t, fullRepo, "services/core/uv.lock")
	var lines []string
	for i := 1; i <= 30; i++ {
		lines = append(lines, fmt.Sprintf("out-%02d", i))
	}
	d.fetchOut = strings.Join(lines, "\n") + "\n"
	d.fetchExit = 2
	_, err := m.Ensure(context.Background(), req)
	if err == nil {
		t.Fatal("Ensure succeeded after the fetch failed")
	}
	for _, w := range []string{"nova-box-c0ffee-fetch", "services/core/uv.lock", "exit 2", "out-11", "out-30"} {
		if !strings.Contains(err.Error(), w) {
			t.Fatalf("error %q lacks %q", err, w)
		}
	}
	if strings.Contains(err.Error(), "out-10") {
		t.Fatalf("error %q carries more than the tail", err)
	}
	for _, name := range []string{Names(fChange).DB, Names(fChange).Box} {
		if callIndex(d.calls, isRunOf(name)) >= 0 {
			t.Fatalf("%s ran after the fetch failed", name)
		}
	}
	if _, err := os.Stat(d.fetches[0].src); !os.IsNotExist(err) {
		t.Fatalf("the failed fetch's temp dir %s survived (%v)", d.fetches[0].src, err)
	}
	// The marker did not move: the next Ensure fetches again.
	d.fetchExit = 0
	ensureOK(t, m, req)
	if len(d.fetches) != 2 {
		t.Fatalf("fetched %d times, want the failed fetch retried", len(d.fetches))
	}
}

// C5
func TestAFetchThatCannotRunOrSaysTooMuchIsBounded(t *testing.T) {
	m, d, req := fetchSetup(t, fullRepo, "apps/novad/go.sum")
	d.fetchSpawn = true
	_, err := m.Ensure(context.Background(), req)
	if err == nil || !strings.Contains(err.Error(), "could not run docker") || !strings.Contains(err.Error(), "apps/novad/go.sum") {
		t.Fatalf("err = %v, want the spawn failure named with the lockfile", err)
	}

	m, d, req = fetchSetup(t, fullRepo, "apps/novad/go.sum")
	d.fetchOut = strings.Repeat("x", 9000) + "END"
	d.fetchExit = 1
	_, err = m.Ensure(context.Background(), req)
	if err == nil || !strings.Contains(err.Error(), "END") || len(err.Error()) > 2400 {
		t.Fatalf("err (%d bytes) does not end with the output's tail or is unbounded", len(fmt.Sprint(err)))
	}
}

// C5
func TestALeftoverFetchIsRemovedFirst(t *testing.T) {
	m, d, req := fetchSetup(t, fullRepo, "services/core/uv.lock")
	d.ctrs[Names(fChange).Fetch] = &fakeCtr{"running", tTag}
	ensureOK(t, m, req)
	rm := callIndex(d.calls, func(a []string) bool {
		return reflect.DeepEqual(a, []string{"rm", "-f", Names(fChange).Fetch})
	})
	if f := callIndex(d.calls, isFetch); rm < 0 || rm > f {
		t.Fatalf("leftover removed at %d, fetch at %d: %q", rm, f, d.calls)
	}

	m, d, req = fetchSetup(t, fullRepo, "services/core/uv.lock")
	ensureOK(t, m, req)
	for _, a := range d.calls {
		if a[0] == "rm" {
			t.Fatalf("removed %q with no leftover", a)
		}
	}
}

// C5
func TestAMarkerThatCannotBeReadIsNamed(t *testing.T) {
	m, d, req := fetchSetup(t, fullRepo, "services/core/uv.lock")
	d.vols[Names(fChange).Cache] = true // a volume this agent did not just create
	d.fail = isMarkerRead
	_, err := m.Ensure(context.Background(), req)
	if err == nil || !strings.Contains(err.Error(), "marker") || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v, want the marker read named and docker quoted", err)
	}
	if len(d.fetches) != 0 || callIndex(d.calls, isRunOf(Names(fChange).Box)) >= 0 {
		t.Fatalf("something ran after the marker could not be read")
	}
}
