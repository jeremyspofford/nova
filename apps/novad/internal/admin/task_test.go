package admin

import (
	"encoding/binary"
	"encoding/xml"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
)

const (
	ownerSID = "S-1-5-21-1004336348-1177238915-682003330-1001"
	ownerBin = `C:\Users\owner\AppData\Local\Nova\novad.exe`
)

var ownerDef = TaskDefinition{SID: ownerSID, Binary: ownerBin}

func TestValidSID(t *testing.T) {
	for _, s := range []string{"S-1-5-18", "S-1-5-32-544", ownerSID} {
		if !ValidSID(s) {
			t.Errorf("%q refused, want valid", s)
		}
	}
	for _, s := range []string{"", "S-1-5", "s-1-5-18", "S-1-5-18 ", "S-1-5-x", "S-1-5-21-1)(A;;GA;;;WD", "S-1--5", "S-1-5-18\n"} {
		if ValidSID(s) {
			t.Errorf("%q accepted, want refused", s)
		}
	}
}

// Directly under ProgramData, never under a folder a standard user could
// have created first (and so own, and rename the request directory out of).
func TestRequestDirIsDirectlyUnderProgramData(t *testing.T) {
	for _, pd := range []string{`C:\ProgramData`, `C:\ProgramData\`} {
		if got := RequestDir(pd); got != `C:\ProgramData\NovaAdmin` {
			t.Errorf("RequestDir(%q) = %q", pd, got)
		}
	}
}

func TestRequestDirSDDLAdmitsOnlyTheOwnerSystemAndAdministrators(t *testing.T) {
	got, err := RequestDirSDDL(ownerSID)
	want := "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + ownerSID + ")"
	if err != nil || got != want {
		t.Fatalf("RequestDirSDDL = %q, %v; want %q", got, err, want)
	}
	for _, bad := range []string{"", "WD", "S-1-5-21-1)(A;OICI;FA;;;WD"} {
		if s, err := RequestDirSDDL(bad); err == nil || s != "" {
			t.Errorf("%q: %q %v, want an error and no descriptor", bad, s, err)
		}
	}
}

func TestTaskSDDLLetsTheOwnerRunButNotChangeIt(t *testing.T) {
	got, err := TaskSDDL(ownerSID)
	want := "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;" + ownerSID + ")"
	if err != nil || got != want {
		t.Fatalf("TaskSDDL = %q, %v; want %q", got, err, want)
	}
	if s, err := TaskSDDL("S-1-5-21-1)(A;;FA;;;WD"); err == nil || s != "" {
		t.Fatalf("an injected SID gave %q %v", s, err)
	}
}

func wellFormed(t *testing.T, doc string) {
	t.Helper()
	d := xml.NewDecoder(strings.NewReader(doc))
	for {
		_, err := d.Token()
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			t.Fatalf("task XML is not well-formed: %v\n%s", err, doc)
		}
	}
}

func TestTaskXMLIsTheOwnersElevatedInteractiveOnDemandTask(t *testing.T) {
	doc, err := TaskXML(ownerDef)
	if err != nil {
		t.Fatal(err)
	}
	wellFormed(t, doc)
	sd, _ := TaskSDDL(ownerSID)
	for _, want := range []string{
		"<UserId>" + ownerSID + "</UserId>",
		"<LogonType>InteractiveToken</LogonType>",
		"<RunLevel>HighestAvailable</RunLevel>",
		"<MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>",
		"<AllowStartOnDemand>true</AllowStartOnDemand>",
		"<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
		"<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
		"<ExecutionTimeLimit>PT25H</ExecutionTimeLimit>",
		"<Command>" + ownerBin + "</Command>",
		"<Arguments>" + RunQueuedArgs + "</Arguments>",
		"<SecurityDescriptor>" + sd + "</SecurityDescriptor>",
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("task XML lacks %s", want)
		}
	}
	for _, never := range []string{"Trigger>", "Password", "S4U"} {
		if strings.Contains(doc, never) {
			t.Errorf("task XML carries %q: it must be on demand, interactive, no stored password", never)
		}
	}
	rb, err := ParseTaskXML([]byte(doc))
	want := TaskReadBack{UserID: ownerSID, LogonType: "InteractiveToken", RunLevel: "HighestAvailable",
		Command: ownerBin, Arguments: RunQueuedArgs, MultipleInstances: "Parallel"}
	if err != nil || rb != want {
		t.Fatalf("read back %+v, %v; want %+v", rb, err, want)
	}
}

func TestTaskXMLEscapesThePath(t *testing.T) {
	bin := `C:\R&D\Nova\novad.exe`
	doc, err := TaskXML(TaskDefinition{SID: ownerSID, Binary: bin})
	if err != nil {
		t.Fatal(err)
	}
	wellFormed(t, doc)
	if !strings.Contains(doc, `C:\R&amp;D\Nova\novad.exe`) {
		t.Fatalf("& not escaped:\n%s", doc)
	}
	if rb, err := ParseTaskXML([]byte(doc)); err != nil || rb.Command != bin {
		t.Fatalf("read back command %q, %v", rb.Command, err)
	}
}

func TestTaskXMLRefusesWhatItCannotBuildSafely(t *testing.T) {
	bad := []TaskDefinition{
		{SID: "", Binary: ownerBin},
		{SID: "S-1-5-21-1)(A;;FA;;;WD", Binary: ownerBin},
		{SID: ownerSID, Binary: ""},
		{SID: ownerSID, Binary: "novad.exe"},
		{SID: ownerSID, Binary: `\\server\share\novad.exe`},
		{SID: ownerSID, Binary: `C:\a"b\novad.exe`},
		{SID: ownerSID, Binary: "C:\\a\nb\\novad.exe"},
	}
	for _, d := range bad {
		if doc, err := TaskXML(d); err == nil || doc != "" {
			t.Errorf("%+v: built %q, %v; want an error and nothing", d, doc, err)
		}
		if b, err := TaskXMLFile(d); err == nil || b != nil {
			t.Errorf("%+v: TaskXMLFile built %d bytes, %v", d, len(b), err)
		}
	}
}

func utf16le(t *testing.T, b []byte) string {
	t.Helper()
	if len(b)%2 != 0 {
		t.Fatalf("odd UTF-16 length %d", len(b))
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[2*i:])
	}
	return string(utf16.Decode(u))
}

func TestTaskXMLFileIsUTF16WithABOM(t *testing.T) {
	b, err := TaskXMLFile(ownerDef)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) < 2 || b[0] != 0xFF || b[1] != 0xFE {
		t.Fatalf("no UTF-16LE BOM: % x", b[:min(len(b), 4)])
	}
	doc := utf16le(t, b[2:])
	if !strings.HasPrefix(doc, `<?xml version="1.0" encoding="UTF-16"?>`) {
		t.Fatalf("declaration: %.60q", doc)
	}
	if !strings.Contains(doc, "<RunLevel>HighestAvailable</RunLevel>") {
		t.Fatalf("decoded file lacks the run level:\n%s", doc)
	}
	rb, err := ParseTaskXML(b)
	if err != nil || rb.UserID != ownerSID || rb.Command != ownerBin {
		t.Fatalf("ParseTaskXML of the UTF-16 file = %+v, %v", rb, err)
	}
}

func TestParseTaskXMLRefusesGarbage(t *testing.T) {
	for _, b := range [][]byte{nil, []byte("ERROR: The system cannot find the file specified."), []byte("<Task><Principals>")} {
		if _, err := ParseTaskXML(b); err == nil {
			t.Errorf("%q parsed, want an error", b)
		}
	}
}

func TestSchtasksArgs(t *testing.T) {
	cases := map[string][]string{
		"create": {"/create", "/tn", TaskPath, "/xml", `C:\t\task.xml`, "/f"},
		"run":    {"/run", "/tn", TaskPath},
		"end":    {"/end", "/tn", TaskPath},
		"delete": {"/delete", "/tn", TaskPath, "/f"},
		"query":  {"/query", "/tn", TaskPath, "/xml"},
	}
	for op, want := range cases {
		if got := SchtasksArgs(op, TaskPath, `C:\t\task.xml`); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %q, want %q", op, got, want)
		}
	}
	if got := SchtasksArgs("change", TaskPath, ""); got != nil {
		t.Errorf("unknown op gave %q", got)
	}
}

func TestPlanInstall(t *testing.T) {
	cases := []struct {
		s    InstallState
		want []string
	}{
		{InstallState{}, []string{StepSecureDir, StepClearDir, StepCopyBinary, StepRegisterTask, StepProve}},
		{InstallState{TaskPresent: true, DirPresent: true, CopyPresent: true}, []string{StepSecureDir, StepClearDir, StepCopyBinary, StepRegisterTask, StepProve}},
		{InstallState{TaskPresent: true, TaskRunning: true, DirPresent: true}, []string{StepEndTask, StepSecureDir, StepClearDir, StepCopyBinary, StepRegisterTask, StepProve}},
		{InstallState{TaskPresent: true, TaskRunning: true, DirPresent: true, Self: true}, []string{StepSecureDir, StepClearDir, StepCopyBinary, StepRegisterTask, StepProve}},
	}
	for _, c := range cases {
		if got := PlanInstall(c.s); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%+v: %q, want %q", c.s, got, c.want)
		}
	}
}

func TestPlanUninstall(t *testing.T) {
	cases := []struct {
		s    InstallState
		want []string
	}{
		{InstallState{}, nil},
		{InstallState{TaskPresent: true, DirPresent: true}, []string{StepDeleteTask, StepRemoveDir, StepReadBack}},
		{InstallState{TaskPresent: true, TaskRunning: true, DirPresent: true}, []string{StepEndTask, StepDeleteTask, StepRemoveDir, StepReadBack}},
		{InstallState{TaskPresent: true, TaskRunning: true, DirPresent: true, Self: true}, []string{StepDeleteTask, StepRemoveDir, StepReadBack}},
		{InstallState{DirPresent: true}, []string{StepRemoveDir, StepReadBack}},
		{InstallState{TaskPresent: true}, []string{StepDeleteTask, StepReadBack}},
		{InstallState{TaskPresent: true, DirPresent: true, CopyPresent: true}, []string{StepDeleteTask, StepRemoveDir, StepRemoveCopy, StepReadBack}},
		{InstallState{CopyPresent: true}, []string{StepRemoveCopy, StepReadBack}},
	}
	for _, c := range cases {
		if got := PlanUninstall(c.s); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%+v: %q, want %q", c.s, got, c.want)
		}
	}
}

func goodDir() DirSecurity {
	return DirSecurity{Owner: SIDAdministrators, Protected: true, Allowed: []string{SIDSystem, SIDAdministrators, ownerSID}}
}

func TestDirVerdict(t *testing.T) {
	if ok, said := DirVerdict(goodDir(), ownerSID); !ok {
		t.Fatalf("the built ACL refused: %s", said)
	}
	cases := map[string]func(*DirSecurity){
		"S-1-1-0":      func(d *DirSecurity) { d.Allowed = append(d.Allowed, "S-1-1-0") }, // Everyone
		"inherit":      func(d *DirSecurity) { d.Protected = false },
		ownerSID:       func(d *DirSecurity) { d.Allowed = []string{SIDSystem, SIDAdministrators} },
		"S-1-5-32-545": func(d *DirSecurity) { d.Owner = "S-1-5-32-545" }, // Users
		"deny":         func(d *DirSecurity) { d.Denied = []string{ownerSID} },
	}
	for names, mut := range cases {
		d := goodDir()
		mut(&d)
		ok, said := DirVerdict(d, ownerSID)
		if ok || !strings.Contains(said, names) {
			t.Errorf("%+v: ok=%v said %q, want refused naming %q", d, ok, said, names)
		}
	}
}

func goodReadBack(t *testing.T) InstallReadBack {
	t.Helper()
	d := goodDir()
	return InstallReadBack{
		Want: ownerDef,
		Task: &TaskReadBack{UserID: ownerSID, LogonType: "InteractiveToken", RunLevel: "HighestAvailable",
			Command: ownerBin, Arguments: RunQueuedArgs, MultipleInstances: "Parallel"},
		Dir: &d,
		Whoami: &TaskResult{V: FileVersion, ID: testID, OK: true, ExitCode: 0, Elevated: true, User: `DELL\owner`,
			Stdout: `{"user":"DELL\\owner","sid":"` + ownerSID + `","elevated":true,"integrity":"high"}`},
	}
}

func TestInstallVerdictProvesAnElevatedRoundTrip(t *testing.T) {
	ok, said := InstallVerdict(goodReadBack(t))
	if !ok || !strings.Contains(said, "elevated") || !strings.Contains(said, TaskPath) || !strings.Contains(said, `DELL\owner`) {
		t.Fatalf("ok=%v said %q, want ok naming the task, the user and elevated", ok, said)
	}
	cases := map[string]func(*InstallReadBack){
		"absent":             func(r *InstallReadBack) { r.Task = nil },
		"LeastPrivilege":     func(r *InstallReadBack) { r.Task.RunLevel = "LeastPrivilege" },
		"Password":           func(r *InstallReadBack) { r.Task.LogonType = "Password" },
		"S-1-5-21-9-9-9-500": func(r *InstallReadBack) { r.Task.UserID = "S-1-5-21-9-9-9-500" },
		`C:\other\novad.exe`: func(r *InstallReadBack) { r.Task.Command = `C:\other\novad.exe` },
		"run-once":           func(r *InstallReadBack) { r.Task.Arguments = "run-once" },
		"request directory":  func(r *InstallReadBack) { r.Dir = nil },
		"S-1-1-0":            func(r *InstallReadBack) { r.Dir.Allowed = append(r.Dir.Allowed, "S-1-1-0") },
		"the task did not start": func(r *InstallReadBack) {
			r.Whoami, r.WhoamiSaid = nil, "the task did not start"
		},
		"exit 5": func(r *InstallReadBack) { r.Whoami.ExitCode = 5 },
		"not elevated": func(r *InstallReadBack) {
			r.Whoami.Stdout = strings.Replace(r.Whoami.Stdout, `"elevated":true`, `"elevated":false`, 1)
		},
		"S-1-5-18": func(r *InstallReadBack) {
			r.Whoami.Stdout = strings.Replace(r.Whoami.Stdout, ownerSID, "S-1-5-18", 1)
		},
		"Access is denied.": func(r *InstallReadBack) { r.Whoami.Stdout = "Access is denied." },
	}
	for names, mut := range cases {
		rb := goodReadBack(t)
		mut(&rb)
		ok, said := InstallVerdict(rb)
		if ok || !strings.Contains(said, names) {
			t.Errorf("%s: ok=%v said %q, want refused naming it", names, ok, said)
		}
	}
}

func TestUninstallVerdict(t *testing.T) {
	if ok, said := UninstallVerdict(false, false, false); !ok || !strings.Contains(said, "gone") || !strings.Contains(said, "protected copy") {
		t.Fatalf("all gone: ok=%v %q", ok, said)
	}
	if ok, said := UninstallVerdict(true, false, false); ok || !strings.Contains(said, TaskPath) {
		t.Errorf("task left: ok=%v %q", ok, said)
	}
	if ok, said := UninstallVerdict(false, true, false); ok || !strings.Contains(said, "request directory") {
		t.Errorf("dir left: ok=%v %q", ok, said)
	}
	if ok, said := UninstallVerdict(false, false, true); ok || !strings.Contains(said, "protected copy is still there") {
		t.Errorf("copy left: ok=%v %q", ok, said)
	}
}

func TestStartCannot(t *testing.T) {
	cases := []struct {
		state    string
		signedIn bool
		want     string
	}{
		{TaskReady, true, ""},
		{TaskRunning, true, ""},
		{TaskAbsent, true, "cannot: no admin path on this machine"},
		{TaskAbsent, false, "cannot: no admin path on this machine"},
		{TaskReady, false, "cannot: nobody is signed in on this machine — the admin task runs only while the owner is signed in"},
	}
	for _, c := range cases {
		if got := StartCannot(c.state, c.signedIn); got != c.want {
			t.Errorf("%s signedIn=%v: %q, want %q", c.state, c.signedIn, got, c.want)
		}
	}
	if got := StartCannot(TaskDisabled, true); !strings.Contains(got, "disabled") || !strings.Contains(got, TaskPath) || !strings.HasPrefix(got, "cannot: ") {
		t.Errorf("disabled: %q", got)
	}
}

func TestCopyLocationIsUnderProgramFiles(t *testing.T) {
	for _, pf := range []string{`C:\Program Files`, `C:\Program Files\`} {
		if got := CopyDirOf(pf); got != `C:\Program Files\Nova\Admin` {
			t.Errorf("CopyDirOf(%q) = %q", pf, got)
		}
		if got := CopyExeOf(pf); got != `C:\Program Files\Nova\Admin\`+CopyName {
			t.Errorf("CopyExeOf(%q) = %q", pf, got)
		}
	}
}

func TestCopyDirSDDLAdmitsOnlySystemAndAdministrators(t *testing.T) {
	if got, want := CopyDirSDDL(), "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"; got != want {
		t.Errorf("CopyDirSDDL = %q, want %q", got, want)
	}
}

func TestCopyDirVerdict(t *testing.T) {
	good := func() DirSecurity {
		return DirSecurity{Owner: SIDAdministrators, Protected: true, Allowed: []string{SIDSystem, SIDAdministrators}}
	}
	if ok, said := CopyDirVerdict(good()); !ok {
		t.Fatalf("the built ACL refused: %s", said)
	}
	cases := map[string]func(*DirSecurity){
		ownerSID:               func(d *DirSecurity) { d.Allowed = append(d.Allowed, ownerSID) }, // the owner unelevated could write it
		"S-1-5-32-545":         func(d *DirSecurity) { d.Allowed = append(d.Allowed, "S-1-5-32-545") },
		"inherit":              func(d *DirSecurity) { d.Protected = false },
		"owned by " + ownerSID: func(d *DirSecurity) { d.Owner = ownerSID },
		"deny":                 func(d *DirSecurity) { d.Denied = []string{"S-1-1-0"} },
		"admits no one":        func(d *DirSecurity) { d.Allowed = nil },
	}
	for name, mut := range cases {
		d := good()
		mut(&d)
		ok, said := CopyDirVerdict(d)
		if ok || !strings.Contains(said, name) {
			t.Errorf("%+v: ok=%v said %q, want refused naming %q", d, ok, said, name)
		}
	}
}

func TestCopyVerdict(t *testing.T) {
	src := FileDigest{Size: 10, SHA256: strings.Repeat("a", 64)}
	if ok, said := CopyVerdict(src, src); !ok || !strings.Contains(said, src.SHA256) {
		t.Errorf("equal: ok=%v %q, want ok naming the sha256", ok, said)
	}
	if ok, said := CopyVerdict(src, FileDigest{Size: 9, SHA256: src.SHA256}); ok || !strings.Contains(said, "size") {
		t.Errorf("size: ok=%v %q", ok, said)
	}
	if ok, said := CopyVerdict(src, FileDigest{Size: 10, SHA256: strings.Repeat("b", 64)}); ok || !strings.Contains(said, "sha256") || !strings.Contains(said, "protected copy") {
		t.Errorf("sha256: ok=%v %q", ok, said)
	}
	if ok, _ := CopyVerdict(FileDigest{}, FileDigest{}); ok {
		t.Error("two empty digests: ok, want refused (nothing was read)")
	}
}

func TestSameExeFoldsCaseOnly(t *testing.T) {
	if !SameExe(`C:\Program Files\Nova\Admin\novad.exe`, `c:\program files\nova\admin\NOVAD.EXE`) {
		t.Error("case-folded paths differ")
	}
	for _, b := range []string{`C:\Program Files\Nova\Admin\novad.exe.old`, `C:\Program Files\Nova\novad.exe`, "", `C:\Program Files\Nova\Admin\novad.exe `} {
		if SameExe(`C:\Program Files\Nova\Admin\novad.exe`, b) {
			t.Errorf("%q read as the copy", b)
		}
	}
}
