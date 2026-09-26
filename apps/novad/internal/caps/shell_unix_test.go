//go:build unix

package caps

import (
	"context"
	"strings"
	"testing"
	"time"
)

// A timed-out command takes its whole process group with it. The
// backgrounded sleep inherits the output pipe: without the group kill, Wait
// blocks until the grandchild exits (30 s) or WaitDelay gives up (5 s).
func TestAShellTimeoutKillsTheWholeGroup(t *testing.T) {
	d := testDeps(t)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	out := Dispatch(ctx, "shell.exec", map[string]any{"argv": []any{"sh", "-c", "sleep 30 & sleep 30"}}, d)
	if out.OK || !strings.Contains(out.Error, "timed out") {
		t.Fatalf("got ok=%v %q", out.OK, out.Error)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("returned after %s: the group kill must take the backgrounded child too", elapsed)
	}
}

// A command cut off by a dropped connection did NOT run to completion. It was
// reported ok:true, exit -1 before S42a — "ran" for something that did not.
func TestACommandCancelledByADroppedConnectionIsNotReportedAsRan(t *testing.T) {
	d := testDeps(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(200 * time.Millisecond); cancel() }()
	out := Dispatch(ctx, "shell.exec", map[string]any{"argv": []any{"sleep", "30"}}, d)
	if out.OK || !strings.Contains(out.Error, "cancelled") {
		t.Fatalf("got ok=%v %q", out.OK, out.Error)
	}
}

// The command itself exits 0 almost immediately; the backgrounded sleep
// inherits the output pipe and outlives WaitDelay (5 s < 8 s). Per exec.Cmd's
// own doc: when pipes are closed by WaitDelay and no Cancel happened, Wait
// returns ErrWaitDelay instead of nil. That is still a process that RAN —
// ok:true, exit 0 — not "could not run". The call must also return well
// before the backgrounded sleep's own 8 s, proving Wait did not block on it.
func TestAShellThatExitsWhileABackgroundedChildHoldsThePipeIsOkTrueAfterWaitDelay(t *testing.T) {
	d := testDeps(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	start := time.Now()
	out := Dispatch(ctx, "shell.exec",
		map[string]any{"argv": []any{"sh", "-c", "echo started; sleep 8 &"}}, d)
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 0 {
		t.Fatalf("got ok=%v code=%v %q", out.OK, out.ExitCode, out.Error)
	}
	if !strings.Contains(out.Output, "started") {
		t.Fatalf("output missing %q: %q", "started", out.Output)
	}
	if !strings.Contains(out.Output, "kept its output open") {
		t.Fatalf("output missing the WaitDelay note: %q", out.Output)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("returned after %s: must return after WaitDelay (5s), not the backgrounded sleep (8s)", elapsed)
	}
}

// The command's own process exits almost immediately (echo, then background
// and return); exec's watchCtx races Cancel against that exit and loses, so
// Cancel is never called. The 5 s WaitDelay drain for the backgrounded
// sleep then runs to completion on its own timer, unrelated to ctx. If the
// deadline happens to land inside that drain window (here, ~1 s into an
// 8 s wait), ctx.Err() reads DeadlineExceeded by the time Run returns even
// though nothing was ever killed — that must not shadow the process's own
// clean exit as "timed out".
func TestADeadlineThatLandsInTheDrainWindowDoesNotShadowAProcessThatAlreadyExited(t *testing.T) {
	d := testDeps(t)
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	out := Dispatch(ctx, "shell.exec",
		map[string]any{"argv": []any{"sh", "-c", "echo started; sleep 8 &"}}, d)
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 0 {
		t.Fatalf("got ok=%v code=%v %q", out.OK, out.ExitCode, out.Error)
	}
	if !strings.Contains(out.Output, "started") {
		t.Fatalf("output missing %q: %q", "started", out.Output)
	}
	if !strings.Contains(out.Output, "kept its output open") {
		t.Fatalf("output missing the WaitDelay note: %q", out.Output)
	}
}

// The cancel twin of the deadline case above: a cancel that lands inside the
// WaitDelay drain window, after the command's own process already exited on
// its own, must not shadow it as "cancelled".
func TestACancelThatLandsInTheDrainWindowDoesNotShadowAProcessThatAlreadyExited(t *testing.T) {
	d := testDeps(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { time.Sleep(1 * time.Second); cancel() }()
	out := Dispatch(ctx, "shell.exec",
		map[string]any{"argv": []any{"sh", "-c", "echo started; sleep 8 &"}}, d)
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 0 {
		t.Fatalf("got ok=%v code=%v %q", out.OK, out.ExitCode, out.Error)
	}
	if !strings.Contains(out.Output, "started") {
		t.Fatalf("output missing %q: %q", "started", out.Output)
	}
	if !strings.Contains(out.Output, "kept its output open") {
		t.Fatalf("output missing the WaitDelay note: %q", out.Output)
	}
}
