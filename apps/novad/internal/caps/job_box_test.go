package caps

import (
	"context"
	"strings"
	"testing"
)

// S30c T5: job.start with box args. Every value is a non-default (change
// c0ffee, checkout /srv/repo, branch trunk, limits 3/5/700/3).

const bJob = "b0b0b0b0b0b1"

func boxJobArgs(t *testing.T, extra string) map[string]any {
	t.Helper()
	return wireArgs(t, `{"job_id": "`+bJob+`", "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", `+bLimits+extra+`}`)
}

// C1: an agent with no box manager (Windows) says cannot and starts nothing.
func TestBoxJobWithoutAManagerSaysCannot(t *testing.T) {
	d := jobDeps(t)
	out := Dispatch(context.Background(), "job.start",
		boxJobArgs(t, `, "argv": ["true"], "cwd": "`+bWorktree+`"`), d)
	if out.OK || out.Error != "cannot: no box manager on this agent" || out.Meta != nil {
		t.Fatalf("ok=%v err=%q meta=%v", out.OK, out.Error, out.Meta)
	}
	if dirs := jobDirs(t, d.Jobs.Store); len(dirs) != 0 {
		t.Fatalf("job dirs %v", dirs)
	}
}

// C1: every input is checked before git, docker or the disk is touched.
func TestBoxJobRefusesBadInputsBeforeAnySeam(t *testing.T) {
	cwd := `, "cwd": "` + bWorktree + `"`
	cases := []struct{ raw, want string }{
		{`{"job_id": "B0B0", "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + `, "argv": ["true"]` + cwd + `}`, "job id"},
		{`{"job_id": "` + bJob + `", "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + cwd + `}`, "argv"},
		{`{"job_id": "` + bJob + `", "change": "C0FFEE", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + `, "argv": ["true"]` + cwd + `}`, `change "C0FFEE"`},
		{`{"job_id": "` + bJob + `", "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + `, "argv": ["true"], "cwd": "/srv/repo"}`, `cwd "/srv/repo"`},
		{`{"job_id": "` + bJob + `", "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", "argv": ["true"]` + cwd + `}`, "limits"},
		{`{"job_id": "` + bJob + `", "change": "c0ffee", "checkout": "/srv/repo", "branch": "a..b", ` + bLimits + `, "argv": ["true"]` + cwd + `}`, `branch "a..b"`},
		{`{"job_id": "` + bJob + `", "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + `, "argv": ["true"], "env": {"A": 3}` + cwd + `}`, `env "A"`},
		{`{"job_id": "` + bJob + `", "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + `, "argv": ["true"], "env": {"1X": "v"}` + cwd + `}`, `"1X"`},
	}
	for _, c := range cases {
		s := warm()
		d := jobDeps(t)
		d.Box = boxDeps(s, "/nonexistent/docker").Box
		out := Dispatch(context.Background(), "job.start", wireArgs(t, c.raw), d)
		if out.OK || !strings.Contains(out.Error, c.want) || !strings.HasSuffix(out.Error, "nothing was started") {
			t.Errorf("%s: ok=%v err=%q, want a refusal naming %q", c.raw, out.OK, out.Error, c.want)
		}
		if len(s.calls) != 0 || out.Meta != nil {
			t.Errorf("%s: a refused job reached the seam: %v (meta %v)", c.raw, s.calls, out.Meta)
		}
		if dirs := jobDirs(t, d.Jobs.Store); len(dirs) != 0 {
			t.Errorf("%s: job dirs %v", c.raw, dirs)
		}
	}
}

// C2: suites that cannot be read, or a box that cannot start, start nothing.
func TestBoxJobThatCannotTellHeavyOrStartRunsNothing(t *testing.T) {
	for _, c := range []struct {
		name string
		s    *scripted
		want []string
	}{
		{"suites unreadable", &scripted{image: "sha256:1\n", failOn: "-C /srv/repo show trunk:"},
			[]string{"cannot tell whether this is a whole suite", "boom at -C /srv/repo show"}},
		{"suites empty", &scripted{image: "sha256:1\n", suites: noSuites},
			[]string{"cannot tell whether this is a whole suite", "lists no suites"}},
		{"image absent", &scripted{image: ""},
			[]string{"cannot start the box nova-box-c0ffee: ", "is not built"}},
	} {
		d := jobDeps(t)
		d.Box = boxDeps(c.s, "/nonexistent/docker").Box
		out := Dispatch(context.Background(), "job.start", boxJobArgs(t, `, "argv": ["true"], "cwd": "`+bWorktree+`"`), d)
		if out.OK || !strings.HasSuffix(out.Error, "nothing was started") {
			t.Errorf("%s: ok=%v err=%q", c.name, out.OK, out.Error)
		}
		for _, w := range c.want {
			if !strings.Contains(out.Error, w) {
				t.Errorf("%s: err %q lacks %q", c.name, out.Error, w)
			}
		}
		if dirs := jobDirs(t, d.Jobs.Store); len(dirs) != 0 {
			t.Errorf("%s: job dirs %v", c.name, dirs)
		}
		if c.s.find("exec") != nil {
			t.Errorf("%s: an exec ran: %v", c.name, c.s.calls)
		}
	}
}
