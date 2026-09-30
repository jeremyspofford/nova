//go:build unix

package platform

import (
	"context"
	"errors"
	"fmt"
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
// answer. A sudo stopped at ctx's bound (a PAM module waiting on a directory
// server) answered nothing: that is an error, never "refused" — on its kill
// sudo exits non-zero like a refusal would.
func Elevation(ctx context.Context, r Runner) (Elev, error) {
	e := Elev{Elevated: os.Geteuid() == 0}
	_, err := r.Run(ctx, "sudo", []string{"-n", "true"}, "")
	switch {
	case err == nil:
		e.Sudo = "no_password"
	case errors.Is(err, exec.ErrNotFound):
		e.Sudo = "absent"
	case ctx.Err() != nil:
		return e, fmt.Errorf("sudo -n true gave no answer in time (%v)", ctx.Err())
	default:
		e.Sudo = "refused"
		e.Said, _, _ = strings.Cut(err.Error(), "\n")
	}
	return e, nil
}
