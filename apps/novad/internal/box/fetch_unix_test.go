//go:build unix

package box

import (
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// C1: a FIFO where a lockfile should be is refused without opening it (an
// open would block until a writer came).
func TestReadLocksNeverOpensAFIFO(t *testing.T) {
	wt := t.TempDir()
	writeFiles(t, wt, map[string]string{"apps/novad/go.mod": "m"})
	if err := syscall.Mkfifo(filepath.Join(wt, "apps/novad/go.sum"), 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := ReadLocks(wt)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "apps/novad/go.sum") {
			t.Fatalf("err = %v, want a refusal naming apps/novad/go.sum", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("ReadLocks blocked opening a FIFO")
	}
}
