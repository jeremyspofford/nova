// Package service registers novad's per-user service on each OS (hub D3,
// S42b): a systemd user unit (plus linger) on Linux, one LaunchAgent on
// macOS, the HKCU Run key on Windows. Each starts `novad supervise`, the
// parent on every OS. No admin rights anywhere: system services are a seam
// (S42c's helper is the first).
package service

import (
	"context"
	"encoding/xml"
	"strings"
	"time"
)

const (
	UnitName    = "novad.service"
	Label       = "nova.novad"
	RunKeyPath  = `Software\Microsoft\Windows\CurrentVersion\Run`
	RunKeyValue = "Nova agent"

	ModeSystemd = "systemd-user"
	ModeLaunch  = "launch-agent"
	ModeRunKey  = "run-key"
)

// Manager installs, starts, stops and removes the agent's service here.
type Manager interface {
	Mode() string
	// Describe says how the agent starts by itself, for a person.
	Describe() string
	// Installed is whether the definition (unit, plist, Run value) exists.
	Installed() bool
	// Install writes the definition for bin; it starts nothing.
	Install(bin string) error
	// Restart stops any running instance and starts the service now.
	Restart(ctx context.Context) error
	// RestartLater schedules a restart outside the caller's process tree —
	// for an install run through the old agent's own hands (P11).
	RestartLater(ctx context.Context, after time.Duration) error
	Stop(ctx context.Context) error
	// Uninstall stops the agent, then removes the definition — even when the
	// stop failed, so an agent that would not stop does not also start again
	// at the next sign-in. stopErr is the stop's failure: the agent may still
	// be running, and nothing may say it is offline (Task 32, L90). err is the
	// removal's.
	Uninstall(ctx context.Context) (stopErr, err error)
	// BootStart reports whether the agent starts before anyone logs in, and
	// a sentence saying so (Linux linger; the others start at sign-in).
	BootStart(ctx context.Context) (bool, string, error)
}

// SystemdUnit is the user unit for bin. It restarts only on failure: supervise
// exits 0 when the agent can never get in (P3). 78 stays named for an agent
// from before S42b that a hand-written unit still runs directly.
func SystemdUnit(bin string) string {
	return "[Unit]\n" +
		"Description=Nova agent (novad)\n" +
		"After=network-online.target\n" +
		"Wants=network-online.target\n\n" +
		"[Service]\n" +
		"ExecStart=" + systemdQuote(bin) + " supervise --mode " + ModeSystemd + "\n" +
		"Restart=on-failure\n" +
		"RestartSec=5\n" +
		"RestartPreventExitStatus=78\n\n" +
		"[Install]\n" +
		"WantedBy=default.target\n"
}

// systemdQuote quotes an ExecStart path that needs it (systemd.syntax:
// C-style quotes; % is doubled so it is not a specifier). A literal $ is left
// as-is: unlike %, systemd does NOT collapse a doubled $$ back to one $ in
// the executable path (systemd-analyze verify rejects the doubled form as
// "not executable"), so escaping it would corrupt the path instead of
// protecting it. A $ still forces quoting when it appears with something
// else that needs it (a space, say); it is still subject to systemd's own
// variable expansion either way, quoted or not — this function cannot change
// that, only avoid making it worse.
func systemdQuote(p string) string {
	if !strings.ContainsAny(p, " \t\"\\'$%;") {
		return p
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`)
	return `"` + r.Replace(p) + `"`
}

// LaunchAgentPlist is the per-user LaunchAgent for bin (macOS, unwalked).
// KeepAlive restarts it only after an unclean exit (P3); RunAtLoad starts it
// at login.
func LaunchAgentPlist(bin, logPath string) string {
	esc := func(s string) string {
		var b strings.Builder
		_ = xml.EscapeText(&b, []byte(s))
		return b.String()
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>` + Label + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + esc(bin) + `</string>
    <string>supervise</string>
    <string>--mode</string>
    <string>` + ModeLaunch + `</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>` + esc(logPath) + `</string>
  <key>StandardErrorPath</key><string>` + esc(logPath) + `</string>
</dict>
</plist>
`
}

// RunKeyCommand is the HKCU Run value: the binary QUOTED, supervise, the mode.
func RunKeyCommand(bin string) string { return `"` + bin + `" supervise --mode ` + ModeRunKey }
