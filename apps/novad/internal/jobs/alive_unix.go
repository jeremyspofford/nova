//go:build unix

package jobs

import (
	"errors"
	"syscall"
)

// ProcessAlive reports whether pid names a live process (EPERM: alive, not
// ours). Alive is not proof it is still the process that pid once named —
// CheckWrapper adds the boot check for that.
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
