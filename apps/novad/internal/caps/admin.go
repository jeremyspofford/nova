package caps

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"

	"novad/internal/admin"
)

// admin.exec (S30b) runs argv as root / the owner elevated through this
// machine's standing admin path: on unix the sudoers rule naming the root
// copy (admin_unix.go), on Windows the elevated task \Nova\NovaAdmin
// (taskExec below, admin_windows.go). A machine without the path answers
// noAdminPath — core adds the machine's name. Nothing here decides whether
// a call MAY run (owner ruling 2026-09-03): it states only that it cannot.

// noAdminPath is the stated cannot core restates as "no admin path on <machine>".
const noAdminPath = "cannot: no admin path on this machine"

// adminDefaultTimeout is the run's timeout when the call names none and its
// ctx has no deadline: the agent's command timeout (client.CommandTimeout,
// which caps cannot import).
const adminDefaultTimeout = 110 * time.Second

// AdminDeps are the admin path's seams. Nil Deps.Admin (or an empty field)
// is the real machine.
type AdminDeps struct {
	// unix: the sudo program ("" = "sudo") and the root copy's path
	// ("" = admin.CopyPath).
	Sudo string
	Copy string
	// windows: Submit (nil = admin.Submit over admin.DefaultHost()).
	Submit func(ctx context.Context, req admin.TaskRequest, timeout time.Duration) (admin.TaskResult, error)
	// Host is admin.install / admin.uninstall's machine (nil = the real one).
	Host *AdminHost
}

func adminExec(ctx context.Context, r Request) Outcome {
	return adminRoute(ctx, r.Args, r.Deps)
}

// parseAdminArgs reads argv (a non-empty array of non-empty strings) and
// cwd (an optional string).
func parseAdminArgs(args map[string]any) ([]string, string, error) {
	raw, ok := args["argv"].([]any)
	if !ok || len(raw) == 0 {
		return nil, "", errors.New("admin.exec needs a non-empty 'argv' array")
	}
	argv := make([]string, 0, len(raw))
	for i, v := range raw {
		s, ok := v.(string)
		if !ok || s == "" {
			return nil, "", fmt.Errorf("admin.exec argv[%d] is not a non-empty string", i)
		}
		argv = append(argv, s)
	}
	var cwd string
	if c, present := args["cwd"]; present {
		s, ok := c.(string)
		if !ok {
			return nil, "", fmt.Errorf("admin.exec 'cwd' must be a string, got %T", c)
		}
		cwd = s
	}
	return argv, cwd, nil
}

// adminTimeout is the run's timeout in whole seconds: timeout_s when given
// (a whole number 1..admin.MaxTimeout, read as the wire sends it — a
// json.Number), else adminDefaultTimeout; capped by the ctx's remaining time
// less margin, so the elevated side gives up before the agent's own call
// does. Less than a second left is a stated cannot.
func adminTimeout(ctx context.Context, args map[string]any, margin time.Duration) (time.Duration, error) {
	t := adminDefaultTimeout
	if v, present := args["timeout_s"]; present {
		f, ok := numberArg(v)
		if !ok {
			return 0, fmt.Errorf("admin.exec 'timeout_s' must be a whole number of seconds, got %T", v)
		}
		if math.IsNaN(f) || f != math.Trunc(f) || f < 1 || f > admin.MaxTimeout {
			return 0, fmt.Errorf("admin.exec 'timeout_s' must be a whole number of seconds from 1 to %d, got %v", admin.MaxTimeout, f)
		}
		t = time.Duration(f) * time.Second
	}
	if dl, ok := ctx.Deadline(); ok {
		if left := time.Until(dl) - margin; left < t {
			t = left
		}
	}
	t = t.Truncate(time.Second)
	if t < time.Second {
		return 0, errors.New("cannot: too little of this call's time is left to run it elevated")
	}
	return t, nil
}

// withExitNote is shell.exec's wording for a run that ended nonzero.
func withExitNote(out string, code int) string {
	if code != 0 {
		out += fmt.Sprintf("\n[process exited with code %d]", code)
	}
	return out
}

// taskExec is admin.exec's Windows route over submit (admin.Submit in
// production): one request with a fresh id, its result judged as
// shell.exec's — a run that ended is ok:true with its code, a timeout or a
// run that never started is ok:false in the task's own words. stdout and
// stderr share shell.exec's one 64 KiB cap.
func taskExec(ctx context.Context, args map[string]any, submit func(context.Context, admin.TaskRequest, time.Duration) (admin.TaskResult, error)) Outcome {
	argv, cwd, err := parseAdminArgs(args)
	if err != nil {
		return fail("%v", err)
	}
	// Submit waits up to timeout + WaitGrace for the result.
	t, err := adminTimeout(ctx, args, admin.WaitGrace+2*time.Second)
	if err != nil {
		return fail("%v", err)
	}
	id, err := admin.NewRequestID(rand.Reader)
	if err != nil {
		return fail("%v", err)
	}
	req := admin.TaskRequest{
		V: admin.FileVersion, ID: id, Argv: argv, Cwd: cwd,
		TimeoutS: json.Number(strconv.Itoa(int(t / time.Second))),
	}
	res, err := submit(ctx, req, t)
	if err != nil {
		return fail("%v", err)
	}
	cw := &capWriter{limit: OutputCap}
	_, _ = cw.Write([]byte(res.Stdout))
	_, _ = cw.Write([]byte(res.Stderr))
	if res.StdoutTruncated || res.StderrTruncated {
		cw.truncated = true
	}
	switch {
	case res.TimedOut:
		return fail("timed out; partial output:\n%s", cw.string())
	case !res.OK && res.Said != "":
		return fail("%s", res.Said)
	case !res.OK:
		return fail("the admin task did not run it and said nothing")
	}
	ranAs := "user_not_elevated"
	if res.Elevated {
		ranAs = "user_elevated"
	}
	code := res.ExitCode
	return Outcome{
		OK: true, Output: withExitNote(cw.string(), code), ExitCode: &code,
		Meta: map[string]any{"elevated": true, "kind": "task", "ran_as": ranAs, "user": res.User},
	}
}
