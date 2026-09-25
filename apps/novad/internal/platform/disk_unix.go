//go:build linux || darwin

package platform

import "syscall"

// Disk is the free (to this user) and total bytes of the filesystem holding
// path.
func Disk(path string) (free, total uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize) // int64 on linux, uint32 on darwin: both widen here
	return st.Bavail * bs, st.Blocks * bs, nil
}

// DiskRoot is what system.info reads when the daemon has no home.
func DiskRoot() string { return "/" }
