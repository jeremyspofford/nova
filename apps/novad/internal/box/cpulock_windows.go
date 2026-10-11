//go:build windows

package box

import (
	"context"
	"fmt"
	"time"
)

// The box runs on a Linux hub only; Windows has no flock(2) to share with
// the Claude lanes' util-linux flock.
func acquire(_ context.Context, l CPULock) (func(), time.Duration, error) {
	return nil, 0, fmt.Errorf("cannot take the CPU lock %s: it is flock(2), and this agent runs on windows", l.Path)
}
