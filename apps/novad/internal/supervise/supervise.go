// Package supervise is the parent every service starts (hub D3, S42b): it
// runs `novad run`, restarts it after a crash, stops for good when the agent
// can never get in, and swaps in a staged update — putting the previous
// build back when the new one does not connect (P7).
package supervise

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"novad/internal/platform"
	"novad/internal/state"
)

const (
	// ExitUpdateStaged is `novad run`'s exit after daemon.update staged a build.
	ExitUpdateStaged = 75
	// ExitFinal is `novad run`'s exit when it can never get in.
	ExitFinal = 78
)

// Child is one running agent.
type Child interface {
	PID() int
	Wait() (int, error) // the exit code; an error only when waiting failed
	Kill() error
}

// Spawner starts bin with args and env.
type Spawner func(ctx context.Context, bin string, args, env []string) (Child, error)

// Config is one supervisor's settings; zero values take the defaults.
type Config struct {
	Binary        string
	StateDir      string
	Mode          string
	Version       string
	Spawn         Spawner
	Now           func() time.Time
	Sleep         func(context.Context, time.Duration) error
	ConfirmWithin time.Duration
	PollEvery     time.Duration
	Backoffs      []time.Duration
	StableAfter   time.Duration
	Logf          func(string, ...any)
}

func withDefaults(c Config) Config {
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Sleep == nil {
		c.Sleep = sleepCtx
	}
	if c.ConfirmWithin == 0 {
		c.ConfirmWithin = 120 * time.Second
	}
	if c.PollEvery == 0 {
		c.PollEvery = 500 * time.Millisecond
	}
	if len(c.Backoffs) == 0 {
		c.Backoffs = []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 15 * time.Second, 30 * time.Second}
	}
	if c.StableAfter == 0 {
		c.StableAfter = time.Minute
	}
	if c.Logf == nil {
		c.Logf = func(string, ...any) {}
	}
	return c
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Run supervises `Binary run` until ctx ends or the agent can never get in.
// Both return 0 (P3): a unit restarts only on failure, and this is never a
// failure — a supervisor that exited non-zero on purpose would be restarted
// into the same state.
func Run(ctx context.Context, cfg Config) int {
	s := &sup{cfg: withDefaults(cfg), since: time.Now().UTC()}
	removeOld(s.cfg.Binary)
	return s.loop(ctx)
}

type sup struct {
	cfg      Config
	since    time.Time
	restarts int
	lastExit *int
	childPID int
}

type readyOutcome int

const (
	readyOK readyOutcome = iota
	readyFailed
	readyStopped
)

func (s *sup) loop(ctx context.Context) int {
	attempt := 0
	confirm := "" // the version a just-swapped build must connect as
	for ctx.Err() == nil {
		started := s.cfg.Now()
		child, err := s.cfg.Spawn(ctx, s.cfg.Binary, []string{"run"}, s.env())
		if err != nil {
			if confirm != "" {
				s.revert(confirm, fmt.Sprintf("the new build could not start: %v", err))
				confirm = ""
				continue
			}
			s.cfg.Logf("could not start the agent: %v", err)
			if s.cfg.Sleep(ctx, s.backoff(attempt)) != nil {
				return 0
			}
			attempt++
			continue
		}
		s.childPID = child.PID()
		s.writeStatus()
		exited := make(chan int, 1)
		go func() {
			code, werr := child.Wait()
			if werr != nil {
				s.cfg.Logf("waiting for the agent: %v", werr)
				code = -1
			}
			exited <- code
		}()
		if confirm != "" {
			outcome, code, reason := s.awaitReady(ctx, child.PID(), exited, confirm, started)
			switch outcome {
			case readyStopped:
				_ = child.Kill()
				<-exited
				return 0
			case readyFailed:
				if code == nil {
					_ = child.Kill()
					<-exited
				}
				s.revert(confirm, reason)
				confirm = ""
				continue
			}
			s.record(confirm, state.UpdateApplied, "")
			s.cfg.Logf("the new build %s connected", confirm)
			confirm = ""
		}
		var code int
		select {
		case code = <-exited:
		case <-ctx.Done():
			_ = child.Kill()
			<-exited
			return 0
		}
		s.restarts++
		s.lastExit = &code
		s.writeStatus()
		switch code {
		case ExitFinal:
			s.cfg.Logf("the agent cannot get in (not enrolled, or revoked) — stopping for good")
			return 0
		case ExitUpdateStaged:
			v, err := s.swapStaged()
			if err != nil {
				s.cfg.Logf("a staged update cannot be applied: %v — running the current build", err)
				break
			}
			s.cfg.Logf("swapped in %s; waiting up to %s for it to connect", v, s.cfg.ConfirmWithin)
			confirm = v
			attempt = 0
			continue
		}
		if ctx.Err() != nil {
			return 0
		}
		if s.cfg.Now().Sub(started) >= s.cfg.StableAfter {
			attempt = 0
		}
		if s.cfg.Sleep(ctx, s.backoff(attempt)) != nil {
			return 0
		}
		attempt++
	}
	return 0
}

// awaitReady waits for the new agent to write "ready" as version (its own
// pid, since it started), to exit, or for the bound — whichever is first.
func (s *sup) awaitReady(ctx context.Context, pid int, exited <-chan int, version string, started time.Time) (readyOutcome, *int, string) {
	path := filepath.Join(s.cfg.StateDir, state.AgentStatusFile)
	deadline := s.cfg.Now().Add(s.cfg.ConfirmWithin)
	for {
		var st state.AgentStatus
		if state.ReadJSON(path, &st) == nil && st.PID == pid && st.State == state.StateReady &&
			st.Version == version && !st.Since.Before(started.Add(-time.Second)) {
			return readyOK, nil, ""
		}
		select {
		case code := <-exited:
			return readyFailed, &code, fmt.Sprintf("the new build exited with %d before it connected%s", code, lastError(path, pid))
		case <-ctx.Done():
			return readyStopped, nil, ""
		default:
		}
		if !s.cfg.Now().Before(deadline) {
			return readyFailed, nil, fmt.Sprintf("the new build did not connect within %s%s", s.cfg.ConfirmWithin, lastError(path, pid))
		}
		if s.cfg.Sleep(ctx, s.cfg.PollEvery) != nil {
			return readyStopped, nil, ""
		}
	}
}

func lastError(path string, pid int) string {
	var st state.AgentStatus
	if state.ReadJSON(path, &st) == nil && st.PID == pid && st.Error != "" {
		return "; its last error: " + st.Error
	}
	return ""
}

func (s *sup) swapStaged() (string, error) {
	var u state.Update
	if err := state.ReadJSON(filepath.Join(s.cfg.StateDir, state.UpdateFile), &u); err != nil {
		return "", fmt.Errorf("no staged update: %w", err)
	}
	if u.Outcome != state.UpdateStaged {
		return "", fmt.Errorf("the last update is %q, not staged", u.Outcome)
	}
	sum, err := platform.FileSHA256(u.Staged)
	if err != nil {
		s.record(u.Version, state.UpdateRolledBack, fmt.Sprintf("the staged build is unreadable: %v", err))
		return "", err
	}
	if sum != u.SHA256 {
		reason := fmt.Sprintf("the staged build's sha256 is %s, not %s — not applied", sum, u.SHA256)
		s.record(u.Version, state.UpdateRolledBack, reason)
		return "", fmt.Errorf("%s", reason)
	}
	if err := Swap(s.cfg.Binary, u.Staged); err != nil {
		s.record(u.Version, state.UpdateRolledBack, err.Error())
		return "", err
	}
	return u.Version, nil
}

func (s *sup) revert(version, reason string) {
	if err := Revert(s.cfg.Binary); err != nil {
		reason += fmt.Sprintf("; putting the previous build back failed too: %v", err)
	}
	s.cfg.Logf("rolled back %s: %s", version, reason)
	s.record(version, state.UpdateRolledBack, reason)
}

// record writes an update's outcome, keeping what daemon.update staged.
func (s *sup) record(version, outcome, reason string) {
	path := filepath.Join(s.cfg.StateDir, state.UpdateFile)
	var u state.Update
	_ = state.ReadJSON(path, &u)
	u.V, u.Version, u.Outcome, u.Reason, u.At = 1, version, outcome, reason, s.cfg.Now().UTC()
	if err := state.WriteJSON(path, u); err != nil {
		s.cfg.Logf("could not record the update's outcome: %v", err)
	}
}

func (s *sup) env() []string {
	return append(os.Environ(),
		platform.ModeEnv+"="+s.cfg.Mode,
		platform.SupervisorEnv+"="+strconv.Itoa(os.Getpid()))
}

func (s *sup) backoff(attempt int) time.Duration {
	return s.cfg.Backoffs[min(attempt, len(s.cfg.Backoffs)-1)]
}

func (s *sup) writeStatus() {
	st := state.SupervisorStatus{V: 1, PID: os.Getpid(), Version: s.cfg.Version, Mode: s.cfg.Mode,
		ChildPID: s.childPID, Restarts: s.restarts, LastExit: s.lastExit, Since: s.since}
	if err := state.WriteJSON(filepath.Join(s.cfg.StateDir, state.SupervisorStatusFile), st); err != nil {
		s.cfg.Logf("could not write the supervisor status: %v", err)
	}
}

// execChild is an agent ExecSpawner started. PID and Wait are the same on
// every OS; Kill is not (spawn_unix.go asks with SIGTERM, spawn_windows.go
// ends it at once).
type execChild struct{ cmd *exec.Cmd }

func (c *execChild) PID() int { return c.cmd.Process.Pid }

func (c *execChild) Wait() (int, error) {
	err := c.cmd.Wait()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}
