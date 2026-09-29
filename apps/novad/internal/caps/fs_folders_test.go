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
