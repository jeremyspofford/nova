package caps

import (
	"context"
	"fmt"
	"strings"
)

// appEntry is one launchable application: the id apps.launch takes, and the
// name a person would call it.
type appEntry struct{ id, name string }

// appsList lists launchable apps from this OS's own catalogue (apps_*.go).
// A catalogue that cannot be read is ok:false with the reason — never
// "0 apps", which would read as a machine with nothing installed.
func appsList(ctx context.Context) Outcome {
	apps, err := listApps(ctx)
	if err != nil {
		return fail("cannot list apps: %v", err)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d apps\n", len(apps))
	for _, a := range apps {
		fmt.Fprintf(&b, "%s — %s\n", a.id, a.name)
	}
	return ok0(b.String())
}

// appsLaunch starts one app by the id apps.list printed (or, where the OS
// allows, its name), detached so it outlives this handler. A launch that
// never started is ok:false.
func appsLaunch(ctx context.Context, args map[string]any) Outcome {
	app, ok := strArg(args, "app")
	if !ok || app == "" {
		return fail("apps.launch needs an 'app' (an id from apps.list)")
	}
	return launchApp(ctx, app)
}
