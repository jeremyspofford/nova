package main

// `novad repoint` (design-verdict §11). Every case here asserts TWO things:
// what repoint returned, and what is on disk afterwards — because the whole
// point of the verb is that a failed proof leaves the enrolment exactly as it
// was, and "it printed an error" is not the same claim as "it wrote nothing".

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"novad/internal/config"
)

// ── a fake core, one socket, whatever shape the case needs ──────────────────

type fakeCore struct {
	srv *httptest.Server
	// dials counts websocket handshakes that REACHED the device socket, so a
	// case can assert that nothing was dialled at all.
	dials atomic.Int32
	// authed records whether the device's signature verified over the RAW
	// nonce bytes with the device's public key.
	authed atomic.Bool
}

type coreBehaviour struct {
	presentKey   string // core_pubkey to send; "" means the pinned one
	nonChallenge bool   // open with something that is not a challenge
	refuseAuth   string // non-empty: answer auth with auth_error{reason}
}

func newFakeCore(t *testing.T, corePubHex string, devPub ed25519.PublicKey, b coreBehaviour) *fakeCore {
	t.Helper()
	fc := &fakeCore{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		fc.dials.Add(1)
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()

		if b.nonChallenge {
			_ = coreWrite(ctx, c, map[string]any{"type": "ready", "last_seq": nil})
			return
		}

		nonce := make([]byte, 32)
		_, _ = rand.Read(nonce)
		key := b.presentKey
		if key == "" {
			key = corePubHex
		}
		_ = coreWrite(ctx, c, map[string]any{
			"type": "challenge", "nonce": hex.EncodeToString(nonce), "core_pubkey": key,
		})

		auth, err := coreRead(ctx, c)
		if err != nil {
			return
		}
		sig, _ := hex.DecodeString(stringField(auth, "sig"))
		fc.authed.Store(ed25519.Verify(devPub, nonce, sig))

		if b.refuseAuth != "" {
			_ = coreWrite(ctx, c, map[string]any{"type": "auth_error", "reason": b.refuseAuth})
			return
		}
		_ = coreWrite(ctx, c, map[string]any{"type": "ready", "last_seq": nil})
		// Hold the socket open briefly so repoint's clean close is the thing
		// that ends it, not the handler returning first.
		time.Sleep(200 * time.Millisecond)
	})
	fc.srv = httptest.NewServer(mux)
	t.Cleanup(fc.srv.Close)
	return fc
}

func coreWrite(ctx context.Context, c *websocket.Conn, v any) error {
	data, _ := json.Marshal(v)
	return c.Write(ctx, websocket.MessageText, data)
}

func coreRead(ctx context.Context, c *websocket.Conn) (map[string]any, error) {
	_, data, err := c.Read(ctx)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return m, nil
}

func stringField(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

// ── custody: a real enrolment on disk, and a way to prove it did not move ───

type enrolment struct {
	paths      config.Paths
	devPub     ed25519.PublicKey
	corePubHex string
	oldServer  string
}

func newEnrolment(t *testing.T, oldServer string) enrolment {
	t.Helper()
	home := t.TempDir()
	paths := config.Paths{
		ConfigDir:  filepath.Join(home, ".config", "novad"),
		StateDir:   filepath.Join(home, ".local", "state", "novad"),
		ConfigFile: filepath.Join(home, ".config", "novad", "config.json"),
		KeyFile:    filepath.Join(home, ".config", "novad", "key"),
		AuditFile:  filepath.Join(home, ".local", "state", "novad", "audit.jsonl"),
		Home:       home,
	}
	corePub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	devPub, devPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		DeviceID:   "dev-repoint-1",
		Name:       "workshop-laptop",
		Server:     oldServer,
		CorePubKey: hex.EncodeToString(corePub),
	}
	if err := config.Save(paths, cfg, devPriv); err != nil {
		t.Fatal(err)
	}
	return enrolment{paths: paths, devPub: devPub, corePubHex: cfg.CorePubKey, oldServer: oldServer}
}

// custody returns the exact bytes of the config and the key, so "untouched"
// means untouched and not "still parses to something similar".
func (e enrolment) custody(t *testing.T) (string, string) {
	t.Helper()
	cfg, err := os.ReadFile(e.paths.ConfigFile)
	if err != nil {
		t.Fatal(err)
	}
	key, err := os.ReadFile(e.paths.KeyFile)
	if err != nil {
		t.Fatal(err)
	}
	return string(cfg), string(key)
}

func (e enrolment) assertUntouched(t *testing.T, cfgBefore, keyBefore string) {
	t.Helper()
	cfgAfter, keyAfter := e.custody(t)
	if cfgAfter != cfgBefore {
		t.Errorf("a failed repoint rewrote %s\nbefore: %s\nafter:  %s", e.paths.ConfigFile, cfgBefore, cfgAfter)
	}
	if keyAfter != keyBefore {
		t.Errorf("a failed repoint rewrote the device key at %s", e.paths.KeyFile)
	}
}

func (e enrolment) server(t *testing.T) string {
	t.Helper()
	cfg, _, err := config.Load(e.paths)
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Server
}

// ── the cases ───────────────────────────────────────────────────────────────

// The hub moved. The new URL presents the SAME core key and still knows this
// device, so the URL is written — and read back.
func TestRepointWritesTheNewURLOnlyAfterTheProof(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	fc := newFakeCore(t, e.corePubHex, e.devPub, coreBehaviour{})

	var out bytes.Buffer
	if err := repoint(e.paths, fc.srv.URL, false, &out); err != nil {
		t.Fatalf("repoint against the same Nova must succeed, got: %v", err)
	}
	if got := e.server(t); got != fc.srv.URL {
		t.Errorf("config server = %q, want %q", got, fc.srv.URL)
	}
	if !fc.authed.Load() {
		t.Error("the device did not produce a valid signature over the RAW nonce — the proof was not a proof")
	}
	if !strings.Contains(out.String(), "repointed: https://nova.old.example -> "+fc.srv.URL) {
		t.Errorf("output must state old -> new, got:\n%s", out.String())
	}
	// It must not claim the daemon reconnected.
	for _, banned := range []string{"reconnected", "connected"} {
		if strings.Contains(strings.ToLower(out.String()), banned) &&
			!strings.Contains(out.String(), "does not\nclaim the daemon reconnected") {
			t.Errorf("repoint must not claim the daemon reconnected, got:\n%s", out.String())
		}
	}
	// The pinned key is not touched by a move: core's key travels in the bundle.
	cfg, _, err := config.Load(e.paths)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CorePubKey != e.corePubHex {
		t.Errorf("repoint changed the pinned core key (%s -> %s); a move changes the URL and nothing else",
			e.corePubHex, cfg.CorePubKey)
	}
	if cfg.DeviceID != "dev-repoint-1" || cfg.Name != "workshop-laptop" {
		t.Errorf("repoint changed the identity fields: %+v", cfg)
	}
}

// The whole control: a server that is NOT the Nova this device paired with is
// refused, and the config does not move.
func TestRepointRefusesAServerPresentingAnotherCoreKey(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	fc := newFakeCore(t, e.corePubHex, e.devPub, coreBehaviour{presentKey: hex.EncodeToString(otherPub)})
	cfgBefore, keyBefore := e.custody(t)

	var out bytes.Buffer
	err := repoint(e.paths, fc.srv.URL, false, &out)
	if err == nil {
		t.Fatal("a server presenting another core key must be refused")
	}
	if !strings.Contains(err.Error(), "not the Nova you paired with") {
		t.Errorf("the refusal must say whose Nova it is not, got: %v", err)
	}
	if !strings.Contains(err.Error(), "Re-enroll") {
		t.Errorf("the refusal must name the way forward, got: %v", err)
	}
	if !strings.Contains(err.Error(), hex.EncodeToString(otherPub)[:8]) {
		t.Errorf("the refusal must name the key it was PRESENTED, got: %v", err)
	}
	if !strings.Contains(err.Error(), e.corePubHex[:8]) {
		t.Errorf("the refusal must name the key we PINNED, got: %v", err)
	}
	e.assertUntouched(t, cfgBefore, keyBefore)
	if out.Len() != 0 {
		t.Errorf("a refused repoint must print nothing on stdout, got: %q", out.String())
	}
}

// A server with the right core key that has FORGOTTEN this device passes the
// key comparison and fails at auth. The write must not be made on a half-proof.
func TestRepointRefusesAServerThatForgotThisDevice(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	fc := newFakeCore(t, e.corePubHex, e.devPub, coreBehaviour{refuseAuth: "unknown device"})
	cfgBefore, keyBefore := e.custody(t)

	err := repoint(e.paths, fc.srv.URL, false, new(bytes.Buffer))
	if err == nil {
		t.Fatal("a server that refuses auth must not be repointed to")
	}
	if !strings.Contains(err.Error(), "unknown device") {
		t.Errorf("the refusal must carry core's own reason, got: %v", err)
	}
	e.assertUntouched(t, cfgBefore, keyBefore)
}

// --check writes NOTHING, ever — including when the proof succeeds. This is
// what the hub-move runbook uses to decide between repoint and a fresh enroll.
func TestRepointCheckProvesAndWritesNothing(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	fc := newFakeCore(t, e.corePubHex, e.devPub, coreBehaviour{})
	cfgBefore, keyBefore := e.custody(t)

	var out bytes.Buffer
	if err := repoint(e.paths, fc.srv.URL, true, &out); err != nil {
		t.Fatalf("--check against the same Nova must succeed, got: %v", err)
	}
	e.assertUntouched(t, cfgBefore, keyBefore)
	if got := e.server(t); got != "https://nova.old.example" {
		t.Errorf("--check moved the enrolment to %q", got)
	}
	if !strings.Contains(out.String(), "nothing was written") {
		t.Errorf("--check must say it wrote nothing, got:\n%s", out.String())
	}
}

// --check on a server that is not this Nova is a non-nil error (exit 1) and
// still writes nothing.
func TestRepointCheckFailsOnAMismatchAndStillWritesNothing(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	fc := newFakeCore(t, e.corePubHex, e.devPub, coreBehaviour{presentKey: hex.EncodeToString(otherPub)})
	cfgBefore, keyBefore := e.custody(t)

	if err := repoint(e.paths, fc.srv.URL, true, new(bytes.Buffer)); err == nil {
		t.Fatal("--check must fail on a key mismatch")
	}
	e.assertUntouched(t, cfgBefore, keyBefore)
}

// A socket that answers but does not open with a challenge is not a Nova
// device socket, and saying so is not the same as saying "unreachable".
func TestRepointRefusesASocketThatDoesNotChallenge(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	fc := newFakeCore(t, e.corePubHex, e.devPub, coreBehaviour{nonChallenge: true})
	cfgBefore, keyBefore := e.custody(t)

	err := repoint(e.paths, fc.srv.URL, false, new(bytes.Buffer))
	if err == nil {
		t.Fatal("a socket that does not open with a challenge must be refused")
	}
	if !strings.Contains(err.Error(), "challenge") {
		t.Errorf("the refusal must say what was missing, got: %v", err)
	}
	e.assertUntouched(t, cfgBefore, keyBefore)
}

// An unreachable URL names the URL and leaves the config alone.
func TestRepointRefusesAnUnreachableServer(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	// A port nothing listens on: httptest hands out a real one, then closes it.
	dead := httptest.NewServer(http.NewServeMux())
	url := dead.URL
	dead.Close()
	cfgBefore, keyBefore := e.custody(t)

	err := repoint(e.paths, url, false, new(bytes.Buffer))
	if err == nil {
		t.Fatal("an unreachable server must be refused")
	}
	if !strings.Contains(err.Error(), url) {
		t.Errorf("the refusal must name the URL it could not open, got: %v", err)
	}
	e.assertUntouched(t, cfgBefore, keyBefore)
}

// The scheme is checked before anything is dialled, so a junk URL never
// reaches the network — and the config never moves.
func TestRepointRefusesAJunkSchemeBeforeDialling(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	fc := newFakeCore(t, e.corePubHex, e.devPub, coreBehaviour{})
	cfgBefore, keyBefore := e.custody(t)

	err := repoint(e.paths, "ftp://nova.example", false, new(bytes.Buffer))
	if err == nil {
		t.Fatal("a non-http(s)/ws(s) scheme must be refused")
	}
	if !strings.Contains(err.Error(), "scheme") {
		t.Errorf("the refusal must name the scheme, got: %v", err)
	}
	if n := fc.dials.Load(); n != 0 {
		t.Errorf("a junk scheme must be refused before any dial, saw %d", n)
	}
	e.assertUntouched(t, cfgBefore, keyBefore)
}

// No --server at all, and no enrolment at all, each fail with the sentence
// that says what to do next.
func TestRepointRefusesWithoutAServerOrAnEnrolment(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	if err := repoint(e.paths, "", false, new(bytes.Buffer)); err == nil ||
		!strings.Contains(err.Error(), "--server") {
		t.Errorf("repoint with no --server must say so, got: %v", err)
	}

	empty := t.TempDir()
	bare := config.Paths{
		ConfigDir:  filepath.Join(empty, "novad"),
		StateDir:   filepath.Join(empty, "state"),
		ConfigFile: filepath.Join(empty, "novad", "config.json"),
		KeyFile:    filepath.Join(empty, "novad", "key"),
		AuditFile:  filepath.Join(empty, "state", "audit.jsonl"),
		Home:       empty,
	}
	err := repoint(bare, "https://nova.new.example", false, new(bytes.Buffer))
	if err == nil || !strings.Contains(err.Error(), "novad enroll") {
		t.Errorf("repoint with no enrolment must point at enroll, got: %v", err)
	}
}

// A device key that is not a 32-byte ed25519 seed is a refusal, not a panic —
// §11 step 1 verifies the seed before anything is dialled.
func TestRepointRefusesATruncatedDeviceKey(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	if err := os.WriteFile(e.paths.KeyFile, []byte("abcd\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fc := newFakeCore(t, e.corePubHex, e.devPub, coreBehaviour{})

	err := repoint(e.paths, fc.srv.URL, false, new(bytes.Buffer))
	if err == nil {
		t.Fatal("a device key that is not a 32-byte seed must be refused")
	}
	if !strings.Contains(err.Error(), "seed") {
		t.Errorf("the refusal must name the seed, got: %v", err)
	}
	if n := fc.dials.Load(); n != 0 {
		t.Errorf("a bad device key must be refused before any dial, saw %d", n)
	}
}

// Repointing at the URL the enrolment already holds is a no-op that still
// proves the server and still verifies its own write. It is not an error: the
// postcondition already holds, and a runbook that re-runs a step must not be
// punished for it.
func TestRepointToTheSameURLIsProvedAndStated(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	fc := newFakeCore(t, e.corePubHex, e.devPub, coreBehaviour{})
	// Enrol at the fake core's own URL, then repoint to it again.
	if err := repoint(e.paths, fc.srv.URL, false, new(bytes.Buffer)); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := repoint(e.paths, fc.srv.URL, false, &out); err != nil {
		t.Fatalf("repointing to the URL already held must succeed, got: %v", err)
	}
	if got := e.server(t); got != fc.srv.URL {
		t.Errorf("config server = %q, want %q", got, fc.srv.URL)
	}
}

// A trailing slash is the same server, not a different one.
func TestRepointNormalisesATrailingSlash(t *testing.T) {
	e := newEnrolment(t, "https://nova.old.example")
	fc := newFakeCore(t, e.corePubHex, e.devPub, coreBehaviour{})

	if err := repoint(e.paths, fc.srv.URL+"/", false, new(bytes.Buffer)); err != nil {
		t.Fatal(err)
	}
	if got := e.server(t); got != fc.srv.URL {
		t.Errorf("config server = %q, want the URL without its trailing slash (%q)", got, fc.srv.URL)
	}
}
