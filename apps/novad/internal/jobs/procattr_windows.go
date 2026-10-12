package jobs

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// prepareChild starts the job's child in its own process group with no
// console window: job.stop takes the tree with taskkill /T, and a console
// Ctrl+C aimed at the wrapper's group never reaches it.
func prepareChild(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW,
		HideWindow:    true,
	}
}
