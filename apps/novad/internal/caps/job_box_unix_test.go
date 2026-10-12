//go:build unix

package caps

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"novad/internal/box"
	"novad/internal/jobs"
)

// S30c T5 box jobs through the real wrapper (the test binary's
// TestCapsJobExecHelper) with a docker stand-in.

// jobDockerBin is the docker client a box job's wrapper runs: it prints each
// argument on its own line and `env:<JOB_SECRET>`, touches mark, then (with
// a stop mark) ignores SIGTERM and waits for that file, exiting 7 — so only
// the stop INSIDE the box (which the test's runner models by creating the
// file) or a SIGKILL ends it.
func jobDockerBin(t *testing.T, stopMark string) (bin, mark string) {
	t.Helper()
	dir := t.TempDir()
	bin = filepath.Join(dir, "docker")
	mark = filepath.Join(dir, "ran")
	script := "#!/bin/sh\n: > '" + mark + "'\nprintf '%s\\n' \"$@\"\necho \"env:$JOB_SECRET\"\n"
	if stopMark != "" {
		script += "trap '' TERM\nwhile [ ! -f '" + stopMark + "' ]; do sleep 0.02; done\nexit 7\n"
	}
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, mark
}

// boxJobDeps: a real job store and wrapper, a box manager over s whose
// exec binary is bin.
func boxJobDeps(t *testing.T, s box.Runner, bin string) Deps {
	t.Helper()
	d := hostJobDeps(t)
	d.Box = &box.Manager{Docker: s, Git: s, Now: func() time.Time { return time.Unix(1e9, 0) }, UID: 1234, GID: 5678, DockerBin: bin}
	return d
}

func startBoxJob(t *testing.T, d Deps, id, checkout, cwdRel string, argv string, extra string) Outcome {
	t.Helper()
	wt := checkout + "/.worktrees/nova-c0ffee"
	cwd := wt
	if cwdRel != "." {
		cwd = wt + "/" + cwdRel
	}
	return DispatchEnvelope(context.Background(), "env-"+id, "job.start", wireArgs(t, `{"job_id": "`+id+`", "change": "c0ffee", "checkout": "`+checkout+
		`", "branch": "trunk", `+bLimits+`, "argv": `+argv+`, "cwd": "`+cwd+`"`+extra+`}`), d)
}

// C3: the wrapper runs docker exec into the box with her argv, env NAMES on
// the argv and values only in the client's environment; the record keeps
// her argv and says where it ran.
func TestBoxJobRunsTheShippedArgvThroughTheWrapper(t *testing.T) {
	bin, _ := jobDockerBin(t, "")
	s := warm()
	d := boxJobDeps(t, s, bin)
	const secret = "box-s3cret-77"
	const id = "b0b0b0b0b0b2"
	out := startBoxJob(t, d, id, "/srv/repo", "services/core", `["uv", "run", "pytest", "-k", "a b"]`,
		`, "env": {"JOB_SECRET": "`+secret+`"}`)
	if !out.OK {
		t.Fatalf("job.start: %q", out.Error)
	}
	m := out.Meta
	for k, v := range map[string]any{"job": id, "ran_in": "box", "box": "nova-box-c0ffee", "image": bTag,
		"heavy": false, "survives_agent": true, "detach": "setsid"} {
		if m[k] != v {
			t.Errorf("meta[%s] = %#v, want %#v (meta %v)", k, m[k], v, m)
		}
	}
	if !strings.Contains(out.Output, "nova-box-c0ffee") {
		t.Errorf("output %q does not name the box", out.Output)
	}
	if g := s.find("-C /srv/repo show trunk:deploy/devbox/suites.toml"); g == nil {
		t.Errorf("heavy was not read from the branch core sent: %v", s.calls)
	}
	fin := waitTerminal(t, d, id, 10*time.Second)
	if fin.Meta["state"] != "done" || fin.Meta["exit_code"] != 0 || fin.Meta["ran_in"] != "box" || fin.Meta["box"] != "nova-box-c0ffee" {
		t.Fatalf("terminal = %v", fin.Meta)
	}
	if !reflect.DeepEqual(fin.Meta["argv"], []string{"uv", "run", "pytest", "-k", "a b"}) {
		t.Fatalf("status argv = %#v, want hers", fin.Meta["argv"])
	}
	cwd := bWorktree + "/services/core"
	lg := Dispatch(context.Background(), "job.log", map[string]any{"job_id": id}, d)
	want := strings.Join([]string{"exec", "-w", cwd, "-u", "1234:5678", "-e", "JOB_SECRET", "nova-box-c0ffee",
		"sh", "-c", `echo $$ >"$0"; exec "$@"`, "/tmp/novad-job-" + id + ".pid",
		"uv", "run", "pytest", "-k", "a b"}, "\n") + "\nenv:" + secret + "\n"
	if lg.Output != want {
		t.Fatalf("docker got\n%q\nwant\n%q", lg.Output, want)
	}
	sp, err := d.Jobs.Store.Spec(id)
	if err != nil {
		t.Fatal(err)
	}
	if sp.Box == nil || *sp.Box != (jobs.BoxRef{Change: "c0ffee", Container: "nova-box-c0ffee"}) || sp.Heavy ||
		sp.Cwd != cwd || len(sp.Run) == 0 || sp.Run[0] != bin || sp.EnvelopeID != "env-"+id {
		t.Fatalf("spec = %+v", sp)
	}
	blob, _ := json.Marshal(out)
	if strings.Contains(string(blob), secret) {
		t.Fatalf("the env value reached the result: %s", blob)
	}
	for _, f := range []string{jobs.SpecFile, jobs.StatusFile} {
		raw, _ := os.ReadFile(filepath.Join(d.Jobs.Store.Dir(id), f))
		if strings.Contains(string(raw), secret) {
			t.Fatalf("the env value reached %s", f)
		}
	}
	if _, ok := d.Box.LastUse("c0ffee"); !ok {
		t.Fatal("the box was not touched by the job's bring-up")
	}
}

// C2: heavy is the branch's suites.toml deciding: the whole core suite in its
// dir is heavy (the lock is the checkout's); a selector, another dir, or a
// branch whose suite lives elsewhere is not.
func TestBoxJobHeavyIsReadFromTheBranchSuites(t *testing.T) {
	bin, _ := jobDockerBin(t, "")
	checkout := t.TempDir()
	// The worktree's own suites.toml would make everything light; it is never read.
	wt := checkout + "/.worktrees/nova-c0ffee"
	os.MkdirAll(filepath.Join(wt, "deploy", "devbox"), 0o755)
	os.WriteFile(filepath.Join(wt, "deploy", "devbox", "suites.toml"), []byte("[[suite]]\nname=\"x\"\ndir=\"nowhere\"\ncommands=[[\"x\"]]\n"), 0o644)
	other := "\n[[suite]]\nname = \"core\"\ndir = \"services/other\"\ncommands = [[\"uv\", \"run\", \"pytest\"]]\n"
	for i, c := range []struct {
		suites, cwdRel, argv string
		heavy                bool
	}{
		{"", "services/core", `["uv", "run", "pytest"]`, true},
		{"", "services/core", `["uv", "run", "pytest", "tests/test_a.py"]`, false},
		{"", ".", `["uv", "run", "pytest"]`, false},
		{other, "services/core", `["uv", "run", "pytest"]`, false},
	} {
		s := warm()
		s.suites = c.suites
		d := boxJobDeps(t, s, bin)
		id := "c0c0c0c0c0c" + string(rune('1'+i))
		out := startBoxJob(t, d, id, checkout, c.cwdRel, c.argv, "")
		if !out.OK || out.Meta["heavy"] != c.heavy {
			t.Fatalf("case %d: ok=%v meta=%v err=%q, want heavy %v", i, out.OK, out.Meta, out.Error, c.heavy)
		}
		if s.find("-C "+checkout+" show trunk:deploy/devbox/suites.toml") == nil {
			t.Fatalf("case %d: suites not read from trunk: %v", i, s.calls)
		}
		sp, _ := d.Jobs.Store.Spec(id)
		if sp.Heavy != c.heavy || (c.heavy && sp.Lock != box.LockPath(checkout)) {
			t.Fatalf("case %d: spec heavy=%v lock=%q", i, sp.Heavy, sp.Lock)
		}
		waitTerminal(t, d, id, 10*time.Second)
	}
}

// C4: a heavy job waits for the CPU lock in the wrapper (the start answers
// waiting_lock, nothing runs), then runs and records how long it waited.
func TestHeavyBoxJobWaitsForTheLock(t *testing.T) {
	bin, mark := jobDockerBin(t, "")
	checkout := t.TempDir()
	d := boxJobDeps(t, warm(), bin)
	rel := holdLock(t, box.LockPath(checkout))
	const id = "d0d0d0d0d0d1"
	out := startBoxJob(t, d, id, checkout, "services/core", `["uv", "run", "pytest"]`, "")
	if !out.OK || out.Meta["state"] != jobs.StateWaitingLock || out.Meta["heavy"] != true {
		rel()
		t.Fatalf("ok=%v meta=%v err=%q", out.OK, out.Meta, out.Error)
	}
	if !strings.Contains(out.Output, "CPU lock") {
		t.Errorf("output %q does not say it waits for the CPU lock", out.Output)
	}
	time.Sleep(1200 * time.Millisecond)
	if _, err := os.Stat(mark); !os.IsNotExist(err) {
		rel()
		t.Fatal("docker ran while the lock was held")
	}
	rel()
	fin := waitTerminal(t, d, id, 10*time.Second)
	if fin.Meta["state"] != "done" || fin.Meta["exit_code"] != 0 {
		t.Fatalf("terminal = %v", fin.Meta)
	}
	if w, _ := fin.Meta["lock_waited_s"].(float64); w < 1 {
		t.Fatalf("lock_waited_s = %#v, want >= 1", fin.Meta["lock_waited_s"])
	}
}

// C4: a stop while the job waits for the lock ends it with nothing run and
// nothing signalled in the box.
func TestBoxJobStopWhileWaitingRunsNothing(t *testing.T) {
	bin, mark := jobDockerBin(t, "")
	checkout := t.TempDir()
	s := warm()
	d := boxJobDeps(t, s, bin)
	defer holdLock(t, box.LockPath(checkout))()
	const id = "d0d0d0d0d0d2"
	out := startBoxJob(t, d, id, checkout, "services/core", `["uv", "run", "pytest"]`, "")
	if !out.OK || out.Meta["state"] != jobs.StateWaitingLock {
		t.Fatalf("ok=%v meta=%v err=%q", out.OK, out.Meta, out.Error)
	}
	stop := Dispatch(context.Background(), "job.stop", map[string]any{"job_id": id}, d)
	if !stop.OK || stop.Meta["state"] != jobs.StateStopped {
		t.Fatalf("stop: ok=%v meta=%v err=%q", stop.OK, stop.Meta, stop.Error)
	}
	if _, err := os.Stat(mark); !os.IsNotExist(err) {
		t.Fatal("docker ran for a job stopped while waiting")
	}
	if s.find("exec") != nil {
		t.Fatalf("a kill reached the box: %v", s.calls)
	}
}

// inBox models the box for job.stop: `cat <pidfile>` answers pid after
// catFails failures; a kill whose signal is in ends creates stopMark (the
// process in the box ends, so its docker client exits).
type inBox struct {
	*scripted
	mu       sync.Mutex
	pid      string
	catFails int
	ends     map[string]bool
	stopMark string
	kills    [][]string
}

func (b *inBox) Run(ctx context.Context, argv []string) (string, int, error) {
	if len(argv) > 0 && argv[0] == "exec" {
		b.mu.Lock()
		defer b.mu.Unlock()
		if argv[len(argv)-2] == "cat" {
			if b.catFails > 0 {
				b.catFails--
				return "cat: can't open: No such file or directory\n", 1, nil
			}
			return b.pid + "\n", 0, nil
		}
		b.kills = append(b.kills, append([]string(nil), argv...))
		for sig := range b.ends {
			if strings.Contains(strings.Join(argv, " "), "kill -"+sig+" ") {
				os.WriteFile(b.stopMark, nil, 0o600)
			}
		}
		return "", 0, nil
	}
	return b.scripted.Run(ctx, argv)
}

func killCall(id, pid, sig string) []string {
	_ = id
	return []string{"exec", "-u", "1234:5678", "nova-box-c0ffee", "sh", "-c",
		`kill -` + sig + ` -"$1" 2>/dev/null || kill -` + sig + ` "$1"`, "kill", pid}
}

func runningBoxJob(t *testing.T, b *inBox, id string) Deps {
	t.Helper()
	bin, _ := jobDockerBin(t, b.stopMark)
	d := boxJobDeps(t, b, bin)
	out := startBoxJob(t, d, id, "/srv/repo", ".", `["sleep", "300"]`, "")
	if !out.OK || out.Meta["state"] != jobs.StateRunning {
		t.Fatalf("start: ok=%v meta=%v err=%q", out.OK, out.Meta, out.Error)
	}
	return d
}

// C5: job.stop kills inside the box — the pidfile read, then TERM to the
// job's group in the box — and the host client (which ignores TERM) ends
// only because the process in the box did: exit 7, not a host signal.
func TestBoxJobStopKillsInsideTheBox(t *testing.T) {
	b := &inBox{scripted: warm(), pid: "4242", ends: map[string]bool{"TERM": true},
		stopMark: filepath.Join(t.TempDir(), "inner-ended")}
	const id = "e0e0e0e0e0e1"
	d := runningBoxJob(t, b, id)
	t0 := time.Now()
	stop := Dispatch(context.Background(), "job.stop", map[string]any{"job_id": id}, d)
	if !stop.OK || stop.Meta["state"] != jobs.StateStopped || stop.Meta["exit_code"] != 7 {
		t.Fatalf("stop: ok=%v meta=%v err=%q", stop.OK, stop.Meta, stop.Error)
	}
	if took := time.Since(t0); took >= StopGrace {
		t.Fatalf("the stop took %v: the TERM inside the box should have ended it", took)
	}
	if want := [][]string{killCall(id, "4242", "TERM")}; !reflect.DeepEqual(b.kills, want) {
		t.Fatalf("kills\n got %q\nwant %q", b.kills, want)
	}
	if b.find("exec") != nil {
		t.Fatalf("the cat/kill went through the scripted runner: %v", b.calls)
	}
}

// C5: a pidfile not written yet is retried until the kill lands.
func TestBoxJobStopRetriesUntilThePidfileExists(t *testing.T) {
	b := &inBox{scripted: warm(), pid: "5151", catFails: 3, ends: map[string]bool{"TERM": true},
		stopMark: filepath.Join(t.TempDir(), "inner-ended")}
	const id = "e0e0e0e0e0e2"
	d := runningBoxJob(t, b, id)
	stop := Dispatch(context.Background(), "job.stop", map[string]any{"job_id": id}, d)
	if !stop.OK || stop.Meta["state"] != jobs.StateStopped || stop.Meta["exit_code"] != 7 {
		t.Fatalf("stop: ok=%v meta=%v err=%q", stop.OK, stop.Meta, stop.Error)
	}
	if want := [][]string{killCall(id, "5151", "TERM")}; !reflect.DeepEqual(b.kills, want) {
		t.Fatalf("kills %q", b.kills)
	}
}

// C5: a job that ignores TERM in the box gets KILL in the box at StopGrace.
func TestBoxJobStopKillsHardInsideTheBox(t *testing.T) {
	defer func(g time.Duration) { StopGrace = g }(StopGrace)
	StopGrace = 300 * time.Millisecond
	b := &inBox{scripted: warm(), pid: "6161", ends: map[string]bool{"KILL": true},
		stopMark: filepath.Join(t.TempDir(), "inner-ended")}
	const id = "e0e0e0e0e0e3"
	d := runningBoxJob(t, b, id)
	stop := Dispatch(context.Background(), "job.stop", map[string]any{"job_id": id}, d)
	if !stop.OK || stop.Meta["state"] != jobs.StateStopped {
		t.Fatalf("stop: ok=%v meta=%v err=%q", stop.OK, stop.Meta, stop.Error)
	}
	if len(b.kills) < 2 || !reflect.DeepEqual(b.kills[0], killCall(id, "6161", "TERM")) ||
		!reflect.DeepEqual(b.kills[len(b.kills)-1], killCall(id, "6161", "KILL")) {
		t.Fatalf("kills %q, want TERM then KILL inside the box", b.kills)
	}
}

// C5: when no kill can land in the box (no pidfile ever), the docker client
// is killed at StopGrace and the result says the process in the box may
// still run — never a silent stop.
func TestBoxJobStopThatCannotReachTheBoxSaysSo(t *testing.T) {
	defer func(g time.Duration) { StopGrace = g }(StopGrace)
	StopGrace = 300 * time.Millisecond
	b := &inBox{scripted: warm(), pid: "7171", catFails: 1 << 30, ends: map[string]bool{},
		stopMark: filepath.Join(t.TempDir(), "inner-ended")}
	const id = "e0e0e0e0e0e4"
	d := runningBoxJob(t, b, id)
	stop := Dispatch(context.Background(), "job.stop", map[string]any{"job_id": id}, d)
	if !stop.OK || stop.Meta["state"] != jobs.StateStopped || stop.Meta["exit_code"] != 137 {
		t.Fatalf("stop: ok=%v meta=%v err=%q", stop.OK, stop.Meta, stop.Error)
	}
	for _, w := range []string{"may still run", "nova-box-c0ffee", "No such file"} {
		if !strings.Contains(stop.Output, w) {
			t.Errorf("output %q lacks %q", stop.Output, w)
		}
	}
	if len(b.kills) != 0 {
		t.Fatalf("a kill was sent with no pid: %q", b.kills)
	}
}

// C1: with no cwd the box job runs in the change's worktree.
func TestBoxJobCwdDefaultsToTheWorktree(t *testing.T) {
	bin, _ := jobDockerBin(t, "")
	d := boxJobDeps(t, warm(), bin)
	const id = bJob
	out := DispatchEnvelope(context.Background(), "env-"+id, "job.start", boxJobArgs(t, `, "argv": ["true"]`), d)
	if !out.OK {
		t.Fatalf("job.start: %q", out.Error)
	}
	waitTerminal(t, d, id, 10*time.Second)
	if sp, _ := d.Jobs.Store.Spec(id); sp.Cwd != bWorktree {
		t.Fatalf("cwd = %q, want %q", sp.Cwd, bWorktree)
	}
	lg := Dispatch(context.Background(), "job.log", map[string]any{"job_id": id}, d)
	if !strings.HasPrefix(lg.Output, "exec\n-w\n"+bWorktree+"\n") {
		t.Fatalf("docker got %q", lg.Output)
	}
}
