package jobs

import (
	"syscall"

	"golang.org/x/sys/windows"
)

type sysProcAttr = syscall.SysProcAttr

// attempts: no console, its own process group, and out of the supervisor's
// kill-on-close job — which allows that only when the supervisor made the
// job with BREAKAWAY_OK (S30c on). Without breakaway it still runs, and says
// it ends with the supervisor.
func attempts(bin, dir, id, mode string) []attempt {
	base := uint32(windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW)
	argv := []string{bin, "job-exec", dir}
	return []attempt{
		{label: "breakaway", argv: argv, survives: true,
			attr: &syscall.SysProcAttr{CreationFlags: base | windows.CREATE_BREAKAWAY_FROM_JOB, HideWindow: true}},
		{label: "in the agent's job", argv: argv,
			attr:   &syscall.SysProcAttr{CreationFlags: base, HideWindow: true},
			caveat: "the agent's job does not allow breakaway (its supervisor predates S30c), so this job ends when novad's supervisor does"},
	}
}
