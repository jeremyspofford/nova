package wake

import (
	"fmt"
	"net"
	"net/netip"
)

// Interfaces reads this machine's up interfaces and their addresses.
func Interfaces() ([]Iface, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	out := make([]Iface, 0, len(ifs))
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			return nil, err
		}
		it := Iface{Name: ifc.Name}
		for _, a := range addrs {
			n, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip, ok := netip.AddrFromSlice(n.IP)
			if !ok {
				continue
			}
			ones, _ := n.Mask.Size()
			it.Prefixes = append(it.Prefixes, netip.PrefixFrom(ip.Unmap(), ones))
		}
		out = append(out, it)
	}
	return out, nil
}

// UDPSender is the real Sender: a UDP socket bound to the local address (Go
// sets SO_BROADCAST on every UDP socket), one datagram, closed.
type UDPSender struct{}

func (UDPSender) Send(local netip.Addr, dst netip.AddrPort, payload []byte) error {
	c, err := net.ListenUDP("udp4", net.UDPAddrFromAddrPort(netip.AddrPortFrom(local, 0)))
	if err != nil {
		return err
	}
	defer c.Close()
	n, err := c.WriteToUDPAddrPort(payload, dst)
	if err != nil {
		return err
	}
	if n != len(payload) {
		return fmt.Errorf("short write: %d of %d bytes", n, len(payload))
	}
	return nil
}
