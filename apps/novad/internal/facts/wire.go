package facts

import (
	"encoding/json"
	jsonv2 "encoding/json/v2"
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
