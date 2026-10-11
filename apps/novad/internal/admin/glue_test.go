package admin

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// The glue (install, uninstall, the runner, submit) driven through fakes for
// every OS seam: no schtasks, no ACL calls, no real elevation. The request
// directory is a real temp directory; its "security" is what the fake ACL
// says it is.

const strangerSID = "S-1-5-21-1004336348-1177238915-682003330-1002"

var meReport = WhoamiReport{User: `DELL\owner`, SID: ownerSID, Elevated: true, Integrity: "high"}

type fakeSched struct {
	mu          sync.Mutex
	state       string
	rb          *TaskReadBack
	calls       []string
	deleteErr   error
	deleteKeeps bool
	onRun       func()
}

func (f *fakeSched) record(c string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, c)
}

func (f *fakeSched) called(c string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, x := range f.calls {
		if x == c {
			return true
		}
	}
	return false
}

func (f *fakeSched) Register(_ context.Context, b []byte) error {
	f.record("register")
	rb, err := ParseTaskXML(b)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state, f.rb = TaskReady, &rb
	return nil
}

func (f *fakeSched) Run(context.Context) error {
	f.record("run")
	if f.onRun != nil {
		go f.onRun()
	}
	return nil
}

func (f *fakeSched) End(context.Context) error { f.record("end"); return nil }

func (f *fakeSched) Delete(context.Context) error {
	f.record("delete")
	if f.deleteErr != nil {
		return f.deleteErr
	}
	if !f.deleteKeeps {
		f.mu.Lock()
		f.state, f.rb = TaskAbsent, nil
		f.mu.Unlock()
	}
	return nil
}

func (f *fakeSched) Query(context.Context) (string, *TaskReadBack, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state == "" {
		return TaskAbsent, nil, nil
	}
	return f.state, f.rb, nil
}

type fakeACL struct {
	mu      sync.Mutex
	sec     map[string]DirSecurity
	created []string // sddl per Create of the request directory
	applied []string // sddl per Apply of the request directory
	// The same for the protected copy's directory (copyDir).
	copyDir     string
	copyCreated []string
	copyApplied []string
}

func builtSecurity() DirSecurity {
	return DirSecurity{Owner: SIDAdministrators, Protected: true, Allowed: []string{SIDSystem, SIDAdministrators, ownerSID}}
}

var aceRe = regexp.MustCompile(`\(A;[^;]*;[^;]*;;;([^)]+)\)`)

// securityOf is what a descriptor reads back as once set.
func securityOf(sddl string) DirSecurity {
	abbr := map[string]string{"SY": SIDSystem, "BA": SIDAdministrators}
	d := DirSecurity{Protected: strings.Contains(sddl, "D:P")}
	if strings.HasPrefix(sddl, "O:BA") {
		d.Owner = SIDAdministrators
	}
	for _, m := range aceRe.FindAllStringSubmatch(sddl, -1) {
		sid := m[1]
		if full, ok := abbr[sid]; ok {
			sid = full
		}
		d.Allowed = append(d.Allowed, sid)
	}
	return d
}

func (a *fakeACL) Create(dir, sddl string) error {
	if err := os.Mkdir(dir, 0o700); err != nil {
		return err // *PathError wrapping fs.ErrExist when present
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if dir == a.copyDir {
		a.copyCreated = append(a.copyCreated, sddl)
	} else {
		a.created = append(a.created, sddl)
	}
	a.sec[dir] = securityOf(sddl)
	return nil
}

func (a *fakeACL) Apply(dir, sddl string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if dir == a.copyDir {
		a.copyApplied = append(a.copyApplied, sddl)
	} else {
		a.applied = append(a.applied, sddl)
	}
	a.sec[dir] = securityOf(sddl)
	return nil
}

func (a *fakeACL) Read(dir string) (DirSecurity, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, err := os.Stat(dir); err != nil {
		return DirSecurity{}, err
	}
	s, ok := a.sec[dir]
	if !ok {
		return DirSecurity{}, errors.New("no security recorded")
	}
	return s, nil
}

type fakeOwners map[string]string // base name → owner SID; default the owner

func (o fakeOwners) Owner(path string) (string, error) {
	if s, ok := o[filepath.Base(path)]; ok {
		return s, nil
	}
	return ownerSID, nil
}

type fakeProc struct {
	mu   sync.Mutex
	ran  [][]string
	plan func(argv []string, stdout, stderr io.Writer) ProcOutcome
}

func (p *fakeProc) Run(_ context.Context, argv []string, _ string, _ time.Duration, stdout, stderr io.Writer) ProcOutcome {
	p.mu.Lock()
	p.ran = append(p.ran, argv)
	p.mu.Unlock()
	if p.plan != nil {
		return p.plan(argv, stdout, stderr)
	}
	return ProcOutcome{}
}

func (p *fakeProc) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.ran)
}

// whoamiProc answers `<bin> admin whoami` with report.
func whoamiProc(report string) *fakeProc {
	return &fakeProc{plan: func(argv []string, stdout, _ io.Writer) ProcOutcome {
		if len(argv) == 3 && argv[1] == "admin" && argv[2] == "whoami" {
			fmt.Fprintln(stdout, report)
			return ProcOutcome{}
		}
		return ProcOutcome{ExitCode: 9, Said: "unexpected argv"}
	}}
}

const goodWhoami = `{"user":"DELL\\owner","sid":"` + ownerSID + `","elevated":true,"integrity":"high"}`

// copyExe is where the task is registered and the runner must run from.
const copyExe = `C:\Program Files\Nova\Admin\novad.exe`

type rig struct {
	h     Host
	sched *fakeSched
	acl   *fakeACL
	own   fakeOwners
	proc  *fakeProc
	src   string // the agent's own binary (the copy's source)
}

func newRig(t *testing.T) *rig {
	t.Helper()
	tmp := t.TempDir()
	copyDir := filepath.Join(tmp, "ProgramFiles", "Nova", "Admin")
	r := &rig{sched: &fakeSched{}, acl: &fakeACL{sec: map[string]DirSecurity{}, copyDir: copyDir}, own: fakeOwners{}, proc: &fakeProc{}}
	r.src = filepath.Join(tmp, "LocalAppData", "novad.exe")
	if err := os.MkdirAll(filepath.Dir(r.src), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.src, []byte("agent build 1"), 0o700); err != nil {
		t.Fatal(err)
	}
	r.h = Host{
		Sched: r.sched, ACL: r.acl, Owners: r.own, Proc: r.proc,
		Dir:      filepath.Join(tmp, "NovaAdmin"),
		SignedIn: func() bool { return true },
		Poll:     2 * time.Millisecond,
		CopyDir:  copyDir,
		CopyExe:  copyExe,
		Self:     func() (string, error) { return copyExe, nil },
	}
	// The task's action: drain the request directory as the owner.
	r.sched.onRun = func() { _ = RunQueued(context.Background(), r.h, meReport) }
	return r
}

// copyFile is the protected copy as written on this test's disk.
func (r *rig) copyFile() string { return filepath.Join(r.h.CopyDir, CopyName) }

func (r *rig) ctx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var n []string
	for _, e := range ents {
		n = append(n, e.Name())
	}
	return n
}

func writeReq(t *testing.T, dir, name string, b []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readResult(t *testing.T, dir, id string) TaskResult {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, ResultName(id)))
	if err != nil {
		t.Fatalf("no result for %s: %v (dir: %q)", id, err, names(t, dir))
	}
	res, err := DecodeResult(b, id)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func goodRequest(t *testing.T, id string) []byte {
	t.Helper()
	b, err := EncodeRequest(TaskRequest{ID: id, Argv: []string{`C:\Windows\System32\cmd.exe`, "/c", "echo", "hi"}, TimeoutS: "30"})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// securedDir makes the request directory as install would.
func (r *rig) securedDir(t *testing.T) {
	t.Helper()
	sddl, _ := RequestDirSDDL(ownerSID)
	if err := r.acl.Create(r.h.Dir, sddl); err != nil {
		t.Fatal(err)
	}
}

// --- pure decisions ---

func TestDirActionReusesOnlyADirectoryAnInstallSecured(t *testing.T) {
	if a, _ := DirAction(false, DirSecurity{}); a != DirCreate {
		t.Errorf("absent: %q, want %q", a, DirCreate)
	}
	for _, owner := range []string{SIDAdministrators, SIDSystem} {
		if a, _ := DirAction(true, DirSecurity{Owner: owner}); a != DirResecure {
			t.Errorf("owned by %s: %q, want %q", owner, a, DirResecure)
		}
	}
	// The owner's own SID is not proof an elevated install made it: any
	// unelevated process of his (or one pretending) could have.
	for _, owner := range []string{strangerSID, ownerSID, "", "S-1-1-0"} {
		a, said := DirAction(true, DirSecurity{Owner: owner, Protected: true})
		if a != DirRecreate || !strings.Contains(said, "not secured by an install") {
			t.Errorf("owned by %q: %q %q, want %q stating why", owner, a, said, DirRecreate)
		}
	}
}

func TestFileOwnerOKAdmitsOnlyTheOwnerSystemAndAdministrators(t *testing.T) {
	for _, o := range []string{ownerSID, SIDSystem, SIDAdministrators} {
		if !FileOwnerOK(o, ownerSID) {
			t.Errorf("%s refused", o)
		}
	}
	for _, o := range []string{strangerSID, "S-1-1-0", "S-1-5-32-545", ""} {
		if FileOwnerOK(o, ownerSID) {
			t.Errorf("%q admitted", o)
		}
	}
}

func TestCapBufferCapsWhileReading(t *testing.T) {
	var c CapBuffer
	chunk := strings.Repeat("x", 4096)
	for i := 0; i < 256; i++ { // 1 MiB
		n, err := c.Write([]byte(chunk))
		if n != len(chunk) || err != nil {
			t.Fatalf("Write = %d, %v; a capped writer still takes everything (the child must not see a short write)", n, err)
		}
	}
	if len(c.b) != OutputCap {
		t.Errorf("kept %d bytes, want exactly OutputCap %d", len(c.b), OutputCap)
	}
	s, cut := c.Result()
	if len(s) != OutputCap || !cut {
		t.Errorf("Result len %d cut %v", len(s), cut)
	}
	var small CapBuffer
	small.Write([]byte("hi"))
	if s, cut := small.Result(); s != "hi" || cut {
		t.Errorf("small: %q %v", s, cut)
	}
}

func TestDecodeRequestRefusesAnOversizedFile(t *testing.T) {
	b := goodRequest(t, testID)
	big := append(b[:len(b)-1], []byte(`,"pad":"`+strings.Repeat("a", MaxRequestBytes)+`"}`)...)
	_, _, err := DecodeRequest(big)
	if err == nil || !strings.Contains(err.Error(), fmt.Sprint(MaxRequestBytes)) {
		t.Errorf("oversized: %v, want refused naming %d", err, MaxRequestBytes)
	}
}

// --- the runner ---

func TestRunQueuedRefusesAMalformedRequestUnrun(t *testing.T) {
	r := newRig(t)
	r.securedDir(t)
	writeReq(t, r.h.Dir, RequestName(testID), []byte(`{"v":1,"id":"`+testID+`","argv":[],"timeout_s":30}`))
	if err := RunQueued(r.ctx(t), r.h, meReport); err != nil {
		t.Fatal(err)
	}
	res := readResult(t, r.h.Dir, testID)
	if res.OK || !strings.HasPrefix(res.Said, "cannot:") || !strings.Contains(res.Said, "argv") {
		t.Errorf("result %+v, want a stated cannot naming argv", res)
	}
	if r.proc.count() != 0 {
		t.Errorf("ran %v", r.proc.ran)
	}
}

func TestRunQueuedRefusesAnOversizedRequestUnrun(t *testing.T) {
	r := newRig(t)
	r.securedDir(t)
	writeReq(t, r.h.Dir, RequestName(testID), []byte(strings.Repeat(" ", MaxRequestBytes+1)))
	if err := RunQueued(r.ctx(t), r.h, meReport); err != nil {
		t.Fatal(err)
	}
	res := readResult(t, r.h.Dir, testID)
	want := fmt.Sprintf("cannot: the request is over %d bytes", MaxRequestBytes)
	if res.OK || !strings.HasPrefix(res.Said, want) {
		t.Errorf("Said %q, want it to start %q", res.Said, want)
	}
	if r.proc.count() != 0 {
		t.Errorf("ran %v", r.proc.ran)
	}
}

func TestRunQueuedSkipsARequestFileTheOwnerDidNotWrite(t *testing.T) {
	r := newRig(t)
	r.securedDir(t)
	const planted = "fedcba9876543210fedcba9876543210"
	writeReq(t, r.h.Dir, RequestName(planted), goodRequest(t, planted))
	writeReq(t, r.h.Dir, RequestName(testID), goodRequest(t, testID))
	r.own[ClaimName(planted)] = strangerSID
	r.own[RequestName(planted)] = strangerSID
	if err := RunQueued(r.ctx(t), r.h, meReport); err != nil {
		t.Fatal(err)
	}
	if res := readResult(t, r.h.Dir, planted); res.OK || !strings.Contains(res.Said, "owned by "+strangerSID) {
		t.Errorf("planted: %+v, want a stated skip naming its owner", res)
	}
	if res := readResult(t, r.h.Dir, testID); !res.OK {
		t.Errorf("the owner's own request: %+v, want it run", res)
	}
	if r.proc.count() != 1 {
		t.Errorf("ran %v, want only the owner's request", r.proc.ran)
	}
}

func TestRunQueuedRunsNothingInADirectoryNotAsBuilt(t *testing.T) {
	r := newRig(t)
	r.securedDir(t)
	s := builtSecurity()
	s.Allowed = append(s.Allowed, "S-1-1-0")
	r.acl.sec[r.h.Dir] = s
	writeReq(t, r.h.Dir, RequestName(testID), goodRequest(t, testID))
	err := RunQueued(r.ctx(t), r.h, meReport)
	if err == nil || !strings.Contains(err.Error(), "S-1-1-0") {
		t.Errorf("err %v, want a stated refusal naming what the directory allows", err)
	}
	if r.proc.count() != 0 {
		t.Errorf("ran %v", r.proc.ran)
	}
	if got := names(t, r.h.Dir); len(got) != 1 || got[0] != RequestName(testID) {
		t.Errorf("dir %q, want the request left unclaimed and no result written", got)
	}
}

func TestRunQueuedBoundsTheResultAndReportsTheToken(t *testing.T) {
	r := newRig(t)
	r.securedDir(t)
	r.proc.plan = func(_ []string, stdout, stderr io.Writer) ProcOutcome {
		for i := 0; i < 3; i++ {
			stdout.Write([]byte(strings.Repeat("o", OutputCap)))
			stderr.Write([]byte(strings.Repeat("e", OutputCap)))
		}
		return ProcOutcome{ExitCode: 3}
	}
	writeReq(t, r.h.Dir, RequestName(testID), goodRequest(t, testID))
	if err := RunQueued(r.ctx(t), r.h, meReport); err != nil {
		t.Fatal(err)
	}
	res := readResult(t, r.h.Dir, testID)
	if len(res.Stdout) != OutputCap || !res.StdoutTruncated || len(res.Stderr) != OutputCap || !res.StderrTruncated {
		t.Errorf("stdout %d/%v stderr %d/%v, want each capped at %d and said", len(res.Stdout), res.StdoutTruncated, len(res.Stderr), res.StderrTruncated, OutputCap)
	}
	if !res.OK || res.ExitCode != 3 || !res.Elevated || res.User != meReport.User {
		t.Errorf("result %+v, want ok, exit 3, elevated as %s", res, meReport.User)
	}
	if got := names(t, r.h.Dir); len(got) != 1 {
		t.Errorf("dir %q, want only the result (claim removed)", got)
	}
}

func TestRunQueuedStatesATimeout(t *testing.T) {
	r := newRig(t)
	r.securedDir(t)
	r.proc.plan = func([]string, io.Writer, io.Writer) ProcOutcome {
		return ProcOutcome{ExitCode: 1, TimedOut: true, Said: "timed out after 30s; the job was terminated"}
	}
	writeReq(t, r.h.Dir, RequestName(testID), goodRequest(t, testID))
	if err := RunQueued(r.ctx(t), r.h, meReport); err != nil {
		t.Fatal(err)
	}
	if res := readResult(t, r.h.Dir, testID); res.OK || !res.TimedOut || !strings.Contains(res.Said, "timed out") {
		t.Errorf("result %+v, want not ok, timed out, said", res)
	}
}

// --- submit ---

func TestSubmitRefusesAnOversizedRequestBeforeWritingIt(t *testing.T) {
	r := newRig(t)
	r.securedDir(t)
	r.sched.state = TaskReady
	req := TaskRequest{ID: testID, Argv: []string{"cmd", strings.Repeat("a", MaxRequestBytes)}, TimeoutS: "30"}
	_, err := Submit(r.ctx(t), r.h, req, 30*time.Second)
	if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("over %d bytes", MaxRequestBytes)) {
		t.Errorf("err %v, want refused naming the cap", err)
	}
	if r.sched.called("run") || len(names(t, r.h.Dir)) != 0 {
		t.Errorf("calls %v dir %q, want nothing written and the task not started", r.sched.calls, names(t, r.h.Dir))
	}
}

func TestSubmitRunsThroughTheTaskAndCleansUp(t *testing.T) {
	r := newRig(t)
	r.securedDir(t)
	r.sched.state = TaskReady
	r.proc = whoamiProc(goodWhoami)
	r.h.Proc = r.proc
	res, err := Submit(r.ctx(t), r.h, TaskRequest{ID: testID, Argv: []string{ownerBin, "admin", "whoami"}, TimeoutS: "30"}, 30*time.Second)
	if err != nil || !res.OK || !strings.Contains(res.Stdout, ownerSID) {
		t.Fatalf("Submit = %+v, %v", res, err)
	}
	if got := names(t, r.h.Dir); len(got) != 0 {
		t.Errorf("dir %q, want empty after the result is read", got)
	}
}

// --- install ---

func TestInstallCreatesTheDirectorySecuredInOneStepAndProvesItself(t *testing.T) {
	r := newRig(t)
	r.proc = whoamiProc(goodWhoami)
	r.h.Proc = r.proc
	said, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false)
	if err != nil || !strings.Contains(said, "elevated") {
		t.Fatalf("InstallTask = %q, %v", said, err)
	}
	want, _ := RequestDirSDDL(ownerSID)
	if len(r.acl.created) != 1 || r.acl.created[0] != want || len(r.acl.applied) != 0 {
		t.Errorf("created %q applied %q, want one Create with %q (never MkdirAll then Apply)", r.acl.created, r.acl.applied, want)
	}
	if !r.sched.called("register") {
		t.Error("task never registered")
	}
	if got := names(t, r.h.Dir); len(got) != 0 {
		t.Errorf("dir %q, want empty after the proof", got)
	}
}

func TestInstallRecreatesADirectoryItDidNotSecureAndDropsWhatWasInIt(t *testing.T) {
	r := newRig(t)
	r.proc = whoamiProc(goodWhoami)
	r.h.Proc = r.proc
	if err := os.Mkdir(r.h.Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	const planted = "fedcba9876543210fedcba9876543210"
	writeReq(t, r.h.Dir, RequestName(planted), goodRequest(t, planted))
	r.acl.sec[r.h.Dir] = DirSecurity{Owner: strangerSID, Protected: true, Allowed: []string{strangerSID, SIDSystem, SIDAdministrators, ownerSID}}
	said, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false)
	if err != nil {
		t.Fatalf("InstallTask: %v", err)
	}
	if len(r.acl.created) != 1 || len(r.acl.applied) != 0 {
		t.Errorf("created %d applied %d, want the foreign directory removed and created anew", len(r.acl.created), len(r.acl.applied))
	}
	if !strings.Contains(said, "elevated") {
		t.Errorf("said %q", said)
	}
	for _, argv := range r.proc.ran {
		if argv[len(argv)-1] == "hi" {
			t.Errorf("ran the planted request %v", argv)
		}
	}
	if _, err := os.Stat(filepath.Join(r.h.Dir, RequestName(planted))); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("planted request still there: %v", err)
	}
}

func TestInstallStatesAForeignDirectoryItCannotRemove(t *testing.T) {
	r := newRig(t)
	if err := os.Mkdir(r.h.Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	r.acl.sec[r.h.Dir] = DirSecurity{Owner: strangerSID}
	r.h.RemoveAll = func(string) error { return errors.New("Access is denied.") }
	_, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false)
	if err == nil || !strings.Contains(err.Error(), "not secured by an install") || !strings.Contains(err.Error(), strangerSID) || !strings.Contains(err.Error(), "Access is denied.") {
		t.Errorf("err %v, want it stated: not secured, its owner, and why removal failed", err)
	}
	if r.sched.called("register") {
		t.Error("registered the task over a directory it could not secure")
	}
}

func TestInstallResecuresItsOwnDirectoryAndClearsIt(t *testing.T) {
	r := newRig(t)
	r.proc = whoamiProc(goodWhoami)
	r.h.Proc = r.proc
	r.securedDir(t)
	r.acl.created = nil
	s := builtSecurity()
	s.Protected = false // drifted
	r.acl.sec[r.h.Dir] = s
	writeReq(t, r.h.Dir, "leftover.res.json", []byte("{}"))
	if _, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false); err != nil {
		t.Fatalf("InstallTask: %v", err)
	}
	want, _ := RequestDirSDDL(ownerSID)
	if len(r.acl.applied) != 1 || r.acl.applied[0] != want || len(r.acl.created) != 0 {
		t.Errorf("applied %q created %q, want one Apply of %q", r.acl.applied, r.acl.created, want)
	}
	if got := names(t, r.h.Dir); len(got) != 0 {
		t.Errorf("dir %q, want what was there before install removed", got)
	}
}

func TestInstallFailsWhenTheProofFails(t *testing.T) {
	r := newRig(t)
	r.proc = whoamiProc(strings.Replace(goodWhoami, `"elevated":true`, `"elevated":false`, 1))
	r.h.Proc = r.proc
	said, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false)
	if err == nil || !strings.Contains(err.Error(), "did not prove itself") || said != "" {
		t.Errorf("InstallTask = %q, %v; want a stated failure, no success words", said, err)
	}
}

// --- uninstall ---

func installed(t *testing.T) *rig {
	t.Helper()
	r := newRig(t)
	r.securedDir(t)
	if err := os.MkdirAll(filepath.Dir(r.h.CopyDir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := r.acl.Create(r.h.CopyDir, CopyDirSDDL()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.copyFile(), []byte("agent build 1"), 0o700); err != nil {
		t.Fatal(err)
	}
	b, _ := TaskXMLFile(TaskDefinition{SID: ownerSID, Binary: copyExe})
	if err := r.sched.Register(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestUninstallRemovesBothAndProvesIt(t *testing.T) {
	r := installed(t)
	said, err := UninstallTask(r.ctx(t), r.h, false)
	if err != nil || !strings.Contains(said, "gone") {
		t.Fatalf("UninstallTask = %q, %v", said, err)
	}
	if _, err := os.Stat(r.h.Dir); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("dir still there: %v", err)
	}
}

func TestUninstallStatesAFailedTaskDelete(t *testing.T) {
	r := installed(t)
	r.sched.deleteErr = errors.New("ERROR: Access is denied.")
	said, err := UninstallTask(r.ctx(t), r.h, false)
	if err == nil || !strings.Contains(err.Error(), "Access is denied.") || said != "" {
		t.Errorf("UninstallTask = %q, %v; want the failure stated", said, err)
	}
}

func TestUninstallReadsBackATaskThatStayed(t *testing.T) {
	r := installed(t)
	r.sched.deleteKeeps = true
	said, err := UninstallTask(r.ctx(t), r.h, false)
	if err == nil || !strings.Contains(err.Error(), TaskPath+" is still there") || said != "" {
		t.Errorf("UninstallTask = %q, %v; want the read-back naming the task", said, err)
	}
}

func TestUninstallReadsBackADirectoryThatStayed(t *testing.T) {
	r := installed(t)
	r.h.RemoveAll = func(string) error { return nil } // says removed, removed nothing
	said, err := UninstallTask(r.ctx(t), r.h, false)
	if err == nil || !strings.Contains(err.Error(), "request directory is still there") || said != "" {
		t.Errorf("UninstallTask = %q, %v; want the read-back naming the directory", said, err)
	}
}

func TestUninstallStatesAFailedDirectoryRemoval(t *testing.T) {
	r := installed(t)
	r.h.RemoveAll = func(string) error { return errors.New("The process cannot access the file") }
	said, err := UninstallTask(r.ctx(t), r.h, false)
	if err == nil || !strings.Contains(err.Error(), "cannot access the file") || said != "" {
		t.Errorf("UninstallTask = %q, %v; want the failure stated", said, err)
	}
}

func TestUninstallOfNothingSaysSo(t *testing.T) {
	r := newRig(t)
	said, err := UninstallTask(r.ctx(t), r.h, false)
	if err != nil || !strings.Contains(said, "no admin path") {
		t.Errorf("UninstallTask = %q, %v", said, err)
	}
}

// --- G6: the runner's read is bounded ---

// endlessRequest is a request file that never ends; it counts what was read
// and fails past a margin so an unbounded read cannot hang the test.
type endlessRequest struct {
	n int
}

func (e *endlessRequest) Read(p []byte) (int, error) {
	if e.n > 4*MaxRequestBytes {
		return 0, errors.New("read far past the cap")
	}
	for i := range p {
		p[i] = ' '
	}
	e.n += len(p)
	return len(p), nil
}

func (e *endlessRequest) Close() error { return nil }

func TestRunQueuedReadsAtMostTheCapPlusOne(t *testing.T) {
	r := newRig(t)
	r.securedDir(t)
	writeReq(t, r.h.Dir, RequestName(testID), []byte("{}")) // what the open seam serves instead is endless
	src := &endlessRequest{}
	r.h.Open = func(string) (io.ReadCloser, error) { return src, nil }
	if err := RunQueued(r.ctx(t), r.h, meReport); err != nil {
		t.Fatal(err)
	}
	if src.n > MaxRequestBytes+1 {
		t.Errorf("read %d bytes of the request, want at most %d (the cap plus one)", src.n, MaxRequestBytes+1)
	}
	res := readResult(t, r.h.Dir, testID)
	want := fmt.Sprintf("cannot: the request is over %d bytes", MaxRequestBytes)
	if res.OK || !strings.HasPrefix(res.Said, want) {
		t.Errorf("Said %q, want it to start %q", res.Said, want)
	}
	if r.proc.count() != 0 {
		t.Errorf("ran %v", r.proc.ran)
	}
}

// --- G7: the protected copy ---

func TestInstallCopiesTheAgentToTheProtectedCopyAndRegistersOnlyThat(t *testing.T) {
	r := newRig(t)
	r.proc = whoamiProc(goodWhoami)
	r.h.Proc = r.proc
	if _, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false); err != nil {
		t.Fatalf("InstallTask: %v", err)
	}
	b, err := os.ReadFile(r.copyFile())
	if err != nil || string(b) != "agent build 1" {
		t.Fatalf("the protected copy reads %q, %v; want the agent's bytes", b, err)
	}
	if len(r.acl.copyCreated) != 1 || r.acl.copyCreated[0] != CopyDirSDDL() || len(r.acl.copyApplied) != 0 {
		t.Errorf("copy dir created %q applied %q, want one Create carrying %q", r.acl.copyCreated, r.acl.copyApplied, CopyDirSDDL())
	}
	_, rb, _ := r.sched.Query(context.Background())
	if rb == nil || rb.Command != copyExe {
		t.Errorf("task registered against %+v, want the protected copy %s (never %s)", rb, copyExe, r.src)
	}
	for _, argv := range r.proc.ran {
		if argv[0] != copyExe {
			t.Errorf("the proof ran %v, want it through the protected copy", argv)
		}
	}
}

func TestInstallRefusesACopyThatDoesNotMatchItsSource(t *testing.T) {
	r := newRig(t)
	r.proc = whoamiProc(goodWhoami)
	r.h.Proc = r.proc
	r.h.Put = func(src, dst string) error { return os.WriteFile(dst, []byte("agent build ?"), 0o700) }
	said, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false)
	if err == nil || said != "" || !strings.Contains(err.Error(), "protected copy") || !strings.Contains(err.Error(), "sha256") {
		t.Errorf("InstallTask = %q, %v; want a stated mismatch naming the protected copy and its sha256", said, err)
	}
	if r.sched.called("register") {
		t.Error("registered the task against a copy that does not match")
	}
}

func TestInstallRefusesACopyOfADifferentSize(t *testing.T) {
	r := newRig(t)
	r.h.Put = func(src, dst string) error { return os.WriteFile(dst, []byte("agent build 1 and more"), 0o700) }
	_, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false)
	if err == nil || !strings.Contains(err.Error(), "size") {
		t.Errorf("err %v, want a stated size mismatch", err)
	}
	if r.sched.called("register") {
		t.Error("registered the task against a copy that does not match")
	}
}

func TestInstallStatesACopyItCannotHash(t *testing.T) {
	r := newRig(t)
	r.h.Sum = func(string) (FileDigest, error) {
		return FileDigest{}, errors.New("The process cannot access the file")
	}
	_, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false)
	if err == nil || !strings.Contains(err.Error(), "cannot access the file") {
		t.Errorf("err %v, want the hash failure stated", err)
	}
	if r.sched.called("register") {
		t.Error("registered the task against an unverified copy")
	}
}

func TestInstallStatesAFailedCopy(t *testing.T) {
	r := newRig(t)
	r.h.Put = func(string, string) error { return errors.New("Access is denied.") }
	_, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false)
	if err == nil || !strings.Contains(err.Error(), "Access is denied.") {
		t.Errorf("err %v, want the copy failure stated", err)
	}
	if r.sched.called("register") {
		t.Error("registered the task with no copy")
	}
}

func TestReinstallRefreshesTheProtectedCopy(t *testing.T) {
	r := newRig(t)
	r.proc = whoamiProc(goodWhoami)
	r.h.Proc = r.proc
	if _, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false); err != nil {
		t.Fatalf("first install: %v", err)
	}
	if err := os.WriteFile(r.src, []byte("agent build 2, longer"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false); err != nil {
		t.Fatalf("re-install: %v", err)
	}
	if b, _ := os.ReadFile(r.copyFile()); string(b) != "agent build 2, longer" {
		t.Errorf("the protected copy reads %q after a re-install, want the new build", b)
	}
	if len(r.acl.copyCreated) != 1 || len(r.acl.copyApplied) != 1 || r.acl.copyApplied[0] != CopyDirSDDL() {
		t.Errorf("copy dir created %q applied %q, want created once then re-secured", r.acl.copyCreated, r.acl.copyApplied)
	}
	if got := names(t, r.h.CopyDir); len(got) != 1 || got[0] != CopyName {
		t.Errorf("copy dir holds %q, want only %s", got, CopyName)
	}
}

func TestInstallRecreatesACopyDirectoryItDidNotSecure(t *testing.T) {
	r := newRig(t)
	r.proc = whoamiProc(goodWhoami)
	r.h.Proc = r.proc
	if err := os.MkdirAll(r.h.CopyDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeReq(t, r.h.CopyDir, "planted.dll", []byte("x"))
	r.acl.sec[r.h.CopyDir] = DirSecurity{Owner: ownerSID, Protected: true, Allowed: []string{SIDSystem, SIDAdministrators, ownerSID}}
	if _, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false); err != nil {
		t.Fatalf("InstallTask: %v", err)
	}
	if len(r.acl.copyCreated) != 1 || len(r.acl.copyApplied) != 0 {
		t.Errorf("copy dir created %d applied %d, want it removed and created anew", len(r.acl.copyCreated), len(r.acl.copyApplied))
	}
	if got := names(t, r.h.CopyDir); len(got) != 1 || got[0] != CopyName {
		t.Errorf("copy dir holds %q, want only %s", got, CopyName)
	}
}

func TestInstallRefusesACopyDirectoryNotAsBuilt(t *testing.T) {
	r := newRig(t)
	if err := os.MkdirAll(r.h.CopyDir, 0o700); err != nil {
		t.Fatal(err)
	}
	r.acl.sec[r.h.CopyDir] = DirSecurity{Owner: SIDAdministrators, Protected: true, Allowed: []string{SIDSystem, SIDAdministrators}}
	// Apply "succeeds" but the directory reads back allowing Users.
	r.h.ACL = driftACL{r.acl, DirSecurity{Owner: SIDAdministrators, Protected: true, Allowed: []string{SIDSystem, SIDAdministrators, "S-1-5-32-545"}}}
	_, err := InstallTask(r.ctx(t), r.h, ownerSID, r.src, false)
	if err == nil || !strings.Contains(err.Error(), "S-1-5-32-545") {
		t.Errorf("err %v, want refused naming what the copy directory allows", err)
	}
	if r.sched.called("register") {
		t.Error("registered the task over a copy directory not as built")
	}
}

// driftACL reads the copy directory back as sec whatever was set.
type driftACL struct {
	*fakeACL
	sec DirSecurity
}

func (d driftACL) Read(dir string) (DirSecurity, error) {
	if dir == d.copyDir {
		return d.sec, nil
	}
	return d.fakeACL.Read(dir)
}

func TestUninstallRemovesTheProtectedCopyAndProvesIt(t *testing.T) {
	r := installed(t)
	said, err := UninstallTask(r.ctx(t), r.h, false)
	if err != nil || !strings.Contains(said, "protected copy") {
		t.Fatalf("UninstallTask = %q, %v; want it to say the protected copy is gone", said, err)
	}
	if _, err := os.Stat(r.h.CopyDir); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("copy dir still there: %v", err)
	}
}

func TestUninstallReadsBackACopyThatStayed(t *testing.T) {
	r := installed(t)
	r.h.RemoveAll = func(p string) error {
		if p == r.h.CopyDir {
			return nil // says removed, removed nothing
		}
		return os.RemoveAll(p)
	}
	said, err := UninstallTask(r.ctx(t), r.h, false)
	if err == nil || !strings.Contains(err.Error(), "protected copy is still there") || said != "" {
		t.Errorf("UninstallTask = %q, %v; want the read-back naming the protected copy", said, err)
	}
}

func TestUninstallOfOnlyACopyRemovesIt(t *testing.T) {
	r := newRig(t)
	if err := os.MkdirAll(r.h.CopyDir, 0o700); err != nil {
		t.Fatal(err)
	}
	said, err := UninstallTask(r.ctx(t), r.h, false)
	if err != nil || strings.Contains(said, "nothing to remove") {
		t.Errorf("UninstallTask = %q, %v; want the leftover copy removed", said, err)
	}
	if _, err := os.Stat(r.h.CopyDir); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("copy dir still there: %v", err)
	}
}

func TestRunQueuedRefusesToRunFromAnywhereButTheProtectedCopy(t *testing.T) {
	for name, self := range map[string]func() (string, error){
		"agent's own":  func() (string, error) { return `C:\Users\owner\AppData\Local\Programs\Nova\novad.exe`, nil },
		"unreadable":   func() (string, error) { return "", errors.New("The handle is invalid.") },
		"a near miss":  func() (string, error) { return copyExe + ".old", nil },
		"another copy": func() (string, error) { return `D:\Program Files\Nova\Admin\novad.exe`, nil },
	} {
		r := newRig(t)
		r.securedDir(t)
		r.h.Self = self
		writeReq(t, r.h.Dir, RequestName(testID), goodRequest(t, testID))
		err := RunQueued(r.ctx(t), r.h, meReport)
		if err == nil || !strings.HasPrefix(err.Error(), "cannot:") || !strings.Contains(err.Error(), "protected copy") {
			t.Errorf("%s: err %v, want a stated cannot naming the protected copy", name, err)
		}
		if r.proc.count() != 0 {
			t.Errorf("%s: ran %v", name, r.proc.ran)
		}
		if got := names(t, r.h.Dir); len(got) != 1 || got[0] != RequestName(testID) {
			t.Errorf("%s: dir %q, want the request left unclaimed", name, got)
		}
	}
	r := newRig(t)
	r.h.Self = nil
	r.securedDir(t)
	if err := RunQueued(r.ctx(t), r.h, meReport); err == nil {
		t.Error("no Self seam: ran, want refused")
	}
	// The same path in another case is the same file on Windows.
	r = newRig(t)
	r.securedDir(t)
	r.h.Self = func() (string, error) { return strings.ToLower(copyExe), nil }
	writeReq(t, r.h.Dir, RequestName(testID), goodRequest(t, testID))
	if err := RunQueued(r.ctx(t), r.h, meReport); err != nil || r.proc.count() != 1 {
		t.Errorf("case-folded copy path: err %v ran %d, want run", err, r.proc.count())
	}
}

// --- the copy's real helpers (OS-neutral) ---

func TestFileSumReadsSizeAndSHA256(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(p, []byte("abc"), 0o600); err != nil {
		t.Fatal(err)
	}
	d, err := FileSum(p)
	want := FileDigest{Size: 3, SHA256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}
	if err != nil || d != want {
		t.Errorf("FileSum = %+v, %v; want %+v", d, err, want)
	}
	if _, err := FileSum(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Error("absent file summed")
	}
}

func TestReplaceFileReplacesAndLeavesNothingElse(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "src.exe"), filepath.Join(dir, "copy", CopyName)
	if err := os.Mkdir(filepath.Dir(dst), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"one", "two, longer"} {
		if err := os.WriteFile(src, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := ReplaceFile(src, dst); err != nil {
			t.Fatalf("ReplaceFile: %v", err)
		}
		if b, _ := os.ReadFile(dst); string(b) != body {
			t.Errorf("dst %q, want %q", b, body)
		}
		if got := names(t, filepath.Dir(dst)); len(got) != 1 {
			t.Errorf("copy dir holds %q, want only %s", got, CopyName)
		}
	}
	if err := ReplaceFile(filepath.Join(dir, "absent"), dst); err == nil {
		t.Error("absent source: no error")
	}
	if b, _ := os.ReadFile(dst); string(b) != "two, longer" {
		t.Errorf("a failed replace damaged the copy: %q", b)
	}
}

// T4 / T2 carry (a): an uninstall through the path runs as the runner's
// child, and the runner's own image (the protected copy) cannot be deleted
// while it runs. In self mode it is moved aside, out of the copy's
// directory (deleted at the next restart), and the directory then goes.
func runningCopy(t *testing.T, r *rig) (*[]string, string) {
	t.Helper()
	var asides []string
	away := filepath.Join(t.TempDir(), "aside.exe")
	r.h.RemoveAll = func(p string) error {
		if p == r.h.CopyDir {
			if _, err := os.Stat(r.copyFile()); err == nil {
				return errors.New("Access is denied: the image is running")
			}
		}
		return os.RemoveAll(p)
	}
	r.h.Aside = func(p string) (string, error) {
		asides = append(asides, p)
		return away, os.Rename(p, away)
	}
	return &asides, away
}

func TestUninstallSelfMovesTheRunningCopyAsideAndRemovesItsDirectory(t *testing.T) {
	r := installed(t)
	asides, away := runningCopy(t, r)
	said, err := UninstallTask(r.ctx(t), r.h, true)
	if err != nil {
		t.Fatalf("UninstallTask = %q, %v", said, err)
	}
	if len(*asides) != 1 || (*asides)[0] != r.copyFile() {
		t.Fatalf("aside = %q, want the running copy only", *asides)
	}
	if _, err := os.Stat(r.h.CopyDir); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("copy dir still there: %v", err)
	}
	if !strings.Contains(said, away) || !strings.Contains(said, "next restart") {
		t.Errorf("said = %q: it names where the running copy went and when it goes", said)
	}
}

func TestUninstallNotSelfNeverMovesTheCopyAside(t *testing.T) {
	r := installed(t)
	asides, _ := runningCopy(t, r)
	_, err := UninstallTask(r.ctx(t), r.h, false)
	if err == nil || !strings.Contains(err.Error(), "image is running") || len(*asides) != 0 {
		t.Fatalf("err = %v, asides %q", err, *asides)
	}
}

func TestUninstallSelfStatesAnAsideThatFailed(t *testing.T) {
	r := installed(t)
	runningCopy(t, r)
	r.h.Aside = func(string) (string, error) { return "", errors.New("rename refused") }
	_, err := UninstallTask(r.ctx(t), r.h, true)
	if err == nil || !strings.Contains(err.Error(), "rename refused") || !strings.Contains(err.Error(), "image is running") {
		t.Fatalf("err = %v", err)
	}
}
