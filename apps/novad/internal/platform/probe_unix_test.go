//go:build unix

package platform

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Fix round 1, I1: the probes' Exec has a WaitDelay because a grandchild can
// hold a program's output pipes after the program itself has gone — here
// sh backgrounds a sleep that keeps stdout open. Without it the call waits
// out the sleep.
func TestExecsWaitDelayEndsAWaitAGrandchildHolds(t *testing.T) {
	start := time.Now()
	out, err := Exec{WaitDelay: 200 * time.Millisecond}.Run(context.Background(), "/bin/sh",
		[]string{"-c", "sleep 3 & echo started"}, "")
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("the call waited %s on a grandchild holding its pipe", took)
	}
	if out != "started\n" || !errors.Is(err, exec.ErrWaitDelay) {
		t.Fatalf("got %q, %v", out, err)
	}
}

// fakeBin writes programs into a directory of their own; a script run with
// PATH set to it alone finds these and nothing else — never the real sudo.
func fakeBin(t *testing.T, progs map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range progs {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// runLook runs WSLLookScript under a real /bin/sh against fakeBin's programs.
func runLook(t *testing.T, progs map[string]string) (WSLInside, string) {
	t.Helper()
	dir := fakeBin(t, progs)
	cmd := exec.Command("/bin/sh", "-c", WSLLookScript)
	cmd.Env = []string{"PATH=" + dir, "HOME=" + dir, "XDG_RUNTIME_DIR=" + dir}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("the look failed under sh: %v\n%s", err, out)
	}
	return ParseWSLInside(string(out)), string(out)
}

const fakeSystemctl = "printf 'ActiveState=active\\nUnitFileState=enabled\\nMainPID=412\\nRestart=always\\n'\n"

// Fix round 1, Minor 6: the look itself, run by a real sh. A refusing
// sudo's first line comes back; a missing or failing pgrep is pids=?, never
// an empty list; pids= is always the last line.
func TestTheLookScriptUnderShSaysWhatItCouldNot(t *testing.T) {
	refusing := "echo 'sudo: a password is required' >&2\necho 'sudo: second line' >&2\nexit 1\n"
	cases := []struct {
		name  string
		progs map[string]string
		want  WSLInside
	}{
		{"sudo refuses, no pgrep", map[string]string{"sudo": refusing, "systemctl": fakeSystemctl},
			WSLInside{Sudo: "refused", SudoSaid: "sudo: a password is required", PIDsUnknown: true}},
		{"no password needed, two agents", map[string]string{"sudo": "exit 0\n", "systemctl": fakeSystemctl,
			"pgrep": "printf '412\\n413\\n'\n"},
			WSLInside{Sudo: "no_password", PIDs: []int{412, 413}}},
		{"no novad process", map[string]string{"sudo": "exit 0\n", "systemctl": fakeSystemctl, "pgrep": "exit 1\n"},
			WSLInside{Sudo: "no_password"}},
		{"pgrep fails", map[string]string{"sudo": "exit 0\n", "systemctl": fakeSystemctl, "pgrep": "echo bad >&2\nexit 2\n"},
			WSLInside{Sudo: "no_password", PIDsUnknown: true}},
		{"no sudo here", map[string]string{"systemctl": fakeSystemctl, "pgrep": "exit 1\n"},
			WSLInside{Sudo: "absent"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, out := runLook(t, c.progs)
			rows := strings.Split(strings.TrimSpace(out), "\n")
			if !strings.HasPrefix(rows[len(rows)-1], "pids=") {
				t.Fatalf("the last line is not pids=:\n%s", out)
			}
			if got.UnitActive != "active" || got.UnitMainPID != 412 {
				t.Fatalf("the unit lines did not come through:\n%s", out)
			}
			got.PID1, got.User, got.UnitActive, got.UnitFile, got.UnitRestart, got.UnitMainPID = "", "", "", "", "", 0
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %+v\nwant %+v\n%s", got, c.want, out)
			}
		})
	}
}

// Fix round 2: exec.ErrWaitDelay is the exit 0 Go reports for a program that
// succeeded while a descendant still held its output pipes. Run for real —
// a fake sudo and a fake wsl.exe, found on a PATH of their own, background
// a sleep that keeps the pipe and exit 0 — it reads as success, never as a
// refusal or a failed list. A fake that exits 1 the same way still refuses.
func TestAProgramThatExitedZeroWhileADescendantHeldItsOutputAnswered(t *testing.T) {
	holdsPipe := "PATH=/usr/bin:/bin\nsleep 2 &\n"
	dir := fakeBin(t, map[string]string{
		"sudo":    holdsPipe + "exit 0\n",
		"wsl.exe": holdsPipe + "echo Ubuntu-26.04\nexit 0\n",
	})
	t.Setenv("PATH", dir)
	r := Exec{WaitDelay: 200 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if e, err := Elevation(ctx, r); err != nil || e.Sudo != "no_password" {
		t.Fatalf("a sudo that exited 0 read as %+v, %v", e, err)
	}
	if out, err := RunWSL(ctx, r, "--list", "--running", "--quiet"); err != nil || out != "Ubuntu-26.04\n" {
		t.Fatalf("a wsl.exe list that exited 0 read as %q, %v", out, err)
	}
	refusing := fakeBin(t, map[string]string{"sudo": holdsPipe + "echo 'sudo: a password is required' >&2\nexit 1\n"})
	t.Setenv("PATH", refusing)
	if e, err := Elevation(ctx, r); err != nil || e.Sudo != "refused" || e.Said != "sudo: exit status 1: sudo: a password is required" {
		t.Fatalf("a sudo that exited 1 read as %+v, %v", e, err)
	}
}
