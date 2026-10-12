//go:build unix

package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"novad/internal/box"
	"novad/internal/config"
)

// reapDocker answers the reaper: ps lists one running box, stop does what
// stopErr says; panics when told to. Safe for the reaper's goroutine.
type reapDocker struct {
	mu      sync.Mutex
	ps      int
	stops   [][]string
	psErr   string
	stopErr string
	panics  bool
}

func (d *reapDocker) Run(_ context.Context, argv []string) (string, int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.panics {
		panic("docker fake blew up")
	}
	switch argv[0] {
	case "ps":
		d.ps++
		if d.psErr != "" {
			return d.psErr, 1, nil
		}
		return "nova-box-aaa111\trunning\tnova-devbox:t-x\n", 0, nil
	case "stop":
		d.stops = append(d.stops, append([]string(nil), argv...))
		if d.stopErr != "" {
			return d.stopErr, 1, nil
		}
		return "", 0, nil
	}
	return "", 0, nil
}

func (d *reapDocker) counts() (int, int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.ps, len(d.stops)
}

type logs struct {
	mu    sync.Mutex
	lines []string
}

func (l *logs) logf(f string, a ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(f, a...))
}

func (l *logs) matching(s string) []string {
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

func reapAgent(t *testing.T, d *reapDocker) (*Agent, *logs) {
	t.Helper()
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	cfg := config.Config{DeviceID: "dev-reap-1", Server: "http://127.0.0.1:1", CorePubKey: hex.EncodeToString(corePub)}
	l := &logs{}
	a, err := New(cfg, devPriv, nil, t.TempDir(), "test", l.logf)
	if err != nil {
		t.Fatal(err)
	}
	// The box was last used long ago: the first tick stops it.
	m := &box.Manager{Docker: d, Git: d, Now: time.Now}
	m.Now = func() time.Time { return time.Unix(1e9, 0) }
	m.Touch("aaa111")
	m.Now = time.Now
	a.deps.Box = m
	a.reapEvery = 5 * time.Millisecond
	return a, l
}

func reapWait(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// C5
func TestTheReaperIntervalIsAMinute(t *testing.T) {
	a, _ := reapAgent(t, &reapDocker{})
	if BoxReapEvery != time.Minute {
		t.Fatalf("BoxReapEvery = %s", BoxReapEvery)
	}
	b, err := New(a.cfg, a.priv, nil, t.TempDir(), "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	if b.reapEvery != BoxReapEvery {
		t.Fatalf("reapEvery = %s, want %s", b.reapEvery, BoxReapEvery)
	}
}

// C5
func TestTheReaperStopsAnIdleBoxAndLogsIt(t *testing.T) {
	d := &reapDocker{}
	a, l := reapAgent(t, d)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { a.reapBoxes(ctx, a.deps.Box); close(done) }()
	reapWait(t, "the stop log line", func() bool { return len(l.matching("stopped nova-box-aaa111")) > 0 })
	cancel()
	<-done
	if _, n := d.counts(); n != 1 {
		t.Fatalf("stops = %d, want 1", n)
	}
	if got := l.matching("idle"); len(got) == 0 {
		t.Fatalf("log %q does not say why", l.lines)
	}
}

// C5: a failure is logged, retried on the next tick, and an unchanged error
// is logged once.
func TestTheReaperLogsAFailureOnceAndKeepsTrying(t *testing.T) {
	d := &reapDocker{stopErr: "Error response from daemon: cannot stop"}
	a, l := reapAgent(t, d)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { a.reapBoxes(ctx, a.deps.Box); close(done) }()
	reapWait(t, "three stop attempts", func() bool { _, n := d.counts(); return n >= 3 })
	d.mu.Lock()
	d.stopErr = "Error response from daemon: another reason"
	d.mu.Unlock()
	reapWait(t, "the changed error", func() bool { return len(l.matching("another reason")) > 0 })
	cancel()
	<-done
	if got := l.matching("cannot stop"); len(got) != 1 {
		t.Fatalf("the same error was logged %d times: %q", len(got), got)
	}
	if got := l.matching("nova-box-aaa111"); len(got) < 2 {
		t.Fatalf("errors do not name the box: %q", l.lines)
	}
}

// C5
func TestTheReaperSurvivesAPanic(t *testing.T) {
	d := &reapDocker{panics: true}
	a, l := reapAgent(t, d)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { a.reapBoxes(ctx, a.deps.Box); close(done) }()
	reapWait(t, "the panic log line", func() bool { return len(l.matching("docker fake blew up")) > 0 })
	d.mu.Lock()
	d.panics = false
	d.mu.Unlock()
	reapWait(t, "a tick after the panic", func() bool { _, n := d.counts(); return n >= 1 })
	cancel()
	<-done
}

// C5: Run starts the reaper for its life and it ends with Run.
func TestRunReapsForItsLifeOnly(t *testing.T) {
	d := &reapDocker{psErr: "nothing to see"}
	a, _ := reapAgent(t, d)
	a.backoffs = []time.Duration{5 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	reapWait(t, "the reaper's first ticks", func() bool { n, _ := d.counts(); return n >= 3 })
	cancel()
	<-done
	before, _ := d.counts()
	time.Sleep(50 * time.Millisecond)
	if after, _ := d.counts(); after != before {
		t.Fatalf("the reaper outlived Run: %d -> %d listings", before, after)
	}
}

// C5: no manager, no reaper (and Run does not crash on it).
func TestRunWithoutABoxManagerReapsNothing(t *testing.T) {
	d := &reapDocker{}
	a, _ := reapAgent(t, d)
	a.deps.Box = nil
	a.backoffs = []time.Duration{5 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	_ = a.Run(ctx)
	if n, _ := d.counts(); n != 0 {
		t.Fatalf("%d listings without a manager", n)
	}
}
