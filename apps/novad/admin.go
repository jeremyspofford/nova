//go:build unix

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"novad/internal/admin"
)

// cmdAdmin is `novad admin install|uninstall|exec|whoami` — the standing
// admin path (S30b). install/uninstall run as root (through sudo); exec is
// what the sudoers rule lets the agent's user run as root; whoami is the
// elevated round trip install's read-back runs.
func cmdAdmin(argv []string) {
	if len(argv) == 0 {
		usage()
		os.Exit(2)
	}
	os.Exit(adminMain(argv, admin.DefaultEnv()))
}

func adminMain(argv []string, env admin.Env) int {
	ctx := context.Background()
	switch argv[0] {
	case "install":
		fs := flag.NewFlagSet("admin install", flag.ExitOnError)
		user := fs.String("user", "", "the agent's user, the one the sudoers rule names")
		_ = fs.Parse(argv[1:])
		if *user == "" {
			fmt.Fprintln(os.Stderr, "novad: admin install needs --user <u>")
			return 2
		}
		said, err := admin.Install(ctx, env, *user)
		return adminSaid(said, err)
	case "uninstall":
		fs := flag.NewFlagSet("admin uninstall", flag.ExitOnError)
		_ = fs.Parse(argv[1:])
		said, err := admin.Uninstall(ctx, env)
		return adminSaid(said, err)
	case "whoami":
		b, err := admin.Whoami(env)
		if err != nil {
			fmt.Fprintf(os.Stderr, "novad: %v\n", err)
			return 1
		}
		fmt.Println(string(b))
		return 0
	case "exec":
		fs := flag.NewFlagSet("admin exec", flag.ExitOnError)
		secs := fs.Int("timeout", 0, "seconds before the whole group is killed (required)")
		cwd := fs.String("cwd", "", "working directory")
		_ = fs.Parse(argv[1:])
		if *secs <= 0 || fs.NArg() == 0 {
			fmt.Fprintln(os.Stderr, "novad: admin exec needs --timeout <s> (> 0) and -- argv")
			return 2
		}
		code, err := admin.Exec(ctx, admin.ExecOpts{
			Argv: fs.Args(), Cwd: *cwd, Timeout: time.Duration(*secs) * time.Second,
		}, os.Stdout)
		switch {
		case errors.Is(err, admin.ErrTimeout):
			// coreutils timeout's convention.
			fmt.Fprintf(os.Stderr, "novad: admin exec: timed out after %ds\n", *secs)
			return 124
		case err != nil:
			fmt.Fprintf(os.Stderr, "novad: admin exec: %v\n", err)
			return 127
		}
		return code
	default:
		usage()
		return 2
	}
}

func adminSaid(said string, err error) int {
	if err != nil {
		fmt.Fprintf(os.Stderr, "novad: %v\n", err)
		return 1
	}
	fmt.Println(said)
	return 0
}
