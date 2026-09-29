//go:build !windows

package platform

import (
	"errors"
	"syscall"
)

// ProcessAlive is whether pid names a running process.
func ProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// Terminate asks pid to stop (SIGTERM; `novad run` and supervise handle it).
func Terminate(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }
