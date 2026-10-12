//go:build linux

package jobs

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// userSystemd skips unless a systemd --user manager answers here (CI
// runners and containers have none; this host does).
func userSystemd(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Skip("no systemd-run on this machine")
	}
	out, _ := exec.Command("systemctl", "--user", "is-system-running").Output()
	switch strings.TrimSpace(string(out)) {
	case "running", "degraded":
	default:
		t.Skipf("no systemd --user manager (is-system-running = %q)", out)
	}
}

func randHex(t *testing.T, n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

// spawnInUnit runs TestSpawnParentHelper as a throwaway KillMode=control-
// group user service (as novad itself runs), waits for its Spawn result,
// then stops the unit — systemd kills every process in its cgroup — and
// returns what Spawn said.
func spawnInUnit(t *testing.T, s *Store, id, mode string) (Spawned, string) {
	t.Helper()
	bin := stubNovad(t, filepath.Join(t.TempDir(), "rec"))
	dir, release := waitJob(t, s, id)
	result := filepath.Join(t.TempDir(), "result.json")
	unit := "novad-t3-test-" + randHex(t, 4)
	t.Cleanup(func() {
		killJob(s, id)
		_ = exec.Command("systemctl", "--user", "stop", unit+".service", "novad-job-"+id+".scope").Run()
		_ = exec.Command("systemctl", "--user", "reset-failed", unit+".service", "novad-job-"+id+".scope").Run()
	})
	args := []string{"--user", "--unit", unit, "-p", "KillMode=control-group", "--collect", "--quiet"}
	for _, kv := range []string{"JOBS_TEST_SPAWN_PARENT=1", "JOBS_TEST_BIN=" + bin, "JOBS_TEST_DIR=" + dir,
		"JOBS_TEST_MODE=" + mode, "JOBS_TEST_RESULT=" + result, "JOBS_TEST_HELPER=wait:" + release,
		"XDG_RUNTIME_DIR=" + os.Getenv("XDG_RUNTIME_DIR"), "DBUS_SESSION_BUS_ADDRESS=" + os.Getenv("DBUS_SESSION_BUS_ADDRESS"),
		"PATH=" + os.Getenv("PATH")} {
		args = append(args, "--setenv="+kv)
	}
	args = append(args, "--", testBin(t), "-test.run=^TestSpawnParentHelper$")
	if out, err := exec.Command("systemd-run", args...).CombinedOutput(); err != nil {
		t.Fatalf("systemd-run %v: %v %s", args, err, out)
	}
	sp := readResult(t, result)
	if out, err := exec.Command("systemctl", "--user", "stop", unit+".service").CombinedOutput(); err != nil {
		t.Fatalf("stop %s: %v %s", unit, err, out)
	}
	time.Sleep(200 * time.Millisecond)
	return sp, release
}

// C4: a job spawned by an agent in a systemd user unit survives that unit
// being stopped (a cgroup kill, as `systemctl --user restart novad` does).
func TestSpawnedJobSurvivesItsAgentsUnitStopping(t *testing.T) {
	userSystemd(t)
	s, _ := newStore(t)
	const id = "5a5a5a5a5a5a"
	sp, release := spawnInUnit(t, s, id, ModeSystemd)
	if sp.Status.State != StateRunning || !sp.SurvivesAgent || sp.Detach != "systemd scope novad-job-"+id {
		t.Fatalf("spawned = %+v", sp)
	}
	if !alive(sp.Status.WrapperPID) || !alive(sp.Status.PID) {
		t.Fatalf("the job died with its agent's unit: wrapper %d alive=%v child %d alive=%v",
			sp.Status.WrapperPID, alive(sp.Status.WrapperPID), sp.Status.PID, alive(sp.Status.PID))
	}
	end := endJob(t, s, id, release)
	if end.State != StateDone || end.ExitCode == nil || *end.ExitCode != 0 {
		t.Fatalf("end = %+v", end)
	}
}

// C4: the trap is real — setsid alone does not escape the unit's cgroup.
func TestWithoutTheScopeTheJobDiesWithTheUnit(t *testing.T) {
	userSystemd(t)
	s, _ := newStore(t)
	const id = "6b6b6b6b6b6b"
	sp, _ := spawnInUnit(t, s, id, "")
	if sp.Status.State != StateRunning || sp.Detach != "setsid" {
		t.Fatalf("spawned = %+v", sp)
	}
	if alive(sp.Status.WrapperPID) || alive(sp.Status.PID) {
		t.Fatalf("a setsid-only job outlived its unit's cgroup kill (wrapper %d, child %d): the scope test proves nothing",
			sp.Status.WrapperPID, sp.Status.PID)
	}
}
