package box

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// S32.2 T6: suites.toml, LoadSuites and Heavy. Every value is a non-default
// (branch trunk, checkout tCheckout, dirs other than the real ones) so a
// hardcoded main or a hardcoded dir cannot pass.

const sampleSuites = `
protected = ["svc/*/tests/**", "guards.py"]

[[suite]]
name = "alpha"
dir = "svc/alpha"
commands = [["uv", "run", "pytest"]]
paths = ["svc/alpha/**"]

[[suite]]
name = "web"
dir = "apps/front"
commands = [["npm", "test"], ["npx", "tsc", "--noEmit"]]
paths = ["apps/front/**"]

[[suite]]
name = "root"
dir = "."
commands = [["./deploy/x_test.sh"]]
paths = ["deploy/**"]
`

// C2 (parse)
func TestParseSuitesReadsEverySuiteAndTheProtectedList(t *testing.T) {
	s, err := ParseSuites([]byte(sampleSuites))
	if err != nil {
		t.Fatal(err)
	}
	want := Suites{
		Suite: []Suite{
			{Name: "alpha", Dir: "svc/alpha", Commands: [][]string{{"uv", "run", "pytest"}}, Paths: []string{"svc/alpha/**"}},
			{Name: "web", Dir: "apps/front", Commands: [][]string{{"npm", "test"}, {"npx", "tsc", "--noEmit"}}, Paths: []string{"apps/front/**"}},
			{Name: "root", Dir: ".", Commands: [][]string{{"./deploy/x_test.sh"}}, Paths: []string{"deploy/**"}},
		},
		Protected: []string{"svc/*/tests/**", "guards.py"},
	}
	if !reflect.DeepEqual(s, want) {
		t.Fatalf("got %+v\nwant %+v", s, want)
	}
}

// C2 (refusals)
func TestParseSuitesRefusesWhatWouldMisjudgeHeavy(t *testing.T) {
	one := func(body string) string { return "[[suite]]\n" + body }
	cases := []struct{ name, raw, want string }{
		{"not toml", "[[suite]\nname=", "suites.toml"},
		{"no suites", `protected = ["a"]`, "no suites"},
		{"unknown key", one("name = \"a\"\ndir = \"a\"\ncommands = [[\"x\"]]\nselector = \"y\"\n"), "selector"},
		{"no name", one("dir = \"a\"\ncommands = [[\"x\"]]\n"), "name"},
		{"no dir", one("name = \"a\"\ncommands = [[\"x\"]]\n"), "dir"},
		{"no commands", one("name = \"a\"\ndir = \"a\"\n"), "commands"},
		{"empty command", one("name = \"a\"\ndir = \"a\"\ncommands = [[]]\n"), "empty command"},
		{"empty word", one("name = \"a\"\ndir = \"a\"\ncommands = [[\"uv\", \"\"]]\n"), "empty word"},
		{"absolute dir", one("name = \"a\"\ndir = \"/srv/a\"\ncommands = [[\"x\"]]\n"), `"/srv/a"`},
		{"unclean dir", one("name = \"a\"\ndir = \"a//b\"\ncommands = [[\"x\"]]\n"), `"a//b"`},
		{"escaping dir", one("name = \"a\"\ndir = \"../a\"\ncommands = [[\"x\"]]\n"), `"../a"`},
	}
	for _, c := range cases {
		_, err := ParseSuites([]byte(c.raw))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want one naming %q", c.name, err, c.want)
		}
	}
}

// C2 (load: the branch's commit, through the Git seam)
func TestLoadSuitesReadsTheBranchsCommittedFile(t *testing.T) {
	m, g := newManager(newFake())
	g.out = sampleSuites
	s, err := m.LoadSuites(context.Background(), tCheckout, "trunk")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Suite) != 3 || s.Suite[1].Name != "web" {
		t.Fatalf("suites = %+v", s)
	}
	want := [][]string{{"-C", tCheckout, "show", "trunk:deploy/devbox/suites.toml"}}
	if !reflect.DeepEqual(g.calls, want) {
		t.Fatalf("git calls = %v, want %v", g.calls, want)
	}
}

func TestLoadSuitesQuotesWhyItCannot(t *testing.T) {
	for _, c := range []struct {
		name string
		g    fakeGit
		want []string
	}{
		{"git says no", fakeGit{out: "fatal: path 'deploy/devbox/suites.toml' does not exist in 'trunk'\n", exit: 128},
			[]string{"trunk", "exit 128", "does not exist in 'trunk'"}},
		{"git missing", fakeGit{err: errors.New("exec: git not found")}, []string{"trunk", "git not found"}},
		{"bad toml", fakeGit{out: "[[suite]\n"}, []string{"trunk", "suites.toml"}},
		{"empty file", fakeGit{out: ""}, []string{"trunk", "no suites"}},
	} {
		g := c.g
		m := &Manager{Docker: newFake(), Git: &g}
		_, err := m.LoadSuites(context.Background(), tCheckout, "trunk")
		if err == nil {
			t.Errorf("%s: no error", c.name)
			continue
		}
		for _, w := range c.want {
			if !strings.Contains(err.Error(), w) {
				t.Errorf("%s: err = %q, missing %q", c.name, err, w)
			}
		}
	}
}

// C3
func TestHeavyIsAWholeSuiteInItsDirOnly(t *testing.T) {
	s, err := ParseSuites([]byte(sampleSuites))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		argv []string
		dir  string
		want bool
	}{
		{[]string{"uv", "run", "pytest"}, "svc/alpha", true},
		{[]string{"npm", "test"}, "apps/front", true},
		{[]string{"npx", "tsc", "--noEmit"}, "apps/front", true},
		{[]string{"./deploy/x_test.sh"}, ".", true},
		{[]string{"uv", "run", "pytest", "tests/test_a.py"}, "svc/alpha", false}, // a selector
		{[]string{"uv", "run", "pytest", "-k", "foo"}, "svc/alpha", false},       // a selector
		{[]string{"uv", "run", "pytest", "-q"}, "svc/alpha", false},              // an extra flag
		{[]string{"uv", "run"}, "svc/alpha", false},                              // a missing word
		{[]string{"uv", "run", "pytest"}, "apps/front", false},                   // another suite's dir
		{[]string{"uv", "run", "pytest"}, "svc/alpha/tests", false},              // below the dir
		{[]string{"uv", "run", "pytest"}, ".", false},                            // the root
		{[]string{"npm", "test"}, "svc/alpha", false},                            // command of another suite
		{[]string{"./deploy/x_test.sh"}, "deploy", false},                        // not its dir
		{[]string{"sh", "-c", "uv run pytest"}, "svc/alpha", false},              // wrapped
		{[]string{"npx", "tsc", "--noEmit", "--watch"}, "apps/front", false},     // extra flag
	}
	for _, c := range cases {
		if got := Heavy(s, c.argv, c.dir); got != c.want {
			t.Errorf("Heavy(%q, %q) = %v, want %v", c.argv, c.dir, got, c.want)
		}
	}
}

func TestLockPathIsTheCheckoutsDeployState(t *testing.T) {
	if got := LockPath("/srv/other"); got != "/srv/other/deploy/state/cpu.lock" {
		t.Fatalf("LockPath = %q", got)
	}
}

// C1: the real file, against the real tree (derived: every service with a
// pyproject.toml must have its suite).
func TestTheRealSuitesFileCoversEveryServiceDir(t *testing.T) {
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(root, SuitesPath))
	if err != nil {
		t.Fatal(err)
	}
	s, err := ParseSuites(raw)
	if err != nil {
		t.Fatal(err)
	}
	byDir := map[string]Suite{}
	for _, su := range s.Suite {
		if _, err := os.Stat(filepath.Join(root, su.Dir)); err != nil {
			t.Errorf("suite %s: dir %q does not exist", su.Name, su.Dir)
		}
		byDir[su.Dir] = su
	}
	want := map[string][][]string{
		"apps/web":   {{"npm", "test"}, {"npx", "tsc", "--noEmit"}},
		"apps/novad": {{"go", "test", "./..."}},
	}
	pys, _ := filepath.Glob(filepath.Join(root, "services", "*", "pyproject.toml"))
	if len(pys) < 3 {
		t.Fatalf("found %d services, want core/gateway/memory at least", len(pys))
	}
	for _, p := range pys {
		rel, _ := filepath.Rel(root, filepath.Dir(p))
		want[filepath.ToSlash(rel)] = [][]string{{"uv", "run", "pytest"}}
	}
	for dir, cmds := range want {
		su, ok := byDir[dir]
		if !ok {
			t.Errorf("no suite for %s", dir)
			continue
		}
		for _, c := range cmds {
			if !Heavy(s, c, dir) {
				t.Errorf("%s: %q is not heavy (suite %+v)", dir, c, su)
			}
		}
	}
	rootSuite, ok := byDir["."]
	if !ok || !Heavy(s, []string{"./deploy/install_test.sh"}, ".") {
		t.Errorf("the installer tests are not a suite at the repo root: %+v", rootSuite)
	}
	for _, c := range rootSuite.Commands {
		if _, err := os.Stat(filepath.Join(root, c[0])); err != nil {
			t.Errorf("root suite command %q: %v", c, err)
		}
	}
	for _, p := range []string{"services/*/tests/**", "tests/**", "services/core/app/guards.py",
		"services/core/app/evals/cases/**", "services/core/tests/test_no_approvals.py"} {
		if !slices.Contains(s.Protected, p) {
			t.Errorf("protected lacks %q: %v", p, s.Protected)
		}
	}
}
