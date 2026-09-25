package platform

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// ParseOSReleasePretty is PRETTY_NAME from an os-release body, or "".
func ParseOSReleasePretty(body string) string {
	sc := bufio.NewScanner(strings.NewReader(body))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"'`)
		}
	}
	return ""
}

var ioPlatformUUID = regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"`)

// ParseIOPlatformUUID is the hardware UUID from
// `ioreg -rd1 -c IOPlatformExpertDevice`.
func ParseIOPlatformUUID(ioreg string) (string, error) {
	m := ioPlatformUUID.FindStringSubmatch(ioreg)
	if m == nil {
		return "", errors.New("ioreg printed no IOPlatformUUID")
	}
	return m[1], nil
}

// WindowsProductName composes the label Windows itself shows. The registry's
// ProductName still says "Windows 10" on Windows 11; build 22000 and later is
// Windows 11, so the number decides.
func WindowsProductName(product, display, build string) string {
	name := strings.TrimSpace(product)
	if name == "" {
		name = "Windows"
	}
	b := strings.TrimSpace(build)
	if n, err := strconv.Atoi(b); err == nil && n >= 22000 {
		name = strings.Replace(name, "Windows 10", "Windows 11", 1)
	}
	if d := strings.TrimSpace(display); d != "" {
		name += " " + d
	}
	if b != "" {
		name += " (build " + b + ")"
	}
	return name
}

// StartApp is one entry of Windows' Get-StartApps: what the Start menu calls
// it, and the AppUserModelID that launches it.
type StartApp struct {
	Name  string `json:"Name"`
	AppID string `json:"AppID"`
}

// ParseStartApps reads `Get-StartApps | ConvertTo-Json`. PowerShell prints a
// bare object instead of an array when there is exactly one app, and nothing
// at all when there are none; all three are read.
func ParseStartApps(out string) ([]StartApp, error) {
	text := strings.TrimSpace(strings.TrimPrefix(out, "\xef\xbb\xbf"))
	if text == "" {
		return nil, nil
	}
	if strings.HasPrefix(text, "{") {
		var one StartApp
		if err := json.Unmarshal([]byte(text), &one); err != nil {
			return nil, fmt.Errorf("the Start menu listing was unreadable: %w", err)
		}
		return []StartApp{one}, nil
	}
	var many []StartApp
	if err := json.Unmarshal([]byte(text), &many); err != nil {
		return nil, fmt.Errorf("the Start menu listing was unreadable: %w", err)
	}
	return many, nil
}

// EncodePowerShell is script in the form `powershell -EncodedCommand` takes:
// UTF-16LE, then base64. The script travels as ONE argv element, with no
// quoting for anything to get wrong.
func EncodePowerShell(script string) string {
	units := utf16.Encode([]rune(script))
	buf := make([]byte, 2*len(units))
	for i, u := range units {
		binary.LittleEndian.PutUint16(buf[2*i:], u)
	}
	return base64.StdEncoding.EncodeToString(buf)
}
