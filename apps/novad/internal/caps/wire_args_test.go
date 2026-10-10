package caps

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// Args as the agent really receives them: client.readFrame decodes every frame
// with UseNumber, so a number on the wire is a json.Number, never a float64.
// Live 2026-10-10 (turns a2e158e7, e24d3ea3): fs.read's start_line and
// fs.search's max_matches refused every real call ("must be a whole number,
// got json.Number") while the Go-built-args tests passed.
func wireArgs(t *testing.T, raw string) map[string]any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatal(err)
	}
	return m
}

func jsonString(t *testing.T, s string) string {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestFsReadTakesALineRangeAsTheWireSendsIt(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "lines.txt", "one\ntwo\nthree\nfour\n")
	out := read(wireArgs(t, `{"path": `+jsonString(t, path)+`, "start_line": 2, "end_line": 3}`), d)
	if !out.OK {
		t.Fatalf("a wire-decoded line range was refused: %s", out.Error)
	}
	if out.Output != "two\nthree\n" {
		t.Fatalf("got %q, want lines 2-3", out.Output)
	}
}

func TestFsReadTakesAByteRangeAsTheWireSendsIt(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "bytes.txt", "abcdefghij")
	out := read(wireArgs(t, `{"path": `+jsonString(t, path)+`, "offset": 2, "length": 3}`), d)
	if !out.OK || out.Output != "cde" {
		t.Fatalf("a wire-decoded byte range: ok=%v output=%q", out.OK, out.Output)
	}
}

func TestFsReadStillRefusesAFractionFromTheWire(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "frac.txt", "one\ntwo\n")
	out := read(wireArgs(t, `{"path": `+jsonString(t, path)+`, "start_line": 1.5, "end_line": 2}`), d)
	if out.OK || !strings.Contains(out.Error, "whole number") {
		t.Fatalf("a fraction must be a stated refusal: ok=%v error=%q", out.OK, out.Error)
	}
}

func TestFsSearchTakesMaxMatchesAsTheWireSendsIt(t *testing.T) {
	d := testDeps(t)
	smallFile(t, d.Home, "a.txt", "NEEDLE one\nNEEDLE two\nNEEDLE three\n")
	out := search(wireArgs(t, `{"path": `+jsonString(t, d.Home)+`, "pattern": "NEEDLE", "max_matches": 2}`), d)
	if !out.OK {
		t.Fatalf("a wire-decoded max_matches was refused: %s", out.Error)
	}
	if n := strings.Count(out.Output, "NEEDLE"); n != 2 {
		t.Fatalf("max_matches 2 from the wire gave %d matches: %q", n, out.Output)
	}
}
