package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"novad/internal/config"
	"novad/internal/platform"
)

type launchd struct {
	r    platform.Runner
	home string
}

// New is the macOS manager: one LaunchAgent (unwalked; CI only).
func New(_ config.Paths, r platform.Runner) Manager {
	home, _ := os.UserHomeDir()
	return &launchd{r: r, home: home}
}

func (l *launchd) Mode() string     { return ModeLaunch }
func (l *launchd) Describe() string { return "a LaunchAgent (starts at login)" }
func (l *launchd) plistPath() string {
	return filepath.Join(l.home, "Library", "LaunchAgents", Label+".plist")
}
func (l *launchd) logPath() string { return filepath.Join(l.home, "Library", "Logs", "novad.log") }
func (l *launchd) target() string  { return fmt.Sprintf("gui/%d/%s", os.Getuid(), Label) }

func (l *launchd) Installed() bool {
	_, err := os.Stat(l.plistPath())
	return err == nil
}

func (l *launchd) Install(bin string) error {
	for _, d := range []string{filepath.Dir(l.plistPath()), filepath.Dir(l.logPath())} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(l.plistPath(), []byte(LaunchAgentPlist(bin, l.logPath())), 0o644)
}

func (l *launchd) Restart(ctx context.Context) error {
	_, _ = l.r.Run(ctx, "launchctl", []string{"bootout", l.target()}, "") // not loaded yet is fine
	if _, err := l.r.Run(ctx, "launchctl", []string{"bootstrap", fmt.Sprintf("gui/%d", os.Getuid()), l.plistPath()}, ""); err != nil {
		return fmt.Errorf("launchctl bootstrap: %w", err)
	}
	if _, err := l.r.Run(ctx, "launchctl", []string{"kickstart", "-k", l.target()}, ""); err != nil {
		return fmt.Errorf("launchctl kickstart: %w", err)
	}
	return nil
}

func (l *launchd) RestartLater(_ context.Context, after time.Duration) error {
	script := fmt.Sprintf("sleep %d; /bin/launchctl kickstart -k %s", int(after.Seconds()), l.target())
	_, err := platform.StartDetached("/bin/sh", []string{"-c", script}, l.logPath())
	return err
}

func (l *launchd) Stop(ctx context.Context) error {
	_, err := l.r.Run(ctx, "launchctl", []string{"bootout", l.target()}, "")
	return err
}

// Uninstall boots the agent out, then removes the plist (Manager). A plist
// that is not there is nothing to stop — launchctl would only say it has no
// such service — so no bootout is tried, and none is reported as failed.
func (l *launchd) Uninstall(ctx context.Context) (stopErr, err error) {
	if l.Installed() {
		stopErr = l.Stop(ctx)
	}
	if err := os.Remove(l.plistPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return stopErr, err
	}
	return stopErr, nil
}

func (l *launchd) BootStart(context.Context) (bool, string, error) {
	return false, "starts at login (a LaunchAgent), not before", nil
}
