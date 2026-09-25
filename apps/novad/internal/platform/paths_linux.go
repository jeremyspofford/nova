package platform

import (
	"os"
	"path/filepath"
)

// ConfigBase is $XDG_CONFIG_HOME or ~/.config — unchanged from before S42a,
// so an enrolled Linux daemon finds its key where it left it.
func ConfigBase() (string, error) {
	if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config"), nil
}

// StateBase is $XDG_STATE_HOME or ~/.local/state, where the audit log lives.
func StateBase() (string, error) {
	if v := os.Getenv("XDG_STATE_HOME"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "state"), nil
}
