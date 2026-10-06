package platform

import (
	"os"
	"path/filepath"
)

// BinaryName is the agent's file name on this OS.
const BinaryName = "novad"

// InstallDir is where `novad install` puts the agent (P1): the user's own
// ~/.local/bin, which systemd's file-hierarchy names for user programs.
func InstallDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "bin"), nil
}

// AdminInstallDir is the admin-only copy S42c's helper will run (P1): a
// LocalSystem or root service must run a binary only an admin can write.
// Declared here so S42c finds it; S42b installs nothing there.
func AdminInstallDir() string { return "/usr/local/libexec/nova" }
