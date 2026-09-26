// Package config is the daemon's on-disk custody: the enrollment config and
// the ed25519 private key (0600, in a 0700 dir). It holds the identity that
// proves WHO signed a command; nothing here decides WHAT a verified command
// may do.
package config

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"novad/internal/platform"
)

// Config is the enrollment record written by `novad enroll`.
type Config struct {
	DeviceID   string `json:"device_id"`
	Name       string `json:"name"`
	Server     string `json:"server"`
	CorePubKey string `json:"core_pubkey"` // pinned at enrollment; 64 hex
}

// Paths resolves the daemon's file locations per OS (platform.ConfigBase and
// StateBase): Linux keeps XDG (unchanged, so an enrolled daemon finds its
// key), macOS uses ~/Library/Application Support, Windows puts config in
// %AppData% and the audit log in %LocalAppData%. The audit log lives in the
// state dir; the key and config in the config dir.
type Paths struct {
	ConfigDir  string
	StateDir   string
	ConfigFile string
	KeyFile    string
	AuditFile  string
	Home       string
}

// DefaultPaths resolves the standard locations for the current user.
func DefaultPaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, fmt.Errorf("cannot resolve home dir: %w", err)
	}
	configBase, err := platform.ConfigBase()
	if err != nil {
		return Paths{}, fmt.Errorf("cannot resolve the config dir: %w", err)
	}
	stateBase, err := platform.StateBase()
	if err != nil {
		return Paths{}, fmt.Errorf("cannot resolve the state dir: %w", err)
	}
	configDir := filepath.Join(configBase, "novad")
	stateDir := filepath.Join(stateBase, "novad")
	return Paths{
		ConfigDir:  configDir,
		StateDir:   stateDir,
		ConfigFile: filepath.Join(configDir, "config.json"),
		KeyFile:    filepath.Join(configDir, "key"),
		AuditFile:  filepath.Join(stateDir, "audit.jsonl"),
		Home:       home,
	}, nil
}

// Enrolled reports whether a config + key already exist (so enroll refuses to
// clobber them without --force).
func (p Paths) Enrolled() bool {
	if _, err := os.Stat(p.ConfigFile); err != nil {
		return false
	}
	if _, err := os.Stat(p.KeyFile); err != nil {
		return false
	}
	return true
}

// Save writes the config and the private key with 0600 in a 0700 dir. The key
// is stored as its 32-byte seed (hex): ed25519.NewKeyFromSeed re-derives the
// full private key, and a seed is all that ever needs to be secret.
func Save(p Paths, cfg Config, priv ed25519.PrivateKey) error {
	if err := os.MkdirAll(p.ConfigDir, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(p.StateDir, 0o700); err != nil {
		return err
	}
	// Windows ignores the mode bits above; harden sets the DACL that makes
	// them true there (custody_windows.go). Before the files are written, so
	// they inherit it. A no-op elsewhere.
	for _, dir := range []string{p.ConfigDir, p.StateDir} {
		if err := harden(dir); err != nil {
			return err
		}
	}
	body, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFile0600(p.ConfigFile, append(body, '\n')); err != nil {
		return err
	}
	seed := priv.Seed()
	if err := writeFile0600(p.KeyFile, []byte(hex.EncodeToString(seed)+"\n")); err != nil {
		return err
	}
	return nil
}

// Load reads the config and re-derives the private key from its stored seed.
func Load(p Paths) (Config, ed25519.PrivateKey, error) {
	var cfg Config
	body, err := os.ReadFile(p.ConfigFile)
	if err != nil {
		return cfg, nil, fmt.Errorf("no enrollment found (run `novad enroll`): %w", err)
	}
	if err := json.Unmarshal(body, &cfg); err != nil {
		return cfg, nil, fmt.Errorf("config is unreadable: %w", err)
	}
	keyHex, err := os.ReadFile(p.KeyFile)
	if err != nil {
		return cfg, nil, fmt.Errorf("no device key found: %w", err)
	}
	seed, err := hex.DecodeString(strings.TrimSpace(string(keyHex)))
	if err != nil {
		return cfg, nil, fmt.Errorf("device key is not hex: %w", err)
	}
	if len(seed) != ed25519.SeedSize {
		return cfg, nil, fmt.Errorf("device key seed is %d bytes, want %d", len(seed), ed25519.SeedSize)
	}
	return cfg, ed25519.NewKeyFromSeed(seed), nil
}

func writeFile0600(path string, body []byte) error {
	// O_TRUNC so a shorter rewrite cannot leave a stale tail; 0600 explicit.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// Wipe removes this device's identity after core revoked it: the config and
// the key go, so a restart cannot reconnect as a device core has disowned,
// and the audit log is SET ASIDE (renamed, never deleted — it is the record
// of what this machine did) so a later enroll starts a fresh chain instead of
// replaying the revoked device's chain under the new id. Missing files are
// fine; any other failure is returned, because a wipe that silently
// half-happened is the one outcome worse than none.
func Wipe(p Paths, now time.Time) error {
	var errs []error
	for _, f := range []string{p.ConfigFile, p.KeyFile} {
		if err := os.Remove(f); err != nil && !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	if _, err := os.Stat(p.AuditFile); err == nil {
		aside := fmt.Sprintf("%s.revoked-%d", p.AuditFile, now.Unix())
		if err := os.Rename(p.AuditFile, aside); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
