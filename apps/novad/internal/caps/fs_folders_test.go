package caps

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withFolders(t *testing.T, folders map[string]string) {
	t.Helper()
	old := folderOf
	folderOf = func(name string) (string, error) {
		if p, ok := folders[name]; ok {
			return p, nil
		}
		return "", errors.New("this machine names no " + name + " folder")
	}
	t.Cleanup(func() { folderOf = old })
}

// P16: "@desktop" is the Desktop as THIS machine names it (OneDrive's on
// Windows), and the listing says which folder that was.
func TestAFolderTokenListsThatFolderAsTheMachineNamesIt(t *testing.T) {
	desk := t.TempDir()
	if err := os.WriteFile(filepath.Join(desk, "note.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	withFolders(t, map[string]string{"desktop": desk})
	out := Dispatch(context.Background(), "fs.list", map[string]any{"path": "@desktop"}, Deps{})
	if !out.OK || !strings.Contains(out.Output, "entries in "+desk) || !strings.Contains(out.Output, "note.txt") {
		t.Fatalf("got %+v", out)
	}
	out = Dispatch(context.Background(), "fs.read", map[string]any{"path": "@desktop/note.txt"}, Deps{})
	if !out.OK || out.Output != "hi" {
		t.Fatalf("got %+v", out)
	}
}

func TestAFolderTokenCannotClimbOutOfItsFolder(t *testing.T) {
	withFolders(t, map[string]string{"desktop": t.TempDir()})
	out := Dispatch(context.Background(), "fs.list", map[string]any{"path": "@desktop/../../etc"}, Deps{})
	if out.OK || !strings.Contains(out.Error, "must stay inside it") {
		t.Fatalf("got %+v", out)
	}
}

// Task 32, L77b: an @folder token is a locator, not a boundary — v4 keeps no
// fs_roots (owner ruling 2026-09-03). A symlink inside the folder is followed
// like any other path; a containment check that refused it would be the
// fs_root the ruling forbids, and this goes red the day one is built.
func TestASymlinkInsideAFolderIsFollowedLikeAnyOtherPath(t *testing.T) {
	desk, elsewhere := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(elsewhere, "note.txt"), []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, filepath.Join(desk, "link")); err != nil {
		t.Skipf("this machine would not make a symlink here: %v", err)
	}
	withFolders(t, map[string]string{"desktop": desk})
	out := Dispatch(context.Background(), "fs.read", map[string]any{"path": "@desktop/link/note.txt"}, Deps{})
	if !out.OK || out.Output != "outside" {
		t.Fatalf("a symlink inside the folder must be followed, got %+v", out)
	}
}

func TestAnUnknownFolderTokenIsRefusedByName(t *testing.T) {
	withFolders(t, map[string]string{})
	out := Dispatch(context.Background(), "fs.list", map[string]any{"path": "@pictures"}, Deps{})
	if out.OK || !strings.Contains(out.Error, "@pictures names no folder") {
		t.Fatalf("got %+v", out)
	}
}

func TestAFolderTheMachineDoesNotNameIsACannot(t *testing.T) {
	withFolders(t, map[string]string{})
	out := Dispatch(context.Background(), "fs.list", map[string]any{"path": "@desktop"}, Deps{})
	if out.OK || !strings.HasPrefix(out.Error, "cannot: ") || !strings.Contains(out.Error, "no desktop folder") {
		t.Fatalf("got %+v", out)
	}
}
