//go:build unix

package jobs

import "testing"

// pid 1 is alive and not ours (EPERM): alive.
func TestProcessAliveReadsAnotherUsersProcessAsAlive(t *testing.T) {
	if !ProcessAlive(1) {
		t.Error("pid 1 reads as not alive")
	}
	if ProcessAlive(0) || ProcessAlive(-1) {
		t.Error("pid 0 or -1 reads as alive")
	}
}
