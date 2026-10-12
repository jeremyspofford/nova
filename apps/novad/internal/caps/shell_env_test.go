package caps

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// S30c T8: device_run's env and timeout_s reach shell.exec and box.exec.
// These are the portable edge checks; the runs themselves are in
// shell_env_unix_test.go.

const t8Secret = "t8-secret-value-9f3a"

// A bad env or timeout_s is refused naming the field, before anything runs,
// and the refusal never quotes an env value.
func TestShellExecRefusesBadEnvAndTimeoutS(t *testing.T) {
	cases := []struct{ extra, field string }{
		{`, "env": "A=` + t8Secret + `"`, "env"},
		{`, "env": ["A"]`, "env"},
		{`, "env": {"A": 1}`, "env"},
		{`, "env": {"A": null}`, "env"},
		{`, "env": {"1X": "` + t8Secret + `"}`, "env"},
		{`, "env": {"A=B": "` + t8Secret + `"}`, "env"},
		{`, "env": {"": "` + t8Secret + `"}`, "env"},
		{`, "timeout_s": 0`, "timeout_s"},
		{`, "timeout_s": -1`, "timeout_s"},
		{`, "timeout_s": 111`, "timeout_s"},
		{`, "timeout_s": 1.5`, "timeout_s"},
		{`, "timeout_s": "5"`, "timeout_s"},
	}
	for _, capability := range []string{"shell.exec", "box.exec"} {
		for _, c := range cases {
			raw := `{"argv": ["novad-t8-no-such-binary"]` + c.extra + `}`
			d := testDeps(t)
			if capability == "box.exec" {
				// No manager: the refusal must come from the field, so give one
				// that is never reached (its docker is a missing binary).
				d = boxDeps(warm(), "/nonexistent/docker")
				raw = `{"argv": ["true"], "cwd": "` + bWorktree + `", "change": "c0ffee", "checkout": "/srv/repo", "branch": "trunk", ` + bLimits + c.extra + `}`
			}
			out := Dispatch(context.Background(), capability, wireArgs(t, raw), d)
			if out.OK || !strings.Contains(out.Error, c.field) || !strings.Contains(out.Error, "nothing was run") {
				t.Errorf("%s %s: ok=%v err=%q, want a refusal naming %s and nothing was run", capability, c.extra, out.OK, out.Error, c.field)
			}
			if strings.Contains(out.Error, t8Secret) || strings.Contains(fmt.Sprint(out.Meta), t8Secret) {
				t.Errorf("%s %s: the refusal quotes the env value: %q", capability, c.extra, out.Error)
			}
		}
	}
}

// The per-call ceiling is the agent's own command budget (client checks the
// two are one number).
func TestMaxCallTimeoutIs110s(t *testing.T) {
	if MaxCallTimeoutS != 110 {
		t.Fatalf("MaxCallTimeoutS = %d, want 110", MaxCallTimeoutS)
	}
}
