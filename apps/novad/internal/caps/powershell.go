package caps

import "novad/internal/platform"

// toastScript shows a Windows toast through the WinRT API that Windows
// PowerShell 5.1 can load (powershell.exe; PowerShell 7 cannot). It is a
// CONSTANT: the message is read from stdin as raw UTF-8 bytes — never through
// [Console]::In, whose console code page would mangle "Café" — so nothing a
// person typed is ever PowerShell source. The AppUserModelID is Windows
// PowerShell's own, registered on every Windows 10 and 11, so the toast shows
// without Nova registering an app.
const toastScript = `$in = [Console]::OpenStandardInput()
$buf = New-Object System.IO.MemoryStream
$in.CopyTo($buf)
$m = [System.Text.Encoding]::UTF8.GetString($buf.ToArray())
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode('Nova')) | Out-Null
$x.Item(1).AppendChild($t.CreateTextNode($m)) | Out-Null
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($t))
`

// startAppsScript lists the Start menu's apps — what Windows itself offers
// to launch, Store apps included — as JSON (platform.ParseStartApps).
const startAppsScript = `Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress`

// powershellArgs is the argv every PowerShell call here uses: no profile (a
// user's profile could print or fail), no prompts, no execution-policy
// refusal, and the script as one encoded argument.
func powershellArgs(script string) []string {
	return []string{
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-EncodedCommand", platform.EncodePowerShell(script),
	}
}
