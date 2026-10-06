//go:build unix

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

// CI follow-up (fix round 2): moved here unchanged from main_test.go. The
// first rebuild-ci run on real Windows runners (windows-2025,
// windows-11-arm) failed this test: it forces a real, non-ErrNotExist Lstat
// error by putting a regular file where AuditFile's parent directory should
// be, so os.Lstat fails with ENOTDIR on Unix — but on Windows that exact
// path shape maps to ERROR_PATH_NOT_FOUND, and GOROOT/src/syscall/
// syscall_windows.go defines `ENOTDIR Errno = ERROR_PATH_NOT_FOUND` (the
// SAME numeric value) AND lists ERROR_PATH_NOT_FOUND as one of the four
// codes syscall.Errno.Is treats as oserror.ErrNotExist. So on Windows the
// premise is false: the path genuinely cannot exist, and the product's
// reading (Lstat says "missing", not "a confirmed problem") is correct, not
// a bug. See main_windows_test.go for the Windows-appropriate twin.
//
// Fix round 1, Finding 2: config.json and key are removed CLEANLY (they are
// really gone), but the audit step fails with ENOTDIR — its parent path
// component is a regular file, not a directory, so config.Wipe cannot even
// Lstat it (a real error, never fs.ErrNotExist). The message must name the
// audit path (still might be live — Wipe never confirmed otherwise) and
// must NOT name config.json or key (confirmed gone), matching afterRun's own
// doc: the status says what is true on disk. ENOTDIR is deterministic
// regardless of the user running the test, unlike a permission bit (root
// ignores those).
func TestAfterFailedWipeNamesOnlyWhatIsStillThere(t *testing.T) {
	home := t.TempDir()
	p := config.Paths{
		ConfigDir: filepath.Join(home, "c"), StateDir: filepath.Join(home, "s"),
		ConfigFile: filepath.Join(home, "c", "config.json"), KeyFile: filepath.Join(home, "c", "key"),
		AuditFile: filepath.Join(home, "not-a-dir", "audit.jsonl"), Home: home,
	}
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := config.Save(p, config.Config{DeviceID: "d"}, priv); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "not-a-dir"), []byte("x"), 0o600); err != nil {
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

// CI follow-up (fix round 2): moved here unchanged from main_test.go, for
// the same ENOTDIR-is-Windows-ErrNotExist reason as its sibling above. See
// main_windows_test.go for the Windows-appropriate twin.
//
// Fix round 1, folded-in item: cmdRun's not-enrolled guard
// (config.Paths.CheckEnrolled since S42b Task 11, shared with install)
// must only treat a CONFIRMED-missing config/key as "not enrolled" (exit
// 78). Any other Lstat error is a real problem re-enrolling cannot fix, so
// it must be returned as itself, never folded into config.ErrNotEnrolled. The
// second case forces a real (ENOTDIR) error the same deterministic way as
// TestAfterFailedWipeNamesOnlyWhatIsStillThere, rather than a permission bit
// a root-run test would not observe.
func TestCheckEnrolledDistinguishesMissingFromAnyOtherError(t *testing.T) {
	home := t.TempDir()
	p := config.Paths{
		ConfigDir: filepath.Join(home, "c"), StateDir: filepath.Join(home, "s"),
		ConfigFile: filepath.Join(home, "c", "config.json"), KeyFile: filepath.Join(home, "c", "key"),
		AuditFile: filepath.Join(home, "s", "audit.jsonl"), Home: home,
	}
	if err := p.CheckEnrolled(); !errors.Is(err, config.ErrNotEnrolled) {
		t.Fatalf("a missing config/key must report config.ErrNotEnrolled (exit 78), got %v", err)
	}

	notADir := filepath.Join(home, "not-a-dir")
	if err := os.WriteFile(notADir, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	p2 := p
	p2.ConfigFile = filepath.Join(notADir, "config.json") // ENOTDIR, never ErrNotExist
	if err := p2.CheckEnrolled(); err == nil || errors.Is(err, config.ErrNotEnrolled) {
		t.Fatalf("a real Lstat error (ENOTDIR) must not be reported as config.ErrNotEnrolled, got %v", err)
	}

	if err := os.MkdirAll(p.ConfigDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.ConfigFile, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.KeyFile, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := p.CheckEnrolled(); err != nil {
		t.Fatalf("both files present must report no error, got %v", err)
	}
}
