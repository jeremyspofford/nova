package admin

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// S30b T4: the admin path as read, on every OS (the pure readers).

func TestUnixPathStateNoRootCopyIsAbsent(t *testing.T) {
	got := UnixPathState(false, nil, true)
	want := PathState{Installed: false, Kind: KindNone, State: PathAbsent}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestUnixPathStateCopyAndRuleIsInstalledSudoers(t *testing.T) {
	got := UnixPathState(true, nil, true)
	want := PathState{Installed: true, Kind: KindSudoers, State: PathReady, Left: []string{LeftRootCopy, LeftSudoersRule}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestUnixPathStateCopyWithoutRuleIsIncompleteInSudosWords(t *testing.T) {
	got := UnixPathState(true, errors.New("sudo: a password is required\nmore"), true)
	if got.Installed || got.Kind != KindNone || got.State != PathIncomplete {
		t.Fatalf("got %+v", got)
	}
	if !strings.Contains(got.Said, "a password is required") || !strings.Contains(got.Said, "root copy") {
		t.Fatalf("said = %q: it names the copy and sudo's own words", got.Said)
	}
	if !reflect.DeepEqual(got.Left, []string{LeftRootCopy}) {
		t.Fatalf("left = %q", got.Left)
	}
}

func TestUnixPathStateNoAnswerIsUnknownNeverAbsent(t *testing.T) {
	got := UnixPathState(true, errors.New("sudo gave no answer in time"), false)
	if got.Installed || got.State != PathUnknown || got.Kind != KindNone {
		t.Fatalf("got %+v", got)
	}
	if !strings.Contains(got.Said, "no answer in time") {
		t.Fatalf("said = %q", got.Said)
	}
	// The rule may still be there: uninstall's read-back must not read it gone.
	if !reflect.DeepEqual(got.Left, []string{LeftRootCopy, LeftSudoersRule}) {
		t.Fatalf("left = %q", got.Left)
	}
}

func TestTaskPathStateAbsentIsNotInstalled(t *testing.T) {
	got := TaskPathState(TaskAbsent, nil, false, false, nil)
	want := PathState{Installed: false, Kind: KindNone, State: PathAbsent}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestTaskPathStateTaskPresentIsInstalledTaskWithItsState(t *testing.T) {
	for _, st := range []string{TaskReady, TaskRunning, TaskDisabled} {
		got := TaskPathState(st, nil, true, true, nil)
		want := PathState{Installed: true, Kind: KindTask, State: st, Left: []string{LeftTask, LeftRequestDir, LeftCopyDir}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: got %+v, want %+v", st, got, want)
		}
	}
}

func TestTaskPathStateLeftoversWithoutTheTaskAreIncomplete(t *testing.T) {
	got := TaskPathState(TaskAbsent, nil, false, true, nil)
	if got.Installed || got.Kind != KindNone || got.State != PathIncomplete {
		t.Fatalf("got %+v", got)
	}
	if !reflect.DeepEqual(got.Left, []string{LeftCopyDir}) || !strings.Contains(got.Said, "protected copy") {
		t.Fatalf("got %+v", got)
	}
}

func TestTaskPathStateQueryFailureIsUnknownInItsWords(t *testing.T) {
	got := TaskPathState("", errors.New("schtasks /query: access denied"), false, false, nil)
	if got.Installed || got.State != PathUnknown || !strings.Contains(got.Said, "access denied") {
		t.Fatalf("got %+v", got)
	}
	if !reflect.DeepEqual(got.Left, []string{LeftTask}) {
		t.Fatalf("left = %q: an unread task may still be there", got.Left)
	}
}

// G9: a failed query is "the task may still be there", whatever state
// came with the error — never absent, never removed.
func TestTaskPathStateQueryFailureNeverReadsAsAbsent(t *testing.T) {
	for _, st := range []string{"", TaskAbsent} {
		got := TaskPathState(st, errors.New("schtasks /query: RPC server unavailable"), false, false, nil)
		if got.Installed || got.State != PathUnknown {
			t.Fatalf("state %q: got %+v, want unknown", st, got)
		}
		if !reflect.DeepEqual(got.Left, []string{LeftTask}) {
			t.Fatalf("state %q: left = %q: an unread task may still be there", st, got.Left)
		}
	}
}

func TestPathStateJSONCarriesNoLeft(t *testing.T) {
	b, err := jsonOf(PathState{Installed: true, Kind: KindTask, State: TaskReady, Left: []string{LeftTask}})
	if err != nil {
		t.Fatal(err)
	}
	if b != `{"installed":true,"kind":"task","state":"ready"}` {
		t.Fatalf("got %s", b)
	}
}

func jsonOf(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}

// G10: the agent copy an uninstall through the path moved aside is still on
// disk until the next restart: the read says so (state pending_restart,
// Pending naming it, one line in Said) until it is gone — never absent —
// and it is not a part of the path left (uninstall proved those gone).
func TestTaskPathStatePendingAsideIsReportedUntilGone(t *testing.T) {
	p := `C:\Program Files\Nova\novad-admin-removed-0a1b2c3d.exe`
	got := TaskPathState(TaskAbsent, nil, false, false, []string{p})
	if got.Installed || got.Kind != KindNone || got.State != PathPendingRestart {
		t.Fatalf("got %+v, want not installed, pending_restart", got)
	}
	if !reflect.DeepEqual(got.Pending, []string{p}) || len(got.Left) != 0 {
		t.Fatalf("pending = %q, left = %q", got.Pending, got.Left)
	}
	if !strings.Contains(got.Said, p) || !strings.Contains(got.Said, "next restart") {
		t.Fatalf("said = %q: names the path and when it goes", got.Said)
	}
	b, err := jsonOf(got)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b, `"state":"pending_restart"`) || !strings.Contains(b, `"pending":[`) {
		t.Fatalf("json = %s: the fact carries the leftover", b)
	}
	if gone := TaskPathState(TaskAbsent, nil, false, false, nil); gone.State != PathAbsent || gone.Pending != nil {
		t.Fatalf("once gone: %+v", gone)
	}
	// With the task back (a reinstall before the restart), the task's own
	// state stands and the leftover is still reported.
	if back := TaskPathState(TaskReady, nil, true, true, []string{p}); !back.Installed || back.State != TaskReady || !reflect.DeepEqual(back.Pending, []string{p}) {
		t.Fatalf("reinstalled: %+v", back)
	}
}

// PendingAsides finds exactly what asideRunning leaves behind.
func TestPendingAsidesFindsWhatAsideRunningMoved(t *testing.T) {
	nova := t.TempDir()
	exe := filepath.Join(nova, "Admin", CopyName)
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{exe, filepath.Join(nova, "novad.exe"), filepath.Join(nova, "README.txt")} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if got := PendingAsides(nova); len(got) != 0 {
		t.Fatalf("nothing moved aside yet: %q", got)
	}
	away, err := asideRunning(exe)
	if err != nil {
		t.Fatal(err)
	}
	if got := PendingAsides(nova); !reflect.DeepEqual(got, []string{away}) {
		t.Fatalf("got %q, want [%q]", got, away)
	}
	if got := PendingAsides(filepath.Join(nova, "missing")); len(got) != 0 {
		t.Fatalf("a missing directory has none: %q", got)
	}
}
