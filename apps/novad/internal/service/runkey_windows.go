package service

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/registry"

	"novad/internal/config"
	"novad/internal/platform"
	"novad/internal/state"
)

type runKey struct {
	paths   config.Paths
	keyPath string // RunKeyPath; a test points it at a scratch key
	value   string
	bin     string
}

// New is the Windows manager: the HKCU Run key (P6).
func New(paths config.Paths, _ platform.Runner) Manager {
	return &runKey{paths: paths, keyPath: RunKeyPath, value: RunKeyValue}
}

func (k *runKey) Mode() string     { return ModeRunKey }
func (k *runKey) Describe() string { return "the Windows Run key (starts at sign-in)" }

func (k *runKey) Installed() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, k.keyPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	_, _, err = key.GetStringValue(k.value)
	return err == nil
}

func (k *runKey) Install(bin string) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, k.keyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return fmt.Errorf(`opening HKCU\%s: %w`, k.keyPath, err)
	}
	defer key.Close()
	want := RunKeyCommand(bin)
	if err := key.SetStringValue(k.value, want); err != nil {
		return err
	}
	if got, _, err := key.GetStringValue(k.value); err != nil || got != want {
		return fmt.Errorf("the Run key did not read back as written (got %q, %v)", got, err)
	}
	k.bin = bin
	return nil
}

// stopTimeout bounds how long Stop waits for a novad process it terminates to
// actually exit (Fix round 1, Important 1). Restart only launches a new
// supervisor after Stop returns nil, so a lock file the dying supervisor
// still held cannot make the new one exit at once thinking one already runs
// (P3's HeldError) and leave the machine with no agent until next sign-in.
const stopTimeout = 10 * time.Second

// Restart stops the running supervisor and agent (their pids from the status
// files, verified to be novad and waited for on the SAME handle —
// platform.TerminateNovad — before anything is reported ended), then starts
// supervise detached, as the Run key would at sign-in. It launches only after
// Stop reports every novad pid it found actually ended.
func (k *runKey) Restart(ctx context.Context) error {
	if k.bin == "" {
		return errors.New("cannot restart: the Run key was not written in this run")
	}
	if err := k.Stop(ctx); err != nil {
		return fmt.Errorf("cannot restart: the running agent did not stop: %w", err)
	}
	_, err := platform.StartDetached(k.bin, []string{"supervise", "--mode", ModeRunKey, "--detached"},
		filepath.Join(k.paths.StateDir, state.LogFile))
	return err
}

var _ RestartLaterRefuser = (*runKey)(nil)

// RestartLaterRefusal is what RestartLater always answers, asked up front
// (RestartLaterRefuser).
func (k *runKey) RestartLaterRefusal() error {
	return errors.New("cannot: a Windows agent updates through its supervisor, never by a delayed restart")
}

func (k *runKey) RestartLater(context.Context, time.Duration) error {
	return k.RestartLaterRefusal()
}

// Stop ends the pids the status files name, when they are still running a
// novad image — never a pid Windows reused for something else — and reports
// an error naming any of them that did not actually end within stopTimeout.
// A status file that does not exist, or names no pid, is not an error: there
// is simply nothing recorded to stop.
func (k *runKey) Stop(context.Context) error {
	var pids []int
	var sv state.SupervisorStatus
	if state.ReadJSON(filepath.Join(k.paths.StateDir, state.SupervisorStatusFile), &sv) == nil {
		pids = append(pids, sv.PID, sv.ChildPID)
	}
	var ag state.AgentStatus
	if state.ReadJSON(filepath.Join(k.paths.StateDir, state.AgentStatusFile), &ag) == nil {
		pids = append(pids, ag.PID)
	}
	var errs []error
	for _, pid := range pids {
		if pid <= 0 {
			continue
		}
		if err := platform.TerminateNovad(pid, stopTimeout); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// Uninstall stops any running instance and removes the Run value (Manager).
// Even when a process would not stop, the autostart definition still comes
// out — and the stop's failure is returned (stopErr), never swallowed: the
// agent may still be running (Task 32, L90). Stop reads the pids the status
// files name, so with nothing recorded it is quiet, and it runs whether or
// not the value is there. Only "the key does not exist" is treated as
// nothing to do — any other error opening it (permissions, a malformed path,
// …) is a real problem and is returned, never silently read as "already
// uninstalled".
func (k *runKey) Uninstall(ctx context.Context) (stopErr, err error) {
	stopErr = k.Stop(ctx)
	key, err := registry.OpenKey(registry.CURRENT_USER, k.keyPath, registry.SET_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return stopErr, nil // no key, no value
		}
		return stopErr, err
	}
	defer key.Close()
	if err := key.DeleteValue(k.value); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return stopErr, err
	}
	return stopErr, nil
}

func (k *runKey) BootStart(context.Context) (bool, string, error) {
	return false, "starts at sign-in (the Windows Run key), not before sign-in", nil
}
