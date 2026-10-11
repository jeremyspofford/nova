//go:build unix

package admin

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ReadPathAt over a fake sudo script (never real sudo): it logs its argv
// and answers `-n -l` with listExit, or sleeps when hang.
func fakeListSudo(t *testing.T, listExit int, said string, hang bool) (sudo, log string) {
	t.Helper()
	dir := t.TempDir()
	sudo, log = filepath.Join(dir, "sudo"), filepath.Join(dir, "calls")
	body := fmt.Sprintf("printf '%%s' '%s' >&2\nexit %d\n", said, listExit)
	if hang {
		body = "exec sleep 30\n"
	}
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$*\" >> '%s'\n%s", log, body)
	if err := os.WriteFile(sudo, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return sudo, log
}

func calls(t *testing.T, log string) []string {
	t.Helper()
	b, err := os.ReadFile(log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n")
}

func TestReadPathAtNoCopyAsksSudoNothing(t *testing.T) {
	sudo, log := fakeListSudo(t, 0, "", false)
	got := ReadPathAt(context.Background(), sudo, filepath.Join(t.TempDir(), "novad"))
	if got.Installed || got.State != PathAbsent || got.Kind != KindNone {
		t.Fatalf("got %+v", got)
	}
	if c := calls(t, log); len(c) != 0 {
		t.Fatalf("sudo ran with no root copy: %q", c)
	}
}

func TestReadPathAtCopyAndRuleIsInstalled(t *testing.T) {
	sudo, log := fakeListSudo(t, 0, "", false)
	cp := filepath.Join(t.TempDir(), "novad")
	if err := os.WriteFile(cp, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	got := ReadPathAt(context.Background(), sudo, cp)
	if !got.Installed || got.Kind != KindSudoers || got.State != PathReady {
		t.Fatalf("got %+v", got)
	}
	if c := calls(t, log); len(c) != 1 || c[0] != "-n -l "+cp+" admin exec" {
		t.Fatalf("calls = %q", c)
	}
}

func TestReadPathAtRuleRefusedIsIncompleteInSudosWords(t *testing.T) {
	sudo, _ := fakeListSudo(t, 1, "sudo: a password is required", false)
	cp := filepath.Join(t.TempDir(), "novad")
	if err := os.WriteFile(cp, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	got := ReadPathAt(context.Background(), sudo, cp)
	if got.Installed || got.State != PathIncomplete || !strings.Contains(got.Said, "a password is required") {
		t.Fatalf("got %+v", got)
	}
}

func TestReadPathAtSudoThatDoesNotAnswerIsUnknownByTheBound(t *testing.T) {
	sudo, _ := fakeListSudo(t, 0, "", true)
	cp := filepath.Join(t.TempDir(), "novad")
	if err := os.WriteFile(cp, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	got := ReadPathAt(ctx, sudo, cp)
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("the read waited %s past its bound", took)
	}
	if got.Installed || got.State != PathUnknown || got.Said == "" {
		t.Fatalf("got %+v", got)
	}
}
