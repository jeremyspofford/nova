package platform

import (
	"os"
	"path/filepath"
)

// BinaryName is the agent's file name on this OS.
const BinaryName = "novad"

// InstallDir is ~/Library/Application Support/Nova (P1: the macOS equivalent
// of %LocalAppData%\Programs).
func InstallDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "Application Support", "Nova"), nil
}

// AdminInstallDir is S42c's admin-only copy (not installed by S42b).
func AdminInstallDir() string { return "/Library/Application Support/Nova" }
