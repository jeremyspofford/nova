package supervise

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Swap puts the staged build in place and keeps the running one as .prev.
// Renames only: every OS allows renaming the file a running process was
// started from (P0-20 measured Windows), and nothing is deleted that a
// running process may hold. An earlier .prev is moved aside first — on
// Windows it may be this supervisor's own image from the last update.
func Swap(binary, staged string) error {
	prev := binary + ".prev"
	if err := moveAside(prev); err != nil {
		return fmt.Errorf("clearing %s: %w", prev, err)
	}
	if err := os.Rename(binary, prev); err != nil {
		return fmt.Errorf("moving the running build aside: %w", err)
	}
	if err := os.Rename(staged, binary); err != nil {
		if rerr := os.Rename(prev, binary); rerr != nil {
			return fmt.Errorf("moving the new build into place: %v; putting the old one back: %v", err, rerr)
		}
		return fmt.Errorf("moving the new build into place: %w", err)
	}
	return nil
}

// Revert puts .prev back and keeps the build that failed as .failed. When
// .prev cannot be put back, the failed build returns to its place, as Swap
// restores the old one: a build that did not connect still beats no build,
// which nothing would ever start again.
func Revert(binary string) error {
	failed := binary + ".failed"
	if err := moveAside(failed); err != nil {
		return err
	}
	if err := os.Rename(binary, failed); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.Rename(binary+".prev", binary); err != nil {
		if rerr := os.Rename(failed, binary); rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
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
	return os.Rename(path, fmt.Sprintf("%s.old-%d", path, time.Now().UnixNano()))
}

// removeOld deletes the builds moved aside earlier; one a process still runs
// from stays until the next start.
func removeOld(binary string) {
	matches, _ := filepath.Glob(binary + "*.old-*")
	for _, m := range matches {
		_ = os.Remove(m)
	}
}
