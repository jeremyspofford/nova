package platform

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// The kernel's own release string decides — not WSL_DISTRO_NAME, which a
// systemd unit inside WSL does not get (measured on the Dell).
func TestWSLIsReadFromTheKernelReleaseNotTheEnvironment(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "osrelease")
	old := osreleasePath
	osreleasePath = path
	t.Cleanup(func() { osreleasePath = old })

	if err := os.WriteFile(path, []byte("5.15.167.4-microsoft-standard-WSL2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu-26.04")
	if in, distro := WSL(); !in || distro != "Ubuntu-26.04" {
		t.Fatalf("WSL kernel with a named distro: got %v %q", in, distro)
	}
	t.Setenv("WSL_DISTRO_NAME", "")
	if in, distro := WSL(); !in || distro != "" {
		t.Fatalf("WSL kernel, unnamed (a systemd unit): got %v %q", in, distro)
	}
	if err := os.WriteFile(path, []byte("6.18.7-76061807-generic\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu-26.04") // an env var alone never makes it WSL
	if in, _ := WSL(); in {
		t.Fatal("a native kernel is not WSL, whatever the environment says")
	}
}

func TestTheLinuxReadersReportRealNumbers(t *testing.T) {
	if m, err := Memory(); err != nil || m.Total == 0 || !m.AvailableKnown {
		t.Fatalf("memory: %+v %v", m, err)
	}
	if up, err := Uptime(); err != nil || up <= 0 {
		t.Fatalf("uptime: %v %v", up, err)
	}
	if free, total, err := Disk(DiskRoot()); err != nil || total == 0 || free > total {
		t.Fatalf("disk: %d of %d, %v", free, total, err)
	}
	if uid, err := MachineUID(context.Background(), Exec{}); err != nil || len(uid) != 64 {
		t.Fatalf("machine uid: %q %v", uid, err)
	}
}
