package caps

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"testing"
	"time"

	"novad/internal/wake"
)

// Documentation-range MAC and addresses only (the repo is public).
const wakeTestMAC = "02:00:5e:10:00:01"

type wakeWrite struct {
	local netip.Addr
	dst   netip.AddrPort
	n     int
}

type fakeWakeSender struct {
	got []wakeWrite
	err error
}

func (f *fakeWakeSender) Send(local netip.Addr, dst netip.AddrPort, payload []byte) error {
	if f.err != nil {
		return f.err
	}
	f.got = append(f.got, wakeWrite{local, dst, len(payload)})
	return nil
}

var wakeAt = time.Date(2026, 10, 11, 9, 30, 0, 0, time.UTC)

func wakeDeps(t *testing.T, s *fakeWakeSender, ifErr error) Deps {
	d := testDeps(t)
	d.Wake = &WakeDeps{
		Sender: s,
		Interfaces: func() ([]wake.Iface, error) {
			return []wake.Iface{
				{Name: "lo", Prefixes: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/8")}},
				{Name: "wlan0", Prefixes: []netip.Prefix{netip.MustParsePrefix("192.0.2.10/24")}},
			}, ifErr
		},
		Now: func() time.Time { return wakeAt },
	}
	return d
}

func TestNetWakeSaysExactlyWhatWasSentWhere(t *testing.T) {
	s := &fakeWakeSender{}
	out := Dispatch(context.Background(), "net.wake",
		wireArgs(t, `{"mac": "`+wakeTestMAC+`", "broadcast": "192.0.2.255"}`), wakeDeps(t, s, nil))
	if !out.OK {
		t.Fatalf("refused: %s", out.Error)
	}
	if len(s.got) != 6 {
		t.Fatalf("wrote %d packets, want 6", len(s.got))
	}
	for _, w := range s.got {
		if w.n != 102 || w.local != netip.MustParseAddr("192.0.2.10") || w.dst.Port() != 9 {
			t.Fatalf("write %+v", w)
		}
	}
	for _, want := range []string{
		"6 magic packets", "from wlan0", "192.0.2.10", "3 to 192.0.2.255:9", "3 to 255.255.255.255:9",
		"2026-10-11T09:30:00Z", "sending is not waking",
	} {
		if !strings.Contains(out.Output, want) {
			t.Errorf("output missing %q: %s", want, out.Output)
		}
	}
	for _, mac := range []string{"02:00:5e", "02-00-5e", "02005e"} {
		if strings.Contains(strings.ToLower(out.Output), mac) {
			t.Fatalf("the MAC is in the output: %s", out.Output)
		}
	}
	if out.Meta["sent"] != 6 || out.Meta["iface"] != "wlan0" || out.Meta["at"] != "2026-10-11T09:30:00Z" {
		t.Fatalf("meta %v", out.Meta)
	}
	to, _ := out.Meta["to"].([]string)
	if strings.Join(to, ",") != "192.0.2.255:9,255.255.255.255:9" {
		t.Fatalf("meta to %v", out.Meta["to"])
	}
	if _, has := out.Meta["mac"]; has {
		t.Fatalf("the MAC is in the meta: %v", out.Meta)
	}
}

func TestNetWakeRefusesWithTheWordsAndSendsNothing(t *testing.T) {
	cases := map[string]string{
		`{"broadcast": "192.0.2.255"}`:                                   "mac",
		`{"mac": 2, "broadcast": "192.0.2.255"}`:                         "mac",
		`{"mac": "ff:ff:ff:ff:ff:ff", "broadcast": "192.0.2.255"}`:       "broadcast MAC",
		`{"mac": "00:00:00:00:00:00", "broadcast": "192.0.2.255"}`:       "zero",
		`{"mac": "02:00:5e:10:00", "broadcast": "192.0.2.255"}`:          "not a MAC",
		`{"mac": "` + wakeTestMAC + `"}`:                                 "broadcast",
		`{"mac": "` + wakeTestMAC + `", "broadcast": 7}`:                 "broadcast",
		`{"mac": "` + wakeTestMAC + `", "broadcast": "10.0.0.255"}`:      "no interface",
		`{"mac": "` + wakeTestMAC + `", "broadcast": "255.255.255.255"}`: "no interface",
	}
	for raw, words := range cases {
		s := &fakeWakeSender{}
		out := Dispatch(context.Background(), "net.wake", wireArgs(t, raw), wakeDeps(t, s, nil))
		if out.OK || !strings.Contains(out.Error, words) || len(s.got) != 0 || out.Meta != nil {
			t.Errorf("%s: ok=%v err=%q writes=%d meta=%v; want a refusal saying %q and nothing sent",
				raw, out.OK, out.Error, len(s.got), out.Meta, words)
		}
	}
}

func TestNetWakeWriteErrorReportsNothingSent(t *testing.T) {
	s := &fakeWakeSender{err: errors.New("sendto: network is unreachable")}
	out := Dispatch(context.Background(), "net.wake",
		wireArgs(t, `{"mac": "`+wakeTestMAC+`", "broadcast": "192.0.2.255"}`), wakeDeps(t, s, nil))
	if out.OK || !strings.Contains(out.Error, "network is unreachable") || out.Meta != nil ||
		strings.Contains(out.Error, "6 magic packets") {
		t.Fatalf("ok=%v err=%q meta=%v", out.OK, out.Error, out.Meta)
	}
}

func TestNetWakeCannotReadInterfacesSaysSo(t *testing.T) {
	s := &fakeWakeSender{}
	out := Dispatch(context.Background(), "net.wake",
		wireArgs(t, `{"mac": "`+wakeTestMAC+`", "broadcast": "192.0.2.255"}`), wakeDeps(t, s, errors.New("route ip+net: netlinkrib: permission denied")))
	if out.OK || !strings.Contains(out.Error, "permission denied") || len(s.got) != 0 {
		t.Fatalf("ok=%v err=%q writes=%d", out.OK, out.Error, len(s.got))
	}
}
