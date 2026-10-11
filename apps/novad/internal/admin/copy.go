package admin

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// The protected copy (G7): the elevated task never runs the agent's own
// executable (under %LocalAppData%, which the owner's unelevated processes
// can write — anything running as him could replace it and inherit the
// elevated run). An elevated install copies it into a directory only
// SYSTEM and Administrators can write, verifies the copy (size + sha256),
// and registers the task against that copy only; the runner refuses to run
// from anywhere else. The same shape as the unix root-owned copy (T1).

// CopyName is the protected copy's file name.
const CopyName = "novad.exe"

// CopyDirOf is the protected copy's directory: <programFiles>\Nova\Admin.
// Program Files' own ACL lets no standard user create or change anything
// in it; the Admin directory is then created with CopyDirSDDL.
func CopyDirOf(programFiles string) string {
	return strings.TrimRight(programFiles, `\`) + `\Nova\Admin`
}

// CopyExeOf is the protected copy's full path: what the task is registered
// against and what the runner must be.
func CopyExeOf(programFiles string) string {
	return CopyDirOf(programFiles) + `\` + CopyName
}

// CopyDirSDDL is the protected copy directory's descriptor: owner
// Administrators, a protected DACL granting full control (inherited by the
// copy) to SYSTEM and Administrators only. No other entry: the owner's
// unelevated token carries Administrators deny-only, so it can neither
// write nor replace the copy.
func CopyDirSDDL() string {
	return "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
}

// CopyDirVerdict: ok only for a protected DACL with no deny entries whose
// allow entries are within {SYSTEM, Administrators} (at least one), owned
// by one of them; else false naming what was read.
func CopyDirVerdict(d DirSecurity) (bool, string) {
	admitted := map[string]bool{SIDSystem: true, SIDAdministrators: true}
	var bad []string
	if !d.Protected {
		bad = append(bad, "its DACL is not protected: it can inherit entries from its parent")
	}
	if !admitted[d.Owner] {
		bad = append(bad, "it is owned by "+d.Owner)
	}
	for _, a := range d.Allowed {
		if !admitted[a] {
			bad = append(bad, "it allows "+a)
		}
	}
	if len(d.Denied) > 0 {
		bad = append(bad, "it carries deny entries for "+strings.Join(d.Denied, ", "))
	}
	if len(d.Allowed) == 0 {
		bad = append(bad, "it admits no one")
	}
	if len(bad) > 0 {
		return false, "the protected copy's directory is not as built: " + strings.Join(bad, "; ")
	}
	return true, "the protected copy's directory admits only SYSTEM and Administrators"
}

// FileDigest is a file's size and sha256 (lowercase hex).
type FileDigest struct {
	Size   int64
	SHA256 string
}

// CopyVerdict: ok only when the copy's size and sha256 equal the source's
// (and something was read); else false naming both.
func CopyVerdict(src, cp FileDigest) (bool, string) {
	var bad []string
	if src.SHA256 == "" || cp.SHA256 == "" {
		bad = append(bad, "a sha256 was not read")
	}
	if cp.Size != src.Size {
		bad = append(bad, fmt.Sprintf("its size is %d, the agent's %d", cp.Size, src.Size))
	}
	if cp.SHA256 != src.SHA256 {
		bad = append(bad, fmt.Sprintf("its sha256 is %s, the agent's %s", cp.SHA256, src.SHA256))
	}
	if len(bad) > 0 {
		return false, "the protected copy does not match the agent: " + strings.Join(bad, "; ")
	}
	return true, fmt.Sprintf("the protected copy matches the agent (%d bytes, sha256 %s)", src.Size, src.SHA256)
}

// SameExe reports whether two Windows paths name the same file: equal but
// for case (NTFS paths are case-insensitive), nothing looser.
func SameExe(a, b string) bool {
	return a != "" && strings.EqualFold(a, b)
}

// FileSum reads a file's size and sha256.
func FileSum(path string) (FileDigest, error) {
	f, err := os.Open(path)
	if err != nil {
		return FileDigest{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return FileDigest{}, fmt.Errorf("reading %s: %w", path, err)
	}
	return FileDigest{Size: n, SHA256: hex.EncodeToString(h.Sum(nil))}, nil
}

// ReplaceFile copies src over dst, even while dst is a running program (a
// re-install through the path runs from the copy): it writes dst.new,
// renames the present dst aside (Windows renames a running image but never
// overwrites or deletes one), renames dst.new into place, then removes
// what it set aside — a removal a running image refuses is left in the
// protected directory and retried by the next install. A failure before
// the final rename leaves dst as it was.
func ReplaceFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("reading the agent %s: %w", src, err)
	}
	defer in.Close()
	tmp := dst + ".new"
	_ = os.Remove(tmp)
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		return fmt.Errorf("writing %s: %w", tmp, err)
	}
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("writing %s: %w", tmp, err)
	}
	removeAside(dst)
	aside := ""
	if _, err := os.Stat(dst); err == nil {
		var r [4]byte
		if _, err := rand.Read(r[:]); err != nil {
			_ = os.Remove(tmp)
			return err
		}
		aside = dst + ".old-" + hex.EncodeToString(r[:])
		if err := os.Rename(dst, aside); err != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("setting the old copy aside: %w", err)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		if aside != "" {
			_ = os.Rename(aside, dst)
		}
		_ = os.Remove(tmp)
		return fmt.Errorf("putting the new copy in place: %w", err)
	}
	if aside != "" {
		_ = os.Remove(aside) // a running image refuses: removeAside retries next time
	}
	return nil
}

// removeAside removes earlier set-aside copies (dst.old-*) that are no
// longer running.
func removeAside(dst string) {
	dir, base := filepath.Dir(dst), filepath.Base(dst)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), base+".old-") {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
