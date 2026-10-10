//go:build unix

package caps

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

// COVERAGE (T6 C2): a FIFO is not a regular file and is never opened (an
// open would block the walk until the command's deadline).
func TestFsSearchSkipsANonRegularFile(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"a.txt": "NEEDLE\n"})
	if err := syscall.Mkfifo(filepath.Join(d.Home, "pipe"), 0o644); err != nil {
		t.Skipf("cannot make a FIFO here: %v", err)
	}
	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if got := hits(out); !reflect.DeepEqual(got, []string{"a.txt:1: NEEDLE"}) {
		t.Errorf("hits = %q", got)
	}
}

// COVERAGE (GREEN's stated choice): an unreadable file is skipped, not
// counted, and the skip is stated rather than silent.
func TestFsSearchStatesAnUnreadableFile(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a 0o000 file")
	}
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"a.txt": "NEEDLE\n", "locked.txt": "NEEDLE\n"})
	locked := filepath.Join(d.Home, "locked.txt")
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o644) })
	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if got := hits(out); !reflect.DeepEqual(got, []string{"a.txt:1: NEEDLE"}) {
		t.Errorf("hits = %q", got)
	}
	if !strings.Contains(out.Output, "[skipped 1 unreadable") {
		t.Errorf("an unreadable file must be stated; output %q", out.Output)
	}
	if n := asInt(t, out.Meta["files_scanned"], "files_scanned"); n != 1 {
		t.Errorf("files_scanned = %d, want 1", n)
	}
}
