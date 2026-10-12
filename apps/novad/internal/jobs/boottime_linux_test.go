package jobs

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

// On Linux the boot time is the kernel's own btime, to the second.
func TestBootTimeIsTheKernelsBtime(t *testing.T) {
	raw, err := os.ReadFile("/proc/stat")
	if err != nil {
		t.Fatal(err)
	}
	var want int64 = -1
	for _, line := range strings.Split(string(raw), "\n") {
		if f := strings.Fields(line); len(f) == 2 && f[0] == "btime" {
			want, _ = strconv.ParseInt(f[1], 10, 64)
		}
	}
	boot, err := BootTime()
	if err != nil || boot.Unix() != want {
		t.Fatalf("BootTime = %v (%v), want btime %d", boot, err, want)
	}
}
