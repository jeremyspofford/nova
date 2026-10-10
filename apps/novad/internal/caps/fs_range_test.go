package caps

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// S30a T2: fs.read by line or byte range, on a file of any size. Args arrive
// from JSON, so every number here is a float64 exactly as core's frame
// decodes it.

// bigLineFile writes "line 0000001\n" .. until the file is at least 1 MiB
// (13 bytes a line), built here, never a checked-in blob. It returns the path,
// the byte size and the line count.
func bigLineFile(t *testing.T, dir string) (string, int64, int64) {
	t.Helper()
	var b strings.Builder
	n := int64(0)
	for b.Len() < 1<<20 {
		n++
		fmt.Fprintf(&b, "line %07d\n", n)
	}
	path := filepath.Join(dir, "big.txt")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	return path, int64(b.Len()), n
}

func smallFile(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// asInt reads a meta number whatever integer/float type the handler chose.
func asInt(t *testing.T, v any, what string) int64 {
	t.Helper()
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	default:
		t.Fatalf("meta %s is %T (%v), want a number", what, v, v)
		return 0
	}
}

func metaRange(t *testing.T, out Outcome) map[string]any {
	t.Helper()
	if out.Meta == nil {
		t.Fatalf("a ranged read must carry meta; got none (ok=%v err=%q)", out.OK, out.Error)
	}
	r, ok := out.Meta["range"].(map[string]any)
	if !ok {
		t.Fatalf("meta.range is %T (%v), want an object", out.Meta["range"], out.Meta["range"])
	}
	return r
}

func read(args map[string]any, d Deps) Outcome {
	return Dispatch(context.Background(), "fs.read", args, d)
}

// C1: a line range (1-based, inclusive) returns exactly those lines of a
// 1 MiB file, with bytes_total, lines_total and the range on meta. The same
// file read with no range is today's refusal with no meta (C4).
func TestFsReadALineRangeOfAFileOverTheCap(t *testing.T) {
	d := testDeps(t)
	path, size, lines := bigLineFile(t, d.Home)

	out := read(map[string]any{"path": path, "start_line": float64(40000), "end_line": float64(40002)}, d)
	if !out.OK {
		t.Fatalf("a 3-line range of a 1 MiB file must be read: %q", out.Error)
	}
	want := "line 0040000\nline 0040001\nline 0040002\n"
	if out.Output != want {
		t.Fatalf("lines 40000-40002 read %q, want %q", out.Output, want)
	}
	if got := asInt(t, out.Meta["bytes_total"], "bytes_total"); got != size {
		t.Errorf("bytes_total = %d, want %d", got, size)
	}
	if got := asInt(t, out.Meta["lines_total"], "lines_total"); got != lines {
		t.Errorf("lines_total = %d, want %d", got, lines)
	}
	r := metaRange(t, out)
	if asInt(t, r["start_line"], "range.start_line") != 40000 || asInt(t, r["end_line"], "range.end_line") != 40002 {
		t.Errorf("meta.range = %v, want start_line 40000 end_line 40002", r)
	}

	whole := read(map[string]any{"path": path}, d)
	if whole.OK || !strings.Contains(whole.Error, "read cap") {
		t.Errorf("with no range the 1 MiB file is still today's cap refusal, got ok=%v %q", whole.OK, whole.Error)
	}
	if whole.Meta != nil {
		t.Errorf("a read with no range carries no meta (today's frame), got %v", whole.Meta)
	}
}

// C2: a byte range returns exactly those bytes, with bytes_total and the
// range on meta. A byte range never scans for lines, so no lines_total.
func TestFsReadAByteRangeOfAFileOverTheCap(t *testing.T) {
	d := testDeps(t)
	path, size, _ := bigLineFile(t, d.Home)

	out := read(map[string]any{"path": path, "offset": float64(13 * 100), "length": float64(13)}, d)
	if !out.OK {
		t.Fatalf("a 13-byte range of a 1 MiB file must be read: %q", out.Error)
	}
	if out.Output != "line 0000101\n" {
		t.Fatalf("bytes 1300..1312 read %q, want %q", out.Output, "line 0000101\n")
	}
	if got := asInt(t, out.Meta["bytes_total"], "bytes_total"); got != size {
		t.Errorf("bytes_total = %d, want %d", got, size)
	}
	if _, has := out.Meta["lines_total"]; has {
		t.Errorf("a byte range does not count lines; meta has lines_total=%v", out.Meta["lines_total"])
	}
	r := metaRange(t, out)
	if asInt(t, r["offset"], "range.offset") != 1300 || asInt(t, r["length"], "range.length") != 13 {
		t.Errorf("meta.range = %v, want offset 1300 length 13", r)
	}
}

// Assumptions pinned: a line ends at "\n"; "\r\n" is returned verbatim (the
// "\r" stays, so a Windows file round-trips byte for byte); a final line with
// no trailing newline is still a line.
func TestFsReadLineRangesKeepCRLFAndCountALastLineWithoutNewline(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "win.txt", "a\r\nb\r\nc")

	first := read(map[string]any{"path": path, "start_line": float64(1), "end_line": float64(2)}, d)
	if !first.OK || first.Output != "a\r\nb\r\n" {
		t.Fatalf("lines 1-2 = ok=%v %q (%q), want %q", first.OK, first.Output, first.Error, "a\r\nb\r\n")
	}
	if got := asInt(t, first.Meta["lines_total"], "lines_total"); got != 3 {
		t.Errorf("lines_total = %d, want 3 (the last line has no newline but is a line)", got)
	}
	last := read(map[string]any{"path": path, "start_line": float64(3), "end_line": float64(3)}, d)
	if !last.OK || last.Output != "c" {
		t.Fatalf("line 3 = ok=%v %q (%q), want %q", last.OK, last.Output, last.Error, "c")
	}
}

// C3 (EOF half): a range past the end is ok, not an error: it returns what
// exists (possibly nothing), states bytes_total, and sets meta.eof.
func TestFsReadARangePastEOFIsOkAndStated(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "three.txt", "a\nb\nc\n")

	cases := []struct {
		name string
		args map[string]any
		want string
	}{
		{"lines wholly past the end", map[string]any{"start_line": float64(10), "end_line": float64(20)}, ""},
		{"lines running off the end", map[string]any{"start_line": float64(2), "end_line": float64(10)}, "b\nc\n"},
		{"bytes wholly past the end", map[string]any{"offset": float64(100), "length": float64(5)}, ""},
		{"bytes running off the end", map[string]any{"offset": float64(4), "length": float64(100)}, "c\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.args["path"] = path
			out := read(c.args, d)
			if !out.OK {
				t.Fatalf("a range past EOF is ok, got refusal %q", out.Error)
			}
			if out.Output != c.want {
				t.Errorf("output %q, want %q", out.Output, c.want)
			}
			if out.Meta == nil {
				t.Fatal("a range past EOF still states bytes_total on meta")
			}
			if got := asInt(t, out.Meta["bytes_total"], "bytes_total"); got != 6 {
				t.Errorf("bytes_total = %d, want 6", got)
			}
			if eof, _ := out.Meta["eof"].(bool); !eof {
				t.Errorf("meta.eof must be true when the range reaches past the end, meta=%v", out.Meta)
			}
		})
	}

	inside := read(map[string]any{"path": path, "start_line": float64(1), "end_line": float64(2)}, d)
	if !inside.OK {
		t.Fatalf("lines 1-2 must be read: %q", inside.Error)
	}
	if eof, _ := inside.Meta["eof"].(bool); eof {
		t.Errorf("a range inside the file is not eof, meta=%v", inside.Meta)
	}
}

// C3 (cap half): the cap applies to the RANGE. A range whose bytes exceed
// ReadCap is a stated refusal naming the cap, never a truncated read.
func TestFsReadARangeOverTheCapIsRefusedNotTruncated(t *testing.T) {
	d := testDeps(t)
	path, _, lines := bigLineFile(t, d.Home)

	for name, args := range map[string]map[string]any{
		"bytes": {"offset": float64(0), "length": float64(ReadCap + 1)},
		"lines": {"start_line": float64(1), "end_line": float64(lines)},
	} {
		t.Run(name, func(t *testing.T) {
			args["path"] = path
			out := read(args, d)
			if out.OK {
				t.Fatalf("a %s range over %d bytes must be refused, got %d bytes", name, ReadCap, len(out.Output))
			}
			if !strings.Contains(out.Error, "read cap") || !strings.Contains(out.Error, "range") {
				t.Errorf("the refusal must name the range and the read cap, got %q", out.Error)
			}
			if out.Output != "" {
				t.Errorf("a refusal carries no partial output, got %d bytes", len(out.Output))
			}
		})
	}

	exact := read(map[string]any{"path": path, "offset": float64(0), "length": float64(ReadCap)}, d)
	if !exact.OK || len(exact.Output) != ReadCap {
		t.Fatalf("a range of exactly the cap is read in full: ok=%v len=%d %q", exact.OK, len(exact.Output), exact.Error)
	}
}

// C4 (args half): a range is start_line+end_line XOR offset+length, whole
// non-negative integers; anything else is a stated refusal, never a guess
// and never a silent whole-file read.
func TestFsReadBadOrMixedRangesAreStatedRefusals(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "three.txt", "a\nb\nc\n")

	cases := map[string]map[string]any{
		"lines and bytes mixed": {"start_line": float64(1), "end_line": float64(2), "offset": float64(0), "length": float64(2)},
		"start_line alone":      {"start_line": float64(1)},
		"end_line alone":        {"end_line": float64(2)},
		"offset alone":          {"offset": float64(0)},
		"length alone":          {"length": float64(2)},
		"start_line zero":       {"start_line": float64(0), "end_line": float64(2)},
		"end before start":      {"start_line": float64(3), "end_line": float64(2)},
		"negative offset":       {"offset": float64(-1), "length": float64(2)},
		"zero length":           {"offset": float64(0), "length": float64(0)},
		"fractional line":       {"start_line": float64(1.5), "end_line": float64(2)},
		"string line":           {"start_line": "1", "end_line": "2"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			args["path"] = path
			out := read(args, d)
			if out.OK {
				t.Fatalf("%s must be a stated refusal, got ok with %q", name, out.Output)
			}
			if out.Error == "" || out.Output != "" {
				t.Errorf("a refusal states a reason and returns nothing: err=%q output=%q", out.Error, out.Output)
			}
		})
	}
}

// COVERAGE (C1/C3): a line longer than the agent's 64 KiB read buffer is one
// line, read whole; a line range of exactly ReadCap bytes is read in full,
// one byte more is refused; line numbers after a long line stay right.
func TestFsReadALineLongerThanTheReadBufferIsOneLine(t *testing.T) {
	d := testDeps(t)
	long := strings.Repeat("x", ReadCap-1) + "\n" // exactly ReadCap bytes
	path := smallFile(t, d.Home, "long.txt", "head\n"+long+"tail\n")

	out := read(map[string]any{"path": path, "start_line": float64(2), "end_line": float64(2)}, d)
	if !out.OK || out.Output != long {
		t.Fatalf("line 2 (exactly ReadCap bytes) must be read whole: ok=%v len=%d %q", out.OK, len(out.Output), out.Error)
	}
	if got := asInt(t, out.Meta["lines_total"], "lines_total"); got != 3 {
		t.Errorf("lines_total = %d, want 3", got)
	}
	tail := read(map[string]any{"path": path, "start_line": float64(3), "end_line": float64(3)}, d)
	if !tail.OK || tail.Output != "tail\n" {
		t.Fatalf("line 3 after a long line = ok=%v %q (%q), want %q", tail.OK, tail.Output, tail.Error, "tail\n")
	}
	over := read(map[string]any{"path": path, "start_line": float64(2), "end_line": float64(3)}, d)
	if over.OK || !strings.Contains(over.Error, "read cap") {
		t.Fatalf("lines 2-3 are ReadCap+5 bytes and must be refused, got ok=%v %q", over.OK, over.Error)
	}
}

// COVERAGE (C3): a range that ends exactly at the end of the file is not eof;
// eof means the request reached PAST the end.
func TestFsReadARangeEndingExactlyAtTheEndIsNotEOF(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "three.txt", "a\nb\nc\n")
	for name, args := range map[string]map[string]any{
		"lines": {"start_line": float64(2), "end_line": float64(3)},
		"bytes": {"offset": float64(2), "length": float64(4)},
	} {
		t.Run(name, func(t *testing.T) {
			args["path"] = path
			out := read(args, d)
			if !out.OK || out.Output != "b\nc\n" {
				t.Fatalf("ok=%v %q (%q), want %q", out.OK, out.Output, out.Error, "b\nc\n")
			}
			if eof, _ := out.Meta["eof"].(bool); eof {
				t.Errorf("a range ending exactly at the end is not eof, meta=%v", out.Meta)
			}
		})
	}
}

// COVERAGE (C4): a range on a directory is a stated refusal, not a read.
func TestFsReadARangeOnADirectoryIsRefused(t *testing.T) {
	d := testDeps(t)
	out := read(map[string]any{"path": d.Home, "start_line": float64(1), "end_line": float64(2)}, d)
	if out.OK || !strings.Contains(out.Error, "is a directory, not a file") {
		t.Fatalf("a ranged read of a directory must be refused naming it, got ok=%v %q", out.OK, out.Error)
	}
}
