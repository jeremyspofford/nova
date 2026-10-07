package platform

import (
	"fmt"
	"os"
	"path/filepath"
)

// Folder is a known folder as this Linux names it: home, else xdg
// user-dirs (a headless server usually names none — said, not guessed).
func Folder(name string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if name == "home" {
		return home, nil
	}
	if !KnownFolder(name) {
		return "", fmt.Errorf("no folder is called %q", name)
	}
	base, err := ConfigBase()
	if err != nil {
		return "", err
	}
	path := filepath.Join(base, "user-dirs.dirs")
	body, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("this machine names no %s folder (%s: %v)", name, path, err)
	}
	if dir, ok := ParseUserDirs(string(body), home)[name]; ok {
		return dir, nil
	}
	return "", fmt.Errorf("this machine names no %s folder (xdg user-dirs has no entry for it)", name)
}
