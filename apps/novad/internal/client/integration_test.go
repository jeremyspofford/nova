package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"novad/internal/audit"
	"novad/internal/config"
	"novad/internal/facts"
	"novad/internal/platform"
	"novad/internal/state"
	"novad/internal/wire"
)

// No test in this package runs the probes' real programs (S42b Task 10b,
// ruling 3): an agent any test Configures probes through a FakeRunner, which
// runs nothing — `sudo -n true` and wsl.exe included.
func init() { probeRunner = &platform.FakeRunner{} }

// hermeticFrame stands in for facts.GatherFrame in every agent these tests
// build. GatherFrame reads this host's folders ($HOME, the XDG user-dirs
// file) and interfaces, and no test's outcome may turn on the machine it
// runs on (PR #106's CI: a runner with no user-dirs file). It is
// GatherFrame's shape, fixed, with the carried entries repeated as
// GatherFrame repeats them.
func hermeticFrame(carried []facts.Unreadable) facts.Frame {
	return facts.Frame{Type: "facts",
		Net:        facts.Net{Ifaces: []facts.Iface{{Name: "eth0", MAC: "02:00:00:00:00:01", IPv4CIDR: []string{"192.0.2.10/24"}, Up: true}}},
		Unreadable: append([]facts.Unreadable{}, carried...)}
}

// A full protocol walk over a REAL websocket against an in-process fake core:
// challenge -> auth (raw-nonce signature) -> ready -> a core-signed system.info
// command -> the device's result AND audit frame. This is the daemon side of
// what T5 walks live, and it proves the coder/websocket path, the handshake,
// and the result/audit frames end to end — not just the units.
func TestFullWalkAgainstAFakeCore(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-integration-1"

	type observed struct {
		result map[string]any
		audits []map[string]any
		authOK bool
	}
	obsCh := make(chan observed, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		var obs observed

		// 1. challenge
		nonce := make([]byte, 32)
		_, _ = rand.Read(nonce)
		_ = coreWrite(ctx, c, map[string]any{
			"type": "challenge", "nonce": hex.EncodeToString(nonce),
			"core_pubkey": hex.EncodeToString(corePub),
		})

		// 2. read auth, verify over the RAW nonce bytes
		auth, err := coreRead(ctx, c)
		if err != nil {
			return
		}
		sigHex, _ := auth["sig"].(string)
		sig, _ := hex.DecodeString(sigHex)
		obs.authOK = ed25519.Verify(devPub, nonce, sig)
		if !obs.authOK {
			_ = c.Close(4401, "bad auth")
			obsCh <- obs
			return
		}

		// 3. ready (no stored audit -> null)
		_ = coreWrite(ctx, c, map[string]any{"type": "ready", "last_seq": nil})

		// 4. a core-signed system.info command
		now := time.Now().Unix()
		env := map[string]any{
			"v": int64(1), "envelope_id": "int-e1", "device_id": deviceID,
			"capability": "system.info", "args": map[string]any{},
			"issued_at": now, "expires_at": now + 60,
		}
		canon, _ := wire.Canonical(env)
		cmdSig := hex.EncodeToString(ed25519.Sign(corePriv, canon))
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": cmdSig})

		// 5. read frames until we have a result and its audit
		deadline := time.Now().Add(8 * time.Second)
		for (obs.result == nil || len(obs.audits) == 0) && time.Now().Before(deadline) {
			f, err := coreRead(ctx, c)
			if err != nil {
				break
			}
			switch f["type"] {
			case "result":
				obs.result = f
			case "audit":
				if raw, ok := f["entries"].([]any); ok {
					for _, e := range raw {
						if m, ok := e.(map[string]any); ok {
							obs.audits = append(obs.audits, m)
						}
					}
				}
			}
		}
		obsCh <- obs
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	// Build the agent against a temp custody dir.
	home := t.TempDir()
	paths := config.Paths{
		ConfigDir: filepath.Join(home, ".config", "novad"),
		StateDir:  filepath.Join(home, ".local", "state", "novad"),
		AuditFile: filepath.Join(home, ".local", "state", "novad", "audit.jsonl"),
		Home:      home,
	}
	auditLog, err := audit.Open(paths.AuditFile)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{DeviceID: deviceID, Name: "itest", Server: srv.URL, CorePubKey: hex.EncodeToString(corePub)}
	agent, err := New(cfg, devPriv, auditLog, home, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	agent.gatherFrame = hermeticFrame

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)

	var obs observed
	select {
	case obs = <-obsCh:
	case <-ctx.Done():
		t.Fatal("timed out waiting for the fake core to observe the walk")
	}
	cancel()

	if !obs.authOK {
		t.Fatal("the device's challenge signature did not verify over the raw nonce")
	}
	if obs.result == nil {
		t.Fatal("no result frame received")
	}
	if ok, _ := obs.result["ok"].(bool); !ok {
		t.Fatalf("result.ok = false, want true; error=%v", obs.result["error"])
	}
	if out, _ := obs.result["output"].(string); !strings.Contains(out, "disk") {
		t.Errorf("result output should carry system.info numbers, got %q", out)
	}
	if len(obs.audits) == 0 {
		t.Fatal("no audit frame received alongside the result")
	}

	// The audit entry core received must hash exactly as core would recompute
	// it — the cross-language chain, proven over a real socket.
	entry := obs.audits[0]
	stored, _ := entry["hash"].(string)
	without := map[string]any{}
	for k, v := range entry {
		if k != "hash" {
			without[k] = v
		}
	}
	prev, _ := entry["prev_hash"].(string)
	recomputed, err := wire.ChainHash(prev, without)
	if err != nil {
		t.Fatal(err)
	}
	if recomputed != stored {
		t.Fatalf("audit hash core received (%s) != recompute (%s)", stored, recomputed)
	}

	// And the device's own local chain advanced to seq 0.
	if auditLog.LastSeq() != 0 {
		t.Errorf("local audit LastSeq = %d, want 0", auditLog.LastSeq())
	}
}

// buildAgent assembles an Agent over a fresh temp custody dir, pinning
// corePubHex and signing with devPriv.
func buildAgent(t *testing.T, serverURL, deviceID, corePubHex string, devPriv ed25519.PrivateKey) (*Agent, *audit.Log) {
	t.Helper()
	home := t.TempDir()
	paths := config.Paths{
		ConfigDir: filepath.Join(home, ".config", "novad"),
		StateDir:  filepath.Join(home, ".local", "state", "novad"),
		AuditFile: filepath.Join(home, ".local", "state", "novad", "audit.jsonl"),
		Home:      home,
	}
	auditLog, err := audit.Open(paths.AuditFile)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{DeviceID: deviceID, Name: "itest", Server: serverURL, CorePubKey: corePubHex}
	agent, err := New(cfg, devPriv, auditLog, home, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	agent.gatherFrame = hermeticFrame
	return agent, auditLog
}

// runAgent runs agent.Run(ctx) on a goroutine of its own and hands back what
// it returns. At the test's end it stops the agent and waits for Run to
// return — and Run returns only once nothing it started can still write —
// so nothing the agent writes (its audit log, its state dir) is still being
// written when t.TempDir's cleanup removes it. PR #106's windows-11-arm run
// failed exactly there: a refused replay's audit append was still writing
// audit.jsonl as RemoveAll ran. Cleanups run last-registered first, so this
// one runs before the TempDir cleanup buildAgent registered.
func runAgent(t *testing.T, ctx context.Context, agent *Agent) <-chan error {
	t.Helper()
	ctx, stop := context.WithCancel(ctx)
	runErr := make(chan error, 1)
	returned := make(chan struct{})
	go func() {
		defer close(returned)
		runErr <- agent.Run(ctx)
	}()
	t.Cleanup(func() {
		stop()
		select {
		case <-returned:
		case <-time.After(10 * time.Second):
			t.Errorf("Run had not returned 10s after the agent was stopped")
		}
	})
	return runErr
}

// I1: a command that FAILS verification must produce BOTH a result{ok:false}
// AND an appended audit entry{ok:false} — the "never report success/failure
// unchecked" tripwire. A refactor that early-returns on the verify error
// without emitting/appending reddens this.
func TestARefusedCommandIsAResultOkFalseAndAnAuditEntry(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-refuse-1"

	type observed struct {
		result map[string]any
		audit  map[string]any
	}
	obsCh := make(chan observed, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()

		nonce := make([]byte, 32)
		_, _ = rand.Read(nonce)
		_ = coreWrite(ctx, c, map[string]any{"type": "challenge", "nonce": hex.EncodeToString(nonce), "core_pubkey": hex.EncodeToString(corePub)})
		auth, err := coreRead(ctx, c)
		if err != nil {
			return
		}
		sigHex, _ := auth["sig"].(string)
		sig, _ := hex.DecodeString(sigHex)
		if !ed25519.Verify(devPub, nonce, sig) {
			_ = c.Close(4401, "bad auth")
			return
		}
		_ = coreWrite(ctx, c, map[string]any{"type": "ready", "last_seq": nil})

		// A command whose signature does NOT verify (64 zero bytes).
		now := time.Now().Unix()
		env := map[string]any{
			"v": int64(1), "envelope_id": "refuse-e1", "device_id": deviceID,
			"capability": "system.info", "args": map[string]any{},
			"issued_at": now, "expires_at": now + 60,
		}
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": strings.Repeat("00", 64)})

		var obs observed
		deadline := time.Now().Add(8 * time.Second)
		for (obs.result == nil || obs.audit == nil) && time.Now().Before(deadline) {
			f, err := coreRead(ctx, c)
			if err != nil {
				break
			}
			switch f["type"] {
			case "result":
				obs.result = f
			case "audit":
				if raw, ok := f["entries"].([]any); ok && len(raw) > 0 {
					if m, ok := raw[0].(map[string]any); ok {
						obs.audit = m
					}
				}
			}
		}
		obsCh <- obs
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	agent, auditLog := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)

	var obs observed
	select {
	case obs = <-obsCh:
	case <-ctx.Done():
		t.Fatal("timed out waiting for the refusal result + audit")
	}
	cancel()

	// (a) a result frame with ok:false and a stated error.
	if obs.result == nil {
		t.Fatal("no result frame for the refused command")
	}
	if ok, _ := obs.result["ok"].(bool); ok {
		t.Fatal("a refused command must be result ok:false")
	}
	if e, _ := obs.result["error"].(string); e == "" {
		t.Error("a refusal result must carry a stated error")
	}
	// (b) an audit entry with ok:false was appended for it.
	if obs.audit == nil {
		t.Fatal("a refusal must ALSO be an audit entry — none received")
	}
	if ok, _ := obs.audit["ok"].(bool); ok {
		t.Fatal("the audit entry for a refusal must be ok:false")
	}
	if auditLog.LastSeq() != 0 {
		t.Errorf("a refusal must append to the local chain (seq 0), got LastSeq %d", auditLog.LastSeq())
	}
}

// I2: a challenge whose core_pubkey != the pinned one is a FATAL, non-
// reconnecting refusal — the daemon's half of the mutual pinning. It must not
// send auth, must not loop, and must surface the changed-key reason. A refactor
// that inverts the check or downgrades fatal->retryable reddens this.
func TestAChangedCoreKeyIsFatalAndDoesNotReconnect(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)  // the key we PIN
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader) // the key the socket PRESENTS
	_, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-tofu-1"

	authSeen := make(chan bool, 4)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		nonce := make([]byte, 32)
		_, _ = rand.Read(nonce)
		// Present the WRONG core key.
		_ = coreWrite(ctx, c, map[string]any{"type": "challenge", "nonce": hex.EncodeToString(nonce), "core_pubkey": hex.EncodeToString(otherPub)})
		// The daemon must refuse before auth: this read should error (socket
		// closed), never return an auth frame.
		if _, err := coreRead(ctx, c); err == nil {
			authSeen <- true
		} else {
			authSeen <- false
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	runErr := runAgent(t, ctx, agent)

	select {
	case err := <-runErr:
		if err == nil {
			t.Fatal("a changed core key must be a fatal error, not a clean return")
		}
		if !strings.Contains(err.Error(), "pinned") {
			t.Errorf("the fatal reason should name the pin, got: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return — a changed key must be fatal, not a reconnect loop")
	}

	select {
	case got := <-authSeen:
		if got {
			t.Error("the daemon sent an auth frame despite a changed core key — it must refuse BEFORE auth")
		}
	case <-time.After(time.Second):
		// The handler may not have reached its read; the fatal-return assertion
		// above is the load-bearing one.
	}
}

// I1: the one-use seen-set must span the envelope validity window, NOT a single
// socket lifetime. A command accepted on one connection, then the SAME
// {envelope, sig} redelivered after the daemon reconnects, must be refused as a
// replay — proving the Verifier is built once (in New) and reused across
// reconnects. If it were rebuilt per connection (inside handshake), the fresh
// seen-set would accept the redelivery and this reddens.
func TestAReplayIsRefusedAcrossAReconnect(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-replay-reconnect"

	// One command, signed once, delivered verbatim on BOTH connections. A long
	// window (+600s) keeps it valid across the reconnect backoff so the ONLY
	// reason the second delivery can fail is the seen-set, not expiry.
	now := time.Now().Unix()
	env := map[string]any{
		"v": int64(1), "envelope_id": "replay-across-reconnect", "device_id": deviceID,
		"capability": "system.info", "args": map[string]any{},
		"issued_at": now, "expires_at": now + 600,
	}
	canon, _ := wire.Canonical(env)
	cmdSig := hex.EncodeToString(ed25519.Sign(corePriv, canon))

	type outcome struct {
		conn int
		ok   bool
		err  string
	}
	results := make(chan outcome, 2)

	var mu sync.Mutex
	connCount := 0

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()

		mu.Lock()
		connCount++
		myConn := connCount
		mu.Unlock()

		// handshake
		nonce := make([]byte, 32)
		_, _ = rand.Read(nonce)
		_ = coreWrite(ctx, c, map[string]any{"type": "challenge", "nonce": hex.EncodeToString(nonce), "core_pubkey": hex.EncodeToString(corePub)})
		auth, err := coreRead(ctx, c)
		if err != nil {
			return
		}
		sigHex, _ := auth["sig"].(string)
		sig, _ := hex.DecodeString(sigHex)
		if !ed25519.Verify(devPub, nonce, sig) {
			_ = c.Close(4401, "bad auth")
			return
		}
		_ = coreWrite(ctx, c, map[string]any{"type": "ready", "last_seq": nil})

		// Deliver the SAME command on this connection.
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": cmdSig})

		// Read frames until the result for our command arrives (skip the audit
		// replay frame the daemon sends on the second connection).
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			f, err := coreRead(ctx, c)
			if err != nil {
				return
			}
			if f["type"] == "result" {
				ok, _ := f["ok"].(bool)
				es, _ := f["error"].(string)
				results <- outcome{conn: myConn, ok: ok, err: es}
				break
			}
		}

		if myConn == 1 {
			// Force the daemon to reconnect: drop this socket after the result.
			_ = c.Close(websocket.StatusNormalClosure, "cycling")
		} else {
			// Hold the second connection open until the test tears down.
			<-ctx.Done()
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)

	got := map[int]outcome{}
	for len(got) < 2 {
		select {
		case o := <-results:
			got[o.conn] = o
		case <-ctx.Done():
			t.Fatalf("timed out; observed %d/2 results: %+v", len(got), got)
		}
	}
	cancel()

	// First delivery: accepted.
	if !got[1].ok {
		t.Fatalf("first delivery must be accepted, got ok=false err=%q", got[1].err)
	}
	// Second delivery, after the reconnect: refused as a replay. The seen-set
	// survived the new socket because the Verifier is process-lived.
	if got[2].ok {
		t.Fatal("the same envelope after a reconnect must be refused (replay) — the seen-set must span reconnects, not one socket")
	}
	if !strings.Contains(got[2].err, "replay") {
		t.Errorf("the second refusal should name the replay, got: %q", got[2].err)
	}
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
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, err
	}
	return m, nil
}

// fakeCoreHandshake runs challenge -> auth (verified) -> ready on c and
// returns the auth frame, or nil if the signature did not verify.
func fakeCoreHandshake(ctx context.Context, c *websocket.Conn, corePub ed25519.PublicKey, devPub ed25519.PublicKey) map[string]any {
	nonce := make([]byte, 32)
	_, _ = rand.Read(nonce)
	_ = coreWrite(ctx, c, map[string]any{"type": "challenge", "nonce": hex.EncodeToString(nonce), "core_pubkey": hex.EncodeToString(corePub)})
	auth, err := coreRead(ctx, c)
	if err != nil {
		return nil
	}
	sigHex, _ := auth["sig"].(string)
	sig, _ := hex.DecodeString(sigHex)
	if !ed25519.Verify(devPub, nonce, sig) {
		return nil
	}
	_ = coreWrite(ctx, c, map[string]any{"type": "ready", "last_seq": nil})
	return auth
}

func TestTheAuthFrameCarriesFactsAndAFactsFrameFollowsReady(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	type seen struct{ auth, next map[string]any }
	ch := make(chan seen, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		auth := fakeCoreHandshake(r.Context(), c, corePub, devPub)
		if auth == nil {
			return
		}
		next, _ := coreRead(r.Context(), c)
		ch <- seen{auth: auth, next: next}
		<-r.Context().Done()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, "dev-facts-1", hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	var got seen
	select {
	case got = <-ch:
	case <-ctx.Done():
		t.Fatal("timed out")
	}
	cancel()
	fm, ok := got.auth["facts"].(map[string]any)
	if !ok {
		t.Fatalf("the auth frame carries no facts: %v", got.auth)
	}
	if v, _ := fm["v"].(json.Number); v.String() != "2" {
		t.Fatalf("facts v = %v", fm["v"])
	}
	if osm, _ := fm["os"].(map[string]any); osm["goos"] != runtime.GOOS {
		t.Fatalf("facts os = %v", fm["os"])
	}
	// The one value this task plumbs through New -> gatherAuth: the build
	// stamp, passed as "test" by buildAgent.
	if am, _ := fm["agent"].(map[string]any); am["version"] != "test" {
		t.Fatalf("facts.agent.version = %v, want %q", am["version"], "test")
	}
	if got.next["type"] != "facts" {
		t.Fatalf("the first frame after ready must be facts, got %v", got.next["type"])
	}
	if _, ok := got.next["net"].(map[string]any); !ok {
		t.Fatalf("the facts frame has no net: %v", got.next)
	}
}

// The Global Constraint says auth facts are never a reason to refuse the
// socket. gatherAuth runs a platform call (macOS ioreg, machine-id reads)
// that has no timeout of its own; if it hung, using hsCtx's full 30s for it
// would let a single stuck read burn the whole handshake, fail the auth
// write or the ready read with "context deadline exceeded", and leave the
// device offline forever on reconnect. gatherAuth must be cut off well
// inside the handshake so ready is still reached quickly.
func TestAHungFactsGatherDoesNotBlockTheHandshake(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	readySeen := make(chan bool, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		auth := fakeCoreHandshake(r.Context(), c, corePub, devPub)
		readySeen <- auth != nil
		<-r.Context().Done()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, "dev-hung-gather-1", hex.EncodeToString(corePub), devPriv)
	agent.authGatherBudget = 100 * time.Millisecond
	agent.gatherAuth = func(ctx context.Context) (facts.Auth, []facts.Unreadable) {
		<-ctx.Done() // simulates a platform call that never returns on its own
		return facts.Auth{}, []facts.Unreadable{{Item: "test", Reason: "blocked"}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	runAgent(t, ctx, agent)
	select {
	case ok := <-readySeen:
		if !ok {
			t.Fatal("the auth frame's signature did not verify")
		}
		if elapsed := time.Since(start); elapsed > 2*time.Second {
			t.Fatalf("handshake took %s — a hung gatherAuth burned most of the 30s handshake budget instead of being cut off at ~100ms", elapsed)
		}
	case <-ctx.Done():
		t.Fatal("handshake never completed — a hung facts gather blocked ready")
	}
}

// The facts frame goes out BEFORE facts.refresh's own result, so core has
// recorded the facts by the time its command returns.
func TestFactsRefreshWritesTheFrameBeforeItsResult(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-refresh-1"
	type observed struct {
		types  []string
		result map[string]any
	}
	order := make(chan observed, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		if fakeCoreHandshake(ctx, c, corePub, devPub) == nil {
			return
		}
		if first, _ := coreRead(ctx, c); first["type"] != "facts" {
			return
		}
		now := time.Now().Unix()
		env := map[string]any{
			"v": int64(1), "envelope_id": "refresh-e1", "device_id": deviceID,
			"capability": "facts.refresh", "args": map[string]any{},
			"issued_at": now, "expires_at": now + 60,
		}
		canon, _ := wire.Canonical(env)
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": hex.EncodeToString(ed25519.Sign(corePriv, canon))})
		// Read through the audit frame too, not just facts+result: the
		// audit frame only goes out AFTER the daemon's audit.Append (which
		// lazily creates audit.jsonl inside this test's TempDir) returns.
		// Stopping at "result" let the test race that Append against
		// TempDir's RemoveAll cleanup.
		var obs observed
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			f, err := coreRead(ctx, c)
			if err != nil {
				break
			}
			switch typ, _ := f["type"].(string); typ {
			case "facts", "result":
				obs.types = append(obs.types, typ)
				if typ == "result" {
					obs.result = f
				}
			case "audit":
				order <- obs
				return
			}
		}
		order <- obs
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	select {
	case got := <-order:
		if len(got.types) != 2 || got.types[0] != "facts" || got.types[1] != "result" {
			t.Fatalf("frames after facts.refresh = %v, want [facts result]", got.types)
		}
		if ok, _ := got.result["ok"].(bool); !ok {
			t.Fatalf("facts.refresh result ok = %v, want true (error=%v)", got.result["ok"], got.result["error"])
		}
	case <-ctx.Done():
		t.Fatal("timed out")
	}
}

// novad repoint's probe writes nothing on either side: no facts.
func TestTheRepointProbeSendsNoFacts(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	sawFacts := make(chan bool, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		auth := fakeCoreHandshake(r.Context(), c, corePub, devPub)
		_, present := auth["facts"]
		sawFacts <- present
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cfg := config.Config{DeviceID: "dev-probe-1", Server: srv.URL, CorePubKey: hex.EncodeToString(corePub)}
	if err := VerifyServer(context.Background(), cfg, devPriv); err != nil {
		t.Fatal(err)
	}
	if <-sawFacts {
		t.Fatal("the repoint probe must not send facts")
	}
}

// countingCore authenticates every connection, records when each arrived,
// then either closes it at once or holds it (hold=true), reading frames so
// pings are answered.
func countingCore(t *testing.T, corePub, devPub ed25519.PublicKey, hold, answerPings bool) (*httptest.Server, func() []time.Time) {
	t.Helper()
	var mu sync.Mutex
	var arrivals []time.Time
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		mu.Lock()
		arrivals = append(arrivals, time.Now())
		mu.Unlock()
		if fakeCoreHandshake(r.Context(), c, corePub, devPub) == nil {
			return
		}
		if !hold {
			_ = c.Close(websocket.StatusNormalClosure, "cycling")
			return
		}
		if answerPings {
			for {
				if _, err := coreRead(r.Context(), c); err != nil {
					return
				}
			}
		}
		<-r.Context().Done() // never reads: pings go unanswered
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, func() []time.Time {
		mu.Lock()
		defer mu.Unlock()
		return append([]time.Time(nil), arrivals...)
	}
}

func waitFor(t *testing.T, within time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", within)
}

// Before S42a the ladder never reset: after five drops EVERY reconnect
// waited the longest step for the life of the process.
func TestTheBackoffResetsAfterASessionThatAuthenticated(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	srv, arrivals := countingCore(t, corePub, devPub, false, false)
	agent, _ := buildAgent(t, srv.URL, "dev-backoff-1", hex.EncodeToString(corePub), devPriv)
	agent.backoffs = []time.Duration{20 * time.Millisecond, 40 * time.Millisecond, 80 * time.Millisecond, 160 * time.Millisecond, 10 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	// Seven authenticated sessions: without the reset, the sixth waits 10 s.
	waitFor(t, 3*time.Second, func() bool { return len(arrivals()) >= 7 })
}

func TestAPingThatGoesUnansweredEndsTheSession(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	srv, arrivals := countingCore(t, corePub, devPub, true, false)
	agent, _ := buildAgent(t, srv.URL, "dev-ping-1", hex.EncodeToString(corePub), devPriv)
	agent.heartbeatEvery, agent.pingTimeout = 50*time.Millisecond, 100*time.Millisecond
	agent.backoffs = []time.Duration{20 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	waitFor(t, 3*time.Second, func() bool { return len(arrivals()) >= 2 })
}

// Review focus 4: a wall-clock jump between ticks is a sleep — the session
// ends and the next connect comes after the FIRST step of the ladder (the
// reset), not after a TCP timeout or a 30 s wait.
//
// Fix round 1 finding 2: heartbeatEvery is REALISTIC here (5s) and the
// watchdog is left at its DEFAULT (watchdogEvery 1s, sleepGap 5s) — proving
// the watchdog catches the jump quickly, not a fast heartbeat ticker standing
// in for it (a 50ms heartbeat, as this test used before, would catch the
// jump itself and never exercise the watchdog at all). Arithmetic for the
// 2.5s bound: worst-case watchdog detection is just under one watchdogEvery
// (~1s) after the jump, plus the reset ladder's first step (1s, DEFAULT
// backoffs — this session authenticates, so Run resets to attempt 0), plus a
// fast local dial+handshake (tens of ms) — about 2.0-2.1s, comfortably under
// 2.5s. The heartbeat's own 5s ticker never even fires before the session
// ends, so its slower P12 gap rule (kept exactly as specified) plays no part
// in this particular test — that is the point.
func TestAClockJumpEndsTheSessionAndTheNextConnectIsQuick(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	srv, arrivals := countingCore(t, corePub, devPub, true, true)
	agent, _ := buildAgent(t, srv.URL, "dev-resume-1", hex.EncodeToString(corePub), devPriv)
	agent.heartbeatEvery = 5 * time.Second // realistic; the DEFAULT watchdog must catch this, not this ticker
	var mu sync.Mutex
	offset := time.Duration(0)
	agent.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return time.Now().Add(offset) }
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	waitFor(t, 2*time.Second, func() bool { return len(arrivals()) >= 1 })
	time.Sleep(120 * time.Millisecond) // let the session settle before jumping
	mu.Lock()
	offset = 10 * time.Minute // the laptop "slept" ten minutes
	mu.Unlock()
	jumped := time.Now()
	waitFor(t, 3*time.Second, func() bool { return len(arrivals()) >= 2 })
	// Controller ruling 3: a spurious reconnect BEFORE the deliberate jump
	// would let this test pass vacuously — arrivals()[1] would predate
	// jumped, its Sub would be negative, and the bound below would hold
	// without the watchdog ever running. Assert causality first.
	if !arrivals()[1].After(jumped) {
		t.Fatalf("arrivals()[1] = %s is not after the jump at %s — a spurious reconnect before the deliberate jump", arrivals()[1], jumped)
	}
	if gap := arrivals()[1].Sub(jumped); gap > 2500*time.Millisecond {
		t.Fatalf("reconnected %s after the jump; watchdog detection (~1s) plus the reset ladder's first step (1s) should be well under this", gap)
	}
}

// Changed facts go out at most once per factsMinGap; unchanged ones only
// every factsEvery.
func TestFactsAreResentOnChangeAtMostOncePerGap(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	var mu sync.Mutex
	count := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		if fakeCoreHandshake(r.Context(), c, corePub, devPub) == nil {
			return
		}
		for {
			f, err := coreRead(r.Context(), c)
			if err != nil {
				return
			}
			if f["type"] == "facts" {
				mu.Lock()
				count++
				mu.Unlock()
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, "dev-cadence-1", hex.EncodeToString(corePub), devPriv)
	// Controller ruling 2 (pre-flight finding F3): the brief's 20ms/40ms
	// heartbeat/gap made a single >=40ms scheduler stall on a -race runner
	// enough to trip the machine-slept rule and end the session, which could
	// drop the count below 3. 50ms/100ms needs a much wider stall, and the
	// 10ms backoff means a spurious reconnect (if a stall happens anyway)
	// costs almost nothing inside the 1.1s window.
	agent.heartbeatEvery, agent.factsMinGap, agent.factsEvery = 50*time.Millisecond, 200*time.Millisecond, time.Hour
	agent.backoffs = []time.Duration{10 * time.Millisecond}
	n := 0
	agent.gatherFrame = func([]facts.Unreadable) facts.Frame { // changes on every gather
		n++
		return facts.Frame{Type: "facts", Net: facts.Net{Ifaces: []facts.Iface{}},
			Unreadable: []facts.Unreadable{{Item: "tick", Reason: fmt.Sprint(n)}}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1100*time.Millisecond)
	defer cancel()
	_ = agent.Run(ctx)
	mu.Lock()
	defer mu.Unlock()
	// One after ready, then about one per 200 ms — never one per tick. Ticks
	// land near t=0,200,400,600,800,1000ms over ~1.1s, so ~6 sends; bounds
	// stay [3,8] as in the brief (kept per ruling 2: adjust only if the
	// arithmetic requires it — it does not).
	if count < 3 || count > 8 {
		t.Fatalf("%d facts frames in ~1 s", count)
	}
}

// blockedConn dials a live websocket connection against a throwaway server
// and holds its write lock open forever — a Writer the test never Closes.
// coder/websocket serializes every Write/Writer call on a connection behind
// this one internal lock (see (*Conn).Writer's own doc: "multiple calls will
// block until the previous writer is closed"), so this reproduces fix round
// 1 finding 1's exact failure mode — a write stuck holding the connection's
// write lock — deterministically and OS-independently. Filling a REAL kernel
// send/receive buffer would need an amount of unread data that varies by
// OS/kernel autotuning and is not controllable from client.go's own Dial
// call (it always uses http.DefaultClient), so a test that depended on that
// would risk flaking across machines rather than proving the fix.
func blockedConn(t *testing.T) *websocket.Conn {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		<-r.Context().Done() // never reads or writes again
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	wsURL, err := WSURL(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	wr, err := conn.Writer(context.Background(), websocket.MessageText)
	if err != nil {
		t.Fatalf("opening the blocking writer: %v", err)
	}
	if _, err := wr.Write([]byte("x")); err != nil {
		t.Fatalf("priming the blocking writer: %v", err)
	}
	// wr is deliberately never Closed: the connection's write lock stays
	// held for the rest of the test.
	return conn
}

// Fix round 1 finding 1: writeFacts had no deadline of its own, so a write
// stuck behind the connection's write lock (a hung facts.refresh, up to the
// 110s command timeout; or a hung maybeSendFacts) would block indefinitely.
// It now bounds its own write with pingTimeout.
func TestWriteFactsEndsWithinPingTimeoutWhenTheConnectionIsBlocked(t *testing.T) {
	conn := blockedConn(t)
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	agent, _ := buildAgent(t, "http://unused.invalid", "dev-lock-1", hex.EncodeToString(corePub), devPriv)
	agent.pingTimeout = 200 * time.Millisecond

	errCh := make(chan error, 1)
	start := time.Now()
	go func() { errCh <- agent.writeFacts(context.Background(), conn, []byte(`{"type":"facts"}`)) }()
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("writeFacts should fail: the connection's write lock is held by another writer and never released")
		}
		if elapsed := time.Since(start); elapsed > 6*agent.pingTimeout {
			t.Fatalf("writeFacts took %s to give up; want at most a small multiple of pingTimeout (%s)", elapsed, agent.pingTimeout)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("writeFacts never returned — its write has no deadline of its own (fix round 1 finding 1)")
	}
}

// Fix round 1 finding 1, the heartbeat's own frame write: before the fix, a
// write stuck on the connection's write lock ran under serveCtx with no
// deadline, so the heartbeat blocked on its OWN write before ever reaching
// the ping or maybeSendFacts that tick. It now bounds that write with
// pingTimeout too, and ends the session (via cancel) on failure.
func TestHeartbeatsOwnWriteEndsWithinPingTimeoutWhenTheConnectionIsBlocked(t *testing.T) {
	conn := blockedConn(t)
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	agent, _ := buildAgent(t, "http://unused.invalid", "dev-lock-2", hex.EncodeToString(corePub), devPriv)
	agent.heartbeatEvery = 30 * time.Millisecond
	agent.pingTimeout = 200 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	start := time.Now()
	go func() { agent.heartbeat(ctx, cancel, conn); close(done) }()
	select {
	case <-ctx.Done():
		if elapsed := time.Since(start); elapsed > 6*agent.pingTimeout {
			t.Fatalf("heartbeat took %s to end the session; want at most a small multiple of pingTimeout (%s)", elapsed, agent.pingTimeout)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("heartbeat never ended the session — its own frame write blocked forever behind the held lock (fix round 1 finding 1)")
	}
	<-done // heartbeat's goroutine actually returned, not just cancelled
}

// refusingCore answers the handshake, then always sends the given auth_error
// reason and closes. attempts() counts how many connections it accepted.
func refusingCore(t *testing.T, corePub, devPub ed25519.PublicKey, reason string) (*httptest.Server, func() int) {
	t.Helper()
	var mu sync.Mutex
	n := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		mu.Lock()
		n++
		mu.Unlock()
		nonce := make([]byte, 32)
		_, _ = rand.Read(nonce)
		_ = coreWrite(r.Context(), c, map[string]any{"type": "challenge", "nonce": hex.EncodeToString(nonce), "core_pubkey": hex.EncodeToString(corePub)})
		if _, err := coreRead(r.Context(), c); err != nil {
			return
		}
		_ = coreWrite(r.Context(), c, map[string]any{"type": "auth_error", "reason": reason})
		_ = c.Close(4401, "auth failed")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, func() int { mu.Lock(); defer mu.Unlock(); return n }
}

// Fix round 1, Finding 1: the reason string alone is unsigned — anyone who
// can terminate the socket can send it. Any other refusal (a restored
// database that forgot the device, a transient core fault, or exactly this
// reason text with no valid proof) is retried — only the exact reason
// "revoked", PROVEN by a signature the pinned core key actually produced
// over THIS handshake, wipes anything. The first case below was core's own
// text for an unknown/ambiguous device before Task 12 introduced
// devices_ws.UNKNOWN_DEVICE_REASON and the signed proof for a genuine
// revoke; it stays here as a near-miss precisely because it still is NOT
// "revoked" and carries no proof — the rest are near-misses on the exact
// string a naive substring or case-insensitive check would wrongly treat as
// a match.
func TestAnyOtherAuthErrorIsRetried(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	reasons := []string{
		"no such device, or it has been revoked", // core's PRE-Task-12 text; still just "any other reason", unsigned and proof-less
		"Revoked",
		" revoked",
		"revoked ",
	}
	for _, reason := range reasons {
		t.Run(reason, func(t *testing.T) {
			srv, attempts := refusingCore(t, corePub, devPub, reason)
			agent, _ := buildAgent(t, srv.URL, "dev-unknown-1", hex.EncodeToString(corePub), devPriv)
			agent.backoffs = []time.Duration{20 * time.Millisecond}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			runAgent(t, ctx, agent)
			waitFor(t, 2*time.Second, func() bool { return attempts() >= 3 })
		})
	}
}

// provenRevokedCore answers the handshake, then sends the auth_error frame
// buildReply returns — given THIS handshake's own nonce hex, so a genuine
// proof can echo it and a near-miss can deliberately not — and closes.
// attempts() counts accepted connections.
func provenRevokedCore(t *testing.T, corePub, devPub ed25519.PublicKey, buildReply func(nonceHex string) map[string]any) (*httptest.Server, func() int) {
	t.Helper()
	var mu sync.Mutex
	n := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		mu.Lock()
		n++
		mu.Unlock()
		nonce := make([]byte, 32)
		_, _ = rand.Read(nonce)
		nonceHex := hex.EncodeToString(nonce)
		_ = coreWrite(r.Context(), c, map[string]any{"type": "challenge", "nonce": nonceHex, "core_pubkey": hex.EncodeToString(corePub)})
		if _, err := coreRead(r.Context(), c); err != nil {
			return
		}
		_ = coreWrite(r.Context(), c, buildReply(nonceHex))
		_ = c.Close(4403, "revoked")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, func() int { mu.Lock(); defer mu.Unlock(); return n }
}

// canonicalRevokedProof builds a genuine proof body: kind and v exactly as
// core will sign them, deviceID and nonceHex echoing one particular
// handshake.
func canonicalRevokedProof(deviceID, nonceHex string) map[string]any {
	return map[string]any{"kind": wire.RevokedProofKind, "v": int64(wire.RevokedProofVersion), "device_id": deviceID, "nonce": nonceHex}
}

// signedRevokedReply signs proof's canonical encoding with signer and wraps
// it in the auth_error frame shape the handshake reads.
func signedRevokedReply(t *testing.T, signer ed25519.PrivateKey, proof map[string]any) map[string]any {
	t.Helper()
	canon, err := wire.Canonical(proof)
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	return map[string]any{
		"type": wire.TypeAuthError, "reason": wire.ReasonRevoked,
		"proof": proof, "sig": hex.EncodeToString(ed25519.Sign(signer, canon)),
	}
}

// Review focus 5 / P5, as fixed in round 1: the ONE refusal that is final is
// a revoke core's PINNED key actually signed, over this device's own id and
// this exact handshake's own nonce. Run must return ErrRevoked and must NOT
// reconnect — a PROVEN revoke is final, not a retry.
func TestARevokedDeviceProvenByCoresSignatureIsFatalAndRunSaysSo(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-revoked-proven-1"
	srv, attempts := provenRevokedCore(t, corePub, devPub, func(nonceHex string) map[string]any {
		return signedRevokedReply(t, corePriv, canonicalRevokedProof(deviceID, nonceHex))
	})
	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	agent.backoffs = []time.Duration{20 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := agent.Run(ctx)
	if !errors.Is(err, ErrRevoked) {
		t.Fatalf("Run = %v, want ErrRevoked", err)
	}
	if attempts() != 1 {
		t.Fatalf("a PROVEN revoke is final: %d connection attempts", attempts())
	}
}

// Fix round 1, Finding 1: every near-miss on the required proof shape must
// be retried, never wiped — the exact vulnerability the finding named. A
// missing proof, a wrong kind/device_id/nonce (even signed correctly BY THE
// PINNED KEY over that wrong content), a signature from a key that is not
// the one pinned at enrollment (never the key merely claimed in the
// challenge frame — that IS the forged-socket attack), and a signature
// valid for some OTHER proof body tampered onto a different one, must all
// leave Run retrying with backoff and must never return ErrRevoked.
func TestAnUnprovenRevocationIsRetriedNeverWiped(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader) // NOT the pinned key
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-revoked-unproven-1"

	cases := []struct {
		name  string
		build func(nonceHex string) map[string]any
	}{
		{"no proof at all", func(nonceHex string) map[string]any {
			return map[string]any{"type": wire.TypeAuthError, "reason": wire.ReasonRevoked}
		}},
		{"wrong kind", func(nonceHex string) map[string]any {
			p := canonicalRevokedProof(deviceID, nonceHex)
			p["kind"] = "not-revoked"
			return signedRevokedReply(t, corePriv, p)
		}},
		{"wrong device_id", func(nonceHex string) map[string]any {
			return signedRevokedReply(t, corePriv, canonicalRevokedProof("some-other-device", nonceHex))
		}},
		{"wrong nonce", func(nonceHex string) map[string]any {
			return signedRevokedReply(t, corePriv, canonicalRevokedProof(deviceID, strings.Repeat("00", 32)))
		}},
		{"signed by a different key", func(nonceHex string) map[string]any {
			return signedRevokedReply(t, otherPriv, canonicalRevokedProof(deviceID, nonceHex))
		}},
		{"tampered after signing", func(nonceHex string) map[string]any {
			signed := signedRevokedReply(t, corePriv, canonicalRevokedProof(deviceID, nonceHex))
			signed["proof"] = canonicalRevokedProof("swapped-after-signing", nonceHex)
			return signed
		}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv, attempts := provenRevokedCore(t, corePub, devPub, c.build)
			agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
			agent.backoffs = []time.Duration{20 * time.Millisecond}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			runErr := runAgent(t, ctx, agent)
			waitFor(t, 2*time.Second, func() bool { return attempts() >= 2 })
			cancel()
			select {
			case err := <-runErr:
				if errors.Is(err, ErrRevoked) {
					t.Fatalf("%s: an unproven revocation must never wipe (ErrRevoked), got %v", c.name, err)
				}
			case <-time.After(2 * time.Second):
				t.Fatalf("%s: Run did not return after ctx was cancelled", c.name)
			}
		})
	}
}

// buildAgentWithHubs is buildAgent with an ordered locator list (S42b).
func buildAgentWithHubs(t *testing.T, hubs []string, deviceID, corePubHex string, devPriv ed25519.PrivateKey) *Agent {
	t.Helper()
	home := t.TempDir()
	auditLog, err := audit.Open(filepath.Join(home, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{DeviceID: deviceID, Name: "itest", Server: hubs[0], CorePubKey: corePubHex, Locators: hubs}
	agent, err := New(cfg, devPriv, auditLog, home, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	agent.gatherFrame = hermeticFrame
	return agent
}

// acceptingCore answers the challenge with corePub and reports each device
// that authenticated on it. Before signaling, it reads one more frame — the
// facts frame serve() sends as its first act (sendFacts, before the read
// loop) — rather than signaling the instant its own "ready" write returns.
// Without this, a caller that waits on authed and then reads agent.Server()
// races the client's own post-handshake bookkeeping (current.Store, in
// sessionAt, which happens strictly before serve() and so strictly before
// that facts write): the server's write of "ready" returning is not
// ordered against the client having processed it at all, and measurement
// (30/30 runs failing under go test -count=30) showed the client losing
// that race almost every time. Reading a frame the client can only have
// sent from inside serve() — reachable only after current.Store — makes the
// wait, and so the assertion after it, deterministic.
func acceptingCore(t *testing.T, corePub, devPub ed25519.PublicKey, authed chan<- string, label string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		if fakeCoreHandshake(r.Context(), c, corePub, devPub) != nil {
			_, _ = coreRead(r.Context(), c) // the facts frame serve() sends first
			authed <- label
		}
		<-r.Context().Done()
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestTheAgentFallsThroughToTheNextLocatorWhenTheFirstDoesNotAnswer(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	authed := make(chan string, 4)
	second := acceptingCore(t, corePub, devPub, authed, "second")
	agent := buildAgentWithHubs(t, []string{"http://127.0.0.1:1", second.URL}, "dev-loc-1", hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	select {
	case got := <-authed:
		if got != "second" {
			t.Fatalf("authenticated on %s", got)
		}
	case <-ctx.Done():
		t.Fatal("the agent never tried its second locator")
	}
	if agent.Server() != second.URL {
		t.Fatalf("Server() = %q, want the locator in use %q", agent.Server(), second.URL)
	}
}

// The loopback of a machine that no longer hosts THIS Nova (the hub moved)
// can answer with another Nova's key: that locator is skipped, not fatal,
// while another locator remains.
func TestALocatorPresentingAnotherCoreKeyIsSkippedWhileAnotherRemains(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	authed := make(chan string, 4)
	stranger := acceptingCore(t, otherPub, devPub, authed, "stranger")
	ours := acceptingCore(t, corePub, devPub, authed, "ours")
	agent := buildAgentWithHubs(t, []string{stranger.URL, ours.URL}, "dev-loc-2", hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runErr := runAgent(t, ctx, agent)
	select {
	case got := <-authed:
		if got != "ours" {
			t.Fatalf("authenticated on %s — the pinned key must decide", got)
		}
	case err := <-runErr:
		t.Fatalf("Run returned %v — a stranger's key must not be fatal while another locator remains", err)
	case <-ctx.Done():
		t.Fatal("timed out")
	}
}

func TestEveryLocatorPresentingAnotherKeyIsFatal(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	authed := make(chan string, 4)
	a := acceptingCore(t, otherPub, devPub, authed, "a")
	b := acceptingCore(t, otherPub, devPub, authed, "b")
	agent := buildAgentWithHubs(t, []string{a.URL, b.URL}, "dev-loc-3", hex.EncodeToString(corePub), devPriv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := agent.Run(ctx)
	if err == nil || ctx.Err() != nil || !strings.Contains(err.Error(), "pinned") {
		t.Fatalf("Run = %v, want a fatal naming the pin", err)
	}
}

// Controller ruling (preflight F1, item 2): the brief's own connectOnce kept
// lastErr = err (the fatal{KeyMismatch} wrapper) for a skipped mismatch, so
// a mismatch tried LAST beside a locator that merely failed to dial would
// itself look fatal to Run's own errors.As(err, &fatal{}) check, and Run
// would stop instead of retrying. The fix keeps lastErr = f.err (the
// unwrapped *KeyMismatch), which Run's fatal check does not match, so Run
// keeps retrying (backoff, never a return) until ctx ends the test.
func TestATrailingMismatchBesideADialFailureDoesNotEndRun(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	authed := make(chan string, 4)
	// The dial failure comes FIRST, the mismatch LAST — the order that
	// exposed the defect.
	stranger := acceptingCore(t, otherPub, devPub, authed, "stranger")
	agent := buildAgentWithHubs(t, []string{"http://127.0.0.1:1", stranger.URL}, "dev-loc-4", hex.EncodeToString(corePub), devPriv)
	agent.backoffs = []time.Duration{20 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	err := agent.Run(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Run = %v, want context.DeadlineExceeded — a trailing mismatch beside a dial failure must keep retrying, not end Run", err)
	}
}

// P7: the result and its audit entry are on the wire BEFORE the agent leaves
// for the swap; Run then returns ErrRestartForUpdate (main exits 75).
func TestAnUpdateReplyIsWrittenBeforeTheAgentLeavesForTheSwap(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-update-1"
	build := []byte("the hub's new build")
	sum := sha256.Sum256(build)
	name := "novad-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	type observed struct {
		result, audit map[string]any
		closeErr      error
	}
	results := make(chan observed, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agent/dist/"+name, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(build) })
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		if fakeCoreHandshake(ctx, c, corePub, devPub) == nil {
			return
		}
		if first, _ := coreRead(ctx, c); first["type"] != "facts" {
			return
		}
		now := time.Now().Unix()
		env := map[string]any{
			"v": int64(1), "envelope_id": "upd-e1", "device_id": deviceID, "capability": "daemon.update",
			"args":      map[string]any{"version": "aaaaaaaaaaaa", "sha256": hex.EncodeToString(sum[:]), "path": "/api/v1/agent/dist/" + name},
			"issued_at": now, "expires_at": now + 60,
		}
		canon, _ := wire.Canonical(env)
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": hex.EncodeToString(ed25519.Sign(corePriv, canon))})
		// Keep reading past the result: the audit entry (Minor 4, fix round
		// 1) follows it, and then the agent closes the socket itself
		// (Minor 5) to leave for the swap — that close is what ends this
		// loop, so its status/reason is observable too.
		var obs observed
		for {
			f, err := coreRead(ctx, c)
			if err != nil {
				obs.closeErr = err
				results <- obs
				return
			}
			switch f["type"] {
			case "result":
				obs.result = f
			case "audit":
				if raw, ok := f["entries"].([]any); ok && len(raw) > 0 {
					if m, ok := raw[0].(map[string]any); ok {
						obs.audit = m
					}
				}
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	dir := t.TempDir()
	bin := filepath.Join(dir, "novad")
	if err := os.WriteFile(bin, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	agent.Configure(Options{StateDir: dir, Supervised: true, Binary: bin})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	runErr := runAgent(t, ctx, agent)
	select {
	case obs := <-results:
		if ok, _ := obs.result["ok"].(bool); !ok {
			t.Fatalf("result = %v", obs.result)
		}
		if ok, _ := obs.audit["ok"].(bool); !ok {
			t.Fatalf("audit entry = %v", obs.audit)
		}
		if code := websocket.CloseStatus(obs.closeErr); code != websocket.StatusNormalClosure {
			t.Errorf("close status = %v (%v), want StatusNormalClosure — a graceful close, not the deferred CloseNow", code, obs.closeErr)
		}
		if obs.closeErr == nil || !strings.Contains(obs.closeErr.Error(), "restarting into a new build") {
			t.Errorf("close reason missing %q, got %v", "restarting into a new build", obs.closeErr)
		}
	case <-ctx.Done():
		t.Fatal("no result+audit frame")
	}
	select {
	case err := <-runErr:
		if !errors.Is(err, ErrRestartForUpdate) {
			t.Fatalf("Run = %v, want ErrRestartForUpdate", err)
		}
	case <-ctx.Done():
		t.Fatal("the agent never left for the swap")
	}
}

// F1 pin (fix round 1, Minor 4): daemon.update downloads from the locator
// THIS session is actually connected through (Server(), Task 6's F1
// ruling), never blindly the first configured locator. The first locator
// here is a black hole; only the second answers, so if BaseURL were wired
// to anything but a.Server() the download would try the dead address and
// the result would never come back ok.
func TestDaemonUpdateDownloadsFromTheLocatorThisSessionIsActuallyOn(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-update-locator-1"
	build := []byte("the hub's new build")
	sum := sha256.Sum256(build)
	name := "novad-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	results := make(chan map[string]any, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agent/dist/"+name, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(build) })
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		if fakeCoreHandshake(ctx, c, corePub, devPub) == nil {
			return
		}
		if first, _ := coreRead(ctx, c); first["type"] != "facts" {
			return
		}
		now := time.Now().Unix()
		env := map[string]any{
			"v": int64(1), "envelope_id": "upd-loc-e1", "device_id": deviceID, "capability": "daemon.update",
			"args":      map[string]any{"version": "aaaaaaaaaaaa", "sha256": hex.EncodeToString(sum[:]), "path": "/api/v1/agent/dist/" + name},
			"issued_at": now, "expires_at": now + 60,
		}
		canon, _ := wire.Canonical(env)
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": hex.EncodeToString(ed25519.Sign(corePriv, canon))})
		for {
			f, err := coreRead(ctx, c)
			if err != nil {
				return
			}
			if f["type"] == "result" {
				results <- f
				return
			}
		}
	})
	live := httptest.NewServer(mux)
	defer live.Close()
	agent := buildAgentWithHubs(t, []string{"http://127.0.0.1:1", live.URL}, deviceID, hex.EncodeToString(corePub), devPriv)
	dir := t.TempDir()
	bin := filepath.Join(dir, "novad")
	if err := os.WriteFile(bin, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	agent.Configure(Options{StateDir: dir, Supervised: true, Binary: bin})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	select {
	case res := <-results:
		if ok, _ := res["ok"].(bool); !ok {
			t.Fatalf("result = %v — the download must succeed against the SECOND (live) locator, the one this session is actually on", res)
		}
	case <-ctx.Done():
		t.Fatal("no result frame — daemon.update likely tried the dead first locator instead of Server()")
	}
}

// I2 (fix round 1), Run's own half: a restart flagged before Run ever
// starts — standing in for a now-dead session's daemon.update finishing its
// download only after ITS OWN connection died, so sessionCancel no longer
// names anything useful — is caught at the TOP of the loop, before even
// dialing. Proven by counting connection ARRIVALS at a live, otherwise-
// perfectly-answering fake core: a timing bound alone would not isolate
// this from the (also-present) after-connectOnce check, since a refused
// dial can be just as fast as never dialing at all.
func TestRunNeverDialsWhenARestartIsAlreadyPending(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	srv, arrivals := countingCore(t, corePub, devPub, false, false)
	agent, _ := buildAgent(t, srv.URL, "dev-restart-race-1", hex.EncodeToString(corePub), devPriv)
	agent.restart.Store(true)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := agent.Run(ctx)
	if !errors.Is(err, ErrRestartForUpdate) {
		t.Fatalf("Run = %v, want ErrRestartForUpdate", err)
	}
	if n := len(arrivals()); n != 0 {
		t.Fatalf("Run dialed the hub %d time(s) — it must never dial at all once a restart is already pending", n)
	}
}

// I2 (fix round 1), serve's own half: a restart already pending when a NEW
// session starts is caught right after sessionCancel.Store, before this
// session serves anything — not even the facts frame. Proven directly
// against serve() with a connection whose write lock is already held
// forever: without the fix, sendFacts's write would block on it until
// pingTimeout; with the fix, serve returns long before that write is ever
// attempted.
func TestServeRefusesToStartASessionWhenARestartIsAlreadyPending(t *testing.T) {
	conn := blockedConn(t)
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	agent, _ := buildAgent(t, "http://unused.invalid", "dev-restart-race-2", hex.EncodeToString(corePub), devPriv)
	agent.pingTimeout = 100 * time.Millisecond
	agent.restart.Store(true)

	errCh := make(chan error, 1)
	start := time.Now()
	go func() { errCh <- agent.serve(context.Background(), conn) }()
	select {
	case err := <-errCh:
		if !errors.Is(err, ErrRestartForUpdate) {
			t.Fatalf("serve = %v, want ErrRestartForUpdate", err)
		}
		if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
			t.Fatalf("serve took %s — it must return before ever attempting to write (a write would block on this connection's held lock until pingTimeout)", elapsed)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("serve never returned — a pending restart did not stop it from trying to serve this session")
	}
}

// P29, Review Focus 11: the slow probes run once at connect — after the
// first frame, off the reader's path — and again on facts.refresh; never on
// the minute cadence. Every frame between carries the last result.
func TestTheProbesRunAtConnectAndOnRefreshOnly(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-probe-1"
	pidOf := func(f map[string]any) string {
		s, _ := f["service"].(map[string]any)
		n, _ := s["pid"].(json.Number)
		return n.String()
	}
	type seen struct{ before, after []string }
	got := make(chan seen, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		if fakeCoreHandshake(ctx, c, corePub, devPub) == nil {
			return
		}
		var s seen
		// The ready frame, the probe's frame, and at least two on the cadence.
		for len(s.before) < 4 || !slices.Contains(s.before, "1") {
			f, err := coreRead(ctx, c)
			if err != nil {
				return
			}
			if f["type"] == "facts" {
				s.before = append(s.before, pidOf(f))
			}
		}
		now := time.Now().Unix()
		env := map[string]any{
			"v": int64(1), "envelope_id": "probe-e1", "device_id": deviceID,
			"capability": "facts.refresh", "args": map[string]any{},
			"issued_at": now, "expires_at": now + 60,
		}
		canon, _ := wire.Canonical(env)
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": hex.EncodeToString(ed25519.Sign(corePriv, canon))})
		for {
			f, err := coreRead(ctx, c)
			if err != nil {
				return
			}
			switch f["type"] {
			case "facts":
				s.after = append(s.after, pidOf(f))
			case "audit":
				got <- s
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	var probes atomic.Int32
	agent.probe = func(context.Context) facts.Probed {
		n := probes.Add(1)
		return facts.Probed{At: time.Now(), Service: facts.Service{Name: "novad.service", PID: int(n)}}
	}
	agent.factsMinGap, agent.factsEvery, agent.heartbeatEvery = 10*time.Millisecond, 40*time.Millisecond, 20*time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	var s seen
	select {
	case s = <-got:
	case <-ctx.Done():
		t.Fatal("timed out")
	}
	if s.before[0] != "" {
		t.Fatalf("the frame at ready waited for the probe: %v", s.before)
	}
	for _, pid := range s.before {
		if pid != "" && pid != "1" {
			t.Fatalf("frames before the refresh = %v: the cadence probed again", s.before)
		}
	}
	if len(s.after) == 0 || s.after[len(s.after)-1] != "2" || probes.Load() != 2 {
		t.Fatalf("after the refresh = %v with %d probes, want exactly one more probe, carried", s.after, probes.Load())
	}
}

// Ruling 4: at connect the probes run at most once per ProbeMaxAge across
// reconnects. A reconnect while one is still running starts no second one
// beside it, and a probe whose session ended before it finished is neither
// cut short nor lost: the next session's frames carry it.
func TestTheConnectProbeRunsOnceAcrossReconnects(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	readyPIDs := make(chan string, 64)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		if fakeCoreHandshake(ctx, c, corePub, devPub) == nil {
			return
		}
		f, err := coreRead(ctx, c) // the frame at ready; then the session ends
		if err != nil {
			return
		}
		s, _ := f["service"].(map[string]any)
		n, _ := s["pid"].(json.Number)
		select {
		case readyPIDs <- n.String():
		default:
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, "dev-probe-2", hex.EncodeToString(corePub), devPriv)
	agent.backoffs = []time.Duration{10 * time.Millisecond}
	release := make(chan struct{})
	var probes atomic.Int32
	agent.probe = func(ctx context.Context) facts.Probed {
		n := probes.Add(1)
		select {
		case <-release:
		case <-ctx.Done():
		}
		return facts.Probed{At: time.Now(), Service: facts.Service{Name: "novad.service", PID: int(n)}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	next := func() string {
		t.Helper()
		select {
		case pid := <-readyPIDs:
			return pid
		case <-ctx.Done():
			t.Fatal("timed out")
			return ""
		}
	}
	for i := 0; i < 3; i++ {
		if pid := next(); pid != "" {
			t.Fatalf("session %d's frame at ready carried pid %q before any probe finished", i+1, pid)
		}
	}
	if n := probes.Load(); n != 1 {
		t.Fatalf("%d probes after three sessions while the first still ran — a reconnect started another", n)
	}
	close(release)
	for next() != "1" {
	}
	for i := 0; i < 3; i++ {
		if pid := next(); pid != "1" {
			t.Fatalf("a later session's frame at ready carried pid %q, want the kept probe's 1", pid)
		}
	}
	if n := probes.Load(); n != 1 {
		t.Fatalf("%d probes — a reconnect within ProbeMaxAge probed again", n)
	}
}

// Configure wires the probes to what main hands the agent — its binary and
// config file — and runs their programs through probeRunner, which this
// package's tests replace so no test runs sudo or wsl.exe.
func TestConfigureProbesThroughTheRunnerWithTheAgentsOwnFiles(t *testing.T) {
	old := probeRunner
	r := &platform.FakeRunner{Outputs: map[string]string{"sudo": ""}}
	probeRunner = r
	t.Cleanup(func() { probeRunner = old })
	a := &Agent{}
	bin, cfg := filepath.Join(t.TempDir(), "novad"), filepath.Join(t.TempDir(), "config.json")
	a.Configure(Options{Binary: bin, Config: cfg})
	p := a.probe(context.Background())
	if p.Service.Binary != bin || p.Service.Config != cfg || p.Service.Process != "novad" || p.At.IsZero() {
		t.Fatalf("got %+v", p)
	}
	if runtime.GOOS != "windows" {
		if p.Elevation == nil || p.Elevation.Sudo != "no_password" || len(r.Calls) != 1 || r.Calls[0].Name != "sudo" {
			t.Fatalf("elevation %+v after calls %+v — sudo -n true through the runner Configure was given", p.Elevation, r.Calls)
		}
	}
}

// nextFacts reads frames until a facts frame; nil when the socket ends.
func nextFacts(ctx context.Context, c *websocket.Conn) map[string]any {
	for {
		f, err := coreRead(ctx, c)
		if err != nil {
			return nil
		}
		if f["type"] == "facts" {
			return f
		}
	}
}

// saidOf is what a frame's unreadable list says about item.
func saidOf(f map[string]any, item string) string {
	list, _ := f["unreadable"].([]any)
	for _, u := range list {
		if m, _ := u.(map[string]any); m["item"] == item {
			s, _ := m["reason"].(string)
			return s
		}
	}
	return ""
}

// Fix round 1, I1: a probe program that ignores its kill — sudo, once root,
// answers an unprivileged agent's SIGKILL with EPERM — holds nothing past
// the probe's bound. The probe returns then and says so, probing clears, the
// next connection probes again (a probe cut short is not kept), and
// facts.refresh answers within the bound instead of waiting on sudo.
func TestAProbeWhoseProgramIgnoresItsKillIsLeftAtItsBound(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("on Windows the probe runs no program unless WSL lists distributions; facts' tests hand one in")
	}
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-probe-bound-1"
	type seen struct {
		probeAfter    time.Duration
		probeSaid     string
		elevation     map[string]any
		kept, again   bool
		refreshTook   time.Duration
		refreshSaid   string
		refreshResult map[string]any
	}
	got, first := make(chan seen, 1), make(chan seen, 1)
	var sessions atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		n := sessions.Add(1)
		if n > 2 {
			<-ctx.Done() // nothing is asked of a later session; it waits for the agent to leave
			return
		}
		if fakeCoreHandshake(ctx, c, corePub, devPub) == nil {
			return
		}
		ready := nextFacts(ctx, c)
		start := time.Now()
		if n == 1 {
			probe := nextFacts(ctx, c)
			elevation, _ := probe["elevation"].(map[string]any)
			first <- seen{probeAfter: time.Since(start), probeSaid: saidOf(probe, "elevation"), elevation: elevation}
			return // the session ends; the next one must probe again
		}
		var s seen
		select {
		case s = <-first:
		case <-ctx.Done():
			return
		}
		_, s.kept = ready["service"].(map[string]any)
		s.again = nextFacts(ctx, c) != nil
		now := time.Now().Unix()
		env := map[string]any{"v": int64(1), "envelope_id": "bound-e1", "device_id": deviceID,
			"capability": "facts.refresh", "args": map[string]any{}, "issued_at": now, "expires_at": now + 60}
		canon, _ := wire.Canonical(env)
		sent := time.Now()
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": hex.EncodeToString(ed25519.Sign(corePriv, canon))})
		for {
			f, err := coreRead(ctx, c)
			if err != nil {
				return
			}
			switch f["type"] {
			case "facts":
				s.refreshSaid = saidOf(f, "elevation")
			case "result":
				s.refreshTook, s.refreshResult = time.Since(sent), f
				got <- s
				// Held open until the agent leaves at the test's end: while
				// this session lives no later one connects, so no connect
				// probe can run a fourth sudo under the count below.
				<-ctx.Done()
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	hold := make(chan struct{})
	defer close(hold)
	r := &platform.FakeRunner{Hold: hold}
	old := probeRunner
	probeRunner = r
	defer func() { probeRunner = old }()
	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	agent.Configure(Options{Binary: filepath.Join(t.TempDir(), "novad"), Config: filepath.Join(t.TempDir(), "config.json")})
	// The programs are cut at 500 ms; reprobe waits until 1.5 s — a second
	// to spare, so the probe's own answer always wins under load.
	agent.probeBudget, agent.probeGrace = 1500*time.Millisecond, time.Second
	agent.backoffs = []time.Duration{10 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	var s seen
	select {
	case s = <-got:
	case <-ctx.Done():
		t.Fatal("timed out")
	}
	if s.probeAfter > 5*time.Second || s.probeSaid != "sudo: gave no answer in time" {
		t.Fatalf("the probe frame came %s after ready, saying %q", s.probeAfter, s.probeSaid)
	}
	// Fix round 2: what the agent knows is kept — elevated is its own read —
	// and sudo is unknown, with the reason.
	if _, ok := s.elevation["elevated"].(bool); !ok || s.elevation["sudo"] != "unknown" || s.elevation["sudo_said"] != "sudo: gave no answer in time" {
		t.Fatalf("elevation = %v", s.elevation)
	}
	if !s.kept || !s.again {
		t.Fatalf("carried at the next connect %v, probed again there %v", s.kept, s.again)
	}
	if ok, _ := s.refreshResult["ok"].(bool); !ok || s.refreshTook > 5*time.Second || s.refreshSaid != "sudo: gave no answer in time" {
		t.Fatalf("facts.refresh answered %v after %s, its frame saying %q", s.refreshResult, s.refreshTook, s.refreshSaid)
	}
	sudo := 0
	for _, c := range r.Recorded() {
		if c.Name == "sudo" {
			sudo++
		}
	}
	agent.factsMu.Lock()
	probing := agent.probing
	agent.factsMu.Unlock()
	if sudo != 3 || probing {
		t.Fatalf("%d sudo runs (want connect, connect again, refresh), probing %v", sudo, probing)
	}
}

// Fix round 1, I1: whatever a probe does — even ignore its ctx outright — it
// is waited for at most probeBudget. probing clears, nothing it answers later
// is kept, the next connection probes again, and facts.refresh says so.
func TestAProbeThatNeverAnswersIsLeftAtItsBudget(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-probe-budget-1"
	results := make(chan map[string]any, 1)
	var sessions atomic.Int32
	var sawProbe atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		if fakeCoreHandshake(ctx, c, corePub, devPub) == nil {
			return
		}
		if sessions.Add(1) > 1 {
			for f := nextFacts(ctx, c); f != nil; f = nextFacts(ctx, c) {
				if _, ok := f["service"]; ok {
					sawProbe.Store(true)
				}
			}
			return
		}
		nextFacts(ctx, c)                  // the frame at ready
		time.Sleep(600 * time.Millisecond) // four budgets: the connect probe was given up on
		now := time.Now().Unix()
		env := map[string]any{"v": int64(1), "envelope_id": "budget-e1", "device_id": deviceID,
			"capability": "facts.refresh", "args": map[string]any{}, "issued_at": now, "expires_at": now + 60}
		canon, _ := wire.Canonical(env)
		sent := time.Now()
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": hex.EncodeToString(ed25519.Sign(corePriv, canon))})
		for {
			f, err := coreRead(ctx, c)
			if err != nil {
				return
			}
			switch f["type"] {
			case "facts":
				if _, ok := f["service"]; ok {
					sawProbe.Store(true)
				}
			case "result":
				f["took"] = time.Since(sent)
				results <- f
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	release := make(chan struct{})
	defer close(release)
	var probes atomic.Int32
	agent.probe = func(context.Context) facts.Probed {
		probes.Add(1)
		<-release // deaf to its ctx
		return facts.Probed{At: time.Now(), Service: facts.Service{Name: "late"}}
	}
	agent.probeBudget, agent.probeGrace = 150*time.Millisecond, 50*time.Millisecond
	agent.backoffs = []time.Duration{10 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	var res map[string]any
	select {
	case res = <-results:
	case <-ctx.Done():
		t.Fatal("timed out")
	}
	took, _ := res["took"].(time.Duration)
	errText, _ := res["error"].(string)
	if ok, _ := res["ok"].(bool); ok || took > 3*time.Second || !strings.Contains(errText, "the probes gave no answer within 150ms") {
		t.Fatalf("facts.refresh = %v after %s", res, took)
	}
	deadline := time.Now().Add(5 * time.Second)
	for probes.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := probes.Load(); n != 3 || sawProbe.Load() {
		t.Fatalf("%d probes (want connect, refresh, next connect), a late answer carried %v", n, sawProbe.Load())
	}
}

// Fix round 1, Minor 3: findings that would take the frame over core's cap
// are left out, and the frame says so — they never stop every facts frame.
func TestAProbeThatWouldOverfillTheFrameIsLeftOutAndSaid(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	agent, _ := buildAgent(t, "http://unused.invalid", "dev-probe-cap-1", hex.EncodeToString(corePub), devPriv)
	long := strings.Repeat("x", 255)
	distros := make([]facts.Distro, 8)
	for i := range distros {
		distros[i] = facts.Distro{Name: fmt.Sprintf("%d%s", i, long[1:]), Running: true, Looked: true, PID1: long, User: long,
			Sudo: "refused", SudoSaid: long, Unit: &facts.Unit{Active: long, File: long, Restart: long, Said: long}, PIDs: []int{1}}
	}
	agent.probed = &facts.Probed{At: time.Now(), Service: facts.Service{Name: long, Binary: long, Config: long},
		WSL: &facts.WSLDistros{Distros: distros}}
	data, err := agent.frameBytes()
	if err != nil {
		t.Fatalf("the frame was not built: %v", err)
	}
	var f map[string]any
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	_, hasNet := f["net"]
	if len(data) > facts.MaxFrameBytes || f["service"] != nil || f["wsl_distros"] != nil || f["probed_at"] != nil || !hasNet ||
		!strings.Contains(saidOf(f, "probe"), "over the 16384-byte cap; they are left out") {
		t.Fatalf("%d bytes: %s", len(data), data)
	}
	agent.probed = &facts.Probed{At: time.Now(), Service: facts.Service{Name: "novad.service"}}
	if data, err = agent.frameBytes(); err != nil || !strings.Contains(string(data), `"service":`) {
		t.Fatalf("a probe that fits is carried: %s, %v", data, err)
	}
}

// probeRunnerAtLoad is probeRunner as the package set it up — package-level
// variables are initialized before any init() — so the test below reads the
// wiring itself, not the fake this package's init() puts in its place.
var probeRunnerAtLoad = probeRunner

// Fix round 1, I1 (fix round 2: the wiring itself): the probes' real
// programs run through probeExec, which has a WaitDelay.
func TestTheProbesRealRunnerHasAWaitDelay(t *testing.T) {
	if probeRunnerAtLoad != platform.Runner(probeExec) || probeExec.WaitDelay <= 0 {
		t.Fatalf("probeRunner starts as %#v; probeExec = %+v", probeRunnerAtLoad, probeExec)
	}
	if _, fake := probeRunner.(*platform.FakeRunner); !fake {
		t.Fatalf("this package's tests must run with the fake, got %#v", probeRunner)
	}
}

// New gathers the facts frame through facts.GatherFrame. Every agent the
// tests here build reads hermeticFrame instead, so this holds the one line
// that stands in for.
func TestNewGathersTheFactsFrameThroughGatherFrame(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	cfg := config.Config{DeviceID: "dev-wiring-1", Server: "http://unused.invalid", CorePubKey: hex.EncodeToString(corePub)}
	a, err := New(cfg, devPriv, nil, t.TempDir(), "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	if reflect.ValueOf(a.gatherFrame).Pointer() != reflect.ValueOf(facts.GatherFrame).Pointer() {
		t.Fatal("New must read the facts frame through facts.GatherFrame")
	}
}

// stateDirNow is every file under dir and what it holds, read now. A dir
// not made yet holds nothing.
func stateDirNow(dir string) (map[string]string, error) {
	files := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == dir && errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(rel)] = string(body)
		return nil
	})
	return files, err
}

// PR #106's windows-11-arm run: t.TempDir's cleanup found the state dir
// still being written — a refused replay's audit append, from a command
// handler Run had never waited for. Run returns only once every worker it
// started is done. Here a facts.refresh is held mid-command (its frame's
// gather waits on the test, deaf to every context) when the agent is
// stopped: Run must not return while it runs, the command's audit entry is
// on disk the moment Run returns, and nothing in the state dir — the audit
// log, the status file OnState writes — changes after.
func TestNothingTheAgentStartedWritesItsStateDirAfterRunReturns(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-stop-1"
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		if fakeCoreHandshake(ctx, c, corePub, devPub) == nil || nextFacts(ctx, c) == nil {
			return
		}
		now := time.Now().Unix()
		env := map[string]any{"v": int64(1), "envelope_id": "stop-e1", "device_id": deviceID,
			"capability": "facts.refresh", "args": map[string]any{}, "issued_at": now, "expires_at": now + 60}
		canon, _ := wire.Canonical(env)
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": hex.EncodeToString(ed25519.Sign(corePriv, canon))})
		for {
			if _, err := coreRead(ctx, c); err != nil {
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	stateDir := filepath.Join(agent.deps.Home, ".local", "state", "novad")
	// What main's agentStatusWriter does at each change of connection state.
	// Set without Configure: no connect probe sends a frame of its own.
	agent.opts = Options{StateDir: stateDir, OnState: func(st, server string, _ error) {
		if err := state.WriteJSON(filepath.Join(stateDir, state.AgentStatusFile), state.AgentStatus{V: 1, State: st, Server: server}); err != nil {
			t.Errorf("writing the status: %v", err)
		}
	}}
	held, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	free := func() { once.Do(func() { close(release) }) }
	var gathers atomic.Int32
	agent.gatherFrame = func(carried []facts.Unreadable) facts.Frame {
		if gathers.Add(1) == 2 { // the refresh's frame; the first went out at ready
			close(held)
			<-release
		}
		return hermeticFrame(carried)
	}

	type stopped struct {
		files map[string]string
		err   error
	}
	ctx, cancel := context.WithCancel(context.Background())
	returned, done := make(chan stopped, 1), make(chan struct{})
	go func() {
		defer close(done)
		_ = agent.Run(ctx)
		files, err := stateDirNow(stateDir) // the state dir as it is the moment Run returns
		returned <- stopped{files, err}
	}()
	t.Cleanup(func() { // whatever failed: the held gather let go, and Run waited for
		cancel()
		free()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Errorf("Run never returned")
		}
	})
	select {
	case <-held:
	case <-time.After(10 * time.Second):
		t.Fatal("the refresh never reached its frame")
	}

	cancel()
	var at stopped
	early := false
	select {
	case at = <-returned:
		early = true
	case <-time.After(300 * time.Millisecond):
	}
	free()
	if !early {
		select {
		case at = <-returned:
		case <-time.After(10 * time.Second):
			t.Fatal("Run did not return once the command it was waiting for had finished")
		}
	}
	if at.err != nil {
		t.Fatalf("reading the state dir when Run returned: %v", at.err)
	}
	// A writer still running when Run returned writes within moments of being
	// let go: watch for it.
	after := at.files
	for deadline := time.Now().Add(300 * time.Millisecond); maps.Equal(after, at.files) && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
		files, err := stateDirNow(stateDir)
		if err != nil {
			t.Fatal(err)
		}
		after = files
	}

	if early {
		t.Error("Run returned while a command it started was still running")
	}
	if !strings.Contains(at.files["audit.jsonl"], `"envelope_id":"stop-e1"`) {
		t.Errorf("when Run returned, the audit log held no entry for the command it stopped: %q", at.files["audit.jsonl"])
	}
	if !maps.Equal(after, at.files) {
		t.Errorf("the state dir changed after Run returned:\nat return: %q\nafter:     %q", at.files, after)
	}
}
