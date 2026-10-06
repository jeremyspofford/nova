package platform

import (
	"context"
	"errors"
	"os/exec"
)

// The two ways a bound cuts a program (runBounded).
var (
	// ErrNoAnswer is a program that ran past its bound: the agent stopped
	// waiting for it. Whether the kill that followed took, the agent cannot
	// always tell — sudo, once it runs as root, refuses an unprivileged
	// agent's SIGKILL — so nothing here claims the program stopped.
	ErrNoAnswer = errors.New("gave no answer in time")
	// ErrNoTime is a program whose bound had passed before it could start.
	ErrNoTime = errors.New("had no time left to start")
)

// OutOfTime is whether err is a program its bound cut: one that gave no
// answer in time, or had no time left to start.
func OutOfTime(err error) bool {
	return errors.Is(err, ErrNoAnswer) || errors.Is(err, ErrNoTime)
}

// runBounded runs one program — run is the call, name what it runs — and
// returns by the time ctx is done, whether or not the program has (S42b fix
// round 1, I1). exec.CommandContext's kill is not enough: sudo, once it runs
// as root, answers an unprivileged SIGKILL with EPERM, and cmd.Wait then
// waits for as long as sudo takes. A program still running at the bound is
// left to the goroutine that ran it, which reaps it whenever it exits. One
// that failed as its bound passed was killed by it — on Windows a killed
// program exits 1, which would otherwise read as its own failure. And
// exec.ErrWaitDelay is the exit 0 it reports (fix round 2): Go returns it
// only for a program that exited successfully while a descendant still held
// its output pipes — sudo -n true that succeeded is never "refused" for it,
// nor a wsl.exe list, look or root check a failure.
func runBounded(ctx context.Context, name string, run func(context.Context) (string, error)) (string, error) {
	if ctx.Err() != nil {
		return "", &RunError{Name: name, Err: ErrNoTime, NotStarted: true}
	}
	type result struct {
		out string
		err error
	}
	done := make(chan result, 1) // buffered: the reaper never waits on a caller that left
	go func() {
		out, err := run(ctx)
		done <- result{out, err}
	}()
	var res result
	select {
	case res = <-done:
	case <-ctx.Done():
		select {
		case res = <-done: // it answered as the bound passed
		default:
			return "", &RunError{Name: name, Err: ErrNoAnswer}
		}
	}
	if errors.Is(res.err, exec.ErrWaitDelay) {
		res.err = nil
	}
	if res.err != nil && ctx.Err() != nil {
		return res.out, &RunError{Name: name, Err: ErrNoAnswer}
	}
	return res.out, res.err
}
