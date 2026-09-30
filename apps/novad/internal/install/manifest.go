package install

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"

	"novad/internal/wire"
)

// CheckManifest reads the hub's signed manifest and says whether sum is the
// hub's build for this OS — the manifest signature's S42b reader (P19). One
// whose signature does not verify against the pinned key is reported as not
// trusted and never used.
func CheckManifest(ctx context.Context, server, corePubHex, sum string) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(server, "/")+"/api/v1/agent/manifest", nil)
	if err != nil {
		return "could not read the hub's manifest: " + err.Error()
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "could not read the hub's manifest: " + err.Error()
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		// Only the status is known: a hub with no build answers 503, one from
		// before S42b does not serve the path, and a busy one says 429.
		return fmt.Sprintf("the hub gave no manifest to compare with (%s)", resp.Status)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var body map[string]any
	if err := dec.Decode(&body); err != nil {
		return "the hub's manifest is unreadable"
	}
	manifest, _ := body["manifest"].(map[string]any)
	sigHex, _ := body["sig"].(string)
	canon, cerr := wire.Canonical(manifest)
	sig, serr := hex.DecodeString(sigHex)
	pub, perr := hex.DecodeString(corePubHex)
	if manifest == nil || cerr != nil || serr != nil || perr != nil || len(pub) != ed25519.PublicKeySize ||
		!ed25519.Verify(ed25519.PublicKey(pub), canon, sig) {
		return "the hub's manifest did not verify against the pinned core key — not trusted"
	}
	version, _ := manifest["version"].(string)
	files, _ := manifest["files"].(map[string]any)
	entry, _ := files[runtime.GOOS+"-"+runtime.GOARCH].(map[string]any)
	if want, _ := entry["sha256"].(string); want == sum {
		return "this binary is the hub's build " + version
	}
	return fmt.Sprintf("this binary is not the hub's build %s — Nova updates it when this machine is idle", version)
}
