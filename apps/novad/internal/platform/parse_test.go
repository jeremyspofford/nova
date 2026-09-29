package platform

import (
	"encoding/base64"
	"reflect"
	"testing"
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
