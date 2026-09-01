package config

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DenyList is the mechanical-at-the-edge fs backstop. Core's fs_roots grant is
// the allow-boundary, checked server-side; DenyList is the refuse-backstop that
// holds even against a fully trusted core. A target at or under any deny root
// is refused REGARDLESS of what core signed.
type DenyList struct {
	roots []string // absolute, cleaned
}

// DefaultDenyRoots are the paths that ship refused: the user's key stores and
// the daemon's own config + state dirs, so a signed fs.write can never rewrite
// the device key or the audit log.
func DefaultDenyRoots(p Paths) []string {
	return []string{
		filepath.Join(p.Home, ".ssh"),
		filepath.Join(p.Home, ".gnupg"),
		p.ConfigDir,
		p.StateDir,
	}
}

// LoadDenyRoots reads ~/.config/novad/deny_roots (one absolute path per line;
// blank lines and #-comments ignored), creating it with the defaults on first
// run if absent. The defaults are always folded in even if the file was edited
// to drop them — the daemon's own custody dirs are not negotiable.
func LoadDenyRoots(p Paths) (*DenyList, error) {
	defaults := DefaultDenyRoots(p)
	if _, err := os.Stat(p.DenyRootsFile); os.IsNotExist(err) {
		if err := os.MkdirAll(p.ConfigDir, 0o700); err != nil {
			return nil, err
		}
		if err := writeDenyRootsFile(p.DenyRootsFile, defaults); err != nil {
			return nil, err
		}
	}
	body, err := os.ReadFile(p.DenyRootsFile)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var roots []string
	add := func(raw string) {
		abs, err := filepath.Abs(raw)
		if err != nil {
			return
		}
		abs = filepath.Clean(abs)
		if !seen[abs] {
			seen[abs] = true
			roots = append(roots, abs)
		}
	}
	sc := bufio.NewScanner(strings.NewReader(string(body)))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		add(line)
	}
	// The custody dirs are non-negotiable: fold the defaults in unconditionally.
	for _, d := range defaults {
		add(d)
	}
	return &DenyList{roots: roots}, nil
}

// Roots returns the resolved deny roots (for status/diagnostics).
func (d *DenyList) Roots() []string { return append([]string(nil), d.roots...) }

// Forbids reports whether target lies at or under any deny root. It checks BOTH
// the lexically-cleaned absolute path AND a symlink-resolved form (resolving
// the nearest existing ancestor, since a write target may not exist yet), so a
// symlinked parent pointing into ~/.ssh cannot smuggle a write past the check.
// A path it cannot even make absolute is refused, not allowed.
func (d *DenyList) Forbids(target string) (bool, string) {
	abs, err := filepath.Abs(target)
	if err != nil {
		return true, "path could not be resolved to an absolute path"
	}
	abs = filepath.Clean(abs)
	resolved := resolveExistingAncestor(abs)
	for _, root := range d.roots {
		if underOrEqual(abs, root) || underOrEqual(resolved, root) {
			return true, fmt.Sprintf("path is under a deny root (%s)", root)
		}
	}
	return false, ""
}

// underOrEqual is true when p is root itself or a descendant of root, using a
// path-separator boundary so /home/jeremy-evil is NOT under /home/jeremy.
func underOrEqual(p, root string) bool {
	if p == root {
		return true
	}
	return strings.HasPrefix(p, root+string(os.PathSeparator))
}

// resolveExistingAncestor resolves symlinks on the longest existing prefix of p
// and re-appends the non-existent tail, so a target whose file does not exist
// yet is still checked against where its real parent points.
func resolveExistingAncestor(p string) string {
	cur := p
	var tail []string
	for {
		if resolved, err := filepath.EvalSymlinks(cur); err == nil {
			full := resolved
			for i := len(tail) - 1; i >= 0; i-- {
				full = filepath.Join(full, tail[i])
			}
			return filepath.Clean(full)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p // reached the root with nothing resolvable
		}
		tail = append(tail, filepath.Base(cur))
		cur = parent
	}
}

func writeDenyRootsFile(path string, roots []string) error {
	var b strings.Builder
	b.WriteString("# novad deny-roots: fs.list/read/write refuse any target at or under\n")
	b.WriteString("# these paths, regardless of what core signed. One absolute path per line.\n")
	b.WriteString("# The daemon's own config/state dirs are always enforced even if removed here.\n")
	for _, r := range roots {
		b.WriteString(r)
		b.WriteByte('\n')
	}
	return writeFile0600(path, []byte(b.String()))
}
