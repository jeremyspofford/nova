package admin

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The request/result files of the Windows admin path (S30b T2). The agent
// writes <id>.req.json atomically into the request directory and starts the
// task; the task (elevated, as the owner) claims it by renaming it to
// <id>.run, runs argv, writes <id>.res.json atomically and removes the claim.
// The agent reads the result and deletes it.
const (
	FileVersion = 1
	// OutputCap bounds stdout and stderr each, as shell.exec's cap.
	OutputCap = 64 << 10
	// MaxTimeout is the longest timeout_s a request may carry (one day).
	MaxTimeout = 86400
	// WaitGrace is how long past a request's own timeout the agent keeps
	// waiting for the result (task start latency + the runner's kill + write).
	WaitGrace = 15 * time.Second
)

// TaskRequest is one request file. TimeoutS is a json.Number so the value
// on disk is read exactly: only a positive whole number ≤ MaxTimeout passes.
type TaskRequest struct {
	V        int         `json:"v"`
	ID       string      `json:"id"`
	Argv     []string    `json:"argv"`
	Cwd      string      `json:"cwd,omitempty"`
	TimeoutS json.Number `json:"timeout_s"`
}

// TaskResult is one result file, written by the task. Said carries a
// cannot or a failure in words; Elevated and User are the task's own token,
// read by the runner, never assumed.
type TaskResult struct {
	V               int    `json:"v"`
	ID              string `json:"id"`
	OK              bool   `json:"ok"`
	ExitCode        int    `json:"exit_code"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	StdoutTruncated bool   `json:"stdout_truncated,omitempty"`
	StderrTruncated bool   `json:"stderr_truncated,omitempty"`
	TimedOut        bool   `json:"timed_out,omitempty"`
	Elevated        bool   `json:"elevated"`
	User            string `json:"user,omitempty"`
	Said            string `json:"said,omitempty"`
}

// NewRequestID is 16 random bytes as 32 lowercase hex characters.
func NewRequestID(rand io.Reader) (string, error) {
	b := make([]byte, 16)
	if _, err := io.ReadFull(rand, b); err != nil {
		return "", fmt.Errorf("reading a request id: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// RequestName, ClaimName and ResultName are the files of request id.
func RequestName(id string) string { return id + ".req.json" }
func ClaimName(id string) string   { return id + ".run" }
func ResultName(id string) string  { return id + ".res.json" }

var (
	idRe      = regexp.MustCompile(`^[0-9a-f]{32}$`)
	requestRe = regexp.MustCompile(`^([0-9a-f]{32})\.req\.json$`)
	wholeRe   = regexp.MustCompile(`^[1-9][0-9]*$`)
)

// PendingRequests is the ids the runner should claim, sorted: only names
// that are exactly <32 lowercase hex>.req.json — never a temp file, a
// claim, a result or anything else.
func PendingRequests(names []string) []string {
	var ids []string
	for _, n := range names {
		if m := requestRe.FindStringSubmatch(n); m != nil {
			ids = append(ids, m[1])
		}
	}
	sort.Strings(ids)
	return ids
}

// WriteFileAtomic writes b to dir/name through a temp file in the same
// directory whose name starts with "." (so PendingRequests never sees it),
// synced, then renamed into place. On any failure no temp file is left.
func WriteFileAtomic(dir, name string, b []byte) error {
	f, err := os.CreateTemp(dir, "."+name+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, filepath.Join(dir, name))
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// EncodeRequest writes a request as JSON with v = FileVersion.
func EncodeRequest(r TaskRequest) ([]byte, error) {
	r.V = FileVersion
	return json.Marshal(r)
}

// timeoutOf is the one rule for timeout_s, given its literal text: a
// positive whole number (digits only, no sign, fraction or exponent) no
// larger than MaxTimeout.
func timeoutOf(lit string) (time.Duration, error) {
	n, err := strconv.Atoi(lit)
	if !wholeRe.MatchString(lit) || err != nil || n > MaxTimeout {
		return 0, fmt.Errorf("timeout_s %s is not a whole number of seconds from 1 to %d", lit, MaxTimeout)
	}
	return time.Duration(n) * time.Second, nil
}

func checkArgv(argv []string) error {
	if len(argv) == 0 {
		return errors.New("argv is empty")
	}
	for i, a := range argv {
		if a == "" {
			return fmt.Errorf("argv[%d] is empty", i)
		}
	}
	return nil
}

// DecodeRequest reads a request file with UseNumber and validates it: v
// must be FileVersion, id 32 lowercase hex, argv non-empty with no ""
// element, timeout_s a positive whole number ≤ MaxTimeout (1.5, "9", 0, -5
// refused naming "timeout_s"). It returns the timeout as a Duration.
func DecodeRequest(b []byte) (TaskRequest, time.Duration, error) {
	// timeout_s is read raw: a json.Number field would also take the
	// string "9".
	var w struct {
		V        int             `json:"v"`
		ID       string          `json:"id"`
		Argv     []string        `json:"argv"`
		Cwd      string          `json:"cwd"`
		TimeoutS json.RawMessage `json:"timeout_s"`
	}
	if len(b) > MaxRequestBytes {
		return TaskRequest{}, 0, fmt.Errorf("the request is over %d bytes", MaxRequestBytes)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&w); err != nil {
		return TaskRequest{}, 0, fmt.Errorf("reading the request: %w", err)
	}
	if w.V != FileVersion {
		return TaskRequest{}, 0, fmt.Errorf("request version %d, this runner reads version %d", w.V, FileVersion)
	}
	if !idRe.MatchString(w.ID) {
		return TaskRequest{}, 0, fmt.Errorf("request id %q is not 32 lowercase hex", w.ID)
	}
	if err := checkArgv(w.Argv); err != nil {
		return TaskRequest{}, 0, err
	}
	if len(w.TimeoutS) == 0 {
		return TaskRequest{}, 0, errors.New("timeout_s is missing")
	}
	d, err := timeoutOf(string(w.TimeoutS))
	if err != nil {
		return TaskRequest{}, 0, err
	}
	return TaskRequest{V: w.V, ID: w.ID, Argv: w.Argv, Cwd: w.Cwd, TimeoutS: json.Number(w.TimeoutS)}, d, nil
}

// RequestFromArgs builds a request from admin.exec's args as the agent
// receives them (a UseNumber-decoded frame: numbers are json.Number):
// argv (array of strings, required), cwd (string, optional), timeout_s
// (whole number, optional → defaultS). The same rules as DecodeRequest.
func RequestFromArgs(id string, args map[string]any, defaultS int) (TaskRequest, error) {
	if !idRe.MatchString(id) {
		return TaskRequest{}, fmt.Errorf("request id %q is not 32 lowercase hex", id)
	}
	raw, ok := args["argv"].([]any)
	if !ok {
		return TaskRequest{}, errors.New("argv must be an array of strings")
	}
	argv := make([]string, 0, len(raw))
	for i, a := range raw {
		s, ok := a.(string)
		if !ok {
			return TaskRequest{}, fmt.Errorf("argv[%d] is not a string", i)
		}
		argv = append(argv, s)
	}
	if err := checkArgv(argv); err != nil {
		return TaskRequest{}, err
	}
	var cwd string
	if c, present := args["cwd"]; present {
		s, ok := c.(string)
		if !ok {
			return TaskRequest{}, errors.New("cwd must be a string")
		}
		cwd = s
	}
	lit := strconv.Itoa(defaultS)
	if t, present := args["timeout_s"]; present {
		n, ok := t.(json.Number)
		if !ok {
			return TaskRequest{}, fmt.Errorf("timeout_s must be a whole number of seconds, not %T", t)
		}
		lit = n.String()
	}
	if _, err := timeoutOf(lit); err != nil {
		return TaskRequest{}, err
	}
	return TaskRequest{V: FileVersion, ID: id, Argv: argv, Cwd: cwd, TimeoutS: json.Number(lit)}, nil
}

// EncodeResult writes a result as JSON with v = FileVersion.
func EncodeResult(r TaskResult) ([]byte, error) {
	r.V = FileVersion
	return json.Marshal(r)
}

// DecodeResult reads a result file; a version other than FileVersion or an
// id other than wantID is an error, never a result.
func DecodeResult(b []byte, wantID string) (TaskResult, error) {
	var r TaskResult
	if err := json.Unmarshal(b, &r); err != nil {
		return TaskResult{}, fmt.Errorf("reading the result: %w", err)
	}
	if r.V != FileVersion {
		return TaskResult{}, fmt.Errorf("result version %d, this agent reads version %d", r.V, FileVersion)
	}
	if r.ID != wantID {
		return TaskResult{}, fmt.Errorf("result is for request %q, not %q", r.ID, wantID)
	}
	return r, nil
}

// CapOutput keeps at most OutputCap bytes and says whether it cut.
func CapOutput(b []byte) (string, bool) {
	if len(b) > OutputCap {
		return string(b[:OutputCap]), true
	}
	return string(b), false
}

// WaitState is what the agent knows on one poll while waiting for a result.
type WaitState struct {
	Elapsed    time.Duration
	Limit      time.Duration // WaitLimit(the request's timeout)
	HaveResult bool          // <id>.res.json exists
	TaskState  string        // TaskRunning | TaskReady | TaskAbsent | TaskDisabled
}

// WaitStep is the decision: Read the result, stop (Done) with Said, or
// poll again (neither).
type WaitStep struct {
	Read bool
	Done bool
	Said string
}

// WaitLimit is how long the agent waits for a request of timeout t.
func WaitLimit(t time.Duration) time.Duration {
	return t + WaitGrace
}

// NextWait decides one poll: a result present is read (whatever the task's
// state); the task gone mid-wait is "cannot: no admin path on this
// machine"; past the limit is "no result from the admin task after <limit>"
// (Done, the caller removes the request); else poll again.
func NextWait(s WaitState) WaitStep {
	switch {
	case s.HaveResult:
		return WaitStep{Read: true, Done: true}
	case s.TaskState == TaskAbsent:
		return WaitStep{Done: true, Said: "cannot: no admin path on this machine"}
	case s.Elapsed >= s.Limit:
		return WaitStep{Done: true, Said: "no result from the admin task after " + s.Limit.String()}
	}
	return WaitStep{}
}

// WhoamiReport is what `novad admin whoami` prints on Windows, run through
// the task for install's elevated round trip.
type WhoamiReport struct {
	User      string `json:"user"`
	SID       string `json:"sid"`
	Elevated  bool   `json:"elevated"`
	Integrity string `json:"integrity"`
}

// ParseWhoami reads that JSON; anything else is an error.
func ParseWhoami(stdout string) (WhoamiReport, error) {
	var r WhoamiReport
	if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &r); err != nil {
		return WhoamiReport{}, fmt.Errorf("whoami said %q, not a report: %w", strings.TrimSpace(stdout), err)
	}
	return r, nil
}
