package admin

import (
	"strings"
	"testing"
)

func TestQueryAbsentReadsOnlyNotFound(t *testing.T) {
	for _, out := range []string{
		"ERROR: The system cannot find the file specified.",
		"ERROR: The system cannot find the path specified.\r\n",
	} {
		if !QueryAbsent(out) {
			t.Errorf("%q: not read as absent", out)
		}
	}
	for _, out := range []string{"ERROR: Access is denied.", "", "ERROR: The task XML is malformed."} {
		if QueryAbsent(out) {
			t.Errorf("%q: read as absent, want an error stated", out)
		}
	}
}

func TestTaskStateOfReadsTheStatusColumn(t *testing.T) {
	cases := map[string]string{
		`"\Nova\NovaAdmin","N/A","Ready"` + "\r\n":   TaskReady,
		"\r\n" + `"\Nova\NovaAdmin","N/A","Running"`: TaskRunning,
		`"\Nova\NovaAdmin","N/A","Queued"`:           TaskRunning,
		`"\Nova\NovaAdmin","N/A","Disabled"`:         TaskDisabled,
	}
	for line, want := range cases {
		if got, err := TaskStateOf(line); err != nil || got != want {
			t.Errorf("%q: %q %v, want %q", line, got, err, want)
		}
	}
	for _, line := range []string{`"\Nova\NovaAdmin","N/A","Bereit"`, ""} {
		got, err := TaskStateOf(line)
		if err == nil || got != "" || !strings.Contains(err.Error(), "status") {
			t.Errorf("%q: %q %v, want an error naming the status", line, got, err)
		}
	}
}

func TestRequestFromArgsRefusesABadID(t *testing.T) {
	for _, id := range []string{"", "../x", strings.ToUpper(testID)} {
		if _, err := RequestFromArgs(id, wireArgs(t, `{"argv":["x"]}`), 300); err == nil || !strings.Contains(err.Error(), "id") {
			t.Errorf("id %q: err = %v, want a refusal naming id", id, err)
		}
	}
}
