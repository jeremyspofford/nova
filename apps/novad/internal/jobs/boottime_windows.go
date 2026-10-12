package jobs

import (
	"time"

	"golang.org/x/sys/windows"
)

var getTickCount64 = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetTickCount64")

// BootTime is when this machine last booted: now less the milliseconds
// since boot (GetTickCount64 — it counts across sleep, as a boot does).
// novad ships for windows amd64 and arm64, where the 64-bit count is r1.
func BootTime() (time.Time, error) {
	if err := getTickCount64.Find(); err != nil {
		return time.Time{}, err
	}
	ms, _, _ := getTickCount64.Call()
	return time.Now().Add(-time.Duration(ms) * time.Millisecond).UTC(), nil
}
