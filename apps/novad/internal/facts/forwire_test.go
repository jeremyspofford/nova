package facts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime/debug"
	"strings"
	"testing"
	"time"

	"novad/internal/platform"
	"novad/internal/state"
)

// The lists sent as null on purpose are a ruling, each named by its Go
// struct and field: Distro.PIDs alone. Each must name a list field the
// encoder writes — a rename that left this naming nothing would turn
// novad_pids' "unknown" into "none" on the wire without a word.
func TestOnlyNovadPIDsIsSentAsNullOnPurpose(t *testing.T) {
	pids := goField{reflect.TypeFor[Distro](), "PIDs"}
	if len(nullIsUnknown) != 1 || !nullIsUnknown[pids] {
		t.Fatalf("null means unknown at %v; the ruling is %s alone", nullIsUnknown, pids)
	}
	for f := range nullIsUnknown {
		sf, ok := f.in.FieldByName(f.name)
		omitEmpty, omitZero := omitOptions(sf)
		if !ok || sf.Type.Kind() != reflect.Slice || isBytes(sf.Type) || omitEmpty || omitZero {
			t.Fatalf("%s is not a list field the encoder writes", f)
		}
	}
	if sf, _ := pids.in.FieldByName(pids.name); sf.Tag.Get("json") != "novad_pids" {
		t.Fatalf("%s is %q on the wire, not novad_pids", pids, sf.Tag.Get("json"))
	}
}

// everyShape holds a list in every place a frame can hold one, and each
// kind of field ForWire leaves as it is.
type everyShape struct {
	List      []string         `json:"list"`
	Kept      []string         `json:"kept"`
	Section   *shapeSection    `json:"section"`
	NoSection *shapeSection    `json:"no_section"`
	Any       any              `json:"any"`
	ByName    map[string][]int `json:"by_name"`
	Lists     [][]int          `json:"lists"`
	Pair      [2][]int         `json:"pair"`
	ShapeEmbedded
	Distros   []Distro       `json:"distros"`
	Lookalike shapeLookalike `json:"lookalike"`
	Empty     []string       `json:"empty,omitempty"`
	Zero      []string       `json:"zero,omitzero"`
	Skipped   []string       `json:"-"`
	hidden    []string
}

type shapeSection struct {
	List []string `json:"list"`
}

// ShapeEmbedded is promoted: its fields are everyShape's on the wire.
type ShapeEmbedded struct {
	Inner []string `json:"inner"`
}

// shapeLookalike has novad_pids too — the JSON key alone exempts nothing.
type shapeLookalike struct {
	PIDs []int `json:"novad_pids"`
}

func newEveryShape() everyShape {
	return everyShape{
		Kept:      []string{"a"},
		Section:   &shapeSection{},
		Any:       shapeSection{},
		ByName:    map[string][]int{"none": nil, "some": {1}},
		Lists:     [][]int{nil, {2}},
		Pair:      [2][]int{nil, {3}},
		Distros:   []Distro{{Name: "unknown"}, {Name: "none", PIDs: []int{}}},
		Lookalike: shapeLookalike{},
	}
}

func TestForWireLeavesNoListNullAndChangesNothingItWasHanded(t *testing.T) {
	in := newEveryShape()
	out := ForWire(in)
	if nulls := NullLists(out); len(nulls) > 0 {
		t.Fatalf("ForWire left a list nil: %s", strings.Join(nulls, ", "))
	}
	data, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"list":[]`, `"section":{"list":[]}`, `"no_section":null`, `"any":{"list":[]}`,
		`"by_name":{"none":[],"some":[1]}`, `"lists":[[],[2]]`, `"pair":[[],[3]]`, `"inner":[]`,
		`"lookalike":{"novad_pids":[]}`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("no %s on the wire: %s", want, data)
		}
	}
	if strings.Contains(string(data), `"empty"`) || strings.Contains(string(data), `"zero"`) {
		t.Errorf("a list the encoder leaves out went out: %s", data)
	}
	// novad_pids, null on purpose, stays null — unknown, never none.
	if out.Distros[0].PIDs != nil || out.Distros[1].PIDs == nil {
		t.Errorf("novad_pids = %#v, %#v: want nil (unknown) and [] (none)", out.Distros[0].PIDs, out.Distros[1].PIDs)
	}
	var back struct {
		Distros []map[string]any `json:"distros"`
	}
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if pids, present := back.Distros[0]["novad_pids"]; !present || pids != nil {
		t.Errorf("an unknown novad_pids went out as %v: %s", pids, data)
	}
	if out.Skipped != nil || out.hidden != nil || out.Empty != nil || out.Zero != nil {
		t.Errorf("a field the encoder never writes, or leaves out, was filled: %+v", out)
	}

	// What it was handed is what it was, and the copy shares nothing it
	// filled or looked inside: changing the copy changes nothing there.
	if !reflect.DeepEqual(in, newEveryShape()) {
		t.Fatalf("ForWire changed what it was handed: %+v", in)
	}
	out.Kept[0] = "changed"
	out.Section.List = append(out.Section.List, "changed")
	out.ByName["some"][0] = 9
	out.Lists[1][0] = 9
	out.Pair[1][0] = 9
	out.Distros[1].PIDs = append(out.Distros[1].PIDs, 9)
	out.Distros[0].Name = "changed"
	if !reflect.DeepEqual(in, newEveryShape()) {
		t.Fatalf("the copy shares what it was handed: %+v", in)
	}
}

// What ForWire leaves alone: a value that encodes itself is its own
// contract — a nil json.RawMessage is null by its own say — and the fields
// encoding/json never reads (time.Time's) come through whole.
func TestForWireLeavesAValueThatEncodesItself(t *testing.T) {
	at := time.Date(2026, 10, 6, 12, 0, 0, 0, time.FixedZone("fixture", 3600))
	in := struct {
		Raw json.RawMessage `json:"raw"`
		At  time.Time       `json:"at"`
	}{At: at}
	out := ForWire(in)
	if out.Raw != nil || !out.At.Equal(at) || out.At.Location() != at.Location() {
		t.Fatalf("got %+v", out)
	}
	data, err := json.Marshal(out)
	if err != nil || string(data) != `{"raw":null,"at":"2026-10-06T12:00:00+01:00"}` {
		t.Fatalf("%s, %v", data, err)
	}
	// And the probe's own state rides through: an unexported field is copied.
	w := ForWire(WSLDistros{outOfTime: true})
	if !w.outOfTime || w.Distros == nil {
		t.Fatalf("got %+v", w)
	}
}

// An unexported embedded struct promotes its exported fields onto the wire.
// reflect sets those through an embedded value, so ForWire fills them. It
// leaves an embedded pointer — reflect will not replace it, and writing
// through it would change what it points to — and one under a JSON key of
// its own, whose value reflect will not hand out for an IsZero or
// MarshalJSON check. NullLists looks inside both all the same and reports
// their nil lists: a builder's test goes red instead of one going out as
// null.
type shapeHidden struct {
	Inner []string `json:"inner"`
}

type shapeHiddenPtr struct {
	Deep []string `json:"deep"`
}

type shapeHiddenKeyed struct {
	Item []string `json:"item"`
}

func TestForWireFillsAnUnexportedEmbeddedValueAndNullListsSeesWhatItCannot(t *testing.T) {
	type withHidden struct {
		shapeHidden
		*shapeHiddenPtr
		shapeHiddenKeyed `json:"keyed"`
		List             []string `json:"list"`
	}
	in := withHidden{shapeHiddenPtr: &shapeHiddenPtr{}}
	out := ForWire(in)
	data, err := json.Marshal(out)
	got := NullLists(out)
	if err != nil || string(data) != `{"inner":[],"deep":null,"keyed":{"item":null},"list":[]}` ||
		!reflect.DeepEqual(got, []string{"deep (facts.shapeHiddenPtr.Deep)", "keyed.item (facts.shapeHiddenKeyed.Item)"}) {
		t.Fatalf("%s, %v, null lists %q", data, err, got)
	}
	if in.Inner != nil || in.Deep != nil || out.shapeHiddenPtr != in.shapeHiddenPtr {
		t.Fatalf("ForWire changed what it was handed: %+v", in)
	}
}

// Review of 2c77f2fb, (a): a []byte is a base64 string on the wire, never a
// list — a nil one is null, and stays null. NullLists does not count it.
type fixtureBytes []byte

type byteShape struct {
	B     []byte            `json:"b"`
	Named fixtureBytes      `json:"named"`
	ByKey map[string][]byte `json:"by_key"`
	Some  []byte            `json:"some"`
	List  []string          `json:"list"`
}

func TestForWireLeavesANilByteListNull(t *testing.T) {
	in := byteShape{ByKey: map[string][]byte{"none": nil}, Some: []byte("fixture")}
	data, err := json.Marshal(ForWire(in))
	if err != nil || string(data) != `{"b":null,"named":null,"by_key":{"none":null},"some":"Zml4dHVyZQ==","list":[]}` {
		t.Fatalf("%s, %v", data, err)
	}
	if got := NullLists(in); !reflect.DeepEqual(got, []string{"list (facts.byteShape.List)"}) {
		t.Fatalf("null lists %q: a []byte is a string, never a list", got)
	}
}

// Review of 2c77f2fb, (b): a field encoding/json leaves out stays out.
// omitzero asks the field's IsZero method when it has one; a struct or an
// array that holds only nil lists is zero, and filling one would put it on
// the wire. An embedded struct's tag options are ignored: its fields are
// promoted, and filled.
type neverZero struct {
	List []string `json:"list"`
}

func (neverZero) IsZero() bool { return false }

type zeroByPointer struct {
	List []string `json:"list"`
}

func (*zeroByPointer) IsZero() bool { return true }

func TestForWireLeavesAnOmittedFieldOut(t *testing.T) {
	type promotes struct {
		Promoted []string `json:"promoted"`
	}
	in := struct {
		Sec           shapeSection  `json:"sec,omitzero"`
		Pair          [2][]int      `json:"pair,omitzero"`
		ByPtr         zeroByPointer `json:"by_ptr,omitzero"`
		Never         neverZero     `json:"never,omitzero"`
		Set           shapeSection  `json:"set,omitzero"`
		Empty         shapeSection  `json:"empty,omitempty"`
		NoList        []string      `json:"no_list,omitempty"`
		NoneZero      []string      `json:"none_zero,omitzero"`
		promotes      `json:",omitzero"`
		ShapeEmbedded `json:",omitzero"`
	}{Set: shapeSection{List: []string{}}, ByPtr: zeroByPointer{List: []string{"left out"}}}
	data, err := json.Marshal(ForWire(in))
	want := `{"never":{"list":[]},"set":{"list":[]},"empty":{"list":[]},"promoted":[],"inner":[]}`
	if err != nil || string(data) != want {
		t.Fatalf("\n got %s, %v\nwant %s", data, err, want)
	}
	// What the wire would carry before ForWire: the same fields, nulls in them.
	got := NullLists(in)
	want2 := []string{"never.list (facts.neverZero.List)", "empty.list (facts.shapeSection.List)",
		"promoted (facts.promotes.Promoted)", "inner (facts.ShapeEmbedded.Inner)"}
	if !reflect.DeepEqual(got, want2) {
		t.Fatalf("null lists\n got %q\nwant %q", got, want2)
	}
}

// Review of 2c77f2fb, (c): encoding/json calls a method of a pointer only
// where it can take the value's address — behind a pointer, a list's
// element, a field of either. Elsewhere — the value itself, a map's value,
// an interface's value, an array or a field of one — it reads the value
// field by field, and ForWire fills it: it never leaves a list nil on the
// strength of a method encoding/json does not call.
type ptrMarshaled struct {
	List []string `json:"list"`
}

func (*ptrMarshaled) MarshalJSON() ([]byte, error) { return []byte(`"its own method"`), nil }

type ptrTexted struct {
	List []string `json:"list"`
}

func (*ptrTexted) MarshalText() ([]byte, error) { return []byte("its own text"), nil }

func TestForWireFillsWhatEncodingJSONReadsFieldByField(t *testing.T) {
	type behind struct {
		In ptrMarshaled `json:"in"`
	}
	in := struct {
		In     ptrMarshaled            `json:"in"`
		Text   ptrTexted               `json:"text"`
		Ptr    *ptrMarshaled           `json:"ptr"`
		Behind *behind                 `json:"behind"`
		Map    map[string]ptrMarshaled `json:"map"`
		Any    any                     `json:"any"`
		Elems  []ptrMarshaled          `json:"elems"`
		Arr    [1]ptrMarshaled         `json:"arr"`
	}{Ptr: &ptrMarshaled{}, Behind: &behind{}, Map: map[string]ptrMarshaled{"k": {}}, Any: ptrMarshaled{}, Elems: []ptrMarshaled{{}}}
	data, err := json.Marshal(ForWire(in))
	want := `{"in":{"list":[]},"text":{"list":[]},"ptr":"its own method","behind":{"in":"its own method"},` +
		`"map":{"k":{"list":[]}},"any":{"list":[]},"elems":["its own method"],"arr":[{"list":[]}]}`
	if err != nil || string(data) != want {
		t.Fatalf("\n got %s, %v\nwant %s", data, err, want)
	}
	for _, c := range []struct {
		v    any
		want string
	}{
		{ForWire(ptrMarshaled{}), `{"list":[]}`},
		{ForWire(&ptrMarshaled{}), `"its own method"`},
		{ForWire[any](ptrMarshaled{}), `{"list":[]}`},
		{ForWire[any](&ptrMarshaled{}), `"its own method"`},
	} {
		if data, err := json.Marshal(c.v); err != nil || string(data) != c.want {
			t.Errorf("%T: %s, %v, want %s", c.v, data, err, c.want)
		}
	}
}

// Review of 2c77f2fb, (d): a value that leads back to itself — through a
// pointer, a map or a list — never crashes the agent. ForWire stops where
// the cycle closes and leaves it as it is; json.Marshal then refuses it
// with an error of its own, which frameBytes returns and the agent logs.
// The stack is capped low here, so a walk that never stops fails fast.
func TestForWireStopsAtACycle(t *testing.T) {
	defer debug.SetMaxStack(debug.SetMaxStack(64 << 20))
	type node struct {
		List []string `json:"list"`
		Next *node    `json:"next"`
	}
	n := &node{}
	n.Next = n
	m := map[string]any{"list": []string(nil)}
	m["self"] = m
	s := []any{nil, []string(nil)}
	s[0] = s
	for _, c := range []struct {
		name string
		v    any
	}{{"a pointer", n}, {"a map", m}, {"a list", s}} {
		out := ForWire(c.v)
		var cycle *json.UnsupportedValueError
		if _, err := json.Marshal(out); !errors.As(err, &cycle) || !strings.Contains(err.Error(), "cycle") {
			t.Errorf("%s: json.Marshal said %v, want its own cycle error", c.name, err)
		}
		NullLists(c.v) // returns: the walk stops where the cycle closes
	}
	if out := ForWire(n); out.List == nil || out.Next != n || n.List != nil || n.Next != n {
		t.Errorf("ForWire filled what it could and left the cycle as it is: got %+v from %+v", out, n)
	}
	if m["list"].([]string) != nil || s[1].([]string) != nil {
		t.Error("ForWire changed what it was handed")
	}
}

// PR #110's review: the walk skipped what it could not see. It looks behind
// every pointer and interface that is not nil, into every map and list, and
// into an embedded struct; it exempts novad_pids by its Go field alone.
func TestNullListsLooksBehindEveryPointerAndIntoEveryMap(t *testing.T) {
	got := NullLists(newEveryShape())
	want := []string{
		"list (facts.everyShape.List)",
		"section.list (facts.shapeSection.List)",
		"any.list (facts.shapeSection.List)",
		"by_name[none]",
		"lists[0]",
		"pair[0]",
		"inner (facts.ShapeEmbedded.Inner)",
		"lookalike.novad_pids (facts.shapeLookalike.PIDs)",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("null lists\n got %q\nwant %q", got, want)
	}
	if got := NullLists([]string(nil)); !reflect.DeepEqual(got, []string{"(the value itself)"}) {
		t.Fatalf("a nil list handed in whole: %q", got)
	}
	if got := NullLists((*Frame)(nil)); got != nil {
		t.Fatalf("a nil pointer holds no list: %q", got)
	}
}

// fix/facts-unreadable-null, and PR #110's review of it: the golden frames
// are built from fixtures, so a list a builder left nil passed every test
// while the agent sent null. Here the builders' REAL output is walked,
// branch by branch — GatherAuth, GatherFrame over each way its readers
// answer, Probe through a FakeRunner on each branch it can drive here
// (sudo's answers on unix, the WSL distributions Windows lists), applied
// to each frame — and again as it crosses the wire through ForWire. A
// builder that leaves a list nil is red here even though ForWire would send
// []: an empty list says "none", and only its builder knows whether that is
// true or the list is unknown (nullIsUnknown).
func TestNoBuilderLeavesAListNil(t *testing.T) {
	ctx := context.Background()

	r := &platform.FakeRunner{Outputs: map[string]string{
		"/usr/sbin/ioreg": `"IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"`,
	}}
	at := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	for _, last := range []*state.Update{nil,
		{Version: "aaaaaaaaaaaa", Outcome: state.UpdateApplied, At: at},
		{Version: "aaaaaaaaaaaa", Outcome: state.UpdateRolledBack, Reason: "fixture\nreason", At: at},
		{Version: "aaaaaaaaaaaa", Outcome: state.UpdateStaged, At: at},
	} {
		a, _ := GatherAuth(ctx, r, "0123456789ab", last)
		noListNil(t, fmt.Sprintf("GatherAuth (last update %+v)", last), a)
	}

	frames := gatheredFrames(t)
	for _, g := range frames {
		noListNil(t, "GatherFrame: "+g.name, g.frame)
	}
	for _, p := range probes(t) {
		for _, g := range frames {
			f := g.frame
			p.probed.ApplyTo(&f)
			what := fmt.Sprintf("Probe (%s) applied to GatherFrame (%s)", p.name, g.name)
			noListNil(t, what, f)
			back, data := onTheWire(t, f)
			if p.probed.WSL == nil {
				continue
			}
			for i, d := range p.probed.WSL.Distros {
				if (back.WSLDistros.Distros[i].PIDs == nil) != (d.PIDs == nil) {
					t.Errorf("%s: novad_pids is null on the wire only where it is unknown, got %#v for %#v: %s",
						what, back.WSLDistros.Distros[i].PIDs, d.PIDs, data)
				}
			}
		}
	}
}

// noListNil fails when v — a builder's output — holds a list
// encoding/json would write as null, or one crossed the wire as null.
func noListNil[T any](t *testing.T, what string, v T) {
	t.Helper()
	if nulls := NullLists(v); len(nulls) > 0 {
		t.Errorf("%s left a list nil, which encoding/json writes as null: %s", what, strings.Join(nulls, ", "))
	}
	if back, data := onTheWire(t, v); len(NullLists(back)) > 0 {
		t.Errorf("%s: a list crossed the wire as null at %s: %s", what, strings.Join(NullLists(back), ", "), data)
	}
}

// onTheWire is v encoded as the agent encodes it — ForWire, then
// encoding/json — and decoded into a fresh value of its type: null decodes
// to a nil slice, [] to an empty one.
func onTheWire[T any](t *testing.T, v T) (T, []byte) {
	t.Helper()
	data, err := json.Marshal(ForWire(v))
	if err != nil {
		t.Fatal(err)
	}
	var back T
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("%v: %s", err, data)
	}
	return back, data
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
