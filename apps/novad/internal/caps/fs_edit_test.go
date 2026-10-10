package caps

import (
	"bytes"
	"context"
	"crypto/sha256"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// S30a T4: fs.edit {path, old, new} replaces exactly one occurrence of the
// exact bytes `old` with `new`, atomically (a temp file in the same directory,
// then a rename). No regex, no line-ending translation: old and new are JSON
// strings and are matched as the bytes they encode.

func edit(args map[string]any, d Deps) Outcome {
	return Dispatch(context.Background(), "fs.edit", args, d)
}

func sum(t *testing.T, path string) [32]byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(b)
}

// dirNames lists a directory, sorted: what is there after an edit is exactly
// what was there before (no temp file left behind, C4).
func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names
}

func sameNames(t *testing.T, dir string, want []string, after string) {
	t.Helper()
	if got := dirNames(t, dir); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("after %s the directory holds %v, want exactly %v (no temp file left behind)", after, got, want)
	}
}

// C1: exactly one occurrence is replaced; every other byte is untouched; meta
// states matches 1 and the sizes before and after; the output names the path.
func TestFsEditReplacesTheOneExactOccurrence(t *testing.T) {
	d := testDeps(t)
	orig := "def f():\n    return 1\n\ndef g():\n    return 2\n"
	path := smallFile(t, d.Home, "a.py", orig)

	out := edit(map[string]any{"path": path, "old": "    return 1\n", "new": "    return 10 + 1\n"}, d)
	if !out.OK {
		t.Fatalf("one exact occurrence must be edited: %q", out.Error)
	}
	got, _ := os.ReadFile(path)
	want := "def f():\n    return 10 + 1\n\ndef g():\n    return 2\n"
	if string(got) != want {
		t.Fatalf("file after the edit is %q, want %q", got, want)
	}
	if out.Meta == nil {
		t.Fatal("an ok edit must carry meta {matches, bytes_before, bytes_after}")
	}
	if n := asInt(t, out.Meta["matches"], "matches"); n != 1 {
		t.Errorf("meta.matches = %d, want 1", n)
	}
	if n := asInt(t, out.Meta["bytes_before"], "bytes_before"); n != int64(len(orig)) {
		t.Errorf("meta.bytes_before = %d, want %d", n, len(orig))
	}
	if n := asInt(t, out.Meta["bytes_after"], "bytes_after"); n != int64(len(want)) {
		t.Errorf("meta.bytes_after = %d, want %d", n, len(want))
	}
	if !strings.Contains(out.Output, path) {
		t.Errorf("the output must name the edited file %s: %q", path, out.Output)
	}
	if out.ExitCode == nil || *out.ExitCode != 0 {
		t.Errorf("an ok edit has exit_code 0, got %v", out.ExitCode)
	}
}

// C1: `new` may be empty (delete the snippet); bytes are matched exactly, so
// CRLF in the file is matched and kept verbatim, and an LF-only `old` does not
// match a CRLF line (0 matches, the file untouched).
func TestFsEditMatchesExactBytesAndKeepsCRLF(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "w.txt", "a\r\nb\r\nc\r\n")

	lf := edit(map[string]any{"path": path, "old": "b\n", "new": "x\n"}, d)
	if lf.OK || !strings.Contains(lf.Error, "found 0 matches") {
		t.Fatalf("an LF-only old against a CRLF file matches nothing: ok=%v %q", lf.OK, lf.Error)
	}

	out := edit(map[string]any{"path": path, "old": "b\r\n", "new": "x\r\ny\r\n"}, d)
	if !out.OK {
		t.Fatalf("the exact CRLF bytes must match: %q", out.Error)
	}
	if got, _ := os.ReadFile(path); string(got) != "a\r\nx\r\ny\r\nc\r\n" {
		t.Fatalf("CRLF file after the edit is %q, want the other CRLFs verbatim", got)
	}

	del := edit(map[string]any{"path": path, "old": "y\r\n", "new": ""}, d)
	if !del.OK {
		t.Fatalf("an empty new deletes the snippet: %q", del.Error)
	}
	if got, _ := os.ReadFile(path); string(got) != "a\r\nx\r\nc\r\n" {
		t.Fatalf("after deleting y the file is %q", got)
	}

	re := smallFile(t, d.Home, "re.txt", "a.c abc\n")
	lit := edit(map[string]any{"path": re, "old": "a.c", "new": "Z"}, d)
	if !lit.OK {
		t.Fatalf("old is a literal, not a regex (a.c occurs once literally): %q", lit.Error)
	}
	if got, _ := os.ReadFile(re); string(got) != "Z abc\n" {
		t.Fatalf("a literal old replaced %q, want %q", got, "Z abc\n")
	}
}

// C2: zero or several occurrences are a refusal naming the count, and the
// file is byte-identical. Overlapping occurrences count: "aa" in "aaa" is two
// places the edit could mean, so it is refused, not guessed.
func TestFsEditRefusesZeroOrManyMatchesAndLeavesTheFile(t *testing.T) {
	d := testDeps(t)
	cases := []struct {
		name, body, old, want string
	}{
		{"none", "alpha\nbeta\n", "gamma", "found 0 matches"},
		{"two", "x = 1\nx = 1\n", "x = 1", "found 2 matches"},
		{"three", "ab ab ab", "ab", "found 3 matches"},
		{"overlapping", "aaa", "aa", "found 2 matches"},
	}
	for _, c := range cases {
		path := smallFile(t, d.Home, c.name+".txt", c.body)
		before := sum(t, path)
		out := edit(map[string]any{"path": path, "old": c.old, "new": "NEW"}, d)
		if out.OK {
			t.Errorf("%s: an edit with %q must be refused", c.name, c.want)
			continue
		}
		if !strings.Contains(out.Error, c.want) {
			t.Errorf("%s: refusal %q must say %q", c.name, out.Error, c.want)
		}
		if out.Output != "" {
			t.Errorf("%s: a refusal has no output, got %q", c.name, out.Output)
		}
		if sum(t, path) != before {
			t.Errorf("%s: a refused edit changed the file", c.name)
		}
	}
}

// C3: a 1 MiB file (four times the read/write cap) is edited; a file over
// EditCap is a stated refusal naming the cap, untouched.
func TestFsEditWorksPastTheReadCapAndRefusesOverEditCap(t *testing.T) {
	d := testDeps(t)
	path, size, _ := bigLineFile(t, d.Home)

	out := edit(map[string]any{"path": path, "old": "line 0040000\n", "new": "LINE FORTY THOUSAND\n"}, d)
	if !out.OK {
		t.Fatalf("a 1 MiB file must be editable: %q", out.Error)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Contains(got, []byte("line 0039999\nLINE FORTY THOUSAND\nline 0040001\n")) {
		t.Fatal("the 1 MiB file does not carry the edit in place")
	}
	if int64(len(got)) != size+7 {
		t.Errorf("1 MiB file is %d bytes after the edit, want %d", len(got), size+7)
	}
	if n := asInt(t, out.Meta["bytes_before"], "bytes_before"); n != size {
		t.Errorf("meta.bytes_before = %d, want %d", n, size)
	}

	huge := filepath.Join(d.Home, "huge.bin")
	f, err := os.Create(huge)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("needle"); err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(EditCap + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	before := sum(t, huge)
	over := edit(map[string]any{"path": huge, "old": "needle", "new": "pin"}, d)
	if over.OK || !strings.Contains(over.Error, "edit cap") {
		t.Fatalf("a file over EditCap must be refused naming the edit cap: ok=%v %q", over.OK, over.Error)
	}
	if sum(t, huge) != before {
		t.Error("a file over the edit cap was changed")
	}
}

// C3: bad calls are stated refusals with empty output: an empty old (it
// matches everywhere), missing path/old/new, a non-string, a directory, a
// missing file.
func TestFsEditBadCallsAreStatedRefusals(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "f.txt", "hello\n")
	before := sum(t, path)
	cases := []struct {
		name string
		args map[string]any
		want string
	}{
		{"empty old", map[string]any{"path": path, "old": "", "new": "x"}, "old"},
		{"no path", map[string]any{"old": "hello", "new": "x"}, "path"},
		{"no old", map[string]any{"path": path, "new": "x"}, "old"},
		{"no new", map[string]any{"path": path, "old": "hello"}, "new"},
		{"new not a string", map[string]any{"path": path, "old": "hello", "new": float64(1)}, "new"},
		{"directory", map[string]any{"path": d.Home, "old": "hello", "new": "x"}, "not a file"},
		{"missing file", map[string]any{"path": filepath.Join(d.Home, "nope.txt"), "old": "hello", "new": "x"}, "could not edit"},
	}
	for _, c := range cases {
		out := edit(c.args, d)
		if out.OK {
			t.Errorf("%s: must be refused", c.name)
			continue
		}
		if !strings.Contains(out.Error, c.want) || strings.Contains(out.Error, "not implemented") {
			t.Errorf("%s: refusal %q must name %q", c.name, out.Error, c.want)
		}
		if out.Output != "" {
			t.Errorf("%s: a refusal has no output, got %q", c.name, out.Output)
		}
	}
	if sum(t, path) != before {
		t.Error("a refused call changed the file")
	}
}

// C4: no temp file is left behind, on the ok path or any refusal.
func TestFsEditLeavesNoTempFileBehind(t *testing.T) {
	d := testDeps(t)
	dir := filepath.Join(d.Home, "repo")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := smallFile(t, dir, "README.md", "# Title\nsame\nsame\n")
	want := dirNames(t, dir)

	ok := edit(map[string]any{"path": path, "old": "# Title", "new": "# New title"}, d)
	if !ok.OK {
		t.Fatalf("the edit must succeed: %q", ok.Error)
	}
	sameNames(t, dir, want, "an ok edit")

	many := edit(map[string]any{"path": path, "old": "same", "new": "x"}, d)
	if many.OK || !strings.Contains(many.Error, "found 2 matches") {
		t.Fatalf("two matches must be refused: ok=%v %q", many.OK, many.Error)
	}
	sameNames(t, dir, want, "a count refusal")

	none := edit(map[string]any{"path": path, "old": "absent", "new": "x"}, d)
	if none.OK || !strings.Contains(none.Error, "found 0 matches") {
		t.Fatalf("zero matches must be refused: ok=%v %q", none.OK, none.Error)
	}
	sameNames(t, dir, want, "a zero-match refusal")
}

// C4: when the final rename fails (Windows: the file held open without
// FILE_SHARE_DELETE; anywhere: a full or read-only disk), the temp file is
// removed and the original is byte-identical; the refusal is stated.
func TestFsEditARenameFailureLeavesNoTempAndTheOriginal(t *testing.T) {
	d := testDeps(t)
	dir := filepath.Join(d.Home, "repo")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := smallFile(t, dir, "a.txt", "one two\n")
	before, want := sum(t, path), dirNames(t, dir)

	saved := renameFile
	renameFile = func(string, string) error { return os.ErrPermission }
	defer func() { renameFile = saved }()

	out := edit(map[string]any{"path": path, "old": "one", "new": "1"}, d)
	if out.OK || !strings.Contains(out.Error, "could not edit") {
		t.Fatalf("a failed rename must be a stated refusal: ok=%v %q", out.OK, out.Error)
	}
	if out.Output != "" || out.Meta != nil {
		t.Errorf("a refusal carries no output or meta: %q %v", out.Output, out.Meta)
	}
	if sum(t, path) != before {
		t.Error("a failed rename changed the original")
	}
	sameNames(t, dir, want, "a failed rename")
}

// C3: each refusal states its own reason, not a neighbour's: an empty old is
// refused as empty (never counted as N matches), a directory is named as one,
// and a file over EditCap states its size beside the cap (the stat check, not
// only the read-time one).
func TestFsEditRefusalsStateTheirOwnReason(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "f.txt", "hello\n")

	empty := edit(map[string]any{"path": path, "old": "", "new": "x"}, d)
	if empty.OK || !strings.Contains(empty.Error, "empty") || strings.Contains(empty.Error, "matches") {
		t.Errorf("an empty old is refused as empty, not counted: ok=%v %q", empty.OK, empty.Error)
	}

	dir := edit(map[string]any{"path": d.Home, "old": "a", "new": "b"}, d)
	if dir.OK || !strings.Contains(dir.Error, "directory") {
		t.Errorf("a directory is named as one: ok=%v %q", dir.OK, dir.Error)
	}

	huge := filepath.Join(d.Home, "huge.bin")
	f, err := os.Create(huge)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(EditCap + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	over := edit(map[string]any{"path": huge, "old": "x", "new": "y"}, d)
	if over.OK || !strings.Contains(over.Error, strconv.Itoa(EditCap+1)+" bytes") {
		t.Errorf("an over-cap file states its size: ok=%v %q", over.OK, over.Error)
	}
}
