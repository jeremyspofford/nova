package main

import (
	"context"
	"strings"
	"testing"

	"novad/internal/caps"
)

func TestAdminPathHookMapsAdminUninstall(t *testing.T) {
	var got []string
	dispatch := func(out caps.Outcome) func(context.Context, string, map[string]any, caps.Deps) caps.Outcome {
		return func(_ context.Context, name string, _ map[string]any, _ caps.Deps) caps.Outcome {
			got = append(got, name)
			return out
		}
	}
	said, err := adminPathHook(dispatch(caps.Outcome{OK: true, Output: "the admin path is removed"}))(context.Background())
	if err != nil || said != "the admin path is removed" || len(got) != 1 || got[0] != "admin.uninstall" {
		t.Fatalf("ok: got (%q, %v), dispatched %q", said, err, got)
	}
	said, err = adminPathHook(dispatch(caps.Outcome{Error: caps.NoAdminPath}))(context.Background())
	if err != nil || said != "" {
		t.Fatalf("no path: got (%q, %v), want nothing to say", said, err)
	}
	_, err = adminPathHook(dispatch(caps.Outcome{Error: "the admin path was not removed: the task is still there"}))(context.Background())
	if err == nil || !strings.Contains(err.Error(), "the task is still there") {
		t.Fatalf("failure: err = %v", err)
	}
}
