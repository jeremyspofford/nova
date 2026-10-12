//go:build unix

package jobs

import (
	"encoding/json"
	"errors"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestJobExecHelper is not a test: Spawn's tests launch this binary as the
// wrapper (`<stub novad> job-exec <dir>` re-execs it with the args after --).
func TestJobExecHelper(t *testing.T) {
	if os.Getenv("JOBS_TEST_EXEC") != "1" {
		return
	}
	args := flag.Args()
	if len(args) != 2 || args[0] != "job-exec" {
		os.Exit(2)
	}
	if err := Exec(args[1]); err != nil {
		os.Stderr.WriteString(err.Error())
		os.Exit(1)
	}
	os.Exit(0)
}

// TestSpawnParentHelper is not a test: it is the "agent" that spawns a job
// and then holds (so a test can kill it, its group, or its systemd unit).
func TestSpawnParentHelper(t *testing.T) {
	if os.Getenv("JOBS_TEST_SPAWN_PARENT") != "1" {
		return
	}
	env := append(os.Environ(), "JOBS_TEST_EXEC=1")
	sp, err := Spawn(os.Getenv("JOBS_TEST_BIN"), os.Getenv("JOBS_TEST_DIR"), env, os.Getenv("JOBS_TEST_MODE"))
	out := map[string]any{"spawned": sp}
	if err != nil {
		out["err"] = err.Error()
	}
	b, _ := json.Marshal(out)
	_ = os.WriteFile(os.Getenv("JOBS_TEST_RESULT")+".tmp", b, 0o600)
	_ = os.Rename(os.Getenv("JOBS_TEST_RESULT")+".tmp", os.Getenv("JOBS_TEST_RESULT"))
	time.Sleep(2 * time.Minute)
	os.Exit(0)
}

func testBin(t *testing.T) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return self
}

// script writes an executable sh script and returns its path.
func script(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return p
}

// stubNovad is a `novad` whose `job-exec <dir>` runs Exec in this test
// binary; it records its own argv and stdio into rec first.
func stubNovad(t *testing.T, rec string) string {
	t.Helper()
	return script(t, "novad", `printf '%s\n' "$@" > '`+rec+`.argv'
i=$(readlink /proc/$$/fd/0 2>/dev/null || echo na); o=$(readlink /proc/$$/fd/1 2>/dev/null || echo na)
printf '%s\n%s\n' "$i" "$o" > '`+rec+`.stdio'
exec '`+testBin(t)+`' -test.run='^TestJobExecHelper$' -- "$@"`)
}

// waitJob creates a job whose child is the test helper (its mode comes from
// the env Spawn is given), with a release file for the wait mode.
func waitJob(t *testing.T, s *Store, id string, envKeys ...string) (dir, release string) {
	t.Helper()
	release = filepath.Join(t.TempDir(), "release")
	sp := Spec{ID: id, EnvelopeID: "env-" + id, Argv: helperArgv(), EnvKeys: envKeys, CreatedAt: time.Now().UTC()}
	if err := s.Create(sp); err != nil {
		t.Fatal(err)
	}
	return s.Dir(id), release
}

func helperEnv(mode string, extra ...string) []string {
	return append(append(os.Environ(), "JOBS_TEST_EXEC=1", "JOBS_TEST_HELPER="+mode), extra...)
}

func alive(pid int) bool { return pid > 0 && syscall.Kill(pid, 0) == nil }

// endJob releases a waiting job and returns its terminal record.
func endJob(t *testing.T, s *Store, id, release string) Status {
	t.Helper()
	_ = os.WriteFile(release, nil, 0o600)
	var st Status
	for i := 0; i < 1000; i++ {
		if st = mustGet(t, s, id).Status; st.Terminal() {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %s never ended: %+v", id, st)
	return st
}

func killJob(s *Store, id string) {
	if j, err := s.Get(id); err == nil {
		if j.Status.PID > 0 {
			_ = syscall.Kill(-j.Status.PID, syscall.SIGKILL)
		}
		if j.Status.WrapperPID > 0 {
			_ = syscall.Kill(j.Status.WrapperPID, syscall.SIGKILL)
		}
	}
}

// C1: bad, unknown and already-claimed jobs are refused with nothing launched.
func TestSpawnRefusesBadUnknownAndClaimedJobs(t *testing.T) {
	s, _ := newStore(t)
	rec := filepath.Join(t.TempDir(), "rec")
	bin := stubNovad(t, rec)
	if _, err := Spawn(bin, filepath.Join(s.Root, "NOT-AN-ID"), nil, ""); err == nil {
		t.Fatal("a bad id was spawned")
	}
	_, err := Spawn(bin, s.Dir(okID), nil, "")
	if !errors.Is(err, ErrNoJob) || err.Error() != "no job "+okID+" on this device" {
		t.Fatalf("unknown job: %v", err)
	}
	dir, _ := waitJob(t, s, okID)
	if err := os.WriteFile(filepath.Join(dir, LogFile), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Spawn(bin, dir, nil, ""); err == nil || !strings.Contains(err.Error(), "runs once") {
		t.Fatalf("claimed job: %v", err)
	}
	if _, err := os.Stat(rec + ".argv"); err == nil {
		t.Fatal("a refused spawn launched the wrapper")
	}
	if st := mustGet(t, s, okID).Status; st.State != "" {
		t.Fatalf("a refused spawn wrote %+v", st)
	}
}

// C2: plain detach — exact argv, own session, /dev/null stdio, a running
// record returned, survives the agent.
func TestSpawnPlainDetach(t *testing.T) {
	s, _ := newStore(t)
	rec := filepath.Join(t.TempDir(), "rec")
	bin := stubNovad(t, rec)
	dir, release := waitJob(t, s, okID)
	sp, err := Spawn(bin, dir, helperEnv("wait:"+release), "")
	if err != nil {
		t.Fatal(err)
	}
	defer killJob(s, okID)
	st := sp.Status
	if st.State != StateRunning || st.PID <= 0 || st.WrapperPID <= 0 || !sp.SurvivesAgent || sp.Why != "" || sp.Detach != "setsid" {
		t.Fatalf("spawned = %+v", sp)
	}
	argv, _ := os.ReadFile(rec + ".argv")
	if string(argv) != "job-exec\n"+dir+"\n" {
		t.Fatalf("wrapper argv = %q", argv)
	}
	want := "/dev/null\n/dev/null\n"
	if runtime.GOOS != "linux" {
		want = "na\nna\n" // no /proc to read it from
	}
	if stdio, _ := os.ReadFile(rec + ".stdio"); string(stdio) != want {
		t.Fatalf("wrapper stdin/stdout = %q", stdio)
	}
	sid, err := getsid(st.WrapperPID)
	if err != nil {
		t.Fatal(err)
	}
	mine, _ := getsid(os.Getpid())
	if sid != st.WrapperPID || sid == mine {
		t.Fatalf("wrapper %d sid %d (spawner sid %d)", st.WrapperPID, sid, mine)
	}
	end := endJob(t, s, okID, release)
	if end.State != StateDone || end.ExitCode == nil || *end.ExitCode != 0 {
		t.Fatalf("end = %+v", end)
	}
}

// C2: an env value reaches the child through the environment and is on no
// argv and in no file of the job dir but the log.
func TestSpawnPassesEnvValuesOnlyThroughTheEnvironment(t *testing.T) {
	s, _ := newStore(t)
	rec := filepath.Join(t.TempDir(), "rec")
	bin := stubNovad(t, rec)
	const secret = "s3cr3t-value-92"
	dir, _ := waitJob(t, s, okID, "NOVA_T3_TOKEN")
	if _, err := Spawn(bin, dir, helperEnv("env:NOVA_T3_TOKEN", "NOVA_T3_TOKEN="+secret), ""); err != nil {
		t.Fatal(err)
	}
	var st Status
	for i := 0; i < 1000 && !st.Terminal(); i++ {
		st = mustGet(t, s, okID).Status
		time.Sleep(10 * time.Millisecond)
	}
	if log := readLog(t, dir); !strings.Contains(log, "NOVA_T3_TOKEN=["+secret+"] set=true") {
		t.Fatalf("log = %q (status %+v)", log, st)
	}
	argv, _ := os.ReadFile(rec + ".argv")
	if strings.Contains(string(argv), secret) {
		t.Fatal("the value was on the wrapper's argv")
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() == LogFile {
			continue
		}
		b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
		if strings.Contains(string(b), secret) {
			t.Fatalf("%s carries the value", e.Name())
		}
	}
}

// startParent runs TestSpawnParentHelper in its own process group and
// returns it with the decoded result once Spawn has returned.
func startParent(t *testing.T, bin, dir, mode, extraEnv string) (*exec.Cmd, Spawned) {
	t.Helper()
	result := filepath.Join(t.TempDir(), "result.json")
	cmd := exec.Command(testBin(t), "-test.run=^TestSpawnParentHelper$")
	cmd.Env = append(os.Environ(), "JOBS_TEST_SPAWN_PARENT=1", "JOBS_TEST_BIN="+bin, "JOBS_TEST_DIR="+dir,
		"JOBS_TEST_MODE="+mode, "JOBS_TEST_RESULT="+result, extraEnv)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) })
	return cmd, readResult(t, result)
}

func readResult(t *testing.T, path string) Spawned {
	t.Helper()
	for i := 0; i < 1500; i++ {
		if b, err := os.ReadFile(path); err == nil {
			var out struct {
				Spawned Spawned `json:"spawned"`
				Err     string  `json:"err"`
			}
			if err := json.Unmarshal(b, &out); err != nil || out.Err != "" {
				t.Fatalf("parent result %s: %v %s", b, err, out.Err)
			}
			return out.Spawned
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the spawning parent never reported")
	return Spawned{}
}

// C3: the job outlives the process that spawned it, even when that process's
// whole group is SIGKILLed (what a service manager does to an agent).
func TestSpawnedJobOutlivesTheSpawnerAndItsGroup(t *testing.T) {
	s, _ := newStore(t)
	bin := stubNovad(t, filepath.Join(t.TempDir(), "rec"))
	dir, release := waitJob(t, s, okID)
	parent, sp := startParent(t, bin, dir, "", "JOBS_TEST_HELPER=wait:"+release)
	defer killJob(s, okID)
	if sp.Status.State != StateRunning || !sp.SurvivesAgent {
		t.Fatalf("spawned = %+v", sp)
	}
	if err := syscall.Kill(-parent.Process.Pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	_ = parent.Wait()
	time.Sleep(100 * time.Millisecond)
	if !alive(sp.Status.WrapperPID) || !alive(sp.Status.PID) {
		t.Fatalf("wrapper %d alive=%v, child %d alive=%v after the spawner's group was killed",
			sp.Status.WrapperPID, alive(sp.Status.WrapperPID), sp.Status.PID, alive(sp.Status.PID))
	}
	end := endJob(t, s, okID, release)
	if end.State != StateDone || end.ExitCode == nil || *end.ExitCode != 0 {
		t.Fatalf("end = %+v", end)
	}
}

// C4: under systemd mode the launcher is systemd-run's scope, with this
// exact argv; a fake systemd-run that records and execs proves the shape.
func TestSpawnSystemdModeUsesAScope(t *testing.T) {
	s, _ := newStore(t)
	rec := filepath.Join(t.TempDir(), "rec")
	bin := stubNovad(t, rec)
	fake := script(t, "systemd-run", `printf '%s\n' "$@" > '`+rec+`.sd'
while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`)
	old := SystemdRun
	SystemdRun = fake
	defer func() { SystemdRun = old }()
	const id = "a1b2c3d4e5f6"
	dir, release := waitJob(t, s, id)
	sp, err := Spawn(bin, dir, helperEnv("wait:"+release), ModeSystemd)
	if err != nil {
		t.Fatal(err)
	}
	defer killJob(s, id)
	if sp.Status.State != StateRunning || !sp.SurvivesAgent || sp.Why != "" || sp.Detach != "systemd scope novad-job-"+id {
		t.Fatalf("spawned = %+v", sp)
	}
	got, _ := os.ReadFile(rec + ".sd")
	want := strings.Join([]string{"--user", "--scope", "--collect", "--quiet", "--unit", "novad-job-" + id, "--", bin, "job-exec", dir}, "\n") + "\n"
	if string(got) != want {
		t.Fatalf("systemd-run argv =\n%s\nwant\n%s", got, want)
	}
	if end := endJob(t, s, id, release); end.State != StateDone || *end.ExitCode != 0 {
		t.Fatalf("end = %+v", end)
	}
}

// C5: a scope launcher that fails (exits without claiming the job, or
// cannot start at all) falls back to a plain spawn — and says so.
func TestSpawnFallsBackWhenTheScopeCannotBeMade(t *testing.T) {
	for _, name := range []string{"exits", "absent"} {
		t.Run(name, func(t *testing.T) {
			s, _ := newStore(t)
			bin := stubNovad(t, filepath.Join(t.TempDir(), "rec"))
			path := filepath.Join(t.TempDir(), "no", "systemd-run")
			wantWhy := path
			if name == "exits" {
				path = script(t, "systemd-run", `echo "Failed to connect to bus: no medium 77" >&2; exit 1`)
				wantWhy = "no medium 77"
			}
			old := SystemdRun
			SystemdRun = path
			defer func() { SystemdRun = old }()
			dir, release := waitJob(t, s, okID)
			sp, err := Spawn(bin, dir, helperEnv("wait:"+release), ModeSystemd)
			if err != nil {
				t.Fatal(err)
			}
			defer killJob(s, okID)
			if sp.Status.State != StateRunning || sp.SurvivesAgent || sp.Detach != "setsid" {
				t.Fatalf("spawned = %+v", sp)
			}
			if !strings.Contains(sp.Why, wantWhy) || !strings.Contains(sp.Why, "restart of novad") || !strings.Contains(sp.Why, "novad-job-"+okID) {
				t.Fatalf("why = %q", sp.Why)
			}
			if end := endJob(t, s, okID, release); end.State != StateDone || *end.ExitCode != 0 {
				t.Fatalf("end = %+v", end)
			}
		})
	}
}

// C6: a wrapper that never writes is killed after SpawnWait and the job is
// failed_to_start, naming the wait.
func TestSpawnTimesOutAndKillsASilentWrapper(t *testing.T) {
	s, _ := newStore(t)
	pidf := filepath.Join(t.TempDir(), "pid")
	bin := script(t, "novad", `echo $$ > '`+pidf+`'; exec sleep 30`)
	old := SpawnWait
	SpawnWait = 700 * time.Millisecond
	defer func() { SpawnWait = old }()
	dir, _ := waitJob(t, s, okID)
	t0 := time.Now()
	sp, err := Spawn(bin, dir, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if took := time.Since(t0); took < 600*time.Millisecond || took > 5*time.Second {
		t.Fatalf("Spawn took %v with SpawnWait 700ms", took)
	}
	st := mustGet(t, s, okID).Status
	if st.State != StateFailedToStart || sp.Status.State != StateFailedToStart || st.EndedAt == nil ||
		!strings.Contains(st.Reason, "within 700ms") || !strings.Contains(st.Reason, "killed") {
		t.Fatalf("status = %+v, spawned %+v", st, sp)
	}
	b, _ := os.ReadFile(pidf)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if alive(pid) {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatalf("the silent wrapper %d was left running", pid)
	}
}

func TestSpawnWaitDefaultIs10s(t *testing.T) {
	if SpawnWait != 10*time.Second || SystemdRun != "systemd-run" {
		t.Fatalf("SpawnWait = %v, SystemdRun = %q", SpawnWait, SystemdRun)
	}
}

// C6: a wrapper that claims the job and exits without a record.
func TestSpawnWrapperExitWithoutARecord(t *testing.T) {
	s, _ := newStore(t)
	bin := script(t, "novad", `: > "$2/`+LogFile+`"; echo "wrapper boom 31" >&2; exit 3`)
	dir, _ := waitJob(t, s, okID)
	sp, err := Spawn(bin, dir, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, s, okID).Status
	if st.State != StateFailedToStart || sp.Status.State != StateFailedToStart || st.EndedAt == nil ||
		!strings.Contains(st.Reason, "code 3") || !strings.Contains(st.Reason, "wrapper boom 31") {
		t.Fatalf("status = %+v", st)
	}
}

// C6: every launch failing is a failed_to_start record naming why, err nil.
func TestSpawnEveryLaunchFailing(t *testing.T) {
	for _, mode := range []string{"", ModeSystemd} {
		t.Run("mode="+mode, func(t *testing.T) {
			s, _ := newStore(t)
			bin := script(t, "novad", `echo "cannot launch 44" >&2; exit 4`)
			old := SystemdRun
			SystemdRun = filepath.Join(t.TempDir(), "absent-systemd-run")
			defer func() { SystemdRun = old }()
			dir, _ := waitJob(t, s, okID)
			sp, err := Spawn(bin, dir, nil, mode)
			if err != nil {
				t.Fatal(err)
			}
			st := mustGet(t, s, okID).Status
			if st.State != StateFailedToStart || sp.Status.State != StateFailedToStart || sp.SurvivesAgent || st.EndedAt == nil ||
				!strings.Contains(st.Reason, "cannot launch 44") || !strings.Contains(st.Reason, "exited 4") {
				t.Fatalf("status = %+v spawned %+v", st, sp)
			}
			if mode == ModeSystemd && !strings.Contains(st.Reason, "absent-systemd-run") {
				t.Fatalf("reason omits the scope failure: %q", st.Reason)
			}
		})
	}
}
