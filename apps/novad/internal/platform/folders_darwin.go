package platform

import (
	"fmt"
	"os"
	"path/filepath"
)

// Folder is a known folder on macOS, where the OS fixes these names.
func Folder(name string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch name {
	case "home":
		return home, nil
	case "desktop":
		return filepath.Join(home, "Desktop"), nil
	case "documents":
		return filepath.Join(home, "Documents"), nil
	case "downloads":
		return filepath.Join(home, "Downloads"), nil
	}
	return "", fmt.Errorf("no folder is called %q", name)
}
