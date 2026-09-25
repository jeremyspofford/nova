package platform

import "context"

// rawMachineID is the hardware UUID ioreg reports. The absolute path: a
// LaunchAgent's PATH is minimal.
func rawMachineID(ctx context.Context, r Runner) (string, error) {
	out, err := r.Run(ctx, "/usr/sbin/ioreg", []string{"-rd1", "-c", "IOPlatformExpertDevice"}, "")
	if err != nil {
		return "", err
	}
	return ParseIOPlatformUUID(out)
}
