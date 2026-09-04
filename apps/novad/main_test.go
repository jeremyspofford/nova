package main

import (
	"encoding/json"
	"testing"
)

// The enroll body is identity only: the pairing code plus what this machine
// will be known by. There is no per-device grant, root or home_dir to seed on
// core's side — a paired device runs whatever core signs. A field added here
// would be the first step back toward a settings row core has to approve, so
// the exact key set is pinned.
func TestEnrollBodyCarriesIdentityOnly(t *testing.T) {
	raw, err := enrollBody("A1B2C3D4", "ab"+"cd", "laptop", "thinkpad")
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
	}
	for k, v := range want {
		if body[k] != v {
			t.Errorf("enroll body[%q] = %q, want %q", k, body[k], v)
		}
	}
	if len(body) != len(want) {
		t.Errorf("enroll body has %d keys, want %d: %v", len(body), len(want), body)
	}
	if _, present := body["home_dir"]; present {
		t.Error("home_dir is gone with the fs-roots suggestion it fed; the enroll body must not carry it")
	}
}
