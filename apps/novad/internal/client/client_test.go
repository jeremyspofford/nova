package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"novad/internal/facts"
	"novad/internal/platform"
	"novad/internal/state"
	"novad/internal/wire"
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

// I3 (fix round 1): lastUpdate must distinguish "never written"
// (fs.ErrNotExist — nothing to report, (nil, nil)) from any OTHER read
// error (a real failure, returned as (nil, err) rather than silently
// swallowed into the same "nothing to report" shape).
func TestLastUpdateDistinguishesMissingFromAnyOtherReadError(t *testing.T) {
	a := &Agent{}
	a.Configure(Options{StateDir: t.TempDir()})

	u, err := a.lastUpdate()
	if u != nil || err != nil {
		t.Fatalf("a never-written update.json must be (nil, nil), got (%v, %v)", u, err)
	}

	path := filepath.Join(a.opts.StateDir, state.UpdateFile)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	u, err = a.lastUpdate()
	if u != nil || err == nil {
		t.Fatalf("a corrupt update.json must be (nil, a real error), got (%v, %v)", u, err)
	}
}

// factsJSON is the one encoder of every frame that carries facts. It sends
// no list as null — the auth frame's facts included, behind the interface
// wire.Auth holds them in — and keeps novad_pids null where it is unknown.
func TestFactsJSONSendsNoListAsNull(t *testing.T) {
	data, err := factsJSON(wire.Auth{Type: wire.TypeAuth, DeviceID: goldenDeviceID, Sig: "00",
		Facts: struct {
			Later []string `json:"later"`
		}{}})
	if err != nil || !strings.Contains(string(data), `"facts":{"later":[]}`) {
		t.Fatalf("the auth frame: %s, %v", data, err)
	}
	data, err = factsJSON(facts.Frame{Type: "facts", Net: facts.Net{Ifaces: []facts.Iface{{Name: "eth0"}}},
		WSLDistros: &facts.WSLDistros{Distros: []facts.Distro{{Name: "Unknown-Fixture", Running: true}}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"ipv4_cidr":[]`, `"unreadable":[]`, `"novad_pids":null`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("no %s on the wire: %s", want, data)
		}
	}
}

// fix/facts-unreadable-null, and PR #110's review of it: the bytes
// frameBytes sends carry no list as null, whatever it is handed — the real
// facts.Probe's output on each branch a FakeRunner drives here, a gathered
// frame and a probe with every list nil (only factsJSON stands between
// those and the wire), and findings over the cap, which take the other
// encoding. novad_pids stays null exactly where the probe left it unknown,
// and the probe the agent keeps, carried in every later frame, is never
// changed by being sent.
func TestFrameBytesSendsNoListAsNull(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	agent, _ := buildAgent(t, "http://unused.invalid", "dev-nulls-1", hex.EncodeToString(corePub), devPriv)

	gathers := []struct {
		name   string
		gather func([]facts.Unreadable) facts.Frame
	}{
		{"hermeticFrame", hermeticFrame},
		{"every list nil", func([]facts.Unreadable) facts.Frame {
			return facts.Frame{Type: "facts", Net: facts.Net{Ifaces: []facts.Iface{{Name: "eth0", MAC: "02:00:00:00:00:01"}}}}
		}},
		{"no interface list", func([]facts.Unreadable) facts.Frame { return facts.Frame{Type: "facts"} }},
	}

	// The real probe, as Configure runs it: facts.Probe through a FakeRunner.
	self := facts.Self{Binary: filepath.Join(t.TempDir(), "novad"), Config: filepath.Join(t.TempDir(), "config.json")}
	hold := make(chan struct{}) // a sudo deaf to its ctx, until the test ends
	t.Cleanup(func() { close(hold) })
	probe := func(r platform.Runner, bound time.Duration) facts.Probed {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		switch {
		case bound > 0:
			var stop context.CancelFunc
			ctx, stop = context.WithTimeout(ctx, bound)
			defer stop()
		case bound < 0:
			cancel()
		}
		return facts.Probe(ctx, r, self)
	}
	answered := probe(&platform.FakeRunner{Outputs: map[string]string{"sudo": ""}}, 0)
	refused := probe(&platform.FakeRunner{Errs: map[string]error{"sudo": errors.New("sudo: a password is required")}}, 0)
	noAnswer := probe(&platform.FakeRunner{Hold: hold}, 150*time.Millisecond)
	noTime := probe(&platform.FakeRunner{}, -1)
	long := strings.Repeat("x", 255)

	probes := []struct {
		name    string
		probed  func() *facts.Probed // a fresh one each call; nil: no probe yet
		overCap bool
	}{
		{"no probe yet", func() *facts.Probed { return nil }, false},
		{"Probe: sudo answers", func() *facts.Probed { p := answered; return &p }, false},
		{"Probe: sudo refuses", func() *facts.Probed { p := refused; return &p }, false},
		{"Probe: sudo gives no answer", func() *facts.Probed { p := noAnswer; return &p }, false},
		{"Probe: nothing had time to start", func() *facts.Probed { p := noTime; return &p }, false},
		{"a probe with every list nil", func() *facts.Probed {
			return &facts.Probed{At: goldenAt, Elevation: &facts.Elevation{Sudo: "unknown"},
				WSL: &facts.WSLDistros{Distros: []facts.Distro{{Name: "Unknown-Fixture", Running: true}, {Name: "Stopped-Fixture", PIDs: []int{}}}}}
		}, false},
		{"a probe with no distribution list", func() *facts.Probed { return &facts.Probed{At: goldenAt, WSL: &facts.WSLDistros{}} }, false},
		{"findings over the cap", func() *facts.Probed {
			distros := make([]facts.Distro, 8)
			for i := range distros {
				distros[i] = facts.Distro{Name: string(rune('a'+i)) + long[1:], Running: true, PID1: long, User: long, SudoSaid: long,
					Unit: &facts.Unit{Active: long, File: long, Restart: long, Said: long}}
			}
			return &facts.Probed{At: goldenAt, Service: facts.Service{Name: long, Binary: long, Config: long},
				WSL: &facts.WSLDistros{Distros: distros}}
		}, true},
	}
	for _, g := range gathers {
		for _, p := range probes {
			what := p.name + ", gathered " + g.name
			agent.gatherFrame = g.gather
			agent.probed = p.probed()
			data, err := agent.frameBytes()
			if err != nil {
				t.Errorf("%s: %v", what, err)
				continue
			}
			var got facts.Frame
			if err := json.Unmarshal(data, &got); err != nil {
				t.Errorf("%s: %v: %s", what, err, data)
				continue
			}
			if nulls := facts.NullLists(got); len(nulls) > 0 {
				t.Errorf("%s: a list crossed the wire as null at %s: %s", what, strings.Join(nulls, ", "), data)
			}
			if agent.probed == nil {
				continue
			}
			if carried := got.ProbedAt != ""; carried == p.overCap {
				t.Errorf("%s: the findings were carried %v, over the cap %v: %s", what, carried, p.overCap, data)
			}
			if want := p.probed(); !reflect.DeepEqual(*agent.probed, *want) {
				t.Errorf("%s: sending it changed the probe the agent keeps:\n got %+v\nwant %+v", what, *agent.probed, *want)
			}
			if w := agent.probed.WSL; w != nil && got.WSLDistros != nil {
				for i, d := range w.Distros {
					if (got.WSLDistros.Distros[i].PIDs == nil) != (d.PIDs == nil) {
						t.Errorf("%s: novad_pids is null on the wire only where it is unknown, got %#v for %#v: %s",
							what, got.WSLDistros.Distros[i].PIDs, d.PIDs, data)
					}
				}
			}
		}
	}
}
