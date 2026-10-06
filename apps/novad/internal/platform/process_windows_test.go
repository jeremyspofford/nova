package platform

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// openDenied makes TerminateNovad's open fail with access denied, and the
// process list name image (or fail with lerr).
func openDenied(t *testing.T, image string, lerr error) {
	t.Helper()
	oldOpen, oldList := openProcess, listedImage
	t.Cleanup(func() { openProcess, listedImage = oldOpen, oldList })
	openProcess = func(uint32, bool, uint32) (windows.Handle, error) { return 0, windows.ERROR_ACCESS_DENIED }
	listedImage = func(int) (string, error) { return image, lerr }
}

// Task 32, L100: access denied on a pid still running novad is not "already
// gone": the process is alive and this caller cannot end it.
func TestTerminateNovadSaysANovadItCannotOpenIsNotGone(t *testing.T) {
	openDenied(t, "novad.exe", nil)
	if err := TerminateNovad(4242, time.Second); err == nil || !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("a novad that cannot be opened must be an error carrying why, got %v", err)
	}
}

// ...while a denied pid the list names as another program is a pid Windows
// reused — not this caller's to end, and no error.
func TestTerminateNovadLeavesAnotherProgramItCannotOpenAlone(t *testing.T) {
	openDenied(t, "svchost.exe", nil)
	if err := TerminateNovad(4242, time.Second); err != nil {
		t.Fatalf("another program's pid must be left alone, got %v", err)
	}
}

// The real process list: this process is listed by its own image name, and a
// pid no process holds is not listed.
func TestTheProcessListNamesThisProcessAndNotAPidNothingHolds(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	got, err := listImage(os.Getpid())
	if err != nil || !strings.EqualFold(got, filepath.Base(self)) {
		t.Fatalf("listImage(self) = %q, %v; want %q", got, err, filepath.Base(self))
	}
	if _, err := listImage(1 << 30); !errors.Is(err, errNotListed) {
		t.Fatalf("a pid nothing holds must be errNotListed, got %v", err)
	}
}

// Fix round 1, Important 1: TerminateNovad must verify identity before
// touching a pid. This runs it against the TEST BINARY'S OWN pid, whose
// image is plainly not named novad — the test process finishing normally
// afterward (and ProcessAlive still reporting it running right up to that
// point) is the proof TerminateNovad left it alone instead of ending it.
func TestTerminateNovadLeavesANonNovadProcessAlone(t *testing.T) {
	self := os.Getpid()
	if !ProcessAlive(self) {
		t.Fatal("this process must be reported alive before the call")
	}
	if err := TerminateNovad(self, time.Second); err != nil {
		t.Fatalf("a non-novad image must be left alone, not errored: %v", err)
	}
	if !ProcessAlive(self) {
		t.Fatal("this process must still be running — TerminateNovad touched a pid it must not have")
	}
}

// A pid this large is far beyond any real Windows pid (always a multiple of
// 4, in practice well under 2^20): OpenProcess on it fails as "already
// gone", which TerminateNovad must treat as success, not an error.
func TestTerminateNovadIsFineWhenThePidIsAlreadyGone(t *testing.T) {
	if err := TerminateNovad(1<<30, time.Second); err != nil {
		t.Fatalf("an already-gone pid must not be an error, got %v", err)
	}
}

func TestTerminateNovadRefusesPidZeroOrNegative(t *testing.T) {
	for _, pid := range []int{0, -1} {
		if err := TerminateNovad(pid, time.Second); err == nil {
			t.Errorf("TerminateNovad(%d) must refuse, not silently succeed", pid)
		}
	}
}
