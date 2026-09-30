//go:build unix

package platform

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"testing"
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

// A sudo stopped at its bound (a PAM module waiting on a directory server)
// did not refuse anything: it is said unreadable, never "refused" — its kill
// would otherwise read as sudo's own answer.
func TestASudoStoppedAtItsBoundIsNeverARefusal(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &FakeRunner{Errs: map[string]error{"sudo": errors.New("sudo: signal: killed")}}
	e, err := Elevation(ctx, r)
	if err == nil || e.Sudo == "refused" {
		t.Fatalf("got %+v, %v", e, err)
	}
}
