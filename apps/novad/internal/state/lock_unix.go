//go:build !windows

package state

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// flock is per open file description, so even a second open in THIS process
// is refused — which is what the test relies on.
func lockFile(f *os.File) error {
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		if errors.Is(err, unix.EWOULDBLOCK) {
			return errLocked
		}
		return err
	}
	return nil
}

func unlockFile(f *os.File) { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN) }
