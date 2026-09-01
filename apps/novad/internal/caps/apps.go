package caps

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// appDirs returns the XDG application directories, in precedence order:
// $XDG_DATA_HOME/applications (or ~/.local/share/applications) then each of
// $XDG_DATA_DIRS/applications (default /usr/local/share:/usr/share).
func appDirs() []string {
	var dirs []string
	dataHome := os.Getenv("XDG_DATA_HOME")
	if dataHome == "" {
		if home, err := os.UserHomeDir(); err == nil {
			dataHome = filepath.Join(home, ".local", "share")
		}
	}
	if dataHome != "" {
		dirs = append(dirs, filepath.Join(dataHome, "applications"))
	}
	dataDirs := os.Getenv("XDG_DATA_DIRS")
	if dataDirs == "" {
		dataDirs = "/usr/local/share:/usr/share"
	}
	for _, d := range strings.Split(dataDirs, ":") {
		if d == "" {
			continue
		}
		dirs = append(dirs, filepath.Join(d, "applications"))
	}
	return dirs
}

type desktopApp struct {
	id   string // the .desktop basename without extension
	name string // Name=
	exec string // Exec=
}

// scanApps reads every .desktop file across the app dirs, first occurrence of
// an id wins (XDG precedence), skipping NoDisplay/Hidden entries.
func scanApps() []desktopApp {
	seen := map[string]bool{}
	var apps []desktopApp
	for _, dir := range appDirs() {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".desktop") {
				continue
			}
			id := strings.TrimSuffix(e.Name(), ".desktop")
			if seen[id] {
				continue
			}
			app, ok := parseDesktop(filepath.Join(dir, e.Name()), id)
			if !ok {
				continue
			}
			seen[id] = true
			apps = append(apps, app)
		}
	}
	sort.Slice(apps, func(i, j int) bool { return apps[i].id < apps[j].id })
	return apps
}

func parseDesktop(path, id string) (desktopApp, bool) {
	f, err := os.Open(path)
	if err != nil {
		return desktopApp{}, false
	}
	defer f.Close()
	app := desktopApp{id: id, name: id}
	inEntry := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") {
			inEntry = line == "[Desktop Entry]"
			continue
		}
		if !inEntry {
			continue
		}
		switch {
		case strings.HasPrefix(line, "Name="):
			app.name = strings.TrimPrefix(line, "Name=")
		case strings.HasPrefix(line, "Exec="):
			app.exec = strings.TrimPrefix(line, "Exec=")
		case line == "NoDisplay=true" || line == "Hidden=true":
			return desktopApp{}, false
		}
	}
	return app, true
}

func appsList() Outcome {
	apps := scanApps()
	var b strings.Builder
	fmt.Fprintf(&b, "%d apps\n", len(apps))
	for _, a := range apps {
		fmt.Fprintf(&b, "%s — %s\n", a.id, a.name)
	}
	return ok0(b.String())
}

// appsLaunch launches a .desktop app by id, detached. It prefers gtk-launch
// (which validates the id against the desktop database), then gio launch on
// the resolved file, then the parsed Exec line as a last resort. A launch that
// never starts is ok:false — it does not report a launch it could not begin.
// Needs a graphical session (DISPLAY/WAYLAND_DISPLAY/DBUS); see the README.
func appsLaunch(ctx context.Context, args map[string]any) Outcome {
	app, ok := strArg(args, "app")
	if !ok || app == "" {
		return fail("apps.launch needs an 'app' (a .desktop id)")
	}

	if path, err := exec.LookPath("gtk-launch"); err == nil {
		cmd := exec.CommandContext(ctx, path, app)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fail("gtk-launch could not start %q: %v: %s", app, err, strings.TrimSpace(string(out)))
		}
		return ok0("launched " + app)
	}

	desktopFile := findDesktopFile(app)
	if path, err := exec.LookPath("gio"); err == nil && desktopFile != "" {
		cmd := exec.CommandContext(ctx, path, "launch", desktopFile)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fail("gio launch could not start %q: %v: %s", app, err, strings.TrimSpace(string(out)))
		}
		return ok0("launched " + app)
	}

	if desktopFile != "" {
		if a, ok := parseDesktop(desktopFile, app); ok && a.exec != "" {
			if outcome := launchExecLine(a.exec); outcome != nil {
				return *outcome
			}
		}
	}
	return fail("could not launch %q: no gtk-launch/gio and no runnable Exec line found", app)
}

func findDesktopFile(id string) string {
	for _, dir := range appDirs() {
		candidate := filepath.Join(dir, id+".desktop")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

// launchExecLine runs a .desktop Exec line detached, after stripping the field
// codes (%f %u %U %F ...) that only a file-manager launch would fill in.
func launchExecLine(execLine string) *Outcome {
	fields := stripFieldCodes(execLine)
	if len(fields) == 0 {
		o := fail("Exec line was empty after stripping field codes")
		return &o
	}
	cmd := exec.Command(fields[0], fields[1:]...)
	// Detach into its own session so it outlives this handler.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		o := fail("could not start %q: %v", fields[0], err)
		return &o
	}
	// Release so we neither wait nor leave a zombie.
	_ = cmd.Process.Release()
	o := ok0("launched " + fields[0])
	return &o
}

func stripFieldCodes(execLine string) []string {
	var out []string
	for _, f := range strings.Fields(execLine) {
		switch f {
		case "%f", "%F", "%u", "%U", "%d", "%D", "%n", "%N", "%i", "%c", "%k", "%v", "%m":
			continue
		}
		out = append(out, f)
	}
	return out
}
