package install

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"novad/internal/platform"
)

func TestPlaceCopiesTheBinaryAndChecksTheCopy(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "download", platform.BinaryName)
	_ = os.MkdirAll(filepath.Dir(self), 0o755)
	if err := os.WriteFile(self, []byte("this build"), 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "install", platform.BinaryName)
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
	bin := filepath.Join(t.TempDir(), platform.BinaryName)
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

// withSeam replaces one of place's file operations for the test.
func withSeam[T any](t *testing.T, seam *T, with T) {
	t.Helper()
	was := *seam
	*seam = with
	t.Cleanup(func() { *seam = was })
}

// replacing is a place over a build already installed at bin: this binary is
// a different build.
func replacing(t *testing.T) (*Options, string) {
	t.Helper()
	dir := t.TempDir()
	self := filepath.Join(dir, "download", platform.BinaryName)
	bin := filepath.Join(dir, "install", platform.BinaryName)
	for f, body := range map[string]string{self: "a newer build", bin: "the running build"} {
		if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return &Options{Self: self, InstallDir: filepath.Dir(bin), Now: time.Now}, bin
}

// besideBin is every file next to bin whose name starts with bin's.
func besideBin(t *testing.T, bin string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(bin))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if e.Name() != filepath.Base(bin) && strings.HasPrefix(e.Name(), filepath.Base(bin)) {
			names = append(names, e.Name())
		}
	}
	return names
}

func mustRead(t *testing.T, f string) string {
	t.Helper()
	b, err := os.ReadFile(f)
	if err != nil {
		t.Fatalf("%s: %v", f, err)
	}
	return string(b)
}

// place checks the copy it made before anything else moves: a copy whose
// sha256 is not this binary's is removed, and the build installed there is
// left exactly as it was — never moved aside for a bad copy.
func TestACopyThatDoesNotMatchLeavesTheInstalledBuildAsItWas(t *testing.T) {
	o, bin := replacing(t)
	withSeam(t, &copyBinary, func(_, dst string) error { return os.WriteFile(dst, []byte("not this build"), 0o755) })
	_, err := o.place(bin)
	if err == nil || !strings.Contains(err.Error(), "does not match this binary") {
		t.Fatalf("got %v", err)
	}
	if got := mustRead(t, bin); got != "the running build" {
		t.Fatalf("the installed build changed to %q", got)
	}
	if left := besideBin(t, bin); len(left) != 0 {
		t.Fatalf("a bad copy left files behind (.installing or an .old- build): %v", left)
	}
}

// Controller ruling (Task 11's review): when the new build cannot be renamed
// into place — on Windows, antivirus can hold a fresh exe — the build moved
// aside goes back, the copy is removed, and the error says both what failed
// and that the old build is back. Otherwise nothing would be installed at
// bin, and after a reboot the machine would have no agent to start.
func TestAPlaceThatCannotFinishPutsTheInstalledBuildBack(t *testing.T) {
	o, bin := replacing(t)
	held := errors.New("the file is being used by another process")
	withSeam(t, &rename, func(from, to string) error {
		if from == bin+".installing" && to == bin {
			return held
		}
		return os.Rename(from, to)
	})
	_, err := o.place(bin)
	if err == nil || !errors.Is(err, held) || !strings.Contains(err.Error(), "the build that was there is back in place") {
		t.Fatalf("got %v", err)
	}
	if got := mustRead(t, bin); got != "the running build" {
		t.Fatalf("bin holds %q, want the build that was there", got)
	}
	if left := besideBin(t, bin); len(left) != 0 {
		t.Fatalf("files left beside bin: %v", left)
	}
}

// When even putting it back fails, the error says where the build waits —
// never a success, and never silence about a missing binary.
func TestAPlaceThatCannotPutTheBuildBackSaysWhereItWaits(t *testing.T) {
	o, bin := replacing(t)
	held := errors.New("the file is being used by another process")
	withSeam(t, &rename, func(from, to string) error {
		if to == bin && from != bin {
			return held
		}
		return os.Rename(from, to)
	})
	_, err := o.place(bin)
	left := besideBin(t, bin)
	if len(left) != 1 || !strings.HasPrefix(left[0], filepath.Base(bin)+".old-") {
		t.Fatalf("want exactly the build moved aside beside bin, got %v", left)
	}
	aside := filepath.Join(filepath.Dir(bin), left[0])
	if err == nil || !errors.Is(err, held) || !strings.Contains(err.Error(), "could not be put back") || !strings.Contains(err.Error(), aside) {
		t.Fatalf("got %v", err)
	}
	if got := mustRead(t, aside); got != "the running build" {
		t.Fatalf("%s holds %q", aside, got)
	}
	if _, serr := os.Lstat(bin); !errors.Is(serr, os.ErrNotExist) {
		t.Fatalf("bin: %v", serr)
	}
}

// A first install that cannot finish leaves nothing behind, and says it
// moved nothing aside.
func TestAFirstPlaceThatCannotFinishLeavesNothingBehind(t *testing.T) {
	o, bin := replacing(t)
	if err := os.Remove(bin); err != nil {
		t.Fatal(err)
	}
	held := errors.New("the file is being used by another process")
	withSeam(t, &rename, func(from, to string) error {
		if to == bin {
			return held
		}
		return os.Rename(from, to)
	})
	_, err := o.place(bin)
	if err == nil || !errors.Is(err, held) || !strings.Contains(err.Error(), "no build had been moved aside") {
		t.Fatalf("got %v", err)
	}
	if left := besideBin(t, bin); len(left) != 0 {
		t.Fatalf("files left beside bin: %v", left)
	}
}
