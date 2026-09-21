package main

// `novad repoint` — point this device at a hub that moved (design-verdict §11).
//
// A hub move changes ONE thing in the enrolment: the URL. Core's ed25519
// signing key travels inside the backup bundle, so the key this device pinned
// at enrolment is still the right key on the new machine — which is exactly
// why repoint can prove the new URL before writing it. `repoint` is therefore
// "change the URL, after proving the new URL is the same Nova", and nothing
// else: it never re-keys, never re-enrolls, and never restarts the daemon.
//
// What it refuses to do is as load-bearing as what it does. Every failure path
// leaves the config byte-for-byte untouched, and `--check` writes nothing even
// when the proof succeeds — so the runbook can ask "is this the same Nova?"
// without committing to the answer.

import (
	"context"
	"crypto/ed25519"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"novad/internal/client"
	"novad/internal/config"
)

func cmdRepoint(argv []string) {
	fs := flag.NewFlagSet("repoint", flag.ExitOnError)
	server := fs.String("server", "", "the hub's new URL, e.g. https://nova.example")
	check := fs.Bool("check", false, "prove the new URL and print the verdict; write nothing")
	_ = fs.Parse(argv)

	paths, err := config.DefaultPaths()
	if err != nil {
		fail("%v", err)
	}
	if err := repoint(paths, *server, *check, os.Stdout); err != nil {
		fail("%s", err)
	}
}

// repoint is the whole verb, with its custody and its output injected so the
// suite can walk it end to end against a fake core and then READ THE CONFIG
// BACK — "a reply is a claim" applies to this command's own success line too.
func repoint(paths config.Paths, server string, check bool, out io.Writer) error {
	// 1. enrolment, and a key that is really a key.
	if server == "" {
		return errors.New("repoint needs --server")
	}
	if !paths.Enrolled() {
		return fmt.Errorf("not enrolled — run `novad enroll` first (nothing at %s)", paths.ConfigFile)
	}
	cfg, priv, err := config.Load(paths)
	if err != nil {
		return err
	}

	// 2. the scheme, before anything is dialled.
	candidate := cfg
	candidate.Server = strings.TrimRight(server, "/")
	if _, err := client.WSURL(candidate.Server); err != nil {
		return err
	}

	// 3-5. dial, refuse a core key that is not the pinned one, and finish the
	// handshake so a server that has forgotten this device fails BEFORE the
	// write rather than after it.
	ctx, cancel := context.WithTimeout(context.Background(), client.VerifyTimeout+5*time.Second)
	defer cancel()
	if err := client.VerifyServer(ctx, candidate, priv); err != nil {
		var mismatch *client.KeyMismatch
		if errors.As(err, &mismatch) {
			return fmt.Errorf("%s. Re-enroll if you meant to pair with a different Nova", err)
		}
		return err
	}

	// 6. --check prints the verdict and stops. It writes nothing, ever.
	if check {
		fmt.Fprintf(out, "%s is the Nova you paired with, and it knows this device.\n", candidate.Server)
		fmt.Fprintf(out, "nothing was written: %s still points at %s\n", paths.ConfigFile, cfg.Server)
		fmt.Fprintf(out, "repoint it with:\n  novad repoint --server %s\n", candidate.Server)
		return nil
	}

	// 7. save, then RE-READ and compare. A save that cannot verify itself is a
	// failure, not a success with a caveat.
	old := cfg.Server
	saved := cfg
	saved.Server = candidate.Server
	if err := config.Save(paths, saved, priv); err != nil {
		return fmt.Errorf("could not write %s: %w (the enrolment still points at %s)", paths.ConfigFile, err, old)
	}
	back, backPriv, err := config.Load(paths)
	if err != nil {
		return fmt.Errorf("%s was written but could not be read back: %w", paths.ConfigFile, err)
	}
	if back.Server != candidate.Server {
		return fmt.Errorf("%s did not read back as written: server is %q, wanted %q — the enrolment was NOT repointed",
			paths.ConfigFile, back.Server, candidate.Server)
	}
	if back.CorePubKey != cfg.CorePubKey {
		return fmt.Errorf("%s read back a DIFFERENT pinned core key (%s…, was %s…) — the enrolment was NOT repointed",
			paths.ConfigFile, shortKey(back.CorePubKey), shortKey(cfg.CorePubKey))
	}
	if !ed25519.PublicKey(backPriv.Public().(ed25519.PublicKey)).Equal(priv.Public()) {
		return fmt.Errorf("%s read back a DIFFERENT device key — the enrolment was NOT repointed", paths.KeyFile)
	}

	// 8. Say what changed and what the operator has to do. It restarts nothing
	// and never claims the daemon reconnected — that is `novad status`'s job.
	fmt.Fprintf(out, "repointed: %s -> %s\n", old, back.Server)
	fmt.Fprintf(out, "config:    %s (read back and compared)\n", paths.ConfigFile)
	fmt.Fprintf(out, "core key:  %s… (unchanged — the same Nova, on a new machine)\n", shortKey(back.CorePubKey))
	fmt.Fprintf(out, "\na running daemon still holds the OLD url; restart it to pick this up:\n")
	fmt.Fprintf(out, "  systemctl --user restart novad\n")
	fmt.Fprintf(out, "then `novad status` says whether the new server answers. This command does not\n")
	fmt.Fprintf(out, "claim the daemon reconnected — it only proved the URL and wrote it down.\n")
	return nil
}
