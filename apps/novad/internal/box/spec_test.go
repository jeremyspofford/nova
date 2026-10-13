package box

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

const (
	tCheckout = "/home/owner/workspace/nova"
	tChange   = "a1b2c3"
	tWorktree = tCheckout + "/.worktrees/nova-" + tChange
	tImage    = "nova-devbox:t-0123456789ab"
)

func goodRequest() Request {
	return Request{
		Checkout: tCheckout,
		Change:   tChange,
		Branch:   "main",
		Cwd:      tWorktree + "/services/core",
		Limits:   Limits{CPUs: 2, MemoryGB: 3, Pids: 512, MaxRunning: 2},
	}
}

// C1
func TestNamesDeriveEveryObjectFromTheChange(t *testing.T) {
	got := Names(tChange)
	want := BoxNames{
		Box:   "nova-box-a1b2c3",
		DB:    "nova-box-a1b2c3-db",
		Net:   "nova-box-a1b2c3-net",
		Cache: "nova-box-a1b2c3-cache",
		Fetch: "nova-box-a1b2c3-fetch",
	}
	if got != want {
		t.Fatalf("Names = %+v, want %+v", got, want)
	}
	if w := Worktree(tCheckout, tChange); w != tWorktree {
		t.Fatalf("Worktree = %q, want %q", w, tWorktree)
	}
}

// C2: a well-formed request passes, including cwd == the worktree itself.
func TestValidateAcceptsAWellFormedRequest(t *testing.T) {
	if err := Validate(goodRequest()); err != nil {
		t.Fatalf("good request refused: %v", err)
	}
	r := goodRequest()
	r.Cwd = tWorktree
	if err := Validate(r); err != nil {
		t.Fatalf("cwd = worktree refused: %v", err)
	}
	r = goodRequest()
	r.Branch = "slice/s32-2"
	if err := Validate(r); err != nil {
		t.Fatalf("branch with a slash refused: %v", err)
	}
	lo := goodRequest()
	lo.Limits = Limits{CPUs: 1, MemoryGB: 1, Pids: 64, MaxRunning: 1}
	if err := Validate(lo); err != nil {
		t.Fatalf("lower bounds refused: %v", err)
	}
	hi := goodRequest()
	hi.Limits = Limits{CPUs: 16, MemoryGB: 64, Pids: 65536, MaxRunning: 8}
	if err := Validate(hi); err != nil {
		t.Fatalf("upper bounds refused: %v", err)
	}
}

// C2: each edge refusal is stated, naming the field and the value.
func TestValidateRefusesAtTheEdgeNamingTheFieldAndValue(t *testing.T) {
	cases := []struct {
		name  string
		mut   func(*Request)
		field string
		value string
	}{
		{"change short", func(r *Request) { r.Change = "a1b2c" }, "change", "a1b2c"},
		{"change long", func(r *Request) { r.Change = "a1b2c3d" }, "change", "a1b2c3d"},
		{"change upper", func(r *Request) { r.Change = "A1B2C3" }, "change", "A1B2C3"},
		{"change non-hex", func(r *Request) { r.Change = "a1b2cg" }, "change", "a1b2cg"},
		{"change traversal", func(r *Request) { r.Change = "../../x" }, "change", "../../x"},
		{"change empty", func(r *Request) { r.Change = "" }, "change", `""`},
		{"checkout relative", func(r *Request) { r.Checkout = "workspace/nova" }, "checkout", "workspace/nova"},
		{"checkout unclean", func(r *Request) { r.Checkout = "/home/owner/x/../nova" }, "checkout", "/home/owner/x/../nova"},
		{"checkout trailing slash", func(r *Request) { r.Checkout = "/home/owner/nova/" }, "checkout", "/home/owner/nova/"},
		{"checkout root", func(r *Request) { r.Checkout = "/" }, "checkout", `"/"`},
		{"checkout colon", func(r *Request) { r.Checkout = "/home/owner/a:/b" }, "checkout", "/home/owner/a:/b"},
		{"checkout comma", func(r *Request) { r.Checkout = "/home/owner/a,b" }, "checkout", "/home/owner/a,b"},
		{"checkout empty", func(r *Request) { r.Checkout = "" }, "checkout", `""`},
		{"branch empty", func(r *Request) { r.Branch = "" }, "branch", `""`},
		{"branch dash", func(r *Request) { r.Branch = "-x" }, "branch", "-x"},
		{"branch dotdot", func(r *Request) { r.Branch = "a..b" }, "branch", "a..b"},
		{"branch space", func(r *Request) { r.Branch = "a b" }, "branch", "a b"},
		{"branch colon", func(r *Request) { r.Branch = "main:x" }, "branch", "main:x"},
		{"cwd checkout", func(r *Request) { r.Cwd = tCheckout }, "cwd", tCheckout},
		{"cwd sibling prefix", func(r *Request) { r.Cwd = tWorktree + "x" }, "cwd", tWorktree + "x"},
		{"cwd other change", func(r *Request) { r.Cwd = tCheckout + "/.worktrees/nova-ffffff" }, "cwd", "nova-ffffff"},
		{"cwd dotdot escape", func(r *Request) { r.Cwd = tWorktree + "/../nova-ffffff" }, "cwd", "/../nova-ffffff"},
		{"cwd relative", func(r *Request) { r.Cwd = "services/core" }, "cwd", "services/core"},
		{"cwd empty", func(r *Request) { r.Cwd = "" }, "cwd", `""`},
		{"cpus low", func(r *Request) { r.Limits.CPUs = 0 }, "cpus", "0"},
		{"cpus high", func(r *Request) { r.Limits.CPUs = 17 }, "cpus", "17"},
		{"memory low", func(r *Request) { r.Limits.MemoryGB = 0 }, "memory_gb", "0"},
		{"memory high", func(r *Request) { r.Limits.MemoryGB = 65 }, "memory_gb", "65"},
		{"pids low", func(r *Request) { r.Limits.Pids = 63 }, "pids", "63"},
		{"pids high", func(r *Request) { r.Limits.Pids = 65537 }, "pids", "65537"},
		{"max_running low", func(r *Request) { r.Limits.MaxRunning = 0 }, "max_running", "0"},
		{"max_running high", func(r *Request) { r.Limits.MaxRunning = 9 }, "max_running", "9"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := goodRequest()
			c.mut(&r)
			err := Validate(r)
			if err == nil {
				t.Fatalf("accepted %+v", r)
			}
			msg := err.Error()
			// The refusal leads with its own field, so a later check firing
			// by accident (e.g. cwd, when change was the bad one) fails here.
			if !strings.HasPrefix(msg, c.field+" ") || !strings.Contains(msg, c.value) {
				t.Fatalf("error %q does not lead with field %q and name value %q", msg, c.field, c.value)
			}
		})
	}
}

// C3
// gateway_mode_ipv4=isolated (T12, measured): an --internal network still
// puts an address on the host's bridge, and the box reached a host listener
// on 0.0.0.0 through it; isolated leaves the bridge without one.
func TestNetworkArgsAreInternalAndLabelled(t *testing.T) {
	want := []string{"network", "create", "--internal",
		"-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
		"--label", "nova.box=a1b2c3", "nova-box-a1b2c3-net"}
	if got := NetworkArgs(tChange); !reflect.DeepEqual(got, want) {
		t.Fatalf("NetworkArgs =\n %q\nwant\n %q", got, want)
	}
}

// C4
func TestDBArgsArePinnedUnpublishedAndOnTheBoxNet(t *testing.T) {
	want := []string{
		"run", "-d",
		"--name", "nova-box-a1b2c3-db",
		"--network", "nova-box-a1b2c3-net",
		"--network-alias", "db",
		"--security-opt", "no-new-privileges",
		"--memory", "1g",
		"--pids-limit", "512",
		"--tmpfs", "/var/lib/postgresql/data",
		"-e", "POSTGRES_HOST_AUTH_METHOD=trust",
		"--label", "nova.box=a1b2c3",
		PostgresImage,
	}
	if got := DBArgs(tChange); !reflect.DeepEqual(got, want) {
		t.Fatalf("DBArgs =\n %q\nwant\n %q", got, want)
	}
	if !strings.HasPrefix(PostgresImage, "postgres:16@sha256:") || len(PostgresImage) != len("postgres:16@sha256:")+64 {
		t.Fatalf("PostgresImage %q is not pinned by a sha256 digest", PostgresImage)
	}
}

// C5
func TestBoxArgsAreExactlyTheSpec(t *testing.T) {
	want := []string{
		"run", "-d",
		"--name", "nova-box-a1b2c3",
		"--network", "nova-box-a1b2c3-net",
		"--init",
		"--user", "1000:1001",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--memory", "3g",
		"--pids-limit", "512",
		"--cpus", "2",
		"--tmpfs", "/tmp:exec",
		"-e", "TEST_DATABASE_URL=postgresql://postgres@db:5432/postgres",
		"-e", "HOME=/tmp/home",
		"-e", "USER=nova",
		"-e", "LOGNAME=nova",
		"-v", tWorktree + ":" + tWorktree + ":rw",
		"-v", tCheckout + "/.git:" + tCheckout + "/.git:ro",
		"-v", "nova-box-a1b2c3-cache:/deps:ro",
		"--mount", "type=volume,src=nova-box-a1b2c3-cache,dst=/deps/uv,volume-subpath=uv",
		"--label", "nova.box=a1b2c3",
		tImage,
		"sleep", "infinity",
	}
	if got := BoxArgs(goodRequest(), tImage, 1000, 1001); !reflect.DeepEqual(got, want) {
		t.Fatalf("BoxArgs =\n %q\nwant\n %q", got, want)
	}
	// Limits flow from the request, not constants.
	r := goodRequest()
	r.Limits = Limits{CPUs: 4, MemoryGB: 8, Pids: 1024, MaxRunning: 2}
	got := strings.Join(BoxArgs(r, tImage, 1000, 1001), " ")
	for _, w := range []string{"--memory 8g", "--pids-limit 1024", "--cpus 4"} {
		if !strings.Contains(got, w) {
			t.Fatalf("BoxArgs with limits %+v lacks %q: %s", r.Limits, w, got)
		}
	}
	// The mounts come from checkout+change, never from cwd.
	r = goodRequest()
	r.Cwd = tWorktree + "/apps/web"
	if got := BoxArgs(r, tImage, 1000, 1001); !reflect.DeepEqual(got, want) {
		t.Fatalf("cwd changed the box argv: %q", got)
	}
}

// flagValues returns every value of flag (both "--f v" and "--f=v" forms).
func flagValues(argv []string, flags ...string) []string {
	var out []string
	for i, a := range argv {
		for _, f := range flags {
			if a == f && i+1 < len(argv) {
				out = append(out, argv[i+1])
			}
			if strings.HasPrefix(a, f+"=") {
				out = append(out, strings.TrimPrefix(a, f+"="))
			}
		}
	}
	return out
}

// C6: derived denials over every argv the package emits, for several
// requests (not just the pinned one).
func TestNoArgvOpensTheSeal(t *testing.T) {
	home, _ := os.UserHomeDir()
	reqs := []Request{goodRequest()}
	r := goodRequest()
	r.Checkout, r.Change = "/srv/repo", "ffffff"
	r.Cwd = Worktree(r.Checkout, r.Change)
	reqs = append(reqs, r)

	for _, req := range reqs {
		names := Names(req.Change)
		all := map[string][]string{
			"network": NetworkArgs(req.Change),
			"db":      DBArgs(req.Change),
			"box":     BoxArgs(req, tImage, 1000, 1000),
		}
		for kind, argv := range all {
			if len(argv) == 0 {
				t.Fatalf("%s argv empty", kind)
			}
			for _, a := range argv {
				for _, bad := range []string{"-p", "--publish", "-P", "--publish-all", "--privileged", "--cap-add", "--device", "--pid", "--ipc", "--userns", "--uts", "--volumes-from", "--dns", "--add-host"} {
					if a == bad || strings.HasPrefix(a, bad+"=") {
						t.Errorf("%s argv carries %q: %q", kind, a, argv)
					}
				}
				for _, bad := range []string{"docker.sock", "/var/run", ".secrets", ".env"} {
					if strings.Contains(a, bad) {
						t.Errorf("%s argv mentions %q in %q", kind, bad, a)
					}
				}
			}
			for _, n := range flagValues(argv, "--network", "--net") {
				if n != names.Net {
					t.Errorf("%s argv joins network %q (only %q allowed)", kind, n, names.Net)
				}
			}
			for _, so := range flagValues(argv, "--security-opt") {
				if so != "no-new-privileges" {
					t.Errorf("%s argv carries --security-opt %q", kind, so)
				}
			}
		}
		if !contains(all["network"], "--internal") {
			t.Errorf("network is not --internal: %q", all["network"])
		}
		// No host address on the box's bridge (T12): without isolated the box
		// reaches every host service listening on 0.0.0.0.
		if o := flagValues(all["network"], "-o", "--opt"); !reflect.DeepEqual(o, []string{"com.docker.network.bridge.gateway_mode_ipv4=isolated"}) {
			t.Errorf("network options %q, want exactly gateway_mode_ipv4=isolated", o)
		}
		box := all["box"]
		if n := flagValues(box, "--network", "--net"); len(n) != 1 {
			t.Errorf("box must join exactly one network, got %q", n)
		}
		if n := flagValues(all["db"], "--network", "--net"); len(n) != 1 {
			t.Errorf("db must join exactly one network, got %q", n)
		}
		if caps := flagValues(box, "--cap-drop"); !reflect.DeepEqual(caps, []string{"ALL"}) {
			t.Errorf("box --cap-drop = %q", caps)
		}
		var envKeys []string
		for _, e := range flagValues(box, "-e", "--env") {
			envKeys = append(envKeys, strings.SplitN(e, "=", 2)[0])
		}
		// USER/LOGNAME added 2026-10-13: the box's uid has no passwd entry
		// (getpass.getuser() raised in the box); a fixed name, not the host's.
		if !reflect.DeepEqual(envKeys, []string{"TEST_DATABASE_URL", "HOME", "USER", "LOGNAME"}) {
			t.Errorf("box env keys = %q, want exactly TEST_DATABASE_URL, HOME, USER and LOGNAME", envKeys)
		}
		if ef := flagValues(box, "--env-file"); len(ef) != 0 {
			t.Errorf("box carries --env-file %q", ef)
		}
		wt := Worktree(req.Checkout, req.Change)
		allowedSrc := map[string]string{
			wt:                     "rw",
			req.Checkout + "/.git": "ro",
			names.Cache:            "ro",
		}
		vols := flagValues(box, "-v", "--volume")
		if len(vols) != len(allowedSrc) {
			t.Errorf("box mounts %q, want exactly %d", vols, len(allowedSrc))
		}
		for _, v := range vols {
			parts := strings.Split(v, ":")
			if len(parts) != 3 {
				t.Errorf("mount %q is not src:dst:mode", v)
				continue
			}
			mode, ok := allowedSrc[parts[0]]
			if !ok {
				t.Errorf("mount source %q is not the worktree, .git or cache", parts[0])
				continue
			}
			if parts[2] != mode {
				t.Errorf("mount %q mode %q, want %q", parts[0], parts[2], mode)
			}
			if home != "" && (parts[0] == home || parts[1] == home) {
				t.Errorf("mount %q exposes $HOME", v)
			}
		}
		for _, v := range flagValues(all["db"], "-v", "--volume") {
			t.Errorf("db mounts %q (it must mount nothing)", v)
		}
		// The one --mount anywhere: the uv part of the box's own cache.
		for kind, argv := range all {
			want := []string(nil)
			if kind == "box" {
				want = []string{"type=volume,src=" + names.Cache + ",dst=/deps/uv,volume-subpath=uv"}
			}
			if got := flagValues(argv, "--mount"); !reflect.DeepEqual(got, want) {
				t.Errorf("%s --mount = %q, want %q", kind, got, want)
			}
		}
	}
}

func contains(argv []string, s string) bool {
	for _, a := range argv {
		if a == s {
			return true
		}
	}
	return false
}

// T12 ruling (option 1): uv cannot run against a read-only cache (it takes a
// lock and writes temp files in UV_CACHE_DIR), so the box mounts the uv part
// of ITS OWN cache volume read-write; the rest of /deps — npm, go and the
// fetch marker /deps/.nova-locks — stays read-only, and nothing else of the
// host is writable but the worktree.
func TestOnlyTheUvCacheAndTheWorktreeAreWritableInTheBox(t *testing.T) {
	argv := BoxArgs(goodRequest(), tImage, 1000, 1000)
	n := Names(tChange)
	type mnt struct{ src, dst, mode string }
	var got []mnt
	for _, v := range flagValues(argv, "-v", "--volume") {
		p := strings.Split(v, ":")
		got = append(got, mnt{p[0], p[1], p[2]})
	}
	for _, m := range flagValues(argv, "--mount") {
		kv := map[string]string{}
		for _, f := range strings.Split(m, ",") {
			k, v, _ := strings.Cut(f, "=")
			kv[k] = v
		}
		mode := "rw"
		if _, ro := kv["readonly"]; ro || kv["ro"] != "" {
			mode = "ro"
		}
		if kv["type"] != "volume" || kv["volume-subpath"] != "uv" {
			t.Errorf("--mount %q is not the uv subpath of a volume", m)
		}
		got = append(got, mnt{kv["src"] + "/" + kv["volume-subpath"], kv["dst"], mode})
	}
	want := []mnt{
		{tWorktree, tWorktree, "rw"},
		{tCheckout + "/.git", tCheckout + "/.git", "ro"},
		{n.Cache, "/deps", "ro"},
		{n.Cache + "/uv", "/deps/uv", "rw"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("box mounts\n %q\nwant\n %q", got, want)
	}
}
