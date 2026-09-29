package platform

import (
	"os"
	"path/filepath"
	"testing"
)

// P6: a log that a handle from OpenLog holds open can still be renamed — a
// rotation's first step. os.OpenFile shares no deleting, so a handle from it
// makes Windows refuse this rename for as long as it is held.
func TestALogOpenedWithOpenLogCanBeRenamedWhileItIsHeld(t *testing.T) {
	path := filepath.Join(t.TempDir(), "novad.log")
	f, err := OpenLog(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString("before "); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatalf("renaming a held log: %v", err)
	}
	if _, err := f.WriteString("after"); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(path + ".1"); err != nil || string(b) != "before after" {
		t.Fatalf("the held handle wrote %q (%v), want both writes in the renamed file", b, err)
	}
}
