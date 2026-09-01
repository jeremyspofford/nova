// Package caps executes a verified capability on this machine and reports a
// precise outcome. The ok/exit_code seam is deliberate and matches core's
// _require_ok: ok means the daemon PERFORMED the capability and captured a
// result — it is NOT the command's own success. So a shell.exec that runs to
// completion is ok:true even on a nonzero exit (exit_code carries that);
// ok:false is reserved for the daemon being UNABLE to perform the capability
// at all — a deny-root hit, an over-cap read, a launch that never started, a
// timeout, or notify with no backend. Nothing is a shell string anywhere:
// shell.exec is argv-only.
package caps

import (
	"context"
	"fmt"

	"novad/internal/config"
)

// Caps for the byte budgets in the plan. ReadCap and WriteCap share the same
// 256 KiB fs domain (the plan's "no v1 capability moves >256 KiB"); a write
// over it is refused at the edge — defence in depth even for a signed envelope,
// and it never reaches the transport where an oversize frame would flap the
// socket instead of stating a refusal.
const (
	ReadCap   = 256 * 1024 // fs.read refuses a larger file; it never truncates
	WriteCap  = 256 * 1024 // fs.write refuses larger content; it never partial-writes
	OutputCap = 64 * 1024  // shell.exec output; reaching it is stated, not silent
)

// Outcome is the device's judgment of one capability call. The client turns it
// into a result frame AND an audit entry — a refusal is never silent.
type Outcome struct {
	OK       bool
	Output   string
	ExitCode *int
	Error    string
}

// Deps are the ambient facts a handler needs: the deny-roots backstop and the
// default working directory for shell.exec.
type Deps struct {
	Deny *config.DenyList
	Home string
}

// Dispatch routes a verified capability to its handler. An unknown capability
// is a refusal (ok:false), not a panic — core should never send one, but the
// edge refuses rather than trusts.
func Dispatch(ctx context.Context, capability string, args map[string]any, d Deps) Outcome {
	switch capability {
	case "system.info":
		return systemInfo(d)
	case "system.notify":
		return systemNotify(ctx, args)
	case "fs.list":
		return fsList(args, d)
	case "fs.read":
		return fsRead(args, d)
	case "fs.write":
		return fsWrite(args, d)
	case "apps.list":
		return appsList()
	case "apps.launch":
		return appsLaunch(ctx, args)
	case "shell.exec":
		return shellExec(ctx, args, d)
	default:
		return fail("unknown capability %q", capability)
	}
}

// ok0 is a successful outcome whose capability has no process exit (exit_code 0
// per the plan's table for everything but shell.exec).
func ok0(output string) Outcome {
	zero := 0
	return Outcome{OK: true, Output: output, ExitCode: &zero}
}

// fail is a refusal: ok:false, exit_code null, the reason stated.
func fail(format string, a ...any) Outcome {
	return Outcome{OK: false, Error: fmt.Sprintf(format, a...)}
}

func strArg(args map[string]any, key string) (string, bool) {
	s, ok := args[key].(string)
	return s, ok
}
