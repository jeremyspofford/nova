// Package client is the daemon's half of the socket: it dials core, proves
// itself with the challenge, replays its audit chain, then serves signed
// commands in steady state. Every command is verified ON the device before it
// runs, and every outcome — success OR refusal — is both a result frame and an
// audit entry. The run loop reconnects on any socket error; a changed core key
// and a revoked device are the fatal conditions — but they authenticate
// differently. The handshake's own core_pubkey compare is an unsigned claim
// from whoever answers the socket, not a proof of anything, so it — and
// everything else in the handshake — rests on the TRANSPORT (TLS, WireGuard,
// loopback) for its integrity, never on itself. The one exception is a
// revoke: the device wipes its identity only when core's SIGNATURE over the
// revoke proof verifies against the key pinned at enrollment
// (wire.VerifyRevokedProof), a check independent of the transport.
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
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"novad/internal/audit"
	"novad/internal/caps"
	"novad/internal/config"
	"novad/internal/facts"
	"novad/internal/platform"
	"novad/internal/wire"
)

// CommandTimeout bounds a single capability's execution. It sits under core's
// ≤120s command wait so the device answers before core gives up, and expiry is
// NOT re-checked during execution (verification is at receipt only).
const CommandTimeout = 110 * time.Second

// HeartbeatInterval is how often the daemon reports liveness; core derives the
// tile state from when it last heard, never from the reported ts.
const HeartbeatInterval = 20 * time.Second

// PingTimeout bounds each heartbeat's ping: a write can succeed into a dead
// TCP connection for minutes, a pong cannot.
const PingTimeout = 10 * time.Second

// FactsEvery and FactsMinGap are the facts frame's cadence
// (r2-integration): unchanged facts every ten minutes; changed facts at most
// once a minute.
const (
	FactsEvery  = 10 * time.Minute
	FactsMinGap = time.Minute
)

// defaultBackoffs is the reconnect ladder. It resets after every session
// that authenticated (Run).
var defaultBackoffs = []time.Duration{1 * time.Second, 2 * time.Second, 5 * time.Second, 15 * time.Second, 30 * time.Second}

// WatchdogEvery is how often the wall-clock watchdog samples the clock: far
// tighter than any realistic heartbeatEvery, so a laptop that sleeps is
// caught on the first sample after resume rather than after whatever was
// left of a much longer heartbeat interval when it slept (Review Focus 4).
// P12's own heartbeat-gap rule stays exactly as it is — the watchdog is a
// second, faster, I/O-free path beside it, not a replacement for it.
const WatchdogEvery = 1 * time.Second

// sleepGap is the watchdog's own threshold: a wall-clock gap between its
// samples wider than this means the machine slept, not just a scheduler
// stall. It is a fixed margin over WatchdogEvery, not a multiple of it —
// changing the sample rate must not change what counts as a sleep.
const sleepGap = 5 * time.Second

// wsReadLimit raises coder/websocket's 32 KiB default so a signed fs.write
// command (content up to the 256 KiB write domain) is not rejected on read.
const wsReadLimit = 4 << 20

// fatal wraps a non-retryable condition: the run loop exits rather than
// reconnecting. Today that is a changed core key or a revoked device.
type fatal struct{ err error }

func (f fatal) Error() string { return f.err.Error() }
func (f fatal) Unwrap() error { return f.err }

// ErrRevoked is Run's return when core says this device was revoked — the one
// refusal that is final. The caller wipes the identity (config.Wipe) and
// exits 78 so no supervisor restarts a daemon that can never get in.
var ErrRevoked = errors.New("core says this device was revoked")

// Agent holds the pinned identity and the local capability + audit surfaces.
type Agent struct {
	cfg   config.Config
	priv  ed25519.PrivateKey
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

	// gatherAuth and gatherFrame read the facts; fields so a test hands in
	// its own. now is the clock (Task 8's resume detector reads it too).
	gatherAuth  func(context.Context) (facts.Auth, []facts.Unreadable)
	gatherFrame func([]facts.Unreadable) facts.Frame
	now         func() time.Time

	// authGatherBudget bounds gatherAuth independently of hsCtx's 30s: a
	// platform call with no timeout of its own (macOS ioreg) must not burn
	// the whole handshake — auth facts are never a reason to refuse the
	// socket. Tests shorten it to prove a hung gather cannot block ready.
	authGatherBudget time.Duration

	// Liveness knobs: the constants above, as fields so a test runs them fast.
	heartbeatEvery time.Duration
	pingTimeout    time.Duration
	factsEvery     time.Duration
	factsMinGap    time.Duration
	backoffs       []time.Duration
	watchdogEvery  time.Duration

	// factsSendMu serializes the whole build (frameBytes) -> write -> record
	// sequence across every path that can send a facts frame on a
	// connection: the post-ready send, a facts.refresh command, and
	// heartbeat's own periodic/on-change sender (maybeSendFacts) running
	// beside them. Without it, two of those sequences racing here could land
	// on the wire out of order, or an older build's record could clobber a
	// newer one's lastFacts/lastFactsAt after the fact — and maybeSendFacts's
	// byte-equality check could then withhold a real change until factsEvery.
	factsSendMu sync.Mutex

	// factsMu guards what the facts frames remember: what GatherAuth could
	// not read (repeated in every frame), and the last frame written and
	// when — the heartbeat's change check compares against them.
	factsMu     sync.Mutex
	authUnread  []facts.Unreadable
	lastFacts   []byte
	lastFactsAt time.Time
}

// New assembles an agent from loaded custody. logf may be nil.
func New(cfg config.Config, priv ed25519.PrivateKey, log *audit.Log, home, version string, logf func(string, ...any)) (*Agent, error) {
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
		audit:    log,
		deps:     caps.Deps{Home: home},
		wsURL:    wsURL,
		logf:     logf,
		verifier: verifier,
		gatherAuth: func(ctx context.Context) (facts.Auth, []facts.Unreadable) {
			return facts.GatherAuth(ctx, platform.Exec{}, version)
		},
		gatherFrame:      facts.GatherFrame,
		now:              time.Now,
		authGatherBudget: 5 * time.Second,
		heartbeatEvery:   HeartbeatInterval,
		pingTimeout:      PingTimeout,
		factsEvery:       FactsEvery,
		factsMinGap:      FactsMinGap,
		backoffs:         defaultBackoffs,
		watchdogEvery:    WatchdogEvery,
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
// or a fatal condition is hit (a changed core key; a revoked device).
func (a *Agent) Run(ctx context.Context) error {
	attempt := 0
	for {
		authed, err := a.connectOnce(ctx)
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
		if authed {
			// A session that authenticated proves the path works, so the next
			// wait starts from the shortest step again. Before S42a the ladder
			// never reset, and after five drops every reconnect waited 30 s for
			// the life of the process.
			attempt = 0
		}
		d := a.backoffs[min(attempt, len(a.backoffs)-1)]
		attempt++
		a.logf("reconnecting in %s", d)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
		}
	}
}

// connectOnce dials, authenticates and serves one session. It reports whether
// the session authenticated (Run's backoff reset reads it), and why it ended.
func (a *Agent) connectOnce(ctx context.Context) (bool, error) {
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	c, _, err := websocket.Dial(dialCtx, a.wsURL, nil)
	cancel()
	if err != nil {
		return false, fmt.Errorf("dial %s: %w", a.wsURL, err)
	}
	defer c.CloseNow()
	c.SetReadLimit(wsReadLimit)

	if err := a.handshake(ctx, c); err != nil {
		return false, err
	}
	a.logf("authenticated; serving")
	return true, a.serve(ctx, c)
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
	// gatherAuth gets its OWN short budget, not the whole 30s hsCtx: a
	// platform call with no timeout of its own (macOS ioreg) must not burn
	// the handshake. A cut-off gather yields empty values plus unreadable
	// entries (GatherAuth already reports what it could not read); the auth
	// frame still goes out on hsCtx regardless.
	gctx, gcancel := context.WithTimeout(hsCtx, a.authGatherBudget)
	auth, unread := a.gatherAuth(gctx)
	gcancel()
	a.factsMu.Lock()
	a.authUnread = unread
	a.factsMu.Unlock()
	if err := writeFrame(hsCtx, c, wire.Auth{
		Type:     wire.TypeAuth,
		DeviceID: a.cfg.DeviceID,
		Sig:      hex.EncodeToString(sig),
		Facts:    auth,
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
		if reason == wire.ReasonRevoked {
			// The reason string is unsigned — anyone who can terminate this
			// socket can send it. Only a proof core's PINNED key actually
			// signed, over THIS handshake's own nonce and this device's own
			// id, is final. a.verifier.CorePubKey() is the key pinned at
			// enrollment, never the key merely claimed in the challenge frame
			// above (that claim is exactly what would let a forged socket
			// prove itself to itself).
			if wire.VerifyRevokedProof(reply, a.cfg.DeviceID, nonceHex, a.verifier.CorePubKey()) {
				return fatal{ErrRevoked}
			}
			a.logf("core said revoked but the refusal carries no proof for this device and handshake that the pinned core key verifies — not wiping")
		}
		// Any other refusal is retried: a transient core-side fault heals on
		// the next attempt, and a restored database that forgot this device is
		// re-enrolled by hand (s45 move runbook) — never wiped from here.
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

	// The facts frame follows ready at once (r2-integration): core records
	// the slower facts before the first command could need them. writeFacts
	// itself bounds the write with pingTimeout (fix round 1), so a write
	// blocking on a dead path cannot prevent the heartbeat below — and its
	// own ping, which would otherwise catch that same dead path — from ever
	// starting on this connection; no extra context needed here.
	if err := a.sendFacts(serveCtx, c); err != nil {
		a.logf("facts frame not sent: %v", err)
	}

	go a.heartbeat(serveCtx, cancel, c)
	go a.watchdog(serveCtx, cancel)

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

// heartbeat keeps the session honest in both directions, once per tick:
//
//   - a wall-clock gap between ticks wider than two intervals means this
//     machine slept: Round(0) drops the monotonic reading so the comparison
//     is wall-clock only, and that holds regardless of how a given OS's
//     ticker or monotonic clock itself behaves across suspend. watchdog
//     (below) runs the same wall-clock check on a much tighter tick, and
//     normally reconnects first — this is the slower, I/O-coupled backstop
//     beside it, kept exactly as P12 specifies;
//   - the heartbeat frame (core stamps last_seen from it), bounded by
//     pingTimeout: on a dead path the kernel keeps taking bytes until its
//     send buffer is full, and from then on a write BLOCKS; coder/
//     websocket closes the whole connection when a write's own context
//     expires, which is what actually frees a write stuck on a dead path —
//     including one from a DIFFERENT call, like a stuck facts.refresh, once
//     this cancel() below cancels serveCtx. A write that took longer than
//     pingTimeout ends the session even on a live but slow link;
//   - a ping core must answer within pingTimeout — what catches a write
//     that SUCCEEDED into a dead path (its bytes only reached the send
//     buffer), which no write error ever reports;
//   - the facts frame, when the facts changed or it is due.
//
// Any failure ends the session through cancel: serve returns, and Run
// reconnects from the first step of the ladder.
func (a *Agent) heartbeat(ctx context.Context, cancel context.CancelFunc, c *websocket.Conn) {
	ticker := time.NewTicker(a.heartbeatEvery)
	defer ticker.Stop()
	last := a.now().Round(0)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		now := a.now().Round(0) // Round(0) drops the monotonic reading: wall clock only
		if gap := now.Sub(last); gap > 2*a.heartbeatEvery {
			a.logf("the clock jumped %s between heartbeats — this machine slept; reconnecting", gap.Round(time.Second))
			cancel()
			return
		}
		last = now
		hbCtx, hbCancel := context.WithTimeout(ctx, a.pingTimeout)
		err := writeFrame(hbCtx, c, wire.Heartbeat{Type: wire.TypeHeartbeat, Ts: now.Unix()})
		hbCancel()
		if err != nil {
			if ctx.Err() == nil {
				a.logf("heartbeat write failed: %v — reconnecting", err)
				cancel()
			}
			return
		}
		pingCtx, pingCancel := context.WithTimeout(ctx, a.pingTimeout)
		err = c.Ping(pingCtx)
		pingCancel()
		if err != nil {
			if ctx.Err() == nil {
				a.logf("core did not answer a ping within %s: %v — reconnecting", a.pingTimeout, err)
				cancel()
			}
			return
		}
		a.maybeSendFacts(ctx, c)
	}
}

// watchdog is heartbeat's fast path for the SAME wall-clock check (P12),
// running beside it on a much tighter tick and doing no I/O of its own: a
// laptop that sleeps is caught on the first watchdog sample after resume
// (about watchdogEvery, default 1s) rather than after however much of a
// realistic, much longer heartbeatEvery was left when it slept. It ends the
// session the same way heartbeat's own gap check does, through cancel.
func (a *Agent) watchdog(ctx context.Context, cancel context.CancelFunc) {
	ticker := time.NewTicker(a.watchdogEvery)
	defer ticker.Stop()
	last := a.now().Round(0)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		now := a.now().Round(0) // wall clock only, same as heartbeat's own check
		if gap := now.Sub(last); gap > sleepGap {
			a.logf("the clock jumped %s between watchdog samples — this machine slept; reconnecting", gap.Round(time.Second))
			cancel()
			return
		}
		last = now
	}
}

// maybeSendFacts writes a facts frame when the facts changed and the last
// frame is at least factsMinGap old, or when factsEvery has passed anyway.
// factsSendMu holds this decision through the write and record (see its
// field comment) so it cannot interleave with a concurrent sendFacts call —
// a facts.refresh command on the same connection.
func (a *Agent) maybeSendFacts(ctx context.Context, c *websocket.Conn) {
	a.factsSendMu.Lock()
	defer a.factsSendMu.Unlock()
	a.factsMu.Lock()
	last, lastAt := a.lastFacts, a.lastFactsAt
	a.factsMu.Unlock()
	since := a.now().Sub(lastAt)
	if since < a.factsMinGap {
		return
	}
	data, err := a.frameBytes()
	if err != nil {
		a.logf("facts frame not built: %v", err)
		return
	}
	if since < a.factsEvery && bytes.Equal(data, last) {
		return
	}
	if err := a.writeFacts(ctx, c, data); err != nil && ctx.Err() == nil {
		a.logf("facts frame not sent: %v", err)
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
	// facts.refresh writes its frame on THIS connection, before its result.
	deps := a.deps
	deps.SendFacts = func(ctx context.Context) error { return a.sendFacts(ctx, c) }
	outcome := caps.Dispatch(cmdCtx, capability, args, deps)

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

// sendFacts gathers a facts frame and writes it on c. factsSendMu holds the
// build through the write and record (see its field comment) so this cannot
// interleave with a concurrent maybeSendFacts call on the same connection.
func (a *Agent) sendFacts(ctx context.Context, c *websocket.Conn) error {
	a.factsSendMu.Lock()
	defer a.factsSendMu.Unlock()
	data, err := a.frameBytes()
	if err != nil {
		return err
	}
	return a.writeFacts(ctx, c, data)
}

// frameBytes gathers and encodes a facts frame. One over core's cap is an
// error here — never sent to be refused over there.
func (a *Agent) frameBytes() ([]byte, error) {
	a.factsMu.Lock()
	carried := append([]facts.Unreadable(nil), a.authUnread...)
	a.factsMu.Unlock()
	data, err := json.Marshal(a.gatherFrame(carried))
	if err != nil {
		return nil, err
	}
	if len(data) > facts.MaxFrameBytes {
		return nil, fmt.Errorf("the facts frame is %d bytes, over the %d-byte cap", len(data), facts.MaxFrameBytes)
	}
	return data, nil
}

// writeFacts writes an encoded frame and remembers what went out and when.
// The write is bounded by pingTimeout (fix round 1): on a dead path, once
// the kernel's send buffer is full a facts write BLOCKS, and coder/websocket
// closes the whole connection when a write's own context expires — the only
// thing that frees a write truly stuck on a dead path. (A write that returns
// proves nothing about the path: its bytes may only be buffered; the
// heartbeat's ping is what catches that.) Without this, a stuck sendFacts
// (facts.refresh, up to the 110s command timeout) or a stuck maybeSendFacts
// held the connection's write lock for far longer, blocking the
// heartbeat's own write behind it.
func (a *Agent) writeFacts(ctx context.Context, c *websocket.Conn, data []byte) error {
	wctx, cancel := context.WithTimeout(ctx, a.pingTimeout)
	defer cancel()
	if err := c.Write(wctx, websocket.MessageText, data); err != nil {
		return err
	}
	a.factsMu.Lock()
	a.lastFacts, a.lastFactsAt = data, a.now()
	a.factsMu.Unlock()
	return nil
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
