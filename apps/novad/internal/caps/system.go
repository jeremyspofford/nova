package caps

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// systemInfo gathers disk, memory, OS and uptime with stdlib only — statfs via
// syscall, the rest by reading /proc and /etc/os-release. Each fact that can be
// read is reported; a fact that cannot is named as unknown rather than faked.
func systemInfo(d Deps) Outcome {
	var parts []string

	if host, err := os.Hostname(); err == nil {
		parts = append(parts, "host="+host)
	}
	if pretty := osReleasePretty(); pretty != "" {
		parts = append(parts, "os="+pretty)
	}

	target := d.Home
	if target == "" {
		target = "/"
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(target, &st); err == nil {
		bs := uint64(st.Bsize)
		free := st.Bavail * bs
		total := st.Blocks * bs
		parts = append(parts, fmt.Sprintf("disk %s free %s of %s", target, gib(free), gib(total)))
	} else {
		parts = append(parts, "disk=unknown")
	}

	if total, avail, ok := memInfo(); ok {
		parts = append(parts, fmt.Sprintf("mem available %s of %s", gib(avail), gib(total)))
	} else {
		parts = append(parts, "mem=unknown")
	}

	if up, ok := uptime(); ok {
		parts = append(parts, "uptime="+up)
	}

	return ok0(strings.Join(parts, "; "))
}

// systemNotify sends a desktop notification via notify-send when it exists.
// With no backend it is ok:false with a stated reason — it does not pretend to
// have notified. It needs a graphical session (DISPLAY/DBUS); see the README.
func systemNotify(ctx context.Context, args map[string]any) Outcome {
	msg, ok := strArg(args, "message")
	if !ok || msg == "" {
		return fail("system.notify needs a 'message'")
	}
	path, err := exec.LookPath("notify-send")
	if err != nil {
		return fail("no desktop notification backend: notify-send is not installed")
	}
	cmd := exec.CommandContext(ctx, path, "Nova", msg)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fail("notify-send failed: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return ok0("notified")
}

func gib(b uint64) string {
	const g = 1024 * 1024 * 1024
	return fmt.Sprintf("%.1f GiB", float64(b)/float64(g))
}

func osReleasePretty() string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			v := strings.TrimPrefix(line, "PRETTY_NAME=")
			return strings.Trim(v, `"`)
		}
	}
	return ""
}

// memInfo reads MemTotal and MemAvailable from /proc/meminfo (both in kB).
func memInfo() (total, avail uint64, ok bool) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	var gotTotal, gotAvail bool
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			if v, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
				total = v * 1024
				gotTotal = true
			}
		case "MemAvailable:":
			if v, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
				avail = v * 1024
				gotAvail = true
			}
		}
	}
	return total, avail, gotTotal && gotAvail
}

// uptime reads /proc/uptime (seconds since boot) and formats it compactly.
func uptime() (string, bool) {
	body, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return "", false
	}
	fields := strings.Fields(string(body))
	if len(fields) == 0 {
		return "", false
	}
	secs, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return "", false
	}
	total := int64(secs)
	days := total / 86400
	hours := (total % 86400) / 3600
	mins := (total % 3600) / 60
	return fmt.Sprintf("%dd %dh %dm", days, hours, mins), true
}
