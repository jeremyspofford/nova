package caps

import (
	"strconv"
	"strings"
	"testing"
)

// T5 (verification 2-7): a model sometimes sends a whole number as a JSON
// string ("max_matches": "200"); core forwards device_search's max_matches
// raw, so the agent saw a string and refused a valid ask ("must be a whole
// number from 1 to 2000, got 200"). fs.read's range keys and fs.search's
// max_matches take a digits-only string as that whole number; anything else
// a string can hold is still refused in words.

// C1: a line range sent as digit strings reads exactly those lines.
func TestFsReadTakesALineRangeSentAsDigitStrings(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "lines.txt", "one\ntwo\nthree\nfour\n")
	out := read(wireArgs(t, `{"path": `+jsonString(t, path)+`, "start_line": "2", "end_line": "3"}`), d)
	if !out.OK {
		t.Fatalf("a digit-string line range was refused: %s", out.Error)
	}
	if out.Output != "two\nthree\n" {
		t.Fatalf("got %q, want lines 2-3", out.Output)
	}
}

// C1: leading zeros are still the number ("007" is 7).
func TestFsReadTakesLeadingZeroDigitStrings(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "lines.txt", "one\ntwo\nthree\nfour\n")
	out := read(wireArgs(t, `{"path": `+jsonString(t, path)+`, "start_line": "04", "end_line": "004"}`), d)
	if !out.OK || out.Output != "four\n" {
		t.Fatalf("leading-zero digit strings: ok=%v output=%q err=%q", out.OK, out.Output, out.Error)
	}
}

// C2: a byte range sent as digit strings reads exactly those bytes.
func TestFsReadTakesAByteRangeSentAsDigitStrings(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "bytes.txt", "abcdefghij")
	out := read(wireArgs(t, `{"path": `+jsonString(t, path)+`, "offset": "2", "length": "3"}`), d)
	if !out.OK || out.Output != "cde" {
		t.Fatalf("a digit-string byte range: ok=%v output=%q err=%q", out.OK, out.Output, out.Error)
	}
}

// C2: a mix of a wire number and a digit string is one range.
func TestFsReadTakesAMixedNumberAndDigitStringRange(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "bytes.txt", "abcdefghij")
	out := read(wireArgs(t, `{"path": `+jsonString(t, path)+`, "offset": 5, "length": "2"}`), d)
	if !out.OK || out.Output != "fg" {
		t.Fatalf("number offset + digit-string length: ok=%v output=%q err=%q", out.OK, out.Output, out.Error)
	}
}

// C3: max_matches sent as a digit string caps the search at that number.
func TestFsSearchTakesMaxMatchesSentAsADigitString(t *testing.T) {
	d := testDeps(t)
	smallFile(t, d.Home, "a.txt", "NEEDLE one\nNEEDLE two\nNEEDLE three\n")
	out := search(wireArgs(t, `{"path": `+jsonString(t, d.Home)+`, "pattern": "NEEDLE", "max_matches": "2"}`), d)
	if !out.OK {
		t.Fatalf("a digit-string max_matches was refused: %s", out.Error)
	}
	if n := len(hits(out)); n != 2 {
		t.Fatalf("max_matches \"2\" gave %d matches: %q", n, out.Output)
	}
}

// C3: the live failure's exact ask ("200") is accepted, and 200 is the cap.
func TestFsSearchTakesTheLiveMaxMatches200(t *testing.T) {
	d := testDeps(t)
	var b strings.Builder
	for i := 0; i < 205; i++ {
		b.WriteString("NEEDLE " + strconv.Itoa(i) + "\n")
	}
	smallFile(t, d.Home, "many.txt", b.String())
	out := search(wireArgs(t, `{"path": `+jsonString(t, d.Home)+`, "pattern": "NEEDLE", "max_matches": "200"}`), d)
	if !out.OK {
		t.Fatalf("max_matches \"200\" was refused: %s", out.Error)
	}
	if n := len(hits(out)); n != 200 {
		t.Fatalf("max_matches \"200\" gave %d matches", n)
	}
}

// C4: a string that is not digits-only is still a refusal in words.
func TestNonDigitStringsAreStillRefused(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "lines.txt", "one\ntwo\nthree\n")
	bad := []string{"1.5", "-1", "abc", "", " 2", "2 ", "+2", "2e3", "0x10", "١"}
	for _, v := range bad {
		r := read(map[string]any{"path": path, "start_line": v, "end_line": "2"}, d)
		if r.OK || !strings.Contains(r.Error, "start_line") || !strings.Contains(r.Error, "whole number") {
			t.Errorf("fs.read start_line %q: ok=%v err=%q, want a refusal naming start_line and \"whole number\"", v, r.OK, r.Error)
		}
		s := search(map[string]any{"path": d.Home, "pattern": "one", "max_matches": v}, d)
		if s.OK || !strings.Contains(s.Error, "max_matches") || !strings.Contains(s.Error, "whole number") {
			t.Errorf("fs.search max_matches %q: ok=%v err=%q, want a refusal naming max_matches and \"whole number\"", v, s.OK, s.Error)
		}
	}
}

// C5: a digit string passes every rule a number does, so these are refused
// for the RULE (ceiling, 1-based, size) — and only once digit strings are
// read as numbers can the refusal say so.
func TestDigitStringsKeepTheNumberRules(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "lines.txt", "one\ntwo\nthree\n")

	for _, v := range []string{"0", "2001"} {
		s := search(map[string]any{"path": d.Home, "pattern": "one", "max_matches": v}, d)
		if s.OK || !strings.Contains(s.Error, "2000") {
			t.Errorf("max_matches %q: ok=%v err=%q, want a refusal naming the 2000 ceiling", v, s.OK, s.Error)
		}
	}

	z := read(map[string]any{"path": path, "start_line": "0", "end_line": "2"}, d)
	if z.OK || !strings.Contains(z.Error, "1-based") {
		t.Errorf("start_line \"0\": ok=%v err=%q, want the 1-based refusal", z.OK, z.Error)
	}

	huge := read(map[string]any{"path": path, "offset": "99999999999999999999", "length": "2"}, d)
	if huge.OK || !strings.Contains(huge.Error, ">= 0") {
		t.Errorf("offset past 2^53: ok=%v err=%q, want the whole-number range refusal (\">= 0\")", huge.OK, huge.Error)
	}
}

// C5 (coverage): a digit string too long for a float64 (ParseFloat's
// ErrRange) is refused for its SIZE, by the same range rule, on both callers
// — not misread as a non-number string.
func TestADigitStringPastFloat64IsARangeRefusal(t *testing.T) {
	d := testDeps(t)
	path := smallFile(t, d.Home, "lines.txt", "one\ntwo\nthree\n")
	giant := strings.Repeat("9", 400)

	r := read(map[string]any{"path": path, "offset": giant, "length": "2"}, d)
	if r.OK || !strings.Contains(r.Error, "offset") || !strings.Contains(r.Error, ">= 0") {
		t.Errorf("400-digit offset: ok=%v err=%q, want the whole-number range refusal (\">= 0\")", r.OK, r.Error)
	}
	s := search(map[string]any{"path": d.Home, "pattern": "one", "max_matches": giant}, d)
	if s.OK || !strings.Contains(s.Error, "2000") {
		t.Errorf("400-digit max_matches: ok=%v err=%q, want the 2000-ceiling refusal", s.OK, s.Error)
	}
}
