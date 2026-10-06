package facts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode"

	"novad/internal/platform"
	"novad/internal/state"
)

// The auth facts are exactly the five keys r2-integration fixes, ≤4 KiB,
// with wsl present (null) off WSL, and every text clipped to core's cap.
func TestAuthFactsDescribeThisAgentInFiveKeysUnderTheCap(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{
		"/usr/sbin/ioreg": `"IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"`,
	}}
	a, _ := GatherAuth(context.Background(), r, strings.Repeat("v", 1000), nil)
	if a.V != 2 || a.OS.GOOS != runtime.GOOS || a.OS.Arch != runtime.GOARCH {
		t.Fatalf("%+v", a)
	}
	if len(a.Agent.Version) != 255 {
		t.Fatalf("version must be clipped to 255, got %d", len(a.Agent.Version))
	}
	data, err := json.Marshal(a)
	if err != nil || len(data) > MaxAuthBytes {
		t.Fatalf("%d bytes, %v", len(data), err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if len(m) != 5 {
		t.Fatalf("the auth facts are exactly five keys, got %v", m)
	}
	for _, k := range []string{"v", "agent", "os", "hostname", "machine_uid"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing %q", k)
		}
	}
	if _, present := m["os"].(map[string]any)["wsl"]; !present {
		t.Error("os.wsl must be present — null when not inside WSL")
	}
	switch mode := a.Agent.Mode; mode {
	case "systemd-user", "launch-agent", "run-key", "foreground":
	default:
		t.Errorf("mode %q is not one core accepts", mode)
	}
}

func withIfaces(t *testing.T, ifs []ifaceInfo, err error) {
	t.Helper()
	old := readIfaces
	readIfaces = func() ([]ifaceInfo, error) { return ifs, err }
	t.Cleanup(func() { readIfaces = old })
}

func TestAFrameListsInterfacesSkipsLoopbackAndSaysWhatItCouldNotRead(t *testing.T) {
	withIfaces(t, []ifaceInfo{
		{Name: "lo", Loopback: true, Up: true, CIDRs: []string{"127.0.0.1/8"}},
		{Name: "wlp2s0", MAC: "aa:bb:cc:dd:ee:ff", Up: true, CIDRs: []string{"192.0.2.10/24"}},
		{Name: "tailscale0", Up: true, CIDRs: []string{"100.64.0.1/32"}},
		{Name: "docker0", MAC: "02:42:ac:11:00:01", AddrErr: errors.New("addrs unreadable")},
	}, nil)
	f := GatherFrame([]Unreadable{{Item: "machine_uid", Reason: "no id"}})
	if f.Type != "facts" || len(f.Net.Ifaces) != 3 {
		t.Fatalf("%+v", f)
	}
	if f.Net.Ifaces[0].Name != "wlp2s0" || f.Net.Ifaces[0].IPv4CIDR[0] != "192.0.2.10/24" || !f.Net.Ifaces[0].Up {
		t.Fatalf("%+v", f.Net.Ifaces[0])
	}
	if f.Net.Ifaces[1].MAC != "" {
		t.Fatal("a tunnel with no hardware address says so with an empty mac")
	}
	items := map[string]bool{}
	for _, u := range f.Unreadable {
		items[u.Item] = true
	}
	if !items["machine_uid"] || !items["net.ifaces.docker0"] {
		t.Fatalf("unreadable = %+v", f.Unreadable)
	}
}

func TestAFrameWithTooManyInterfacesIsCappedAndSaysSo(t *testing.T) {
	var many []ifaceInfo
	for i := 0; i < 40; i++ {
		many = append(many, ifaceInfo{Name: fmt.Sprintf("veth%02d", i), MAC: "02:42:ac:11:00:01", Up: true,
			CIDRs: []string{"10.0.0.1/24", "10.0.1.1/24", "10.0.2.1/24", "10.0.3.1/24", "10.0.4.1/24",
				"10.0.5.1/24", "10.0.6.1/24", "10.0.7.1/24", "10.0.8.1/24"}})
	}
	withIfaces(t, many, nil)
	f := GatherFrame(nil)
	if len(f.Net.Ifaces) != 32 || len(f.Net.Ifaces[0].IPv4CIDR) != 8 {
		t.Fatalf("ifaces=%d addrs=%d", len(f.Net.Ifaces), len(f.Net.Ifaces[0].IPv4CIDR))
	}
	said := false
	for _, u := range f.Unreadable {
		said = said || (u.Item == "net.ifaces" && strings.Contains(u.Reason, "more than 32"))
	}
	data, _ := json.Marshal(f)
	if !said || len(data) > MaxFrameBytes {
		t.Fatalf("said=%v bytes=%d", said, len(data))
	}
}

func TestAnInterfaceListThatCannotBeReadIsSaidNeverEmpty(t *testing.T) {
	withIfaces(t, nil, errors.New("netlink refused"))
	f := GatherFrame(nil)
	data, _ := json.Marshal(f)
	if !strings.Contains(string(data), `"ifaces":[]`) {
		t.Fatalf("ifaces must marshal as [], got %s", data)
	}
	if len(f.Unreadable) != 1 || f.Unreadable[0].Item != "net.ifaces" {
		t.Fatalf("%+v", f.Unreadable)
	}
}

func TestTheFactsFrameCarriesTheFoldersAndSaysWhichCouldNotBeRead(t *testing.T) {
	oldIf, oldF := readIfaces, readFolder
	t.Cleanup(func() { readIfaces, readFolder = oldIf, oldF })
	readIfaces = func() ([]ifaceInfo, error) { return nil, nil }
	readFolder = func(name string) (string, error) {
		if name == "desktop" {
			return "", errors.New("this machine names no desktop folder")
		}
		return "/home/sam/" + name, nil
	}
	f := GatherFrame(nil)
	if f.Folders["home"] != "/home/sam/home" || f.Folders["documents"] != "/home/sam/documents" {
		t.Fatalf("folders = %v", f.Folders)
	}
	if _, present := f.Folders["desktop"]; present {
		t.Fatal("an unnamed folder must be absent, never a guess")
	}
	found := false
	for _, u := range f.Unreadable {
		if u.Item == "folders.desktop" && strings.Contains(u.Reason, "no desktop folder") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the missing folder must be named in unreadable: %v", f.Unreadable)
	}
}

// Controller ruling (S42b Task 7 preflight): clipping a too-long folder path
// would silently truncate it into a WRONG path that she would then act on.
// It must be omitted — reported unreadable — never clipped into a lie.
func TestATooLongFolderPathIsOmittedNeverClippedIntoAWrongPath(t *testing.T) {
	oldIf, oldF := readIfaces, readFolder
	t.Cleanup(func() { readIfaces, readFolder = oldIf, oldF })
	readIfaces = func() ([]ifaceInfo, error) { return nil, nil }
	long := "/home/sam/" + strings.Repeat("x", 300)
	readFolder = func(name string) (string, error) {
		if name == "desktop" {
			return long, nil
		}
		return "", errors.New("this machine names no " + name + " folder")
	}
	f := GatherFrame(nil)
	if _, present := f.Folders["desktop"]; present {
		t.Fatalf("a too-long path must be omitted, never clipped into a wrong path: %v", f.Folders["desktop"])
	}
	found := false
	for _, u := range f.Unreadable {
		if u.Item == "folders.desktop" {
			found = true
			if strings.Contains(u.Reason, long) || strings.Contains(u.Reason, strings.Repeat("x", 300)) {
				t.Fatalf("the reason must say the path was too long, never repeat the clipped path: %q", u.Reason)
			}
		}
	}
	if !found {
		t.Fatalf("a too-long folder path must be reported unreadable: %v", f.Unreadable)
	}
	data, err := json.Marshal(f)
	if err != nil || len(data) > MaxFrameBytes {
		t.Fatalf("%d bytes, %v", len(data), err)
	}
}

func TestAuthFactsCarryTheLastUpdateOutcomeButNeverAStagedOne(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{
		"/usr/sbin/ioreg": `"IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"`,
	}}
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	a, _ := GatherAuth(context.Background(), r, "0123456789ab", &state.Update{
		Version: "aaaaaaaaaaaa", Outcome: state.UpdateRolledBack, Reason: "the new build did not connect within 2m0s", At: at})
	want := &UpdateFact{Version: "aaaaaaaaaaaa", Outcome: "rolled_back", Reason: "the new build did not connect within 2m0s", At: "2026-09-28T12:00:00Z"}
	if !reflect.DeepEqual(a.Agent.Update, want) {
		t.Fatalf("got %+v", a.Agent.Update)
	}
	b, _ := GatherAuth(context.Background(), r, "0123456789ab", &state.Update{Version: "aaaaaaaaaaaa", Outcome: state.UpdateStaged})
	if b.Agent.Update != nil {
		t.Fatal("a staged update is transient and never reported")
	}
}

// Minor 4 (fix round 1): the applied branch is exercised too, not just
// rolled_back — a confirmed update is reported exactly like a reverted one.
func TestAuthFactsCarryAnAppliedUpdateToo(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{
		"/usr/sbin/ioreg": `"IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"`,
	}}
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	a, _ := GatherAuth(context.Background(), r, "0123456789ab", &state.Update{
		Version: "bbbbbbbbbbbb", Outcome: state.UpdateApplied, At: at})
	want := &UpdateFact{Version: "bbbbbbbbbbbb", Outcome: "applied", Reason: "", At: "2026-09-28T12:00:00Z"}
	if !reflect.DeepEqual(a.Agent.Update, want) {
		t.Fatalf("got %+v", a.Agent.Update)
	}
}

// Cross-task item (fix round 1): core's Task 16 refuses a control character
// in a P29-style reported field outright, and the supervisor's own reasons
// can carry an agent's last error (supervise's lastError appends "; its
// last error: " + a status string an arbitrary program produced) — so a
// newline or tab must never survive into UpdateFact.Reason.
func TestAuthFactsCollapseControlCharactersInTheUpdateReason(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{
		"/usr/sbin/ioreg": `"IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"`,
	}}
	a, _ := GatherAuth(context.Background(), r, "0123456789ab", &state.Update{
		Version: "aaaaaaaaaaaa", Outcome: state.UpdateRolledBack,
		Reason: "the new build did not connect within 2m0s; its last error: panic: boom\n\ngoroutine 1 [running]:\nmain.main()\n\t/tmp/x.go:1",
		At:     time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC),
	})
	got := a.Agent.Update.Reason
	for _, r := range got {
		if isControl(r) {
			t.Fatalf("a control character (%q) survived into the reported reason: %q", r, got)
		}
	}
	if strings.Contains(got, "\n") || strings.Contains(got, "\t") {
		t.Fatalf("the reason must read as one line, got %q", got)
	}
	if !strings.Contains(got, "boom") || !strings.Contains(got, "main.main()") {
		t.Fatalf("collapsing must not delete the content, only the control characters, got %q", got)
	}
}

// Task 32, MF2: the class the agent keeps out of a line is core's
// LINE_BREAKS, class by class — C0, DEL, C1, U+2028 and U+2029. One that core
// refuses and this let through dropped the WHOLE facts frame there. Each
// class is caught three ways the agent uses it: isControl says so, line()
// (every P29 field) collapses it to a space, and unfit() leaves a path that
// holds it out. The characters just outside each class are kept as they are.
func TestEveryCharacterCoreRefusesInALineIsCaughtClassByClass(t *testing.T) {
	classes := []struct {
		name    string
		members []rune
		outside []rune
	}{
		{"C0", []rune{0x00, '\t', '\n', '\r', 0x0b, 0x1b, 0x1f}, []rune{0x20, 'A'}},
		{"DEL", []rune{0x7f}, []rune{0x7e}},
		{"C1", []rune{0x80, 0x85, 0x9b, 0x9f}, []rune{0xa0, 0xe9}},
		{"U+2028", []rune{0x2028}, []rune{0x2027}},
		{"U+2029", []rune{0x2029}, []rune{0x202a, 0x2014}},
	}
	for _, c := range classes {
		t.Run(c.name, func(t *testing.T) {
			for _, r := range c.members {
				s := "before" + string(r) + "after"
				if !isControl(r) {
					t.Fatalf("isControl(%U) = false, and core refuses it in a line", r)
				}
				if got := line(s); got != "before after" {
					t.Fatalf("line(%q) = %q, want %q", s, got, "before after")
				}
				if got := said(s); strings.ContainsFunc(got, isControl) || !strings.HasPrefix(got, "before") {
					t.Fatalf("said(%q) = %q, not one clean line", s, got)
				}
				if why := unfit("/home/sam/" + s); why != "path contains a control character or a line separator" {
					t.Fatalf("unfit(%q) = %q", s, why)
				}
			}
			for _, r := range c.outside {
				s := "before" + string(r) + "after"
				if isControl(r) {
					t.Fatalf("isControl(%U) = true, and core keeps it in a line", r)
				}
				if got := line(s); got != s {
					t.Fatalf("line(%q) = %q, want it unchanged", s, got)
				}
				if why := unfit("/home/sam/" + s); why != "" {
					t.Fatalf("unfit(%q) = %q, want it to fit", s, why)
				}
			}
		})
	}
}

// isControl IS the lineBreaks table, at every code point: the Python side
// (services/core/tests/test_device_facts.py) reads that table out of this
// file and holds it to core's LINE_BREAKS, so a predicate that answered
// anything but the table would drift from core again unseen.
func TestIsControlIsTheLineBreaksTable(t *testing.T) {
	inTable := func(r rune) bool {
		for _, span := range lineBreaks {
			if span[0] <= r && r <= span[1] {
				return true
			}
		}
		return false
	}
	for r := rune(0); r <= unicode.MaxRune; r++ {
		if isControl(r) != inTable(r) {
			t.Fatalf("isControl(%U) = %v, and the lineBreaks table says %v", r, isControl(r), inTable(r))
		}
	}
}

// The auth frame's agent.update.reason is where one refused character costs
// the most — core then records NONE of the auth-frame facts — so the C1 and
// separator classes are pinned there too, on supervise's own words.
func TestAuthFactsCollapseC1AndLineSeparatorsInTheUpdateReason(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{
		"/usr/sbin/ioreg": `"IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"`,
	}}
	a, _ := GatherAuth(context.Background(), r, "0123456789ab", &state.Update{
		Version: "aaaaaaaaaaaa", Outcome: state.UpdateRolledBack,
		Reason: "the new build did not connect\u0085its last error: panic: boom \u009b[0m",
		At:     time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC),
	})
	want := "the new build did not connect its last error: panic: boom [0m"
	if got := a.Agent.Update.Reason; got != want {
		t.Fatalf("reason = %q, want %q", got, want)
	}
}
