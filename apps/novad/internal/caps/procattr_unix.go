//go:build unix

package caps

import (
	"os/exec"
	"syscall"
)

// prepareCommand puts the command in its own process group and makes a
// cancel kill the WHOLE group: a backgrounded grandchild holding the output
// pipe would otherwise keep Wait blocked past the timeout (doing-things
// named this "a defect to fix regardless").
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = killGrace
}
