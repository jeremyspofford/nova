//go:build unix

package caps

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// admin.exec's unix route (S30b T3) over a fake `sudo` script: it logs
// each call's argv, answers `-n -l` with listExit, and otherwise prints
// body and exits runExit. Never real sudo.
type fakeSudo struct {
	path, log, copy string
}

func newFakeSudo(t *testing.T, listExit, runExit int, body string) fakeSudo {
	t.Helper()
	dir := t.TempDir()
	f := fakeSudo{path: filepath.Join(dir, "sudo"), log: filepath.Join(dir, "calls"), copy: filepath.Join(dir, "novad-root-copy")}
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> '%s'
if [ "$2" = "-l" ]; then exit %d; fi
printf '%%s' '%s'
exit %d
`, f.log, listExit, body, runExit)
	if err := os.WriteFile(f.path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.copy, []byte("root copy"), 0o755); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f fakeSudo) deps(t *testing.T) Deps {
	d := testDeps(t)
	d.Admin = &AdminDeps{Sudo: f.path, Copy: f.copy}
	return d
}

func (f fakeSudo) calls(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(f.log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n")
}

func TestAdminExecNoRootCopyIsTheStatedCannot(t *testing.T) {
	f := newFakeSudo(t, 0, 0, "")
	if err := os.Remove(f.copy); err != nil {
		t.Fatal(err)
	}
	out := Dispatch(withDeadline(t, time.Minute), "admin.exec", map[string]any{"argv": []any{"id"}}, f.deps(t))
	if out.OK || out.Error != "cannot: no admin path on this machine" {
		t.Fatalf("got ok=%v error=%q", out.OK, out.Error)
	}
	if c := f.calls(t); len(c) != 0 {
		t.Fatalf("sudo ran with no root copy: %q", c)
	}
}

func TestAdminExecSudoRefusingIsTheStatedCannot(t *testing.T) {
	f := newFakeSudo(t, 1, 0, "")
	out := Dispatch(withDeadline(t, time.Minute), "admin.exec", map[string]any{"argv": []any{"id"}}, f.deps(t))
	if out.OK || out.Error != "cannot: no admin path on this machine" {
		t.Fatalf("got ok=%v error=%q", out.OK, out.Error)
	}
	c := f.calls(t)
	if len(c) != 1 || c[0] != "-n -l "+f.copy+" admin exec" {
		t.Fatalf("want exactly the list check, got %q", c)
	}
}

func TestAdminExecRunsThroughTheRootCopy(t *testing.T) {
	f := newFakeSudo(t, 0, 7, "elevated output")
	out := Dispatch(withDeadline(t, 30*time.Second), "admin.exec",
		wireArgs(t, `{"argv": ["apt-get", "install", "-y", "htop"], "cwd": "/srv"}`), f.deps(t))
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 7 {
		t.Fatalf("a run that completed is ok:true with its code: ok=%v code=%v err=%q", out.OK, out.ExitCode, out.Error)
	}
	if !strings.Contains(out.Output, "elevated output") || !strings.Contains(out.Output, "[process exited with code 7]") {
		t.Fatalf("output %q", out.Output)
	}
	c := f.calls(t)
	if len(c) != 2 {
		t.Fatalf("want the list check then the run, got %q", c)
	}
	// ctx 30 s minus the 2 s margin, whole seconds: 27 or 28.
	want27 := "-n " + f.copy + " admin exec --timeout 27 --cwd /srv -- apt-get install -y htop"
	want28 := strings.Replace(want27, "--timeout 27", "--timeout 28", 1)
	if c[1] != want27 && c[1] != want28 {
		t.Fatalf("run argv = %q, want %q", c[1], want28)
	}
	m := out.Meta
	if m["elevated"] != true || m["kind"] != "sudoers" || m["ran_as"] != "root" {
		t.Fatalf("meta = %v", m)
	}
}

func TestAdminExecWithoutCwdSendsNoCwdFlag(t *testing.T) {
	f := newFakeSudo(t, 0, 0, "ok")
	out := Dispatch(withDeadline(t, time.Minute), "admin.exec", wireArgs(t, `{"argv": ["id", "-u"], "timeout_s": 5}`), f.deps(t))
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 0 {
		t.Fatalf("ok=%v code=%v err=%q", out.OK, out.ExitCode, out.Error)
	}
	c := f.calls(t)
	if len(c) != 2 || c[1] != "-n "+f.copy+" admin exec --timeout 5 -- id -u" {
		t.Fatalf("calls %q", c)
	}
}

func TestAdminExecRootSideTimeoutIsOkFalse(t *testing.T) {
	f := newFakeSudo(t, 0, 124, "partial\nnovad: admin exec: timed out after 5s\n")
	out := Dispatch(withDeadline(t, time.Minute), "admin.exec", wireArgs(t, `{"argv": ["sleep", "99"], "timeout_s": 5}`), f.deps(t))
	if out.OK || !strings.Contains(out.Error, "timed out") || !strings.Contains(out.Error, "partial") {
		t.Fatalf("got ok=%v error=%q", out.OK, out.Error)
	}
}

func TestAdminExecAChildsOwn124IsItsExitCode(t *testing.T) {
	f := newFakeSudo(t, 0, 124, "the child said 124")
	out := Dispatch(withDeadline(t, time.Minute), "admin.exec", map[string]any{"argv": []any{"x"}}, f.deps(t))
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 124 {
		t.Fatalf("a child's own 124 with no timeout line is its exit code: ok=%v code=%v err=%q", out.OK, out.ExitCode, out.Error)
	}
}

// The twin of the 124 case: a child that ran and exited 127 itself (e.g. a
// shell's "command not found"), with no root-side line, is the child's
// exit code — ok:true 127, never the root side's "could not run".
func TestAdminExecAChildsOwn127IsItsExitCode(t *testing.T) {
	f := newFakeSudo(t, 0, 127, "sh: 1: nope: not found")
	out := Dispatch(withDeadline(t, time.Minute), "admin.exec", map[string]any{"argv": []any{"sh", "-c", "nope"}}, f.deps(t))
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 127 {
		t.Fatalf("a child's own 127 with no root-side line is its exit code: ok=%v code=%v err=%q", out.OK, out.ExitCode, out.Error)
	}
	if !strings.Contains(out.Output, "nope: not found") {
		t.Fatalf("the child's own words are its output: %q", out.Output)
	}
}

func TestAdminExecBadArgsRunNothing(t *testing.T) {
	f := newFakeSudo(t, 0, 0, "")
	out := Dispatch(withDeadline(t, time.Minute), "admin.exec", wireArgs(t, `{"argv": ["x"], "timeout_s": 1.5}`), f.deps(t))
	if out.OK || !strings.Contains(out.Error, "timeout_s") {
		t.Fatalf("ok=%v error=%q", out.OK, out.Error)
	}
	if c := f.calls(t); len(c) != 0 {
		t.Fatalf("sudo ran on bad args: %q", c)
	}
}

// The real machine's defaults: sudo by name and the T1 root copy's path.
func TestAdminExecDefaultsAreTheT1Path(t *testing.T) {
	sudo, copyPath := adminUnixDefaults(nil)
	if sudo != "sudo" || copyPath != "/usr/local/libexec/nova/novad" {
		t.Fatalf("defaults %q %q", sudo, copyPath)
	}
}

// The root side could not start argv (admin.go exits 127 with its line):
// the daemon could not perform it — ok:false, as shell.exec's "could not run".
func TestAdminExecRootSideStartFailureIsOkFalse(t *testing.T) {
	f := newFakeSudo(t, 0, 127, "novad: admin exec: exec: \"nope\": executable file not found\n")
	out := Dispatch(withDeadline(t, time.Minute), "admin.exec", map[string]any{"argv": []any{"nope"}}, f.deps(t))
	if out.OK || !strings.Contains(out.Error, "could not run") || !strings.Contains(out.Error, "executable file not found") {
		t.Fatalf("got ok=%v error=%q", out.OK, out.Error)
	}
}
