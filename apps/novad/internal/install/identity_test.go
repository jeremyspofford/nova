package install

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"novad/internal/client"
	"novad/internal/config"
)

const core = "ab"

func paths(t *testing.T) config.Paths {
	t.Helper()
	home := t.TempDir()
	return config.Paths{
		ConfigDir: filepath.Join(home, "cfg"), StateDir: filepath.Join(home, "state"),
		ConfigFile: filepath.Join(home, "cfg", "config.json"), KeyFile: filepath.Join(home, "cfg", "key"),
		AuditFile: filepath.Join(home, "state", "audit.jsonl"), Home: home,
	}
}

func enrolled(t *testing.T, p config.Paths, hubs ...string) {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	cfg := config.Config{DeviceID: "d-old", Name: "laptop", Server: hubs[0], CorePubKey: strings.Repeat(core, 32), Locators: hubs}
	if err := config.Save(p, cfg, priv); err != nil {
		t.Fatal(err)
	}
}

type enrollCall struct{ hub, code, name string }

func opts(t *testing.T, p config.Paths, verify error, enroll func(hub string) (EnrollResult, error)) (*Options, *[]enrollCall) {
	t.Helper()
	var calls []enrollCall
	return &Options{
		Hubs:  []string{"http://127.0.0.1:3000", "https://nova.fake-tailnet.ts.net"},
		Paths: p, Now: func() time.Time { return time.Unix(1_790_000_000, 0) },
		Verify: func(context.Context, config.Config, ed25519.PrivateKey) error { return verify },
		Enroll: func(_ context.Context, hub, code, name, _ string, _ ed25519.PublicKey) (EnrollResult, error) {
			calls = append(calls, enrollCall{hub, code, name})
			return enroll(hub)
		},
		Name: "laptop",
	}, &calls
}

func okEnroll(repaired bool) func(string) (EnrollResult, error) {
	return func(string) (EnrollResult, error) {
		return EnrollResult{DeviceID: "d-new", Name: "laptop", CorePubKey: strings.Repeat(core, 32), Repaired: repaired}, nil
	}
}

func TestANewMachineWithoutACodeNeedsACode(t *testing.T) {
	o, _ := opts(t, paths(t), nil, okEnroll(false))
	if _, _, err := o.identity(context.Background()); !errors.Is(err, ErrNeedsCode) {
		t.Fatalf("got %v, want ErrNeedsCode", err)
	}
}

func TestANewMachinePairsWithTheCodeAndPinsTheCoreKey(t *testing.T) {
	p := paths(t)
	o, calls := opts(t, p, nil, okEnroll(false))
	o.Code = "ABCD-2345"
	cfg, notes, err := o.identity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0] != (enrollCall{"http://127.0.0.1:3000", "ABCD-2345", "laptop"}) {
		t.Fatalf("enroll calls %+v", *calls)
	}
	back, _, err := config.Load(p)
	if err != nil || back.DeviceID != "d-new" || back.CorePubKey != strings.Repeat(core, 32) ||
		strings.Join(back.Locators, ",") != strings.Join(o.Hubs, ",") || back.Server != "http://127.0.0.1:3000" {
		t.Fatalf("saved %+v, %v", back, err)
	}
	if cfg.DeviceID != "d-new" || !strings.Contains(strings.Join(notes, "\n"), `paired as "laptop"`) {
		t.Fatalf("cfg %+v notes %v", cfg, notes)
	}
}

func TestAPairingAHubStillKnowsIsKeptAndTheCodeLeftUnused(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "https://nova.fake-tailnet.ts.net")
	o, calls := opts(t, p, nil, okEnroll(false))
	o.Code = "ABCD-2345"
	cfg, notes, err := o.identity(context.Background())
	if err != nil || cfg.DeviceID != "d-old" || len(*calls) != 0 {
		t.Fatalf("cfg %+v calls %v err %v", cfg, *calls, err)
	}
	if !strings.Contains(strings.Join(notes, "\n"), "the pairing code was not used") {
		t.Fatalf("notes %v", notes)
	}
}

// Decision 4: a pairing no hub knows is set aside (never deleted) and the
// re-pair code rebinds the machine's row.
func TestAPairingEveryHubDisownsIsSetAsideAndReplacedWithTheCode(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "https://nova.fake-tailnet.ts.net")
	o, calls := opts(t, p, &client.RefusedError{Server: "x", Reason: "revoked"}, okEnroll(true))
	o.Code = "ABCD-2345"
	cfg, notes, err := o.identity(context.Background())
	if err != nil || cfg.DeviceID != "d-new" || len(*calls) != 1 {
		t.Fatalf("cfg %+v calls %v err %v", cfg, *calls, err)
	}
	if _, err := os.Stat(p.ConfigFile + ".replaced-1790000000"); err != nil {
		t.Fatalf("the old pairing was not set aside: %v", err)
	}
	if !strings.Contains(strings.Join(notes, "\n"), "re-paired as \"laptop\" — its name and history kept") {
		t.Fatalf("notes %v", notes)
	}
}

func TestAPairingEveryHubDisownsWithoutACodeNeedsACode(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "https://nova.fake-tailnet.ts.net")
	o, _ := opts(t, p, &client.KeyMismatch{Presented: "x", Pinned: "y"}, okEnroll(false))
	if _, _, err := o.identity(context.Background()); !errors.Is(err, ErrNeedsCode) || !strings.Contains(err.Error(), "no longer knows") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(p.ConfigFile); err != nil {
		t.Fatal("without a code, nothing is set aside")
	}
}

// A hub that did not answer proves nothing about the pairing: it is kept.
func TestAnUnreachableHubKeepsThePairing(t *testing.T) {
	p := paths(t)
	enrolled(t, p, "https://nova.fake-tailnet.ts.net")
	o, calls := opts(t, p, errors.New("dial tcp: connection refused"), okEnroll(false))
	o.Code = "ABCD-2345"
	cfg, notes, err := o.identity(context.Background())
	if err != nil || cfg.DeviceID != "d-old" || len(*calls) != 0 || !strings.Contains(strings.Join(notes, "\n"), "could not reach Nova to check") {
		t.Fatalf("cfg %+v calls %v notes %v err %v", cfg, *calls, notes, err)
	}
}

func TestTheHubsRefusalOfTheCodeIsFinal(t *testing.T) {
	o, calls := opts(t, paths(t), nil, func(string) (EnrollResult, error) {
		return EnrollResult{}, &EnrollRefused{Status: 403, Reason: "that pairing code is not usable"}
	})
	o.Code = "ABCD-2345"
	_, _, err := o.identity(context.Background())
	var refused *EnrollRefused
	if !errors.As(err, &refused) || len(*calls) != 1 {
		t.Fatalf("err %v calls %v — a refusal is the hub's word, never retried on another address", err, *calls)
	}
}

func TestAHubThatDoesNotAnswerFallsThroughToTheNext(t *testing.T) {
	o, calls := opts(t, paths(t), nil, func(hub string) (EnrollResult, error) {
		if strings.HasPrefix(hub, "http://127.0.0.1") {
			return EnrollResult{}, errors.New("connection refused")
		}
		return okEnroll(false)(hub)
	})
	o.Code = "ABCD-2345"
	cfg, _, err := o.identity(context.Background())
	if err != nil || cfg.Server != "https://nova.fake-tailnet.ts.net" || len(*calls) != 2 {
		t.Fatalf("cfg %+v calls %v err %v", cfg, *calls, err)
	}
}

func TestAnOrphanedAuditLogIsSetAsideBeforeAFreshPairing(t *testing.T) {
	p := paths(t)
	if err := os.MkdirAll(p.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.AuditFile, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	o, _ := opts(t, p, nil, okEnroll(false))
	o.Code = "ABCD-2345"
	if _, _, err := o.identity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.AuditFile); err == nil {
		t.Fatal("an old chain would replay under the new device's id")
	}
}

func TestPlainHTTPIsOnlyForThisMachinesLoopback(t *testing.T) {
	if err := checkHubs([]string{"http://127.0.0.1:3000", "http://localhost:3000", "https://nova.fake-tailnet.ts.net"}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"http://nova.example", "http://192.0.2.10:3000", "ftp://nova.example"} {
		if err := checkHubs([]string{bad}); err == nil {
			t.Errorf("%s was accepted — the core link is verified TLS or this machine's loopback (D6)", bad)
		}
	}
}

// F14 (controller ruling): an old audit log that cannot be set aside stops a
// fresh pairing before the code is spent — pairing on top of it would replay
// the old chain under the new device's id, and a swallowed failure would
// report a clean start that did not happen. The failure here is a real one
// on every OS: the log's name sits at the filesystem's 255-byte component
// limit, so no set-aside name (<name>.orphaned-<unix>) can exist beside it.
func TestAnOrphanedAuditLogThatCannotBeSetAsideStopsThePairing(t *testing.T) {
	p := paths(t)
	p.AuditFile = filepath.Join(p.StateDir, strings.Repeat("a", 250))
	if err := os.MkdirAll(p.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.AuditFile, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	o, calls := opts(t, p, nil, okEnroll(false))
	o.Code = "ABCD-2345"
	_, _, err := o.identity(context.Background())
	if err == nil || !strings.HasPrefix(err.Error(), "cannot pair: the old audit log could not be set aside") {
		t.Fatalf("got %v", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("the code was spent on a pairing that cannot start clean: %+v", *calls)
	}
	if _, err := os.Stat(p.ConfigFile); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a pairing was saved anyway: %v", err)
	}
	if _, err := os.Stat(p.AuditFile); err != nil {
		t.Fatalf("the old audit log must stay exactly where it was: %v", err)
	}
}

// Task 32, L225 + L243: the orphaned-audit-log set-aside says what it moved
// before it failed, too. A stray key with no config is not a pairing, so it
// goes aside with the old log; the log's name leaves no room for a set-aside
// name, so the key moves and the log does not.
func TestAnOrphanSetAsideThatFailsPartwaySaysWhatItMoved(t *testing.T) {
	p := paths(t)
	p.AuditFile = filepath.Join(p.StateDir, strings.Repeat("a", 250))
	for _, dir := range []string{p.StateDir, p.ConfigDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(p.AuditFile, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.KeyFile, []byte(strings.Repeat(core, 32)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	o, calls := opts(t, p, nil, okEnroll(false))
	o.Code = "ABCD-2345"
	_, notes, err := o.identity(context.Background())
	if err == nil || !strings.HasPrefix(err.Error(), "cannot pair: the old audit log could not be set aside") || len(*calls) != 0 {
		t.Fatalf("err %v calls %+v", err, *calls)
	}
	moved := p.KeyFile + ".orphaned-1790000000"
	if _, serr := os.Stat(moved); serr != nil {
		t.Fatalf("the setup did not move the key: %v", serr)
	}
	if !strings.Contains(strings.Join(notes, "\n"), moved) {
		t.Fatalf("%s was set aside and not said: %v", moved, notes)
	}
}

// A pairing that names no address was asked of no hub, so nothing proves it
// dead: it is never set aside on that, and install says what it needs.
func TestAPairingThatNamesNoAddressIsNeverSetAside(t *testing.T) {
	p := paths(t)
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if err := config.Save(p, config.Config{DeviceID: "d-old", Name: "laptop", CorePubKey: strings.Repeat(core, 32)}, priv); err != nil {
		t.Fatal(err)
	}
	o, calls := opts(t, p, nil, okEnroll(true))
	o.Hubs = nil
	o.Code = "ABCD-2345"
	_, _, err := o.identity(context.Background())
	if err == nil || !strings.Contains(err.Error(), "--hub") || len(*calls) != 0 {
		t.Fatalf("err %v calls %+v", err, *calls)
	}
	if _, err := os.Stat(p.ConfigFile); err != nil {
		t.Fatalf("a pairing no hub was asked about was set aside: %v", err)
	}
}

// F2 (controller ruling, P11): `install --restart-later` runs inside the old
// agent's own shell.exec. A second authenticated socket as the same device
// would make core's hub fail that in-flight command, so a trusted pairing is
// kept without dialing any hub. The hub here counts every TCP connection it
// accepts, and the verifier is the real one; the control run proves this same
// setup DOES dial it when the pairing is not trusted.
func TestATrustedPairingIsKeptWithoutDialingAnyHub(t *testing.T) {
	var dials atomic.Int32
	hub := httptest.NewUnstartedServer(http.NotFoundHandler())
	hub.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			dials.Add(1)
		}
	}
	hub.Start()
	t.Cleanup(hub.Close)

	p := paths(t)
	enrolled(t, p, hub.URL)
	o, calls := opts(t, p, nil, okEnroll(false))
	o.Hubs = nil // P11's bootstrap passes no --hub: the pairing's own addresses are the hubs
	o.Verify = client.VerifyServer
	o.Code = "ABCD-2345"
	o.TrustPairing = true
	cfg, notes, err := o.identity(context.Background())
	if err != nil || cfg.DeviceID != "d-old" || len(*calls) != 0 {
		t.Fatalf("cfg %+v calls %+v err %v", cfg, *calls, err)
	}
	if n := dials.Load(); n != 0 {
		t.Fatalf("a trusted pairing dialed the hub %d time(s)", n)
	}
	joined := strings.Join(notes, "\n")
	if !strings.Contains(joined, "without asking Nova") || !strings.Contains(joined, "the pairing code was not used") {
		t.Fatalf("the notes must say the pairing was not checked: %v", notes)
	}
	if back, _, err := config.Load(p); err != nil || back.DeviceID != "d-old" {
		t.Fatalf("the pairing on disk is not the one it ran under: %+v, %v", back, err)
	}

	o.TrustPairing = false
	if _, _, err := o.identity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if dials.Load() == 0 {
		t.Fatal("the control never dialed the hub, so the check above proves nothing")
	}
}
