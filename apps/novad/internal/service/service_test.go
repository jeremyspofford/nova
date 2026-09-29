package service

import (
	"encoding/xml"
	"strings"
	"testing"
)

// P3: supervise exits 0 when the agent can never get in, so a unit that
// restarts only on failure leaves a revoked device stopped.
func TestTheUnitRestartsOnlyOnFailure(t *testing.T) {
	u := SystemdUnit("/home/sam/.local/bin/novad")
	for _, want := range []string{
		"ExecStart=/home/sam/.local/bin/novad supervise --mode systemd-user\n",
		"Restart=on-failure\n",
		"RestartPreventExitStatus=78\n",
		"WantedBy=default.target\n",
	} {
		if !strings.Contains(u, want) {
			t.Errorf("unit lacks %q:\n%s", want, u)
		}
	}
	if strings.Contains(u, "Restart=always") {
		t.Fatal("Restart=always would restart a supervisor that stopped for good")
	}
}

func TestTheUnitQuotesAPathWithASpaceOrASpecifier(t *testing.T) {
	u := SystemdUnit("/home/sam doe/bin/novad%x")
	if !strings.Contains(u, `ExecStart="/home/sam doe/bin/novad%%x" supervise --mode systemd-user`) {
		t.Fatalf("got:\n%s", u)
	}
}

func TestThePlistDoesNotRestartACleanExit(t *testing.T) {
	p := LaunchAgentPlist("/Users/sam/Library/Application Support/Nova/novad", "/Users/sam/Library/Logs/novad&.log")
	for _, want := range []string{
		"<key>Label</key><string>nova.novad</string>",
		"<string>/Users/sam/Library/Application Support/Nova/novad</string>",
		"<string>supervise</string>", "<string>--mode</string>", "<string>launch-agent</string>",
		"<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
		"<key>RunAtLoad</key><true/>",
		"novad&amp;.log",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("plist lacks %q", want)
		}
	}
	var v struct{ XMLName xml.Name }
	if err := xml.Unmarshal([]byte(p), &v); err != nil || v.XMLName.Local != "plist" {
		t.Fatalf("not a well-formed plist: %v", err)
	}
}

// A profile path can hold a space; unquoted, Windows would try to run
// C:\Users\Jane and pass the rest as arguments.
func TestTheRunKeyValueQuotesAPathWithSpaces(t *testing.T) {
	got := RunKeyCommand(`C:\Users\Jane Doe\AppData\Local\Programs\Nova\novad.exe`)
	want := `"C:\Users\Jane Doe\AppData\Local\Programs\Nova\novad.exe" supervise --mode run-key`
	if got != want {
		t.Fatalf("got %s\nwant %s", got, want)
	}
}
