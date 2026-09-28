package caps

import (
	"context"

	"novad/internal/platform"
)

// systemNotify shows a desktop notification through this OS's own mechanism
// (notify_linux.go, notify_darwin.go, notify_windows.go). With no mechanism it
// is ok:false with the reason — it never pretends to have notified. The
// message reaches the program as an argument or on stdin, never inside a
// script.
func systemNotify(ctx context.Context, args map[string]any) Outcome {
	msg, ok := strArg(args, "message")
	if !ok || msg == "" {
		return fail("system.notify needs a 'message'")
	}
	return notify(ctx, platform.Exec{}, msg)
}
