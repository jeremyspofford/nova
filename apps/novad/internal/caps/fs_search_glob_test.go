package caps

import (
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// S38c T2: fs.search's default cap is 50, a `glob` arg picks the files
// searched before any is opened, and past the cap the walk keeps counting
// (no output) so meta.total_matches says how many it left out.

func sortedHitFiles(out Outcome) []string {
	got := append([]string(nil), hitFiles(out)...)
	sort.Strings(got)
	return got
}

func lastLine(out Outcome) string {
	lines := strings.Split(strings.TrimRight(out.Output, "\n"), "\n")
	return lines[len(lines)-1]
}

func metaBool(t *testing.T, out Outcome, key string) bool {
	t.Helper()
	b, ok := out.Meta[key].(bool)
	if !ok {
		t.Fatalf("meta.%s is %T (%v), want a bool", key, out.Meta[key], out.Meta[key])
	}
	return b
}

// C1: the default cap is 50.
func TestFsSearchDefaultMatchesIs50(t *testing.T) {
	if SearchDefaultMatches != 50 {
		t.Fatalf("SearchDefaultMatches = %d, want 50 (S38c §12 Q7)", SearchDefaultMatches)
	}
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"many.txt": needles(120)})
	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if n := len(hits(out)); n != 50 || !metaCapped(t, out) {
		t.Errorf("an omitted max_matches output %d hits (capped=%v), want 50 and capped", n, out.Meta["capped"])
	}
}

// globTree is a tree where every file holds NEEDLE once.
func globTree(t *testing.T, root string) {
	tree(t, root, map[string]string{
		".gitignore":             "services/b/gone.py\n",
		"top.py":                 "NEEDLE\n",
		"main.go":                "NEEDLE\n",
		"main.go.txt":            "NEEDLE\n",
		"services/x.py":          "NEEDLE\n",
		"services/a/x.py":        "NEEDLE\n",
		"services/b/c/y.py":      "NEEDLE\n",
		"services/b/gone.py":     "NEEDLE\n", // .gitignored: never searched
		"services/z.go":          "NEEDLE\n",
		"services/a/notes.pyc":   "NEEDLE\n",
		"other/services/q.py":    "NEEDLE\n",
		"cmd/tool/main.go":       "NEEDLE\n",
		"cmd/tool/main_test.go":  "NEEDLE\n",
		"cmd/tool/data/one.json": "NEEDLE\n",
	})
}

// C2: `glob` with a `/` matches the whole relpath from the search root, `**`
// spanning directories; without a `/` it matches the base name at any depth;
// `*` and `?` never cross a `/`. Files it leaves out are not opened, so they
// are not counted in files_scanned. A .gitignored file stays out.
func TestFsSearchGlobSelectsTheFilesSearched(t *testing.T) {
	d := testDeps(t)
	globTree(t, d.Home)
	for _, c := range []struct {
		glob string
		want []string
	}{
		{"services/**/*.py", []string{"services/a/x.py", "services/b/c/y.py", "services/x.py"}},
		{"*.go", []string{"cmd/tool/main.go", "cmd/tool/main_test.go", "main.go", "services/z.go"}},
		{"services/*.py", []string{"services/x.py"}},
		{"*.p?", []string{"other/services/q.py", "services/a/x.py", "services/b/c/y.py", "services/x.py", "top.py"}},
		{"cmd/**", []string{"cmd/tool/data/one.json", "cmd/tool/main.go", "cmd/tool/main_test.go"}},
		{"**/services/*.py", []string{"other/services/q.py", "services/x.py"}},
		{"main_test.go", []string{"cmd/tool/main_test.go"}},
		{"*.rs", nil},
	} {
		out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE", "glob": c.glob}, d)
		if got := sortedHitFiles(out); !reflect.DeepEqual(got, c.want) {
			t.Errorf("glob %q: files with hits = %q, want exactly %q", c.glob, got, c.want)
		}
		if n := asInt(t, out.Meta["files_scanned"], "files_scanned"); n != int64(len(c.want)) {
			t.Errorf("glob %q: files_scanned = %d, want %d (a file outside the glob is never opened)", c.glob, n, len(c.want))
		}
	}
}

// C3: meta.glob echoes the glob the search applied (core proves agent
// support from this echo, never from ok); absent when none was given.
func TestFsSearchEchoesTheGlobInMeta(t *testing.T) {
	d := testDeps(t)
	globTree(t, d.Home)
	with := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE", "glob": "*.go"}, d)
	if g, ok := with.Meta["glob"].(string); !ok || g != "*.go" {
		t.Errorf("meta.glob = %#v, want %q echoed", with.Meta["glob"], "*.go")
	}
	without := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if g, present := without.Meta["glob"]; present {
		t.Errorf("meta.glob = %#v on a search with no glob, want it absent", g)
	}
}

// C4: past the cap the walk keeps counting, across files, with no output:
// 412 seeded hits at the default cap answer 50 lines, total_matches 412,
// total_complete true, and the closing note names the total.
func TestFsSearchCountsEveryMatchPastTheCap(t *testing.T) {
	d := testDeps(t)
	files := map[string]string{}
	for i := 0; i < 4; i++ {
		files[fmt.Sprintf("f%d.txt", i)] = needles(100)
	}
	files["sub/last.txt"] = needles(12)
	tree(t, d.Home, files)

	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if n := len(hits(out)); n != 50 {
		t.Fatalf("hits = %d, want 50", n)
	}
	if n := asInt(t, out.Meta["matches"], "matches"); n != 50 {
		t.Errorf("meta.matches = %d, want 50 (what was output)", n)
	}
	if n := asInt(t, out.Meta["total_matches"], "total_matches"); n != 412 {
		t.Errorf("meta.total_matches = %d, want 412 (every matching line in the tree)", n)
	}
	if !metaBool(t, out, "total_complete") {
		t.Error("meta.total_complete = false on a walk that finished")
	}
	if !metaCapped(t, out) {
		t.Error("meta.capped = false on a capped search")
	}
	if n := asInt(t, out.Meta["files_scanned"], "files_scanned"); n != 5 {
		t.Errorf("files_scanned = %d, want 5 (the count walk scans every file)", n)
	}
	if last := lastLine(out); !strings.HasPrefix(last, "[stopped") || !strings.Contains(last, "max_matches") || !strings.Contains(last, "412") {
		t.Errorf("closing note %q must state the cap and the 412 in all", last)
	}

	// Uncapped: total is the matches output, complete.
	few := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE", "glob": "last.txt"}, d)
	if asInt(t, few.Meta["total_matches"], "total_matches") != 12 || !metaBool(t, few, "total_complete") || metaCapped(t, few) {
		t.Errorf("uncapped: meta %v, want total_matches 12, total_complete true, capped false", few.Meta)
	}
}

// C4: the output cap stops the output, not the count — the count walk goes
// on into later files.
func TestFsSearchCountsPastTheOutputCap(t *testing.T) {
	d := testDeps(t)
	line := "NEEDLE " + strings.Repeat("z", 200)
	tree(t, d.Home, map[string]string{
		"big.txt": strings.Repeat(line+"\n", SearchMaxMatches-100),
		"z.txt":   needles(100),
	})
	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE", "max_matches": float64(SearchMaxMatches)}, d)
	if n := len(hits(out)); n == 0 || n >= SearchMaxMatches {
		t.Fatalf("output cap: %d hit lines", n)
	}
	if n := asInt(t, out.Meta["total_matches"], "total_matches"); n != SearchMaxMatches {
		t.Errorf("total_matches = %d, want %d (the output cap does not cut the count; z.txt is counted)", n, SearchMaxMatches)
	}
	if !metaBool(t, out, "total_complete") {
		t.Error("total_complete = false, but the walk finished")
	}
	if last := lastLine(out); !strings.Contains(last, "output cap") || !strings.Contains(last, strconv.Itoa(SearchMaxMatches)) {
		t.Errorf("closing note %q must state the output cap and the total", last)
	}
}

// C5: a count cut short (here by its own budget) is still an answer: ok,
// the 50 lines, total_complete false and total_matches a lower bound.
func TestFsSearchACutCountIsALowerBound(t *testing.T) {
	d := testDeps(t)
	files := map[string]string{}
	for i := 0; i < 412; i++ {
		files[fmt.Sprintf("f%03d.txt", i)] = "NEEDLE\n"
	}
	tree(t, d.Home, files)
	old := searchCountBudget
	searchCountBudget = 0
	t.Cleanup(func() { searchCountBudget = old })

	out := mustSearch(t, map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if n := len(hits(out)); n != 50 {
		t.Fatalf("hits = %d, want 50", n)
	}
	if metaBool(t, out, "total_complete") {
		t.Error("total_complete = true on a count its budget cut")
	}
	total := asInt(t, out.Meta["total_matches"], "total_matches")
	if total < 51 || total >= 412 {
		t.Errorf("total_matches = %d, want a lower bound in [51, 412)", total)
	}
	if last := lastLine(out); !strings.Contains(last, "at least "+strconv.FormatInt(total, 10)) {
		t.Errorf("closing note %q must say \"at least %d\"", last, total)
	}
}

// C5: the command's deadline landing in the count walk (after the cap) is a
// lower bound too, not a refusal: the 50 lines were already found.
func TestFsSearchADeadlineInTheCountWalkIsALowerBound(t *testing.T) {
	d := testDeps(t)
	files := map[string]string{"a.txt": needles(60)}
	for i := 0; i < 20; i++ {
		files[fmt.Sprintf("z%02d.txt", i)] = "NEEDLE\n"
	}
	tree(t, d.Home, files)
	// The walk checks the context once per entry: entry a.txt passes (the
	// cap is reached inside it), the next check stops the count walk.
	ctx := &laterCancel{Context: t.Context(), n: 1}
	out := Dispatch(ctx, "fs.search", map[string]any{"path": d.Home, "pattern": "NEEDLE"}, d)
	if !out.OK {
		t.Fatalf("a deadline after the cap: refused %q, want the 50 lines with a lower-bound total", out.Error)
	}
	if n := len(hits(out)); n != 50 {
		t.Errorf("hits = %d, want 50", n)
	}
	if metaBool(t, out, "total_complete") {
		t.Error("total_complete = true on a count the deadline cut")
	}
	if n := asInt(t, out.Meta["total_matches"], "total_matches"); n != 60 {
		t.Errorf("total_matches = %d, want 60 (a.txt counted whole, nothing after)", n)
	}
}

// C6: a bad glob is a stated refusal naming 'glob' — empty output, no meta,
// nothing searched.
func TestFsSearchABadGlobIsAStatedRefusal(t *testing.T) {
	d := testDeps(t)
	tree(t, d.Home, map[string]string{"a.txt": "NEEDLE\n"})
	for _, g := range []any{"[", "a/[b/*.go", "", "a//b", "/a.go", "a/", float64(5), true, []any{"*.go"}} {
		out := search(map[string]any{"path": d.Home, "pattern": "NEEDLE", "glob": g}, d)
		if out.OK || out.Output != "" || out.Meta != nil || !strings.Contains(out.Error, "glob") {
			t.Errorf("glob %#v: ok=%v output=%q meta=%v err=%q, want a refusal naming 'glob'",
				g, out.OK, out.Output, out.Meta, out.Error)
		}
	}
}
