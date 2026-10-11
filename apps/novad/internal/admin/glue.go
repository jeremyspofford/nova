package admin

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// The Windows admin path's glue, OS-neutral so every decision runs under
// test on any OS: install, uninstall, the task's runner and the agent's
// submit, each over the seams below. task_windows.go supplies the real
// seams (schtasks.exe, Get/SetNamedSecurityInfo, CreateDirectory with a
// descriptor, a kill-on-close job object).

// MaxRequestBytes bounds one request file (64 KiB): the runner reads at
// most this many bytes plus one, and a larger file is refused unrun; the
// agent refuses to write one. A Windows command line is at most 32767
// UTF-16 units, so no runnable argv needs more.
const MaxRequestBytes = 64 << 10

// FileOwners reads a file's owner SID (the seam).
type FileOwners interface {
	Owner(path string) (string, error)
}

// ProcOutcome is how one run ended. Failed: it never reached an exit code
// of its own (could not start, the wait failed); Said says why.
type ProcOutcome struct {
	ExitCode int
	TimedOut bool
	Failed   bool
	Said     string
}

// ProcRunner runs one request's argv in cwd, writing its output to stdout
// and stderr, and kills everything it started at the deadline (the seam).
type ProcRunner interface {
	Run(ctx context.Context, argv []string, cwd string, timeout time.Duration, stdout, stderr io.Writer) ProcOutcome
}

// Host is everything the glue touches.
type Host struct {
	Sched  Scheduler
	ACL    DirACL
	Owners FileOwners
	Proc   ProcRunner
	Dir    string // the request directory
	// SignedIn reports whether the owner has an interactive session (the
	// task runs only then); nil reads as not signed in.
	SignedIn  func() bool
	Poll      time.Duration      // Submit's poll interval; 0 = 500 ms
	RemoveAll func(string) error // nil = os.RemoveAll

	// The protected copy (G7). CopyDir is where install writes it;
	// CopyExe is the path the task is registered against and the runner
	// must be (CopyExeOf: CopyDir\novad.exe on Windows).
	CopyDir string
	CopyExe string
	// Self reads the running program's own path (the runner's check).
	Self func() (string, error)
	Put  func(src, dst string) error           // nil = ReplaceFile
	Sum  func(path string) (FileDigest, error) // nil = FileSum
	// Open opens a claimed request for reading (nil = os.Open).
	Open func(path string) (io.ReadCloser, error)
	// Aside moves a running image out of the way, to be deleted at the
	// next restart, and says where it went (nil = asideRunning).
	Aside func(path string) (string, error)
}

func (h Host) removeAll(p string) error {
	if h.RemoveAll != nil {
		return h.RemoveAll(p)
	}
	return os.RemoveAll(p)
}

func (h Host) put(src, dst string) error {
	if h.Put != nil {
		return h.Put(src, dst)
	}
	return ReplaceFile(src, dst)
}

func (h Host) aside(p string) (string, error) {
	if h.Aside != nil {
		return h.Aside(p)
	}
	return asideRunning(p)
}

// asideRunning moves a running image beside its directory's parent under a
// name of its own; task_windows.go also marks it for deletion at the next
// restart (MoveFileEx), which nothing else here can do.
var asideRunning = func(p string) (string, error) {
	id, err := NewRequestID(rand.Reader)
	if err != nil {
		return "", err
	}
	away := filepath.Join(filepath.Dir(filepath.Dir(p)), AsidePrefix+id[:8]+filepath.Ext(p))
	if err := os.Rename(p, away); err != nil {
		return "", err
	}
	return away, nil
}

func (h Host) sum(p string) (FileDigest, error) {
	if h.Sum != nil {
		return h.Sum(p)
	}
	return FileSum(p)
}

func (h Host) open(p string) (io.ReadCloser, error) {
	if h.Open != nil {
		return h.Open(p)
	}
	return os.Open(p)
}

// copyFile is the protected copy on disk (CopyExe's file on Windows).
func (h Host) copyFile() string { return filepath.Join(h.CopyDir, CopyName) }

func (h Host) signedIn() bool { return h.SignedIn != nil && h.SignedIn() }

func (h Host) poll() time.Duration {
	if h.Poll > 0 {
		return h.Poll
	}
	return 500 * time.Millisecond
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// CapBuffer keeps the first OutputCap bytes written to it and drops the
// rest as it arrives (never buffering a child's whole output); Write
// always reports the full length so the child never sees a short write.
type CapBuffer struct {
	b   []byte
	cut bool
}

func (c *CapBuffer) Write(p []byte) (int, error) {
	room := OutputCap - len(c.b)
	switch {
	case len(p) <= room:
		c.b = append(c.b, p...)
	default:
		if room > 0 {
			c.b = append(c.b, p[:room]...)
		}
		c.cut = true
	}
	return len(p), nil
}

// Result is what was kept and whether anything was dropped.
func (c *CapBuffer) Result() (string, bool) { return string(c.b), c.cut }

// What install does with the request directory.
const (
	DirCreate   = "create"   // absent: create it with its descriptor in one call
	DirResecure = "resecure" // an install made it: set its descriptor again
	DirRecreate = "recreate" // anyone else may have: remove it, create it anew
)

// DirAction decides install's handling of the request directory. Only an
// owner of SYSTEM or Administrators proves an elevated install made it (a
// standard user cannot give a file away to either); anything else —
// including the owner's own unelevated SID — is removed and created anew,
// never reused.
func DirAction(present bool, sec DirSecurity) (string, string) {
	switch {
	case !present:
		return DirCreate, "the request directory is absent: install creates it"
	case sec.Owner == SIDSystem || sec.Owner == SIDAdministrators:
		return DirResecure, "the request directory was secured by an install: install sets its security again"
	}
	owner := sec.Owner
	if owner == "" {
		owner = "nobody readable"
	}
	return DirRecreate, "the request directory was not secured by an install (it is owned by " + owner +
		"): install does not reuse it — it removes it and creates it anew"
}

// FileOwnerOK: a request file runs only when owned by the owner, SYSTEM or
// Administrators.
func FileOwnerOK(owner, sid string) bool {
	return owner == sid || owner == SIDSystem || owner == SIDAdministrators
}

func readState(ctx context.Context, h Host, self bool) (InstallState, error) {
	st, _, err := h.Sched.Query(ctx)
	if err != nil {
		return InstallState{}, err
	}
	return InstallState{
		TaskPresent: st != TaskAbsent,
		TaskRunning: st == TaskRunning,
		DirPresent:  exists(h.Dir),
		CopyPresent: exists(h.CopyDir),
		Self:        self,
	}, nil
}

// secureDir makes dir (the request directory or the protected copy's) as
// DirAction decides, carrying sddl; it never leaves a directory it did not
// secure in place.
func secureDir(h Host, dir, sddl string) error {
	present := exists(dir)
	var sec DirSecurity
	if present {
		var err error
		if sec, err = h.ACL.Read(dir); err != nil {
			sec = DirSecurity{Owner: "unreadable (" + err.Error() + ")"}
		}
	}
	action, said := DirAction(present, sec)
	switch action {
	case DirResecure:
		return h.ACL.Apply(dir, sddl)
	case DirRecreate:
		if err := h.removeAll(dir); err != nil {
			return fmt.Errorf("cannot: %s; removing %s failed: %w", said, dir, err)
		}
	}
	if err := h.ACL.Create(dir, sddl); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("cannot: %s was still there (or came back) when install created it: it is not reused", dir)
		}
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	return nil
}

// putCopy secures the protected copy's directory (DirAction, CopyDirSDDL),
// reads its security back (CopyDirVerdict), copies src into it and
// verifies the copy (CopyVerdict). Any failure is stated; the task is
// never registered over an unverified copy.
func putCopy(h Host, src string) error {
	if err := os.MkdirAll(filepath.Dir(h.CopyDir), 0o755); err != nil {
		return fmt.Errorf("creating the protected copy's parent %s: %w", filepath.Dir(h.CopyDir), err)
	}
	if err := secureDir(h, h.CopyDir, CopyDirSDDL()); err != nil {
		return err
	}
	sec, err := h.ACL.Read(h.CopyDir)
	if err != nil {
		return fmt.Errorf("reading the protected copy's directory back: %w", err)
	}
	if ok, said := CopyDirVerdict(sec); !ok {
		return errors.New("cannot: " + said)
	}
	dst := h.copyFile()
	if err := h.put(src, dst); err != nil {
		return fmt.Errorf("copying the agent %s to the protected copy %s: %w", src, dst, err)
	}
	want, err := h.sum(src)
	if err != nil {
		return fmt.Errorf("hashing the agent %s: %w", src, err)
	}
	got, err := h.sum(dst)
	if err != nil {
		return fmt.Errorf("hashing the protected copy %s: %w", dst, err)
	}
	if ok, said := CopyVerdict(want, got); !ok {
		return errors.New(said)
	}
	return nil
}

// clearDir removes everything in the request directory: nothing written
// before install runs after it.
func clearDir(h Host) error {
	ents, err := os.ReadDir(h.Dir)
	if err != nil {
		return err
	}
	for _, e := range ents {
		if err := h.removeAll(filepath.Join(h.Dir, e.Name())); err != nil {
			return fmt.Errorf("removing %s, left in the request directory before install: %w", e.Name(), err)
		}
	}
	return nil
}

// InstallTask is `novad admin install` (run elevated) for the owner sid:
// secures the request directory (DirAction) and clears it, copies src (the
// agent's own executable) to the protected copy and verifies it, registers
// the task against h.CopyExe only, then proves it (InstallVerdict) by an
// elevated whoami round trip through the copy. A re-install refreshes the
// copy. self is true when this runs inside the task's own instance.
func InstallTask(ctx context.Context, h Host, sid, src string, self bool) (string, error) {
	def := TaskDefinition{SID: sid, Binary: h.CopyExe}
	s, err := readState(ctx, h, self)
	if err != nil {
		return "", err
	}
	for _, step := range PlanInstall(s) {
		switch step {
		case StepEndTask:
			if err := h.Sched.End(ctx); err != nil {
				return "", err
			}
		case StepSecureDir:
			sddl, err := RequestDirSDDL(def.SID)
			if err != nil {
				return "", err
			}
			if err := secureDir(h, h.Dir, sddl); err != nil {
				return "", err
			}
		case StepClearDir:
			if err := clearDir(h); err != nil {
				return "", err
			}
		case StepCopyBinary:
			if err := putCopy(h, src); err != nil {
				return "", err
			}
		case StepRegisterTask:
			b, err := TaskXMLFile(def)
			if err != nil {
				return "", err
			}
			if err := h.Sched.Register(ctx, b); err != nil {
				return "", err
			}
		case StepProve:
			rb := InstallReadBack{Want: def}
			_, task, err := h.Sched.Query(ctx)
			if err != nil {
				return "", err
			}
			rb.Task = task
			if exists(h.Dir) {
				d, err := h.ACL.Read(h.Dir)
				if err != nil {
					return "", err
				}
				rb.Dir = &d
			}
			id, err := NewRequestID(rand.Reader)
			if err != nil {
				return "", err
			}
			const whoamiS = 60
			res, err := Submit(ctx, h, TaskRequest{
				ID: id, Argv: []string{def.Binary, "admin", "whoami"}, TimeoutS: json.Number(fmt.Sprint(whoamiS)),
			}, whoamiS*time.Second)
			if err != nil {
				rb.WhoamiSaid = err.Error()
			} else {
				rb.Whoami = &res
			}
			ok, said := InstallVerdict(rb)
			if !ok {
				return "", errors.New(said)
			}
			return said, nil
		}
	}
	return "", errors.New("install planned no proof") // PlanInstall always ends in StepProve
}

// UninstallTask deletes the task, the request directory and the protected
// copy (PlanUninstall) and proves all three gone (UninstallVerdict); a
// failed step is stated, never read as removed.
func UninstallTask(ctx context.Context, h Host, self bool) (string, error) {
	s, err := readState(ctx, h, self)
	if err != nil {
		return "", err
	}
	steps := PlanUninstall(s)
	movedAside := ""
	if len(steps) == 0 {
		return "no admin path on this machine — nothing to remove", nil
	}
	for _, step := range steps {
		switch step {
		case StepEndTask:
			if err := h.Sched.End(ctx); err != nil {
				return "", err
			}
		case StepDeleteTask:
			if err := h.Sched.Delete(ctx); err != nil {
				return "", fmt.Errorf("deleting the task %s: %w", TaskPath, err)
			}
		case StepRemoveDir:
			if err := h.removeAll(h.Dir); err != nil {
				return "", fmt.Errorf("removing the request directory %s: %w", h.Dir, err)
			}
		case StepRemoveCopy:
			if err := h.removeAll(h.CopyDir); err != nil {
				if !s.Self {
					return "", fmt.Errorf("removing the protected copy %s: %w", h.CopyDir, err)
				}
				// Through the path, the runner that started this runs
				// from the copy: its image cannot be deleted while it
				// runs, but it can be moved out of the directory.
				away, aerr := h.aside(h.copyFile())
				if aerr != nil {
					return "", fmt.Errorf("removing the protected copy %s: %w (moving the running copy aside failed too: %v)", h.CopyDir, err, aerr)
				}
				if err := h.removeAll(h.CopyDir); err != nil {
					return "", fmt.Errorf("removing the protected copy %s after moving the running copy aside: %w", h.CopyDir, err)
				}
				movedAside = "; the running copy was moved aside to " + away + " and is deleted at the next restart"
			}
		case StepReadBack:
			st, _, err := h.Sched.Query(ctx)
			if err != nil {
				return "", err
			}
			ok, said := UninstallVerdict(st != TaskAbsent, exists(h.Dir), exists(h.CopyDir))
			if !ok {
				return "", errors.New(said)
			}
			return said + movedAside, nil
		}
	}
	return "", errors.New("uninstall planned no read-back") // PlanUninstall always ends in StepReadBack
}

// RunQueued is the task's action, run as me (the owner, elevated). It runs
// nothing unless it is itself the protected copy (h.Self equals
// h.CopyExe): an elevated run of any other program is refused. Before
// each pass it re-reads the request directory's security and runs nothing
// unless DirVerdict holds; it claims each pending request by rename, runs
// it, and writes its result atomically. It drains until nothing is pending.
func RunQueued(ctx context.Context, h Host, me WhoamiReport) error {
	if h.Self == nil {
		return errors.New("cannot: this runner cannot read its own path, so cannot show it is the protected copy " + h.CopyExe + " — nothing run")
	}
	self, err := h.Self()
	if err != nil {
		return fmt.Errorf("cannot: reading this runner's own path: %v — it must be the protected copy %s; nothing run", err, h.CopyExe)
	}
	if !SameExe(self, h.CopyExe) {
		return fmt.Errorf("cannot: this runner is %s, not the protected copy %s — nothing run", self, h.CopyExe)
	}
	for {
		sec, err := h.ACL.Read(h.Dir)
		if err != nil {
			return fmt.Errorf("cannot: reading the request directory's security: %w — nothing run", err)
		}
		if ok, said := DirVerdict(sec, me.SID); !ok {
			return errors.New("cannot: " + said + " — nothing run")
		}
		ents, err := os.ReadDir(h.Dir)
		if err != nil {
			return err
		}
		names := make([]string, 0, len(ents))
		for _, e := range ents {
			names = append(names, e.Name())
		}
		ran := false
		for _, id := range PendingRequests(names) {
			claim := filepath.Join(h.Dir, ClaimName(id))
			if err := os.Rename(filepath.Join(h.Dir, RequestName(id)), claim); err != nil {
				continue // another instance claimed it
			}
			ran = true
			res := runClaimed(ctx, h, claim, id, me.SID)
			res.ID, res.Elevated, res.User = id, me.Elevated, me.User
			b, err := EncodeResult(res)
			if err == nil {
				err = WriteFileAtomic(h.Dir, ResultName(id), b)
			}
			_ = os.Remove(claim)
			if err != nil {
				return fmt.Errorf("writing the result of %s: %w", id, err)
			}
		}
		if !ran || ctx.Err() != nil {
			return ctx.Err()
		}
	}
}

// runClaimed checks one claimed request (its owner, its size, its content)
// and runs it; anything it will not run is a result that says why.
func runClaimed(ctx context.Context, h Host, claim, id, sid string) TaskResult {
	cannot := func(format string, a ...any) TaskResult {
		return TaskResult{ExitCode: -1, Said: "cannot: " + fmt.Sprintf(format, a...)}
	}
	owner, err := h.Owners.Owner(claim)
	if err != nil {
		return cannot("reading the request file's owner: %v — not run", err)
	}
	if !FileOwnerOK(owner, sid) {
		return cannot("the request file is owned by %s, not the owner, SYSTEM or Administrators — not run", owner)
	}
	f, err := h.open(claim)
	if err != nil {
		return cannot("reading the request: %v", err)
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxRequestBytes+1))
	f.Close()
	if err != nil {
		return cannot("reading the request: %v", err)
	}
	if len(b) > MaxRequestBytes {
		return cannot("the request is over %d bytes — not run", MaxRequestBytes)
	}
	req, timeout, err := DecodeRequest(b)
	if err == nil && req.ID != id {
		err = fmt.Errorf("request file %s carries id %s", id, req.ID)
	}
	if err != nil {
		return cannot("%v — not run", err)
	}
	var out, errb CapBuffer
	o := h.Proc.Run(ctx, req.Argv, req.Cwd, timeout, &out, &errb)
	res := TaskResult{OK: !o.Failed && !o.TimedOut, ExitCode: o.ExitCode, TimedOut: o.TimedOut, Said: o.Said}
	res.Stdout, res.StdoutTruncated = out.Result()
	res.Stderr, res.StderrTruncated = errb.Result()
	return res
}

// Submit is admin.exec's Windows side: refuse an oversized request,
// StartCannot, write the request atomically, start the task, wait
// (NextWait) and read the result.
func Submit(ctx context.Context, h Host, req TaskRequest, timeout time.Duration) (TaskResult, error) {
	b, err := EncodeRequest(req)
	if err != nil {
		return TaskResult{}, err
	}
	if len(b) > MaxRequestBytes {
		return TaskResult{}, fmt.Errorf("cannot: the request is over %d bytes — not sent", MaxRequestBytes)
	}
	st, _, err := h.Sched.Query(ctx)
	if err != nil {
		return TaskResult{}, err
	}
	if c := StartCannot(st, h.signedIn()); c != "" {
		return TaskResult{}, errors.New(c)
	}
	reqPath := filepath.Join(h.Dir, RequestName(req.ID))
	resPath := filepath.Join(h.Dir, ResultName(req.ID))
	if err := WriteFileAtomic(h.Dir, RequestName(req.ID), b); err != nil {
		return TaskResult{}, fmt.Errorf("writing the request: %w", err)
	}
	if err := h.Sched.Run(ctx); err != nil {
		_ = os.Remove(reqPath)
		return TaskResult{}, err
	}
	start := time.Now()
	limit := WaitLimit(timeout)
	for {
		ws := WaitState{Elapsed: time.Since(start), Limit: limit, HaveResult: exists(resPath)}
		if !ws.HaveResult {
			if ws.TaskState, _, err = h.Sched.Query(ctx); err != nil {
				_ = os.Remove(reqPath)
				return TaskResult{}, err
			}
		}
		step := NextWait(ws)
		if step.Read {
			b, err := os.ReadFile(resPath)
			if err != nil {
				return TaskResult{}, fmt.Errorf("reading the result: %w", err)
			}
			res, err := DecodeResult(b, req.ID)
			if err != nil {
				return TaskResult{}, err
			}
			if err := os.Remove(resPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return res, fmt.Errorf("removing the result: %w", err)
			}
			return res, nil
		}
		if step.Done {
			_ = os.Remove(reqPath)
			return TaskResult{}, errors.New(step.Said)
		}
		select {
		case <-ctx.Done():
			_ = os.Remove(reqPath)
			return TaskResult{}, ctx.Err()
		case <-time.After(h.poll()):
		}
	}
}
