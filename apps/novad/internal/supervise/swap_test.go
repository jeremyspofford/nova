package supervise

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// A revert that cannot put .prev back must not leave the machine with no
// build at all: nothing would start the agent again. The build that did not
// connect goes back in place (it may only have been slow to connect), and the
// error says why nothing was put back.
func TestARevertWithNoPreviousBuildLeavesTheInstalledOneInPlace(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "novad")
	if err := os.WriteFile(bin, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Revert(bin); err == nil {
		t.Fatal("Revert reported success with no previous build to put back")
	}
	if got := read(t, bin); got != "new" {
		t.Fatalf("installed build = %q — a revert with nothing to put back must leave a build in place", got)
	}
}

// Task 32 Phase C (C3): removeOld deletes, so it must read the install
// directory and match names there, never glob it. In a glob a bracket is a
// character class: under a folder named like C:\Users\[Jane]\… the pattern
// matches a DIFFERENT folder's files and none of its own. Here "[ab]" as a
// glob names the folder "a" beside it, which holds files of the same shapes.
// Only the builds moved aside in the install directory itself go; nothing
// outside it is touched, nor the running build, .prev, or a file that only
// starts the same way.
func TestRemoveOldTouchesNothingOutsideTheInstallDirectory(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "[ab]")
	sibling := filepath.Join(root, "a")
	for _, d := range []string{dir, sibling} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	bin := filepath.Join(dir, "novad")
	gone := []string{
		bin + ".old-1790000000000000001",
		bin + ".prev.old-1790000000000000002",
		bin + ".failed.old-1790000000000000003",
	}
	kept := []string{bin, bin + ".prev", bin + ".old-backup", filepath.Join(dir, "other.old-1790000000000000004")}
	outside := []string{
		filepath.Join(sibling, "novad"),
		filepath.Join(sibling, "novad.old-1790000000000000001"),
		filepath.Join(sibling, "novad.prev.old-1790000000000000002"),
		filepath.Join(sibling, "novad.failed.old-1790000000000000003"),
	}
	for _, f := range append(append(append([]string{}, gone...), kept...), outside...) {
		if err := os.WriteFile(f, []byte("a build"), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	removeOld(bin)

	for _, f := range gone {
		if _, err := os.Lstat(f); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s was moved aside in the install directory, and it is still there (%v)", f, err)
		}
	}
	for _, f := range kept {
		if _, err := os.Lstat(f); err != nil {
			t.Errorf("%s is not a build moved aside, and it was touched: %v", f, err)
		}
	}
	for _, f := range outside {
		if _, err := os.Lstat(f); err != nil {
			t.Errorf("%s is outside the install directory %s, and it was touched: %v", f, dir, err)
		}
	}
}
