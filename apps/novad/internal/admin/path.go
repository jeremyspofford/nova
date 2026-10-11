package admin

import (
	"os"
	"path/filepath"
	"strings"
)

// The admin path as read from the machine (S30b T4): what the agent's facts
// report as admin_path and what admin.install / admin.uninstall read back.
// It is read every time it is asked for, from the machine — never
// remembered from an install.

// Kinds of admin path.
const (
	KindSudoers = "sudoers" // unix: the drop-in naming the root copy (T1)
	KindTask    = "task"    // windows: the elevated task \Nova\NovaAdmin (T2)
	KindNone    = "none"
)

// States of the path beyond the task's own (TaskReady, TaskRunning,
// TaskDisabled): installed and answering (unix), nothing there, part of it
// there, and a read that gave no answer.
const (
	PathReady      = "ready"
	PathAbsent     = "absent"
	PathIncomplete = "incomplete"
	PathUnknown    = "unknown"
	// PathPendingRestart: nothing of the path runs or answers, but the
	// agent copy an uninstall moved aside is still on disk until the next
	// restart deletes it (Pending names it).
	PathPendingRestart = "pending_restart"
)

// PathState is the admin path as read now. Installed is true only when the
// whole path reads back (unix: the root copy and a rule allowing it;
// windows: the task). Said is one line when the read failed or found it
// incomplete. Left names each part of the path still on the machine —
// uninstall's read-back — and is not a fact.
type PathState struct {
	Installed bool   `json:"installed"`
	Kind      string `json:"kind"`
	State     string `json:"state"`
	Said      string `json:"said,omitempty"`
	// Pending names each moved-aside agent copy still on disk, deleted at
	// the next restart (windows uninstall through the path): a fact,
	// reported until it is gone.
	Pending []string `json:"pending,omitempty"`
	Left    []string `json:"-"`
}

// What of the path Left names.
const (
	LeftRootCopy    = "the root copy " + "/usr/local/libexec/nova/novad"
	LeftSudoersRule = "the sudoers rule allowing it"
	LeftTask        = "the task " + TaskPath
	LeftRequestDir  = "the request directory"
	LeftCopyDir     = "the protected copy"
)

// UnixPathState reads the unix path from what was read: whether the root
// copy is there, and `sudo -n -l <copy> admin exec`'s answer — listErr nil
// when sudo allows it, else its error; answered false when sudo gave no
// answer at all (it never started, or ran out of time), which is unknown,
// never absent.
func UnixPathState(copyPresent bool, listErr error, answered bool) PathState {
	switch {
	case !copyPresent:
		return PathState{Kind: KindNone, State: PathAbsent}
	case !answered:
		return PathState{Kind: KindNone, State: PathUnknown, Said: firstLine("sudo did not answer whether the rule allows the root copy: " + errText(listErr)),
			Left: []string{LeftRootCopy, LeftSudoersRule}}
	case listErr != nil:
		return PathState{Kind: KindNone, State: PathIncomplete, Said: firstLine("the root copy is there but sudo does not allow it: " + errText(listErr)),
			Left: []string{LeftRootCopy}}
	}
	return PathState{Installed: true, Kind: KindSudoers, State: PathReady, Left: []string{LeftRootCopy, LeftSudoersRule}}
}

// TaskPathState reads the windows path from the task's state as
// Scheduler.Query answered it (queryErr when it failed: unknown) and
// whether the request directory and the protected copy's directory are on
// disk.
func TaskPathState(taskState string, queryErr error, dirPresent, copyPresent bool, pending []string) PathState {
	var left []string
	if queryErr != nil || taskState != TaskAbsent {
		left = append(left, LeftTask)
	}
	if dirPresent {
		left = append(left, LeftRequestDir)
	}
	if copyPresent {
		left = append(left, LeftCopyDir)
	}
	pending = append([]string(nil), pending...)
	if len(pending) == 0 {
		pending = nil
	}
	switch {
	case queryErr != nil:
		return PathState{Kind: KindNone, State: PathUnknown, Said: firstLine("the task could not be read: " + queryErr.Error()), Pending: pending, Left: left}
	case taskState != TaskAbsent:
		return PathState{Installed: true, Kind: KindTask, State: taskState, Pending: pending, Left: left}
	case len(left) > 0:
		return PathState{Kind: KindNone, State: PathIncomplete, Said: "the task is absent but " + strings.Join(left, " and ") + " is still there", Pending: pending, Left: left}
	case pending != nil:
		return PathState{Kind: KindNone, State: PathPendingRestart, Said: PendingWords(pending), Pending: pending}
	}
	return PathState{Kind: KindNone, State: PathAbsent}
}

// PendingWords says what of the path is only scheduled to go: the moved-
// aside agent copy, by path, deleted at the next restart.
func PendingWords(pending []string) string {
	if len(pending) == 1 {
		return "the agent copy is moved aside to " + pending[0] + " and is deleted at the next restart"
	}
	return "the agent copies are moved aside to " + strings.Join(pending, " and ") + " and are deleted at the next restart"
}

// PendingAsides lists the agent copies an uninstall moved aside
// (asideRunning: novad-admin-removed-* in novaDir, the copy directory's
// parent) still on disk.
func PendingAsides(novaDir string) []string {
	entries, err := os.ReadDir(novaDir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.Type().IsRegular() && strings.HasPrefix(e.Name(), AsidePrefix) {
			out = append(out, filepath.Join(novaDir, e.Name()))
		}
	}
	return out
}

// AsidePrefix names a moved-aside agent copy (asideRunning).
const AsidePrefix = "novad-admin-removed-"

func errText(err error) string {
	if err == nil {
		return "no answer"
	}
	return err.Error()
}

// firstLine is s up to its first line break, trimmed.
func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	return s
}
