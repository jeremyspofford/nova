package platform

import (
	"context"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// OSVersion is "macOS <version>", from the kernel's own record.
func OSVersion(_ context.Context, _ Runner) string {
	v, err := unix.Sysctl("kern.osproductversion")
	if err != nil || strings.TrimSpace(v) == "" {
		return "macOS (version not stated)"
	}
	return "macOS " + strings.TrimSpace(v)
}

// Memory is the installed total. Available memory needs vm_stat's page
// counts; until something needs it, it is stated unknown (AvailableKnown
// false), never guessed.
func Memory() (Mem, error) {
	total, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return Mem{}, err
	}
	return Mem{Total: total}, nil
}

// Uptime is the time since the kernel's boottime.
func Uptime() (time.Duration, error) {
	tv, err := unix.SysctlTimeval("kern.boottime")
	if err != nil {
		return 0, err
	}
	sec, nsec := tv.Unix()
	return time.Since(time.Unix(sec, nsec)), nil
}
