//go:build unix

package caps

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakeDockerBin is a docker stand-in for box.exec's exec: it prints each
// argument on its own line, then NOVA_FAKE_OUT bytes of 'a', sleeps
// NOVA_FAKE_SLEEP seconds and exits NOVA_FAKE_EXIT. It leaves a mark file
// so a test can tell it never ran.
func fakeDockerBin(t *testing.T) (bin, mark string) {
	t.Helper()
	dir := t.TempDir()
	bin = filepath.Join(dir, "docker")
	mark = filepath.Join(dir, "ran")
	script := "#!/bin/sh\n: > '" + mark + "'\nprintf '%s\\n' \"$@\"\n" +
		"[ -n \"$NOVA_FAKE_OUT\" ] && head -c \"$NOVA_FAKE_OUT\" /dev/zero | tr '\\0' a\n" +
		"[ -n \"$NOVA_FAKE_SLEEP\" ] && sleep \"$NOVA_FAKE_SLEEP\"\nexit \"${NOVA_FAKE_EXIT:-0}\"\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, mark
}

func TestBoxExecRunsTheArgvInTheBoxAsTheOwner(t *testing.T) {
	bin, _ := fakeDockerBin(t)
	cwd := bWorktree + "/services/core"
	out := Dispatch(context.Background(), "box.exec",
		boxArgs(t, `, "argv": ["uv", "run", "pytest", "-k", "a b"], "cwd": "`+cwd+`"`), boxDeps(warm(), bin))
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 0 {
		t.Fatalf("ok=%v exit=%v err=%q", out.OK, out.ExitCode, out.Error)
	}
	want := strings.Join([]string{"exec", "-w", cwd, "-u", "1234:5678", "nova-box-c0ffee", "uv", "run", "pytest", "-k", "a b"}, "\n") + "\n"
	if out.Output != want {
		t.Fatalf("docker got\n%q\nwant\n%q", out.Output, want)
	}
	wantMeta := map[string]any{"ran_in": "box", "box": "nova-box-c0ffee", "image": bTag, "heavy": false, "lock_waited_s": 0}
	if !reflect.DeepEqual(out.Meta, wantMeta) {
		t.Fatalf("meta = %v, want %v", out.Meta, wantMeta)
	}
}

func TestBoxExecReportsTheImageTheRunningBoxHas(t *testing.T) {
	bin, _ := fakeDockerBin(t)
	s := warm()
	s.ps = "nova-box-c0ffee\trunning\tnova-devbox:t-old\nnova-box-c0ffee-db\trunning\tpg\n"
	out := Dispatch(context.Background(), "box.exec", boxArgs(t, `, "argv": ["true"], "cwd": "`+bWorktree+`"`), boxDeps(s, bin))
	if !out.OK || out.Meta["image"] != "nova-devbox:t-old" {
		t.Fatalf("ok=%v meta=%v err=%q", out.OK, out.Meta, out.Error)
	}
}

func TestBoxExecCarriesANonzeroExitAsARun(t *testing.T) {
	bin, _ := fakeDockerBin(t)
	t.Setenv("NOVA_FAKE_EXIT", "3")
	out := Dispatch(context.Background(), "box.exec", boxArgs(t, `, "argv": ["false"], "cwd": "`+bWorktree+`"`), boxDeps(warm(), bin))
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 3 || !strings.Contains(out.Output, "[process exited with code 3]") {
		t.Fatalf("ok=%v exit=%v out=%q err=%q", out.OK, out.ExitCode, out.Output, out.Error)
	}
	if out.Meta["ran_in"] != "box" {
		t.Fatalf("meta = %v", out.Meta)
	}
}

func TestBoxExecKeepsTheOutputCapAndTimeoutWords(t *testing.T) {
	bin, _ := fakeDockerBin(t)
	t.Setenv("NOVA_FAKE_OUT", "70000")
	out := Dispatch(context.Background(), "box.exec", boxArgs(t, `, "argv": ["yes"], "cwd": "`+bWorktree+`"`), boxDeps(warm(), bin))
	if !out.OK || !strings.HasSuffix(out.Output, "[truncated at 64 KiB]") {
		t.Fatalf("cap: ok=%v tail=%q", out.OK, out.Output[max(0, len(out.Output)-40):])
	}

	t.Setenv("NOVA_FAKE_OUT", "")
	t.Setenv("NOVA_FAKE_SLEEP", "5")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	slow := Dispatch(ctx, "box.exec", boxArgs(t, `, "argv": ["sleep", "5"], "cwd": "`+bWorktree+`"`), boxDeps(warm(), bin))
	if slow.OK || !strings.HasPrefix(slow.Error, "timed out") {
		t.Fatalf("timeout: ok=%v err=%q", slow.OK, slow.Error)
	}
	if slow.Meta["ran_in"] != "box" || slow.Meta["box"] != "nova-box-c0ffee" {
		t.Fatalf("an exec that was attempted carries its meta: %v", slow.Meta)
	}
}

func TestBoxExecThatCannotStartNeverExecs(t *testing.T) {
	bin, mark := fakeDockerBin(t)
	out := Dispatch(context.Background(), "box.exec", boxArgs(t, `, "argv": ["true"], "cwd": "`+bWorktree+`"`), boxDeps(&scripted{image: ""}, bin))
	if out.OK {
		t.Fatal("an absent image ran")
	}
	if _, err := os.Stat(mark); !os.IsNotExist(err) {
		t.Fatalf("the exec ran although the box could not start (%v)", err)
	}
}

// T7 C1: box.exec touches the box again when its exec returns, so a long run
// counts its idle time from its end, not from the bring-up.
func TestBoxExecTouchesTheBoxWhenTheExecReturns(t *testing.T) {
	bin, _ := fakeDockerBin(t)
	deps := boxDeps(warm(), bin)
	var calls int
	var last time.Time
	deps.Box.Now = func() time.Time {
		calls++
		last = time.Unix(1e9, 0).Add(time.Duration(calls) * time.Minute)
		return last
	}
	out := Dispatch(context.Background(), "box.exec", boxArgs(t, `, "argv": ["true"], "cwd": "`+bWorktree+`"`), deps)
	if !out.OK {
		t.Fatalf("err=%q", out.Error)
	}
	got, ok := deps.Box.LastUse("c0ffee")
	if !ok || calls < 2 || !got.Equal(last) {
		t.Fatalf("last use %v (%v) after %d clock reads, want the last read %v", got, ok, calls, last)
	}
}
