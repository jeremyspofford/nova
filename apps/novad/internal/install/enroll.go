// Package install is `novad install` and `novad uninstall` (S42b): one
// command that pairs — or keeps, or re-pairs — this machine, puts the binary
// in the user's own folder, registers the service and PROVES the agent came
// up. A registration alone is never reported as installed.
package install

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// EnrollResult is core's answer to a pairing (the response of POST /enroll).
type EnrollResult struct {
	DeviceID   string `json:"device_id"`
	Name       string `json:"name"`
	CorePubKey string `json:"core_pubkey"`
	Repaired   bool   `json:"repaired"`
}

// EnrollRefused is the hub's own refusal of this request — a spent code, a
// name taken — in its stated words. The same hub answers the same at any of
// its addresses, so it is final: no other address is tried.
type EnrollRefused struct {
	Status int
	Reason string
}

func (e *EnrollRefused) Error() string {
	return fmt.Sprintf("enrollment refused (%d): %s", e.Status, e.Reason)
}

// Body is the enroll payload: the five keys main_test pins, and nothing else
// — core has no per-device settings to seed.
func Body(code, pubkeyHex, name, hostname string) ([]byte, error) {
	return json.Marshal(map[string]string{
		"code": code, "pubkey": pubkeyHex, "name": name, "platform": runtime.GOOS, "hostname": hostname,
	})
}

// Enroll spends code at hub to bind pub to this machine. Its error words are
// `novad enroll`'s own, which prints them as they are.
func Enroll(ctx context.Context, hub, code, name, hostname string, pub ed25519.PublicKey) (EnrollResult, error) {
	body, err := Body(code, hex.EncodeToString(pub), name, hostname)
	if err != nil {
		return EnrollResult{}, fmt.Errorf("could not build the enroll request: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	enrollURL := strings.TrimRight(hub, "/") + "/api/v1/devices/enroll"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, enrollURL, bytes.NewReader(body))
	if err != nil {
		return EnrollResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return EnrollResult{}, fmt.Errorf("could not reach %s: %w", enrollURL, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return EnrollResult{}, notEnrolled(enrollURL, resp, raw)
	}
	var res EnrollResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return EnrollResult{}, fmt.Errorf("the enrollment answer from %s was unreadable: %w", enrollURL, err)
	}
	if res.DeviceID == "" || res.CorePubKey == "" {
		return EnrollResult{}, fmt.Errorf("the enrollment answer from %s was missing device_id or core_pubkey", enrollURL)
	}
	return res, nil
}

// notEnrolled says what a non-200 from enrollURL was (Task 32, L222). Final
// — an *EnrollRefused — only when it is the hub's own refusal of this
// request: a 4xx carrying core's stated reason, {"error": "…"} (a shape
// refusal, a spent code, a name taken). Anything else is no answer about the
// code, so the caller tries the next address as after a network error: a
// status with no reason Nova states — a reverse proxy's 502, a CDN's 403
// page — said by its status alone, never framed as the hub's words nor
// repeated (a page may echo the request, and the request holds the code);
// and core's own 429, which limits one door, not the code — another address
// is another door.
func notEnrolled(enrollURL string, resp *http.Response, raw []byte) error {
	var e struct {
		Error string `json:"error"`
	}
	stated := json.Unmarshal(raw, &e) == nil && strings.TrimSpace(e.Error) != ""
	switch {
	case stated && resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != http.StatusTooManyRequests:
		return &EnrollRefused{Status: resp.StatusCode, Reason: e.Error}
	case stated:
		return fmt.Errorf("%s answered %d: %s", enrollURL, resp.StatusCode, e.Error)
	default:
		return fmt.Errorf("%s answered %s", enrollURL, resp.Status)
	}
}
