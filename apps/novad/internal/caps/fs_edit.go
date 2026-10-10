package caps

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// EditCap is the largest file fs.edit will change (S30a T4): the whole file is
// held in memory to count occurrences of `old`, so the cap bounds that. A
// larger file is a stated refusal, never a partial edit.
const EditCap = 16 << 20

// renameFile is the step that makes the edit visible; a variable so a test
// injects a failure and proves the temp file is removed and the original kept.
var renameFile = os.Rename

// countOccurrences counts every place `old` occurs in body, overlapping ones
// included ("aa" in "aaa" is two places the edit could mean).
func countOccurrences(body, old []byte) (n int, first int) {
	first = -1
	for i := 0; i <= len(body)-len(old); {
		j := bytes.Index(body[i:], old)
		if j < 0 {
			break
		}
		if first < 0 {
			first = i + j
		}
		n++
		i += j + 1
	}
	return n, first
}

// fsEdit replaces exactly one occurrence of args["old"] with args["new"] in
// the file at args["path"]. The bytes are matched exactly (no regex, no line
// ending translation). Zero or several occurrences are a refusal naming the
// count, and the file is untouched.
//
// The write is atomic: a temp file in the SAME directory as the file (a
// symlink is followed to its target, which is what is edited), fsynced, given
// the original's permission bits, then renamed over it. On every failure the
// temp file is removed and the original is byte-identical.
func fsEdit(args map[string]any, d Deps) Outcome {
	path, ok := strArg(args, "path")
	if !ok || path == "" {
		return fail("fs.edit needs a 'path'")
	}
	old, ok := strArg(args, "old")
	if !ok {
		return fail("fs.edit needs 'old' (the exact text to replace)")
	}
	if old == "" {
		return fail("fs.edit 'old' must not be empty: it would match everywhere")
	}
	repl, ok := strArg(args, "new")
	if !ok {
		return fail("fs.edit needs 'new' (a string, may be empty)")
	}
	path, err := resolvePath(path)
	if err != nil {
		return fail("%v", err)
	}
	target, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fail("could not edit %s: %v", path, err)
	}
	info, err := os.Stat(target)
	if err != nil {
		return fail("could not edit %s: %v", path, err)
	}
	if info.IsDir() {
		return fail("%s is a directory, not a file", path)
	}
	if !info.Mode().IsRegular() {
		return fail("%s is not a file fs.edit can change (mode %v)", path, info.Mode())
	}
	if info.Size() > EditCap {
		return fail("file is %d bytes, over the %d MiB edit cap", info.Size(), EditCap>>20)
	}
	f, err := os.Open(target)
	if err != nil {
		return fail("could not edit %s: %v", path, err)
	}
	// The cap holds on the read itself, not only the stat: a file that grows
	// past it in between is refused, never partially edited.
	body, err := io.ReadAll(io.LimitReader(f, EditCap+1))
	f.Close()
	if err != nil {
		return fail("could not edit %s: %v", path, err)
	}
	if len(body) > EditCap {
		return fail("file grew past the %d MiB edit cap while reading", EditCap>>20)
	}

	n, at := countOccurrences(body, []byte(old))
	if n != 1 {
		return fail("found %d matches of 'old' in %s; fs.edit changes exactly one (include more surrounding text to make it unique)", n, path)
	}
	out := make([]byte, 0, len(body)-len(old)+len(repl))
	out = append(out, body[:at]...)
	out = append(out, repl...)
	out = append(out, body[at+len(old):]...)

	if err := replaceAtomically(target, out, info.Mode().Perm()); err != nil {
		return fail("could not edit %s: %v", path, err)
	}
	res := ok0(fmt.Sprintf("edited %s: replaced 1 match (%d -> %d bytes)", path, len(body), len(out)))
	res.Meta = map[string]any{
		"matches":      1,
		"bytes_before": len(body),
		"bytes_after":  len(out),
	}
	return res
}

// replaceAtomically writes data to a temp file beside target, fsyncs it, sets
// perm and renames it over target. Any failure removes the temp file; target
// is then exactly as it was.
func replaceAtomically(target string, data []byte, perm os.FileMode) (err error) {
	tmp, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".novad-edit-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(name)
		}
	}()
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Chmod(perm); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return renameFile(name, target)
}
