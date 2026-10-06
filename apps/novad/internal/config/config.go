// Package config is the daemon's on-disk custody: the enrollment config and
// the ed25519 private key (0600, in a 0700 dir on Linux and macOS; on
// Windows, in a directory whose DACL is protected and grants only SYSTEM and
// this user — custody_windows.go). It holds the identity that proves WHO
// signed a command; nothing here decides WHAT a verified command may do.
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

	// Locators are this device's ways to reach its Nova, in order (S42b):
	// the hub's own loopback first on the hub machine, then the tailnet
	// origin. Each is only ever trusted through the core key pinned at
	// enrolment. Empty in a config written before S42b.
	Locators []string `json:"locators,omitempty"`
}

// Hubs are the locators to try, in order: Locators, else the one Server a
// config from before S42b carries. A copy — callers may reorder it.
func (c Config) Hubs() []string {
	if len(c.Locators) > 0 {
		return append([]string(nil), c.Locators...)
	}
	if c.Server != "" {
		return []string{c.Server}
	}
	return nil
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

// ErrNotEnrolled is CheckEnrolled's answer when the config or the key is
// simply MISSING — never enrolled, or wiped after a revoke. Any OTHER error
// CheckEnrolled returns is the real cause (permission, I/O, a config dir
// that is itself unreadable) and must never be folded into "not enrolled":
// pairing again cannot fix a real error, so `run` exits 1 on it, never 78,
// and `install` stops instead of pairing over it.
var ErrNotEnrolled = errors.New("not enrolled")

// CheckEnrolled distinguishes confirmed-missing (ErrNotEnrolled) from every
// other Lstat failure (returned as itself); nil means both files exist. It is
// the one enrollment check `run` and `install` share (S42b). Enrolled is a
// plain bool that `enroll` uses only to decide whether --force is needed;
// these callers need the finer distinction because a real error and "pair
// this machine" are not the same advice, and giving the wrong one hides the
// real problem.
func (p Paths) CheckEnrolled() error {
	for _, f := range []string{p.ConfigFile, p.KeyFile} {
		if _, err := os.Lstat(f); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return ErrNotEnrolled
			}
			return err
		}
	}
	return nil
}

// Save writes the config and the private key with 0600 in a 0700 dir, each
// replaced whole (writeFile0600), so a failed write never tears them. The key
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

// writeAll writes body to f and syncs it to the disk; a test makes it fail
// partway, as a crash or a full disk would.
var writeAll = func(f *os.File, body []byte) error {
	if _, err := f.Write(body); err != nil {
		return err
	}
	return f.Sync()
}

// writeFile0600 replaces path with body whole (Task 32, L223): written and
// synced to a temp file in the same directory — 0600 from its creation, and
// under the custody DACL there on Windows — then renamed over path. A write
// that fails or a crash leaves the old file exactly as it was, never a torn
// config or key. The rename is retried briefly, as state.WriteJSON's is: on
// Windows a reader holding the old file open refuses it for a moment.
func writeFile0600(path string, body []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if err := writeAll(tmp, body); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	for i := 0; ; i++ {
		err = os.Rename(name, path)
		if err == nil || i == 9 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		os.Remove(name)
	}
	return err
}

// Wipe removes this device's identity after core revoked it: the config and
// the key go, so a restart cannot reconnect as a device core has disowned,
// and the audit log is SET ASIDE (renamed, never deleted — it is the record
// of what this machine did) so a later enroll starts a fresh chain instead of
// replaying the revoked device's chain under the new id. Missing files are
// fine; any other failure is returned, because a wipe that silently
// half-happened is the one outcome worse than none. The returned string is
// where the audit log went — "" when there was none to move, or when the
// rename did not complete — so a caller can say exactly what happened
// instead of assuming every wipe moves one.
func Wipe(p Paths, now time.Time) (string, error) {
	var errs []error
	for _, f := range []string{p.ConfigFile, p.KeyFile} {
		if err := os.Remove(f); err != nil && !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	asidePath := ""
	// Lstat the SOURCE first: on a second Wipe in the same unix second the
	// live file is already gone, so this is a no-op rather than a second,
	// pointless search for a free set-aside name. Any Stat/Lstat error
	// other than "missing" (EACCES, EIO, ...) is reported, never swallowed
	// as "nothing to do" — a wipe that silently left the audit log live is
	// the one outcome worse than a crash.
	if _, err := os.Lstat(p.AuditFile); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, fmt.Errorf("checking the audit log %s: %w", p.AuditFile, err))
		}
	} else if aside, err := setAsideName(p.AuditFile, now); err != nil {
		errs = append(errs, err)
	} else if err := os.Rename(p.AuditFile, aside); err != nil {
		errs = append(errs, err)
	} else {
		asidePath = aside
	}
	return asidePath, errors.Join(errs...)
}

// setAsideName is the first "<audit file>.revoked-<unix>[-N]" name that does
// not exist yet. os.Rename REPLACES an existing destination on both Unix and
// Windows, so reusing a name a previous wipe already claimed would silently
// destroy that earlier audit log instead of keeping it.
func setAsideName(auditFile string, now time.Time) (string, error) {
	return freeName(fmt.Sprintf("%s.revoked-%d", auditFile, now.Unix()))
}

// SetAside moves an identity out of the way without deleting it — config,
// key and audit log each renamed to "<file>.<tag>-<unix>[-N]", never
// overwriting an earlier one — so a machine can pair again while the old
// record stays on disk. Missing files are skipped; the new paths are
// returned.
func SetAside(p Paths, now time.Time, tag string) ([]string, error) {
	var moved []string
	var errs []error
	for _, f := range []string{p.ConfigFile, p.KeyFile, p.AuditFile} {
		if _, err := os.Lstat(f); err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				errs = append(errs, err)
			}
			continue
		}
		dst, err := freeName(fmt.Sprintf("%s.%s-%d", f, tag, now.Unix()))
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if err := os.Rename(f, dst); err != nil {
			errs = append(errs, err)
			continue
		}
		moved = append(moved, dst)
	}
	return moved, errors.Join(errs...)
}

// freeName is base, or base-1, base-2, … — the first that does not exist.
func freeName(base string) (string, error) {
	candidate := base
	for n := 0; ; n++ {
		if n > 0 {
			candidate = fmt.Sprintf("%s-%d", base, n)
		}
		if _, err := os.Lstat(candidate); errors.Is(err, fs.ErrNotExist) {
			return candidate, nil
		} else if err != nil {
			return "", err
		}
	}
}
