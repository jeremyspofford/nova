package jobs

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"novad/internal/box"
)

// LogFile is the job's combined stdout+stderr, written only by the wrapper.
const LogFile = "output.log"

// StopFile, when present, makes the wrapper record the job as stopped: job.stop
// writes it before killing the child's group, and a wrapper that finds it
// before starting runs nothing.
const StopFile = "stop"

// LogCap bounds the log. Output past it is drained (the child is never
// blocked or killed by the cap) and discarded, and the log says so.
var LogCap int64 = 64 << 20

// waitDelay bounds how long the wrapper keeps reading output after the child
// exits: a background process the job started can hold the pipe open forever.
const waitDelay = 2 * time.Second

// Exec is `novad job-exec <jobdir>`: it runs the job described by
// <jobdir>/spec.json once, owning its log, and leaves a terminal status.json
// whatever happened. The child's environment is the wrapper's own — env
// values reach it through the process environment, never through a file.
// It never touches the audit log: the agent's scanner writes the one audit
// entry per terminal job.
//
// The error is nil whenever a terminal record was written (whatever the
// child did); otherwise it says why there is none — no such job, a job
// already started, or a record that could not be written.
func Exec(jobDir string) error {
	jobDir = filepath.Clean(jobDir)
	id := filepath.Base(jobDir)
	if err := ValidID(id); err != nil {
		return err
	}
	s := &Store{Root: filepath.Dir(jobDir)}
	if _, err := s.existing(id); err != nil {
		return err
	}
	// The log is the exclusive claim: a job dir runs at most once.
	logf, err := os.OpenFile(filepath.Join(jobDir, LogFile), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("job %s already started on this device; a job runs once", id)
		}
		return err
	}
	defer logf.Close()
	r := &wrapper{s: s, id: id, dir: jobDir, log: &capLog{f: logf, limit: LogCap}}
	return r.run()
}

type wrapper struct {
	s   *Store
	id  string
	dir string
	log *capLog
}

// end writes the terminal record.
func (w *wrapper) end(st Status) error {
	now := time.Now().UTC()
	st.EndedAt = &now
	st.WrapperPID = os.Getpid()
	st.LogBytes = w.log.size()
	if err := w.s.WriteStatus(w.id, st); err != nil {
		return fmt.Errorf("job %s ended %s but its record could not be written: %w", w.id, st.State, err)
	}
	return nil
}

func (w *wrapper) notStarted(format string, a ...any) error {
	return w.end(Status{State: StateFailedToStart, Reason: fmt.Sprintf(format, a...) + "; nothing ran"})
}

func (w *wrapper) stopRequested() bool {
	_, err := os.Stat(filepath.Join(w.dir, StopFile))
	return err == nil
}

func (w *wrapper) run() error {
	sp, err := w.s.Spec(w.id)
	if err != nil {
		return w.notStarted("could not read the job's spec: %v", err)
	}
	if sp.ID != w.id {
		return w.notStarted("the spec names job %q, not %s", sp.ID, w.id)
	}
	if w.stopRequested() {
		return w.end(Status{State: StateStopped, Reason: "stopped before it started; nothing ran"})
	}
	if len(sp.Argv) == 0 {
		return w.notStarted("the job's argv is empty")
	}
	for _, k := range sp.EnvKeys {
		if _, ok := os.LookupEnv(k); !ok {
			return w.notStarted("env %s was named but the wrapper was not given it", k)
		}
	}
	// A box job runs spec.Run (docker exec -w <cwd> ...): its cwd is the
	// box's, and the docker client runs from the wrapper's own directory.
	run, dir := sp.Argv, sp.Cwd
	if len(sp.Run) > 0 {
		run, dir = sp.Run, ""
	}
	if dir != "" {
		fi, err := os.Stat(dir)
		if err != nil {
			return w.notStarted("cwd %s: %v", dir, err)
		}
		if !fi.IsDir() {
			return w.notStarted("cwd %s is not a directory", dir)
		}
	}
	var waited float64
	if sp.Heavy {
		release, secs, stopped, err := w.takeLock(sp.Lock)
		if stopped {
			return w.end(Status{State: StateStopped, LockWaitedS: secs,
				Reason: fmt.Sprintf("stopped while waiting for the CPU lock %s; nothing ran", sp.Lock)})
		}
		if err != nil {
			return w.notStarted("could not take the CPU lock: %v", err)
		}
		// Held until the terminal record is written: run's return value is
		// end's, and this deferred release runs after it.
		defer release()
		waited = secs
	}

	cmd := exec.Command(run[0], run[1:]...)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	// One writer for both: exec shares a single pipe, so the log keeps the
	// child's own interleaving of stdout and stderr.
	cmd.Stdout = w.log
	cmd.Stderr = w.log
	cmd.WaitDelay = waitDelay
	prepareChild(cmd)
	if err := cmd.Start(); err != nil {
		return w.notStarted("could not start %q: %v", sp.Argv[0], err)
	}
	started := time.Now().UTC()
	running := Status{State: StateRunning, PID: cmd.Process.Pid, WrapperPID: os.Getpid(), StartedAt: &started, LockWaitedS: waited}
	if err := w.s.WriteStatus(w.id, running); err != nil {
		// Nobody could see or stop a job with no running record: end it.
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return w.notStarted("its running record could not be written (%v), so it was killed", err)
	}

	waitErr := cmd.Wait()
	st := Status{State: StateDone, PID: running.PID, StartedAt: &started, LockWaitedS: waited}
	if ps := cmd.ProcessState; ps != nil {
		code := ps.ExitCode()
		if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			code = 128 + int(ws.Signal())
			st.Reason = fmt.Sprintf("killed by signal %d (%v)", int(ws.Signal()), ws.Signal())
		}
		st.ExitCode = &code
	} else {
		st.Reason = fmt.Sprintf("its exit could not be read: %v", waitErr)
	}
	if errors.Is(waitErr, exec.ErrWaitDelay) {
		w.log.note("the job exited, but a process it started kept its output open; output after the exit was not recorded")
	}
	if w.log.capped() {
		w.log.note(fmt.Sprintf("log capped at %s; later output was discarded", capWords(w.log.limit)))
	}
	if w.stopRequested() {
		st.State = StateStopped
		st.Reason = "stopped on request"
	}
	return w.end(st)
}

// lockStopPoll is how often a wrapper waiting for the CPU lock looks for a
// stop request.
const lockStopPoll = 100 * time.Millisecond

// takeLock waits for the CPU lock with no deadline (a heavy job runs when
// the lock frees, however long that takes), recording waiting_lock first so
// job.status says why nothing runs yet. A stop file ends the wait: stopped
// is true and nothing may run. secs is the wait, to a tenth of a second.
func (w *wrapper) takeLock(path string) (release func(), secs float64, stopped bool, err error) {
	if err := w.s.WriteStatus(w.id, Status{State: StateWaitingLock, WrapperPID: os.Getpid()}); err != nil {
		return nil, 0, false, fmt.Errorf("its waiting record could not be written: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		t := time.NewTicker(lockStopPoll)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if w.stopRequested() {
					cancel()
					return
				}
			}
		}
	}()
	release, waited, err := box.CPULock{Path: path}.Acquire(ctx)
	cancel()
	<-watchDone
	secs = math.Round(waited.Seconds()*10) / 10
	if err == nil && w.stopRequested() {
		release()
		return nil, secs, true, nil
	}
	if err != nil && w.stopRequested() {
		return nil, secs, true, nil
	}
	return release, secs, false, err
}

// capLog writes to the log file up to limit bytes and then discards,
// always claiming a full write so the child is never blocked or killed.
type capLog struct {
	mu      sync.Mutex
	f       *os.File
	limit   int64
	n       int64 // bytes of child output written
	extra   int64 // bytes of the wrapper's own notes
	over    bool
	failErr error
}

func (c *capLog) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	room := c.limit - c.n
	b := p
	if int64(len(b)) > room {
		b = b[:max(room, 0)]
		c.over = true
	}
	if len(b) > 0 && c.failErr == nil {
		m, err := c.f.Write(b)
		c.n += int64(m)
		if err != nil {
			c.failErr = err
		}
	}
	return len(p), nil
}

func (c *capLog) capped() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.over
}

// note appends one line of the wrapper's own to the log, past the cap.
func (c *capLog) note(s string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	m, _ := c.f.WriteString("\n[novad: " + s + "]\n")
	c.extra += int64(m)
}

func (c *capLog) size() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if fi, err := c.f.Stat(); err == nil {
		return fi.Size()
	}
	return c.n + c.extra
}

// capWords states a byte count the way the log says it: 64 MiB, 8 KiB, 100 bytes.
func capWords(n int64) string {
	switch {
	case n > 0 && n%(1<<20) == 0:
		return fmt.Sprintf("%d MiB", n>>20)
	case n > 0 && n%(1<<10) == 0:
		return fmt.Sprintf("%d KiB", n>>10)
	default:
		return fmt.Sprintf("%d bytes", n)
	}
}
