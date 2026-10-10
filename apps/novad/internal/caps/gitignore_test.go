package caps

import "testing"

// S30a T6: the .gitignore matcher fs.search walks with. In scope (the T6
// line): root and nested .gitignore files, `!` negation, a trailing `/`
// (directories only), `**`, comments and blank lines (plus a `\#` escape and
// trailing-space trimming, which every real .gitignore relies on). Out of
// scope, stated: core.excludesFile (global excludes) and .git/info/exclude;
// `[...]` classes beyond what path.Match gives; core.ignorecase — matching is
// case-sensitive on every OS.

type ignoreCase struct {
	rel   string
	isDir bool
	want  bool
}

// rules builds a matcher from .gitignore files keyed by the slash directory
// that holds them ("" = the base), added shallowest first.
func rules(files ...[2]string) *ignoreRules {
	r := newIgnoreRules()
	for _, f := range files {
		r.add(f[0], f[1])
	}
	return r
}

func checkIgnore(t *testing.T, r *ignoreRules, cases []ignoreCase) {
	t.Helper()
	for _, c := range cases {
		if got := r.Match(c.rel, c.isDir); got != c.want {
			t.Errorf("Match(%q, isDir=%v) = %v, want %v", c.rel, c.isDir, got, c.want)
		}
	}
}

func TestGitignoreCommentsAndBlankLinesAreNotPatterns(t *testing.T) {
	r := rules([2]string{"", "# a comment naming keep.txt\n\n   \n*.o\n\\#hash.txt\nspaced.txt   \n"})
	checkIgnore(t, r, []ignoreCase{
		{"a.o", false, true},
		{"# a comment naming keep.txt", false, false}, // only a pattern if the comment were read as one
		{"#hash.txt", false, true},                    // `\#` is a literal leading hash
		{"spaced.txt", false, true},                   // trailing spaces are trimmed
		{"a.c", false, false},
	})
}

func TestGitignoreAPatternWithoutASlashMatchesAtAnyDepth(t *testing.T) {
	r := rules([2]string{"", "*.o\nnode_modules\n"})
	checkIgnore(t, r, []ignoreCase{
		{"a.o", false, true},
		{"x/y/z.o", false, true},
		{"node_modules", true, true},
		{"web/node_modules", true, true},
		{"web/node_modules/pkg/index.js", false, true}, // inside an ignored dir
		{"a.oo", false, false},
		{"o", false, false},
	})
}

func TestGitignoreASlashAnchorsThePatternToItsFile(t *testing.T) {
	r := rules([2]string{"", "/top.txt\ndoc/frotz\na/*.c\n"})
	checkIgnore(t, r, []ignoreCase{
		{"top.txt", false, true},
		{"x/top.txt", false, false}, // leading slash: only beside the .gitignore
		{"doc/frotz", false, true},
		{"a/doc/frotz", false, false}, // a middle slash anchors too
		{"a/x.c", false, true},
		{"a/b/x.c", false, false}, // `*` never crosses a slash
	})
}

func TestGitignoreATrailingSlashMatchesOnlyDirectories(t *testing.T) {
	r := rules([2]string{"", "build/\n"})
	checkIgnore(t, r, []ignoreCase{
		{"build", true, true},
		{"src/build", true, true},
		{"build", false, false}, // a FILE named build is not ignored
		{"src/build", false, false},
		{"build/out.txt", false, true}, // inside the ignored directory
		{"build/deep/out.txt", false, true},
	})
}

func TestGitignoreDoubleStarMatchesAnyNumberOfDirectories(t *testing.T) {
	r := rules([2]string{"", "**/logs\ngen/**\ndocs/**/draft.md\n"})
	checkIgnore(t, r, []ignoreCase{
		{"logs", true, true},
		{"a/b/logs", true, true},
		{"gen/x.txt", false, true},
		{"gen/a/b/x.txt", false, true},
		{"gen", true, false},           // `gen/**` is everything INSIDE gen, not gen
		{"docs/draft.md", false, true}, // zero directories
		{"docs/a/draft.md", false, true},
		{"docs/a/b/c/draft.md", false, true},
		{"docs/adraft.md", false, false},
		{"xdocs/draft.md", false, false},
	})
}

func TestGitignoreNegationReincludesAndTheLastRuleWins(t *testing.T) {
	r := rules([2]string{"", "*.log\n!keep.log\n"})
	checkIgnore(t, r, []ignoreCase{
		{"x.log", false, true},
		{"keep.log", false, false},
		{"a/keep.log", false, false},
	})
	// Order matters: the later rule wins.
	r = rules([2]string{"", "!keep.log\n*.log\n"})
	checkIgnore(t, r, []ignoreCase{{"keep.log", false, true}})
	// git cannot re-include a file whose parent directory is excluded.
	r = rules([2]string{"", "build/\n!build/keep.txt\n"})
	checkIgnore(t, r, []ignoreCase{{"build/keep.txt", false, true}})
}

func TestGitignoreANestedFileAppliesBelowItsDirectoryAndWinsThere(t *testing.T) {
	r := rules(
		[2]string{"", "*.gen\n"},
		[2]string{"sub", "!x.gen\n*.tmp\n/only.txt\n"},
	)
	checkIgnore(t, r, []ignoreCase{
		{"x.gen", false, true},      // root rule, outside sub
		{"sub/x.gen", false, false}, // the nested negation beats the root rule
		{"sub/y.gen", false, true},  // root rule still applies in sub
		{"a.tmp", false, false},     // a nested rule never reaches above its dir
		{"sub/a.tmp", false, true},  //
		{"sub/deep/a.tmp", false, true},
		{"sub/only.txt", false, true}, // anchored to sub/, not the base
		{"sub/d/only.txt", false, false},
		{"only.txt", false, false},
	})
}

func TestGitignoreIsCaseSensitive(t *testing.T) {
	r := rules([2]string{"", "*.LOG\nREADME\n"})
	checkIgnore(t, r, []ignoreCase{
		{"a.LOG", false, true},
		{"README", false, true},
		{"a.log", false, false},
		{"readme", false, false},
	})
}

// COVERAGE (T6 C2): a CRLF .gitignore (Windows checkouts) reads the same as
// LF, a `\!` escape is a literal leading "!", and `?` is one character not
// crossing a slash.
func TestGitignoreCRLFLinesAndEscapes(t *testing.T) {
	r := rules([2]string{"", "*.o\r\n\\!bang.txt\r\nfile?.c\r\n"})
	checkIgnore(t, r, []ignoreCase{
		{"a.o", false, true},
		{"!bang.txt", false, true},
		{"bang.txt", false, false}, // `\!` is not a negation of anything
		{"file1.c", false, true},
		{"file12.c", false, false},
	})
}
