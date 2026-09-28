package platform

import (
	"os"
	"strings"
)

// osreleasePath is where the kernel names itself; a variable so a test can
// point it at a WSL-shaped file.
var osreleasePath = "/proc/sys/kernel/osrelease"

// WSL reports whether this Linux runs inside WSL, and the distribution when
// the environment names it ("" otherwise). The kernel's own release string
// is the test — never WSL_DISTRO_NAME or WSL_INTEROP, which a systemd unit
// inside WSL does not get (measured on the Dell, r1-wake-critique:114).
func WSL() (bool, string) {
	body, err := os.ReadFile(osreleasePath)
	if err != nil || !strings.Contains(strings.ToLower(string(body)), "microsoft") {
		return false, ""
	}
	return true, os.Getenv("WSL_DISTRO_NAME")
}

// Interactive is whether a graphical session is reachable: apps.launch and
// system.notify need one (README, "graphical session").
func Interactive() bool {
	return os.Getenv("WAYLAND_DISPLAY") != "" || os.Getenv("DISPLAY") != ""
}

// Mode is how this daemon was started: by systemd, which sets INVOCATION_ID
// for every unit it starts, or by hand.
func Mode() string {
	if os.Getenv("INVOCATION_ID") != "" {
		return "systemd-user"
	}
	return "foreground"
}
