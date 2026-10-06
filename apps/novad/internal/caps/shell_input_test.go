package caps

import (
	"context"
	"runtime"
	"testing"
	"time"
)

// P30, Review Focus 12: a command that reads its input gets none and ends
// at once — it never waits for a person nobody told.
func TestAShellExecChildGetsEmptyInput(t *testing.T) {
	argv := []any{"cat"}
	if runtime.GOOS == "windows" {
		argv = []any{"findstr", "x"} // reads its input to the end; no match is exit 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	out := Dispatch(ctx, "shell.exec", map[string]any{"argv": argv}, testDeps(t))
	if !out.OK {
		t.Fatalf("got %+v", out)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("the command waited %s for input", took)
	}
}
