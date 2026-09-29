package platform

import "testing"

// P4: the supervisor's word decides the mode, on every OS.
func TestModeIsTheSupervisorsWordWhenItIsAServiceMode(t *testing.T) {
	for _, m := range []string{"systemd-user", "launch-agent", "run-key"} {
		t.Setenv(ModeEnv, m)
		if got := Mode(); got != m {
			t.Fatalf("%s=%q: Mode() = %q", ModeEnv, m, got)
		}
	}
}

func TestAnUnknownModeWordFallsBackToWhatTheOSSays(t *testing.T) {
	t.Setenv(ModeEnv, "root-kit")
	if got := Mode(); got != osMode() {
		t.Fatalf("an unknown word must never be reported: got %q, want %q", got, osMode())
	}
}

func TestSupervisedIsWhetherASupervisorStartedThisProcess(t *testing.T) {
	t.Setenv(SupervisorEnv, "")
	if Supervised() {
		t.Fatal("no supervisor pid: not supervised")
	}
	t.Setenv(SupervisorEnv, "4242")
	if !Supervised() {
		t.Fatal("a supervisor pid: supervised")
	}
}
