package platform

import "golang.org/x/sys/windows"

// WSL is Linux's; the Windows agent reaches WSL through wsl.exe.
func WSL() (bool, string) { return false, "" }

// Interactive is whether this process runs in a user's desktop session. A
// service runs in session 0, where a toast or a window never shows.
func Interactive() bool {
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err != nil {
		return false
	}
	return session != 0
}

// osMode is foreground: a Windows agent's service mode arrives from its
// supervisor (mode.go).
func osMode() string { return "foreground" }
