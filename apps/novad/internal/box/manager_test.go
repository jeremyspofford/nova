package box

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const tHash = "0123456789abcdef0123456789abcdef01234567"

var tTag = "nova-devbox:t-" + tHash

type fakeCtr struct{ state, image string }

// fakeDocker models just enough of docker to answer the Manager: images,
// containers (name -> state/image), networks and volumes. Every argv is
// recorded; fail injects a docker refusal or a spawn error.
type fakeDocker struct {
	images   map[string]bool
	ctrs     map[string]*fakeCtr
	nets     map[string]bool
	vols     map[string]bool
	calls    [][]string
	fail     func(argv []string) bool
	spawnErr bool

	// T8: the image's labels, each cache volume's marker file, and what
	// every fetch container was given (its argv and the files in /src).
	labels     map[string]string
	markers    map[string]string
	fetches    []fetchRec
	fetchOut   string
	fetchExit  int
	fetchSpawn bool
}

type fetchRec struct {
	argv  []string
	src   string
	files map[string]string
}

// vols are the -v values of an argv.
func vols(argv []string) []string {
	var out []string
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == "-v" {
			out = append(out, argv[i+1])
		}
	}
	return out
}

func (f *fakeDocker) runRm(argv []string) (string, int, error) {
	var src, vol string
	for _, v := range vols(argv) {
		parts := strings.Split(v, ":")
		if parts[1] == "/src" {
			src = parts[0]
		}
		if parts[1] == DepsMount {
			vol = parts[0]
		}
	}
	if flagVal(argv, "--network") == "none" {
		return f.markers[vol], 0, nil
	}
	rec := fetchRec{argv: append([]string(nil), argv...), src: src, files: map[string]string{}}
	_ = filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := os.ReadFile(p)
			rel, _ := filepath.Rel(src, p)
			rec.files[filepath.ToSlash(rel)] = string(b)
		}
		return nil
	})
	f.fetches = append(f.fetches, rec)
	if f.fetchSpawn {
		return "", -1, errors.New("exec: \"docker\": executable file not found in $PATH")
	}
	if f.fetchExit != 0 {
		return f.fetchOut, f.fetchExit, nil
	}
	if f.markers == nil {
		f.markers = map[string]string{}
	}
	f.markers[vol] = rec.files[".nova-locks"]
	return f.fetchOut, 0, nil
}

func newFake() *fakeDocker {
	return &fakeDocker{
		images: map[string]bool{tTag: true},
		ctrs:   map[string]*fakeCtr{},
		nets:   map[string]bool{},
		vols:   map[string]bool{},
	}
}

func flagVal(argv []string, flag string) string {
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == flag {
			return argv[i+1]
		}
	}
	return ""
}

func (f *fakeDocker) Run(_ context.Context, argv []string) (string, int, error) {
	f.calls = append(f.calls, append([]string(nil), argv...))
	if f.fail != nil && f.fail(argv) {
		if f.spawnErr {
			return "", -1, errors.New("exec: \"docker\": executable file not found in $PATH")
		}
		return "Error response from daemon: boom at " + strings.Join(argv[:2], " ") + "\n", 1, nil
	}
	j := strings.Join(argv, " ")
	switch {
	case strings.HasPrefix(j, "image inspect --format {{json .Config.Labels}} "):
		if !f.images[argv[len(argv)-1]] {
			return "Error: No such image: " + argv[len(argv)-1], 1, nil
		}
		b, _ := json.Marshal(f.labels)
		return string(b) + "\n", 0, nil
	case len(argv) > 1 && argv[0] == "run" && argv[1] == "--rm":
		return f.runRm(argv)
	case strings.HasPrefix(j, "image ls -q "):
		if f.images[argv[len(argv)-1]] {
			return "sha256:feedface\n", 0, nil
		}
		return "", 0, nil
	case strings.HasPrefix(j, "ps -a --filter label="+Label+" --format "):
		var b strings.Builder
		for n, c := range f.ctrs {
			b.WriteString(n + "\t" + c.state + "\t" + c.image + "\n")
		}
		return b.String(), 0, nil
	case strings.HasPrefix(j, "network ls -q --filter name="):
		name := strings.TrimSuffix(strings.TrimPrefix(argv[len(argv)-1], "name=^"), "$")
		if f.nets[name] {
			return "netid\n", 0, nil
		}
		return "", 0, nil
	case strings.HasPrefix(j, "volume ls -q --filter name="):
		name := strings.TrimSuffix(strings.TrimPrefix(argv[len(argv)-1], "name=^"), "$")
		if f.vols[name] {
			return name + "\n", 0, nil
		}
		return "", 0, nil
	case strings.HasPrefix(j, "network create "):
		f.nets[argv[len(argv)-1]] = true
		return "netid\n", 0, nil
	case strings.HasPrefix(j, "volume create "):
		f.vols[argv[len(argv)-1]] = true
		return argv[len(argv)-1] + "\n", 0, nil
	case strings.HasPrefix(j, "run -d "):
		name := flagVal(argv, "--name")
		img := PostgresImage
		if !strings.HasSuffix(name, "-db") {
			img = argv[len(argv)-3]
		}
		f.ctrs[name] = &fakeCtr{"running", img}
		return "ctrid\n", 0, nil
	case argv[0] == "start":
		for _, n := range argv[1:] {
			f.ctrs[n].state = "running"
		}
		return "", 0, nil
	case argv[0] == "stop":
		for _, n := range argv[1:] {
			f.ctrs[n].state = "exited"
		}
		return "", 0, nil
	case argv[0] == "rm":
		for _, n := range argv[2:] {
			delete(f.ctrs, n)
		}
		return "", 0, nil
	case strings.HasPrefix(j, "network rm "):
		delete(f.nets, argv[2])
		return "", 0, nil
	case strings.HasPrefix(j, "volume rm "):
		delete(f.vols, argv[2])
		delete(f.markers, argv[2])
		return "", 0, nil
	}
	return "unknown command " + j, 125, nil
}

// verbs are the mutating calls (everything but listings), as "verb name".
func (f *fakeDocker) mutations() []string {
	var out []string
	for _, a := range f.calls {
		j := strings.Join(a, " ")
		switch {
		case strings.HasPrefix(j, "network create"), strings.HasPrefix(j, "volume create"),
			strings.HasPrefix(j, "network rm"), strings.HasPrefix(j, "volume rm"):
			out = append(out, a[0]+" "+a[1]+" "+a[len(a)-1])
		case a[0] == "run":
			out = append(out, "run "+flagVal(a, "--name"))
		case a[0] == "start", a[0] == "rm":
			out = append(out, j)
		}
	}
	return out
}

type fakeGit struct {
	out   string
	exit  int
	err   error
	calls [][]string
}

func (g *fakeGit) Run(_ context.Context, argv []string) (string, int, error) {
	g.calls = append(g.calls, append([]string(nil), argv...))
	return g.out, g.exit, g.err
}

var tNow = time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)

func newManager(d *fakeDocker) (*Manager, *fakeGit) {
	g := &fakeGit{out: tHash + "\n"}
	return &Manager{Docker: d, Git: g, Now: func() time.Time { return tNow }, UID: 1000, GID: 1001}, g
}

func boxReq(change string) Request {
	r := goodRequest()
	r.Change = change
	r.Cwd = Worktree(r.Checkout, change)
	return r
}

// C1
func TestImageTagIsMainsDevboxTreeHash(t *testing.T) {
	m, g := newManager(newFake())
	tag, err := m.ImageTag(context.Background(), tCheckout, "main")
	if err != nil {
		t.Fatal(err)
	}
	if tag != tTag {
		t.Fatalf("tag = %q, want %q", tag, tTag)
	}
	want := []string{"-C", tCheckout, "rev-parse", "main:deploy/devbox"}
	if !reflect.DeepEqual(g.calls, [][]string{want}) {
		t.Fatalf("git calls = %q, want %q", g.calls, want)
	}
}

// C1
func TestImageTagRefusesWhatGitDidNotSay(t *testing.T) {
	for name, g := range map[string]*fakeGit{
		"exit":      {out: "fatal: path 'deploy/devbox' does not exist in 'main'\n", exit: 128},
		"spawn":     {err: errors.New("exec: \"git\": not found")},
		"not-hash":  {out: "main\n"},
		"empty":     {out: ""},
		"short-hex": {out: "abc123\n"},
	} {
		m, _ := newManager(newFake())
		m.Git = g
		tag, err := m.ImageTag(context.Background(), tCheckout, "main")
		if err == nil || tag != "" {
			t.Fatalf("%s: tag %q err %v, want an error and no tag", name, tag, err)
		}
		if name == "exit" && (!strings.Contains(err.Error(), "does not exist in 'main'") || !strings.Contains(err.Error(), "exit 128")) {
			t.Fatalf("%s: error %q does not quote git", name, err)
		}
	}
}

// C2
func TestEnsureColdStartsNetThenDBThenBox(t *testing.T) {
	d := newFake()
	m, _ := newManager(d)
	st, err := m.Ensure(context.Background(), goodRequest())
	if err != nil {
		t.Fatal(err)
	}
	n := Names(tChange)
	want := State{Box: n.Box, Status: "running", Image: tTag}
	if st != want {
		t.Fatalf("state = %+v, want %+v", st, want)
	}
	gotMut := d.mutations()
	wantMut := []string{"network create " + n.Net, "volume create " + n.Cache, "run " + n.DB, "run " + n.Box}
	if !reflect.DeepEqual(gotMut, wantMut) {
		t.Fatalf("mutations = %q, want %q", gotMut, wantMut)
	}
	// The image is checked before anything is made.
	if !strings.HasPrefix(strings.Join(d.calls[0], " "), "image ls -q "+tTag) {
		t.Fatalf("first call %q, want the image check", d.calls[0])
	}
	var netArgv, dbArgv, boxArgv, volArgv []string
	for _, a := range d.calls {
		switch {
		case a[0] == "network" && a[1] == "create":
			netArgv = a
		case a[0] == "volume" && a[1] == "create":
			volArgv = a
		case a[0] == "run" && flagVal(a, "--name") == n.DB:
			dbArgv = a
		case a[0] == "run" && flagVal(a, "--name") == n.Box:
			boxArgv = a
		}
	}
	if !reflect.DeepEqual(netArgv, NetworkArgs(tChange)) {
		t.Fatalf("network argv %q", netArgv)
	}
	if !reflect.DeepEqual(dbArgv, DBArgs(tChange)) {
		t.Fatalf("db argv %q", dbArgv)
	}
	if !reflect.DeepEqual(boxArgv, BoxArgs(goodRequest(), tTag, 1000, 1001)) {
		t.Fatalf("box argv %q", boxArgv)
	}
	wantVol := []string{"volume", "create", "--label", Label + "=" + tChange, n.Cache}
	if !reflect.DeepEqual(volArgv, wantVol) {
		t.Fatalf("volume argv %q, want %q", volArgv, wantVol)
	}
}

// C3
func TestEnsureOnARunningBoxIsANoOp(t *testing.T) {
	d := newFake()
	n := Names(tChange)
	d.nets[n.Net], d.vols[n.Cache] = true, true
	d.ctrs[n.Box] = &fakeCtr{"running", tTag}
	d.ctrs[n.DB] = &fakeCtr{"running", PostgresImage}
	m, _ := newManager(d)
	st, err := m.Ensure(context.Background(), goodRequest())
	if err != nil {
		t.Fatal(err)
	}
	if st.Status != "running" || st.Box != n.Box || st.Image != tTag {
		t.Fatalf("state %+v", st)
	}
	if mut := d.mutations(); len(mut) != 0 {
		t.Fatalf("warm Ensure mutated: %q", mut)
	}
}

// C3
func TestEnsureStartsAStoppedBoxAndDB(t *testing.T) {
	d := newFake()
	n := Names(tChange)
	d.nets[n.Net], d.vols[n.Cache] = true, true
	d.ctrs[n.Box] = &fakeCtr{"exited", tTag}
	d.ctrs[n.DB] = &fakeCtr{"exited", PostgresImage}
	m, _ := newManager(d)
	st, err := m.Ensure(context.Background(), goodRequest())
	if err != nil {
		t.Fatal(err)
	}
	if st.Status != "running" {
		t.Fatalf("state %+v", st)
	}
	want := []string{"start " + n.DB, "start " + n.Box}
	if got := d.mutations(); !reflect.DeepEqual(got, want) {
		t.Fatalf("mutations = %q, want %q", got, want)
	}
}

// C3: a stopped box whose network went missing gets it back before it starts.
func TestEnsureRestoresAMissingNetworkBeforeStarting(t *testing.T) {
	d := newFake()
	n := Names(tChange)
	d.vols[n.Cache] = true
	d.ctrs[n.Box] = &fakeCtr{"exited", tTag}
	d.ctrs[n.DB] = &fakeCtr{"exited", PostgresImage}
	m, _ := newManager(d)
	if _, err := m.Ensure(context.Background(), goodRequest()); err != nil {
		t.Fatal(err)
	}
	want := []string{"network create " + n.Net, "start " + n.DB, "start " + n.Box}
	if got := d.mutations(); !reflect.DeepEqual(got, want) {
		t.Fatalf("mutations = %q, want %q", got, want)
	}
}

// C3: a running box whose db stopped gets the db (and its network) back.
func TestEnsureRestartsTheDBUnderARunningBox(t *testing.T) {
	d := newFake()
	n := Names(tChange)
	d.vols[n.Cache] = true
	d.ctrs[n.Box] = &fakeCtr{"running", tTag}
	d.ctrs[n.DB] = &fakeCtr{"exited", PostgresImage}
	m, _ := newManager(d)
	if _, err := m.Ensure(context.Background(), goodRequest()); err != nil {
		t.Fatal(err)
	}
	want := []string{"network create " + n.Net, "start " + n.DB}
	if got := d.mutations(); !reflect.DeepEqual(got, want) {
		t.Fatalf("mutations = %q, want %q", got, want)
	}
}

// C3 (A4): a running box keeps running even when main's tag moved; a
// stopped one on an old image is rebuilt from the current tag.
func TestEnsureRecreatesAStoppedBoxOnAnOldImageOnly(t *testing.T) {
	n := Names(tChange)
	old := "nova-devbox:t-" + strings.Repeat("f", 40)

	d := newFake()
	d.nets[n.Net], d.vols[n.Cache] = true, true
	d.ctrs[n.Box] = &fakeCtr{"running", old}
	d.ctrs[n.DB] = &fakeCtr{"running", PostgresImage}
	m, _ := newManager(d)
	st, err := m.Ensure(context.Background(), goodRequest())
	if err != nil {
		t.Fatal(err)
	}
	if st.Image != old || len(d.mutations()) != 0 {
		t.Fatalf("running old box: state %+v mutations %q", st, d.mutations())
	}

	d = newFake()
	d.nets[n.Net], d.vols[n.Cache] = true, true
	d.ctrs[n.Box] = &fakeCtr{"exited", old}
	d.ctrs[n.DB] = &fakeCtr{"running", PostgresImage}
	m, _ = newManager(d)
	st, err = m.Ensure(context.Background(), goodRequest())
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"rm -f " + n.Box, "run " + n.Box}
	if got := d.mutations(); !reflect.DeepEqual(got, want) || st.Image != tTag {
		t.Fatalf("stopped old box: mutations %q (want %q), state %+v", got, want, st)
	}
}

// C4
func TestEnsureWithoutTheImageSaysSoAndMakesNothing(t *testing.T) {
	d := newFake()
	d.images = map[string]bool{}
	m, _ := newManager(d)
	_, err := m.Ensure(context.Background(), goodRequest())
	if err == nil {
		t.Fatal("no error without the image")
	}
	for _, w := range []string{"nova-devbox:t-" + tHash[:12], "main", "deploy/devbox", "./install", "nothing was run"} {
		if !strings.Contains(err.Error(), w) {
			t.Fatalf("error %q lacks %q", err, w)
		}
	}
	if mut := d.mutations(); len(mut) != 0 {
		t.Fatalf("mutated without an image: %q", mut)
	}
}

// C1/C4 (VERIFY gap): the branch is the request's, never a hardcoded "main"
// — a repo whose default branch is trunk reads trunk's deploy/devbox.
func TestImageTagReadsTheBranchItIsGiven(t *testing.T) {
	m, g := newManager(newFake())
	if _, err := m.ImageTag(context.Background(), tCheckout, "trunk"); err != nil {
		t.Fatal(err)
	}
	want := []string{"-C", tCheckout, "rev-parse", "trunk:deploy/devbox"}
	if !reflect.DeepEqual(g.calls, [][]string{want}) {
		t.Fatalf("git calls = %q, want %q", g.calls, want)
	}
}

// C1/C4 (VERIFY gap): Ensure passes the request's branch to ImageTag and
// the image-absent error names that branch, not main.
func TestEnsureReadsTheRequestsBranch(t *testing.T) {
	d := newFake()
	d.images = map[string]bool{}
	m, g := newManager(d)
	req := goodRequest()
	req.Branch = "trunk"
	_, err := m.Ensure(context.Background(), req)
	if err == nil {
		t.Fatal("no error without the image")
	}
	want := []string{"-C", tCheckout, "rev-parse", "trunk:deploy/devbox"}
	if !reflect.DeepEqual(g.calls, [][]string{want}) {
		t.Fatalf("git calls = %q, want %q", g.calls, want)
	}
	if !strings.Contains(err.Error(), "for trunk's deploy/devbox") || strings.Contains(err.Error(), "main") {
		t.Fatalf("error %q does not name trunk (or names main)", err)
	}
}

// C4
func TestEnsureRefusesABadRequestBeforeAnySeam(t *testing.T) {
	d := newFake()
	m, g := newManager(d)
	r := goodRequest()
	r.Cwd = tCheckout
	_, err := m.Ensure(context.Background(), r)
	if err == nil || !strings.HasPrefix(err.Error(), "cwd ") {
		t.Fatalf("err %v, want Validate's cwd refusal", err)
	}
	if len(d.calls)+len(g.calls) != 0 {
		t.Fatalf("seam called: docker %q git %q", d.calls, g.calls)
	}
}

// C5
func TestEnsurePastMaxRunningNamesTheRunningBoxes(t *testing.T) {
	d := newFake()
	m, _ := newManager(d)
	clock := tNow
	m.Now = func() time.Time { return clock }
	// One box this agent started 12 minutes ago, one it never saw.
	if _, err := m.Ensure(context.Background(), boxReq("aaa111")); err != nil {
		t.Fatal(err)
	}
	d.ctrs[Names("bbb222").Box] = &fakeCtr{"running", tTag}
	clock = tNow.Add(12 * time.Minute)
	d.calls = nil
	_, err := m.Ensure(context.Background(), goodRequest())
	if err == nil {
		t.Fatal("a third box started")
	}
	for _, w := range []string{"nova-box-aaa111", "idle 12m", "nova-box-bbb222", "idle unknown", "max_running", "2", "nova-box-" + tChange} {
		if !strings.Contains(err.Error(), w) {
			t.Fatalf("error %q lacks %q", err, w)
		}
	}
	if mut := d.mutations(); len(mut) != 0 {
		t.Fatalf("mutated past the limit: %q", mut)
	}
	// A box that is already running is never blocked by the limit.
	if _, err := m.Ensure(context.Background(), boxReq("aaa111")); err != nil {
		t.Fatalf("the running box was blocked: %v", err)
	}
	// Not even when the limit was lowered below what is running.
	lowered := boxReq("aaa111")
	lowered.Limits.MaxRunning = 1
	if _, err := m.Ensure(context.Background(), lowered); err != nil {
		t.Fatalf("the running box was blocked by a lowered limit: %v", err)
	}
	// One under the limit starts.
	delete(d.ctrs, Names("bbb222").Box)
	if _, err := m.Ensure(context.Background(), goodRequest()); err != nil {
		t.Fatalf("second box refused: %v", err)
	}
}

// C6
func TestEveryDockerFailureNamesTheStepAndStops(t *testing.T) {
	n := Names(tChange)
	steps := []struct {
		name  string
		match func(a []string) bool
		word  string
	}{
		{"image", func(a []string) bool { return a[0] == "image" }, "image"},
		{"ps", func(a []string) bool { return a[0] == "ps" }, "list"},
		{"netls", func(a []string) bool { return a[0] == "network" && a[1] == "ls" }, "network"},
		{"netcreate", func(a []string) bool { return a[0] == "network" && a[1] == "create" }, "network"},
		{"volcreate", func(a []string) bool { return a[0] == "volume" && a[1] == "create" }, "volume"},
		{"db", func(a []string) bool { return a[0] == "run" && flagVal(a, "--name") == n.DB }, "database"},
		{"box", func(a []string) bool { return a[0] == "run" && flagVal(a, "--name") == n.Box }, "box"},
	}
	for _, spawn := range []bool{false, true} {
		for _, s := range steps {
			d := newFake()
			d.fail, d.spawnErr = s.match, spawn
			m, _ := newManager(d)
			_, err := m.Ensure(context.Background(), goodRequest())
			if err == nil {
				t.Fatalf("%s (spawn %v): no error", s.name, spawn)
			}
			quote := "boom at"
			if spawn {
				quote = "executable file not found"
			}
			if !strings.Contains(err.Error(), quote) || !strings.Contains(err.Error(), s.word) {
				t.Fatalf("%s (spawn %v): error %q lacks %q or %q", s.name, spawn, err, quote, s.word)
			}
			last := d.calls[len(d.calls)-1]
			if !s.match(last) {
				t.Fatalf("%s (spawn %v): a step ran after the failure: %q", s.name, spawn, last)
			}
		}
	}
	// The start path fails the same way.
	d := newFake()
	d.nets[n.Net], d.vols[n.Cache] = true, true
	d.ctrs[n.Box] = &fakeCtr{"exited", tTag}
	d.ctrs[n.DB] = &fakeCtr{"exited", PostgresImage}
	d.fail = func(a []string) bool { return a[0] == "start" }
	m, _ := newManager(d)
	if _, err := m.Ensure(context.Background(), goodRequest()); err == nil || !strings.Contains(err.Error(), "boom at start") {
		t.Fatalf("start failure: %v", err)
	}
	if len(d.mutations()) != 1 {
		t.Fatalf("ran past a failed start: %q", d.mutations())
	}
}

// C7
func TestStatusReadsBoxesOnly(t *testing.T) {
	d := newFake()
	d.ctrs[Names("aaa111").Box] = &fakeCtr{"running", tTag}
	d.ctrs[Names("aaa111").DB] = &fakeCtr{"running", PostgresImage}
	d.ctrs[Names("bbb222").Box] = &fakeCtr{"exited", tTag}
	d.ctrs[Names("ccc333").Box] = &fakeCtr{"created", tTag}
	d.ctrs["someone-else"] = &fakeCtr{"running", "x"}
	m, _ := newManager(d)
	got, err := m.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"aaa111": "running", "bbb222": "stopped", "ccc333": "stopped"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("status = %v, want %v", got, want)
	}
	if len(d.calls) != 1 || d.calls[0][0] != "ps" || flagVal(d.calls[0], "--filter") != "label="+Label {
		t.Fatalf("calls %q, want one labelled ps", d.calls)
	}
	d.fail = func([]string) bool { return true }
	got, err = m.Status(context.Background())
	if err == nil || got != nil || !strings.Contains(err.Error(), "boom at ps") {
		t.Fatalf("failing docker: %v %v, want an error quoting docker and no map", got, err)
	}
}

// C7
func TestRemoveTakesEverythingTheChangeOwns(t *testing.T) {
	d := newFake()
	m, _ := newManager(d)
	if _, err := m.Ensure(context.Background(), goodRequest()); err != nil {
		t.Fatal(err)
	}
	other := Names("bbb222")
	d.ctrs[other.Box] = &fakeCtr{"running", tTag}
	d.nets[other.Net] = true
	if err := m.Remove(context.Background(), tChange); err != nil {
		t.Fatal(err)
	}
	n := Names(tChange)
	if d.ctrs[n.Box] != nil || d.ctrs[n.DB] != nil || d.nets[n.Net] || d.vols[n.Cache] {
		t.Fatalf("left behind: ctrs %v nets %v vols %v", d.ctrs, d.nets, d.vols)
	}
	if d.ctrs[other.Box] == nil || !d.nets[other.Net] {
		t.Fatal("removed another change's box")
	}
	// Nothing left: a second Remove is a no-op, not an error.
	d.calls = nil
	if err := m.Remove(context.Background(), tChange); err != nil {
		t.Fatalf("second remove: %v", err)
	}
	if mut := d.mutations(); len(mut) != 0 {
		t.Fatalf("second remove mutated: %q", mut)
	}
	d.calls = nil
	if err := m.Remove(context.Background(), "../x"); err == nil || len(d.calls) != 0 {
		t.Fatalf("bad id: err %v calls %q", err, d.calls)
	}
	if _, err := m.Ensure(context.Background(), goodRequest()); err != nil {
		t.Fatal(err)
	}
	d.fail = func(a []string) bool { return a[0] == "rm" }
	if err := m.Remove(context.Background(), tChange); err == nil || !strings.Contains(err.Error(), "boom at rm") {
		t.Fatalf("rm failure: %v", err)
	}
}
