package client

import (
	"os"
	"regexp"
	"strconv"
	"testing"
	"time"

	"novad/internal/caps"
)

// uac-timeout T1: the UAC wait plus the read-back fits inside this agent's
// command bound, and that bound inside core's wait — or the agent's answer
// lands after core has already said "did not answer" (turn 153578ab).
// Core's number is read from its source, never copied here.
func TestUACBudgetFitsUnderTheCommandBoundAndCores(t *testing.T) {
	src, err := os.ReadFile("../../../../services/core/app/tools/devices.py")
	if err != nil {
		t.Fatalf("reading core's command timeout: %v", err)
	}
	m := regexp.MustCompile(`(?m)^COMMAND_TIMEOUT_SECONDS = (\d+)\s*$`).FindSubmatch(src)
	if m == nil {
		t.Fatal("core's devices.py names no COMMAND_TIMEOUT_SECONDS = <n>")
	}
	n, _ := strconv.Atoi(string(m[1]))
	core := time.Duration(n) * time.Second
	if caps.UACWait+caps.ReadBackReserve >= CommandTimeout {
		t.Fatalf("UACWait %s + ReadBackReserve %s >= CommandTimeout %s", caps.UACWait, caps.ReadBackReserve, CommandTimeout)
	}
	if CommandTimeout >= core {
		t.Fatalf("CommandTimeout %s >= core's %s", CommandTimeout, core)
	}
	if caps.UACWait > 60*time.Second {
		t.Fatalf("UACWait %s: the design is 60 s, well under Windows' own ~2 min prompt timeout", caps.UACWait)
	}
}
