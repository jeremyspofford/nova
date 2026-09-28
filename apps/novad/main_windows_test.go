//go:build windows

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"novad/internal/client"
	"novad/internal/config"
)

// CI follow-up (fix round 2): Windows twins of the two Unix-only tests in
// main_unix_test.go. Their ENOTDIR trick (a regular file where a directory
// should be) does not produce a non-ErrNotExist error on Windows — see that
// file's comment for the exact syscall-level reason — so both tests here use
// a DIFFERENT, Windows-specific fault: a path whose final component carries
// "<", one of the characters Windows rejects in a filename
// (< > : " | ? *; ":" is excluded from that set here because it collides
// with drive letters and NTFS alternate data streams).
//
// Verified from GOROOT source (GOROOT = `go env GOROOT`), not by running on
// real Windows hardware (this development sandbox is Linux; the controller
// re-runs actual Windows CI to confirm):
//   - GOROOT/src/os/stat_windows.go: Lstat's implementation (lstatNolog ->
//     stat) passes the name straight to syscall.GetFileAttributesEx with no
//     character validation of its own — filepath.Join and
//     syscall.UTF16PtrFromString do not reject "<" either — so the OS/kernel
//     itself is what would reject an invalid character, not Go.
//   - GOROOT/src/syscall/syscall_windows.go's Errno.Is lists, for
//     oserror.ErrNotExist, EXACTLY four codes: ERROR_FILE_NOT_FOUND,
//     _ERROR_BAD_NETPATH, ERROR_PATH_NOT_FOUND, ENOENT.
//     ERROR_INVALID_NAME (123, GOROOT/src/internal/syscall/windows/
//     syscall_windows.go:41) is in NONE of Errno.Is's four switch cases
//     (ErrPermission/ErrExist/ErrNotExist/ErrUnsupported) — so if the OS
//     returns it, errors.Is(err, fs.ErrNotExist) is false by construction.
//   - GOROOT/src/os/root_windows.go's rootCleanPath uses
//     windows.ERROR_INVALID_NAME itself, for exactly this class of problem:
//     its own comment calls "?" "not a valid character in a Windows
//     filename" — direct confirmation from Go's own authors of the
//     character/error association, for a sibling reserved character in the
//     same set the controller named.
//
// This is standard, long-documented Win32 behavior (CreateFile,
// GetFileAttributesEx and friends reject <, >, :, ", |, ?, * in a path
// component with ERROR_INVALID_NAME), corroborated by Go's own source
// choosing that exact code for the same problem — but it is still a
// source-level inference, not an execution-level one, since this sandbox
// cannot run Windows binaries.

// Windows twin of TestAfterFailedWipeNamesOnlyWhatIsStillThere
// (main_unix_test.go). AuditFile's own name is invalid, so no directory
// trick is needed at all: config.Save already creates AuditFile's parent
// (StateDir) as part of creating a normal enrollment, and Lstat fails on the
// name itself.
func TestAfterFailedWipeNamesOnlyWhatIsStillThereOnWindows(t *testing.T) {
	home := t.TempDir()
	p := config.Paths{
		ConfigDir: filepath.Join(home, "c"), StateDir: filepath.Join(home, "s"),
		ConfigFile: filepath.Join(home, "c", "config.json"), KeyFile: filepath.Join(home, "c", "key"),
		AuditFile: filepath.Join(home, "s", "audit<invalid.jsonl"), Home: home,
	}
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := config.Save(p, config.Config{DeviceID: "d"}, priv); err != nil {
		t.Fatal(err)
	}

	code, msg := afterRun(p, client.ErrRevoked, time.Now())
	if code != 78 {
		t.Fatalf("a wipe that fails on the audit step must still exit 78, got %d: %q", code, msg)
	}
	if p.Enrolled() {
		t.Fatalf("config.json and key must actually be gone: %q", msg)
	}
	if !strings.Contains(msg, p.AuditFile) {
		t.Fatalf("the message must name the audit path that could not be confirmed set aside, got %q", msg)
	}
	if strings.Contains(msg, p.ConfigFile) || strings.Contains(msg, p.KeyFile) {
		t.Fatalf("the message must not name files that are already gone, got %q", msg)
	}
}

// Windows twin of TestCheckEnrolledDistinguishesMissingFromAnyOtherError
// (main_unix_test.go). ConfigDir is created FIRST so the invalid-name case
// tests only character validity, never an incidentally-missing parent
// directory too.
func TestCheckEnrolledDistinguishesMissingFromAnyOtherErrorOnWindows(t *testing.T) {
	home := t.TempDir()
	p := config.Paths{
		ConfigDir: filepath.Join(home, "c"), StateDir: filepath.Join(home, "s"),
		ConfigFile: filepath.Join(home, "c", "config.json"), KeyFile: filepath.Join(home, "c", "key"),
		AuditFile: filepath.Join(home, "s", "audit.jsonl"), Home: home,
	}
	if err := checkEnrolled(p); !errors.Is(err, errNotEnrolled) {
		t.Fatalf("a missing config/key must report errNotEnrolled (exit 78), got %v", err)
	}

	if err := os.MkdirAll(p.ConfigDir, 0o700); err != nil {
		t.Fatal(err)
	}
	p2 := p
	p2.ConfigFile = filepath.Join(p.ConfigDir, "config<invalid.json") // ERROR_INVALID_NAME, never ErrNotExist
	if err := checkEnrolled(p2); err == nil || errors.Is(err, errNotEnrolled) {
		t.Fatalf("a real Lstat error (ERROR_INVALID_NAME) must not be reported as errNotEnrolled, got %v", err)
	}

	if err := os.WriteFile(p.ConfigFile, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.KeyFile, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := checkEnrolled(p); err != nil {
		t.Fatalf("both files present must report no error, got %v", err)
	}
}
