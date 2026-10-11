//go:build unix

package caps

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"novad/internal/admin"
)

// installTimeout bounds one run of the installer / uninstaller, and
// whoamiTimeout the elevated round trip.
const (
	installTimeout = 60
	whoamiTimeout  = 20
)

// realAdminHost is the unix machine: its euid, its user, this binary, and
// the installer run directly (root), through the path (`sudo -n <copy>
// admin exec -- <bin> admin install`), or through `sudo -n <bin>`.
func realAdminHost(d Deps) (AdminHost, error) {
	sudo, cp := adminUnixDefaults(d.Admin)
	bin, err := os.Executable()
	if err != nil {
		return AdminHost{}, fmt.Errorf("finding this agent's binary: %w", err)
	}
	if b, err := filepath.EvalSymlinks(bin); err == nil {
		bin = b
	}
	u, err := user.Current()
	if err != nil {
		return AdminHost{}, fmt.Errorf("reading this agent's user: %w", err)
	}
	// Through the path, as admin.exec runs it: the root side kills its
	// group at its own timeout.
	throughPath := func(ctx context.Context, secs int, argv ...string) (string, error) {
		full := append([]string{"-n", cp, "admin", "exec", "--timeout", strconv.Itoa(secs), "--"}, argv...)
		return runWords(ctx, sudo, full...)
	}
	run := func(ctx context.Context, route, verb string) (string, error) {
		args := []string{"admin", verb}
		if verb == "install" {
			args = append(args, "--user", u.Username)
		}
		switch route {
		case routeDirect:
			return runWords(ctx, bin, args...)
		case routePath:
			return throughPath(ctx, installTimeout, append([]string{bin}, args...)...)
		case routeSudoN:
			return runWords(ctx, sudo, append([]string{"-n", bin}, args...)...)
		}
		return "", fmt.Errorf("cannot: there is no %q route on this machine", route)
	}
	return AdminHost{
		Elevated: os.Geteuid() == 0,
		Bin:      bin,
		User:     u.Username,
		SudoN: func(ctx context.Context) bool {
			ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			return exec.CommandContext(ctx, sudo, "-n", "true").Run() == nil
		},
		Read: func(ctx context.Context) admin.PathState {
			ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			return admin.ReadPathAt(ctx, sudo, cp)
		},
		Install:   func(ctx context.Context, route string) (string, error) { return run(ctx, route, "install") },
		Uninstall: func(ctx context.Context, route string) (string, error) { return run(ctx, route, "uninstall") },
		Whoami: func(ctx context.Context) (string, error) {
			return throughPath(ctx, whoamiTimeout, cp, "admin", "whoami")
		},
	}, nil
}

// runWords runs name argv and returns its output; a failure is an error
// carrying its exit and its own words.
func runWords(ctx context.Context, name string, argv ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, (installTimeout+10)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, argv...)
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.CombinedOutput()
	if err != nil {
		if w := strings.TrimSpace(string(out)); w != "" {
			return string(out), fmt.Errorf("%v: %s", err, w)
		}
		return string(out), err
	}
	return string(out), nil
}
