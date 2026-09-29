package supervise

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sync"
	"time"

	"novad/internal/platform"
)

// maxLogBytes is when the log is rotated (P6: 1 MiB, one generation kept as
// <path>.1). ExecSpawner rotates as each agent starts.
const maxLogBytes = 1 << 20

// Log is novad.log where no service manager keeps the output (Windows, P6):
// the agents' output and the supervisor's own lines. Writes go to the current
// file, so a writer holding the Log follows it across a rotation.
type Log struct {
	path   string
	max    int64
	mu     sync.Mutex
	f      *os.File
	follow func(*os.File) error // points this process's own output at a fresh file (log_windows.go)
}

// OpenLog opens path to append to, with platform.OpenLog: on Windows it is
// shared for deleting, so it can be renamed while it is held open.
func OpenLog(path string) (*Log, error) {
	f, err := platform.OpenLog(path)
	if err != nil {
		return nil, err
	}
	return &Log{path: path, max: maxLogBytes, f: f}, nil
}

// Write appends p to the current file.
func (l *Log) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.f.Write(p)
}

// Close closes the current file.
func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.f.Close()
}

// file is the current file, for an agent's output; nil when there is no Log.
func (l *Log) file() *os.File {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.f
}

// Rotate keeps the log under its limit. Past it, the file is renamed to
// <path>.1, replacing the one before, and a fresh one is opened, which every
// writer through the Log — and this process's own output, once it follows the
// log — uses from then on. A rotation that fails is written into the log
// itself, the one place anyone reads on a machine with no journal, and
// returned.
func (l *Log) Rotate() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	fi, err := os.Stat(l.path)
	switch {
	case err == nil && fi.Size() <= l.max:
		return nil
	case err == nil:
		if err := os.Rename(l.path, l.path+".1"); err != nil {
			return l.sayLocked("could not rotate %s (%d bytes, over %d): %v; it grows until a rotation succeeds",
				l.path, fi.Size(), l.max, err)
		}
	case !errors.Is(err, fs.ErrNotExist):
		return l.sayLocked("could not read the size of %s to rotate it: %v", l.path, err)
	}
	// Moved aside just now, or removed by someone: start a fresh one.
	f, err := platform.OpenLog(l.path)
	if err != nil {
		return l.sayLocked("could not open a fresh %s: %v; still writing to the previous file", l.path, err)
	}
	var followErr error
	if l.follow != nil {
		followErr = l.follow(f)
	}
	old := l.f
	l.f = f
	_ = old.Close()
	if followErr != nil {
		return l.sayLocked("this process's own output does not follow the fresh %s: %v", l.path, followErr)
	}
	return nil
}

// say writes one line in the supervisor's own format into the log, or to
// stderr when there is no Log — never nowhere.
func (l *Log) say(format string, a ...any) {
	if l == nil {
		fmt.Fprintf(os.Stderr, "novad supervise %s %v\n", time.Now().Format("2006/01/02 15:04:05"), fmt.Errorf(format, a...))
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_ = l.sayLocked(format, a...)
}

// sayLocked writes the line into the current file and returns it as an
// error; l.mu is held.
func (l *Log) sayLocked(format string, a ...any) error {
	err := fmt.Errorf(format, a...)
	fmt.Fprintf(l.f, "novad supervise %s %v\n", time.Now().Format("2006/01/02 15:04:05"), err)
	return err
}
