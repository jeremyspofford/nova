package box

import (
	"context"
	"fmt"
	"time"
)

// LockMargin is how much of a call's deadline the CPU lock leaves for the
// command itself: a lock won with less left would only time the suite out.
const LockMargin = 10 * time.Second

// lockPoll is how often a waiter retries the lock; polling (not a blocking
// flock) is what lets a deadline or a cancel stop the wait.
const lockPoll = 200 * time.Millisecond

// CPULock is the shared flock(2) lock heavy commands run under (spec §4.5).
type CPULock struct {
	Path   string
	Margin time.Duration
}

// HeldError is the lock staying held for the whole wait.
type HeldError struct {
	Path   string
	Waited time.Duration
}

func (e *HeldError) Error() string {
	return fmt.Sprintf("the CPU lock %s stayed held for %ds", e.Path, int(e.Waited/time.Second))
}

// Acquire takes the lock, waiting while another holder has it until ctx's
// deadline less Margin (or until ctx is done, without a deadline). It
// returns release and how long it waited.
func (l CPULock) Acquire(ctx context.Context) (release func(), waited time.Duration, err error) {
	return acquire(ctx, l)
}
