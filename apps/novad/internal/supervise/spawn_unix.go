//go:build !windows

package supervise

import (
	"context"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// ExecSpawner starts agents with this process's output (the journal under
// systemd, the plist's log under launchd). Kill asks politely — `novad run`
// handles SIGTERM — and forces after 10 s.
func ExecSpawner(_ string) Spawner {
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
