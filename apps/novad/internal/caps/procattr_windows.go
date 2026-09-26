package caps

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

// prepareCommand starts the command in a new process group and makes a
// cancel take the whole TREE (taskkill /T) — wsl.exe and anything it
// started. WSL_UTF8=1 makes wsl.exe print UTF-8 instead of UTF-16, like
// every other program's output here.
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
		if err := kill.Run(); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
	cmd.WaitDelay = killGrace
	cmd.Env = append(os.Environ(), "WSL_UTF8=1")
}
