package caps

import (
	"context"
	"strings"
	"testing"
	"time"
)

// The Windows twins of caps_unix_test.go: a builtin needs cmd /c.
func TestShellExecNonzeroExitIsOkTrueWithTheCodeOnWindows(t *testing.T) {
	out := Dispatch(context.Background(), "shell.exec", map[string]any{"argv": []any{"cmd", "/c", "exit 3"}}, testDeps(t))
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 3 {
		t.Fatalf("ok=%v code=%v %q", out.OK, out.ExitCode, out.Error)
	}
}

func TestShellExecZeroExitCapturesOutputOnWindows(t *testing.T) {
	out := Dispatch(context.Background(), "shell.exec", map[string]any{"argv": []any{"cmd", "/c", "echo", "hello"}}, testDeps(t))
	if !out.OK || !strings.Contains(out.Output, "hello") {
		t.Fatalf("ok=%v %q %q", out.OK, out.Output, out.Error)
	}
}

func TestShellExecOutputIsCappedAndStatedOnWindows(t *testing.T) {
	out := Dispatch(context.Background(), "shell.exec", map[string]any{"argv": []any{
		"powershell.exe", "-NoProfile", "-Command", "[Console]::Out.Write('A' * 200000)",
	}}, testDeps(t))
	if !out.OK || !strings.Contains(out.Output, "truncated at") {
		t.Fatalf("ok=%v len=%d %q", out.OK, len(out.Output), out.Error)
	}
}

// A long-running command killed by a short deadline must be reported as a
// timeout, not as a process that ran. This is the Windows twin of
// TestAShellTimeoutKillsTheWholeGroup. ping has no descendants racing to
// exit mid-kill, so taskkill exits 0 here — this is a smoke test that the
// deadline -> Cancel -> WithHandle -> taskkill -> reported-timeout path
// works end to end, not a regression test for taskkill's own exit code
// (that needs a multi-process tree this test doesn't build).
func TestShellExecTimeoutIsOkFalseOnWindows(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	start := time.Now()
	out := Dispatch(ctx, "shell.exec", map[string]any{"argv": []any{"ping", "-n", "30", "127.0.0.1"}}, testDeps(t))
	if out.OK || !strings.Contains(out.Error, "timed out") {
		t.Fatalf("ok=%v %q", out.OK, out.Error)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("returned after %s: the kill must not wait for the full ping", elapsed)
	}
}
