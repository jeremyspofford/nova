package jobs

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// BootTime is when this machine last booted: the kernel's btime.
func BootTime() (time.Time, error) {
	raw, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}, err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if f := strings.Fields(line); len(f) == 2 && f[0] == "btime" {
			n, err := strconv.ParseInt(f[1], 10, 64)
			if err != nil {
				return time.Time{}, fmt.Errorf("/proc/stat btime %q: %w", f[1], err)
			}
			return time.Unix(n, 0).UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("/proc/stat has no btime line")
}
