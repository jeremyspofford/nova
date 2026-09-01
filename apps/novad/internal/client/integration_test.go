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
	paths.DenyRootsFile = filepath.Join(paths.ConfigDir, "deny_roots")
	deny, err := config.LoadDenyRoots(paths)
	if err != nil {
		t.Fatal(err)
	}
	auditLog, err := audit.Open(paths.AuditFile)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{DeviceID: deviceID, Name: "itest", Server: srv.URL, CorePubKey: hex.EncodeToString(corePub)}
	agent, err := New(cfg, devPriv, deny, auditLog, home, nil)
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
