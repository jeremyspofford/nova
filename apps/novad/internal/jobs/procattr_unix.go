//go:build unix

package jobs

import (
	"os/exec"
	"syscall"
)

// prepareChild makes the job's child lead its own session (and so its own
// process group, pgid = pid): job.stop kills the whole group with one
// signal, a program that would ask on a terminal fails at once instead of
// waiting on one, and nothing aimed at the wrapper's group reaches it.
func prepareChild(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
