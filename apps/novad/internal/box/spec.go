// Package box is the run spec of a change's sealed dev container (S32.2,
// spec §4). The spec is Go code inside novad, built from main: a change can
// edit its own worktree but never the shape of the box it runs in (the v3
// lesson, §4.1).
//
// This file is pure — it derives names and docker argv and refuses at the
// edge; it never runs docker. Every argv omits the leading "docker": it is
// what the Docker seam's Run(ctx, argv) receives.
//
// Paths are Linux paths (package path, not filepath): the box runs on the
// Linux hub only, and the spec must read the same on every GOOS.
package box

import (
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// PostgresImage is the box's own Postgres, pinned by digest (postgres:16 on
// the hub, 2026-10-11). A tag alone would let a registry push change what
// runs beside her code.
const PostgresImage = "postgres:16@sha256:a3b7f434b2dc57ce85a67e171163eb8ab1a1ebcb39d27484661f26b1dfbe30d6"

// Label marks every docker object a box owns; its value is the change id.
const Label = "nova.box"

// The box's fixed environment (§4.2): its own Postgres and a HOME that is
// not the owner's. Nothing from the host.
const (
	TestDatabaseURL = "postgresql://postgres@db:5432/postgres"
	BoxHome         = "/tmp/home"
	// BoxUser names the box's user for tools that ask for one. The box runs
	// as the owner's uid, which the image has no passwd entry for, so
	// getpwuid fails and Python's getpass.getuser() raised KeyError — 12 core
	// tests failed in the box and passed on the host (S30c walk, 2026-10-13).
	// getpass and most tools read USER/LOGNAME first. A fixed name, never
	// the host's user.
	BoxUser   = "nova"
	DepsMount = "/deps"
)

// The db's own caps: it holds disposable test data only.
const (
	dbMemory = "1g"
	dbPids   = "512"
)

// Limits are the box's resource bounds, read live from core's box.*
// settings (§9.5) and bounds-checked here with the same bounds.
type Limits struct {
	CPUs       int
	MemoryGB   int
	Pids       int
	MaxRunning int
}

// Request is everything core may send about a box (D3). novad derives every
// path from Checkout + Change; nothing else (mounts, flags, image, env)
// comes over the wire.
type Request struct {
	Checkout string
	Change   string
	Branch   string
	Cwd      string
	Limits   Limits
}

// BoxNames are the docker object names of one change's box.
type BoxNames struct {
	Box, DB, Net, Cache, Fetch string
}

// Names derives every docker object name from the change id.
func Names(change string) BoxNames {
	b := "nova-box-" + change
	return BoxNames{Box: b, DB: b + "-db", Net: b + "-net", Cache: b + "-cache", Fetch: b + "-fetch"}
}

// Worktree is the change's worktree: <checkout>/.worktrees/nova-<change>.
func Worktree(checkout, change string) string {
	return path.Join(checkout, ".worktrees", "nova-"+change)
}

var (
	changeShape = regexp.MustCompile(`^[0-9a-f]{6}$`)
	// The same shape core stores a default branch under (code_repos.BRANCH_SHAPE).
	branchShape = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$`)
)

// ValidChange is whether change has a change id's shape (6 lowercase hex) —
// the one rule Validate and Remove hold, for a caller that sends only an id.
func ValidChange(change string) bool { return changeShape.MatchString(change) }

type bound struct {
	name   string
	val    int
	lo, hi int
}

// Validate refuses a request at the edge, each refusal naming the field and
// the value it was given.
func Validate(req Request) error {
	if !changeShape.MatchString(req.Change) {
		return fmt.Errorf("change %q is not a change id (6 lowercase hex)", req.Change)
	}
	c := req.Checkout
	switch {
	case !strings.HasPrefix(c, "/"):
		return fmt.Errorf("checkout %q is not an absolute path", c)
	case path.Clean(c) != c:
		return fmt.Errorf("checkout %q is not a clean path (it cleans to %q)", c, path.Clean(c))
	case c == "/":
		return fmt.Errorf("checkout %q is the filesystem root", c)
	case strings.ContainsAny(c, ":,"):
		// ':' and ',' are docker's -v / --mount separators: a checkout
		// carrying one could rewrite the mount it names.
		return fmt.Errorf("checkout %q carries ':' or ',', which a docker mount cannot hold", c)
	}
	if !branchShape.MatchString(req.Branch) || strings.Contains(req.Branch, "..") {
		return fmt.Errorf("branch %q is not a branch name", req.Branch)
	}
	wt := Worktree(c, req.Change)
	cwd := req.Cwd
	switch {
	case !strings.HasPrefix(cwd, "/"):
		return fmt.Errorf("cwd %q is not an absolute path", cwd)
	case path.Clean(cwd) != cwd:
		return fmt.Errorf("cwd %q is not a clean path (it cleans to %q)", cwd, path.Clean(cwd))
	case cwd != wt && !strings.HasPrefix(cwd, wt+"/"):
		return fmt.Errorf("cwd %q is not inside the change's worktree %s", cwd, wt)
	}
	l := req.Limits
	for _, b := range []bound{
		{"cpus", l.CPUs, 1, 16},
		{"memory_gb", l.MemoryGB, 1, 64},
		{"pids", l.Pids, 64, 65536},
		{"max_running", l.MaxRunning, 1, 8},
	} {
		if b.val < b.lo || b.val > b.hi {
			return fmt.Errorf("%s limit %d is outside %d..%d", b.name, b.val, b.lo, b.hi)
		}
	}
	return nil
}

// NetworkArgs creates the box's own internal network: the box and its
// Postgres, no route out (§4.2). --internal alone still puts an address on
// the host's bridge, and the seal test (T12) measured the box reaching a
// host listener on 0.0.0.0 through it; gateway mode isolated (docker 28+)
// leaves the bridge without one, so the host is not on the box's network.
func NetworkArgs(change string) []string {
	return []string{"network", "create", "--internal",
		"-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
		"--label", Label + "=" + change, Names(change).Net}
}

// DBArgs runs the box's own Postgres on the box network under the alias
// "db": nothing published, data on tmpfs, trust auth (reachable only from
// the box).
func DBArgs(change string) []string {
	n := Names(change)
	return []string{
		"run", "-d",
		"--name", n.DB,
		"--network", n.Net,
		"--network-alias", "db",
		"--security-opt", "no-new-privileges",
		"--memory", dbMemory,
		"--pids-limit", dbPids,
		"--tmpfs", "/var/lib/postgresql/data",
		"-e", "POSTGRES_HOST_AUTH_METHOD=trust",
		"--label", Label + "=" + change,
		PostgresImage,
	}
}

// BoxArgs is the box itself, exactly §4.2: the worktree rw at its own path,
// the repo's .git ro at its own path (the worktree's .git file points there),
// the change's dependency cache ro but for its uv part (rw, T12 ruling),
// the owner's uid/gid, no capabilities, no new privileges, the limits, two
// env vars and nothing else. Mounts are derived from req.Checkout +
// req.Change — never from req.Cwd.
func BoxArgs(req Request, image string, uid, gid int) []string {
	n := Names(req.Change)
	wt := Worktree(req.Checkout, req.Change)
	gitDir := path.Join(req.Checkout, ".git")
	return []string{
		"run", "-d",
		"--name", n.Box,
		"--network", n.Net,
		"--init",
		"--user", strconv.Itoa(uid) + ":" + strconv.Itoa(gid),
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--memory", strconv.Itoa(req.Limits.MemoryGB) + "g",
		"--pids-limit", strconv.Itoa(req.Limits.Pids),
		"--cpus", strconv.Itoa(req.Limits.CPUs),
		// exec: docker mounts a --tmpfs noexec by default, and `go test`
		// runs its test binaries from /tmp (T12 measured "permission
		// denied"). The worktree is exec anyway; noexec here sealed nothing.
		"--tmpfs", "/tmp:exec",
		"-e", "TEST_DATABASE_URL=" + TestDatabaseURL,
		"-e", "HOME=" + BoxHome,
		"-e", "USER=" + BoxUser,
		"-e", "LOGNAME=" + BoxUser,
		"-v", wt + ":" + wt + ":rw",
		"-v", gitDir + ":" + gitDir + ":ro",
		"-v", n.Cache + ":" + DepsMount + ":ro",
		// The uv part of the change's own cache, read-write (T12 ruling,
		// option 1): uv takes a lock and writes temp files in its cache and
		// fails on a read-only one, so no Python suite could run. npm, go
		// and the fetch marker (/deps/.nova-locks) stay read-only; the
		// volume is this change's alone and removed with its box.
		"--mount", "type=volume,src=" + n.Cache + ",dst=" + DepsMount + "/uv,volume-subpath=uv",
		"--label", Label + "=" + req.Change,
		image,
		"sleep", "infinity",
	}
}
