package client

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// truncate caps by bytes but must never split a rune — a mangled rune in an
// audit summary re-canonicalizes to a different chain hash on core's side and
// logs a spurious device.audit_break.
func TestTruncateNeverSplitsARune(t *testing.T) {
	s := strings.Repeat("界", 200) // U+754C, 3 bytes each -> 600 bytes
	out := truncate(s, 301)       // 301 is not a rune boundary
	if len(out) > 301 {
		t.Fatalf("len %d exceeds the cap", len(out))
	}
	if !utf8.ValidString(out) {
		t.Fatal("truncate produced invalid UTF-8 (split a rune)")
	}
	if len(out) != 300 {
		t.Fatalf("expected a back-off to the 300-byte boundary, got %d", len(out))
	}
	// A string already within the cap is returned whole.
	if got := truncate("ok", 300); got != "ok" {
		t.Errorf("short string changed: %q", got)
	}
}

func TestWSURLDerivation(t *testing.T) {
	cases := []struct {
		server string
		want   string
	}{
		{"https://nova.example", "wss://nova.example/api/v1/devices/ws"},
		{"http://127.0.0.1:8000", "ws://127.0.0.1:8000/api/v1/devices/ws"},
		{"https://host:3000/some/base", "wss://host:3000/api/v1/devices/ws"},
		{"http://box.tailnet.ts.net", "ws://box.tailnet.ts.net/api/v1/devices/ws"},
	}
	for _, c := range cases {
		got, err := WSURL(c.server)
		if err != nil {
			t.Errorf("WSURL(%q) errored: %v", c.server, err)
			continue
		}
		if got != c.want {
			t.Errorf("WSURL(%q) = %q, want %q", c.server, got, c.want)
		}
	}
}

func TestWSURLRefusesAJunkScheme(t *testing.T) {
	if _, err := WSURL("ftp://nope"); err == nil {
		t.Error("a non-http(s)/ws(s) scheme must be refused")
	}
}
