// Command novad is the Nova agent daemon: it enrolls a machine with a pairing
// code, then holds an outbound socket to core and executes only the ed25519
// one-use signed command envelopes it verifies on-device. The LLM never talks
// to novad; only core does.
//
// Subcommands: enroll | run | status | version.
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"novad/internal/audit"
	"novad/internal/client"
	"novad/internal/config"
)

// version is a const for now; S6 wires a -ldflags build stamp.
var version = "0.1.0-dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "enroll":
		cmdEnroll(os.Args[2:])
	case "run":
		cmdRun(os.Args[2:])
	case "status":
		cmdStatus(os.Args[2:])
	case "version":
		fmt.Printf("novad %s\n", version)
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `novad %s — the Nova agent daemon

usage:
  novad enroll --server <url> --code <code> [--name <name>] [--force]
  novad run
  novad status
  novad version
`, version)
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "novad: "+format+"\n", a...)
	os.Exit(1)
}

func cmdEnroll(argv []string) {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	server := fs.String("server", "", "core server URL, e.g. https://nova.example")
	code := fs.String("code", "", "the pairing code minted in Settings → Devices")
	name := fs.String("name", "", "device name (default: hostname)")
	force := fs.Bool("force", false, "overwrite an existing enrollment")
	_ = fs.Parse(argv)

	if *server == "" || *code == "" {
		fail("enroll needs --server and --code")
	}
	paths, err := config.DefaultPaths()
	if err != nil {
		fail("%v", err)
	}
	if paths.Enrolled() && !*force {
		fail("already enrolled (%s); re-enrolling is deliberate — pass --force", paths.ConfigFile)
	}

	hostname, _ := os.Hostname()
	devName := *name
	if devName == "" {
		devName = hostname
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		fail("could not generate a device key: %v", err)
	}

	reqBody, err := enrollBody(*code, hex.EncodeToString(pub), devName, hostname)
	if err != nil {
		fail("could not build the enroll request: %v", err)
	}
	enrollURL := strings.TrimRight(*server, "/") + "/api/v1/devices/enroll"

	httpc := &http.Client{Timeout: 15 * time.Second}
	resp, err := httpc.Post(enrollURL, "application/json", bytes.NewReader(reqBody))
	if err != nil {
		fail("could not reach %s: %v", enrollURL, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode != http.StatusOK {
		// Surface the server's own reason verbatim (spent/expired code, name taken).
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &e) == nil && e.Error != "" {
			fail("enrollment refused (%d): %s", resp.StatusCode, e.Error)
		}
		fail("enrollment refused (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var ok struct {
		DeviceID   string `json:"device_id"`
		Name       string `json:"name"`
		CorePubKey string `json:"core_pubkey"`
	}
	if err := json.Unmarshal(body, &ok); err != nil {
		fail("enrollment response was unreadable: %v", err)
	}
	if ok.DeviceID == "" || ok.CorePubKey == "" {
		fail("enrollment response was missing device_id or core_pubkey")
	}

	cfg := config.Config{
		DeviceID:   ok.DeviceID,
		Name:       ok.Name,
		Server:     strings.TrimRight(*server, "/"),
		CorePubKey: ok.CorePubKey,
	}
	if err := config.Save(paths, cfg, priv); err != nil {
		fail("could not save enrollment: %v", err)
	}

	fmt.Printf("enrolled as %q (device %s)\n", ok.Name, ok.DeviceID)
	fmt.Printf("core key pinned: %s…\n", shortKey(ok.CorePubKey))
	fmt.Printf("config: %s\n", paths.ConfigFile)
	fmt.Printf("\nnext: run `novad run` in a desktop session, or install the user service (see README).\n")
}

// enrollBody is the POST /api/v1/devices/enroll payload: the pairing code and
// the identity this machine will be known by. Nothing else travels — core has
// no per-device settings to seed.
func enrollBody(code, pubkeyHex, name, hostname string) ([]byte, error) {
	return json.Marshal(map[string]string{
		"code":     code,
		"pubkey":   pubkeyHex,
		"name":     name,
		"platform": "linux",
		"hostname": hostname,
	})
}

func cmdRun(argv []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	_ = fs.Parse(argv)

	paths, err := config.DefaultPaths()
	if err != nil {
		fail("%v", err)
	}
	cfg, priv, err := config.Load(paths)
	if err != nil {
		fail("%v", err)
	}
	auditLog, err := audit.Open(paths.AuditFile)
	if err != nil {
		fail("could not open the audit log: %v", err)
	}

	logger := log.New(os.Stderr, "novad ", log.LstdFlags)
	agent, err := client.New(cfg, priv, auditLog, paths.Home, func(format string, a ...any) {
		logger.Printf(format, a...)
	})
	if err != nil {
		fail("%v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Printf("device %s connecting to %s", cfg.DeviceID, cfg.Server)
	if err := agent.Run(ctx); err != nil && ctx.Err() == nil {
		fail("run stopped: %v", err)
	}
	logger.Printf("stopped")
}

func cmdStatus(argv []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	_ = fs.Parse(argv)

	paths, err := config.DefaultPaths()
	if err != nil {
		fail("%v", err)
	}
	if !paths.Enrolled() {
		fmt.Printf("not enrolled — run `novad enroll` first\n")
		fmt.Printf("config dir: %s\n", paths.ConfigDir)
		os.Exit(0)
	}
	cfg, _, err := config.Load(paths)
	if err != nil {
		fail("%v", err)
	}

	fmt.Printf("device_id:   %s\n", cfg.DeviceID)
	fmt.Printf("name:        %s\n", cfg.Name)
	fmt.Printf("server:      %s\n", cfg.Server)
	fmt.Printf("config:      %s (present)\n", paths.ConfigFile)
	fmt.Printf("key:         %s (present)\n", paths.KeyFile)
	fmt.Printf("core key:    %s… (pinned)\n", shortKey(cfg.CorePubKey))

	if auditLog, err := audit.Open(paths.AuditFile); err == nil {
		fmt.Printf("audit:       %s (last seq %d)\n", paths.AuditFile, auditLog.LastSeq())
	} else {
		fmt.Printf("audit:       %s (unreadable: %v)\n", paths.AuditFile, err)
	}

	// A reachability probe — the HTTP server answered — NOT proof of a
	// connected, authenticated socket. We never claim "connected" here.
	reachable, detail := probe(cfg.Server)
	if reachable {
		fmt.Printf("server:      reachable (%s)\n", detail)
	} else {
		fmt.Printf("server:      NOT reachable (%s)\n", detail)
	}
}

// probe does a short HTTP GET to the server root; any HTTP answer (even 401/404)
// proves reachability. A transport error means not reachable. It never asserts
// the daemon is authenticated or connected.
func probe(server string) (bool, string) {
	httpc := &http.Client{Timeout: 4 * time.Second}
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(server, "/")+"/api/v1/health", nil)
	if err != nil {
		return false, err.Error()
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return false, err.Error()
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return true, fmt.Sprintf("HTTP %d", resp.StatusCode)
}

func shortKey(hexKey string) string {
	if len(hexKey) < 8 {
		return hexKey
	}
	return hexKey[:8]
}
