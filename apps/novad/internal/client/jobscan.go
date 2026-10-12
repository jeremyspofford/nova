package client

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/coder/websocket"

	"novad/internal/jobs"
	"novad/internal/wire"
)

// JobScanEvery is how often a connected agent scans its jobs (S30c): a job
// that ends mid-session is reported within it.
const JobScanEvery = 5 * time.Second

// JobEndCapability is the audit capability of a job's one terminal entry.
const JobEndCapability = "job.end"

// jobFrame is the job frame for one job's record.
func jobFrame(j jobs.Job) wire.Job {
	return wire.Job{
		Type:      wire.TypeJob,
		JobID:     j.Spec.ID,
		State:     j.Status.State,
		ExitCode:  j.Status.ExitCode,
		StartedAt: utc(j.Status.StartedAt),
		EndedAt:   utc(j.Status.EndedAt),
		LogBytes:  j.Status.LogBytes,
		Reason:    j.Status.Reason,
	}
}

func utc(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

// jobEndSummary is the job.end entry's summary; the chain is searched by
// its "job <id> " prefix.
func jobEndSummary(j jobs.Job) string {
	if j.Status.ExitCode == nil {
		return fmt.Sprintf("job %s %s, no exit code", j.Spec.ID, j.Status.State)
	}
	return fmt.Sprintf("job %s %s exit %d", j.Spec.ID, j.Status.State, *j.Status.ExitCode)
}

// jobScanner scans at once — the session's start, after the audit replay —
// then every jobScanEvery until the session ends. sent is this session's:
// each terminal, unacked job's frame goes once per session, and every new
// session sends it again until core acks it.
func (a *Agent) jobScanner(ctx context.Context, c *websocket.Conn) {
	sent := map[string]bool{}
	a.scanJobs(ctx, c, sent)
	ticker := time.NewTicker(a.jobScanEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		a.scanJobs(ctx, c, sent)
	}
}

// scanJobs is one pass over the job store: a live job whose wrapper is gone
// is written lost (jobs.Store.CheckWrapper); every terminal job gets its ONE
// job.end audit entry — appended through the agent's own chain, the only
// writer of audit.jsonl, then marked `audited` — and, until core acks it,
// its job frame. jobScanMu makes one pass at a time, so no two passes
// audit a job twice; a crash between an append and its mark is caught by
// reading the chain before appending.
func (a *Agent) scanJobs(ctx context.Context, c *websocket.Conn, sent map[string]bool) {
	if a.opts.StateDir == "" {
		return
	}
	a.jobScanMu.Lock()
	defer a.jobScanMu.Unlock()
	store := jobs.NewStore(a.opts.StateDir)
	all, bad, err := store.ListAll()
	if err != nil {
		a.jobScanFailed(fmt.Sprintf("job scan: cannot read the jobs: %v", err))
		return
	}
	a.jobScanErr = ""
	a.jobScanUnreadable(bad)

	var boot time.Time
	bootRead := false
	var inChain map[string]bool // job ids with a job.end entry already, read once per pass when needed
	for _, j := range all {
		if !j.Status.Terminal() {
			// running, waiting_lock, or no record yet: CheckWrapper judges.
			if !bootRead {
				bootRead = true
				if b, err := a.bootTime(); err != nil {
					a.logf("job scan: this machine's boot time is unreadable (%v); a live wrapper pid is taken as the job's", err)
				} else {
					boot = b
				}
			}
			nj, wrote, err := store.CheckWrapper(j, a.jobAlive, boot, a.now())
			if err != nil {
				a.logf("job scan: job %s: %v", j.Spec.ID, err)
				continue
			}
			if wrote {
				a.logf("job %s is lost: %s", j.Spec.ID, nj.Status.Reason)
			}
			j = nj
			if !j.Status.Terminal() {
				continue
			}
		}
		id := j.Spec.ID
		if !store.Marked(id, jobs.MarkerAudited) {
			if inChain == nil {
				inChain, err = a.jobEndsInChain()
				if err != nil {
					a.logf("job scan: cannot read the audit chain: %v; no job.end appended this pass", err)
					inChain = nil
					continue
				}
			}
			if !inChain[id] {
				if !a.auditJobEnd(ctx, c, j) {
					continue
				}
				inChain[id] = true
			}
			if err := store.Mark(id, jobs.MarkerAudited); err != nil {
				a.logf("job scan: job %s: its entry is in the chain but the marker could not be written: %v", id, err)
			}
		}
		if sent[id] || store.Marked(id, jobs.MarkerAcked) {
			continue
		}
		wctx, cancel := context.WithTimeout(ctx, a.pingTimeout)
		err := writeFrame(wctx, c, jobFrame(j))
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				a.logf("job frame for %s not sent: %v", id, err)
			}
			return
		}
		sent[id] = true
	}
}

// auditJobEnd appends the job's one job.end entry and sends it in an audit
// frame. A frame that is not sent is replayed from the chain on reconnect;
// false only when the append itself failed.
func (a *Agent) auditJobEnd(ctx context.Context, c *websocket.Conn, j jobs.Job) bool {
	entry, err := a.audit.Append(a.now().Unix(), j.Spec.EnvelopeID, JobEndCapability, truncate(jobEndSummary(j), 300), j.Status.State == jobs.StateDone, j.Status.ExitCode)
	if err != nil {
		a.logf("job scan: job %s: audit append failed: %v", j.Spec.ID, err)
		return false
	}
	wctx, cancel := context.WithTimeout(ctx, a.pingTimeout)
	defer cancel()
	if err := writeFrame(wctx, c, auditFrame{Type: wire.TypeAudit, Entries: []map[string]any{entry}}); err != nil && ctx.Err() == nil {
		a.logf("audit write failed for job %s: %v", j.Spec.ID, err)
	}
	return true
}

// jobEndsInChain is the ids of the jobs that already have a job.end entry.
func (a *Agent) jobEndsInChain() (map[string]bool, error) {
	entries, err := a.audit.EntriesAfter(-1)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, e := range entries {
		if e["capability"] != JobEndCapability {
			continue
		}
		s, _ := e["summary"].(string)
		if f := strings.Fields(s); len(f) >= 2 && f[0] == "job" {
			out[f[1]] = true
		}
	}
	return out, nil
}

// jobScanUnreadable logs each unreadable job once per distinct error (the
// scan goes on with the rest) and forgets the ids that read again.
func (a *Agent) jobScanUnreadable(bad []jobs.BadJob) {
	now := map[string]string{}
	for _, b := range bad {
		msg := b.Err.Error()
		now[b.ID] = msg
		if a.jobScanBad[b.ID] != msg {
			a.logf("job scan: job %s is unreadable (%s); scanning the rest", b.ID, msg)
		}
	}
	a.jobScanBad = now
}

func (a *Agent) jobScanFailed(msg string) {
	if msg != a.jobScanErr {
		a.logf("%s", msg)
		a.jobScanErr = msg
	}
}

// handleJobAck is core's word that it stored a job's terminal frame: the
// job is marked `acked` and no later session sends it. An ack that names
// no job here, a malformed id, or a job not yet ended marks nothing — the
// job's frame still goes when it ends. It runs on the reader without the
// scan lock: a scan stuck on a write must not stop the reader.
func (a *Agent) handleJobAck(frame map[string]any) {
	id, _ := frame["job_id"].(string)
	if a.opts.StateDir == "" {
		a.logf("core acked job %q, but this agent keeps no jobs", id)
		return
	}
	store := jobs.NewStore(a.opts.StateDir)
	j, err := store.Get(id)
	switch {
	case errors.Is(err, jobs.ErrNoJob):
		a.logf("core acked job %q, which this device has no record of; nothing marked", id)
		return
	case err != nil:
		a.logf("core acked job %q: %v; nothing marked", id, err)
		return
	case !j.Status.Terminal():
		a.logf("core acked job %q, which has not ended (state %q); nothing marked", id, j.Status.State)
		return
	}
	if err := store.Mark(id, jobs.MarkerAcked); err != nil {
		a.logf("core acked job %q, but the marker could not be written: %v", id, err)
	}
}
