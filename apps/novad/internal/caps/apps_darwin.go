package caps

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"novad/internal/platform"
)

// appDirsDarwin are where macOS keeps applications: the system's, the
// machine's, and this user's.
func appDirsDarwin() []string {
	dirs := []string{"/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, "Applications"))
	}
	return dirs
}

// listApps on macOS is every *.app bundle in those folders, by name. A Mac
// always has apps in /System/Applications, so finding none means the folders
// could not be read — said, never "0 apps".
func listApps(_ context.Context) ([]appEntry, error) {
	seen := map[string]bool{}
	var apps []appEntry
	for _, dir := range appDirsDarwin() {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !strings.HasSuffix(e.Name(), ".app") {
				continue
			}
			name := strings.TrimSuffix(e.Name(), ".app")
			if seen[name] {
				continue
			}
			seen[name] = true
			apps = append(apps, appEntry{id: name, name: name})
		}
	}
	if len(apps) == 0 {
		return nil, errors.New("no .app bundle could be read in /Applications, /System/Applications or ~/Applications")
	}
	sort.Slice(apps, func(i, j int) bool { return apps[i].id < apps[j].id })
	return apps, nil
}

// launchApp is `open -a <name>`: macOS resolves the bundle and starts it in
// the user's session.
func launchApp(ctx context.Context, app string) Outcome {
	if _, err := (platform.Exec{}).Run(ctx, "/usr/bin/open", []string{"-a", app}, ""); err != nil {
		return fail("could not launch %q: %v", app, err)
	}
	return ok0("launched " + app)
}
