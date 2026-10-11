package caps

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"novad/internal/admin"
)

// admin.install / admin.uninstall (S30b T4), OS-neutral over a fake
// AdminHost: every route, every read-back verdict. Nothing here runs sudo,
// schtasks or a UAC prompt.

var (
	unixReady   = admin.PathState{Installed: true, Kind: admin.KindSudoers, State: admin.PathReady, Left: []string{admin.LeftRootCopy, admin.LeftSudoersRule}}
	unixAbsent  = admin.PathState{Kind: admin.KindNone, State: admin.PathAbsent}
	taskReady   = admin.PathState{Installed: true, Kind: admin.KindTask, State: admin.TaskReady, Left: []string{admin.LeftTask, admin.LeftRequestDir, admin.LeftCopyDir}}
	rootWhoami  = `{"euid":0,"user":"root"}`
	ownerWhoami = `{"user":"DELL\\owner","sid":"S-1-5-21-1-2-3-1001","elevated":true,"integrity":"high"}`
)

// fakeHost records what ran, in order.
type fakeHost struct {
	h       AdminHost
	reads   []admin.PathState // successive Read answers; the last repeats
	nread   int
	ran     []string
	sudoN   bool
	instErr error
	whoami  string
	whoErr  error
}

func newFakeHost(windows bool, reads ...admin.PathState) *fakeHost {
	f := &fakeHost{reads: reads}
	f.h = AdminHost{
		Windows: windows, Bin: "/home/sam/.local/bin/novad", User: "sam", SignedIn: true,
		SudoN: func(context.Context) bool { f.ran = append(f.ran, "sudo -n true"); return f.sudoN },
		Read: func(context.Context) admin.PathState {
			f.ran = append(f.ran, "read")
			i := min(f.nread, len(f.reads)-1)
			f.nread++
			return f.reads[i]
		},
		Install: func(_ context.Context, route string) (string, error) {
			f.ran = append(f.ran, "install "+route)
			return "installed: the words", f.instErr
		},
		Uninstall: func(_ context.Context, route string) (string, error) {
			f.ran = append(f.ran, "uninstall "+route)
			return "removed", f.instErr
		},
		Whoami: func(context.Context) (string, error) {
			f.ran = append(f.ran, "whoami")
			return f.whoami, f.whoErr
		},
	}
	return f
}

func (f *fakeHost) ranAny(prefix string) bool {
	for _, r := range f.ran {
		if strings.HasPrefix(r, prefix) {
			return true
		}
	}
	return false
}

type factsLog struct {
	sent int
	at   []string // what had run when facts were sent
	err  error
}

func (l *factsLog) send(f *fakeHost) func(context.Context) error {
	return func(context.Context) error {
		l.sent++
		l.at = append(l.at, strings.Join(f.ran, ","))
		return l.err
	}
}

// C1: the route table.
func TestPickInstallRoute(t *testing.T) {
	for _, c := range []struct {
		name   string
		r      installReads
		route  string
		cannot string
	}{
		{"unix root", installReads{Elevated: true}, routeDirect, ""},
		{"windows elevated", installReads{Windows: true, Elevated: true}, routeDirect, ""},
		{"unix installed", installReads{Installed: true}, routePath, ""},
		{"windows installed", installReads{Windows: true, Installed: true, SignedIn: true}, routePath, ""},
		{"elevated beats installed", installReads{Elevated: true, Installed: true}, routeDirect, ""},
		{"unix sudo -n", installReads{SudoN: true}, routeSudoN, ""},
		{"installed beats sudo -n", installReads{Installed: true, SudoN: true}, routePath, ""},
		{"windows signed in", installReads{Windows: true, SignedIn: true}, routeUAC, ""},
		{"windows sudo -n is not read", installReads{Windows: true, SudoN: true, SignedIn: true}, routeUAC, ""},
	} {
		route, cannot := pickInstallRoute(c.r)
		if route != c.route || cannot != c.cannot {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", c.name, route, cannot, c.route, c.cannot)
		}
	}
}

func TestPickInstallRouteUnixWithoutSudoNamesTheOwnersCommandVerbatim(t *testing.T) {
	route, cannot := pickInstallRoute(installReads{Bin: "/home/sam/.local/bin/novad", User: "sam"})
	if route != "" {
		t.Fatalf("route = %q, want none", route)
	}
	want := "cannot: installing the admin path needs root once and sudo here asks for a password — " +
		"the owner runs this once on this machine: sudo '/home/sam/.local/bin/novad' admin install --user sam"
	if cannot != want {
		t.Fatalf("cannot =\n%q\nwant\n%q", cannot, want)
	}
}

func TestPickInstallRouteWindowsNobodySignedInSaysWhatTheOwnerDoes(t *testing.T) {
	route, cannot := pickInstallRoute(installReads{Windows: true})
	want := "cannot: nobody is signed in on this machine to answer the UAC prompt — " +
		"the owner signs in at its screen, then clicks Yes on the one UAC prompt"
	if route != "" || cannot != want {
		t.Fatalf("got (%q, %q)", route, cannot)
	}
}

func TestUACWaitIsBoundedByTheCallsTimeLessTheReadBack(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 110*time.Second)
	defer cancel()
	w, err := uacWait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if w > 70*time.Second || w < 68*time.Second {
		t.Fatalf("wait = %s, want about 110 s - 40 s", w)
	}
	long, cancel2 := context.WithTimeout(context.Background(), time.Hour)
	defer cancel2()
	if w, _ := uacWait(long); w != uacWaitMax {
		t.Fatalf("wait = %s, want the %s cap", w, uacWaitMax)
	}
	if w, _ := uacWait(context.Background()); w != uacWaitMax {
		t.Fatalf("no deadline: wait = %s, want %s", w, uacWaitMax)
	}
	short, cancel3 := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel3()
	if _, err := uacWait(short); err == nil || !strings.HasPrefix(err.Error(), "cannot: ") {
		t.Fatalf("too little time left: err = %v, want a stated cannot", err)
	}
}

// C2: the read-back verdicts.
func TestInstallVerdict(t *testing.T) {
	for _, c := range []struct {
		name    string
		windows bool
		st      admin.PathState
		who     string
		whoErr  error
		ok      bool
		said    string
	}{
		{"unix root", false, unixReady, rootWhoami, nil, true, "ran as root (euid 0)"},
		{"unix not root", false, unixReady, `{"euid":1000,"user":"sam"}`, nil, false, "euid 1000"},
		{"unix not installed", false, unixAbsent, rootWhoami, nil, false, "does not read back as installed"},
		{"unix incomplete says why", false, admin.PathState{Kind: admin.KindNone, State: admin.PathIncomplete, Said: "sudo: a password is required"}, rootWhoami, nil, false, "a password is required"},
		{"whoami failed", false, unixReady, "", errors.New("sudo: exit 1"), false, "sudo: exit 1"},
		{"unix garbage", false, unixReady, "hello", nil, false, "hello"},
		{"windows elevated", true, taskReady, ownerWhoami, nil, true, `DELL\owner, elevated`},
		{"windows not elevated", true, taskReady, `{"user":"DELL\\owner","sid":"S-1-5-21-1","elevated":false,"integrity":"medium"}`, nil, false, "not elevated"},
		{"windows not installed", true, unixAbsent, ownerWhoami, nil, false, "does not read back as installed"},
		{"windows reads a unix report", true, taskReady, rootWhoami, nil, false, "not elevated"},
	} {
		ok, said := installVerdict(c.windows, c.st, c.who, c.whoErr)
		if ok != c.ok || !strings.Contains(said, c.said) {
			t.Errorf("%s: got (%v, %q), want (%v, …%q…)", c.name, ok, said, c.ok, c.said)
		}
	}
}

func TestUninstallVerdict(t *testing.T) {
	if ok, said := uninstallVerdict(nil, nil); !ok || !strings.Contains(said, "removed") {
		t.Fatalf("nothing left: got (%v, %q)", ok, said)
	}
	ok, said := uninstallVerdict([]string{admin.LeftTask, admin.LeftCopyDir}, nil)
	if ok || !strings.Contains(said, admin.LeftTask) || !strings.Contains(said, admin.LeftCopyDir) {
		t.Fatalf("got (%v, %q), want ok:false naming each part left", ok, said)
	}
}

// C1+C2 end to end over the fake host.
func TestInstallThroughSudoNProvesItselfAndSendsFactsBeforeTheResult(t *testing.T) {
	f := newFakeHost(false, unixAbsent, unixReady)
	f.sudoN, f.whoami = true, rootWhoami
	var l factsLog
	out := installAdminPath(context.Background(), f.h, l.send(f))
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 0 {
		t.Fatalf("got %+v", out)
	}
	if !strings.Contains(out.Output, "ran as root (euid 0)") || !strings.Contains(out.Output, "sudo -n") {
		t.Fatalf("output = %q: it says the route and the proof", out.Output)
	}
	if strings.Join(f.ran, ",") != "read,sudo -n true,install sudo -n,read,whoami" {
		t.Fatalf("ran = %q", f.ran)
	}
	if l.sent != 1 || l.at[0] != "read,sudo -n true,install sudo -n,read,whoami" {
		t.Fatalf("facts sent %d times, at %q: once, after the read-back", l.sent, l.at)
	}
	if out.Meta["installed"] != true || out.Meta["kind"] != admin.KindSudoers || out.Meta["route"] != routeSudoN ||
		!strings.Contains(out.Meta["proof"].(string), "euid 0") {
		t.Fatalf("meta = %+v", out.Meta)
	}
}

func TestInstallWhoseRoundTripIsNotRootIsOkFalse(t *testing.T) {
	f := newFakeHost(false, unixAbsent, unixReady)
	f.sudoN, f.whoami = true, `{"euid":1000,"user":"sam"}`
	var l factsLog
	out := installAdminPath(context.Background(), f.h, l.send(f))
	if out.OK || !strings.Contains(out.Error, "euid 1000") {
		t.Fatalf("got %+v", out)
	}
	if l.sent != 1 {
		t.Fatalf("facts sent %d times: a failed read-back still sends what was read", l.sent)
	}
}

func TestInstallThatDoesNotReadBackIsOkFalseWithTheInstallersWords(t *testing.T) {
	f := newFakeHost(false, unixAbsent, unixAbsent)
	f.sudoN, f.whoami = true, rootWhoami
	out := installAdminPath(context.Background(), f.h, nil)
	if out.OK || !strings.Contains(out.Error, "does not read back as installed") || !strings.Contains(out.Error, "installed: the words") {
		t.Fatalf("got %+v", out)
	}
}

func TestInstallWithoutSudoIsTheStatedCannotAndRunsNothing(t *testing.T) {
	f := newFakeHost(false, unixAbsent)
	var l factsLog
	out := installAdminPath(context.Background(), f.h, l.send(f))
	if out.OK || !strings.HasPrefix(out.Error, "cannot: installing the admin path needs root once") ||
		!strings.Contains(out.Error, "sudo '/home/sam/.local/bin/novad' admin install --user sam") {
		t.Fatalf("got %+v", out)
	}
	if f.ranAny("install") || f.ranAny("whoami") {
		t.Fatalf("ran = %q", f.ran)
	}
}

func TestInstallAlreadyInstalledGoesThroughThePath(t *testing.T) {
	f := newFakeHost(false, unixReady, unixReady)
	f.whoami = rootWhoami
	out := installAdminPath(context.Background(), f.h, nil)
	if !out.OK || f.ranAny("sudo -n true") || !f.ranAny("install path") {
		t.Fatalf("got %+v, ran %q", out, f.ran)
	}
}

func TestInstallWindowsUACDeclinedSaysSoAndReadsNoProof(t *testing.T) {
	f := newFakeHost(true, unixAbsent)
	f.instErr = ErrDeclined
	out := installAdminPath(context.Background(), f.h, nil)
	want := "the UAC prompt on this machine was declined — nothing was installed; the owner clicks Yes on it to install the admin path"
	if out.OK || out.Error != want {
		t.Fatalf("got %+v", out)
	}
	if !f.ranAny("install uac") || f.ranAny("whoami") {
		t.Fatalf("ran = %q", f.ran)
	}
}

func TestInstallWindowsUACAcceptedProvesItself(t *testing.T) {
	f := newFakeHost(true, unixAbsent, taskReady)
	f.whoami = ownerWhoami
	out := installAdminPath(context.Background(), f.h, nil)
	if !out.OK || !strings.Contains(out.Output, `DELL\owner, elevated`) || out.Meta["kind"] != admin.KindTask {
		t.Fatalf("got %+v", out)
	}
}

func TestInstallFailingIsStatedInItsWords(t *testing.T) {
	f := newFakeHost(false, unixAbsent)
	f.sudoN, f.instErr = true, errors.New("visudo refused the rule")
	out := installAdminPath(context.Background(), f.h, nil)
	if out.OK || !strings.Contains(out.Error, "visudo refused the rule") || f.ranAny("whoami") {
		t.Fatalf("got %+v, ran %q", out, f.ran)
	}
}

func TestInstallSaysFactsThatCouldNotBeSent(t *testing.T) {
	f := newFakeHost(false, unixAbsent, unixReady)
	f.sudoN, f.whoami = true, rootWhoami
	l := factsLog{err: errors.New("socket closed")}
	out := installAdminPath(context.Background(), f.h, l.send(f))
	if !out.OK || !strings.Contains(out.Output, "socket closed") {
		t.Fatalf("got %+v: the proof stands, the unsent facts are said", out)
	}
}

// C3: uninstall.
func TestUninstallWithNoPathIsTheStatedCannotAndRunsNothing(t *testing.T) {
	f := newFakeHost(false, unixAbsent)
	out := uninstallAdminPath(context.Background(), f.h, nil)
	if out.OK || out.Error != NoAdminPath || f.ranAny("uninstall") {
		t.Fatalf("got %+v, ran %q", out, f.ran)
	}
}

func TestUninstallGoesThroughThePathAndProvesNothingIsLeft(t *testing.T) {
	f := newFakeHost(false, unixReady, unixAbsent)
	var l factsLog
	out := uninstallAdminPath(context.Background(), f.h, l.send(f))
	if !out.OK || !f.ranAny("uninstall path") || out.Meta["installed"] != false {
		t.Fatalf("got %+v, ran %q", out, f.ran)
	}
	if l.sent != 1 || !strings.HasSuffix(l.at[0], "uninstall path,read") {
		t.Fatalf("facts at %q: after the read-back", l.at)
	}
}

func TestUninstallElevatedRunsDirect(t *testing.T) {
	f := newFakeHost(false, unixReady, unixAbsent)
	f.h.Elevated = true
	if out := uninstallAdminPath(context.Background(), f.h, nil); !out.OK || !f.ranAny("uninstall direct") {
		t.Fatalf("got %+v, ran %q", out, f.ran)
	}
}

func TestUninstallWithSomethingLeftIsOkFalseNamingIt(t *testing.T) {
	left := admin.PathState{Kind: admin.KindNone, State: admin.PathIncomplete, Left: []string{admin.LeftRootCopy}}
	f := newFakeHost(false, unixReady, left)
	out := uninstallAdminPath(context.Background(), f.h, nil)
	if out.OK || !strings.Contains(out.Error, admin.LeftRootCopy) {
		t.Fatalf("got %+v", out)
	}
}

// T2 carry (a): on windows the runner's leftovers go as it exits — the
// read-back keeps reading for Settle, and an uninstaller that answered an
// error (its task vanished under it) is judged by the read-back alone.
func TestUninstallWindowsPollsTheReadBackUntilNothingIsLeft(t *testing.T) {
	partly := admin.PathState{Kind: admin.KindNone, State: admin.PathIncomplete, Left: []string{admin.LeftCopyDir}}
	f := newFakeHost(true, taskReady, partly, partly, unixAbsent)
	f.instErr = errors.New("cannot: no admin path on this machine")
	f.h.Settle, f.h.Poll = 2*time.Second, time.Millisecond
	out := uninstallAdminPath(context.Background(), f.h, nil)
	if !out.OK || f.nread != 4 {
		t.Fatalf("got %+v after %d reads", out, f.nread)
	}
}

func TestUninstallWindowsStillLeftAfterSettleIsOkFalseWithTheUninstallersWords(t *testing.T) {
	partly := admin.PathState{Kind: admin.KindNone, State: admin.PathIncomplete, Left: []string{admin.LeftCopyDir}}
	f := newFakeHost(true, taskReady, partly)
	f.instErr = errors.New("removing the protected copy: access denied")
	f.h.Settle, f.h.Poll = 20*time.Millisecond, time.Millisecond
	out := uninstallAdminPath(context.Background(), f.h, nil)
	if out.OK || !strings.Contains(out.Error, admin.LeftCopyDir) || !strings.Contains(out.Error, "access denied") {
		t.Fatalf("got %+v", out)
	}
}

// Both are in the dispatch table and reach the host.
func TestAdminInstallAndUninstallDispatchThroughTheTable(t *testing.T) {
	f := newFakeHost(false, unixAbsent)
	d := Deps{Admin: &AdminDeps{Host: &f.h}}
	if out := Dispatch(context.Background(), "admin.install", nil, d); out.OK || !strings.HasPrefix(out.Error, "cannot: installing") {
		t.Fatalf("admin.install: %+v", out)
	}
	if out := Dispatch(context.Background(), "admin.uninstall", nil, d); out.OK || out.Error != NoAdminPath {
		t.Fatalf("admin.uninstall: %+v", out)
	}
}

func TestUninstallElevatedWithNothingThereClaimsNoRemoval(t *testing.T) {
	f := newFakeHost(false, unixAbsent)
	f.h.Elevated = true
	out := uninstallAdminPath(context.Background(), f.h, nil)
	if out.OK || out.Error != NoAdminPath || f.ranAny("uninstall") {
		t.Fatalf("got %+v, ran %q", out, f.ran)
	}
}

func TestUninstallIncompleteNotElevatedNamesWhatIsLeft(t *testing.T) {
	left := admin.PathState{Kind: admin.KindNone, State: admin.PathIncomplete, Left: []string{admin.LeftRootCopy}}
	f := newFakeHost(false, left)
	out := uninstallAdminPath(context.Background(), f.h, nil)
	if out.OK || !strings.HasPrefix(out.Error, NoAdminPath) || !strings.Contains(out.Error, admin.LeftRootCopy) || f.ranAny("uninstall") {
		t.Fatalf("got %+v, ran %q", out, f.ran)
	}
}

// G9: an uninstall whose read-back could not query the task (request dir
// and copy gone) is ok:false — the task may still be there; never "removed".
func TestUninstallWhoseReadBackCannotQueryTheTaskIsOkFalse(t *testing.T) {
	for _, st := range []string{"", admin.TaskAbsent} {
		unread := admin.TaskPathState(st, errors.New("schtasks /query: RPC server unavailable"), false, false, nil)
		f := newFakeHost(true, taskReady, unread)
		out := uninstallAdminPath(context.Background(), f.h, nil)
		if out.OK || strings.Contains(out.Error, "is removed") || !strings.Contains(out.Error, admin.LeftTask) {
			t.Fatalf("state %q: got %+v", st, out)
		}
	}
}

// G10: on windows the uninstall through the path moves the running agent
// copy aside, deleted at the next restart. The result says exactly what was
// proven and what is only scheduled, naming the path — never "nothing of it
// is left" — and Meta carries the pending path.
func TestUninstallWithAPendingAsideSaysExactlyWhatItProved(t *testing.T) {
	p := `C:\Program Files\Nova\novad-admin-removed-0a1b2c3d.exe`
	pending := admin.TaskPathState(admin.TaskAbsent, nil, false, false, []string{p})
	f := newFakeHost(true, taskReady, pending)
	f.instErr = errors.New("cannot: no admin path on this machine")
	out := uninstallAdminPath(context.Background(), f.h, nil)
	if !out.OK {
		t.Fatalf("task, request directory and copy are proven gone: got %+v", out)
	}
	for _, w := range []string{admin.LeftTask, admin.LeftRequestDir, "gone", "moved aside to " + p, "deleted at the next restart"} {
		if !strings.Contains(out.Output, w) {
			t.Fatalf("output %q lacks %q", out.Output, w)
		}
	}
	if strings.Contains(out.Output, "nothing of it is left") {
		t.Fatalf("output %q overclaims", out.Output)
	}
	if got, _ := out.Meta["pending_restart"].([]string); len(got) != 1 || got[0] != p {
		t.Fatalf("meta = %+v", out.Meta)
	}
}
