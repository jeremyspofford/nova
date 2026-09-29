package supervise

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
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
// A stopped agent exits 0 when the supervisor's context ends, as `novad run`
// does when the service manager stops the whole group at once. With
// startErr, the agent never starts: the spawn itself fails.
type step struct {
	ready    string
	exit     int
	block    bool
	stopped  bool
	startErr string
	delay    time.Duration
}

type fakeSpawner struct {
	stateDir string
	steps    []step
	mu       sync.Mutex
	from     []string   // the binary's CONTENT each agent was started from
	envs     [][]string // each agent's environment
}

func (f *fakeSpawner) spawn(ctx context.Context, bin string, _ []string, env []string) (Child, error) {
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
	if st.startErr != "" {
		return nil, errors.New(st.startErr)
	}
	go func() {
		time.Sleep(st.delay)
		if st.ready != "" {
			_ = state.WriteJSON(filepath.Join(f.stateDir, state.AgentStatusFile), state.AgentStatus{
				V: 1, PID: c.pid, Version: st.ready, State: state.StateReady, Since: time.Now()})
		}
		switch {
		case st.stopped:
			<-ctx.Done()
			select {
			case c.exit <- 0:
			default: // already killed
			}
		case !st.block:
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
// Supervise returning before cond holds — on its own, or because the 10 s
// bound ran out — fails the test: it is never a quiet return that the
// test's later checks could read as a pass.
func runUntil(t *testing.T, cfg Config, cond func() bool) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan int, 1)
	go func() { done <- Run(ctx, cfg) }()
	for !cond() {
		select {
		case code := <-done:
			if !cond() {
				t.Fatalf("supervise returned %d (ctx: %v) before the condition held", code, ctx.Err())
			}
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
	// Each read of this clock is a minute after the last, so every run
	// measures a full StableAfter (the default minute) — never 0, which a
	// coarse OS clock (a Windows tick) can measure for a fast run.
	start := time.Now()
	var reads atomic.Int64
	cfg.Now = func() time.Time { return start.Add(time.Duration(reads.Add(1)) * time.Minute) }
	runUntil(t, cfg, func() bool { return len(r.sp.spawned()) == 3 })
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.slept) < 2 || r.slept[1] != time.Second {
		t.Fatalf("slept %v, want the ladder to restart at 1s", r.slept)
	}
}

// stopMidConfirm stages a build, lets a supervisor swap it in and start it,
// and stops that supervisor before the build confirms: what a service stop, a
// crash or a reboot inside the window leaves on disk. The rig's first two
// steps must be an exit 75 and an agent that never reaches ready.
func (r *rig) stopMidConfirm(t *testing.T) {
	t.Helper()
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 2 })
	if u, got := r.update(t), read(t, r.bin); u.Outcome != state.UpdateStaged || got != "new" {
		t.Fatalf("stopped mid-confirm: update = %+v, installed build = %q", u, got)
	}
}

// Review focus 1 across a restart: the next supervisor confirms a build that
// was swapped in but never confirmed...
func TestASupervisorRestartedMidConfirmConfirmsAGoodBuild(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{block: true})
	r.stopMidConfirm(t)
	r.sp = &fakeSpawner{stateDir: r.dir, steps: []step{{ready: "aaaaaaaaaaaa", block: true}}}
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
	if from := r.sp.spawned(); from[0] != "new" {
		t.Fatalf("the restarted supervisor's agent started from %q", from[0])
	}
}

// ...and puts .prev back when that build never connects.
func TestASupervisorRestartedMidConfirmRevertsABuildThatNeverReachesReady(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{block: true})
	r.stopMidConfirm(t)
	r.sp = &fakeSpawner{stateDir: r.dir} // every agent blocks and never writes ready
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 2 })
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
	if from := r.sp.spawned(); from[0] != "new" || from[1] != "old" {
		t.Fatalf("agents started from %v, want the unconfirmed build, then the old one", from)
	}
}

// A stop during confirm is not a failed build, even when the agent's own exit
// (the service manager ends the whole group) lands with the stop: nothing is
// recorded and nothing reverted, so the next start confirms it. Repeated, so
// both orders of the agent's exit and the stop are seen.
func TestACancelDuringConfirmRecordsNothingAndRevertsNothing(t *testing.T) {
	for i := 0; i < 20; i++ {
		r := newRig(t, step{exit: ExitUpdateStaged}, step{stopped: true})
		r.stage(t, "new", "aaaaaaaaaaaa", "")
		cfg := r.config()
		// Pace the confirm poll without ending it on the stop, so the agent's
		// exit is often already waiting when the stop is seen.
		cfg.Sleep = func(context.Context, time.Duration) error { time.Sleep(time.Millisecond); return nil }
		runUntil(t, cfg, func() bool { return len(r.sp.spawned()) == 2 })
		if u := r.update(t); u.Outcome != state.UpdateStaged || u.Reason != "" {
			t.Fatalf("run %d: a stop was recorded as %q (%s)", i, u.Outcome, u.Reason)
		}
		if got := read(t, r.bin); got != "new" {
			t.Fatalf("run %d: a stop put back the old build (installed = %q)", i, got)
		}
		if _, err := os.Lstat(r.bin + ".failed"); err == nil {
			t.Fatalf("run %d: a stop left a .failed build", i)
		}
	}
}

// With no .prev there is nothing to put back, so a staged record whose file
// is gone is not confirmed: the agent runs as it is, and no rollback that
// could not happen is recorded.
func TestAnUnconfirmedSwapWithNoPreviousBuildIsNotConfirmed(t *testing.T) {
	r := newRig(t, step{exit: 1})
	if err := state.WriteJSON(filepath.Join(r.dir, state.UpdateFile), state.Update{
		V: 1, Version: "aaaaaaaaaaaa", Staged: r.bin + ".new", Outcome: state.UpdateStaged, At: time.Now()}); err != nil {
		t.Fatal(err)
	}
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 2 })
	if u := r.update(t); u.Outcome != state.UpdateStaged || u.Reason != "" {
		t.Fatalf("update = %+v", u)
	}
}

// swapRevert makes revertBuild fake for one test.
func swapRevert(t *testing.T, fake func(string) error) {
	t.Helper()
	was := revertBuild
	revertBuild = fake
	t.Cleanup(func() { revertBuild = was })
}

// logLines collects what a supervisor logs.
type logLines struct {
	mu    sync.Mutex
	lines []string
}

func (l *logLines) logf(format string, a ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, a...))
}

func (l *logLines) contain(s string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, line := range l.lines {
		if strings.Contains(line, s) {
			return true
		}
	}
	return false
}

// rolled_back is recorded only when the revert happened. A revert that fails
// records nothing: the build that never connected is still installed. The
// failure is logged with its reason, and the build is confirmed again on the
// backoff ladder, so the revert is retried.
func TestAFailedRevertRecordsNothingAndIsRetried(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{exit: 2}, step{exit: 2})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	var reverts atomic.Int32
	swapRevert(t, func(string) error { reverts.Add(1); return errors.New("the disk refused") })
	var logged logLines
	cfg := r.config()
	cfg.Logf = logged.logf
	runUntil(t, cfg, func() bool { return reverts.Load() >= 2 })
	if u := r.update(t); u.Outcome != state.UpdateStaged || u.Reason != "" {
		t.Fatalf("a revert that failed was recorded: %+v", u)
	}
	if got := read(t, r.bin); got != "new" {
		t.Fatalf("installed build = %q", got)
	}
	if from := r.sp.spawned(); len(from) < 3 || from[1] != "new" || from[2] != "new" {
		t.Fatalf("agents started from %v, want the unconfirmed build confirmed again", from)
	}
	if !logged.contain("the disk refused") {
		t.Fatalf("the failed revert is not logged with its reason: %q", logged.lines)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !slices.Contains(r.slept, time.Second) {
		t.Fatalf("slept %v, want the retry on the backoff ladder (1s first)", r.slept)
	}
}

func TestARevertThatLaterSucceedsRecordsRolledBackOnce(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{exit: 2}, step{exit: 2})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	var reverts atomic.Int32
	var atRetry atomic.Value // update.json's outcome as the revert is retried
	swapRevert(t, func(bin string) error {
		if reverts.Add(1) == 1 {
			return errors.New("the disk refused")
		}
		var u state.Update
		_ = state.ReadJSON(filepath.Join(r.dir, state.UpdateFile), &u)
		atRetry.Store(u.Outcome)
		return Revert(bin)
	})
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 4 })
	if got, _ := atRetry.Load().(string); got != state.UpdateStaged {
		t.Fatalf("update.json said %q when the revert was retried, want staged: the failed one recorded it", got)
	}
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "exited with 2") || strings.Contains(u.Reason, "refused") {
		t.Fatalf("update = %+v, want rolled_back for the build that failed, recorded by the revert that happened", u)
	}
	if n := reverts.Load(); n != 2 {
		t.Fatalf("%d reverts, want 2: one that failed, one retried", n)
	}
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q, want the old one back", got)
	}
	if from := r.sp.spawned(); from[3] != "old" {
		t.Fatalf("the agent after the revert started from %q", from[3])
	}
}

// The revert's other way in: a new build that cannot even start.
func TestANewBuildThatCannotStartIsRolledBack(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{startErr: "exec format error"})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 3 })
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "could not start: exec format error") {
		t.Fatalf("update = %+v", u)
	}
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q, want the old one back", got)
	}
	if got := read(t, r.bin+".failed"); got != "new" {
		t.Fatalf(".failed = %q", got)
	}
	if from := r.sp.spawned(); from[1] != "new" || from[2] != "old" {
		t.Fatalf("agents started from %v", from)
	}
}

// An install over an interrupted confirm places another build. It is not the
// build update.json says was swapped in, so it is not confirmed as that one,
// and never reverted to an older .prev.
func TestAnotherBuildInstalledOverAnInterruptedConfirmIsNotReverted(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{block: true})
	r.stopMidConfirm(t)
	if err := os.WriteFile(r.bin, []byte("installed"), 0o755); err != nil {
		t.Fatal(err)
	}
	r.sp = &fakeSpawner{stateDir: r.dir, steps: []step{{exit: 1}}}
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 2 })
	if from := r.sp.spawned(); from[0] != "installed" || from[1] != "installed" {
		t.Fatalf("agents started from %v, want the installed build, never the older .prev", from)
	}
	if u := r.update(t); u.Outcome != state.UpdateStaged || u.Reason != "" {
		t.Fatalf("update = %+v", u)
	}
	if got := read(t, r.bin+".prev"); got != "old" {
		t.Fatalf(".prev = %q", got)
	}
}

// A staged build never swapped in (.new still there), beside an older .prev
// from an earlier update: nothing was swapped, so nothing is confirmed.
func TestAStagedBuildBesideAnOlderPrevIsNotConfirmed(t *testing.T) {
	r := newRig(t, step{exit: 1})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	if err := os.WriteFile(r.bin+".prev", []byte("older"), 0o755); err != nil {
		t.Fatal(err)
	}
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 2 })
	if from := r.sp.spawned(); from[0] != "old" || from[1] != "old" {
		t.Fatalf("agents started from %v, want the installed build", from)
	}
	if u := r.update(t); u.Outcome != state.UpdateStaged || u.Reason != "" {
		t.Fatalf("update = %+v", u)
	}
	if got := read(t, r.bin+".prev"); got != "older" {
		t.Fatalf(".prev = %q", got)
	}
}

// A Windows sign-out ends the agent first, and the detached supervisor gets no
// signal. A supervisor torn down inside the grace after its agent's exit never
// reverts: the build stays staged for the next start to confirm.
func TestASupervisorTornDownInsideTheExitGraceNeverReverts(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{exit: 1})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cfg := r.config()
	var graced atomic.Bool
	cfg.Sleep = func(ctx context.Context, d time.Duration) error {
		if d == exitGrace {
			graced.Store(true)
			cancel() // torn down while it waits
		}
		return ctx.Err()
	}
	Run(ctx, cfg)
	if !graced.Load() || !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatalf("the agent's exit was not given its grace (graced %v, ctx %v)", graced.Load(), ctx.Err())
	}
	if u := r.update(t); u.Outcome != state.UpdateStaged || u.Reason != "" {
		t.Fatalf("a supervisor torn down inside the grace recorded %+v", u)
	}
	if got := read(t, r.bin); got != "new" {
		t.Fatalf("installed build = %q: a supervisor torn down inside the grace reverted", got)
	}
}

// A build whose status says it connected is never reported as exiting
// "before it connected" (here it connected as another version).
func TestABuildThatConnectedAndThenExitedIsNotSaidToHaveExitedBeforeItConnected(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{ready: "bbbbbbbbbbbb", exit: 2})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 3 })
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || strings.Contains(u.Reason, "before it connected") ||
		!strings.Contains(u.Reason, "exited with 2 after it connected as bbbbbbbbbbbb") {
		t.Fatalf("update = %+v", u)
	}
}

// ...nor, when it never exits, as one that "did not connect".
func TestABuildThatConnectedAsAnotherVersionIsNotSaidNotToHaveConnected(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{ready: "bbbbbbbbbbbb", block: true})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 3 })
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || strings.Contains(u.Reason, "did not connect") ||
		!strings.Contains(u.Reason, "connected as bbbbbbbbbbbb, not aaaaaaaaaaaa") {
		t.Fatalf("update = %+v", u)
	}
}

// scriptRenames makes each rename whose source refuse answers for fail with
// that answer; every other rename is os.Rename. The real Swap, restore and
// revert run on top.
func scriptRenames(t *testing.T, refuse func(from string) error) {
	t.Helper()
	was := rename
	rename = func(from, to string) error {
		if err := refuse(from); err != nil {
			return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
		}
		return os.Rename(from, to)
	}
	t.Cleanup(func() { rename = was })
}

// A swap that fails but puts the running build back records rolled_back: the
// build that was running is verifiably in place again.
func TestAFailedSwapWhoseRestoreSucceedsRecordsRolledBack(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	scriptRenames(t, func(from string) error {
		if strings.HasSuffix(from, ".new") {
			return errors.New("no space left")
		}
		return nil
	})
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 2 })
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "moving the new build into place") {
		t.Fatalf("update = %+v", u)
	}
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q, want the running one back", got)
	}
	if from := r.sp.spawned(); from[1] != "old" {
		t.Fatalf("the next agent started from %q", from[1])
	}
}

// A swap that fails and cannot put the running build back either leaves
// nothing installed. It records nothing (no build is in place to have been
// rolled back to), says why, starts nothing, and retries the restore on the
// backoff ladder.
func TestAFailedSwapWhoseRestoreFailsRecordsNothingAndRetries(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	var restores atomic.Int32
	scriptRenames(t, func(from string) error {
		switch {
		case strings.HasSuffix(from, ".new"):
			return errors.New("no space left")
		case strings.HasSuffix(from, ".prev"):
			restores.Add(1)
			return errors.New("the disk refused")
		}
		return nil
	})
	var logged logLines
	cfg := r.config()
	cfg.Logf = logged.logf
	runUntil(t, cfg, func() bool { return restores.Load() >= 3 }) // the swap's own, then two retries
	if u := r.update(t); u.Outcome != state.UpdateStaged || u.Reason != "" {
		t.Fatalf("a swap that left nothing installed recorded %+v", u)
	}
	if n := len(r.sp.spawned()); n != 1 {
		t.Fatalf("%d agents started, want none after the swap left nothing installed", n)
	}
	if _, err := os.Lstat(r.bin); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("something is installed: %v", err)
	}
	if !logged.contain("the disk refused") {
		t.Fatalf("why the restore failed is not logged: %q", logged.lines)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !slices.Contains(r.slept, time.Second) || !slices.Contains(r.slept, 2*time.Second) {
		t.Fatalf("slept %v, want the restore retried on the backoff ladder", r.slept)
	}
}

// A restore that succeeds later records rolled_back exactly once, and only
// then: until the running build is back, nothing is recorded.
func TestARestoreThatLaterSucceedsRecordsRolledBackExactlyOnce(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	var restores atomic.Int32
	var mu sync.Mutex
	var seen []string // update.json's outcome at each restore
	scriptRenames(t, func(from string) error {
		switch {
		case strings.HasSuffix(from, ".new"):
			return errors.New("no space left")
		case strings.HasSuffix(from, ".prev"):
			var u state.Update
			_ = state.ReadJSON(filepath.Join(r.dir, state.UpdateFile), &u)
			mu.Lock()
			seen = append(seen, u.Outcome)
			mu.Unlock()
			if restores.Add(1) <= 2 {
				return errors.New("the disk refused")
			}
		}
		return nil
	})
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 2 })
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(seen, []string{state.UpdateStaged, state.UpdateStaged, state.UpdateStaged}) {
		t.Fatalf("update.json at each restore = %q, want staged until the one that succeeded", seen)
	}
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "moving the new build into place") {
		t.Fatalf("update = %+v", u)
	}
	if n := restores.Load(); n != 3 {
		t.Fatalf("%d restores, want 3: two that failed, one that succeeded", n)
	}
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q", got)
	}
	if from := r.sp.spawned(); from[1] != "old" {
		t.Fatalf("the next agent started from %q", from[1])
	}
}

// A supervisor that starts with nothing installed, the previous build at
// .prev and the update still staged (the last one stopped while its restore
// kept failing) puts the build back first, and records the rollback then.
func TestASupervisorStartingWithNothingInstalledPutsThePreviousBuildBack(t *testing.T) {
	r := newRig(t)
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	if err := os.Rename(r.bin, r.bin+".prev"); err != nil {
		t.Fatal(err)
	}
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 1 })
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q, want the previous one back", got)
	}
	if u := r.update(t); u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "put back") {
		t.Fatalf("update = %+v", u)
	}
	if from := r.sp.spawned(); from[0] != "old" {
		t.Fatalf("the agent started from %q", from[0])
	}
}

// An agent is never started from a missing binary without saying so.
func TestStartingWithNoBuildInstalledSaysSo(t *testing.T) {
	r := newRig(t)
	if err := os.Remove(r.bin); err != nil {
		t.Fatal(err)
	}
	var logged logLines
	cfg := r.config()
	cfg.Logf = logged.logf
	runUntil(t, cfg, func() bool { return len(r.sp.spawned()) == 1 })
	if !logged.contain("no build is installed at " + r.bin) {
		t.Fatalf("an agent was started from a missing binary without saying so: %q", logged.lines)
	}
}

// P3 holds while a revert fails: an unconfirmed build that exits 78 (it can
// never get in) and cannot be reverted is not respawned forever. Run ends with
// 0 and records nothing; update.json stays staged, so the next start confirms
// it again and retries the revert.
func TestAnExit78DuringAConfirmWhoseRevertFailsStopsForGood(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{exit: ExitFinal}, step{exit: ExitFinal}, step{exit: ExitFinal})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	swapRevert(t, func(string) error { return errors.New("the disk refused") })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if code := Run(ctx, r.config()); code != 0 {
		t.Fatalf("exit %d, want 0", code)
	}
	if ctx.Err() != nil {
		t.Fatalf("Run did not stop on its own: %d agents started, the 78 starved", len(r.sp.spawned()))
	}
	if n := len(r.sp.spawned()); n != 2 {
		t.Fatalf("%d agents started, want 2 — a build that exited 78 is never respawned", n)
	}
	if u := r.update(t); u.Outcome != state.UpdateStaged || u.Reason != "" {
		t.Fatalf("update = %+v, want nothing recorded", u)
	}
	var sv state.SupervisorStatus
	if err := state.ReadJSON(filepath.Join(r.dir, state.SupervisorStatusFile), &sv); err != nil || sv.LastExit == nil || *sv.LastExit != ExitFinal {
		t.Fatalf("supervisor status = %+v, %v; want the 78 recorded as its last exit", sv, err)
	}
}

// A revert that can neither put .prev back nor return the failed build to its
// place leaves nothing installed. The log says so, never "it stays
// installed". Nothing is started from the missing binary: the previous build
// is put back first. The rolled_back then recorded carries the original
// reason and that nothing was installed, never a spawn error. The failed
// build is kept as .failed.
func TestARevertThatLeavesNothingInstalledSaysSoAndKeepsTheFailedBuild(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{exit: 2})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	var fromPrev atomic.Int32
	scriptRenames(t, func(from string) error {
		switch {
		case strings.HasSuffix(from, ".prev"): // putting the previous build back: the revert's try fails
			if fromPrev.Add(1) == 1 {
				return errors.New("the disk refused")
			}
		case strings.HasSuffix(from, ".failed"): // returning the failed build to its place
			return errors.New("the disk refused again")
		}
		return nil
	})
	var logged logLines
	cfg := r.config()
	cfg.Logf = logged.logf
	runUntil(t, cfg, func() bool { return len(r.sp.spawned()) == 3 })
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "exited with 2 before it connected") ||
		!strings.Contains(u.Reason, "nothing installed") || strings.Contains(u.Reason, "could not start") {
		t.Fatalf("update = %+v, want the original reason and that nothing was installed", u)
	}
	if !logged.contain("nothing is installed at "+r.bin) || logged.contain("it stays installed") {
		t.Fatalf("the log does not say nothing is installed: %q", logged.lines)
	}
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q, want the previous one back", got)
	}
	if got := read(t, r.bin+".failed"); got != "new" {
		t.Fatalf(".failed = %q, want the failed build kept", got)
	}
	if from := r.sp.spawned(); from[2] != "old" {
		t.Fatalf("agents started from %q, want nothing from the missing binary, then the previous build", from)
	}
}

// A "ready" older than this agent (from before it started, under its reused
// pid) is not taken as it connecting, the same guard the confirm uses.
func TestAStaleReadyIsNotTakenAsTheNewBuildConnecting(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{exit: 2})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	if err := state.WriteJSON(filepath.Join(r.dir, state.AgentStatusFile), state.AgentStatus{
		V: 1, PID: 1001, Version: "bbbbbbbbbbbb", State: state.StateReady, Since: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 3 })
	if u := r.update(t); u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "exited with 2 before it connected") {
		t.Fatalf("update = %+v, want the stale ready ignored", u)
	}
}

// A build whose ready as its own version landed after the last poll, just
// before it exited, did connect: it is confirmed — never reverted, never
// "connected as X, not X" — and its exit is handled as after any confirm.
func TestABuildThatConnectedAsItsVersionBeforeExitingIsConfirmed(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{exit: 2})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	cfg := r.config()
	cfg.Sleep = func(ctx context.Context, d time.Duration) error {
		if d == exitGrace {
			_ = state.WriteJSON(filepath.Join(r.dir, state.AgentStatusFile), state.AgentStatus{
				V: 1, PID: 1001, Version: "aaaaaaaaaaaa", State: state.StateReady, Since: time.Now()})
		}
		return ctx.Err()
	}
	runUntil(t, cfg, func() bool { return len(r.sp.spawned()) == 3 })
	if u := r.update(t); u.Outcome != state.UpdateApplied || strings.Contains(u.Reason, "not aaaaaaaaaaaa") {
		t.Fatalf("update = %+v, want the build that connected confirmed", u)
	}
	if got := read(t, r.bin); got != "new" {
		t.Fatalf("installed build = %q, want the confirmed build kept", got)
	}
	if from := r.sp.spawned(); from[2] != "new" {
		t.Fatalf("after its exit the agent restarted from %q, want the confirmed build", from[2])
	}
}

// When the resume cannot read the installed binary to tell whether it is the
// build that was swapped in, it says so. It is never a silent skip, and it
// still confirms nothing.
func TestAResumeThatCannotReadTheBinarySaysWhy(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{block: true})
	r.stopMidConfirm(t)
	if err := os.Remove(r.bin); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(r.bin, 0o700); err != nil { // present, but no file to hash
		t.Fatal(err)
	}
	r.sp = &fakeSpawner{stateDir: r.dir}
	var logged logLines
	cfg := r.config()
	cfg.Logf = logged.logf
	runUntil(t, cfg, func() bool { return len(r.sp.spawned()) == 1 })
	if !logged.contain("cannot tell whether " + r.bin) {
		t.Fatalf("the unreadable binary is not said: %q", logged.lines)
	}
	if u := r.update(t); u.Outcome != state.UpdateStaged || u.Reason != "" {
		t.Fatalf("update = %+v", u)
	}
}

// An exit 78 whose revert leaves nothing installed does not stop the
// supervisor there. Returning would leave the service manager no binary to
// start. .prev is put back first, on the backoff ladder, with nothing
// started meanwhile. Then a 78 from the restored build is final.
func TestAnExit78WhoseRevertLeftNothingInstalledIsRestoredThenStopsForGood(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{exit: ExitFinal}, step{exit: ExitFinal})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	var fromPrev atomic.Int32
	scriptRenames(t, func(from string) error {
		switch {
		case strings.HasSuffix(from, ".prev"):
			if fromPrev.Add(1) <= 2 { // the revert's try, then one restore retry
				return errors.New("the disk refused")
			}
		case strings.HasSuffix(from, ".failed"):
			return errors.New("the disk refused again")
		}
		return nil
	})
	var logged logLines
	cfg := r.config()
	cfg.Logf = logged.logf
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if code := Run(ctx, cfg); code != 0 || ctx.Err() != nil {
		t.Fatalf("Run = %d (ctx %v), want 0 on its own; agents started from %q", code, ctx.Err(), r.sp.spawned())
	}
	if from := r.sp.spawned(); !slices.Equal(from, []string{"old", "new", "old"}) {
		t.Fatalf("agents started from %q, want [old new old]: the 78 stopped the supervisor with nothing installed; logs %q", from, logged.lines)
	}
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "exited with 78 before it connected") ||
		!strings.Contains(u.Reason, "nothing installed") {
		t.Fatalf("update = %+v", u)
	}
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q", got)
	}
	if got := read(t, r.bin+".failed"); got != "new" {
		t.Fatalf(".failed = %q", got)
	}
	if n := fromPrev.Load(); n != 3 {
		t.Fatalf("%d renames from .prev, want 3: the revert's, a failed retry, the restore", n)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var ladder []time.Duration
	for _, d := range r.slept {
		if d != 10*time.Millisecond { // the confirm's polls
			ladder = append(ladder, d)
		}
	}
	if !slices.Equal(ladder, []time.Duration{exitGrace, time.Second, 2 * time.Second}) {
		t.Fatalf("slept %v, want the exit's grace, then the ladder 1s, 2s", r.slept)
	}
}

// A new build that cannot even start, whose revert then leaves nothing
// installed. Nothing is started from the missing binary: the previous build
// is put back first. The rollback recorded says why — the spawn error, and
// that nothing was installed.
func TestANewBuildThatCannotStartWhoseRevertLeavesNothingInstalledIsRestored(t *testing.T) {
	r := newRig(t, step{exit: ExitUpdateStaged}, step{startErr: "exec format error"})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	var fromPrev atomic.Int32
	scriptRenames(t, func(from string) error {
		switch {
		case strings.HasSuffix(from, ".prev"):
			if fromPrev.Add(1) == 1 { // the revert's try
				return errors.New("the disk refused")
			}
		case strings.HasSuffix(from, ".failed"):
			return errors.New("the disk refused again")
		}
		return nil
	})
	runUntil(t, r.config(), func() bool { return len(r.sp.spawned()) == 3 })
	if from := r.sp.spawned(); !slices.Equal(from, []string{"old", "new", "old"}) {
		t.Fatalf("agents started from %q, want nothing from the missing binary before the previous build is back", from)
	}
	u := r.update(t)
	if u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "could not start: exec format error") ||
		!strings.Contains(u.Reason, "nothing installed") {
		t.Fatalf("update = %+v", u)
	}
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q", got)
	}
	if got := read(t, r.bin+".failed"); got != "new" {
		t.Fatalf(".failed = %q", got)
	}
}

// stopWhileRestoring runs a supervisor whose swap fails and leaves nothing
// installed, stopping it while it waits to retry the restore. lastTry says
// whether the rename from .prev works once the stop has come.
func stopWhileRestoring(t *testing.T, lastTry bool) (*rig, *logLines) {
	t.Helper()
	r := newRig(t, step{exit: ExitUpdateStaged})
	r.stage(t, "new", "aaaaaaaaaaaa", "")
	var stopping atomic.Bool
	scriptRenames(t, func(from string) error {
		switch {
		case strings.HasSuffix(from, ".new"):
			return errors.New("no space left")
		case strings.HasSuffix(from, ".prev"):
			if !stopping.Load() || !lastTry {
				return errors.New("the disk refused")
			}
		}
		return nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	logged := &logLines{}
	cfg := r.config()
	cfg.Logf = logged.logf
	cfg.Sleep = func(ctx context.Context, d time.Duration) error {
		if d == time.Second { // waiting to retry the restore: the service is stopped
			stopping.Store(true)
			cancel()
		}
		return ctx.Err()
	}
	if code := Run(ctx, cfg); code != 0 || !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatalf("Run = %d (ctx %v), want 0 on the stop", code, ctx.Err())
	}
	if n := len(r.sp.spawned()); n != 1 {
		t.Fatalf("%d agents started, want none after the swap left nothing installed", n)
	}
	return r, logged
}

// A stop while nothing is installed makes one last try to put the previous
// build back before returning. Otherwise the service manager would have no
// binary to start any later supervisor with. It is back: said, and
// recorded.
func TestAStopWhileNothingIsInstalledPutsThePreviousBuildBackFirst(t *testing.T) {
	r, logged := stopWhileRestoring(t, true)
	if got := read(t, r.bin); got != "old" {
		t.Fatalf("installed build = %q, want the previous one back before the supervisor returned", got)
	}
	if !logged.contain("stopping: the previous build is back at " + r.bin) {
		t.Fatalf("the last restore is not logged: %q", logged.lines)
	}
	if u := r.update(t); u.Outcome != state.UpdateRolledBack || !strings.Contains(u.Reason, "moving the new build into place") {
		t.Fatalf("update = %+v", u)
	}
}

// ...and when the last try fails too, that is said, and nothing is recorded.
func TestAStopWhoseLastRestoreFailsSaysSoAndRecordsNothing(t *testing.T) {
	r, logged := stopWhileRestoring(t, false)
	if _, err := os.Lstat(r.bin); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("something is installed: %v", err)
	}
	if !logged.contain("stopping with nothing installed at " + r.bin) {
		t.Fatalf("the failed last restore is not logged: %q", logged.lines)
	}
	if u := r.update(t); u.Outcome != state.UpdateStaged || u.Reason != "" {
		t.Fatalf("update = %+v", u)
	}
}
