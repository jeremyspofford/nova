package facts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"novad/internal/platform"
	"novad/internal/state"
)

// fix/facts-unreadable-null, and PR #110's review of it: the golden frames
// are built from fixtures, so a list a builder left nil passed every test
// while the agent sent null. Here every value the agent sends is made by
// the real builders, branch by branch — GatherAuth, GatherFrame over each
// way its readers answer, Probe through a FakeRunner on each branch it can
// drive here (sudo's answers on unix, the WSL distributions Windows lists),
// each probe applied to each frame — and json.Marshal must write it as the
// wire does (Marshal). The two differ only where a list is nil
// (TestTheWireIsJSONMarshalButForNilLists), so a builder that leaves one
// nil is red here even though the wire would carry []: an empty list says
// "none", and only its builder knows whether that is true or the list is
// unknown (PIDList).
func TestNoBuilderLeavesAListNil(t *testing.T) {
	auths, frames, probed := builderOutputs(t)
	var sent []output
	for _, a := range auths {
		sent = append(sent, output{"GatherAuth (" + a.name + ")", a.auth})
	}
	for _, g := range frames {
		sent = append(sent, output{"GatherFrame (" + g.name + ")", g.frame})
	}
	for _, p := range probed {
		for _, g := range frames {
			f := g.frame
			p.probed.ApplyTo(&f)
			sent = append(sent, output{fmt.Sprintf("Probe (%s) applied to GatherFrame (%s)", p.name, g.name), f})
		}
	}
	for _, o := range sent {
		for _, d := range wireDiffs(t, o.v) {
			if d.nullFilled() {
				t.Errorf("%s left a list nil: json.Marshal writes null at %s, the wire []", o.name, d.where())
				continue
			}
			t.Errorf("%s: json.Marshal writes %s at %s, the wire %s — the wire's encoding moved (TestTheWireIsJSONMarshalButForNilLists)",
				o.name, show(d.marshal), d.where(), show(d.wire))
		}
	}

	// And novad_pids crosses the wire as null exactly where the probe could
	// not list them — unknown — and as a list wherever it could.
	for _, p := range probed {
		if p.probed.WSL == nil {
			continue
		}
		f := frames[0].frame
		p.probed.ApplyTo(&f)
		data, err := Marshal(f)
		var back Frame
		if err == nil {
			err = json.Unmarshal(data, &back)
		}
		if err != nil {
			t.Fatalf("Probe (%s): %v", p.name, err)
		}
		for i, d := range p.probed.WSL.Distros {
			if (back.WSLDistros.Distros[i].PIDs == nil) != (d.PIDs == nil) {
				t.Errorf("Probe (%s): novad_pids is null on the wire only where it is unknown, got %#v for %#v: %s",
					p.name, back.WSLDistros.Distros[i].PIDs, d.PIDs, data)
			}
		}
	}
}

// What Marshal relies on, held to every real builder output — what
// GatherAuth, GatherFrame and Probe return, sent or not, and each probe
// applied to each frame: it writes what json.Marshal writes, but for a nil
// list, which json.Marshal writes as null and the wire as []. Never
// anywhere else, and never novad_pids, whose null means unknown (PIDList).
// json.Marshal is jsonv2.Marshal(v, DefaultOptionsV1()), and Marshal adds
// one option to that; this holds the pair to it over what the agent really
// builds, so a change to either encoder that moves anything else is red.
func TestTheWireIsJSONMarshalButForNilLists(t *testing.T) {
	auths, frames, probed := builderOutputs(t)
	var outputs []output
	for _, a := range auths {
		outputs = append(outputs, output{"GatherAuth (" + a.name + ")", a.auth},
			output{"GatherAuth's unreadable (" + a.name + ")", a.unread})
	}
	for _, g := range frames {
		outputs = append(outputs, output{"GatherFrame (" + g.name + ")", g.frame})
	}
	for _, p := range probed {
		outputs = append(outputs, output{"Probe (" + p.name + ")", p.probed})
		for _, g := range frames {
			f := g.frame
			p.probed.ApplyTo(&f)
			outputs = append(outputs, output{fmt.Sprintf("Probe (%s) applied to GatherFrame (%s)", p.name, g.name), f})
		}
	}
	filled := 0
	for _, o := range outputs {
		for _, d := range wireDiffs(t, o.v) {
			if !d.nullFilled() || strings.HasSuffix(d.at, "novad_pids") {
				t.Errorf("%s: json.Marshal writes %s at %s, and the wire %s — they may differ only where a nil list is null and [], never at novad_pids",
					o.name, show(d.marshal), d.where(), show(d.wire))
			}
			filled++
		}
	}
	t.Logf("%d real builder outputs; %d nil lists in them, written as [] on the wire", len(outputs), filled)

	// The option is on, whatever this host's builders left nil: a frame whose
	// lists are nil differs at each of them — and not at a novad_pids that is
	// unknown.
	unfilled := Frame{Type: "facts", Net: Net{Ifaces: []Iface{{Name: "eth0"}}},
		WSLDistros: &WSLDistros{Distros: []Distro{{Name: "Unknown-Fixture", Running: true}}}}
	var at []string
	for _, d := range wireDiffs(t, unfilled) {
		if d.nullFilled() {
			at = append(at, d.at)
		}
	}
	if want := []string{"net.ifaces[0].ipv4_cidr", "unreadable"}; !slices.Equal(at, want) {
		t.Fatalf("a nil list is written as [] at %q, want %q", at, want)
	}
}

// output is one value a real builder made, and which.
type output struct {
	name string
	v    any
}

type authRun struct {
	name   string
	auth   Auth
	unread []Unreadable
}

// builderOutputs runs each builder on each branch the tests drive here.
func builderOutputs(t *testing.T) ([]authRun, []gathered, []probeRun) {
	r := &platform.FakeRunner{Outputs: map[string]string{
		"/usr/sbin/ioreg": `"IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"`,
	}}
	at := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	var auths []authRun
	for _, last := range []*state.Update{nil,
		{Version: "aaaaaaaaaaaa", Outcome: state.UpdateApplied, At: at},
		{Version: "aaaaaaaaaaaa", Outcome: state.UpdateRolledBack, Reason: "fixture\nreason", At: at},
		{Version: "aaaaaaaaaaaa", Outcome: state.UpdateStaged, At: at},
	} {
		name := "no update"
		if last != nil {
			name = "last update " + last.Outcome
		}
		a, unread := GatherAuth(context.Background(), r, "0123456789ab", last)
		auths = append(auths, authRun{name, a, unread})
	}
	return auths, gatheredFrames(t), probes(t)
}

// jsonDiff is one place two encodings of a value differ: at, the keys and
// indexes that lead there, and what each wrote — nil for null, absent{} for
// a key it left out.
type jsonDiff struct {
	at            string
	marshal, wire any
}

type absent struct{}

func (d jsonDiff) where() string {
	if d.at == "" {
		return "(the value itself)"
	}
	return d.at
}

// nullFilled is whether json.Marshal wrote null there and the wire [].
func (d jsonDiff) nullFilled() bool {
	list, ok := d.wire.([]any)
	return d.marshal == nil && ok && len(list) == 0
}

// wireDiffs is every place json.Marshal and the wire (Marshal) write v
// differently, read off the two encodings themselves.
func wireDiffs(t *testing.T, v any) []jsonDiff {
	t.Helper()
	a, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out []jsonDiff
	diffJSON(decodeJSON(t, a), decodeJSON(t, b), "", &out)
	return out
}

func decodeJSON(t *testing.T, data []byte) any {
	t.Helper()
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		t.Fatalf("%v: %s", err, data)
	}
	return v
}

func diffJSON(a, b any, at string, out *[]jsonDiff) {
	switch av := a.(type) {
	case map[string]any:
		if bv, ok := b.(map[string]any); ok {
			keys := slices.Sorted(maps.Keys(av))
			for k := range bv {
				if _, both := av[k]; !both {
					keys = append(keys, k)
				}
			}
			for _, k := range keys {
				x, inA := av[k]
				y, inB := bv[k]
				if !inA {
					x = absent{}
				}
				if !inB {
					y = absent{}
				}
				next := k
				if at != "" {
					next = at + "." + k
				}
				diffJSON(x, y, next, out)
			}
			return
		}
	case []any:
		if bv, ok := b.([]any); ok && len(av) == len(bv) {
			for i := range av {
				diffJSON(av[i], bv[i], fmt.Sprintf("%s[%d]", at, i), out)
			}
			return
		}
	}
	if !reflect.DeepEqual(a, b) {
		*out = append(*out, jsonDiff{at, a, b})
	}
}

// show is a decoded JSON value as JSON again.
func show(v any) string {
	if _, ok := v.(absent); ok {
		return "nothing"
	}
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(data)
}

type gathered struct {
	name  string
	frame Frame
}

// gatheredFrames is GatherFrame's real output over each way its readers
// answer — and each kind of carried list, nil among them.
func gatheredFrames(t *testing.T) []gathered {
	var out []gathered
	gather := func(name string, carried []Unreadable, set func(t *testing.T)) {
		t.Run("GatherFrame/"+name, func(t *testing.T) {
			set(t)
			out = append(out, gathered{name, GatherFrame(carried)})
		})
	}
	addrs := func(n int) []string {
		var cidrs []string
		for i := range n {
			cidrs = append(cidrs, fmt.Sprintf("10.0.%d.1/24", i))
		}
		return cidrs
	}
	gather("every folder; interfaces with addresses and without", nil, func(t *testing.T) {
		withFolders(t, everyFolder())
		withIfaces(t, []ifaceInfo{
			{Name: "lo", Loopback: true, Up: true, CIDRs: []string{"127.0.0.1/8"}},
			{Name: "eth0", MAC: "02:00:00:00:00:01", Up: true, CIDRs: []string{"192.0.2.10/24"}},
			{Name: "tailscale0", Up: true, CIDRs: []string{"100.64.0.1/32"}},
			{Name: "wlan0", MAC: "02:00:00:00:00:02"},
			{Name: "docker0", MAC: "02:00:00:00:00:03", AddrErr: errors.New("addrs unreadable")},
		}, nil)
	})
	gather("no folder named, no interface", []Unreadable{}, func(t *testing.T) {
		withFolders(t, map[string]string{})
		withIfaces(t, nil, nil)
	})
	gather("an empty folder path and one too long", []Unreadable{{Item: "machine_uid", Reason: "fixture"}}, func(t *testing.T) {
		folders := everyFolder()
		folders["downloads"] = ""
		folders["desktop"] = "/home/sam/" + strings.Repeat("x", 300)
		withFolders(t, folders)
		withIfaces(t, []ifaceInfo{{Name: "eth0", MAC: "02:00:00:00:00:01", Up: true}}, nil)
	})
	gather("the interfaces could not be read", nil, func(t *testing.T) {
		withFolders(t, everyFolder())
		withIfaces(t, nil, errors.New("netlink refused"))
	})
	gather("more interfaces and addresses than are listed", nil, func(t *testing.T) {
		var many []ifaceInfo
		for i := range 40 {
			many = append(many, ifaceInfo{Name: fmt.Sprintf("veth%02d", i), MAC: "02:00:00:00:00:04", Up: true, CIDRs: addrs(9)})
		}
		withFolders(t, everyFolder())
		withIfaces(t, many, nil)
	})
	carried := make([]Unreadable, 40)
	for i := range carried {
		carried[i] = Unreadable{Item: fmt.Sprintf("fixture.%d", i), Reason: "fixture"}
	}
	gather("more unreadable than are listed", carried, func(t *testing.T) {
		withFolders(t, map[string]string{})
		withIfaces(t, nil, nil)
	})
	if len(out) != 6 {
		t.Fatalf("%d frames gathered, want 6", len(out))
	}
	return out
}

type probeRun struct {
	name   string
	probed Probed
}

// probes is Probe's real output through a FakeRunner on each branch it can
// drive on this OS: unix elevation's sudo answers (Windows reads its token
// instead, whatever the runner says) and, with probesWSL, every way the WSL
// distributions Windows lists can answer.
func probes(t *testing.T) []probeRun {
	fits := Self{Binary: filepath.Join(t.TempDir(), "novad"), Config: filepath.Join(t.TempDir(), "config.json")}
	sudo := func() *platform.FakeRunner { return &platform.FakeRunner{Outputs: map[string]string{"sudo": ""}} }
	// Every held program waits until the test ends, deaf to its ctx.
	hold := make(chan struct{})
	t.Cleanup(func() { close(hold) })
	ubuntu := []platform.WSLDistro{{Name: "Ubuntu-26.04", Version: 2, Default: true}}
	two := []platform.WSLDistro{ubuntu[0], {Name: "docker-desktop", Version: 2}}
	var nine []platform.WSLDistro
	for i := range 9 {
		nine = append(nine, platform.WSLDistro{Name: fmt.Sprintf("Fixture-%d", i), Version: 2})
	}
	const list = "Ubuntu-26.04\n"
	busy := errors.New("wsl.exe: exit status 1: busy")
	look := func(pids string) string { return strings.Replace(lookOut, "pids=412", pids, 1) }
	wslSeq := func(answers ...string) programs {
		return programs{"sudo": sudo(), "wsl.exe": &platform.FakeRunner{Seq: map[string][]string{"wsl.exe": answers}}}
	}
	wslScript := func(answers ...answer) programs {
		return programs{"sudo": sudo(), "wsl.exe": &script{answers: answers}}
	}

	cases := []struct {
		name    string
		wsl     bool // Probe's Windows branch (probesWSL)
		distros []platform.WSLDistro
		r       platform.Runner
		self    *Self              // nil: the agent's own files, which fit
		bound   time.Duration      // >0: the probe's ctx ends after it; <0: it has ended
		set     func(t *testing.T) // anything else the case hands in
	}{
		{name: "sudo answers", r: sudo()},
		{name: "sudo refuses", r: &platform.FakeRunner{Errs: map[string]error{"sudo": errors.New("sudo: a password is required")}}},
		{name: "sudo is absent", r: &platform.FakeRunner{Errs: map[string]error{"sudo": &exec.Error{Name: "sudo", Err: exec.ErrNotFound}}}},
		{name: "sudo gives no answer", r: &platform.FakeRunner{Hold: hold}, bound: 150 * time.Millisecond},
		{name: "its own files do not fit", r: sudo(),
			self: &Self{Binary: filepath.Join(t.TempDir(), strings.Repeat("n", 300), "novad"), Config: filepath.Join("cfg", "con\nfig.json")}},
		{name: "WSL: no distribution", wsl: true, r: wslSeq()},
		{name: "WSL: the registry could not be read", wsl: true, r: wslSeq(), set: func(t *testing.T) {
			old := readDistros
			readDistros = func() ([]platform.WSLDistro, []error, error) { return nil, nil, errors.New("Lxss: Access is denied.") }
			t.Cleanup(func() { readDistros = old })
		}},
		{name: "WSL: an entry of the registry could not be read", wsl: true, r: wslSeq(), set: func(t *testing.T) {
			withRegistry(t, nil, []error{errors.New(`opening HKCU\...\Lxss\{0000}: Access is denied.`)})
		}},
		{name: "WSL: one running and looked inside, one stopped", wsl: true, distros: two, r: wslSeq(list, list, lookOut, "")},
		{name: "WSL: the running-list failed", wsl: true, distros: two,
			r: programs{"sudo": sudo(), "wsl.exe": &platform.FakeRunner{Errs: map[string]error{"wsl.exe": busy}}}},
		{name: "WSL: the list just before the look failed", wsl: true, distros: ubuntu, r: wslScript(answer{out: list}, answer{err: busy})},
		{name: "WSL: stopped since the list", wsl: true, distros: ubuntu, r: wslScript(answer{out: list}, answer{out: ""})},
		{name: "WSL: the look failed", wsl: true, distros: ubuntu, r: wslScript(answer{out: list}, answer{out: list}, answer{err: busy})},
		{name: "WSL: the look printed no answer", wsl: true, distros: ubuntu,
			r: wslScript(answer{out: list}, answer{out: list}, answer{out: "pid1=systemd\n"})},
		{name: "WSL: its novad processes could not be listed", wsl: true, distros: ubuntu, r: wslSeq(list, list, look("pids=?"), "")},
		{name: "WSL: a finished look found no novad", wsl: true, distros: ubuntu, r: wslSeq(list, list, look("pids="), "")},
		{name: "WSL: more novad processes than are listed", wsl: true, distros: ubuntu,
			r: wslSeq(list, list, look("pids=1 2 3 4 5 6 7 8 9 10"), "")},
		{name: "WSL: the root check failed", wsl: true, distros: ubuntu,
			r: wslScript(answer{out: list}, answer{out: list}, answer{out: lookOut}, answer{err: busy})},
		{name: "WSL: more distributions than are listed", wsl: true, distros: nine, r: wslSeq("")},
		{name: "WSL: wsl.exe gives no answer", wsl: true, distros: ubuntu,
			r: programs{"sudo": sudo(), "wsl.exe": &platform.FakeRunner{Hold: hold}}, bound: 150 * time.Millisecond},
		{name: "WSL: nothing had time to start", wsl: true, distros: ubuntu, r: wslSeq(), bound: -1},
	}
	var out []probeRun
	for _, c := range cases {
		t.Run("Probe/"+c.name, func(t *testing.T) {
			old := probesWSL
			probesWSL = c.wsl
			t.Cleanup(func() { probesWSL = old })
			withDistros(t, c.distros)
			if c.set != nil {
				c.set(t)
			}
			self := fits
			if c.self != nil {
				self = *c.self
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch {
			case c.bound > 0:
				var stop context.CancelFunc
				ctx, stop = context.WithTimeout(ctx, c.bound)
				defer stop()
			case c.bound < 0:
				cancel()
			}
			out = append(out, probeRun{c.name, Probe(ctx, c.r, self)})
		})
	}
	if len(out) != len(cases) {
		t.Fatalf("%d of %d probes ran", len(out), len(cases))
	}
	return out
}

// programs answers each program from a runner of its own — sudo from one,
// wsl.exe from another — so a scenario reads the same on Windows, whose
// elevation runs no program at all.
type programs map[string]platform.EnvRunner

func (p programs) Run(ctx context.Context, name string, args []string, stdin string) (string, error) {
	return p.RunEnv(ctx, nil, name, args, stdin)
}

func (p programs) RunEnv(ctx context.Context, env []string, name string, args []string, stdin string) (string, error) {
	r, ok := p[name]
	if !ok {
		return "", errors.New("nothing scripted for " + name)
	}
	return r.RunEnv(ctx, env, name, args, stdin)
}
