package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"

	"novad/internal/jobs"
	"novad/internal/platform"
	"novad/internal/wire"
)

// Every command's deps carry the job store under the agent's state dir, the
// agent's own binary (the wrapper is `<binary> job-exec <dir>`) and its mode.
func TestCommandDepsCarryTheJobStore(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	agent, _ := buildAgent(t, "http://unused.invalid", "dev-jobs-0", hex.EncodeToString(corePub), devPriv)
	if d := agent.commandDeps(nil); d.Jobs != nil {
		t.Fatalf("an agent with no state dir has a job store: %+v", d.Jobs)
	}
	stateDir := t.TempDir()
	bin := filepath.Join(t.TempDir(), "novad-bin")
	agent.Configure(Options{StateDir: stateDir, Binary: bin})
	d := agent.commandDeps(nil)
	if d.Jobs == nil {
		t.Fatal("no job store on a configured agent")
	}
	if d.Jobs.Store == nil || d.Jobs.Store.Root != filepath.Join(stateDir, "jobs") || d.Jobs.Binary != bin || d.Jobs.Mode != platform.Mode() {
		t.Fatalf("jobs deps = %+v (root %v)", d.Jobs, d.Jobs.Store)
	}
}

// A job.start through the socket keys the job to the verified envelope.
func TestAJobStartThroughTheSocketKeysTheSpecToItsEnvelope(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID = "dev-jobs-1"
	results := make(chan map[string]any, 1)
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
		now := time.Now().Unix()
		env := map[string]any{
			"v": int64(1), "envelope_id": "job-env-9", "device_id": deviceID,
			"capability": "job.start", "args": map[string]any{"job_id": "a1b2c3d4e5f6", "argv": []any{"true"}},
			"issued_at": now, "expires_at": now + 60,
		}
		canon, _ := wire.Canonical(env)
		_ = coreWrite(ctx, c, map[string]any{"type": "command", "envelope": env, "sig": hex.EncodeToString(ed25519.Sign(corePriv, canon))})
		var result map[string]any
		for {
			f, err := coreRead(ctx, c)
			if err != nil {
				break
			}
			switch f["type"] {
			case "result":
				result = f
			case "audit":
				results <- result
				return
			}
		}
		results <- result
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	agent, _ := buildAgent(t, srv.URL, deviceID, hex.EncodeToString(corePub), devPriv)
	stateDir := t.TempDir()
	// A binary that does not exist: the job is recorded failed_to_start, and
	// its spec is still on disk to read.
	agent.Configure(Options{StateDir: stateDir, Binary: filepath.Join(t.TempDir(), "absent-novad")})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	runAgent(t, ctx, agent)
	var res map[string]any
	select {
	case res = <-results:
	case <-ctx.Done():
		t.Fatal("timed out")
	}
	meta, _ := res["meta"].(map[string]any)
	if meta["state"] != jobs.StateFailedToStart || meta["job"] != "a1b2c3d4e5f6" {
		t.Fatalf("result = %v", res)
	}
	sp, err := jobs.NewStore(stateDir).Spec("a1b2c3d4e5f6")
	if err != nil || sp.EnvelopeID != "job-env-9" {
		t.Fatalf("spec = %+v (%v), want envelope_id job-env-9", sp, err)
	}
}
