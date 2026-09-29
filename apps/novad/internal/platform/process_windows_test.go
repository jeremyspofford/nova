package platform

import (
	"os"
	"testing"
	"time"
)

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
