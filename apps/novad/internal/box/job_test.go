package box

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// S30c T5: box jobs. Non-default values throughout — uid/gid 1000:1001
// (newManager), change aaa111, a docker binary of its own — so a hardcoded
// default cannot pass.

const tJob = "0a1b2c3d4e5f"

// C3: the wrapper's argv is docker exec into the change's box, as the owner,
// in her cwd, naming each env variable (the value rides in the docker
// client's environment), with sh writing its own pid to the pidfile before
// exec'ing her argv.
func TestJobArgvIsTheShippedExec(t *testing.T) {
	m, _ := newManager(newFake())
	m.DockerBin = "/opt/bin/docker-x"
	req := boxReq("aaa111")
	req.Cwd = Worktree(req.Checkout, "aaa111") + "/apps/web"
	got := m.JobArgv(req, tJob, []string{"GH_TOKEN", "NPM_X"}, []string{"npm", "test", "--", "a b"})
	want := []string{"/opt/bin/docker-x", "exec", "-w", req.Cwd, "-u", "1000:1001",
		"-e", "GH_TOKEN", "-e", "NPM_X", "nova-box-aaa111",
		"sh", "-c", `echo $$ >"$0"; exec "$@"`, "/tmp/novad-job-" + tJob + ".pid",
		"npm", "test", "--", "a b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("argv\n got %q\nwant %q", got, want)
	}
	if JobPidfile(tJob) != "/tmp/novad-job-"+tJob+".pid" {
		t.Fatalf("pidfile %q", JobPidfile(tJob))
	}
	// No env: no -e at all; "docker" when DockerBin is empty.
	m.DockerBin = ""
	bare := m.JobArgv(req, tJob, nil, []string{"true"})
	if len(bare) == 0 || bare[0] != "docker" || strings.Contains(strings.Join(bare, " "), " -e ") {
		t.Fatalf("bare argv %q", bare)
	}
}

// killDocker answers `exec ... cat <pidfile>` with pid (or fails), and
// records every call.
type killDocker struct {
	pid    string
	catErr bool
	calls  [][]string
}

func (k *killDocker) Run(_ context.Context, argv []string) (string, int, error) {
	k.calls = append(k.calls, append([]string(nil), argv...))
	if len(argv) >= 2 && argv[len(argv)-2] == "cat" {
		if k.catErr {
			return "cat: can't open '/tmp/x': No such file or directory\n", 1, nil
		}
		return k.pid, 0, nil
	}
	return "", 0, nil
}

// C5: the stop reads the pidfile inside the box and signals the job's group
// (then the pid) inside the box, as the owner; hard is KILL.
func TestKillJobSignalsInsideTheBox(t *testing.T) {
	for _, c := range []struct {
		hard bool
		sig  string
	}{{false, "TERM"}, {true, "KILL"}} {
		k := &killDocker{pid: "4242\n"}
		m := &Manager{Docker: k, UID: 1000, GID: 1001}
		if err := m.KillJob(context.Background(), "aaa111", tJob, c.hard); err != nil {
			t.Fatalf("%s: %v", c.sig, err)
		}
		want := [][]string{
			{"exec", "-u", "1000:1001", "nova-box-aaa111", "cat", "/tmp/novad-job-" + tJob + ".pid"},
			{"exec", "-u", "1000:1001", "nova-box-aaa111", "sh", "-c",
				`kill -` + c.sig + ` -"$1" 2>/dev/null || kill -` + c.sig + ` "$1"`, "kill", "4242"},
		}
		if !reflect.DeepEqual(k.calls, want) {
			t.Fatalf("%s calls\n got %q\nwant %q", c.sig, k.calls, want)
		}
	}
}

// C5: a pidfile that is missing or does not hold a pid kills nothing and
// says why; a bad change id reaches no docker at all.
func TestKillJobWithNoPidKillsNothing(t *testing.T) {
	for _, pid := range []string{"", "abc\n", "0\n", "-1\n", "12 13\n"} {
		k := &killDocker{pid: pid}
		m := &Manager{Docker: k, UID: 1000, GID: 1001}
		err := m.KillJob(context.Background(), "aaa111", tJob, false)
		if err == nil || len(k.calls) != 1 {
			t.Fatalf("pid %q: err %v calls %q", pid, err, k.calls)
		}
	}
	k := &killDocker{catErr: true}
	m := &Manager{Docker: k, UID: 1000, GID: 1001}
	err := m.KillJob(context.Background(), "aaa111", tJob, false)
	if err == nil || !strings.Contains(err.Error(), "No such file") || len(k.calls) != 1 {
		t.Fatalf("no pidfile: err %v calls %q", err, k.calls)
	}
	k2 := &killDocker{pid: "4242\n"}
	if err := (&Manager{Docker: k2}).KillJob(context.Background(), "AAA111", tJob, false); err == nil || len(k2.calls) != 0 {
		t.Fatalf("a bad change id: err %v calls %q", err, k2.calls)
	}
}

// C6: a box with a live job is never stopped; its idle time counts from the
// tick that saw the job.
func TestReapSkipsABoxWithALiveJob(t *testing.T) {
	d := newFake()
	m, clock := clocked(d)
	for _, id := range []string{"aaa111", "bbb222"} {
		if _, err := m.Ensure(context.Background(), boxReq(id)); err != nil {
			t.Fatal(err)
		}
	}
	busy := map[string]bool{"aaa111": true}
	m.Busy = func() (map[string]bool, error) { return busy, nil }
	*clock = tNow.Add(2 * time.Hour)
	stopped, err := m.Reap(context.Background())
	if err != nil || !reflect.DeepEqual(stopped, []string{"nova-box-bbb222"}) {
		t.Fatalf("stopped %q err %v: only the box without a job may stop", stopped, err)
	}
	if got, ok := m.LastUse("aaa111"); !ok || !got.Equal(tNow.Add(2*time.Hour)) {
		t.Fatalf("a busy box's idle was not counted from the tick: %v %v", got, ok)
	}
	// The job ended: 30 minutes after that tick it stops, not before.
	busy = map[string]bool{}
	*clock = tNow.Add(2*time.Hour + IdleStop - time.Second)
	if stopped, _ := m.Reap(context.Background()); len(stopped) != 0 {
		t.Fatalf("stopped %q before 30m from the job's last sight", stopped)
	}
	*clock = tNow.Add(2*time.Hour + IdleStop)
	stopped, err = m.Reap(context.Background())
	if err != nil || !reflect.DeepEqual(stopped, []string{"nova-box-aaa111"}) {
		t.Fatalf("after the job: stopped %q err %v", stopped, err)
	}
}

// C6: when the live jobs cannot be read, nothing is stopped and the error
// says so.
func TestReapThatCannotReadTheJobsStopsNothing(t *testing.T) {
	d := newFake()
	m, clock := clocked(d)
	if _, err := m.Ensure(context.Background(), boxReq("aaa111")); err != nil {
		t.Fatal(err)
	}
	m.Busy = func() (map[string]bool, error) { return nil, errors.New("jobs dir unreadable") }
	*clock = tNow.Add(time.Hour)
	stopped, err := m.Reap(context.Background())
	if len(stopped) != 0 || len(d.stops()) != 0 {
		t.Fatalf("stopped %q (%q) with the jobs unread", stopped, d.stops())
	}
	if err == nil || !strings.Contains(err.Error(), "jobs dir unreadable") {
		t.Fatalf("err %v", err)
	}
}
