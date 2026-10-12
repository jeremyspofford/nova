//go:build !windows

package box

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

func acquire(ctx context.Context, l CPULock) (func(), time.Duration, error) {
	if err := os.MkdirAll(filepath.Dir(l.Path), 0o755); err != nil {
		return nil, 0, fmt.Errorf("cannot make the CPU lock's directory: %v", err)
	}
	f, err := os.OpenFile(l.Path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, 0, fmt.Errorf("cannot open the CPU lock %s: %v", l.Path, err)
	}
	start := time.Now()
	var giveUp <-chan time.Time
	if dl, ok := ctx.Deadline(); ok {
		t := time.NewTimer(time.Until(dl.Add(-l.Margin)))
		defer t.Stop()
		giveUp = t.C
	}
	for {
		err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }, time.Since(start), nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) {
			f.Close()
			return nil, time.Since(start), fmt.Errorf("cannot take the CPU lock %s: %v", l.Path, err)
		}
		select {
		case <-giveUp:
			f.Close()
			w := time.Since(start)
			return nil, w, &HeldError{Path: l.Path, Waited: w}
		case <-ctx.Done():
			f.Close()
			return nil, time.Since(start), fmt.Errorf("stopped waiting for the CPU lock %s: %v", l.Path, ctx.Err())
		case <-time.After(lockPoll):
		}
	}
}
