package caps

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"novad/internal/box"
)

// box.* run a change's sealed box (S32.2, spec §4). Core sends only the
// shape inputs D3 allows — argv, cwd, change, checkout, branch, limits —
// and the box package derives every path, mount and flag from them. A box
// that cannot start is a stated cannot; box.exec never falls back to the
// host.

const noBoxManager = "cannot: no box manager on this agent"

// boxRequest reads the shape inputs as the wire sends them (numbers are
// json.Number) and refuses at the edge through box.Validate. cwd defaults to
// the change's worktree when needCwd is false and none was sent.
func boxRequest(capability string, args map[string]any, needCwd bool) (box.Request, error) {
	var req box.Request
	for _, f := range []struct {
		key string
		dst *string
	}{{"change", &req.Change}, {"checkout", &req.Checkout}, {"branch", &req.Branch}, {"cwd", &req.Cwd}} {
		v, present := args[f.key]
		if !present && f.key == "cwd" && !needCwd {
			continue
		}
		s, ok := v.(string)
		if !ok {
			return req, fmt.Errorf("%s needs a string '%s', got %T", capability, f.key, v)
		}
		*f.dst = s
	}
	if req.Cwd == "" && !needCwd {
		req.Cwd = box.Worktree(req.Checkout, req.Change)
	}
	lim, ok := args["limits"].(map[string]any)
	if !ok {
		return req, fmt.Errorf("%s needs a 'limits' object, got %T", capability, args["limits"])
	}
	for _, f := range []struct {
		key string
		dst *int
	}{{"cpus", &req.Limits.CPUs}, {"memory_gb", &req.Limits.MemoryGB}, {"pids", &req.Limits.Pids}, {"max_running", &req.Limits.MaxRunning}} {
		n, ok := numberArg(lim[f.key])
		if !ok || math.IsNaN(n) || n != math.Trunc(n) || n < 0 || n > 1<<31 {
			return req, fmt.Errorf("%s 'limits.%s' must be a whole number, got %v", capability, f.key, lim[f.key])
		}
		*f.dst = int(n)
	}
	if err := box.Validate(req); err != nil {
		return req, fmt.Errorf("%s: %v", capability, err)
	}
	return req, nil
}

func argvArg(capability string, args map[string]any) ([]string, error) {
	raw, ok := args["argv"].([]any)
	if !ok || len(raw) == 0 {
		return nil, fmt.Errorf("%s needs a non-empty 'argv' array", capability)
	}
	argv := make([]string, 0, len(raw))
	for i, v := range raw {
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("%s argv[%d] is not a string", capability, i)
		}
		argv = append(argv, s)
	}
	return argv, nil
}

// boxExec brings the change's box up and runs argv inside it, as the owner,
// in cwd — through runArgv, so the output cap, the ok/exit seam and the
// timeout words are shell.exec's. Ensure failing is ok:false and nothing runs.
func boxExec(ctx context.Context, r Request) Outcome {
	m := r.Deps.Box
	if m == nil {
		return fail(noBoxManager)
	}
	argv, err := argvArg("box.exec", r.Args)
	if err != nil {
		return fail("%v; nothing was run", err)
	}
	req, err := boxRequest("box.exec", r.Args, true)
	if err != nil {
		return fail("%v; nothing was run", err)
	}
	opts, err := readCallOptions("box.exec", r.Args)
	if err != nil {
		return fail("%v; nothing was run", err)
	}
	// timeout_s bounds the whole call — bring-up, CPU lock and run — since
	// core waits timeout_s + 10 s for the answer to all of it.
	ctx, cancel := opts.bound(ctx)
	defer cancel()
	// Heavy is read from the branch's committed suites.toml (D6) before
	// anything starts: unreadable means we cannot say whether to lock, and
	// guessing "light" would run a full suite beside another one.
	suites, err := m.LoadSuites(ctx, req.Checkout, req.Branch)
	if err != nil {
		return fail("box.exec: cannot tell whether this is a whole suite: %v — nothing was run", err)
	}
	heavy := box.Heavy(suites, argv, worktreeRel(req))
	st, err := m.Ensure(ctx, req)
	if err != nil {
		return fail("cannot start the box %s: %v — nothing was run", box.Names(req.Change).Box, err)
	}
	var waited time.Duration
	if heavy {
		release, w, err := box.CPULock{Path: box.LockPath(req.Checkout), Margin: box.LockMargin}.Acquire(ctx)
		if err != nil {
			return fail("%v — nothing was run", err)
		}
		defer release()
		waited = w
	}
	// env crosses by name (-e NAME); each value sits in the docker client's
	// environment only, never in an argv.
	full := m.ExecArgvEnv(req, opts.keys, argv)
	// The host side runs docker from the agent's own directory: the cwd is
	// inside the box (-w), never the host process's.
	out := runArgvEnv(ctx, full, "", opts.env)
	// A long run counts its idle time from its end (T7).
	m.Touch(req.Change)
	secs := int(waited / time.Second)
	if secs > 0 {
		out.Output = fmt.Sprintf("waited %ds for the CPU lock\n", secs) + out.Output
	}
	out.Meta = opts.echo(map[string]any{"ran_in": "box", "box": st.Box, "image": st.Image, "heavy": heavy, "lock_waited_s": secs})
	return out
}

// worktreeRel is req.Cwd relative to the change's worktree ("." for the
// worktree itself); Validate has already held cwd inside it.
func worktreeRel(req box.Request) string {
	wt := box.Worktree(req.Checkout, req.Change)
	if req.Cwd == wt {
		return "."
	}
	return strings.TrimPrefix(req.Cwd, wt+"/")
}

// boxStart brings the change's box up and runs nothing in it.
func boxStart(ctx context.Context, r Request) Outcome {
	m := r.Deps.Box
	if m == nil {
		return fail(noBoxManager)
	}
	req, err := boxRequest("box.start", r.Args, false)
	if err != nil {
		return fail("%v", err)
	}
	st, err := m.Ensure(ctx, req)
	if err != nil {
		return fail("cannot start the box %s: %v", box.Names(req.Change).Box, err)
	}
	out := ok0(fmt.Sprintf("%s %s (image %s)", st.Box, st.Status, st.Image))
	out.Meta = map[string]any{"box": st.Box, "state": st.Status, "image": st.Image}
	return out
}

// boxStatus is every box's state by change id.
func boxStatus(ctx context.Context, r Request) Outcome {
	m := r.Deps.Box
	if m == nil {
		return fail(noBoxManager)
	}
	boxes, err := m.Status(ctx)
	if err != nil {
		return fail("cannot read the boxes: %v", err)
	}
	ids := make([]string, 0, len(boxes))
	for id := range boxes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	lines := make([]string, len(ids))
	for i, id := range ids {
		lines[i] = box.Names(id).Box + " " + boxes[id]
	}
	text := strings.Join(lines, "\n")
	if text == "" {
		text = "no boxes"
	}
	out := ok0(text)
	out.Meta = map[string]any{"boxes": boxes}
	return out
}

// boxRemove takes a change's box down — box, its Postgres, network and
// dependency cache — for a landing's close and close_change (S32.3 T7). Only
// the change id crosses the wire: Manager.Remove derives every name from it,
// so no path or name she sends can reach docker. What is already gone is
// skipped; a docker refusal is stated and nothing claims removed.
func boxRemove(ctx context.Context, r Request) Outcome {
	m := r.Deps.Box
	if m == nil {
		return fail(noBoxManager)
	}
	change, ok := r.Args["change"].(string)
	if !ok {
		return fail("box.remove needs a string 'change', got %T; nothing was removed", r.Args["change"])
	}
	if !box.ValidChange(change) {
		return fail("box.remove: change %q is not a change id (6 lowercase hex); nothing was removed", change)
	}
	name := box.Names(change).Box
	if err := m.Remove(ctx, change); err != nil {
		return fail("cannot remove the box %s: %v", name, err)
	}
	out := ok0(name + " removed: its box, database, network and dependency cache (any already gone were skipped)")
	out.Meta = map[string]any{"box": name, "removed": true}
	return out
}

// boxStop stops a change's running box and its Postgres (S38c T4): a
// landing's judge takes the slot its own change's idle box holds. Only the
// change id crosses the wire, as for box.remove. A box not running is ok with
// stopped false; a box running a live job is refused naming the job, and
// nothing claims stopped. The next box command starts it again (Ensure).
func boxStop(ctx context.Context, r Request) Outcome {
	m := r.Deps.Box
	if m == nil {
		return fail(noBoxManager)
	}
	change, ok := r.Args["change"].(string)
	if !ok {
		return fail("box.stop needs a string 'change', got %T; nothing was stopped", r.Args["change"])
	}
	if !box.ValidChange(change) {
		return fail("box.stop: change %q is not a change id (6 lowercase hex); nothing was stopped", change)
	}
	name := box.Names(change).Box
	stopped, err := m.Stop(ctx, change)
	if errors.Is(err, box.ErrBusy) {
		return fail("cannot stop the box %s: %s — stop it with job.stop or wait for it; nothing was stopped", name, liveJobWords(r, change))
	}
	if err != nil {
		return fail("cannot stop the box %s: %v", name, err)
	}
	text := name + " was not running; nothing was stopped"
	if stopped {
		text = name + " stopped; it starts again on the next box command"
	}
	out := ok0(text)
	out.Meta = map[string]any{"box": name, "stopped": stopped}
	return out
}

// liveJobWords names the change's live box jobs from the job store ("it runs
// live job <id>"); with no store, or one that cannot be read, the refusal
// still stands as "it runs a live job". The ids come in the store's order
// (newest first, as job.list).
func liveJobWords(r Request, change string) string {
	jd, ok := jobsOf(r)
	if !ok {
		return box.ErrBusy.Error()
	}
	all, err := jd.Store.List()
	if err != nil {
		return box.ErrBusy.Error()
	}
	var ids []string
	for _, j := range all {
		if j.Spec.Box != nil && j.Spec.Box.Change == change && !j.Status.Terminal() {
			ids = append(ids, j.Spec.ID)
		}
	}
	switch len(ids) {
	case 0:
		return box.ErrBusy.Error()
	case 1:
		return "it runs live job " + ids[0]
	}
	return "it runs live jobs " + strings.Join(ids, ", ")
}
