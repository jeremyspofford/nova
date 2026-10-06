package platform

import (
	"context"
	"encoding/base64"
	"errors"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestParseOSReleasePrettyReadsTheQuotedName(t *testing.T) {
	body := "NAME=\"Pop!_OS\"\nPRETTY_NAME=\"Pop!_OS 24.04 LTS\"\nID=pop\n"
	if got := ParseOSReleasePretty(body); got != "Pop!_OS 24.04 LTS" {
		t.Fatalf("got %q", got)
	}
	if got := ParseOSReleasePretty("ID=alpine\n"); got != "" {
		t.Fatalf("no PRETTY_NAME must read as empty, got %q", got)
	}
}

func TestParseIOPlatformUUIDFindsTheHardwareUUID(t *testing.T) {
	out := `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000200, registered, matched, active, busy 0 (1 ms), retain 34>
    {
      "IOPlatformSerialNumber" = "SERIAL00"
      "IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"
    }`
	got, err := ParseIOPlatformUUID(out)
	if err != nil || got != "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := ParseIOPlatformUUID("no uuid here"); err == nil {
		t.Fatal("output without IOPlatformUUID must be an error, never an empty id")
	}
}

// The registry's ProductName says "Windows 10" on Windows 11 — Microsoft never
// changed it — so the build number decides which one this is.
func TestWindowsProductNameSaysElevenFromTheBuild(t *testing.T) {
	if got := WindowsProductName("Windows 10 Pro", "24H2", "26100"); got != "Windows 11 Pro 24H2 (build 26100)" {
		t.Fatalf("got %q", got)
	}
	if got := WindowsProductName("Windows 10 Pro", "22H2", "19045"); got != "Windows 10 Pro 22H2 (build 19045)" {
		t.Fatalf("got %q", got)
	}
	if got := WindowsProductName("", "", ""); got != "Windows" {
		t.Fatalf("nothing readable must still name the OS, got %q", got)
	}
}

// PowerShell prints an array for many apps, a bare object for one, and
// nothing for none — all three are real outputs of the same command.
func TestParseStartAppsReadsAllThreeShapes(t *testing.T) {
	many, err := ParseStartApps(`[{"Name":"Notepad","AppID":"Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"},{"Name":"Paint","AppID":"Microsoft.Paint_8wekyb3d8bbwe!App"}]`)
	if err != nil || len(many) != 2 || many[0].Name != "Notepad" {
		t.Fatalf("array: %v %v", many, err)
	}
	one, err := ParseStartApps("\xef\xbb\xbf" + `{"Name":"Notepad","AppID":"Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"}`)
	if err != nil || !reflect.DeepEqual(one, []StartApp{{Name: "Notepad", AppID: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"}}) {
		t.Fatalf("object: %v %v", one, err)
	}
	none, err := ParseStartApps("  \r\n")
	if err != nil || len(none) != 0 {
		t.Fatalf("empty: %v %v", none, err)
	}
	if _, err := ParseStartApps("not json"); err == nil {
		t.Fatal("unreadable output must be an error")
	}
}

func TestEncodePowerShellIsUTF16LEBase64(t *testing.T) {
	got := EncodePowerShell("ab")
	raw, err := base64.StdEncoding.DecodeString(got)
	if err != nil || !reflect.DeepEqual(raw, []byte{'a', 0, 'b', 0}) {
		t.Fatalf("got %q -> %v (%v)", got, raw, err)
	}
}

// xdg-user-dirs writes a disabled folder as "$HOME" — that is "no such
// folder", never the home directory.
func TestParseUserDirsReadsTheFoldersAndSkipsDisabledOnes(t *testing.T) {
	body := `# written by xdg-user-dirs-update
XDG_DESKTOP_DIR="$HOME/Desktop"
XDG_DOCUMENTS_DIR="/data/docs"
XDG_DOWNLOAD_DIR="$HOME"
XDG_MUSIC_DIR="$HOME/Music"
`
	got := ParseUserDirs(body, "/home/sam")
	want := map[string]string{"desktop": "/home/sam/Desktop", "documents": "/data/docs"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if len(ParseUserDirs("XDG_DESKTOP_DIR=Desktop\n", "/home/sam")) != 0 {
		t.Fatal("a relative path is not a folder the OS names — never guessed")
	}
}

// P29: the look inside a running distribution, as its script prints it.
func TestParseWSLInsideReadsTheLook(t *testing.T) {
	out := "pid1=systemd\nuser=sam\nsudo=refused\nunit.ActiveState=active\nunit.UnitFileState=enabled\n" +
		"unit.MainPID=412\nunit.Restart=always\npids=412 \n"
	want := WSLInside{PID1: "systemd", User: "sam", Sudo: "refused", UnitActive: "active", UnitFile: "enabled",
		UnitRestart: "always", UnitMainPID: 412, PIDs: []int{412}}
	if got := ParseWSLInside(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

// A user bus systemctl cannot reach is said in systemctl's own words — never
// read as "no unit".
func TestParseWSLInsideKeepsWhatSystemctlSaidWhenItCouldNotAnswer(t *testing.T) {
	got := ParseWSLInside("pid1=systemd\nuser=sam\nsudo=refused\nunit.Failed to connect to bus: No medium found\npids=\n")
	if got.UnitActive != "" || got.UnitSaid != "Failed to connect to bus: No medium found" || got.PIDs != nil {
		t.Fatalf("got %+v", got)
	}
}

// wsl.exe writes UTF-16LE unless WSL_UTF8 took; both read the same.
func TestDecodeWSLReadsUTF16AndUTF8(t *testing.T) {
	utf16le := "\xff\xfeU\x00b\x00u\x00n\x00t\x00u\x00-\x002\x006\x00.\x000\x004\x00\r\x00\n\x00"
	if got := DecodeWSL(utf16le); got != "Ubuntu-26.04\r\n" {
		t.Fatalf("utf-16: %q", got)
	}
	if got := DecodeWSL("Ubuntu-26.04\r\n"); got != "Ubuntu-26.04\r\n" {
		t.Fatalf("utf-8: %q", got)
	}
}

// asUTF16 is s as a wsl.exe that ignored WSL_UTF8 writes it: UTF-16LE, no
// byte-order mark.
func asUTF16(s string) string {
	var b strings.Builder
	for _, u := range utf16.Encode([]rune(s)) {
		b.WriteByte(byte(u))
		b.WriteByte(byte(u >> 8))
	}
	return b.String()
}

// F3: every wsl.exe the agent runs is asked for UTF-8, and its output reads
// as text whichever encoding it used.
func TestRunWSLAsksForUTF8AndDecodesTheOutput(t *testing.T) {
	r := &FakeRunner{Seq: map[string][]string{"wsl.exe": {asUTF16("Ubuntu-26.04\r\n"), "Debian\n"}}}
	for _, want := range []string{"Ubuntu-26.04\r\n", "Debian\n"} {
		if got, err := RunWSL(context.Background(), r, "--list", "--quiet"); err != nil || got != want {
			t.Fatalf("got %q, %v; want %q", got, err, want)
		}
	}
	for _, c := range r.Calls {
		if c.Name != "wsl.exe" || !reflect.DeepEqual(c.Args, []string{"--list", "--quiet"}) ||
			!reflect.DeepEqual(c.Env, []string{"WSL_UTF8=1"}) {
			t.Fatalf("call = %+v: wsl.exe runs with WSL_UTF8=1, every time", c)
		}
	}
}

// F3: a wsl.exe that ignored WSL_UTF8 fails in UTF-16 on stderr, which Exec
// puts after its own ASCII prefix. Only wsl.exe's words are decoded: decoding
// the whole text would turn the prefix — and, at an odd length, every word
// after it — into nonsense.
func TestRunWSLDecodesOnlyWSLsOwnWordsInAFailure(t *testing.T) {
	failed := &RunError{Name: "wsl.exe", Err: errors.New("exit status 4294967295"),
		Stderr: asUTF16("There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n")}
	r := &FakeRunner{Errs: map[string]error{"wsl.exe": failed}}
	_, err := RunWSL(context.Background(), r, "-d", "Nope", "--exec", "/bin/true")
	want := "wsl.exe: exit status 4294967295: There is no distribution with the supplied name.\r\n" +
		"Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND"
	if err == nil || err.Error() != want {
		t.Fatalf("got %q\nwant %q", err, want)
	}
	var re *RunError
	if !errors.As(err, &re) || re.Err != failed.Err {
		t.Fatalf("the decoded failure keeps what it wraps: %#v", err)
	}
	// A failure from a runner that is not Exec is decoded whole.
	r = &FakeRunner{Errs: map[string]error{"wsl.exe": errors.New(asUTF16("The operation timed out.\r\n"))}}
	if _, err := RunWSL(context.Background(), r, "--list"); err == nil || err.Error() != "The operation timed out.\r\n" {
		t.Fatalf("got %q", err)
	}
}

// plainRunner can run a program but cannot add to its environment.
type plainRunner struct{ ran bool }

func (p *plainRunner) Run(context.Context, string, []string, string) (string, error) {
	p.ran = true
	return "", nil
}

// F3: no wsl.exe runs without WSL_UTF8=1 — a runner that cannot give it
// runs nothing and says so.
func TestRunWSLRunsNothingThroughARunnerThatCannotSetTheEnvironment(t *testing.T) {
	p := &plainRunner{}
	if _, err := RunWSL(context.Background(), p, "--list"); err == nil || !strings.Contains(err.Error(), "WSL_UTF8=1") || p.ran {
		t.Fatalf("err = %v, ran = %v", err, p.ran)
	}
}

// Fix round 1, Minor 6: a refusing sudo's first line is read, and pids=? —
// pgrep missing or failing — is unknown, never "no novad process".
func TestParseWSLInsideReadsSudosWordsAndUnknownPIDs(t *testing.T) {
	got := ParseWSLInside("pid1=systemd\nuser=sam\nsudo=refused\nsudo.said=sudo: a password is required\npids=?\n")
	if got.Sudo != "refused" || got.SudoSaid != "sudo: a password is required" || !got.PIDsUnknown || got.PIDs != nil {
		t.Fatalf("got %+v", got)
	}
	if got := ParseWSLInside("pids=\n"); got.PIDsUnknown || got.PIDs != nil {
		t.Fatalf("none found is known: %+v", got)
	}
}
