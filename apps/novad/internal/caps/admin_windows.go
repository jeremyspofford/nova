//go:build windows

package caps

import (
	"context"
	"time"

	"novad/internal/admin"
)

// adminRoute is admin.exec on Windows: taskExec over admin.Submit to the
// elevated task (or Deps.Admin.Submit under test).
func adminRoute(ctx context.Context, args map[string]any, d Deps) Outcome {
	submit := realSubmit
	if d.Admin != nil && d.Admin.Submit != nil {
		submit = d.Admin.Submit
	}
	return taskExec(ctx, args, submit)
}

func realSubmit(ctx context.Context, req admin.TaskRequest, timeout time.Duration) (admin.TaskResult, error) {
	h, err := admin.DefaultHost()
	if err != nil {
		return admin.TaskResult{}, err
	}
	return admin.Submit(ctx, h, req, timeout)
}
