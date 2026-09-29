package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"novad/internal/config"
	"novad/internal/platform"
	"novad/internal/service"
	"novad/internal/state"
	"novad/internal/supervise"
)

// cmdSupervise is what every service definition starts (P3, P4, P6).
func cmdSupervise(argv []string) {
	fs := flag.NewFlagSet("supervise", flag.ExitOnError)
	mode := fs.String("mode", "", "how the service started it: systemd-user | launch-agent | run-key")
	detached := fs.Bool("detached", false, "(Windows) already running without a console")
	_ = fs.Parse(argv)
	switch *mode {
	case service.ModeSystemd, service.ModeLaunch, service.ModeRunKey:
	default:
		fail("supervise needs --mode systemd-user, launch-agent or run-key (the service definition passes it)")
	}
	paths, err := config.DefaultPaths()
	if err != nil {
		fail("%v", err)
	}
	self, err := os.Executable()
	if err != nil {
		fail("%v", err)
	}
	logPath := filepath.Join(paths.StateDir, state.LogFile)
	if runtime.GOOS == "windows" && !*detached {
		// The Run key started a console program: start again with no console
		// and let this one go (the brief flash P0-20 measured).
		if _, err := platform.StartDetached(self, []string{"supervise", "--mode", *mode, "--detached"}, logPath); err != nil {
			fail("could not start detached: %v", err)
		}
		return
	}
	lock, err := state.Acquire(filepath.Join(paths.StateDir, state.SuperviseLockFile))
	if err != nil {
		var held *state.HeldError
		if errors.As(err, &held) {
			fmt.Fprintf(os.Stderr, "novad: %v — a supervisor already runs this agent\n", err)
			return
		}
		fail("%v", err)
	}
	logger := log.New(os.Stderr, "novad supervise ", log.LstdFlags)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	code := supervise.Run(ctx, supervise.Config{
		Binary: self, StateDir: paths.StateDir, Mode: *mode, Version: version,
		Spawn: supervise.ExecSpawner(logPath), Logf: logger.Printf,
	})
	stop()
	_ = lock.Release()
	os.Exit(code)
}
