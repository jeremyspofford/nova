package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"novad/internal/config"
	"novad/internal/platform"
)

func TestInstallWritesThePlistAndRestartBootstrapsIt(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	r := &platform.FakeRunner{Outputs: map[string]string{"launchctl": ""}}
	m := New(config.Paths{}, r)
	if err := m.Install("/Users/sam/Library/Application Support/Nova/novad"); err != nil {
		t.Fatal(err)
	}
	plist := filepath.Join(home, "Library", "LaunchAgents", Label+".plist")
	if _, err := os.Stat(plist); err != nil {
		t.Fatal(err)
	}
	if err := m.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	target := fmt.Sprintf("gui/%d/%s", os.Getuid(), Label)
	got := strings.Join(argvsDarwin(r.Calls), "|")
	for _, want := range []string{"launchctl bootout " + target, fmt.Sprintf("launchctl bootstrap gui/%d %s", os.Getuid(), plist), "launchctl kickstart -k " + target} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
}

// Task 32, L90: a bootout that fails is returned on its own — the agent may
// still be running — and the plist still comes out, so an agent that would
// not stop does not also start again at the next login.
func TestUninstallReturnsAStopThatFailedAndStillRemovesThePlist(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := New(config.Paths{}, &platform.FakeRunner{Errs: map[string]error{"launchctl": errors.New("Boot-out failed: 5: Input/output error")}})
	if err := m.Install("/Users/sam/Library/Application Support/Nova/novad"); err != nil {
		t.Fatal(err)
	}
	stopErr, err := m.Uninstall(context.Background())
	if stopErr == nil || err != nil {
		t.Fatalf("stop %v, removal %v", stopErr, err)
	}
	if m.Installed() {
		t.Fatal("the plist must come out even when the stop failed")
	}
}

// A plist that is not there is nothing to stop: no bootout is tried, so
// launchctl's "no such service" is never reported as a stop that failed.
func TestUninstallOfAPlistThatIsNotThereTriesNoStop(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	r := &platform.FakeRunner{Outputs: map[string]string{"launchctl": ""}}
	if stopErr, err := New(config.Paths{}, r).Uninstall(context.Background()); stopErr != nil || err != nil {
		t.Fatalf("stop %v, removal %v", stopErr, err)
	}
	if len(r.Calls) != 0 {
		t.Fatalf("ran %v", argvsDarwin(r.Calls))
	}
}

// Task 32, L245: a LaunchAgent can schedule a delayed restart (a detached
// kickstart), so it never refuses one up front.
func TestALaunchAgentNeverRefusesARestartLaterUpFront(t *testing.T) {
	if _, ok := New(config.Paths{}, &platform.FakeRunner{}).(RestartLaterRefuser); ok {
		t.Fatal("a LaunchAgent can restart later; it must not refuse it up front")
	}
}

func argvsDarwin(calls []platform.FakeCall) []string {
	out := make([]string, len(calls))
	for i, c := range calls {
		out[i] = c.Name + " " + strings.Join(c.Args, " ")
	}
	return out
}
