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
// do — and that the agent is offline only when this run stopped its service
// and removed it. The pairing is kept (a reinstall reuses it) unless Forget
// sets it aside. It never claims the device is unpaired: that is a revoke, in
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
	stopErr, err := o.Service.Uninstall(ctx)
	if stopErr != nil {
		errs = append(errs, fmt.Errorf("stopping the agent: %w — it may still be running", stopErr))
	}
	removed := false
	switch {
	case err != nil:
		errs = append(errs, fmt.Errorf("removing the service: %w", err))
	case o.Service.Installed():
		errs = append(errs, fmt.Errorf("removing the service: %s is still registered", o.Service.Describe()))
	default:
		removed = true
		if registered {
			fmt.Fprintf(o.Out, "removed:    the service (%s)\n", o.Service.Mode())
		}
	}

	// The builds moved aside earlier go first, so a file moved aside below
	// — in use right now — is not tried again and reported twice.
	olds, err := platform.OldBuilds(o.InstallDir, platform.BinaryName)
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
	// "Offline from now on" is what this run did (Task 32, L90 + L242): it
	// stopped the service that was registered and removed it, read back. A
	// stop that failed may have left the agent running; with no service
	// registered, nothing was stopped here; a definition still there starts
	// the agent again at the next sign-in.
	how := ""
	switch {
	case stopErr != nil:
		how = ", and its agent may still be running"
	case registered && removed:
		how = " (offline from now on)"
	}
	switch {
	case !hasPairing:
		// Never paired, or wiped after a revoke: Settings may show it revoked.
		fmt.Fprintln(o.Out, "no pairing is on this machine — if Settings → Devices shows it as paired, revoke it there")
	case o.Forget:
		fmt.Fprintf(o.Out, "Nova still lists %s as paired%s — revoke it in Settings → Devices\n", name, how)
	default:
		fmt.Fprintf(o.Out, "Nova still lists %s as paired%s — revoke it in Settings → Devices, or run novad install to bring it back\n", name, how)
	}
	return errors.Join(errs...)
}
