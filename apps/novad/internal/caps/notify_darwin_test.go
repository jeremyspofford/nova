package caps

import (
	"context"
	"strings"
	"testing"

	"novad/internal/platform"
)

// An AppleScript-injection-shaped message stays DATA: it is item 1 of argv,
// never part of the -e source.
func TestNotifyOnMacOSPassesTheMessageAsArgvNeverAsScript(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{"/usr/bin/osascript": ""}}
	msg := `done" & do shell script "rm -rf ~" & "`
	if out := notify(context.Background(), r, msg); !out.OK {
		t.Fatal(out.Error)
	}
	args := r.Calls[0].Args
	if args[len(args)-1] != msg {
		t.Fatalf("the message must be the last argv element: %v", args)
	}
	for _, a := range args[:len(args)-1] {
		if strings.Contains(a, "rm -rf") {
			t.Fatal("the message leaked into the script")
		}
	}
}
