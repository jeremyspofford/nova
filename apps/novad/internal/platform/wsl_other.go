//go:build !windows

package platform

// WSLDistros: WSL is a Windows feature; anywhere else there is none to list.
func WSLDistros() ([]WSLDistro, []error, error) { return nil, nil, nil }
