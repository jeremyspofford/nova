//go:build unix

package caps

import (
	"context"
	"strings"
	"testing"
)

// The ok-vs-exit_code seam: a process that RAN to completion is ok:true even on
// a nonzero exit; exit_code carries the command's own result.
func TestShellExecNonzeroExitIsOkTrueWithTheCode(t *testing.T) {
	d := testDeps(t)
	out := Dispatch(context.Background(), "shell.exec",
		map[string]any{"argv": []any{"sh", "-c", "exit 3"}}, d)
	if !out.OK {
		t.Fatal("a process that ran to completion is ok:true even on a nonzero exit")
	}
	if out.ExitCode == nil || *out.ExitCode != 3 {
		t.Fatalf("exit_code = %v, want 3", out.ExitCode)
	}
}

func TestShellExecZeroExitCapturesOutput(t *testing.T) {
	d := testDeps(t)
	out := Dispatch(context.Background(), "shell.exec",
		map[string]any{"argv": []any{"echo", "hello"}}, d)
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 0 {
		t.Fatalf("echo should be ok:true exit 0, got ok=%v code=%v", out.OK, out.ExitCode)
	}
	if !strings.Contains(out.Output, "hello") {
		t.Errorf("output should contain 'hello', got %q", out.Output)
	}
}

// A binary that does not exist is the daemon UNABLE to perform the capability
// -> ok:false, not a fake exit code.
func TestShellExecUnstartableIsOkFalse(t *testing.T) {
	d := testDeps(t)
	out := Dispatch(context.Background(), "shell.exec",
		map[string]any{"argv": []any{"this-binary-does-not-exist-xyz"}}, d)
	if out.OK {
		t.Fatal("a binary that cannot start must be ok:false")
	}
	if out.ExitCode != nil {
		t.Errorf("exit_code should be null for an unstartable command, got %v", out.ExitCode)
	}
}

func TestShellExecOutputIsCappedAndStated(t *testing.T) {
	d := testDeps(t)
	// Emit far more than the 64 KiB cap.
	out := Dispatch(context.Background(), "shell.exec",
		map[string]any{"argv": []any{"sh", "-c", "yes AAAAAAAA | head -c 200000"}}, d)
	if !out.OK {
		t.Fatalf("the command itself ran fine: %q", out.Error)
	}
	if len(out.Output) > OutputCap+64 { // cap + the short truncation note
		t.Errorf("output length %d exceeds the cap plus its note", len(out.Output))
	}
	if !strings.Contains(out.Output, "truncated at") {
		t.Error("reaching the cap must be stated, not silent")
	}
}
