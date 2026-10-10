package caps

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

// S30a T6: fs.search {path, pattern, literal?, ignore_case?, max_matches?}
// walks the directory tree at path natively (no ripgrep) and answers every
// matching LINE as `relpath:line: text`: relpath relative to path with
// forward slashes on every OS, line 1-based, text without its line ending.
// Order is the walk's: directory entries by name, depth first, lines
// ascending. Notes (no matches, a cap reached) are lines starting with "[".

func search(args map[string]any, d Deps) Outcome {
	return Dispatch(context.Background(), "fs.search", args, d)
}

// tree writes files (slash paths relative to root) and their parent dirs.
func tree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// hits is the output's match lines (every line not starting with "[").
func hits(out Outcome) []string {
	var got []string
	for _, l := range strings.Split(out.Output, "\n") {
		if l != "" && !strings.HasPrefix(l, "[") {
			got = append(got, l)
		}
	}
	return got
}

// hitFiles is the set of relpaths with at least one match, in output order.
func hitFiles(out Outcome) []string {
	var got []string
	seen := map[string]bool{}
	for _, l := range hits(out) {
		f := l[:strings.Index(l, ":")]
		if !seen[f] {
			seen[f] = true
			got = append(got, f)
		}
	}
	return got
}

func mustSearch(t *testing.T, args map[string]any, d Deps) Outcome {
	t.Helper()
	out := search(args, d)
	if !out.OK {
		t.Fatalf("fs.search %v must succeed: %q", args, out.Error)
	}
	if out.ExitCode == nil || *out.ExitCode != 0 {
		t.Errorf("an ok search has exit_code 0, got %v", out.ExitCode)
	}
	if out.Meta == nil {
		t.Fatalf("an ok search carries meta {matches, files_scanned, capped}; got none")
	}
	return out
}

func metaCapped(t *testing.T, out Outcome) bool {
	t.Helper()
	c, ok := out.Meta["capped"].(bool)
	if !ok {
		t.Fatalf("meta.capped is %T (%v), want a bool", out.Meta["capped"], out.Meta["capped"])
	}
	return c
}

// C1: a regex (RE2) and a literal over a tree; `relpath:line: text` with
// forward slashes; same answer every time; meta counts lines and files.
func TestFsSearchFindsARegexAndALiteralInWalkOrder(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{
		"a.go":          "func Foo() {}\nfunc Bar()\n",
		"b.go":          "x\nfunc Foo()\n",
		"sub/deep/c.go": "  Foo.bar\n  Foo(1)\n",
	})

	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": `Foo\(`}, d)
	want := []string{
		"a.go:1: func Foo() {}",
		"b.go:2: func Foo()",
		"sub/deep/c.go:2:   Foo(1)",
	}
	if got := hits(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("regex hits = %q, want %q", got, want)
	}
	if n := asInt(t, out.Meta["matches"], "matches"); n != 3 {
		t.Errorf("meta.matches = %d, want 3 (one per matching line)", n)
	}
	if n := asInt(t, out.Meta["files_scanned"], "files_scanned"); n != 3 {
		t.Errorf("meta.files_scanned = %d, want 3", n)
	}
	if metaCapped(t, out) {
		t.Error("meta.capped = true on a search that reached no cap")
	}
	again := mustSearch(t, map[string]any{"path": d.Home, "pattern": `Foo\(`}, d)
	if again.Output != out.Output {
		t.Errorf("the same search answered differently:\n%q\n%q", out.Output, again.Output)
	}

	// literal: "Foo." is the four bytes, not "Foo" + any character.
	lit := mustSearch(t, map[string]any{"path": d.Home, "pattern": "Foo.", "literal": true}, d)
	if got := hits(lit); !reflect.DeepEqual(got, []string{"sub/deep/c.go:1:   Foo.bar"}) {
		t.Errorf("literal hits = %q, want only the line holding \"Foo.\"", got)
	}
	// A line matching twice is one match.
	two := mustSearch(t, map[string]any{"path": d.Home, "pattern": "o"}, d)
	if n := asInt(t, two.Meta["matches"], "matches"); n != int64(len(hits(two))) {
		t.Errorf("meta.matches = %d but %d lines were output", n, len(hits(two)))
	}
}

func TestFsSearchIgnoreCaseIsAFlag(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"a.txt": "FOO.bar\nfoo\n"})

	sensitive := mustSearch(t, map[string]any{"path": d.Home, "pattern": "foo"}, d)
	if got := hits(sensitive); !reflect.DeepEqual(got, []string{"a.txt:2: foo"}) {
		t.Errorf("case-sensitive by default: hits = %q", got)
	}
	insensitive := mustSearch(t, map[string]any{"path": d.Home, "pattern": "foo", "ignore_case": true}, d)
	if got := hits(insensitive); len(got) != 2 {
		t.Errorf("ignore_case: hits = %q, want both lines", got)
	}
	lit := mustSearch(t, map[string]any{"path": d.Home, "pattern": "foo.", "literal": true, "ignore_case": true}, d)
	if got := hits(lit); !reflect.DeepEqual(got, []string{"a.txt:1: FOO.bar"}) {
		t.Errorf("literal + ignore_case: hits = %q", got)
	}
}

// Line endings are not text; a long line is cut at SearchLineCap with a
// stated marker; a line longer than any read buffer is still one line.
func TestFsSearchStripsLineEndingsAndCutsALongLine(t *testing.T) {
	d := testDeps(t)
	long := strings.Repeat("x", 100<<10) + "NEEDLE"
	tree(t, d.Home, map[string]string{
		"crlf.txt": "one\r\nNEEDLE two\r\n",
		"long.txt": "first\n" + long + "\nNEEDLE after\n",
	})
	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	want := []string{
		"crlf.txt:2: NEEDLE two",
		"long.txt:2: " + long[:SearchLineCap] + searchTruncMark,
		"long.txt:3: NEEDLE after",
	}
	if got := hits(out); !reflect.DeepEqual(got, want) {
		for i := range got {
			if len(got[i]) > 120 {
				got[i] = got[i][:120] + "..."
			}
		}
		t.Errorf("hits = %q, want crlf.txt:2, long.txt:2 cut at SearchLineCap + %q, long.txt:3", got, searchTruncMark)
	}
}

// C2: .gitignore is honoured (root + nested, negation, dir-only, **,
// comments); .git is always skipped; a binary file (NUL in its first 8 KiB)
// is skipped and not counted.
func TestFsSearchHonoursGitignoreAndSkipsGitAndBinaries(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{
		".gitignore":        "#a.txt\n*.log\n!keep.log\nbuild/\n/top.txt\ndocs/**/draft.md\ngen/**\n",
		"a.txt":             "NEEDLE\n", // only a comment names it
		"x.log":             "NEEDLE\n",
		"keep.log":          "NEEDLE\n",
		"deep/y.log":        "NEEDLE\n",
		"build/o.txt":       "NEEDLE\n",
		"src/build":         "NEEDLE\n", // a FILE named build
		"top.txt":           "NEEDLE\n",
		"src/top.txt":       "NEEDLE\n",
		"docs/draft.md":     "NEEDLE\n",
		"docs/a/b/draft.md": "NEEDLE\n",
		"docs/final.md":     "NEEDLE\n",
		"gen/z.txt":         "NEEDLE\n",
		"sub/.gitignore":    "*.tmp\n!special.log\n",
		"sub/t.tmp":         "NEEDLE\n",
		"t.tmp":             "NEEDLE\n",
		"sub/special.log":   "NEEDLE\n",
		"sub/other.log":     "NEEDLE\n",
		".git/config":       "NEEDLE\n",
		".git/HEAD":         "NEEDLE\n",
		"bin.dat":           "NEEDLE\x00\x01\x02",
		"late-nul.dat":      strings.Repeat("y", 9<<10) + "\x00\nNEEDLE\n", // NUL past 8 KiB: text
	})
	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE", "literal": true}, d)
	want := []string{
		"a.txt", "docs/final.md", "keep.log", "late-nul.dat", "src/build", "src/top.txt",
		"sub/special.log", "t.tmp",
	}
	got := hitFiles(out)
	gotSorted := append([]string(nil), got...)
	sort.Strings(gotSorted)
	if !reflect.DeepEqual(gotSorted, want) {
		t.Fatalf("files with hits = %q, want exactly %q", got, want)
	}
	// files_scanned counts the text files searched: the 8 above plus the two
	// .gitignore files (they are text in the tree); bin.dat is not counted.
	if n := asInt(t, out.Meta["files_scanned"], "files_scanned"); n != 10 {
		t.Errorf("meta.files_scanned = %d, want 10 (8 hit files + 2 .gitignore; binaries, ignored files and .git not scanned)", n)
	}
}

// The search root is never ignored (it was asked for by name), and the
// repository's .gitignore files ABOVE it apply: the walk climbs to the
// nearest directory holding .git. With no .git above, nothing above applies.
func TestFsSearchReadsTheRepositorysGitignoreAboveThePath(t *testing.T) {
	d := testDeps(t)
	repo := filepath.Join(d.Home, "repo")
	tree(t, repo, map[string]string{
		".git/HEAD":   "ref: refs/heads/main\n",
		".gitignore":  "*.log\nbuild/\n",
		"sub/a.txt":   "NEEDLE\n",
		"sub/a.log":   "NEEDLE\n",
		"build/b.txt": "NEEDLE\n",
	})
	out := mustSearch(t, map[string]any{"path": filepath.Join(repo, "sub"), "pattern": "NEEDLE"}, d)
	if got := hits(out); !reflect.DeepEqual(got, []string{"a.txt:1: NEEDLE"}) {
		t.Errorf("searching repo/sub: hits = %q, want only a.txt (the repo root's *.log applies; relpath is relative to the path searched)", got)
	}
	named := mustSearch(t, map[string]any{"path": filepath.Join(repo, "build"), "pattern": "NEEDLE"}, d)
	if got := hits(named); !reflect.DeepEqual(got, []string{"b.txt:1: NEEDLE"}) {
		t.Errorf("searching an ignored dir by name: hits = %q, want b.txt", got)
	}

	plain := filepath.Join(d.Home, "plain")
	tree(t, plain, map[string]string{
		".gitignore": "*.log\n",
		"sub/a.log":  "NEEDLE\n",
	})
	out = mustSearch(t, map[string]any{"path": filepath.Join(plain, "sub"), "pattern": "NEEDLE"}, d)
	if got := hits(out); !reflect.DeepEqual(got, []string{"a.log:1: NEEDLE"}) {
		t.Errorf("no repository above: hits = %q, want a.log (a .gitignore above the path applies only inside a repository)", got)
	}
}

// Symlinks are not followed, to a file or a directory: a link cycle cannot
// loop the walk, and nothing is reported twice.
func TestFsSearchDoesNotFollowSymlinks(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"a.txt": "NEEDLE\n", "sub/b.txt": "NEEDLE\n"})
	if err := os.Symlink(d.Home, filepath.Join(d.Home, "sub", "loop")); err != nil {
		t.Skipf("cannot make a symlink here: %v", err)
	}
	if err := os.Symlink(filepath.Join(d.Home, "a.txt"), filepath.Join(d.Home, "link.txt")); err != nil {
		t.Skipf("cannot make a symlink here: %v", err)
	}
	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	want := []string{"a.txt:1: NEEDLE", "sub/b.txt:1: NEEDLE"}
	if got := hits(out); !reflect.DeepEqual(got, want) {
		t.Errorf("hits = %q, want %q (no link followed)", got, want)
	}
}

func needles(n int) string {
	var b strings.Builder
	for i := 1; i <= n; i++ {
		b.WriteString("NEEDLE " + strconv.Itoa(i) + "\n")
	}
	return b.String()
}

// C3: max_matches (default SearchDefaultMatches, ceiling SearchMaxMatches).
// capped is true only when a match past the cap exists, and then the output
// says so in its last line.
func TestFsSearchStopsAtMaxMatchesAndSaysSo(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"five.txt": needles(5)})

	exact := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE", "max_matches": float64(5)}, d)
	if len(hits(exact)) != 5 || metaCapped(t, exact) || strings.Contains(exact.Output, "[stopped") {
		t.Errorf("exactly max_matches matches is not capped: %d hits, capped=%v, output %q",
			len(hits(exact)), exact.Meta["capped"], exact.Output)
	}

	capped := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE", "max_matches": float64(4)}, d)
	if len(hits(capped)) != 4 || !metaCapped(t, capped) {
		t.Errorf("max_matches 4 of 5: %d hits, capped=%v", len(hits(capped)), capped.Meta["capped"])
	}
	if n := asInt(t, capped.Meta["matches"], "matches"); n != 4 {
		t.Errorf("meta.matches = %d, want 4 (what was output)", n)
	}
	lines := strings.Split(strings.TrimRight(capped.Output, "\n"), "\n")
	if last := lines[len(lines)-1]; !strings.HasPrefix(last, "[stopped") || !strings.Contains(last, "max_matches") {
		t.Errorf("reaching max_matches must be stated in the last line; got %q", last)
	}

	tree(t, d.Home, map[string]string{"five.txt": needles(SearchDefaultMatches + 50)})
	def := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if len(hits(def)) != SearchDefaultMatches || !metaCapped(t, def) {
		t.Errorf("default max_matches: %d hits, capped=%v, want %d and true", len(hits(def)), def.Meta["capped"], SearchDefaultMatches)
	}

	over := search(map[string]any{"path": d.Home, "pattern": "NEEDLE", "max_matches": float64(SearchMaxMatches + 1)}, d)
	if over.OK || !strings.Contains(over.Error, strconv.Itoa(SearchMaxMatches)) {
		t.Errorf("max_matches over the ceiling is a refusal naming it: ok=%v err=%q", over.OK, over.Error)
	}
}

// C3: output bytes are capped at OutputCap; only whole lines are output and
// the stop is stated in the last line; capped=true.
func TestFsSearchStopsAtTheOutputCapAndSaysSo(t *testing.T) {
	d := testDeps(t)
	line := "NEEDLE " + strings.Repeat("z", 200)
	tree(t, d.Home, map[string]string{"big.txt": strings.Repeat(line+"\n", SearchMaxMatches)})

	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE", "max_matches": float64(SearchMaxMatches)}, d)
	if len(out.Output) > OutputCap {
		t.Errorf("output is %d bytes, over OutputCap %d", len(out.Output), OutputCap)
	}
	if !metaCapped(t, out) {
		t.Error("meta.capped must be true when the output cap stopped the search")
	}
	got := hits(out)
	if len(got) == 0 || len(got) >= SearchMaxMatches {
		t.Fatalf("output cap: %d hit lines", len(got))
	}
	whole := regexp.MustCompile(`^big\.txt:\d+: ` + regexp.QuoteMeta(line) + `$`)
	for _, h := range got {
		if !whole.MatchString(h) {
			t.Fatalf("a cut line was output: %q", h)
		}
	}
	if n := asInt(t, out.Meta["matches"], "matches"); n != int64(len(got)) {
		t.Errorf("meta.matches = %d, but %d lines were output", n, len(got))
	}
	lines := strings.Split(strings.TrimRight(out.Output, "\n"), "\n")
	if last := lines[len(lines)-1]; !strings.HasPrefix(last, "[stopped") || !strings.Contains(last, "output cap") {
		t.Errorf("reaching the output cap must be stated in the last line; got %q", last)
	}
}

func TestFsSearchNoMatchIsOkAndStated(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"a.txt": "hay\n"})
	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if len(hits(out)) != 0 || !strings.Contains(out.Output, "no matches") {
		t.Errorf("no match: output %q, want a stated \"no matches\" note", out.Output)
	}
	if asInt(t, out.Meta["matches"], "matches") != 0 || metaCapped(t, out) {
		t.Errorf("no match: meta %v", out.Meta)
	}
	if asInt(t, out.Meta["files_scanned"], "files_scanned") != 1 {
		t.Errorf("no match: files_scanned %v, want 1", out.Meta["files_scanned"])
	}
}

// C4: bad calls are stated refusals with empty output and no meta.
func TestFsSearchBadCallsAreStatedRefusals(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"a.txt": "x\n"})
	file := filepath.Join(d.Home, "a.txt")
	for _, c := range []struct {
		name string
		args map[string]any
		says string
	}{
		{"no path", map[string]any{"pattern": "x"}, "path"},
		{"no pattern", map[string]any{"path": d.Home}, "pattern"},
		{"empty pattern", map[string]any{"path": d.Home, "pattern": ""}, "pattern"},
		{"bad regex", map[string]any{"path": d.Home, "pattern": "("}, "pattern"},
		{"a file", map[string]any{"path": file, "pattern": "x"}, "not a directory"},
		{"missing", map[string]any{"path": filepath.Join(d.Home, "nope"), "pattern": "x"}, "could not search"},
		{"literal not bool", map[string]any{"path": d.Home, "pattern": "x", "literal": "yes"}, "literal"},
		{"ignore_case not bool", map[string]any{"path": d.Home, "pattern": "x", "ignore_case": float64(1)}, "ignore_case"},
		{"max 0", map[string]any{"path": d.Home, "pattern": "x", "max_matches": float64(0)}, "max_matches"},
		{"max negative", map[string]any{"path": d.Home, "pattern": "x", "max_matches": float64(-1)}, "max_matches"},
		{"max fraction", map[string]any{"path": d.Home, "pattern": "x", "max_matches": 1.5}, "max_matches"},
		{"max string", map[string]any{"path": d.Home, "pattern": "x", "max_matches": "10"}, "max_matches"},
	} {
		out := search(c.args, d)
		if out.OK || out.Output != "" || out.Meta != nil || !strings.Contains(out.Error, c.says) {
			t.Errorf("%s: ok=%v output=%q meta=%v err=%q, want a refusal naming %q",
				c.name, out.OK, out.Output, out.Meta, out.Error, c.says)
		}
	}
}

// A search the command's deadline stops is a stated refusal, not a partial
// answer passed off as the whole.
func TestFsSearchAStoppedContextIsStated(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"a.txt": "NEEDLE\n"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out := Dispatch(ctx, "fs.search", map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if out.OK || !strings.Contains(out.Error, "stopped") {
		t.Errorf("a cancelled search: ok=%v err=%q, want a refusal saying it stopped", out.OK, out.Error)
	}
}

// COVERAGE (T6 C1): the order is the walk's — entries by name, depth first,
// lines ascending — not a sort of the output: dir "a" comes before file
// "a.txt" (a byte sort of relpaths would put "a.txt" first, '.' < '/').
func TestFsSearchWalksEntriesByNameDepthFirst(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{
		"b.txt":     "NEEDLE\n",
		"a.txt":     "NEEDLE\n",
		"a/z.txt":   "NEEDLE 1\nhay\nNEEDLE 3\n",
		"a/y/x.txt": "NEEDLE\n",
		"b/c/d.txt": "NEEDLE\n",
	})
	want := []string{
		"a/y/x.txt:1: NEEDLE",
		"a/z.txt:1: NEEDLE 1",
		"a/z.txt:3: NEEDLE 3",
		"a.txt:1: NEEDLE",
		"b/c/d.txt:1: NEEDLE",
		"b.txt:1: NEEDLE",
	}
	first := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if got := hits(first); !reflect.DeepEqual(got, want) {
		t.Fatalf("hits = %q, want walk order %q", got, want)
	}
	for i := 0; i < 3; i++ {
		again := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
		if again.Output != first.Output {
			t.Fatalf("run %d answered differently:\n%q\n%q", i+2, first.Output, again.Output)
		}
	}
}

// COVERAGE (T6 C1): a line longer than SearchLineCap but inside the read
// buffer (the in-place path, not the streamed one) is cut at the cap with
// the marker; a line of exactly SearchLineCap bytes is whole; a cut never
// splits a rune.
func TestFsSearchCutsALineOverTheLineCapThatFitsTheBuffer(t *testing.T) {
	d := testDeps(t)
	exact := "NEEDLE" + strings.Repeat("e", SearchLineCap-len("NEEDLE"))
	over := "NEEDLE" + strings.Repeat("o", 1000)
	// "é" is 2 bytes; placed so its first byte is the cap's last byte.
	runey := "NEEDLE" + strings.Repeat("r", SearchLineCap-len("NEEDLE")-1) + "é" + strings.Repeat("r", 100)
	tree(t, d.Home, map[string]string{"a.txt": exact + "\n" + over + "\n" + runey + "\n"})
	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	got := hits(out)
	if len(got) != 3 {
		t.Fatalf("want 3 hits, got %d", len(got))
	}
	if got[0] != "a.txt:1: "+exact {
		t.Errorf("a line of exactly SearchLineCap bytes must be whole; got %d bytes of text", len(got[0])-len("a.txt:1: "))
	}
	if got[1] != "a.txt:2: "+over[:SearchLineCap]+searchTruncMark {
		t.Errorf("a %d-byte line must be cut at SearchLineCap + %q; got %d bytes", len(over), searchTruncMark, len(got[1]))
	}
	text := strings.TrimPrefix(got[2], "a.txt:3: ")
	if !strings.HasSuffix(text, searchTruncMark) || !utf8.ValidString(strings.TrimSuffix(text, searchTruncMark)) {
		t.Errorf("a cut through a rune must back off to its start; got %q", text[len(text)-20:])
	}
	if body := strings.TrimSuffix(text, searchTruncMark); len(body) > SearchLineCap {
		t.Errorf("cut text is %d bytes, over SearchLineCap", len(body))
	}
}

// COVERAGE (T6 C2): every .gitignore from the repository root DOWN to the
// search path applies, the repository root is found by a .git FILE too (a
// worktree), a nested negation re-includes in the walk, and .git is skipped
// where no .gitignore exists at all.
func TestFsSearchReadsEveryGitignoreFromTheRepoRootDownToThePath(t *testing.T) {
	d := testDeps(t)
	repo := filepath.Join(d.Home, "wt")
	tree(t, repo, map[string]string{
		".git":                "gitdir: /elsewhere/.git/worktrees/wt\n", // a worktree's .git is a file
		".gitignore":          "*.tmp\n",
		"mid/.gitignore":      "*.log\n!keep.tmp\n",
		"mid/sub/a.txt":       "NEEDLE\n",
		"mid/sub/a.log":       "NEEDLE\n",
		"mid/sub/b.tmp":       "NEEDLE\n",
		"mid/sub/keep.tmp":    "NEEDLE\n",
		"mid/sub/deep/.git":   "NEEDLE\n",
		"mid/sub/deep/ok.txt": "NEEDLE\n",
	})
	out := mustSearch(t, map[string]any{"path": filepath.Join(repo, "mid", "sub"), "pattern": "NEEDLE"}, d)
	want := []string{"a.txt:1: NEEDLE", "deep/ok.txt:1: NEEDLE", "keep.tmp:1: NEEDLE"}
	if got := hits(out); !reflect.DeepEqual(got, want) {
		t.Errorf("searching wt/mid/sub: hits = %q, want %q (wt/.gitignore and wt/mid/.gitignore both apply; .git skipped)", got, want)
	}

	plain := filepath.Join(d.Home, "plain")
	tree(t, plain, map[string]string{
		"x/.git/HEAD": "NEEDLE\n",
		"x/a.txt":     "NEEDLE\n",
	})
	out = mustSearch(t, map[string]any{"path": plain, "pattern": "NEEDLE"}, d)
	if got := hits(out); !reflect.DeepEqual(got, []string{"x/a.txt:1: NEEDLE"}) {
		t.Errorf("no .gitignore anywhere: hits = %q, want only x/a.txt (.git is always skipped)", got)
	}
	if n := asInt(t, out.Meta["files_scanned"], "files_scanned"); n != 1 {
		t.Errorf("files_scanned = %d, want 1 (.git contents are not scanned)", n)
	}
}

// COVERAGE (T6 C2): binary means a NUL in the first binarySniff bytes —
// the last sniffed byte counts, the first unsniffed one does not.
func TestFsSearchBinarySniffIsTheFirst8KiB(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{
		"in.dat":  strings.Repeat("y", binarySniff-1) + "\x00\nNEEDLE\n",
		"out.dat": strings.Repeat("y", binarySniff) + "\x00\nNEEDLE\n",
	})
	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if got := hitFiles(out); !reflect.DeepEqual(got, []string{"out.dat"}) {
		t.Errorf("files with hits = %q, want only out.dat (in.dat's NUL is byte %d, inside the sniff)", got, binarySniff)
	}
	if n := asInt(t, out.Meta["files_scanned"], "files_scanned"); n != 1 {
		t.Errorf("files_scanned = %d, want 1 (a binary is not counted)", n)
	}
}

// COVERAGE (T6 C3): max_matches counts across files; reaching it exactly
// with no further match anywhere is not capped and the walk still scans
// every file; a match in a LATER file past the cap makes it capped.
func TestFsSearchMaxMatchesCountsAcrossFiles(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"a.txt": needles(2), "b.txt": "hay\n", "c.txt": "hay\n"})
	exact := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE", "max_matches": float64(2)}, d)
	if metaCapped(t, exact) || strings.Contains(exact.Output, "[stopped") {
		t.Errorf("2 matches at max_matches 2 is not capped: %q", exact.Output)
	}
	if n := asInt(t, exact.Meta["files_scanned"], "files_scanned"); n != 3 {
		t.Errorf("files_scanned = %d, want 3 (reaching max_matches with no match past it does not stop the walk)", n)
	}

	tree(t, d.Home, map[string]string{"c.txt": "NEEDLE late\n"})
	capped := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE", "max_matches": float64(2)}, d)
	if !metaCapped(t, capped) || len(hits(capped)) != 2 {
		t.Errorf("a third match in a later file: capped=%v hits=%q", capped.Meta["capped"], hits(capped))
	}
	lines := strings.Split(strings.TrimRight(capped.Output, "\n"), "\n")
	if last := lines[len(lines)-1]; !strings.HasPrefix(last, "[stopped") || !strings.Contains(last, "max_matches") {
		t.Errorf("last line %q must state max_matches", last)
	}
}

// laterCancel is a context whose Err turns non-nil after its first n calls:
// the walk starts, and the stop lands mid-file.
type laterCancel struct {
	context.Context
	n int
}

func (c *laterCancel) Err() error {
	if c.n > 0 {
		c.n--
		return nil
	}
	return context.Canceled
}

// COVERAGE (T6 C4): a deadline landing in the middle of a long file stops
// the search there and is a refusal (empty output, nil meta), never partial
// results passed off as the whole.
func TestFsSearchAStopMidFileIsStatedNotPartial(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"big.txt": strings.Repeat("hay\n", 10000) + "NEEDLE\n"})
	ctx := &laterCancel{Context: context.Background(), n: 1} // the walk's per-entry check passes
	out := Dispatch(ctx, "fs.search", map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if out.OK || !strings.Contains(out.Error, "stopped") || out.Output != "" || out.Meta != nil {
		t.Errorf("stopped mid-file: ok=%v err=%q output %d bytes meta=%v, want a refusal saying it stopped",
			out.OK, out.Error, len(out.Output), out.Meta)
	}
}
