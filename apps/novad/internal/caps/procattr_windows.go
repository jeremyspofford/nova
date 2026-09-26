package caps

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// taskkillWait bounds how long the taskkill helper process itself may run,
// so a hung taskkill can never defeat killGrace.
const taskkillWait = 3 * time.Second

// prepareCommand starts the command in a new process group and makes a
// cancel take the whole TREE (taskkill /T) — wsl.exe and anything it
// started. WSL_UTF8=1 makes wsl.exe print UTF-8 instead of UTF-16, like
// every other program's output here.
//
// Cancel's return value is the only thing shell.go's killedByCancel trusts,
// so it must answer one question about the ROOT process, never taskkill's
// own exit code: was the root alive and is it now dead because of this
// call (nil), or had it already exited (os.ErrProcessDone)? taskkill /T /F
// can exit nonzero even after successfully killing the root — a descendant
// that exits mid-kill makes it report "There is no running instance of the
// task" for that PID — so the root's own handle is checked directly, both
// before spending any effort and after.
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		pid := cmd.Process.Pid

		h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
		if err != nil {
			// No handle to check the root's own state with — the best we
			// can still do is kill the root directly.
			return cmd.Process.Kill()
		}
		defer windows.CloseHandle(h)

		if signaled(h, 0) {
			// The root had already exited before this Cancel could matter.
			return os.ErrProcessDone
		}

		// Best-effort: take the whole tree with it. Bounded so a hung
		// taskkill cannot itself defeat killGrace; its exit code is not
		// consulted — the handle below is the verdict.
		tctx, tcancel := context.WithTimeout(context.Background(), taskkillWait)
		_ = exec.CommandContext(tctx, taskkillPath(), "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
		tcancel()

		if signaled(h, 2*time.Second) {
			return nil
		}
		// Still alive per its own handle: taskkill missed the root (or
		// never ran). Kill it directly.
		if killErr := cmd.Process.Kill(); killErr != nil {
			if signaled(h, 0) {
				// Died between the check above and this Kill call.
				return nil
			}
			return killErr
		}
		return nil
	}
	cmd.WaitDelay = killGrace
	cmd.Env = append(os.Environ(), "WSL_UTF8=1")
}

// signaled reports whether the process behind h has already exited, waiting
// up to d for it to do so.
func signaled(h windows.Handle, d time.Duration) bool {
	ev, err := windows.WaitForSingleObject(h, uint32(d.Milliseconds()))
	return err == nil && ev == windows.WAIT_OBJECT_0
}

// taskkillPath is System32\taskkill.exe under %SystemRoot%, falling back to
// C:\Windows on the rare machine where that variable is unset.
func taskkillPath() string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32", "taskkill.exe")
}
