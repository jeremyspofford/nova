package platform

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// FakeRunner is a Runner for tests: it answers each program from a table and
// records every call, so a test asserts both what was parsed and exactly what
// argv and stdin would have run — on any OS.
type FakeRunner struct {
	mu      sync.Mutex
	Outputs map[string]string // keyed by program name
	Errs    map[string]error
	// Seq answers successive calls of one program in order, before Outputs:
	// a test that reads a value, changes it and reads it back scripts both.
	Seq   map[string][]string
	Calls []FakeCall
}

// FakeCall is one recorded run. Env is what RunEnv added to the program's
// environment; nil for Run.
type FakeCall struct {
	Name  string
	Args  []string
	Stdin string
	Env   []string
}

// Run records the call, then answers it from Errs, then Seq, then Outputs.
// An unscripted program is an error, never an empty success.
func (f *FakeRunner) Run(ctx context.Context, name string, args []string, stdin string) (string, error) {
	return f.RunEnv(ctx, nil, name, args, stdin)
}

// RunEnv is Run, recording env too.
func (f *FakeRunner) RunEnv(_ context.Context, env []string, name string, args []string, stdin string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, FakeCall{Name: name, Args: append([]string(nil), args...), Stdin: stdin,
		Env: append([]string(nil), env...)})
	if err, ok := f.Errs[name]; ok {
		return "", err
	}
	if q := f.Seq[name]; len(q) > 0 {
		f.Seq[name] = q[1:]
		return q[0], nil
	}
	if out, ok := f.Outputs[name]; ok {
		return out, nil
	}
	return "", fmt.Errorf("fake runner: nothing scripted for %s %s", name, strings.Join(args, " "))
}
