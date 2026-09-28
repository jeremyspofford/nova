//go:build unix

package caps

import (
	"errors"
	"os/exec"
	"syscall"
)

// prepareCommand puts the command in its own process group and makes a
// cancel kill the WHOLE group: a backgrounded grandchild holding the output
// pipe would otherwise keep Wait blocked past the timeout (doing-things
// named this "a defect to fix regardless").
//
// Cancel's return value is the only thing shell.go's killedByCancel trusts.
// It is nil when the group kill signalled something — or, if the group was
// already empty, when the direct kill of the root did — never a promise
// that the ROOT specifically was the one signalled, since a lingering group
// member can keep the group alive after the root itself has exited. It is
// os.ErrProcessDone when the root had already been reaped. ESRCH from the
// group kill proves only that the GROUP is empty, not that the root is
// dead — a process can also leave its own group and still be alive — so
// that alone is never treated as "the root is dead": cmd.Process.Kill()
// then targets the root's own pid directly, and Go's os package already
// converts ITS OWN ESRCH into os.ErrProcessDone (os.convertESRCH), so no
// mapping of that is needed here.
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			// The group is empty; check — and if still alive, kill — the
			// root itself rather than assuming it died with the group.
			return cmd.Process.Kill()
		}
		return err
	}
	cmd.WaitDelay = killGrace
}
