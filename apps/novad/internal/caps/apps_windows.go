package caps

import (
	"context"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"syscall"

	"novad/internal/platform"
)

// listApps on Windows is the Start menu's own list (Get-StartApps).
func listApps(ctx context.Context) ([]appEntry, error) {
	apps, err := startApps(ctx, platform.Exec{})
	if err != nil {
		return nil, err
	}
	out := make([]appEntry, 0, len(apps))
	for _, a := range apps {
		out = append(out, appEntry{id: a.AppID, name: a.Name})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].name) < strings.ToLower(out[j].name) })
	return out, nil
}

func startApps(ctx context.Context, r platform.Runner) ([]platform.StartApp, error) {
	out, err := r.Run(ctx, "powershell.exe", powershellArgs(startAppsScript), "")
	if err != nil {
		return nil, fmt.Errorf("reading the Start menu: %w", err)
	}
	return platform.ParseStartApps(out)
}

// launchApp starts the Start-menu app whose AppID or name matches, through
// explorer's shell:AppsFolder — the way the Start menu itself launches it,
// Store apps included. An app named like a program on PATH ("notepad",
// "notepad.exe") that the Start menu does not list is started directly.
func launchApp(ctx context.Context, app string) Outcome {
	apps, listErr := startApps(ctx, platform.Exec{})
	if listErr == nil {
		if id, ok := matchStartApp(apps, app); ok {
			cmd := exec.Command("explorer.exe", `shell:AppsFolder\`+id)
			// explorer.exe hands the launch to the shell and exits — often with
			// status 1 even when the app opened — so STARTING it is the signal,
			// never its exit code. That signal is only that the shell accepted
			// the request, not that the app is running, so the result says so.
			if err := cmd.Start(); err != nil {
				return fail("could not launch %q: %v", app, err)
			}
			_ = cmd.Process.Release()
			return ok0("asked Windows to launch " + app)
		}
	}
	if path, err := exec.LookPath(app); err == nil {
		cmd := exec.Command(path)
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
		if err := cmd.Start(); err != nil {
			return fail("could not start %q: %v", path, err)
		}
		_ = cmd.Process.Release()
		return ok0("launched " + path)
	}
	if listErr != nil {
		return fail("could not launch %q: the Start menu could not be read (%v) and no program by that name is on PATH", app, listErr)
	}
	return fail("no Start-menu app named %q and no program by that name on PATH — device_list_apps lists the names", app)
}
