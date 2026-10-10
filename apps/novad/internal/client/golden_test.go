package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"novad/internal/caps"
	"novad/internal/facts"
	"novad/internal/service"
)

// The frames the agent sends, as core receives them, are the facts' contract
// between the two languages — the way testdata/manifest_golden.json (core
// signs, novad's CheckManifest reads; services/core/tests/fixtures/
// gen_manifest_golden.py) is the manifest's, the other way round:
//
//   - this test captures the auth frame and the facts frame off a real
//     socket, byte for byte as the agent wrote them, and fails when a
//     committed golden under testdata/ is not what the agent sends now;
//   - core's suite (services/core/tests/test_device_facts.py) feeds each
//     golden through device_facts.validate_auth / validate_frame, and fails
//     when one is refused or a section is missing.
//
// Build 8a2c15dab611 sent "unreadable": null in every facts frame that
// carried a probe and had nothing unreadable — the healthy case — and core
// dropped the whole frame for it. No test crossed this boundary with that
// frame, so both suites stayed green (fix/facts-unreadable-null).
//
// What this test checks, exactly. The VALUES are fixtures: goldenAuth,
// goldenFrame and goldenProbe stand in for GatherAuth, GatherFrame and
// Probe, so no builder runs here. What is real is everything from them to
// the socket: the handshake, frameBytes, Probed.ApplyTo and factsJSON, the
// one encoder of both frames (facts.Marshal inside it). So it fails when a
// golden is stale, or when a list in one of these three frames crossed the
// wire as null; a list a builder leaves nil it cannot see, since no builder
// made these values (PR #110's review). That a builder leaves none is
// facts' TestNoBuilderLeavesAListNil, over each builder's real output,
// branch by branch; that frameBytes sends none whatever it is handed is
// TestFrameBytesSendsNoListAsNull, in client_test.go.
//
// When this test says a golden is stale, the agent's frames moved. Rewrite
// them with
//
//	go test ./internal/client -run TestTheFramesTheAgentSendsAreTheGoldenFilesCoreReads -update
//
// and run core's suite: it is core's test that says whether core still
// accepts what the agent now sends. Never rewrite them to quiet core.
//
// Every value is a fixture — keys from fixed seeds, TEST-NET addresses,
// locally administered MACs, a made-up account — never this machine's.
var updateGolden = flag.Bool("update", false, "rewrite testdata/*_golden.json from the frames the agent sends now")

// What the fake core and the agent hold: throwaway keys from fixed seeds,
// so the auth frame's signature is the same on every run.
var (
	goldenDevicePriv = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x11}, ed25519.SeedSize))
	goldenCorePriv   = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x22}, ed25519.SeedSize))
	goldenNonce      = hex.EncodeToString(bytes.Repeat([]byte{0x5a}, 32))
)

const (
	goldenDeviceID = "00000000-0000-4000-8000-0000000000f1"
	goldenVersion  = "0123456789ab"
	goldenHome     = `C:\Users\fixture`
)

var goldenAt = time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)

// goldenAuth is a Windows agent under its Run key that last applied an
// update: every key validate_auth reads.
func goldenAuth() facts.Auth {
	return facts.Auth{
		V: facts.Version,
		Agent: facts.AgentInfo{Version: goldenVersion, Mode: service.ModeRunKey, SessionInteractive: true,
			Update: &facts.UpdateFact{Version: goldenVersion, Outcome: "applied", Reason: "", At: goldenAt.Format(time.RFC3339)}},
		OS:         facts.OSInfo{GOOS: "windows", Arch: "amd64", Version: "Windows 11 Pro 24H2 (build 26100)"},
		Hostname:   "FIXTURE-PC",
		MachineUID: strings.Repeat("0123456789abcdef", 4),
	}
}

// goldenFrame is facts.GatherFrame's shape with fixture values (this
// package's tests never read the host's own; hermeticFrame): the carried
// entries first, then what it could not read itself. A folder in `unread`
// is filed unreadable and left out of folders, as GatherFrame does.
func goldenFrame(unread ...facts.Unreadable) func([]facts.Unreadable) facts.Frame {
	return func(carried []facts.Unreadable) facts.Frame {
		f := facts.Frame{Type: "facts",
			Net: facts.Net{Ifaces: []facts.Iface{
				{Name: "Ethernet", MAC: "02:00:00:00:00:01", IPv4CIDR: []string{"192.0.2.10/24"}, Up: true},
				{Name: "Wi-Fi", MAC: "02:00:00:00:00:02", IPv4CIDR: []string{}, Up: false},
			}},
			Folders: map[string]string{
				"home":      goldenHome,
				"desktop":   goldenHome + `\Desktop`,
				"documents": goldenHome + `\Documents`,
				"downloads": goldenHome + `\Downloads`,
			},
			Unreadable: append([]facts.Unreadable{}, carried...),
		}
		for _, u := range unread {
			delete(f.Folders, strings.TrimPrefix(u.Item, "folders."))
			f.Unreadable = append(f.Unreadable, u)
		}
		return f
	}
}

// goldenProbe is one run of the probes on that agent: how it runs, what
// elevating would meet, and two distributions beside it — one running and
// looked inside, one stopped (novad_pids [], known to be none).
func goldenProbe() facts.Probed {
	admin := true
	return facts.Probed{
		At: goldenAt,
		Service: facts.Service{
			Name:          `HKCU\` + service.RunKeyPath + `\` + service.RunKeyValue,
			Binary:        goldenHome + `\AppData\Local\Programs\Nova\novad.exe`,
			Config:        goldenHome + `\AppData\Roaming\novad\config.json`,
			Process:       "novad.exe",
			PID:           4321,
			SupervisorPID: 4300,
			User:          `FIXTURE-PC\fixture`,
		},
		Elevation: &facts.Elevation{Elevated: false, Admin: &admin, Sudo: "off"},
		WSL: &facts.WSLDistros{Distros: []facts.Distro{
			{Name: "Ubuntu-Fixture", Default: true, Version: 2, Running: true, Looked: true, PID1: "systemd",
				User: "fixture", Sudo: "no_password", Root: true,
				Unit: &facts.Unit{Active: "active", File: "enabled", Restart: "always", MainPID: 412}, PIDs: []int{412}},
			{Name: "Stopped-Fixture", Version: 2, PIDs: []int{}},
		}},
	}
}

// goldenProbeWithUnreadable is a probe that could not read everything: a
// running distribution whose look printed no answer — novad_pids null,
// unknown — and the elevation it could not read.
func goldenProbeWithUnreadable() facts.Probed {
	p := goldenProbe()
	p.Elevation = &facts.Elevation{Elevated: false, Sudo: "unknown", SudoSaid: "the sudo setting could not be read: fixture"}
	p.WSL.Distros[0] = facts.Distro{Name: "Ubuntu-Fixture", Default: true, Version: 2, Running: true}
	p.Unreadable = []facts.Unreadable{
		{Item: "elevation", Reason: "reading whether this account is in Administrators: fixture"},
		{Item: "wsl_distros.Ubuntu-Fixture", Reason: "the look printed no answer"},
	}
	return p
}

// sentAtConnect runs an agent — built by buildAgent, then set by `set` —
// against a fake core that answers its handshake with a fixed nonce, and
// returns the auth frame and the facts frame that follows ready, byte for
// byte as they crossed the socket.
func sentAtConnect(t *testing.T, set func(*Agent)) (auth, frame []byte) {
	t.Helper()
	type got struct{ auth, frame []byte }
	ch := make(chan got, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		corePub := goldenCorePriv.Public().(ed25519.PublicKey)
		if coreWrite(ctx, c, map[string]any{"type": "challenge", "nonce": goldenNonce, "core_pubkey": hex.EncodeToString(corePub)}) != nil {
			return
		}
		_, a, err := c.Read(ctx)
		if err != nil || coreWrite(ctx, c, map[string]any{"type": "ready", "last_seq": nil}) != nil {
			return
		}
		_, f, err := c.Read(ctx)
		if err != nil {
			return
		}
		select {
		case ch <- got{a, f}:
		default:
		}
		// Read on until the agent leaves (the test's end): a hijacked
		// socket's ctx is not cancelled when the peer closes it.
		for {
			if _, _, err := c.Read(ctx); err != nil {
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	corePub := goldenCorePriv.Public().(ed25519.PublicKey)
	agent, _ := buildAgent(t, srv.URL, goldenDeviceID, hex.EncodeToString(corePub), goldenDevicePriv)
	set(agent)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	select {
	case g := <-ch:
		return g.auth, g.frame
	case <-ctx.Done():
		t.Fatal("the fake core never saw an auth frame and a facts frame")
		return nil, nil
	}
}

// authFrame decodes the auth frame with its facts typed, so the checks
// below read facts.Auth's own fields.
type authFrame struct {
	Type     string     `json:"type"`
	DeviceID string     `json:"device_id"`
	Sig      string     `json:"sig"`
	Facts    facts.Auth `json:"facts"`
}

// matchesGolden fails when testdata/<name> is not what the agent sent —
// indented, a whitespace-only change that keeps every byte of every value —
// and, with -update, writes it first.
func matchesGolden(t *testing.T, name string, sent []byte) {
	t.Helper()
	var want bytes.Buffer
	if err := json.Indent(&want, sent, "", "  "); err != nil {
		t.Fatalf("%s: the agent sent what is not JSON: %v", name, err)
	}
	want.WriteByte('\n')
	path := filepath.Join("testdata", name)
	if *updateGolden {
		if err := os.WriteFile(path, want.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	committed, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v — write it with -update (see this file's top)", path, err)
	}
	// A checkout that turned LF into CRLF (Windows, core.autocrlf) is the
	// same golden, not a stale one.
	committed = bytes.ReplaceAll(committed, []byte("\r\n"), []byte("\n"))
	if !bytes.Equal(committed, want.Bytes()) {
		t.Errorf("%s is stale — the agent now sends:\n%s\nrewrite it with -update and run core's suite (see this file's top)",
			path, want.Bytes())
	}
}

func TestTheFramesTheAgentSendsAreTheGoldenFilesCoreReads(t *testing.T) {
	// Healthy: a probe in hand, and nothing anywhere it could not read — the
	// frame build 8a2c15dab611 sent with "unreadable": null.
	authSent, healthy := sentAtConnect(t, func(a *Agent) {
		a.gatherAuth = func(context.Context) (facts.Auth, []facts.Unreadable) { return goldenAuth(), nil }
		a.gatherFrame = goldenFrame()
		p := goldenProbe()
		a.probed = &p
	})
	// Unreadable: something from each source — the auth gather (carried),
	// the frame's own gather, and the probe.
	_, unreadable := sentAtConnect(t, func(a *Agent) {
		a.gatherAuth = func(context.Context) (facts.Auth, []facts.Unreadable) {
			auth := goldenAuth()
			auth.MachineUID = ""
			return auth, []facts.Unreadable{{Item: "machine_uid", Reason: "the machine id could not be read: fixture"}}
		}
		a.gatherFrame = goldenFrame(facts.Unreadable{Item: "folders.desktop", Reason: "this machine names no desktop folder"})
		p := goldenProbeWithUnreadable()
		a.probed = &p
	})

	for _, g := range []struct {
		file string
		sent []byte
		into any
	}{
		{"auth_golden.json", authSent, &authFrame{}},
		{"facts_healthy_golden.json", healthy, &facts.Frame{}},
		{"facts_unreadable_golden.json", unreadable, &facts.Frame{}},
	} {
		if err := json.Unmarshal(g.sent, g.into); err != nil {
			t.Fatalf("%s: %v", g.file, err)
		}
		// Null only where the agent means it (facts.NullsOnPurpose): core's
		// validators read a list, and before fix/facts-unreadable-null refused
		// the whole frame over a null one. Read off the bytes themselves.
		if stray, err := facts.StrayNulls(g.sent); err != nil || len(stray) > 0 {
			t.Errorf("%s: null where nothing means null, at %s (%v): %s", g.file, strings.Join(stray, ", "), err, g.sent)
		}
		matchesGolden(t, g.file, g.sent)
	}

	// The goldens hold what they say they hold.
	var h, u facts.Frame
	_ = json.Unmarshal(healthy, &h)
	_ = json.Unmarshal(unreadable, &u)
	if h.Service == nil || h.Elevation == nil || h.WSLDistros == nil || h.ProbedAt == "" || len(h.Folders) != 4 || len(h.Unreadable) != 0 {
		t.Errorf("the healthy frame is not a probe with nothing unreadable: %s", healthy)
	}
	items := map[string]bool{}
	for _, e := range u.Unreadable {
		items[e.Item] = true
	}
	if !items["machine_uid"] || !items["folders.desktop"] || !items["wsl_distros.Ubuntu-Fixture"] || u.ProbedAt == "" {
		t.Errorf("the unreadable frame does not carry an entry from each source: %s", unreadable)
	}
	if u.WSLDistros == nil || u.WSLDistros.Distros[0].PIDs != nil || u.WSLDistros.Distros[1].PIDs == nil {
		t.Errorf("novad_pids must be null where unknown and [] where none: %s", unreadable)
	}
}

// S30a T1: the result frame resultFrame builds from a dispatched outcome —
// the frame handleCommand writes — byte for byte as core receives it.
// C1: an outcome with Meta yields a frame whose meta equals it.
// C2: an outcome without Meta yields today's frame (result_ok_golden.json and
// result_refused_golden.json, captured before Meta existed), with no meta key.
// result_meta_golden.json does not exist until Meta crosses the wire; write it
// with -update (see this file's top) and run core's test_devices_ws.
func TestAnOutcomesMetaReachesTheResultFrame(t *testing.T) {
	code := 0
	meta := map[string]any{"matches": 1, "bytes_before": 10, "bytes_after": 12}
	b, err := json.Marshal(resultFrame("00000000-0000-4000-8000-0000000000e3", caps.Outcome{OK: true, Output: "edited", ExitCode: &code, Meta: meta}))
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Meta map[string]any `json:"meta"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.Meta == nil || got.Meta["matches"] != float64(1) || got.Meta["bytes_before"] != float64(10) || got.Meta["bytes_after"] != float64(12) {
		t.Fatalf("the outcome's meta did not reach the result frame: %s", b)
	}
	// core's test_devices_ws reads this golden through its socket and
	// expects meta to reach the awaiting command unchanged.
	matchesGolden(t, "result_meta_golden.json", b)
}

func TestAnOutcomeWithoutMetaIsTheGoldenResultFrame(t *testing.T) {
	code := 0
	ok, err := json.Marshal(resultFrame("00000000-0000-4000-8000-0000000000e1", caps.Outcome{OK: true, Output: "hello", ExitCode: &code}))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ok, []byte(`"meta"`)) {
		t.Errorf("a frame without meta carries a meta key: %s", ok)
	}
	matchesGolden(t, "result_ok_golden.json", ok)
	refused, err := json.Marshal(resultFrame("00000000-0000-4000-8000-0000000000e2", caps.Outcome{OK: false, Error: "unknown capability \"fs.edit\""}))
	if err != nil {
		t.Fatal(err)
	}
	matchesGolden(t, "result_refused_golden.json", refused)
}
