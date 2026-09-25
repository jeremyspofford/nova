package caps

import (
	"context"
	"os/exec"

	"novad/internal/platform"
)

// notify on Linux is notify-send, which needs a graphical session
// (DISPLAY/DBUS; see the README).
func notify(ctx context.Context, r platform.Runner, msg string) Outcome {
	if _, err := exec.LookPath("notify-send"); err != nil {
		return fail("no desktop notification backend: notify-send is not installed")
	}
	if _, err := r.Run(ctx, "notify-send", []string{"Nova", msg}, ""); err != nil {
		return fail("notify-send failed: %v", err)
	}
	return ok0("notified")
}
