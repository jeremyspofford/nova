package caps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"novad/internal/admin"
)

// admin.install / admin.uninstall (S30b T4): Nova sets up and removes this
// machine's standing admin path through her own tool. The agent picks how
// to elevate the installer from what it reads (pickInstallRoute), runs it,
// and answers ok only for what its own unelevated read-back proves: the
// path reads installed and an elevated `admin whoami` through it answers
// root / elevated. Uninstall goes through the path and is ok only when
// nothing of it is left. Every decision is here, OS-neutral, over
// AdminHost; admin_install_unix.go / admin_install_windows.go build the
// real one.

// NoAdminPath is the stated cannot when this machine has no admin path
// (core restates it as "no admin path on <machine>").
const NoAdminPath = noAdminPath

// How admin.install elevates the installer.
const (
	routeDirect = "direct" // this agent is already root / elevated
	routePath   = "path"   // through the admin path already here
	routeSudoN  = "sudo -n"
	routeUAC    = "uac" // the owner's one UAC click
)

// UACWait bounds the WHOLE UAC prompt on the owner's screen — the
// ShellExecuteEx call that shows it, not only the process after a Yes —
// and ReadBackReserve is the time kept after it for the read-back. Their
// sum sits under client.CommandTimeout (pinned in client's tests), so the
// agent's answer reaches core before core stops waiting.
const (
	UACWait         = 60 * time.Second
	ReadBackReserve = 40 * time.Second
)

// ErrNoYes is the UAC route's answer when no Yes came: the prompt was
// cancelled (a No, or Windows closing it — the agent cannot tell which)
// or the wait ran out. Errors carrying it are *NoYesError.
var ErrNoYes = errors.New("no Yes came on the UAC prompt")

// NoYesError says how long the agent waited and whether the prompt may
// still be on the screen (the wait ran out; a later Yes still installs).
type NoYesError struct {
	Wait     time.Duration
	MayStill bool
}

func (e *NoYesError) Error() string {
	return fmt.Sprintf("no Yes came on the UAC prompt within %d s", int(e.Wait/time.Second))
}

func (e *NoYesError) Is(t error) bool { return t == ErrNoYes }

// errPromptCancelled is what a prompt func returns for ERROR_CANCELLED.
var errPromptCancelled = errors.New("the UAC prompt was cancelled")

// awaitYes runs prompt — the call that shows the UAC prompt and returns
// once it is answered (ShellExecuteEx with SEE_MASK_NOASYNC blocks until a
// click, or until Windows closes the prompt at about 2 min) — and waits at
// most wait for it, never past ctx. A cancelled prompt (errPromptCancelled)
// is a *NoYesError; the wait running out is one too, MayStill, because the
// prompt cannot be taken down from here: the call is abandoned, and if a
// Yes comes later its value goes to drop (nil: nothing to release).
func awaitYes[T any](ctx context.Context, wait time.Duration, prompt func() (T, error), drop func(T)) (T, error) {
	type answer struct {
		v   T
		err error
	}
	got := make(chan answer, 1)
	go func() {
		v, err := prompt()
		got <- answer{v, err}
	}()
	start := time.Now()
	timer := time.NewTimer(wait)
	defer timer.Stop()
	var zero T
	waited := wait
	select {
	case a := <-got:
		if errors.Is(a.err, errPromptCancelled) {
			return zero, &NoYesError{Wait: wait}
		}
		return a.v, a.err
	case <-timer.C:
	case <-ctx.Done():
		waited = time.Since(start)
	}
	go func() {
		if a := <-got; a.err == nil && drop != nil {
			drop(a.v)
		}
	}()
	return zero, &NoYesError{Wait: waited, MayStill: true}
}

// noYesWords is admin.install's answer when no Yes came: what the agent
// knows (it waited, no Yes) and what it read right after — never a cause.
func noYesWords(ny *NoYesError, st admin.PathState) string {
	s := fmt.Sprintf("no Yes came on this machine's UAC prompt within %d s (it was declined, closed, or nobody answered) — ",
		int(ny.Wait.Round(time.Second)/time.Second))
	if st.Installed {
		return s + "the admin path reads " + st.State + " now, so a Yes may have come as the wait ran out; device_info reads whether it did"
	}
	s += "nothing was installed: the admin path reads " + st.State + " now"
	s += fmt.Sprintf("; the owner clicks Yes on the prompt within %d s when Nova asks again", int(UACWait/time.Second))
	if ny.MayStill {
		s += "; the prompt may still be on the screen — a Yes there now still installs it; device_info reads whether it did"
	}
	return s
}

// AdminHost is what admin.install / admin.uninstall read and do on this
// machine (the seam). Nil AdminDeps.Host is the real machine.
type AdminHost struct {
	Windows  bool
	Elevated bool   // euid 0 / an elevated token
	SignedIn bool   // windows: an interactive session to show a UAC prompt in
	Bin      string // this agent's own binary: what installs the path
	User     string // unix: the agent's user, the one the rule names

	// SudoN answers whether `sudo -n true` runs without a password (unix).
	SudoN func(ctx context.Context) bool
	// Read is the admin path as read now (admin.ReadPath).
	Read func(ctx context.Context) admin.PathState
	// Install / Uninstall run `<Bin> admin install|uninstall` by route and
	// return its words; Install returns a *NoYesError (ErrNoYes) when no Yes came.
	Install   func(ctx context.Context, route string) (string, error)
	Uninstall func(ctx context.Context, route string) (string, error)
	// Whoami runs `<copy> admin whoami` through the path: its stdout.
	Whoami func(ctx context.Context) (string, error)

	// Settle is how long uninstall's read-back keeps reading for the path
	// to be gone (the windows runner removes its own leftovers as it
	// exits); Poll its interval. 0 = one read.
	Settle time.Duration
	Poll   time.Duration
}

// installReads is what pickInstallRoute decides from.
type installReads struct {
	Windows, Elevated, Installed, SudoN, SignedIn bool
	Bin, User                                     string
}

// pickInstallRoute is admin.install's route from what was read, or the
// stated cannot naming the owner's one step.
func pickInstallRoute(r installReads) (route, cannot string) {
	switch {
	case r.Elevated:
		return routeDirect, ""
	case r.Installed:
		return routePath, ""
	case !r.Windows && r.SudoN:
		return routeSudoN, ""
	case !r.Windows:
		return "", "cannot: installing the admin path needs root once and sudo here asks for a password — " +
			"the owner runs this once on this machine: sudo '" + r.Bin + "' admin install --user " + r.User
	case r.SignedIn:
		return routeUAC, ""
	}
	return "", "cannot: nobody is signed in on this machine to answer the UAC prompt — " +
		"the owner signs in at its screen, then clicks Yes on the one UAC prompt"
}

// uacWait is how long the UAC route waits for the owner's click:
// UACWait, less when ctx leaves less than that plus ReadBackReserve;
// too little time left is a stated cannot.
func uacWait(ctx context.Context) (time.Duration, error) {
	w := UACWait
	if dl, ok := ctx.Deadline(); ok {
		if left := time.Until(dl) - ReadBackReserve; left < w {
			w = left
		}
	}
	if w < 10*time.Second {
		return 0, errors.New("cannot: too little of this call's time is left to wait for the UAC prompt and read the install back")
	}
	return w, nil
}

// installVerdict judges the read-back after an install: the path read
// installed, and the whoami round trip through it answered root (unix:
// {"euid":0}) or elevated (windows: admin.WhoamiReport). Its words are the
// proof, or what was read.
func installVerdict(windows bool, st admin.PathState, whoami string, whoErr error) (bool, string) {
	if !st.Installed {
		said := "the admin path does not read back as installed: it reads " + st.State
		if st.Said != "" {
			said += " (" + st.Said + ")"
		}
		return false, said
	}
	if whoErr != nil {
		return false, "the elevated round trip through the path failed: " + whoErr.Error()
	}
	if windows {
		r, err := admin.ParseWhoami(whoami)
		switch {
		case err != nil:
			return false, "the elevated round trip through the path: " + err.Error()
		case !r.Elevated:
			who := r.User
			if who == "" {
				who = "an unnamed user"
			}
			return false, "the elevated round trip through the path ran as " + who + ", not elevated"
		}
		return true, fmt.Sprintf("an elevated round trip through the path ran as %s, elevated (integrity %s)", r.User, r.Integrity)
	}
	var u struct {
		Euid *int   `json:"euid"`
		User string `json:"user"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(whoami)), &u); err != nil || u.Euid == nil {
		return false, fmt.Sprintf("the elevated round trip through the path said %q, not a report", strings.TrimSpace(whoami))
	}
	if *u.Euid != 0 {
		return false, fmt.Sprintf("the elevated round trip through the path ran as euid %d (%s), not root", *u.Euid, u.User)
	}
	return true, "an elevated round trip through the path ran as root (euid 0)"
}

// uninstallVerdict: ok only when nothing of the path is left. A moved-aside
// agent copy (windows, through the path) is not a part left — the task,
// request directory and protected copy are proven gone — but it is still
// on disk until the next restart, so the words say exactly that, by path,
// and never "nothing of it is left".
func uninstallVerdict(left, pending []string) (bool, string) {
	switch {
	case len(left) > 0:
		return false, "the admin path was not removed: " + strings.Join(left, " and ") + " still there"
	case len(pending) > 0:
		return true, "the admin path is removed: " + admin.LeftTask + ", " + admin.LeftRequestDir + " and " + admin.LeftCopyDir +
			" are gone; " + admin.PendingWords(pending)
	}
	return true, "the admin path is removed: nothing of it is left"
}

func adminInstall(ctx context.Context, r Request) Outcome {
	h, err := adminHostFor(r.Deps)
	if err != nil {
		return fail("%v", err)
	}
	return installAdminPath(ctx, h, r.Deps.SendFacts)
}

func adminUninstall(ctx context.Context, r Request) Outcome {
	h, err := adminHostFor(r.Deps)
	if err != nil {
		return fail("%v", err)
	}
	return uninstallAdminPath(ctx, h, r.Deps.SendFacts)
}

func adminHostFor(d Deps) (AdminHost, error) {
	if d.Admin != nil && d.Admin.Host != nil {
		return *d.Admin.Host, nil
	}
	return realAdminHost(d)
}

// installAdminPath is admin.install over h: route, run, read back, send
// fresh facts, answer.
func installAdminPath(ctx context.Context, h AdminHost, sendFacts func(context.Context) error) Outcome {
	before := h.Read(ctx)
	reads := installReads{Windows: h.Windows, Elevated: h.Elevated, Installed: before.Installed, SignedIn: h.SignedIn, Bin: h.Bin, User: h.User}
	if !h.Windows && !h.Elevated && !before.Installed && h.SudoN != nil {
		reads.SudoN = h.SudoN(ctx)
	}
	route, cannot := pickInstallRoute(reads)
	if cannot != "" {
		return fail("%s", cannot)
	}
	words, err := h.Install(ctx, route)
	var ny *NoYesError
	switch {
	case errors.As(err, &ny):
		return fail("%s", noYesWords(ny, h.Read(ctx)))
	case errors.Is(err, ErrNoYes):
		return fail("%s", noYesWords(&NoYesError{Wait: UACWait}, h.Read(ctx)))
	case err != nil:
		return fail("the admin install (%s) did not finish: %v", routeWords(route), err)
	}
	after := h.Read(ctx)
	var who string
	var whoErr error
	if after.Installed {
		who, whoErr = h.Whoami(ctx)
	}
	ok, proof := installVerdict(h.Windows, after, who, whoErr)
	note := factsNote(ctx, sendFacts)
	if !ok {
		if w := strings.TrimSpace(words); w != "" {
			proof += "; the installer said: " + firstLine(w)
		}
		return fail("%s%s", proof, note)
	}
	out := ok0(fmt.Sprintf("admin path installed (%s) %s; proven: %s%s", kindWords(after.Kind), routeWords(route), proof, note))
	out.Meta = map[string]any{"installed": true, "kind": after.Kind, "route": route, "proof": proof}
	return out
}

// routeWords says how the installer ran.
func routeWords(route string) string {
	switch route {
	case routeDirect:
		return "by this agent, already elevated"
	case routePath:
		return "through the admin path already here"
	case routeSudoN:
		return "through sudo -n, with no prompt"
	case routeUAC:
		return "after the owner's Yes on the UAC prompt"
	}
	return route
}

func kindWords(kind string) string {
	switch kind {
	case admin.KindSudoers:
		return "a sudoers rule"
	case admin.KindTask:
		return "an elevated scheduled task"
	}
	return kind
}

// factsNote sends fresh facts (when there is a connection to send them on)
// and is "" — or says they could not be sent.
func factsNote(ctx context.Context, sendFacts func(context.Context) error) string {
	if sendFacts == nil {
		return ""
	}
	if err := sendFacts(ctx); err != nil {
		return "; the fresh facts could not be sent: " + err.Error()
	}
	return ""
}

func firstLine(s string) string {
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

// uninstallAdminPath is admin.uninstall over h.
func uninstallAdminPath(ctx context.Context, h AdminHost, sendFacts func(context.Context) error) Outcome {
	before := h.Read(ctx)
	route := routePath
	switch {
	case !before.Installed && len(before.Left) == 0:
		// Nothing there: never a "removed" for what was never there.
		return fail("%s", noAdminPath)
	case h.Elevated:
		route = routeDirect
	case !before.Installed:
		return fail("%s — %s is still there, and only an elevated `%s admin uninstall` removes it", noAdminPath, strings.Join(before.Left, " and "), h.Bin)
	}
	words, runErr := h.Uninstall(ctx, route)
	after := h.Read(ctx)
	deadline := time.Now().Add(h.Settle)
	for len(after.Left) > 0 && time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			deadline = time.Now()
			continue
		case <-time.After(h.Poll):
		}
		after = h.Read(ctx)
	}
	ok, said := uninstallVerdict(after.Left, after.Pending)
	note := factsNote(ctx, sendFacts)
	if !ok {
		switch {
		case runErr != nil:
			said += "; the uninstall said: " + firstLine(runErr.Error())
		case strings.TrimSpace(words) != "":
			said += "; the uninstall said: " + firstLine(words)
		}
		return fail("%s%s", said, note)
	}
	out := ok0(fmt.Sprintf("%s (%s)%s", said, routeWords(route), note))
	out.Meta = map[string]any{"installed": false, "kind": admin.KindNone, "route": route}
	if len(after.Pending) > 0 {
		out.Meta["pending_restart"] = after.Pending
	}
	return out
}
