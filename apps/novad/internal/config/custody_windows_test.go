package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// fileAllAccess is FILE_ALL_ACCESS (STANDARD_RIGHTS_REQUIRED | SYNCHRONIZE |
// 0x1FF) — what SDDL's "FA" resolves to. x/sys/windows does not export the
// named constant. https://learn.microsoft.com/en-us/windows/win32/secauthz/ace-strings
const fileAllAccess = windows.ACCESS_MASK(windows.STANDARD_RIGHTS_REQUIRED | windows.SYNCHRONIZE | 0x1FF)

// inheritObjectAndContainer is the AceFlags SDDL's "OICI" resolves to: the
// ACE is inherited by both object (file) and container (subdirectory)
// children.
const inheritObjectAndContainer = byte(windows.OBJECT_INHERIT_ACE | windows.CONTAINER_INHERIT_ACE)

// The D-M11 read-back: the custody directories carry a PROTECTED DACL with
// exactly SYSTEM and this user — no BUILTIN\Users, no Everyone, nothing
// inherited from the parent. Windows ignores 0700/0600, so without this the
// device key inherits whatever the parent folder grants.
//
// This compares SIDs, never SDDL trustee strings: SDDL renders some
// well-known SIDs as aliases (e.g. "LA" for a RID-500 local administrator),
// and GitHub's Windows runners run as "runneradmin", which may be exactly
// that account — a string comparison could go red on a correct DACL
// (r2 ruling on S42a Task 5). The DACL the product WRITES is still exactly
// P7's SDDL string (custody_windows.go); DACLOf is still used for the
// protected-flag check, it just is not what identifies the trustees.
func TestTheCustodyDACLIsSystemAndThisUserOnly(t *testing.T) {
	p := testPaths(t)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := Save(p, Config{DeviceID: "d"}, priv); err != nil {
		t.Fatal(err)
	}
	systemSID, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatal(err)
	}
	userSID, err := currentUserRawSID()
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{p.ConfigDir, p.StateDir} {
		sddl, err := DACLOf(dir)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(sddl, "D:P") {
			t.Fatalf("%s: the DACL must be protected (D:P...), got %s", dir, sddl)
		}

		sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		dacl, _, err := sd.DACL()
		if err != nil {
			t.Fatal(err)
		}
		if dacl.AceCount != 2 {
			t.Fatalf("%s: want exactly 2 ACEs, got %d (%s)", dir, dacl.AceCount, sddl)
		}
		sawSystem, sawUser := false, false
		for i := uint32(0); i < uint32(dacl.AceCount); i++ {
			var entry *windows.ACCESS_ALLOWED_ACE
			if err := windows.GetAce(dacl, i, &entry); err != nil {
				t.Fatalf("%s: GetAce(%d): %v", dir, i, err)
			}
			if entry.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
				t.Fatalf("%s: ACE %d is not an allow ACE (type %d): %s", dir, i, entry.Header.AceType, sddl)
			}
			if entry.Header.AceFlags != inheritObjectAndContainer {
				t.Fatalf("%s: ACE %d is not inherited by objects and containers only (flags %#x): %s", dir, i, entry.Header.AceFlags, sddl)
			}
			if entry.Mask != fileAllAccess {
				t.Fatalf("%s: ACE %d is not full access (mask %#x): %s", dir, i, entry.Mask, sddl)
			}
			sid := (*windows.SID)(unsafe.Pointer(&entry.SidStart))
			switch {
			case windows.EqualSid(sid, systemSID):
				sawSystem = true
			case windows.EqualSid(sid, userSID):
				sawUser = true
			default:
				t.Fatalf("%s: unexpected trustee on ACE %d: %s (%s)", dir, i, sid.String(), sddl)
			}
		}
		if !sawSystem || !sawUser {
			t.Fatalf("%s: want exactly SYSTEM and %s, got system=%v user=%v (%s)", dir, userSID.String(), sawSystem, sawUser, sddl)
		}
	}
}
