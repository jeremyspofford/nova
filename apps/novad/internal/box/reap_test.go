package box

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

// clocked is a Manager on the fake docker whose clock the test moves.
func clocked(d *fakeDocker) (*Manager, *time.Time) {
	m, _ := newManager(d)
	clock := tNow
	m.Now = func() time.Time { return clock }
	return m, &clock
}

func (f *fakeDocker) stops() [][]string {
	var out [][]string
	for _, a := range f.calls {
		if a[0] == "stop" {
			out = append(out, a)
		}
	}
	return out
}

// C1
func TestTouchRecordsAUseAtNow(t *testing.T) {
	m, clock := clocked(newFake())
	if _, ok := m.LastUse("aaa111"); ok {
		t.Fatal("a use recorded before any")
	}
	*clock = tNow.Add(7 * time.Minute)
	m.Touch("aaa111")
	got, ok := m.LastUse("aaa111")
	if !ok || !got.Equal(tNow.Add(7*time.Minute)) {
		t.Fatalf("last use %v %v, want %v", got, ok, tNow.Add(7*time.Minute))
	}
	if _, ok := m.LastUse("bbb222"); ok {
		t.Fatal("touching one change recorded another")
	}
}

// C1
func TestEnsureTouchesTheBox(t *testing.T) {
	m, clock := clocked(newFake())
	*clock = tNow.Add(3 * time.Minute)
	if _, err := m.Ensure(context.Background(), boxReq("aaa111")); err != nil {
		t.Fatal(err)
	}
	if got, ok := m.LastUse("aaa111"); !ok || !got.Equal(tNow.Add(3*time.Minute)) {
		t.Fatalf("last use %v %v after Ensure", got, ok)
	}
}

// C2
func TestReapStopsABoxIdleThirtyMinutesAndNotBefore(t *testing.T) {
	d := newFake()
	m, clock := clocked(d)
	if _, err := m.Ensure(context.Background(), boxReq("aaa111")); err != nil {
		t.Fatal(err)
	}
	d.calls = nil
	*clock = tNow.Add(IdleStop - time.Second)
	stopped, err := m.Reap(context.Background())
	if err != nil || len(stopped) != 0 || len(d.stops()) != 0 {
		t.Fatalf("29m59s idle: stopped %q err %v stops %q", stopped, err, d.stops())
	}
	*clock = tNow.Add(IdleStop)
	stopped, err = m.Reap(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stopped, []string{"nova-box-aaa111"}) {
		t.Fatalf("stopped %q", stopped)
	}
	want := [][]string{{"stop", "nova-box-aaa111", "nova-box-aaa111-db"}}
	if !reflect.DeepEqual(d.stops(), want) {
		t.Fatalf("stops %q, want %q", d.stops(), want)
	}
	if d.ctrs["nova-box-aaa111"].state == "running" || d.ctrs["nova-box-aaa111-db"].state == "running" {
		t.Fatal("box or db still running")
	}
	if _, ok := m.LastUse("aaa111"); ok {
		t.Fatal("a stopped box kept its record")
	}
	// The next tick has nothing to do.
	d.calls = nil
	*clock = tNow.Add(3 * IdleStop)
	if stopped, err := m.Reap(context.Background()); err != nil || len(stopped) != 0 || len(d.stops()) != 0 {
		t.Fatalf("second tick: stopped %q err %v stops %q", stopped, err, d.stops())
	}
}

// C2: the idle time counts from the LAST use, and a stopped db is not stopped again.
func TestReapCountsFromTheLastUseAndStopsOnlyWhatRuns(t *testing.T) {
	d := newFake()
	m, clock := clocked(d)
	if _, err := m.Ensure(context.Background(), boxReq("aaa111")); err != nil {
		t.Fatal(err)
	}
	*clock = tNow.Add(20 * time.Minute)
	m.Touch("aaa111")
	*clock = tNow.Add(45 * time.Minute)
	d.calls = nil
	if stopped, _ := m.Reap(context.Background()); len(stopped) != 0 {
		t.Fatalf("stopped %q 25m after the last use", stopped)
	}
	d.ctrs["nova-box-aaa111-db"].state = "exited"
	*clock = tNow.Add(50 * time.Minute)
	stopped, err := m.Reap(context.Background())
	if err != nil || !reflect.DeepEqual(stopped, []string{"nova-box-aaa111"}) {
		t.Fatalf("stopped %q err %v", stopped, err)
	}
	if want := [][]string{{"stop", "nova-box-aaa111"}}; !reflect.DeepEqual(d.stops(), want) {
		t.Fatalf("stops %q, want %q", d.stops(), want)
	}
}

// C3
func TestReapCountsAnUnknownBoxFromFirstSight(t *testing.T) {
	d := newFake()
	m, clock := clocked(d)
	d.ctrs["nova-box-bbb222"] = &fakeCtr{"running", tTag}
	d.ctrs["nova-box-bbb222-db"] = &fakeCtr{"running", PostgresImage}
	d.ctrs["nova-box-ccc333"] = &fakeCtr{"exited", tTag}
	d.ctrs["nova-box-ccc333-db"] = &fakeCtr{"running", PostgresImage}
	d.ctrs["someone-else"] = &fakeCtr{"running", "nginx"}
	*clock = tNow.Add(5 * time.Hour)
	if stopped, err := m.Reap(context.Background()); err != nil || len(stopped) != 0 || len(d.stops()) != 0 {
		t.Fatalf("first sight: stopped %q err %v stops %q", stopped, err, d.stops())
	}
	if got, ok := m.LastUse("bbb222"); !ok || !got.Equal(tNow.Add(5*time.Hour)) {
		t.Fatalf("first sight not recorded: %v %v", got, ok)
	}
	if _, ok := m.LastUse("ccc333"); ok {
		t.Fatal("a stopped box was recorded")
	}
	*clock = tNow.Add(5*time.Hour + IdleStop - time.Minute)
	if stopped, _ := m.Reap(context.Background()); len(stopped) != 0 {
		t.Fatalf("stopped %q before 30m from first sight", stopped)
	}
	*clock = tNow.Add(5*time.Hour + IdleStop)
	stopped, err := m.Reap(context.Background())
	if err != nil || !reflect.DeepEqual(stopped, []string{"nova-box-bbb222"}) {
		t.Fatalf("stopped %q err %v", stopped, err)
	}
	if want := [][]string{{"stop", "nova-box-bbb222", "nova-box-bbb222-db"}}; !reflect.DeepEqual(d.stops(), want) {
		t.Fatalf("stops %q, want %q (never the stopped box's db, never a foreign name)", d.stops(), want)
	}
}

// C4
func TestReapThatCannotListStopsNothingAndSaysWhy(t *testing.T) {
	d := newFake()
	m, clock := clocked(d)
	if _, err := m.Ensure(context.Background(), boxReq("aaa111")); err != nil {
		t.Fatal(err)
	}
	d.fail = func(a []string) bool { return a[0] == "ps" }
	*clock = tNow.Add(time.Hour)
	stopped, err := m.Reap(context.Background())
	if err == nil || len(stopped) != 0 || len(d.stops()) != 0 {
		t.Fatalf("stopped %q err %v", stopped, err)
	}
	for _, w := range []string{"listing the boxes", "boom at ps -a"} {
		if !strings.Contains(err.Error(), w) {
			t.Fatalf("error %q lacks %q", err, w)
		}
	}
}

// C4
func TestReapRetriesAFailedStopOnTheNextTick(t *testing.T) {
	d := newFake()
	m, clock := clocked(d)
	for _, id := range []string{"aaa111", "bbb222"} {
		if _, err := m.Ensure(context.Background(), boxReq(id)); err != nil {
			t.Fatal(err)
		}
	}
	d.fail = func(a []string) bool { return a[0] == "stop" && a[1] == "nova-box-aaa111" }
	*clock = tNow.Add(IdleStop)
	stopped, err := m.Reap(context.Background())
	if !reflect.DeepEqual(stopped, []string{"nova-box-bbb222"}) {
		t.Fatalf("stopped %q: the other idle box must still stop", stopped)
	}
	if err == nil {
		t.Fatal("a failed stop was not reported")
	}
	for _, w := range []string{"stopping the idle box nova-box-aaa111", "exit 1", "boom at stop nova-box-aaa111"} {
		if !strings.Contains(err.Error(), w) {
			t.Fatalf("error %q lacks %q", err, w)
		}
	}
	if got, ok := m.LastUse("aaa111"); !ok || !got.Equal(tNow) {
		t.Fatalf("the failed box lost its record: %v %v", got, ok)
	}
	d.fail = nil
	d.calls = nil
	*clock = tNow.Add(IdleStop + time.Minute)
	stopped, err = m.Reap(context.Background())
	if err != nil || !reflect.DeepEqual(stopped, []string{"nova-box-aaa111"}) {
		t.Fatalf("retry: stopped %q err %v", stopped, err)
	}
}

// C4
func TestReapNeverPanicsOnWhatDockerSays(t *testing.T) {
	m := &Manager{Docker: scriptedPs("garbage\n\t\t\n\nnova-box-aaa111\trunning\t" + tTag + "\nnova-box-\trunning\tx\nnova-box-ZZZ999\trunning\tx\n"), Now: func() time.Time { return tNow }}
	stopped, err := m.Reap(context.Background())
	if err != nil || len(stopped) != 0 {
		t.Fatalf("stopped %q err %v", stopped, err)
	}
	if _, ok := m.LastUse("aaa111"); !ok {
		t.Fatal("the one well-formed running box was not recorded")
	}
	for _, id := range []string{"ZZZ999", ""} {
		if _, ok := m.LastUse(id); ok {
			t.Fatalf("a malformed name %q was recorded", id)
		}
	}
}

type scriptedPs string

func (s scriptedPs) Run(_ context.Context, argv []string) (string, int, error) {
	if argv[0] == "ps" {
		return string(s), 0, nil
	}
	return "", 0, nil
}
