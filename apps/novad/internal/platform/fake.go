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
	Calls   []FakeCall
}

// FakeCall is one recorded run.
type FakeCall struct {
	Name  string
	Args  []string
	Stdin string
}

// Run records the call, then answers it from Errs, then Outputs. An
// unscripted program is an error, never an empty success.
func (f *FakeRunner) Run(_ context.Context, name string, args []string, stdin string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, FakeCall{Name: name, Args: append([]string(nil), args...), Stdin: stdin})
	if err, ok := f.Errs[name]; ok {
		return "", err
	}
	if out, ok := f.Outputs[name]; ok {
		return out, nil
	}
	return "", fmt.Errorf("fake runner: nothing scripted for %s %s", name, strings.Join(args, " "))
}
