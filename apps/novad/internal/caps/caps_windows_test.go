package caps

import (
	"context"
	"strings"
	"testing"
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
