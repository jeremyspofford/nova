//go:build unix

package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"novad/internal/platform"
)

// The installed layout, relative to Env.Root ("/" on a real machine).
const (
	CopyRel   = "usr/local/libexec/nova/novad"
	DropInRel = "etc/sudoers.d/nova-admin"
	// CopyPath is the root copy's absolute path as the sudoers rule names it.
	CopyPath = "/" + CopyRel
)

// ErrTimeout is Exec's answer when argv outlived its deadline and its whole
// process group was killed.
var ErrTimeout = errors.New("timed out")

// killGrace bounds how long Exec waits, after the group kill, for output
// pipes a process that left the group may still hold.
const killGrace = 2 * time.Second

// Env is every seam install/uninstall/whoami touch: the root prefix (tests
// pass a t.TempDir()), the Runner visudo goes through, the effective uid,
// the user name, the agent's own binary, and chown.
type Env struct {
	Root     string
	Runner   platform.Runner
	Euid     func() int
	Username func() (string, error)
	Self     func() (string, error)
	Chown    func(path string, uid, gid int) error
}

// DefaultEnv is the real machine: root "/", real visudo, the process's own
// euid and user, its own executable, os.Chown.
func DefaultEnv() Env {
	return Env{
		Root:   "/",
		Runner: platform.Exec{WaitDelay: killGrace},
		Euid:   os.Geteuid,
		Username: func() (string, error) {
			u, err := user.LookupId(strconv.Itoa(os.Geteuid()))
			if err != nil {
				return "", err
			}
			return u.Username, nil
		},
		Self: func() (string, error) {
			p, err := os.Executable()
			if err != nil {
				return "", err
			}
			return filepath.EvalSymlinks(p)
		},
		Chown: os.Chown,
	}
}

// CopyFile is the root copy's path under Root.
func (e Env) CopyFile() string { return filepath.Join(e.Root, CopyRel) }

// DropInFile is the sudoers drop-in's path under Root.
func (e Env) DropInFile() string { return filepath.Join(e.Root, DropInRel) }

// oneWord is a user name sudoers reads as exactly one user: no '%' (a
// group), no ',' or ':' (lists, runas), no space or newline (a second rule).
var oneWord = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// Rule is the drop-in's exact bytes for user.
func Rule(user string) (string, error) {
	if !oneWord.MatchString(user) {
		return "", fmt.Errorf("cannot: %q is not one user name (letters, digits, '_', '.', '-')", user)
	}
	return user + " ALL=(root) NOPASSWD: " + CopyPath + " admin exec *\n" +
		"Defaults!" + CopyPath + " !requiretty\n", nil
}

func needRoot(e Env, what string) error {
	if euid := e.Euid(); euid != 0 {
		return fmt.Errorf("cannot: admin %s runs as root — this is euid %d; run it through sudo", what, euid)
	}
	return nil
}

// Install copies the agent to CopyFile and writes the drop-in, visudo-checked
// before an atomic rename. It returns one line saying what it did.
func Install(ctx context.Context, e Env, user string) (string, error) {
	if err := needRoot(e, "install"); err != nil {
		return "", err
	}
	rule, err := Rule(user)
	if err != nil {
		return "", err
	}
	self, err := e.Self()
	if err != nil {
		return "", fmt.Errorf("admin install: finding this agent's binary: %w", err)
	}
	bin, err := os.ReadFile(self)
	if err != nil {
		return "", fmt.Errorf("admin install: reading %s: %w", self, err)
	}

	// The root copy: its own dir 0755 root:root, the bytes renamed in.
	copyDir := filepath.Dir(e.CopyFile())
	if err := os.MkdirAll(copyDir, 0o755); err != nil {
		return "", fmt.Errorf("admin install: %w", err)
	}
	if err := os.Chmod(copyDir, 0o755); err != nil {
		return "", fmt.Errorf("admin install: %w", err)
	}
	if err := e.Chown(copyDir, 0, 0); err != nil {
		return "", fmt.Errorf("admin install: chown %s: %w", copyDir, err)
	}
	if err := writeRename(filepath.Join(copyDir, ".novad.tmp"), e.CopyFile(), bin, 0o755, nil); err != nil {
		return "", fmt.Errorf("admin install: the root copy: %w", err)
	}
	if err := e.Chown(e.CopyFile(), 0, 0); err != nil {
		return "", fmt.Errorf("admin install: chown %s: %w", e.CopyFile(), err)
	}

	// The drop-in: a temp sudo ignores (its name has a '.'), in sudoers.d
	// itself so the rename is atomic, checked by visudo BEFORE the rename —
	// a broken drop-in breaks sudo for the whole machine.
	dropDir := filepath.Dir(e.DropInFile())
	if err := os.MkdirAll(dropDir, 0o750); err != nil {
		return "", fmt.Errorf("admin install: %w", err)
	}
	check := func(tmp string) error {
		out, err := e.Runner.Run(ctx, "visudo", []string{"-cf", tmp}, "")
		if err != nil {
			if o := strings.TrimSpace(out); o != "" {
				return fmt.Errorf("visudo refused the rule: %v (%s)", err, o)
			}
			return fmt.Errorf("visudo refused the rule: %v", err)
		}
		return nil
	}
	if err := writeRename(filepath.Join(dropDir, ".nova-admin.tmp"), e.DropInFile(), []byte(rule), 0o440, check); err != nil {
		return "", fmt.Errorf("admin install: %w", err)
	}
	if err := e.Chown(e.DropInFile(), 0, 0); err != nil {
		return "", fmt.Errorf("admin install: chown %s: %w", e.DropInFile(), err)
	}
	return fmt.Sprintf("installed: %s (root 0755) and %s (0440, visudo-checked) for user %s",
		filepath.Join("/", CopyRel), filepath.Join("/", DropInRel), user), nil
}

// writeRename writes b to tmp with mode, runs check on it (when given), and
// renames it over dst. Any failure removes tmp: nothing unchecked is left.
func writeRename(tmp, dst string, b []byte, mode os.FileMode, check func(string) error) error {
	if err := os.Remove(tmp); err != nil && !os.IsNotExist(err) {
		return err
	}
	err := func() error {
		f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			return err
		}
		if _, err := f.Write(b); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		if err := os.Chmod(tmp, mode); err != nil {
			return err
		}
		if check != nil {
			if err := check(tmp); err != nil {
				return err
			}
		}
		return os.Rename(tmp, dst)
	}()
	if err != nil {
		if rmErr := os.Remove(tmp); rmErr != nil && !os.IsNotExist(rmErr) {
			return fmt.Errorf("%w (and removing %s failed: %v)", err, tmp, rmErr)
		}
	}
	return err
}

// Uninstall removes the drop-in, then the copy. Absent is nothing to do, said.
func Uninstall(ctx context.Context, e Env) (string, error) {
	if err := needRoot(e, "uninstall"); err != nil {
		return "", err
	}
	var removed []string
	for _, p := range []struct{ file, shown string }{
		{e.DropInFile(), "/" + DropInRel},
		{e.CopyFile(), CopyPath},
	} {
		err := os.Remove(p.file)
		switch {
		case err == nil:
			removed = append(removed, p.shown)
		case os.IsNotExist(err):
		default:
			return "", fmt.Errorf("admin uninstall: %w", err)
		}
	}
	if len(removed) == 0 {
		return "nothing to do: no admin path installed (neither /" + DropInRel + " nor " + CopyPath + ")", nil
	}
	return "removed " + strings.Join(removed, " and "), nil
}

// ExecOpts is one elevated run.
type ExecOpts struct {
	Argv    []string
	Cwd     string
	Timeout time.Duration
}

// Exec runs argv in its own session, kills the whole group at Timeout, and
// returns the child's exit code; combined output goes to out. A child killed
// by a signal (not the timeout) exits 128+signal, the shell's convention.
func Exec(ctx context.Context, o ExecOpts, out io.Writer) (int, error) {
	if len(o.Argv) == 0 {
		return -1, errors.New("admin exec: no argv")
	}
	runCtx := ctx
	if o.Timeout > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, o.Timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(runCtx, o.Argv[0], o.Argv[1:]...)
	cmd.Dir = o.Cwd
	cmd.Stdout = out
	cmd.Stderr = out
	// Its own session (so its own group, pgid = pid, no controlling
	// terminal); the deadline kills the WHOLE group, a backgrounded
	// grandchild included. This side is root: the user-side agent cannot.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return cmd.Process.Kill()
		}
		return err
	}
	cmd.WaitDelay = killGrace
	if err := cmd.Start(); err != nil {
		return -1, err
	}
	err := cmd.Wait()
	// A child that exited on its own keeps its code even if the deadline
	// passed a moment later; one that did not exit (killed) when the
	// deadline had passed is the timeout's kill.
	exitedItself := cmd.ProcessState != nil && cmd.ProcessState.Exited()
	if !exitedItself && runCtx.Err() != nil {
		if ctx.Err() != nil {
			return -1, ctx.Err()
		}
		return -1, ErrTimeout
	}
	// The child's own status, read from its process state: an output pipe
	// a stray process held past killGrace (exec.ErrWaitDelay) does not
	// change how the child itself ended.
	if ps := cmd.ProcessState; ps != nil {
		if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 128 + int(ws.Signal()), nil
		}
		return ps.ExitCode(), nil
	}
	return -1, err
}

// Whoami is `admin whoami`'s JSON: {"euid": n, "user": "..."}.
func Whoami(e Env) ([]byte, error) {
	name, err := e.Username()
	if err != nil {
		return nil, fmt.Errorf("admin whoami: %w", err)
	}
	return json.Marshal(struct {
		Euid int    `json:"euid"`
		User string `json:"user"`
	}{e.Euid(), name})
}

// ReadPath is the admin path on this machine as read now: ReadPathAt over
// the real sudo and the root copy.
func ReadPath(ctx context.Context) PathState { return ReadPathAt(ctx, "sudo", CopyPath) }

// ReadPathAt stats copy and, when it is there, asks `<sudo> -n -l <copy>
// admin exec` whether the rule allows it (UnixPathState). A sudo that has
// not answered when ctx ends is unknown; the read never waits past ctx.
func ReadPathAt(ctx context.Context, sudo, copy string) PathState {
	if _, err := os.Stat(copy); err != nil {
		if os.IsNotExist(err) {
			return UnixPathState(false, nil, true)
		}
		return PathState{Kind: KindNone, State: PathUnknown, Said: firstLine("the root copy could not be read: " + err.Error()), Left: []string{LeftRootCopy}}
	}
	type answer struct {
		err      error
		answered bool
	}
	done := make(chan answer, 1)
	cmd := exec.Command(sudo, "-n", "-l", copy, "admin", "exec")
	var out strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			// No sudo at all: an answer — nothing can allow the copy.
			return UnixPathState(true, fmt.Errorf("%s is not installed", sudo), true)
		}
		return UnixPathState(true, fmt.Errorf("%s did not start: %w", sudo, err), false)
	}
	go func() {
		err := cmd.Wait()
		if err != nil {
			if o := strings.TrimSpace(out.String()); o != "" {
				err = fmt.Errorf("%s", o)
			}
		}
		done <- answer{err: err, answered: true}
	}()
	select {
	case a := <-done:
		return UnixPathState(true, a.err, a.answered)
	case <-ctx.Done():
		// sudo runs as root: this user's kill may not take, so the read
		// does not wait for it — it says it gave no answer.
		_ = cmd.Process.Kill()
		return UnixPathState(true, errors.New("sudo gave no answer in time"), false)
	}
}
