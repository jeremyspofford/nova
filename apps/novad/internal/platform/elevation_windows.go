//go:build windows

package platform

import (
	"context"
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Elev is what elevating from this agent would meet (S42b P29).
type Elev struct {
	Elevated bool   // root, or an elevated token
	Admin    *bool  // Windows: a member of Administrators; nil elsewhere
	Sudo     string // see facts.Elevation
	Said     string // what was read when Windows sudo's setting is unknown
}

const (
	tokenElevationTypeDefault = 1
	tokenElevationTypeFull    = 2
	tokenElevationTypeLimited = 3
	sudoKey                   = `SOFTWARE\Microsoft\Windows\CurrentVersion\Sudo`
)

// sudoModes are Windows sudo's settings by the value of its Enabled key
// (Task 1 measured the key).
var sudoModes = map[uint64]string{0: "off", 1: "new_window", 2: "input_off", 3: "inline"}

// Elevation reads this agent's own token — elevated, and whether the
// account is an administrator behind UAC — and Windows sudo's setting. It
// runs no program. A read that fails is said, never read as "not an
// administrator" or "no sudo".
func Elevation(_ context.Context, _ Runner) (Elev, error) {
	t := windows.GetCurrentProcessToken()
	e := Elev{Elevated: t.IsElevated(), Sudo: "absent"}
	var typ, n uint32
	if err := windows.GetTokenInformation(t, windows.TokenElevationType,
		(*byte)(unsafe.Pointer(&typ)), uint32(unsafe.Sizeof(typ)), &n); err != nil {
		return e, fmt.Errorf("reading this agent's token: %w", err)
	}
	admin := typ == tokenElevationTypeFull || typ == tokenElevationTypeLimited
	if typ == tokenElevationTypeDefault {
		sid, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
		if err == nil {
			admin, err = windows.Token(0).IsMember(sid)
		}
		if err != nil {
			return e, fmt.Errorf("reading whether this account is in Administrators: %w", err)
		}
	}
	e.Admin = &admin
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, sudoKey, registry.QUERY_VALUE)
	switch {
	case errors.Is(err, registry.ErrNotExist):
		// No Windows sudo here: "absent".
	case err != nil:
		e.Sudo, e.Said = "unknown", fmt.Sprintf(`reading HKLM\%s: %v`, sudoKey, err)
	default:
		v, _, verr := k.GetIntegerValue("Enabled")
		k.Close()
		m, known := sudoModes[v]
		switch {
		case errors.Is(verr, registry.ErrNotExist):
			// The key without its value: sudo was never turned on — "absent".
		case verr != nil:
			e.Sudo, e.Said = "unknown", fmt.Sprintf(`reading HKLM\%s\Enabled: %v`, sudoKey, verr)
		case known:
			e.Sudo = m
		default:
			e.Sudo, e.Said = "unknown", fmt.Sprintf("Enabled=%d", v)
		}
	}
	return e, nil
}
