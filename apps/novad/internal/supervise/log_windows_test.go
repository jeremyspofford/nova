package supervise

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"novad/internal/platform"
)

// TestHelperLogOwner is not a test: it stands in for a detached supervisor
// whose standard handles are novad.log as StartDetached opened it. It takes
// the log over, rotates it twice — the second rotation replaces the first
// .1, which works only when no handle of this process still holds that file
// — then panics: the runtime's crash output must land in the current log.
// Exit 3-6 names the step that failed.
func TestHelperLogOwner(t *testing.T) {
	path := os.Getenv("NOVA_TEST_LOG")
	if path == "" {
		return
	}
	lg, err := OpenLog(path)
	if err != nil {
		os.Exit(3)
	}
	lg.max = 8
	if err := lg.captureProcessOutput(); err != nil {
		os.Exit(4)
	}
	fmt.Fprintln(os.Stderr, "generation 1 of this process's own output")
	if lg.Rotate() != nil {
		os.Exit(5)
	}
	fmt.Fprintln(os.Stderr, "generation 2 of this process's own output")
	if lg.Rotate() != nil {
		os.Exit(6)
	}
	panic("generation 3, the runtime's own crash output")
}

// P6 on Windows: novad.log rotates while the supervisor holds it as its own
// output, and that output — its lines and a crash — follows the log.
func TestTheSupervisorsOwnOutputFollowsTheLogAcrossRotations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "novad.log")
	out, err := platform.OpenLog(path) // as StartDetached opens it
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperLogOwner$")
	cmd.Env = append(os.Environ(), "NOVA_TEST_LOG="+path)
	cmd.Stdout, cmd.Stderr = out, out
	err = cmd.Start()
	out.Close() // StartDetached lets its copy go once the process has started
	if err != nil {
		t.Fatal(err)
	}
	err = cmd.Wait()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 2 {
		t.Fatalf("the stand-in supervisor ended with %v, want the panic's exit 2 (3-6: a step failed)", err)
	}
	if got := read(t, path+".1"); !strings.Contains(got, "generation 2") {
		t.Fatalf("%s.1 = %q, want the second generation", path, got)
	}
	if got := read(t, path); !strings.Contains(got, "panic: generation 3") {
		t.Fatalf("%s = %q, want the crash output after the rotations", path, got)
	}
}

// A kill-on-close job that cannot be made is written to the log, and the
// agent still runs.
func TestAJobThatCannotBeMadeIsLoggedAndTheAgentStillRuns(t *testing.T) {
	lg, path := openTestLog(t, maxLogBytes)
	made := newJob
	newJob = func() (windows.Handle, error) { return 0, errors.New("job objects refused") }
	t.Cleanup(func() { newJob = made })
	spawn := ExecSpawner(lg)
	c, err := spawn(context.Background(), os.Args[0], []string{"-test.run=^TestHelperAgent$"},
		append(os.Environ(), "NOVA_TEST_AGENT="+strconv.Itoa(ExitFinal)))
	if err != nil {
		t.Fatal(err)
	}
	if code, err := c.Wait(); err != nil || code != ExitFinal {
		t.Fatalf("Wait = %d, %v; the agent must still run", code, err)
	}
	if got := read(t, path); !strings.Contains(got, "no kill-on-close job (job objects refused)") {
		t.Fatalf("the log does not say the job is missing:\n%s", got)
	}
}
