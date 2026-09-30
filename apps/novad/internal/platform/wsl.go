package platform

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
)

// WSLDistro is one WSL distribution registered for this account, as WSL's
// own registry key names it (wsl_windows.go).
type WSLDistro struct {
	Name    string
	Version int // 1 or 2; 0 when the key did not say
	Default bool
}

// WSLInside is what one look inside a RUNNING distribution found. A field
// the look could not read stays empty; UnitSaid carries systemctl's own
// words when it answered nothing this parser knows.
type WSLInside struct {
	PID1        string
	User        string
	Sudo        string // no_password | refused | absent
	UnitActive  string // ActiveState of the user unit novad.service
	UnitFile    string // UnitFileState; "" when no unit file exists
	UnitRestart string // Restart=
	UnitMainPID int
	UnitSaid    string
	PIDs        []int // processes named novad
}

// WSLLookScript is the one look inside a running distribution, run as its
// default user through `wsl.exe -d <name> --exec /bin/sh -c`. A constant:
// the distro's name reaches wsl.exe as its own argument, never this text.
// Plain sh, one key=value a line, and nothing in it can ask for input
// (sudo -n). XDG_RUNTIME_DIR is defaulted because a process wsl.exe starts
// may not have it, and without it systemctl --user cannot find the bus.
const WSLLookScript = `export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; ` +
	`echo "pid1=$(cat /proc/1/comm 2>/dev/null)"; ` +
	`echo "user=$(id -un 2>/dev/null)"; ` +
	`if command -v sudo >/dev/null 2>&1; then if sudo -n true >/dev/null 2>&1; then echo sudo=no_password; else echo sudo=refused; fi; else echo sudo=absent; fi; ` +
	`systemctl --user show -p ActiveState -p UnitFileState -p MainPID -p Restart novad.service 2>&1 | while IFS= read -r l; do echo "unit.$l"; done; ` +
	`echo "pids=$(pgrep -x novad 2>/dev/null | tr '\n' ' ')"`

// ParseWSLInside reads WSLLookScript's output.
func ParseWSLInside(out string) WSLInside {
	var in WSLInside
	lines := strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n")
	for _, line := range lines {
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		switch key {
		case "pid1":
			in.PID1 = val
		case "user":
			in.User = val
		case "sudo":
			in.Sudo = val
		case "unit.ActiveState":
			in.UnitActive = val
		case "unit.UnitFileState":
			in.UnitFile = val
		case "unit.Restart":
			in.UnitRestart = val
		case "unit.MainPID":
			in.UnitMainPID, _ = strconv.Atoi(val)
		case "pids":
			for _, f := range strings.Fields(val) {
				if n, err := strconv.Atoi(f); err == nil && n > 0 {
					in.PIDs = append(in.PIDs, n)
				}
			}
		}
	}
	if in.UnitActive == "" {
		for _, line := range lines {
			if rest, ok := strings.CutPrefix(line, "unit."); ok && strings.TrimSpace(rest) != "" {
				in.UnitSaid = strings.TrimSpace(rest)
				break
			}
		}
	}
	return in
}

// DecodeWSL turns wsl.exe's own output into text: UTF-16LE (its default,
// with or without a byte-order mark) or UTF-8 (when WSL_UTF8=1 took).
func DecodeWSL(out string) string {
	if !strings.Contains(out, "\x00") {
		return strings.TrimPrefix(out, "\uFEFF")
	}
	b := []byte(out)
	if len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE {
		b = b[2:]
	}
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		u = append(u, uint16(b[i])|uint16(b[i+1])<<8)
	}
	return string(utf16.Decode(u))
}

// WSLUTF8 is in the environment of every wsl.exe the agent runs: wsl.exe then
// writes UTF-8 instead of UTF-16 — the conditions Task 1 measured under.
const WSLUTF8 = "WSL_UTF8=1"

// RunWSL runs wsl.exe the one way the agent does (S42b F3): with WSLUTF8 in
// its environment, its output decoded, and a failure's words decoded too —
// only wsl.exe's own words, from its stderr: Exec's prefix before them is
// ASCII already, and decoding the whole text as UTF-16 would scramble it. A
// wsl.exe that ignored WSL_UTF8 reads the same through DecodeWSL. A runner
// that cannot set the environment runs nothing.
func RunWSL(ctx context.Context, r Runner, args ...string) (string, error) {
	er, ok := r.(EnvRunner)
	if !ok {
		return "", fmt.Errorf("wsl.exe was not run: %T cannot give it %s", r, WSLUTF8)
	}
	out, err := er.RunEnv(ctx, []string{WSLUTF8}, "wsl.exe", args, "")
	var re *RunError
	switch {
	case err == nil:
	case errors.As(err, &re):
		decoded := *re
		decoded.Stderr = DecodeWSL(re.Stderr)
		err = &decoded
	case strings.Contains(err.Error(), "\x00"):
		err = errors.New(DecodeWSL(err.Error()))
	}
	return DecodeWSL(out), err
}
