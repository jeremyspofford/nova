package caps

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"novad/internal/jobs"
)

// jobDeps is a handler's deps with a job store under a temp state dir and a
// wrapper binary that does not exist (a spawn then records failed_to_start).
func jobDeps(t *testing.T) Deps {
	t.Helper()
	d := testDeps(t)
	d.Jobs = &JobDeps{Store: jobs.NewStore(t.TempDir()), Binary: filepath.Join(t.TempDir(), "no-novad"), Mode: "manual"}
	return d
}

func jobDirs(t *testing.T, s *jobs.Store) []string {
	t.Helper()
	entries, err := os.ReadDir(s.Root)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestJobCapabilitiesAreInTheTable(t *testing.T) {
	names := map[string]bool{}
	for _, n := range Names() {
		names[n] = true
	}
	for _, c := range []string{"job.start", "job.status", "job.log", "job.stop", "job.list"} {
		if !names[c] {
			t.Errorf("%s is not in the table", c)
		}
	}
}

func TestJobsWithoutAStoreSayCannot(t *testing.T) {
	d := testDeps(t)
	for _, c := range []string{"job.start", "job.status", "job.log", "job.stop", "job.list"} {
		out := Dispatch(context.Background(), c, map[string]any{"job_id": "abcdef012345", "argv": []any{"true"}}, d)
		if out.OK || !strings.HasPrefix(out.Error, "cannot: no job store on this agent") {
			t.Errorf("%s with no store: ok=%v err=%q", c, out.OK, out.Error)
		}
	}
}

func TestJobStartRefusesBadInputsAndWritesNothing(t *testing.T) {
	file := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	good := func() map[string]any {
		return map[string]any{"job_id": "abcdef012345", "argv": []any{"true"}}
	}
	cases := map[string]func(map[string]any){
		"no job_id":       func(a map[string]any) { delete(a, "job_id") },
		"upper job_id":    func(a map[string]any) { a["job_id"] = "ABCDEF012345" },
		"dotdot job_id":   func(a map[string]any) { a["job_id"] = "../x" },
		"no argv":         func(a map[string]any) { delete(a, "argv") },
		"empty argv":      func(a map[string]any) { a["argv"] = []any{} },
		"non-string argv": func(a map[string]any) { a["argv"] = []any{json.Number("1")} },
		"relative cwd":    func(a map[string]any) { a["cwd"] = "rel/dir" },
		"dot cwd":         func(a map[string]any) { a["cwd"] = "." }, // exists, but relative
		"missing cwd":     func(a map[string]any) { a["cwd"] = filepath.Join(t.TempDir(), "gone") },
		"file cwd":        func(a map[string]any) { a["cwd"] = file },
		"non-string cwd":  func(a map[string]any) { a["cwd"] = json.Number("3") },
		"env not object":  func(a map[string]any) { a["env"] = "A=B" },
		"env non-string":  func(a map[string]any) { a["env"] = map[string]any{"A": json.Number("1")} },
		"env digit name":  func(a map[string]any) { a["env"] = map[string]any{"1X": "v"} },
		"env = in name":   func(a map[string]any) { a["env"] = map[string]any{"A=B": "v"} },
		"env empty name":  func(a map[string]any) { a["env"] = map[string]any{"": "v"} },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			d := jobDeps(t)
			args := good()
			mut(args)
			out := Dispatch(context.Background(), "job.start", args, d)
			if out.OK || !strings.Contains(out.Error, "nothing was started") {
				t.Fatalf("ok=%v err=%q, want a refusal saying nothing was started", out.OK, out.Error)
			}
			if got := jobDirs(t, d.Jobs.Store); len(got) != 0 {
				t.Fatalf("a refused start left %v under the jobs dir", got)
			}
		})
	}
}

func TestJobStartKeysTheSpecToTheEnvelope(t *testing.T) {
	d := jobDeps(t)
	cwd := t.TempDir()
	DispatchEnvelope(context.Background(), "env-77", "job.start",
		map[string]any{"job_id": "0123456789ab", "argv": []any{"echo", "hi"}, "cwd": cwd,
			"env": map[string]any{"ZED": "z-value", "ALPHA": "a-value"}}, d)
	sp, err := d.Jobs.Store.Spec("0123456789ab")
	if err != nil {
		t.Fatalf("no spec after job.start: %v", err)
	}
	if sp.EnvelopeID != "env-77" || !reflect.DeepEqual(sp.Argv, []string{"echo", "hi"}) || sp.Cwd != cwd {
		t.Fatalf("spec = %+v", sp)
	}
	if !reflect.DeepEqual(sp.EnvKeys, []string{"ALPHA", "ZED"}) {
		t.Fatalf("env_keys = %v, want [ALPHA ZED] (names only, sorted)", sp.EnvKeys)
	}
	raw, _ := os.ReadFile(filepath.Join(d.Jobs.Store.Dir("0123456789ab"), jobs.SpecFile))
	if strings.Contains(string(raw), "z-value") || strings.Contains(string(raw), "a-value") {
		t.Fatalf("an env value reached spec.json: %s", raw)
	}
}

func TestJobStartDefaultsCwdToHome(t *testing.T) {
	d := jobDeps(t)
	DispatchEnvelope(context.Background(), "e", "job.start", map[string]any{"job_id": "0123456789ab", "argv": []any{"true"}}, d)
	sp, err := d.Jobs.Store.Spec("0123456789ab")
	if err != nil || sp.Cwd != d.Home {
		t.Fatalf("cwd = %q (%v), want home %q", sp.Cwd, err, d.Home)
	}
}

func TestJobStartThatCannotLaunchIsFailedToStart(t *testing.T) {
	d := jobDeps(t)
	out := Dispatch(context.Background(), "job.start", map[string]any{"job_id": "0123456789ab", "argv": []any{"true"}}, d)
	if out.OK {
		t.Fatalf("a wrapper that cannot launch reported ok: %q", out.Output)
	}
	if out.Meta["state"] != jobs.StateFailedToStart || out.Meta["job"] != "0123456789ab" {
		t.Fatalf("meta = %v, want state failed_to_start for the job", out.Meta)
	}
	if !strings.Contains(out.Error, "failed to start") || !strings.Contains(out.Error, "no-novad") {
		t.Fatalf("error = %q, want it to say it failed to start and why", out.Error)
	}
}

func TestJobStartTwiceIsRefused(t *testing.T) {
	d := jobDeps(t)
	Dispatch(context.Background(), "job.start", map[string]any{"job_id": "0123456789ab", "argv": []any{"first"}}, d)
	out := Dispatch(context.Background(), "job.start", map[string]any{"job_id": "0123456789ab", "argv": []any{"second"}}, d)
	if out.OK || !strings.Contains(out.Error, "already exists") {
		t.Fatalf("second start: ok=%v err=%q", out.OK, out.Error)
	}
	sp, err := d.Jobs.Store.Spec("0123456789ab")
	if err != nil || sp.Argv[0] != "first" {
		t.Fatalf("the first spec changed: %+v (%v)", sp, err)
	}
}

func TestUnknownJobIsTheNoJobSentence(t *testing.T) {
	d := jobDeps(t)
	for _, c := range []string{"job.status", "job.log", "job.stop"} {
		out := Dispatch(context.Background(), c, map[string]any{"job_id": "abcdef012345"}, d)
		if out.OK || out.Error != "no job abcdef012345 on this device" {
			t.Errorf("%s of an unknown id: ok=%v err=%q", c, out.OK, out.Error)
		}
		out = Dispatch(context.Background(), c, map[string]any{"job_id": "NOT-AN-ID"}, d)
		if out.OK || !strings.Contains(out.Error, "12 lowercase hex") {
			t.Errorf("%s of a malformed id: ok=%v err=%q", c, out.OK, out.Error)
		}
	}
}

// seedJob writes a job's spec, status and log by hand.
func seedJob(t *testing.T, s *jobs.Store, id string, created time.Time, st *jobs.Status, log string) {
	t.Helper()
	if err := s.Create(jobs.Spec{ID: id, EnvelopeID: "e-" + id, Argv: []string{"run", id}, Cwd: "/work/" + id, CreatedAt: created}); err != nil {
		t.Fatal(err)
	}
	if st != nil {
		if err := s.WriteStatus(id, *st); err != nil {
			t.Fatal(err)
		}
	}
	if log != "" {
		if err := os.WriteFile(filepath.Join(s.Dir(id), jobs.LogFile), []byte(log), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func intp(n int) *int { return &n }

func TestJobStatusMetaCarriesTheRecord(t *testing.T) {
	d := jobDeps(t)
	start := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	end := start.Add(90 * time.Second)
	seedJob(t, d.Jobs.Store, "aaaaaaaaaaa3", start, &jobs.Status{State: jobs.StateDone, PID: 4242, WrapperPID: 4241,
		ExitCode: intp(3), StartedAt: &start, EndedAt: &end, Reason: "why-x", LockWaitedS: 2.5, LogBytes: 7}, "")
	out := Dispatch(context.Background(), "job.status", map[string]any{"job_id": "aaaaaaaaaaa3"}, d)
	if !out.OK {
		t.Fatalf("status: %q", out.Error)
	}
	m := out.Meta
	want := map[string]any{"job": "aaaaaaaaaaa3", "state": "done", "exit_code": 3, "pid": 4242,
		"started_at": start.Format(time.RFC3339Nano), "ended_at": end.Format(time.RFC3339Nano),
		"reason": "why-x", "lock_waited_s": 2.5, "log_bytes": int64(7), "cwd": "/work/aaaaaaaaaaa3", "ran_in": "host"}
	for k, v := range want {
		if !reflect.DeepEqual(m[k], v) {
			t.Errorf("meta[%s] = %#v, want %#v", k, m[k], v)
		}
	}
	if !reflect.DeepEqual(m["argv"], []string{"run", "aaaaaaaaaaa3"}) {
		t.Errorf("meta argv = %#v", m["argv"])
	}
	if !strings.Contains(out.Output, "done") || !strings.Contains(out.Output, "exit 3") {
		t.Errorf("output = %q", out.Output)
	}

	seedJob(t, d.Jobs.Store, "aaaaaaaaaaa0", start, &jobs.Status{State: jobs.StateDone, ExitCode: intp(0)}, "")
	out = Dispatch(context.Background(), "job.status", map[string]any{"job_id": "aaaaaaaaaaa0"}, d)
	if v, ok := out.Meta["exit_code"]; !ok || v != 0 {
		t.Fatalf("exit 0 must be present: %#v (%v)", v, ok)
	}
	seedJob(t, d.Jobs.Store, "aaaaaaaaaaab", start, &jobs.Status{State: jobs.StateRunning, PID: 5}, "")
	out = Dispatch(context.Background(), "job.status", map[string]any{"job_id": "aaaaaaaaaaab"}, d)
	if _, ok := out.Meta["exit_code"]; ok || out.Meta["state"] != "running" {
		t.Fatalf("a running job has no exit_code: %v", out.Meta)
	}
}

func TestJobListNewestFirst(t *testing.T) {
	d := jobDeps(t)
	t0 := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	seedJob(t, d.Jobs.Store, "bbbbbbbbbbb1", t0, &jobs.Status{State: jobs.StateDone, ExitCode: intp(1)}, "")
	seedJob(t, d.Jobs.Store, "bbbbbbbbbbb2", t0.Add(time.Hour), &jobs.Status{State: jobs.StateRunning, PID: 9}, "")
	out := Dispatch(context.Background(), "job.list", map[string]any{}, d)
	if !out.OK {
		t.Fatalf("list: %q", out.Error)
	}
	list, _ := out.Meta["jobs"].([]map[string]any)
	if len(list) != 2 || list[0]["job"] != "bbbbbbbbbbb2" || list[1]["job"] != "bbbbbbbbbbb1" {
		t.Fatalf("jobs = %v, want newest first", list)
	}
	if list[0]["state"] != "running" || list[1]["exit_code"] != 1 || out.Meta["total"] != 2 {
		t.Fatalf("list meta = %v", out.Meta)
	}
	if !strings.Contains(out.Output, "bbbbbbbbbbb2 running") || !strings.Contains(out.Output, "bbbbbbbbbbb1 done exit 1") {
		t.Fatalf("output = %q", out.Output)
	}
	empty := Dispatch(context.Background(), "job.list", map[string]any{}, jobDeps(t))
	if !empty.OK || empty.Meta["total"] != 0 || empty.Output != "no jobs" {
		t.Fatalf("empty list: %+v", empty)
	}
}

func TestJobLogReadsByRange(t *testing.T) {
	d := jobDeps(t)
	seedJob(t, d.Jobs.Store, "ccccccccccc1", time.Now(), &jobs.Status{State: jobs.StateDone, ExitCode: intp(0)}, "0123456789")
	read := func(args map[string]any) Outcome {
		args["job_id"] = "ccccccccccc1"
		return Dispatch(context.Background(), "job.log", args, d)
	}
	check := func(name string, out Outcome, text string, offset, length int64) {
		t.Helper()
		if !out.OK || out.Output != text || out.Meta["bytes_total"] != int64(10) || out.Meta["offset"] != offset || out.Meta["length"] != length {
			t.Errorf("%s: ok=%v out=%q meta=%v err=%q", name, out.OK, out.Output, out.Meta, out.Error)
		}
	}
	check("offset+length", read(map[string]any{"offset": json.Number("2"), "length": json.Number("3")}), "234", 2, 3)
	check("offset only", read(map[string]any{"offset": json.Number("7")}), "789", 7, 3)
	check("tail", read(map[string]any{"tail_bytes": json.Number("4")}), "6789", 6, 4)
	check("tail over size", read(map[string]any{"tail_bytes": json.Number("40")}), "0123456789", 0, 10)
	check("default", read(map[string]any{}), "0123456789", 0, 10)
	check("past the end", read(map[string]any{"offset": json.Number("20")}), "", 20, 0)
	for name, args := range map[string]map[string]any{
		"length over cap": {"length": json.Number("262145")},
		"tail over cap":   {"tail_bytes": json.Number("262145")},
		"negative offset": {"offset": json.Number("-1")},
		"negative tail":   {"tail_bytes": json.Number("-1")},
		"fraction":        {"offset": json.Number("1.5")},
		"both":            {"offset": json.Number("1"), "tail_bytes": json.Number("2")},
	} {
		if out := read(args); out.OK {
			t.Errorf("%s: read ok %q", name, out.Output)
		}
	}
	if out := read(map[string]any{"length": json.Number("262145")}); !strings.Contains(out.Error, "262144") {
		t.Errorf("over-cap error does not name the cap: %q", out.Error)
	}
	// A job with no log yet reads empty.
	seedJob(t, d.Jobs.Store, "ccccccccccc2", time.Now(), nil, "")
	out := Dispatch(context.Background(), "job.log", map[string]any{"job_id": "ccccccccccc2"}, d)
	if !out.OK || out.Output != "" || out.Meta["bytes_total"] != int64(0) {
		t.Errorf("no log yet: %+v", out)
	}
}

// A log bigger than one read: the default (no offset, no tail_bytes) is the
// LAST LogReadCap bytes, not the first.
func TestJobLogDefaultIsTheTailOfALongLog(t *testing.T) {
	d := jobDeps(t)
	log := "HEAD012345" + strings.Repeat("x", LogReadCap-4) + "TAIL"
	seedJob(t, d.Jobs.Store, "ccccccccccc3", time.Now(), &jobs.Status{State: jobs.StateDone, ExitCode: intp(0)}, log)
	out := Dispatch(context.Background(), "job.log", map[string]any{"job_id": "ccccccccccc3"}, d)
	total := int64(len(log))
	if !out.OK || out.Meta["bytes_total"] != total || out.Meta["offset"] != total-LogReadCap || out.Meta["length"] != int64(LogReadCap) {
		t.Fatalf("default read of a long log: ok=%v meta=%v err=%q", out.OK, out.Meta, out.Error)
	}
	if out.Output != log[total-LogReadCap:] || !strings.HasSuffix(out.Output, "TAIL") || strings.Contains(out.Output, "HEAD") {
		t.Fatalf("default read is not the last %d bytes (len %d)", LogReadCap, len(out.Output))
	}
}

func TestJobStopOfAnEndedJobSignalsNothing(t *testing.T) {
	d := jobDeps(t)
	seedJob(t, d.Jobs.Store, "ddddddddddd1", time.Now(), &jobs.Status{State: jobs.StateDone, ExitCode: intp(0), PID: 1}, "")
	out := Dispatch(context.Background(), "job.stop", map[string]any{"job_id": "ddddddddddd1"}, d)
	if !out.OK || !strings.Contains(out.Output, "already ended") || out.Meta["state"] != "done" {
		t.Fatalf("stop of an ended job: %+v", out)
	}
	if _, err := os.Stat(filepath.Join(d.Jobs.Store.Dir("ddddddddddd1"), jobs.StopFile)); !os.IsNotExist(err) {
		t.Fatalf("a stop file was written for an ended job (%v)", err)
	}
}

// Amended C7: job.list lists the readable jobs and names each unreadable
// one with why; one bad dir never fails the whole list.
func TestJobListNamesAnUnreadableJob(t *testing.T) {
	d := jobDeps(t)
	t0 := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	seedJob(t, d.Jobs.Store, "ddddddddddd1", t0, &jobs.Status{State: jobs.StateDone, ExitCode: intp(0)}, "")
	bad := d.Jobs.Store.Dir("ddddddddddd2")
	if err := os.MkdirAll(bad, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bad, jobs.SpecFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	out := Dispatch(context.Background(), "job.list", map[string]any{}, d)
	if !out.OK {
		t.Fatalf("one unreadable job failed the list: %q", out.Error)
	}
	list, _ := out.Meta["jobs"].([]map[string]any)
	if len(list) != 1 || list[0]["job"] != "ddddddddddd1" || out.Meta["total"] != 1 {
		t.Fatalf("jobs = %v (meta %v), want the readable one", list, out.Meta)
	}
	unread, _ := out.Meta["unreadable"].([]map[string]any)
	if len(unread) != 1 || unread[0]["job"] != "ddddddddddd2" || fmt.Sprint(unread[0]["error"]) == "" {
		t.Fatalf("unreadable = %v", out.Meta["unreadable"])
	}
	if !strings.Contains(out.Output, "ddddddddddd1 done exit 0") || !strings.Contains(out.Output, "ddddddddddd2 unreadable:") {
		t.Fatalf("output = %q", out.Output)
	}
}
