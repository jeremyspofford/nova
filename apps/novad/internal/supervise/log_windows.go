package supervise

import (
	"os"

	"golang.org/x/sys/windows"
)

// captureProcessOutput makes this process's own output follow the log, now
// and after every rotation: the standard handles, where the runtime writes a
// crash, and os.Stdout/os.Stderr. The handles the process started with —
// novad.log as StartDetached opened it — are closed: held open, they would
// keep that file from ever being replaced by a later rotation (a rename
// cannot replace a file another handle still holds).
func (l *Log) captureProcessOutput() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	inherited := []*os.File{os.Stdout, os.Stderr}
	if err := pointStdAt(l.f); err != nil {
		return err
	}
	l.follow = pointStdAt
	closed := map[uintptr]bool{l.f.Fd(): true} // never the log's own handle, never one twice
	for _, f := range inherited {
		if f == nil || closed[f.Fd()] {
			continue
		}
		closed[f.Fd()] = true
		_ = f.Close()
	}
	return nil
}

// pointStdAt points the standard output and error handles, and os.Stdout
// and os.Stderr, at f.
func pointStdAt(f *os.File) error {
	h := windows.Handle(f.Fd())
	for _, std := range []uint32{windows.STD_OUTPUT_HANDLE, windows.STD_ERROR_HANDLE} {
		if err := windows.SetStdHandle(std, h); err != nil {
			return err
		}
	}
	os.Stdout, os.Stderr = f, f
	return nil
}
