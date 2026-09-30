package install

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"novad/internal/platform"
)

// place's file operations; a test makes one fail, or copy the wrong bytes
// (supervise keeps the same seam for its renames).
var (
	copyBinary = copyFile
	rename     = os.Rename
)

// place copies this binary to bin, checks the copy's sha256, and moves any
// build already there aside (it may be running; a rename is always allowed).
// It returns the sha256. Nothing is copied when this binary IS bin. A copy
// that cannot be put in place leaves the build that was there where it was
// (putBack): nothing installed at bin would leave the service nothing to
// start at the next boot or sign-in.
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
	if err := copyBinary(o.Self, tmp); err != nil {
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
	aside := ""
	if _, err := os.Lstat(bin); err == nil {
		aside = fmt.Sprintf("%s.old-%d", bin, o.Now().UnixNano())
		if err := rename(bin, aside); err != nil {
			_ = os.Remove(tmp)
			return "", fmt.Errorf("moving the installed build aside: %w", err)
		}
	}
	if err := rename(tmp, bin); err != nil {
		return "", putBack(bin, tmp, aside, err)
	}
	return sum, nil
}

// putBack undoes a place whose last rename failed — on Windows, antivirus can
// hold a fresh exe: the build moved aside returns to bin, and the copy is
// removed. The error names the failure and says whether the build that was
// there is back, or where it waits when it could not be put back.
func putBack(bin, tmp, aside string, cause error) error {
	var then []string
	switch {
	case aside == "":
		then = append(then, "no build had been moved aside")
	default:
		if err := rename(aside, bin); err != nil {
			then = append(then, fmt.Sprintf("and the build that was there could not be put back (%v): it waits at %s", err, aside))
		} else {
			then = append(then, "the build that was there is back in place")
		}
	}
	if err := os.Remove(tmp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		then = append(then, fmt.Sprintf("the copy at %s could not be removed (%v)", tmp, err))
	}
	return fmt.Errorf("putting the new build in place at %s: %w — %s", bin, cause, strings.Join(then, "; "))
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
