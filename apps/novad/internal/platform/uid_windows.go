package platform

import (
	"context"
	"fmt"

	"golang.org/x/sys/windows/registry"
)

// rawMachineID is the MachineGuid Windows writes at install.
func rawMachineID(_ context.Context, _ Runner) (string, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Cryptography`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return "", fmt.Errorf("reading MachineGuid: %w", err)
	}
	defer k.Close()
	v, _, err := k.GetStringValue("MachineGuid")
	if err != nil {
		return "", fmt.Errorf("reading MachineGuid: %w", err)
	}
	return v, nil
}
