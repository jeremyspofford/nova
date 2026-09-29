// Package facts is what novad says about the machine it runs on: raw
// observations, never conclusions. Core alone turns them into roles (hub
// decision D2, services/core/app/device_facts.py), so nothing here decides
// what the agent "can" do.
//
// Two shapes, both on the socket core authenticated (TLS or WireGuard; facts
// are not signed — r2-integration D11):
//
//	Auth  rides inside the auth frame: small (≤4 KiB), about the agent and
//	      the OS. Core records it only after the signature verifies, and it is
//	      never a reason to refuse the socket.
//	Frame is the `facts` frame: the larger, slower facts — network
//	      interfaces now; power, compute and the rest as later slices add
//	      them — sent after ready, on a change (at most once a minute), every
//	      ten minutes, and on facts.refresh.
//
// A fact that cannot be read is said so: as an `unreadable` entry in the
// frame naming the item and the reason, or — in Auth, which has no room to
// explain itself — as an empty value core reads as unknown, with its reason
// carried into every frame's unreadable list.
package facts

import (
	"context"
	"fmt"
	"net"
	"os"
	"runtime"
	"time"
	"unicode/utf8"

	"novad/internal/platform"
	"novad/internal/state"
)

const (
	// Version is the facts shape r2-integration fixes; core refuses others.
	Version = 2
	// MaxAuthBytes and MaxFrameBytes are core's caps (device_facts.py).
	MaxAuthBytes  = 4096
	MaxFrameBytes = 16 * 1024

	maxText       = 255
	maxIfaces     = 32
	maxAddrs      = 8
	maxUnreadable = 32
)

// Auth is the auth frame's facts.
type Auth struct {
	V          int       `json:"v"`
	Agent      AgentInfo `json:"agent"`
	OS         OSInfo    `json:"os"`
	Hostname   string    `json:"hostname"`
	MachineUID string    `json:"machine_uid"`
}

// AgentInfo is about the daemon itself. The build identity is doing-things
// S30's `build` field, never added here (r2-integration:699).
type AgentInfo struct {
	Version            string `json:"version"`
	Mode               string `json:"mode"`
	SessionInteractive bool   `json:"session_interactive"`
	// Update is the last update's outcome, omitted unless there is one to
	// report (a staged update is transient and never reported here).
	Update *UpdateFact `json:"update,omitempty"`
}

// UpdateFact is the last update's outcome, as the supervisor recorded it:
// core confirms or rolls back its record from this (S42b P8).
type UpdateFact struct {
	Version string `json:"version"`
	Outcome string `json:"outcome"`
	Reason  string `json:"reason"`
	At      string `json:"at"`
}

// OSInfo is the OS as Go and the OS name it. WSL is nil (null on the wire)
// unless this Linux runs inside WSL.
type OSInfo struct {
	GOOS    string `json:"goos"`
	Arch    string `json:"arch"`
	Version string `json:"version"`
	WSL     *WSL   `json:"wsl"`
}

// WSL names the distribution this agent runs inside ("" when unnamed).
type WSL struct {
	Distro string `json:"distro"`
}

// Frame is the facts frame.
type Frame struct {
	Type string `json:"type"`
	Net  Net    `json:"net"`
	// Folders are the known folders as this OS names them (S42b P16); core
	// admits an @folder path only for a folder listed here.
	Folders    map[string]string `json:"folders,omitempty"`
	Unreadable []Unreadable      `json:"unreadable"`
}

// Net is this machine's network interfaces, loopback excluded.
type Net struct {
	Ifaces []Iface `json:"ifaces"`
}

// Iface is one interface. MAC is "" for one with no hardware address (a
// tunnel); IPv4CIDR lists at most eight.
type Iface struct {
	Name     string   `json:"name"`
	MAC      string   `json:"mac"`
	IPv4CIDR []string `json:"ipv4_cidr"`
	Up       bool     `json:"up"`
}

// Unreadable names a fact that could not be read, and why.
type Unreadable struct {
	Item   string `json:"item"`
	Reason string `json:"reason"`
}

// GatherAuth reads this machine's auth facts. version is the build stamp
// (main.version). last is update.json's last outcome, or nil when there is
// none — GatherAuth reports it only when it is applied or rolled_back
// (never staged, which is transient and confirmed a different way: by the
// next connection's own reported version). What could not be read is
// returned so the caller carries it into the facts frames.
func GatherAuth(ctx context.Context, r platform.Runner, version string, last *state.Update) (Auth, []Unreadable) {
	var unread []Unreadable
	host, err := os.Hostname()
	if err != nil {
		unread = append(unread, Unreadable{Item: "hostname", Reason: clip(err.Error())})
	}
	uid, err := platform.MachineUID(ctx, r)
	if err != nil {
		unread = append(unread, Unreadable{Item: "machine_uid", Reason: clip(err.Error())})
	}
	a := Auth{
		V: Version,
		Agent: AgentInfo{
			Version:            clip(version),
			Mode:               platform.Mode(),
			SessionInteractive: platform.Interactive(),
		},
		OS: OSInfo{
			GOOS:    runtime.GOOS,
			Arch:    runtime.GOARCH,
			Version: clip(platform.OSVersion(ctx, r)),
		},
		Hostname:   clip(host),
		MachineUID: uid,
	}
	if in, distro := platform.WSL(); in {
		a.OS.WSL = &WSL{Distro: clip(distro)}
	}
	if last != nil && (last.Outcome == state.UpdateApplied || last.Outcome == state.UpdateRolledBack) {
		a.Agent.Update = &UpdateFact{Version: clip(last.Version), Outcome: last.Outcome,
			Reason: clip(last.Reason), At: last.At.UTC().Format(time.RFC3339)}
	}
	return a, unread
}

// ifaceInfo is one interface as GatherFrame reads it — a type of its own so
// a test hands in interfaces without a network stack.
type ifaceInfo struct {
	Name     string
	MAC      string
	Up       bool
	Loopback bool
	CIDRs    []string
	AddrErr  error
}

// readFolder is the real reader; a variable so a test replaces it.
var readFolder = platform.Folder

// readIfaces is the real reader; a variable so a test replaces it.
var readIfaces = func() ([]ifaceInfo, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	out := make([]ifaceInfo, 0, len(ifs))
	for _, ifc := range ifs {
		info := ifaceInfo{
			Name:     ifc.Name,
			MAC:      ifc.HardwareAddr.String(),
			Up:       ifc.Flags&net.FlagUp != 0,
			Loopback: ifc.Flags&net.FlagLoopback != 0,
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			info.AddrErr = err
		}
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok && ipnet.IP.To4() != nil {
				info.CIDRs = append(info.CIDRs, ipnet.String())
			}
		}
		out = append(out, info)
	}
	return out, nil
}

// GatherFrame reads the facts frame. carried are GatherAuth's unreadable
// entries, repeated so every frame states them.
func GatherFrame(carried []Unreadable) Frame {
	f := Frame{Type: "facts", Net: Net{Ifaces: []Iface{}}, Unreadable: append([]Unreadable{}, carried...)}
	folders := map[string]string{}
	for _, name := range platform.FolderNames {
		p, err := readFolder(name)
		if err != nil {
			f.Unreadable = append(f.Unreadable, Unreadable{Item: "folders." + name, Reason: clip(err.Error())})
			continue
		}
		// RULING (S42b Task 7 preflight, overriding the brief's clip(p)):
		// clipping a too-long folder path would silently truncate it into a
		// WRONG path she would then act on. Too long is omitted and reported
		// unreadable, never guessed-by-truncation.
		if len(p) > maxText {
			f.Unreadable = append(f.Unreadable, Unreadable{
				Item:   "folders." + name,
				Reason: fmt.Sprintf("path is %d bytes, over the %d limit", len(p), maxText),
			})
			continue
		}
		folders[name] = p
	}
	if len(folders) > 0 {
		f.Folders = folders
	}
	ifs, err := readIfaces()
	if err != nil {
		f.Unreadable = append(f.Unreadable, Unreadable{Item: "net.ifaces", Reason: clip(err.Error())})
		return capUnreadable(f)
	}
	for _, ifc := range ifs {
		if ifc.Loopback {
			continue
		}
		if len(f.Net.Ifaces) == maxIfaces {
			f.Unreadable = append(f.Unreadable, Unreadable{
				Item:   "net.ifaces",
				Reason: fmt.Sprintf("more than %d interfaces; the rest are not listed", maxIfaces),
			})
			break
		}
		entry := Iface{Name: clip(ifc.Name), MAC: ifc.MAC, IPv4CIDR: []string{}, Up: ifc.Up}
		for _, c := range ifc.CIDRs {
			if len(entry.IPv4CIDR) == maxAddrs {
				break
			}
			entry.IPv4CIDR = append(entry.IPv4CIDR, c)
		}
		if ifc.AddrErr != nil {
			f.Unreadable = append(f.Unreadable, Unreadable{
				Item: "net.ifaces." + clip(ifc.Name), Reason: clip(ifc.AddrErr.Error()),
			})
		}
		f.Net.Ifaces = append(f.Net.Ifaces, entry)
	}
	return capUnreadable(f)
}

// capUnreadable keeps the list within core's cap, saying so when it cut.
func capUnreadable(f Frame) Frame {
	if len(f.Unreadable) > maxUnreadable {
		f.Unreadable = append(f.Unreadable[:maxUnreadable-1],
			Unreadable{Item: "unreadable", Reason: "more unreadable items than can be listed"})
	}
	return f
}

// clip keeps a text within core's 255-character cap, on a rune boundary.
func clip(s string) string {
	if len(s) <= maxText {
		return s
	}
	cut := maxText
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
