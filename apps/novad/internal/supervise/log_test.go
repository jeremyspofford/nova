package supervise

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// openTestLog opens a Log at <temp>/novad.log that rotates past limit bytes.
func openTestLog(t *testing.T, limit int64) (*Log, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "novad.log")
	lg, err := OpenLog(path)
	if err != nil {
		t.Fatal(err)
	}
	lg.max = limit
	t.Cleanup(func() { _ = lg.Close() })
	return lg, path
}

// P6: past its limit the log moves to .1 — one generation kept, so a second
// rotation replaces the first — and a writer holding the Log follows it.
func TestTheLogRotatesPastItsLimitAndItsWritersFollow(t *testing.T) {
	lg, path := openTestLog(t, 8)
	fmt.Fprint(lg, "generation 1")
	if err := lg.Rotate(); err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(lg, "generation 2")
	if err := lg.Rotate(); err != nil {
		t.Fatalf("a second rotation must replace the first .1: %v", err)
	}
	fmt.Fprint(lg, "after")
	if got := read(t, path+".1"); got != "generation 2" {
		t.Fatalf("%s.1 = %q, want the second generation, the one kept", path, got)
	}
	if got := read(t, path); got != "after" {
		t.Fatalf("%s = %q, want what was written after the rotations", path, got)
	}
}

func TestALogUnderItsLimitIsNotRotated(t *testing.T) {
	lg, path := openTestLog(t, 1<<10)
	fmt.Fprint(lg, "short")
	if err := lg.Rotate(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path + ".1"); err == nil {
		t.Fatal("a log under its limit was rotated")
	}
	if got := read(t, path); got != "short" {
		t.Fatalf("%s = %q", path, got)
	}
}

// A rotation that fails is never silent: why goes into the log itself (on
// Windows the one place anyone reads) and back to the caller.
func TestAFailedRotationIsWrittenIntoTheLogAndReturned(t *testing.T) {
	lg, path := openTestLog(t, 8)
	if err := os.MkdirAll(filepath.Join(path+".1", "in-the-way"), 0o700); err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(lg, "over the limit\n")
	err := lg.Rotate()
	if err == nil {
		t.Fatal("a rotation that could not move the log aside reported success")
	}
	if got := read(t, path); !strings.Contains(got, "could not rotate") || !strings.Contains(got, err.Error()) {
		t.Fatalf("the log does not say why it was not rotated:\n%s", got)
	}
}

// A log someone removed is started afresh at the next rotation.
func TestARemovedLogIsStartedAfresh(t *testing.T) {
	lg, path := openTestLog(t, 1<<10)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := lg.Rotate(); err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(lg, "back")
	if got := read(t, path); got != "back" {
		t.Fatalf("%s = %q, want the writes after the fresh start", path, got)
	}
}

// A rotation whose follow fails keeps the previous file open: this process's
// own output (its standard handles, os.Stderr) may still point at it. The
// writers through the Log move on to the fresh file, and a later rotation
// whose follow succeeds closes the previous one.
func TestAFailedFollowKeepsThePreviousFileOpenUntilOneSucceeds(t *testing.T) {
	lg, path := openTestLog(t, 8)
	previous := lg.f
	lg.follow = func(*os.File) error { return errors.New("SetStdHandle refused") }
	fmt.Fprint(lg, "generation 1")
	if err := lg.Rotate(); err == nil || !strings.Contains(err.Error(), "does not follow") {
		t.Fatalf("Rotate = %v, want the failed follow reported", err)
	}
	if _, err := previous.WriteString(" still open"); err != nil {
		t.Fatalf("the previous file was closed while this process's output may still point at it: %v", err)
	}
	fmt.Fprint(lg, "generation 2")
	if got := read(t, path); !strings.Contains(got, "generation 2") {
		t.Fatalf("%s = %q, want the writers on the fresh file", path, got)
	}
	lg.follow = func(*os.File) error { return nil }
	if err := os.Remove(path + ".1"); err != nil { // the held file, so no rename replaces it
		t.Fatal(err)
	}
	if err := lg.Rotate(); err != nil {
		t.Fatal(err)
	}
	if _, err := previous.WriteString("x"); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("the previous file is still open after a follow succeeded (write: %v)", err)
	}
}
