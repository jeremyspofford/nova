package platform

import (
	"errors"
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// openProcess is windows.OpenProcess; a test makes it fail.
var openProcess = windows.OpenProcess

// listedImage is listImage; a test answers it.
var listedImage = listImage

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
	return isNovadImage(windows.UTF16ToString(buf[:n]))
}

// listImage is the image file name the process list gives pid, or
// errNotListed when no process holds it. A snapshot of the list needs no
// access to the process itself, so it answers for a pid OpenProcess was
// denied.
func listImage(pid int) (string, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return "", fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if e.ProcessID == uint32(pid) {
			return windows.UTF16ToString(e.ExeFile[:]), nil
		}
	}
	if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return "", errNotListed
	}
	return "", fmt.Errorf("reading the process list: %w", err)
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
// not this caller's process to end. Gone is what the OS says — OpenProcess's
// ERROR_INVALID_PARAMETER, its answer for a pid no process holds, or the
// process list — never an open that merely failed: a pid it was denied is
// looked up in the list, and one still running novad is an error (unopened,
// Task 32, L100). Only a genuine novad process that cannot be opened, fails
// to terminate, or does not exit within timeout, is an error. pid <= 0 is
// refused, as Terminate refuses it.
func TerminateNovad(pid int, timeout time.Duration) error {
	if pid <= 0 {
		return fmt.Errorf("refusing to terminate pid %d", pid)
	}
	h, err := openProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return unopened(pid, err, errors.Is(err, windows.ERROR_INVALID_PARAMETER), listedImage)
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
