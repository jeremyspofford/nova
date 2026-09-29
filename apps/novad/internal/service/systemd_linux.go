package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"novad/internal/config"
	"novad/internal/platform"
)

type systemd struct {
	r       platform.Runner
	unitDir string
}

// New is the Linux manager: a systemd user unit.
func New(_ config.Paths, r platform.Runner) Manager {
	base, _ := platform.ConfigBase()
	return &systemd{r: r, unitDir: filepath.Join(base, "systemd", "user")}
}

func (s *systemd) Mode() string     { return ModeSystemd }
func (s *systemd) Describe() string { return "a systemd user service" }
func (s *systemd) unitPath() string { return filepath.Join(s.unitDir, UnitName) }

func (s *systemd) Installed() bool {
	_, err := os.Stat(s.unitPath())
	return err == nil
}

func (s *systemd) Install(bin string) error {
	if err := os.MkdirAll(s.unitDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.unitPath(), []byte(SystemdUnit(bin)), 0o644)
}

func (s *systemd) systemctl(ctx context.Context, args ...string) error {
	if _, err := s.r.Run(ctx, "systemctl", append([]string{"--user"}, args...), ""); err != nil {
		return fmt.Errorf("systemctl --user %s: %w", strings.Join(args, " "), err)
	}
	return nil
}

func (s *systemd) Restart(ctx context.Context) error {
	for _, args := range [][]string{{"daemon-reload"}, {"enable", UnitName}, {"restart", UnitName}} {
		if err := s.systemctl(ctx, args...); err != nil {
			return err
		}
	}
	return nil
}

func (s *systemd) RestartLater(ctx context.Context, after time.Duration) error {
	secs := int(after.Seconds())
	if secs < 1 {
		secs = 1
	}
	if err := s.systemctl(ctx, "daemon-reload"); err != nil {
		return err
	}
	if err := s.systemctl(ctx, "enable", UnitName); err != nil {
		return err
	}
	args := []string{"--user", fmt.Sprintf("--on-active=%d", secs),
		fmt.Sprintf("--unit=novad-restart-%d", time.Now().Unix()),
		"systemctl", "--user", "restart", UnitName}
	if _, err := s.r.Run(ctx, "systemd-run", args, ""); err != nil {
		return fmt.Errorf("systemd-run: %w", err)
	}
	return nil
}

func (s *systemd) Stop(ctx context.Context) error { return s.systemctl(ctx, "stop", UnitName) }

func (s *systemd) Uninstall(ctx context.Context) error {
	_ = s.systemctl(ctx, "disable", "--now", UnitName)
	if err := os.Remove(s.unitPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return s.systemctl(ctx, "daemon-reload")
}

// BootStart turns linger on without sudo when the session allows it (an
// active local session usually does) and reads it back; it never claims boot
// start it did not read (P26).
func (s *systemd) BootStart(ctx context.Context) (bool, string, error) {
	u, err := user.Current()
	if err != nil {
		return false, "", err
	}
	read := func() (string, error) {
		out, err := s.r.Run(ctx, "loginctl", []string{"show-user", u.Username, "-p", "Linger", "--value"}, "")
		return strings.TrimSpace(out), err
	}
	v, err := read()
	if err != nil {
		return false, "", fmt.Errorf("reading linger: %w", err)
	}
	if v == "yes" {
		return true, "starts at boot (linger is on)", nil
	}
	_, _ = s.r.Run(ctx, "loginctl", []string{"enable-linger"}, "")
	if v, _ = read(); v == "yes" {
		return true, "starts at boot (linger turned on)", nil
	}
	return false, fmt.Sprintf("starts at login, not at boot, until linger is on — run once: sudo loginctl enable-linger %s", u.Username), nil
}
