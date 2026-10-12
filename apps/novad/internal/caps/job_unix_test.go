//go:build unix

package caps

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"novad/internal/jobs"
)

// TestCapsJobExecHelper is not a test: job.start's tests launch this binary
// as the wrapper through hostJobDeps' stub novad.
func TestCapsJobExecHelper(t *testing.T) {
	if os.Getenv("CAPS_TEST_JOBEXEC") != "1" {
		return
	}
	args := flag.Args()
	if len(args) != 2 || args[0] != "job-exec" {
		os.Exit(2)
	}
	if err := jobs.Exec(args[1]); err != nil {
		os.Stderr.WriteString(err.Error())
		os.Exit(1)
	}
	os.Exit(0)
}

// hostJobDeps: a stub novad whose `job-exec <dir>` is jobs.Exec.
func hostJobDeps(t *testing.T) Deps {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "novad")
	body := "#!/bin/sh\nCAPS_TEST_JOBEXEC=1 exec '" + self + "' -test.run='^TestCapsJobExecHelper$' -- \"$@\"\n"
	if err := os.WriteFile(bin, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	d := testDeps(t)
	d.Jobs = &JobDeps{Store: jobs.NewStore(t.TempDir()), Binary: bin, Mode: "manual"}
	return d
}

func waitTerminal(t *testing.T, d Deps, id string, within time.Duration) Outcome {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		out := Dispatch(context.Background(), "job.status", map[string]any{"job_id": id}, d)
		if out.OK {
			if st, _ := out.Meta["state"].(string); (jobs.Status{State: st}).Terminal() {
				return out
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %s not terminal after %v: %+v", id, within, out)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestJobStartRunsTheJobOnTheHost(t *testing.T) {
	d := hostJobDeps(t)
	cwd := t.TempDir()
	const secret = "s3cr3t-value-91"
	out := DispatchEnvelope(context.Background(), "env-host-1", "job.start", map[string]any{
		"job_id": "eeeeeeeeeee1", "cwd": cwd,
		"argv": []any{"sh", "-c", `pwd; echo "got:$JOB_SECRET"; exit 3`},
		"env":  map[string]any{"JOB_SECRET": secret},
	}, d)
	if !out.OK {
		t.Fatalf("job.start: %q", out.Error)
	}
	m := out.Meta
	if m["job"] != "eeeeeeeeeee1" || m["ran_in"] != "host" || m["survives_agent"] != true || m["detach"] != "setsid" {
		t.Fatalf("meta = %v", m)
	}
	if st := m["state"]; st != "running" && st != "done" {
		t.Fatalf("state = %v", st)
	}
	if pid, _ := m["pid"].(int); pid <= 0 {
		t.Fatalf("pid = %#v", m["pid"])
	}
	if _, has := m["why"]; has {
		t.Fatalf("a surviving job carries a why: %v", m)
	}
	blob, _ := json.Marshal(out)
	if strings.Contains(string(blob), secret) {
		t.Fatalf("the env value reached the result: %s", blob)
	}
	fin := waitTerminal(t, d, "eeeeeeeeeee1", 10*time.Second)
	if fin.Meta["state"] != "done" || fin.Meta["exit_code"] != 3 {
		t.Fatalf("terminal = %v", fin.Meta)
	}
	lg := Dispatch(context.Background(), "job.log", map[string]any{"job_id": "eeeeeeeeeee1"}, d)
	if !strings.Contains(lg.Output, cwd) || !strings.Contains(lg.Output, "got:"+secret) {
		t.Fatalf("log = %q, want the cwd and the env value the job saw", lg.Output)
	}
	sp, _ := d.Jobs.Store.Spec("eeeeeeeeeee1")
	if sp.EnvelopeID != "env-host-1" || !reflect.DeepEqual(sp.EnvKeys, []string{"JOB_SECRET"}) {
		t.Fatalf("spec = %+v", sp)
	}
	for _, f := range []string{jobs.SpecFile, jobs.StatusFile} {
		raw, _ := os.ReadFile(filepath.Join(d.Jobs.Store.Dir("eeeeeeeeeee1"), f))
		if strings.Contains(string(raw), secret) {
			t.Fatalf("the env value reached %s", f)
		}
	}
}

// The agent's mode reaches Spawn: under systemd-user a scope is tried first,
// and when it cannot be made the job still runs and says it will not
// survive a restart of novad.
func TestJobStartPassesTheModeAndStatesNotSurviving(t *testing.T) {
	d := hostJobDeps(t)
	d.Jobs.Mode = jobs.ModeSystemd
	old := jobs.SystemdRun
	jobs.SystemdRun = filepath.Join(t.TempDir(), "no-systemd-run")
	defer func() { jobs.SystemdRun = old }()
	out := Dispatch(context.Background(), "job.start", map[string]any{"job_id": "eeeeeeeeeee2", "argv": []any{"true"}}, d)
	if !out.OK || out.Meta["survives_agent"] != false {
		t.Fatalf("start: %+v", out)
	}
	why, _ := out.Meta["why"].(string)
	if !strings.Contains(why, "no-systemd-run") || !strings.Contains(why, "restart of novad") {
		t.Fatalf("why = %q", why)
	}
	if !strings.Contains(out.Output, "will not survive") {
		t.Fatalf("output does not state it: %q", out.Output)
	}
	waitTerminal(t, d, "eeeeeeeeeee2", 10*time.Second)
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func TestJobStopEndsARunningJob(t *testing.T) {
	d := hostJobDeps(t)
	out := Dispatch(context.Background(), "job.start", map[string]any{"job_id": "fffffffffff1", "argv": []any{"sleep", "60"}}, d)
	if !out.OK {
		t.Fatalf("start: %q", out.Error)
	}
	pid := out.Meta["pid"].(int)
	began := time.Now()
	st := Dispatch(context.Background(), "job.stop", map[string]any{"job_id": "fffffffffff1"}, d)
	// 143 = 128+SIGTERM: the polite signal ended it, not the hard one.
	if !st.OK || st.Meta["state"] != jobs.StateStopped || st.Meta["exit_code"] != 143 {
		t.Fatalf("stop: %+v", st)
	}
	if time.Since(began) >= StopGrace {
		t.Fatalf("SIGTERM should have ended sleep before the grace (%v)", time.Since(began))
	}
	if alive(pid) {
		t.Fatalf("the job's child %d is still alive", pid)
	}
	if _, err := os.Stat(filepath.Join(d.Jobs.Store.Dir("fffffffffff1"), jobs.StopFile)); err != nil {
		t.Fatalf("no stop file: %v", err)
	}
}

func TestJobStopKillsAChildThatIgnoresTerm(t *testing.T) {
	d := hostJobDeps(t)
	old := StopGrace
	StopGrace = 300 * time.Millisecond
	defer func() { StopGrace = old }()
	// The grandchild proves the WHOLE group is ended, not just the child.
	pidfile := filepath.Join(t.TempDir(), "grandchild.pid")
	out := Dispatch(context.Background(), "job.start", map[string]any{"job_id": "fffffffffff2",
		"argv": []any{"sh", "-c", `trap "" TERM; sleep 60 & echo $! >"$0"; wait`, pidfile}}, d)
	if !out.OK {
		t.Fatalf("start: %q", out.Error)
	}
	var grandchild int
	deadline := time.Now().Add(5 * time.Second)
	for grandchild == 0 && time.Now().Before(deadline) {
		if b, err := os.ReadFile(pidfile); err == nil && strings.HasSuffix(string(b), "\n") {
			grandchild, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		}
		time.Sleep(10 * time.Millisecond)
	}
	if grandchild == 0 {
		t.Fatal("the job never wrote its grandchild's pid")
	}
	st := Dispatch(context.Background(), "job.stop", map[string]any{"job_id": "fffffffffff2"}, d)
	if !st.OK || st.Meta["state"] != jobs.StateStopped || st.Meta["exit_code"] != 137 {
		t.Fatalf("stop: %+v", st)
	}
	deadline = time.Now().Add(2 * time.Second)
	for alive(grandchild) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if alive(grandchild) {
		_ = syscall.Kill(grandchild, syscall.SIGKILL)
		t.Fatalf("the job's grandchild %d outlived the stop", grandchild)
	}
}

// startSession starts `sleep 60` in a session of its own (pgid == pid), as a
// job's child is.
func startSession(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("sleep", "60")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd
}

func deadPID(t *testing.T) int {
	t.Helper()
	c := exec.Command("true")
	if err := c.Run(); err != nil {
		t.Fatal(err)
	}
	return c.Process.Pid
}

func TestJobStopWithAGoneWrapperSignalsNothing(t *testing.T) {
	d := hostJobDeps(t)
	child := startSession(t)
	seedJob(t, d.Jobs.Store, "fffffffffff3", time.Now(), &jobs.Status{State: jobs.StateRunning, PID: child.Process.Pid, WrapperPID: deadPID(t)}, "")
	out := Dispatch(context.Background(), "job.stop", map[string]any{"job_id": "fffffffffff3"}, d)
	if out.OK || !strings.Contains(out.Error, "gone") || !strings.Contains(out.Error, "nothing was signalled") {
		t.Fatalf("stop with a gone wrapper: %+v", out)
	}
	if !alive(child.Process.Pid) {
		t.Fatal("a process was signalled although the wrapper is gone")
	}
}

func TestJobStopWithNoRecordInTimeSaysTheRequestStays(t *testing.T) {
	d := hostJobDeps(t)
	oldG, oldW := StopGrace, StopWait
	StopGrace, StopWait = 200*time.Millisecond, 500*time.Millisecond
	defer func() { StopGrace, StopWait = oldG, oldW }()
	child := startSession(t)
	// The "wrapper" is this test process: alive, but it never writes a record.
	seedJob(t, d.Jobs.Store, "fffffffffff4", time.Now(), &jobs.Status{State: jobs.StateRunning, PID: child.Process.Pid, WrapperPID: os.Getpid()}, "")
	began := time.Now()
	out := Dispatch(context.Background(), "job.stop", map[string]any{"job_id": "fffffffffff4"}, d)
	if took := time.Since(began); took < StopWait || took > StopWait+time.Second {
		t.Fatalf("job.stop took %v, want StopWait (%v) and no more", took, StopWait)
	}
	if out.OK || !strings.Contains(out.Error, "no end within") || !strings.Contains(out.Error, "stop request stays") {
		t.Fatalf("stop with no record: %+v", out)
	}
	// The child's group was signalled all the same.
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the child's group was not signalled")
	}
	if _, err := os.Stat(filepath.Join(d.Jobs.Store.Dir("fffffffffff4"), jobs.StopFile)); err != nil {
		t.Fatalf("no stop file: %v", err)
	}
}

// C7 (T6): job.list is ok:false only when the jobs dir itself cannot be read,
// and then it says why — an unreadable dir never reads as "no jobs".
func TestJobListFailsWhenTheJobsDirIsUnreadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a mode-000 dir; this check needs an unprivileged user")
	}
	d := jobDeps(t)
	root := d.Jobs.Store.Root
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(root, 0o700) //nolint:errcheck // let TempDir clean up
	out := Dispatch(context.Background(), "job.list", map[string]any{}, d)
	if out.OK || out.Output == "no jobs" {
		t.Fatalf("an unreadable jobs dir read as a list: %+v", out)
	}
	if !strings.Contains(out.Error, "cannot read the jobs") || !strings.Contains(out.Error, "permission denied") {
		t.Fatalf("error = %q, want it to name the unreadable jobs dir and why", out.Error)
	}
}
