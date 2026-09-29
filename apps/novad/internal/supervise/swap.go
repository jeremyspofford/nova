package supervise

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// rename is os.Rename; a test makes one fail.
var rename = os.Rename

// Swap puts the staged build in place and keeps the running one as .prev.
// Renames only: every OS allows renaming the file a running process was
// started from (P0-20 measured Windows), and nothing is deleted that a
// running process may hold. An earlier .prev is moved aside first — on
// Windows it may be this supervisor's own image from the last update.
//
// Any other error leaves the running build in place: either never moved, or
// put back. A *notRestoredError means putting it back failed too: nothing is
// installed at binary, and the running build waits at .prev.
func Swap(binary, staged string) error {
	prev := binary + ".prev"
	if err := moveAside(prev); err != nil {
		return fmt.Errorf("clearing %s: %w", prev, err)
	}
	if err := rename(binary, prev); err != nil {
		return fmt.Errorf("moving the running build aside: %w", err)
	}
	if err := rename(staged, binary); err != nil {
		err = fmt.Errorf("moving the new build into place: %w", err)
		if rerr := restorePrev(binary); rerr != nil {
			return &notRestoredError{swap: err, restore: rerr}
		}
		return err
	}
	return nil
}

// notRestoredError is a Swap that failed and could not put the running
// build back either: nothing is installed, and the build waits at .prev.
type notRestoredError struct{ swap, restore error }

func (e *notRestoredError) Error() string {
	return fmt.Sprintf("%v; putting the running build back failed too: %v", e.swap, e.restore)
}

func (e *notRestoredError) Unwrap() error { return e.swap }

// restorePrev puts back the build a failed swap left at .prev.
func restorePrev(binary string) error { return rename(binary+".prev", binary) }

// Revert puts .prev back and keeps the build that failed as .failed. When
// .prev cannot be put back, the failed build returns to its place, as Swap
// restores the old one: a build that did not connect still beats no build,
// which nothing would ever start again.
func Revert(binary string) error {
	failed := binary + ".failed"
	if err := moveAside(failed); err != nil {
		return err
	}
	if err := rename(binary, failed); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := rename(binary+".prev", binary); err != nil {
		if rerr := rename(failed, binary); rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
			return fmt.Errorf("%v; returning the failed build to its place: %v", err, rerr)
		}
		return err
	}
	return nil
}

func moveAside(path string) error {
	if _, err := os.Lstat(path); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return rename(path, fmt.Sprintf("%s.old-%d", path, time.Now().UnixNano()))
}

// removeOld deletes the builds moved aside earlier; one a process still runs
// from stays until the next start.
func removeOld(binary string) {
	matches, _ := filepath.Glob(binary + "*.old-*")
	for _, m := range matches {
		_ = os.Remove(m)
	}
}
