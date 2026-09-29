package platform

import "testing"

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
