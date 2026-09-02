// Package client is the daemon's half of the socket: it dials core, proves
// itself with the challenge, replays its audit chain, then serves signed
// commands in steady state. Every command is verified ON the device before it
// runs, and every outcome — success OR refusal — is both a result frame and an
// audit entry. The run loop reconnects on any socket error; a changed core key
// is the one fatal condition (the daemon's half of the mutual pinning).
package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"novad/internal/audit"
	"novad/internal/caps"
	"novad/internal/config"
	"novad/internal/wire"
)

// CommandTimeout bounds a single capability's execution. It sits under core's
// ≤120s command wait so the device answers before core gives up, and expiry is
// NOT re-checked during execution (verification is at receipt only).
const CommandTimeout = 110 * time.Second

// HeartbeatInterval is how often the daemon reports liveness; core derives the
// tile state from when it last heard, never from the reported ts.
const HeartbeatInterval = 20 * time.Second

// wsReadLimit raises coder/websocket's 32 KiB default so a signed fs.write
// command (content up to the 256 KiB write domain) is not rejected on read.
const wsReadLimit = 4 << 20

// fatal wraps a non-retryable condition: the run loop exits rather than
// reconnecting. Today that is exactly a changed core key.
type fatal struct{ err error }

func (f fatal) Error() string { return f.err.Error() }
func (f fatal) Unwrap() error { return f.err }

// Agent holds the pinned identity and the local capability + audit surfaces.
type Agent struct {
	cfg   config.Config
	priv  ed25519.PrivateKey
	deny  *config.DenyList
	audit *audit.Log
	deps  caps.Deps
	wsURL string
	logf  func(string, ...any)

	// verifier is built ONCE and reused across every reconnect, so its one-use
	// seen-set spans the envelope validity window (TTL + skew) rather than a
	// single socket lifetime. If it were rebuilt per connection, a command
	// redelivered after a socket flap inside its window would re-verify and
	// RE-EXECUTE — the replay defence has to outlive the socket. Its own pruning
	// (past expiry + skew) keeps the set from growing unbounded.
	verifier *wire.Verifier
}

// New assembles an agent from loaded custody. logf may be nil.
func New(cfg config.Config, priv ed25519.PrivateKey, deny *config.DenyList, log *audit.Log, home string, logf func(string, ...any)) (*Agent, error) {
	wsURL, err := WSURL(cfg.Server)
	if err != nil {
		return nil, err
	}
	// Pin the command verifier at construction. A bad core pubkey is a config
	// fault surfaced here at startup, not a mystery mid-run — and the one
	// instance now lives for the whole process.
	verifier, err := wire.NewVerifier(cfg.CorePubKey, cfg.DeviceID, nil)
	if err != nil {
		return nil, fmt.Errorf("cannot build command verifier: %w", err)
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Agent{
		cfg:      cfg,
		priv:     priv,
		deny:     deny,
		audit:    log,
		deps:     caps.Deps{Deny: deny, Home: home},
		wsURL:    wsURL,
		logf:     logf,
		verifier: verifier,
	}, nil
}

// WSURL derives the socket URL from the enrollment server URL: http->ws,
// https->wss, path /api/v1/devices/ws.
func WSURL(server string) (string, error) {
	u, err := url.Parse(server)
	if err != nil {
		return "", fmt.Errorf("server url is unparseable: %w", err)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
		// already a ws scheme
	default:
		return "", fmt.Errorf("server url scheme %q is neither http(s) nor ws(s)", u.Scheme)
	}
	u.Path = "/api/v1/devices/ws"
	u.RawQuery = ""
	return u.String(), nil
}

// Run connects, serves, and reconnects with a capped backoff until ctx is done
// or a fatal condition (a changed core key) is hit.
func (a *Agent) Run(ctx context.Context) error {
	backoffs := []time.Duration{1 * time.Second, 2 * time.Second, 5 * time.Second, 15 * time.Second, 30 * time.Second}
	attempt := 0
	for {
		err := a.connectOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var f fatal
		if errors.As(err, &f) {
			a.logf("fatal: %v — not reconnecting", f.err)
			return f.err
		}
		if err != nil {
			a.logf("connection ended: %v", err)
		}
		d := backoffs[min(attempt, len(backoffs)-1)]
		attempt++
		a.logf("reconnecting in %s", d)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
		}
	}
}

func (a *Agent) connectOnce(ctx context.Context) error {
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	c, _, err := websocket.Dial(dialCtx, a.wsURL, nil)
	cancel()
	if err != nil {
		return fmt.Errorf("dial %s: %w", a.wsURL, err)
	}
	defer c.CloseNow()
	c.SetReadLimit(wsReadLimit)

	if err := a.handshake(ctx, c); err != nil {
		return err
	}
	a.logf("authenticated; serving")
	return a.serve(ctx, c)
}

// handshake reads the challenge, refuses a core key that is not the pinned one
// (fatal), signs the RAW nonce bytes, sends auth, reads ready, and replays the
// audit chain from core's last_seq. The command verifier is NOT built here —
// it is a.verifier, constructed once in New and reused across reconnects so its
// one-use seen-set persists between connections.
func (a *Agent) handshake(ctx context.Context, c *websocket.Conn) error {
	hsCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	frame, err := readFrame(hsCtx, c)
	if err != nil {
		return fmt.Errorf("reading challenge: %w", err)
	}
	if t, _ := frame["type"].(string); t != wire.TypeChallenge {
		return fmt.Errorf("expected a challenge, got %q", t)
	}
	nonceHex, _ := frame["nonce"].(string)
	coreKey, _ := frame["core_pubkey"].(string)

	// TOFU: a changed core key is a refuse-and-exit, not a silent re-trust.
	if coreKey != a.cfg.CorePubKey {
		return fatal{fmt.Errorf("core presented key %s but we pinned %s at enrollment", short(coreKey), short(a.cfg.CorePubKey))}
	}

	nonce, err := hex.DecodeString(nonceHex)
	if err != nil {
		return fmt.Errorf("challenge nonce is not hex: %w", err)
	}
	sig := ed25519.Sign(a.priv, nonce) // RAW nonce bytes, not the hex string
	if err := writeFrame(hsCtx, c, wire.Auth{
		Type:     wire.TypeAuth,
		DeviceID: a.cfg.DeviceID,
		Sig:      hex.EncodeToString(sig),
		// Additive: core stores it as the suggested first fs root once the
		// signature verifies; a device enrolled before the field existed
		// reports it here on its next connect. See wire.Auth.
		HomeDir: a.deps.Home,
	}); err != nil {
		return fmt.Errorf("sending auth: %w", err)
	}

	reply, err := readFrame(hsCtx, c)
	if err != nil {
		return fmt.Errorf("reading ready/auth_error: %w", err)
	}
	switch t, _ := reply["type"].(string); t {
	case wire.TypeAuthError:
		reason, _ := reply["reason"].(string)
		// Retryable: a revoked device keeps being refused here, correctly; it
		// cannot get in, but a re-grant heals without a manual restart.
		return fmt.Errorf("core refused auth: %s", reason)
	case wire.TypeReady:
		if err := a.replayAudit(hsCtx, c, reply["last_seq"]); err != nil {
			return fmt.Errorf("replaying audit: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("expected ready or auth_error, got %q", t)
	}
}

func (a *Agent) replayAudit(ctx context.Context, c *websocket.Conn, lastSeqField any) error {
	after := int64(-1) // null last_seq -> replay the whole chain
	if lastSeqField != nil {
		if n, ok := lastSeqField.(json.Number); ok {
			if v, err := n.Int64(); err == nil {
				after = v
			}
		}
	}
	entries, err := a.audit.EntriesAfter(after)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return nil
	}
	a.logf("replaying %d audit entries after seq %d", len(entries), after)
	return writeFrame(ctx, c, auditFrame{Type: wire.TypeAudit, Entries: entries})
}

// serve runs the heartbeat writer and the single reader. Commands are handled
// in their own goroutines so the reader stays responsive (coder/websocket
// needs a live reader to handle control frames) and a slow command cannot
// block the heartbeat.
func (a *Agent) serve(ctx context.Context, c *websocket.Conn) error {
	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	go a.heartbeat(serveCtx, c)

	for {
		frame, err := readFrame(serveCtx, c)
		if err != nil {
			if code := websocket.CloseStatus(err); code != -1 {
				a.logf("socket closed by core: code %d", int(code))
			}
			return err
		}
		switch t, _ := frame["type"].(string); t {
		case wire.TypeCommand:
			go a.handleCommand(serveCtx, c, frame)
		default:
			a.logf("ignoring unexpected frame type %q", t)
		}
	}
}

func (a *Agent) heartbeat(ctx context.Context, c *websocket.Conn) {
	ticker := time.NewTicker(HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := writeFrame(ctx, c, wire.Heartbeat{Type: wire.TypeHeartbeat, Ts: time.Now().Unix()}); err != nil {
				a.logf("heartbeat write failed: %v", err)
				return
			}
		}
	}
}

// handleCommand verifies then dispatches, and ALWAYS emits both a result frame
// and an audit entry — a refusal is ok:false in both, never silent.
func (a *Agent) handleCommand(ctx context.Context, c *websocket.Conn, frame map[string]any) {
	envelope, _ := frame["envelope"].(map[string]any)
	sig, _ := frame["sig"].(string)
	envelopeID := ""
	attemptedCap := ""
	if envelope != nil {
		envelopeID, _ = envelope["envelope_id"].(string)
		attemptedCap, _ = envelope["capability"].(string)
	}

	capability, args, verr := a.verifier.VerifyCommand(envelope, sig)
	if verr != nil {
		a.emit(ctx, c, wire.Result{
			Type:       wire.TypeResult,
			EnvelopeID: envelopeID,
			OK:         false,
			Output:     "",
			ExitCode:   nil,
			Error:      verr.Error(),
		}, envelopeID, attemptedCap, "refused: "+verr.Error(), false, nil)
		return
	}

	cmdCtx, cancel := context.WithTimeout(ctx, CommandTimeout)
	defer cancel()
	outcome := caps.Dispatch(cmdCtx, capability, args, a.deps)

	errStr := ""
	if !outcome.OK {
		errStr = outcome.Error
	}
	a.emit(ctx, c, wire.Result{
		Type:       wire.TypeResult,
		EnvelopeID: envelopeID,
		OK:         outcome.OK,
		Output:     outcome.Output,
		ExitCode:   outcome.ExitCode,
		Error:      errStr,
	}, envelopeID, capability, summarize(capability, outcome), outcome.OK, outcome.ExitCode)
}

// emit sends the result, then appends the audit entry and sends it in a batch.
// The audit append is the record of record; if the socket write of either
// frame fails, the local chain still holds and replays on reconnect.
func (a *Agent) emit(ctx context.Context, c *websocket.Conn, result wire.Result, envelopeID, capability, summary string, ok bool, exitCode *int) {
	if err := writeFrame(ctx, c, result); err != nil {
		a.logf("result write failed for %s: %v", envelopeID, err)
	}
	entry, err := a.audit.Append(time.Now().Unix(), envelopeID, capability, summary, ok, exitCode)
	if err != nil {
		a.logf("audit append failed for %s: %v", envelopeID, err)
		return
	}
	if err := writeFrame(ctx, c, auditFrame{Type: wire.TypeAudit, Entries: []map[string]any{entry}}); err != nil {
		a.logf("audit write failed for %s: %v", envelopeID, err)
	}
}

type auditFrame struct {
	Type    string           `json:"type"`
	Entries []map[string]any `json:"entries"`
}

func readFrame(ctx context.Context, c *websocket.Conn) (map[string]any, error) {
	typ, data, err := c.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText {
		return nil, fmt.Errorf("expected a text frame, got %v", typ)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber() // keep envelope numbers exact for canonical re-encoding
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("decoding frame: %w", err)
	}
	return m, nil
}

func writeFrame(ctx context.Context, c *websocket.Conn, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.Write(ctx, websocket.MessageText, data)
}

func summarize(capability string, o caps.Outcome) string {
	var s string
	switch {
	case !o.OK:
		s = "refused: " + o.Error
	case capability == "shell.exec" && o.ExitCode != nil:
		s = fmt.Sprintf("ran, exit %d", *o.ExitCode)
	default:
		s = capability + " ok"
	}
	return truncate(s, 300)
}

// truncate caps a summary at n BYTES but never mid-rune: a split multibyte
// rune would be invalid UTF-8, and core re-canonicalizes the summary into the
// chain hash — a mangled rune there would recompute a different hash and log a
// spurious device.audit_break. So back off to a rune boundary.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func short(hexKey string) string {
	if len(hexKey) < 8 {
		return hexKey
	}
	return hexKey[:8]
}
