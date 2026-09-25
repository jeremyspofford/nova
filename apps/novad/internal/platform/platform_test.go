package platform

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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
