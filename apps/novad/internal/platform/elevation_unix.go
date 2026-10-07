//go:build unix

package platform

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
)

// Elev is what elevating from this agent would meet (S42b P29).
type Elev struct {
	Elevated bool   // root, or an elevated token
	Admin    *bool  // Windows: a member of Administrators; nil elsewhere
	Sudo     string // see facts.Elevation
	Said     string // sudo's own first line when it refused
}

// Elevation: whether the agent already runs as root, and what `sudo -n
// true` did. -n never asks for a password; it fails instead, which is the
// answer. sudo runs bounded (runBounded): a sudo that gives no answer by
// ctx's end — a PAM module waiting on a directory server — is waited for no
// longer, and is an error, never "refused". So is a sudo that never started.
func Elevation(ctx context.Context, r Runner) (Elev, error) {
	e := Elev{Elevated: os.Geteuid() == 0}
	_, err := runBounded(ctx, "sudo", func(ctx context.Context) (string, error) {
		return r.Run(ctx, "sudo", []string{"-n", "true"}, "")
	})
	var re *RunError
	switch {
	case err == nil:
		e.Sudo = "no_password"
	case errors.Is(err, exec.ErrNotFound):
		e.Sudo = "absent"
	case OutOfTime(err), errors.As(err, &re) && re.NotStarted:
		return e, err
	default:
		e.Sudo = "refused"
		e.Said, _, _ = strings.Cut(err.Error(), "\n")
	}
	return e, nil
}
