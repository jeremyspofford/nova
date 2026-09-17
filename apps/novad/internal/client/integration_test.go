package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"novad/internal/audit"
	"novad/internal/config"
	"novad/internal/wire"
)

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
	agent, err := New(cfg, devPriv, auditLog, home, nil)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() { _ = agent.Run(ctx) }()

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
	agent, err := New(cfg, devPriv, auditLog, home, nil)
	if err != nil {
		t.Fatal(err)
	}
	return agent, auditLog
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
	go func() { _ = agent.Run(ctx) }()

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

	runErr := make(chan error, 1)
	go func() { runErr <- agent.Run(ctx) }()

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
	go func() { _ = agent.Run(ctx) }()

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
