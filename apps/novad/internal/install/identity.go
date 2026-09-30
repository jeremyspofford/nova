package install

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"strings"
	"time"

	"novad/internal/client"
	"novad/internal/config"
	"novad/internal/service"
)

// ErrNeedsCode is install's answer when this machine has no live pairing and
// no code was given: main exits 3, and ./install mints one and asks again.
var ErrNeedsCode = errors.New("a pairing code is needed")

// Options is one install. Zero-valued seams take the real implementations.
type Options struct {
	Hubs         []string
	Code         string
	Name         string
	IfMissing    bool
	RestartLater bool
	// TrustPairing keeps a pairing this machine already has WITHOUT asking
	// any hub whether it still knows it (controller ruling F2, P11). It is
	// for `install --restart-later`, which runs inside the old agent's own
	// shell.exec: that agent's live, authenticated session is the proof, and
	// a second socket as the same device would make core's hub fail the very
	// command running this install. Off — the default — a hub is asked.
	TrustPairing bool
	Self         string // this binary (os.Executable)
	Version      string
	Paths        config.Paths
	InstallDir   string
	Service      service.Manager
	Now          func() time.Time
	Verify       func(context.Context, config.Config, ed25519.PrivateKey) error
	Enroll       func(ctx context.Context, hub, code, name, hostname string, pub ed25519.PublicKey) (EnrollResult, error)
	InWSL        func() bool
	Alive        func(pid int) bool
	Manifest     func(ctx context.Context, server, corePubHex, sum string) string
	WaitReady    time.Duration
	PollEvery    time.Duration
	Out          io.Writer
}

// checkHubs holds each address to D6: verified TLS, or plain http only to
// this machine's own loopback.
func checkHubs(hubs []string) error {
	for _, h := range hubs {
		u, err := url.Parse(h)
		if err != nil {
			return fmt.Errorf("%q is not an address: %w", h, err)
		}
		switch u.Scheme {
		case "https":
		case "http":
			host := u.Hostname()
			if host != "127.0.0.1" && host != "localhost" && host != "::1" {
				return fmt.Errorf("%s must be https — plain http is only for this machine's own loopback", h)
			}
		default:
			return fmt.Errorf("%s must be an https address (or http to this machine's loopback)", h)
		}
	}
	return nil
}

type verdict int

const (
	alive verdict = iota
	dead
	unreachable
)

// check asks each hub whether it still knows this pairing. Dead only when
// EVERY hub answered and none knew it; one that did not answer proves nothing.
func (o *Options) check(ctx context.Context, cfg config.Config, priv ed25519.PrivateKey, hubs []string) (verdict, string, string) {
	var reasons []string
	answered := 0
	for _, hub := range hubs {
		c := cfg
		c.Server = hub
		err := o.Verify(ctx, c, priv)
		if err == nil {
			return alive, hub, ""
		}
		var km *client.KeyMismatch
		var rf *client.RefusedError
		if errors.As(err, &km) || errors.As(err, &rf) {
			answered++
		}
		reasons = append(reasons, fmt.Sprintf("%s: %v", hub, err))
	}
	if answered == len(hubs) {
		return dead, "", strings.Join(reasons, "; ")
	}
	return unreachable, "", strings.Join(reasons, "; ")
}

// identity is the pairing to run under. An existing one is kept when a hub
// still knows it, when no hub answered (that proves nothing), or — with
// TrustPairing — without asking any hub; a code given is then left unused. A
// fresh one is made from the code when there is none, or when every hub
// disowned the old one (set aside first, never deleted); without a code that
// is ErrNeedsCode. The notes say which, for the report.
func (o *Options) identity(ctx context.Context) (config.Config, []string, error) {
	var notes []string
	enrolled := true
	if err := o.Paths.CheckEnrolled(); errors.Is(err, config.ErrNotEnrolled) {
		enrolled = false
	} else if err != nil {
		return config.Config{}, nil, fmt.Errorf("could not check this machine's pairing: %w", err)
	}
	hubs := o.Hubs
	if enrolled {
		cfg, priv, err := config.Load(o.Paths)
		if err != nil {
			return config.Config{}, nil, err
		}
		if len(hubs) == 0 {
			hubs = cfg.Hubs()
		}
		if len(hubs) == 0 {
			// Asked of no hub, the pairing is proven neither alive nor dead —
			// so it is never set aside on that.
			return config.Config{}, nil, errors.New("install needs --hub <Nova's address>: this machine's pairing names none (the card's command has it)")
		}
		if o.TrustPairing {
			notes = append(notes, fmt.Sprintf("kept this machine's pairing as %q without asking Nova whether it still knows it", cfg.Name))
			return o.keep(cfg, priv, hubs, notes)
		}
		v, hub, reason := o.check(ctx, cfg, priv, hubs)
		switch v {
		case alive:
			cfg.Server = hub
			notes = append(notes, fmt.Sprintf("kept this machine's pairing as %q", cfg.Name))
			return o.keep(cfg, priv, hubs, notes)
		case unreachable:
			notes = append(notes, "could not reach Nova to check this pairing ("+reason+"); kept it")
			return o.keep(cfg, priv, hubs, notes)
		}
		if o.Code == "" {
			return config.Config{}, nil, fmt.Errorf("%w: Nova no longer knows this machine's pairing (%s)", ErrNeedsCode, reason)
		}
		moved, err := config.SetAside(o.Paths, o.Now(), "replaced")
		if err != nil {
			return config.Config{}, nil, fmt.Errorf("setting the old pairing aside: %w", err)
		}
		notes = append(notes, fmt.Sprintf("set the old pairing aside (%s) — Nova no longer knew it", strings.Join(moved, ", ")))
	} else {
		if o.Code == "" {
			return config.Config{}, nil, fmt.Errorf("%w: this machine is not paired", ErrNeedsCode)
		}
		if len(hubs) == 0 {
			return config.Config{}, nil, errors.New("install needs --hub <Nova's address> to pair (the card's command has it)")
		}
		// An audit log with no pairing is an older identity's chain: it would
		// replay under the new device's id. It is set aside first, and one that
		// cannot be set aside — or cannot even be checked — stops the pairing
		// before the code is spent (F14): a clean start is never assumed.
		if _, err := os.Lstat(o.Paths.AuditFile); !errors.Is(err, fs.ErrNotExist) {
			moved, err := config.SetAside(o.Paths, o.Now(), "orphaned")
			if err != nil {
				return config.Config{}, nil, fmt.Errorf("cannot pair: the old audit log could not be set aside: %w", err)
			}
			if len(moved) > 0 {
				notes = append(notes, "set an old audit log aside ("+strings.Join(moved, ", ")+")")
			}
		}
	}
	cfg, note, err := o.pair(ctx, hubs)
	if err != nil {
		return config.Config{}, notes, err
	}
	return cfg, append(notes, note), nil
}

// keep saves the pairing this machine already has, with hubs as its
// addresses; its key and pinned core key are unchanged. A code given is left
// unused, and the notes say so.
func (o *Options) keep(cfg config.Config, priv ed25519.PrivateKey, hubs, notes []string) (config.Config, []string, error) {
	if o.Code != "" {
		notes = append(notes, "the pairing code was not used (it expires unused)")
	}
	cfg.Locators = hubs
	if err := config.Save(o.Paths, cfg, priv); err != nil {
		return config.Config{}, nil, fmt.Errorf("saving this machine's pairing: %w", err)
	}
	return cfg, notes, nil
}

func (o *Options) pair(ctx context.Context, hubs []string) (config.Config, string, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return config.Config{}, "", err
	}
	host, _ := os.Hostname()
	name := o.Name
	if name == "" {
		name = host
	}
	var lastErr error
	for _, hub := range hubs {
		res, err := o.Enroll(ctx, hub, o.Code, name, host, pub)
		var refused *EnrollRefused
		if errors.As(err, &refused) {
			return config.Config{}, "", err
		}
		if err != nil {
			lastErr = err
			continue
		}
		cfg := config.Config{DeviceID: res.DeviceID, Name: res.Name, Server: hub, CorePubKey: res.CorePubKey, Locators: hubs}
		if err := config.Save(o.Paths, cfg, priv); err != nil {
			return config.Config{}, "", fmt.Errorf("saving the pairing: %w", err)
		}
		if res.Repaired {
			return cfg, fmt.Sprintf("re-paired as %q — its name and history kept", res.Name), nil
		}
		return cfg, fmt.Sprintf("paired as %q", res.Name), nil
	}
	return config.Config{}, "", fmt.Errorf("could not pair: %w", lastErr)
}
