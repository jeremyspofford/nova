package platform

import "os"

// ConfigBase is ~/Library/Application Support (os.UserConfigDir).
func ConfigBase() (string, error) { return os.UserConfigDir() }

// StateBase is the same place: macOS keeps an app's state beside its config.
func StateBase() (string, error) { return os.UserConfigDir() }
