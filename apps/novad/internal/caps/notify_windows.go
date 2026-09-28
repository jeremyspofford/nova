package caps

import (
	"context"

	"novad/internal/platform"
)

// notify on Windows is a WinRT toast through Windows PowerShell (see
// toastScript). The message goes on stdin; the script is a constant.
func notify(ctx context.Context, r platform.Runner, msg string) Outcome {
	if _, err := r.Run(ctx, "powershell.exe", powershellArgs(toastScript), msg); err != nil {
		return fail("could not show the toast: %v", err)
	}
	return ok0("notified")
}
