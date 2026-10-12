//go:build unix

package client

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"reflect"
	"testing"
	"time"

	"novad/internal/jobs"
)

// S30c T5 C6: the agent's box manager reads its live box jobs from the job
// store under its state dir, so Reap never stops a box running a job.
func TestTheBoxManagerReadsLiveJobsFromTheStateDir(t *testing.T) {
	corePub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, devPriv, _ := ed25519.GenerateKey(rand.Reader)
	agent, _ := buildAgent(t, "http://unused.invalid", "dev-jobs-box", hex.EncodeToString(corePub), devPriv)
	if agent.deps.Box == nil {
		t.Fatal("no box manager on a unix agent")
	}
	stateDir := t.TempDir()
	s := jobs.NewStore(stateDir)
	sp := jobs.Spec{ID: "f0f0f0f0f0f1", Argv: []string{"sleep", "9"}, CreatedAt: time.Now().UTC(),
		Box: &jobs.BoxRef{Change: "beef01", Container: "nova-box-beef01"}}
	if err := s.Create(sp); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteStatus(sp.ID, jobs.Status{State: jobs.StateRunning, PID: 1}); err != nil {
		t.Fatal(err)
	}
	agent.Configure(Options{StateDir: stateDir})
	if agent.deps.Box.Busy == nil {
		t.Fatal("the box manager has no view of the jobs")
	}
	got, err := agent.deps.Box.Busy()
	if err != nil || !reflect.DeepEqual(got, map[string]bool{"beef01": true}) {
		t.Fatalf("busy = %v %v", got, err)
	}
}
