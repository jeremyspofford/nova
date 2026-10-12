//go:build unix

package jobs

import "syscall"

type sysProcAttr = syscall.SysProcAttr

// attempts: its own session always (no signal aimed at the agent's group or
// session reaches it). Under systemd that is not enough — stopping or
// restarting novad's unit kills every process in the unit's cgroup — so the
// wrapper first goes into a transient scope of its own; when that cannot be
// made it still runs, and says it will not survive a restart of novad.
func attempts(bin, dir, id, mode string) []attempt {
	plain := attempt{label: "setsid", argv: []string{bin, "job-exec", dir},
		attr: &syscall.SysProcAttr{Setsid: true}, survives: true}
	if mode != ModeSystemd {
		return []attempt{plain}
	}
	unit := "novad-job-" + id
	scope := attempt{label: "systemd scope " + unit,
		argv: []string{SystemdRun, "--user", "--scope", "--collect", "--quiet", "--unit", unit, "--", bin, "job-exec", dir},
		attr: &syscall.SysProcAttr{Setsid: true}, survives: true}
	plain.survives = false
	plain.caveat = "it runs in novad's own cgroup, so a stop or restart of novad's service (systemd kills the whole cgroup) ends this job"
	return []attempt{scope, plain}
}
