package platform

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// Folder is a known folder as Windows names it — the Desktop OneDrive
// redirected, if it did. The walk of 2026-09-28 listed C:\Users\Public\Desktop
// instead: this is the answer to "which desktop", read, never guessed.
func Folder(name string) (string, error) {
	ids := map[string]*windows.KNOWNFOLDERID{
		"home":      windows.FOLDERID_Profile,
		"desktop":   windows.FOLDERID_Desktop,
		"documents": windows.FOLDERID_Documents,
		"downloads": windows.FOLDERID_Downloads,
	}
	id, ok := ids[name]
	if !ok {
		return "", fmt.Errorf("no folder is called %q", name)
	}
	path, err := windows.KnownFolderPath(id, 0)
	if err != nil || path == "" {
		return "", fmt.Errorf("this machine names no %s folder (%v)", name, err)
	}
	return path, nil
}
