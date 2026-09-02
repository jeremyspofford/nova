package wire

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

func unixNow() int64 { return time.Now().Unix() }

// EnvelopeVersion is the only wire version this daemon understands. An unknown
// version is refused, not guessed at — a bump is a deliberate two-sided change.
const EnvelopeVersion = 1

// SkewSeconds is the clock tolerance around an envelope's [issued_at,
// expires_at] window (the plan's ±120s). Checked ONCE at receipt; a command
// that takes long to EXECUTE is not re-checked, because core's 60s TTL governs
// acceptance, not execution (T2 concern #2).
const SkewSeconds = 120

// Frame types on the socket. Every frame is a single JSON object with a "type".
const (
	TypeChallenge = "challenge"
	TypeAuth      = "auth"
	TypeReady     = "ready"
	TypeHeartbeat = "heartbeat"
	TypeCommand   = "command"
	TypeResult    = "result"
	TypeAudit     = "audit"
	TypeAuthError = "auth_error"
)

// Challenge is core -> device: a nonce to sign and core's pinned public key.
type Challenge struct {
	Type       string `json:"type"`
	Nonce      string `json:"nonce"`
	CorePubkey string `json:"core_pubkey"`
}

// Auth is device -> core: the device id and its signature over the RAW nonce
// bytes (bytes.fromhex(nonce)) — not an envelope, not the hex string.
//
// HomeDir is OPTIONAL and additive (omitempty): the daemon's os.UserHomeDir(),
// which core stores on the device row only AFTER the signature verifies, so
// Settings -> Devices can suggest it as the first filesystem root (an fs.*
// grant with no root is refused there as dead on arrival). It grants nothing
// by itself, and a core that predates the field ignores the unknown key. The
// contract is mirrored in services/core/app/devices_ws.py ("The frame
// contract").
type Auth struct {
	Type     string `json:"type"`
	DeviceID string `json:"device_id"`
	Sig      string `json:"sig"`
	HomeDir  string `json:"home_dir,omitempty"`
}

// Ready is core -> device: the last audit seq core has stored (null when none).
type Ready struct {
	Type    string `json:"type"`
	LastSeq *int64 `json:"last_seq"`
}

// Heartbeat is device -> core, ~every 20s. ts is core-informational only.
type Heartbeat struct {
	Type string `json:"type"`
	Ts   int64  `json:"ts"`
}

// Result is device -> core: the outcome of one command, keyed by envelope_id.
// ok is the daemon's own judgment and is authoritative to core.
type Result struct {
	Type       string `json:"type"`
	EnvelopeID string `json:"envelope_id"`
	OK         bool   `json:"ok"`
	Output     string `json:"output"`
	ExitCode   *int   `json:"exit_code"`
	Error      string `json:"error"`
}

// AuthError is core -> device before a 4401 close.
type AuthError struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

// ChainHash is the audit-chain hash, defined once to match core's
// devices_ws.chain_hash: sha256( prev_hash + canonical(entry_without_hash) ).
// prev_hash is "" for seq 0. The entry passed here is the eight-key map WITHOUT
// its own hash field.
func ChainHash(prevHash string, entryWithoutHash map[string]any) (string, error) {
	canon, err := Canonical(entryWithoutHash)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	h.Write([]byte(prevHash))
	h.Write(canon)
	return hex.EncodeToString(h.Sum(nil)), nil
}

// RefusalError is a mechanical verification failure. Every one becomes a
// result frame (ok:false) AND an audit entry — never a silent drop. The
// message is the summary core and the local audit record.
type RefusalError struct{ Reason string }

func (e *RefusalError) Error() string { return e.Reason }

func refuse(format string, a ...any) *RefusalError {
	return &RefusalError{Reason: fmt.Sprintf(format, a...)}
}

// Verifier holds the pinned core public key, this device's id, and the one-use
// seen-set. All command verification is mechanical here — no field is trusted
// because the socket delivered it.
type Verifier struct {
	corePubKey ed25519.PublicKey
	deviceID   string
	now        func() int64

	mu   sync.Mutex
	seen map[string]int64 // envelope_id -> expires_at (for pruning)
}

// NewVerifier pins core's key (32 raw bytes as hex) and this device's id.
// now defaults to time.Now().Unix when nil; tests inject a fixed clock.
func NewVerifier(corePubKeyHex, deviceID string, now func() int64) (*Verifier, error) {
	raw, err := hex.DecodeString(corePubKeyHex)
	if err != nil {
		return nil, fmt.Errorf("core pubkey is not hex: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("core pubkey is %d bytes, want %d", len(raw), ed25519.PublicKeySize)
	}
	return &Verifier{
		corePubKey: ed25519.PublicKey(raw),
		deviceID:   deviceID,
		now:        now,
		seen:       make(map[string]int64),
	}, nil
}

// VerifyCommand refuses on ANY failure and, only on full success, records the
// envelope_id so a replay inside the validity window is refused. The order is:
// signature over the canonical re-encoding, version, device match, expiry
// window (checked once), one-use. It returns the capability and args on accept.
func (v *Verifier) VerifyCommand(envelope map[string]any, sigHex string) (capability string, args map[string]any, err error) {
	// 1. Signature over the canonical RE-ENCODING of the envelope object — not
	//    the raw wire bytes, which we never trust to be canonical.
	canon, cerr := Canonical(envelope)
	if cerr != nil {
		return "", nil, refuse("envelope is not encodable: %v", cerr)
	}
	sig, herr := hex.DecodeString(sigHex)
	if herr != nil {
		return "", nil, refuse("signature is not hex")
	}
	if !ed25519.Verify(v.corePubKey, canon, sig) {
		return "", nil, refuse("signature did not verify against the pinned core key")
	}

	// 2. Version.
	ver, ok := asInt64(envelope["v"])
	if !ok {
		return "", nil, refuse("envelope version is missing or not an integer")
	}
	if ver != EnvelopeVersion {
		return "", nil, refuse("unknown envelope version %d", ver)
	}

	// 3. device_id == this device.
	did, _ := envelope["device_id"].(string)
	if did == "" {
		return "", nil, refuse("envelope carries no device_id")
	}
	if did != v.deviceID {
		return "", nil, refuse("envelope is addressed to a different device")
	}

	// 4. Expiry window, ±SKEW, checked ONCE at receipt.
	issuedAt, ok1 := asInt64(envelope["issued_at"])
	expiresAt, ok2 := asInt64(envelope["expires_at"])
	if !ok1 || !ok2 {
		return "", nil, refuse("envelope timestamps are missing or not integers")
	}
	now := v.clock()
	if now < issuedAt-SkewSeconds {
		return "", nil, refuse("envelope is not yet valid (issued in the future beyond skew)")
	}
	if now > expiresAt+SkewSeconds {
		return "", nil, refuse("envelope has expired")
	}

	// 5. envelope_id one-use.
	eid, _ := envelope["envelope_id"].(string)
	if eid == "" {
		return "", nil, refuse("envelope carries no envelope_id")
	}
	capName, _ := envelope["capability"].(string)
	if capName == "" {
		return "", nil, refuse("envelope names no capability")
	}
	a, _ := envelope["args"].(map[string]any)
	if a == nil {
		a = map[string]any{}
	}

	v.mu.Lock()
	defer v.mu.Unlock()
	v.pruneLocked(now)
	if _, seen := v.seen[eid]; seen {
		return "", nil, refuse("envelope has already been used (replay)")
	}
	v.seen[eid] = expiresAt
	return capName, a, nil
}

func (v *Verifier) clock() int64 {
	if v.now != nil {
		return v.now()
	}
	return unixNow()
}

// pruneLocked drops seen ids whose validity window (plus skew) has fully
// passed; a replay after that fails the expiry check anyway, so the set only
// needs to span the validity window.
func (v *Verifier) pruneLocked(now int64) {
	for id, exp := range v.seen {
		if now > exp+SkewSeconds {
			delete(v.seen, id)
		}
	}
}

// asInt64 accepts json.Number (the wire), int and int64 (built entries).
func asInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			return 0, false
		}
		return i, true
	case int64:
		return n, true
	case int:
		return int64(n), true
	default:
		return 0, false
	}
}
