package supervise

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// S30c T3: the agent's kill-on-close job lets a job wrapper break away (the
// agent itself still dies with the supervisor).
func TestAgentJobAllowsBreakaway(t *testing.T) {
	want := uint32(windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK)
	if agentJobLimits != want {
		t.Fatalf("agentJobLimits = %#x, want %#x", agentJobLimits, want)
	}
	job, err := killOnCloseJob()
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(job)
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
		t.Fatal(err)
	}
	if info.BasicLimitInformation.LimitFlags&want != want {
		t.Fatalf("job limit flags = %#x", info.BasicLimitInformation.LimitFlags)
	}
}
