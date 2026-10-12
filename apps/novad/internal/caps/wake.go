package caps

import (
	"context"
	"fmt"
	"strings"
	"time"

	"novad/internal/wake"
)

// WakeDeps are net.wake's seams. Nil Deps.Wake (or an empty field) is the
// real machine; tests fake every one, so no test sends a real packet.
type WakeDeps struct {
	Sender     wake.Sender
	Interfaces func() ([]wake.Iface, error)
	Now        func() time.Time
}

func (d *WakeDeps) parts() (wake.Sender, func() ([]wake.Iface, error), func() time.Time) {
	var s wake.Sender = wake.UDPSender{}
	ifs, now := wake.Interfaces, time.Now
	if d != nil {
		if d.Sender != nil {
			s = d.Sender
		}
		if d.Interfaces != nil {
			ifs = d.Interfaces
		}
		if d.Now != nil {
			now = d.Now
		}
	}
	return s, ifs, now
}

// netWake sends a Wake-on-LAN magic packet {mac, broadcast} (S46a T3): 3 to
// the subnet-directed broadcast core names and 3 to 255.255.255.255, UDP 9,
// from the interface of THIS machine that owns that broadcast. It reports
// what was written where and when — never that the target woke (core
// measures that). The MAC is never in the output or the meta.
func netWake(_ context.Context, r Request) Outcome {
	macArg, ok := strArg(r.Args, "mac")
	if !ok {
		return fail("net.wake needs mac: the target card's MAC address, as a string")
	}
	bcArg, ok := strArg(r.Args, "broadcast")
	if !ok {
		return fail("net.wake needs broadcast: the subnet-directed broadcast address, as a string")
	}
	mac, err := wake.ParseMAC(macArg)
	if err != nil {
		return fail("cannot wake: %v", err)
	}
	sender, interfaces, now := r.Deps.Wake.parts()
	ifs, err := interfaces()
	if err != nil {
		return fail("cannot read this machine's interfaces: %v", err)
	}
	target, err := wake.Route(bcArg, ifs)
	if err != nil {
		return fail("cannot wake: %v", err)
	}
	res, err := wake.Send(sender, mac, target)
	if err != nil {
		return fail("%v; the wake was not sent in full", err)
	}
	at := now().UTC().Format(time.RFC3339)
	parts := make([]string, len(res.To))
	for i, to := range res.To {
		parts[i] = fmt.Sprintf("%d to %s", wake.Repeats, to)
	}
	out := ok0(fmt.Sprintf("sent %d magic packets (%d bytes each) from %s (%s) at %s: %s — sending is not waking: this says nothing about whether the target woke",
		res.Sent, wake.PacketLen, res.Iface, target.Local, at, strings.Join(parts, ", ")))
	out.Meta = map[string]any{"sent": res.Sent, "iface": res.Iface, "at": at, "to": res.To}
	return out
}
