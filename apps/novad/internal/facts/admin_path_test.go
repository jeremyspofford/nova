package facts

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"novad/internal/admin"
	"novad/internal/platform"
)

// S30b T4: the admin path is read at every probe, from the machine.

// Every other test here probes as a machine with no admin path, whatever
// the machine running the tests has (the hub has one after L1).
func init() {
	readAdminPath = func(context.Context) admin.PathState {
		return admin.PathState{Kind: admin.KindNone, State: admin.PathAbsent}
	}
}

func withAdminPath(t *testing.T, read func(context.Context) admin.PathState) *int {
	t.Helper()
	n := 0
	old := readAdminPath
	readAdminPath = func(ctx context.Context) admin.PathState { n++; return read(ctx) }
	t.Cleanup(func() { readAdminPath = old })
	return &n
}

func TestProbeCarriesTheAdminPathAsReadEachTime(t *testing.T) {
	withDistros(t, nil)
	states := []admin.PathState{
		{Kind: admin.KindNone, State: admin.PathAbsent},
		{Installed: true, Kind: admin.KindSudoers, State: admin.PathReady, Left: []string{admin.LeftRootCopy}},
	}
	i := 0
	n := withAdminPath(t, func(context.Context) admin.PathState { s := states[i]; i++; return s })
	r := &platform.FakeRunner{Outputs: map[string]string{"sudo": ""}}
	first := Probe(context.Background(), r, Self{})
	second := Probe(context.Background(), r, Self{})
	if *n != 2 {
		t.Fatalf("read %d times over two probes: every probe reads it", *n)
	}
	if first.AdminPath == nil || first.AdminPath.Installed || first.AdminPath.State != admin.PathAbsent {
		t.Fatalf("first = %+v", first.AdminPath)
	}
	if second.AdminPath == nil || !second.AdminPath.Installed || second.AdminPath.Kind != admin.KindSudoers {
		t.Fatalf("second = %+v", second.AdminPath)
	}
}

func TestAnUnreadAdminPathIsSaidOneLineAndUnreadable(t *testing.T) {
	withDistros(t, nil)
	withAdminPath(t, func(context.Context) admin.PathState {
		return admin.PathState{Kind: admin.KindNone, State: admin.PathUnknown, Said: "sudo gave no answer\nin time"}
	})
	p := Probe(context.Background(), &platform.FakeRunner{Outputs: map[string]string{"sudo": ""}}, Self{})
	if p.AdminPath == nil || p.AdminPath.State != admin.PathUnknown || p.AdminPath.Said != "sudo gave no answer" {
		t.Fatalf("admin path = %+v: one line, never two", p.AdminPath)
	}
	found := false
	for _, u := range p.Unreadable {
		if u.Item == "admin_path" && u.Reason == "sudo gave no answer" {
			found = true
		}
	}
	if !found {
		t.Fatalf("unreadable = %+v", p.Unreadable)
	}
}

func TestAnIncompleteAdminPathIsNotUnreadable(t *testing.T) {
	withDistros(t, nil)
	withAdminPath(t, func(context.Context) admin.PathState {
		return admin.PathState{Kind: admin.KindNone, State: admin.PathIncomplete, Said: "the root copy is there but sudo does not allow it"}
	})
	p := Probe(context.Background(), &platform.FakeRunner{Outputs: map[string]string{"sudo": ""}}, Self{})
	for _, u := range p.Unreadable {
		if u.Item == "admin_path" {
			t.Fatalf("an answer that it is incomplete is read, not unreadable: %+v", p.Unreadable)
		}
	}
}

func TestApplyToPutsTheAdminPathInTheFrame(t *testing.T) {
	withDistros(t, nil)
	withAdminPath(t, func(context.Context) admin.PathState {
		return admin.PathState{Installed: true, Kind: admin.KindTask, State: admin.TaskReady, Left: []string{admin.LeftTask}}
	})
	p := Probe(context.Background(), &platform.FakeRunner{Outputs: map[string]string{"sudo": ""}}, Self{})
	f := Frame{Type: "facts", Net: Net{Ifaces: []Iface{}}, Unreadable: []Unreadable{}}
	p.ApplyTo(&f)
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"admin_path":{"installed":true,"kind":"task","state":"ready"}`) {
		t.Fatalf("frame = %s", b)
	}
}

// G10: the moved-aside copy is in the facts until it is gone, read, not
// unreadable.
func TestAPendingAsideIsInTheFrameUntilItIsGone(t *testing.T) {
	withDistros(t, nil)
	p := `C:\Program Files\Nova\novad-admin-removed-0a1b2c3d.exe`
	withAdminPath(t, func(context.Context) admin.PathState {
		return admin.TaskPathState(admin.TaskAbsent, nil, false, false, []string{p})
	})
	pr := Probe(context.Background(), &platform.FakeRunner{Outputs: map[string]string{"sudo": ""}}, Self{})
	for _, u := range pr.Unreadable {
		if u.Item == "admin_path" {
			t.Fatalf("a pending aside is read, not unreadable: %+v", pr.Unreadable)
		}
	}
	f := Frame{Type: "facts", Net: Net{Ifaces: []Iface{}}, Unreadable: []Unreadable{}}
	pr.ApplyTo(&f)
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := json.Marshal(p)
	if !strings.Contains(string(b), `"state":"pending_restart"`) || !strings.Contains(string(b), `"pending":[`+string(want)+`]`) {
		t.Fatalf("frame = %s", b)
	}
}
