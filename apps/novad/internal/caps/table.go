package caps

import "context"

// table is the dispatch table: every capability this daemon performs, and
// the handler that performs it. It replaces the literal switch (S42a) and is
// the table doing-things S30 adds its capabilities to — never a second one
// (hub-topology, "the Dispatch table"). Per-OS behaviour lives INSIDE the
// handlers (platform, notify_*, apps_*, procattr_*), never in which names
// exist: the same names answer on every OS, and an OS that cannot do one
// says "cannot" from inside its handler.
var table = map[string]Handler{
	"system.info":   func(ctx context.Context, r Request) Outcome { return systemInfo(ctx, r.Deps) },
	"system.notify": func(ctx context.Context, r Request) Outcome { return systemNotify(ctx, r.Args) },
	"fs.list":       func(_ context.Context, r Request) Outcome { return fsList(r.Args, r.Deps) },
	"fs.read":       func(_ context.Context, r Request) Outcome { return fsRead(r.Args, r.Deps) },
	"fs.write":      func(_ context.Context, r Request) Outcome { return fsWrite(r.Args, r.Deps) },
	"fs.edit":       func(_ context.Context, r Request) Outcome { return fsEdit(r.Args, r.Deps) },
	"fs.search":     func(ctx context.Context, r Request) Outcome { return fsSearch(ctx, r.Args, r.Deps) },
	"apps.list":     func(ctx context.Context, _ Request) Outcome { return appsList(ctx) },
	"apps.launch":   func(ctx context.Context, r Request) Outcome { return appsLaunch(ctx, r.Args) },
	"shell.exec":    func(ctx context.Context, r Request) Outcome { return shellExec(ctx, r.Args, r.Deps) },
	"facts.refresh": factsRefresh,
	"daemon.update": daemonUpdate,
}

// factsRefresh answers core's facts.refresh: it writes a fresh facts frame
// on this connection and only then returns, so the frame is on the wire
// BEFORE this command's result. Core reads a socket's frames in order, so by
// the time its command returns, the facts are recorded (S46a relies on it).
func factsRefresh(ctx context.Context, r Request) Outcome {
	if r.Deps.SendFacts == nil {
		return fail("cannot: there is no connection to send facts on")
	}
	if err := r.Deps.SendFacts(ctx); err != nil {
		return fail("could not send facts: %v", err)
	}
	return ok0("facts sent")
}
