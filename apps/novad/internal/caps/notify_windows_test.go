package caps

import (
	"context"
	"strings"
	"testing"

	"novad/internal/platform"
)

func TestNotifyOnWindowsPassesTheMessageOnStdin(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{"powershell.exe": ""}}
	msg := "Café ☕ — backup done"
	if out := notify(context.Background(), r, msg); !out.OK {
		t.Fatal(out.Error)
	}
	call := r.Calls[0]
	if call.Name != "powershell.exe" || call.Stdin != msg {
		t.Fatalf("got %+v", call)
	}
	for _, a := range call.Args {
		if strings.Contains(a, "Café") {
			t.Fatal("the message must never be in argv or the script")
		}
	}
}
