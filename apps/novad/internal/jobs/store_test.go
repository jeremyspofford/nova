package jobs

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const okID = "0123456789ab"

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	return NewStore(dir), dir
}

func spec(id string, created time.Time) Spec {
	return Spec{ID: id, EnvelopeID: "env-" + id, Argv: []string{"sleep", "200"}, Cwd: "/srv/work",
		EnvKeys: []string{"GH_TOKEN", "_X9"}, Box: &BoxRef{Change: "c0ffee", Container: "nova-box-c0ffee"},
		Heavy: true, Lock: "/srv/repo/deploy/state/cpu.lock", Run: []string{"docker", "exec", "nova-box-c0ffee", "sleep", "200"},
		CreatedAt: created.UTC()}
}

func TestNewStoreRootIsStateDirJobs(t *testing.T) {
	s, dir := newStore(t)
	if s.Root != filepath.Join(dir, "jobs") {
		t.Fatalf("Root = %q, want %q", s.Root, filepath.Join(dir, "jobs"))
	}
	if got := s.Dir(okID); got != filepath.Join(dir, "jobs", okID) {
		t.Fatalf("Dir = %q", got)
	}
}

func TestValidIDAcceptsTwelveLowercaseHexOnly(t *testing.T) {
	for _, id := range []string{okID, "abcdefabcdef", "000000000000"} {
		if err := ValidID(id); err != nil {
			t.Errorf("ValidID(%q) = %v, want nil", id, err)
		}
	}
	for _, id := range []string{"", "0123456789AB", "0123456789a", "0123456789abc", "0123456789ag",
		"../012345678", "01234/6789ab", " 0123456789a"} {
		if err := ValidID(id); err == nil {
			t.Errorf("ValidID(%q) accepted a bad id", id)
		}
	}
}

func TestBadIDIsRefusedEverywhereAndWritesNothing(t *testing.T) {
	s, dir := newStore(t)
	bad := "../escape0001"
	sp := spec(bad, time.Now())
	if err := s.Create(sp); err == nil {
		t.Error("Create accepted a bad id")
	}
	if _, err := s.Get(bad); err == nil {
		t.Error("Get accepted a bad id")
	}
	if _, err := s.Spec(bad); err == nil {
		t.Error("Spec accepted a bad id")
	}
	if err := s.WriteStatus(bad, Status{State: StateRunning}); err == nil {
		t.Error("WriteStatus accepted a bad id")
	}
	if err := s.Mark(bad, MarkerAcked); err == nil {
		t.Error("Mark accepted a bad id")
	}
	if s.Marked(bad, MarkerAcked) {
		t.Error("Marked true for a bad id")
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "jobs" {
			t.Errorf("a bad id wrote %q outside jobs/", e.Name())
		}
	}
}

func TestCreateWritesSpecThatReadsBack(t *testing.T) {
	s, _ := newStore(t)
	want := spec(okID, time.Unix(1_790_000_000, 0))
	if err := s.Create(want); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(s.Dir(okID), "spec.json")); err != nil {
		t.Fatalf("spec.json not written: %v", err)
	}
	got, err := s.Spec(okID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Spec read back %+v, wrote %+v", got, want)
	}
	j, err := s.Get(okID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(j.Spec, want) {
		t.Fatalf("Get spec %+v, wrote %+v", j.Spec, want)
	}
	if j.Status.State != "" {
		t.Fatalf("a never-run job reads state %q, want empty", j.Status.State)
	}
}

func TestCreateTwiceIsRefusedAndKeepsTheFirst(t *testing.T) {
	s, _ := newStore(t)
	first := spec(okID, time.Unix(1_790_000_000, 0))
	if err := s.Create(first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.Argv = []string{"rm", "-rf", "/"}
	if err := s.Create(second); err == nil {
		t.Fatal("a second Create of the same id was accepted")
	}
	got, _ := s.Spec(okID)
	if !reflect.DeepEqual(got.Argv, first.Argv) {
		t.Fatalf("the second Create overwrote argv: %v", got.Argv)
	}
}

func TestCreateRefusesEmptyArgv(t *testing.T) {
	s, _ := newStore(t)
	sp := spec(okID, time.Now())
	sp.Argv = nil
	if err := s.Create(sp); err == nil {
		t.Fatal("empty argv accepted")
	}
	if _, err := os.Stat(s.Dir(okID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused Create left a job dir: %v", err)
	}
}

func TestSpecHasNoEnvValueField(t *testing.T) {
	ty := reflect.TypeOf(Spec{})
	for i := 0; i < ty.NumField(); i++ {
		f := ty.Field(i)
		if f.Type.Kind() == reflect.Map {
			t.Errorf("Spec.%s is a map — env values must never reach spec.json", f.Name)
		}
		if strings.Contains(strings.ToLower(f.Name), "env") && f.Name != "EnvKeys" && f.Name != "EnvelopeID" {
			t.Errorf("Spec.%s looks like an env value field", f.Name)
		}
	}
}

func TestCreateRefusesEnvKeysThatAreNotNames(t *testing.T) {
	for _, k := range []string{"TOKEN=abc", "1X", "", "A-B", "A B"} {
		s, _ := newStore(t)
		sp := spec(okID, time.Now())
		sp.EnvKeys = []string{"OK", k}
		if err := s.Create(sp); err == nil {
			t.Errorf("env key %q accepted", k)
		}
		if _, err := os.Stat(s.Dir(okID)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("env key %q: a refused Create left a job dir", k)
		}
	}
}

func TestSpecJSONCarriesKeyNames(t *testing.T) {
	s, _ := newStore(t)
	if err := s.Create(spec(okID, time.Now())); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(s.Dir(okID), "spec.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"env_keys"`, `"GH_TOKEN"`, `"_X9"`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("spec.json lacks %s:\n%s", want, body)
		}
	}
}

func TestWriteStatusRoundTripsEveryField(t *testing.T) {
	s, _ := newStore(t)
	if err := s.Create(spec(okID, time.Now())); err != nil {
		t.Fatal(err)
	}
	start := time.Unix(1_790_000_100, 0).UTC()
	end := time.Unix(1_790_000_300, 0).UTC()
	code := 3
	want := Status{State: StateDone, PID: 4242, ExitCode: &code, StartedAt: &start, EndedAt: &end,
		Reason: "finished", LockWaitedS: 12.5, LogBytes: 9876}
	if err := s.WriteStatus(okID, want); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(s.Dir(okID), "status.json")); err != nil {
		t.Fatalf("status.json not written: %v", err)
	}
	j, err := s.Get(okID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(j.Status, want) {
		t.Fatalf("read back %+v, wrote %+v", j.Status, want)
	}
	leftovers, _ := filepath.Glob(filepath.Join(s.Dir(okID), ".*"))
	if len(leftovers) != 0 {
		t.Fatalf("a temp file was left in the job dir: %v", leftovers)
	}
}

func TestExitCodeZeroIsPresentNotAbsent(t *testing.T) {
	s, _ := newStore(t)
	if err := s.Create(spec(okID, time.Now())); err != nil {
		t.Fatal(err)
	}
	zero := 0
	if err := s.WriteStatus(okID, Status{State: StateDone, ExitCode: &zero}); err != nil {
		t.Fatal(err)
	}
	j, err := s.Get(okID)
	if err != nil {
		t.Fatal(err)
	}
	if j.Status.ExitCode == nil || *j.Status.ExitCode != 0 {
		t.Fatalf("exit 0 read back as %v — 'done, exit 0' must be distinguishable from no exit code", j.Status.ExitCode)
	}
}

func TestWriteStatusRefusesUnknownState(t *testing.T) {
	s, _ := newStore(t)
	if err := s.Create(spec(okID, time.Now())); err != nil {
		t.Fatal(err)
	}
	for _, st := range []string{"", "finished", "RUNNING"} {
		if err := s.WriteStatus(okID, Status{State: st}); err == nil {
			t.Errorf("state %q accepted", st)
		}
	}
	for _, st := range []string{StateRunning, StateWaitingLock, StateDone, StateFailedToStart, StateStopped, StateLost} {
		if err := s.WriteStatus(okID, Status{State: st}); err != nil {
			t.Errorf("state %q refused: %v", st, err)
		}
	}
}

func TestTerminalStates(t *testing.T) {
	want := map[string]bool{StateRunning: false, StateWaitingLock: false, "": false,
		StateDone: true, StateFailedToStart: true, StateStopped: true, StateLost: true}
	for st, term := range want {
		if got := (Status{State: st}).Terminal(); got != term {
			t.Errorf("Terminal(%q) = %v, want %v", st, got, term)
		}
	}
}

func TestMarkersAreIndependent(t *testing.T) {
	s, _ := newStore(t)
	if err := s.Create(spec(okID, time.Now())); err != nil {
		t.Fatal(err)
	}
	if s.Marked(okID, MarkerAudited) || s.Marked(okID, MarkerAcked) {
		t.Fatal("a fresh job reads marked")
	}
	if err := s.Mark(okID, MarkerAudited); err != nil {
		t.Fatal(err)
	}
	if !s.Marked(okID, MarkerAudited) {
		t.Fatal("audited not marked after Mark")
	}
	if s.Marked(okID, MarkerAcked) {
		t.Fatal("marking audited also marked acked")
	}
	if err := s.Mark(okID, MarkerAcked); err != nil {
		t.Fatal(err)
	}
	if !s.Marked(okID, MarkerAcked) {
		t.Fatal("acked not marked after Mark")
	}
	if err := s.Mark(okID, MarkerAcked); err != nil {
		t.Fatalf("a second Mark failed: %v", err)
	}
}

func TestMarkRefusesOtherNames(t *testing.T) {
	s, _ := newStore(t)
	if err := s.Create(spec(okID, time.Now())); err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{"spec.json", "status.json", "../acked", "done", ""} {
		if err := s.Mark(okID, m); err == nil {
			t.Errorf("marker %q accepted", m)
		}
		if s.Marked(okID, m) {
			t.Errorf("Marked(%q) true", m)
		}
	}
}

func TestListNewestFirstSkippingStrays(t *testing.T) {
	s, _ := newStore(t)
	base := time.Unix(1_790_000_000, 0)
	ids := []struct {
		id string
		at time.Time
	}{
		{"aaaaaaaaaaa1", base},
		{"aaaaaaaaaaa3", base.Add(2 * time.Hour)},
		{"bbbbbbbbbbb1", base.Add(time.Hour)},
		{"aaaaaaaaaaa2", base.Add(time.Hour)},
	}
	for _, x := range ids {
		if err := s.Create(spec(x.id, x.at)); err != nil {
			t.Fatal(err)
		}
	}
	code := 0
	if err := s.WriteStatus("aaaaaaaaaaa3", Status{State: StateDone, ExitCode: &code}); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(s.Root, "stray.txt"), []byte("x"), 0o600)
	os.MkdirAll(filepath.Join(s.Root, "NOT-A-JOB"), 0o700)
	os.MkdirAll(filepath.Join(s.Root, "cccccccccccc"), 0o700) // valid name, no spec
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, j := range got {
		order = append(order, j.Spec.ID)
	}
	want := []string{"aaaaaaaaaaa3", "aaaaaaaaaaa2", "bbbbbbbbbbb1", "aaaaaaaaaaa1"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("List order %v, want %v", order, want)
	}
	if got[0].Status.State != StateDone {
		t.Fatalf("List did not carry status: %+v", got[0].Status)
	}
}

func TestListOfMissingDirIsEmpty(t *testing.T) {
	s, _ := newStore(t)
	got, err := s.List()
	if err != nil || len(got) != 0 {
		t.Fatalf("List of a fresh store = %v, %v", got, err)
	}
}

func TestUnknownJobErrorText(t *testing.T) {
	s, _ := newStore(t)
	id := "fedcba987654"
	want := "no job " + id + " on this device"
	if _, err := s.Get(id); err == nil || err.Error() != want || !errors.Is(err, ErrNoJob) {
		t.Errorf("Get: %v, want exactly %q wrapping ErrNoJob", err, want)
	}
	if _, err := s.Spec(id); err == nil || err.Error() != want || !errors.Is(err, ErrNoJob) {
		t.Errorf("Spec: %v, want exactly %q", err, want)
	}
	if err := s.WriteStatus(id, Status{State: StateLost}); err == nil || err.Error() != want || !errors.Is(err, ErrNoJob) {
		t.Errorf("WriteStatus: %v, want exactly %q", err, want)
	}
	if err := s.Mark(id, MarkerAcked); err == nil || err.Error() != want || !errors.Is(err, ErrNoJob) {
		t.Errorf("Mark: %v, want exactly %q", err, want)
	}
	if _, err := os.Stat(s.Dir(id)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a refused write to an unknown job created its dir")
	}
}
