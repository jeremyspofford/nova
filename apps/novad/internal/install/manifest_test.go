package install

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"novad/internal/wire"
)

func signedManifestServer(t *testing.T, signer ed25519.PrivateKey, sum string) string {
	t.Helper()
	return signedManifestServerOf(t, signer, map[string]any{
		runtime.GOOS + "-" + runtime.GOARCH: map[string]any{"name": "novad", "sha256": sum, "size": 10}})
}

// signedManifestServerOf serves a manifest listing exactly files, signed.
func signedManifestServerOf(t *testing.T, signer ed25519.PrivateKey, files map[string]any) string {
	t.Helper()
	manifest := map[string]any{
		"v": 1, "version": "aaaaaaaaaaaa", "built_at": "2026-09-28T12:00:00Z", "go": "go1.27.1",
		"files": files,
	}
	canon, err := wire.Canonical(manifest)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"manifest": manifest, "sig": hex.EncodeToString(ed25519.Sign(signer, canon))})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/agent/manifest" {
			_, _ = w.Write(body)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestTheManifestSaysWhetherThisIsTheHubsBuild(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	sum := strings.Repeat("c", 64)
	url := signedManifestServer(t, priv, sum)
	if got := CheckManifest(context.Background(), url, hex.EncodeToString(pub), sum); got != "this binary is the hub's build aaaaaaaaaaaa" {
		t.Fatalf("got %q", got)
	}
	if got := CheckManifest(context.Background(), url, hex.EncodeToString(pub), strings.Repeat("d", 64)); !strings.Contains(got, "is not the hub's build aaaaaaaaaaaa") {
		t.Fatalf("got %q", got)
	}
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	if got := CheckManifest(context.Background(), url, hex.EncodeToString(otherPub), sum); !strings.Contains(got, "not trusted") {
		t.Fatalf("a manifest another key signed must never be believed: %q", got)
	}
}

// Task 32, L226: a manifest that lists no build for this OS and arch — or
// lists one with no sha256 — has nothing to compare with. A missing sha256
// reads as "", so an empty sum once matched it: "this binary is the hub's
// build" must never come of a comparison that did not happen.
func TestAManifestWithNoBuildForThisPlatformIsNeverAMatch(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	here := runtime.GOOS + "-" + runtime.GOARCH
	for name, files := range map[string]map[string]any{
		"no entry":        {"plan9-386": map[string]any{"name": "novad", "sha256": strings.Repeat("c", 64), "size": 10}},
		"no sha256 in it": {here: map[string]any{"name": "novad", "size": 10}},
	} {
		url := signedManifestServerOf(t, priv, files)
		for _, sum := range []string{"", strings.Repeat("c", 64)} {
			got := CheckManifest(context.Background(), url, hex.EncodeToString(pub), sum)
			if strings.Contains(got, "is the hub's build") || !strings.Contains(got, "names no "+here+" build") {
				t.Errorf("%s, sum %q: got %q", name, sum, got)
			}
		}
	}
}
