//go:build unix

package box

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// holdFlock takes flock(2) on path through its own open file description —
// what util-linux `flock` (the Claude lanes) does.
func holdFlock(t *testing.T, p string) (release func()) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }
}

// C4: free lock, created dir, released for the next taker.
func TestCPULockTakesAFreeLockAndCreatesItsDir(t *testing.T) {
	p := filepath.Join(t.TempDir(), "deploy", "state", "cpu.lock")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	release, waited, err := CPULock{Path: p, Margin: time.Second}.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if waited > 500*time.Millisecond {
		t.Errorf("waited %v on a free lock", waited)
	}
	// Held: another open description is refused.
	f, _ := os.OpenFile(p, os.O_RDWR, 0)
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); !errors.Is(err, unix.EWOULDBLOCK) {
		t.Errorf("the lock is not held while acquired: %v", err)
	}
	release()
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Errorf("release did not free it: %v", err)
	}
	f.Close()
}

// C4: contention -> waits until deadline - margin, then HeldError.
func TestCPULockGivesUpAtTheDeadlineLessTheMargin(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state", "cpu.lock")
	defer holdFlock(t, p)()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	start := time.Now()
	release, waited, err := CPULock{Path: p, Margin: 2 * time.Second}.Acquire(ctx)
	took := time.Since(start)
	var held *HeldError
	if !errors.As(err, &held) || release != nil {
		t.Fatalf("err = %v (release %v), want *HeldError", err, release != nil)
	}
	if held.Path != p || !strings.Contains(err.Error(), p) {
		t.Errorf("error does not name the path: %v", err)
	}
	if took < 700*time.Millisecond || took > 1800*time.Millisecond {
		t.Errorf("gave up after %v, want ~1s (3s deadline - 2s margin)", took)
	}
	if waited < 700*time.Millisecond || held.Waited != waited {
		t.Errorf("waited = %v, held.Waited = %v", waited, held.Waited)
	}
}

// C4: a holder releasing mid-wait lets the waiter through, and it says how
// long it waited.
func TestCPULockWaitsForTheHolder(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cpu.lock")
	rel := holdFlock(t, p)
	go func() { time.Sleep(1200 * time.Millisecond); rel() }()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	release, waited, err := CPULock{Path: p, Margin: time.Second}.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if waited < time.Second || waited > 5*time.Second {
		t.Errorf("waited = %v, want ~1.2s", waited)
	}
}

// C4: a cancelled ctx stops the wait.
func TestCPULockStopsWhenTheCallIsCancelled(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cpu.lock")
	defer holdFlock(t, p)()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(300 * time.Millisecond); cancel() }()
	start := time.Now()
	_, _, err := CPULock{Path: p, Margin: time.Second}.Acquire(ctx)
	if err == nil || time.Since(start) > 3*time.Second {
		t.Fatalf("err = %v after %v", err, time.Since(start))
	}
}

// C4: two takers in one process — the second waits on the first (an
// exclusive lock, not a shared one), then gets it once released.
func TestTwoAcquiresExcludeEachOther(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cpu.lock")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, _, err := CPULock{Path: p}.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	short, cancel2 := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel2()
	_, _, err = CPULock{Path: p, Margin: time.Second}.Acquire(short)
	var held *HeldError
	if !errors.As(err, &held) {
		t.Fatalf("a second taker got a held lock: %v", err)
	}
	first()
	second, _, err := CPULock{Path: p, Margin: time.Second}.Acquire(ctx)
	if err != nil {
		t.Fatalf("after release: %v", err)
	}
	second()
}
