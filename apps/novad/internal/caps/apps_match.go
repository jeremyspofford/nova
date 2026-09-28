package caps

import (
	"strings"

	"novad/internal/platform"
)

// matchStartApp finds app among the Start menu's entries: an exact AppID
// first, then the Start menu's name compared without case. OS-agnostic so it
// is tested on every runner.
func matchStartApp(apps []platform.StartApp, app string) (string, bool) {
	for _, a := range apps {
		if a.AppID == app {
			return a.AppID, true
		}
	}
	for _, a := range apps {
		if strings.EqualFold(a.Name, app) {
			return a.AppID, true
		}
	}
	return "", false
}
