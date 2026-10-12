package caps

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// signalJob ends a job's child and its whole tree at once: Windows has no
// polite group signal for a detached console-less process, so the first call
// is already the hard one (taskkill /T /F) and the second does nothing.
func signalJob(pid int, hard bool) error {
	if hard {
		return nil
	}
	out, err := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).CombinedOutput()
	if err != nil {
		// 128: no such process — it already ended.
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 128 {
			return nil
		}
		return fmt.Errorf("taskkill: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

const (
	processQueryLimitedInformation = 0x1000
	stillActive                    = 259
)

// processAlive reports whether pid names a running process.
func processAlive(pid int) bool {
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		// Access denied means it exists.
		return err == syscall.ERROR_ACCESS_DENIED
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return true
	}
	return code == stillActive
}
