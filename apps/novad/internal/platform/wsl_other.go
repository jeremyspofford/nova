//go:build !windows

package platform

// WSLDistros: WSL is a Windows feature; anywhere else there is none to list.
func WSLDistros() ([]WSLDistro, error) { return nil, nil }
