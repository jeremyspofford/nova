package jobs

import (
	"fmt"
	"time"
)

// RecordlessWindow is how long a job may have no record before the scanner
// judges it lost: twice SpawnWait, past which a live agent's Spawn has
// written failed_to_start itself, so no record means the agent that started
// it ended inside Spawn.
func RecordlessWindow() time.Duration { return 2 * SpawnWait }

// CheckWrapper is the agent scanner's verdict on one job (S30c). A running,
// waiting_lock or record-less job is judged; a terminal job comes back
// unchanged. A record-less job is lost once it is older than
// RecordlessWindow or was created before the last boot; younger, Spawn
// still owns it and it is left alone. A live job is lost — written here,
// with ended_at now — when its wrapper pid is not alive, or when it is alive but the record predates
// this machine's last boot: a pid from before a reboot is someone else's
// process now, never our wrapper. A zero boot means it could not be read,
// and then only a dead pid is judged. A wrapper that wrote its terminal
// record and exited between the caller's read and the pid check keeps that
// record: the status is read again after the pid is found dead, and a dead
// wrapper writes nothing more. wrote reports whether lost was written.
func (s *Store) CheckWrapper(j Job, alive func(int) bool, boot, now time.Time) (Job, bool, error) {
	if j.Status.State != StateRunning && j.Status.State != StateWaitingLock && j.Status.State != "" {
		return j, false, nil
	}
	pid := j.Status.WrapperPID
	var reason string
	switch {
	case j.Status.State == "":
		created := j.Spec.CreatedAt
		window := RecordlessWindow()
		switch {
		case !boot.IsZero() && created.Before(boot):
			reason = fmt.Sprintf("it was created at %s, before this machine's last boot at %s, and the agent that started it ended before its wrapper wrote a record; how it ended is unknown",
				created.UTC().Format(time.RFC3339), boot.UTC().Format(time.RFC3339))
		case now.Sub(created) > window:
			reason = fmt.Sprintf("it was created at %s, more than %v ago, and the agent that started it ended before its wrapper wrote a record; how it ended is unknown",
				created.UTC().Format(time.RFC3339), window)
		default:
			return j, false, nil // Spawn still owns it
		}
	case pid <= 0:
		reason = "its record names no wrapper pid, so nothing watches it; how it ended is unknown"
	case !alive(pid):
		reason = fmt.Sprintf("its wrapper (pid %d) is gone and left no record of how the job ended", pid)
	default:
		recorded := j.Spec.CreatedAt
		if j.Status.StartedAt != nil {
			recorded = *j.Status.StartedAt
		}
		if boot.IsZero() || !recorded.Before(boot) {
			return j, false, nil
		}
		reason = fmt.Sprintf("its wrapper (pid %d) was recorded at %s, before this machine's last boot at %s; the job did not survive the reboot and pid %d is another process now",
			pid, recorded.UTC().Format(time.RFC3339), boot.UTC().Format(time.RFC3339), pid)
	}
	// Read again: the wrapper may have written its end before it exited.
	fresh, err := s.Get(j.Spec.ID)
	if err != nil {
		return j, false, err
	}
	if fresh.Status.State != j.Status.State || fresh.Status.WrapperPID != pid {
		return fresh, false, nil
	}
	st := fresh.Status
	ended := now.UTC()
	st.State = StateLost
	st.EndedAt = &ended
	st.ExitCode = nil
	st.Reason = reason
	if err := s.WriteStatus(j.Spec.ID, st); err != nil {
		return fresh, false, err
	}
	fresh.Status = st
	return fresh, true, nil
}
