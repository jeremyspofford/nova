package service

import (
	"context"
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

func argvsDarwin(calls []platform.FakeCall) []string {
	out := make([]string, len(calls))
	for i, c := range calls {
		out[i] = c.Name + " " + strings.Join(c.Args, " ")
	}
	return out
}
