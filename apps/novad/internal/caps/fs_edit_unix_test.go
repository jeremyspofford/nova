//go:build unix

package caps

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func inode(t *testing.T, path string) uint64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Sys().(*syscall.Stat_t).Ino
}

// C1 (unix): the edit is a rename of a temp file over the original (a new
// inode: never written in place, so a reader sees the old file or the new one,
// never half), and the original's mode is kept (0o755 stays 0o755, 0o600 stays
// 0o600 — not fs.write's 0o644).
func TestFsEditIsARenameAndKeepsTheMode(t *testing.T) {
	d := testDeps(t)
	for _, mode := range []os.FileMode{0o755, 0o600} {
		path := smallFile(t, d.Home, "run-"+mode.String()+".sh", "#!/bin/sh\necho old\n")
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		ino := inode(t, path)

		out := edit(map[string]any{"path": path, "old": "echo old", "new": "echo new"}, d)
		if !out.OK {
			t.Fatalf("%v: the edit must succeed: %q", mode, out.Error)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != mode {
			t.Errorf("mode after the edit is %v, want %v kept", info.Mode().Perm(), mode)
		}
		if inode(t, path) == ino {
			t.Errorf("%v: the file kept its inode — written in place, not renamed over", mode)
		}
		if got, _ := os.ReadFile(path); string(got) != "#!/bin/sh\necho new\n" {
			t.Errorf("%v: file after the edit is %q", mode, got)
		}
	}
}

// Design call (symlink): fs.edit follows a symlink like every fs capability
// (resolvePath: "a symlink is followed like any other path") and edits its
// TARGET; the link stays a link pointing where it did, and no temp file is
// left beside the link or the target.
func TestFsEditThroughASymlinkEditsTheTargetAndKeepsTheLink(t *testing.T) {
	d := testDeps(t)
	realDir := filepath.Join(d.Home, "real")
	linkDir := filepath.Join(d.Home, "links")
	for _, dir := range []string{realDir, linkDir} {
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	target := smallFile(t, realDir, "conf.txt", "key=old\n")
	link := filepath.Join(linkDir, "conf.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	realNames, linkNames := dirNames(t, realDir), dirNames(t, linkDir)

	out := edit(map[string]any{"path": link, "old": "old", "new": "new"}, d)
	if !out.OK {
		t.Fatalf("an edit through a symlink edits the target: %q", out.Error)
	}
	li, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	if li.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the link was replaced by a regular file; it must stay a symlink")
	}
	if dest, _ := os.Readlink(link); dest != target {
		t.Errorf("the link now points at %q, want %q", dest, target)
	}
	if got, _ := os.ReadFile(target); string(got) != "key=new\n" {
		t.Errorf("target after the edit is %q, want %q", got, "key=new\n")
	}
	sameNames(t, realDir, realNames, "an edit through a link (target dir)")
	sameNames(t, linkDir, linkNames, "an edit through a link (link dir)")
}

// C3 (unix): a path that is not a regular file (a FIFO) is a stated refusal,
// never opened — opening a FIFO for read would block the capability forever.
func TestFsEditRefusesANonRegularFile(t *testing.T) {
	d := testDeps(t)
	fifo := filepath.Join(d.Home, "pipe")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Skipf("no mkfifo here: %v", err)
	}
	done := make(chan Outcome, 1)
	go func() { done <- edit(map[string]any{"path": fifo, "old": "a", "new": "b"}, d) }()
	select {
	case out := <-done:
		if out.OK || !strings.Contains(out.Error, "not a file") {
			t.Fatalf("a FIFO must be refused as not a file: ok=%v %q", out.OK, out.Error)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("fs.edit blocked on a FIFO instead of refusing it")
	}
}
