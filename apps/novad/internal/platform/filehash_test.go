package platform

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// FileSHA256 is the one file hash a build is checked with: supervise before
// it swaps a staged build in, install after it copies itself into place.
func TestFileSHA256IsTheHexDigestOfTheFilesBytes(t *testing.T) {
	p := filepath.Join(t.TempDir(), "build")
	if err := os.WriteFile(p, []byte("abc"), 0o600); err != nil {
		t.Fatal(err)
	}
	// FIPS 180-2's "abc" test vector.
	const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got, err := FileSHA256(p); err != nil || got != want {
		t.Fatalf("FileSHA256 = %q, %v; want %s", got, err, want)
	}
}

func TestFileSHA256OfAMissingFileSaysItIsMissing(t *testing.T) {
	if _, err := FileSHA256(filepath.Join(t.TempDir(), "absent")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("err = %v, want fs.ErrNotExist", err)
	}
}
