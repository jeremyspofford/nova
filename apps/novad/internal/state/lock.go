package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// HeldError is Acquire's refusal: another process holds the lock. PID is 0
// when the holder's pid could not be read.
type HeldError struct {
	Path string
	PID  int
}

func (e *HeldError) Error() string {
	if e.PID > 0 {
		return fmt.Sprintf("another novad (pid %d) holds %s", e.PID, e.Path)
	}
	return fmt.Sprintf("another novad holds %s", e.Path)
}

// Lock is a held lock. The OS frees it when the process exits, however it
// exits, so a crash never leaves an identity locked.
type Lock struct{ f *os.File }

var errLocked = errors.New("locked by another holder")

// Acquire takes path's exclusive lock without waiting, then writes this
// process's pid into the file for the next one's refusal to name.
func Acquire(path string) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		f.Close()
		if errors.Is(err, errLocked) {
			return nil, &HeldError{Path: path, PID: readPID(path)}
		}
		return nil, fmt.Errorf("locking %s: %w", path, err)
	}
	if err := f.Truncate(0); err == nil {
		_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	}
	return &Lock{f: f}, nil
}

// Release frees the lock.
func (l *Lock) Release() error {
	unlockFile(l.f)
	return l.f.Close()
}

func readPID(path string) int {
	body, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(body)))
	return pid
}
