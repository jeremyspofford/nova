package platform

import (
	"os"

	"golang.org/x/sys/windows"
)

// OpenLog opens path to append to, creating it, shared for reading, writing
// AND deleting. os.OpenFile shares only reading and writing, and Windows
// refuses to rename a file that any handle holds without delete sharing — so
// novad.log, which the detached supervisor holds as its own output for its
// whole life, could never be rotated (P6: 1 MiB, one rotation).
func OpenLog(path string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	// Appending access, as os.OpenFile asks for O_APPEND.
	access := uint32(windows.FILE_APPEND_DATA | windows.FILE_WRITE_ATTRIBUTES | windows.FILE_WRITE_EA |
		windows.STANDARD_RIGHTS_WRITE | windows.SYNCHRONIZE)
	share := uint32(windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE)
	h, err := windows.CreateFile(name, access, share, nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}
