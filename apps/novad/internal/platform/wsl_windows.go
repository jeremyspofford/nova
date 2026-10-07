//go:build windows

package platform

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const lxssKey = `Software\Microsoft\Windows\CurrentVersion\Lxss`

// WSLDistros lists this account's distributions from the key WSL itself
// keeps (Task 1, branch L-reg) — never `wsl --list --verbose`'s table, whose
// headings and states are translated. No key: nothing is registered.
// unreadable says each entry that could not be read — never skipped
// silently — while a key with no DistributionName is not a distribution
// (WSL keeps others there) and is skipped.
func WSLDistros() (distros []WSLDistro, unreadable []error, err error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, lxssKey, registry.READ)
	if errors.Is(err, registry.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf(`reading HKCU\%s: %w`, lxssKey, err)
	}
	defer k.Close()
	def, _, err := k.GetStringValue("DefaultDistribution")
	if err != nil && !errors.Is(err, registry.ErrNotExist) {
		unreadable = append(unreadable, fmt.Errorf(`reading HKCU\%s\DefaultDistribution: %w`, lxssKey, err))
	}
	ids, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return nil, nil, fmt.Errorf(`listing HKCU\%s: %w`, lxssKey, err)
	}
	for _, id := range ids {
		sk, err := registry.OpenKey(k, id, registry.READ)
		if err != nil {
			unreadable = append(unreadable, fmt.Errorf(`opening HKCU\%s\%s: %w`, lxssKey, id, err))
			continue
		}
		name, _, nerr := sk.GetStringValue("DistributionName")
		ver, _, _ := sk.GetIntegerValue("Version")
		sk.Close()
		switch {
		case errors.Is(nerr, registry.ErrNotExist), nerr == nil && name == "":
			continue
		case nerr != nil:
			unreadable = append(unreadable, fmt.Errorf(`reading HKCU\%s\%s\DistributionName: %w`, lxssKey, id, nerr))
			continue
		}
		distros = append(distros, WSLDistro{Name: name, Version: int(ver), Default: strings.EqualFold(id, def)})
	}
	return distros, unreadable, nil
}
