//go:build unix

package caps

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"novad/internal/box"
)

// S32.2 T6 C5: box.exec takes the CPU lock for a whole suite only. The
// checkout is a temp dir (never /srv/repo) so the lock path is derived from
// the request, and testSuites puts the one suite in services/core.

func lockArgs(t *testing.T, checkout, cwdRel string, argv string) map[string]any {
	t.Helper()
	wt := checkout + "/.worktrees/nova-c0ffee"
	cwd := wt
	if cwdRel != "." {
		cwd = wt + "/" + cwdRel
	}
	return wireArgs(t, `{"change": "c0ffee", "checkout": "`+checkout+`", "branch": "trunk", `+bLimits+
		`, "argv": `+argv+`, "cwd": "`+cwd+`"}`)
}

func holdLock(t *testing.T, p string) (release func()) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }
}

func TestBoxExecTakesTheLockForAWholeSuite(t *testing.T) {
	bin, _ := fakeDockerBin(t)
	checkout := t.TempDir()
	out := Dispatch(context.Background(), "box.exec",
		lockArgs(t, checkout, "services/core", `["uv", "run", "pytest"]`), boxDeps(warm(), bin))
	if !out.OK || out.Meta["heavy"] != true || out.Meta["lock_waited_s"] != 0 {
		t.Fatalf("ok=%v meta=%v err=%q", out.OK, out.Meta, out.Error)
	}
	if strings.HasPrefix(out.Output, "waited") {
		t.Errorf("a free lock said it waited: %q", out.Output)
	}
	// The lock lives in the request's checkout, not anywhere else.
	if _, err := os.Stat(filepath.Join(checkout, "deploy", "state", "cpu.lock")); err != nil {
		t.Errorf("no lock file at the checkout's deploy/state: %v", err)
	}
	// Released once the exec is done: the next taker gets it at once.
	holdLock(t, box.LockPath(checkout))()
}

func TestBoxExecSaysHowLongItWaitedForTheLock(t *testing.T) {
	bin, _ := fakeDockerBin(t)
	checkout := t.TempDir()
	rel := holdLock(t, box.LockPath(checkout))
	go func() { time.Sleep(1300 * time.Millisecond); rel() }()
	ctx, cancel := context.WithTimeout(context.Background(), box.LockMargin+30*time.Second)
	defer cancel()
	out := Dispatch(ctx, "box.exec", lockArgs(t, checkout, "services/core", `["uv", "run", "pytest"]`), boxDeps(warm(), bin))
	if !out.OK || out.Meta["heavy"] != true || out.Meta["lock_waited_s"] != 1 {
		t.Fatalf("ok=%v meta=%v err=%q", out.OK, out.Meta, out.Error)
	}
	if !strings.HasPrefix(out.Output, "waited 1s for the CPU lock\nexec\n") {
		t.Fatalf("output = %q", out.Output)
	}
}

func TestBoxExecThatCannotGetTheLockRunsNothing(t *testing.T) {
	bin, mark := fakeDockerBin(t)
	checkout := t.TempDir()
	p := box.LockPath(checkout)
	defer holdLock(t, p)()
	ctx, cancel := context.WithTimeout(context.Background(), box.LockMargin+1500*time.Millisecond)
	defer cancel()
	start := time.Now()
	out := Dispatch(ctx, "box.exec", lockArgs(t, checkout, "services/core", `["uv", "run", "pytest"]`), boxDeps(warm(), bin))
	if took := time.Since(start); took > 4*time.Second {
		t.Errorf("waited %v; the margin should have left the call at ~1.5s", took)
	}
	if out.OK || !strings.HasPrefix(out.Error, "the CPU lock "+p+" stayed held for 1s") ||
		!strings.HasSuffix(out.Error, " — nothing was run") || out.Meta != nil {
		t.Fatalf("ok=%v err=%q meta=%v", out.OK, out.Error, out.Meta)
	}
	if _, err := os.Stat(mark); err == nil {
		t.Fatal("docker exec ran without the lock")
	}
}

func TestATargetedRunTakesNoLock(t *testing.T) {
	bin, _ := fakeDockerBin(t)
	checkout := t.TempDir()
	defer holdLock(t, box.LockPath(checkout))()
	for _, c := range []struct{ rel, argv string }{
		{"services/core", `["uv", "run", "pytest", "tests/test_a.py"]`},
		{"services/core", `["uv", "run", "pytest", "-q"]`},
		{"services/gateway", `["uv", "run", "pytest"]`},
		{".", `["uv", "run", "pytest"]`},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), box.LockMargin+20*time.Second)
		start := time.Now()
		out := Dispatch(ctx, "box.exec", lockArgs(t, checkout, c.rel, c.argv), boxDeps(warm(), bin))
		cancel()
		if !out.OK || out.Meta["heavy"] != false || out.Meta["lock_waited_s"] != 0 || time.Since(start) > 2*time.Second {
			t.Errorf("%s %s: ok=%v meta=%v err=%q took %v", c.rel, c.argv, out.OK, out.Meta, out.Error, time.Since(start))
		}
	}
}

func TestBoxExecWithoutTheBranchsSuitesSaysSo(t *testing.T) {
	bin, mark := fakeDockerBin(t)
	for _, suites := range []string{noSuites, "[[suite]\n"} {
		s := warm()
		s.suites = suites
		out := Dispatch(context.Background(), "box.exec", lockArgs(t, t.TempDir(), "services/core", `["true"]`), boxDeps(s, bin))
		if out.OK || !strings.Contains(out.Error, "trunk's deploy/devbox/suites.toml") ||
			!strings.HasSuffix(out.Error, "nothing was run") || out.Meta != nil {
			t.Errorf("suites %q: ok=%v err=%q meta=%v", suites, out.OK, out.Error, out.Meta)
		}
		if s.find("ps ") != nil || s.find("start") != nil {
			t.Errorf("suites %q: the box was touched: %v", suites, s.calls)
		}
	}
	if _, err := os.Stat(mark); err == nil {
		t.Fatal("docker exec ran")
	}
}
