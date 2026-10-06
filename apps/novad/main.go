// Command novad is the Nova agent daemon: it enrolls a machine with a pairing
// code, then holds an outbound socket to core and executes only the ed25519
// one-use signed command envelopes it verifies on-device. The LLM never talks
// to novad; only core does.
//
// Subcommands: enroll | repoint | run | status | version | install | uninstall | supervise.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"novad/internal/audit"
	"novad/internal/client"
	"novad/internal/config"
	"novad/internal/install"
	"novad/internal/platform"
	"novad/internal/state"
	"novad/internal/supervise"
)

// version is the build stamp: builds set it with
// -ldflags "-X main.version=<rev>" (CI and the walk build do; see README).
var version = "0.2.0-dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "enroll":
		cmdEnroll(os.Args[2:])
	case "repoint":
		cmdRepoint(os.Args[2:])
	case "run":
		cmdRun(os.Args[2:])
	case "install":
		cmdInstall(os.Args[2:])
	case "uninstall":
		cmdUninstall(os.Args[2:])
	case "supervise":
		cmdSupervise(os.Args[2:])
	case "status":
		cmdStatus(os.Args[2:])
	case "version":
		fmt.Printf("novad %s\n", version)
	default:
		usage()
		os.Exit(2)
	}
}

func usage() { fmt.Fprint(os.Stderr, usageText()) }

func usageText() string {
	return fmt.Sprintf(`novad %s — the Nova agent daemon

usage:
  novad enroll --server <url> --code <code> [--name <name>] [--force]
  novad repoint --server <url> [--check]
  novad run
  novad install [--hub <url>]... [--code <code>] [--name <name>] [--if-missing] [--restart-later]
  novad uninstall [--forget]
  novad supervise --mode <systemd-user|launch-agent|run-key>
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
	if err := enrollPreflight(); err != nil {
		fail("%v", err)
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

	// install.Enroll is the one enroll call (S42b): its errors are this
	// command's own words — "could not reach <url>: …", the server's reason
	// verbatim as "enrollment refused (<status>): <reason>" (spent/expired
	// code, name taken), or an unreadable answer.
	ok, err := install.Enroll(context.Background(), *server, *code, devName, hostname, pub)
	if err != nil {
		fail("%v", err)
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

// inWSL is platform.WSL, a variable so a test can say "inside WSL".
var inWSL = func() bool { in, _ := platform.WSL(); return in }

// executablePath is os.Executable, a variable so a test can make it fail.
var executablePath = os.Executable

// selfBinary is cmdRun's own path — daemon.update stages a build beside it,
// so it must be a real, absolute path, never a silently empty Binary that
// only surfaces much later as a mysterious daemon.update refusal (fix round
// 1, Minor 2: main.go used to discard os.Executable's error).
func selfBinary() (string, error) {
	self, err := executablePath()
	if err != nil {
		return "", fmt.Errorf("could not determine this executable's own path: %w", err)
	}
	return self, nil
}

// enrollPreflight refuses to enroll inside WSL (hub decision D1): on Windows,
// Nova's agent runs on Windows itself and reaches WSL through wsl.exe and
// \\wsl.localhost. An agent inside WSL cannot reach Windows' desktop,
// adapters or sleep settings — the machine belongs to its Windows agent.
func enrollPreflight() error {
	if inWSL() {
		return errors.New("cannot: on Windows, Nova's agent runs on Windows itself; " +
			"run the Windows command (novad.exe enroll) in PowerShell, not this one inside WSL")
	}
	return nil
}

// enrollBody is the POST /api/v1/devices/enroll payload: the pairing code and
// the identity this machine will be known by. Nothing else travels — core has
// no per-device settings to seed. It is install.Body, the one builder `enroll`
// and `install` share; the S42a pin (TestEnrollBodyCarriesIdentityOnly) stays
// here.
func enrollBody(code, pubkeyHex, name, hostname string) ([]byte, error) {
	return install.Body(code, pubkeyHex, name, hostname)
}

// exitConfig (EX_CONFIG, 78) is the exit status for "this daemon has no
// identity to run as" — never enrolled, or revoked. The wipe is attempted
// either way, and 78 covers both outcomes (a clean wipe, or one that could
// not fully remove everything): restarting cannot help in either case, so
// this is the ONE status novad.service's RestartPreventExitStatus names, and
// systemd stops instead of restarting a daemon that can never get in.
const exitConfig = 78

// exitUpdateStaged is `novad run`'s exit after daemon.update staged a build:
// the supervisor (internal/supervise) swaps it in and confirms or rolls it
// back. Fix round 1, Minor 1: named FROM supervise.ExitUpdateStaged (the
// value that code actually consumes at the OS boundary), not a second
// literal 75 that could quietly drift from it.
const exitUpdateStaged = supervise.ExitUpdateStaged

// afterFailedWipe turns a config.Wipe failure into an instruction built from
// what is ACTUALLY still on disk, checked fresh rather than assumed from
// which of Wipe's three independent steps (config, key, audit) errored — any
// one of them may already have succeeded. A file Lstat cannot confirm gone is
// named; a file already confirmed gone is not — so an operator who does
// exactly what this says, then re-enrolls, never replays a revoked device's
// audit chain under the new id (P5's whole reason config.Wipe renames
// audit.jsonl instead of deleting it, and afterRun's own reason to exist:
// the status must say what is true on disk).
func afterFailedWipe(paths config.Paths, werr error) string {
	// "Still there" errs toward CAUTION: only a confirmed-missing (ErrNotExist)
	// Lstat suppresses the instruction. Any other outcome — it exists, or Wipe
	// could not even check (EACCES, ENOTDIR, ...) — is named, because staying
	// silent about a file that might still be live is the failure mode this
	// whole finding is about.
	stillThere := func(p string) bool {
		_, err := os.Lstat(p)
		return err == nil || !errors.Is(err, fs.ErrNotExist)
	}
	var toDelete []string
	for _, f := range []string{paths.ConfigFile, paths.KeyFile} {
		if stillThere(f) {
			toDelete = append(toDelete, f)
		}
	}
	var clauses []string
	if len(toDelete) > 0 {
		clauses = append(clauses, fmt.Sprintf("delete %s by hand", strings.Join(toDelete, " and ")))
	}
	if stillThere(paths.AuditFile) {
		clauses = append(clauses, fmt.Sprintf("move %s aside before pairing again", paths.AuditFile))
	}
	msg := fmt.Sprintf("this device was revoked in Nova, and wiping its identity failed: %v", werr)
	if len(clauses) > 0 {
		msg += " — " + strings.Join(clauses, "; ")
	}
	return msg
}

// afterRun turns Run's return into the exit status and the line to print. A
// revoke wipes the identity FIRST, so the status says what is true on disk.
// Even a wipe that only PARTLY succeeds still exits exitConfig, never 1:
// restarting cannot help either way — core will refuse this same device
// again at the very next handshake — so a supervisor must not loop on it.
// The message never claims a clean wipe when the disk says otherwise, and
// names the audit log's new path only when one genuinely existed and moved
// (a device that never ran has no audit.jsonl to claim was set aside).
func afterRun(paths config.Paths, err error, now time.Time) (int, string) {
	switch {
	case err == nil:
		return 0, ""
	case errors.Is(err, client.ErrRevoked):
		asidePath, werr := config.Wipe(paths, now)
		if werr != nil {
			return exitConfig, afterFailedWipe(paths, werr)
		}
		msg := "this device was revoked in Nova — its identity is wiped (config and key removed"
		if asidePath != "" {
			msg += fmt.Sprintf(", the audit log set aside as %s", asidePath)
		}
		msg += "). Pair it again with `novad enroll`."
		return exitConfig, msg
	case errors.Is(err, client.ErrRestartForUpdate):
		return exitUpdateStaged, "a new build is staged — exiting so the supervisor swaps it in"
	default:
		return 1, fmt.Sprintf("run stopped: %v", err)
	}
}

func cmdRun(argv []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	_ = fs.Parse(argv)

	paths, err := config.DefaultPaths()
	if err != nil {
		fail("%v", err)
	}
	// config.ErrNotEnrolled only when the config or key is confirmed MISSING
	// (exit 78: re-enrolling is the fix); any other failure to check is the
	// real cause and exits 1 — re-enrolling cannot fix it.
	if err := paths.CheckEnrolled(); err != nil {
		if errors.Is(err, config.ErrNotEnrolled) {
			fmt.Fprintf(os.Stderr, "novad: not enrolled — run `novad enroll` first (config dir: %s)\n", paths.ConfigDir)
			os.Exit(exitConfig)
		}
		fail("could not check enrollment: %v", err)
	}
	cfg, priv, err := config.Load(paths)
	if err != nil {
		fail("%v", err)
	}

	logger := log.New(os.Stderr, "novad ", log.LstdFlags)
	writeStatus := agentStatusWriter(paths.StateDir, logger)

	lock, err := holdIdentity(paths.StateDir, writeStatus)
	if err != nil {
		// Exit 1, never 78: the other copy may stop, and a supervisor retries.
		fail("%v — this identity is already running; stop that copy first", err)
	}
	defer lock.Release()
	writeStatus(state.StateStarting, cfg.Server, nil)

	auditLog, err := audit.Open(paths.AuditFile)
	if err != nil {
		fail("could not open the audit log: %v", err)
	}

	agent, err := client.New(cfg, priv, auditLog, paths.Home, version, func(format string, a ...any) {
		logger.Printf(format, a...)
	})
	if err != nil {
		fail("%v", err)
	}
	self, err := selfBinary()
	if err != nil {
		fail("%v", err)
	}
	agent.Configure(client.Options{StateDir: paths.StateDir, Supervised: platform.Supervised(), Binary: self,
		Config: paths.ConfigFile, OnState: writeStatus})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Printf("device %s connecting to %s", cfg.DeviceID, cfg.Server)
	runErr := agent.Run(ctx)
	writeStatus(state.StateStopped, "", runErr)
	if ctx.Err() != nil {
		logger.Printf("stopped")
		return
	}
	code, msg := afterRun(paths, runErr, time.Now())
	if msg != "" {
		fmt.Fprintf(os.Stderr, "novad: %s\n", msg)
	}
	os.Exit(code)
}

// agentStatusWriter is `novad run`'s writer of agent-status.json: each call
// writes the whole status, as this process, now.
func agentStatusWriter(stateDir string, logger *log.Logger) func(st, server string, e error) {
	statusPath := filepath.Join(stateDir, state.AgentStatusFile)
	return func(st, server string, e error) {
		s := state.AgentStatus{V: 1, PID: os.Getpid(), Version: version, Mode: platform.Mode(),
			State: st, Server: server, Since: time.Now().UTC()}
		if e != nil {
			s.Error = e.Error()
		}
		if err := state.WriteJSON(statusPath, s); err != nil {
			logger.Printf("could not write %s: %v", statusPath, err)
		}
	}
}

// holdIdentity takes run.lock, one copy per identity (P5). Refused, the
// supervisor's own child writes the refusal into agent-status.json before it
// is returned: that child is the one install's restart started, and install
// names the copy holding the identity from it (Review Focus 4). Any other
// copy writes nothing there — the file is the running holder's, and
// supervise's swap confirmation and install --if-missing decide on it — so
// its refusal, naming the holder's pid, is only on its own stderr (fix round
// 1, controller ruling).
func holdIdentity(stateDir string, writeStatus func(st, server string, e error)) (*state.Lock, error) {
	lock, err := state.Acquire(filepath.Join(stateDir, state.RunLockFile))
	if err != nil {
		if supervisorsChild() {
			writeStatus(state.StateStopped, "", err)
		}
		return nil, err
	}
	return lock, nil
}

// supervisorsChild is whether this process is the child a supervisor
// started: platform.Supervised() — NOVA_SUPERVISOR_PID is set — and that
// supervisor is this process's parent, as supervise starts its agent
// directly. The variable alone is not enough: every program the agent runs
// for her inherits it, so a `novad run` started through her hands would pass
// for the supervisor's own child.
func supervisorsChild() bool {
	if !platform.Supervised() {
		return false
	}
	pid, err := strconv.Atoi(os.Getenv(platform.SupervisorEnv))
	return err == nil && pid > 0 && pid == os.Getppid()
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

	for _, line := range statusLines(paths.StateDir) {
		fmt.Println(line)
	}
}

// statusLines says what the status files in stateDir say — and that there is
// none when there is none, never a guess. A file that is there but cannot be
// read is said to be unreadable, with why: it is never read as one that was
// never written (Task 32, L61). A "ready" is what the agent last wrote, not a
// live probe; the reachability line above it is the probe.
func statusLines(stateDir string) []string {
	var out []string
	var a state.AgentStatus
	switch err := state.ReadJSON(filepath.Join(stateDir, state.AgentStatusFile), &a); {
	case errors.Is(err, fs.ErrNotExist):
		out = append(out, "agent:       no status yet (it has not run since S42b's build)")
	case err != nil:
		out = append(out, "agent:       status unknown — "+err.Error())
	default:
		line := fmt.Sprintf("agent:       %s since %s (pid %d, %s, build %s)", a.State,
			a.Since.UTC().Format(time.RFC3339), a.PID, a.Mode, a.Version)
		if a.Server != "" {
			line += " via " + a.Server
		}
		out = append(out, line)
		if a.Error != "" {
			out = append(out, "             last error: "+a.Error)
		}
	}
	var s state.SupervisorStatus
	switch err := state.ReadJSON(filepath.Join(stateDir, state.SupervisorStatusFile), &s); {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		out = append(out, "supervisor:  status unknown — "+err.Error())
	default:
		line := fmt.Sprintf("supervisor:  pid %d, %d restarts", s.PID, s.Restarts)
		if s.LastExit != nil {
			line += fmt.Sprintf(", last exit %d", *s.LastExit)
		}
		out = append(out, line)
	}
	var u state.Update
	switch err := state.ReadJSON(filepath.Join(stateDir, state.UpdateFile), &u); {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		out = append(out, "last update: unknown — "+err.Error())
	default:
		line := fmt.Sprintf("last update: %s %s at %s", u.Outcome, u.Version, u.At.UTC().Format(time.RFC3339))
		if u.Reason != "" {
			line += " — " + u.Reason
		}
		out = append(out, line)
	}
	return out
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
