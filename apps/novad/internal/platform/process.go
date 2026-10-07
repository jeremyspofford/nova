package platform

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// errNotListed is a process list's answer for a pid nothing holds.
var errNotListed = errors.New("no process has this pid")

// isNovadImage is whether an image, a full path or a bare file name, is a
// novad build. On Windows filepath.Base splits at a backslash too.
func isNovadImage(image string) bool {
	return strings.HasPrefix(strings.ToLower(filepath.Base(image)), "novad")
}

// unopened is what TerminateNovad says of a pid it could not open (err). It
// is decided here, apart from Windows' own calls, so it is tested on every
// OS. gone is the open's own "no process has this pid": that pid is already
// gone. Any other failure, access denied above all, is never read as gone
// (Task 32, L100): listed asks the OS's process list, which needs no access
// to the process itself. A pid no longer listed is gone. One listed as
// another program is not this caller's to end: a pid Windows reused, often
// for another user's process, which is exactly what denies access. One
// listed as novad is running, and this caller cannot end it: an error, so a
// stop is never reported done while it runs. A list that cannot be read
// leaves that unknown, which is an error too.
func unopened(pid int, err error, gone bool, listed func(int) (string, error)) error {
	if gone {
		return nil
	}
	image, lerr := listed(pid)
	switch {
	case errors.Is(lerr, errNotListed):
		return nil // gone since the open
	case lerr != nil:
		return fmt.Errorf("pid %d: cannot open it (%w), and the process list could not say what runs there: %v", pid, err, lerr)
	case !isNovadImage(image):
		return nil // not ours: a pid Windows has reused for another program
	default:
		return fmt.Errorf("pid %d runs %s, and it cannot be ended from here: %w", pid, image, err)
	}
}
