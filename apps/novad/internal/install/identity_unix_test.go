//go:build unix

package install

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// An audit log that cannot even be looked at may still be a live chain, so
// the pairing stops there too — "no log" is never assumed from a failed
// check. ENOTDIR (a regular file where the log's directory should be) is a
// real Lstat error on Unix for every user, root included; on Windows that
// path shape reads as missing, which is true there (main_unix_test.go says
// why), so this case is Unix-only.
func TestAnAuditLogThatCannotBeCheckedStopsThePairing(t *testing.T) {
	p := paths(t)
	notADir := filepath.Join(p.Home, "not-a-dir")
	if err := os.WriteFile(notADir, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	p.AuditFile = filepath.Join(notADir, "audit.jsonl")
	o, calls := opts(t, p, nil, okEnroll(false))
	o.Code = "ABCD-2345"
	_, _, err := o.identity(context.Background())
	if err == nil || !strings.HasPrefix(err.Error(), "cannot pair: the old audit log could not be set aside") {
		t.Fatalf("got %v", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("the code was spent on a pairing that cannot start clean: %+v", *calls)
	}
}
