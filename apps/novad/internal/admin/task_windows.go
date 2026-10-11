//go:build windows

package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// RunnerEnv is set in every child the task's runner starts, so a `novad
// admin install|uninstall` run through the path knows it is inside the
// task's own instance and must not end it (InstallState.Self).
const RunnerEnv = "NOVAD_ADMIN_TASK"

// Schtasks is the Scheduler over %SystemRoot%\System32\schtasks.exe (an
// absolute path, never PATH) for the task at Path (TaskPath in production).
type Schtasks struct {
	Path string
}

func schtasksExe() string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32", "schtasks.exe")
}

// run is one schtasks call: its stdout, and an error carrying its words
// when it failed.
func (s Schtasks) run(ctx context.Context, args ...string) ([]byte, string, error) {
	cmd := exec.CommandContext(ctx, schtasksExe(), args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	words := strings.TrimSpace(errb.String() + " " + out.String())
	if err != nil {
		return out.Bytes(), words, fmt.Errorf("schtasks %s: %v: %s", strings.Join(args, " "), err, words)
	}
	return out.Bytes(), words, nil
}

func (s Schtasks) Register(ctx context.Context, xmlFile []byte) error {
	f, err := os.CreateTemp("", "nova-admin-task-*.xml")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	_, err = f.Write(xmlFile)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	_, _, err = s.run(ctx, SchtasksArgs("create", s.Path, name)...)
	return err
}

func (s Schtasks) Run(ctx context.Context) error {
	_, _, err := s.run(ctx, SchtasksArgs("run", s.Path, "")...)
	return err
}

func (s Schtasks) End(ctx context.Context) error {
	_, _, err := s.run(ctx, SchtasksArgs("end", s.Path, "")...)
	return err
}

func (s Schtasks) Delete(ctx context.Context) error {
	_, _, err := s.run(ctx, SchtasksArgs("delete", s.Path, "")...)
	return err
}

func (s Schtasks) Query(ctx context.Context) (string, *TaskReadBack, error) {
	out, words, err := s.run(ctx, SchtasksArgs("query", s.Path, "")...)
	if err != nil {
		if QueryAbsent(words) {
			return TaskAbsent, nil, nil
		}
		return "", nil, err
	}
	rb, err := ParseTaskXML(out)
	if err != nil {
		return "", nil, err
	}
	line, _, err := s.run(ctx, "/query", "/tn", s.Path, "/fo", "csv", "/nh")
	if err != nil {
		return "", nil, err
	}
	st, err := TaskStateOf(string(line))
	if err != nil {
		return "", nil, err
	}
	return st, &rb, nil
}

// WinACL is the DirACL over CreateDirectory (with the descriptor) and
// SetNamedSecurityInfo / GetNamedSecurityInfo.
type WinACL struct{}

// Create makes dir carrying sddl from its first instant: there is no
// window in which it holds ProgramData's inherited ACL.
func (WinACL) Create(dir, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("reading the descriptor %s: %w", sddl, err)
	}
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	if err := windows.CreateDirectory(p, &sa); err != nil {
		if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			return fmt.Errorf("creating %s: %w", dir, fs.ErrExist)
		}
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	return nil
}

func (WinACL) Apply(dir, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("reading the descriptor %s: %w", sddl, err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	info := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION)
	if owner != nil {
		info |= windows.OWNER_SECURITY_INFORMATION
	}
	if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, info, owner, nil, dacl, nil); err != nil {
		return fmt.Errorf("setting %s's security: %w", dir, err)
	}
	return nil
}

func (WinACL) Read(dir string) (DirSecurity, error) {
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return DirSecurity{}, fmt.Errorf("reading %s's security: %w", dir, err)
	}
	var d DirSecurity
	if owner, _, err := sd.Owner(); err == nil && owner != nil {
		d.Owner = owner.String()
	}
	ctl, _, err := sd.Control()
	if err != nil {
		return DirSecurity{}, err
	}
	d.Protected = ctl&windows.SE_DACL_PROTECTED != 0
	dacl, _, err := sd.DACL()
	if err != nil {
		return DirSecurity{}, err
	}
	if dacl == nil {
		// A NULL DACL admits everyone.
		d.Allowed = []string{"S-1-1-0"}
		return d, nil
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return DirSecurity{}, err
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		switch ace.Header.AceType {
		case windows.ACCESS_ALLOWED_ACE_TYPE:
			d.Allowed = append(d.Allowed, sid)
		case windows.ACCESS_DENIED_ACE_TYPE:
			d.Denied = append(d.Denied, sid)
		default:
			// An entry this reader does not decode is not "nothing":
			// count it as an allow it cannot vouch for.
			d.Allowed = append(d.Allowed, fmt.Sprintf("ace-type-%d", ace.Header.AceType))
		}
	}
	return d, nil
}

// WinOwners is the FileOwners over GetNamedSecurityInfo.
type WinOwners struct{}

func (WinOwners) Owner(path string) (string, error) {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return "", fmt.Errorf("reading %s's owner: %w", path, err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return "", err
	}
	if owner == nil {
		return "", fmt.Errorf("%s has no owner", path)
	}
	return owner.String(), nil
}

// JobRunner is the ProcRunner: argv with no window, in a kill-on-close job
// object; at the deadline (or ctx's end) the whole job is terminated.
// Output goes straight to the given writers (CapBuffers: capped as read).
type JobRunner struct{}

func (JobRunner) Run(ctx context.Context, argv []string, cwd string, timeout time.Duration, stdout, stderr io.Writer) ProcOutcome {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return ProcOutcome{ExitCode: -1, Failed: true, Said: "creating a job object: " + err.Error()}
	}
	defer windows.CloseHandle(job)
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		return ProcOutcome{ExitCode: -1, Failed: true, Said: "setting up the job object: " + err.Error()}
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), RunnerEnv+"=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := cmd.Start(); err != nil {
		return ProcOutcome{ExitCode: -1, Failed: true, Said: "cannot start " + argv[0] + ": " + err.Error()}
	}
	var jobSaid string
	if err := cmd.Process.WithHandle(func(h uintptr) {
		if err := windows.AssignProcessToJobObject(job, windows.Handle(h)); err != nil {
			jobSaid = "not in the job object (" + err.Error() + "): the deadline kills only the process itself"
		}
	}); err != nil && jobSaid == "" {
		jobSaid = "not in the job object (" + err.Error() + ")"
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var waitErr error
	timedOut := false
	select {
	case waitErr = <-done:
	case <-timer.C:
		timedOut = true
	case <-ctx.Done():
		timedOut = true
	}
	if timedOut {
		_ = windows.TerminateJobObject(job, 1)
		_ = cmd.Process.Kill()
		waitErr = <-done
	}

	o := ProcOutcome{TimedOut: timedOut}
	if cmd.ProcessState != nil {
		o.ExitCode = cmd.ProcessState.ExitCode()
	}
	var ee *exec.ExitError
	if waitErr != nil && !errors.As(waitErr, &ee) {
		o.Failed = true
		o.Said = waitErr.Error()
	}
	if timedOut {
		o.Said = fmt.Sprintf("timed out after %s; the job was terminated", timeout)
	}
	if jobSaid != "" {
		o.Said = strings.TrimSpace(o.Said + " " + jobSaid)
	}
	return o
}

// integrityOf names a mandatory label's RID.
func integrityOf(rid uint32) string {
	switch {
	case rid >= 0x4000:
		return "system"
	case rid >= 0x3000:
		return "high"
	case rid >= 0x2000:
		return "medium"
	case rid >= 0x1000:
		return "low"
	}
	return "untrusted"
}

func tokenReport(t windows.Token) (WhoamiReport, error) {
	u, err := t.GetTokenUser()
	if err != nil {
		return WhoamiReport{}, fmt.Errorf("reading this process's user: %w", err)
	}
	r := WhoamiReport{SID: u.User.Sid.String(), Elevated: t.IsElevated()}
	if acct, dom, _, err := u.User.Sid.LookupAccount(""); err == nil {
		r.User = dom + `\` + acct
	} else {
		r.User = r.SID
	}
	var n uint32
	_ = windows.GetTokenInformation(t, windows.TokenIntegrityLevel, nil, 0, &n)
	if n > 0 {
		buf := make([]byte, n)
		if err := windows.GetTokenInformation(t, windows.TokenIntegrityLevel, &buf[0], n, &n); err == nil {
			lbl := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&buf[0]))
			if c := lbl.Label.Sid.SubAuthorityCount(); c > 0 {
				r.Integrity = integrityOf(lbl.Label.Sid.SubAuthority(uint32(c) - 1))
			}
		}
	}
	if r.Integrity == "" {
		r.Integrity = "unreadable"
	}
	return r, nil
}

// Me is this process's token as a WhoamiReport: the runner's identity
// (the owner, elevated) that RunQueued checks the directory and each
// request file's owner against.
func Me() (WhoamiReport, error) {
	return tokenReport(windows.GetCurrentProcessToken())
}

// WhoamiToken is `novad admin whoami` on Windows: this process's user,
// SID, elevation and integrity as WhoamiReport JSON.
func WhoamiToken() ([]byte, error) {
	r, err := tokenReport(windows.GetCurrentProcessToken())
	if err != nil {
		return nil, err
	}
	return json.Marshal(r)
}

// SignedIn reports whether the owner has an interactive session: the
// agent runs in his desktop session while he is signed in, never in
// session 0.
func SignedIn() bool {
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err != nil {
		return false
	}
	return session != 0
}

// DefaultHost is the glue over the real seams: the request directory under
// ProgramData and the protected copy under Program Files, each read from
// its known folder (never an environment variable someone set). `novad
// admin` and the agent's admin.exec (caps) both build their Host here.
func DefaultHost() (Host, error) {
	pd, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return Host{}, fmt.Errorf("reading ProgramData's location: %w", err)
	}
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return Host{}, fmt.Errorf("reading Program Files' location: %w", err)
	}
	return Host{
		Sched:    Schtasks{Path: TaskPath},
		ACL:      WinACL{},
		Owners:   WinOwners{},
		Proc:     JobRunner{},
		Dir:      RequestDir(pd),
		SignedIn: SignedIn,
		CopyDir:  CopyDirOf(pf),
		CopyExe:  CopyExeOf(pf),
		Self:     OwnPath,
	}, nil
}

// OwnPath is this program's own path, links resolved: the protected copy's
// source at install, and what the runner checks it is.
func OwnPath() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}

// ReadPath is the admin path on this machine as read now: the task's state
// (schtasks, as the agent's own unelevated user may query it) and whether
// the request directory and the protected copy are on disk
// (TaskPathState).
func ReadPath(ctx context.Context) PathState {
	h, err := DefaultHost()
	if err != nil {
		return TaskPathState("", err, false, false, nil)
	}
	st, _, qerr := h.Sched.Query(ctx)
	return TaskPathState(st, qerr, exists(h.Dir), exists(h.CopyDir), PendingAsides(filepath.Dir(h.CopyDir)))
}

func init() {
	plain := asideRunning
	// The moved image is deleted at the next restart: until then nothing
	// can run it (the task is gone) and nothing can delete it (it runs).
	asideRunning = func(p string) (string, error) {
		away, err := plain(p)
		if err != nil {
			return "", err
		}
		u, err := windows.UTF16PtrFromString(away)
		if err != nil {
			return away, err
		}
		if err := windows.MoveFileEx(u, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT); err != nil {
			return away, fmt.Errorf("moved to %s, but marking it for deletion at the next restart failed: %w", away, err)
		}
		return away, nil
	}
}
