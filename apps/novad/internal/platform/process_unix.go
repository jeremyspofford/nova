//go:build !windows

package platform

import (
	"errors"
	"fmt"
	"syscall"
)

// ProcessAlive is whether pid names a running process. pid <= 0 is never a
// single process this package tracks — kill(0) targets the caller's own
// process group, and kill(-1) every process the caller can signal — so it is
// reported not alive rather than answered from either of those.
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// Terminate asks pid to stop (SIGTERM; `novad run` and supervise handle it).
// pid <= 0 is refused: kill(0) signals the caller's own process group and
// kill(-1) every process the caller can signal, so an unguarded call here
// could end far more than "the process that turned out not to be running".
func Terminate(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("refusing to signal pid %d", pid)
	}
	return syscall.Kill(pid, syscall.SIGTERM)
}
