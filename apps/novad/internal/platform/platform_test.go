package platform

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestMachineUIDIsASaltedHashNeverTheRawID(t *testing.T) {
	got, err := hashMachineID("  0A1B2C3D-Machine\n")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("nova/machine-uid/v1:0a1b2c3d-machine"))
	if got != hex.EncodeToString(sum[:]) {
		t.Fatalf("got %s", got)
	}
	if len(got) != 64 || strings.Contains(got, "0a1b2c3d") {
		t.Fatalf("the uid must be a 64-hex hash that does not carry the raw id: %s", got)
	}
}

func TestAnEmptyMachineIDIsAnErrorNeverAHashOfNothing(t *testing.T) {
	if _, err := hashMachineID(" \n"); err == nil {
		t.Fatal("an empty id must be an error")
	}
}

func TestFakeRunnerRecordsArgvAndStdinAndAnswersFromItsTable(t *testing.T) {
	r := &FakeRunner{Outputs: map[string]string{"tool": "out"}, Errs: map[string]error{"bad": errors.New("boom")}}
	out, err := r.Run(context.Background(), "tool", []string{"-a", "b"}, "in")
	if err != nil || out != "out" {
		t.Fatalf("got %q %v", out, err)
	}
	if _, err := r.Run(context.Background(), "bad", nil, ""); err == nil {
		t.Fatal("a scripted error must be returned")
	}
	if _, err := r.Run(context.Background(), "unscripted", nil, ""); err == nil {
		t.Fatal("an unscripted program must be an error, never an empty success")
	}
	want := FakeCall{Name: "tool", Args: []string{"-a", "b"}, Stdin: "in"}
	if !reflect.DeepEqual(r.Calls[0], want) {
		t.Fatalf("recorded %+v", r.Calls[0])
	}
}

// TestHelperFailsInUTF16 is not a test: TestExecAddsTheEnvironmentAndKeeps
// AFailuresStderr runs this binary again with NOVA_TEST_HELPER=utf16-stderr
// — passed through RunEnv — and this plays a wsl.exe that ignored WSL_UTF8.
func TestHelperFailsInUTF16(t *testing.T) {
	if os.Getenv("NOVA_TEST_HELPER") != "utf16-stderr" {
		return
	}
	_, _ = os.Stderr.WriteString(asUTF16("bad news\r\n"))
	os.Exit(3)
}

// F3: Exec adds what RunEnv is given to the program's environment, and a
// failure keeps the program's stderr as written — RunWSL decodes wsl.exe's
// words and nothing else — under the same text as before.
func TestExecAddsTheEnvironmentAndKeepsAFailuresStderr(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, err = Exec{}.RunEnv(context.Background(), []string{"NOVA_TEST_HELPER=utf16-stderr"}, self,
		[]string{"-test.run=^TestHelperFailsInUTF16$"}, "")
	var re *RunError
	if !errors.As(err, &re) || re.Name != self || re.Stderr != asUTF16("bad news\r\n") {
		t.Fatalf("err = %#v: the helper never ran with the environment given, or its stderr was not kept", err)
	}
	if want := self + ": exit status 3: " + strings.TrimSpace(asUTF16("bad news\r\n")); err.Error() != want {
		t.Fatalf("text = %q, want %q", err.Error(), want)
	}
	if _, err := (Exec{}).Run(context.Background(), self, []string{"-test.run=^TestHelperFailsInUTF16$"}, ""); err != nil {
		t.Fatalf("without the variable the helper exits 0: %v", err)
	}
}
