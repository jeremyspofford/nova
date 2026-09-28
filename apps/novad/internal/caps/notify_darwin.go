package caps

import (
	"context"

	"novad/internal/platform"
)

// notify on macOS is AppleScript's display notification. The message is item
// 1 of argv inside `on run`, so it is never AppleScript source.
func notify(ctx context.Context, r platform.Runner, msg string) Outcome {
	args := []string{
		"-e", "on run argv",
		"-e", `display notification (item 1 of argv) with title "Nova"`,
		"-e", "end run",
		msg,
	}
	if _, err := r.Run(ctx, "/usr/bin/osascript", args, ""); err != nil {
		return fail("osascript could not show the notification: %v", err)
	}
	return ok0("notified")
}
