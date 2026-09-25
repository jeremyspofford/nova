package caps

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"novad/internal/platform"
)

// systemInfo reports host, OS, disk, memory and uptime, plus this OS's extra
// lines (home, and on Windows the Desktop folder). Every fact is NAMED: a
// value when it could be read, "unknown" when it could not — never dropped,
// because an omitted line reads as though it was never asked.
func systemInfo(ctx context.Context, d Deps) Outcome {
	var parts []string
	if host, err := os.Hostname(); err == nil {
		parts = append(parts, "host="+host)
	} else {
		parts = append(parts, "host=unknown")
	}
	parts = append(parts, "os="+platform.OSVersion(ctx, platform.Exec{}))

	target := d.Home
	if target == "" {
		target = platform.DiskRoot()
	}
	if free, total, err := platform.Disk(target); err == nil {
		parts = append(parts, fmt.Sprintf("disk %s free %s of %s", target, gib(free), gib(total)))
	} else {
		parts = append(parts, "disk=unknown")
	}

	switch m, err := platform.Memory(); {
	case err != nil:
		parts = append(parts, "mem=unknown")
	case m.AvailableKnown:
		parts = append(parts, fmt.Sprintf("mem available %s of %s", gib(m.Available), gib(m.Total)))
	default:
		parts = append(parts, fmt.Sprintf("mem total %s, available unknown", gib(m.Total)))
	}

	if up, err := platform.Uptime(); err == nil {
		parts = append(parts, "uptime="+formatUptime(up))
	} else {
		parts = append(parts, "uptime=unknown")
	}
	parts = append(parts, platform.Extras(d.Home)...)
	return ok0(strings.Join(parts, "; "))
}

func gib(b uint64) string {
	const g = 1024 * 1024 * 1024
	return fmt.Sprintf("%.1f GiB", float64(b)/float64(g))
}

// formatUptime is "Nd Nh Nm".
func formatUptime(d time.Duration) string {
	total := int64(d / time.Second)
	return fmt.Sprintf("%dd %dh %dm", total/86400, (total%86400)/3600, (total%3600)/60)
}
