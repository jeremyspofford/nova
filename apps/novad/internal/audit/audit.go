// Package audit is the daemon's local, hash-chained record of every command it
// verified and every one it refused. Each entry's hash covers the previous
// hash, so a break is detectable; core re-verifies the chain on replay and
// raises a loud governance event on any discontinuity. A refusal is an entry
// too — nothing the daemon decided about a command is ever silent.
package audit

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"novad/internal/wire"
)

// Log is the append-only JSONL audit chain, guarded so concurrent command
// handlers assign strictly increasing seqs.
type Log struct {
	path string
	mu   sync.Mutex

	lastSeq  int64  // -1 when empty
	lastHash string // "" when empty
}

// Open reads any existing chain to recover the last seq + hash. A missing file
// is an empty chain (lastSeq -1). It does NOT rewrite the file.
func Open(path string) (*Log, error) {
	l := &Log{path: path, lastSeq: -1, lastHash: ""}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return l, nil
		}
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		e, err := decodeEntry(line)
		if err != nil {
			return nil, fmt.Errorf("audit line unreadable: %w", err)
		}
		seq, _ := intField(e, "seq")
		hash, _ := e["hash"].(string)
		l.lastSeq = seq
		l.lastHash = hash
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return l, nil
}

// LastSeq is the highest seq stored, or -1 for an empty chain.
func (l *Log) LastSeq() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastSeq
}

// Append computes the next entry's chain hash, writes the nine-key JSONL line,
// advances the chain, and returns the entry (nine keys) ready to send in an
// audit frame. exitCode is nil for capabilities without a process exit.
func (l *Log) Append(ts int64, envelopeID, capability, summary string, ok bool, exitCode *int) (map[string]any, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	seq := l.lastSeq + 1
	prev := l.lastHash

	// The eight hashed keys, exit_code present as null (never omitted).
	entry := map[string]any{
		"seq":         seq,
		"prev_hash":   prev,
		"ts":          ts,
		"envelope_id": envelopeID,
		"capability":  capability,
		"summary":     summary,
		"ok":          ok,
		"exit_code":   exitCodeValue(exitCode),
	}
	hash, err := wire.ChainHash(prev, entry)
	if err != nil {
		return nil, err
	}
	full := make(map[string]any, len(entry)+1)
	for k, v := range entry {
		full[k] = v
	}
	full["hash"] = hash

	if err := l.appendLine(full); err != nil {
		return nil, err
	}
	l.lastSeq = seq
	l.lastHash = hash
	return full, nil
}

// EntriesAfter returns every stored entry with seq > after, in seq order, ready
// to replay upstream. Pass -1 to replay the whole chain (core's null last_seq).
// It reads from disk so it is correct across a restart.
func (l *Log) EntriesAfter(after int64) ([]map[string]any, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	f, err := os.Open(l.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	var out []map[string]any
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		e, err := decodeEntry(line)
		if err != nil {
			return nil, err
		}
		seq, _ := intField(e, "seq")
		if seq > after {
			out = append(out, e)
		}
	}
	return out, sc.Err()
}

// Verify recomputes the whole chain from disk and returns an error naming the
// first seq where prev_hash or the recomputed hash disagrees — the same break
// core would refuse.
func (l *Log) Verify() error {
	l.mu.Lock()
	defer l.mu.Unlock()

	f, err := os.Open(l.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // an empty chain is a valid chain
		}
		return err
	}
	defer f.Close()

	prev := ""
	expectSeq := int64(0)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		e, err := decodeEntry(line)
		if err != nil {
			return err
		}
		seq, _ := intField(e, "seq")
		if seq != expectSeq {
			return fmt.Errorf("audit chain gap: expected seq %d, found %d", expectSeq, seq)
		}
		gotPrev, _ := e["prev_hash"].(string)
		if gotPrev != prev {
			return fmt.Errorf("audit chain break at seq %d: prev_hash %q, expected %q", seq, gotPrev, prev)
		}
		storedHash, _ := e["hash"].(string)
		withoutHash := make(map[string]any, len(e)-1)
		for k, v := range e {
			if k == "hash" {
				continue
			}
			withoutHash[k] = v
		}
		recomputed, err := wire.ChainHash(prev, withoutHash)
		if err != nil {
			return err
		}
		if recomputed != storedHash {
			return fmt.Errorf("audit chain break at seq %d: stored hash %q != recomputed %q", seq, storedHash, recomputed)
		}
		prev = storedHash
		expectSeq++
	}
	return sc.Err()
}

func (l *Log) appendLine(entry map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(l.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	body, err := json.Marshal(entry)
	if err != nil {
		f.Close()
		return err
	}
	body = append(body, '\n')
	if _, err := f.Write(body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// decodeEntry decodes a stored line with UseNumber so seq/ts/exit_code stay
// integers (a float64 would re-render wrong when core re-canonicalizes).
func decodeEntry(line []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.UseNumber()
	var e map[string]any
	if err := dec.Decode(&e); err != nil {
		return nil, err
	}
	return e, nil
}

func intField(e map[string]any, key string) (int64, bool) {
	switch n := e[key].(type) {
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	case int64:
		return n, true
	case int:
		return int64(n), true
	default:
		return 0, false
	}
}

func exitCodeValue(exitCode *int) any {
	if exitCode == nil {
		return nil
	}
	return int64(*exitCode)
}
