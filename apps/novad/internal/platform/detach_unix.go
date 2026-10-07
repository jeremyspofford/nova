//go:build !windows

package platform

import (
	"os"
	"os/exec"
	"syscall"
)

// StartDetached starts bin in its own session (Setsid), so a service manager
// that ends the caller's process group does not end it; output goes to
// logPath. It returns the pid.
func StartDetached(bin string, args []string, logPath string) (int, error) {
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	cmd := exec.Command(bin, args...)
	cmd.Stdout, cmd.Stderr = f, f
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return pid, nil
}
