package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func newLog(t *testing.T) *Log {
	t.Helper()
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	l, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if l.LastSeq() != -1 {
		t.Fatalf("fresh log LastSeq = %d, want -1", l.LastSeq())
	}
	return l
}

func i(n int) *int { return &n }

func TestAppendAssignsMonotonicSeqAndChains(t *testing.T) {
	l := newLog(t)
	e0, err := l.Append(1756600000, "env-0", "system.info", "ok", true, i(0))
	if err != nil {
		t.Fatal(err)
	}
	if e0["seq"].(int64) != 0 || e0["prev_hash"].(string) != "" {
		t.Fatalf("first entry seq/prev wrong: %+v", e0)
	}
	e1, err := l.Append(1756600001, "env-1", "fs.read", "read", true, i(0))
	if err != nil {
		t.Fatal(err)
	}
	if e1["seq"].(int64) != 1 {
		t.Fatalf("second seq = %v, want 1", e1["seq"])
	}
	if e1["prev_hash"].(string) != e0["hash"].(string) {
		t.Fatal("entry 1 prev_hash must equal entry 0 hash")
	}
	if l.LastSeq() != 1 {
		t.Fatalf("LastSeq = %d, want 1", l.LastSeq())
	}
}

// The first entry's hash must equal the committed cross-language chain vector
// from the T2 report — proof the daemon's chain agrees with core's ingester.
func TestFirstEntryMatchesTheCommittedChainVector(t *testing.T) {
	l := newLog(t)
	e, err := l.Append(1756600000, "env-1", "system.info", "ok", true, i(0))
	if err != nil {
		t.Fatal(err)
	}
	const want = "35e014b6f5d8a09503084e59db7b59b964fb523b49e97f92bd91f97b360c63a4"
	if got := e["hash"].(string); got != want {
		t.Fatalf("first-entry hash = %s, want committed vector %s", got, want)
	}
}

func TestAppendPersistsExitCodeNullVsValue(t *testing.T) {
	l := newLog(t)
	// A refusal has no process exit — exit_code must be present as null.
	e, err := l.Append(1756600000, "env-x", "fs.read", "refused: signature did not verify", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := e["exit_code"]; !ok {
		t.Error("exit_code key must be present (as null), never omitted")
	} else if v != nil {
		t.Errorf("exit_code = %v, want nil", v)
	}
}

func TestReopenRecoversLastSeqAndHash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	l, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = l.Append(1, "a", "system.info", "ok", true, i(0))
	e1, _ := l.Append(2, "b", "system.info", "ok", true, i(0))

	l2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if l2.LastSeq() != 1 {
		t.Fatalf("reopened LastSeq = %d, want 1", l2.LastSeq())
	}
	// A further append must chain onto the recovered hash.
	e2, err := l2.Append(3, "c", "system.info", "ok", true, i(0))
	if err != nil {
		t.Fatal(err)
	}
	if e2["prev_hash"].(string) != e1["hash"].(string) {
		t.Fatal("append after reopen did not chain onto the recovered last hash")
	}
}

func TestEntriesAfterFiltersBySeq(t *testing.T) {
	l := newLog(t)
	for k := 0; k < 5; k++ {
		if _, err := l.Append(int64(k), "e", "system.info", "ok", true, i(0)); err != nil {
			t.Fatal(err)
		}
	}
	got, err := l.EntriesAfter(2)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 { // seq 3 and 4
		t.Fatalf("EntriesAfter(2) returned %d entries, want 2", len(got))
	}
	all, err := l.EntriesAfter(-1)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 5 {
		t.Fatalf("EntriesAfter(-1) returned %d, want 5", len(all))
	}
}

func TestVerifyPassesACleanChainAndCatchesATamper(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	l, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = l.Append(1, "a", "system.info", "ok", true, i(0))
	_, _ = l.Append(2, "b", "shell.exec", "ran", true, i(3))
	_, _ = l.Append(3, "c", "fs.read", "read", true, i(0))
	if err := l.Verify(); err != nil {
		t.Fatalf("a clean chain must verify: %v", err)
	}

	// Tamper with the middle entry's summary on disk; the recomputed hash for
	// seq 1 no longer matches the stored hash.
	tamperMiddleSummary(t, path)
	if err := l.Verify(); err == nil {
		t.Fatal("a tampered entry must fail Verify")
	}
}

// tamperMiddleSummary rewrites seq 1's summary in place, leaving its stored
// hash untouched, so recomputation disagrees.
func tamperMiddleSummary(t *testing.T, path string) {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := splitLines(body)
	var e map[string]any
	if err := json.Unmarshal(lines[1], &e); err != nil {
		t.Fatal(err)
	}
	e["summary"] = "TAMPERED"
	rewritten, _ := json.Marshal(e)
	lines[1] = rewritten
	out := joinLines(lines)
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatal(err)
	}
}

func splitLines(b []byte) [][]byte {
	var out [][]byte
	start := 0
	for k := 0; k < len(b); k++ {
		if b[k] == '\n' {
			out = append(out, b[start:k])
			start = k + 1
		}
	}
	if start < len(b) {
		out = append(out, b[start:])
	}
	return out
}

func joinLines(lines [][]byte) []byte {
	var out []byte
	for _, l := range lines {
		out = append(out, l...)
		out = append(out, '\n')
	}
	return out
}
