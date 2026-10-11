package box

// The dependency fetch step (S32.2 T8, spec §4.3, ruling §9.1). The box has
// no route out, so a change whose lockfile differs from what main's devbox
// image was built from gets its dependencies from a separate, short-lived
// container WITH egress that sees only the lockfiles and manifests — never
// her source, .git, $HOME or a secret — and writes into the change's cache
// volume, which the box mounts read-only.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	// LockLabel prefixes the devbox image's labels: nova.lock.<rel> =
	// sha256 of the lockfile at <rel> the image's caches were built from.
	LockLabel = "nova.lock."
	// MarkerPath records, in the cache volume, the lockfiles a fetch has
	// served: lines "<sha256>  <rel>".
	MarkerPath = DepsMount + "/.nova-locks"
	// MaxLockBytes bounds a lockfile or manifest the fetch will copy.
	MaxLockBytes = 16 << 20
)

// fetchEnv is the fetch container's whole environment: the cache layout
// under /deps (A2) and the egress the box's offline image ENV turns off.
// Constants only — nothing of the host's.
var fetchEnv = []string{
	"HOME=" + BoxHome,
	"UV_CACHE_DIR=" + DepsMount + "/uv",
	"UV_OFFLINE=false",
	"UV_LINK_MODE=copy",
	"npm_config_cache=" + DepsMount + "/npm",
	"npm_config_offline=false",
	"GOMODCACHE=" + DepsMount + "/go",
	"GOPROXY=https://proxy.golang.org,direct",
	"GOFLAGS=-mod=mod",
	"GOCACHE=/tmp/gocache",
}

var serviceName = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// lockFile is one lockfile and its manifest, read once: the bytes hashed are
// the bytes copied.
type lockFile struct {
	rel, sha     string
	data         []byte
	manifest     string
	manifestData []byte
}

// manifestOf is the manifest a lockfile's tool needs beside it.
func manifestOf(rel string) string {
	dir := path.Dir(rel)
	switch path.Base(rel) {
	case "uv.lock":
		return dir + "/pyproject.toml"
	case "package-lock.json":
		return dir + "/package.json"
	default: // go.sum
		return dir + "/go.mod"
	}
}

// toolOf is the command that fills the cache from a lockfile's directory.
func toolOf(rel string) string {
	switch path.Base(rel) {
	case "uv.lock":
		return "uv sync --frozen --no-install-project"
	case "package-lock.json":
		return "npm ci --ignore-scripts"
	default: // go.sum
		return "go mod download"
	}
}

// readIn reads rel through root: absent is (nil, false, nil); a link that
// leaves the worktree, a non-regular file or one over MaxLockBytes is an
// error naming rel.
func readIn(root *os.Root, rel string) ([]byte, bool, error) {
	fi, err := root.Stat(rel)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("%s: %v", rel, err)
	}
	// Checked before opening: opening a FIFO would block.
	if !fi.Mode().IsRegular() {
		return nil, false, fmt.Errorf("%s is not a regular file", rel)
	}
	f, err := root.Open(rel)
	if err != nil {
		return nil, false, fmt.Errorf("%s: %v", rel, err)
	}
	defer f.Close()
	if fi, err = f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return nil, false, fmt.Errorf("%s is not a regular file", rel)
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxLockBytes+1))
	if err != nil {
		return nil, false, fmt.Errorf("reading %s: %v", rel, err)
	}
	if len(data) > MaxLockBytes {
		return nil, false, fmt.Errorf("%s is over %d MiB", rel, MaxLockBytes>>20)
	}
	return data, true, nil
}

// readLocks reads every lockfile present in the worktree with its manifest.
// Every read goes through os.Root: a link inside the worktree is hers and is
// followed; one leaving it is refused, and nothing outside is read (A8).
func readLocks(worktree string) ([]lockFile, error) {
	root, err := os.OpenRoot(worktree)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("opening the worktree %s: %v", worktree, err)
	}
	defer root.Close()

	var cands []string
	dir, err := root.Open("services")
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return nil, fmt.Errorf("services: %v", err)
	default:
		ents, err := dir.ReadDir(-1)
		dir.Close()
		if err != nil {
			return nil, fmt.Errorf("listing services: %v", err)
		}
		for _, e := range ents {
			rel := "services/" + e.Name() + "/uv.lock"
			if _, err := root.Stat(rel); errors.Is(err, fs.ErrNotExist) {
				continue
			} else if err != nil {
				return nil, fmt.Errorf("%s: %v", rel, err)
			}
			if !serviceName.MatchString(e.Name()) {
				return nil, fmt.Errorf("services/%q holds a uv.lock but its name is outside [A-Za-z0-9._-]", e.Name())
			}
			cands = append(cands, rel)
		}
	}
	cands = append(cands, "apps/web/package-lock.json", "apps/novad/go.sum")

	var out []lockFile
	for _, rel := range cands {
		data, ok, err := readIn(root, rel)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		man := manifestOf(rel)
		mdata, ok, err := readIn(root, man)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("%s has no %s beside it", rel, man)
		}
		out = append(out, lockFile{rel: rel, sha: sha256Hex(data), data: data, manifest: man, manifestData: mdata})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].rel < out[j].rel })
	return out, nil
}

// ReadLocks is the sha256 of every lockfile present in the worktree, by
// repo-relative path: services/*/uv.lock, apps/web/package-lock.json,
// apps/novad/go.sum.
func ReadLocks(worktree string) (map[string]string, error) {
	locks, err := readLocks(worktree)
	if err != nil {
		return nil, err
	}
	got := map[string]string{}
	for _, l := range locks {
		got[l.rel] = l.sha
	}
	return got, nil
}

// FetchScript runs, from a writable copy of /src, only the tools whose
// lockfiles are in need, then records the marker in the cache (A6).
func FetchScript(need []string) string {
	var b strings.Builder
	b.WriteString("set -eu\nmkdir -p /tmp/w\ncp -R /src/. /tmp/w\n")
	for _, rel := range need {
		fmt.Fprintf(&b, "(cd /tmp/w/%s && %s)\n", path.Dir(rel), toolOf(rel))
	}
	b.WriteString("cp /tmp/w/.nova-locks " + MarkerPath + "\n")
	return b.String()
}

// FetchArgs is the fetch container: egress on the default bridge, no
// capabilities, the owner's uid/gid, the box's limits, a fixed environment,
// and exactly two mounts — the lockfiles ro and the change's cache rw (the
// cache's only writer).
func FetchArgs(req Request, image string, uid, gid int, src string, need []string) []string {
	n := Names(req.Change)
	argv := []string{
		"run", "--rm",
		"--name", n.Fetch,
		"--network", "bridge",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--user", strconv.Itoa(uid) + ":" + strconv.Itoa(gid),
		"--memory", strconv.Itoa(req.Limits.MemoryGB) + "g",
		"--pids-limit", strconv.Itoa(req.Limits.Pids),
		"--cpus", strconv.Itoa(req.Limits.CPUs),
		"--tmpfs", "/tmp",
	}
	for _, e := range fetchEnv {
		argv = append(argv, "-e", e)
	}
	return append(argv,
		"-v", src+":/src:ro",
		"-v", n.Cache+":"+DepsMount,
		"--label", Label+"="+req.Change,
		image,
		"sh", "-c", FetchScript(need),
	)
}

// MarkerArgs reads the cache volume's marker: no network, read-only.
func MarkerArgs(change, image string, uid, gid int) []string {
	return []string{
		"run", "--rm",
		"--network", "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--user", strconv.Itoa(uid) + ":" + strconv.Itoa(gid),
		"-v", Names(change).Cache + ":" + DepsMount + ":ro",
		"--label", Label + "=" + change,
		image,
		"sh", "-c", "cat " + MarkerPath + " 2>/dev/null || true",
	}
}

var sha256Shape = regexp.MustCompile(`^[0-9a-f]{64}$`)

func parseMarker(s string) map[string]string {
	got := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		sum, rel, ok := strings.Cut(strings.TrimSpace(line), "  ")
		if ok && sha256Shape.MatchString(sum) && rel != "" {
			got[rel] = sum
		}
	}
	return got
}

func formatMarker(m map[string]string) string {
	rels := make([]string, 0, len(m))
	for rel := range m {
		rels = append(rels, rel)
	}
	sort.Strings(rels)
	var b strings.Builder
	for _, rel := range rels {
		b.WriteString(m[rel] + "  " + rel + "\n")
	}
	return b.String()
}

// tail is the end of a failed fetch's output: the last 20 lines, at most
// 2000 bytes (A7).
func tail(out string) string {
	lines := strings.Split(strings.TrimRight(out, "\n\r\t "), "\n")
	if len(lines) > 20 {
		lines = lines[len(lines)-20:]
	}
	t := strings.Join(lines, "\n")
	if len(t) > 2000 {
		t = strings.ToValidUTF8(t[len(t)-2000:], "")
	}
	return t
}

// imageLocks is the devbox image's nova.lock.* labels by rel, read once per
// tag (a tag is a tree hash; its labels do not move, A5). Caller holds m.mu.
func (m *Manager) imageLocks(ctx context.Context, tag string) (map[string]string, error) {
	if got, ok := m.labels[tag]; ok {
		return got, nil
	}
	out, err := m.docker(ctx, "reading the lockfile labels of "+tag, "image", "inspect", "--format", "{{json .Config.Labels}}", tag)
	if err != nil {
		return nil, err
	}
	var all map[string]string
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &all); err != nil {
		return nil, fmt.Errorf("reading the lockfile labels of %s: docker answered %q: %v", tag, strings.TrimSpace(out), err)
	}
	got := map[string]string{}
	for k, v := range all {
		if rel, ok := strings.CutPrefix(k, LockLabel); ok {
			got[rel] = v
		}
	}
	if m.labels == nil {
		m.labels = map[string]map[string]string{}
	}
	m.labels[tag] = got
	return got, nil
}

// fetchLocked runs the fetch step for the change when a lockfile of its
// worktree matches neither the image's label nor the cache's marker.
// freshCache: the volume was created in this Ensure, so it has no marker.
// Caller holds m.mu.
func (m *Manager) fetchLocked(ctx context.Context, req Request, tag string, ctrs map[string]ctr, freshCache bool) error {
	locks, err := readLocks(Worktree(req.Checkout, req.Change))
	if err != nil {
		return fmt.Errorf("reading the change's lockfiles: %v — nothing was fetched", err)
	}
	if len(locks) == 0 {
		return nil
	}
	labels, err := m.imageLocks(ctx, tag)
	if err != nil {
		return err
	}
	var differ []lockFile
	for _, l := range locks {
		if labels[l.rel] != l.sha {
			differ = append(differ, l)
		}
	}
	if len(differ) == 0 {
		return nil
	}
	n := Names(req.Change)
	marker, ok := m.fetched[req.Change]
	if !ok {
		marker = map[string]string{}
		if !freshCache {
			out, err := m.docker(ctx, "reading the dependency marker in "+n.Cache, MarkerArgs(req.Change, tag, m.UID, m.GID)...)
			if err != nil {
				return err
			}
			marker = parseMarker(out)
		}
		if m.fetched == nil {
			m.fetched = map[string]map[string]string{}
		}
		m.fetched[req.Change] = marker
	}
	var need []lockFile
	for _, l := range differ {
		if marker[l.rel] != l.sha {
			need = append(need, l)
		}
	}
	if len(need) == 0 {
		return nil
	}

	merged := map[string]string{}
	for rel, sum := range marker {
		merged[rel] = sum
	}
	rels := make([]string, len(need))
	for i, l := range need {
		rels[i] = l.rel
		merged[l.rel] = l.sha
	}
	step := fmt.Sprintf("fetching the dependencies for %s (%s)", strings.Join(rels, ", "), n.Fetch)

	src, err := os.MkdirTemp("", "nova-fetch-")
	if err != nil {
		return fmt.Errorf("%s: making its temp dir: %v", step, err)
	}
	defer os.RemoveAll(src)
	files := map[string][]byte{".nova-locks": []byte(formatMarker(merged))}
	for _, l := range need {
		files[l.rel] = l.data
		files[l.manifest] = l.manifestData
	}
	for rel, data := range files {
		p := filepath.Join(src, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return fmt.Errorf("%s: %v", step, err)
		}
		if err := os.WriteFile(p, data, 0o644); err != nil {
			return fmt.Errorf("%s: %v", step, err)
		}
	}

	// A fetch killed with its caller (the 110 s command cap) may still be
	// running; one writer at a time.
	if _, left := ctrs[n.Fetch]; left {
		if _, err := m.docker(ctx, "removing the leftover fetch "+n.Fetch, "rm", "-f", n.Fetch); err != nil {
			return err
		}
	}
	out, code, err := m.Docker.Run(ctx, FetchArgs(req, tag, m.UID, m.GID, src, rels))
	if err != nil {
		return fmt.Errorf("%s: could not run docker: %v", step, err)
	}
	if code != 0 {
		return fmt.Errorf("%s: docker said (exit %d): %s", step, code, tail(out))
	}
	m.fetched[req.Change] = merged
	return nil
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
