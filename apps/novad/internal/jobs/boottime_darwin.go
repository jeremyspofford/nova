package jobs

import (
	"time"

	"golang.org/x/sys/unix"
)

// BootTime is when this machine last booted: sysctl kern.boottime.
func BootTime() (time.Time, error) {
	tv, err := unix.SysctlTimeval("kern.boottime")
	if err != nil {
		return time.Time{}, err
	}
	return time.Unix(tv.Sec, int64(tv.Usec)*1000).UTC(), nil
}
