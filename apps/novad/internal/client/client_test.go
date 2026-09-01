package client

import "testing"

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
