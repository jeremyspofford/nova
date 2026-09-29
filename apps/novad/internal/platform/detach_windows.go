package platform

import (
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// StartDetached starts bin with no console and no parent it depends on (P6):
// its own process group, no window, and out of the caller's job when that job
// allows breakaway (a terminal's job would otherwise end it with the window).
// Output goes to logPath. It returns the pid.
func StartDetached(bin string, args []string, logPath string) (int, error) {
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	base := uint32(windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW)
	start := func(flags uint32) (*exec.Cmd, error) {
		cmd := exec.Command(bin, args...)
		cmd.Stdout, cmd.Stderr = f, f
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: flags, HideWindow: true}
		return cmd, cmd.Start()
	}
	cmd, err := start(base | windows.CREATE_BREAKAWAY_FROM_JOB)
	if err != nil {
		if cmd, err = start(base); err != nil {
			return 0, err
		}
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return pid, nil
}
