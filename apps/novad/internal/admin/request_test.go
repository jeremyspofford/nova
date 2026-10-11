package admin

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

const testID = "0123456789abcdef0123456789abcdef"

// wireArgs decodes args as the agent receives them: client.readFrame uses
// UseNumber, so a number arrives as json.Number (the S30a lesson).
func wireArgs(t *testing.T, raw string) map[string]any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestNewRequestIDIs32LowercaseHexFromTheReader(t *testing.T) {
	id, err := NewRequestID(bytes.NewReader(bytes.Repeat([]byte{0xab}, 16)))
	if err != nil {
		t.Fatal(err)
	}
	if id != strings.Repeat("ab", 16) {
		t.Fatalf("id = %q, want 16 bytes of 0xab as hex", id)
	}
	if _, err := NewRequestID(bytes.NewReader([]byte{1, 2})); err == nil {
		t.Fatal("a short read must be an error, never a short id")
	}
}

func TestFileNamesOfARequest(t *testing.T) {
	got := []string{RequestName(testID), ClaimName(testID), ResultName(testID)}
	want := []string{testID + ".req.json", testID + ".run", testID + ".res.json"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("names = %q, want %q", got, want)
	}
}

func TestPendingRequestsSeesOnlyWholeRequestFiles(t *testing.T) {
	other := strings.Repeat("f", 32)
	names := []string{
		other + ".req.json",
		"." + testID + ".req.json.tmp-123", // a write in flight
		testID + ".req.json",
		testID + ".run",
		testID + ".res.json",
		strings.ToUpper(other) + ".req.json",
		"abc.req.json",
		"notes.txt",
		testID + ".req.json.bak",
	}
	got := PendingRequests(names)
	want := []string{testID, other}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pending = %q, want %q", got, want)
	}
}

func TestWriteFileAtomicLeavesTheFileAndNoTemp(t *testing.T) {
	dir := t.TempDir()
	if err := WriteFileAtomic(dir, RequestName(testID), []byte(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, RequestName(testID)))
	if err != nil || string(b) != `{"a":1}` {
		t.Fatalf("read back %q, %v", b, err)
	}
	// Replacing is atomic too.
	if err := WriteFileAtomic(dir, RequestName(testID), []byte(`{"a":2}`)); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 || ents[0].Name() != RequestName(testID) {
		t.Fatalf("dir holds %v, want only the request file", ents)
	}
}

func TestWriteFileAtomicFailingLeavesNothing(t *testing.T) {
	dir := t.TempDir()
	// The target name is a directory: the rename must fail.
	if err := os.Mkdir(filepath.Join(dir, "x.req.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "x.req.json", "keep"), []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(dir, "x.req.json", []byte("b")); err == nil {
		t.Fatal("a rename onto a non-empty directory must be an error")
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 {
		t.Fatalf("a failed write left %v", ents)
	}
	if err := WriteFileAtomic(filepath.Join(dir, "missing"), "y", []byte("b")); err == nil {
		t.Fatal("a missing directory must be an error")
	}
}

func TestRequestRoundTrips(t *testing.T) {
	in := TaskRequest{ID: testID, Argv: []string{"winget", "install", "-e", "--id", "7zip.7zip"}, Cwd: `C:\Users\o`, TimeoutS: "600"}
	b, err := EncodeRequest(in)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"v":1`)) {
		t.Fatalf("encoded request carries no version: %s", b)
	}
	out, d, err := DecodeRequest(b)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.ID != in.ID || !reflect.DeepEqual(out.Argv, in.Argv) || out.Cwd != in.Cwd || d != 600*time.Second {
		t.Fatalf("round trip = %+v %v", out, d)
	}
}

func TestDecodeRequestRefusesWhatItCannotRunExactly(t *testing.T) {
	ok := `{"v":1,"id":"` + testID + `","argv":["cmd","/c","echo"],"timeout_s":%s}`
	for _, ts := range []string{`1.5`, `"9"`, `0`, `-5`, `86401`, `9007199254740993`, `1e3`} {
		b := []byte(strings.Replace(ok, "%s", ts, 1))
		if _, _, err := DecodeRequest(b); err == nil || !strings.Contains(err.Error(), "timeout_s") {
			t.Errorf("timeout_s %s: err = %v, want a refusal naming timeout_s", ts, err)
		}
	}
	b := []byte(strings.Replace(ok, "%s", "86400", 1))
	if _, d, err := DecodeRequest(b); err != nil || d != 86400*time.Second {
		t.Fatalf("86400: %v %v, want exactly one day", d, err)
	}
	bad := []struct{ raw, names string }{
		{`{"v":2,"id":"` + testID + `","argv":["x"],"timeout_s":5}`, "version"},
		{`{"v":1,"id":"../x","argv":["x"],"timeout_s":5}`, "id"},
		{`{"v":1,"id":"` + testID + `","argv":[],"timeout_s":5}`, "argv"},
		{`{"v":1,"id":"` + testID + `","argv":["x",""],"timeout_s":5}`, "argv"},
		{`{"v":1,"id":"` + testID + `","argv":["x"]}`, "timeout_s"},
		{`{"v":1,`, ""},
	}
	for _, c := range bad {
		_, _, err := DecodeRequest([]byte(c.raw))
		if err == nil || !strings.Contains(err.Error(), c.names) {
			t.Errorf("%s: err = %v, want a refusal naming %q", c.raw, err, c.names)
		}
	}
}

func TestRequestFromArgsReadsTheWireDecodedFrame(t *testing.T) {
	args := wireArgs(t, `{"argv":["winget","list"],"cwd":"C:\\tmp","timeout_s":120}`)
	r, err := RequestFromArgs(testID, args, 300)
	if err != nil {
		t.Fatalf("a wire-decoded frame was refused: %v", err)
	}
	if r.V != FileVersion || r.ID != testID || !reflect.DeepEqual(r.Argv, []string{"winget", "list"}) || r.Cwd != `C:\tmp` || r.TimeoutS.String() != "120" {
		t.Fatalf("request = %+v", r)
	}
	r, err = RequestFromArgs(testID, wireArgs(t, `{"argv":["x"]}`), 300)
	if err != nil || r.TimeoutS.String() != "300" {
		t.Fatalf("no timeout_s → the default: %+v %v", r, err)
	}
	for _, raw := range []string{`{"argv":["x"],"timeout_s":2.5}`, `{"argv":["x"],"timeout_s":"60"}`, `{"argv":["x"],"timeout_s":-1}`} {
		if _, err := RequestFromArgs(testID, wireArgs(t, raw), 300); err == nil || !strings.Contains(err.Error(), "timeout_s") {
			t.Errorf("%s: err = %v, want a refusal naming timeout_s", raw, err)
		}
	}
	for _, raw := range []string{`{}`, `{"argv":"cmd /c echo"}`, `{"argv":[1]}`, `{"argv":["x"],"cwd":7}`} {
		if _, err := RequestFromArgs(testID, wireArgs(t, raw), 300); err == nil {
			t.Errorf("%s: accepted, want a refusal", raw)
		}
	}
}

func TestResultRoundTripsAndChecksItsID(t *testing.T) {
	in := TaskResult{ID: testID, OK: true, ExitCode: 3, Stdout: "o", Stderr: "e", Elevated: true, User: `DELL\owner`}
	b, err := EncodeResult(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := DecodeResult(b, testID)
	if err != nil {
		t.Fatal(err)
	}
	in.V = FileVersion
	if !reflect.DeepEqual(out, in) {
		t.Fatalf("round trip = %+v, want %+v", out, in)
	}
	if _, err := DecodeResult(b, strings.Repeat("0", 32)); err == nil {
		t.Fatal("a result for another id must be an error")
	}
	if _, err := DecodeResult([]byte(`{"v":9,"id":"`+testID+`","ok":true}`), testID); err == nil {
		t.Fatal("an unknown version must be an error")
	}
	if _, err := DecodeResult([]byte(`{"v":1,`), testID); err == nil {
		t.Fatal("a torn file must be an error")
	}
}

func TestCapOutputSaysWhenItCut(t *testing.T) {
	s, cut := CapOutput([]byte("short"))
	if s != "short" || cut {
		t.Fatalf("short = %q %v", s, cut)
	}
	big := bytes.Repeat([]byte("x"), OutputCap+10)
	s, cut = CapOutput(big)
	if len(s) != OutputCap || !cut {
		t.Fatalf("big: len %d cut %v, want %d true", len(s), cut, OutputCap)
	}
	s, cut = CapOutput(big[:OutputCap])
	if len(s) != OutputCap || cut {
		t.Fatalf("exactly the cap: len %d cut %v", len(s), cut)
	}
}

func TestNextWaitDecidesEachPoll(t *testing.T) {
	limit := WaitLimit(60 * time.Second)
	if limit != 60*time.Second+WaitGrace {
		t.Fatalf("WaitLimit(60s) = %v, want 60s + WaitGrace", limit)
	}
	cases := []struct {
		name string
		s    WaitState
		want WaitStep
		said string
	}{
		{"result present is read", WaitState{Elapsed: time.Second, Limit: limit, HaveResult: true, TaskState: TaskReady}, WaitStep{Read: true, Done: true}, ""},
		{"result present past the limit is still read", WaitState{Elapsed: 2 * limit, Limit: limit, HaveResult: true, TaskState: TaskAbsent}, WaitStep{Read: true, Done: true}, ""},
		{"running, in time: poll again", WaitState{Elapsed: time.Second, Limit: limit, TaskState: TaskRunning}, WaitStep{}, ""},
		{"ready (not started yet), in time: poll again", WaitState{Elapsed: time.Second, Limit: limit, TaskState: TaskReady}, WaitStep{}, ""},
		{"task gone mid-wait", WaitState{Elapsed: time.Second, Limit: limit, TaskState: TaskAbsent}, WaitStep{Done: true}, "cannot: no admin path on this machine"},
		{"past the limit", WaitState{Elapsed: limit, Limit: limit, TaskState: TaskRunning}, WaitStep{Done: true}, "no result from the admin task after 1m15s"},
	}
	for _, c := range cases {
		got := NextWait(c.s)
		if got.Read != c.want.Read || got.Done != c.want.Done || got.Said != c.said {
			t.Errorf("%s: %+v, want read=%v done=%v said=%q", c.name, got, c.want.Read, c.want.Done, c.said)
		}
	}
}

func TestParseWhoamiReadsTheReport(t *testing.T) {
	r, err := ParseWhoami(`{"user":"DELL\\owner","sid":"S-1-5-21-1-2-3-1001","elevated":true,"integrity":"high"}` + "\r\n")
	if err != nil {
		t.Fatal(err)
	}
	if r.User != `DELL\owner` || r.SID != "S-1-5-21-1-2-3-1001" || !r.Elevated || r.Integrity != "high" {
		t.Fatalf("report = %+v", r)
	}
	for _, s := range []string{"", "Access is denied.", `{"user":`} {
		if _, err := ParseWhoami(s); err == nil {
			t.Errorf("%q parsed, want an error", s)
		}
	}
}

var hex32 = regexp.MustCompile(`^[0-9a-f]{32}$`)

func TestNewRequestIDsDiffer(t *testing.T) {
	a, _ := NewRequestID(strings.NewReader(strings.Repeat("a", 16)))
	b, _ := NewRequestID(strings.NewReader(strings.Repeat("b", 16)))
	if !hex32.MatchString(a) || !hex32.MatchString(b) || a == b {
		t.Fatalf("ids %q %q", a, b)
	}
}
