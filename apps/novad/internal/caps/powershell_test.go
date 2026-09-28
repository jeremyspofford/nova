package caps

import (
	"strings"
	"testing"

	"novad/internal/platform"
)

// Review focus 3: the message reaches the toast as UTF-8 BYTES from stdin —
// never through [Console]::In, whose code page would mangle "Café ☕".
func TestTheToastScriptReadsTheMessageAsUTF8Bytes(t *testing.T) {
	for _, want := range []string{"OpenStandardInput", "UTF8.GetString"} {
		if !strings.Contains(toastScript, want) {
			t.Errorf("toastScript must contain %q", want)
		}
	}
	if strings.Contains(toastScript, "[Console]::In.") {
		t.Error("[Console]::In decodes with the console code page; read the raw bytes")
	}
}

// Nothing is ever formatted into a script: they are constants.
func TestTheScriptsHaveNoPlaceForAnything(t *testing.T) {
	for name, s := range map[string]string{"toast": toastScript, "startApps": startAppsScript} {
		if strings.Contains(s, "%s") || strings.Contains(s, "{0}") {
			t.Errorf("%s script has a format placeholder", name)
		}
	}
}

func TestPowerShellArgsCarryTheScriptAsOneEncodedArgument(t *testing.T) {
	args := powershellArgs("Write-Output 'hi'")
	n := len(args)
	if n < 2 || args[n-2] != "-EncodedCommand" || args[n-1] != platform.EncodePowerShell("Write-Output 'hi'") {
		t.Fatalf("args = %v", args)
	}
	for _, flag := range []string{"-NoProfile", "-NonInteractive"} {
		found := false
		for _, a := range args {
			found = found || a == flag
		}
		if !found {
			t.Errorf("missing %s", flag)
		}
	}
}
