package install

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"novad/internal/platform"
)

// S30b T4: `novad uninstall` removes the admin path first, through the
// path, and says so; a failure is in its error, never swallowed.

func uninstallWith(t *testing.T, hook func(context.Context) (string, error)) (string, error, []string) {
	t.Helper()
	p := paths(t)
	enrolled(t, p, "http://127.0.0.1:3000")
	dir := t.TempDir()
	bin := filepath.Join(dir, platform.BinaryName)
	_ = os.WriteFile(bin, []byte("x"), 0o755)
	var order []string
	svc := &fakeService{installed: bin}
	var out bytes.Buffer
	wrapped := hook
	if hook != nil {
		wrapped = func(ctx context.Context) (string, error) {
			// The agent's binary is still there when the path goes.
			if _, err := os.Stat(bin); err != nil {
				order = append(order, "admin path after the binary went")
			} else {
				order = append(order, "admin path")
			}
			return hook(ctx)
		}
	}
	err := Uninstall(context.Background(), UninstallOptions{Paths: p, InstallDir: dir, Service: svc, Now: time.Now, Out: &out, AdminPath: wrapped})
	if _, serr := os.Stat(bin); !errors.Is(serr, os.ErrNotExist) {
		order = append(order, "binary still there")
	}
	return out.String(), err, order
}

func TestUninstallRemovesTheAdminPathFirstAndSaysSo(t *testing.T) {
	out, err, order := uninstallWith(t, func(context.Context) (string, error) {
		return "the admin path is removed: nothing of it is left", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(order) != 1 || order[0] != "admin path" {
		t.Fatalf("order = %q: the path goes first, then the agent", order)
	}
	if !strings.Contains(out, "removed:    the admin path (the admin path is removed: nothing of it is left)") {
		t.Fatalf("out:\n%s", out)
	}
}

func TestUninstallWithNoAdminPathSaysNothingOfIt(t *testing.T) {
	out, err, _ := uninstallWith(t, func(context.Context) (string, error) { return "", nil })
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "admin path") {
		t.Fatalf("out:\n%s", out)
	}
}

func TestUninstallStatesAnAdminPathItCouldNotRemove(t *testing.T) {
	out, err, order := uninstallWith(t, func(context.Context) (string, error) {
		return "", errors.New("the admin path was not removed: the root copy /usr/local/libexec/nova/novad is still there")
	})
	if err == nil || !strings.Contains(err.Error(), "removing the admin path: the admin path was not removed") {
		t.Fatalf("err = %v: never swallowed", err)
	}
	if strings.Contains(out, "removed:    the admin path") {
		t.Fatalf("out:\n%s", out)
	}
	if len(order) != 1 || order[0] != "admin path" {
		t.Fatalf("order = %q: the rest of the uninstall still runs", order)
	}
}
