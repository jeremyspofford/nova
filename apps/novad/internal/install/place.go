package install

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"novad/internal/platform"
)

// place copies this binary to bin, checks the copy's sha256, and moves any
// build already there aside (it may be running; a rename is always allowed).
// It returns the sha256. Nothing is copied when this binary IS bin.
func (o *Options) place(bin string) (string, error) {
	sum, err := platform.FileSHA256(o.Self)
	if err != nil {
		return "", fmt.Errorf("reading this binary: %w", err)
	}
	if same, _ := samePath(o.Self, bin); same {
		return sum, nil
	}
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		return "", err
	}
	tmp := bin + ".installing"
	if err := copyFile(o.Self, tmp); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("copying this binary to %s: %w", tmp, err)
	}
	got, err := platform.FileSHA256(tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("the copy at %s could not be read back to check it: %w", tmp, err)
	}
	if got != sum {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("the copy at %s does not match this binary (sha256 %s, want %s)", tmp, got, sum)
	}
	if _, err := os.Lstat(bin); err == nil {
		if err := os.Rename(bin, fmt.Sprintf("%s.old-%d", bin, o.Now().UnixNano())); err != nil {
			_ = os.Remove(tmp)
			return "", fmt.Errorf("moving the installed build aside: %w", err)
		}
	}
	if err := os.Rename(tmp, bin); err != nil {
		return "", err
	}
	return sum, nil
}

func samePath(a, b string) (bool, error) {
	ea, err := filepath.EvalSymlinks(a)
	if err != nil {
		return false, err
	}
	eb, err := filepath.EvalSymlinks(b)
	if err != nil {
		return false, err
	}
	return filepath.Clean(ea) == filepath.Clean(eb), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
