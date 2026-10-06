package platform

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestHelperProcess is not a test: StartDetached's test runs this binary
// again with NOVA_TEST_HELPER=write, and this writes the proof it ran.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("NOVA_TEST_HELPER") != "write" {
		return
	}
	_ = os.WriteFile(os.Getenv("NOVA_TEST_HELPER_OUT"), []byte("ran"), 0o600)
	os.Exit(0)
}

func TestStartDetachedRunsTheProgramOnItsOwn(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out")
	t.Setenv("NOVA_TEST_HELPER", "write")
	t.Setenv("NOVA_TEST_HELPER_OUT", out)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pid, err := StartDetached(self, []string{"-test.run=TestHelperProcess"}, filepath.Join(dir, "log"))
	if err != nil || pid <= 0 {
		t.Fatalf("pid=%d err=%v", pid, err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(out); err == nil && string(b) == "ran" {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the detached program never ran")
}
