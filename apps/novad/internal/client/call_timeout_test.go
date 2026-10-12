package client

import (
	"testing"
	"time"

	"novad/internal/caps"
)

// S30c T8: device_run's timeout_s ceiling (caps.MaxCallTimeoutS) is the
// agent's own command budget — one number, so a per-call budget can never
// claim more than handleCommand grants.
func TestMaxCallTimeoutIsTheCommandTimeout(t *testing.T) {
	if time.Duration(caps.MaxCallTimeoutS)*time.Second != CommandTimeout {
		t.Fatalf("caps.MaxCallTimeoutS = %d s, CommandTimeout = %s", caps.MaxCallTimeoutS, CommandTimeout)
	}
}
