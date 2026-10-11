//go:build windows

package main

import (
	"context"
	"fmt"
	"os"

	"golang.org/x/sys/windows"

	"novad/internal/admin"
)

// cmdAdmin is `novad admin install|uninstall|whoami|run-queued` on Windows
// — the elevated scheduled task \Nova\NovaAdmin (S30b, owner decision
// 2026-10-11). install/uninstall run elevated (the owner's one UAC click,
// or through the path itself); run-queued is the task's own action;
// whoami is the elevated round trip install's proof runs. install copies
// this program to the protected copy %ProgramFiles%\Nova\Admin\novad.exe
// (SYSTEM and Administrators only) and registers the task against that
// copy; run-queued refuses unless it is that copy.
func cmdAdmin(argv []string) {
	if len(argv) == 0 {
		usage()
		os.Exit(2)
	}
	ctx := context.Background()
	self := os.Getenv(admin.RunnerEnv) != ""
	switch argv[0] {
	case "install":
		tok := windows.GetCurrentProcessToken()
		if !tok.IsElevated() {
			fail("cannot: admin install runs elevated — it registers the elevated task \\Nova\\NovaAdmin")
		}
		u, err := tok.GetTokenUser()
		if err != nil {
			fail("reading the installing token's user: %v", err)
		}
		// The source of the protected copy: this program (the agent's
		// build). The task is registered against the copy, never this.
		src, err := admin.OwnPath()
		if err != nil {
			fail("finding this program: %v", err)
		}
		h, err := admin.DefaultHost()
		if err != nil {
			fail("%v", err)
		}
		said, err := admin.InstallTask(ctx, h, u.User.Sid.String(), src, self)
		adminExit(said, err)
	case "uninstall":
		h, err := admin.DefaultHost()
		if err != nil {
			fail("%v", err)
		}
		said, err := admin.UninstallTask(ctx, h, self)
		adminExit(said, err)
	case "whoami":
		b, err := admin.WhoamiToken()
		if err != nil {
			fail("%v", err)
		}
		fmt.Println(string(b))
	case "run-queued":
		h, err := admin.DefaultHost()
		if err != nil {
			fail("%v", err)
		}
		me, err := admin.Me()
		if err != nil {
			fail("%v", err)
		}
		if err := admin.RunQueued(ctx, h, me); err != nil {
			fail("admin run-queued: %v", err)
		}
	default:
		usage()
		os.Exit(2)
	}
}

func adminExit(said string, err error) {
	if err != nil {
		fail("%v", err)
	}
	fmt.Println(said)
}
