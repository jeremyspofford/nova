package caps

import (
	"path"
	"strings"
)

// ignoreRules is the .gitignore matcher fs.search walks with (S30a T6). Every
// path it is given is relative to the walk's base (the repository root when
// one is found above the search path, else the search path), with forward
// slashes on every OS.
//
// In scope: root and nested files, `!` negation (the last matching rule
// wins), a trailing `/` (directories only), `**` (leading, trailing, middle),
// `*`/`?`/`[...]` as path.Match gives them (never crossing a `/`), comments,
// blank lines, a `\#` / `\!` escape and trailing-space trimming. Out of scope,
// stated: core.excludesFile, .git/info/exclude and core.ignorecase — matching
// is case-sensitive on every OS.
type ignoreRules struct {
	rules []ignoreRule
}

// ignoreRule is one pattern line, scoped to the directory of its file.
type ignoreRule struct {
	dir      string   // slash dir of the .gitignore, relative to the base ("" = base)
	segs     []string // the pattern split on "/"
	anchored bool     // a slash at the start or in the middle: match from dir, not at any depth
	negate   bool     // `!`: re-include
	dirOnly  bool     // a trailing `/`: directories only
}

func newIgnoreRules() *ignoreRules { return &ignoreRules{} }

// add loads one .gitignore's content; dir is the slash path of the directory
// holding it, relative to the base ("" for the base itself). Files are added
// shallowest first; a later rule beats an earlier one.
func (r *ignoreRules) add(dir, content string) {
	dir = strings.Trim(dir, "/")
	for _, line := range strings.Split(content, "\n") {
		if rule, ok := parseIgnoreLine(dir, line); ok {
			r.rules = append(r.rules, rule)
		}
	}
}

func parseIgnoreLine(dir, line string) (ignoreRule, bool) {
	line = strings.TrimSuffix(line, "\r")
	// Trailing spaces are trimmed unless the last one is escaped (`\ `).
	for strings.HasSuffix(line, " ") && !strings.HasSuffix(line, `\ `) {
		line = line[:len(line)-1]
	}
	if line == "" || strings.HasPrefix(line, "#") {
		return ignoreRule{}, false
	}
	rule := ignoreRule{dir: dir}
	if strings.HasPrefix(line, "!") {
		rule.negate = true
		line = line[1:]
	} else if strings.HasPrefix(line, `\#`) || strings.HasPrefix(line, `\!`) {
		line = line[1:]
	}
	if strings.HasSuffix(line, "/") {
		rule.dirOnly = true
		line = strings.TrimRight(line, "/")
	}
	if line == "" {
		return ignoreRule{}, false
	}
	if strings.Contains(line, "/") {
		rule.anchored = true
		line = strings.TrimPrefix(line, "/")
	}
	if line == "" {
		return ignoreRule{}, false
	}
	rule.segs = strings.Split(line, "/")
	return rule, true
}

// Match reports whether rel (relative to the base, forward slashes) is
// ignored. isDir says whether rel names a directory (dir-only patterns, a
// trailing "/", match only directories). A path inside an ignored directory
// is ignored whatever later rules say, as in git.
func (r *ignoreRules) Match(rel string, isDir bool) bool {
	rel = strings.Trim(rel, "/")
	for i := 0; i < len(rel); i++ {
		if rel[i] == '/' && r.matchSelf(rel[:i], true) {
			return true
		}
	}
	return r.matchSelf(rel, isDir)
}

// matchSelf judges rel by the rules alone, without asking whether a parent
// directory is ignored. The walk uses it: it never descends into an ignored
// directory, and it must not judge the directories at or above the search
// path, which was asked for by name.
func (r *ignoreRules) matchSelf(rel string, isDir bool) bool {
	ignored := false
	for i := range r.rules {
		rule := &r.rules[i]
		if rule.negate == ignored && rule.matches(rel, isDir) {
			ignored = !rule.negate
		}
	}
	return ignored
}

func (rule *ignoreRule) matches(rel string, isDir bool) bool {
	if rule.dirOnly && !isDir {
		return false
	}
	sub := rel
	if rule.dir != "" {
		if !strings.HasPrefix(rel, rule.dir+"/") {
			return false
		}
		sub = rel[len(rule.dir)+1:]
	}
	parts := strings.Split(sub, "/")
	if !rule.anchored {
		// No slash in the pattern: it matches the name at any depth.
		return matchSegs(rule.segs, parts[len(parts)-1:])
	}
	return matchSegs(rule.segs, parts)
}

// matchSegs matches pattern segments against path segments. A `**` segment
// matches zero or more directories, except a trailing one, which matches one
// or more (`gen/**` is everything inside gen, not gen itself).
func matchSegs(pat, parts []string) bool {
	for len(pat) > 0 {
		if pat[0] == "**" {
			if len(pat) == 1 {
				return len(parts) > 0
			}
			for skip := 0; skip <= len(parts); skip++ {
				if matchSegs(pat[1:], parts[skip:]) {
					return true
				}
			}
			return false
		}
		if len(parts) == 0 {
			return false
		}
		if ok, err := path.Match(pat[0], parts[0]); err != nil || !ok {
			return false
		}
		pat, parts = pat[1:], parts[1:]
	}
	return len(parts) == 0
}
