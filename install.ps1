# Nova's hub on Windows (S42b; hub-topology D20): the hub runs in Docker
# inside WSL for now. This states that and gives the one step. It installs
# nothing, and exits 1.
#
# Windows PowerShell 5.1 reads a script that has no byte-order mark in the
# ANSI code page, so this file is plain ASCII (deploy/install_test.sh holds
# it to that). No -ErrorAction Stop: on 5.1, a native program's stderr line
# becomes an error record, and Stop would turn a WSL warning into "no WSL".
$names = @()
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
    # wsl.exe writes its list in UTF-16, which PowerShell 5.1 reads with a
    # NUL after each character: the NULs go. A distribution's name is one
    # word of letters, digits, '.', '_' and '-', so a line that is not one
    # (wsl's own "no installed distributions" text) is not a name; and
    # Docker Desktop's own distributions are not where ./install runs.
    $listed = & wsl.exe --list --quiet 2>$null
    if ($LASTEXITCODE -eq 0) {
        $names = @($listed | ForEach-Object { ([string]$_ -replace "`0", '').Trim() } |
            Where-Object { $_ -match '^[A-Za-z0-9._-]+$' -and $_ -notlike 'docker-desktop*' })
    }
}
if ($names.Count -eq 0) {
    Write-Output "cannot: Nova's hub runs inside WSL on Windows, and this PC has no WSL distribution to run it in."
    Write-Output "Install one from an administrator PowerShell with:  wsl --install"
    Write-Output "then open it, get this repository there, and run ./install in it."
    exit 1
}
Write-Output "cannot here: Nova's hub runs inside WSL, not in Windows itself. Open WSL ($($names -join ', ')),"
Write-Output "get this repository there, and run ./install in it."
Write-Output "To add this PC as a machine Nova controls instead, run the Windows line from her setup card in PowerShell."
exit 1
