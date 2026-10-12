package box

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Runner is the one seam every docker and git call goes through (D2). argv
// omits the binary. err means the binary could not be run at all; a
// non-zero exit means it ran and said no — out carries its words.
type Runner interface {
	Run(ctx context.Context, argv []string) (out string, exit int, err error)
}

// ExecRunner is the real Runner: Bin ("docker", "git") run with no shell,
// stdout and stderr combined.
type ExecRunner struct{ Bin string }

func (r ExecRunner) Run(ctx context.Context, argv []string) (string, int, error) {
	out, err := exec.CommandContext(ctx, r.Bin, argv...).CombinedOutput()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return string(out), ee.ExitCode(), nil
	}
	if err != nil {
		return string(out), -1, err
	}
	return string(out), 0, nil
}

// State is one box as Ensure left it. Image is what the box actually runs
// (a running box keeps the image it started from, A4).
type State struct {
	Box    string
	Status string
	Image  string
}

// Manager runs a change's box over the seams: Docker for every docker call,
// Git to read main's deploy/devbox tree hash. UID/GID are the owner's — the
// box runs as him.
type Manager struct {
	Docker Runner
	Git    Runner
	Now    func() time.Time
	UID    int
	GID    int

	// DockerBin is the docker binary box.exec runs its exec through
	// ("docker" when empty).
	DockerBin string

	// Busy names the changes whose box runs a live job (S30c): Reap never
	// stops one. nil means no job store — nothing is busy.
	Busy func() (map[string]bool, error)

	mu      sync.Mutex
	lastUse map[string]time.Time
	// fetched is each change's dependency marker as this agent knows it;
	// labels the devbox image's lockfile labels by tag (T8).
	fetched map[string]map[string]string
	labels  map[string]map[string]string
}

// ImagePrefix is the devbox image's repository; the tag is t-<tree hash>.
const ImagePrefix = "nova-devbox:t-"

var treeHash = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)

// ImageTag is the devbox image built from <branch>'s committed
// deploy/devbox: nova-devbox:t-<git rev-parse <branch>:deploy/devbox>.
// The shape comes from the branch's commit, never the worktree (D4).
func (m *Manager) ImageTag(ctx context.Context, checkout, branch string) (string, error) {
	out, code, err := m.Git.Run(ctx, []string{"-C", checkout, "rev-parse", branch + ":deploy/devbox"})
	if err != nil {
		return "", fmt.Errorf("reading %s's deploy/devbox: could not run git: %v", branch, err)
	}
	if code != 0 {
		return "", fmt.Errorf("reading %s's deploy/devbox: git said (exit %d): %s", branch, code, strings.TrimSpace(out))
	}
	h := strings.TrimSpace(out)
	if !treeHash.MatchString(h) {
		return "", fmt.Errorf("reading %s's deploy/devbox: git answered %q, not a tree hash", branch, h)
	}
	return ImagePrefix + h, nil
}

type ctr struct{ state, image string }

// docker runs one step; any failure names the step and quotes docker.
func (m *Manager) docker(ctx context.Context, step string, argv ...string) (string, error) {
	out, code, err := m.Docker.Run(ctx, argv)
	if err != nil {
		return "", fmt.Errorf("%s: could not run docker: %v", step, err)
	}
	if code != 0 {
		return "", fmt.Errorf("%s: docker said (exit %d): %s", step, code, strings.TrimSpace(out))
	}
	return out, nil
}

// containers lists every container carrying the box label, by name.
func (m *Manager) containers(ctx context.Context) (map[string]ctr, error) {
	out, err := m.docker(ctx, "listing the boxes",
		"ps", "-a", "--filter", "label="+Label, "--format", "{{.Names}}\t{{.State}}\t{{.Image}}")
	if err != nil {
		return nil, err
	}
	got := map[string]ctr{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(strings.TrimSpace(line), "\t")
		if len(f) != 3 {
			continue
		}
		got[f[0]] = ctr{state: f[1], image: f[2]}
	}
	return got, nil
}

// boxChange is the change id of a box container name, "" for anything else
// (its db, a foreign container).
func boxChange(name string) string {
	id, ok := strings.CutPrefix(name, "nova-box-")
	if !ok || !changeShape.MatchString(id) {
		return ""
	}
	return id
}

func (m *Manager) exists(ctx context.Context, step, kind, name string) (bool, error) {
	out, err := m.docker(ctx, step, kind, "ls", "-q", "--filter", "name=^"+name+"$")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(out) != "", nil
}

// Ensure brings the change's box up: the image must exist (built by
// ./install), then the network, cache volume, db and box are created if
// missing and started if stopped. A running box is left alone. A new start
// past max_running is a stated cannot naming the running boxes.
func (m *Manager) Ensure(ctx context.Context, req Request) (State, error) {
	if err := Validate(req); err != nil {
		return State{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	n := Names(req.Change)

	tag, err := m.ImageTag(ctx, req.Checkout, req.Branch)
	if err != nil {
		return State{}, err
	}
	out, err := m.docker(ctx, "checking the image "+tag, "image", "ls", "-q", tag)
	if err != nil {
		return State{}, err
	}
	if strings.TrimSpace(out) == "" {
		return State{}, fmt.Errorf("the box image %s%s for %s's deploy/devbox is not built — ./install from the checkout builds it; nothing was run",
			ImagePrefix, strings.TrimPrefix(tag, ImagePrefix)[:12], req.Branch)
	}

	ctrs, err := m.containers(ctx)
	if err != nil {
		return State{}, err
	}
	box, haveBox := ctrs[n.Box]
	db, haveDB := ctrs[n.DB]
	boxUp := haveBox && box.state == "running"

	if !boxUp {
		if err := m.underLimit(req, ctrs); err != nil {
			return State{}, err
		}
	}
	if !boxUp || !haveDB || db.state != "running" {
		ok, err := m.exists(ctx, "looking up the network "+n.Net, "network", n.Net)
		if err != nil {
			return State{}, err
		}
		if !ok {
			if _, err := m.docker(ctx, "creating the network "+n.Net, NetworkArgs(req.Change)...); err != nil {
				return State{}, err
			}
		}
	}
	freshCache := false
	if !haveBox {
		// A box that exists holds its volume (docker refuses to remove a
		// volume in use, and rm -f keeps named volumes), so only a box about
		// to be created can be missing it.
		ok, err := m.exists(ctx, "looking up the dependency cache volume "+n.Cache, "volume", n.Cache)
		if err != nil {
			return State{}, err
		}
		if !ok {
			if _, err := m.docker(ctx, "creating the dependency cache volume "+n.Cache,
				"volume", "create", "--label", Label+"="+req.Change, n.Cache); err != nil {
				return State{}, err
			}
			freshCache = true
		}
	}
	// The dependency fetch (T8): before the db and box start, and under a
	// running box when her lockfiles moved.
	if err := m.fetchLocked(ctx, req, tag, ctrs, freshCache); err != nil {
		return State{}, err
	}
	switch {
	case !haveDB:
		if _, err := m.docker(ctx, "starting the database "+n.DB, DBArgs(req.Change)...); err != nil {
			return State{}, err
		}
	case db.state != "running":
		if _, err := m.docker(ctx, "starting the database "+n.DB, "start", n.DB); err != nil {
			return State{}, err
		}
	}

	st := State{Box: n.Box, Status: "running", Image: tag}
	switch {
	case boxUp:
		st.Image = box.image
	case haveBox && box.image == tag:
		if _, err := m.docker(ctx, "starting the box "+n.Box, "start", n.Box); err != nil {
			return State{}, err
		}
	default:
		if haveBox {
			// Stopped on an older main's image: the shape is main's, so it is
			// rebuilt from the current tag (A4). /tmp is tmpfs and the
			// worktree a mount, so nothing of hers lives in it.
			if _, err := m.docker(ctx, "removing the box "+n.Box+" built from "+box.image, "rm", "-f", n.Box); err != nil {
				return State{}, err
			}
		}
		if _, err := m.docker(ctx, "creating the box "+n.Box, BoxArgs(req, tag, m.UID, m.GID)...); err != nil {
			return State{}, err
		}
	}
	m.touchLocked(req.Change)
	return st, nil
}

// underLimit refuses a new start when max_running other boxes are running,
// naming each with how long it has been idle.
func (m *Manager) underLimit(req Request, ctrs map[string]ctr) error {
	var running []string
	for name, c := range ctrs {
		if id := boxChange(name); id != "" && id != req.Change && c.state == "running" {
			running = append(running, id)
		}
	}
	if len(running) < req.Limits.MaxRunning {
		return nil
	}
	sort.Strings(running)
	parts := make([]string, len(running))
	for i, id := range running {
		idle := "idle unknown: running before this agent started"
		if t, ok := m.lastUse[id]; ok {
			idle = fmt.Sprintf("idle %dm", int(m.Now().Sub(t)/time.Minute))
		}
		parts[i] = fmt.Sprintf("%s (%s)", Names(id).Box, idle)
	}
	return fmt.Errorf("cannot start %s: %d boxes are already running and box.max_running is %d — %s; nothing was started",
		Names(req.Change).Box, len(running), req.Limits.MaxRunning, strings.Join(parts, ", "))
}

func (m *Manager) touchLocked(change string) {
	if m.lastUse == nil {
		m.lastUse = map[string]time.Time{}
	}
	m.lastUse[change] = m.Now()
}

// Status is every box's state by change id: "running" or "stopped". A
// docker failure is an error, never an empty map.
func (m *Manager) Status(ctx context.Context) (map[string]string, error) {
	ctrs, err := m.containers(ctx)
	if err != nil {
		return nil, err
	}
	got := map[string]string{}
	for name, c := range ctrs {
		id := boxChange(name)
		if id == "" {
			continue
		}
		if c.state == "running" {
			got[id] = "running"
		} else {
			got[id] = "stopped"
		}
	}
	return got, nil
}

// Remove takes down everything a change's box owns: box, db, network and
// cache volume (S32.3's close/land calls it, D9). What is already gone is
// skipped.
func (m *Manager) Remove(ctx context.Context, change string) error {
	if !changeShape.MatchString(change) {
		return fmt.Errorf("change %q is not a change id (6 lowercase hex)", change)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	n := Names(change)
	ctrs, err := m.containers(ctx)
	if err != nil {
		return err
	}
	var gone []string
	for _, name := range []string{n.Box, n.DB} {
		if _, ok := ctrs[name]; ok {
			gone = append(gone, name)
		}
	}
	if len(gone) > 0 {
		if _, err := m.docker(ctx, "removing "+strings.Join(gone, " and "), append([]string{"rm", "-f"}, gone...)...); err != nil {
			return err
		}
	}
	for _, o := range []struct{ kind, name string }{{"network", n.Net}, {"volume", n.Cache}} {
		ok, err := m.exists(ctx, "looking up the "+o.kind+" "+o.name, o.kind, o.name)
		if err != nil {
			return err
		}
		if ok {
			if _, err := m.docker(ctx, "removing the "+o.kind+" "+o.name, o.kind, "rm", o.name); err != nil {
				return err
			}
		}
	}
	delete(m.lastUse, change)
	delete(m.fetched, change)
	return nil
}

// ExecArgv is the full argv that runs argv inside the change's box, as the
// owner, in req.Cwd: <docker> exec -w <cwd> -u <uid>:<gid> nova-box-<id> argv...
func (m *Manager) ExecArgv(req Request, argv []string) []string {
	return m.ExecArgvEnv(req, nil, argv)
}

// ExecArgvEnv is ExecArgv with `-e NAME` for each env key before the box
// name (S30c T8): docker reads each value from its OWN environment, so a
// value never sits in an argv (ps, /proc/<pid>/cmdline).
func (m *Manager) ExecArgvEnv(req Request, envKeys, argv []string) []string {
	bin := m.DockerBin
	if bin == "" {
		bin = "docker"
	}
	out := []string{bin, "exec", "-w", req.Cwd, "-u", m.owner()}
	for _, k := range envKeys {
		out = append(out, "-e", k)
	}
	out = append(out, Names(req.Change).Box)
	return append(out, argv...)
}

// IdleStop is how long a box may sit unused before Reap stops it (spec §4.2:
// idle stop 30 min). Stopping frees its CPU and memory; S32.3 removes it.
const IdleStop = 30 * time.Minute

// Touch records a use of the change's box now: Ensure does on every
// bring-up, box.exec again when its exec returns.
func (m *Manager) Touch(change string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.touchLocked(change)
}

// LastUse is when the change's box was last used, as far as this agent knows
// (a box it never touched or saw has no record).
func (m *Manager) LastUse(change string) (time.Time, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.lastUse[change]
	return t, ok
}

// Reap stops every running box idle for IdleStop or longer — the box and its
// db, if that runs — and returns the boxes it stopped. A running box with no
// record (started before this agent) is recorded at first sight and never
// stopped on that tick. A failed stop keeps its record, so the next tick
// retries it; the other idle boxes are still stopped, and every failure comes
// back in the error, naming the box and quoting docker. A box whose change
// runs a live job (Busy, S30c) is never stopped: it is touched instead, so
// its idle time counts from the last tick that saw the job; when Busy cannot
// be read, nothing is stopped.
func (m *Manager) Reap(ctx context.Context) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ctrs, err := m.containers(ctx)
	if err != nil {
		return nil, err
	}
	var ids []string
	for name, c := range ctrs {
		if id := boxChange(name); id != "" && c.state == "running" {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	// A box running a job is in use however long ago anything touched it
	// (a 40-minute suite outlives IdleStop). Unread jobs stop nothing.
	busy := map[string]bool{}
	if m.Busy != nil {
		b, err := m.Busy()
		if err != nil {
			return nil, fmt.Errorf("reading which boxes run a job: %v; no box was stopped", err)
		}
		busy = b
	}
	now := m.Now()
	var stopped []string
	var errs []error
	for _, id := range ids {
		if busy[id] {
			m.touchLocked(id)
			continue
		}
		last, ok := m.lastUse[id]
		if !ok {
			m.touchLocked(id)
			continue
		}
		if now.Sub(last) < IdleStop {
			continue
		}
		n := Names(id)
		argv := []string{"stop", n.Box}
		if db, ok := ctrs[n.DB]; ok && db.state == "running" {
			argv = append(argv, n.DB)
		}
		if _, err := m.docker(ctx, fmt.Sprintf("stopping the idle box %s (idle %dm)", n.Box, int(now.Sub(last)/time.Minute)), argv...); err != nil {
			errs = append(errs, err)
			continue
		}
		delete(m.lastUse, id)
		stopped = append(stopped, n.Box)
	}
	return stopped, errors.Join(errs...)
}

// JobPidfile is where a box job's in-box pid is written (the box's /tmp).
func JobPidfile(id string) string { return "/tmp/novad-job-" + id + ".pid" }

// jobShim is the sh a box job's argv runs under: it writes its own pid
// (in the box's pid namespace) to the pidfile named by $0, then execs her
// argv in its place, so that pid IS her command — the one job.stop kills.
// Killing the host's docker exec client does not end a process in the box.
const jobShim = `echo $$ >"$0"; exec "$@"`

// JobArgv is what a box job's wrapper runs (S30c): <docker> exec -w <cwd>
// -u <uid>:<gid> -e NAME... nova-box-<id> sh -c <jobShim> <pidfile> argv...
// Env values are never on it: `-e NAME` makes the docker client pass the
// value from its own environment, which the wrapper gives it.
func (m *Manager) JobArgv(req Request, id string, envKeys, argv []string) []string {
	bin := m.DockerBin
	if bin == "" {
		bin = "docker"
	}
	out := []string{bin, "exec", "-w", req.Cwd, "-u", m.owner()}
	for _, k := range envKeys {
		out = append(out, "-e", k)
	}
	out = append(out, Names(req.Change).Box, "sh", "-c", jobShim, JobPidfile(id))
	return append(out, argv...)
}

func (m *Manager) owner() string { return strconv.Itoa(m.UID) + ":" + strconv.Itoa(m.GID) }

var pidShape = regexp.MustCompile(`^[1-9][0-9]{0,9}$`)

// KillJob signals a box job INSIDE its box: it reads the pid the job's shim
// wrote, then sends TERM (KILL when hard) to that pid's process group — a
// docker exec'd process leads its own group (measured 2026-10-12) — and to
// the pid itself when the group is gone. The image has no kill binary, so
// sh's builtin does it. A pidfile not written yet is an error naming why,
// and nothing is signalled.
func (m *Manager) KillJob(ctx context.Context, change, id string, hard bool) error {
	if !changeShape.MatchString(change) {
		return fmt.Errorf("change %q is not a change id (6 lowercase hex)", change)
	}
	n := Names(change)
	out, err := m.docker(ctx, "reading job "+id+"'s pid in "+n.Box, "exec", "-u", m.owner(), n.Box, "cat", JobPidfile(id))
	if err != nil {
		return err
	}
	pid := strings.TrimSpace(out)
	if !pidShape.MatchString(pid) {
		return fmt.Errorf("job %s's pidfile in %s holds %q, not a pid", id, n.Box, pid)
	}
	sig := "TERM"
	if hard {
		sig = "KILL"
	}
	script := `kill -` + sig + ` -"$1" 2>/dev/null || kill -` + sig + ` "$1"`
	_, err = m.docker(ctx, "signalling job "+id+" (pid "+pid+") in "+n.Box, "exec", "-u", m.owner(), n.Box, "sh", "-c", script, "kill", pid)
	return err
}
