package jobs

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"novad/internal/state"
)

// TestJobHelperChild is the child process the tests' jobs run (argv =
// this test binary). It does nothing unless JOBS_TEST_HELPER names a mode.
func TestJobHelperChild(t *testing.T) {
	mode := os.Getenv("JOBS_TEST_HELPER")
	if mode == "" {
		return
	}
	verb, arg, _ := strings.Cut(mode, ":")
	switch verb {
	case "exit":
		n, _ := strconv.Atoi(arg)
		fmt.Fprint(os.Stdout, "to-stdout ")
		fmt.Fprint(os.Stderr, "to-stderr")
		os.Exit(n)
	case "env":
		v, ok := os.LookupEnv(arg)
		fmt.Printf("%s=[%s] set=%v", arg, v, ok)
		os.Exit(0)
	case "pwd":
		wd, _ := os.Getwd()
		fmt.Print("cwd=" + wd)
		os.Exit(0)
	case "spam":
		// spam:<bytes>:<exit>
		b, e, _ := strings.Cut(arg, ":")
		n, _ := strconv.Atoi(b)
		code, _ := strconv.Atoi(e)
		os.Stdout.Write([]byte(strings.Repeat("x", n)))
		os.Exit(code)
	case "touch":
		os.WriteFile(arg, []byte("ran"), 0o600)
		os.Exit(0)
	case "wait":
		// wait:<release file>
		for i := 0; i < 3000; i++ {
			if _, err := os.Stat(arg); err == nil {
				os.Exit(0)
			}
			time.Sleep(10 * time.Millisecond)
		}
		os.Exit(99)
	}
	os.Exit(98)
}

func helperArgv() []string { return []string{os.Args[0], "-test.run=^TestJobHelperChild$"} }

// newJob creates a job whose child is the helper in mode, returning its dir.
func newJob(t *testing.T, s *Store, id, mode, cwd string, envKeys ...string) string {
	t.Helper()
	t.Setenv("JOBS_TEST_HELPER", mode)
	sp := Spec{ID: id, EnvelopeID: "env-" + id, Argv: helperArgv(), Cwd: cwd, EnvKeys: envKeys,
		CreatedAt: time.Now().UTC()}
	if err := s.Create(sp); err != nil {
		t.Fatal(err)
	}
	return s.Dir(id)
}

func mustGet(t *testing.T, s *Store, id string) Job {
	t.Helper()
	j, err := s.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func readLog(t *testing.T, dir string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, LogFile))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// C1: done with the child's own exit code; 0 is present, not omitted.
func TestExecRecordsDoneWithTheExitCode(t *testing.T) {
	for _, code := range []int{0, 7} {
		s, _ := newStore(t)
		id := fmt.Sprintf("00000000000%d", code)
		dir := newJob(t, s, id, fmt.Sprintf("exit:%d", code), "")
		if err := Exec(dir); err != nil {
			t.Fatalf("Exec: %v", err)
		}
		st := mustGet(t, s, id).Status
		if st.State != StateDone || st.ExitCode == nil || *st.ExitCode != code {
			t.Fatalf("status = %+v, want done exit %d", st, code)
		}
		if st.StartedAt == nil || st.EndedAt == nil || st.EndedAt.Before(*st.StartedAt) {
			t.Fatalf("times = %v .. %v", st.StartedAt, st.EndedAt)
		}
		if st.PID <= 0 || st.WrapperPID != os.Getpid() {
			t.Fatalf("pid=%d wrapper_pid=%d (want %d)", st.PID, st.WrapperPID, os.Getpid())
		}
	}
}

// C1: the running record (child pid, wrapper pid, started_at) is on disk
// while the child runs.
func TestExecWritesRunningBeforeTheChildEnds(t *testing.T) {
	s, _ := newStore(t)
	release := filepath.Join(t.TempDir(), "release")
	dir := newJob(t, s, okID, "wait:"+release, "")
	done := make(chan error, 1)
	go func() { done <- Exec(dir) }()
	var st Status
	for i := 0; i < 500; i++ {
		st = mustGet(t, s, okID).Status
		if st.State != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if st.State != StateRunning || st.PID <= 0 || st.PID == os.Getpid() || st.WrapperPID != os.Getpid() ||
		st.StartedAt == nil || st.EndedAt != nil || st.ExitCode != nil {
		t.Fatalf("running record = %+v", st)
	}
	if p, err := os.FindProcess(st.PID); err != nil || p == nil {
		t.Fatalf("child pid %d not found: %v", st.PID, err)
	}
	os.WriteFile(release, nil, 0o600)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, s, okID).Status; got.State != StateDone || *got.ExitCode != 0 || got.PID != st.PID {
		t.Fatalf("terminal = %+v", got)
	}
}

// C1: the child runs in spec.Cwd.
func TestExecRunsInTheSpecCwd(t *testing.T) {
	s, _ := newStore(t)
	cwd := t.TempDir()
	dir := newJob(t, s, okID, "pwd", cwd)
	if err := Exec(dir); err != nil {
		t.Fatal(err)
	}
	want, _ := filepath.EvalSymlinks(cwd)
	got := strings.TrimPrefix(readLog(t, dir), "cwd=")
	got, _ = filepath.EvalSymlinks(got)
	if got != want {
		t.Fatalf("child cwd = %q, want %q", got, want)
	}
}

// C2: env values come from the wrapper's own environment and never reach a
// file in the job dir other than the child's own output.
func TestExecPassesEnvFromItsOwnEnvironmentOnly(t *testing.T) {
	s, _ := newStore(t)
	const secret = "s3cr3t-value-S30C"
	t.Setenv("S30C_TOKEN", secret)
	dir := newJob(t, s, okID, "env:S30C_TOKEN", "", "S30C_TOKEN")
	if err := Exec(dir); err != nil {
		t.Fatal(err)
	}
	if got := readLog(t, dir); got != "S30C_TOKEN=["+secret+"] set=true" {
		t.Fatalf("child saw %q", got)
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if e.Name() == LogFile {
			continue
		}
		b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
		if strings.Contains(string(b), secret) {
			t.Fatalf("%s carries the env value", e.Name())
		}
	}
}

// C2: a named key the wrapper was not given is failed_to_start, nothing run.
func TestExecRefusesAMissingEnvKey(t *testing.T) {
	s, _ := newStore(t)
	marker := filepath.Join(t.TempDir(), "ran")
	os.Unsetenv("S30C_ABSENT_KEY")
	dir := newJob(t, s, okID, "touch:"+marker, "", "S30C_ABSENT_KEY")
	if err := Exec(dir); err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, s, okID).Status
	if st.State != StateFailedToStart || !strings.Contains(st.Reason, "S30C_ABSENT_KEY") {
		t.Fatalf("status = %+v", st)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("the child ran")
	}
}

// C4: past the cap the child runs to its own exit and the log states the cap.
func TestExecCapsTheLogAndStatesIt(t *testing.T) {
	old := LogCap
	LogCap = 100
	t.Cleanup(func() { LogCap = old })
	s, _ := newStore(t)
	dir := newJob(t, s, okID, "spam:5000:3", "")
	if err := Exec(dir); err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, s, okID).Status
	if st.State != StateDone || *st.ExitCode != 3 {
		t.Fatalf("status = %+v (the child must run to its own exit)", st)
	}
	log := readLog(t, dir)
	if !strings.HasPrefix(log, strings.Repeat("x", 100)) || strings.Contains(log, strings.Repeat("x", 101)) {
		t.Fatalf("log does not hold exactly the first 100 bytes: %q", log)
	}
	if !strings.Contains(log, "log capped at 100 bytes") {
		t.Fatalf("log does not state the cap: %q", log)
	}
	fi, _ := os.Stat(filepath.Join(dir, LogFile))
	if st.LogBytes != fi.Size() {
		t.Fatalf("log_bytes=%d, file=%d", st.LogBytes, fi.Size())
	}
}

func TestLogCapDefaultIs64MiBAndStatedThatWay(t *testing.T) {
	if LogCap != 64<<20 {
		t.Fatalf("LogCap = %d", LogCap)
	}
	if got := capWords(64 << 20); got != "64 MiB" {
		t.Fatalf("capWords = %q", got)
	}
}

// C4: stdout and stderr both land in the one log.
func TestExecLogIsCombinedOutput(t *testing.T) {
	s, _ := newStore(t)
	dir := newJob(t, s, okID, "exit:0", "")
	if err := Exec(dir); err != nil {
		t.Fatal(err)
	}
	log := readLog(t, dir)
	if !strings.Contains(log, "to-stdout") || !strings.Contains(log, "to-stderr") {
		t.Fatalf("log = %q", log)
	}
	if st := mustGet(t, s, okID).Status; st.LogBytes != int64(len(log)) {
		t.Fatalf("log_bytes = %d, want %d", st.LogBytes, len(log))
	}
}

// C5: failed_to_start + why for a missing cwd and a missing binary.
func TestExecFailedToStart(t *testing.T) {
	cases := map[string]func(*Spec){
		"cwd":    func(sp *Spec) { sp.Cwd = filepath.Join(os.TempDir(), "s30c-no-such-dir-0x1") },
		"binary": func(sp *Spec) { sp.Argv = []string{"novad-s30c-no-such-binary"} },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			s, _ := newStore(t)
			sp := Spec{ID: okID, Argv: helperArgv(), CreatedAt: time.Now().UTC()}
			mut(&sp)
			if err := s.Create(sp); err != nil {
				t.Fatal(err)
			}
			if err := Exec(s.Dir(okID)); err != nil {
				t.Fatal(err)
			}
			st := mustGet(t, s, okID).Status
			if st.State != StateFailedToStart || st.Reason == "" || st.EndedAt == nil || st.PID != 0 || st.ExitCode != nil {
				t.Fatalf("status = %+v", st)
			}
			want := map[string]string{"cwd": "s30c-no-such-dir-0x1", "binary": "novad-s30c-no-such-binary"}[name]
			if !strings.Contains(st.Reason, want) {
				t.Fatalf("reason %q does not name %q", st.Reason, want)
			}
		})
	}
}

// C5: an unreadable spec is failed_to_start, recorded.
func TestExecUnreadableSpec(t *testing.T) {
	s, _ := newStore(t)
	dir := newJob(t, s, okID, "exit:0", "")
	os.WriteFile(filepath.Join(dir, SpecFile), []byte("{not json"), 0o600)
	if err := Exec(dir); err != nil {
		t.Fatal(err)
	}
	// Get cannot read this job (its spec is broken); read the record itself.
	var st Status
	if err := state.ReadJSON(filepath.Join(dir, StatusFile), &st); err != nil {
		t.Fatal(err)
	}
	if st.State != StateFailedToStart || !strings.Contains(st.Reason, "unreadable") || st.EndedAt == nil {
		t.Fatalf("status = %+v", st)
	}
}

// C5: a dir with no spec is the no-job error; a bad dir name is refused.
func TestExecOfNoJob(t *testing.T) {
	s, _ := newStore(t)
	err := Exec(s.Dir(okID))
	if !errors.Is(err, ErrNoJob) || err.Error() != "no job "+okID+" on this device" {
		t.Fatalf("err = %v", err)
	}
	if err := Exec(filepath.Join(s.Root, "NOT-A-JOB")); err == nil || errors.Is(err, ErrNoJob) {
		t.Fatalf("bad id err = %v", err)
	}
}

// C5: a job dir runs at most once.
func TestExecTwiceIsRefused(t *testing.T) {
	s, _ := newStore(t)
	dir := newJob(t, s, okID, "exit:7", "")
	if err := Exec(dir); err != nil {
		t.Fatal(err)
	}
	first := mustGet(t, s, okID).Status
	logBefore := readLog(t, dir)
	t.Setenv("JOBS_TEST_HELPER", "exit:0")
	if err := Exec(dir); err == nil || !strings.Contains(err.Error(), "already") {
		t.Fatalf("second Exec err = %v", err)
	}
	if got := mustGet(t, s, okID).Status; *got.ExitCode != 7 || !got.EndedAt.Equal(*first.EndedAt) {
		t.Fatalf("first record changed: %+v", got)
	}
	if readLog(t, dir) != logBefore {
		t.Fatal("log changed")
	}
}

// C6: a stop file present when the child ends -> stopped, exit code kept.
func TestExecStopFileWhileRunning(t *testing.T) {
	s, _ := newStore(t)
	release := filepath.Join(t.TempDir(), "release")
	dir := newJob(t, s, okID, "wait:"+release, "")
	done := make(chan error, 1)
	go func() { done <- Exec(dir) }()
	for i := 0; i < 500 && mustGet(t, s, okID).Status.State == ""; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	os.WriteFile(filepath.Join(dir, StopFile), nil, 0o600)
	os.WriteFile(release, nil, 0o600)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, s, okID).Status
	if st.State != StateStopped || st.ExitCode == nil || *st.ExitCode != 0 || st.Reason != "stopped on request" {
		t.Fatalf("status = %+v", st)
	}
}

// C6: a stop file present before start -> stopped, nothing run.
func TestExecStopFileBeforeStart(t *testing.T) {
	s, _ := newStore(t)
	marker := filepath.Join(t.TempDir(), "ran")
	dir := newJob(t, s, okID, "touch:"+marker, "")
	os.WriteFile(filepath.Join(dir, StopFile), nil, 0o600)
	if err := Exec(dir); err != nil {
		t.Fatal(err)
	}
	st := mustGet(t, s, okID).Status
	if st.State != StateStopped || st.PID != 0 || st.ExitCode != nil || !strings.Contains(st.Reason, "before it started") {
		t.Fatalf("status = %+v", st)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("the child ran")
	}
}

// C7: records are written whole (no temp left) and no audit log appears.
func TestExecLeavesNoTempAndNoAudit(t *testing.T) {
	s, stateDir := newStore(t)
	dir := newJob(t, s, okID, "exit:0", "")
	if err := Exec(dir); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(dir)
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
		if strings.HasPrefix(e.Name(), ".") {
			t.Fatalf("temp left behind: %s", e.Name())
		}
	}
	if strings.Join(names, ",") != strings.Join([]string{LogFile, SpecFile, StatusFile}, ",") {
		t.Fatalf("job dir = %v", names)
	}
	filepath.Walk(stateDir, func(p string, fi os.FileInfo, err error) error {
		if fi != nil && strings.Contains(fi.Name(), "audit") {
			t.Fatalf("audit file written: %s", p)
		}
		return nil
	})
}

// C7: the jobs package cannot write the audit log: it does not import it.
func TestJobsDoesNotImportAudit(t *testing.T) {
	gobin := filepath.Join(runtime.GOROOT(), "bin", "go")
	out, err := exec.Command(gobin, "list", "-deps", ".").CombinedOutput()
	if err != nil {
		t.Fatalf("go list: %v %s", err, out)
	}
	if strings.Contains(string(out), "novad/internal/audit") {
		t.Fatal("internal/jobs imports internal/audit")
	}
	if !strings.Contains(string(out), "novad/internal/state") {
		t.Fatalf("go list output looks wrong: %s", out)
	}
}

// C5: a spec naming another id, and a cwd that is a file, are failed_to_start.
func TestExecRefusesAMismatchedSpecAndAFileCwd(t *testing.T) {
	s, _ := newStore(t)
	dir := newJob(t, s, okID, "exit:0", "")
	body, _ := os.ReadFile(filepath.Join(dir, SpecFile))
	os.WriteFile(filepath.Join(dir, SpecFile), []byte(strings.Replace(string(body), okID, "ffffffffffff", 1)), 0o600)
	if err := Exec(dir); err != nil {
		t.Fatal(err)
	}
	var st Status
	state.ReadJSON(filepath.Join(dir, StatusFile), &st)
	if st.State != StateFailedToStart || !strings.Contains(st.Reason, "ffffffffffff") {
		t.Fatalf("mismatch status = %+v", st)
	}

	s2, _ := newStore(t)
	file := filepath.Join(t.TempDir(), "plain")
	os.WriteFile(file, nil, 0o600)
	dir2 := newJob(t, s2, okID, "exit:0", file)
	if err := Exec(dir2); err != nil {
		t.Fatal(err)
	}
	if st := mustGet(t, s2, okID).Status; st.State != StateFailedToStart || !strings.Contains(st.Reason, "not a directory") {
		t.Fatalf("file cwd status = %+v", st)
	}
}
