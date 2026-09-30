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
func WSLDistros() ([]WSLDistro, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, lxssKey, registry.READ)
	if errors.Is(err, registry.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf(`reading HKCU\%s: %w`, lxssKey, err)
	}
	defer k.Close()
	def, _, _ := k.GetStringValue("DefaultDistribution")
	ids, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return nil, fmt.Errorf(`listing HKCU\%s: %w`, lxssKey, err)
	}
	var out []WSLDistro
	for _, id := range ids {
		sk, err := registry.OpenKey(k, id, registry.READ)
		if err != nil {
			continue
		}
		name, _, nerr := sk.GetStringValue("DistributionName")
		ver, _, _ := sk.GetIntegerValue("Version")
		sk.Close()
		if nerr != nil || name == "" {
			continue
		}
		out = append(out, WSLDistro{Name: name, Version: int(ver), Default: strings.EqualFold(id, def)})
	}
	return out, nil
}
