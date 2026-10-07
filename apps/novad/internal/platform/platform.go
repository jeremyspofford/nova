// Package platform is novad's one seam onto the operating system. What is
// read or done differently on Linux, macOS and Windows lives in this
// package's *_linux.go, *_darwin.go and *_windows.go files, so everything
// above it — the capabilities, the facts, the client — is written once.
//
// Two rules hold here. A command is argv, never a shell string: a message or
// a name reaches a program as an argument or on stdin, never spliced into a
// script. And every program a platform function runs goes through a Runner,
// so the parsing of its output is tested on every OS with canned text
// (FakeRunner) even where the program itself exists on only one.
package platform

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Runner runs one program, argv form, and returns what it wrote to stdout.
// stdin, when not empty, is written to its standard input.
type Runner interface {
	Run(ctx context.Context, name string, args []string, stdin string) (string, error)
}

// EnvRunner is a Runner that can also add to one program's environment —
// how wsl.exe gets WSL_UTF8=1 (RunWSL). Exec and FakeRunner are both one.
type EnvRunner interface {
	Runner
	RunEnv(ctx context.Context, env []string, name string, args []string, stdin string) (string, error)
}

// Exec is the Runner that runs real programs. WaitDelay, when set, bounds
// how long a call waits, once its program has exited or been killed at ctx's
// end, for the program's output pipes to close: a grandchild still holding
// them (one wsl.exe started) cannot hold the call open (exec.Cmd.WaitDelay).
type Exec struct {
	WaitDelay time.Duration
}

// Run runs name with args. A failure carries the program's own stderr, so a
// caller states the reason the program gave, not just "exit status 1".
func (e Exec) Run(ctx context.Context, name string, args []string, stdin string) (string, error) {
	return e.RunEnv(ctx, nil, name, args, stdin)
}

// RunEnv is Run with env ("KEY=value" entries) added to the environment the
// program inherits from the agent. A failure is a *RunError.
func (e Exec) RunEnv(ctx context.Context, env []string, name string, args []string, stdin string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = e.WaitDelay
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return "", &RunError{Name: name, Err: err, NotStarted: true}
	}
	if err := cmd.Wait(); err != nil {
		return stdout.String(), &RunError{Name: name, Err: err, Stderr: stderr.String()}
	}
	return stdout.String(), nil
}

// RunError is a program that failed: its name, how (an exit status, not
// found, killed), and its stderr exactly as it wrote it — so a caller that
// knows the program's encoding decodes its words alone (RunWSL), never the
// prefix this adds. NotStarted is a program that never ran: it could not be
// started (not found, not allowed), or its bound had already passed.
type RunError struct {
	Name       string
	Err        error
	Stderr     string
	NotStarted bool
}

// Error is "name: how: stderr", stderr trimmed, or "name: how" when the
// program wrote none.
func (e *RunError) Error() string {
	if msg := strings.TrimSpace(e.Stderr); msg != "" {
		return fmt.Sprintf("%s: %v: %s", e.Name, e.Err, msg)
	}
	return fmt.Sprintf("%s: %v", e.Name, e.Err)
}

// Unwrap is how the program failed (exec.ErrNotFound, *exec.ExitError).
func (e *RunError) Unwrap() error { return e.Err }

// Mem is the machine's memory as the OS reports it. AvailableKnown is false
// where the OS gives only the total; the caller then says "available
// unknown", never a number nobody read.
type Mem struct {
	Total          uint64
	Available      uint64
	AvailableKnown bool
}

// machineUIDSalt makes MachineUID application-specific: the raw OS id never
// leaves the machine (machine-id(5) asks exactly this of anything exposing
// it), and two programs hashing the same id never match each other.
const machineUIDSalt = "nova/machine-uid/v1:"

// MachineUID is this machine's identity for one purpose — spotting two Nova
// agents on one machine: a salted sha256 of the OS's own machine id, as hex.
// "" and an error when the OS would not say; the caller reports that as
// unreadable.
func MachineUID(ctx context.Context, r Runner) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	raw, err := rawMachineID(ctx, r)
	if err != nil {
		return "", err
	}
	return hashMachineID(raw)
}

func hashMachineID(raw string) (string, error) {
	id := strings.ToLower(strings.TrimSpace(raw))
	if id == "" {
		return "", errors.New("the operating system reported an empty machine id")
	}
	sum := sha256.Sum256([]byte(machineUIDSalt + id))
	return hex.EncodeToString(sum[:]), nil
}
