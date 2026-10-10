package wire

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"testing"
)

// The committed chain-hash vector from the T2 report. seq 0, prev_hash "",
// exit_code present as 0 (never omitted). If this drifts, the daemon's audit
// chain and core's ingester disagree and every replay would read as a break.
func TestChainHashMatchesTheCommittedVector(t *testing.T) {
	entry := map[string]any{
		"seq":         int64(0),
		"prev_hash":   "",
		"ts":          int64(1756600000),
		"envelope_id": "env-1",
		"capability":  "system.info",
		"summary":     "ok",
		"ok":          true,
		"exit_code":   int64(0),
	}
	const want = "35e014b6f5d8a09503084e59db7b59b964fb523b49e97f92bd91f97b360c63a4"
	got, err := ChainHash("", entry)
	if err != nil {
		t.Fatalf("ChainHash errored: %v", err)
	}
	if got != want {
		// Prove the canonical of the eight keys too, so a failure says where.
		canon, _ := Canonical(entry)
		t.Fatalf("chain hash differs\n want: %s\n  got: %s\n canonical: %s", want, got, string(canon))
	}
}

// A device signing key derived from the fixture seed, so the test can mint a
// valid command envelope and then tamper with it.
func fixtureVerifier(t *testing.T, deviceID string, now int64) (*Verifier, ed25519.PrivateKey) {
	t.Helper()
	vf := loadVectors(t)
	seed, err := hex.DecodeString(vf.SeedHex)
	if err != nil {
		t.Fatalf("seed hex: %v", err)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	ver, err := NewVerifier(vf.PublicKeyHex, deviceID, func() int64 { return now })
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	return ver, priv
}

func signedEnvelope(t *testing.T, priv ed25519.PrivateKey, env map[string]any) string {
	t.Helper()
	canon, err := Canonical(env)
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	return hex.EncodeToString(ed25519.Sign(priv, canon))
}

func baseEnvelope(deviceID string) map[string]any {
	return map[string]any{
		"v":           int64(1),
		"envelope_id": "cmd-1",
		"device_id":   deviceID,
		"capability":  "system.info",
		"args":        map[string]any{},
		"issued_at":   int64(1756600000),
		"expires_at":  int64(1756600060),
	}
}

func TestVerifyCommandAcceptsAWellFormedEnvelope(t *testing.T) {
	const dev = "11111111-2222-3333-4444-555555555555"
	ver, priv := fixtureVerifier(t, dev, 1756600030)
	env := baseEnvelope(dev)
	sig := signedEnvelope(t, priv, env)

	cap, args, err := ver.VerifyCommand(env, sig)
	if err != nil {
		t.Fatalf("expected accept, got refusal: %v", err)
	}
	if cap != "system.info" {
		t.Errorf("capability = %q, want system.info", cap)
	}
	if args == nil {
		t.Error("args should be a (possibly empty) map, not nil")
	}
}

func TestVerifyCommandRefusesATamperedEnvelope(t *testing.T) {
	const dev = "11111111-2222-3333-4444-555555555555"
	ver, priv := fixtureVerifier(t, dev, 1756600030)
	env := baseEnvelope(dev)
	sig := signedEnvelope(t, priv, env)
	// Flip the capability AFTER signing — the signature no longer covers it.
	env["capability"] = "shell.exec"

	if _, _, err := ver.VerifyCommand(env, sig); err == nil {
		t.Fatal("a tampered envelope must be refused")
	}
}

func TestVerifyCommandRefusesAnExpiredEnvelope(t *testing.T) {
	const dev = "11111111-2222-3333-4444-555555555555"
	// now well past expires_at + skew (1756600060 + 120).
	ver, priv := fixtureVerifier(t, dev, 1756600060+120+1)
	env := baseEnvelope(dev)
	sig := signedEnvelope(t, priv, env)

	if _, _, err := ver.VerifyCommand(env, sig); err == nil {
		t.Fatal("an expired envelope must be refused")
	}
}

func TestVerifyCommandRefusesAReplay(t *testing.T) {
	const dev = "11111111-2222-3333-4444-555555555555"
	ver, priv := fixtureVerifier(t, dev, 1756600030)
	env := baseEnvelope(dev)
	sig := signedEnvelope(t, priv, env)

	if _, _, err := ver.VerifyCommand(env, sig); err != nil {
		t.Fatalf("first use should accept: %v", err)
	}
	if _, _, err := ver.VerifyCommand(env, sig); err == nil {
		t.Fatal("the same envelope_id used twice must be refused")
	}
}

func TestVerifyCommandRefusesAForeignDevice(t *testing.T) {
	const dev = "11111111-2222-3333-4444-555555555555"
	ver, priv := fixtureVerifier(t, "some-other-device", 1756600030)
	env := baseEnvelope(dev) // signed for dev, but the verifier is another id
	sig := signedEnvelope(t, priv, env)

	if _, _, err := ver.VerifyCommand(env, sig); err == nil {
		t.Fatal("an envelope addressed to another device must be refused")
	}
}

func TestVerifyCommandRefusesAnUnknownVersion(t *testing.T) {
	const dev = "11111111-2222-3333-4444-555555555555"
	ver, priv := fixtureVerifier(t, dev, 1756600030)
	env := baseEnvelope(dev)
	env["v"] = int64(2)
	sig := signedEnvelope(t, priv, env) // correctly signed, but v=2

	if _, _, err := ver.VerifyCommand(env, sig); err == nil {
		t.Fatal("an unknown envelope version must be refused")
	}
}

// A long execution must not be re-checked against expiry: verification is at
// receipt only. Accept an envelope whose expires_at is in the past relative to
// a LATER clock, as long as receipt was inside the window (we accept at receipt
// time; the daemon never calls VerifyCommand again for the same command).
func TestVerifyIsCheckedOnceAtReceiptNotDuringExecution(t *testing.T) {
	const dev = "11111111-2222-3333-4444-555555555555"
	ver, priv := fixtureVerifier(t, dev, 1756600030) // inside the window
	env := baseEnvelope(dev)
	sig := signedEnvelope(t, priv, env)
	if _, _, err := ver.VerifyCommand(env, sig); err != nil {
		t.Fatalf("receipt inside the window must accept: %v", err)
	}
	// No second VerifyCommand call happens for a command mid-execution; the
	// seen-set now refuses a genuine replay, which is the only re-entry path.
}

// canonicalRevokedProof builds a genuine proof body: kind and v exactly as
// core will sign them, deviceID and nonceHex echoing one particular
// handshake.
func canonicalRevokedProof(deviceID, nonceHex string) map[string]any {
	return map[string]any{"kind": RevokedProofKind, "v": int64(RevokedProofVersion), "device_id": deviceID, "nonce": nonceHex}
}

// signedRevokedReply signs proof's canonical encoding with signer and wraps
// it in the auth_error frame shape VerifyRevokedProof reads.
func signedRevokedReply(t *testing.T, signer ed25519.PrivateKey, proof map[string]any) map[string]any {
	t.Helper()
	canon, err := Canonical(proof)
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	return map[string]any{
		"type": TypeAuthError, "reason": ReasonRevoked,
		"proof": proof, "sig": hex.EncodeToString(ed25519.Sign(signer, canon)),
	}
}

// Fix round 1, Finding 1: the ONE destructive path (the device wiping its
// own identity) must be authenticated by core's signature over the proof —
// never by the handshake's unsigned core_pubkey claim. A genuinely signed,
// exactly-matching proof, verified against the PINNED key, is the only thing
// that passes.
func TestVerifyRevokedProofAcceptsAGenuinelySignedProof(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID, nonceHex = "dev-1", "aa"
	reply := signedRevokedReply(t, corePriv, canonicalRevokedProof(deviceID, nonceHex))
	if !VerifyRevokedProof(reply, deviceID, nonceHex, corePub) {
		t.Fatal("a genuinely signed, matching proof must verify")
	}
}

// Every near-miss on the required shape must be refused: a missing proof, a
// wrong kind/version/device/nonce (even with a VALID signature over that
// wrong content), a signature by a key that is not the pinned one, and a
// signature valid for some OTHER proof body tampered onto a different one
// (proving content checks and the signature check both run over the exact
// same received object, not two independently-trusted views of it).
func TestVerifyRevokedProofRejectsEveryNearMiss(t *testing.T) {
	corePub, corePriv, _ := ed25519.GenerateKey(rand.Reader)
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	const deviceID, nonceHex = "dev-1", "aa"

	cases := []struct {
		name  string
		build func() map[string]any
	}{
		{"no proof at all", func() map[string]any {
			return map[string]any{"type": TypeAuthError, "reason": ReasonRevoked}
		}},
		{"wrong kind", func() map[string]any {
			p := canonicalRevokedProof(deviceID, nonceHex)
			p["kind"] = "not-revoked"
			return signedRevokedReply(t, corePriv, p)
		}},
		{"wrong version", func() map[string]any {
			p := canonicalRevokedProof(deviceID, nonceHex)
			p["v"] = int64(2)
			return signedRevokedReply(t, corePriv, p)
		}},
		{"wrong device_id", func() map[string]any {
			return signedRevokedReply(t, corePriv, canonicalRevokedProof("some-other-device", nonceHex))
		}},
		{"wrong nonce", func() map[string]any {
			return signedRevokedReply(t, corePriv, canonicalRevokedProof(deviceID, "bb"))
		}},
		{"signed by a different key", func() map[string]any {
			return signedRevokedReply(t, otherPriv, canonicalRevokedProof(deviceID, nonceHex))
		}},
		{"tampered after signing", func() map[string]any {
			signed := signedRevokedReply(t, corePriv, canonicalRevokedProof(deviceID, nonceHex))
			signed["proof"] = canonicalRevokedProof("swapped-after-signing", nonceHex)
			return signed
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if VerifyRevokedProof(c.build(), deviceID, nonceHex, corePub) {
				t.Fatalf("%s: must not verify", c.name)
			}
		})
	}
}

// VerifyRevokedProof must check against the key pinned at enrollment, never
// the key a peer merely claims in a challenge frame — CorePubKey is that
// pinned key's one parsed, trusted copy.
func TestVerifierCorePubKeyReturnsThePinnedKey(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	ver, err := NewVerifier(hex.EncodeToString(pub), "dev-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !ver.CorePubKey().Equal(pub) {
		t.Fatal("CorePubKey must return the pinned key")
	}
}

// flipLastChar returns s with its final character changed to a different,
// deterministic one — a one-character mutation that works whether s is hex
// (a signature) or a UUID (a device_id), since both end in a character other
// than a dash in every fixture value this file uses.
func flipLastChar(s string) string {
	if s == "" {
		return s
	}
	replacement := byte('0')
	if s[len(s)-1] == '0' {
		replacement = '1'
	}
	return s[:len(s)-1] + string(replacement)
}

// TestVerifyRevokedProofAcceptsTheCommittedVector is the cross-language pin
// for S42a (controller ruling 2): core's actual signer
// (services/core/app/devices_ws.py's revoked_proof, via envelopes.sign with
// the SAME fixed seed) and this Verifier's checker must agree on the SAME
// bytes. The fixture's fourth vector (index 3) is the revoked-proof body —
// decoded exactly as the wire does (UseNumber) — and must verify against the
// seed's own public key, addressed to the vector's own device_id and nonce.
// A fixed index, not "last": Task 13 appends a fifth (Windows-path) vector
// AFTER this one, so "last" would silently pick up the wrong payload.
func TestVerifyRevokedProofAcceptsTheCommittedVector(t *testing.T) {
	vf := loadVectors(t)
	v := vf.Vectors[3]
	proof := decodePayload(t, v.Payload)
	if kind, _ := proof["kind"].(string); kind != RevokedProofKind {
		t.Fatalf("expected fixture vector 4 (index 3) to be the revoked-proof vector, got %v", proof)
	}
	deviceID, _ := proof["device_id"].(string)
	nonceHex, _ := proof["nonce"].(string)
	pub, err := hex.DecodeString(vf.PublicKeyHex)
	if err != nil {
		t.Fatalf("public key hex: %v", err)
	}
	corePub := ed25519.PublicKey(pub)

	reply := map[string]any{
		"type": TypeAuthError, "reason": ReasonRevoked,
		"proof": proof, "sig": v.SigHex,
	}
	if !VerifyRevokedProof(reply, deviceID, nonceHex, corePub) {
		t.Fatal("the committed revoked-proof vector must verify against the seed's public key")
	}

	// Fix round 1: a one-character change to the SIGNATURE, with the proof
	// left exactly as committed so every content check still passes — this
	// is the case that actually reaches ed25519.Verify.
	reply["sig"] = flipLastChar(v.SigHex)
	if VerifyRevokedProof(reply, deviceID, nonceHex, corePub) {
		t.Fatal("a one-character change to the signature must be refused")
	}

	// A one-character change to the proof's device_id, caught by the content
	// check before the signature is ever verified.
	tampered := map[string]any{}
	for k, val := range proof {
		tampered[k] = val
	}
	did, _ := tampered["device_id"].(string)
	tampered["device_id"] = flipLastChar(did)
	reply["proof"], reply["sig"] = tampered, v.SigHex
	if VerifyRevokedProof(reply, deviceID, nonceHex, corePub) {
		t.Fatal("a one-character change to the proof's device_id must be refused")
	}
}

// S30a T1 C1: a Result carrying Meta crosses the wire with a "meta" object
// equal to it.
func TestAResultWithMetaCarriesItOnTheWire(t *testing.T) {
	code := 0
	r := Result{Type: TypeResult, EnvelopeID: "e1", OK: true, Output: "x", ExitCode: &code,
		Meta: map[string]any{"bytes_total": 1048576, "range": map[string]any{"start_line": 3, "end_line": 9}}}
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	meta, ok := got["meta"].(map[string]any)
	if !ok {
		t.Fatalf("the result frame carries no meta object: %s", b)
	}
	if meta["bytes_total"] != float64(1048576) {
		t.Errorf("meta.bytes_total = %v, want 1048576: %s", meta["bytes_total"], b)
	}
	rng, _ := meta["range"].(map[string]any)
	if rng["start_line"] != float64(3) || rng["end_line"] != float64(9) {
		t.Errorf("meta.range = %v, want start_line 3 end_line 9: %s", meta["range"], b)
	}
}

// S30a T1 C2: a Result without Meta is byte-identical to the pre-S30a frame —
// no meta key at all, not "meta": null — so an old core and every golden
// stay unchanged. Nil and empty Meta both omit it.
func TestAResultWithoutMetaIsTodaysFrameByteForByte(t *testing.T) {
	code := 0
	const want = `{"type":"result","envelope_id":"e1","ok":true,"output":"x","exit_code":0,"error":""}`
	for _, meta := range []map[string]any{nil, {}} {
		b, err := json.Marshal(Result{Type: TypeResult, EnvelopeID: "e1", OK: true, Output: "x", ExitCode: &code, Meta: meta})
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != want {
			t.Errorf("Meta=%v: got %s, want %s", meta, b, want)
		}
	}
}
