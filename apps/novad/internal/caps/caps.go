// Package caps executes a verified capability on this machine and reports a
// precise outcome. The ok/exit_code seam is deliberate and matches core's
// _require_ok: ok means the daemon PERFORMED the capability and captured a
// result — it is NOT the command's own success. So a shell.exec that runs to
// completion is ok:true even on a nonzero exit (exit_code carries that);
// ok:false is reserved for the daemon being UNABLE to perform the capability
// at all — an over-cap read, a launch that never started, a timeout, or notify
// with no backend. Nothing is a shell string anywhere: shell.exec is argv-only.
package caps

import (
	"context"
	"fmt"
	"sort"
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

// Deps are the ambient facts a handler needs: the default working directory
// for shell.exec (also system.info's disk target), and — on a live socket —
// SendFacts, which writes a facts frame on THIS connection (facts.refresh).
// SendFacts is nil where there is no socket, and a handler that needs it says
// "cannot" rather than pretending.
type Deps struct {
	Home      string
	SendFacts func(context.Context) error
}

// Request is one verified call as its handler receives it.
type Request struct {
	Args map[string]any
	Deps Deps
}

// Handler performs one capability and judges the outcome (see Outcome).
type Handler func(ctx context.Context, req Request) Outcome

// Dispatch routes a verified capability through the table (table.go). An
// unknown capability is a refusal (ok:false), not a panic — core should never
// send one, but the edge refuses rather than trusts. The words "unknown
// capability" are load-bearing: doing-things S30 restates them to say a
// daemon is too old for a call, so they do not change.
func Dispatch(ctx context.Context, capability string, args map[string]any, d Deps) Outcome {
	h, ok := table[capability]
	if !ok {
		return fail("unknown capability %q", capability)
	}
	return h(ctx, Request{Args: args, Deps: d})
}

// Names is every capability this daemon performs, sorted — derived from the
// table, so a capability is listed because a handler exists (S30's
// daemon.info reads this), never from a second list kept by hand.
func Names() []string {
	names := make([]string, 0, len(table))
	for name := range table {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
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
