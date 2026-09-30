package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"novad/internal/config"
)

// install reads a server that holds the pinned core key but refused this
// device as "this pairing is dead there" (S42b Task 11) — so VerifyServer's
// refusal must be the type install matches, in the same words as before.
func TestAServerThatRefusesThisDeviceIsARefusedError(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	srv, attempts := refusingCore(t, corePub, devPub, "revoked")
	cfg := config.Config{DeviceID: "dev-refused-1", Server: srv.URL, CorePubKey: hex.EncodeToString(corePub)}
	err := VerifyServer(context.Background(), cfg, devPriv)
	var refused *RefusedError
	if !errors.As(err, &refused) || refused.Reason != "revoked" || attempts() != 1 {
		t.Fatalf("err %v (%T), attempts %d", err, err, attempts())
	}
	if !strings.Contains(err.Error(), "holds the core key you pinned, but it refused this device: revoked") {
		t.Fatalf("the words changed: %v", err)
	}
}
