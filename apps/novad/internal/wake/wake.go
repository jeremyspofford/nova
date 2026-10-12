// Package wake builds and sends a Wake-on-LAN magic packet (S46a T3). It
// SENDS; it never claims the target woke — only the target's agent
// reconnecting says that (core measures it, S46a T5).
package wake

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
)

const (
	Port      = 9   // UDP discard: the port every WoL variant P0-1 measured used
	Repeats   = 3   // packets per destination
	PacketLen = 102 // 6 x 0xFF + 16 x the 6-byte MAC
)

// Limited is the limited broadcast, sent alongside the subnet-directed one.
var Limited = netip.AddrFrom4([4]byte{255, 255, 255, 255})

// Iface is one of this machine's interfaces as Route needs it.
type Iface struct {
	Name     string
	Prefixes []netip.Prefix
}

// Sender writes one UDP datagram from local to dst. It is the seam the tests
// fake: no test ever sends a real packet.
type Sender interface {
	Send(local netip.Addr, dst netip.AddrPort, payload []byte) error
}

// Target is where a wake goes out: the iface owning the broadcast's subnet,
// its address (the socket is bound to it) and the directed broadcast.
type Target struct {
	Iface     string
	Local     netip.Addr
	Broadcast netip.Addr
}

// Result is what was written, only after every write returned.
type Result struct {
	Sent  int
	Iface string
	To    []string
}

// ParseMAC reads a card's MAC in any common spelling (aa:bb:cc:dd:ee:ff,
// aa-bb-cc-dd-ee-ff, aabb.ccdd.eeff, aabbccddeeff; any case) and refuses what
// no card has: anything but 6 bytes, the broadcast MAC and the zero MAC. The
// input is never quoted back — a near-real MAC must not reach a span.
func ParseMAC(s string) (net.HardwareAddr, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, errors.New("no MAC given")
	}
	if len(s) == 12 && !strings.ContainsAny(s, ":-.") {
		parts := make([]string, 0, 6)
		for i := 0; i < 12; i += 2 {
			parts = append(parts, s[i:i+2])
		}
		s = strings.Join(parts, ":")
	}
	mac, err := net.ParseMAC(s)
	if err != nil {
		return nil, errors.New("not a MAC address (want 6 hex bytes, as aa:bb:cc:dd:ee:ff)")
	}
	if len(mac) != 6 {
		return nil, fmt.Errorf("a wake MAC is 6 bytes; this one is %d", len(mac))
	}
	if bytes.Equal(mac, net.HardwareAddr{0xff, 0xff, 0xff, 0xff, 0xff, 0xff}) {
		return nil, errors.New("the broadcast MAC ff:ff:ff:ff:ff:ff is no card's address")
	}
	if bytes.Equal(mac, make(net.HardwareAddr, 6)) {
		return nil, errors.New("the zero MAC 00:00:00:00:00:00 is no card's address")
	}
	return mac, nil
}

// Packet is the magic packet: 6 x 0xFF, then the MAC 16 times (102 bytes).
func Packet(mac net.HardwareAddr) []byte {
	p := make([]byte, 0, PacketLen)
	p = append(p, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)
	for i := 0; i < 16; i++ {
		p = append(p, mac...)
	}
	return p
}

// Route finds the interface of THIS machine whose IPv4 subnet's directed
// broadcast is the one asked for. It never guesses: a broadcast no interface
// owns is refused, as are the limited broadcast (always sent anyway; it
// names no interface), loopback and /31-/32 (no broadcast).
func Route(broadcast string, ifaces []Iface) (Target, error) {
	b, err := netip.ParseAddr(strings.TrimSpace(broadcast))
	if err != nil || !b.Unmap().Is4() {
		return Target{}, fmt.Errorf("%q is not an IPv4 broadcast address", broadcast)
	}
	b = b.Unmap()
	for _, ifc := range ifaces {
		for _, p := range ifc.Prefixes {
			a := p.Addr().Unmap()
			if !a.Is4() || a.IsLoopback() || p.Bits() < 0 || p.Bits() > 30 {
				continue
			}
			if directed(a, p.Bits()) == b {
				return Target{Iface: ifc.Name, Local: a, Broadcast: b}, nil
			}
		}
	}
	return Target{}, fmt.Errorf("no interface on this machine has the broadcast %s", b)
}

func directed(a netip.Addr, bits int) netip.Addr {
	v := a.As4()
	for i := range v {
		hostBits := 8 - (bits - 8*i)
		if hostBits <= 0 {
			continue
		}
		if hostBits > 8 {
			hostBits = 8
		}
		v[i] |= byte(1<<hostBits - 1)
	}
	return netip.AddrFrom4(v)
}

// Send writes Repeats packets to the directed broadcast, then Repeats to the
// limited one, all on Port from the target's address. The first write error
// stops it and is returned in the OS's words with an empty Result: nothing
// is reported sent unless every write returned.
func Send(s Sender, mac net.HardwareAddr, t Target) (Result, error) {
	payload := Packet(mac)
	dsts := []netip.AddrPort{netip.AddrPortFrom(t.Broadcast, Port), netip.AddrPortFrom(Limited, Port)}
	for _, dst := range dsts {
		for i := 0; i < Repeats; i++ {
			if err := s.Send(t.Local, dst, payload); err != nil {
				return Result{}, fmt.Errorf("could not send to %s from %s (%s): %w", dst, t.Iface, t.Local, err)
			}
		}
	}
	return Result{Sent: Repeats * len(dsts), Iface: t.Iface, To: []string{dsts[0].String(), dsts[1].String()}}, nil
}
