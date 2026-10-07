package facts

import (
	"bytes"
	"cmp"
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"fmt"
	"maps"
	"slices"
)

// Marshal is how the agent writes what it says about its machine: client's
// factsJSON encodes the facts frame and the auth frame through it, and
// nothing else. It is json.Marshal — encoding/json's own encoder, run with
// its v1 options, as json.Marshal runs it — with one option turned the other
// way: a nil list is written as [], never null. Core refused a whole facts
// frame over one null list (PR #110), and the encoder holds every list to
// this, those a later slice adds included, by its own rules: there is no
// copy of them here to keep in step. A list whose null means something says
// so in its own type (PIDList). A nil []byte, which no fact is, would be ""
// rather than null.
//
// The option comes after DefaultOptionsV1, which sets it the other way: the
// later one wins (TestTheWireIsJSONMarshalButForNilLists). encoding/json/v2
// is built only with the jsonv2 experiment, which Go 1.27 turns on by
// default; without it this does not compile — it never sends another wire.
func Marshal(v any) ([]byte, error) {
	return jsonv2.Marshal(v, json.DefaultOptionsV1(), jsonv2.FormatNilSliceAsNull(false))
}

// PIDList is a list of process ids that can be unknown: nil when they could
// not be listed — written as null, whatever the encoder does with other nil
// lists, because [] would say that none runs — and [] only when none is
// known to. Core reads novad_pids so (device_facts.py).
type PIDList []int

// MarshalJSON writes an unknown list as null, and a known one — empty or
// not — as the list.
func (p PIDList) MarshalJSON() ([]byte, error) {
	if p == nil {
		return []byte("null"), nil
	}
	return json.Marshal([]int(p))
}

// NullsOnPurpose are the only places a frame the agent sends — the facts
// frame or the auth frame — holds null, each by its path from the frame's
// root (keys joined by ".", and "[]" for any element of a list), with the
// reason core reads it so (services/core/app/device_facts.py). Anywhere else
// null is a stray: a value core expects, sent as nothing — core refused a
// whole frame over one (PR #110). Adding a path is a ruling that its null
// means something, never a way to quiet StrayNulls.
var NullsOnPurpose = map[string]string{
	"wsl_distros.distros[].novad_pids": "a distribution's novad processes that could not be listed: unknown, where [] would say none runs (PIDList)",
	"facts.os.wsl":                     "this agent does not run inside WSL: there is no distribution to name (OSInfo.WSL)",
}

// StrayNulls is the path of every null in data — a frame as the agent sent
// it — that NullsOnPurpose does not name. It reads the bytes, never the Go
// values they were written from, so it holds to nothing an encoder does: a
// nil list written as null, and a type that writes its own null, are strays
// alike.
//
// It is exported for tests only, here and in client, which hold every frame
// the agent sends to this one list: the builders' output, frameBytes' bytes,
// the auth frame, the goldens.
func StrayNulls(data []byte) ([]string, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	var stray []string
	strayNulls(v, "", "", &stray)
	return stray, nil
}

// strayNulls walks v: at is its path, and shape the same path with "[]" for
// each list index, as NullsOnPurpose names it.
func strayNulls(v any, at, shape string, stray *[]string) {
	switch v := v.(type) {
	case nil:
		if _, ok := NullsOnPurpose[shape]; !ok {
			*stray = append(*stray, cmp.Or(at, "(the frame itself)"))
		}
	case map[string]any:
		for _, k := range slices.Sorted(maps.Keys(v)) {
			if at == "" {
				strayNulls(v[k], k, k, stray)
				continue
			}
			strayNulls(v[k], at+"."+k, shape+"."+k, stray)
		}
	case []any:
		for i, e := range v {
			strayNulls(e, fmt.Sprintf("%s[%d]", at, i), shape+"[]", stray)
		}
	}
}
