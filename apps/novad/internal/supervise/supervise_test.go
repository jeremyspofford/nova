package supervise

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"novad/internal/platform"
	"novad/internal/state"
)

type fakeChild struct {
	pid    int
	exit   chan int
	killed atomic.Bool
}

func (c *fakeChild) PID() int           { return c.pid }
func (c *fakeChild) Wait() (int, error) { return <-c.exit, nil }
func (c *fakeChild) Kill() error {
	if c.killed.CompareAndSwap(false, true) {
		select {
		case c.exit <- -9:
		default:
		}
	}
	return nil
}

// step is what one spawned agent does: after delay, write "ready" as that
// version (when ready is set), then exit with code — or block until killed.
type step struct {
	ready string
	exit  int
	block bool
	delay time.Duration
}

type fakeSpawner struct {
	stateDir string
	steps    []step
	mu       sync.Mutex
	from     []string   // the binary's CONTENT each agent was started from
	envs     [][]string // each agent's environment
}

func (f *fakeSpawner) spawn(_ context.Context, bin string, _ []string, env []string) (Child, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := os.ReadFile(bin)
	f.from = append(f.from, string(body))
	f.envs = append(f.envs, env)
	n := len(f.from) - 1
	c := &fakeChild{pid: 1000 + n, exit: make(chan int, 1)}
	st := step{block: true}
	if n < len(f.steps) {
		st = f.steps[n]
	}
	go func() {
		time.Sleep(st.delay)
		if st.ready != "" {
			_ = state.WriteJSON(filepath.Join(f.stateDir, state.AgentStatusFile), state.AgentStatus{
				V: 1, PID: c.pid, Version: st.ready, State: state.StateReady, Since: time.Now()})
		}
		if !st.block {
			c.exit <- st.exit
		}
	}()
	return c, nil
}

func (f *fakeSpawner) spawned() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.from...)
}

type rig struct {
	dir, bin string
	sp       *fakeSpawner
	slept    []time.Duration
	mu       sync.Mutex
}

func newRig(t *testing.T, steps ...step) *rig {
	t.Helper()
	dir := t.TempDir()
	r := &rig{dir: dir, bin: filepath.Join(dir, "novad"), sp: &fakeSpawner{stateDir: dir, steps: steps}}
	if err := os.WriteFile(r.bin, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	return r
}

func (r *rig) config() Config {
	return Config{
		Binary: r.bin, StateDir: r.dir, Mode: "run-key", Version: "0123456789ab",
		Spawn: r.sp.spawn, ConfirmWithin: 300 * time.Millisecond, PollEvery: 10 * time.Millisecond,
		Sleep: func(ctx context.Context, d time.Duration) error {
			r.mu.Lock()
			r.slept = append(r.slept, d)
			r.mu.Unlock()
			return ctx.Err()
		},
	}
}

// stage writes a staged build with content and records it in update.json;
// sum overrides the recorded sha256 (a tampered or truncated staged file).
func (r *rig) stage(t *testing.T, content, version, sum string) {
	t.Helper()
	staged := r.bin + ".new"
	if err := os.WriteFile(staged, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	if sum == "" {
		h := sha256.Sum256([]byte(content))
		sum = hex.EncodeToString(h[:])
	}
	if err := state.WriteJSON(filepath.Join(r.dir, state.UpdateFile), state.Update{
		V: 1, Version: version, SHA256: sum, Staged: staged, Outcome: state.UpdateStaged, At: time.Now()}); err != nil {
		t.Fatal(err)
	}
}

func (r *rig) update(t *testing.T) state.Update {
	t.Helper()
	var u state.Update
	if err := state.ReadJSON(filepath.Join(r.dir, state.UpdateFile), &u); err != nil {
		t.Fatal(err)
	}
	return u
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// runUntil runs supervise in the background and cancels it once cond holds.
func runUntil(t *testing.T, cfg Config, cond func() bool) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan int, 1)
	go func() { done <- Run(ctx, cfg) }()
	for !cond() {
		select {
		case code := <-done:
			return code
		case <-time.After(5 * time.Millisecond):
		}
		if ctx.Err() != nil {
			t.Fatal("the condition never held")
		}
	}
	cancel()
	return <-done
}

// P3: an agent that can never get in stops the supervisor for good, with 0.
func TestSuperviseStopsForGoodWhenTheAgentCannotGetIn(t *testing.T) {
	r := newRig(t, step{exit: ExitFinal})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if code := Run(ctx, r.config()); code != 0 {
		t.Fatalf("exit %d, want 0", code)
	}
	if ctx.Err() != nil {
		t.Fatal("Run did not return on its own after exit 78")
	}
	if n := len(r.sp.spawned()); n != 1 {
		t.Fatalf("spawned %d agents, want 1 — a final exit is never restarted", n)
	}
	var sv state.SupervisorStatus
	if err := state.ReadJSON(filepath.Join(r.dir, state.SupervisorStatusFile), &sv); err != nil || sv.LastExit == nil || *sv.LastExit != ExitFinal {
		t.Fatalf("supervisor status = %+v, %v", sv, err)
	}
}

func TestSuperviseRestartsACrashedAgentWithBackoff(t *testing.T) {
	r := newRig(t, step{exit: 1}, step{exit: 1})
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 3 })
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.slept) < 2 || r.slept[0] != time.Second || r.slept[1] != 2*time.Second {
		t.Fatalf("slept %v, want 1s then 2s", r.slept)
	}
}

func TestTheAgentIsToldItsModeAndItsSupervisor(t *testing.T) {
	r := newRig(t)
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 1 })
	env := strings.Join(r.sp.envs[0], "\n")
	for _, want := range []string{platform.ModeEnv + "=run-key", platform.SupervisorEnv + "="} {
		if !strings.Contains(env, want) {
			t.Fatalf("the agent's environment lacks %s", want)
		}
	}
}

func TestAStagedUpdateIsSwappedInAndConfirmedByReady(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{ready: "aaaaaaaaaaaa", block: true})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	runUntil(t, r.config(), func() bool {
		var u state.Update
		return state.ReadJSON(filepath.Join(r.dir, state.UpdateFile), &u) == nil && u.Outcome == state.UpdateApplied
	})
	if got := read(t, r.bin); got != "new" {
		t.Fatalf("installed build = %q, want the new one", got)
	}
	if got := read(t, r.bin+".prev"); got != "old" {
		t.Fatalf(".prev = %q, want the old build kept", got)
	}
	if from := r.sp.spawned(); len(from) < 2 || from[1] != "new" {
		t.Fatalf("agents started from %v", from)
	}
}

// Review focus 1: a build that never connects is put back.
func TestAStagedBuildThatNeverReachesReadyIsRolledBack(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{block: true})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 3 })
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "did not connect within") {
		t.Fatalf("update = %+v", u)
	}
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q, want the old one back", got)
	}
	if got := read(t, r.bin+".failed"); got != "new" {
		t.Fatalf(".failed = %q", got)
	}
	if from := r.sp.spawned(); from[2] != "old" {
		t.Fatalf("the agent after the revert started from %q", from[2])
	}
}

func TestAStagedBuildThatExitsAtOnceIsRolledBack(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{exit: 2})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 3 })
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "exited with 2 before it connected") {
		t.Fatalf("update = %+v", u)
	}
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q", got)
	}
}

func TestAStagedFileWhoseHashDoesNotMatchIsNotSwapped(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged})
	r.stage(t, "new", "aaaaaaaaaaaa", strings.Repeat("0", 64))
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 2 })
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q — a mismatched file must never be swapped in", got)
	}
	if u := r.update(t); u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "sha256") {
		t.Fatalf("update = %+v", u)
	}
}

func TestTheBackoffResetsAfterAStableRun(t *testing.T) {
	r := newRig(t, step{exit: 1}, step{exit: 1})
	cfg := r.config()
	cfg.StableAfter = time.Nanosecond // every run counts as stable
	runUntil(t, cfg, func() bool { return len(r.sp.spawned()) == 3 })
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.slept) < 2 || r.slept[1] != time.Second {
		t.Fatalf("slept %v, want the ladder to restart at 1s", r.slept)
	}
}
