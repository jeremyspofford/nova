package box

import (
	"bytes"
	"context"
	"fmt"
	"path"
	"slices"
	"strings"

	"github.com/BurntSushi/toml"
)

// SuitesPath is where main's suite list lives (spec §5.2). It is read from
// the branch's commit through git, never from the worktree (D6): a change
// cannot make its own full suite "light" to dodge the lock.
const SuitesPath = "deploy/devbox/suites.toml"

// Suite is one [[suite]] of suites.toml: the commands that run the whole
// suite from Dir (repo-relative, "." for the root), and the paths that
// select it on a landing (S32.3).
type Suite struct {
	Name     string     `toml:"name"`
	Dir      string     `toml:"dir"`
	Commands [][]string `toml:"commands"`
	Paths    []string   `toml:"paths"`
}

// Suites is the whole file: the suites, and the protected list S32.3 flags.
type Suites struct {
	Suite     []Suite  `toml:"suite"`
	Protected []string `toml:"protected"`
}

// ParseSuites reads suites.toml strictly: an unknown key, a suite without a
// name, dir or command, an empty word, or a dir that is absolute, unclean or
// escapes the repo is refused — each would misjudge what is heavy. A file
// with no suites is refused too: it would make nothing heavy, silently.
func ParseSuites(data []byte) (Suites, error) {
	var s Suites
	md, err := toml.NewDecoder(bytes.NewReader(data)).Decode(&s)
	if err != nil {
		return Suites{}, fmt.Errorf("suites.toml does not parse: %v", err)
	}
	if extra := md.Undecoded(); len(extra) > 0 {
		keys := make([]string, len(extra))
		for i, k := range extra {
			keys[i] = k.String()
		}
		return Suites{}, fmt.Errorf("suites.toml has keys nothing reads: %s", strings.Join(keys, ", "))
	}
	if len(s.Suite) == 0 {
		return Suites{}, fmt.Errorf("suites.toml lists no suites")
	}
	for i, su := range s.Suite {
		if su.Name == "" {
			return Suites{}, fmt.Errorf("suites.toml suite %d has no name", i+1)
		}
		if su.Dir == "" {
			return Suites{}, fmt.Errorf("suites.toml suite %s has no dir", su.Name)
		}
		if path.IsAbs(su.Dir) || path.Clean(su.Dir) != su.Dir || su.Dir == ".." || strings.HasPrefix(su.Dir, "../") {
			return Suites{}, fmt.Errorf("suites.toml suite %s: dir %q is not a clean path inside the repo", su.Name, su.Dir)
		}
		if len(su.Commands) == 0 {
			return Suites{}, fmt.Errorf("suites.toml suite %s has no commands", su.Name)
		}
		for _, c := range su.Commands {
			if len(c) == 0 {
				return Suites{}, fmt.Errorf("suites.toml suite %s has an empty command", su.Name)
			}
			if slices.Contains(c, "") {
				return Suites{}, fmt.Errorf("suites.toml suite %s: command %q has an empty word", su.Name, c)
			}
		}
	}
	return s, nil
}

// LoadSuites reads <branch>'s committed suites.toml through the Git seam.
func (m *Manager) LoadSuites(ctx context.Context, checkout, branch string) (Suites, error) {
	out, code, err := m.Git.Run(ctx, []string{"-C", checkout, "show", branch + ":" + SuitesPath})
	if err != nil {
		return Suites{}, fmt.Errorf("reading %s's %s: could not run git: %v", branch, SuitesPath, err)
	}
	if code != 0 {
		return Suites{}, fmt.Errorf("reading %s's %s: git said (exit %d): %s", branch, SuitesPath, code, strings.TrimSpace(out))
	}
	s, err := ParseSuites([]byte(out))
	if err != nil {
		return Suites{}, fmt.Errorf("reading %s's %s: %v", branch, SuitesPath, err)
	}
	return s, nil
}

// Heavy is true when argv, run from cwdRel (repo-relative), is exactly one
// of a suite's commands in that suite's dir — a whole suite. A selector, an
// extra flag or another dir makes it a targeted run (spec §4.5, D6).
func Heavy(s Suites, argv []string, cwdRel string) bool {
	for _, su := range s.Suite {
		if su.Dir != cwdRel {
			continue
		}
		for _, c := range su.Commands {
			if slices.Equal(c, argv) {
				return true
			}
		}
	}
	return false
}

// LockPath is the CPU lock on the hub: <checkout>/deploy/state/cpu.lock
// (spec §4.5; deploy/state/ is gitignored). The Claude lanes take the same
// file with util-linux flock.
func LockPath(checkout string) string { return path.Join(checkout, "deploy", "state", "cpu.lock") }
