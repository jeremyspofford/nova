package install

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"novad/internal/client"
	"novad/internal/config"
	"novad/internal/platform"
	"novad/internal/state"
)

type fakeService struct {
	installed string
	restarts  int
	later     bool
	onRestart func()
	// stays keeps the definition through an Uninstall that reports nil.
	stays bool
	// laterErr is what RestartLater answers.
	laterErr error
	// stopErr is what Uninstall says of its stop: the definition still goes.
	stopErr error
}

func (f *fakeService) Mode() string             { return "systemd-user" }
func (f *fakeService) Describe() string         { return "a fake service" }
func (f *fakeService) Installed() bool          { return f.installed != "" }
func (f *fakeService) Install(bin string) error { f.installed = bin; return nil }
func (f *fakeService) RestartLater(context.Context, time.Duration) error {
	if f.laterErr != nil {
		return f.laterErr
	}
	f.later = true
	return nil
}
func (f *fakeService) Stop(context.Context) error { return nil }
func (f *fakeService) Uninstall(context.Context) (stopErr, err error) {
	if !f.stays {
		f.installed = ""
	}
	return f.stopErr, nil
}
func (f *fakeService) BootStart(context.Context) (bool, string, error) {
	return true, "starts at boot (linger is on)", nil
}
func (f *fakeService) Restart(context.Context) error {
	f.restarts++
	if f.onRestart != nil {
		f.onRestart()
	}
	return nil
}

// agentCameUp writes what a new supervisor and its agent write once core
// accepted the handshake.
func agentCameUp(p config.Paths, version string, st string, errText string) func() {
	return agentCameUpVia(p, "http://127.0.0.1:3000", version, st, errText)
}

// agentCameUpVia is agentCameUp through a given server — a test that runs
// the real manifest reader points it at its own listener, never at a port
// something else may serve.
func agentCameUpVia(p config.Paths, server, version, st, errText string) func() {
	return func() {
		now := time.Now().UTC()
		_ = state.WriteJSON(filepath.Join(p.StateDir, state.SupervisorStatusFile), state.SupervisorStatus{V: 1, PID: 500, ChildPID: 501, Since: now})
		_ = state.WriteJSON(filepath.Join(p.StateDir, state.AgentStatusFile), state.AgentStatus{
			V: 1, PID: 501, Version: version, State: st, Server: server, Since: now, Error: errText})
	}
}

// installOpts is an install on an enrolled machine whose hub says the
// pairing is alive. Every seam that would reach a network is a stub; Enroll
// fails the test if anything calls it.
func installOpts(t *testing.T) (*Options, *fakeService, *bytes.Buffer) {
	t.Helper()
	p := paths(t)
	enrolled(t, p, "http://127.0.0.1:3000")
	self := filepath.Join(t.TempDir(), platform.BinaryName)
	if err := os.WriteFile(self, []byte("build"), 0o755); err != nil {
		t.Fatal(err)
	}
	svc := &fakeService{}
	var out bytes.Buffer
	return &Options{
		Hubs: []string{"http://127.0.0.1:3000"}, Self: self, Version: "aaaaaaaaaaaa", Paths: p,
		InstallDir: filepath.Join(t.TempDir(), "bin"), Service: svc, Out: &out,
		Verify: func(context.Context, config.Config, ed25519.PrivateKey) error { return nil },
		Enroll: func(context.Context, string, string, string, string, ed25519.PublicKey) (EnrollResult, error) {
			t.Error("this install must not pair")
			return EnrollResult{}, errors.New("no enroll in this test")
		},
		InWSL: func() bool { return false },
		Manifest: func(context.Context, string, string, string) string {
			return "this binary is the hub's build aaaaaaaaaaaa"
		},
		WaitReady: 300 * time.Millisecond, PollEvery: 10 * time.Millisecond,
	}, svc, &out
}

func TestInstallSucceedsOnlyWhenTheNewAgentReportsReady(t *testing.T) {
	o, svc, out := installOpts(t)
	svc.onRestart = agentCameUp(o.Paths, "aaaaaaaaaaaa", state.StateReady, "")
	if err := Install(context.Background(), *o); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"installed:  " + filepath.Join(o.InstallDir, platform.BinaryName), "starts:     a fake service; starts at boot (linger is on)",
		`running:    connected to http://127.0.0.1:3000 as "laptop"`} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}
	if svc.installed != filepath.Join(o.InstallDir, platform.BinaryName) || svc.restarts != 1 {
		t.Fatalf("service %+v", svc)
	}
}

func TestInstallFailsWhenTheAgentNeverReportsReady(t *testing.T) {
	o, _, out := installOpts(t)
	err := Install(context.Background(), *o)
	if err == nil || !strings.Contains(err.Error(), "did not connect within") || !strings.Contains(err.Error(), "has not written a status") {
		t.Fatalf("got %v", err)
	}
	if strings.Contains(out.String(), "running:") {
		t.Fatal("a registration alone must never be reported as running")
	}
}

// Review focus 4: a copy started by hand holds the identity — say whose.
func TestInstallNamesAnotherCopyHoldingTheIdentity(t *testing.T) {
	o, svc, _ := installOpts(t)
	svc.onRestart = agentCameUp(o.Paths, "aaaaaaaaaaaa", state.StateStopped, "another novad (pid 77) holds /x/run.lock")
	err := Install(context.Background(), *o)
	if err == nil || !strings.Contains(err.Error(), "pid 77") {
		t.Fatalf("got %v", err)
	}
}

func TestAnOldBuildReportingReadyIsNotThisInstall(t *testing.T) {
	o, svc, _ := installOpts(t)
	svc.onRestart = agentCameUp(o.Paths, "000000000000", state.StateReady, "")
	if err := Install(context.Background(), *o); err == nil {
		t.Fatal("ready from another build must not count as this install coming up")
	}
}

func TestInstallRefusesInsideWSL(t *testing.T) {
	o, _, _ := installOpts(t)
	o.InWSL = func() bool { return true }
	if err := Install(context.Background(), *o); err == nil || !strings.HasPrefix(err.Error(), "cannot: on Windows") {
		t.Fatalf("got %v", err)
	}
}

func TestIfMissingLeavesARunningAgentAlone(t *testing.T) {
	o, svc, out := installOpts(t)
	bin := filepath.Join(o.InstallDir, platform.BinaryName)
	_ = os.MkdirAll(o.InstallDir, 0o755)
	_ = os.WriteFile(bin, []byte("running build"), 0o755)
	svc.installed = bin
	now := time.Now().UTC()
	_ = state.WriteJSON(filepath.Join(o.Paths.StateDir, state.SupervisorStatusFile), state.SupervisorStatus{V: 1, PID: os.Getpid(), ChildPID: os.Getpid(), Since: now})
	_ = state.WriteJSON(filepath.Join(o.Paths.StateDir, state.AgentStatusFile), state.AgentStatus{V: 1, PID: os.Getpid(), Version: "000000000000", State: state.StateReady, Since: now})
	o.IfMissing = true
	if err := Install(context.Background(), *o); err != nil {
		t.Fatal(err)
	}
	if svc.restarts != 0 || !strings.Contains(out.String(), "left as it is") {
		t.Fatalf("restarts %d out %s", svc.restarts, out.String())
	}
	if b, _ := os.ReadFile(bin); string(b) != "running build" {
		t.Fatal("--if-missing replaced a running agent's binary")
	}
}

func TestRestartLaterSchedulesTheRestartAndDoesNotClaimIt(t *testing.T) {
	o, svc, out := installOpts(t)
	o.RestartLater = true
	if err := Install(context.Background(), *o); err != nil {
		t.Fatal(err)
	}
	if !svc.later || svc.restarts != 0 || !strings.Contains(out.String(), "confirmed only when the agent reconnects") {
		t.Fatalf("later %v restarts %d out %s", svc.later, svc.restarts, out.String())
	}
}

// A restart that cannot be scheduled comes after the build was placed and the
// service definition rewritten: the error says so, so the command running
// this install is never read as "nothing changed" (on Windows the Run key
// refuses a delayed restart).
func TestARestartThatCannotBeScheduledSaysTheBuildIsAlreadyInPlace(t *testing.T) {
	o, svc, _ := installOpts(t)
	o.RestartLater = true
	svc.laterErr = errors.New("cannot: a Windows agent updates through its supervisor, never by a delayed restart")
	err := Install(context.Background(), *o)
	bin := filepath.Join(o.InstallDir, platform.BinaryName)
	if err == nil || !errors.Is(err, svc.laterErr) || !strings.Contains(err.Error(), "installed "+bin+", but the restart could not be scheduled") ||
		!strings.Contains(err.Error(), "until the service next starts") {
		t.Fatalf("got %v", err)
	}
	if mustRead(t, bin) != "build" || svc.installed != bin {
		t.Fatalf("the setup did not place the build and register it: service %+v", svc)
	}
}

// F2 (controller ruling, P11): `install --restart-later` runs inside the old
// agent's own shell.exec, and that agent's live, authenticated session is the
// proof of the pairing. A second socket as the same device would make core's
// hub fail the very command running this install — the update would be
// logged refused while it went ahead — so the restart-later path dials no hub
// at all. The hub counts every TCP connection it accepts; the verifier and
// the manifest reader are the real ones (a zero seam takes them); and the
// control run proves a plain install of the same setup DOES dial it, so the
// zero is meaningful.
func TestRestartLaterTrustsThePairingItRunsUnderAndDialsNoHub(t *testing.T) {
	var dials atomic.Int32
	hub := httptest.NewUnstartedServer(http.NotFoundHandler())
	hub.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			dials.Add(1)
		}
	}
	hub.Start()
	t.Cleanup(hub.Close)

	runInstall := func(later bool) (int32, string, error) {
		o, svc, out := installOpts(t)
		enrolled(t, o.Paths, hub.URL)
		o.Hubs = nil // P11's argv passes no --hub: the pairing's own addresses are the hubs
		o.Verify, o.Manifest = nil, nil
		o.RestartLater = later
		svc.onRestart = agentCameUpVia(o.Paths, hub.URL, o.Version, state.StateReady, "")
		before := dials.Load()
		err := Install(context.Background(), *o)
		return dials.Load() - before, out.String(), err
	}

	n, out, err := runInstall(true)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("install --restart-later dialed the hub %d time(s) — a second socket as this device fails the command running it", n)
	}
	if !strings.Contains(out, "without asking Nova whether it still knows it") {
		t.Fatalf("the output must say the pairing was kept unchecked:\n%s", out)
	}

	if n, _, err := runInstall(false); n == 0 {
		t.Fatalf("the control never dialed the hub (err %v), so the check above proves nothing", err)
	}
}

// Controller ruling (Task 11's review): identity can set a dead pairing
// aside BEFORE the pairing that replaces it fails. That is true on disk
// whatever happens next, so Install says it on its error path too.
func TestInstallSaysThePairingItSetAsideWhenPairingThenFails(t *testing.T) {
	o, svc, out := installOpts(t)
	o.Code = "ABCD-2345"
	o.Now = func() time.Time { return time.Unix(1_790_000_000, 0) }
	o.Verify = func(context.Context, config.Config, ed25519.PrivateKey) error {
		return &client.RefusedError{Server: "x", Reason: "revoked"}
	}
	o.Enroll = func(context.Context, string, string, string, string, ed25519.PublicKey) (EnrollResult, error) {
		return EnrollResult{}, &EnrollRefused{Status: 403, Reason: "that pairing code is not usable"}
	}
	err := Install(context.Background(), *o)
	if err == nil || !strings.Contains(err.Error(), "enrollment refused (403): that pairing code is not usable") {
		t.Fatalf("got %v", err)
	}
	if _, serr := os.Stat(o.Paths.ConfigFile + ".replaced-1790000000"); serr != nil {
		t.Fatalf("the setup did not set the pairing aside: %v", serr)
	}
	if !strings.Contains(out.String(), "set the old pairing aside ("+o.Paths.ConfigFile+".replaced-1790000000") {
		t.Fatalf("a pairing set aside must be said even when the install fails:\n%s", out.String())
	}
	if svc.installed != "" || svc.restarts != 0 {
		t.Fatalf("nothing is registered after a failed pairing: %+v", svc)
	}
}

// Task 32, L225 + L243: a set-aside that fails partway has still moved what
// it moved. Those files are set aside on disk whatever happens next, so
// Install says them on its error path — never dropped with the error. The
// audit log's name sits at the 255-byte limit, so no set-aside name can
// exist beside it: SetAside moves the config and the key, then fails.
func TestInstallSaysWhatAPartialSetAsideMoved(t *testing.T) {
	o, svc, out := installOpts(t)
	o.Paths.AuditFile = filepath.Join(o.Paths.StateDir, strings.Repeat("a", 250))
	if err := os.WriteFile(o.Paths.AuditFile, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	o.Code = "ABCD-2345"
	o.Now = func() time.Time { return time.Unix(1_790_000_000, 0) }
	o.Verify = func(context.Context, config.Config, ed25519.PrivateKey) error {
		return &client.RefusedError{Server: "x", Reason: "revoked"}
	}
	err := Install(context.Background(), *o)
	if err == nil || !strings.Contains(err.Error(), "setting the old pairing aside") {
		t.Fatalf("got %v", err)
	}
	for _, moved := range []string{o.Paths.ConfigFile + ".replaced-1790000000", o.Paths.KeyFile + ".replaced-1790000000"} {
		if _, serr := os.Stat(moved); serr != nil {
			t.Fatalf("the setup did not move %s: %v", moved, serr)
		}
		if !strings.Contains(out.String(), moved) {
			t.Errorf("%s was set aside and not said:\n%s", moved, out.String())
		}
	}
	if svc.installed != "" {
		t.Fatalf("nothing is registered after a failed set-aside: %+v", svc)
	}
}

// The same holds for every step after identity: a pairing made or set aside
// is on disk whether or not the agent then comes up.
func TestInstallSaysWhatItDidToThePairingWhenTheAgentThenNeverComesUp(t *testing.T) {
	o, _, out := installOpts(t)
	o.Code = "ABCD-2345"
	o.Verify = func(context.Context, config.Config, ed25519.PrivateKey) error {
		return &client.RefusedError{Server: "x", Reason: "revoked"}
	}
	o.Enroll = func(context.Context, string, string, string, string, ed25519.PublicKey) (EnrollResult, error) {
		return EnrollResult{DeviceID: "d-new", Name: "laptop", CorePubKey: strings.Repeat(core, 32), Repaired: true}, nil
	}
	err := Install(context.Background(), *o)
	if err == nil || !strings.Contains(err.Error(), "did not connect within") {
		t.Fatalf("got %v", err)
	}
	for _, want := range []string{"set the old pairing aside", `re-paired as "laptop"`} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}
	if strings.Contains(out.String(), "running:") {
		t.Fatal("an agent that never came up must never be reported as running")
	}
}

// Options says zero-valued seams take the real implementations; defaults()
// is what makes that true, and a seam that was set is kept.
func TestAZeroOptionsTakesTheRealSeams(t *testing.T) {
	var o Options
	o.defaults()
	same := func(got, want any) bool {
		g := reflect.ValueOf(got)
		return !g.IsNil() && g.Pointer() == reflect.ValueOf(want).Pointer()
	}
	for name, isReal := range map[string]bool{
		"Verify":   same(o.Verify, client.VerifyServer),
		"Enroll":   same(o.Enroll, Enroll),
		"Now":      same(o.Now, time.Now),
		"Alive":    same(o.Alive, platform.ProcessAlive),
		"Manifest": same(o.Manifest, CheckManifest),
	} {
		if !isReal {
			t.Errorf("a zero Options' %s is not the real one", name)
		}
	}
	inWSL, _ := platform.WSL()
	if o.InWSL == nil || o.InWSL() != inWSL {
		t.Error("a zero Options' InWSL is not platform.WSL's answer")
	}
	if o.WaitReady != 60*time.Second || o.PollEvery != 500*time.Millisecond || o.Out != os.Stdout {
		t.Errorf("WaitReady %s, PollEvery %s, Out %v", o.WaitReady, o.PollEvery, o.Out)
	}

	fixed := time.Unix(1_790_000_000, 0)
	o = Options{Now: func() time.Time { return fixed }}
	o.defaults()
	if !o.Now().Equal(fixed) {
		t.Fatal("defaults() replaced a seam that was set")
	}
}

func TestUninstallRemovesTheServiceAndBinaryAndKeepsTheIdentity(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "http://127.0.0.1:3000")
	dir := t.TempDir()
	bin := filepath.Join(dir, platform.BinaryName)
	_ = os.WriteFile(bin, []byte("x"), 0o755)
	_ = os.WriteFile(bin+".prev", []byte("y"), 0o755)
	svc := &fakeService{installed: bin}
	var out bytes.Buffer
	if err := Uninstall(context.Background(), UninstallOptions{Paths: p, InstallDir: dir, Service: svc, Now: time.Now, Out: &out}); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{bin, bin + ".prev"} {
		if _, err := os.Stat(f); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s is still there", f)
		}
	}
	if svc.Installed() {
		t.Fatal("the service is still registered")
	}
	if _, err := os.Stat(p.ConfigFile); err != nil {
		t.Fatal("uninstall keeps the pairing unless --forget")
	}
	if !strings.Contains(out.String(), `Nova still lists "laptop" as paired`) || !strings.Contains(out.String(), "Settings → Devices") {
		t.Fatalf("out:\n%s", out.String())
	}
}

func TestUninstallForgetSetsThePairingAside(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "http://127.0.0.1:3000")
	var out bytes.Buffer
	if err := Uninstall(context.Background(), UninstallOptions{Paths: p, InstallDir: t.TempDir(), Service: &fakeService{}, Forget: true, Now: time.Now, Out: &out}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.ConfigFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("--forget must set the pairing aside")
	}
}

// Controller ruling (Task 11's carry): place leaves each build it replaced as
// <bin>.old-<nanos> — it may still be running — and supervise leaves
// <bin>.prev.old-<nanos> and <bin>.failed.old-<nanos>. Uninstall removes them
// all, and says each one it removed. One it cannot remove is left and said,
// with the reason, never counted as removed; a file that only looks like one
// of those builds is not touched.
func TestUninstallRemovesTheBuildsLeftAsideAndSaysWhichItCouldNot(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "http://127.0.0.1:3000")
	dir := t.TempDir()
	bin := filepath.Join(dir, platform.BinaryName)
	gone := []string{bin, bin + ".old-1790000000000000001", bin + ".prev.old-1790000000000000002", bin + ".failed.old-1790000000000000003"}
	kept := []string{bin + ".old-backup", filepath.Join(dir, "other.old-1790000000000000004")}
	for _, f := range append(append([]string{}, gone...), kept...) {
		if err := os.WriteFile(f, []byte("a build"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// No OS removes a non-empty directory: it stands in for a build a process
	// still runs from, which Windows will not delete.
	held := bin + ".old-1790000000000000005"
	if err := os.MkdirAll(filepath.Join(held, "inside"), 0o755); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Uninstall(context.Background(), UninstallOptions{Paths: p, InstallDir: dir, Service: &fakeService{installed: bin}, Now: time.Now, Out: &out}); err != nil {
		t.Fatal(err)
	}
	for _, f := range gone {
		if _, err := os.Lstat(f); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s is still there", f)
		}
		if !strings.Contains(out.String(), "removed:    "+f+"\n") {
			t.Errorf("the removal of %s is not said:\n%s", f, out.String())
		}
	}
	for _, f := range kept {
		if _, err := os.Lstat(f); err != nil {
			t.Errorf("%s is not a build uninstall left aside, and it was touched: %v", f, err)
		}
		if strings.Contains(out.String(), f) {
			t.Errorf("%s is not a build uninstall left aside, and it was named:\n%s", f, out.String())
		}
	}
	if _, err := os.Lstat(held); err != nil {
		t.Fatalf("the setup's held build is gone: %v", err)
	}
	if strings.Contains(out.String(), "removed:    "+held) {
		t.Fatalf("a build that could not be removed was reported removed:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "left:       "+held+" — it could not be removed (") {
		t.Fatalf("a build left behind must be named with its reason:\n%s", out.String())
	}
}

// After a revoke the agent wipes its identity; "Nova still lists it as
// paired" would then be false (Settings shows it revoked). Uninstall says
// what this machine holds, never a pairing it does not have.
func TestUninstallNeverSaysNovaListsAPairingThisMachineDoesNotHold(t *testing.T) {
	var out bytes.Buffer
	if err := Uninstall(context.Background(), UninstallOptions{Paths: paths(t), InstallDir: t.TempDir(), Service: &fakeService{}, Now: time.Now, Out: &out}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "still lists") || !strings.Contains(out.String(), "no pairing is on this machine") {
		t.Fatalf("out:\n%s", out.String())
	}
}

// The service definition names the binary by the install directory's path,
// and uninstall removes files by it: a relative one would be resolved against
// wherever the command happened to run. Both refuse it before touching
// anything.
func TestARelativeInstallDirIsRefusedBeforeAnythingIsTouched(t *testing.T) {
	t.Chdir(t.TempDir())
	o, svc, _ := installOpts(t)
	o.InstallDir = "bin"
	if err := Install(context.Background(), *o); err == nil || !strings.Contains(err.Error(), "absolute install directory") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Lstat("bin"); !errors.Is(err, os.ErrNotExist) || svc.installed != "" {
		t.Fatalf("install touched a relative path: %v, service %+v", err, svc)
	}

	if err := os.WriteFile(platform.BinaryName, []byte("someone's file"), 0o755); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := Uninstall(context.Background(), UninstallOptions{Paths: paths(t), InstallDir: ".", Service: &fakeService{}, Now: time.Now, Out: &out})
	if err == nil || !strings.Contains(err.Error(), "absolute install directory") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Lstat(platform.BinaryName); err != nil {
		t.Fatalf("uninstall removed a file by a relative path: %v", err)
	}
}

// A service manager that reports success but still has the definition is not
// "removed": uninstall reads it back and says so.
func TestUninstallReadsTheServiceBackBeforeSayingItIsRemoved(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	err := Uninstall(context.Background(), UninstallOptions{Paths: paths(t), InstallDir: dir,
		Service: &fakeService{installed: filepath.Join(dir, platform.BinaryName), stays: true}, Now: time.Now, Out: &out})
	if err == nil || !strings.Contains(err.Error(), "is still registered") {
		t.Fatalf("got %v", err)
	}
	if strings.Contains(out.String(), "removed:    the service") {
		t.Fatalf("a service still registered was reported removed:\n%s", out.String())
	}
}

// Task 32, L90 + L242: a stop that failed is said — the agent may still be
// running — and "(offline from now on)" is not. The definition still comes
// out, read back and said, so an agent that would not stop does not also
// start again at the next sign-in.
func TestUninstallNeverSaysOfflineAfterAStopThatFailed(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "http://127.0.0.1:3000")
	dir := t.TempDir()
	stopErr := errors.New("systemctl --user disable --now novad.service: exit status 1: Failed to connect to bus")
	var out bytes.Buffer
	err := Uninstall(context.Background(), UninstallOptions{Paths: p, InstallDir: dir,
		Service: &fakeService{installed: filepath.Join(dir, platform.BinaryName), stopErr: stopErr}, Now: time.Now, Out: &out})
	if err == nil || !errors.Is(err, stopErr) || !strings.Contains(err.Error(), "may still be running") {
		t.Fatalf("a stop that failed must be returned, saying the agent may still be running: %v", err)
	}
	if strings.Contains(out.String(), "offline from now on") {
		t.Fatalf("offline was claimed after a stop that failed:\n%s", out.String())
	}
	for _, want := range []string{"removed:    the service (systemd-user)\n", `Nova still lists "laptop" as paired, and its agent may still be running`} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}
}

// "(offline from now on)" is what this run did: it stopped a service that was
// registered and removed it. With no service, nothing was stopped here; with
// the definition still there, the service starts again at the next sign-in.
func TestUninstallSaysOfflineOnlyWhenItStoppedAndRemovedTheService(t *testing.T) {
	for _, tc := range []struct {
		name    string
		svc     func(bin string) *fakeService
		offline bool
	}{
		{"stopped and removed", func(bin string) *fakeService { return &fakeService{installed: bin} }, true},
		{"no service was registered", func(string) *fakeService { return &fakeService{} }, false},
		{"the definition is still there", func(bin string) *fakeService { return &fakeService{installed: bin, stays: true} }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := paths(t)
			enrolled(t, p, "http://127.0.0.1:3000")
			dir := t.TempDir()
			var out bytes.Buffer
			_ = Uninstall(context.Background(), UninstallOptions{Paths: p, InstallDir: dir,
				Service: tc.svc(filepath.Join(dir, platform.BinaryName)), Now: time.Now, Out: &out})
			if got := strings.Contains(out.String(), "(offline from now on)"); got != tc.offline {
				t.Fatalf("offline said = %v, want %v:\n%s", got, tc.offline, out.String())
			}
			if !strings.Contains(out.String(), `Nova still lists "laptop" as paired`) {
				t.Fatalf("the pairing line is missing:\n%s", out.String())
			}
		})
	}
}

// The installed build itself may be in use (on Windows, uninstall run from
// it): it is moved aside and said so — never reported removed — and the build
// moved aside is not swept up again in the same run.
func TestUninstallMovesABuildItCannotRemoveAsideAndSaysSo(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, platform.BinaryName)
	// No OS removes a non-empty directory; a rename still moves it.
	if err := os.MkdirAll(filepath.Join(bin, "inside"), 0o755); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Uninstall(context.Background(), UninstallOptions{Paths: paths(t), InstallDir: dir, Service: &fakeService{}, Now: time.Now, Out: &out}); err != nil {
		t.Fatal(err)
	}
	olds, err := oldBuilds(dir, platform.BinaryName)
	if err != nil || len(olds) != 1 {
		t.Fatalf("want the one build moved aside, got %v (%v)", olds, err)
	}
	if !strings.Contains(out.String(), "moved:      "+bin+" to "+olds[0]+" — it could not be removed (") {
		t.Fatalf("the move is not said:\n%s", out.String())
	}
	if strings.Contains(out.String(), "removed:    "+bin) || strings.Contains(out.String(), "left:") {
		t.Fatalf("a build moved aside was reported removed, or tried again:\n%s", out.String())
	}
}
