package facts

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"novad/internal/platform"
	"novad/internal/service"
)

// Self is what only the running agent knows about itself: its binary and
// its config file (main passes them through client.Options).
type Self struct {
	Binary string
	Config string
}

// Service is how THIS agent runs (S42b P29): the name its service manager
// knows it by ("" when it was started by hand), its files, its process and
// the account it runs as — read, never assumed.
type Service struct {
	Name          string `json:"name"`
	Binary        string `json:"binary"`
	Config        string `json:"config"`
	Process       string `json:"process"`
	PID           int    `json:"pid"`
	SupervisorPID int    `json:"supervisor_pid"`
	User          string `json:"user"`
}

// Elevation is what elevating from this agent would meet.
type Elevation struct {
	Elevated bool   `json:"elevated"`
	Admin    *bool  `json:"admin,omitempty"`
	Sudo     string `json:"sudo"`
	SudoSaid string `json:"sudo_said,omitempty"`
}

// WSLDistros are the WSL distributions beside a Windows agent.
// RunningSaid is wsl.exe's own words when its running-list failed.
type WSLDistros struct {
	Distros     []Distro `json:"distros"`
	RunningSaid string   `json:"running_said,omitempty"`

	outOfTime bool // a wsl.exe was cut by its bound (Probed.OutOfTime)
}

// Distro is one distribution. Looked is false for one that is not running:
// looking inside would start it.
type Distro struct {
	Name    string `json:"name"`
	Default bool   `json:"default"`
	Version int    `json:"version"`
	Running bool   `json:"running"`
	Looked  bool   `json:"looked"`
	PID1    string `json:"pid1,omitempty"`
	User    string `json:"user,omitempty"`
	Sudo    string `json:"sudo,omitempty"`
	// SudoSaid is sudo's own first line there when it refused.
	SudoSaid string `json:"sudo_said,omitempty"`
	Root     bool   `json:"root"`
	Unit     *Unit  `json:"novad_unit,omitempty"`
	// PIDs are its novad processes: [] only when none is known to run (it
	// is stopped, or a finished look found none); null — unknown — whenever
	// they could not be listed: the list or look failed, pgrep is missing.
	PIDs []int `json:"novad_pids"`
}

// Unit is the user unit novad.service inside a distribution.
type Unit struct {
	Active  string `json:"active"`
	File    string `json:"file"`
	Restart string `json:"restart"`
	MainPID int    `json:"main_pid"`
	Said    string `json:"said,omitempty"`
}

// Probed is one run of the probes and when it ran. OutOfTime says a
// program in it gave no answer in time, or had no time left to start: what
// it did not answer is said unreadable, and a reconnect probes again rather
// than keep it.
type Probed struct {
	At         time.Time
	Service    Service
	Elevation  *Elevation
	WSL        *WSLDistros
	Unreadable []Unreadable
	OutOfTime  bool
}

const (
	maxDistros   = 8 // keeps the frame far inside core's 16 KiB with the rest
	maxPIDs      = 8
	probeProgram = 10 * time.Second
)

// lookSudo are the words the look's sudo line prints. Anything else is left
// out, never sent: core drops the WHOLE frame over one field it refuses.
var lookSudo = map[string]bool{"no_password": true, "refused": true, "absent": true}

// readDistros is WSL's registry list; a variable so a test hands in its own.
var readDistros = platform.WSLDistros

// Probe runs the probes. The client runs it at connect and on facts.refresh
// only — never on the minute cadence: `sudo -n` can write an auth-log line
// each time, and wsl.exe is not free. Every program runs through r, bounded
// by ctx and by probeProgram whatever its kill does (platform.Elevation and
// platform.RunWSL run them through the platform's bounded helper).
func Probe(ctx context.Context, r platform.Runner, self Self) Probed {
	p := Probed{At: time.Now().UTC(), Service: serviceOf(platform.Mode(), self)}
	for _, f := range []struct{ item, path string }{{"service.binary", self.Binary}, {"service.config", self.Config}} {
		if why := unfit(f.path); why != "" {
			p.Unreadable = append(p.Unreadable, Unreadable{Item: f.item, Reason: why})
		}
	}
	ectx, cancel := context.WithTimeout(ctx, probeProgram)
	e, err := platform.Elevation(ectx, r)
	cancel()
	// What was read is kept whatever failed (fix round 2): Elevated is the
	// agent's own read (geteuid, its token). A sudo that gave no answer, or
	// never started, is "unknown" with the reason — never dropped, never a
	// guess; what else failed is said unreadable, and Admin stays nil.
	p.Elevation = &Elevation{Elevated: e.Elevated, Admin: e.Admin, Sudo: e.Sudo, SudoSaid: said(e.Said)}
	if err != nil {
		p.OutOfTime = platform.OutOfTime(err)
		p.Unreadable = append(p.Unreadable, Unreadable{Item: "elevation", Reason: failed(err)})
		if p.Elevation.Sudo == "" {
			p.Elevation.Sudo, p.Elevation.SudoSaid = "unknown", failed(err)
		}
	}
	if runtime.GOOS == "windows" {
		w, unread := probeWSL(ctx, r)
		p.WSL = w
		p.OutOfTime = p.OutOfTime || (w != nil && w.outOfTime)
		p.Unreadable = append(p.Unreadable, unread...)
	}
	return p
}

func serviceOf(mode string, self Self) Service {
	s := Service{Binary: whole(self.Binary), Config: whole(self.Config), PID: pidFact(os.Getpid())}
	if self.Binary != "" {
		s.Process = whole(filepath.Base(self.Binary))
	}
	switch mode {
	case service.ModeSystemd:
		s.Name = service.UnitName
	case service.ModeLaunch:
		s.Name = service.Label
	case service.ModeRunKey:
		s.Name = `HKCU\` + service.RunKeyPath + `\` + service.RunKeyValue
	}
	sup, _ := strconv.Atoi(os.Getenv(platform.SupervisorEnv))
	s.SupervisorPID = pidFact(sup)
	switch u, err := user.Current(); {
	case err == nil:
		s.User = line(u.Username)
	case os.Getenv("USER") != "":
		s.User = line(os.Getenv("USER"))
	default:
		s.User = line(os.Getenv("USERNAME"))
	}
	return s
}

// probeWSL lists the distributions and looks inside each RUNNING one —
// never a stopped one, which looking would start (Review Focus 11).
func probeWSL(ctx context.Context, r platform.Runner) (*WSLDistros, []Unreadable) {
	list, bad, err := readDistros()
	if err != nil {
		return nil, []Unreadable{{Item: "wsl_distros", Reason: said(err.Error())}}
	}
	var unread []Unreadable
	for _, e := range bad {
		unread = append(unread, Unreadable{Item: "wsl_distros", Reason: said(e.Error())})
	}
	out := &WSLDistros{Distros: []Distro{}}
	if len(list) == 0 {
		return out, unread
	}
	running, listErr := runningNow(ctx, r)
	if listErr != nil {
		// Nothing running and a real failure can look alike here: say the
		// words, and read nothing it printed as running — a wrong guess
		// would look inside, and so start, a stopped distribution.
		out.RunningSaid = failed(listErr)
		out.outOfTime = platform.OutOfTime(listErr)
	}
	for _, d := range list {
		if len(out.Distros) == maxDistros {
			unread = append(unread, Unreadable{Item: "wsl_distros", Reason: fmt.Sprintf("more than %d distributions; the rest are not listed", maxDistros)})
			break
		}
		// PIDs stay nil — null on the wire, unknown — unless it is known
		// that none runs: the distribution is stopped, or a finished look
		// found none (fix round 2). [] is never a guess.
		entry := Distro{Name: line(d.Name), Default: d.Default, Version: wslVersion(d.Version), Running: running[d.Name]}
		switch {
		case listErr != nil:
		case !entry.Running:
			entry.PIDs = []int{} // stopped: nothing runs there
		case lookIfStillRunning(ctx, r, d.Name, &entry, &unread):
			out.outOfTime = true
		}
		out.Distros = append(out.Distros, entry)
	}
	return out, unread
}

// runningNow is the distributions wsl.exe lists as running at this moment.
func runningNow(ctx context.Context, r platform.Runner) (map[string]bool, error) {
	lctx, cancel := context.WithTimeout(ctx, probeProgram)
	defer cancel()
	raw, err := platform.RunWSL(lctx, r, "--list", "--running", "--quiet")
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	for _, row := range strings.Split(raw, "\n") {
		if name := strings.TrimSpace(row); name != "" {
			names[name] = true
		}
	}
	return names, nil
}

// lookIfStillRunning lists what runs again just before the look (Review
// Focus 11): a distribution that stopped since the first list is never
// started by looking. It reports whether a wsl.exe was out of time.
func lookIfStillRunning(ctx context.Context, r platform.Runner, name string, d *Distro, unread *[]Unreadable) bool {
	running, err := runningNow(ctx, r)
	switch {
	case err != nil:
		*unread = append(*unread, Unreadable{Item: clip("wsl_distros." + d.Name),
			Reason: said("not looked inside: the running-list just before the look failed: " + failed(err))})
		return platform.OutOfTime(err)
	case !running[name]:
		d.Running, d.PIDs = false, []int{} // it stopped since the first list: nothing runs there
		return false
	}
	return look(ctx, r, name, d, unread)
}

// look runs the one look inside a running distribution, then whether
// `wsl.exe -u root` runs there without a password. A look that did not
// print its last line, pids=, is unreadable whatever wsl.exe's exit status:
// what it never printed is not read as "no unit" or "no novad process". It
// reports whether a wsl.exe was out of time before its answer was complete.
func look(ctx context.Context, r platform.Runner, name string, d *Distro, unread *[]Unreadable) bool {
	item := clip("wsl_distros." + d.Name)
	lctx, cancel := context.WithTimeout(ctx, probeProgram)
	raw, err := platform.RunWSL(lctx, r, "-d", name, "--exec", "/bin/sh", "-c", platform.WSLLookScript)
	cancel()
	if !lookFinished(raw) {
		reason := "the look printed no answer"
		if err != nil {
			reason = failed(err)
		}
		*unread = append(*unread, Unreadable{Item: item, Reason: reason})
		return platform.OutOfTime(err)
	}
	in := platform.ParseWSLInside(raw)
	d.Looked = true
	d.PID1, d.User = line(in.PID1), line(in.User)
	if lookSudo[in.Sudo] {
		d.Sudo = in.Sudo
		if in.Sudo == "refused" {
			d.SudoSaid = said(in.SudoSaid)
		}
	}
	if in.PIDsUnknown {
		*unread = append(*unread, Unreadable{Item: clip(item + ".novad_pids"),
			Reason: "its novad processes could not be listed: pgrep is missing there, or failed"})
	} else {
		d.PIDs = []int{}
	}
	for _, pid := range in.PIDs {
		if pidFact(pid) == 0 {
			continue
		}
		if len(d.PIDs) == maxPIDs {
			*unread = append(*unread, Unreadable{Item: clip(item + ".novad_pids"),
				Reason: fmt.Sprintf("more than %d novad processes; the rest are not listed", maxPIDs)})
			break
		}
		d.PIDs = append(d.PIDs, pid)
	}
	if in.UnitActive != "" || in.UnitSaid != "" {
		d.Unit = &Unit{Active: line(in.UnitActive), File: line(in.UnitFile), Restart: line(in.UnitRestart),
			MainPID: pidFact(in.UnitMainPID), Said: said(in.UnitSaid)}
	}
	rctx, rcancel := context.WithTimeout(ctx, probeProgram)
	_, rerr := platform.RunWSL(rctx, r, "-d", name, "-u", "root", "--exec", "/bin/true")
	rcancel()
	d.Root = rerr == nil
	if rerr != nil {
		*unread = append(*unread, Unreadable{Item: clip(item + ".root"), Reason: failed(rerr)})
	}
	return platform.OutOfTime(rerr)
}

// lookFinished is whether a look's output reached its last line, pids=.
func lookFinished(out string) bool {
	return strings.HasPrefix(out, "pids=") || strings.Contains(out, "\npids=")
}

// failed is why a program failed, as one line (S42b F3): that it never
// started — for want of time or of the program — that it gave no answer in
// time (platform.ErrNoAnswer, which claims no kill took), or its own words.
func failed(err error) string {
	var re *platform.RunError
	if errors.As(err, &re) && re.NotStarted {
		return said(re.Name + " did not start: " + re.Err.Error())
	}
	return said(err.Error())
}

// ApplyTo puts a probe's findings in a frame, with the time they were read.
func (p Probed) ApplyTo(f *Frame) {
	svc := p.Service
	f.Service = &svc
	f.Elevation = p.Elevation
	f.WSLDistros = p.WSL
	f.ProbedAt = p.At.UTC().Format(time.RFC3339)
	f.Unreadable = append(f.Unreadable, p.Unreadable...)
	*f = capUnreadable(*f)
}

// line is text read off the machine as core renders it inside a listing
// line: every character core refuses in a line collapsed (isControl), clipped
// to the cap.
func line(s string) string { return clip(collapseControl(s)) }

// said is what a program said — an error, a refusal — as the ONE line core
// renders into a listing line (S42b F3): what comes before its first CR or LF,
// with every other character core refuses in a line — the rest of the C0
// controls, DEL, the C1 controls, U+2028 and U+2029 (isControl) — collapsed
// to a space, clipped. Core refuses any of them, and one refused field drops
// the whole frame.
func said(s string) string {
	first := strings.TrimSpace(s)
	if i := strings.IndexAny(first, "\r\n"); i >= 0 {
		first = first[:i]
	}
	return line(first)
}

// unfit says why a path cannot be a fact whole — over core's cap, or not one
// line — or "" when it can. Task 7's ruling holds here too: such a path is
// left out and said unreadable, never clipped or collapsed into a path that
// is not the file.
func unfit(p string) string {
	switch {
	case len(p) > maxText:
		return fmt.Sprintf("path is %d bytes, over the %d limit", len(p), maxText)
	case strings.ContainsFunc(p, isControl):
		return "path contains a control character or a line separator"
	}
	return ""
}

// whole is p when it fits, else "" (Probe says why).
func whole(p string) string {
	if unfit(p) != "" {
		return ""
	}
	return p
}

// pidFact is a pid core can hold, or 0: core refuses any number past
// 2^31-1 — and with it the whole frame.
func pidFact(n int) int {
	if n < 0 || n > math.MaxInt32 {
		return 0
	}
	return n
}

// wslVersion is 1 or 2, or 0 ("unknown") for anything else the registry
// said: core holds no version past 2, and refuses the frame over one.
func wslVersion(v int) int {
	if v == 1 || v == 2 {
		return v
	}
	return 0
}
