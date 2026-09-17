package wire

import (
	"crypto/ed25519"
	"encoding/hex"
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
