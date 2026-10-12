//go:build unix

package jobs

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// S30c T5: what the wrapper does for a box job — run the spec's `run`
// (docker exec ...) while her argv stays the record, and hold the CPU lock
// for a heavy job's whole life.

// tryLock takes path's flock without waiting: true when it was free (and is
// released again at once).
func tryLock(t *testing.T, path string) bool {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return false
	}
	_ = unix.Flock(int(f.Fd()), unix.LOCK_UN)
	return true
}

func holdLock(t *testing.T, path string) func() {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }
}

func waitState(t *testing.T, s *Store, id string, want string, within time.Duration) Status {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		st := mustGet(t, s, id).Status
		if st.State == want {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %s: state %q after %v, want %q", id, st.State, within, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// C3: a box job's wrapper runs spec.Run (the docker exec), never her argv
// directly, and does not chdir into the box's cwd on the host.
func TestExecRunsTheSpecsRunNotItsArgv(t *testing.T) {
	s, _ := newStore(t)
	mark := filepath.Join(t.TempDir(), "argv-ran")
	sp := Spec{ID: okID, Argv: []string{"touch", mark}, Cwd: "/nonexistent/box-only/path",
		Run: []string{"sh", "-c", "echo ran-the-run"}, CreatedAt: time.Now().UTC()}
	if err := s.Create(sp); err != nil {
		t.Fatal(err)
	}
	if err := Exec(s.Dir(okID)); err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, s, okID).Status
	if st.State != StateDone || st.ExitCode == nil || *st.ExitCode != 0 {
		t.Fatalf("status = %+v", st)
	}
	if lg := readLog(t, s.Dir(okID)); !strings.Contains(lg, "ran-the-run") {
		t.Fatalf("log = %q", lg)
	}
	if _, err := os.Stat(mark); !os.IsNotExist(err) {
		t.Fatalf("her argv ran on the host (%v)", err)
	}
	if got := mustGet(t, s, okID).Spec; !reflect.DeepEqual(got.Argv, []string{"touch", mark}) {
		t.Fatalf("the record's argv = %q, want hers", got.Argv)
	}
}

// C4: a heavy job needs the lock it will hold; Create refuses one without.
func TestCreateRefusesAHeavyJobWithoutALock(t *testing.T) {
	s, _ := newStore(t)
	for _, lock := range []string{"", "deploy/state/cpu.lock"} {
		sp := Spec{ID: okID, Argv: []string{"true"}, Heavy: true, Lock: lock, CreatedAt: time.Now().UTC()}
		if err := s.Create(sp); err == nil || !strings.Contains(err.Error(), "lock") {
			t.Fatalf("lock %q: err %v", lock, err)
		}
		if _, err := os.Stat(s.Dir(okID)); !os.IsNotExist(err) {
			t.Fatalf("lock %q: a job dir was written", lock)
		}
	}
}

// C4: while another holder has the lock the job waits (waiting_lock, nothing
// started); it then runs holding the lock until it ends, and the records say
// how long it waited.
func TestExecHeavyWaitsForTheLockAndHoldsItForTheJobsLife(t *testing.T) {
	s, _ := newStore(t)
	lock := filepath.Join(t.TempDir(), "deploy", "state", "cpu.lock")
	release := filepath.Join(t.TempDir(), "release")
	started := filepath.Join(t.TempDir(), "started")
	t.Setenv("JOBS_TEST_HELPER", "wait:"+release)
	sp := Spec{ID: okID, Argv: []string{"uv", "run", "pytest"}, Heavy: true, Lock: lock,
		Run:       []string{"sh", "-c", `: > "$0"; exec "$@"`, started, os.Args[0], "-test.run=^TestJobHelperChild$"},
		CreatedAt: time.Now().UTC()}
	if err := s.Create(sp); err != nil {
		t.Fatal(err)
	}
	unlock := holdLock(t, lock)
	done := make(chan error, 1)
	go func() { done <- Exec(s.Dir(okID)) }()
	w := waitState(t, s, okID, StateWaitingLock, 5*time.Second)
	if w.PID != 0 || w.WrapperPID != os.Getpid() {
		t.Fatalf("waiting record = %+v (no child yet, the wrapper's pid)", w)
	}
	time.Sleep(1200 * time.Millisecond)
	if _, err := os.Stat(started); !os.IsNotExist(err) {
		t.Fatal("the job started while the lock was held elsewhere")
	}
	unlock()
	run := waitState(t, s, okID, StateRunning, 5*time.Second)
	if run.PID <= 0 || run.LockWaitedS < 1 {
		t.Fatalf("running record = %+v, want a pid and lock_waited_s >= 1", run)
	}
	if tryLock(t, lock) {
		t.Fatal("the lock is free while the heavy job runs")
	}
	os.WriteFile(release, nil, 0o600)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	fin := mustGet(t, s, okID).Status
	if fin.State != StateDone || fin.ExitCode == nil || *fin.ExitCode != 0 || fin.LockWaitedS != run.LockWaitedS {
		t.Fatalf("terminal = %+v (lock_waited_s must carry %v)", fin, run.LockWaitedS)
	}
	if !tryLock(t, lock) {
		t.Fatal("the lock is still held after the job ended")
	}
}

// C4: a stop while waiting ends the job stopped with nothing run.
func TestExecStopWhileWaitingForTheLockRunsNothing(t *testing.T) {
	s, _ := newStore(t)
	lock := filepath.Join(t.TempDir(), "cpu.lock")
	mark := filepath.Join(t.TempDir(), "ran")
	sp := Spec{ID: okID, Argv: []string{"touch", mark}, Heavy: true, Lock: lock,
		Run: []string{"touch", mark}, CreatedAt: time.Now().UTC()}
	if err := s.Create(sp); err != nil {
		t.Fatal(err)
	}
	defer holdLock(t, lock)()
	done := make(chan error, 1)
	go func() { done <- Exec(s.Dir(okID)) }()
	waitState(t, s, okID, StateWaitingLock, 5*time.Second)
	os.WriteFile(filepath.Join(s.Dir(okID), StopFile), nil, 0o600)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a stop while waiting for the lock did not end the job")
	}
	st := mustGet(t, s, okID).Status
	if st.State != StateStopped || st.PID != 0 || st.ExitCode != nil || !strings.Contains(st.Reason, "nothing ran") ||
		!strings.Contains(st.Reason, "CPU lock") || st.EndedAt == nil {
		t.Fatalf("status = %+v", st)
	}
	if _, err := os.Stat(mark); !os.IsNotExist(err) {
		t.Fatal("the job ran although it was stopped while waiting")
	}
}

// C4: a light job never takes the lock, even when it names one.
func TestExecLightJobNeverTakesTheLock(t *testing.T) {
	s, _ := newStore(t)
	lock := filepath.Join(t.TempDir(), "cpu.lock")
	sp := Spec{ID: okID, Argv: []string{"true"}, Lock: lock, Run: []string{"true"}, CreatedAt: time.Now().UTC()}
	if err := s.Create(sp); err != nil {
		t.Fatal(err)
	}
	defer holdLock(t, lock)()
	done := make(chan error, 1)
	go func() { done <- Exec(s.Dir(okID)) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a light job waited on the held lock")
	}
	if st := mustGet(t, s, okID).Status; st.State != StateDone || st.LockWaitedS != 0 {
		t.Fatalf("status = %+v", st)
	}
}

// C6: the changes whose box runs a job not yet ended — running, waiting for
// the lock, or spawned with no record yet; never a host job or an ended one.
func TestLiveBoxes(t *testing.T) {
	s, _ := newStore(t)
	now := time.Now().UTC()
	mk := func(id, change string, st string) {
		sp := Spec{ID: id, Argv: []string{"true"}, CreatedAt: now}
		if change != "" {
			sp.Box = &BoxRef{Change: change, Container: "nova-box-" + change}
		}
		if err := s.Create(sp); err != nil {
			t.Fatal(err)
		}
		if st != "" {
			if err := s.WriteStatus(id, Status{State: st}); err != nil {
				t.Fatal(err)
			}
		}
	}
	mk("000000000001", "aaa111", StateRunning)
	mk("000000000002", "bbb222", StateWaitingLock)
	mk("000000000003", "ccc333", "")
	mk("000000000004", "ddd444", StateDone)
	mk("000000000005", "ddd444", StateLost)
	mk("000000000006", "", StateRunning)
	mk("000000000007", "eee555", StateStopped)
	got, err := s.LiveBoxes()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"aaa111": true, "bbb222": true, "ccc333": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("live = %v, want %v", got, want)
	}
	if err := os.WriteFile(filepath.Join(s.Dir("000000000004"), SpecFile), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LiveBoxes(); err == nil {
		t.Fatal("an unreadable job read as no live box")
	}
	empty, err := NewStore(t.TempDir()).LiveBoxes()
	if err != nil || len(empty) != 0 {
		t.Fatalf("no jobs dir: %v %v", empty, err)
	}
}
