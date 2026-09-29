package state

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteJSONThenReadJSONRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", AgentStatusFile)
	want := AgentStatus{V: 1, PID: 42, Version: "0123456789ab", Mode: "run-key", State: StateReady,
		Server: "https://nova.fake-tailnet.ts.net", Since: time.Unix(1_790_000_000, 0).UTC()}
	if err := WriteJSON(path, want); err != nil {
		t.Fatal(err)
	}
	var got AgentStatus
	if err := ReadJSON(path, &got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("read back %+v, wrote %+v", got, want)
	}
	leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".*"))
	if len(leftovers) != 0 {
		t.Fatalf("a temp file was left beside the status: %v", leftovers)
	}
}

func TestReadJSONOfAMissingFileIsErrNotExist(t *testing.T) {
	var s AgentStatus
	err := ReadJSON(filepath.Join(t.TempDir(), AgentStatusFile), &s)
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("got %v, want fs.ErrNotExist — never-written must read differently from unreadable", err)
	}
}

func TestReadJSONOfGarbageSaysUnreadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), UpdateFile)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	var u Update
	if err := ReadJSON(path, &u); err == nil || errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("got %v, want an 'unreadable' error", err)
	}
}

// P5: one copy per identity. A second holder — another process, or this one
// through a second open — is refused and told who holds it.
func TestASecondHolderOfTheLockIsRefusedWithTheFirstsPID(t *testing.T) {
	path := filepath.Join(t.TempDir(), RunLockFile)
	first, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Acquire(path)
	var held *HeldError
	if !errors.As(err, &held) || held.PID != os.Getpid() {
		t.Fatalf("second Acquire = %v, want a HeldError naming pid %d", err, os.Getpid())
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	again, err := Acquire(path)
	if err != nil {
		t.Fatalf("after Release the lock must be free again: %v", err)
	}
	_ = again.Release()
}
