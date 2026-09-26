//go:build unix

package caps

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// prepareCommand puts the command in its own process group and makes a
// cancel kill the WHOLE group: a backgrounded grandchild holding the output
// pipe would otherwise keep Wait blocked past the timeout (doing-things
// named this "a defect to fix regardless"). If the group is already gone
// (ESRCH), the process finished on its own before this Cancel could matter —
// report exec's own contract for "already done" (os.ErrProcessDone) rather
// than a bare ESRCH, so a Cancel that found nothing to kill is never counted
// as having killed something (see shell.go's killedByCancel).
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.WaitDelay = killGrace
}
