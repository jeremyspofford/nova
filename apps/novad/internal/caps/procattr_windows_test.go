package caps

import (
	"errors"
	"fmt"
	"testing"

	"golang.org/x/sys/windows"
)

// TestAKillThisCancelStartedIsNeverReportedAsRan pins Cancel's answer once it
// has fallen back to TerminateProcess on the root (final review I3). The root
// was alive when Cancel began and taskkill /T /F was sent to it; if it is still
// dying 2 s later, TerminateProcess on Go's own full-access handle fails with
// ERROR_ACCESS_DENIED — what Windows returns for a process already
// terminating. Returning that error left killedByCancel false, and Wait then
// handed back the process's own non-zero exit, so shell.exec said
// "[process exited with code 1]" for a command novad killed. Every row that
// is the kill this Cancel started must answer nil, so the call reads as timed
// out or cancelled; only a failure that confirms nothing is returned.
func TestAKillThisCancelStartedIsNeverReportedAsRan(t *testing.T) {
	cases := []struct {
		name    string
		killErr error
		exited  bool
		want    error
	}{
		{"terminated by this call", nil, false, nil},
		{"already terminating: access denied on Go's own handle", windows.ERROR_ACCESS_DENIED, false, nil},
		{"access denied, wrapped", fmt.Errorf("terminate: %w", windows.ERROR_ACCESS_DENIED), false, nil},
		{"exited between the check and the call", windows.ERROR_INVALID_HANDLE, true, nil},
		{"any other failure confirms no kill", windows.ERROR_INVALID_HANDLE, false, windows.ERROR_INVALID_HANDLE},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := terminateVerdict(c.killErr, c.exited)
			if c.want == nil && got != nil {
				t.Fatalf("terminateVerdict(%v, %v) = %v, want nil: a kill this Cancel started must never read as a command that ran", c.killErr, c.exited, got)
			}
			if c.want != nil && !errors.Is(got, c.want) {
				t.Fatalf("terminateVerdict(%v, %v) = %v, want %v", c.killErr, c.exited, got, c.want)
			}
		})
	}
}
