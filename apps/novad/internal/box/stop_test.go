package box

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// Manager.Stop (S38c T4): a landing's judge stops the change's own idle box
// so it can take the slot. Only the change id goes in; every name is derived.

func psCall() []string {
	return []string{"ps", "-a", "--filter", "label=" + Label, "--format", "{{.Names}}\t{{.State}}\t{{.Image}}"}
}

// C1
func TestStopStopsARunningBoxAndItsDB(t *testing.T) {
	d := newFake()
	n, other := Names(tChange), Names("bbb222")
	d.ctrs[n.Box] = &fakeCtr{"running", tTag}
	d.ctrs[n.DB] = &fakeCtr{"running", PostgresImage}
	d.ctrs[other.Box] = &fakeCtr{"running", tTag}
	d.ctrs[other.DB] = &fakeCtr{"running", PostgresImage}
	m, _ := newManager(d)
	m.Touch(tChange)
	stopped, err := m.Stop(context.Background(), tChange)
	if err != nil || !stopped {
		t.Fatalf("stopped=%v err=%v, want true and no error", stopped, err)
	}
	want := [][]string{psCall(), {"stop", n.Box, n.DB}}
	if !reflect.DeepEqual(d.calls, want) {
		t.Fatalf("docker calls\n got %q\nwant %q", d.calls, want)
	}
	if d.ctrs[n.Box].state == "running" || d.ctrs[n.DB].state == "running" {
		t.Fatal("the change's box or db still runs")
	}
	if d.ctrs[other.Box].state != "running" || d.ctrs[other.DB].state != "running" {
		t.Fatal("stopped another change's box")
	}
	if _, ok := m.LastUse(tChange); ok {
		t.Fatal("a stopped box keeps its last use; Reap would count a stale idle time")
	}
}

// C1: a running box whose db is down stops the box alone (docker stop of a
// stopped container is noise, of an absent one an error).
func TestStopNamesTheDBOnlyWhenItRuns(t *testing.T) {
	for name, db := range map[string]*fakeCtr{"exited": {"exited", PostgresImage}, "absent": nil} {
		d := newFake()
		n := Names(tChange)
		d.ctrs[n.Box] = &fakeCtr{"running", tTag}
		if db != nil {
			d.ctrs[n.DB] = db
		}
		m, _ := newManager(d)
		stopped, err := m.Stop(context.Background(), tChange)
		if err != nil || !stopped {
			t.Fatalf("%s: stopped=%v err=%v", name, stopped, err)
		}
		if want := [][]string{psCall(), {"stop", n.Box}}; !reflect.DeepEqual(d.calls, want) {
			t.Fatalf("%s: calls %q, want %q", name, d.calls, want)
		}
	}
}

// C2
func TestStopOfABoxNotRunningStopsNothing(t *testing.T) {
	for _, state := range []string{"exited", "created", "absent"} {
		d := newFake()
		n := Names(tChange)
		if state != "absent" {
			d.ctrs[n.Box] = &fakeCtr{state, tTag}
			// A lone running db under a stopped box is left alone (Reap's
			// rule): Ensure starts it again with the box.
			d.ctrs[n.DB] = &fakeCtr{"running", PostgresImage}
		}
		d.ctrs[Names("bbb222").Box] = &fakeCtr{"running", tTag}
		m, _ := newManager(d)
		stopped, err := m.Stop(context.Background(), tChange)
		if err != nil || stopped {
			t.Fatalf("%s: stopped=%v err=%v, want false and no error", state, stopped, err)
		}
		if want := [][]string{psCall()}; !reflect.DeepEqual(d.calls, want) {
			t.Fatalf("%s: calls %q, want only the listing", state, d.calls)
		}
	}
}

// C3
func TestStopRefusesABoxRunningALiveJob(t *testing.T) {
	d := newFake()
	n := Names(tChange)
	d.ctrs[n.Box] = &fakeCtr{"running", tTag}
	d.ctrs[n.DB] = &fakeCtr{"running", PostgresImage}
	m, _ := newManager(d)
	m.Busy = func() (map[string]bool, error) { return map[string]bool{tChange: true}, nil }
	stopped, err := m.Stop(context.Background(), tChange)
	if stopped || !errors.Is(err, ErrBusy) {
		t.Fatalf("stopped=%v err=%v, want ErrBusy", stopped, err)
	}
	if !strings.Contains(err.Error(), n.Box) || !strings.Contains(err.Error(), "nothing was stopped") {
		t.Fatalf("err %q does not name the box and say nothing was stopped", err)
	}
	for _, c := range d.calls {
		if c[0] == "stop" {
			t.Fatalf("stopped a busy box: %q", c)
		}
	}
	if d.ctrs[n.Box].state != "running" {
		t.Fatal("the busy box no longer runs")
	}
}

// C3
func TestStopThatCannotReadTheJobsStopsNothing(t *testing.T) {
	d := newFake()
	n := Names(tChange)
	d.ctrs[n.Box] = &fakeCtr{"running", tTag}
	m, _ := newManager(d)
	m.Busy = func() (map[string]bool, error) { return nil, errors.New("job 0123456789ab: unreadable status") }
	stopped, err := m.Stop(context.Background(), tChange)
	if stopped || err == nil || !strings.Contains(err.Error(), "unreadable status") || !strings.Contains(err.Error(), "nothing was stopped") {
		t.Fatalf("stopped=%v err=%v, want a stated refusal quoting the read", stopped, err)
	}
	if errors.Is(err, ErrBusy) {
		t.Fatal("an unread job store is not a busy box")
	}
	for _, c := range d.calls {
		if c[0] == "stop" {
			t.Fatalf("stopped on doubt: %q", c)
		}
	}
}

// C3: another change's job does not hold this box.
func TestStopIgnoresAnotherChangesJob(t *testing.T) {
	d := newFake()
	n := Names(tChange)
	d.ctrs[n.Box] = &fakeCtr{"running", tTag}
	m, _ := newManager(d)
	m.Busy = func() (map[string]bool, error) { return map[string]bool{"bbb222": true}, nil }
	stopped, err := m.Stop(context.Background(), tChange)
	if err != nil || !stopped {
		t.Fatalf("stopped=%v err=%v", stopped, err)
	}
}

// C4
func TestStopRefusesABadChangeBeforeDocker(t *testing.T) {
	for _, id := range []string{"", "../x", "C0FFEE", "c0ffee1", "abc12"} {
		d := newFake()
		m, _ := newManager(d)
		busyRead := false
		m.Busy = func() (map[string]bool, error) { busyRead = true; return nil, nil }
		stopped, err := m.Stop(context.Background(), id)
		if err == nil || stopped || !strings.Contains(err.Error(), "not a change id") {
			t.Fatalf("%q: stopped=%v err=%v", id, stopped, err)
		}
		if len(d.calls) != 0 || busyRead {
			t.Fatalf("%q: reached docker %q (busy read %v)", id, d.calls, busyRead)
		}
	}
}

// C5 (manager half): a docker failure quotes docker and claims nothing.
func TestStopStatesADockerFailure(t *testing.T) {
	for _, verb := range []string{"ps", "stop"} {
		d := newFake()
		n := Names(tChange)
		d.ctrs[n.Box] = &fakeCtr{"running", tTag}
		m, _ := newManager(d)
		m.Touch(tChange)
		d.fail = func(a []string) bool { return a[0] == verb }
		stopped, err := m.Stop(context.Background(), tChange)
		if stopped || err == nil || !strings.Contains(err.Error(), "boom at "+verb) {
			t.Fatalf("%s: stopped=%v err=%v", verb, stopped, err)
		}
		if _, ok := m.LastUse(tChange); !ok {
			t.Fatalf("%s: a failed stop forgot the box's last use", verb)
		}
	}
}
