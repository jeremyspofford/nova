//go:build docker && linux

// The seal test's harness (S32.2 T12, spec §4.2): run by
// deploy/devbox/seal_test.sh, which builds the devbox image in a throwaway
// checkout with two change worktrees and passes their shape in SEAL_*. It
// drives the SHIPPED path — the agent's own newBoxManager() and
// caps.Dispatch("box.exec", ...) with args shaped as core sends them — against
// real docker, so what it proves is the argv novad actually runs, not a
// hand-written `docker run`.
//
// Behind the `docker` build tag: `go test ./...` never runs it. Missing
// SEAL_* is a failure, never a skip — a seal test that did not run proved
// nothing.
package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"novad/internal/box"
	"novad/internal/caps"
	"novad/internal/jobs"
)

// probe is the one script every network check runs, in the box and in the
// control container: one op, one answer line ("open ..." or "closed ...").
const probe = `
import socket, sys, urllib.request
op = sys.argv[1]
try:
    if op == "tcp":
        s = socket.create_connection((sys.argv[2], int(sys.argv[3])), timeout=3)
        s.close(); print("open")
    elif op == "udpdns":
        q = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01"
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
        s.sendto(q, (sys.argv[2], 53)); s.recvfrom(512); print("open")
    elif op == "resolve":
        print("open " + socket.gethostbyname(sys.argv[2]))
    elif op == "url":
        urllib.request.urlopen(sys.argv[2], timeout=5); print("open")
except Exception as e:
    print("closed " + type(e).__name__ + ": " + str(e))
`

type sealEnv struct {
	checkout, branch, a, b, tag, changeTag, fetchedMod, novad string
}

func sealRead(t *testing.T) sealEnv {
	t.Helper()
	get := func(k string) string {
		v := os.Getenv(k)
		if v == "" {
			t.Fatalf("%s is not set: run deploy/devbox/seal_test.sh, which sets it", k)
		}
		return v
	}
	return sealEnv{
		checkout: get("SEAL_CHECKOUT"), branch: get("SEAL_BRANCH"),
		a: get("SEAL_A"), b: get("SEAL_B"),
		tag: get("SEAL_TAG"), changeTag: get("SEAL_CHANGE_TAG"),
		fetchedMod: get("SEAL_FETCHED_MOD"),
		novad:      get("SEAL_NOVAD"),
	}
}

func dockerOut(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v: %s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// inspected is the part of one container's docker inspect the seal reads.
type inspected struct {
	Config struct {
		Image string
		User  string
	}
	HostConfig struct {
		NetworkMode     string
		PortBindings    map[string]any
		PublishAllPorts bool
		CapDrop         []string
		CapAdd          []string
		Privileged      bool
		SecurityOpt     []string
		Memory          int64
		PidsLimit       *int64
		NanoCpus        int64
		Devices         []any
	}
	Mounts []struct {
		Type, Source, Destination, Name string
		RW                              bool
	}
	NetworkSettings struct {
		Ports    map[string][]any
		Networks map[string]struct{ IPAddress string }
	}
}

func inspectCtr(t *testing.T, name string) inspected {
	t.Helper()
	var got []inspected
	if err := json.Unmarshal([]byte(dockerOut(t, "inspect", name)), &got); err != nil || len(got) != 1 {
		t.Fatalf("inspect %s: %v (%d)", name, err, len(got))
	}
	return got[0]
}

func TestSeal(t *testing.T) {
	se := sealRead(t)
	// A secret in the harness's own environment: docker exec runs from this
	// process, so a host passthrough would carry it into the box.
	t.Setenv("SEAL_PLANTED_SECRET", "seal-secret-must-not-cross")

	m := newBoxManager() // the agent's own wiring: docker/git ExecRunners, owner uid/gid
	if m == nil {
		t.Fatal("newBoxManager returned nil on linux")
	}
	deps := caps.Deps{Box: m}
	ctx := context.Background()
	wt := map[string]string{se.a: box.Worktree(se.checkout, se.a), se.b: box.Worktree(se.checkout, se.b)}
	limits := map[string]any{
		"cpus": json.Number("2"), "memory_gb": json.Number("3"),
		"pids": json.Number("512"), "max_running": json.Number("8"),
	}

	// run is box.exec exactly as core sends it; it returns the output (the
	// runArgv exit suffix removed), the exit code and the meta.
	run := func(t *testing.T, change, cwdRel string, argv ...string) (string, int, map[string]any) {
		t.Helper()
		cwd := wt[change]
		if cwdRel != "" {
			cwd = filepath.Join(cwd, cwdRel)
		}
		av := make([]any, len(argv))
		for i, a := range argv {
			av[i] = a
		}
		out := caps.Dispatch(ctx, "box.exec", map[string]any{
			"argv": av, "cwd": cwd, "change": change, "checkout": se.checkout,
			"branch": se.branch, "limits": limits,
		}, deps)
		if !out.OK {
			t.Fatalf("box.exec %v in %s was not run: %s", argv, change, out.Error)
		}
		code := *out.ExitCode
		text := strings.TrimSuffix(out.Output, fmt.Sprintf("\n[process exited with code %d]", code))
		return strings.TrimSpace(text), code, out.Meta
	}
	sh := func(t *testing.T, change, script string) (string, int) {
		t.Helper()
		o, c, _ := run(t, change, "", "sh", "-c", script)
		return o, c
	}
	probeIn := func(t *testing.T, change string, args ...string) string {
		t.Helper()
		o, _, _ := run(t, change, "", append([]string{"python3", "-c", probe}, args...)...)
		return o
	}

	// Both boxes come up through box.exec (Ensure is its first step).
	_, _, metaA := run(t, se.a, "", "true")
	if metaA["ran_in"] != "box" || metaA["box"] != box.Names(se.a).Box {
		t.Fatalf("box.exec meta = %v, want ran_in box in %s", metaA, box.Names(se.a).Box)
	}
	run(t, se.b, "", "true")
	nA, nB := box.Names(se.a), box.Names(se.b)
	boxA, dbA, dbB := inspectCtr(t, nA.Box), inspectCtr(t, nA.DB), inspectCtr(t, nB.DB)
	dbAIP := dbA.NetworkSettings.Networks[nA.Net].IPAddress
	dbBIP := dbB.NetworkSettings.Networks[nB.Net].IPAddress
	if dbAIP == "" || dbBIP == "" {
		t.Fatalf("db addresses unread: A %q B %q", dbAIP, dbBIP)
	}

	// The host listener every host-address probe aims at, on all addresses.
	ln, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	port := strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
	var hostIPs []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil && !ipn.IP.IsLoopback() {
			hostIPs = append(hostIPs, ipn.IP.String())
		}
	}
	gw := dockerOut(t, "network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}")

	t.Run("C1 a control container on the default bridge gets out (the probe is not vacuous)", func(t *testing.T) {
		for _, args := range [][]string{{"tcp", "1.1.1.1", "443"}, {"tcp", gw, port}} {
			o := dockerOut(t, append([]string{"run", "--rm", "--network", "bridge", se.tag, "python3", "-c", probe}, args...)...)
			if !strings.HasPrefix(o, "open") {
				t.Errorf("control %v: %s", args, o)
			}
		}
	})
	t.Run("C1 no egress: internet by IP, DNS and URL, and every host address", func(t *testing.T) {
		cases := [][]string{
			{"tcp", "1.1.1.1", "443"}, {"tcp", "8.8.8.8", "53"}, {"udpdns", "8.8.8.8"}, {"udpdns", "1.1.1.1"},
			{"url", "https://example.com"}, {"url", "http://1.1.1.1"},
		}
		if len(hostIPs) == 0 {
			t.Fatal("no host IPv4 address read")
		}
		for _, ip := range hostIPs {
			cases = append(cases, []string{"tcp", ip, port})
		}
		for _, c := range cases {
			if o := probeIn(t, se.a, c...); !strings.HasPrefix(o, "closed") {
				t.Errorf("box A reached %v: %s", c, o)
			}
		}
		t.Logf("host addresses probed on :%s: %v", port, hostIPs)
	})
	t.Run("C2 DNS resolves its own db and nothing else", func(t *testing.T) {
		if o := probeIn(t, se.a, "resolve", "db"); o != "open "+dbAIP {
			t.Errorf("db resolved to %q, want %s", o, dbAIP)
		}
		for _, name := range []string{"example.com", "host.docker.internal", nB.DB, nB.Box} {
			if o := probeIn(t, se.a, "resolve", name); !strings.HasPrefix(o, "closed") {
				t.Errorf("box A resolved %s: %s", name, o)
			}
		}
		if o := probeIn(t, se.a, "tcp", "db", "5432"); o != "open" {
			t.Errorf("box A cannot reach its own db: %s", o)
		}
	})
	t.Run("C3 no published ports, one internal network holding box and db", func(t *testing.T) {
		for _, name := range []string{nA.Box, nA.DB, nB.Box, nB.DB} {
			c := inspectCtr(t, name)
			if len(c.HostConfig.PortBindings) != 0 || c.HostConfig.PublishAllPorts {
				t.Errorf("%s publishes: %v all=%v", name, c.HostConfig.PortBindings, c.HostConfig.PublishAllPorts)
			}
			for p, b := range c.NetworkSettings.Ports {
				if len(b) != 0 {
					t.Errorf("%s binds %s: %v", name, p, b)
				}
			}
		}
		if boxA.HostConfig.NetworkMode != nA.Net || len(boxA.NetworkSettings.Networks) != 1 {
			t.Errorf("box network mode %q, networks %v", boxA.HostConfig.NetworkMode, boxA.NetworkSettings.Networks)
		}
		if len(dbA.NetworkSettings.Networks) != 1 {
			t.Errorf("db networks %v", dbA.NetworkSettings.Networks)
		}
		if got := dockerOut(t, "network", "inspect", nA.Net, "--format", "{{.Internal}}"); got != "true" {
			t.Errorf("%s internal = %s", nA.Net, got)
		}
		members := strings.Fields(dockerOut(t, "network", "inspect", nA.Net, "--format", "{{range .Containers}}{{.Name}} {{end}}"))
		sort.Strings(members)
		if strings.Join(members, " ") != nA.Box+" "+nA.DB {
			t.Errorf("%s holds %v", nA.Net, members)
		}
	})
	t.Run("C4 no socket, four mounts, nothing of $HOME or the checkout's secrets", func(t *testing.T) {
		home, _ := os.UserHomeDir()
		want := map[string]string{
			wt[se.a]: "bind rw", filepath.Join(se.checkout, ".git"): "bind ro", box.DepsMount: "volume ro",
			box.DepsMount + "/uv": "volume rw", // the T12 ruling: uv needs its cache writable
		}
		if len(boxA.Mounts) != 4 {
			t.Errorf("mounts = %+v, want exactly four", boxA.Mounts)
		}
		for _, mt := range boxA.Mounts {
			rw := "ro"
			if mt.RW {
				rw = "rw"
			}
			if want[mt.Destination] != mt.Type+" "+rw {
				t.Errorf("mount %s -> %s is %s %s", mt.Source, mt.Destination, mt.Type, rw)
			}
			if mt.Type == "bind" && mt.Source != mt.Destination {
				t.Errorf("bind %s lands at another path %s", mt.Source, mt.Destination)
			}
			if mt.Type == "volume" && mt.Name != nA.Cache {
				t.Errorf("volume %s, want %s", mt.Name, nA.Cache)
			}
		}
		if len(boxA.HostConfig.Devices) != 0 {
			t.Errorf("devices %v", boxA.HostConfig.Devices)
		}
		for _, p := range []string{"/var/run/docker.sock", "/run/docker.sock", filepath.Join(home, ".secrets"),
			filepath.Join(home, ".ssh"), filepath.Join(se.checkout, ".env"), filepath.Join(se.checkout, "deploy/.env"),
			filepath.Join(se.checkout, "deploy/devbox/Dockerfile")} {
			if o, c := sh(t, se.a, "test -e '"+p+"' || test -L '"+p+"'"); c == 0 {
				t.Errorf("%s exists in the box (%s)", p, o)
			}
		}
		// $HOME holds only the path down to the checkout's mounts.
		rel, err := filepath.Rel(home, se.checkout)
		if err == nil && !strings.HasPrefix(rel, "..") {
			first := strings.Split(rel, string(filepath.Separator))[0]
			if o, _ := sh(t, se.a, "ls -A '"+home+"'"); o != first {
				t.Errorf("$HOME in the box lists %q, want only %q", o, first)
			}
		}
		if o, _, _ := run(t, se.a, "", "env"); strings.Contains(o, "seal-secret-must-not-cross") {
			t.Errorf("the harness's env crossed into the box")
		}
	})
	t.Run("C5 .git read-only, worktree read-write and the owner's", func(t *testing.T) {
		gitDir := filepath.Join(se.checkout, ".git")
		if o, c := sh(t, se.a, "touch '"+gitDir+"/seal-probe'"); c == 0 {
			t.Errorf("wrote into .git: %s", o)
		}
		if o, c := sh(t, se.a, "git -c user.name=s -c user.email=s@s commit --allow-empty -m seal"); c == 0 {
			t.Errorf("committed from the box: %s", o)
		}
		head, err := exec.Command("git", "-C", wt[se.a], "rev-parse", "HEAD").Output()
		if err != nil {
			t.Fatal(err)
		}
		if o, c := sh(t, se.a, "git log -1 --format=%H"); c != 0 || o != strings.TrimSpace(string(head)) {
			t.Errorf("git log in the box: %d %q, want %s", c, o, head)
		}
		if o, c := sh(t, se.a, "git status --porcelain"); c != 0 {
			t.Errorf("git status in the box: %d %s", c, o)
		}
		if o, c := sh(t, se.a, "mkdir -p seal-dir && echo hi > seal-dir/written"); c != 0 {
			t.Fatalf("cannot write the worktree: %s", o)
		}
		fi, err := os.Stat(filepath.Join(wt[se.a], "seal-dir/written"))
		if err != nil {
			t.Fatalf("the box's write is not on the host at the same path: %v", err)
		}
		st := fi.Sys().(*syscall.Stat_t)
		if int(st.Uid) != os.Getuid() || int(st.Gid) != os.Getgid() {
			t.Errorf("written as %d:%d, want %d:%d", st.Uid, st.Gid, os.Getuid(), os.Getgid())
		}
		if o, _ := sh(t, se.a, "echo $(id -u):$(id -g)"); o != fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid()) {
			t.Errorf("the box runs as %s", o)
		}
	})
	t.Run("C6 env is TEST_DATABASE_URL and HOME plus the image's own", func(t *testing.T) {
		var img []struct{ Config struct{ Env []string } }
		if err := json.Unmarshal([]byte(dockerOut(t, "image", "inspect", se.tag)), &img); err != nil || len(img) != 1 {
			t.Fatalf("image inspect: %v", err)
		}
		allowed := map[string]bool{"TEST_DATABASE_URL": true, "HOME": true, "HOSTNAME": true}
		for _, e := range img[0].Config.Env {
			k, _, _ := strings.Cut(e, "=")
			allowed[k] = true
		}
		// env itself, not through sh: a shell adds PWD/SHLVL of its own.
		o, _, _ := run(t, se.a, "", "env")
		got := map[string]string{}
		for _, line := range strings.Split(o, "\n") {
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			got[k] = v
			if !allowed[k] {
				t.Errorf("env %s=%s is neither §4.2's nor the image's", k, v)
			}
		}
		if got["TEST_DATABASE_URL"] != box.TestDatabaseURL || got["HOME"] != box.BoxHome {
			t.Errorf("TEST_DATABASE_URL=%q HOME=%q", got["TEST_DATABASE_URL"], got["HOME"])
		}
	})
	t.Run("C7 no capabilities, no new privileges, default seccomp and AppArmor", func(t *testing.T) {
		o, _ := sh(t, se.a, "cat /proc/self/status")
		want := map[string]string{"CapInh": "0000000000000000", "CapPrm": "0000000000000000", "CapEff": "0000000000000000",
			"CapBnd": "0000000000000000", "CapAmb": "0000000000000000", "NoNewPrivs": "1", "Seccomp": "2"}
		for _, line := range strings.Split(o, "\n") {
			k, v, _ := strings.Cut(line, ":")
			if w, ok := want[k]; ok {
				if strings.TrimSpace(v) != w {
					t.Errorf("%s = %s, want %s", k, strings.TrimSpace(v), w)
				}
				delete(want, k)
			}
		}
		if len(want) != 0 {
			t.Errorf("unread from /proc/self/status: %v", want)
		}
		if aa, err := os.ReadFile("/sys/module/apparmor/parameters/enabled"); err == nil && strings.TrimSpace(string(aa)) == "Y" {
			if o, _ := sh(t, se.a, "cat /proc/self/attr/current"); !strings.HasPrefix(o, "docker-default") {
				t.Errorf("AppArmor profile %q", o)
			}
		}
		hc := boxA.HostConfig
		if strings.Join(hc.CapDrop, ",") != "ALL" || len(hc.CapAdd) != 0 || hc.Privileged {
			t.Errorf("CapDrop %v CapAdd %v Privileged %v", hc.CapDrop, hc.CapAdd, hc.Privileged)
		}
		if strings.Join(hc.SecurityOpt, ",") != "no-new-privileges" {
			t.Errorf("SecurityOpt %v", hc.SecurityOpt)
		}
		if boxA.Config.User != fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid()) {
			t.Errorf("User %q", boxA.Config.User)
		}
	})
	t.Run("C8 limits are applied", func(t *testing.T) {
		hc := boxA.HostConfig
		if hc.Memory != 3<<30 || hc.PidsLimit == nil || *hc.PidsLimit != 512 || hc.NanoCpus != 2e9 {
			t.Errorf("Memory %d PidsLimit %v NanoCpus %d", hc.Memory, hc.PidsLimit, hc.NanoCpus)
		}
		if _, err := os.Stat("/sys/fs/cgroup/cgroup.controllers"); err == nil {
			o, _ := sh(t, se.a, "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max")
			if o != "3221225472\n512\n200000 100000" {
				t.Errorf("cgroup limits %q", o)
			}
		}
	})
	t.Run("C9 offline from the image caches: uv's part writable, the rest read-only", func(t *testing.T) {
		// Only the uv part of /deps takes a write; npm, go and the fetch
		// marker stay read-only.
		for p, want := range map[string]int{
			box.DepsMount + "/uv/seal-write": 0, box.DepsMount + "/npm/seal-write": 1,
			box.DepsMount + "/go/seal-write": 1, box.DepsMount + "/.nova-locks": 1, box.DepsMount + "/seal-write": 1,
		} {
			if o, c := sh(t, se.a, "touch '"+p+"' 2>&1"); (c == 0) != (want == 0) {
				t.Errorf("touch %s: exit %d (%s), want writable=%v", p, c, o, want == 0)
			}
		}
		// The core suite's exact command (suites.toml), so it runs as a whole
		// suite does: through the heavy path and the CPU lock.
		o, code, meta := run(t, se.a, "services/core", "uv", "run", "pytest")
		if code != 0 || !strings.Contains(o, "1 passed") {
			t.Errorf("uv run pytest in services/core: exit %d: %s", code, o)
		}
		if meta["heavy"] != true {
			t.Errorf("uv run pytest meta heavy = %v, want true (a whole suite)", meta["heavy"])
		}
		for _, c := range []struct{ dir, cmd string }{
			{"services/core", "uv sync --frozen --no-install-project"},
			{"apps/web", "npm ci --ignore-scripts"},
			{"apps/novad", "go mod download"},
			{"apps/novad", "go test ./sealprobe"},
		} {
			if o, code, _ := run(t, se.a, c.dir, "sh", "-c", c.cmd); code != 0 {
				t.Errorf("%s in %s: exit %d: %s", c.cmd, c.dir, code, o)
			}
		}
	})
	t.Run("C9 TEST_DATABASE_URL reaches its own Postgres", func(t *testing.T) {
		// The Postgres wire protocol by hand (stdlib only), so this row does
		// not lean on any installed package: startup as the URL's user and
		// database (trust auth), then ask the server its own address.
		py := `
import os, socket, struct, time, urllib.parse
u = urllib.parse.urlparse(os.environ["TEST_DATABASE_URL"])
def read(s, n):
    b = b""
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c:
            raise EOFError("server closed")
        b += c
    return b
def msg(s):
    h = read(s, 5)
    return h[:1], read(s, struct.unpack("!i", h[1:])[0] - 4)
err = None
for _ in range(60):
    try:
        s = socket.create_connection((u.hostname, u.port or 5432), timeout=3)
        p = b"user\0" + u.username.encode() + b"\0database\0" + u.path.lstrip("/").encode() + b"\0\0"
        s.sendall(struct.pack("!ii", 8 + len(p), 196608) + p)
        t, b = msg(s)
        while t != b"Z":
            if t == b"E":
                raise RuntimeError(b)
            t, b = msg(s)
        q = b"select host(inet_server_addr())\0"
        s.sendall(b"Q" + struct.pack("!i", 4 + len(q)) + q)
        t, b = msg(s)
        while t != b"D":
            if t == b"E":
                raise RuntimeError(b)
            t, b = msg(s)
        n = struct.unpack("!i", b[2:6])[0]
        print("open", b[6:6 + n].decode())
        break
    except Exception as e:
        err = e
        time.sleep(0.5)
else:
    print("closed", err)
`
		if o, _, _ := run(t, se.a, "", "python3", "-c", py); o != "open "+dbAIP {
			t.Errorf("TEST_DATABASE_URL: %q, want open %s", o, dbAIP)
		}
	})
	t.Run("C10 another change's box: no reach into A, its own fetched deps", func(t *testing.T) {
		if o := probeIn(t, se.b, "tcp", dbAIP, "5432"); !strings.HasPrefix(o, "closed") {
			t.Errorf("box B reached box A's db %s: %s", dbAIP, o)
		}
		if o := probeIn(t, se.b, "resolve", nA.DB); !strings.HasPrefix(o, "closed") {
			t.Errorf("box B resolved %s: %s", nA.DB, o)
		}
		if o := probeIn(t, se.b, "resolve", "db"); o != "open "+dbBIP {
			t.Errorf("box B's db is %q, want %s", o, dbBIP)
		}
		mod, ver, _ := strings.Cut(se.fetchedMod, "@")
		zip := box.DepsMount + "/go/cache/download/" + mod + "/@v/" + ver + ".zip"
		if o, c := sh(t, se.b, "test -f "+zip); c != 0 {
			t.Errorf("the fetch did not put %s in B's cache: %s", zip, o)
		}
		if o, code, _ := run(t, se.b, "apps/novad", "go", "mod", "download", se.fetchedMod); code != 0 {
			t.Errorf("offline go mod download %s in B: %s", se.fetchedMod, o)
		}
		if _, c := sh(t, se.a, "test -f "+zip); c == 0 {
			t.Errorf("A's cache holds %s too: B's fetch reached it", zip)
		}
		if o := dockerOut(t, "ps", "-aq", "--filter", "name=^"+nB.Fetch+"$"); o != "" {
			t.Errorf("a fetch container was left: %s", o)
		}
	})
	t.Run("C11 a change's own deploy/devbox never shapes its box", func(t *testing.T) {
		if se.changeTag == se.tag {
			t.Fatalf("the change's branch did not move its deploy/devbox tree (%s)", se.tag)
		}
		if boxA.Config.Image != se.tag {
			t.Errorf("box A runs %s, want main's %s", boxA.Config.Image, se.tag)
		}
		if metaA["image"] != se.tag {
			t.Errorf("box.exec meta image %v, want %s", metaA["image"], se.tag)
		}
	})
	t.Run("C13 a box job runs in the box, and job.stop kills it INSIDE the box (S30c T5)", func(t *testing.T) {
		// The shipped path: job.start with box args as core sends them, the
		// real `novad job-exec` wrapper (built from this tree by
		// seal_test.sh), the agent's own box manager.
		jdeps := caps.Deps{Box: m, Jobs: &caps.JobDeps{Store: jobs.NewStore(t.TempDir()), Binary: se.novad, Mode: "manual"}}
		inBox := func(t *testing.T, script string) string {
			t.Helper()
			return dockerOut(t, "exec", nA.Box, "sh", "-c", script)
		}
		procs := `for p in /proc/[0-9]*; do c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) && echo "${p#/proc/} $c"; done`
		pidOf := func(t *testing.T, id string) string {
			t.Helper()
			for i := 0; i < 100; i++ {
				if o, err := exec.Command("docker", "exec", nA.Box, "cat", box.JobPidfile(id)).Output(); err == nil {
					if p := strings.TrimSpace(string(o)); p != "" {
						return p
					}
				}
				time.Sleep(100 * time.Millisecond)
			}
			t.Fatalf("job %s wrote no pidfile in %s", id, nA.Box)
			return ""
		}
		start := func(t *testing.T, id, marker string) {
			t.Helper()
			out := caps.DispatchEnvelope(ctx, "seal-"+id, "job.start", map[string]any{
				"job_id": id, "change": se.a, "checkout": se.checkout, "branch": se.branch, "limits": limits,
				"cwd":  wt[se.a],
				"argv": []any{"sh", "-c", `echo "env:$SEAL_JOB_ENV planted:$SEAL_PLANTED_SECRET"; sleep ` + marker + ` & wait`},
				"env":  map[string]any{"SEAL_JOB_ENV": "job-env-" + id},
			}, jdeps)
			if !out.OK || out.Meta["ran_in"] != "box" || out.Meta["box"] != nA.Box || out.Meta["state"] != jobs.StateRunning {
				t.Fatalf("job.start: ok=%v meta=%v err=%q", out.OK, out.Meta, out.Error)
			}
		}
		alive := func(t *testing.T, marker string) bool {
			t.Helper()
			return strings.Contains(inBox(t, procs), "sleep "+marker)
		}

		// Control: killing only the host's docker exec client leaves the
		// process in the box running — the trap this row guards.
		const ctl, ctlMark = "5ea1c0000001", "3011"
		start(t, ctl, ctlMark)
		ctlPid := pidOf(t, ctl)
		j, err := jdeps.Jobs.Store.Get(ctl)
		if err != nil || j.Status.PID <= 0 {
			t.Fatalf("control job record: %+v %v", j.Status, err)
		}
		if err := syscall.Kill(-j.Status.PID, syscall.SIGKILL); err != nil {
			t.Fatalf("killing the control's docker client: %v", err)
		}
		time.Sleep(1500 * time.Millisecond)
		if !alive(t, ctlMark) {
			t.Fatal("killing the docker client ended the process in the box: the control is vacuous")
		}
		inBox(t, `kill -KILL -`+ctlPid+` 2>/dev/null || kill -KILL `+ctlPid)

		// The job: started in the box, stopped through job.stop.
		const id, mark = "5ea1c0000002", "3012"
		start(t, id, mark)
		pid := pidOf(t, id)
		if !alive(t, mark) || !strings.Contains(inBox(t, procs), pid+" sh -c") {
			t.Fatalf("the job is not running in the box (pid %s): %s", pid, inBox(t, procs))
		}
		stop := caps.Dispatch(ctx, "job.stop", map[string]any{"job_id": id}, jdeps)
		if !stop.OK || stop.Meta["state"] != jobs.StateStopped || strings.Contains(stop.Output, "may still run") {
			t.Fatalf("job.stop: ok=%v meta=%v out=%q err=%q", stop.OK, stop.Meta, stop.Output, stop.Error)
		}
		time.Sleep(500 * time.Millisecond)
		ps := inBox(t, procs)
		if strings.Contains(ps, "sleep "+mark) {
			t.Fatalf("after job.stop the job's child still runs in the box:\n%s", ps)
		}
		for _, line := range strings.Split(ps, "\n") {
			if strings.HasPrefix(line, pid+" ") {
				t.Fatalf("after job.stop pid %s still runs in the box: %q", pid, line)
			}
		}
		// The env value crossed by name only; the harness's own secret did not.
		lg := caps.Dispatch(ctx, "job.log", map[string]any{"job_id": id}, jdeps)
		if !strings.Contains(lg.Output, "env:job-env-"+id+" planted:\n") {
			t.Fatalf("job log %q", lg.Output)
		}
		raw, _ := os.ReadFile(filepath.Join(jdeps.Jobs.Store.Dir(id), jobs.SpecFile))
		if strings.Contains(string(raw), "job-env-"+id) {
			t.Fatalf("the env value reached spec.json: %s", raw)
		}
	})
	t.Run("C12 Remove takes down box, db, network and volume", func(t *testing.T) {
		for _, id := range []string{se.a, se.b} {
			if err := m.Remove(ctx, id); err != nil {
				t.Fatalf("Remove %s: %v", id, err)
			}
			for _, kind := range [][]string{
				{"ps", "-aq", "--filter", "label=" + box.Label + "=" + id},
				{"network", "ls", "-q", "--filter", "label=" + box.Label + "=" + id},
				{"volume", "ls", "-q", "--filter", "label=" + box.Label + "=" + id},
			} {
				if o := dockerOut(t, kind...); o != "" {
					t.Errorf("after Remove %s, %s still lists %s", id, kind[0], o)
				}
			}
		}
	})
}
