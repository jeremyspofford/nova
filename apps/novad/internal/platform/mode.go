package platform

import "os"

// ModeEnv is how `novad supervise` tells its agent which way the service
// started (S42b P4); SupervisorEnv carries the supervisor's pid. The service
// definitions (unit, plist, Run key) pass --mode to supervise, and supervise
// passes it on here.
const (
	ModeEnv       = "NOVA_AGENT_MODE"
	SupervisorEnv = "NOVA_SUPERVISOR_PID"
)

var serviceModes = map[string]bool{"systemd-user": true, "launch-agent": true, "run-key": true}

// Mode is how this agent was started: its supervisor's word when that is a
// service mode Nova knows, else what the OS can tell by itself (osMode). An
// unknown word is never reported.
func Mode() string {
	if m := os.Getenv(ModeEnv); serviceModes[m] {
		return m
	}
	return osMode()
}

// Supervised is whether `novad supervise` started this process — the one
// case in which exiting to be restarted into a new build is safe.
func Supervised() bool { return os.Getenv(SupervisorEnv) != "" }
