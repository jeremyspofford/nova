package install

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// testdata/manifest_golden.json is what core's own signer
// (services/core/app/agent_dist.py signed_manifest) made of a fake build,
// committed beside the public half of the throwaway TEST key that signed it —
// never core's real key. Core's suite (test_agent_dist.py) builds it again
// through the real signer and fails when the committed file is stale; these
// tests say whether novad's CheckManifest trusts what core signs, and only
// that. If they go red after a regeneration, the two sides drifted: find out
// which one moved (tests/fixtures/gen_manifest_golden.py says how).
type goldenManifest struct {
	PublicKeyHex string          `json:"public_key_hex"`
	Response     json.RawMessage `json:"response"`
}

type goldenBody struct {
	Manifest struct {
		Version string `json:"version"`
		Files   map[string]struct {
			Sha256 string `json:"sha256"`
		} `json:"files"`
	} `json:"manifest"`
	Sig string `json:"sig"`
}

func loadGolden(t *testing.T) (goldenManifest, goldenBody) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "manifest_golden.json"))
	if err != nil {
		t.Fatalf("read the golden manifest: %v", err)
	}
	var g goldenManifest
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("parse the golden manifest: %v", err)
	}
	var body goldenBody
	if err := json.Unmarshal(g.Response, &body); err != nil {
		t.Fatalf("parse the golden response: %v", err)
	}
	if g.PublicKeyHex == "" || body.Manifest.Version == "" || len(body.Manifest.Files) != 6 || body.Sig == "" {
		t.Fatalf("the golden manifest is not a signed six-target manifest: %s", raw)
	}
	return g, body
}

// serveResponse answers /api/v1/agent/manifest with exactly these bytes.
func serveResponse(t *testing.T, response []byte) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/agent/manifest" {
			_, _ = w.Write(response)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestTheManifestCoreSignsIsTrusted(t *testing.T) {
	g, body := loadGolden(t)
	url := serveResponse(t, g.Response)
	version := body.Manifest.Version

	// Every CI runner is one of the six targets the manifest names, so this
	// binary's own entry is always there to match.
	entry, ok := body.Manifest.Files[runtime.GOOS+"-"+runtime.GOARCH]
	if !ok {
		t.Fatalf("the golden manifest names no %s-%s build", runtime.GOOS, runtime.GOARCH)
	}
	if got := CheckManifest(context.Background(), url, g.PublicKeyHex, entry.Sha256); got != "this binary is the hub's build "+version {
		t.Fatalf("core's own signature was not trusted, or the entry not matched: %q", got)
	}
	// Trusted, and a sum the manifest does not name is not the hub's build.
	if got := CheckManifest(context.Background(), url, g.PublicKeyHex, strings.Repeat("0", 64)); !strings.Contains(got, "is not the hub's build "+version) {
		t.Fatalf("got %q", got)
	}

	// What is signed is the canonical form, not the transport's bytes: the
	// same response with every byte of whitespace taken out is still trusted.
	var compact bytes.Buffer
	if err := json.Compact(&compact, g.Response); err != nil {
		t.Fatal(err)
	}
	if got := CheckManifest(context.Background(), serveResponse(t, compact.Bytes()), g.PublicKeyHex, entry.Sha256); got != "this binary is the hub's build "+version {
		t.Fatalf("the compacted response was not trusted: %q", got)
	}
}

func TestOneChangedByteInTheManifestCoreSignsIsNotTrusted(t *testing.T) {
	g, body := loadGolden(t)
	entry := body.Manifest.Files[runtime.GOOS+"-"+runtime.GOARCH]

	// Each case changes exactly one byte of the response: the first byte of
	// `value` where it follows `before` (the byte right after `before` when
	// value is empty).
	cases := []struct{ what, before, value string }{
		{"the version", `"version": "`, body.Manifest.Version},
		{"this target's sha256", `"sha256": "`, entry.Sha256},
		{"a size", `"size": `, ""},
		{"the build time", `"built_at": "`, ""},
		{"the Go version", `"go": "go`, ""},
		{"the manifest's own version", `"v": `, ""},
		{"the signature", `"sig": "`, body.Sig},
	}
	for _, c := range cases {
		at := bytes.Index(g.Response, []byte(c.before+c.value))
		if at < 0 {
			t.Fatalf("%s: %q is not in the golden response", c.what, c.before+c.value)
		}
		at += len(c.before)
		changed := bytes.Clone(g.Response)
		changed[at] = otherByte(changed[at])
		if bytes.Equal(changed, g.Response) || len(changed) != len(g.Response) {
			t.Fatalf("%s: not exactly one byte changed", c.what)
		}
		got := CheckManifest(context.Background(), serveResponse(t, changed), g.PublicKeyHex, entry.Sha256)
		if !strings.Contains(got, "not trusted") {
			t.Fatalf("%s changed by one byte was believed: %q", c.what, got)
		}
	}
}

// otherByte is a different byte of the same class, so the change stays valid
// JSON and the manifest still parses: what refuses it is the signature.
func otherByte(b byte) byte {
	switch {
	case b >= '0' && b <= '8', b >= 'a' && b <= 'e':
		return b + 1
	case b == '9':
		return '0'
	case b == 'f':
		return 'a'
	case b >= 'g' && b <= 'y':
		return b + 1
	default:
		return 'z'
	}
}
