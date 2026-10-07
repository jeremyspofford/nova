package install

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"novad/internal/config"
)

// hubAnswering is a test hub whose enroll route answers status and body; it
// counts the requests that reached it.
func hubAnswering(t *testing.T, status int, body string) (string, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/devices/enroll" {
			http.NotFound(w, r)
			return
		}
		hits.Add(1)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv.URL, &hits
}

func enrolledAnswer() string {
	return `{"device_id":"d-new","name":"laptop","core_pubkey":"` + strings.Repeat(core, 32) + `","repaired":false}`
}

// pairThrough pairs a new machine through hubs with the real Enroll.
func pairThrough(t *testing.T, hubs ...string) (config.Config, error) {
	t.Helper()
	o, _ := opts(t, paths(t), nil, nil)
	o.Hubs, o.Code, o.Enroll = hubs, "ABCD-2345", Enroll
	cfg, _, err := o.identity(context.Background())
	return cfg, err
}

// Task 32, L222: only the hub's own refusal of this request is final. A
// status with no reason Nova states — a reverse proxy's 502, a CDN's 403
// page — or Nova's 429, which limits one door and not the code, is no answer
// about the code: the next address is tried, as after a network error.
func TestAnAnswerThatIsNotTheHubsRefusalFallsThroughToTheNextAddress(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"a proxy's 502", http.StatusBadGateway, "<html><body>502 Bad Gateway</body></html>"},
		{"a 403 page that is not Nova's", http.StatusForbidden, "<html>Access denied by the edge</html>"},
		{"Nova's 429 on one door", http.StatusTooManyRequests, `{"error":"too many failed enrollments came this way — try again in 15 minutes"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			first, _ := hubAnswering(t, tc.status, tc.body)
			second, hits := hubAnswering(t, http.StatusOK, enrolledAnswer())
			cfg, err := pairThrough(t, first, second)
			if err != nil || cfg.Server != second || hits.Load() != 1 {
				t.Fatalf("cfg %+v, err %v, second asked %d time(s) — want paired through the second address", cfg, err, hits.Load())
			}
		})
	}
}

// The hub's own refusal — a spent code, in its stated words — is still final:
// the code is dead at every address of that hub, so no other is asked.
func TestTheHubsStatedRefusalIsFinal(t *testing.T) {
	first, _ := hubAnswering(t, http.StatusForbidden, `{"error":"that pairing code is not usable — it is unknown, expired, or already used"}`)
	second, hits := hubAnswering(t, http.StatusOK, enrolledAnswer())
	_, err := pairThrough(t, first, second)
	var refused *EnrollRefused
	if !errors.As(err, &refused) || refused.Status != http.StatusForbidden || !strings.Contains(refused.Reason, "already used") {
		t.Fatalf("got %v, want the hub's 403 in its own words", err)
	}
	if hits.Load() != 0 {
		t.Fatal("a final refusal was retried on another address")
	}
}

// A later address's answer never replaces what an earlier one said: the
// first may have spent the code before its answer was lost, and "already
// used" alone would hide that.
func TestWhatAnEarlierAddressSaidIsKeptBesideTheFinalRefusal(t *testing.T) {
	first, _ := hubAnswering(t, http.StatusBadGateway, "<html>502</html>")
	second, _ := hubAnswering(t, http.StatusForbidden, `{"error":"that pairing code is not usable — it is unknown, expired, or already used"}`)
	_, err := pairThrough(t, first, second)
	var refused *EnrollRefused
	if !errors.As(err, &refused) || !strings.Contains(err.Error(), "already used") ||
		!strings.Contains(err.Error(), first+"/api/v1/devices/enroll answered 502 Bad Gateway") {
		t.Fatalf("got %v, want the final refusal with the first address's 502 beside it", err)
	}
	if strings.Contains(err.Error(), "<html>") {
		t.Fatalf("a page that is not Nova's was repeated as words: %v", err)
	}
}
