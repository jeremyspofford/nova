//go:build unix

package caps

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"novad/internal/admin"
)

// adminMargin is how much sooner than the agent's own deadline the root
// side's `admin exec --timeout` fires: the agent's user cannot kill a root
// process group, so the root side must kill it (and exit 124) first.
const adminMargin = 2 * time.Second

// adminUnixDefaults is the sudo program and the root copy, a's or the real
// machine's (T1's CopyPath).
func adminUnixDefaults(a *AdminDeps) (string, string) {
	sudo, cp := "sudo", admin.CopyPath
	if a != nil && a.Sudo != "" {
		sudo = a.Sudo
	}
	if a != nil && a.Copy != "" {
		cp = a.Copy
	}
	return sudo, cp
}

// The root side's own words (apps/novad/admin.go): a timeout exits 124,
// a child that never started exits 127, each with this line on stderr.
const (
	rootTimedOut  = "novad: admin exec: timed out after "
	rootSaidStart = "novad: admin exec: "
)

// adminRoute is admin.exec on unix: the root copy present and `sudo -n -l
// <copy> admin exec` allowing it, or noAdminPath with nothing run; then
// `sudo -n <copy> admin exec --timeout <s> [--cwd <d>] -- argv...` through
// shell.exec's own run (runArgv), its exit code the child's.
func adminRoute(ctx context.Context, args map[string]any, d Deps) Outcome {
	sudo, cp := adminUnixDefaults(d.Admin)
	argv, cwd, err := parseAdminArgs(args)
	if err != nil {
		return fail("%v", err)
	}
	t, err := adminTimeout(ctx, args, adminMargin)
	if err != nil {
		return fail("%v", err)
	}
	if _, err := os.Stat(cp); err != nil {
		return fail("%s", noAdminPath)
	}
	if err := exec.CommandContext(ctx, sudo, "-n", "-l", cp, "admin", "exec").Run(); err != nil {
		if ctx.Err() != nil {
			return fail("timed out reading whether the admin path allows it: %v", ctx.Err())
		}
		return fail("%s", noAdminPath)
	}
	full := []string{sudo, "-n", cp, "admin", "exec", "--timeout", strconv.Itoa(int(t / time.Second))}
	if cwd != "" {
		full = append(full, "--cwd", cwd)
	}
	full = append(full, "--")
	full = append(full, argv...)
	out := runArgv(ctx, full, d.Home)
	if !out.OK || out.ExitCode == nil {
		return out
	}
	body := strings.TrimSuffix(out.Output, "\n[process exited with code "+strconv.Itoa(*out.ExitCode)+"]")
	switch {
	case *out.ExitCode == 124 && strings.Contains(body, rootTimedOut):
		return fail("timed out; partial output:\n%s", body)
	case *out.ExitCode == 127 && strings.Contains(body, rootSaidStart):
		return fail("could not run %q elevated: %s", argv[0], strings.TrimSpace(body[strings.LastIndex(body, rootSaidStart):]))
	}
	out.Meta = map[string]any{"elevated": true, "kind": "sudoers", "ran_as": "root"}
	return out
}
