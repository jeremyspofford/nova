package wake

import (
	"bytes"
	"errors"
	"net"
	"net/netip"
	"strings"
	"testing"
)

// Documentation-range MAC and addresses only (the repo is public).
const testMAC = "02:00:5e:10:00:01"

func mustMAC(t *testing.T, s string) net.HardwareAddr {
	t.Helper()
	m, err := ParseMAC(s)
	if err != nil {
		t.Fatalf("ParseMAC(%q): %v", s, err)
	}
	return m
}

func TestPacketIsSixFFThenTheMacSixteenTimes(t *testing.T) {
	mac := mustMAC(t, testMAC)
	p := Packet(mac)
	if len(p) != PacketLen || PacketLen != 102 {
		t.Fatalf("len = %d, want 102", len(p))
	}
	if !bytes.Equal(p[:6], bytes.Repeat([]byte{0xFF}, 6)) {
		t.Fatalf("header = % x", p[:6])
	}
	for i := 0; i < 16; i++ {
		if got := p[6+6*i : 12+6*i]; !bytes.Equal(got, mac) {
			t.Fatalf("repeat %d = % x, want % x", i, got, mac)
		}
	}
}

func TestParseMACTakesEveryCommonSpelling(t *testing.T) {
	want := net.HardwareAddr{0x02, 0x00, 0x5e, 0x10, 0x00, 0x01}
	for _, s := range []string{
		"02:00:5e:10:00:01", "02:00:5E:10:00:01", "02-00-5E-10-00-01",
		"0200.5e10.0001", "02005e100001", "02005E100001", " 02:00:5e:10:00:01 ",
	} {
		got, err := ParseMAC(s)
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("ParseMAC(%q) = % x, %v", s, got, err)
		}
	}
}

func TestParseMACRefusesWhatNoCardHas(t *testing.T) {
	cases := map[string]string{
		"":                        "no MAC",
		"02:00:5e:10:00":          "not a MAC",
		"02:00:5e:10:00:01:02:03": "6 bytes",
		"zz:00:5e:10:00:01":       "not a MAC",
		"02005e10000":             "not a MAC",
		"ff:ff:ff:ff:ff:ff":       "broadcast",
		"FF-FF-FF-FF-FF-FF":       "broadcast",
		"00:00:00:00:00:00":       "zero",
		"000000000000":            "zero",
	}
	for in, words := range cases {
		m, err := ParseMAC(in)
		if err == nil || !strings.Contains(err.Error(), words) {
			t.Errorf("ParseMAC(%q) = % x, %v; want an error saying %q", in, m, err, words)
		}
	}
}

func ifaces() []Iface {
	return []Iface{
		{Name: "lo", Prefixes: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/8")}},
		{Name: "tun0", Prefixes: []netip.Prefix{netip.MustParsePrefix("100.64.0.1/32")}},
		{Name: "eth0", Prefixes: []netip.Prefix{
			netip.MustParsePrefix("fe80::1/64"),
			netip.MustParsePrefix("198.51.100.7/24"),
		}},
		{Name: "wlan0", Prefixes: []netip.Prefix{netip.MustParsePrefix("192.0.2.10/24")}},
		{Name: "p2p", Prefixes: []netip.Prefix{netip.MustParsePrefix("203.0.113.0/31")}},
	}
}

func TestRouteFindsTheIfaceOwningTheBroadcast(t *testing.T) {
	got, err := Route("192.0.2.255", ifaces())
	if err != nil {
		t.Fatal(err)
	}
	want := Target{Iface: "wlan0", Local: netip.MustParseAddr("192.0.2.10"), Broadcast: netip.MustParseAddr("192.0.2.255")}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	got, err = Route("198.51.100.255", ifaces())
	if err != nil || got.Iface != "eth0" || got.Local != netip.MustParseAddr("198.51.100.7") {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestRouteRefusesABroadcastNoIfaceOwns(t *testing.T) {
	for _, b := range []string{
		"10.0.0.255",      // no such subnet here
		"192.0.2.10",      // the host address, not the subnet's broadcast
		"192.0.2.127",     // a broadcast of a /25 we are not on
		"255.255.255.255", // the limited one is always sent; it names no iface
		"100.64.0.1",      // a /32 has no broadcast
		"203.0.113.1",     // nor does a /31
		"127.255.255.255", // loopback never carries a wake
		"fe80::ffff",      // IPv6 has no broadcast
		"not-an-address",
		"",
	} {
		got, err := Route(b, ifaces())
		if err == nil || !strings.Contains(err.Error(), "broadcast") {
			t.Errorf("Route(%q) = %+v, %v; want an error naming the broadcast", b, got, err)
		}
	}
}

type sent struct {
	local   netip.Addr
	dst     netip.AddrPort
	payload []byte
}

type fakeSender struct {
	got    []sent
	failAt int // 1-based write that fails; 0 = never
	err    error
}

func (f *fakeSender) Send(local netip.Addr, dst netip.AddrPort, payload []byte) error {
	if f.failAt > 0 && len(f.got)+1 == f.failAt {
		return f.err
	}
	f.got = append(f.got, sent{local, dst, append([]byte(nil), payload...)})
	return nil
}

func TestSendWritesThreeDirectedThenThreeLimitedOnPortNine(t *testing.T) {
	mac := mustMAC(t, testMAC)
	tg, err := Route("192.0.2.255", ifaces())
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeSender{}
	res, err := Send(f, mac, tg)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.got) != 6 {
		t.Fatalf("wrote %d packets, want 6", len(f.got))
	}
	for i, s := range f.got {
		want := netip.AddrPortFrom(netip.MustParseAddr("192.0.2.255"), 9)
		if i >= 3 {
			want = netip.AddrPortFrom(Limited, 9)
		}
		if s.dst != want || s.local != netip.MustParseAddr("192.0.2.10") || !bytes.Equal(s.payload, Packet(mac)) {
			t.Fatalf("packet %d: %+v, want to %v from 192.0.2.10", i, s, want)
		}
	}
	if res.Sent != 6 || res.Iface != "wlan0" || strings.Join(res.To, ",") != "192.0.2.255:9,255.255.255.255:9" {
		t.Fatalf("result %+v", res)
	}
}

func TestSendStopsOnAWriteErrorAndSaysNothingSent(t *testing.T) {
	mac := mustMAC(t, testMAC)
	tg, _ := Route("192.0.2.255", ifaces())
	f := &fakeSender{failAt: 4, err: errors.New("sendto: network is unreachable")}
	res, err := Send(f, mac, tg)
	if err == nil || !strings.Contains(err.Error(), "network is unreachable") || !strings.Contains(err.Error(), "255.255.255.255:9") {
		t.Fatalf("err = %v", err)
	}
	if res.Sent != 0 || len(f.got) != 3 {
		t.Fatalf("a failed send reported %+v after %d writes; want nothing reported, writing stopped at the failure", res, len(f.got))
	}
}
