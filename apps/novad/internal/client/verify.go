package client

import (
	"context"
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/coder/websocket"

	"novad/internal/config"
	"novad/internal/wire"
)

// VerifyTimeout bounds the dial AND the whole handshake. It matches the run
// loop's own dial bound (connectOnce), so a server that is merely slow behaves
// the same whether the daemon or `novad repoint` is asking.
const VerifyTimeout = 30 * time.Second

// KeyMismatch is what VerifyServer returns when the socket presented a core
// public key that is not the one this device pinned at enrolment.
//
// This is the whole control behind `novad repoint`: whoever owns a DNS name
// can serve a Nova-shaped websocket, but cannot produce core's ed25519 public
// key. The URL is not the identity; the pinned key is. A caller that wants to
// say something specific about the mismatch matches it with errors.As.
type KeyMismatch struct {
	Presented string // what the socket sent, 64 hex or whatever it sent
	Pinned    string // what enrolment recorded
}

func (e *KeyMismatch) Error() string {
	return fmt.Sprintf("that server is not the Nova you paired with (it presented %s…, we pinned %s…)",
		short(e.Presented), short(e.Pinned))
}

// VerifyServer dials cfg.Server's device socket and completes the FULL
// handshake against it — challenge, pinned-key comparison, a signature over
// the raw nonce, ready — then closes.
//
// It writes nothing: no config, no audit entry, no command is served, and the
// returned error is the reason the proof failed. Completing the handshake
// rather than stopping at the key comparison is deliberate: a server that
// holds core's key but has FORGOTTEN this device passes the key check and
// fails here, so a caller that repoints on success never writes on a
// half-proof.
func VerifyServer(ctx context.Context, cfg config.Config, priv ed25519.PrivateKey) error {
	wsURL, err := WSURL(cfg.Server)
	if err != nil {
		return err
	}

	dialCtx, cancel := context.WithTimeout(ctx, VerifyTimeout)
	defer cancel()

	c, _, err := websocket.Dial(dialCtx, wsURL, nil)
	if err != nil {
		return fmt.Errorf("could not open the device socket at %s: %w", wsURL, err)
	}
	defer c.CloseNow()
	c.SetReadLimit(wsReadLimit)

	frame, err := readFrame(dialCtx, c)
	if err != nil {
		return fmt.Errorf("no first frame from %s: %w", wsURL, err)
	}
	if t, _ := frame["type"].(string); t != wire.TypeChallenge {
		return fmt.Errorf("%s did not open with a challenge frame (got type %q) — that is not a Nova device socket", wsURL, t)
	}
	nonceHex, _ := frame["nonce"].(string)
	coreKey, _ := frame["core_pubkey"].(string)

	// 64 hex characters, checked BEFORE the comparison, so "it presented
	// nothing" is a distinct sentence from "it presented another Nova".
	if raw, decErr := hex.DecodeString(coreKey); decErr != nil || len(raw) != ed25519.PublicKeySize {
		return fmt.Errorf("%s presented a core_pubkey that is not 64 hex characters (%q) — that is not a Nova device socket",
			wsURL, coreKey)
	}
	// Constant time, though the pinned key is public: it costs nothing, and the
	// day this compares something that is not public the habit is already here.
	if subtle.ConstantTimeCompare([]byte(coreKey), []byte(cfg.CorePubKey)) != 1 {
		return &KeyMismatch{Presented: coreKey, Pinned: cfg.CorePubKey}
	}

	nonce, err := hex.DecodeString(nonceHex)
	if err != nil || len(nonce) == 0 {
		return fmt.Errorf("the challenge nonce from %s is not hex", wsURL)
	}
	sig := ed25519.Sign(priv, nonce) // RAW nonce bytes, exactly as handshake does
	if err := writeFrame(dialCtx, c, wire.Auth{
		Type:     wire.TypeAuth,
		DeviceID: cfg.DeviceID,
		Sig:      hex.EncodeToString(sig),
	}); err != nil {
		return fmt.Errorf("sending auth to %s: %w", wsURL, err)
	}

	reply, err := readFrame(dialCtx, c)
	if err != nil {
		return fmt.Errorf("reading the auth reply from %s: %w", wsURL, err)
	}
	switch t, _ := reply["type"].(string); t {
	case wire.TypeReady:
		// A clean close, so core does not log this probe as a dropped socket.
		_ = c.Close(websocket.StatusNormalClosure, "verify")
		return nil
	case wire.TypeAuthError:
		reason, _ := reply["reason"].(string)
		if reason == "" {
			reason = "no reason given"
		}
		return fmt.Errorf("%s holds the core key you pinned, but it refused this device: %s", wsURL, reason)
	default:
		return fmt.Errorf("expected ready or auth_error from %s, got %q", wsURL, t)
	}
}
