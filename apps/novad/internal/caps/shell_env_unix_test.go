//go:build unix

package caps

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The child sees the agent's own environment plus each env value; meta
// echoes the names (sorted), never a value.
func TestShellExecPassesEnvToTheChild(t *testing.T) {
	t.Setenv("NOVA_T8_AGENT", "kept-from-the-agent")
	d := testDeps(t)
	raw := `{"argv": ["sh", "-c", "printf '%s|%s|%s' \"$NOVA_T8_B\" \"$NOVA_T8_A\" \"$NOVA_T8_AGENT\""], ` +
		`"env": {"NOVA_T8_B": "` + t8Secret + `", "NOVA_T8_A": "a b=c"}}`
	out := Dispatch(context.Background(), "shell.exec", wireArgs(t, raw), d)
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 0 {
		t.Fatalf("ok=%v exit=%v err=%q", out.OK, out.ExitCode, out.Error)
	}
	if out.Output != t8Secret+"|a b=c|kept-from-the-agent" {
		t.Fatalf("child saw %q", out.Output)
	}
	if !reflect.DeepEqual(out.Meta["env_keys"], []string{"NOVA_T8_A", "NOVA_T8_B"}) {
		t.Fatalf("meta env_keys = %#v", out.Meta["env_keys"])
	}
	if _, ok := out.Meta["timeout_s"]; ok {
		t.Fatalf("timeout_s echoed though none was sent: %v", out.Meta)
	}
	if strings.Contains(fmt.Sprint(out.Meta), t8Secret) {
		t.Fatalf("meta carries an env value: %v", out.Meta)
	}
}

// An env value overrides the agent's own variable of that name.
func TestShellExecEnvOverridesTheAgentsValue(t *testing.T) {
	t.Setenv("NOVA_T8_SAME", "the-agents")
	out := Dispatch(context.Background(), "shell.exec", wireArgs(t,
		`{"argv": ["sh", "-c", "printf %s \"$NOVA_T8_SAME\""], "env": {"NOVA_T8_SAME": "the-calls"}}`), testDeps(t))
	if !out.OK || out.Output != "the-calls" {
		t.Fatalf("ok=%v out=%q err=%q", out.OK, out.Output, out.Error)
	}
}

// Without env the echo is an empty name list, and the child sees only the
// agent's environment.
func TestShellExecWithoutEnvEchoesNoNames(t *testing.T) {
	out := Dispatch(context.Background(), "shell.exec", wireArgs(t, `{"argv": ["true"]}`), testDeps(t))
	if !out.OK || !reflect.DeepEqual(out.Meta["env_keys"], []string{}) {
		t.Fatalf("ok=%v meta=%#v err=%q", out.OK, out.Meta, out.Error)
	}
}

// timeout_s is the call's budget: a 5 s sleep with timeout_s 1 times out in
// about a second, under a caller deadline far longer.
func TestShellExecTimeoutSIsTheCallsBudget(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	start := time.Now()
	out := Dispatch(ctx, "shell.exec", wireArgs(t, `{"argv": ["sleep", "5"], "timeout_s": 1}`), testDeps(t))
	elapsed := time.Since(start)
	if out.OK || !strings.Contains(out.Error, "timed out") {
		t.Fatalf("ok=%v err=%q", out.OK, out.Error)
	}
	if elapsed < 900*time.Millisecond || elapsed > 3*time.Second {
		t.Fatalf("returned after %s, want about 1 s", elapsed)
	}
	if out.Meta["timeout_s"] != 1 {
		t.Fatalf("meta timeout_s = %#v", out.Meta["timeout_s"])
	}
}

// The budget is min(timeout_s, the caller's): a longer timeout_s never
// stretches the agent's own command deadline.
func TestShellExecTimeoutSNeverOutlivesTheCallersDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	start := time.Now()
	out := Dispatch(ctx, "shell.exec", wireArgs(t, `{"argv": ["sleep", "5"], "timeout_s": 100}`), testDeps(t))
	if out.OK || !strings.Contains(out.Error, "timed out") {
		t.Fatalf("ok=%v err=%q", out.OK, out.Error)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("returned after %s: timeout_s 100 stretched the caller's 400 ms", elapsed)
	}
}

// A run inside its budget echoes the timeout_s it was given.
func TestShellExecEchoesTimeoutS(t *testing.T) {
	out := Dispatch(context.Background(), "shell.exec", wireArgs(t, `{"argv": ["true"], "timeout_s": 37}`), testDeps(t))
	if !out.OK || out.Meta["timeout_s"] != 37 || !reflect.DeepEqual(out.Meta["env_keys"], []string{}) {
		t.Fatalf("ok=%v meta=%#v err=%q", out.OK, out.Meta, out.Error)
	}
}

// A refused env runs nothing (the mark is never written).
func TestShellExecWithABadEnvRunsNothing(t *testing.T) {
	d := testDeps(t)
	mark := filepath.Join(d.Home, "ran")
	out := Dispatch(context.Background(), "shell.exec", wireArgs(t,
		`{"argv": ["touch", "`+mark+`"], "env": {"BAD NAME": "x"}}`), d)
	if out.OK {
		t.Fatalf("a bad env ran: %q", out.Output)
	}
	if _, err := os.Stat(mark); err == nil {
		t.Fatalf("the command ran despite the refusal")
	}
}

// fakeDockerEnv prints each argument, then the value its environment holds
// for NOVA_T8_TOKEN (what the docker client would hand the box for -e).
func fakeDockerEnv(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "docker")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\"\nprintf 'client-env=%s\\n' \"$NOVA_T8_TOKEN\"\n" +
		"[ -n \"$NOVA_FAKE_SLEEP\" ] && sleep \"$NOVA_FAKE_SLEEP\"\nexit 0\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

// box.exec names each env key with -e before the box (sorted), never its
// value; the value reaches the docker client's environment only.
func TestBoxExecPassesEnvByNameOnly(t *testing.T) {
	bin := fakeDockerEnv(t)
	cwd := bWorktree + "/services/core"
	out := Dispatch(context.Background(), "box.exec", boxArgs(t,
		`, "argv": ["env"], "cwd": "`+cwd+`", "env": {"NOVA_T8_TOKEN": "`+t8Secret+`", "AA_FIRST": "x"}, "timeout_s": 42`), boxDeps(warm(), bin))
	if !out.OK {
		t.Fatalf("ok=%v err=%q", out.OK, out.Error)
	}
	lines := strings.Split(strings.TrimSuffix(out.Output, "\n"), "\n")
	wantArgs := []string{"exec", "-w", cwd, "-u", "1234:5678", "-e", "AA_FIRST", "-e", "NOVA_T8_TOKEN", "nova-box-c0ffee", "env"}
	if !reflect.DeepEqual(lines[:len(lines)-1], wantArgs) {
		t.Fatalf("docker argv\n%q\nwant\n%q", lines[:len(lines)-1], wantArgs)
	}
	if lines[len(lines)-1] != "client-env="+t8Secret {
		t.Fatalf("the docker client's env: %q", lines[len(lines)-1])
	}
	want := map[string]any{"ran_in": "box", "box": "nova-box-c0ffee", "image": bTag, "heavy": false, "lock_waited_s": 0,
		"env_keys": []string{"AA_FIRST", "NOVA_T8_TOKEN"}, "timeout_s": 42}
	if !reflect.DeepEqual(out.Meta, want) {
		t.Fatalf("meta = %#v\nwant %#v", out.Meta, want)
	}
}

// box.exec's budget is timeout_s too.
func TestBoxExecTimeoutSIsTheCallsBudget(t *testing.T) {
	bin := fakeDockerEnv(t)
	t.Setenv("NOVA_FAKE_SLEEP", "5")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	start := time.Now()
	out := Dispatch(ctx, "box.exec", boxArgs(t, `, "argv": ["true"], "cwd": "`+bWorktree+`", "timeout_s": 1`), boxDeps(warm(), bin))
	if out.OK || !strings.Contains(out.Error, "timed out") {
		t.Fatalf("ok=%v err=%q", out.OK, out.Error)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("returned after %s, want about 1 s", elapsed)
	}
}
