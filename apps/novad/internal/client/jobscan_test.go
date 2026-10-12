package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"novad/internal/audit"
	"novad/internal/config"
	"novad/internal/jobs"
	"novad/internal/wire"
)

// A fake core for the job scanner: every frame after ready, tagged with
// its session (1, 2, ...). ack answers each job frame with job_ack;
// endAfter, when set, ends a session that long after its ready; first, when
// set, is written to core's side right after ready.
type jobCore struct {
	srv      *httptest.Server
	frames   chan sessFrame
	sessions atomic.Int32
	ack      atomic.Bool
	endAfter time.Duration
	first    []map[string]any
}

type sessFrame struct {
	session int
	f       map[string]any
}

func newJobCore(t *testing.T, corePub, devPub ed25519.PublicKey, ack bool, endAfter time.Duration, first ...map[string]any) *jobCore {
	t.Helper()
	jc := &jobCore{frames: make(chan sessFrame, 1000), endAfter: endAfter, first: first}
	jc.ack.Store(ack)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		if jc.endAfter > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, jc.endAfter)
			defer cancel()
		}
		if fakeCoreHandshake(ctx, c, corePub, devPub) == nil {
			return
		}
		n := int(jc.sessions.Add(1))
		for _, f := range jc.first {
			_ = coreWrite(ctx, c, f)
		}
		for {
			f, err := coreRead(ctx, c)
			if err != nil {
				return
			}
			jc.frames <- sessFrame{n, f}
			if f["type"] == wire.TypeJob && jc.ack.Load() {
				_ = coreWrite(ctx, c, map[string]any{"type": wire.TypeJobAck, "job_id": f["job_id"]})
			}
		}
	})
	jc.srv = httptest.NewServer(mux)
	t.Cleanup(jc.srv.Close)
	return jc
}

// jobFrames drains what arrived within d and returns the job frames (and
// the job.end audit entries seen) per session.
func (jc *jobCore) collect(d time.Duration) (jobsBySession map[int][]map[string]any, ends []map[string]any) {
	jobsBySession = map[int][]map[string]any{}
	deadline := time.After(d)
	for {
		select {
		case sf := <-jc.frames:
			switch sf.f["type"] {
			case wire.TypeJob:
				jobsBySession[sf.session] = append(jobsBySession[sf.session], sf.f)
			case wire.TypeAudit:
				es, _ := sf.f["entries"].([]any)
				for _, e := range es {
					if m, _ := e.(map[string]any); m["capability"] == "job.end" {
						ends = append(ends, m)
					}
				}
			}
		case <-deadline:
			return
		}
	}
}

// waitJobFrame returns the first job frame for id within d.
func (jc *jobCore) waitJobFrame(t *testing.T, id string, d time.Duration) sessFrame {
	t.Helper()
	deadline := time.After(d)
	for {
		select {
		case sf := <-jc.frames:
			if sf.f["type"] == wire.TypeJob && sf.f["job_id"] == id {
				return sf
			}
		case <-deadline:
			t.Fatalf("no job frame for %s within %s", id, d)
		}
	}
}

// jobLogs captures an agent's log lines (box_reap_test's logs is unix-only).
type jobLogs struct {
	mu    sync.Mutex
	lines []string
}

func (l *jobLogs) logf(f string, a ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(f, a...))
}

func (l *jobLogs) matching(s string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for _, x := range l.lines {
		if strings.Contains(x, s) {
			out = append(out, x)
		}
	}
	return out
}

// jobHome is one machine: the device key, its home (audit file + state dir).
type jobHome struct {
	corePub ed25519.PublicKey
	devPub  ed25519.PublicKey
	devPriv ed25519.PrivateKey
	home    string
}

func newJobHome(t *testing.T) *jobHome {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	devPub, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	return &jobHome{corePub: corePub, devPub: devPub, devPriv: devPriv, home: t.TempDir()}
}

func (h *jobHome) stateDir() string  { return filepath.Join(h.home, "state") }
func (h *jobHome) auditPath() string { return filepath.Join(h.home, "audit.jsonl") }
func (h *jobHome) store() *jobs.Store {
	return jobs.NewStore(h.stateDir())
}

// agent is a NEW Agent over this machine's audit file and state dir — the
// way novad starts again after a restart. Scans every 30 ms.
func (h *jobHome) agent(t *testing.T, serverURL string) (*Agent, *audit.Log, *jobLogs) {
	t.Helper()
	log, err := audit.Open(h.auditPath())
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{DeviceID: "dev-jobscan", Name: "itest", Server: serverURL, CorePubKey: hex.EncodeToString(h.corePub)}
	l := &jobLogs{}
	a, err := New(cfg, h.devPriv, log, h.home, "test", l.logf)
	if err != nil {
		t.Fatal(err)
	}
	a.gatherFrame = hermeticFrame
	a.backoffs = []time.Duration{10 * time.Millisecond}
	a.jobScanEvery = 30 * time.Millisecond
	a.jobAlive = func(int) bool { return true }
	a.bootTime = func() (time.Time, error) { return time.Now().Add(-24 * time.Hour), nil }
	a.Configure(Options{StateDir: h.stateDir()})
	return a, log, l
}

// start runs a until the returned stop is called (stop waits for Run).
func start(t *testing.T, a *Agent) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = a.Run(ctx) }()
	var once sync.Once
	stop = func() {
		once.Do(func() {
			cancel()
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				t.Errorf("Run had not returned 10s after the agent was stopped")
			}
		})
	}
	t.Cleanup(stop)
	return stop
}

func (h *jobHome) job(t *testing.T, id string, st jobs.Status) {
	t.Helper()
	s := h.store()
	if err := s.Create(jobs.Spec{ID: id, EnvelopeID: "env-" + id, Argv: []string{"sleep", "200"}, CreatedAt: time.Now().UTC().Add(-time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if st.State != "" {
		if err := s.WriteStatus(id, st); err != nil {
			t.Fatal(err)
		}
	}
}

func done(code int) jobs.Status {
	s := time.Now().UTC().Add(-30 * time.Second)
	e := time.Now().UTC()
	return jobs.Status{State: jobs.StateDone, PID: 900, WrapperPID: 899, ExitCode: &code, StartedAt: &s, EndedAt: &e, LogBytes: 12}
}

func running() jobs.Status {
	s := time.Now().UTC().Add(-30 * time.Second)
	return jobs.Status{State: jobs.StateRunning, PID: 900, WrapperPID: 899, StartedAt: &s}
}

// jobEnds is the job.end entries in the chain on disk.
func jobEnds(t *testing.T, log *audit.Log) []map[string]any {
	t.Helper()
	all, err := log.EntriesAfter(-1)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, e := range all {
		if e["capability"] == "job.end" {
			out = append(out, e)
		}
	}
	return out
}

func num(v any) any {
	if n, ok := v.(json.Number); ok {
		i, _ := n.Int64()
		return i
	}
	return v
}

// C1: the job frame's wire shape, committed as the golden core reads.
func TestTheJobFrameIsTheGoldenCoreReads(t *testing.T) {
	code := 0
	// started in another zone: the frame says UTC.
	started := time.Date(2026, 10, 12, 11, 0, 0, 0, time.FixedZone("CEST", 2*3600))
	ended := time.Date(2026, 10, 12, 9, 3, 20, 0, time.UTC)
	j := jobs.Job{
		Spec:   jobs.Spec{ID: "0123456789ab", EnvelopeID: "00000000-0000-4000-8000-0000000000j1", Argv: []string{"sleep", "200"}},
		Status: jobs.Status{State: jobs.StateDone, PID: 4300, WrapperPID: 4299, ExitCode: &code, StartedAt: &started, EndedAt: &ended, LogBytes: 41},
	}
	b, err := json.Marshal(jobFrame(j))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	want := map[string]any{"type": "job", "job_id": "0123456789ab", "state": "done", "exit_code": float64(0),
		"started_at": "2026-10-12T09:00:00Z", "ended_at": "2026-10-12T09:03:20Z", "log_bytes": float64(41), "reason": ""}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("job frame = %s\nwant %v", b, want)
	}
	matchesGolden(t, "job_golden.json", b)

	// No exit code and no start: null, never omitted.
	lost := jobs.Job{Spec: j.Spec, Status: jobs.Status{State: jobs.StateLost, EndedAt: &ended, Reason: "its wrapper is gone"}}
	b, _ = json.Marshal(jobFrame(lost))
	if !bytes.Contains(b, []byte(`"exit_code":null`)) || !bytes.Contains(b, []byte(`"started_at":null`)) || !bytes.Contains(b, []byte(`"reason":"its wrapper is gone"`)) || !bytes.Contains(b, []byte(`"state":"lost"`)) {
		t.Errorf("a lost job's frame = %s", b)
	}
	if wire.TypeJob != "job" || wire.TypeJobAck != "job_ack" {
		t.Errorf("frame types = %q, %q", wire.TypeJob, wire.TypeJobAck)
	}
}

// C2: the agent writes lost for a running job whose wrapper is gone, and
// reports it like any terminal job.
func TestTheScannerWritesLostForAGoneWrapper(t *testing.T) {
	h := newJobHome(t)
	h.job(t, "00000000aa01", running())
	jc := newJobCore(t, h.corePub, h.devPub, false, 0)
	a, log, _ := h.agent(t, jc.srv.URL)
	var asked atomic.Int64
	a.jobAlive = func(pid int) bool { asked.Store(int64(pid)); return false }
	start(t, a)
	sf := jc.waitJobFrame(t, "00000000aa01", 5*time.Second)
	if sf.f["state"] != jobs.StateLost || sf.f["exit_code"] != nil || !strings.Contains(fmt.Sprint(sf.f["reason"]), "899") {
		t.Fatalf("frame = %v", sf.f)
	}
	if asked.Load() != 899 {
		t.Errorf("asked about pid %d, want the wrapper's 899", asked.Load())
	}
	j, _ := h.store().Get("00000000aa01")
	if j.Status.State != jobs.StateLost || j.Status.EndedAt == nil {
		t.Errorf("record = %+v", j.Status)
	}
	ends := jobEnds(t, log)
	if len(ends) != 1 || ends[0]["summary"] != "job 00000000aa01 lost, no exit code" || ends[0]["ok"] != false || ends[0]["exit_code"] != nil {
		t.Errorf("job.end entries = %v", ends)
	}
}

// C2: an alive wrapper since the boot is left running; one alive but
// recorded before the agent's boot time is lost (the agent reads bootTime).
func TestTheScannerReadsAliveAndTheBootTime(t *testing.T) {
	h := newJobHome(t)
	h.job(t, "00000000bb01", running())
	jc := newJobCore(t, h.corePub, h.devPub, false, 0)
	a, _, _ := h.agent(t, jc.srv.URL)
	stop := start(t, a)
	frames, _ := jc.collect(400 * time.Millisecond)
	if len(frames) != 0 {
		t.Fatalf("a running job with a live wrapper was reported: %v", frames)
	}
	stop()
	if j, _ := h.store().Get("00000000bb01"); j.Status.State != jobs.StateRunning {
		t.Fatalf("record = %+v, want still running", j.Status)
	}
	// The same pid alive, but this machine booted after the record.
	a2, _, _ := h.agent(t, jc.srv.URL)
	a2.bootTime = func() (time.Time, error) { return time.Now(), nil }
	start(t, a2)
	sf := jc.waitJobFrame(t, "00000000bb01", 5*time.Second)
	if sf.f["state"] != jobs.StateLost || !strings.Contains(fmt.Sprint(sf.f["reason"]), "before this machine's last boot") {
		t.Fatalf("frame = %v", sf.f)
	}
}

// C3: one terminal job, many scans: exactly one job.end entry, sent in an
// audit frame, marked, and the chain still verifies.
func TestOneAuditEntryPerTerminalJob(t *testing.T) {
	h := newJobHome(t)
	h.job(t, "00000000cc01", done(3))
	h.job(t, "00000000cc02", jobs.Status{State: jobs.StateFailedToStart, Reason: "no such binary"})
	jc := newJobCore(t, h.corePub, h.devPub, false, 0)
	a, log, _ := h.agent(t, jc.srv.URL)
	start(t, a)
	_, sent := jc.collect(500 * time.Millisecond) // ~16 scans
	ends := jobEnds(t, log)
	if len(ends) != 2 || len(sent) != 2 {
		t.Fatalf("job.end entries on disk %v, sent %v; want one per job", ends, sent)
	}
	byID := map[string]map[string]any{}
	for _, e := range ends {
		byID[strings.Fields(fmt.Sprint(e["summary"]))[1]] = e
	}
	if e := byID["00000000cc01"]; e == nil || e["envelope_id"] != "env-00000000cc01" || e["summary"] != "job 00000000cc01 done exit 3" || e["ok"] != true || num(e["exit_code"]) != int64(3) {
		t.Errorf("done job's entry = %v", e)
	}
	if e := byID["00000000cc02"]; e == nil || e["envelope_id"] != "env-00000000cc02" || e["summary"] != "job 00000000cc02 failed_to_start, no exit code" || e["ok"] != false || e["exit_code"] != nil {
		t.Errorf("failed job's entry = %v", e)
	}
	for _, id := range []string{"00000000cc01", "00000000cc02"} {
		if !h.store().Marked(id, jobs.MarkerAudited) {
			t.Errorf("%s not marked audited", id)
		}
	}
	if err := log.Verify(); err != nil {
		t.Errorf("chain: %v", err)
	}
}

// C3: an entry already in the chain without the marker (a crash between
// append and mark) gets the marker and no second entry.
func TestAnEntryAlreadyInTheChainIsNotAppendedAgain(t *testing.T) {
	h := newJobHome(t)
	h.job(t, "00000000dd01", done(0))
	log, err := audit.Open(h.auditPath())
	if err != nil {
		t.Fatal(err)
	}
	zero := 0
	if _, err := log.Append(time.Now().Unix(), "env-00000000dd01", "job.end", "job 00000000dd01 done exit 0", true, &zero); err != nil {
		t.Fatal(err)
	}
	jc := newJobCore(t, h.corePub, h.devPub, false, 0)
	a, log2, _ := h.agent(t, jc.srv.URL)
	start(t, a)
	jc.waitJobFrame(t, "00000000dd01", 5*time.Second)
	waitFor(t, 2*time.Second, func() bool { return h.store().Marked("00000000dd01", jobs.MarkerAudited) })
	if ends := jobEnds(t, log2); len(ends) != 1 {
		t.Fatalf("job.end entries = %v, want the one already there", ends)
	}
}

// C4: a job frame once per session, again on the next session, until acked.
func TestAJobFrameIsSentOncePerSessionUntilAcked(t *testing.T) {
	h := newJobHome(t)
	h.job(t, "00000000ee01", done(0))
	jc := newJobCore(t, h.corePub, h.devPub, false, 400*time.Millisecond)
	a, log, _ := h.agent(t, jc.srv.URL)
	start(t, a)
	frames, _ := jc.collect(1500 * time.Millisecond)
	if len(frames[1]) != 1 || len(frames[2]) != 1 {
		t.Fatalf("job frames per session = %v, want one in each of sessions 1 and 2", frames)
	}
	f := frames[1][0]
	if f["job_id"] != "00000000ee01" || f["state"] != "done" || num(f["exit_code"]) != int64(0) || num(f["log_bytes"]) != int64(12) || f["started_at"] == nil || f["ended_at"] == nil {
		t.Errorf("frame = %v", f)
	}
	if ends := jobEnds(t, log); len(ends) != 1 {
		t.Errorf("job.end entries over %d sessions = %v, want 1", jc.sessions.Load(), ends)
	}
}

// C4: a job that ends mid-session is sent on the next scan; the default
// interval is 5 s.
func TestAJobThatEndsMidSessionIsSentOnTheNextScan(t *testing.T) {
	if JobScanEvery != 5*time.Second {
		t.Errorf("JobScanEvery = %s, want 5s", JobScanEvery)
	}
	h := newJobHome(t)
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	if a, err := New(config.Config{DeviceID: "d", Server: "http://x.invalid", CorePubKey: hex.EncodeToString(corePub)}, h.devPriv, nil, h.home, "t", nil); err != nil || a.jobScanEvery != JobScanEvery {
		t.Errorf("a new agent scans every %v (%v), want JobScanEvery", a.jobScanEvery, err)
	}
	h.job(t, "00000000ff01", running())
	jc := newJobCore(t, h.corePub, h.devPub, false, 0)
	a, _, _ := h.agent(t, jc.srv.URL)
	start(t, a)
	if frames, _ := jc.collect(200 * time.Millisecond); len(frames) != 0 {
		t.Fatalf("a running job was reported: %v", frames)
	}
	if err := h.store().WriteStatus("00000000ff01", done(5)); err != nil {
		t.Fatal(err)
	}
	sf := jc.waitJobFrame(t, "00000000ff01", 2*time.Second)
	if num(sf.f["exit_code"]) != int64(5) || sf.session != 1 {
		t.Errorf("frame = %v (session %d)", sf.f, sf.session)
	}
}

// C5: core's job_ack marks the job acked, and no later session sends it.
func TestAJobAckEndsTheResends(t *testing.T) {
	h := newJobHome(t)
	h.job(t, "000000001101", done(0))
	jc := newJobCore(t, h.corePub, h.devPub, true, 300*time.Millisecond)
	a, _, _ := h.agent(t, jc.srv.URL)
	start(t, a)
	frames, _ := jc.collect(1500 * time.Millisecond)
	if jc.sessions.Load() < 2 {
		t.Fatalf("only %d session(s)", jc.sessions.Load())
	}
	if len(frames[1]) != 1 || len(frames) != 1 {
		t.Fatalf("job frames per session = %v, want one, in session 1 only", frames)
	}
	if !h.store().Marked("000000001101", jobs.MarkerAcked) {
		t.Error("not marked acked")
	}
}

// C5: an ack for an unknown id, a malformed id, or a job still running
// marks nothing; the running job's frame still comes when it ends.
func TestAJobAckThatNamesNoEndedJobMarksNothing(t *testing.T) {
	h := newJobHome(t)
	h.job(t, "000000002201", running())
	jc := newJobCore(t, h.corePub, h.devPub, false, 0,
		map[string]any{"type": wire.TypeJobAck, "job_id": "0000000022ff"},
		map[string]any{"type": wire.TypeJobAck, "job_id": "../x"},
		map[string]any{"type": wire.TypeJobAck, "job_id": "000000002201"},
	)
	a, _, l := h.agent(t, jc.srv.URL)
	start(t, a)
	waitFor(t, 3*time.Second, func() bool { return len(l.matching("0000000022ff")) > 0 && len(l.matching("000000002201")) > 0 })
	if h.store().Marked("000000002201", jobs.MarkerAcked) {
		t.Fatal("a running job was marked acked")
	}
	if len(l.matching(`"../x"`)) == 0 {
		t.Errorf("the malformed ack was not logged: %v", l.matching("ack"))
	}
	if err := h.store().WriteStatus("000000002201", done(0)); err != nil {
		t.Fatal(err)
	}
	jc.waitJobFrame(t, "000000002201", 2*time.Second)
}

// C6: novad restarted mid-job: the job ended while no agent ran; the new
// agent reports it and audits it once; one after it, with core never
// acking, re-sends it and appends nothing.
func TestAnAgentRestartedMidJobSendsTheFrameAndAuditsOnce(t *testing.T) {
	h := newJobHome(t)
	h.job(t, "000000003301", running())
	jc := newJobCore(t, h.corePub, h.devPub, false, 0)
	a1, _, _ := h.agent(t, jc.srv.URL)
	stop1 := start(t, a1)
	if frames, _ := jc.collect(200 * time.Millisecond); len(frames) != 0 {
		t.Fatalf("a running job was reported: %v", frames)
	}
	stop1()
	if err := h.store().WriteStatus("000000003301", done(0)); err != nil {
		t.Fatal(err)
	}
	a2, log2, _ := h.agent(t, jc.srv.URL)
	stop2 := start(t, a2)
	jc.waitJobFrame(t, "000000003301", 5*time.Second)
	waitFor(t, 2*time.Second, func() bool { return h.store().Marked("000000003301", jobs.MarkerAudited) })
	stop2()
	if ends := jobEnds(t, log2); len(ends) != 1 {
		t.Fatalf("job.end entries after the restart = %v, want 1", ends)
	}
	a3, log3, _ := h.agent(t, jc.srv.URL)
	start(t, a3)
	jc.waitJobFrame(t, "000000003301", 5*time.Second)
	time.Sleep(100 * time.Millisecond)
	if ends := jobEnds(t, log3); len(ends) != 1 {
		t.Fatalf("job.end entries after a second restart = %v, want still 1", ends)
	}
	if err := log3.Verify(); err != nil {
		t.Errorf("chain: %v", err)
	}
}

// C4: the scan runs at the session's start, not only on the tick.
func TestAnEndedJobIsSentAtConnect(t *testing.T) {
	h := newJobHome(t)
	h.job(t, "000000004401", done(0))
	jc := newJobCore(t, h.corePub, h.devPub, false, 0)
	a, log, _ := h.agent(t, jc.srv.URL)
	a.jobScanEvery = time.Hour
	start(t, a)
	jc.waitJobFrame(t, "000000004401", 3*time.Second)
	if ends := jobEnds(t, log); len(ends) != 1 {
		t.Errorf("job.end entries = %v", ends)
	}
}

// C3: passes racing each other (a session's first scan, a tick, a second
// session) still append one entry per job.
func TestRacingScansAuditEachJobOnce(t *testing.T) {
	h := newJobHome(t)
	var ids []string
	for i := range 6 {
		id := fmt.Sprintf("0000000055%02d", i)
		ids = append(ids, id)
		h.job(t, id, done(i))
	}
	// A sink core: it reads and drops whatever it is sent.
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			if _, _, err := c.Read(r.Context()); err != nil {
				return
			}
		}
	}))
	defer sink.Close()
	a, log, _ := h.agent(t, sink.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(sink.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() { a.scanJobs(ctx, c, map[string]bool{}) })
	}
	wg.Wait()
	if ends := jobEnds(t, log); len(ends) != len(ids) {
		t.Fatalf("%d job.end entries for %d jobs: %v", len(ends), len(ids), ends)
	}
	if err := log.Verify(); err != nil {
		t.Errorf("chain: %v", err)
	}
}

// C2: a real agent reads a wrapper's liveness and the boot time from the
// OS (jobs.ProcessAlive, jobs.BootTime), not a stand-in.
func TestANewAgentReadsLivenessAndBootFromTheOS(t *testing.T) {
	h := newJobHome(t)
	a, err := New(config.Config{DeviceID: "d", Server: "http://x.invalid", CorePubKey: hex.EncodeToString(h.corePub)}, h.devPriv, nil, h.home, "t", nil)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if !a.jobAlive(os.Getpid()) || a.jobAlive(cmd.Process.Pid) {
		t.Errorf("jobAlive: self %v, an exited child %v", a.jobAlive(os.Getpid()), a.jobAlive(cmd.Process.Pid))
	}
	got, gerr := a.bootTime()
	want, werr := jobs.BootTime()
	if gerr != nil || werr != nil || !got.Round(time.Second).Equal(want.Round(time.Second)) {
		t.Errorf("bootTime = %v (%v), want jobs.BootTime %v (%v)", got, gerr, want, werr)
	}
}

// Amended C7: one unreadable job dir never stops the scan: every readable
// job is still audited, framed and judged, and the bad id is logged once.
func TestAnUnreadableJobDoesNotStopTheScan(t *testing.T) {
	h := newJobHome(t)
	h.job(t, "000000001a01", done(0))
	h.job(t, "000000001a03", running())
	bad := h.store().Dir("000000001a02")
	if err := os.MkdirAll(bad, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bad, jobs.SpecFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	jc := newJobCore(t, h.corePub, h.devPub, false, 0)
	a, log, logs := h.agent(t, jc.srv.URL)
	a.jobAlive = func(int) bool { return false }
	start(t, a)
	frames, _ := jc.collect(600 * time.Millisecond) // ~20 scans
	got := map[string]string{}
	for _, f := range frames[1] {
		got[fmt.Sprint(f["job_id"])] = fmt.Sprint(f["state"])
	}
	if got["000000001a01"] != jobs.StateDone || got["000000001a03"] != jobs.StateLost || len(got) != 2 {
		t.Fatalf("job frames = %v, want 1a01 done and 1a03 lost", got)
	}
	if ends := jobEnds(t, log); len(ends) != 2 {
		t.Errorf("job.end entries = %v, want one per readable job", ends)
	}
	if lines := logs.matching("000000001a02"); len(lines) != 1 || !strings.Contains(lines[0], "unreadable") {
		t.Errorf("log lines naming the bad job = %q, want exactly one saying it is unreadable", lines)
	}
}

// Amended C2: a record-less job past the spawn window is written lost and
// reported (one job.end, a frame); one inside the window is left alone.
func TestTheScannerJudgesAnOldRecordlessJobLost(t *testing.T) {
	h := newJobHome(t)
	h.job(t, "000000001b01", jobs.Status{}) // created a minute ago, no record
	if err := h.store().Create(jobs.Spec{ID: "000000001b02", EnvelopeID: "env-1b02", Argv: []string{"true"}, CreatedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	jc := newJobCore(t, h.corePub, h.devPub, false, 0)
	a, log, _ := h.agent(t, jc.srv.URL)
	start(t, a)
	sf := jc.waitJobFrame(t, "000000001b01", 5*time.Second)
	if sf.f["state"] != jobs.StateLost || sf.f["exit_code"] != nil || !strings.Contains(fmt.Sprint(sf.f["reason"]), "before its wrapper wrote a record") {
		t.Fatalf("frame = %v", sf.f)
	}
	frames, _ := jc.collect(300 * time.Millisecond)
	for _, fs := range frames {
		for _, f := range fs {
			if f["job_id"] == "000000001b02" {
				t.Errorf("a record-less job inside the spawn window was reported: %v", f)
			}
		}
	}
	if j, _ := h.store().Get("000000001b02"); j.Status.State != "" {
		t.Errorf("young job record = %+v, want none", j.Status)
	}
	ends := jobEnds(t, log)
	if len(ends) != 1 || ends[0]["summary"] != "job 000000001b01 lost, no exit code" {
		t.Errorf("job.end entries = %v", ends)
	}
}
