//go:build !windows

package supervise

import (
	"context"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// Output is where a supervisor and its agents write on Linux and macOS: this
// process's own stdout and stderr, which the service manager keeps (the
// journal under systemd, the plist's log under launchd) — so there is no Log.
func Output(string) (io.Writer, *Log, error) { return os.Stderr, nil, nil }

// ExecSpawner starts agents with this process's output (the journal under
// systemd, the plist's log under launchd); the Log is Windows' only. Kill
// asks politely — `novad run` handles SIGTERM — and forces after 10 s.
func ExecSpawner(*Log) Spawner {
	return func(_ context.Context, bin string, args, env []string) (Child, error) {
		cmd := exec.Command(bin, args...)
		cmd.Env = env
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		return &execChild{cmd: cmd}, nil
	}
}

func (c *execChild) Kill() error {
	p := c.cmd.Process
	time.AfterFunc(10*time.Second, func() { _ = p.Kill() })
	return p.Signal(syscall.SIGTERM)
}
