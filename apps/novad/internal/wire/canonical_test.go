package wire

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The committed cross-language fixture. Core's pytest and this Go suite assert
// the SAME bytes and the SAME signatures — a drift in either language reddens
// both. The fixture is read-only here; if a vector goes red the question is
// which implementation moved, never "regenerate to make it pass".
type vectorFile struct {
	SeedHex      string `json:"seed_hex"`
	PublicKeyHex string `json:"public_key_hex"`
	Vectors      []struct {
		Note      string          `json:"note"`
		Payload   json.RawMessage `json:"payload"`
		Canonical string          `json:"canonical"`
		SigHex    string          `json:"sig_hex"`
	} `json:"vectors"`
}

// fixturePath resolves the core fixture from THIS test file's location via
// runtime.Caller, so it does not depend on the working directory a runner
// happens to use. apps/novad/internal/wire -> repo root is four parents up.
func fixturePath(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	repoRoot := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..")
	return filepath.Join(repoRoot, "services", "core", "tests", "fixtures", "envelope_vectors.json")
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(fixturePath(t))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var vf vectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(vf.Vectors) == 0 {
		t.Fatal("fixture carries no vectors")
	}
	return vf
}

// decodePayload mirrors what the daemon does on the wire: decode with
// UseNumber so 1756600000 stays an integer text and never becomes a float64
// that would re-render as 1.7566e+09 and break every signature.
func decodePayload(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	return m
}

func TestCanonicalMatchesEveryVector(t *testing.T) {
	vf := loadVectors(t)
	for i, v := range vf.Vectors {
		payload := decodePayload(t, v.Payload)
		got, err := Canonical(payload)
		if err != nil {
			t.Fatalf("vector %d (%s): Canonical errored: %v", i+1, v.Note, err)
		}
		if string(got) != v.Canonical {
			t.Fatalf("vector %d (%s): canonical bytes differ\n want: %s\n  got: %s",
				i+1, v.Note, v.Canonical, string(got))
		}
	}
}

func TestSignatureVerifiesOverCanonicalForEveryVector(t *testing.T) {
	vf := loadVectors(t)
	pub, err := hex.DecodeString(vf.PublicKeyHex)
	if err != nil {
		t.Fatalf("public key hex: %v", err)
	}
	for i, v := range vf.Vectors {
		payload := decodePayload(t, v.Payload)
		canon, err := Canonical(payload)
		if err != nil {
			t.Fatalf("vector %d: Canonical errored: %v", i+1, err)
		}
		sig, err := hex.DecodeString(v.SigHex)
		if err != nil {
			t.Fatalf("vector %d: sig hex: %v", i+1, err)
		}
		if !ed25519.Verify(ed25519.PublicKey(pub), canon, sig) {
			t.Fatalf("vector %d (%s): ed25519 verify FAILED over canonical bytes", i+1, v.Note)
		}
	}
}

// The astral / surrogate-pair branch is the one path no committed vector
// reaches (all three stay within the BMP). Python emits a lowercase UTF-16
// surrogate pair for a rune beyond U+FFFF; the daemon must match. 😀 is
// U+1F600 -> 😀.
func TestCanonicalEmitsAstralAsASurrogatePair(t *testing.T) {
	got, err := Canonical(map[string]any{"x": "😀"})
	if err != nil {
		t.Fatalf("Canonical errored: %v", err)
	}
	// The ASCII escape Python emits: a lowercase UTF-16 surrogate pair. Built
	// with doubled backslashes so the literal is unambiguous ASCII.
	want := "{\"x\":\"\\ud83d\\ude00\"}"
	if string(got) != want {
		t.Fatalf("astral encoding differs\n want: %s\n  got: %s", want, string(got))
	}
}

// Vector 2 is the whole interop risk in one payload: non-ASCII (café, naïve, ✓)
// AND the three HTML-ish bytes (< > &). A naive encoding/json.Marshal fails it
// two ways — it emits UTF-8 for the non-ASCII and escapes < > & as < etc.
// This test names it explicitly so a regression here is unambiguous.
func TestVectorTwoIsTheInteropTripwire(t *testing.T) {
	vf := loadVectors(t)
	var v2 = vf.Vectors[1]
	payload := decodePayload(t, v2.Payload)
	got, err := Canonical(payload)
	if err != nil {
		t.Fatalf("Canonical errored: %v", err)
	}
	if string(got) != v2.Canonical {
		t.Fatalf("vector 2 canonical differs (the interop hazard)\n want: %s\n  got: %s",
			v2.Canonical, string(got))
	}
	// The literal facts, asserted directly so the intent survives a refactor.
	if !bytes.Contains(got, []byte("\\u00e9")) {
		t.Error("expected the accented e as the ASCII escape \\u00e9 (Python ensure_ascii), not raw UTF-8")
	}
	if bytes.Contains(got, []byte{0xc3, 0xa9}) {
		t.Error("raw UTF-8 bytes for the accented e must NOT appear — ensure_ascii escapes every rune > 0x7f")
	}
	if !bytes.Contains(got, []byte("a<b>c&d")) {
		t.Error("expected < > & left literal (Python does not HTML-escape); Go's default would emit \\u003c")
	}
	if !bytes.Contains(got, []byte("\\u2713")) {
		t.Error("expected the check-mark (U+2713) as the ASCII escape \\u2713")
	}
}
