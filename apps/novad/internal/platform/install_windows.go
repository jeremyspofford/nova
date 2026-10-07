package platform

import (
	"os"
	"path/filepath"
)

// BinaryName is the agent's file name on this OS.
const BinaryName = "novad.exe"

// InstallDir is %LocalAppData%\Programs\Nova (P1): where per-user Windows
// programs live, and never roams.
func InstallDir() (string, error) {
	local, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(local, "Programs", "Nova"), nil
}

// AdminInstallDir is %ProgramFiles%\Nova — S42c's admin-only copy.
func AdminInstallDir() string {
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return filepath.Join(pf, "Nova")
}
