//go:build windows

package admin

// Compile-only: the real seams satisfy the interfaces the glue is tested
// through (glue_test.go, with fakes). No test here runs schtasks.exe, sets
// an ACL or starts a process — the bar for this package's tests.
var (
	_ Scheduler  = Schtasks{}
	_ DirACL     = WinACL{}
	_ FileOwners = WinOwners{}
	_ ProcRunner = JobRunner{}
)
