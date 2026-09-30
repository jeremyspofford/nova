package caps

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"novad/internal/state"
)

// UpdateDeps is what daemon.update needs from the running agent (S42b P7).
type UpdateDeps struct {
	Supervised bool          // a supervisor started this agent and will swap
	Binary     string        // the running binary; the build is staged beside it
	StateDir   string        // where update.json lives
	BaseURL    func() string // the locator this connection came through
	HTTP       *http.Client
}

// MaxBinaryBytes caps a download (a variable so a test can lower it).
var MaxBinaryBytes int64 = 64 << 20

var (
	hex12 = regexp.MustCompile(`^[0-9a-f]{12}$`)
	hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// distPath matches one of the hub's agent builds. .exe is captured
	// separately from goos (preflight minor, S42b Task 10): the plan's
	// original pattern let .exe trail ANY goos, so both
	// "novad-windows-amd64" (no .exe) and "novad-linux-amd64.exe" would have
	// matched. RE2 (Go's regexp) has no lookaround to tie them inline, so
	// daemonUpdate checks the pairing itself right after the match.
	distPath = regexp.MustCompile(`^/api/v1/agent/dist/novad-(linux|darwin|windows)-(amd64|arm64)(\.exe)?$`)
)

// daemonUpdate downloads the hub's build the signed envelope names, checks
// its sha256, and stages it beside the running binary for supervise to swap
// in. It restarts nothing itself: Outcome.Restart asks the client to exit 75
// after this result is on the wire. A download that does not match is deleted
// and nothing is staged.
func daemonUpdate(ctx context.Context, r Request) Outcome {
	u := r.Deps.Update
	if u == nil {
		return fail("cannot: this agent is not running connected to Nova, so it has nothing to update from")
	}
	version, _ := strArg(r.Args, "version")
	sum, _ := strArg(r.Args, "sha256")
	path, _ := strArg(r.Args, "path")
	switch {
	case !hex12.MatchString(version):
		return fail("daemon.update needs a 12-hex version, got %q", version)
	case !hex64.MatchString(sum):
		return fail("daemon.update needs a 64-hex sha256")
	}
	m := distPath.FindStringSubmatch(path)
	if m == nil {
		return fail("daemon.update's path must be one of the hub's agent builds, got %q", path)
	}
	goos, arch, ext := m[1], m[2], m[3]
	if (goos == "windows") != (ext == ".exe") {
		// windows always ships .exe; linux and darwin never do.
		return fail("daemon.update's path must be one of the hub's agent builds, got %q", path)
	}
	if goos != runtime.GOOS || arch != runtime.GOARCH {
		return fail("cannot: %s is not this machine's build (%s/%s)", path, runtime.GOOS, runtime.GOARCH)
	}
	if !u.Supervised {
		return fail("cannot: this agent was started by hand, not by its service, so nothing would start a new build — install the service (novad install) and it updates itself")
	}
	if u.Binary == "" || !filepath.IsAbs(u.Binary) || u.StateDir == "" || !filepath.IsAbs(u.StateDir) {
		// Fix round 1, Minor 2: a relative or empty Binary/StateDir would
		// stage (or record) beside whatever the process's current
		// directory happens to be — never safe to guess at.
		return fail("cannot: this agent's binary and state directory must both be configured with absolute paths before it can stage an update")
	}
	base := ""
	if u.BaseURL != nil {
		base = strings.TrimRight(u.BaseURL(), "/")
	}
	if base == "" {
		return fail("cannot: this agent has no hub address to download from")
	}
	staged := u.Binary + ".new"
	part := staged + ".part"
	got, size, err := download(ctx, u.HTTP, base+path, part)
	if err != nil {
		_ = os.Remove(part)
		return fail("could not download %s: %v", path, err)
	}
	if got != sum {
		_ = os.Remove(part)
		return fail("the download's sha256 is %s, not the signed %s — nothing staged", got, sum)
	}
	if err := os.Chmod(part, 0o755); err != nil {
		_ = os.Remove(part)
		return fail("could not mark the new build executable: %v", err)
	}
	if err := os.Rename(part, staged); err != nil {
		_ = os.Remove(part)
		return fail("could not stage the new build: %v", err)
	}
	rec := state.Update{V: 1, Version: version, SHA256: sum, Staged: staged, Outcome: state.UpdateStaged, At: time.Now().UTC()}
	if err := state.WriteJSON(filepath.Join(u.StateDir, state.UpdateFile), rec); err != nil {
		_ = os.Remove(staged)
		return fail("could not record the staged update: %v", err)
	}
	out := ok0(fmt.Sprintf("staged %s (%d bytes, sha256 %s…); restarting into it now — the update is confirmed only when this agent reconnects reporting %s",
		version, size, sum[:12], version))
	out.Restart = true
	return out
}

func download(ctx context.Context, c *http.Client, url, dst string) (string, int64, error) {
	if c == nil {
		c = &http.Client{
			Timeout: 100 * time.Second,
			// Fix round 1, Minor 3: the download must stay on the locator
			// this connection is on. The first response is used as-is —
			// http.ErrUseLastResponse stops net/http from silently
			// following a redirect to another host; a redirect then reads
			// as a non-200 status below, refused like any other bad answer.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", 0, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("the hub answered %s", resp.Status)
	}
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o700)
	if err != nil {
		return "", 0, err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, MaxBinaryBytes+1))
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", n, err
	}
	if n > MaxBinaryBytes {
		return "", n, fmt.Errorf("the build is over the %d MiB cap", MaxBinaryBytes>>20)
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}
