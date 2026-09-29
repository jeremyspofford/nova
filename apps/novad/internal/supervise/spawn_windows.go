package supervise

import (
	"context"
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ExecSpawner starts agents with no window, logging to logPath (1 MiB, one
// rotation — there is no console), inside a kill-on-close job object: when
// this supervisor ends, however it ends, its agent ends with it (P6).
func ExecSpawner(logPath string) Spawner {
	job, jobErr := killOnCloseJob()
	return func(_ context.Context, bin string, args, env []string) (Child, error) {
		rotate(logPath, 1<<20)
		f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		cmd := exec.Command(bin, args...)
		cmd.Env = env
		cmd.Stdout, cmd.Stderr = f, f
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		if jobErr == nil {
			if h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid)); err == nil {
				_ = windows.AssignProcessToJobObject(job, h)
				windows.CloseHandle(h)
			}
		}
		return &execChild{cmd: cmd}, nil
	}
}

func killOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func rotate(path string, max int64) {
	if fi, err := os.Stat(path); err == nil && fi.Size() > max {
		_ = os.Rename(path, path+".1")
	}
}

// Kill ends the agent at once: Windows has no SIGTERM to ask with.
func (c *execChild) Kill() error { return c.cmd.Process.Kill() }
