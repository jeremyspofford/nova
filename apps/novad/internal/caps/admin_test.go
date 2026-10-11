package caps

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"novad/internal/admin"
)

// admin.exec's Windows route (S30b T3) is OS-neutral: the TaskResult →
// Outcome mapping runs here on every OS over a fake Submit. The real Submit
// (the scheduled task) is T2's, never run here.

type fakeSubmit struct {
	res     admin.TaskResult
	err     error
	called  int
	req     admin.TaskRequest
	timeout time.Duration
}

func (f *fakeSubmit) submit(_ context.Context, req admin.TaskRequest, timeout time.Duration) (admin.TaskResult, error) {
	f.called++
	f.req, f.timeout = req, timeout
	r := f.res
	r.ID = req.ID
	return r, f.err
}

func withDeadline(t *testing.T, d time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}

func TestTaskExecNoAdminPathIsTheStatedCannot(t *testing.T) {
	f := &fakeSubmit{err: errors.New("cannot: no admin path on this machine")}
	out := taskExec(withDeadline(t, time.Minute), map[string]any{"argv": []any{"whoami"}}, f.submit)
	if out.OK || out.Error != "cannot: no admin path on this machine" {
		t.Fatalf("got ok=%v error=%q, want the stated cannot", out.OK, out.Error)
	}
	if out.ExitCode != nil {
		t.Fatalf("a cannot carries no exit code, got %d", *out.ExitCode)
	}
}

func TestTaskExecOtherSubmitErrorsAreStated(t *testing.T) {
	f := &fakeSubmit{err: errors.New("cannot: nobody is signed in on this machine — the admin task runs only while the owner is signed in")}
	out := taskExec(withDeadline(t, time.Minute), map[string]any{"argv": []any{"whoami"}}, f.submit)
	if out.OK || !strings.Contains(out.Error, "nobody is signed in") {
		t.Fatalf("got ok=%v error=%q", out.OK, out.Error)
	}
}

func TestTaskExecSendsTheRequestItWasGiven(t *testing.T) {
	f := &fakeSubmit{res: admin.TaskResult{OK: true, Elevated: true, User: "DELL\\owner"}}
	out := taskExec(withDeadline(t, time.Minute),
		wireArgs(t, `{"argv": ["winget", "install", "-e"], "cwd": "C:\\work", "timeout_s": 20}`), f.submit)
	if !out.OK {
		t.Fatalf("a run that completed is ok: %s", out.Error)
	}
	if f.called != 1 {
		t.Fatalf("Submit called %d times, want 1", f.called)
	}
	if strings.Join(f.req.Argv, " ") != "winget install -e" || f.req.Cwd != `C:\work` {
		t.Fatalf("request argv=%q cwd=%q", f.req.Argv, f.req.Cwd)
	}
	if f.req.TimeoutS.String() != "20" || f.timeout != 20*time.Second {
		t.Fatalf("request timeout_s=%q timeout=%v, want 20 / 20s", f.req.TimeoutS, f.timeout)
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(f.req.ID) {
		t.Fatalf("request id %q is not 32 lowercase hex", f.req.ID)
	}
	if f.req.V != admin.FileVersion {
		t.Fatalf("request v=%d, want %d", f.req.V, admin.FileVersion)
	}
}

func TestTaskExecExitCodeAndOutputPassThrough(t *testing.T) {
	f := &fakeSubmit{res: admin.TaskResult{OK: true, ExitCode: 3, Stdout: "out-line\n", Stderr: "err-line\n", Elevated: true, User: "DELL\\owner"}}
	out := taskExec(withDeadline(t, time.Minute), map[string]any{"argv": []any{"x"}}, f.submit)
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 3 {
		t.Fatalf("a nonzero exit is ok:true with the code: ok=%v code=%v err=%q", out.OK, out.ExitCode, out.Error)
	}
	for _, want := range []string{"out-line", "err-line", "[process exited with code 3]"} {
		if !strings.Contains(out.Output, want) {
			t.Errorf("output %q lacks %q", out.Output, want)
		}
	}
	m := out.Meta
	if m["elevated"] != true || m["kind"] != "task" || m["ran_as"] != "user_elevated" || m["user"] != "DELL\\owner" {
		t.Fatalf("meta = %v", m)
	}
}

func TestTaskExecZeroExitHasNoExitNote(t *testing.T) {
	f := &fakeSubmit{res: admin.TaskResult{OK: true, ExitCode: 0, Stdout: "fine\n", Elevated: true, User: "u"}}
	out := taskExec(withDeadline(t, time.Minute), map[string]any{"argv": []any{"x"}}, f.submit)
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 0 || strings.Contains(out.Output, "exited with code") {
		t.Fatalf("ok=%v code=%v output=%q", out.OK, out.ExitCode, out.Output)
	}
}

func TestTaskExecNotElevatedIsSaidInMeta(t *testing.T) {
	f := &fakeSubmit{res: admin.TaskResult{OK: true, Elevated: false, User: "u"}}
	out := taskExec(withDeadline(t, time.Minute), map[string]any{"argv": []any{"x"}}, f.submit)
	if out.Meta["ran_as"] != "user_not_elevated" {
		t.Fatalf("the task's own token said not elevated; meta = %v", out.Meta)
	}
}

func TestTaskExecTimeoutIsOkFalse(t *testing.T) {
	f := &fakeSubmit{res: admin.TaskResult{TimedOut: true, ExitCode: -1, Stdout: "partial"}}
	out := taskExec(withDeadline(t, time.Minute), map[string]any{"argv": []any{"x"}}, f.submit)
	if out.OK || !strings.Contains(out.Error, "timed out") || !strings.Contains(out.Error, "partial") {
		t.Fatalf("got ok=%v error=%q", out.OK, out.Error)
	}
}

func TestTaskExecNeverRanIsTheTasksWords(t *testing.T) {
	f := &fakeSubmit{res: admin.TaskResult{ExitCode: -1, Said: "cannot: the request file is owned by S-1-5-21-9, not the owner — not run"}}
	out := taskExec(withDeadline(t, time.Minute), map[string]any{"argv": []any{"x"}}, f.submit)
	if out.OK || out.Error != f.res.Said {
		t.Fatalf("got ok=%v error=%q, want the task's own words", out.OK, out.Error)
	}
}

func TestTaskExecCapsCombinedOutput(t *testing.T) {
	big := strings.Repeat("a", admin.OutputCap)
	f := &fakeSubmit{res: admin.TaskResult{OK: true, Stdout: big, Stderr: big, Elevated: true}}
	out := taskExec(withDeadline(t, time.Minute), map[string]any{"argv": []any{"x"}}, f.submit)
	if !out.OK || !strings.Contains(out.Output, "[truncated at 64 KiB]") || len(out.Output) > OutputCap+64 {
		t.Fatalf("ok=%v len=%d tail=%q", out.OK, len(out.Output), out.Output[max(0, len(out.Output)-40):])
	}
}

func TestTaskExecBadArgsRunNothing(t *testing.T) {
	for name, raw := range map[string]string{
		"no argv":          `{}`,
		"empty argv":       `{"argv": []}`,
		"argv not strings": `{"argv": [1]}`,
		"cwd not string":   `{"argv": ["x"], "cwd": 5}`,
		"timeout fraction": `{"argv": ["x"], "timeout_s": 1.5}`,
		"timeout string":   `{"argv": ["x"], "timeout_s": "9"}`,
		"timeout zero":     `{"argv": ["x"], "timeout_s": 0}`,
	} {
		f := &fakeSubmit{}
		out := taskExec(withDeadline(t, time.Minute), wireArgs(t, raw), f.submit)
		if out.OK || out.Error == "" || f.called != 0 {
			t.Errorf("%s: ok=%v error=%q submitted=%d", name, out.OK, out.Error, f.called)
		}
	}
}

func TestAdminTimeoutDerivation(t *testing.T) {
	near := func(got, want time.Duration) bool { return got <= want && got > want-2*time.Second }
	// No timeout_s: the ctx's remaining time minus the margin.
	got, err := adminTimeout(withDeadline(t, 60*time.Second), map[string]any{}, 2*time.Second)
	if err != nil || !near(got, 58*time.Second) {
		t.Fatalf("ctx 60s, margin 2s: got %v %v, want ~58s", got, err)
	}
	// timeout_s under the ctx: taken as given.
	got, err = adminTimeout(withDeadline(t, 60*time.Second), wireArgs(t, `{"timeout_s": 10}`), 2*time.Second)
	if err != nil || got != 10*time.Second {
		t.Fatalf("timeout_s 10: got %v %v", got, err)
	}
	// timeout_s past the ctx: capped by it.
	got, err = adminTimeout(withDeadline(t, 60*time.Second), wireArgs(t, `{"timeout_s": 600}`), 2*time.Second)
	if err != nil || !near(got, 58*time.Second) {
		t.Fatalf("timeout_s 600 under a 60s ctx: got %v %v, want ~58s", got, err)
	}
	// No deadline and no timeout_s: the agent's command timeout.
	got, err = adminTimeout(context.Background(), map[string]any{}, 2*time.Second)
	if err != nil || got != 110*time.Second {
		t.Fatalf("no deadline: got %v %v, want 110s", got, err)
	}
	// Whole seconds only.
	if got%time.Second != 0 {
		t.Fatalf("timeout %v is not whole seconds", got)
	}
	// Too little time left: a stated cannot, nothing run.
	if _, err = adminTimeout(withDeadline(t, 2500*time.Millisecond), map[string]any{}, 2*time.Second); err == nil || !strings.Contains(err.Error(), "cannot") {
		t.Fatalf("0.5s left after the margin: err = %v, want a cannot", err)
	}
	// A bad timeout_s is refused naming it.
	if _, err = adminTimeout(context.Background(), wireArgs(t, `{"timeout_s": 1.5}`), 2*time.Second); err == nil || !strings.Contains(err.Error(), "timeout_s") {
		t.Fatalf("timeout_s 1.5: err = %v", err)
	}
}
