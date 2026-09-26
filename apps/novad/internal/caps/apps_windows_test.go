package caps

import (
	"context"
	"testing"

	"novad/internal/platform"
)

func TestStartAppsRunsTheConstantScriptAndParsesItsJSON(t *testing.T) {
	r := &platform.FakeRunner{Outputs: map[string]string{
		"powershell.exe": `[{"Name":"Notepad","AppID":"Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"}]`,
	}}
	apps, err := startApps(context.Background(), r)
	if err != nil || len(apps) != 1 || apps[0].Name != "Notepad" {
		t.Fatalf("%v %v", apps, err)
	}
	args := r.Calls[0].Args
	if args[len(args)-1] != platform.EncodePowerShell(startAppsScript) {
		t.Fatal("the listing must run the constant script")
	}
}
