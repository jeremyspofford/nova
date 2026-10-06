package caps

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// testDeps is a handler's ambient facts over a throwaway home: the only thing
// a capability needs from the daemon is where "here" is.
func testDeps(t *testing.T) Deps {
	t.Helper()
	return Deps{Home: t.TempDir()}
}

// No path blocklist on the device (owner ruling 2026-09-03): a verified
// command runs anywhere the user novad runs as can write — including the
// paths the old deny-roots refused (~/.ssh, the daemon's own custody dir).
// Verification proves WHO signed a command; nothing here second-guesses WHAT
// it asked for. A rebuilt blocklist reddens this.
func TestAVerifiedFsWriteRunsAnywhereTheUserCan(t *testing.T) {
	d := testDeps(t)
	for _, target := range []string{
		filepath.Join(d.Home, ".ssh", "authorized_keys"),
		filepath.Join(d.Home, ".config", "novad", "key"),
	} {
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			t.Fatal(err)
		}
		out := Dispatch(context.Background(), "fs.write",
			map[string]any{"path": target, "content": "written"}, d)
		if !out.OK {
			t.Fatalf("fs.write to %s must run (no blocklist on the device): %q", target, out.Error)
		}
		body, err := os.ReadFile(target)
		if err != nil || string(body) != "written" {
			t.Fatalf("fs.write to %s claimed ok but the file reads %q (%v)", target, body, err)
		}
		if r := Dispatch(context.Background(), "fs.read", map[string]any{"path": target}, d); !r.OK {
			t.Fatalf("fs.read of %s must run: %q", target, r.Error)
		}
	}
}

func TestFsWriteThenReadRoundTrips(t *testing.T) {
	d := testDeps(t)
	path := filepath.Join(d.Home, "note.txt")
	w := Dispatch(context.Background(), "fs.write",
		map[string]any{"path": path, "content": "hello world"}, d)
	if !w.OK {
		t.Fatalf("write should succeed: %q", w.Error)
	}
	r := Dispatch(context.Background(), "fs.read", map[string]any{"path": path}, d)
	if !r.OK {
		t.Fatalf("read should succeed: %q", r.Error)
	}
	if r.Output != "hello world" {
		t.Errorf("read back %q, want %q", r.Output, "hello world")
	}
}

func TestFsReadRefusesOverTheCapWithoutTruncating(t *testing.T) {
	d := testDeps(t)
	path := filepath.Join(d.Home, "big.bin")
	if err := os.WriteFile(path, make([]byte, ReadCap+1), 0o644); err != nil {
		t.Fatal(err)
	}
	out := Dispatch(context.Background(), "fs.read", map[string]any{"path": path}, d)
	if out.OK {
		t.Fatal("a file over the 256 KiB cap must be refused, never truncated")
	}
	if !strings.Contains(out.Error, "read cap") {
		t.Errorf("refusal should name the cap, got: %q", out.Error)
	}
}

// The boundary: a file exactly at the cap is allowed and read in full (proving
// the mechanical LimitReader(ReadCap+1) reads all ReadCap bytes), while ReadCap+1
// (above) is refused.
func TestFsReadAllowsExactlyTheCap(t *testing.T) {
	d := testDeps(t)
	path := filepath.Join(d.Home, "atcap.bin")
	if err := os.WriteFile(path, make([]byte, ReadCap), 0o644); err != nil {
		t.Fatal(err)
	}
	out := Dispatch(context.Background(), "fs.read", map[string]any{"path": path}, d)
	if !out.OK {
		t.Fatalf("a file exactly at the cap must be allowed: %q", out.Error)
	}
	if len(out.Output) != ReadCap {
		t.Fatalf("expected a full read of %d bytes, got %d", ReadCap, len(out.Output))
	}
}

// The write cap mirrors the read cap: content over 256 KiB is a STATED refusal
// at the edge (defence in depth — core caps it too), never a partial write.
func TestFsWriteRefusesOverTheCapWithoutWriting(t *testing.T) {
	d := testDeps(t)
	path := filepath.Join(d.Home, "big.txt")
	out := Dispatch(context.Background(), "fs.write",
		map[string]any{"path": path, "content": strings.Repeat("a", WriteCap+1)}, d)
	if out.OK {
		t.Fatal("content over the 256 KiB write cap must be refused, never written")
	}
	if !strings.Contains(out.Error, "write cap") {
		t.Errorf("refusal should name the cap, got: %q", out.Error)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("the refused write must not have created the file")
	}
}

// The boundary: content exactly at the cap is allowed and written in full.
func TestFsWriteAllowsExactlyTheCap(t *testing.T) {
	d := testDeps(t)
	path := filepath.Join(d.Home, "atcap.txt")
	out := Dispatch(context.Background(), "fs.write",
		map[string]any{"path": path, "content": strings.Repeat("a", WriteCap)}, d)
	if !out.OK {
		t.Fatalf("content exactly at the cap must be allowed: %q", out.Error)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("the write should have created the file: %v", err)
	}
	if info.Size() != int64(WriteCap) {
		t.Fatalf("wrote %d bytes, want %d", info.Size(), WriteCap)
	}
}

func TestShellExecRejectsNonStringArgv(t *testing.T) {
	d := testDeps(t)
	out := Dispatch(context.Background(), "shell.exec",
		map[string]any{"argv": []any{"echo", 42}}, d)
	if out.OK {
		t.Fatal("a non-string argv element must be refused")
	}
}

func TestUnknownCapabilityIsRefused(t *testing.T) {
	d := testDeps(t)
	out := Dispatch(context.Background(), "fs.destroy", map[string]any{}, d)
	if out.OK {
		t.Fatal("an unknown capability must be refused, not executed")
	}
}

func TestSystemInfoReportsRealNumbers(t *testing.T) {
	d := testDeps(t)
	out := Dispatch(context.Background(), "system.info", map[string]any{}, d)
	if !out.OK {
		t.Fatalf("system.info should succeed: %q", out.Error)
	}
	for _, want := range []string{"disk", "mem", "host="} {
		if !strings.Contains(out.Output, want) {
			t.Errorf("system.info output missing %q: %s", want, out.Output)
		}
	}
}

// The capability list is DERIVED from the dispatch table: a capability is
// listed because a handler exists (doing-things S30's daemon.info reads
// Names), never because a name was written twice.
func TestNamesAreDerivedFromTheTable(t *testing.T) {
	want := []string{
		"apps.launch", "apps.list", "daemon.update", "facts.refresh", "fs.list", "fs.read",
		"fs.write", "shell.exec", "system.info", "system.notify",
	}
	if got := Names(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Names() = %v, want %v", got, want)
	}
}

// S30 restates these words to say a daemon is too old for a call.
func TestUnknownCapabilityKeepsItsExactWords(t *testing.T) {
	out := Dispatch(context.Background(), "fs.destroy", map[string]any{}, testDeps(t))
	if out.OK || out.Error != `unknown capability "fs.destroy"` {
		t.Fatalf("got ok=%v %q", out.OK, out.Error)
	}
}

func TestFactsRefreshWithoutASocketSaysCannot(t *testing.T) {
	out := Dispatch(context.Background(), "facts.refresh", map[string]any{}, testDeps(t))
	if out.OK || !strings.HasPrefix(out.Error, "cannot:") {
		t.Fatalf("got ok=%v %q", out.OK, out.Error)
	}
}

// The frame goes out BEFORE the result: SendFacts runs inside the handler,
// so by the time core's command returns, core has recorded the facts.
func TestFactsRefreshSendsTheFrameThenAnswers(t *testing.T) {
	sent := 0
	d := testDeps(t)
	d.SendFacts = func(context.Context) error { sent++; return nil }
	out := Dispatch(context.Background(), "facts.refresh", map[string]any{}, d)
	if !out.OK || sent != 1 {
		t.Fatalf("ok=%v sent=%d %q", out.OK, sent, out.Error)
	}
	d.SendFacts = func(context.Context) error { return errors.New("socket gone") }
	if out := Dispatch(context.Background(), "facts.refresh", map[string]any{}, d); out.OK {
		t.Fatal("a frame that could not be written is ok:false, never 'facts sent'")
	}
}

// Every fact is NAMED, as a value or as unknown — an omitted line reads as
// though it was never asked. (Before S42a, os= and uptime= were silently
// dropped off Linux.)
func TestSystemInfoNamesEveryFactEvenWhenUnknown(t *testing.T) {
	out := Dispatch(context.Background(), "system.info", map[string]any{}, testDeps(t))
	if !out.OK {
		t.Fatalf("system.info should succeed: %q", out.Error)
	}
	for _, want := range []string{"host=", "os=", "disk", "mem", "uptime="} {
		if !strings.Contains(out.Output, want) {
			t.Errorf("system.info output missing %q: %s", want, out.Output)
		}
	}
}
