package platform

import (
	"bufio"
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

// OSVersion is what os-release calls this system, e.g. "Ubuntu 26.04 LTS".
func OSVersion(_ context.Context, _ Runner) string {
	if body, err := os.ReadFile("/etc/os-release"); err == nil {
		if pretty := ParseOSReleasePretty(string(body)); pretty != "" {
			return pretty
		}
	}
	return "Linux (distribution not stated)"
}

// Memory reads MemTotal and MemAvailable from /proc/meminfo (kB).
func Memory() (Mem, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return Mem{}, err
	}
	defer f.Close()
	var m Mem
	gotTotal := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		v, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			m.Total, gotTotal = v*1024, true
		case "MemAvailable:":
			m.Available, m.AvailableKnown = v*1024, true
		}
	}
	if !gotTotal {
		return Mem{}, errors.New("/proc/meminfo has no MemTotal")
	}
	return m, nil
}

// Uptime reads /proc/uptime.
func Uptime() (time.Duration, error) {
	body, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(body))
	if len(fields) == 0 {
		return 0, errors.New("/proc/uptime is empty")
	}
	secs, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, err
	}
	return time.Duration(secs * float64(time.Second)), nil
}
