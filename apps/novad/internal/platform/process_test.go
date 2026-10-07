package platform

import (
	"errors"
	"strings"
	"testing"
)

// Task 32, L100: TerminateNovad's answer for a pid it could not open, run on
// every OS (the decision is kept apart from Windows' own calls). Only the
// open's own "no such process", or a pid the process list no longer holds, is
// gone. A pid listed as another program is not this caller's to end. One
// listed as novad is running and cannot be ended from here — never "already
// gone" — and a list that cannot be read leaves it unknown, which is no
// "gone" either.
func TestAPidThatCouldNotBeOpenedIsGoneOnlyWhenTheOSSaysSo(t *testing.T) {
	denied := errors.New("Access is denied.")
	listedAs := func(image string, err error) func(int) (string, error) {
		return func(int) (string, error) { return image, err }
	}
	for _, tc := range []struct {
		name    string
		gone    bool
		listed  func(int) (string, error)
		wantErr string
	}{
		// The list must not even be asked: asked, its error would surface.
		{"the open said no such process", true, listedAs("", errors.New("asked anyway")), ""},
		{"no longer listed", false, listedAs("", errNotListed), ""},
		{"listed as another program", false, listedAs("svchost.exe", nil), ""},
		{"listed as novad", false, listedAs("novad.exe", nil), "pid 4242 runs novad.exe, and it cannot be ended from here"},
		{"listed as novad in capitals", false, listedAs("NOVAD.EXE", nil), "cannot be ended from here"},
		{"the list could not be read", false, listedAs("", errors.New("snapshot failed")), "the process list could not say what runs there: snapshot failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := unopened(4242, denied, tc.gone, tc.listed)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("got %v, want nil", err)
				}
				return
			}
			if err == nil || !errors.Is(err, denied) || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("got %v, want an error carrying the open's own failure and %q", err, tc.wantErr)
			}
		})
	}
}

// Fix round 1, Minor 2: pid <= 0 must never be treated as a live, terminable
// process, on any OS. On Unix, kill(0) signals the caller's own process
// group and kill(-1) signals every process the caller can signal — so an
// unguarded Terminate(-1) would end the whole session, not "the process that
// turned out not to be running". This runs against whichever OS's
// ProcessAlive/Terminate this package built (process_unix.go or
// process_windows.go): both must refuse the same way.
func TestProcessAliveAndTerminateRefusePidZeroOrNegative(t *testing.T) {
	for _, pid := range []int{0, -1} {
		if ProcessAlive(pid) {
			t.Errorf("ProcessAlive(%d) must be false", pid)
		}
		if err := Terminate(pid); err == nil {
			t.Errorf("Terminate(%d) must refuse, not silently succeed", pid)
		}
	}
}
