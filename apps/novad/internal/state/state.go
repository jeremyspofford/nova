// Package state is novad's local record of itself, in its state directory
// (S42b): which process holds an identity (the locks), what the running agent
// last said about its connection (agent-status.json), what its supervisor is
// doing (supervisor-status.json), and the last update it staged or applied
// (update.json). `install` reads these to prove an agent came up, `supervise`
// to confirm a new build, `novad status` to say what runs, and the facts to
// report an update's outcome. Every file is written whole — a temp file
// renamed over it — so a reader never sees half a status.
package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	AgentStatusFile      = "agent-status.json"
	SupervisorStatusFile = "supervisor-status.json"
	UpdateFile           = "update.json"
	RunLockFile          = "run.lock"
	SuperviseLockFile    = "supervise.lock"
	LogFile              = "novad.log"
)

// The agent's states, in the order a healthy run passes through them.
const (
	StateStarting   = "starting"
	StateConnecting = "connecting"
	StateReady      = "ready"
	StateStopped    = "stopped"
)

// An update's outcomes: staged by daemon.update; applied or rolled_back by
// supervise after the swap.
const (
	UpdateStaged     = "staged"
	UpdateApplied    = "applied"
	UpdateRolledBack = "rolled_back"
)

// AgentStatus is written by `novad run` at each change of connection state.
// Ready means core accepted the handshake on Server at Since.
type AgentStatus struct {
	V       int       `json:"v"`
	PID     int       `json:"pid"`
	Version string    `json:"version"`
	Mode    string    `json:"mode"`
	State   string    `json:"state"`
	Server  string    `json:"server"`
	Since   time.Time `json:"since"`
	Error   string    `json:"error"`
}

// SupervisorStatus is written by `novad supervise` each time it starts an
// agent or sees one exit.
type SupervisorStatus struct {
	V        int       `json:"v"`
	PID      int       `json:"pid"`
	Version  string    `json:"version"`
	Mode     string    `json:"mode"`
	ChildPID int       `json:"child_pid"`
	Restarts int       `json:"restarts"`
	LastExit *int      `json:"last_exit"`
	Since    time.Time `json:"since"`
}

// Update is the last update this machine staged, applied or rolled back.
type Update struct {
	V       int       `json:"v"`
	Version string    `json:"version"`
	SHA256  string    `json:"sha256"`
	Staged  string    `json:"staged"`
	Outcome string    `json:"outcome"`
	Reason  string    `json:"reason"`
	At      time.Time `json:"at"`
}

// WriteJSON writes v to path whole. The rename is retried briefly: on
// Windows a reader holding the old file open can refuse it for a moment.
func WriteJSON(path string, v any) error {
	body, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(append(body, '\n')); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	for i := 0; ; i++ {
		err = os.Rename(name, path)
		if err == nil || i == 9 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		os.Remove(name)
	}
	return err
}

// ReadJSON reads path into v. A missing file stays fs.ErrNotExist (errors.Is),
// so "never written" reads differently from "unreadable".
func ReadJSON(path string, v any) error {
	body, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, v); err != nil {
		return fmt.Errorf("%s is unreadable: %w", path, err)
	}
	return nil
}
