package caps

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"time"
)

// shellExec runs argv with NO shell — exec.CommandContext(argv[0], argv[1:]...).
// There is no string-to-shell path anywhere in the daemon: a user who wants a
// shell passes ["bash","-lc","..."] explicitly, in argv form, visible in the
// audit. Combined stdout+stderr is captured to a 64 KiB cap. The ctx carries
// the command timeout; a deadline hit is ok:false, but a process that RAN to
// completion is ok:true even on a nonzero exit — exit_code carries the result.
func shellExec(ctx context.Context, args map[string]any, d Deps) Outcome {
	raw, ok := args["argv"].([]any)
	if !ok || len(raw) == 0 {
		return fail("shell.exec needs a non-empty 'argv' array")
	}
	argv := make([]string, 0, len(raw))
	for i, v := range raw {
		s, ok := v.(string)
		if !ok {
			return fail("shell.exec argv[%d] is not a string", i)
		}
		argv = append(argv, s)
	}

	cwd := d.Home
	if c, ok := strArg(args, "cwd"); ok && c != "" {
		cwd = c
	}

	cw := &capWriter{limit: OutputCap}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = cwd
	cmd.Stdout = cw
	cmd.Stderr = cw
	prepareCommand(cmd)

	runErr := cmd.Run()

	// A timeout is the daemon failing to complete the capability -> ok:false.
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fail("timed out; partial output:\n%s", cw.string())
	}
	// Cancelled without a deadline: the connection to Nova dropped mid-run
	// (serve's context). The process was killed, not finished — never
	// "ran, exit -1".
	if errors.Is(ctx.Err(), context.Canceled) {
		return fail("cancelled before it finished — the connection to Nova dropped; partial output:\n%s", cw.string())
	}

	if runErr == nil {
		code := 0
		return Outcome{OK: true, Output: cw.string(), ExitCode: &code}
	}
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		// The process ran and returned a nonzero code — that is a RESULT, not a
		// daemon failure. ok:true, the code carried, the output naming it.
		code := exitErr.ExitCode()
		out := cw.string()
		out += fmt.Sprintf("\n[process exited with code %d]", code)
		return Outcome{OK: true, Output: out, ExitCode: &code}
	}
	if errors.Is(runErr, exec.ErrWaitDelay) {
		// The command itself exited 0, but a background process it started
		// still held the output pipe when WaitDelay closed it, so Wait
		// reports ErrWaitDelay instead of nil (exec.Cmd.WaitDelay's own
		// doc). That is still a process that RAN — ok:true, exit 0 — not
		// "could not run"; the note says why later output is missing.
		code := 0
		out := cw.string()
		out += "\n[exited 0, but a background process it started kept its output open; output after the exit was not read]"
		return Outcome{OK: true, Output: out, ExitCode: &code}
	}
	// Anything else (binary not found, permission, cwd missing) is the daemon
	// being unable to perform the capability -> ok:false.
	return fail("could not run %q: %v", argv[0], runErr)
}

// capWriter accumulates output up to a byte cap, notes when the cap is reached,
// and always claims a full write so the child process is never killed by a
// short write. It is written from both the stdout and stderr pipes, so it is
// mutex-guarded.
type capWriter struct {
	mu        sync.Mutex
	buf       []byte
	limit     int
	truncated bool
}

func (w *capWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.buf) >= w.limit {
		w.truncated = true
		return len(p), nil
	}
	room := w.limit - len(w.buf)
	if room >= len(p) {
		w.buf = append(w.buf, p...)
	} else {
		w.buf = append(w.buf, p[:room]...)
		w.truncated = true
	}
	return len(p), nil
}

func (w *capWriter) string() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	s := string(w.buf)
	if w.truncated {
		s += fmt.Sprintf("\n[truncated at %d KiB]", w.limit/1024)
	}
	return s
}

// killGrace bounds how long Wait may block on output pipes after the command
// is killed, so a stuck descendant cannot hold a handler past its budget.
const killGrace = 5 * time.Second
