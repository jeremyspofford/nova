package config

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// harden replaces dir's DACL with exactly two entries — SYSTEM and the user
// novad runs as, full control, inherited by everything created inside — and
// protects it from the parent's entries (transport critique M11, accepted in
// r2-integration). Windows ignores 0700/0600, so without this the device key
// inherits whatever the parent folder grants.
func harden(dir string) error {
	sid, err := currentUserSID()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + sid + ")")
	if err != nil {
		return fmt.Errorf("building the custody DACL: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("reading the custody DACL back: %w", err)
	}
	err = windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil)
	if err != nil {
		return fmt.Errorf("setting the custody DACL on %s: %w", dir, err)
	}
	return nil
}

// currentUserRawSID is the SID of the user this process runs as, unparsed.
// Split out from currentUserSID so the read-back test can compare SIDs
// directly (windows.EqualSid) instead of parsing trustee strings out of
// SDDL, which renders some well-known SIDs as aliases (r2 ruling, S42a
// Task 5).
func currentUserRawSID() (*windows.SID, error) {
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("reading this process's user: %w", err)
	}
	return tu.User.Sid, nil
}

// currentUserSID is the same SID, as the string form the SDDL harden writes
// needs.
func currentUserSID() (string, error) {
	sid, err := currentUserRawSID()
	if err != nil {
		return "", err
	}
	return sid.String(), nil
}

// DACLOf is dir's DACL as SDDL — what the read-back test (and a curious
// operator) compare against.
func DACLOf(dir string) (string, error) {
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return "", err
	}
	return sd.String(), nil
}
