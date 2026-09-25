package platform

import (
	"context"
	"errors"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// OSVersion is the name Windows shows, e.g. "Windows 11 Pro 24H2 (build 26100)".
func OSVersion(_ context.Context, _ Runner) string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return "Windows (version not stated)"
	}
	defer k.Close()
	product, _, _ := k.GetStringValue("ProductName")
	display, _, _ := k.GetStringValue("DisplayVersion")
	build, _, _ := k.GetStringValue("CurrentBuild")
	return WindowsProductName(product, display, build)
}

// Disk is GetDiskFreeSpaceEx for the volume holding path.
func Disk(path string) (free, total uint64, err error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, err
	}
	var avail, tot, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &avail, &tot, &totalFree); err != nil {
		return 0, 0, err
	}
	return avail, tot, nil
}

// DiskRoot is what system.info reads when the daemon has no home.
func DiskRoot() string { return `C:\` }

// memoryStatusEx is MEMORYSTATUSEX. x/sys/windows wraps neither
// GlobalMemoryStatusEx nor GetTickCount64, so both are called directly.
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

var (
	kernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetTickCount64       = kernel32.NewProc("GetTickCount64")
)

// Memory is physical memory, total and available.
func Memory() (Mem, error) {
	var st memoryStatusEx
	st.Length = uint32(unsafe.Sizeof(st))
	ok, _, callErr := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&st)))
	if ok == 0 {
		return Mem{}, callErr
	}
	return Mem{Total: st.TotalPhys, Available: st.AvailPhys, AvailableKnown: true}, nil
}

// Uptime is GetTickCount64: milliseconds since boot.
func Uptime() (time.Duration, error) {
	if err := procGetTickCount64.Find(); err != nil {
		return 0, err
	}
	ms, _, _ := procGetTickCount64.Call()
	if ms == 0 {
		return 0, errors.New("GetTickCount64 returned 0")
	}
	return time.Duration(ms) * time.Millisecond, nil
}

// Extras are home and the Desktop folder. Windows moves Desktop (OneDrive
// redirects it), so "what's on my desktop" is answered from the folder
// Windows names, never from a guessed C:\Users\<name>\Desktop.
func Extras(home string) []string {
	var out []string
	if home != "" {
		out = append(out, "home="+home)
	}
	if desk, err := windows.KnownFolderPath(windows.FOLDERID_Desktop, 0); err == nil && desk != "" {
		out = append(out, "desktop="+desk)
	} else {
		out = append(out, "desktop=unknown")
	}
	return out
}
