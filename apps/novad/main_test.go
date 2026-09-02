package main

import (
	"encoding/json"
	"testing"
)

// The enroll body carries the machine's home directory so core can suggest it
// as the first fs root (a rootless fs grant is refused there). Every field the
// older contract required is still present — the change is purely additive.
func TestEnrollBodyCarriesTheHomeDir(t *testing.T) {
	raw, err := enrollBody("A1B2C3D4", "ab"+"cd", "laptop", "thinkpad", "/home/jeremy")
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]string
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"code":     "A1B2C3D4",
		"pubkey":   "abcd",
		"name":     "laptop",
		"platform": "linux",
		"hostname": "thinkpad",
		"home_dir": "/home/jeremy",
	}
	for k, v := range want {
		if body[k] != v {
			t.Errorf("enroll body[%q] = %q, want %q", k, body[k], v)
		}
	}
	if len(body) != len(want) {
		t.Errorf("enroll body has %d keys, want %d: %v", len(body), len(want), body)
	}
}
