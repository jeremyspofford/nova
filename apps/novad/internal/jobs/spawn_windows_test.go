package jobs

import (
	"testing"

	"golang.org/x/sys/windows"
)

// C5 (Windows, vet-compiled here): breakaway first, then without it — and the
// second attempt says the job will not outlive the supervisor.
func TestWindowsSpawnAttempts(t *testing.T) {
	at := attempts(`C:\nova\novad.exe`, `C:\state\jobs\0123456789ab`, "0123456789ab", "run-key")
	if len(at) != 2 {
		t.Fatalf("attempts = %+v", at)
	}
	base := uint32(windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW)
	if at[0].attr.CreationFlags != base|windows.CREATE_BREAKAWAY_FROM_JOB || !at[0].survives {
		t.Fatalf("first attempt = %+v", at[0])
	}
	if at[1].attr.CreationFlags != base || at[1].survives || at[1].caveat == "" {
		t.Fatalf("second attempt = %+v", at[1])
	}
	for _, a := range at {
		if len(a.argv) != 3 || a.argv[1] != "job-exec" {
			t.Fatalf("argv = %q", a.argv)
		}
	}
}
