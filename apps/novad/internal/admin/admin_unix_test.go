//go:build unix

package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// visudoFake stands in for visudo: it records each call and the bytes of the
// file it was asked to check (read AT check time), and refuses with said
// when said is not empty. Nothing here ever runs a real visudo or sudo.
type visudoFake struct {
	said    string
	calls   [][]string
	checked []string
}

func (v *visudoFake) Run(_ context.Context, name string, args []string, _ string) (string, error) {
	v.calls = append(v.calls, append([]string{name}, args...))
	if name != "visudo" {
		return "", errors.New("unexpected program " + name)
	}
	if len(args) == 2 && args[0] == "-cf" {
		b, err := os.ReadFile(args[1])
		if err != nil {
			return "", err
		}
		v.checked = append(v.checked, string(b))
	}
	if v.said != "" {
		return "", errors.New(v.said)
	}
	return "", nil
}

type chownCall struct {
	path     string
	uid, gid int
}

// testEnv is an Env rooted in a temp dir, euid as given, with a fake agent
// binary holding self's bytes.
func testEnv(t *testing.T, euid int, v *visudoFake, self string) (Env, *[]chownCall) {
	t.Helper()
	root := t.TempDir()
	bin := filepath.Join(t.TempDir(), "novad")
	if err := os.WriteFile(bin, []byte(self), 0o700); err != nil {
		t.Fatal(err)
	}
	var chowns []chownCall
	return Env{
		Root:     root,
		Runner:   v,
		Euid:     func() int { return euid },
		Username: func() (string, error) { return "root", nil },
		Self:     func() (string, error) { return bin, nil },
		Chown: func(p string, uid, gid int) error {
			chowns = append(chowns, chownCall{p, uid, gid})
			return nil
		},
	}, &chowns
}

func mode(t *testing.T, p string) os.FileMode {
	t.Helper()
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat %s: %v", p, err)
	}
	return fi.Mode().Perm()
}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	return names
}

const wantRule = "jeremy ALL=(root) NOPASSWD: /usr/local/libexec/nova/novad admin exec *\n" +
	"Defaults!/usr/local/libexec/nova/novad !requiretty\n"

func TestRuleNamesTheRootCopyAndAdminExecOnly(t *testing.T) {
	got, err := Rule("jeremy")
	if err != nil {
		t.Fatalf("Rule: %v", err)
	}
	if got != wantRule {
		t.Fatalf("rule:\n%q\nwant\n%q", got, wantRule)
	}
}

func TestRuleRefusesAUserNameThatIsNotOneWord(t *testing.T) {
	for _, u := range []string{"jeremy", "svc_nova", "a.b-c"} {
		if _, err := Rule(u); err != nil {
			t.Errorf("Rule(%q): %v, want accepted", u, err)
		}
	}
	for _, u := range []string{"", "bob ALL=(ALL) ALL", "bob\nroot", "%admin", "bob,eve", "a:b"} {
		if _, err := Rule(u); err == nil {
			t.Errorf("Rule(%q): no error", u)
		}
	}
}

func TestInstallRefusesUnlessRootAndTouchesNothing(t *testing.T) {
	v := &visudoFake{}
	e, chowns := testEnv(t, 1000, v, "agent-bytes")
	_, err := Install(context.Background(), e, "jeremy")
	if err == nil || !strings.HasPrefix(err.Error(), "cannot: admin install runs as root") {
		t.Fatalf("err = %v, want the cannot: admin install runs as root words", err)
	}
	if len(v.calls) != 0 || len(*chowns) != 0 {
		t.Fatalf("a refused install ran visudo %v / chown %v", v.calls, *chowns)
	}
	if names := dirNames(t, filepath.Join(e.Root, "etc", "sudoers.d")); len(names) != 0 {
		t.Fatalf("a refused install left %v", names)
	}
	if _, err := os.Stat(e.CopyFile()); !os.IsNotExist(err) {
		t.Fatalf("a refused install left the copy: %v", err)
	}
}

func TestInstallCopiesTheAgentAndWritesAVisudoCheckedDropIn(t *testing.T) {
	v := &visudoFake{}
	e, chowns := testEnv(t, 0, v, "agent-bytes")
	said, err := Install(context.Background(), e, "jeremy")
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if said == "" {
		t.Error("Install said nothing")
	}
	// The root copy: the agent's bytes, 0755, in a 0755 dir, owned 0:0.
	b, err := os.ReadFile(e.CopyFile())
	if err != nil || string(b) != "agent-bytes" {
		t.Fatalf("copy = %q, %v", b, err)
	}
	if m := mode(t, e.CopyFile()); m != 0o755 {
		t.Errorf("copy mode %o, want 755", m)
	}
	if m := mode(t, filepath.Dir(e.CopyFile())); m != 0o755 {
		t.Errorf("copy dir mode %o, want 755", m)
	}
	// The drop-in: the rule, 0440, the ONLY entry in sudoers.d.
	d, err := os.ReadFile(e.DropInFile())
	if err != nil || string(d) != wantRule {
		t.Fatalf("drop-in = %q, %v", d, err)
	}
	if m := mode(t, e.DropInFile()); m != 0o440 {
		t.Errorf("drop-in mode %o, want 440", m)
	}
	if names := dirNames(t, filepath.Dir(e.DropInFile())); len(names) != 1 || names[0] != "nova-admin" {
		t.Errorf("sudoers.d holds %v, want only nova-admin", names)
	}
	// visudo checked exactly those bytes, in a temp file sudo would ignore
	// (a '.' in its name), in the drop-in's own dir (so the rename is atomic).
	if len(v.calls) != 1 || len(v.checked) != 1 || v.checked[0] != wantRule {
		t.Fatalf("visudo calls %v checked %q", v.calls, v.checked)
	}
	tmp := v.calls[0][2]
	if filepath.Dir(tmp) != filepath.Dir(e.DropInFile()) {
		t.Errorf("visudo checked %s, not in %s: the rename would not be atomic", tmp, filepath.Dir(e.DropInFile()))
	}
	if !strings.Contains(filepath.Base(tmp), ".") {
		t.Errorf("temp name %q has no '.': sudo would read it before it was checked", filepath.Base(tmp))
	}
	// Owned by root: copy, its dir and the drop-in all chowned 0:0.
	owned := map[string]bool{}
	for _, c := range *chowns {
		if c.uid != 0 || c.gid != 0 {
			t.Errorf("chown %s to %d:%d, want 0:0", c.path, c.uid, c.gid)
		}
		owned[c.path] = true
	}
	for _, p := range []string{e.CopyFile(), filepath.Dir(e.CopyFile()), e.DropInFile()} {
		if !owned[p] {
			t.Errorf("%s never chowned to root (chowned: %v)", p, *chowns)
		}
	}
}

func TestInstallWithARefusedRuleLeavesNoFileAndSaysVisudosWords(t *testing.T) {
	said := ">>> /etc/sudoers.d/.nova-admin.tmp: syntax error near line 1 <<<"
	v := &visudoFake{said: said}
	e, _ := testEnv(t, 0, v, "agent-bytes")
	_, err := Install(context.Background(), e, "jeremy")
	if err == nil || !strings.Contains(err.Error(), "syntax error near line 1") {
		t.Fatalf("err = %v, want visudo's own words", err)
	}
	if names := dirNames(t, filepath.Dir(e.DropInFile())); len(names) != 0 {
		t.Fatalf("a refused rule left %v in sudoers.d", names)
	}
}

func TestInstallTwiceReplacesTheCopyAndTheDropIn(t *testing.T) {
	v := &visudoFake{}
	e, _ := testEnv(t, 0, v, "build-1")
	if _, err := Install(context.Background(), e, "jeremy"); err != nil {
		t.Fatalf("first Install: %v", err)
	}
	if err := os.WriteFile(mustSelf(t, e), []byte("build-2"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(context.Background(), e, "jeremy"); err != nil {
		t.Fatalf("second Install: %v", err)
	}
	if b, _ := os.ReadFile(e.CopyFile()); string(b) != "build-2" {
		t.Errorf("copy after reinstall = %q, want build-2", b)
	}
	if d, _ := os.ReadFile(e.DropInFile()); string(d) != wantRule {
		t.Errorf("drop-in after reinstall = %q", d)
	}
	if names := dirNames(t, filepath.Dir(e.DropInFile())); len(names) != 1 {
		t.Errorf("sudoers.d after reinstall holds %v", names)
	}
}

// A re-run for another user rewrites the drop-in (not just the copy): the
// rule names the new user only, visudo checked it again, and sudoers.d still
// holds the one entry.
func TestInstallAgainForAnotherUserRewritesTheDropIn(t *testing.T) {
	v := &visudoFake{}
	e, _ := testEnv(t, 0, v, "build-1")
	if _, err := Install(context.Background(), e, "jeremy"); err != nil {
		t.Fatalf("first Install: %v", err)
	}
	if err := os.WriteFile(mustSelf(t, e), []byte("build-2"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(context.Background(), e, "nova"); err != nil {
		t.Fatalf("second Install: %v", err)
	}
	want, err := Rule("nova")
	if err != nil {
		t.Fatal(err)
	}
	d, _ := os.ReadFile(e.DropInFile())
	if string(d) != want {
		t.Errorf("drop-in after reinstall for nova = %q, want %q", d, want)
	}
	if strings.Contains(string(d), "jeremy") {
		t.Errorf("drop-in after reinstall for nova still names jeremy: %q", d)
	}
	if len(v.checked) != 2 || v.checked[1] != want {
		t.Errorf("visudo checked %q, want two checks, the second of Rule(nova)", v.checked)
	}
	if b, _ := os.ReadFile(e.CopyFile()); string(b) != "build-2" {
		t.Errorf("copy after reinstall = %q, want build-2", b)
	}
	if names := dirNames(t, filepath.Dir(e.DropInFile())); len(names) != 1 {
		t.Errorf("sudoers.d after reinstall holds %v", names)
	}
}

func mustSelf(t *testing.T, e Env) string {
	t.Helper()
	p, err := e.Self()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestUninstallRemovesBothAndAbsentIsNothingToDo(t *testing.T) {
	v := &visudoFake{}
	e, _ := testEnv(t, 0, v, "agent-bytes")
	if _, err := Install(context.Background(), e, "jeremy"); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if _, err := Uninstall(context.Background(), e); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	for _, p := range []string{e.DropInFile(), e.CopyFile()} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s still there after uninstall: %v", p, err)
		}
	}
	said, err := Uninstall(context.Background(), e)
	if err != nil {
		t.Fatalf("Uninstall of nothing: %v", err)
	}
	if !strings.Contains(said, "nothing to do") {
		t.Errorf("Uninstall of nothing said %q, want it to say nothing to do", said)
	}
}

func TestUninstallRefusesUnlessRoot(t *testing.T) {
	e, _ := testEnv(t, 1000, &visudoFake{}, "x")
	if _, err := Uninstall(context.Background(), e); err == nil || !strings.HasPrefix(err.Error(), "cannot:") {
		t.Fatalf("err = %v, want a cannot", err)
	}
}

func TestExecPassesTheChildsExitCodeAndCombinedOutput(t *testing.T) {
	var out bytes.Buffer
	code, err := Exec(context.Background(), ExecOpts{
		Argv:    []string{"sh", "-c", "echo out; echo err >&2; exit 7"},
		Timeout: 10 * time.Second,
	}, &out)
	if err != nil || code != 7 {
		t.Fatalf("code %d err %v, want 7 nil", code, err)
	}
	if !strings.Contains(out.String(), "out") || !strings.Contains(out.String(), "err") {
		t.Errorf("output %q lacks stdout or stderr", out.String())
	}
}

func TestExecRunsInCwd(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	var out bytes.Buffer
	code, err := Exec(context.Background(), ExecOpts{Argv: []string{"pwd"}, Cwd: dir, Timeout: 10 * time.Second}, &out)
	if err != nil || code != 0 || strings.TrimSpace(out.String()) != dir {
		t.Fatalf("code %d err %v out %q, want %s", code, err, out.String(), dir)
	}
}

// The root side owns the deadline: the user-side agent cannot SIGKILL a
// root group, so Exec itself must kill the WHOLE group — a backgrounded
// grandchild included — at Timeout.
func TestExecKillsTheWholeGroupAtTheTimeout(t *testing.T) {
	var out bytes.Buffer
	start := time.Now()
	_, err := Exec(context.Background(), ExecOpts{
		Argv:    []string{"sh", "-c", "sleep 300 & echo $!; wait"},
		Timeout: 500 * time.Millisecond,
	}, &out)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if el := time.Since(start); el > 5*time.Second {
		t.Fatalf("Exec took %v past a 500ms timeout", el)
	}
	pid, perr := strconv.Atoi(strings.TrimSpace(out.String()))
	if perr != nil {
		t.Fatalf("no grandchild pid in output %q", out.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("grandchild sleep %d outlived the timeout", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestWhoamiIsJSONEuidAndUser(t *testing.T) {
	e, _ := testEnv(t, 0, &visudoFake{}, "x")
	b, err := Whoami(e)
	if err != nil {
		t.Fatalf("Whoami: %v", err)
	}
	var got struct {
		Euid *int   `json:"euid"`
		User string `json:"user"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("not JSON: %q: %v", b, err)
	}
	if got.Euid == nil || *got.Euid != 0 || got.User != "root" {
		t.Fatalf("whoami = %s", b)
	}
}

// A child killed by a signal it did not get from the deadline exits
// 128+signal (the shell's convention), never -1 or a timeout.
func TestExecSaysASignalledChildAs128PlusTheSignal(t *testing.T) {
	var out bytes.Buffer
	code, err := Exec(context.Background(), ExecOpts{
		Argv:    []string{"sh", "-c", "kill -TERM $$"},
		Timeout: 10 * time.Second,
	}, &out)
	if err != nil || code != 128+int(syscall.SIGTERM) {
		t.Fatalf("code %d err %v, want %d nil", code, err, 128+int(syscall.SIGTERM))
	}
}

// A refused user name is refused before anything is written, even as root.
func TestInstallWithABadUserNameTouchesNothing(t *testing.T) {
	v := &visudoFake{}
	e, chowns := testEnv(t, 0, v, "agent-bytes")
	if _, err := Install(context.Background(), e, "bob ALL=(ALL) ALL"); err == nil {
		t.Fatal("Install took a user name that is not one word")
	}
	if len(v.calls) != 0 || len(*chowns) != 0 {
		t.Fatalf("a refused name ran visudo %v / chown %v", v.calls, *chowns)
	}
	if _, err := os.Stat(e.CopyFile()); !os.IsNotExist(err) {
		t.Fatalf("a refused name left the copy: %v", err)
	}
}
