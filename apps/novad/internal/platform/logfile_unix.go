//go:build !windows

package platform

import "os"

// OpenLog opens path to append to, creating it (0600). Unix renames a file
// that another process holds open, so a log can always be rotated.
func OpenLog(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
}
