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
	"errors"
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

// EnrollRefused is the hub's own refusal — a spent code, a name taken. The
// hub answered, so its words are final: no other address is tried.
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
		// The hub's own reason, verbatim (a spent or expired code, a name taken).
		var e struct {
			Error string `json:"error"`
		}
		reason := strings.TrimSpace(string(raw))
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			reason = e.Error
		}
		return EnrollResult{}, &EnrollRefused{Status: resp.StatusCode, Reason: reason}
	}
	var res EnrollResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return EnrollResult{}, fmt.Errorf("enrollment response was unreadable: %w", err)
	}
	if res.DeviceID == "" || res.CorePubKey == "" {
		return EnrollResult{}, errors.New("enrollment response was missing device_id or core_pubkey")
	}
	return res, nil
}
