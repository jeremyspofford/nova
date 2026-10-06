//go:build unix

package platform

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"testing"
	"time"
)

// P29: what `sudo -n true` did, never a guess — and -n never asks anyone.
func TestElevationSaysWhatSudoDid(t *testing.T) {
	cases := []struct {
		name, sudo, said string
		err              error
	}{
		{"no password needed", "no_password", "", nil},
		{"a password is required", "refused", "sudo: exit status 1: sudo: a password is required",
			errors.New("sudo: exit status 1: sudo: a password is required")},
		{"no sudo here", "absent", "", &exec.Error{Name: "sudo", Err: exec.ErrNotFound}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := &FakeRunner{Outputs: map[string]string{"sudo": ""}}
			if c.err != nil {
				r.Errs = map[string]error{"sudo": c.err}
			}
			e, err := Elevation(context.Background(), r)
			if err != nil || e.Sudo != c.sudo || e.Said != c.said || e.Admin != nil {
				t.Fatalf("got %+v, %v", e, err)
			}
			if len(r.Calls) != 1 || !reflect.DeepEqual(r.Calls[0].Args, []string{"-n", "true"}) {
				t.Fatalf("calls = %+v — only `sudo -n true`, which never asks", r.Calls)
			}
		})
	}
}

// Fix round 1, I1: a sudo that ignores its kill — once it runs as root, an
// unprivileged agent's SIGKILL gets EPERM — is waited for no longer than its
// bound, and is no answer: an error, never "refused".
func TestASudoThatIgnoresItsKillIsLeftAtItsBoundNeverARefusal(t *testing.T) {
	hold := make(chan struct{})
	defer close(hold)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var e Elev
	var err error
	returnsWithin(t, 2*time.Second, func() { e, err = Elevation(ctx, &FakeRunner{Hold: hold}) })
	if !errors.Is(err, ErrNoAnswer) || e.Sudo == "refused" || err.Error() != "sudo: gave no answer in time" {
		t.Fatalf("got %+v, %v", e, err)
	}
}

// A sudo that never started — no time was left, or it could not be run —
// did not refuse anything either.
func TestASudoThatNeverStartedIsNeverARefusal(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &FakeRunner{Outputs: map[string]string{"sudo": ""}}
	e, err := Elevation(ctx, r)
	if !errors.Is(err, ErrNoTime) || e.Sudo == "refused" || len(r.Calls) != 0 {
		t.Fatalf("got %+v, %v after %d calls", e, err, len(r.Calls))
	}
	denied := &RunError{Name: "sudo", Err: errors.New("fork/exec /usr/bin/sudo: permission denied"), NotStarted: true}
	e, err = Elevation(context.Background(), &FakeRunner{Errs: map[string]error{"sudo": denied}})
	if err != denied || e.Sudo == "refused" {
		t.Fatalf("got %+v, %v", e, err)
	}
}
