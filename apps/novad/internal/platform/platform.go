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
	"os/exec"
	"strings"
)

// Runner runs one program, argv form, and returns what it wrote to stdout.
// stdin, when not empty, is written to its standard input.
type Runner interface {
	Run(ctx context.Context, name string, args []string, stdin string) (string, error)
}

// Exec is the Runner that runs real programs.
type Exec struct{}

// Run runs name with args. A failure carries the program's own stderr, so a
// caller states the reason the program gave, not just "exit status 1".
func (Exec) Run(ctx context.Context, name string, args []string, stdin string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return stdout.String(), fmt.Errorf("%s: %w: %s", name, err, msg)
		}
		return stdout.String(), fmt.Errorf("%s: %w", name, err)
	}
	return stdout.String(), nil
}

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
