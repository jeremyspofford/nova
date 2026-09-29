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

// Restart stops the running supervisor and agent (their pids from the status
// files, checked to be novad before anything is ended), then starts
// supervise detached, as the Run key would at sign-in.
func (k *runKey) Restart(ctx context.Context) error {
	if k.bin == "" {
		return errors.New("cannot restart: the Run key was not written in this run")
	}
	_ = k.Stop(ctx)
	_, err := platform.StartDetached(k.bin, []string{"supervise", "--mode", ModeRunKey, "--detached"},
		filepath.Join(k.paths.StateDir, state.LogFile))
	return err
}

func (k *runKey) RestartLater(context.Context, time.Duration) error {
	return errors.New("cannot: a Windows agent updates through its supervisor, never by a delayed restart")
}

func (k *runKey) Stop(context.Context) error {
	var sv state.SupervisorStatus
	if state.ReadJSON(filepath.Join(k.paths.StateDir, state.SupervisorStatusFile), &sv) == nil {
		for _, pid := range []int{sv.PID, sv.ChildPID} {
			if pid > 0 && platform.ProcessIsNovad(pid) {
				_ = platform.Terminate(pid)
			}
		}
	}
	var ag state.AgentStatus
	if state.ReadJSON(filepath.Join(k.paths.StateDir, state.AgentStatusFile), &ag) == nil && ag.PID > 0 && platform.ProcessIsNovad(ag.PID) {
		_ = platform.Terminate(ag.PID)
	}
	return nil
}

func (k *runKey) Uninstall(ctx context.Context) error {
	_ = k.Stop(ctx)
	key, err := registry.OpenKey(registry.CURRENT_USER, k.keyPath, registry.SET_VALUE)
	if err != nil {
		return nil // no key, no value
	}
	defer key.Close()
	if err := key.DeleteValue(k.value); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

func (k *runKey) BootStart(context.Context) (bool, string, error) {
	return false, "starts at sign-in (the Windows Run key), not before sign-in", nil
}
