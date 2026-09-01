// Package config is the daemon's on-disk custody: the enrollment config, the
// ed25519 private key (0600, in a 0700 dir), and the deny-roots backstop.
// Nothing here trusts core — the deny-roots check refuses a signed fs.* target
// under a protected root regardless of what core granted, so the daemon's own
// key can never be rewritten by a command it was told to run.
package config

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Config is the enrollment record written by `novad enroll`.
type Config struct {
	DeviceID   string `json:"device_id"`
	Name       string `json:"name"`
	Server     string `json:"server"`
	CorePubKey string `json:"core_pubkey"` // pinned at enrollment; 64 hex
}

// Paths resolves the daemon's file locations, honoring XDG_CONFIG_HOME and
// XDG_STATE_HOME. The audit log lives in the state dir; the key and config in
// the config dir. Both dirs are deny-rooted by default.
type Paths struct {
	ConfigDir     string
	StateDir      string
	ConfigFile    string
	KeyFile       string
	DenyRootsFile string
	AuditFile     string
	Home          string
}

// DefaultPaths resolves the standard locations for the current user.
func DefaultPaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, fmt.Errorf("cannot resolve home dir: %w", err)
	}
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		configHome = filepath.Join(home, ".config")
	}
	stateHome := os.Getenv("XDG_STATE_HOME")
	if stateHome == "" {
		stateHome = filepath.Join(home, ".local", "state")
	}
	configDir := filepath.Join(configHome, "novad")
	stateDir := filepath.Join(stateHome, "novad")
	return Paths{
		ConfigDir:     configDir,
		StateDir:      stateDir,
		ConfigFile:    filepath.Join(configDir, "config.json"),
		KeyFile:       filepath.Join(configDir, "key"),
		DenyRootsFile: filepath.Join(configDir, "deny_roots"),
		AuditFile:     filepath.Join(stateDir, "audit.jsonl"),
		Home:          home,
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
