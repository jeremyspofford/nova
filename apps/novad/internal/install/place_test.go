package install

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPlaceCopiesTheBinaryAndChecksTheCopy(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "download", "novad")
	_ = os.MkdirAll(filepath.Dir(self), 0o755)
	if err := os.WriteFile(self, []byte("this build"), 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "install", "novad")
	o := &Options{Self: self, InstallDir: filepath.Dir(bin), Now: time.Now}
	sum, err := o.place(bin)
	if err != nil || len(sum) != 64 {
		t.Fatalf("sum %q err %v", sum, err)
	}
	if b, _ := os.ReadFile(bin); string(b) != "this build" {
		t.Fatal("the binary was not copied into place")
	}
	if err := os.WriteFile(self, []byte("a newer build"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := o.place(bin); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(bin); string(b) != "a newer build" {
		t.Fatal("the new build did not replace the old one")
	}
	if old, _ := filepath.Glob(bin + ".old-*"); len(old) != 1 {
		t.Fatalf("the replaced build must be moved aside, not deleted (it may be running): %v", old)
	}
}

func TestPlaceOfTheInstalledBinaryItselfCopiesNothing(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "novad")
	if err := os.WriteFile(bin, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	o := &Options{Self: bin, InstallDir: filepath.Dir(bin), Now: time.Now}
	if _, err := o.place(bin); err != nil {
		t.Fatal(err)
	}
	if old, _ := filepath.Glob(bin + ".*"); len(old) != 0 {
		t.Fatalf("nothing may be moved when it already runs from the install dir: %v", old)
	}
}
