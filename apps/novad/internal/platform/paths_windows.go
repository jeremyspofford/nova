package platform

import "os"

// ConfigBase is %AppData% (os.UserConfigDir), per the hub design.
func ConfigBase() (string, error) { return os.UserConfigDir() }

// StateBase is %LocalAppData% (os.UserCacheDir on Windows): the audit log is
// this machine's record and must never travel with a roaming profile.
func StateBase() (string, error) { return os.UserCacheDir() }
