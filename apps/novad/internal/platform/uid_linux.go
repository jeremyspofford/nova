package platform

import (
	"context"
	"errors"
	"os"
	"strings"
)

// rawMachineID is /etc/machine-id, or dbus's copy where systemd is absent.
// Inside WSL this is the distribution's own id, not Windows' — which is why
// core's WSL rule reads os.wsl, never machine ids.
func rawMachineID(_ context.Context, _ Runner) (string, error) {
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if body, err := os.ReadFile(p); err == nil && strings.TrimSpace(string(body)) != "" {
			return string(body), nil
		}
	}
	return "", errors.New("neither /etc/machine-id nor /var/lib/dbus/machine-id is readable")
}
