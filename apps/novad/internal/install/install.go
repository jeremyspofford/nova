package install

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"novad/internal/client"
	"novad/internal/config"
	"novad/internal/platform"
	"novad/internal/service"
	"novad/internal/state"
)

// restartDelay is how long RestartLater waits before restarting the service:
// long enough for the command running this install to answer first (P11).
const restartDelay = 5 * time.Second

// defaults gives every zero-valued seam its real implementation — what
// Options promises.
func (o *Options) defaults() {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Verify == nil {
		o.Verify = client.VerifyServer
	}
	if o.Enroll == nil {
		o.Enroll = Enroll
	}
	if o.InWSL == nil {
		o.InWSL = func() bool { in, _ := platform.WSL(); return in }
	}
	if o.Alive == nil {
		o.Alive = platform.ProcessAlive
	}
	if o.Manifest == nil {
		o.Manifest = CheckManifest
	}
	if o.WaitReady == 0 {
		o.WaitReady = 60 * time.Second
	}
	if o.PollEvery == 0 {
		o.PollEvery = 500 * time.Millisecond
	}
	if o.Out == nil {
		o.Out = os.Stdout
	}
}

// Install pairs (or keeps, or re-pairs), places the binary, registers the
// service, starts it and waits for the new agent to say it connected. It
// returns nil only then — or, with RestartLater, once the restart is
// scheduled, saying plainly that nothing is confirmed yet. What identity did
// to this machine's pairing is said whichever way it ends.
func Install(ctx context.Context, o Options) error {
	o.defaults()
	// F2 (P11): --restart-later runs inside the old agent's own shell.exec,
	// and that agent's live, authenticated session is the proof of this
	// pairing. Asking a hub again would open a second socket as the same
	// device, and core would fail the very command running this install.
	if o.RestartLater {
		// A manager that can never schedule the restart says so before a code
		// is spent, the pairing rewritten or anything placed (Task 32, L245).
		if r, ok := o.Service.(service.RestartLaterRefuser); ok {
			if err := r.RestartLaterRefusal(); err != nil {
				return err
			}
		}
		o.TrustPairing = true
	}
	if o.InWSL() {
		return errors.New("cannot: on Windows, Nova's agent runs on Windows itself; run the Windows command in PowerShell, not this one inside WSL")
	}
	if !filepath.IsAbs(o.InstallDir) {
		// The service definition names the binary by this path.
		return fmt.Errorf("install needs an absolute install directory, not %q", o.InstallDir)
	}
	if err := checkHubs(o.Hubs); err != nil {
		return err
	}
	bin := filepath.Join(o.InstallDir, platform.BinaryName)
	if o.IfMissing && o.running(bin) {
		fmt.Fprintf(o.Out, "Nova's agent is installed and running (%s); left as it is — Nova keeps it on the hub's build\n", bin)
		return nil
	}
	cfg, notes, err := o.identity(ctx)
	if err != nil {
		return o.failed(notes, err)
	}
	sum, err := o.place(bin)
	if err != nil {
		return o.failed(notes, err)
	}
	// From here on the new build is in place whatever fails: each failure
	// says so, so none is read as "nothing changed" (Task 32, L244).
	if err := o.Service.Install(bin); err != nil {
		return o.failed(notes, fmt.Errorf("placed %s (build %s), but registering %s failed: %w", bin, o.Version, o.Service.Describe(), err))
	}
	if o.RestartLater {
		if err := o.Service.RestartLater(ctx, restartDelay); err != nil {
			// The build is in place and the definition rewritten: say so, so a
			// failure here is never read as "nothing changed".
			return o.failed(notes, fmt.Errorf("installed %s, but the restart could not be scheduled: %w — the agent running now is unchanged until the service next starts", bin, err))
		}
		fmt.Fprintf(o.Out, "installed %s (build %s, sha256 %s…)\nthe service restarts into it in %d s; this is confirmed only when the agent reconnects reporting %s\n",
			bin, o.Version, sum[:12], int(restartDelay.Seconds()), o.Version)
		o.say(notes)
		return nil
	}
	started := o.Now()
	if err := o.Service.Restart(ctx); err != nil {
		return o.failed(notes, fmt.Errorf("placed %s (build %s) and registered %s, but starting it failed: %w", bin, o.Version, o.Service.Describe(), err))
	}
	_, bootNote, bootErr := o.Service.BootStart(ctx)
	st, err := o.awaitReady(ctx, started)
	if err != nil {
		return o.failed(notes, err)
	}
	build := o.Manifest(ctx, st.Server, cfg.CorePubKey, sum)
	o.report(bin, sum, cfg, st, bootNote, bootErr, notes, build)
	return nil
}

// failed says identity's notes and returns err. A pairing set aside, an old
// audit log moved, a fresh pairing made: each is true on disk whatever step
// failed after it — or before the pairing that was to replace it failed — so
// it is never said only on success.
func (o *Options) failed(notes []string, err error) error {
	o.say(notes)
	return err
}

func (o *Options) say(notes []string) {
	for _, n := range notes {
		fmt.Fprintf(o.Out, "note:       %s\n", n)
	}
}

// running is --if-missing's test: the service is registered, and its
// supervisor and that supervisor's agent are alive and connected.
func (o *Options) running(bin string) bool {
	if !o.Service.Installed() {
		return false
	}
	if _, err := os.Stat(bin); err != nil {
		return false
	}
	var sv state.SupervisorStatus
	var ag state.AgentStatus
	if state.ReadJSON(filepath.Join(o.Paths.StateDir, state.SupervisorStatusFile), &sv) != nil ||
		state.ReadJSON(filepath.Join(o.Paths.StateDir, state.AgentStatusFile), &ag) != nil {
		return false
	}
	return ag.State == state.StateReady && ag.PID == sv.ChildPID && o.Alive(sv.PID) && o.Alive(ag.PID)
}

// awaitReady waits for an agent the restarted supervisor started to write
// "ready" as this version. Anything else — no status, an old build's ready,
// a lock held by a hand-started copy — is a failure with its reason.
func (o *Options) awaitReady(ctx context.Context, started time.Time) (state.AgentStatus, error) {
	agentPath := filepath.Join(o.Paths.StateDir, state.AgentStatusFile)
	supPath := filepath.Join(o.Paths.StateDir, state.SupervisorStatusFile)
	fresh := func(t time.Time) bool { return !t.Before(started.Add(-time.Second)) }
	deadline := o.Now().Add(o.WaitReady)
	var last state.AgentStatus
	for {
		var ag state.AgentStatus
		if state.ReadJSON(agentPath, &ag) == nil && fresh(ag.Since) {
			last = ag
			var sv state.SupervisorStatus
			if ag.State == state.StateReady && ag.Version == o.Version &&
				state.ReadJSON(supPath, &sv) == nil && fresh(sv.Since) && ag.PID == sv.ChildPID {
				return ag, nil
			}
		}
		if !o.Now().Before(deadline) {
			return last, fmt.Errorf("installed and started, but the agent did not connect within %s — %s", o.WaitReady, o.lastSaid(last))
		}
		select {
		case <-ctx.Done():
			// install's own time can run out first — identity()'s retries may
			// have used most of it — and that end says as much (Task 32, L246).
			return last, fmt.Errorf("installed and started, but the wait ended (%w) before the agent connected — %s", ctx.Err(), o.lastSaid(last))
		case <-time.After(o.PollEvery):
		}
	}
}

// lastSaid is what the new agent's status last said, for an error that ends
// the wait: its state, its build when that is not this one, its last error.
func (o *Options) lastSaid(last state.AgentStatus) string {
	if last.PID == 0 {
		return "it has not written a status"
	}
	why := fmt.Sprintf("it last said %q", last.State)
	if last.Version != o.Version {
		why += " as build " + last.Version
	}
	if last.Error != "" {
		why += ": " + last.Error
	}
	return why
}

func (o *Options) report(bin, sum string, cfg config.Config, st state.AgentStatus, bootNote string, bootErr error, notes []string, build string) {
	w := o.Out
	fmt.Fprintf(w, "installed:  %s (build %s, sha256 %s…)\n", bin, o.Version, sum[:12])
	starts := o.Service.Describe()
	switch {
	case bootErr != nil:
		starts += "; whether it starts at boot could not be read: " + bootErr.Error()
	case bootNote != "":
		starts += "; " + bootNote
	}
	fmt.Fprintf(w, "starts:     %s\n", starts)
	fmt.Fprintf(w, "running:    connected to %s as %q since %s (pid %d)\n", st.Server, cfg.Name, st.Since.UTC().Format(time.RFC3339), st.PID)
	if build != "" {
		fmt.Fprintf(w, "build:      %s\n", build)
	}
	o.say(notes)
}
