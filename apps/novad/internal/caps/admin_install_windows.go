//go:build windows

package caps

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"novad/internal/admin"
)

// installTimeout bounds one run of the installer / uninstaller through the
// task, and whoamiTimeout the elevated round trip.
const (
	installTimeout = 60
	whoamiTimeout  = 30
)

// realAdminHost is the windows machine: its token, its session, this
// binary, and the installer run directly (already elevated), through the
// task, or elevated by the owner's one UAC click (ShellExecuteEx "runas").
func realAdminHost(d Deps) (AdminHost, error) {
	bin, err := admin.OwnPath()
	if err != nil {
		return AdminHost{}, fmt.Errorf("finding this agent's binary: %w", err)
	}
	submit := realSubmit
	if d.Admin != nil && d.Admin.Submit != nil {
		submit = d.Admin.Submit
	}
	// One request through the task: its stdout, or why it did not run.
	through := func(ctx context.Context, secs int, argv ...string) (string, error) {
		id, err := admin.NewRequestID(rand.Reader)
		if err != nil {
			return "", err
		}
		res, err := submit(ctx, admin.TaskRequest{
			V: admin.FileVersion, ID: id, Argv: argv, TimeoutS: json.Number(strconv.Itoa(secs)),
		}, time.Duration(secs)*time.Second)
		switch {
		case err != nil:
			return "", err
		case res.TimedOut:
			return res.Stdout, fmt.Errorf("timed out after %ds", secs)
		case !res.OK:
			return res.Stdout, errors.New(res.Said)
		case res.ExitCode != 0:
			return res.Stdout, fmt.Errorf("exit %d: %s", res.ExitCode, strings.TrimSpace(res.Stderr+" "+res.Stdout))
		}
		return res.Stdout, nil
	}
	run := func(ctx context.Context, route, verb string) (string, error) {
		switch route {
		case routeDirect:
			out, err := exec.CommandContext(ctx, bin, "admin", verb).CombinedOutput()
			if err != nil {
				return string(out), fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
			}
			return string(out), nil
		case routePath:
			return through(ctx, installTimeout, bin, "admin", verb)
		case routeUAC:
			if verb != "install" {
				break
			}
			wait, err := uacWait(ctx)
			if err != nil {
				return "", err
			}
			return "", runElevated(bin, "admin install", wait)
		}
		return "", fmt.Errorf("cannot: there is no %q route for admin %s on this machine", route, verb)
	}
	h, herr := admin.DefaultHost()
	return AdminHost{
		Windows:  true,
		Elevated: windows.GetCurrentProcessToken().IsElevated(),
		SignedIn: admin.SignedIn(),
		Bin:      bin,
		Read: func(ctx context.Context) admin.PathState {
			ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			return admin.ReadPath(ctx)
		},
		Install:   func(ctx context.Context, route string) (string, error) { return run(ctx, route, "install") },
		Uninstall: func(ctx context.Context, route string) (string, error) { return run(ctx, route, "uninstall") },
		Whoami: func(ctx context.Context) (string, error) {
			if herr != nil {
				return "", herr
			}
			return through(ctx, whoamiTimeout, h.CopyExe, "admin", "whoami")
		},
		// The runner's own leftovers go as it exits (T2 carry a).
		Settle: 20 * time.Second,
		Poll:   500 * time.Millisecond,
	}, nil
}

// shellExecuteInfo is SHELLEXECUTEINFOW.
type shellExecuteInfo struct {
	cbSize       uint32
	fMask        uint32
	hwnd         windows.Handle
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     windows.Handle
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    windows.Handle
	dwHotKey     uint32
	hIconOrMon   windows.Handle
	hProcess     windows.Handle
}

const (
	seeMaskNoCloseProcess = 0x00000040
	seeMaskNoAsync        = 0x00000100
)

var procShellExecuteExW = windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteExW")

// runElevated starts file with params through ShellExecuteEx "runas" — the
// one UAC prompt, on the owner's screen — and waits up to wait for it to
// exit. A declined prompt is ErrDeclined; a nonzero exit is its code.
func runElevated(file, params string, wait time.Duration) error {
	verb, _ := windows.UTF16PtrFromString("runas")
	f, err := windows.UTF16PtrFromString(file)
	if err != nil {
		return err
	}
	p, err := windows.UTF16PtrFromString(params)
	if err != nil {
		return err
	}
	info := shellExecuteInfo{
		fMask: seeMaskNoCloseProcess | seeMaskNoAsync, lpVerb: verb, lpFile: f, lpParameters: p, nShow: windows.SW_HIDE,
	}
	info.cbSize = uint32(unsafe.Sizeof(info))
	r, _, callErr := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		if errors.Is(callErr, windows.ERROR_CANCELLED) {
			return ErrDeclined
		}
		return fmt.Errorf("could not show the UAC prompt: %v", callErr)
	}
	if info.hProcess == 0 {
		return errors.New("the elevated install started but its process could not be watched")
	}
	defer windows.CloseHandle(info.hProcess)
	ev, err := windows.WaitForSingleObject(info.hProcess, uint32(wait/time.Millisecond))
	switch {
	case err != nil:
		return fmt.Errorf("waiting for the elevated install: %w", err)
	case ev == uint32(windows.WAIT_TIMEOUT):
		return fmt.Errorf("the elevated install had not finished after %s (the UAC prompt may still be waiting for the owner)", wait)
	}
	var code uint32
	if err := windows.GetExitCodeProcess(info.hProcess, &code); err != nil {
		return fmt.Errorf("reading the elevated install's exit: %w", err)
	}
	if code != 0 {
		return fmt.Errorf("the elevated install exited %d", code)
	}
	return nil
}
