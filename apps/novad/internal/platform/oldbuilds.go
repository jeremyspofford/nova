package platform

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// OldBuilds are the builds moved aside in dir: <name>.old-<nanos> (install's
// place, and an uninstall that met a file in use) and <name>.<prev|new|
// failed|installing>.old-<nanos> (supervise; uninstall). Only names of that
// shape: a file that merely starts the same way is never listed. The
// directory is read, never globbed, so a bracket in a Windows user folder
// cannot change the match — in a glob it is a character class, which names
// another folder's files (Task 32 Phase C). Both callers delete what it
// lists: supervise at each start, uninstall once. A dir that does not exist
// holds none.
func OldBuilds(dir, name string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		rest, ok := strings.CutPrefix(e.Name(), name+".")
		if !ok {
			continue
		}
		for _, kind := range []string{"prev.", "new.", "failed.", "installing."} {
			if r, ok := strings.CutPrefix(rest, kind); ok {
				rest = r
				break
			}
		}
		if nanos, ok := strings.CutPrefix(rest, "old-"); ok && allDigits(nanos) {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	return out, nil
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
