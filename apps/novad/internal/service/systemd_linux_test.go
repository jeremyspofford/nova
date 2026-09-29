package service

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"novad/internal/config"
	"novad/internal/platform"
)

func argvs(calls []platform.FakeCall) []string {
	out := make([]string, len(calls))
	for i, c := range calls {
		out[i] = strings.TrimSpace(c.Name + " " + strings.Join(c.Args, " "))
	}
	return out
}

func TestInstallWritesTheUnitAndRestartRunsTheThreeCommandsInOrder(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	r := &platform.FakeRunner{Outputs: map[string]string{"systemctl": ""}}
	m := New(config.Paths{}, r)
	if m.Installed() {
		t.Fatal("nothing written yet")
	}
	if err := m.Install("/opt/nova/novad"); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "systemd", "user", UnitName))
	if err != nil || string(body) != SystemdUnit("/opt/nova/novad") {
		t.Fatalf("unit on disk = %q, %v", body, err)
	}
	if !m.Installed() {
		t.Fatal("Installed after Install")
	}
	if err := m.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"systemctl --user daemon-reload", "systemctl --user enable novad.service", "systemctl --user restart novad.service"}
	if got := argvs(r.Calls); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("ran %v, want %v", got, want)
	}
}

// P26: linger is turned on without sudo and read back; when it stays off the
// one sudo line is said, and "starts at boot" is never claimed.
func TestBootStartTurnsLingerOnWithoutSudoAndReadsItBack(t *testing.T) {
	r := &platform.FakeRunner{Seq: map[string][]string{"loginctl": {"no\n", "", "yes\n"}}}
	on, note, err := New(config.Paths{}, r).BootStart(context.Background())
	if err != nil || !on || !strings.Contains(note, "linger turned on") {
		t.Fatalf("on=%v note=%q err=%v", on, note, err)
	}
	got := argvs(r.Calls)
	if len(got) != 3 || got[1] != "loginctl enable-linger" {
		t.Fatalf("ran %v", got)
	}
}

func TestBootStartThatCannotTurnLingerOnSaysTheOneSudoLine(t *testing.T) {
	r := &platform.FakeRunner{Seq: map[string][]string{"loginctl": {"no\n", "", "no\n"}}}
	on, note, err := New(config.Paths{}, r).BootStart(context.Background())
	if err != nil || on || !strings.Contains(note, "starts at login, not at boot") || !strings.Contains(note, "sudo loginctl enable-linger ") {
		t.Fatalf("on=%v note=%q err=%v", on, note, err)
	}
}

// P11: an update run through the old agent's own hands restarts the unit
// from OUTSIDE the agent's process tree — systemd-run's timer — so the
// restart cannot kill the command that scheduled it before it answers.
func TestRestartLaterSchedulesTheRestartOutsideTheCaller(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	r := &platform.FakeRunner{Outputs: map[string]string{"systemctl": "", "systemd-run": ""}}
	if err := New(config.Paths{}, r).RestartLater(context.Background(), 5e9); err != nil {
		t.Fatal(err)
	}
	last := argvs(r.Calls)[len(r.Calls)-1]
	if !strings.HasPrefix(last, "systemd-run --user --on-active=5 --unit=novad-restart-") ||
		!strings.HasSuffix(last, "systemctl --user restart novad.service") {
		t.Fatalf("scheduled %q", last)
	}
}
