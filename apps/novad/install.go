package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"novad/internal/config"
	"novad/internal/install"
	"novad/internal/platform"
	"novad/internal/service"
)

// exitNeedsCode is install's exit when this machine has no live pairing and
// no code was given: ./install mints one and runs install again.
const exitNeedsCode = 3

// pairingCodeEnv is how ./install hands install a code: never on a command
// line (ps shows those), never in its output.
const pairingCodeEnv = "NOVA_PAIRING_CODE"

type hubList []string

func (h *hubList) String() string     { return strings.Join(*h, ",") }
func (h *hubList) Set(v string) error { *h = append(*h, strings.TrimRight(v, "/")); return nil }

func installExit(err error) int {
	switch {
	case err == nil:
		return 0
	case errors.Is(err, install.ErrNeedsCode):
		return exitNeedsCode
	default:
		return 1
	}
}

// pairingCode is --code, else NOVA_PAIRING_CODE. The variable leaves this
// process's environment either way, so nothing install starts inherits the
// code: on Windows the supervisor it starts detached would, and so would
// every command the agent ran for her after it — and the code never reaches
// her context.
func pairingCode(flagValue string) string {
	env := os.Getenv(pairingCodeEnv)
	_ = os.Unsetenv(pairingCodeEnv)
	if flagValue != "" {
		return flagValue
	}
	return env
}

func cmdInstall(argv []string) {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	var hubs hubList
	fs.Var(&hubs, "hub", "Nova's address; repeat for fallbacks, in order (the card's command gives them)")
	code := fs.String("code", "", "a pairing code — needed only when this machine is not paired (or "+pairingCodeEnv+")")
	name := fs.String("name", "", "the machine's name (default: the card's, else the hostname)")
	ifMissing := fs.Bool("if-missing", false, "leave an agent that is installed and running as it is")
	later := fs.Bool("restart-later", false, "schedule the service restart instead of waiting for it, and keep this machine's pairing without asking Nova (used when Nova installs through the old agent's own hands)")
	_ = fs.Parse(argv)
	c := pairingCode(*code)
	paths, err := config.DefaultPaths()
	if err != nil {
		fail("%v", err)
	}
	self, err := selfBinary()
	if err != nil {
		fail("%v", err)
	}
	dir, err := platform.InstallDir()
	if err != nil {
		fail("could not find where to install: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	err = install.Install(ctx, install.Options{
		Hubs: hubs, Code: c, Name: *name, IfMissing: *ifMissing, RestartLater: *later,
		Self: self, Version: version, Paths: paths, InstallDir: dir,
		Service: service.New(paths, platform.Exec{}), InWSL: inWSL, Out: os.Stdout,
	})
	if code := installExit(err); code != 0 {
		if code == exitNeedsCode {
			fmt.Fprintf(os.Stderr, "novad: %v — get a code from Settings → Devices (Re-pair on its tile, or Pair a device) and run the card's command\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "novad: %v\n", err)
		}
		os.Exit(code)
	}
}

func cmdUninstall(argv []string) {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	forget := fs.Bool("forget", false, "also set this machine's pairing aside (it is kept by default)")
	_ = fs.Parse(argv)
	paths, err := config.DefaultPaths()
	if err != nil {
		fail("%v", err)
	}
	dir, err := platform.InstallDir()
	if err != nil {
		fail("could not find where novad is installed: %v", err)
	}
	if err := install.Uninstall(context.Background(), install.UninstallOptions{
		Paths: paths, InstallDir: dir, Service: service.New(paths, platform.Exec{}), Forget: *forget,
		Now: time.Now, Out: os.Stdout,
	}); err != nil {
		fail("%v", err)
	}
}
