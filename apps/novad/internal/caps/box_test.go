package caps

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"novad/internal/box"
)

// box.* over a scripted Runner (S32.2 T5). Every value is a non-default —
// change c0ffee, checkout /srv/repo, branch trunk, limits 3/5/700/3, uid/gid
// 1234:5678 — so a hardcoded default cannot pass.

const (
	bHash     = "89abcdef0123456789abcdef0123456789abcdef"
	bTag      = box.ImagePrefix + bHash
	bChange   = "c0ffee"
	bCheckout = "/srv/repo"
	bWorktree = "/srv/repo/.worktrees/nova-c0ffee"
)

// scripted answers docker and git: rev-parse -> bHash, image ls -> image,
// ps -> ps; every other call (ls -q of a net/volume, create, run, start)
// answers "" with exit 0. failOn makes a call whose joined argv starts with
// it answer docker's refusal.
type scripted struct {
	image, ps string
	// suites is what `git show <branch>:deploy/devbox/suites.toml` answers
	// (T6); "" answers testSuites, noSuites answers an empty file.
	suites string
	failOn string
	// objs is what `network ls` / `volume ls` answer (T7: box.remove looks
	// each one up before removing it); "" says none exists.
	objs  string
	calls [][]string
}

func (s *scripted) Run(_ context.Context, argv []string) (string, int, error) {
	s.calls = append(s.calls, append([]string(nil), argv...))
	j := strings.Join(argv, " ")
	switch {
	case s.failOn != "" && strings.HasPrefix(j, s.failOn):
		return "Error response from daemon: boom at " + s.failOn + "\n", 1, nil
	case strings.Contains(j, "rev-parse"):
		return bHash + "\n", 0, nil
	case strings.Contains(j, " show "):
		switch s.suites {
		case "":
			return testSuites, 0, nil
		case noSuites:
			return "", 0, nil
		}
		return s.suites, 0, nil
	case strings.HasPrefix(j, "image ls"):
		return s.image, 0, nil
	case strings.HasPrefix(j, "ps "):
		return s.ps, 0, nil
	case strings.HasPrefix(j, "network ls") || strings.HasPrefix(j, "volume ls"):
		return s.objs, 0, nil
	}
	return "", 0, nil
}

// testSuites is the branch's suites.toml the scripted git answers: one suite
// in services/core, so `uv run pytest` there is heavy and anything else is not.
const testSuites = `
[[suite]]
name = "core"
dir = "services/core"
commands = [["uv", "run", "pytest"]]
`

const noSuites = "\x00none"

func (s *scripted) find(prefix string) []string {
	for _, c := range s.calls {
		if strings.HasPrefix(strings.Join(c, " "), prefix) {
			return c
		}
	}
	return nil
}

func boxDeps(s *scripted, dockerBin string) Deps {
	return Deps{Box: &box.Manager{Docker: s, Git: s, Now: func() time.Time { return time.Unix(1e9, 0) }, UID: 1234, GID: 5678, DockerBin: dockerBin}}
}

func warm() *scripted {
	return &scripted{image: "sha256:1\n", ps: "nova-box-c0ffee\trunning\t" + bTag + "\nnova-box-c0ffee-db\trunning\tpostgres\n"}
}

const bLimits = `"limits": {"cpus": 3, "memory_gb": 5, "pids": 700, "max_running": 3}`

func boxArgs(t *testing.T, extra string) map[string]any {
	t.Helper()
	return wireArgs(t, `{"change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", `+bLimits+extra+`}`)
}

func TestBoxCapsWithoutAManagerSayCannot(t *testing.T) {
	for _, name := range []string{"box.exec", "box.start", "box.status", "box.remove"} {
		out := Dispatch(context.Background(), name, boxArgs(t, `, "argv": ["true"], "cwd": "`+bWorktree+`"`), Deps{})
		if out.OK || out.Error != "cannot: no box manager on this agent" || out.Meta != nil {
			t.Errorf("%s: ok=%v err=%q meta=%v", name, out.OK, out.Error, out.Meta)
		}
	}
}

func TestBoxArgsAreRefusedNamingThemBeforeAnySeam(t *testing.T) {
	cwd := `, "cwd": "` + bWorktree + `"`
	cases := []struct {
		capability, raw, want string
	}{
		{"box.exec", `{"change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + cwd + `}`, "argv"},
		{"box.exec", `{"argv": [], "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + cwd + `}`, "argv"},
		{"box.exec", `{"argv": ["ls", 3], "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + cwd + `}`, "argv[1]"},
		{"box.exec", `{"argv": ["ls"], "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + cwd + `}`, "change"},
		{"box.exec", `{"argv": ["ls"], "change": "c0ffee", "branch": "trunk", ` + bLimits + cwd + `}`, "checkout"},
		{"box.exec", `{"argv": ["ls"], "change": "c0ffee", "checkout": "/srv/repo", ` + bLimits + cwd + `}`, "branch"},
		{"box.exec", `{"argv": ["ls"], "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + `}`, "cwd"},
		{"box.exec", `{"argv": ["ls"], "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk"` + cwd + `}`, "limits"},
		{"box.exec", `{"argv": ["ls"], "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", "limits": {"cpus": "3", "memory_gb": 5, "pids": 700, "max_running": 3}` + cwd + `}`, "limits.cpus"},
		{"box.exec", `{"argv": ["ls"], "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", "limits": {"cpus": 3, "memory_gb": 5.5, "pids": 700, "max_running": 3}` + cwd + `}`, "limits.memory_gb"},
		{"box.exec", `{"argv": ["ls"], "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", "limits": {"cpus": 3, "memory_gb": 5, "max_running": 3}` + cwd + `}`, "limits.pids"},
		{"box.exec", `{"argv": ["ls"], "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", "limits": {"cpus": 3, "memory_gb": 5, "pids": 700, "max_running": -1}` + cwd + `}`, "limits.max_running"},
		// Validate's refusals, through the handler.
		{"box.exec", `{"argv": ["ls"], "change": "C0FFEE", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + cwd + `}`, `change "C0FFEE"`},
		{"box.exec", `{"argv": ["ls"], "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + `, "cwd": "/srv/repo"}`, `cwd "/srv/repo"`},
		{"box.exec", `{"argv": ["ls"], "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", "limits": {"cpus": 17, "memory_gb": 5, "pids": 700, "max_running": 3}` + cwd + `}`, "cpus limit 17"},
		{"box.start", `{"checkout": "/srv/repo", "branch": "trunk", ` + bLimits + `}`, "change"},
		{"box.start", `{"change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", "limits": {"cpus": 3, "memory_gb": 5, "pids": 7, "max_running": 3}}`, "pids limit 7"},
		{"box.start", `{"change": "c0ffee", "checkout": "srv/repo", "branch": "trunk", ` + bLimits + `}`, `checkout "srv/repo"`},
	}
	for _, c := range cases {
		s := warm()
		out := Dispatch(context.Background(), c.capability, wireArgs(t, c.raw), boxDeps(s, "/nonexistent/docker"))
		if out.OK || !strings.Contains(out.Error, c.want) || !strings.HasPrefix(out.Error, c.capability) {
			t.Errorf("%s %s: ok=%v err=%q, want a refusal naming %q", c.capability, c.raw, out.OK, out.Error, c.want)
		}
		if len(s.calls) != 0 || out.Meta != nil {
			t.Errorf("%s: a refused call reached the seam: %v (meta %v)", c.capability, s.calls, out.Meta)
		}
	}
}

func TestBoxExecSaysTheBoxCannotStartAndRunsNothing(t *testing.T) {
	for _, c := range []struct {
		name string
		s    *scripted
		want string
	}{
		{"image absent", &scripted{image: ""}, "the box image nova-devbox:t-89abcdef0123 for trunk's deploy/devbox is not built"},
		{"docker refuses", &scripted{image: "sha256:1\n", failOn: "ps "}, "Error response from daemon: boom at ps"},
	} {
		out := Dispatch(context.Background(), "box.exec",
			boxArgs(t, `, "argv": ["true"], "cwd": "`+bWorktree+`"`), boxDeps(c.s, "/nonexistent/docker"))
		if out.OK || !strings.HasPrefix(out.Error, "cannot start the box nova-box-c0ffee: ") ||
			!strings.Contains(out.Error, c.want) || !strings.HasSuffix(out.Error, " — nothing was run") {
			t.Errorf("%s: ok=%v err=%q", c.name, out.OK, out.Error)
		}
		if out.Meta != nil || out.ExitCode != nil {
			t.Errorf("%s: nothing ran, yet meta=%v exit=%v", c.name, out.Meta, out.ExitCode)
		}
	}
}

func TestBoxStartEnsuresAColdBoxWithTheLimitsItWasSent(t *testing.T) {
	// Two other boxes running and max_running 3: the start goes ahead.
	s := &scripted{image: "sha256:1\n", ps: "nova-box-aaaaaa\trunning\tx\nnova-box-bbbbbb\trunning\tx\n"}
	out := Dispatch(context.Background(), "box.start", boxArgs(t, ""), boxDeps(s, "/nonexistent/docker"))
	if !out.OK {
		t.Fatalf("box.start: %q", out.Error)
	}
	run := s.find("run -d --name nova-box-c0ffee ")
	if run == nil {
		t.Fatalf("no box run in %v", s.calls)
	}
	want := box.BoxArgs(box.Request{Checkout: bCheckout, Change: bChange, Branch: "trunk", Cwd: bWorktree,
		Limits: box.Limits{CPUs: 3, MemoryGB: 5, Pids: 700, MaxRunning: 3}}, bTag, 1234, 5678)
	if !reflect.DeepEqual(run, want) {
		t.Fatalf("box run argv\n got %v\nwant %v", run, want)
	}
	if g := s.find("-C /srv/repo rev-parse trunk:deploy/devbox"); g == nil {
		t.Fatalf("the image tag was not read from trunk: %v", s.calls)
	}
	if s.find("exec") != nil {
		t.Fatalf("box.start ran an exec: %v", s.calls)
	}
	wantMeta := map[string]any{"box": "nova-box-c0ffee", "state": "running", "image": bTag}
	if !reflect.DeepEqual(out.Meta, wantMeta) {
		t.Fatalf("meta = %v, want %v", out.Meta, wantMeta)
	}
	for _, w := range []string{"nova-box-c0ffee", "running", bTag} {
		if !strings.Contains(out.Output, w) {
			t.Errorf("output %q does not name %q", out.Output, w)
		}
	}
}

func TestBoxStartPastMaxRunningIsTheManagersCannot(t *testing.T) {
	s := &scripted{image: "sha256:1\n", ps: "nova-box-aaaaaa\trunning\tx\nnova-box-bbbbbb\trunning\tx\n"}
	args := wireArgs(t, `{"change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", "limits": {"cpus": 3, "memory_gb": 5, "pids": 700, "max_running": 2}}`)
	out := Dispatch(context.Background(), "box.start", args, boxDeps(s, "/nonexistent/docker"))
	if out.OK || !strings.HasPrefix(out.Error, "cannot start the box nova-box-c0ffee: ") ||
		!strings.Contains(out.Error, "box.max_running is 2") || !strings.Contains(out.Error, "nova-box-aaaaaa") {
		t.Fatalf("ok=%v err=%q", out.OK, out.Error)
	}
	if out.Meta != nil {
		t.Fatalf("meta on a box that did not start: %v", out.Meta)
	}
}

func TestBoxStatusReadsEveryBox(t *testing.T) {
	s := &scripted{ps: "nova-box-c0ffee\trunning\t" + bTag + "\nnova-box-c0ffee-db\trunning\tpg\nnova-box-abc123\texited\t" + bTag + "\n"}
	out := Dispatch(context.Background(), "box.status", map[string]any{}, boxDeps(s, "/nonexistent/docker"))
	if !out.OK {
		t.Fatalf("box.status: %q", out.Error)
	}
	want := map[string]any{"boxes": map[string]string{"c0ffee": "running", "abc123": "stopped"}}
	if !reflect.DeepEqual(out.Meta, want) {
		t.Fatalf("meta = %#v, want %#v", out.Meta, want)
	}
	if !strings.Contains(out.Output, "nova-box-c0ffee running") || !strings.Contains(out.Output, "nova-box-abc123 stopped") {
		t.Fatalf("output %q", out.Output)
	}

	empty := Dispatch(context.Background(), "box.status", map[string]any{}, boxDeps(&scripted{}, ""))
	if !empty.OK || empty.Output != "no boxes" || !reflect.DeepEqual(empty.Meta, map[string]any{"boxes": map[string]string{}}) {
		t.Fatalf("no boxes: ok=%v out=%q meta=%#v", empty.OK, empty.Output, empty.Meta)
	}

	bad := Dispatch(context.Background(), "box.status", map[string]any{}, boxDeps(&scripted{failOn: "ps "}, ""))
	if bad.OK || !strings.HasPrefix(bad.Error, "cannot read the boxes: ") || !strings.Contains(bad.Error, "boom at ps") || bad.Meta != nil {
		t.Fatalf("a docker failure: ok=%v err=%q meta=%v", bad.OK, bad.Error, bad.Meta)
	}
}

// -- box.remove (S32.3 T7) ----------------------------------------------------
//
// A landing's close and close_change take a change's box down. Only the change
// id crosses the wire; Manager.Remove derives every name from it.

// C1
func TestBoxRemoveTakesDownEverythingTheChangeOwns(t *testing.T) {
	s := &scripted{
		ps: "nova-box-c0ffee\trunning\t" + bTag + "\nnova-box-c0ffee-db\trunning\tpg\n" +
			"nova-box-abc123\trunning\t" + bTag + "\nnova-box-abc123-db\trunning\tpg\n",
		objs: "f00d\n",
	}
	out := Dispatch(context.Background(), "box.remove", wireArgs(t, `{"change": "c0ffee"}`), boxDeps(s, "/nonexistent/docker"))
	if !out.OK {
		t.Fatalf("box.remove: %q", out.Error)
	}
	want := [][]string{
		{"ps", "-a", "--filter", "label=" + box.Label, "--format", "{{.Names}}\t{{.State}}\t{{.Image}}"},
		{"rm", "-f", "nova-box-c0ffee", "nova-box-c0ffee-db"},
		{"network", "ls", "-q", "--filter", "name=^nova-box-c0ffee-net$"},
		{"network", "rm", "nova-box-c0ffee-net"},
		{"volume", "ls", "-q", "--filter", "name=^nova-box-c0ffee-cache$"},
		{"volume", "rm", "nova-box-c0ffee-cache"},
	}
	if !reflect.DeepEqual(s.calls, want) {
		t.Fatalf("docker argv\n got %q\nwant %q", s.calls, want)
	}
	for _, c := range s.calls {
		if strings.Contains(strings.Join(c, " "), "abc123") {
			t.Fatalf("touched another change's box: %q", c)
		}
	}
	if !reflect.DeepEqual(out.Meta, map[string]any{"box": "nova-box-c0ffee", "removed": true}) {
		t.Fatalf("meta = %#v", out.Meta)
	}
	for _, w := range []string{"nova-box-c0ffee removed", "database", "network", "cache"} {
		if !strings.Contains(out.Output, w) {
			t.Errorf("output %q does not name %q", out.Output, w)
		}
	}
	if out.ExitCode == nil || *out.ExitCode != 0 {
		t.Errorf("exit = %v, want 0", out.ExitCode)
	}
}

// C2
func TestBoxRemoveRefusesABadChangeBeforeDocker(t *testing.T) {
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
		out := Dispatch(context.Background(), "box.remove", wireArgs(t, c.raw), boxDeps(s, "/nonexistent/docker"))
		if out.OK || !strings.HasPrefix(out.Error, "box.remove") || !strings.Contains(out.Error, c.want) {
			t.Errorf("%s: ok=%v err=%q, want a refusal naming %s", c.raw, out.OK, out.Error, c.want)
		}
		if len(s.calls) != 0 || out.Meta != nil {
			t.Errorf("%s: a refused call reached docker: %q (meta %v)", c.raw, s.calls, out.Meta)
		}
	}
}

// C3
func TestBoxRemoveStatesADockerFailure(t *testing.T) {
	for _, failOn := range []string{"ps ", "rm -f", "network rm", "volume ls"} {
		s := &scripted{ps: "nova-box-c0ffee\texited\t" + bTag + "\n", objs: "f00d\n", failOn: failOn}
		out := Dispatch(context.Background(), "box.remove", wireArgs(t, `{"change": "c0ffee"}`), boxDeps(s, ""))
		if out.OK || !strings.HasPrefix(out.Error, "cannot remove the box nova-box-c0ffee: ") ||
			!strings.Contains(out.Error, "boom at "+strings.TrimSpace(failOn)) {
			t.Errorf("fail on %q: ok=%v err=%q", failOn, out.OK, out.Error)
		}
		if out.Meta != nil {
			t.Errorf("fail on %q: meta %v on a box that was not removed", failOn, out.Meta)
		}
	}
}

// C3
func TestBoxRemoveOfABoxAlreadyGoneIsFine(t *testing.T) {
	s := &scripted{ps: "nova-box-abc123\trunning\t" + bTag + "\n"}
	out := Dispatch(context.Background(), "box.remove", wireArgs(t, `{"change": "c0ffee"}`), boxDeps(s, ""))
	if !out.OK || !reflect.DeepEqual(out.Meta, map[string]any{"box": "nova-box-c0ffee", "removed": true}) {
		t.Fatalf("ok=%v err=%q meta=%v", out.OK, out.Error, out.Meta)
	}
	for _, c := range s.calls {
		if c[0] == "rm" || (len(c) > 1 && c[1] == "rm") {
			t.Fatalf("removed something that was not there: %q", c)
		}
	}
}
