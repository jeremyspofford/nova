//go:build unix

package caps

import (
	"errors"
	"syscall"
)

// signalJob signals a job's child's whole process group (the wrapper starts
// the child as a session leader, so pgid == pid): SIGTERM first, SIGKILL
// when hard. A group already gone is not an error.
func signalJob(pid int, hard bool) error {
	sig := syscall.SIGTERM
	if hard {
		sig = syscall.SIGKILL
	}
	if err := syscall.Kill(-pid, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}

// processAlive reports whether pid names a live process (EPERM: alive, not ours).
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
