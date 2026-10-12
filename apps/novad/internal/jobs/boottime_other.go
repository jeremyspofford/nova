//go:build !linux && !darwin && !windows

package jobs

import (
	"errors"
	"time"
)

// BootTime cannot be read on this OS: the scanner then judges a wrapper by
// its pid alone.
func BootTime() (time.Time, error) {
	return time.Time{}, errors.New("this OS's boot time is not read")
}
