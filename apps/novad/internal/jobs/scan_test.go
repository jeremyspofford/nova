package jobs

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// scanJob makes a job with a spec created at created and, when st has a
// state, that record.
func scanJob(t *testing.T, s *Store, id string, created time.Time, st Status) Job {
	t.Helper()
	if err := s.Create(Spec{ID: id, EnvelopeID: "env-" + id, Argv: []string{"sleep", "200"}, CreatedAt: created}); err != nil {
		t.Fatal(err)
	}
	if st.State != "" {
		if err := s.WriteStatus(id, st); err != nil {
			t.Fatal(err)
		}
	}
	j, err := s.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func always(int) bool { return true }

// C2: a live job whose wrapper is gone is written lost, naming the pid.
func TestCheckWrapperGoneIsLost(t *testing.T) {
	s := NewStore(t.TempDir())
	boot := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	started := boot.Add(time.Hour)
	now := boot.Add(2 * time.Hour)
	for _, c := range []struct {
		id string
		st Status
	}{
		{"0000000000a1", Status{State: StateRunning, PID: 4300, WrapperPID: 4242, StartedAt: &started}},
		{"0000000000a2", Status{State: StateWaitingLock, WrapperPID: 4343}},
	} {
		j := scanJob(t, s, c.id, boot.Add(30*time.Minute), c.st)
		var asked int
		got, wrote, err := s.CheckWrapper(j, func(pid int) bool { asked = pid; return false }, boot, now)
		if err != nil || !wrote {
			t.Fatalf("%s: wrote=%v err=%v", c.id, wrote, err)
		}
		if asked != c.st.WrapperPID {
			t.Errorf("%s: asked about pid %d, want the wrapper's %d", c.id, asked, c.st.WrapperPID)
		}
		disk, _ := s.Get(c.id)
		for _, st := range []Status{got.Status, disk.Status} {
			if st.State != StateLost || st.EndedAt == nil || !st.EndedAt.Equal(now) || st.ExitCode != nil {
				t.Errorf("%s: record = %+v, want lost ended %v with no exit code", c.id, st, now)
			}
			if !strings.Contains(st.Reason, "wrapper") || !strings.Contains(st.Reason, itoa(c.st.WrapperPID)) || !strings.Contains(st.Reason, "no record") {
				t.Errorf("%s: reason %q does not name the gone wrapper pid", c.id, st.Reason)
			}
		}
	}
}

// C2: a wrapper pid that is alive but recorded before the last boot is not
// our wrapper — pid reuse never reads as running.
func TestCheckWrapperFromBeforeTheLastBootIsLost(t *testing.T) {
	s := NewStore(t.TempDir())
	boot := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	now := boot.Add(time.Hour)
	before := boot.Add(-time.Hour)
	// running: started_at before boot (spec created after it, so started_at is what counts).
	j1 := scanJob(t, s, "0000000000b1", boot.Add(time.Minute), Status{State: StateRunning, PID: 9, WrapperPID: 8, StartedAt: &before})
	// waiting_lock has no started_at: the spec's created_at counts.
	j2 := scanJob(t, s, "0000000000b2", before, Status{State: StateWaitingLock, WrapperPID: 7})
	for _, j := range []Job{j1, j2} {
		got, wrote, err := s.CheckWrapper(j, always, boot, now)
		if err != nil || !wrote || got.Status.State != StateLost {
			t.Fatalf("%s: %+v wrote=%v err=%v", j.Spec.ID, got.Status, wrote, err)
		}
		if !strings.Contains(got.Status.Reason, "before this machine's last boot") {
			t.Errorf("%s: reason %q does not say it predates the boot", j.Spec.ID, got.Status.Reason)
		}
	}
}

// C2: alive and since the boot (or the boot unknown) -> left running.
func TestCheckWrapperAliveSinceTheBootStays(t *testing.T) {
	s := NewStore(t.TempDir())
	boot := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	after := boot.Add(time.Minute)
	before := boot.Add(-time.Hour)
	j1 := scanJob(t, s, "0000000000c1", after, Status{State: StateRunning, PID: 9, WrapperPID: 8, StartedAt: &after})
	// Boot unknown (zero): an alive pid cannot be judged by it.
	j2 := scanJob(t, s, "0000000000c2", before, Status{State: StateRunning, PID: 9, WrapperPID: 8, StartedAt: &before})
	for _, c := range []struct {
		j    Job
		boot time.Time
	}{{j1, boot}, {j2, time.Time{}}} {
		raw, _ := os.ReadFile(filepath.Join(s.Dir(c.j.Spec.ID), StatusFile))
		got, wrote, err := s.CheckWrapper(c.j, always, c.boot, boot.Add(time.Hour))
		if err != nil || wrote || got.Status.State != StateRunning {
			t.Fatalf("%s: %+v wrote=%v err=%v", c.j.Spec.ID, got.Status, wrote, err)
		}
		after, _ := os.ReadFile(filepath.Join(s.Dir(c.j.Spec.ID), StatusFile))
		if string(raw) != string(after) {
			t.Errorf("%s: the record changed: %s -> %s", c.j.Spec.ID, raw, after)
		}
	}
}

// C2: a wrapper that wrote its terminal record and exited between the
// scanner's read and its pid check keeps that record.
func TestCheckWrapperKeepsARecordWrittenMeanwhile(t *testing.T) {
	s := NewStore(t.TempDir())
	boot := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	started := boot.Add(time.Minute)
	j := scanJob(t, s, "0000000000d1", started, Status{State: StateRunning, PID: 9, WrapperPID: 8, StartedAt: &started})
	zero := 0
	ended := boot.Add(2 * time.Minute)
	alive := func(int) bool {
		// The wrapper finishes now: its record, then its exit.
		if err := s.WriteStatus("0000000000d1", Status{State: StateDone, PID: 9, WrapperPID: 8, ExitCode: &zero, StartedAt: &started, EndedAt: &ended}); err != nil {
			t.Fatal(err)
		}
		return false
	}
	got, wrote, err := s.CheckWrapper(j, alive, boot, boot.Add(time.Hour))
	if err != nil || wrote {
		t.Fatalf("wrote=%v err=%v", wrote, err)
	}
	disk, _ := s.Get("0000000000d1")
	for _, st := range []Status{got.Status, disk.Status} {
		if st.State != StateDone || st.ExitCode == nil || *st.ExitCode != 0 {
			t.Errorf("record = %+v, want the wrapper's done exit 0", st)
		}
	}
}

// C2: a terminal job and a job with no record yet (inside the spawn
// window) are left alone.
func TestCheckWrapperLeavesTerminalAndRecordlessJobs(t *testing.T) {
	s := NewStore(t.TempDir())
	boot := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	seven := 7
	j1 := scanJob(t, s, "0000000000e1", boot, Status{State: StateDone, WrapperPID: 8, ExitCode: &seven})
	// Record-less but younger than the spawn window: Spawn still owns it
	// (amended C2, 2026-10-12).
	now := boot.Add(time.Hour)
	j2 := scanJob(t, s, "0000000000e2", now.Add(-time.Second), Status{})
	for _, j := range []Job{j1, j2} {
		got, wrote, err := s.CheckWrapper(j, func(int) bool { t.Errorf("%s: asked about a pid", j.Spec.ID); return false }, boot, now)
		if err != nil || wrote || got.Status.State != j.Status.State {
			t.Errorf("%s: %+v wrote=%v err=%v", j.Spec.ID, got.Status, wrote, err)
		}
	}
}

func TestProcessAlive(t *testing.T) {
	if !ProcessAlive(os.Getpid()) {
		t.Error("this process reads as not alive")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if ProcessAlive(cmd.Process.Pid) {
		t.Errorf("an exited child (pid %d) reads as alive", cmd.Process.Pid)
	}
}

func TestBootTimeIsBeforeThisProcess(t *testing.T) {
	boot, err := BootTime()
	if err != nil {
		t.Fatal(err)
	}
	if !boot.Before(time.Now()) || boot.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("boot time %v is not a past boot", boot)
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

// C2: a live record that names no wrapper pid is lost (nothing watches it),
// and no pid is asked about.
func TestCheckWrapperWithNoWrapperPidIsLost(t *testing.T) {
	s := NewStore(t.TempDir())
	boot := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	started := boot.Add(time.Minute)
	j := scanJob(t, s, "0000000000f1", started, Status{State: StateRunning, PID: 9, StartedAt: &started})
	got, wrote, err := s.CheckWrapper(j, func(int) bool { t.Error("asked about pid 0"); return true }, boot, boot.Add(time.Hour))
	if err != nil || !wrote || got.Status.State != StateLost || !strings.Contains(got.Status.Reason, "no wrapper pid") {
		t.Fatalf("%+v wrote=%v err=%v", got.Status, wrote, err)
	}
}

// Amended C2: a record-less job past the spawn window, or created before
// the last boot, is lost — the agent that started it ended before its
// wrapper wrote a record. No pid is asked about (there is none).
func TestCheckWrapperJudgesAnOldRecordlessJobLost(t *testing.T) {
	s := NewStore(t.TempDir())
	boot := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	now := boot.Add(time.Hour)
	for _, c := range []struct {
		id      string
		created time.Time
		why     string
	}{
		{"000000000101", now.Add(-time.Minute), "past the spawn window"},
		{"000000000102", now.Add(-2*SpawnWait - time.Second), "just past the spawn window"},
		{"000000000103", boot.Add(-time.Second), "before the last boot"},
	} {
		bootNow := boot
		if c.id == "000000000103" {
			// boot moments ago: the job is younger than the window but older than the boot.
			bootNow = now.Add(-time.Second)
			c.created = now.Add(-2 * time.Second)
		}
		j := scanJob(t, s, c.id, c.created, Status{})
		got, wrote, err := s.CheckWrapper(j, func(int) bool { t.Errorf("%s: asked about a pid", c.id); return true }, bootNow, now)
		if err != nil || !wrote {
			t.Fatalf("%s (%s): wrote=%v err=%v", c.id, c.why, wrote, err)
		}
		disk, _ := s.Get(c.id)
		for _, st := range []Status{got.Status, disk.Status} {
			if st.State != StateLost || st.EndedAt == nil || !st.EndedAt.Equal(now) || st.ExitCode != nil {
				t.Errorf("%s (%s): record = %+v, want lost ended %v", c.id, c.why, st, now)
			}
			if !strings.Contains(st.Reason, "before its wrapper wrote a record") || !strings.Contains(st.Reason, "unknown") {
				t.Errorf("%s (%s): reason %q", c.id, c.why, st.Reason)
			}
		}
	}
	// Inside the window and after the boot: left alone, nothing on disk.
	young := scanJob(t, s, "000000000104", now.Add(-2*SpawnWait+time.Second), Status{})
	got, wrote, err := s.CheckWrapper(young, always, boot, now)
	if err != nil || wrote || got.Status.State != "" {
		t.Fatalf("young: %+v wrote=%v err=%v", got.Status, wrote, err)
	}
	if _, err := os.Stat(filepath.Join(s.Dir("000000000104"), StatusFile)); !os.IsNotExist(err) {
		t.Errorf("young: a status file was written (%v)", err)
	}
}

// Amended C2: a record-less job whose wrapper writes its first record
// between the caller's read and the verdict keeps that record.
func TestCheckWrapperKeepsAFirstRecordWrittenMeanwhile(t *testing.T) {
	s := NewStore(t.TempDir())
	boot := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	now := boot.Add(time.Hour)
	j := scanJob(t, s, "000000000201", now.Add(-time.Minute), Status{})
	started := now.Add(-time.Second)
	if err := s.WriteStatus("000000000201", Status{State: StateRunning, PID: 9, WrapperPID: 8, StartedAt: &started}); err != nil {
		t.Fatal(err)
	}
	got, wrote, err := s.CheckWrapper(j, always, boot, now)
	if err != nil || wrote {
		t.Fatalf("wrote=%v err=%v", wrote, err)
	}
	disk, _ := s.Get("000000000201")
	for _, st := range []Status{got.Status, disk.Status} {
		if st.State != StateRunning || st.WrapperPID != 8 {
			t.Errorf("record = %+v, want the wrapper's running", st)
		}
	}
}

// badJobDir plants a job dir whose spec.json is not JSON.
func badJobDir(t *testing.T, s *Store, id string) {
	t.Helper()
	if err := os.MkdirAll(s.Dir(id), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Dir(id), SpecFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// Amended C7: ListAll returns the readable jobs and names each unreadable
// one with why; List and LiveBoxes stay strict.
func TestListAllNamesAnUnreadableJobAndKeepsTheRest(t *testing.T) {
	s := NewStore(t.TempDir())
	t0 := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	scanJob(t, s, "000000000301", t0, Status{State: StateRunning, WrapperPID: 8})
	badJobDir(t, s, "000000000302")
	scanJob(t, s, "000000000303", t0.Add(time.Hour), Status{})
	all, bad, err := s.ListAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].Spec.ID != "000000000303" || all[1].Spec.ID != "000000000301" {
		t.Fatalf("readable = %v, want 303 then 301", all)
	}
	if len(bad) != 1 || bad[0].ID != "000000000302" || bad[0].Err == nil {
		t.Fatalf("unreadable = %+v, want 302 with its error", bad)
	}
	if _, err := s.List(); err == nil {
		t.Error("List read past an unreadable job")
	}
	if _, err := s.LiveBoxes(); err == nil {
		t.Error("LiveBoxes read past an unreadable job")
	}
	// No jobs dir at all: nothing, no error.
	if all, bad, err := NewStore(t.TempDir()).ListAll(); err != nil || len(all)+len(bad) != 0 {
		t.Errorf("empty store: %v %v %v", all, bad, err)
	}
}
