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
// own exit code: nil when the root was alive and is now dead because of
// this call, os.ErrProcessDone when it had already exited. taskkill /T /F
// can exit nonzero even after successfully killing the root — a descendant
// that exits mid-kill makes it report "There is no running instance of the
// task" for that PID — so the root's own state is checked directly instead
// of trusting taskkill's exit code.
//
// The root's handle comes from cmd.Process.WithHandle, never a fresh
// OpenProcess(pid). Cancel can run AFTER Cmd.Wait has already reaped the
// root: watchCtx's ctx.Done race (exec.Cmd.watchCtx) can fire and decide to
// call Cancel before Cmd.Wait's own concurrent c.Process.Wait() completes,
// but then lose the second race — the reap finishing before Cancel's body
// actually runs. By then Go has closed its own handle and marked the
// Process released, and the PID may already have been reused by an
// unrelated process, so opening a fresh handle by PID could hit that
// unrelated process instead (and taskkill would then hit an unrelated
// tree). WithHandle instead reuses Go's OWN handle — guaranteed to still
// refer to the right process for as long as the callback runs — and simply
// errors when Wait has already consumed it, which is treated as
// os.ErrProcessDone.
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		pid := cmd.Process.Pid

		var result error
		err := cmd.Process.WithHandle(func(handle uintptr) {
			h := windows.Handle(handle)

			if signaled(h, 0) {
				// The root had already exited before this Cancel could matter.
				result = os.ErrProcessDone
				return
			}

			// Best-effort: take the whole tree with it. Bounded so a hung
			// taskkill cannot itself defeat killGrace; its exit code is not
			// consulted — the handle is the verdict, not taskkill's status.
			tctx, tcancel := context.WithTimeout(context.Background(), taskkillWait)
			_ = exec.CommandContext(tctx, taskkillPath(), "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
			tcancel()

			if signaled(h, 2*time.Second) {
				result = nil
				return
			}
			// Still alive per its own handle: taskkill missed the root (or
			// never ran). Terminate it directly.
			if killErr := windows.TerminateProcess(h, 1); killErr != nil {
				if signaled(h, 0) {
					// Died between the check above and this call.
					result = nil
					return
				}
				result = killErr
				return
			}
			result = nil
		})
		if err != nil {
			// WithHandle errors only when Wait has already consumed the
			// Process (or, in principle, when handles are unsupported —
			// not the case on Windows): the root exited before this Cancel
			// could matter.
			return os.ErrProcessDone
		}
		return result
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
