package supervise

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestHelperSleep is not a test: the swap test runs a copy of this binary as
// a stand-in for a running agent.
func TestHelperSleep(t *testing.T) {
	if os.Getenv("NOVA_TEST_SLEEP") != "1" {
		return
	}
	time.Sleep(time.Minute)
}

// P0-20 measured that Windows renames a running image; this pins it on CI.
func TestSwapRenamesARunningImageOnWindows(t *testing.T) {
	dir := t.TempDir()
	self, _ := os.Executable()
	bin := filepath.Join(dir, "novad.exe")
	src, _ := os.Open(self)
	dst, _ := os.Create(bin)
	_, _ = io.Copy(dst, src)
	src.Close()
	dst.Close()
	cmd := exec.Command(bin, "-test.run=TestHelperSleep")
	cmd.Env = append(os.Environ(), "NOVA_TEST_SLEEP=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	staged := bin + ".new"
	if err := os.WriteFile(staged, []byte("new build"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Swap(bin, staged); err != nil {
		t.Fatalf("swapping over a running image: %v", err)
	}
	if b, _ := os.ReadFile(bin); string(b) != "new build" {
		t.Fatal("the new build is not in place")
	}
	if _, err := os.Stat(bin + ".prev"); err != nil {
		t.Fatalf("the running build was not kept as .prev: %v", err)
	}
}
