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
// frame over one: before PR #110, a healthy agent's frames carried
// "unreadable": null once its probe had run, and none of its facts landed.
// Two pieces of code hold it, for every list — those a later slice adds
// included:
//
//	ForWire    the choke point: client's factsJSON, the one encoder of the
//	           facts frame and of the auth frame, puts each through it.
//	NullLists  the check: the tests run it over what each builder makes, and
//	           over the frames decoded from the bytes the agent sends.
//
// Both read a value as encoding/json reads it: the same fields, left out by
// the same rules, and a []byte is a string to both, never a list.

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
// encoding/json would write as null is an empty one, [] on the wire, at any
// depth — a struct's fields, behind a pointer or an interface, a map's
// values, a list's elements, the fields an embedded struct promotes. v is
// read as json.Marshal(v) reads it, by value. ForWire leaves as it is:
//
//   - a list in nullIsUnknown: null there means unknown, and [] would say
//     none;
//   - a field encoding/json leaves out — omitempty and empty, or omitzero
//     and zero, by its IsZero method when it has one: filling a list inside
//     would make it no longer zero, and put it on the wire;
//   - a value encoding/json hands to a method of its own: its type has
//     MarshalJSON or MarshalText, or its pointer type does and encoding/json
//     can take the value's address there — behind a pointer or in a list, or
//     a field or element of a value that is. What the method writes is its
//     own contract. Elsewhere — v itself, a map's value, an interface's
//     value, or a field or element of one — encoding/json never calls a
//     pointer's method: it reads the value field by field, and ForWire
//     fills it;
//   - a []byte: encoding/json writes it as a base64 string, never a list —
//     a nil one as null, which stays null;
//   - a pointer, map or list met again inside itself: a cycle. ForWire
//     stops there, and json.Marshal refuses the value with an error of its
//     own; it never crashes the agent;
//   - what encoding/json never writes (an unexported field, one tagged "-"),
//     and an unexported embedded field that is not a struct value whose
//     fields it promotes: a pointer, or one under a JSON key of its own.
//     reflect will not replace such a field, nor hand out its value for an
//     IsZero or MarshalJSON check, and writing through the pointer would
//     change what it points to. NullLists reports a nil list there.
//
// v, and everything it points to, is never changed: ForWire builds a new
// struct, list, map and pointer everywhere it looks inside, so the probe the
// agent keeps — carried in every later frame — and the rest of its state are
// what they were.
func ForWire[T any](v T) T {
	var out T
	c := copier{onPath: path{}}
	reflect.ValueOf(&out).Elem().Set(c.copy(reflect.ValueOf(&v).Elem(), false))
	return out
}

// copier is one ForWire walk: onPath is the pointers, maps and lists it is
// inside now.
type copier struct{ onPath path }

// copy is v, copied wherever ForWire looks inside it, every nil list it
// meets filled. addressable is whether encoding/json could take v's address
// there, so call a method its pointer has.
func (c *copier) copy(v reflect.Value, addressable bool) reflect.Value {
	t := v.Type()
	if encodesItself(t, addressable) || isBytes(t) {
		return v
	}
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			return v
		}
		k, ok := c.onPath.enter(v)
		if !ok {
			return v
		}
		defer delete(c.onPath, k)
		p := reflect.New(t.Elem())
		p.Elem().Set(c.copy(v.Elem(), true))
		return p
	case reflect.Interface:
		if v.IsNil() {
			return v
		}
		i := reflect.New(t).Elem()
		i.Set(c.copy(v.Elem(), false))
		return i
	case reflect.Struct:
		s := reflect.New(t).Elem()
		s.Set(v) // every field, the ones encoding/json never reads included
		c.fields(s, v, addressable)
		return s
	case reflect.Slice:
		if v.IsNil() {
			return reflect.MakeSlice(t, 0, 0)
		}
		k, ok := c.onPath.enter(v)
		if !ok {
			return v
		}
		defer delete(c.onPath, k)
		s := reflect.MakeSlice(t, v.Len(), v.Len())
		for i := range v.Len() {
			s.Index(i).Set(c.copy(v.Index(i), true))
		}
		return s
	case reflect.Array:
		a := reflect.New(t).Elem()
		for i := range v.Len() {
			a.Index(i).Set(c.copy(v.Index(i), addressable))
		}
		return a
	case reflect.Map:
		if v.IsNil() {
			return v
		}
		k, ok := c.onPath.enter(v)
		if !ok {
			return v
		}
		defer delete(c.onPath, k)
		m := reflect.MakeMapWithSize(t, v.Len())
		for it := v.MapRange(); it.Next(); {
			m.SetMapIndex(it.Key(), c.copy(it.Value(), false))
		}
		return m
	}
	return v
}

// fields replaces each field of dst — a copy of src, every field already
// set — that encoding/json writes with ForWire's copy of it.
func (c *copier) fields(dst, src reflect.Value, addressable bool) {
	t := src.Type()
	for i := range t.NumField() {
		f := t.Field(i)
		_, promoted, written := jsonField(f)
		if !written {
			continue
		}
		fv := src.Field(i)
		switch {
		case !f.IsExported():
			// An unexported embedded struct: reflect sets the fields it
			// promotes through dst, though never the embedded field itself.
			if promoted && fv.Kind() == reflect.Struct {
				c.fields(dst.Field(i), fv, addressable)
			}
		case !promoted && omitted(f, fv):
		case fv.Kind() == reflect.Slice && fv.IsNil() && nullIsUnknown[goField{t, f.Name}]:
		default:
			dst.Field(i).Set(c.copy(fv, addressable))
		}
	}
}

// path is the pointers, maps and lists a walk is inside now. One met again
// leads back to itself: a cycle, which json.Marshal refuses with an error,
// and which a walk that did not stop would follow until the agent crashed.
type path map[pathKey]bool

type pathKey struct {
	t   reflect.Type
	ptr uintptr
	len int // a list's: one is never its own sub-list
}

// enter adds v — a pointer, map or list that is not nil — to the path, or
// says it is on it already.
func (p path) enter(v reflect.Value) (pathKey, bool) {
	k := pathKey{t: v.Type(), ptr: v.Pointer()}
	if v.Kind() == reflect.Slice {
		k.len = v.Len()
	}
	if p[k] {
		return k, false
	}
	p[k] = true
	return k, true
}

var (
	jsonMarshaler = reflect.TypeFor[json.Marshaler]()
	textMarshaler = reflect.TypeFor[encoding.TextMarshaler]()
	isZeroer      = reflect.TypeFor[interface{ IsZero() bool }]()
)

// encodesItself is encoding/json's rule for handing a value of type t to a
// method of its own: t has MarshalJSON or MarshalText, or — where the value
// is addressable — its pointer type does. An interface never does here: the
// value inside it is asked, as encoding/json asks it.
func encodesItself(t reflect.Type, addressable bool) bool {
	if t.Kind() == reflect.Interface {
		return false
	}
	if t.Implements(jsonMarshaler) || t.Implements(textMarshaler) {
		return true
	}
	p := reflect.PointerTo(t)
	return addressable && t.Kind() != reflect.Pointer && (p.Implements(jsonMarshaler) || p.Implements(textMarshaler))
}

// isBytes is whether encoding/json writes a list of type t as a base64
// string: its elements are bytes, and do not encode themselves.
func isBytes(t reflect.Type) bool {
	if t.Kind() != reflect.Slice || t.Elem().Kind() != reflect.Uint8 {
		return false
	}
	p := reflect.PointerTo(t.Elem())
	return !p.Implements(jsonMarshaler) && !p.Implements(textMarshaler)
}

// jsonField is how encoding/json writes struct field f: under key, or — an
// embedded struct with no key of its own — as the fields it promotes, its
// tag's options ignored; or, when written is false, not at all.
func jsonField(f reflect.StructField) (key string, promoted, written bool) {
	tag := f.Tag.Get("json")
	if tag == "-" {
		return "", false, false
	}
	key, _, _ = strings.Cut(tag, ",")
	ft := f.Type
	if ft.Kind() == reflect.Pointer {
		ft = ft.Elem()
	}
	embeds := f.Anonymous && ft.Kind() == reflect.Struct
	switch {
	case !f.IsExported() && !embeds:
		return "", false, false
	case key == "" && embeds:
		return "", true, true
	case key == "":
		key = f.Name
	}
	return key, false, true
}

// omitOptions are the options in f's tag that can leave it out.
func omitOptions(f reflect.StructField) (omitEmpty, omitZero bool) {
	_, opts, _ := strings.Cut(f.Tag.Get("json"), ",")
	for _, o := range strings.Split(opts, ",") {
		omitEmpty = omitEmpty || o == "omitempty"
		omitZero = omitZero || o == "omitzero"
	}
	return omitEmpty, omitZero
}

// omitted is whether encoding/json leaves field f, holding v, out of the
// object it writes.
func omitted(f reflect.StructField, v reflect.Value) bool {
	omitEmpty, omitZero := omitOptions(f)
	return (omitEmpty && isEmpty(v)) || (omitZero && isZero(v))
}

// isEmpty is encoding/json's omitempty test.
func isEmpty(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Array, reflect.Map, reflect.Slice, reflect.String:
		return v.Len() == 0
	case reflect.Bool,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64,
		reflect.Interface, reflect.Pointer:
		return v.IsZero()
	}
	return false
}

// isZero is encoding/json's omitzero test: the IsZero method of v's type,
// or of its pointer type, when it has one; else whether v is its type's zero
// value. A value reflect will not hand out (one read through an unexported
// field) is asked the second way: no method can be called on it.
func isZero(v reflect.Value) bool {
	t := v.Type()
	if !v.CanInterface() {
		return v.IsZero()
	}
	switch {
	case t.Kind() == reflect.Interface && t.Implements(isZeroer):
		return v.IsNil() || (v.Elem().Kind() == reflect.Pointer && v.Elem().IsNil()) ||
			v.Interface().(interface{ IsZero() bool }).IsZero()
	case t.Kind() == reflect.Pointer && t.Implements(isZeroer):
		return v.IsNil() || v.Interface().(interface{ IsZero() bool }).IsZero()
	case t.Implements(isZeroer):
		return v.Interface().(interface{ IsZero() bool }).IsZero()
	case reflect.PointerTo(t).Implements(isZeroer):
		if !v.CanAddr() {
			boxed := reflect.New(t).Elem()
			boxed.Set(v)
			v = boxed
		}
		return v.Addr().Interface().(interface{ IsZero() bool }).IsZero()
	}
	return v.IsZero()
}

// NullLists is the path of every list in v that encoding/json would write as
// null: a nil slice in a field it writes and does not leave out, in a map's
// values or in a list — looking behind every pointer and interface that is
// not nil, and into every map and list, at any depth, the fields of an
// embedded struct included. Not reported: the lists in nullIsUnknown, and a
// []byte, which is a string on the wire. Stricter than the wire in one way:
// a value with a MarshalJSON or MarshalText of its own is read field by
// field all the same — what its method writes, NullLists cannot know. A
// pointer, map or list met again inside itself is not walked again: v
// cycles, and json.Marshal refuses it whole.
//
// It is the tests' check, run over what each builder makes and over a frame
// decoded from the bytes the agent sent (null decodes to a nil slice, [] to
// an empty one). A path is the keys on the wire, then — for a field — the Go
// field: "net.ifaces[0].ipv4_cidr (facts.Iface.IPv4CIDR)".
func NullLists(v any) []string {
	w := nullWalk{onPath: path{}}
	w.walk(reflect.ValueOf(v), "")
	return w.found
}

type nullWalk struct {
	onPath path
	found  []string
}

func (w *nullWalk) walk(v reflect.Value, at string) {
	if !v.IsValid() {
		return
	}
	switch v.Kind() {
	case reflect.Pointer, reflect.Map:
		if v.IsNil() {
			return
		}
		k, ok := w.onPath.enter(v)
		if !ok {
			return
		}
		defer delete(w.onPath, k)
		if v.Kind() == reflect.Pointer {
			w.walk(v.Elem(), at)
			return
		}
		keys := v.MapKeys()
		slices.SortFunc(keys, func(a, b reflect.Value) int { return strings.Compare(fmt.Sprint(a), fmt.Sprint(b)) })
		for _, key := range keys {
			w.walk(v.MapIndex(key), fmt.Sprintf("%s[%v]", at, key))
		}
	case reflect.Interface:
		if !v.IsNil() {
			w.walk(v.Elem(), at)
		}
	case reflect.Struct:
		t := v.Type()
		for i := range t.NumField() {
			f := t.Field(i)
			key, promoted, written := jsonField(f)
			if !written {
				continue
			}
			fv := v.Field(i)
			if promoted {
				w.walk(fv, at)
				continue
			}
			if omitted(f, fv) {
				continue // never on the wire
			}
			if at != "" {
				key = at + "." + key
			}
			if fv.Kind() == reflect.Slice && fv.IsNil() && !isBytes(fv.Type()) {
				if !nullIsUnknown[goField{t, f.Name}] {
					w.found = append(w.found, fmt.Sprintf("%s (%s)", key, goField{t, f.Name}))
				}
				continue
			}
			w.walk(fv, key)
		}
	case reflect.Slice, reflect.Array:
		if isBytes(v.Type()) {
			return // a string on the wire
		}
		if v.Kind() == reflect.Slice {
			if v.IsNil() {
				// Only a map's value, a list's element or v itself gets here: a
				// field's nil list is told apart above, with its Go field.
				if at == "" {
					at = "(the value itself)"
				}
				w.found = append(w.found, at)
				return
			}
			k, ok := w.onPath.enter(v)
			if !ok {
				return
			}
			defer delete(w.onPath, k)
		}
		for i := range v.Len() {
			w.walk(v.Index(i), fmt.Sprintf("%s[%d]", at, i))
		}
	}
}
