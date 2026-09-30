package platform

import (
	"context"
	"errors"
	"os/exec"
	"sync"
	"testing"
	"time"
)

// returnsWithin fails the test unless call returns within d: a program waited
// on past its bound would otherwise hang the suite until go test's timeout.
func returnsWithin(t *testing.T, d time.Duration, call func()) {
	t.Helper()
	done := make(chan struct{})
	go func() { defer close(done); call() }()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatalf("still waiting after %s: a program was waited on past its bound", d)
	}
}

// Fix round 1, I1: a program that ignores its kill — sudo, once root,
// answers an unprivileged SIGKILL with EPERM — is waited for no longer than
// its bound. The call returns then, saying it gave no answer (never that it
// stopped), and the goroutine left with the program reaps it when it exits.
func TestABoundedProgramIsLeftAtItsBoundAndReapedWhenItExits(t *testing.T) {
	release, reaped := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var err error
	returnsWithin(t, 2*time.Second, func() {
		_, err = runBounded(ctx, "sudo", func(context.Context) (string, error) {
			defer close(reaped)
			<-release // deaf to ctx
			return "", nil
		})
	})
	var re *RunError
	if !errors.Is(err, ErrNoAnswer) || !OutOfTime(err) || !errors.As(err, &re) || re.NotStarted || err.Error() != "sudo: gave no answer in time" {
		t.Fatalf("err = %v", err)
	}
	select {
	case <-reaped:
		t.Fatal("the program was reaped before it exited")
	default:
	}
	once.Do(func() { close(release) })
	select {
	case <-reaped:
	case <-time.After(5 * time.Second):
		t.Fatal("the program left at its bound was never reaped")
	}
}

// A program whose bound has already passed is never started, and says so.
func TestABoundedProgramWithNoTimeLeftNeverStarts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ran := false
	_, err := runBounded(ctx, "wsl.exe", func(context.Context) (string, error) { ran = true; return "", nil })
	var re *RunError
	if ran || !errors.Is(err, ErrNoTime) || !OutOfTime(err) || !errors.As(err, &re) || !re.NotStarted {
		t.Fatalf("ran %v, err %v", ran, err)
	}
}

// A program that fails as its bound passes was killed by it — on Windows a
// killed program exits 1 — and gave no answer; one that answers in time is
// read as it answered, success or failure.
func TestABoundedProgramKilledAtItsBoundGaveNoAnswer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := runBounded(ctx, "wsl.exe", func(ctx context.Context) (string, error) {
		<-ctx.Done()
		return "", errors.New("wsl.exe: exit status 1")
	})
	if !errors.Is(err, ErrNoAnswer) {
		t.Fatalf("err = %v", err)
	}
	failed := errors.New("wsl.exe: exit status 1: its own words")
	out, err := runBounded(context.Background(), "wsl.exe", func(context.Context) (string, error) { return "partial", failed })
	if out != "partial" || err != failed {
		t.Fatalf("got %q, %v", out, err)
	}
}

// RunWSL is bounded the same way: a wsl.exe that ignores its kill is left at
// its bound.
func TestRunWSLIsLeftAtItsBound(t *testing.T) {
	hold := make(chan struct{})
	defer close(hold)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	r := &FakeRunner{Hold: hold}
	var err error
	returnsWithin(t, 2*time.Second, func() { _, err = RunWSL(ctx, r, "--list", "--running", "--quiet") })
	if !errors.Is(err, ErrNoAnswer) || len(r.Recorded()) != 1 {
		t.Fatalf("err %v, calls %v", err, r.Recorded())
	}
}

// Fix round 2: exec.ErrWaitDelay — a program that exited 0 while a
// descendant held its output — is an answer: success, whatever wraps it.
func TestABoundedProgramThatExitedZeroWhileItsOutputWasHeldSucceeded(t *testing.T) {
	out, err := runBounded(context.Background(), "wsl.exe", func(context.Context) (string, error) {
		return "Ubuntu-26.04\n", &RunError{Name: "wsl.exe", Err: exec.ErrWaitDelay}
	})
	if err != nil || out != "Ubuntu-26.04\n" {
		t.Fatalf("got %q, %v", out, err)
	}
}
