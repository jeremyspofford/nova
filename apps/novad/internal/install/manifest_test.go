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
	manifest := map[string]any{
		"v": 1, "version": "aaaaaaaaaaaa", "built_at": "2026-09-28T12:00:00Z", "go": "go1.27.1",
		"files": map[string]any{runtime.GOOS + "-" + runtime.GOARCH: map[string]any{"name": "novad", "sha256": sum, "size": 10}},
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
