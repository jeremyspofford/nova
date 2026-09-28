//go:build !windows

package config

// harden is a no-op where the 0700/0600 modes Save sets are the whole
// control (Linux, macOS).
func harden(string) error { return nil }
