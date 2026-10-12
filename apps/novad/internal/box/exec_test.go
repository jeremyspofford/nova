package box

import (
	"reflect"
	"testing"
)

func TestExecArgvRunsInTheBoxAsTheOwnerInTheCwd(t *testing.T) {
	req := Request{Checkout: "/srv/repo", Change: "c0ffee", Branch: "trunk", Cwd: "/srv/repo/.worktrees/nova-c0ffee/apps/web"}
	m := &Manager{UID: 1234, GID: 5678, DockerBin: "/opt/bin/docker"}
	got := m.ExecArgv(req, []string{"npm", "test"})
	want := []string{"/opt/bin/docker", "exec", "-w", req.Cwd, "-u", "1234:5678", "nova-box-c0ffee", "npm", "test"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
	if got := (&Manager{UID: 1, GID: 2}).ExecArgv(req, []string{"ls"})[0]; got != "docker" {
		t.Fatalf("an empty DockerBin runs %q, want docker", got)
	}
}
