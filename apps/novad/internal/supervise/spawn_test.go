package supervise

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// TestHelperAgent is not a test: the spawner tests run this binary as a
// stand-in agent. It exits with NOVA_TEST_AGENT's code, or sleeps when that
// is "sleep".
func TestHelperAgent(t *testing.T) {
	switch v := os.Getenv("NOVA_TEST_AGENT"); v {
	case "":
		return
	case "sleep":
		time.Sleep(time.Minute)
	default:
		code, _ := strconv.Atoi(v)
		os.Exit(code)
	}
}

func spawnHelper(t *testing.T, behaviour string) Child {
	t.Helper()
	spawn := ExecSpawner(filepath.Join(t.TempDir(), "novad.log"))
	c, err := spawn(context.Background(), os.Args[0], []string{"-test.run=^TestHelperAgent$"},
		append(os.Environ(), "NOVA_TEST_AGENT="+behaviour))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// The exit code decides what supervise does next (75 swaps a build in, 78
// stops for good), so it is read back from a real process on every OS.
func TestTheSpawnerReadsARealAgentsExitCode(t *testing.T) {
	for _, want := range []int{1, ExitUpdateStaged, ExitFinal} {
		c := spawnHelper(t, strconv.Itoa(want))
		if got, err := c.Wait(); err != nil || got != want {
			t.Fatalf("Wait = %d, %v; want %d", got, err, want)
		}
	}
}

// Kill must end the agent: supervise waits for the exit after every Kill.
func TestTheSpawnerEndsAnAgentItKills(t *testing.T) {
	c := spawnHelper(t, "sleep")
	if err := c.Kill(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _, _ = c.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent was still running 5 s after Kill")
	}
}
