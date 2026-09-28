//go:build linux || darwin

package platform

// Extras are the lines system.info adds on this OS. Linux and macOS add
// nothing beyond home: identical on both, so it lives here once instead of
// being copied into info_linux.go and info_darwin.go.
func Extras(home string) []string {
	if home == "" {
		return nil
	}
	return []string{"home=" + home}
}
