package admin

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf16"
)

// The Windows admin path (S30b T2, owner decision 2026-10-11): an elevated
// scheduled task registered once by `novad admin install` (the owner's one
// UAC click), for his own account, run level highest, interactive token (it
// runs only while he is signed in; no stored password). Its action is
// `<the protected copy> admin run-queued` (copy.go), which drains the request directory.
const (
	TaskFolder = `\Nova`
	TaskName   = "NovaAdmin"
	TaskPath   = `\Nova\NovaAdmin`
	// RunQueuedArgs is the task action's arguments.
	RunQueuedArgs = "admin run-queued"

	SIDSystem         = "S-1-5-18"
	SIDAdministrators = "S-1-5-32-544"
)

// What Scheduler.Query reports of the task.
const (
	TaskRunning  = "running"
	TaskReady    = "ready"
	TaskDisabled = "disabled"
	TaskAbsent   = "absent"
)

// Scheduler is every Task Scheduler call the glue makes (the seam; the
// Windows implementation is task_windows.go).
type Scheduler interface {
	Register(ctx context.Context, xmlFile []byte) error // create or replace
	Run(ctx context.Context) error
	End(ctx context.Context) error
	Delete(ctx context.Context) error
	// Query answers the task's state (TaskAbsent when it does not exist,
	// with a nil read-back and no error) and its definition as read.
	Query(ctx context.Context) (string, *TaskReadBack, error)
}

// DirACL sets and reads the request directory's security (the seam).
type DirACL interface {
	// Create makes dir with the descriptor sddl in one call (exclusive:
	// an existing path is an error wrapping fs.ErrExist).
	Create(dir, sddl string) error
	// Apply re-sets an existing dir's owner and protected DACL.
	Apply(dir, sddl string) error
	Read(dir string) (DirSecurity, error)
}

// DirSecurity is the request directory's security as read back.
type DirSecurity struct {
	Owner     string   // owner SID
	Protected bool     // SE_DACL_PROTECTED: nothing inherited
	Allowed   []string // SIDs of every allow ACE
	Denied    []string // SIDs of every deny ACE
}

// ValidSID reports whether s is a SID string: S-1-<n>(-<n>)+, digits only.
func ValidSID(s string) bool {
	return sidRe.MatchString(s)
}

var (
	sidRe       = regexp.MustCompile(`^S-1-[0-9]+(-[0-9]+)+$`)
	driveAbsRe  = regexp.MustCompile(`^[A-Za-z]:\\`)
	errBadSID   = errors.New("not a SID (S-1-<n>-<n>...)")
	xmlDeclUTF8 = `<?xml version="1.0" encoding="UTF-8"?>`
	xmlDecl16   = `<?xml version="1.0" encoding="UTF-16"?>`
)

// RequestDir is <programData>\NovaAdmin: directly under ProgramData, whose
// own ACL lets a standard user create a folder but never delete or rename
// one he does not own — so no user-creatable parent sits between them.
func RequestDir(programData string) string {
	return strings.TrimRight(programData, `\`) + `\NovaAdmin`
}

// RequestDirSDDL is the request directory's descriptor: owner
// Administrators, a protected DACL granting full control (inherited by
// files) to SYSTEM, Administrators and sid only. A malformed sid is an
// error and "".
func RequestDirSDDL(sid string) (string, error) {
	if !ValidSID(sid) {
		return "", fmt.Errorf("request directory for %q: %w", sid, errBadSID)
	}
	return "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + sid + ")", nil
}

// TaskSDDL is the task's own descriptor: full control to SYSTEM and
// Administrators, read+execute (run it, not change it) to sid.
func TaskSDDL(sid string) (string, error) {
	if !ValidSID(sid) {
		return "", fmt.Errorf("task descriptor for %q: %w", sid, errBadSID)
	}
	return "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;" + sid + ")", nil
}

// TaskDefinition is what the task is built from: the owner's SID (read from
// the installing token, never a name someone typed) and the protected
// copy's absolute path (CopyExeOf) — never the agent's own executable.
type TaskDefinition struct {
	SID    string
	Binary string
}

// TaskXML is the Task Scheduler XML for def: principal UserId = SID,
// LogonType InteractiveToken, RunLevel HighestAvailable; settings
// MultipleInstancesPolicy Parallel (claims are by rename, so two runners
// never run one request), AllowStartOnDemand, no battery stop, an
// ExecutionTimeLimit of PT25H (past MaxTimeout); no triggers (on demand
// only); one Exec action Command = Binary, Arguments = RunQueuedArgs; the
// RegistrationInfo SecurityDescriptor = TaskSDDL. Text is XML-escaped. A
// malformed SID, a Binary that is not a drive-absolute path (C:\…) or one
// carrying a quote or control character is an error.
func TaskXML(def TaskDefinition) (string, error) {
	sd, err := TaskSDDL(def.SID)
	if err != nil {
		return "", err
	}
	if !driveAbsRe.MatchString(def.Binary) {
		return "", fmt.Errorf("the task's program %q is not a drive-absolute path (C:\\...)", def.Binary)
	}
	for _, r := range def.Binary {
		if r == '"' || r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("the task's program %q carries a quote or a control character", def.Binary)
		}
	}
	esc := func(s string) string {
		var b strings.Builder
		_ = xml.EscapeText(&b, []byte(s))
		return b.String()
	}
	return xmlDeclUTF8 + `
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Nova's admin path: runs the requests the Nova agent leaves in its request directory, elevated, as the owner. On demand only.</Description>
    <URI>` + TaskPath + `</URI>
    <SecurityDescriptor>` + sd + `</SecurityDescriptor>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>` + def.SID + `</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT25H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + esc(def.Binary) + `</Command>
      <Arguments>` + RunQueuedArgs + `</Arguments>
    </Exec>
  </Actions>
</Task>
`, nil
}

// TaskXMLFile is TaskXML as schtasks /create /xml reads it: UTF-16LE with a
// BOM and encoding="UTF-16" in the declaration.
func TaskXMLFile(def TaskDefinition) ([]byte, error) {
	doc, err := TaskXML(def)
	if err != nil {
		return nil, err
	}
	doc = xmlDecl16 + strings.TrimPrefix(doc, xmlDeclUTF8)
	u := utf16.Encode([]rune(doc))
	b := make([]byte, 2+2*len(u))
	b[0], b[1] = 0xFF, 0xFE
	for i, c := range u {
		binary.LittleEndian.PutUint16(b[2+2*i:], c)
	}
	return b, nil
}

// TaskReadBack is the task definition as read back (schtasks /query /xml).
type TaskReadBack struct {
	UserID            string
	LogonType         string
	RunLevel          string
	Command           string
	Arguments         string
	MultipleInstances string
}

// ParseTaskXML reads a task definition, UTF-8 or UTF-16LE with a BOM.
func ParseTaskXML(b []byte) (TaskReadBack, error) {
	switch {
	case len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE:
		if len(b)%2 != 0 {
			return TaskReadBack{}, errors.New("task XML: odd UTF-16 length")
		}
		u := make([]uint16, (len(b)-2)/2)
		for i := range u {
			u[i] = binary.LittleEndian.Uint16(b[2+2*i:])
		}
		b = []byte(string(utf16.Decode(u)))
	case bytes.HasPrefix(b, []byte{0xEF, 0xBB, 0xBF}):
		b = b[3:]
	}
	var t struct {
		XMLName    xml.Name
		Principals struct {
			Principal struct {
				UserID    string `xml:"UserId"`
				LogonType string
				RunLevel  string
			}
		}
		Settings struct {
			MultipleInstancesPolicy string
		}
		Actions struct {
			Exec struct {
				Command   string
				Arguments string
			}
		}
	}
	d := xml.NewDecoder(bytes.NewReader(b))
	// The bytes are UTF-8 by now, whatever the declaration says.
	d.CharsetReader = func(_ string, r io.Reader) (io.Reader, error) { return r, nil }
	if err := d.Decode(&t); err != nil {
		return TaskReadBack{}, fmt.Errorf("task XML: %w", err)
	}
	if t.XMLName.Local != "Task" {
		return TaskReadBack{}, fmt.Errorf("task XML: root <%s>, not <Task>", t.XMLName.Local)
	}
	p := t.Principals.Principal
	return TaskReadBack{
		UserID: strings.TrimSpace(p.UserID), LogonType: strings.TrimSpace(p.LogonType), RunLevel: strings.TrimSpace(p.RunLevel),
		Command: strings.TrimSpace(t.Actions.Exec.Command), Arguments: strings.TrimSpace(t.Actions.Exec.Arguments),
		MultipleInstances: strings.TrimSpace(t.Settings.MultipleInstancesPolicy),
	}, nil
}

// SchtasksArgs is schtasks.exe's argv (after the program) for op on the
// task at path (TaskPath in production): create (/create /tn <path> /xml
// <xmlPath> /f), run (/run /tn), end (/end /tn), delete (/delete /tn <path>
// /f), query (/query /tn <path> /xml). An unknown op is nil.
func SchtasksArgs(op, path, xmlPath string) []string {
	switch op {
	case "create":
		return []string{"/create", "/tn", path, "/xml", xmlPath, "/f"}
	case "run":
		return []string{"/run", "/tn", path}
	case "end":
		return []string{"/end", "/tn", path}
	case "delete":
		return []string{"/delete", "/tn", path, "/f"}
	case "query":
		return []string{"/query", "/tn", path, "/xml"}
	}
	return nil
}

// InstallState is what install/uninstall read before acting. Self is true
// when this process is the task's own running instance (an uninstall
// through the path): it must not end itself.
type InstallState struct {
	TaskPresent bool
	TaskRunning bool
	DirPresent  bool
	CopyPresent bool // the protected copy's directory
	Self        bool
}

// The steps install/uninstall run, in order.
const (
	StepEndTask      = "end_task"
	StepSecureDir    = "secure_dir"
	StepClearDir     = "clear_dir"
	StepCopyBinary   = "copy_binary"
	StepRegisterTask = "register_task"
	StepProve        = "prove"
	StepDeleteTask   = "delete_task"
	StepRemoveDir    = "remove_dir"
	StepRemoveCopy   = "remove_copy"
	StepReadBack     = "read_back"
)

// PlanInstall: end a running task first (unless Self); secure the request
// directory (DirAction) and clear it; put and verify the protected copy;
// register (create or replace) against that copy and prove.
func PlanInstall(s InstallState) []string {
	var steps []string
	if s.TaskRunning && !s.Self {
		steps = append(steps, StepEndTask)
	}
	return append(steps, StepSecureDir, StepClearDir, StepCopyBinary, StepRegisterTask, StepProve)
}

// PlanUninstall: end a running task (unless Self), delete a present task,
// remove a present request directory and protected copy, then read back;
// nothing installed = no steps.
func PlanUninstall(s InstallState) []string {
	if !s.TaskPresent && !s.DirPresent && !s.CopyPresent {
		return nil
	}
	var steps []string
	if s.TaskRunning && !s.Self {
		steps = append(steps, StepEndTask)
	}
	if s.TaskPresent {
		steps = append(steps, StepDeleteTask)
	}
	if s.DirPresent {
		steps = append(steps, StepRemoveDir)
	}
	if s.CopyPresent {
		steps = append(steps, StepRemoveCopy)
	}
	return append(steps, StepReadBack)
}

// DirVerdict: ok only for a protected DACL with no deny entries whose allow
// entries are exactly within {SYSTEM, Administrators, sid} and include sid,
// owned by one of those three; else false naming what was read.
func DirVerdict(d DirSecurity, sid string) (bool, string) {
	admitted := map[string]bool{SIDSystem: true, SIDAdministrators: true, sid: true}
	var bad []string
	if !d.Protected {
		bad = append(bad, "its DACL is not protected: it can inherit entries from its parent")
	}
	if !admitted[d.Owner] {
		bad = append(bad, "it is owned by "+d.Owner)
	}
	for _, a := range d.Allowed {
		if !admitted[a] {
			bad = append(bad, "it allows "+a)
		}
	}
	if len(d.Denied) > 0 {
		bad = append(bad, "it carries deny entries for "+strings.Join(d.Denied, ", "))
	}
	has := false
	for _, a := range d.Allowed {
		has = has || a == sid
	}
	if !has {
		bad = append(bad, "it does not allow the owner "+sid)
	}
	if len(bad) > 0 {
		return false, "the request directory's security is not as built: " + strings.Join(bad, "; ")
	}
	return true, "the request directory admits only SYSTEM, Administrators and " + sid
}

// InstallReadBack is everything install's proof reads.
type InstallReadBack struct {
	Want       TaskDefinition
	Task       *TaskReadBack // nil: the task is absent
	Dir        *DirSecurity  // nil: the request directory is absent
	Whoami     *TaskResult   // nil: the round trip produced no result
	WhoamiSaid string        // why, when Whoami is nil
}

// InstallVerdict is ok only when the task reads back as built (UserId =
// Want.SID, InteractiveToken, HighestAvailable, Command = Want.Binary,
// Arguments = RunQueuedArgs), DirVerdict is ok, and the whoami round trip
// through the task answered ok, exit 0, with a report saying elevated true
// for Want.SID. Its words say the token is elevated; a failure names what
// was read.
func InstallVerdict(rb InstallReadBack) (bool, string) {
	var bad []string
	if t := rb.Task; t == nil {
		bad = append(bad, "the task "+TaskPath+" is absent")
	} else {
		field := func(name, got, want string) {
			if got != want {
				bad = append(bad, fmt.Sprintf("the task's %s reads %s, not %s", name, got, want))
			}
		}
		field("user", t.UserID, rb.Want.SID)
		field("logon type", t.LogonType, "InteractiveToken")
		field("run level", t.RunLevel, "HighestAvailable")
		field("program", t.Command, rb.Want.Binary)
		field("arguments", t.Arguments, RunQueuedArgs)
	}
	if rb.Dir == nil {
		bad = append(bad, "the request directory is absent")
	} else if ok, said := DirVerdict(*rb.Dir, rb.Want.SID); !ok {
		bad = append(bad, said)
	}
	var who WhoamiReport
	switch w := rb.Whoami; {
	case w == nil:
		bad = append(bad, "no elevated round trip: "+rb.WhoamiSaid)
	case !w.OK || w.ExitCode != 0:
		bad = append(bad, fmt.Sprintf("the whoami round trip through the task ended exit %d: %s", w.ExitCode, strings.TrimSpace(w.Said+" "+w.Stderr)))
	default:
		r, err := ParseWhoami(w.Stdout)
		switch {
		case err != nil:
			bad = append(bad, err.Error())
		case !r.Elevated:
			bad = append(bad, "the task ran whoami as "+r.User+", not elevated")
		case r.SID != rb.Want.SID:
			bad = append(bad, fmt.Sprintf("the task ran whoami as %s, not the owner %s", r.SID, rb.Want.SID))
		default:
			who = r
		}
	}
	if len(bad) > 0 {
		return false, "the admin path did not prove itself: " + strings.Join(bad, "; ")
	}
	return true, fmt.Sprintf("the admin task %s is installed: it ran whoami as %s, elevated (integrity %s); the request directory admits only SYSTEM, Administrators and the owner",
		TaskPath, who.User, who.Integrity)
}

// UninstallVerdict is ok only when the task, the request directory and the
// protected copy are all gone; else false naming which is still there.
func UninstallVerdict(taskPresent, dirPresent, copyPresent bool) (bool, string) {
	var left []string
	if taskPresent {
		left = append(left, "the task "+TaskPath+" is still there")
	}
	if dirPresent {
		left = append(left, "the request directory is still there")
	}
	if copyPresent {
		left = append(left, "the protected copy is still there")
	}
	if len(left) > 0 {
		return false, "the admin path was not removed: " + strings.Join(left, "; ")
	}
	return true, "the admin task " + TaskPath + ", its request directory and the protected copy are gone"
}

// StartCannot is the stated cannot before a request is written, "" when the
// task can start: absent → "cannot: no admin path on this machine";
// disabled → names the task and "disabled"; nobody signed in → "cannot:
// nobody is signed in on this machine — the admin task runs only while the
// owner is signed in".
func StartCannot(taskState string, signedIn bool) string {
	switch {
	case taskState == TaskAbsent:
		return "cannot: no admin path on this machine"
	case taskState == TaskDisabled:
		return "cannot: the admin task " + TaskPath + " is disabled"
	case !signedIn:
		return "cannot: nobody is signed in on this machine — the admin task runs only while the owner is signed in"
	}
	return ""
}

// QueryAbsent reports whether schtasks' failed /query output says the task
// (or its folder) does not exist. Any other failure is an error to state,
// never read as absent.
func QueryAbsent(output string) bool {
	return strings.Contains(strings.ToLower(output), "cannot find the")
}

// TaskStateOf maps the Status column of `schtasks /query /fo csv /nh` to a
// task state. A status it does not know is an error naming it — never a
// guess.
func TaskStateOf(csvLine string) (string, error) {
	fields := strings.Split(strings.TrimSpace(csvLine), `","`)
	status := strings.Trim(fields[len(fields)-1], `"`)
	switch status {
	case "Ready":
		return TaskReady, nil
	case "Running", "Queued":
		return TaskRunning, nil
	case "Disabled":
		return TaskDisabled, nil
	}
	return "", fmt.Errorf("schtasks reports the task's status as %q, which this agent does not read", status)
}
