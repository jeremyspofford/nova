package platform

import (
	"os"
	"syscall"
)

// WSL is Linux's; macOS is never inside it.
func WSL() (bool, string) { return false, "" }

// Interactive is whether the console belongs to this user — the Aqua
// session a notification or an app launch appears in.
func Interactive() bool {
	info, err := os.Stat("/dev/console")
	if err != nil {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}

// osMode is launch-agent when launchd (pid 1) started this process.
func osMode() string {
	if os.Getppid() == 1 {
		return "launch-agent"
	}
	return "foreground"
}
