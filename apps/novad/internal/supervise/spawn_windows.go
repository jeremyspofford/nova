package supervise

import (
	"context"
	"io"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Output is where a supervisor and its agents write on Windows, which keeps
// no journal: novad.log, rotated at 1 MiB with one generation kept (P6). This
// process's own output — its lines, and a crash — follows the log across a
// rotation.
func Output(logPath string) (io.Writer, *Log, error) {
	lg, err := OpenLog(logPath)
	if err != nil {
		return nil, nil, err
	}
	if err := lg.captureProcessOutput(); err != nil {
		lg.say("this process's own output does not follow %s: %v", logPath, err)
	}
	return lg, lg, nil
}

// newJob is killOnCloseJob; a test makes it fail.
var newJob = killOnCloseJob

// ExecSpawner starts agents with no window, writing to lg — rotated first
// when it is over its limit — inside a kill-on-close job object: when this
// supervisor ends, however it ends, its agent ends with it (P6). A job that
// cannot be made, or an agent that cannot be put in it, is written to lg:
// the agent still runs, but would outlive a supervisor that is killed.
func ExecSpawner(lg *Log) Spawner {
	job, jobErr := newJob()
	if jobErr != nil {
		lg.say("no kill-on-close job (%v): an agent will outlive this supervisor if it is killed", jobErr)
	}
	return func(_ context.Context, bin string, args, env []string) (Child, error) {
		_ = lg.Rotate() // a failed rotation is written into the log itself
		cmd := exec.Command(bin, args...)
		cmd.Env = env
		if out := lg.file(); out != nil {
			cmd.Stdout, cmd.Stderr = out, out
		}
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		if jobErr == nil {
			if err := assignToJob(job, cmd.Process.Pid); err != nil {
				lg.say("agent pid %d is not in the kill-on-close job (%v): it will outlive this supervisor if it is killed",
					cmd.Process.Pid, err)
			}
		}
		return &execChild{cmd: cmd}, nil
	}
}

func assignToJob(job windows.Handle, pid int) error {
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.AssignProcessToJobObject(job, h)
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

// Kill ends the agent at once: Windows has no SIGTERM to ask with.
func (c *execChild) Kill() error { return c.cmd.Process.Kill() }
