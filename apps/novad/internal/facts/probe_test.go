package facts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"novad/internal/platform"
	"novad/internal/service"
)

func withDistros(t *testing.T, list []platform.WSLDistro) {
	t.Helper()
	withRegistry(t, list, nil)
}

// withRegistry hands in WSL's registry list and the entries of it that
// could not be read.
func withRegistry(t *testing.T, list []platform.WSLDistro, bad []error) {
	t.Helper()
	old := readDistros
	readDistros = func() ([]platform.WSLDistro, []error, error) { return list, bad, nil }
	t.Cleanup(func() { readDistros = old })
}

const lookOut = "pid1=systemd\nuser=sam\nsudo=refused\nunit.ActiveState=active\nunit.UnitFileState=enabled\n" +
	"unit.MainPID=412\nunit.Restart=always\npids=412\n"

// P29, Review Focus 11: a stopped distribution is listed and never looked
// inside — looking would start it. A running one gets one look and the root
// check, nothing else.
func TestTheWSLProbeLooksOnlyInsideRunningDistros(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2, Default: true}, {Name: "docker-desktop", Version: 2}})
	// Fix round 1, Minor 2: the running-list runs again just before the look.
	r := &platform.FakeRunner{Seq: map[string][]string{"wsl.exe": {"Ubuntu-26.04\r\n", "Ubuntu-26.04\r\n", lookOut, ""}}}
	got, unread := probeWSL(context.Background(), r)
	if len(unread) != 0 {
		t.Fatalf("unreadable: %+v", unread)
	}
	want := &WSLDistros{Distros: []Distro{
		{Name: "Ubuntu-26.04", Default: true, Version: 2, Running: true, Looked: true, PID1: "systemd", User: "sam",
			Sudo: "refused", Root: true, Unit: &Unit{Active: "active", File: "enabled", Restart: "always", MainPID: 412},
			PIDs: []int{412}},
		{Name: "docker-desktop", Version: 2, PIDs: []int{}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
	wantCalls := [][]string{
		{"--list", "--running", "--quiet"},
		{"--list", "--running", "--quiet"},
		{"-d", "Ubuntu-26.04", "--exec", "/bin/sh", "-c", platform.WSLLookScript},
		{"-d", "Ubuntu-26.04", "-u", "root", "--exec", "/bin/true"},
	}
	if len(r.Calls) != len(wantCalls) {
		t.Fatalf("calls = %+v", r.Calls)
	}
	for i, c := range r.Calls {
		if c.Name != "wsl.exe" || !reflect.DeepEqual(c.Args, wantCalls[i]) || slices.Contains(c.Args, "docker-desktop") {
			t.Fatalf("call %d = %s %v", i, c.Name, c.Args)
		}
	}
}

// A running-list that failed is said in wsl.exe's words, and nothing is
// looked inside on a guess.
func TestAFailedRunningListLooksInsideNothingAndSaysSo(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2, Default: true}})
	r := &platform.FakeRunner{Errs: map[string]error{
		"wsl.exe": errors.New("wsl.exe: exit status 4294967295: The Windows Subsystem for Linux is not enabled."),
	}}
	got, _ := probeWSL(context.Background(), r)
	d := got.Distros[0]
	if d.Running || d.Looked || !strings.Contains(got.RunningSaid, "is not enabled") || len(r.Calls) != 1 {
		t.Fatalf("got %+v (running_said %q), calls %d", d, got.RunningSaid, len(r.Calls))
	}
}

// No distribution for this account is an observation — an empty list, never
// "unreadable", and no wsl.exe at all.
func TestNoDistributionIsAnEmptyList(t *testing.T) {
	withDistros(t, nil)
	r := &platform.FakeRunner{}
	got, unread := probeWSL(context.Background(), r)
	if got == nil || got.Distros == nil || len(got.Distros) != 0 || len(unread) != 0 || len(r.Calls) != 0 {
		t.Fatalf("got %+v, %+v, calls %v", got, unread, r.Calls)
	}
}

// P29: how THIS agent runs, read from its own mode, files and process.
func TestServiceSaysHowThisAgentRuns(t *testing.T) {
	t.Setenv(platform.SupervisorEnv, "4242")
	bin := filepath.Join(t.TempDir(), "novad.exe")
	s := serviceOf(service.ModeRunKey, Self{Binary: bin, Config: filepath.Join("cfg", "config.json")})
	want := `HKCU\` + service.RunKeyPath + `\` + service.RunKeyValue
	if s.Name != want || s.Process != "novad.exe" || s.Binary != bin || s.PID != os.Getpid() ||
		s.SupervisorPID != 4242 || s.User == "" {
		t.Fatalf("got %+v", s)
	}
	t.Setenv(platform.SupervisorEnv, "")
	if got := serviceOf("foreground", Self{Binary: bin}); got.Name != "" || got.SupervisorPID != 0 {
		t.Fatalf("a hand-started agent has no service and no supervisor: %+v", got)
	}
}

// The frame carries the last probe with its time; a frame with no probe
// says nothing about one.
func TestAProbeIsCarriedInTheFrameWithItsTime(t *testing.T) {
	at := time.Date(2026, 9, 28, 17, 40, 0, 0, time.UTC)
	p := Probed{At: at, Service: Service{Name: service.UnitName}, Unreadable: []Unreadable{{Item: "elevation", Reason: "x"}}}
	f := Frame{Type: "facts"}
	p.ApplyTo(&f)
	if f.Service == nil || f.Service.Name != service.UnitName || f.ProbedAt != "2026-09-28T17:40:00Z" || len(f.Unreadable) != 1 {
		t.Fatalf("got %+v", f)
	}
	data, _ := json.Marshal(Frame{Type: "facts"})
	if strings.Contains(string(data), "service") || strings.Contains(string(data), "probed_at") {
		t.Fatalf("a frame with no probe says nothing about one: %s", data)
	}
}

// fix/facts-unreadable-null: encoding/json writes a nil slice as null, and
// core refused a facts frame whose unreadable was null — every frame a
// healthy agent sent once its probe had run. ApplyTo leaves no list nil:
// unreadable, and the distributions it copies in, whatever it was handed —
// without changing the probe, which every later frame carries too.
func TestApplyToNeverLeavesANilList(t *testing.T) {
	p := Probed{At: time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC), WSL: &WSLDistros{}}
	f := Frame{Type: "facts"}
	p.ApplyTo(&f)
	data, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	if f.Unreadable == nil || f.WSLDistros == nil || f.WSLDistros.Distros == nil ||
		!strings.Contains(string(data), `"unreadable":[]`) || !strings.Contains(string(data), `"distros":[]`) {
		t.Fatalf("ApplyTo left a list nil, so null on the wire: %s", data)
	}
	if p.WSL.Distros != nil {
		t.Fatal("ApplyTo changed the probe it was handed")
	}
}

// script answers each call in turn with an output AND an error when told —
// what FakeRunner does not: a program that printed something, then failed.
// An answer with a hold waits for it to close first, deaf to ctx: a child
// the agent cannot kill.
type script struct {
	mu      sync.Mutex
	answers []answer
	calls   []platform.FakeCall
}

type answer struct {
	out  string
	err  error
	hold chan struct{}
}

func (s *script) Run(ctx context.Context, name string, args []string, stdin string) (string, error) {
	return s.RunEnv(ctx, nil, name, args, stdin)
}

func (s *script) RunEnv(_ context.Context, env []string, name string, args []string, _ string) (string, error) {
	s.mu.Lock()
	s.calls = append(s.calls, platform.FakeCall{Name: name, Args: args, Env: env})
	if len(s.answers) == 0 {
		s.mu.Unlock()
		return "", errors.New("nothing scripted for " + name)
	}
	a := s.answers[0]
	s.answers = s.answers[1:]
	s.mu.Unlock()
	if a.hold != nil {
		<-a.hold
	}
	return a.out, a.err
}

func (s *script) recorded() []platform.FakeCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]platform.FakeCall(nil), s.calls...)
}

// asUTF16 is s as a wsl.exe that ignored WSL_UTF8 writes it: UTF-16LE.
func asUTF16(s string) string {
	var b strings.Builder
	for _, r := range s { // ASCII only here, which is all these tests write
		b.WriteByte(byte(r))
		b.WriteByte(0)
	}
	return b.String()
}

// returnsWithin fails the test unless call returns within d: a program waited
// on past its bound would otherwise hang the suite until go test's timeout.
func returnsWithin(t *testing.T, d time.Duration, call func()) {
	t.Helper()
	done := make(chan struct{})
	go func() { defer close(done); call() }()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatalf("still waiting after %s: a program was waited on past its bound", d)
	}
}

// oneLine fails unless s could sit inside one listing line core renders: no
// character core refuses in a line (isControl, core's LINE_BREAKS) — core
// refuses one, and drops the whole frame.
func oneLine(t *testing.T, what, s string) {
	t.Helper()
	if strings.ContainsFunc(s, isControl) {
		t.Fatalf("%s %q is not one clean line", what, s)
	}
}

// F3: every wsl.exe the probe runs is asked for UTF-8.
func TestEveryWSLExeTheProbeRunsAsksForUTF8(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2, Default: true}})
	r := &platform.FakeRunner{Seq: map[string][]string{"wsl.exe": {"Ubuntu-26.04\r\n", "Ubuntu-26.04\r\n", lookOut, ""}}}
	probeWSL(context.Background(), r)
	if len(r.Calls) != 4 {
		t.Fatalf("calls = %+v", r.Calls)
	}
	for _, c := range r.Calls {
		if !reflect.DeepEqual(c.Env, []string{"WSL_UTF8=1"}) {
			t.Fatalf("%v ran without WSL_UTF8=1: env %v", c.Args, c.Env)
		}
	}
}

// F3: whatever wsl.exe wrote — UTF-16 because WSL_UTF8 did not take, several
// lines, a bare carriage return, a stray control character — what the frame
// says is its FIRST line, as one clean line.
func TestWhatWSLExeSaidIsOneCleanLine(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"UTF-16 on stderr after Exec's prefix", &platform.RunError{Name: "wsl.exe", Err: errors.New("exit status 4294967295"),
			Stderr: asUTF16("The Windows Subsystem for Linux is not enabled.\r\nError code: Wsl/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED\r\n")},
			"wsl.exe: exit status 4294967295: The Windows Subsystem for Linux is not enabled."},
		{"several lines", errors.New("wsl.exe: exit status 1: There is no distribution with the supplied name.\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\n"),
			"wsl.exe: exit status 1: There is no distribution with the supplied name."},
		{"a bare carriage return", errors.New("wsl.exe: exit status 1: first\rsecond"), "wsl.exe: exit status 1: first"},
		{"control characters inside the line", errors.New("wsl.exe:\texit status 1:\x1b[0m\x07 stopped"),
			"wsl.exe: exit status 1: [0m stopped"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
			got, _ := probeWSL(context.Background(), &platform.FakeRunner{Errs: map[string]error{"wsl.exe": c.err}})
			oneLine(t, "running_said", got.RunningSaid)
			if got.RunningSaid != c.want {
				t.Fatalf("running_said = %q, want %q", got.RunningSaid, c.want)
			}

			// The same words when the look inside a running distribution fails.
			s := &script{answers: []answer{{out: "Ubuntu-26.04\n"}, {out: "Ubuntu-26.04\n"}, {err: c.err}}}
			got, unread := probeWSL(context.Background(), s)
			if len(unread) != 1 || unread[0].Item != "wsl_distros.Ubuntu-26.04" || unread[0].Reason != c.want {
				t.Fatalf("unreadable = %+v, want the reason %q", unread, c.want)
			}
			if d := got.Distros[0]; !d.Running || d.Looked || d.Root || len(s.calls) != 3 {
				t.Fatalf("got %+v after %d calls — a look that failed is not looked, and no root check follows", d, len(s.calls))
			}
		})
	}
}

// A look that printed part of its answer and then failed — stopped at its
// bound while systemctl waited on a bus, say — is unreadable: what it did
// not print is never read as "no unit" or "no novad process".
func TestALookCutShortIsUnreadableNeverNoAgent(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
	s := &script{answers: []answer{
		{out: "Ubuntu-26.04\n"}, {out: "Ubuntu-26.04\n"},
		{out: "pid1=systemd\nuser=sam\nsudo=refused\n", err: errors.New("wsl.exe: exit status 1")},
	}}
	got, unread := probeWSL(context.Background(), s)
	if d := got.Distros[0]; d.Looked || d.Unit != nil || len(unread) != 1 || unread[0].Reason != "wsl.exe: exit status 1" {
		t.Fatalf("got %+v, unreadable %+v", d, unread)
	}
	// Fix round 1, I2: the same when wsl.exe exits 0 — a look that never
	// printed its last line did not look, whatever the exit status said.
	s = &script{answers: []answer{
		{out: "Ubuntu-26.04\n"}, {out: "Ubuntu-26.04\n"},
		{out: "pid1=systemd\nuser=sam\nsudo=refused\nunit.ActiveState=inactive\n"},
	}}
	got, unread = probeWSL(context.Background(), s)
	if d := got.Distros[0]; d.Looked || d.Unit != nil || len(unread) != 1 || unread[0].Reason != "the look printed no answer" {
		t.Fatalf("an exit 0 without the last line: got %+v, unreadable %+v", d, unread)
	}
	// A look that finished is read even though wsl.exe then failed.
	s = &script{answers: []answer{{out: "Ubuntu-26.04\n"}, {out: "Ubuntu-26.04\n"}, {out: lookOut, err: errors.New("wsl.exe: exit status 1")}, {}}}
	got, unread = probeWSL(context.Background(), s)
	if d := got.Distros[0]; !d.Looked || d.Unit == nil || !reflect.DeepEqual(d.PIDs, []int{412}) || len(unread) != 0 {
		t.Fatalf("got %+v, unreadable %+v", d, unread)
	}
}

// Fix round 1, I1: a wsl.exe that ignores its kill is left at its bound —
// the probe returns then and says so, and the frame never says it stopped.
// On Windows a killed program exits 1, which must not read as wsl.exe's own
// failure either.
func TestAWSLExeThatOutlivesItsBoundIsSaidToHaveGivenNoAnswer(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
	hold := make(chan struct{})
	t.Cleanup(func() { close(hold) })
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	var got *WSLDistros
	returnsWithin(t, 2*time.Second, func() { got, _ = probeWSL(ctx, &platform.FakeRunner{Hold: hold}) })
	if got.RunningSaid != "wsl.exe: gave no answer in time" || !got.outOfTime {
		t.Fatalf("running_said = %q, out of time %v", got.RunningSaid, got.outOfTime)
	}

	// The look itself, stopped at its bound, the same.
	h := make(chan struct{})
	t.Cleanup(func() { close(h) })
	ctx, cancel = context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	s := &script{answers: []answer{{out: "Ubuntu-26.04\n"}, {out: "Ubuntu-26.04\n"}, {hold: h}}}
	var unread []Unreadable
	returnsWithin(t, 2*time.Second, func() { got, unread = probeWSL(ctx, s) })
	if d := got.Distros[0]; d.Looked || !got.outOfTime || len(unread) != 1 || unread[0].Reason != "wsl.exe: gave no answer in time" {
		t.Fatalf("got %+v, unreadable %+v", d, unread)
	}

	// Killed at its bound: it answers — failing, exit 1 as on Windows — the
	// moment the bound passes. That is no answer, never wsl.exe's failure.
	ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	got, _ = probeWSL(ctx, killedAtItsBound{})
	if got.RunningSaid != "wsl.exe: gave no answer in time" || !got.outOfTime {
		t.Fatalf("running_said = %q — a program killed at its bound read as its own failure", got.RunningSaid)
	}
}

// killedAtItsBound is a program the kill at its bound does stop: it fails,
// exit 1 as a killed program does on Windows, when its ctx ends.
type killedAtItsBound struct{}

func (k killedAtItsBound) Run(ctx context.Context, name string, args []string, stdin string) (string, error) {
	return k.RunEnv(ctx, nil, name, args, stdin)
}

func (killedAtItsBound) RunEnv(ctx context.Context, _ []string, name string, _ []string, _ string) (string, error) {
	<-ctx.Done()
	return "", errors.New(name + ": exit status 1")
}

// Fix round 1, Minor 4: a wsl.exe that never started says so — never that
// it gave no answer, or was stopped.
func TestAWSLExeThatNeverStartedSaysSo(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &platform.FakeRunner{}
	got, _ := probeWSL(ctx, r)
	if got.RunningSaid != "wsl.exe did not start: had no time left to start" || len(r.Calls) != 0 {
		t.Fatalf("running_said = %q after %d calls", got.RunningSaid, len(r.Calls))
	}
	notFound := &platform.RunError{Name: "wsl.exe", Err: &exec.Error{Name: "wsl.exe", Err: exec.ErrNotFound}, NotStarted: true}
	got, _ = probeWSL(context.Background(), &platform.FakeRunner{Errs: map[string]error{"wsl.exe": notFound}})
	if want := "wsl.exe did not start: " + notFound.Err.Error(); got.RunningSaid != want {
		t.Fatalf("running_said = %q, want %q", got.RunningSaid, want)
	}
}

// A running-list that failed is never read for what runs, even when it
// printed names: a wrong guess would look inside — and so start — a stopped
// distribution.
func TestAFailedRunningListIsNeverReadForWhatRuns(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
	s := &script{answers: []answer{{out: "Ubuntu-26.04\n", err: errors.New("wsl.exe: exit status 1: partial")}}}
	got, _ := probeWSL(context.Background(), s)
	if d := got.Distros[0]; d.Running || d.Looked || len(s.calls) != 1 {
		t.Fatalf("got %+v after %d calls", d, len(s.calls))
	}
}

// Nothing the look found reaches the frame in a shape core would refuse —
// one refused field drops the whole frame: at most eight pids (the rest said
// so), a sudo word core knows, a WSL version of 1 or 2, pids that fit.
func TestTheProbeSendsNothingCoreWouldRefuse(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 3}})
	look := "pid1=systemd\x1b\nuser=sam\tx\nsudo=maybe\nunit.ActiveState=active\nunit.UnitFileState=enabled\n" +
		"unit.MainPID=99999999999\nunit.Restart=always\npids=1 2 3 4 5 6 7 8 9 10\n"
	got, unread := probeWSL(context.Background(), &platform.FakeRunner{Seq: map[string][]string{"wsl.exe": {"Ubuntu-26.04\n", "Ubuntu-26.04\n", look, ""}}})
	d := got.Distros[0]
	if d.Version != 0 || d.Sudo != "" || d.Unit == nil || d.Unit.MainPID != 0 || len(d.PIDs) != 8 {
		t.Fatalf("got %+v", d)
	}
	oneLine(t, "pid1", d.PID1)
	oneLine(t, "user", d.User)
	if len(unread) != 1 || unread[0].Item != "wsl_distros.Ubuntu-26.04.novad_pids" || !strings.Contains(unread[0].Reason, "more than 8") {
		t.Fatalf("unreadable = %+v — the pids past the eighth are said, never cut silently", unread)
	}
}

// Task 7's ruling holds for the agent's own files: a path that does not fit
// one line of core's cap is left out and said, never clipped or collapsed
// into a path that is not the file.
func TestAPathThatDoesNotFitIsLeftOutNeverMadeIntoAnother(t *testing.T) {
	withDistros(t, nil)
	long := filepath.Join(t.TempDir(), strings.Repeat("n", 300), "novad")
	p := Probe(context.Background(), &platform.FakeRunner{Outputs: map[string]string{"sudo": ""}},
		Self{Binary: long, Config: filepath.Join("cfg", "con\nfig.json")})
	if p.Service.Binary != "" || p.Service.Config != "" || p.Service.Process != "novad" {
		t.Fatalf("got %+v", p.Service)
	}
	items := map[string]string{}
	for _, u := range p.Unreadable {
		items[u.Item] = u.Reason
	}
	if !strings.Contains(items["service.binary"], "over the 255") || !strings.Contains(items["service.config"], "control character") {
		t.Fatalf("unreadable = %+v", p.Unreadable)
	}
}

// Fix round 1, Minor 2 (Review Focus 11): what runs is listed again just
// before each look, so a distribution that stopped since the first list is
// never started by looking. A list that fails then is said, and nothing is
// looked inside on a guess.
func TestTheLookRunsOnlyIfTheDistroStillRunsJustBeforeIt(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
	s := &script{answers: []answer{{out: "Ubuntu-26.04\n"}, {out: ""}}}
	got, unread := probeWSL(context.Background(), s)
	if d := got.Distros[0]; d.Running || d.Looked || len(unread) != 0 || len(s.recorded()) != 2 {
		t.Fatalf("got %+v, unreadable %+v, calls %v — it stopped: never looked inside", d, unread, s.recorded())
	}
	s = &script{answers: []answer{{out: "Ubuntu-26.04\n"}, {err: errors.New("wsl.exe: exit status 1: busy")}}}
	got, unread = probeWSL(context.Background(), s)
	d := got.Distros[0]
	if !d.Running || d.Looked || len(s.recorded()) != 2 || len(unread) != 1 ||
		unread[0].Reason != "not looked inside: the running-list just before the look failed: wsl.exe: exit status 1: busy" {
		t.Fatalf("got %+v, unreadable %+v", d, unread)
	}
}

// Fix round 1, Minor 1: a root check that failed keeps wsl.exe's words.
func TestTheRootCheckKeepsItsReason(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
	s := &script{answers: []answer{{out: "Ubuntu-26.04\n"}, {out: "Ubuntu-26.04\n"}, {out: lookOut},
		{err: errors.New("wsl.exe: exit status 1: <3>WSL: the user root is not allowed here\nmore")}}}
	got, unread := probeWSL(context.Background(), s)
	if d := got.Distros[0]; !d.Looked || d.Root || len(unread) != 1 || unread[0].Item != "wsl_distros.Ubuntu-26.04.root" ||
		unread[0].Reason != "wsl.exe: exit status 1: <3>WSL: the user root is not allowed here" {
		t.Fatalf("got %+v, unreadable %+v", d, unread)
	}
}

// Fix round 1, Minor 6: a refusing sudo's first line is carried, and pids
// the look could not list are unknown — null on the wire and said — never
// "no novad process".
func TestSudosWordsAreKeptAndUnknownPIDsAreNeverNone(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
	look := "pid1=systemd\nuser=sam\nsudo=refused\nsudo.said=sudo: a password is required\n" +
		"unit.ActiveState=active\nunit.UnitFileState=enabled\nunit.MainPID=412\nunit.Restart=always\npids=?\n"
	got, unread := probeWSL(context.Background(), &platform.FakeRunner{Seq: map[string][]string{
		"wsl.exe": {"Ubuntu-26.04\n", "Ubuntu-26.04\n", look, ""}}})
	d := got.Distros[0]
	if d.SudoSaid != "sudo: a password is required" || d.PIDs != nil || len(unread) != 1 ||
		unread[0].Item != "wsl_distros.Ubuntu-26.04.novad_pids" || !strings.Contains(unread[0].Reason, "could not be listed") {
		t.Fatalf("got %+v, unreadable %+v", d, unread)
	}
	data, _ := json.Marshal(d)
	if !strings.Contains(string(data), `"novad_pids":null`) || !strings.Contains(string(data), `"sudo_said":"sudo: a password is required"`) {
		t.Fatalf("on the wire: %s", data)
	}
	// None found is an empty list, and a sudo that asked nothing has no words.
	got, _ = probeWSL(context.Background(), &platform.FakeRunner{Seq: map[string][]string{
		"wsl.exe": {"Ubuntu-26.04\n", "Ubuntu-26.04\n", strings.Replace(lookOut, "pids=412", "pids=", 1), ""}}})
	if d := got.Distros[0]; d.PIDs == nil || len(d.PIDs) != 0 || d.SudoSaid != "" {
		t.Fatalf("got %+v", d)
	}
}

// Fix round 1, Minor 5: an entry of WSL's list that could not be read is
// said, never skipped silently.
func TestADistroEntryThatCannotBeReadIsSaid(t *testing.T) {
	withRegistry(t, nil, []error{errors.New(`opening HKCU\...\Lxss\{0000}: Access is denied.`)})
	got, unread := probeWSL(context.Background(), &platform.FakeRunner{})
	if got == nil || len(got.Distros) != 0 || len(unread) != 1 || unread[0].Item != "wsl_distros" ||
		!strings.Contains(unread[0].Reason, "Access is denied.") {
		t.Fatalf("got %+v, unreadable %+v", got, unread)
	}
}

// Fix round 1, Minor 7: the look asks after the unit the service package
// installs — a rename there cannot leave the look asking after another.
func TestTheLookAsksAfterTheUnitTheServiceInstalls(t *testing.T) {
	ask := "systemctl --user show -p ActiveState -p UnitFileState -p MainPID -p Restart " + service.UnitName + " "
	if !strings.Contains(platform.WSLLookScript, ask) || strings.Count(platform.WSLLookScript, ".service") != 1 {
		t.Fatalf("the look does not ask after %s alone:\n%s", service.UnitName, platform.WSLLookScript)
	}
}

// Fix round 1, I1: a probe whose program ignores its kill — sudo on Linux
// and macOS, wsl.exe on Windows — returns at its bound, says so, and is
// out of time, so a reconnect probes again rather than keep it.
func TestAProbeWhoseProgramIgnoresTheKillReturnsAtItsBound(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
	hold := make(chan struct{})
	t.Cleanup(func() { close(hold) })
	r := &platform.FakeRunner{Hold: hold}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	bin := filepath.Join(t.TempDir(), "novad")
	var p Probed
	returnsWithin(t, 2*time.Second, func() { p = Probe(ctx, r, Self{Binary: bin}) })
	said := fmt.Sprint(p.Unreadable)
	if p.WSL != nil {
		said += p.WSL.RunningSaid
	}
	if !p.OutOfTime || !strings.Contains(said, "gave no answer in time") || len(r.Recorded()) == 0 {
		t.Fatalf("out of time %v, said %q, calls %v", p.OutOfTime, said, r.Recorded())
	}
}

// Fix round 2: a wsl.exe that exited 0 while a descendant held its output
// (exec.ErrWaitDelay) answered — its list is read, its look is looked at, its
// root check ran — never "the list failed" or root:false.
func TestAWSLExeThatExitedZeroWhileItsOutputWasHeldAnswered(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
	held := &platform.RunError{Name: "wsl.exe", Err: exec.ErrWaitDelay}
	s := &script{answers: []answer{
		{out: "Ubuntu-26.04\n", err: held}, {out: "Ubuntu-26.04\n", err: held}, {out: lookOut, err: held}, {err: held},
	}}
	got, unread := probeWSL(context.Background(), s)
	if d := got.Distros[0]; got.RunningSaid != "" || !d.Running || !d.Looked || !d.Root || len(unread) != 0 {
		t.Fatalf("got %+v (running_said %q), unreadable %+v", d, got.RunningSaid, unread)
	}
}

// Fix round 2: novad_pids is [] only when none is known to run — the
// distribution is stopped, or a finished look found none. Whenever the list,
// the list before the look, or the look failed, it is null: unknown, never
// "no novad process".
func TestNovadPIDsAreUnknownUnlessKnownToBeNone(t *testing.T) {
	failed := errors.New("wsl.exe: exit status 1: busy")
	cases := []struct {
		name    string
		answers []answer
		want    []int
	}{
		{"the list failed", []answer{{err: failed}}, nil},
		{"the list before the look failed", []answer{{out: "Ubuntu-26.04\n"}, {err: failed}}, nil},
		{"the look failed", []answer{{out: "Ubuntu-26.04\n"}, {out: "Ubuntu-26.04\n"}, {err: failed}}, nil},
		{"the look ended early", []answer{{out: "Ubuntu-26.04\n"}, {out: "Ubuntu-26.04\n"}, {out: "pid1=systemd\n"}}, nil},
		{"stopped", []answer{{out: ""}}, []int{}},
		{"stopped since the list", []answer{{out: "Ubuntu-26.04\n"}, {out: ""}}, []int{}},
		{"a finished look found none", []answer{{out: "Ubuntu-26.04\n"}, {out: "Ubuntu-26.04\n"},
			{out: strings.Replace(lookOut, "pids=412", "pids=", 1)}, {}}, []int{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
			got, _ := probeWSL(context.Background(), &script{answers: c.answers})
			d := got.Distros[0]
			if (d.PIDs == nil) != (c.want == nil) || len(d.PIDs) != len(c.want) {
				t.Fatalf("novad_pids = %#v, want %#v", d.PIDs, c.want)
			}
			data, _ := json.Marshal(d)
			if wire := `"novad_pids":null`; (c.want == nil) != strings.Contains(string(data), wire) {
				t.Fatalf("on the wire: %s", data)
			}
		})
	}
}

// Fix round 2: a sudo that gave no answer, or never started, leaves what the
// agent knows in the frame — elevated is its own geteuid read — and says
// sudo is unknown, with the reason; it is never dropped whole.
func TestASudoWithNoAnswerKeepsWhatTheAgentKnows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows reads its own token and registry; no program answers for sudo there")
	}
	hold := make(chan struct{})
	t.Cleanup(func() { close(hold) })
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	var p Probed
	returnsWithin(t, 2*time.Second, func() { p = Probe(ctx, &platform.FakeRunner{Hold: hold}, Self{}) })
	e := p.Elevation
	if e == nil || e.Elevated != (os.Geteuid() == 0) || e.Admin != nil || e.Sudo != "unknown" ||
		e.SudoSaid != "sudo: gave no answer in time" || !p.OutOfTime || len(p.Unreadable) != 1 {
		t.Fatalf("elevation %+v, unreadable %+v", e, p.Unreadable)
	}
	ctx, cancel = context.WithCancel(context.Background())
	cancel()
	p = Probe(ctx, &platform.FakeRunner{}, Self{})
	if e := p.Elevation; e == nil || e.Sudo != "unknown" || e.SudoSaid != "sudo did not start: had no time left to start" {
		t.Fatalf("elevation %+v", e)
	}
	// A sudo that answered is said as it answered.
	p = Probe(context.Background(), &platform.FakeRunner{Outputs: map[string]string{"sudo": ""}}, Self{})
	if e := p.Elevation; e == nil || e.Sudo != "no_password" || e.SudoSaid != "" || len(p.Unreadable) != 0 {
		t.Fatalf("elevation %+v, unreadable %+v", e, p.Unreadable)
	}
}
