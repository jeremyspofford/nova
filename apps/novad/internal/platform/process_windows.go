package platform

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

// ProcessAlive is whether pid names a running process. pid <= 0 never names a
// single process this package tracks (0 is the System Idle Process; Windows
// pids are never negative), so it is reported not alive without asking the
// OS — mirrors process_unix.go's guard, for the same reason.
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	return windows.GetExitCodeProcess(h, &code) == nil && code == 259 // STILL_ACTIVE
}

// ProcessIsNovad is whether pid runs a novad image — checked before a pid
// read from a status file is ended, so a pid Windows has reused for another
// program is never touched.
func ProcessIsNovad(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	return imageIsNovad(h)
}

// imageIsNovad is whether the process behind an already-open handle is a
// novad image. Shared by ProcessIsNovad and TerminateNovad so the latter can
// verify identity on the SAME handle it goes on to terminate, instead of
// opening a second handle by pid and leaving a window in which Windows could
// have reused the pid for something else between the two calls.
func imageIsNovad(h windows.Handle) bool {
	buf := make([]uint16, windows.MAX_PATH)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) != nil {
		return false
	}
	return strings.HasPrefix(strings.ToLower(filepath.Base(windows.UTF16ToString(buf[:n]))), "novad")
}

// Terminate ends pid. pid <= 0 is refused, for the same reason
// process_unix.go's Terminate refuses one: neither OS defines a single
// process that a non-positive pid names here.
func Terminate(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("refusing to terminate pid %d", pid)
	}
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.TerminateProcess(h, 1)
}

// TerminateNovad ends pid IF — and only if — it is still running a novad
// image, and waits up to timeout for it to actually exit before returning.
//
// Fix round 1, Important 1: the previous shape called ProcessIsNovad(pid)
// and, separately, Terminate(pid) — two independent OpenProcess calls, with
// a window between them in which Windows could reuse the pid for an
// unrelated program, and no confirmation the process had actually gone before
// the caller moved on. Here ONE handle is opened with
// QUERY_LIMITED_INFORMATION | TERMINATE | SYNCHRONIZE, the image name is
// verified on that SAME handle, then TerminateProcess and
// WaitForSingleObject run against it — so there is no separate identity
// check to race, and a caller (runKey.Stop) that must not report success it
// did not check gets a genuine answer.
//
// A pid that is already gone, or that Windows has reused for something other
// than novad, is left alone and reported as fine (nil, not an error) — it is
// not this caller's process to end. Only a genuine novad process that fails
// to terminate, or does not exit within timeout, is an error. pid <= 0 is
// refused, as Terminate refuses it.
func TerminateNovad(pid int, timeout time.Duration) error {
	if pid <= 0 {
		return fmt.Errorf("refusing to terminate pid %d", pid)
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return nil // already gone
	}
	defer windows.CloseHandle(h)
	if !imageIsNovad(h) {
		return nil // not ours: a pid Windows has reused for another program
	}
	if err := windows.TerminateProcess(h, 1); err != nil {
		return fmt.Errorf("pid %d: TerminateProcess: %w", pid, err)
	}
	event, err := windows.WaitForSingleObject(h, uint32(timeout.Milliseconds()))
	if err != nil {
		return fmt.Errorf("pid %d: waiting for it to exit: %w", pid, err)
	}
	if event != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("pid %d: did not exit within %s", pid, timeout)
	}
	return nil
}
