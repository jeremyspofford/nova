package facts

import (
	"encoding"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
)

// No list the agent sends is null unless null is what it means.
// encoding/json writes a nil slice as null, and core refused the WHOLE facts
// frame over one: build 8a2c15dab611 sent "unreadable": null whenever nothing
// was unreadable, and a healthy agent's facts never landed
// (fix/facts-unreadable-null). Two pieces of code hold it, for every list —
// those a later slice adds included:
//
//	ForWire    the choke point: client's factsJSON, the one encoder of the
//	           facts frame and of the auth frame, puts each through it.
//	NullLists  the check: the tests run it over what each builder makes, and
//	           over the frames decoded from the bytes the agent sends.

// goField names one struct field by its Go struct and field name — never by
// its JSON key, which a field in another struct can share.
type goField struct {
	in   reflect.Type
	name string
}

func (f goField) String() string { return f.in.String() + "." + f.name }

// nullIsUnknown are the lists the agent sends as null ON PURPOSE: there null
// is "could not be listed" — unknown — where [] would say "none". One today:
// Distro.PIDs, novad_pids on the wire, which core reads as unknown when null
// (device_facts.py). Every other list goes out as [] when it is empty. Adding
// a field here is a ruling that its null means unknown, never a way to quiet
// NullLists; TestOnlyNovadPIDsIsSentAsNullOnPurpose pins the set.
var nullIsUnknown = map[goField]bool{
	{reflect.TypeFor[Distro](), "PIDs"}: true,
}

// ForWire is v as the agent sends it: a copy in which every list
// encoding/json would write as null is an empty one, [] on the wire — at any
// depth: a struct's fields, behind a pointer or an interface, a map's values,
// a list's elements. Left as they are: the lists in nullIsUnknown, a list the
// encoder leaves out (omitempty, omitzero), and a value that encodes itself
// (json.Marshaler, encoding.TextMarshaler: its encoding is its own contract).
//
// v, and everything it points to, is never changed: ForWire builds a new
// struct, list, map and pointer everywhere it looks inside, so the probe the
// agent keeps — carried in every later frame — and the rest of its state are
// what they were. The one place it cannot reach is an unexported embedded
// struct, whose fields reflect cannot set; NullLists looks there all the same.
func ForWire[T any](v T) T {
	var out T
	reflect.ValueOf(&out).Elem().Set(wireCopy(reflect.ValueOf(&v).Elem()))
	return out
}

var (
	jsonMarshaler = reflect.TypeFor[json.Marshaler]()
	textMarshaler = reflect.TypeFor[encoding.TextMarshaler]()
)

// encodesItself is whether encoding/json can hand a value of type t to a
// method of its own (its pointer's included) rather than read it field by
// field. An interface is never one here: its dynamic value is asked instead.
func encodesItself(t reflect.Type) bool {
	if t.Kind() == reflect.Interface {
		return false
	}
	p := reflect.PointerTo(t)
	return t.Implements(jsonMarshaler) || t.Implements(textMarshaler) ||
		p.Implements(jsonMarshaler) || p.Implements(textMarshaler)
}

// wireCopy is v, copied wherever it is looked inside, with each nil list it
// meets made empty unless nullIsUnknown or the encoder leaves it out.
func wireCopy(v reflect.Value) reflect.Value {
	t := v.Type()
	if encodesItself(t) {
		return v
	}
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			return v
		}
		p := reflect.New(t.Elem())
		p.Elem().Set(wireCopy(v.Elem()))
		return p
	case reflect.Interface:
		if v.IsNil() {
			return v
		}
		i := reflect.New(t).Elem()
		i.Set(wireCopy(v.Elem()))
		return i
	case reflect.Struct:
		s := reflect.New(t).Elem()
		s.Set(v) // every field, the ones encoding/json never reads included
		for i := range t.NumField() {
			f := t.Field(i)
			if !f.IsExported() || f.Tag.Get("json") == "-" {
				continue // never written, and an unexported field cannot be set
			}
			fv := v.Field(i)
			if fv.Kind() == reflect.Slice && fv.IsNil() && (nullIsUnknown[goField{t, f.Name}] || leftOut(f)) {
				continue
			}
			s.Field(i).Set(wireCopy(fv))
		}
		return s
	case reflect.Slice:
		if v.IsNil() {
			return reflect.MakeSlice(t, 0, 0)
		}
		s := reflect.MakeSlice(t, v.Len(), v.Len())
		for i := range v.Len() {
			s.Index(i).Set(wireCopy(v.Index(i)))
		}
		return s
	case reflect.Array:
		a := reflect.New(t).Elem()
		for i := range v.Len() {
			a.Index(i).Set(wireCopy(v.Index(i)))
		}
		return a
	case reflect.Map:
		if v.IsNil() {
			return v
		}
		m := reflect.MakeMapWithSize(t, v.Len())
		for it := v.MapRange(); it.Next(); {
			m.SetMapIndex(it.Key(), wireCopy(it.Value()))
		}
		return m
	}
	return v
}

// leftOut is whether encoding/json leaves a struct field out when it is
// empty (omitempty) or zero (omitzero): a nil list there is absent, not null.
func leftOut(f reflect.StructField) bool {
	_, opts, _ := strings.Cut(f.Tag.Get("json"), ",")
	for _, o := range strings.Split(opts, ",") {
		if o == "omitempty" || o == "omitzero" {
			return true
		}
	}
	return false
}

// NullLists is the path of every list in v that encoding/json would write as
// null: a nil slice in a field it writes and does not leave out, in a map's
// values or in a list — looking behind every pointer and interface that is
// not nil, and into every map and list, at any depth, the fields of an
// embedded struct included. The lists in nullIsUnknown are not reported.
//
// It is the tests' check, run over what each builder makes and over a frame
// decoded from the bytes the agent sent (null decodes to a nil slice, [] to
// an empty one). A path is the keys on the wire, then — for a field — the Go
// field: "net.ifaces[0].ipv4_cidr (facts.Iface.IPv4CIDR)".
func NullLists(v any) []string {
	var out []string
	nullLists(reflect.ValueOf(v), "", &out)
	return out
}

func nullLists(v reflect.Value, path string, out *[]string) {
	if !v.IsValid() {
		return
	}
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			nullLists(v.Elem(), path, out)
		}
	case reflect.Struct:
		t := v.Type()
		for i := range t.NumField() {
			f := t.Field(i)
			tag := f.Tag.Get("json")
			if tag == "-" {
				continue
			}
			name, _, _ := strings.Cut(tag, ",")
			ft := f.Type
			if ft.Kind() == reflect.Pointer {
				ft = ft.Elem()
			}
			// encoding/json's own rule: an unexported field is never written,
			// except an embedded struct, whose exported fields it promotes.
			embedded := f.Anonymous && name == "" && ft.Kind() == reflect.Struct
			if !f.IsExported() && !embedded {
				continue
			}
			fv := v.Field(i)
			if embedded {
				nullLists(fv, path, out)
				continue
			}
			if name == "" {
				name = f.Name
			}
			at := name
			if path != "" {
				at = path + "." + name
			}
			if fv.Kind() == reflect.Slice && fv.IsNil() {
				if !leftOut(f) && !nullIsUnknown[goField{t, f.Name}] {
					*out = append(*out, fmt.Sprintf("%s (%s)", at, goField{t, f.Name}))
				}
				continue
			}
			nullLists(fv, at, out)
		}
	case reflect.Slice, reflect.Array:
		if v.Kind() == reflect.Slice && v.IsNil() {
			// Only a map's value, a list's element or v itself gets here: a
			// field's nil list is told apart above, with its Go field.
			if path == "" {
				path = "(the value itself)"
			}
			*out = append(*out, path)
			return
		}
		for i := range v.Len() {
			nullLists(v.Index(i), fmt.Sprintf("%s[%d]", path, i), out)
		}
	case reflect.Map:
		keys := v.MapKeys()
		slices.SortFunc(keys, func(a, b reflect.Value) int { return strings.Compare(fmt.Sprint(a), fmt.Sprint(b)) })
		for _, k := range keys {
			nullLists(v.MapIndex(k), fmt.Sprintf("%s[%v]", path, k), out)
		}
	}
}
