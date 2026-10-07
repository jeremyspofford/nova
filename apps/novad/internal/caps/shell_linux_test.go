//go:build linux

package caps

import (
	"context"
	"strings"
	"testing"
)

// P30, Review Focus 12: the child leads its own session, so it has no
// controlling terminal even under an agent started by hand in one — where a
// sudo used to ask on the owner's terminal and wait.
func TestAShellExecChildHasNoControllingTerminal(t *testing.T) {
	out := Dispatch(context.Background(), "shell.exec", map[string]any{
		"argv": []any{"sh", "-c", `echo "$$ $(cut -d' ' -f6 /proc/$$/stat) $(cut -d' ' -f7 /proc/$$/stat)"`},
	}, testDeps(t))
	f := strings.Fields(out.Output)
	if !out.OK || len(f) != 3 || f[0] != f[1] || f[2] != "0" {
		t.Fatalf("pid, session, tty = %q: the child must lead its own session, with no terminal", out.Output)
	}
}
