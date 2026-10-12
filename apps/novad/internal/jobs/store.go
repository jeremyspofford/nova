// Package jobs is novad's record of work that outlives a turn (S30c). Each
// job owns a directory <StateDir>/jobs/<id>: spec.json (what to run, written
// once by the agent at job.start), status.json (where it is, written whole by
// the `novad job-exec` wrapper, or `lost` by the agent's scanner when the
// wrapper is gone), the log, and two empty marker files — `audited` (the
// scanner appended the job's one terminal audit entry) and `acked` (core
// stored the terminal `job` frame). Env VALUES never reach this directory:
// a spec carries the variable names only, and the wrapper receives the values
// through its own process environment.
package jobs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"novad/internal/state"
)

// ErrNoJob is what every lookup of an id with no job directory wraps; its
// message (via noJobError) is the exact sentence core quotes to her.
var ErrNoJob = errors.New("no job")

type noJobError struct{ id string }

func (e *noJobError) Error() string { return "no job " + e.id + " on this device" }
func (e *noJobError) Is(target error) bool {
	return target == ErrNoJob
}

// A job's states. running and waiting_lock are live; the rest are terminal.
const (
	StateRunning       = "running"
	StateWaitingLock   = "waiting_lock"
	StateDone          = "done"
	StateFailedToStart = "failed_to_start"
	StateStopped       = "stopped"
	StateLost          = "lost"
)

// The markers a job dir can carry.
const (
	MarkerAudited = "audited"
	MarkerAcked   = "acked"
)

const (
	SpecFile   = "spec.json"
	StatusFile = "status.json"
)

var (
	idRe     = regexp.MustCompile(`^[0-9a-f]{12}$`)
	envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	states   = map[string]bool{StateRunning: true, StateWaitingLock: true, StateDone: true,
		StateFailedToStart: true, StateStopped: true, StateLost: true}
	terminal = map[string]bool{StateDone: true, StateFailedToStart: true, StateStopped: true, StateLost: true}
	markers  = map[string]bool{MarkerAudited: true, MarkerAcked: true}
)

// BoxRef names the change box a job runs in (Linux hub only).
type BoxRef struct {
	Change    string `json:"change"`
	Container string `json:"container"`
}

// Spec is what a job runs. EnvKeys are names only — never values. Argv is
// her command, the one every record quotes; Run, when set, is what the
// wrapper executes instead (a box job's `docker exec ... <argv>`), and Cwd is
// then the box's, never entered on the host. A Heavy job's wrapper holds the
// flock at Lock for the job's whole life.
type Spec struct {
	ID         string    `json:"id"`
	EnvelopeID string    `json:"envelope_id"`
	Argv       []string  `json:"argv"`
	Cwd        string    `json:"cwd,omitempty"`
	EnvKeys    []string  `json:"env_keys,omitempty"`
	Box        *BoxRef   `json:"box,omitempty"`
	Heavy      bool      `json:"heavy,omitempty"`
	Lock       string    `json:"lock,omitempty"`
	Run        []string  `json:"run,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// Status is where a job is. ExitCode is a pointer so exit 0 reads as present.
type Status struct {
	State       string     `json:"state"`
	PID         int        `json:"pid,omitempty"`
	WrapperPID  int        `json:"wrapper_pid,omitempty"`
	ExitCode    *int       `json:"exit_code,omitempty"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	EndedAt     *time.Time `json:"ended_at,omitempty"`
	Reason      string     `json:"reason,omitempty"`
	LockWaitedS float64    `json:"lock_waited_s,omitempty"`
	LogBytes    int64      `json:"log_bytes"`
}

// Terminal reports whether the job has ended, however it ended.
func (s Status) Terminal() bool { return terminal[s.State] }

// Job is a spec with its latest status (zero State before the wrapper ran).
type Job struct {
	Spec   Spec   `json:"spec"`
	Status Status `json:"status"`
}

// Store reads and writes job directories under Root.
type Store struct{ Root string }

// NewStore is the store at <stateDir>/jobs.
func NewStore(stateDir string) *Store { return &Store{Root: filepath.Join(stateDir, "jobs")} }

// ValidID accepts exactly 12 lowercase hex characters (core generates them).
func ValidID(id string) error {
	if !idRe.MatchString(id) {
		return fmt.Errorf("job id %q is not 12 lowercase hex characters", id)
	}
	return nil
}

// ValidEnvKey accepts a plain variable name: ^[A-Za-z_][A-Za-z0-9_]*$.
func ValidEnvKey(k string) error {
	if !envKeyRe.MatchString(k) {
		return fmt.Errorf("env key %q is not a variable name", k)
	}
	return nil
}

// Dir is the job's directory. It does not validate id; callers that touch
// the disk go through existing(), which does.
func (s *Store) Dir(id string) string { return filepath.Join(s.Root, id) }

// existing validates id and confirms the job has a spec.
func (s *Store) existing(id string) (string, error) {
	if err := ValidID(id); err != nil {
		return "", err
	}
	dir := s.Dir(id)
	if _, err := os.Stat(filepath.Join(dir, SpecFile)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", &noJobError{id: id}
		}
		return "", err
	}
	return dir, nil
}

// Create writes a new job's spec. It refuses a bad id, an id already used,
// empty argv and any env key that is not a plain variable name.
func (s *Store) Create(spec Spec) error {
	if err := ValidID(spec.ID); err != nil {
		return err
	}
	if len(spec.Argv) == 0 {
		return errors.New("job argv is empty")
	}
	for _, k := range spec.EnvKeys {
		if err := ValidEnvKey(k); err != nil {
			return err
		}
	}
	// The lock is the Linux hub's (box jobs are Linux-only): a slash path on
	// every GOOS, as package box writes it.
	if spec.Heavy && !path.IsAbs(spec.Lock) {
		return fmt.Errorf("a heavy job needs the absolute path of the CPU lock it holds, got lock %q", spec.Lock)
	}
	if err := os.MkdirAll(s.Root, 0o700); err != nil {
		return err
	}
	dir := s.Dir(spec.ID)
	// Mkdir (not MkdirAll) is the exclusive claim on the id.
	if err := os.Mkdir(dir, 0o700); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("job %s already exists on this device", spec.ID)
		}
		return err
	}
	if err := state.WriteJSON(filepath.Join(dir, SpecFile), spec); err != nil {
		os.RemoveAll(dir)
		return err
	}
	return nil
}

// Spec reads a job's spec.
func (s *Store) Spec(id string) (Spec, error) {
	dir, err := s.existing(id)
	if err != nil {
		return Spec{}, err
	}
	var sp Spec
	if err := state.ReadJSON(filepath.Join(dir, SpecFile), &sp); err != nil {
		return Spec{}, err
	}
	return sp, nil
}

// Get reads a job's spec and status. A job whose wrapper has not written a
// status yet has a zero Status.
func (s *Store) Get(id string) (Job, error) {
	sp, err := s.Spec(id)
	if err != nil {
		return Job{}, err
	}
	var st Status
	if err := state.ReadJSON(filepath.Join(s.Dir(id), StatusFile), &st); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return Job{}, err
	}
	return Job{Spec: sp, Status: st}, nil
}

// WriteStatus replaces the job's status whole.
func (s *Store) WriteStatus(id string, st Status) error {
	if !states[st.State] {
		return fmt.Errorf("job state %q is not one of running, waiting_lock, done, failed_to_start, stopped, lost", st.State)
	}
	dir, err := s.existing(id)
	if err != nil {
		return err
	}
	return state.WriteJSON(filepath.Join(dir, StatusFile), st)
}

// Mark sets one of the job's markers (idempotent).
func (s *Store) Mark(id, marker string) error {
	if !markers[marker] {
		return fmt.Errorf("%q is not a job marker", marker)
	}
	dir, err := s.existing(id)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, marker), nil, 0o600)
}

// Marked reports whether the job carries marker.
func (s *Store) Marked(id, marker string) bool {
	if !markers[marker] || ValidID(id) != nil {
		return false
	}
	_, err := os.Stat(filepath.Join(s.Dir(id), marker))
	return err == nil
}

// BadJob is a job directory that could not be read, and why.
type BadJob struct {
	ID  string
	Err error
}

// ListAll returns every readable job, newest first (ties by id), and each
// job directory that could not be read, by id, with why: one bad directory
// never hides the rest. Entries that are not a job directory with a spec
// are skipped. The error is only for the jobs directory itself.
func (s *Store) ListAll() ([]Job, []BadJob, error) {
	entries, err := os.ReadDir(s.Root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	var out []Job
	var bad []BadJob
	for _, e := range entries {
		if !e.IsDir() || ValidID(e.Name()) != nil {
			continue
		}
		j, err := s.Get(e.Name())
		if err != nil {
			if errors.Is(err, ErrNoJob) {
				continue
			}
			bad = append(bad, BadJob{ID: e.Name(), Err: err})
			continue
		}
		out = append(out, j)
	}
	sort.Slice(out, func(a, b int) bool {
		ta, tb := out[a].Spec.CreatedAt, out[b].Spec.CreatedAt
		if !ta.Equal(tb) {
			return ta.After(tb)
		}
		return out[a].Spec.ID < out[b].Spec.ID
	})
	return out, bad, nil
}

// List is ListAll held strict: any unreadable job is an error (LiveBoxes
// reads it, and Reap never stops a box on doubt).
func (s *Store) List() ([]Job, error) {
	all, bad, err := s.ListAll()
	if err != nil {
		return nil, err
	}
	if len(bad) > 0 {
		return nil, fmt.Errorf("job %s: %w", bad[0].ID, bad[0].Err)
	}
	return all, nil
}

// LiveBoxes is the changes whose box runs a job that has not ended —
// running, waiting for the CPU lock, or spawned with no record yet. The box
// manager's Reap reads it (box.Manager.Busy): a box with a live job is never
// stopped. An unreadable job is an error, never "not live".
func (s *Store) LiveBoxes() (map[string]bool, error) {
	all, err := s.List()
	if err != nil {
		return nil, err
	}
	live := map[string]bool{}
	for _, j := range all {
		if j.Spec.Box != nil && !j.Status.Terminal() {
			live[j.Spec.Box.Change] = true
		}
	}
	return live, nil
}
