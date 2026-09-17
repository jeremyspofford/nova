// Package wire is the byte-level contract with core: the canonical-JSON
// encoder that must match Python's json.dumps exactly, the on-device envelope
// verification (signature, device match, expiry, one-use), and the frame
// structs that cross the socket.
package wire

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Canonical produces the byte-identical equivalent of core's
//
//	json.dumps(payload, sort_keys=True, separators=(",",":"),
//	           ensure_ascii=True, default=str).encode("utf-8")
//
// This is the whole cross-language interop risk, so it is hand-rolled rather
// than delegated to encoding/json, which differs from Python on two axes that
// both break signatures:
//
//   - non-ASCII: Python escapes every rune > 0x7f as \uXXXX (a surrogate pair
//     for astral runes); encoding/json emits raw UTF-8.
//   - < > &: Python leaves them literal; encoding/json escapes them < etc.
//
// The value tree is what json.Unmarshal-with-UseNumber yields — map[string]any,
// []any, json.Number, string, bool, nil — plus int/int64 for entries this
// daemon builds itself (audit). There are no floats anywhere in the envelope or
// audit domain; a float64 is refused loudly rather than guessed at, because
// matching Python's float repr is a different problem this contract never has.
func Canonical(v any) ([]byte, error) {
	var b strings.Builder
	if err := encodeValue(&b, v); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

func encodeValue(b *strings.Builder, v any) error {
	switch val := v.(type) {
	case nil:
		b.WriteString("null")
		return nil
	case bool:
		if val {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
		return nil
	case string:
		encodeString(b, val)
		return nil
	case json.Number:
		// The exact numeric text as it arrived on the wire — never re-parsed,
		// so 1756600000 can never round-trip through float64 into 1.7566e+09.
		b.WriteString(string(val))
		return nil
	case int:
		b.WriteString(strconv.FormatInt(int64(val), 10))
		return nil
	case int64:
		b.WriteString(strconv.FormatInt(val, 10))
		return nil
	case map[string]any:
		return encodeObject(b, val)
	case []any:
		return encodeArray(b, val)
	case float64:
		return fmt.Errorf("canonical: float64 %v is outside the envelope/audit domain; "+
			"decode the wire with UseNumber and build numbers as int64", val)
	default:
		return fmt.Errorf("canonical: unsupported type %T", v)
	}
}

func encodeObject(b *strings.Builder, m map[string]any) error {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Go's byte-lexicographic sort on UTF-8 keys agrees with Python's
	// sort_keys (code-point order) because UTF-8 preserves code-point order.
	sort.Strings(keys)
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		encodeString(b, k)
		b.WriteByte(':')
		if err := encodeValue(b, m[k]); err != nil {
			return err
		}
	}
	b.WriteByte('}')
	return nil
}

func encodeArray(b *strings.Builder, a []any) error {
	b.WriteByte('[')
	for i, item := range a {
		if i > 0 {
			b.WriteByte(',')
		}
		if err := encodeValue(b, item); err != nil {
			return err
		}
	}
	b.WriteByte(']')
	return nil
}

// encodeString mirrors Python's json ESCAPE_ASCII table exactly: the named
// short escapes, \u00XX for the remaining C0 controls, printable ASCII
// (0x20–0x7e) left literal INCLUDING < > &, and everything else — every rune
// > 0x7e, DEL included — emitted as \uXXXX, with a UTF-16 surrogate pair for
// runes beyond the BMP. Hex digits are lowercase, matching Python.
func encodeString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			switch {
			case r < 0x20 || r > 0x7e:
				if r > 0xffff {
					r -= 0x10000
					hi := 0xd800 + ((r >> 10) & 0x3ff)
					lo := 0xdc00 + (r & 0x3ff)
					fmt.Fprintf(b, `\u%04x\u%04x`, hi, lo)
				} else {
					fmt.Fprintf(b, `\u%04x`, r)
				}
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}
