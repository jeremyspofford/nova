package facts

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"novad/internal/platform"
	"novad/internal/service"
)

func withDistros(t *testing.T, list []platform.WSLDistro) {
	t.Helper()
	old := readDistros
	readDistros = func() ([]platform.WSLDistro, error) { return list, nil }
	t.Cleanup(func() { readDistros = old })
}

const lookOut = "pid1=systemd\nuser=sam\nsudo=refused\nunit.ActiveState=active\nunit.UnitFileState=enabled\n" +
	"unit.MainPID=412\nunit.Restart=always\npids=412\n"

// P29, Review Focus 11: a stopped distribution is listed and never looked
// inside — looking would start it. A running one gets one look and the root
// check, nothing else.
func TestTheWSLProbeLooksOnlyInsideRunningDistros(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2, Default: true}, {Name: "docker-desktop", Version: 2}})
	r := &platform.FakeRunner{Seq: map[string][]string{"wsl.exe": {"Ubuntu-26.04\r\n", lookOut, ""}}}
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

// script answers each call in turn with an output AND an error when told —
// what FakeRunner does not: a program that printed something, then failed.
type script struct {
	answers []answer
	calls   []platform.FakeCall
}

type answer struct {
	out string
	err error
}

func (s *script) Run(ctx context.Context, name string, args []string, stdin string) (string, error) {
	return s.RunEnv(ctx, nil, name, args, stdin)
}

func (s *script) RunEnv(_ context.Context, env []string, name string, args []string, _ string) (string, error) {
	s.calls = append(s.calls, platform.FakeCall{Name: name, Args: args, Env: env})
	if len(s.answers) == 0 {
		return "", errors.New("nothing scripted for " + name)
	}
	a := s.answers[0]
	s.answers = s.answers[1:]
	return a.out, a.err
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

// oneLine fails unless s could sit inside one listing line core renders:
// no control character — core refuses one, and drops the whole frame.
func oneLine(t *testing.T, what, s string) {
	t.Helper()
	if strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		t.Fatalf("%s %q is not one clean line", what, s)
	}
}

// F3: every wsl.exe the probe runs is asked for UTF-8.
func TestEveryWSLExeTheProbeRunsAsksForUTF8(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2, Default: true}})
	r := &platform.FakeRunner{Seq: map[string][]string{"wsl.exe": {"Ubuntu-26.04\r\n", lookOut, ""}}}
	probeWSL(context.Background(), r)
	if len(r.Calls) != 3 {
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
			s := &script{answers: []answer{{out: "Ubuntu-26.04\n"}, {err: c.err}}}
			got, unread := probeWSL(context.Background(), s)
			if len(unread) != 1 || unread[0].Item != "wsl_distros.Ubuntu-26.04" || unread[0].Reason != c.want {
				t.Fatalf("unreadable = %+v, want the reason %q", unread, c.want)
			}
			if d := got.Distros[0]; !d.Running || d.Looked || d.Root || len(s.calls) != 2 {
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
		{out: "Ubuntu-26.04\n"},
		{out: "pid1=systemd\nuser=sam\nsudo=refused\n", err: errors.New("wsl.exe: exit status 1")},
	}}
	got, unread := probeWSL(context.Background(), s)
	if d := got.Distros[0]; d.Looked || d.Unit != nil || len(unread) != 1 || unread[0].Reason != "wsl.exe: exit status 1" {
		t.Fatalf("got %+v, unreadable %+v", d, unread)
	}
	// A look that finished is read even though wsl.exe then failed.
	s = &script{answers: []answer{{out: "Ubuntu-26.04\n"}, {out: lookOut, err: errors.New("wsl.exe: exit status 1")}, {}}}
	got, unread = probeWSL(context.Background(), s)
	if d := got.Distros[0]; !d.Looked || d.Unit == nil || !reflect.DeepEqual(d.PIDs, []int{412}) || len(unread) != 0 {
		t.Fatalf("got %+v, unreadable %+v", d, unread)
	}
}

// A wsl.exe stopped at its bound is said to be so — on Windows a killed
// program exits 1, which would read as wsl.exe's own failure.
func TestAWSLExeStoppedAtItsBoundSaysSo(t *testing.T) {
	withDistros(t, []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2}})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, _ := probeWSL(ctx, &platform.FakeRunner{Errs: map[string]error{"wsl.exe": errors.New("wsl.exe: exit status 1")}})
	if !strings.Contains(got.RunningSaid, "no answer in time") {
		t.Fatalf("running_said = %q", got.RunningSaid)
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
	got, unread := probeWSL(context.Background(), &platform.FakeRunner{Seq: map[string][]string{"wsl.exe": {"Ubuntu-26.04\n", look, ""}}})
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
