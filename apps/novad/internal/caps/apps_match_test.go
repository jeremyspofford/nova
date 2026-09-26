package caps

import (
	"testing"

	"novad/internal/platform"
)

// "Notepad" and its AppID both open Notepad: an exact AppID first, then the
// Start menu's name compared without case.
func TestMatchStartAppPrefersTheExactAppIDThenTheNameWithoutCase(t *testing.T) {
	apps := []platform.StartApp{
		{Name: "Notepad", AppID: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"},
		{Name: "Paint", AppID: "Microsoft.Paint_8wekyb3d8bbwe!App"},
	}
	if id, ok := matchStartApp(apps, "notepad"); !ok || id != "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" {
		t.Fatalf("by name: %q %v", id, ok)
	}
	if id, ok := matchStartApp(apps, "Microsoft.Paint_8wekyb3d8bbwe!App"); !ok || id != "Microsoft.Paint_8wekyb3d8bbwe!App" {
		t.Fatalf("by id: %q %v", id, ok)
	}
	if _, ok := matchStartApp(apps, "Photoshop"); ok {
		t.Fatal("no match must say so")
	}
}
