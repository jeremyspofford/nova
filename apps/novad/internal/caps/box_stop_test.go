package caps

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"novad/internal/box"
	"novad/internal/jobs"
)

// -- box.stop (S38c T4) --------------------------------------------------------
//
// A landing's judge stops the change's own idle box to take its slot. Only the
// change id crosses the wire; Manager.Stop derives every name from it.

func psArgv() []string {
	return []string{"ps", "-a", "--filter", "label=" + box.Label, "--format", "{{.Names}}\t{{.State}}\t{{.Image}}"}
}

// stopDeps is boxDeps with a job store under a temp dir, wired as the agent
// wires it (client.Configure): Busy reads the store's live box jobs.
func stopDeps(t *testing.T, s *scripted) (Deps, *jobs.Store) {
	t.Helper()
	d := boxDeps(s, "")
	st := jobs.NewStore(t.TempDir())
	d.Box.Busy = st.LiveBoxes
	d.Jobs = &JobDeps{Store: st}
	return d, st
}

// boxJob seeds a box job for change; ended writes a terminal status.
func boxJob(t *testing.T, st *jobs.Store, id, change string, ended bool) {
	t.Helper()
	if err := st.Create(jobs.Spec{ID: id, EnvelopeID: "e-" + id, Argv: []string{"uv", "run", "pytest"},
		Box: &jobs.BoxRef{Change: change, Container: box.Names(change).Box}, CreatedAt: time.Unix(1e9, 0)}); err != nil {
		t.Fatal(err)
	}
	if ended {
		code := 0
		if err := st.WriteStatus(id, jobs.Status{State: jobs.StateDone, ExitCode: &code}); err != nil {
			t.Fatal(err)
		}
	}
}

// C1, C5
func TestBoxStopStopsTheChangesRunningBox(t *testing.T) {
	s := &scripted{ps: "nova-box-c0ffee\trunning\t" + bTag + "\nnova-box-c0ffee-db\trunning\tpg\n" +
		"nova-box-abc123\trunning\t" + bTag + "\nnova-box-abc123-db\trunning\tpg\n"}
	d, st := stopDeps(t, s)
	boxJob(t, st, "0123456789ab", "abc123", false) // another change's live job
	boxJob(t, st, "ba9876543210", "c0ffee", true)  // this change's job, ended
	out := Dispatch(context.Background(), "box.stop", wireArgs(t, `{"change": "c0ffee"}`), d)
	if !out.OK {
		t.Fatalf("box.stop: %q", out.Error)
	}
	want := [][]string{psArgv(), {"stop", "nova-box-c0ffee", "nova-box-c0ffee-db"}}
	if !reflect.DeepEqual(s.calls, want) {
		t.Fatalf("docker argv\n got %q\nwant %q", s.calls, want)
	}
	if !reflect.DeepEqual(out.Meta, map[string]any{"box": "nova-box-c0ffee", "stopped": true}) {
		t.Fatalf("meta = %#v", out.Meta)
	}
	if out.Output != "nova-box-c0ffee stopped; it starts again on the next box command" {
		t.Fatalf("output = %q", out.Output)
	}
	if out.ExitCode == nil || *out.ExitCode != 0 {
		t.Errorf("exit = %v, want 0", out.ExitCode)
	}
}

// C2, C5
func TestBoxStopOfABoxNotRunningSaysSo(t *testing.T) {
	for _, ps := range []string{
		"nova-box-c0ffee\texited\t" + bTag + "\n",
		"nova-box-abc123\trunning\t" + bTag + "\n",
	} {
		s := &scripted{ps: ps}
		d, _ := stopDeps(t, s)
		out := Dispatch(context.Background(), "box.stop", wireArgs(t, `{"change": "c0ffee"}`), d)
		if !out.OK || !reflect.DeepEqual(out.Meta, map[string]any{"box": "nova-box-c0ffee", "stopped": false}) {
			t.Fatalf("ok=%v err=%q meta=%v", out.OK, out.Error, out.Meta)
		}
		if out.Output != "nova-box-c0ffee was not running; nothing was stopped" {
			t.Fatalf("output = %q", out.Output)
		}
		if !reflect.DeepEqual(s.calls, [][]string{psArgv()}) {
			t.Fatalf("calls %q, want only the listing", s.calls)
		}
	}
}

// C3, C5
func TestBoxStopRefusesABoxRunningALiveJobNamingIt(t *testing.T) {
	s := warm()
	d, st := stopDeps(t, s)
	boxJob(t, st, "0123456789ab", "c0ffee", false)
	boxJob(t, st, "fedcba987654", "c0ffee", false)
	boxJob(t, st, "ba9876543210", "c0ffee", true)  // ended: not named
	boxJob(t, st, "aaaaaaaaaaaa", "abc123", false) // another change: not named
	out := Dispatch(context.Background(), "box.stop", wireArgs(t, `{"change": "c0ffee"}`), d)
	want := "cannot stop the box nova-box-c0ffee: it runs live jobs 0123456789ab, fedcba987654 — stop it with job.stop or wait for it; nothing was stopped"
	if out.OK || out.Error != want {
		t.Fatalf("ok=%v err=%q\nwant %q", out.OK, out.Error, want)
	}
	if out.Meta != nil {
		t.Fatalf("meta %v on a box that was not stopped", out.Meta)
	}
	for _, c := range s.calls {
		if c[0] == "stop" {
			t.Fatalf("stopped a busy box: %q", c)
		}
	}
}

// C3, C5: with no job store to name the job, the refusal still stands.
func TestBoxStopRefusesABusyBoxWithoutAStoreToNameTheJob(t *testing.T) {
	s := warm()
	d := boxDeps(s, "")
	d.Box.Busy = func() (map[string]bool, error) { return map[string]bool{"c0ffee": true}, nil }
	out := Dispatch(context.Background(), "box.stop", wireArgs(t, `{"change": "c0ffee"}`), d)
	want := "cannot stop the box nova-box-c0ffee: it runs a live job — stop it with job.stop or wait for it; nothing was stopped"
	if out.OK || out.Error != want || out.Meta != nil {
		t.Fatalf("ok=%v err=%q meta=%v\nwant %q", out.OK, out.Error, out.Meta, want)
	}
}

// C4
func TestBoxStopRefusesABadChangeBeforeDocker(t *testing.T) {
	for _, c := range []struct{ raw, want string }{
		{`{}`, "'change'"},
		{`{"change": 7}`, "'change'"},
		{`{"change": null}`, "'change'"},
		{`{"change": "C0FFEE"}`, `"C0FFEE"`},
		{`{"change": "c0ffee1"}`, `"c0ffee1"`},
		{`{"change": "../x"}`, `"../x"`},
		{`{"change": ""}`, `""`},
	} {
		s := warm()
		d, _ := stopDeps(t, s)
		out := Dispatch(context.Background(), "box.stop", wireArgs(t, c.raw), d)
		if out.OK || !strings.HasPrefix(out.Error, "box.stop") || !strings.Contains(out.Error, c.want) ||
			!strings.HasSuffix(out.Error, "nothing was stopped") {
			t.Errorf("%s: ok=%v err=%q, want a refusal naming %s", c.raw, out.OK, out.Error, c.want)
		}
		if len(s.calls) != 0 || out.Meta != nil {
			t.Errorf("%s: a refused call reached docker: %q (meta %v)", c.raw, s.calls, out.Meta)
		}
	}
}

// C5
func TestBoxStopStatesADockerFailure(t *testing.T) {
	for _, failOn := range []string{"ps ", "stop"} {
		s := warm()
		s.failOn = failOn
		d, _ := stopDeps(t, s)
		out := Dispatch(context.Background(), "box.stop", wireArgs(t, `{"change": "c0ffee"}`), d)
		if out.OK || !strings.HasPrefix(out.Error, "cannot stop the box nova-box-c0ffee: ") ||
			!strings.Contains(out.Error, "boom at "+strings.TrimSpace(failOn)) {
			t.Errorf("fail on %q: ok=%v err=%q", failOn, out.OK, out.Error)
		}
		if out.Meta != nil {
			t.Errorf("fail on %q: meta %v on a box that was not stopped", failOn, out.Meta)
		}
	}
}

// C5
func TestBoxStopWithoutAManagerSaysCannot(t *testing.T) {
	out := Dispatch(context.Background(), "box.stop", wireArgs(t, `{"change": "c0ffee"}`), Deps{})
	if out.OK || out.Error != "cannot: no box manager on this agent" || out.Meta != nil {
		t.Fatalf("ok=%v err=%q meta=%v", out.OK, out.Error, out.Meta)
	}
}

// C5: one live job is named in the singular; a store that cannot be read
// still refuses, as "a live job".
func TestBoxStopNamesOneLiveJob(t *testing.T) {
	s := warm()
	d, st := stopDeps(t, s)
	boxJob(t, st, "0123456789ab", "c0ffee", false)
	out := Dispatch(context.Background(), "box.stop", wireArgs(t, `{"change": "c0ffee"}`), d)
	want := "cannot stop the box nova-box-c0ffee: it runs live job 0123456789ab — stop it with job.stop or wait for it; nothing was stopped"
	if out.OK || out.Error != want {
		t.Fatalf("ok=%v err=%q\nwant %q", out.OK, out.Error, want)
	}
	d.Box.Busy = func() (map[string]bool, error) { return map[string]bool{"c0ffee": true}, nil }
	d.Jobs = &JobDeps{Store: jobs.NewStore("/nonexistent/state")}
	out = Dispatch(context.Background(), "box.stop", wireArgs(t, `{"change": "c0ffee"}`), d)
	if out.OK || !strings.Contains(out.Error, ": it runs a live job — ") {
		t.Fatalf("store with no jobs: ok=%v err=%q", out.OK, out.Error)
	}
	for _, c := range s.calls {
		if c[0] == "stop" {
			t.Fatalf("stopped a busy box: %q", c)
		}
	}
}
