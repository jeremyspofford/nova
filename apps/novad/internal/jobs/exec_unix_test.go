//go:build unix

package jobs

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// C3: the child leads its own session and process group.
func TestExecChildHasItsOwnSessionAndGroup(t *testing.T) {
	s, _ := newStore(t)
	release := filepath.Join(t.TempDir(), "release")
	dir := newJob(t, s, okID, "wait:"+release, "")
	done := make(chan error, 1)
	go func() { done <- Exec(dir) }()
	var st Status
	for i := 0; i < 500; i++ {
		if st = mustGet(t, s, okID).Status; st.State != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	pgid, err := syscall.Getpgid(st.PID)
	if err != nil {
		t.Fatal(err)
	}
	sid, err := getsid(st.PID)
	if err != nil {
		t.Fatal(err)
	}
	mine, _ := syscall.Getpgid(os.Getpid())
	os.WriteFile(release, nil, 0o600)
	<-done
	if pgid != st.PID || sid != st.PID || pgid == mine {
		t.Fatalf("child pid %d: pgid %d sid %d (wrapper pgid %d)", st.PID, pgid, sid, mine)
	}
}

func getsid(pid int) (int, error) {
	r, _, e := syscall.RawSyscall(syscall.SYS_GETSID, uintptr(pid), 0, 0)
	if e != 0 {
		return 0, e
	}
	return int(r), nil
}

// C1: a signal death reads 128+sig and names the signal.
func TestExecSignalDeath(t *testing.T) {
	s, _ := newStore(t)
	sp := Spec{ID: okID, Argv: []string{"sh", "-c", "kill -KILL $$"}, CreatedAt: time.Now().UTC()}
	if err := s.Create(sp); err != nil {
		t.Fatal(err)
	}
	if err := Exec(s.Dir(okID)); err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, s, okID).Status
	if st.State != StateDone || st.ExitCode == nil || *st.ExitCode != 137 || !strings.Contains(st.Reason, "killed") {
		t.Fatalf("status = %+v", st)
	}
}

// C4: a background process holding the output open does not hold the
// record: the wrapper stops reading after waitDelay and says so in the log.
func TestExecDoesNotWaitOnABackgroundHolder(t *testing.T) {
	s, _ := newStore(t)
	sp := Spec{ID: okID, Argv: []string{"sh", "-c", "sleep 20 & echo hi"}, CreatedAt: time.Now().UTC()}
	if err := s.Create(sp); err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	if err := Exec(s.Dir(okID)); err != nil {
		t.Fatal(err)
	}
	took := time.Since(t0)
	st := mustGet(t, s, okID).Status
	syscall.Kill(-st.PID, syscall.SIGKILL)
	if took > 10*time.Second || st.State != StateDone || *st.ExitCode != 0 {
		t.Fatalf("took %v, status %+v", took, st)
	}
	if log := readLog(t, s.Dir(okID)); !strings.HasPrefix(log, "hi\n") || !strings.Contains(log, "kept its output open") {
		t.Fatalf("log = %q", log)
	}
}
