package supervise

import (
	"os"
	"path/filepath"
	"testing"
)

// A revert that cannot put .prev back must not leave the machine with no
// build at all: nothing would start the agent again. The build that did not
// connect goes back in place (it may only have been slow to connect), and the
// error says why nothing was put back.
func TestARevertWithNoPreviousBuildLeavesTheInstalledOneInPlace(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "novad")
	if err := os.WriteFile(bin, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Revert(bin); err == nil {
		t.Fatal("Revert reported success with no previous build to put back")
	}
	if got := read(t, bin); got != "new" {
		t.Fatalf("installed build = %q — a revert with nothing to put back must leave a build in place", got)
	}
}
