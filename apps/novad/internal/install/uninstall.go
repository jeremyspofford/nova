package install

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"novad/internal/config"
	"novad/internal/platform"
	"novad/internal/service"
)

// UninstallOptions is one uninstall.
type UninstallOptions struct {
	Paths      config.Paths
	InstallDir string
	Service    service.Manager
	Forget     bool
	Now        func() time.Time
	Out        io.Writer
}

// Uninstall stops and removes the service and the binaries: the build,
// supervise's .prev, .new and .failed, a copy place left as .installing, and
// every build moved aside as .old-<nanos>. It says each thing it removed and
// each file it had to leave, with the reason — never a removal it did not
// do. The pairing is kept (a reinstall reuses it) unless Forget sets it
// aside. It never claims the device is unpaired: that is a revoke, in
// Settings → Devices (P21).
func Uninstall(ctx context.Context, o UninstallOptions) error {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Out == nil {
		o.Out = os.Stdout
	}
	if !filepath.IsAbs(o.InstallDir) {
		return fmt.Errorf("uninstall needs an absolute install directory, not %q", o.InstallDir)
	}
	var errs []error
	registered := o.Service.Installed()
	if err := o.Service.Uninstall(ctx); err != nil {
		errs = append(errs, fmt.Errorf("removing the service: %w", err))
	} else if o.Service.Installed() {
		errs = append(errs, fmt.Errorf("removing the service: %s is still registered", o.Service.Describe()))
	} else if registered {
		fmt.Fprintf(o.Out, "removed:    the service (%s)\n", o.Service.Mode())
	}

	// The builds moved aside earlier go first, so a file moved aside below
	// — in use right now — is not tried again and reported twice.
	olds, err := oldBuilds(o.InstallDir, platform.BinaryName)
	if err != nil {
		errs = append(errs, fmt.Errorf("looking for the builds moved aside in %s: %w", o.InstallDir, err))
	}
	for _, f := range olds {
		if err := os.Remove(f); err != nil {
			// On Windows a build a process still runs from cannot be deleted.
			fmt.Fprintf(o.Out, "left:       %s — it could not be removed (%v); if a process still runs from it, delete it once none does\n", f, err)
			continue
		}
		fmt.Fprintf(o.Out, "removed:    %s\n", f)
	}
	bin := filepath.Join(o.InstallDir, platform.BinaryName)
	for _, f := range []string{bin, bin + ".prev", bin + ".new", bin + ".failed", bin + ".installing"} {
		err := os.Remove(f)
		switch {
		case err == nil:
			fmt.Fprintf(o.Out, "removed:    %s\n", f)
		case errors.Is(err, fs.ErrNotExist):
		default:
			aside := fmt.Sprintf("%s.old-%d", f, o.Now().UnixNano())
			if rerr := os.Rename(f, aside); rerr != nil {
				errs = append(errs, fmt.Errorf("%s is still there: %v (moving it aside failed too: %v)", f, err, rerr))
			} else {
				fmt.Fprintf(o.Out, "moved:      %s to %s — it could not be removed (%v); delete it once nothing runs it\n", f, aside, err)
			}
		}
	}

	// Read before --forget moves it: what this machine holds decides what
	// can truthfully be said about Nova's list.
	hasPairing := !errors.Is(o.Paths.CheckEnrolled(), config.ErrNotEnrolled)
	name := "this machine"
	if cfg, _, err := config.Load(o.Paths); err == nil {
		name = fmt.Sprintf("%q", cfg.Name)
	}
	if o.Forget {
		moved, err := config.SetAside(o.Paths, o.Now(), "forgotten")
		if err != nil {
			errs = append(errs, fmt.Errorf("setting the pairing aside: %w", err))
		}
		if len(moved) > 0 {
			fmt.Fprintf(o.Out, "set aside:  %s\n", strings.Join(moved, ", "))
		}
	}
	switch {
	case !hasPairing:
		// Never paired, or wiped after a revoke: Settings may show it revoked.
		fmt.Fprintln(o.Out, "no pairing is on this machine — if Settings → Devices shows it as paired, revoke it there")
	case o.Forget:
		fmt.Fprintf(o.Out, "Nova still lists %s as paired (offline from now on) — revoke it in Settings → Devices\n", name)
	default:
		fmt.Fprintf(o.Out, "Nova still lists %s as paired (offline from now on) — revoke it in Settings → Devices, or run novad install to bring it back\n", name)
	}
	return errors.Join(errs...)
}

// oldBuilds are the builds moved aside in dir: <name>.old-<nanos> (place,
// and an uninstall that met a file in use) and <name>.<prev|new|failed|
// installing>.old-<nanos> (supervise; uninstall). Only names of that shape:
// a file that merely starts the same way is never touched. The directory is
// read, not globbed, so a bracket in a Windows user folder cannot change the
// match.
func oldBuilds(dir, name string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		rest, ok := strings.CutPrefix(e.Name(), name+".")
		if !ok {
			continue
		}
		for _, kind := range []string{"prev.", "new.", "failed.", "installing."} {
			if r, ok := strings.CutPrefix(rest, kind); ok {
				rest = r
				break
			}
		}
		if nanos, ok := strings.CutPrefix(rest, "old-"); ok && allDigits(nanos) {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	return out, nil
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
