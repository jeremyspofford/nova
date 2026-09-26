package facts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"testing"

	"novad/internal/platform"
)

// The auth facts are exactly the five keys r2-integration fixes, ≤4 KiB,
// with wsl present (null) off WSL, and every text clipped to core's cap.
func TestAuthFactsDescribeThisAgentInFiveKeysUnderTheCap(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{
		"/usr/sbin/ioreg": `"IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"`,
	}}
	a, _ := GatherAuth(context.Background(), r, strings.Repeat("v", 1000))
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
