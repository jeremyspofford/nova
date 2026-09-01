package caps

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"novad/internal/config"
)

func testDeps(t *testing.T) (Deps, config.Paths) {
	t.Helper()
	home := t.TempDir()
	p := config.Paths{
		ConfigDir:     filepath.Join(home, ".config", "novad"),
		StateDir:      filepath.Join(home, ".local", "state", "novad"),
		ConfigFile:    filepath.Join(home, ".config", "novad", "config.json"),
		KeyFile:       filepath.Join(home, ".config", "novad", "key"),
		DenyRootsFile: filepath.Join(home, ".config", "novad", "deny_roots"),
		AuditFile:     filepath.Join(home, ".local", "state", "novad", "audit.jsonl"),
		Home:          home,
	}
	dl, err := config.LoadDenyRoots(p)
	if err != nil {
		t.Fatal(err)
	}
	return Deps{Deny: dl, Home: home}, p
}

// The deny-roots backstop must hold even when a command is fully verified. This
// is the mechanical-over-prompts pin: a signed, in-fs_roots envelope targeting
// a deny-root path is refused ON THE DEVICE. We test it through Dispatch, the
// same path a verified command takes.
func TestDenyRootSurvivesAVerifiedFsWrite(t *testing.T) {
	d, p := testDeps(t)
	target := filepath.Join(p.Home, ".ssh", "authorized_keys")
	out := Dispatch(context.Background(), "fs.write",
		map[string]any{"path": target, "content": "pwned"}, d)
	if out.OK {
		t.Fatal("a write into ~/.ssh must be refused even for a verified command")
	}
	if !strings.Contains(out.Error, "deny root") {
		t.Errorf("refusal should name the deny root, got: %q", out.Error)
	}
	if _, err := os.Stat(target); err == nil {
		t.Fatal("the refused write must not have created the file")
	}
}

func TestDenyRootRefusesReadAndList(t *testing.T) {
	d, p := testDeps(t)
	ssh := filepath.Join(p.Home, ".ssh")
	if err := os.MkdirAll(ssh, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ssh, "id"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if out := Dispatch(context.Background(), "fs.read",
		map[string]any{"path": filepath.Join(ssh, "id")}, d); out.OK {
		t.Error("fs.read of a deny-root file must be refused")
	}
	if out := Dispatch(context.Background(), "fs.list",
		map[string]any{"path": ssh}, d); out.OK {
		t.Error("fs.list of a deny-root dir must be refused")
	}
}

func TestFsWriteThenReadRoundTrips(t *testing.T) {
	d, _ := testDeps(t)
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
	d, _ := testDeps(t)
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
	d, _ := testDeps(t)
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
	d, _ := testDeps(t)
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
	d, _ := testDeps(t)
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

// The ok-vs-exit_code seam: a process that RAN to completion is ok:true even on
// a nonzero exit; exit_code carries the command's own result.
func TestShellExecNonzeroExitIsOkTrueWithTheCode(t *testing.T) {
	d, _ := testDeps(t)
	out := Dispatch(context.Background(), "shell.exec",
		map[string]any{"argv": []any{"sh", "-c", "exit 3"}}, d)
	if !out.OK {
		t.Fatal("a process that ran to completion is ok:true even on a nonzero exit")
	}
	if out.ExitCode == nil || *out.ExitCode != 3 {
		t.Fatalf("exit_code = %v, want 3", out.ExitCode)
	}
}

func TestShellExecZeroExitCapturesOutput(t *testing.T) {
	d, _ := testDeps(t)
	out := Dispatch(context.Background(), "shell.exec",
		map[string]any{"argv": []any{"echo", "hello"}}, d)
	if !out.OK || out.ExitCode == nil || *out.ExitCode != 0 {
		t.Fatalf("echo should be ok:true exit 0, got ok=%v code=%v", out.OK, out.ExitCode)
	}
	if !strings.Contains(out.Output, "hello") {
		t.Errorf("output should contain 'hello', got %q", out.Output)
	}
}

// A binary that does not exist is the daemon UNABLE to perform the capability
// -> ok:false, not a fake exit code.
func TestShellExecUnstartableIsOkFalse(t *testing.T) {
	d, _ := testDeps(t)
	out := Dispatch(context.Background(), "shell.exec",
		map[string]any{"argv": []any{"this-binary-does-not-exist-xyz"}}, d)
	if out.OK {
		t.Fatal("a binary that cannot start must be ok:false")
	}
	if out.ExitCode != nil {
		t.Errorf("exit_code should be null for an unstartable command, got %v", out.ExitCode)
	}
}

func TestShellExecRejectsNonStringArgv(t *testing.T) {
	d, _ := testDeps(t)
	out := Dispatch(context.Background(), "shell.exec",
		map[string]any{"argv": []any{"echo", 42}}, d)
	if out.OK {
		t.Fatal("a non-string argv element must be refused")
	}
}

func TestShellExecOutputIsCappedAndStated(t *testing.T) {
	d, _ := testDeps(t)
	// Emit far more than the 64 KiB cap.
	out := Dispatch(context.Background(), "shell.exec",
		map[string]any{"argv": []any{"sh", "-c", "yes AAAAAAAA | head -c 200000"}}, d)
	if !out.OK {
		t.Fatalf("the command itself ran fine: %q", out.Error)
	}
	if len(out.Output) > OutputCap+64 { // cap + the short truncation note
		t.Errorf("output length %d exceeds the cap plus its note", len(out.Output))
	}
	if !strings.Contains(out.Output, "truncated at") {
		t.Error("reaching the cap must be stated, not silent")
	}
}

func TestUnknownCapabilityIsRefused(t *testing.T) {
	d, _ := testDeps(t)
	out := Dispatch(context.Background(), "fs.destroy", map[string]any{}, d)
	if out.OK {
		t.Fatal("an unknown capability must be refused, not executed")
	}
}

func TestSystemInfoReportsRealNumbers(t *testing.T) {
	d, _ := testDeps(t)
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
