package caps

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

// denyCheck runs the deny-roots backstop FIRST, before any fs syscall. This is
// mechanical-over-prompts at the edge: it refuses regardless of what core
// signed. A missing deny list is itself a refusal — the backstop is not
// optional.
func denyCheck(d Deps, path string) *Outcome {
	if d.Deny == nil {
		o := fail("fs is unavailable: the deny-roots backstop is not loaded")
		return &o
	}
	if forbidden, reason := d.Deny.Forbids(path); forbidden {
		o := fail("refused: %s", reason)
		return &o
	}
	return nil
}

func fsList(args map[string]any, d Deps) Outcome {
	path, ok := strArg(args, "path")
	if !ok || path == "" {
		return fail("fs.list needs a 'path'")
	}
	if refusal := denyCheck(d, path); refusal != nil {
		return *refusal
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return fail("could not list %s: %v", path, err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	var b strings.Builder
	fmt.Fprintf(&b, "%d entries in %s\n", len(entries), path)
	for _, e := range entries {
		size := int64(-1)
		if info, err := e.Info(); err == nil {
			size = info.Size()
		}
		kind := "f"
		if e.IsDir() {
			kind = "d"
		}
		fmt.Fprintf(&b, "%s %10d  %s\n", kind, size, e.Name())
	}
	return ok0(b.String())
}

func fsRead(args map[string]any, d Deps) Outcome {
	path, ok := strArg(args, "path")
	if !ok || path == "" {
		return fail("fs.read needs a 'path'")
	}
	if refusal := denyCheck(d, path); refusal != nil {
		return *refusal
	}
	info, err := os.Stat(path)
	if err != nil {
		return fail("could not read %s: %v", path, err)
	}
	if info.IsDir() {
		return fail("%s is a directory, not a file", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return fail("could not read %s: %v", path, err)
	}
	defer f.Close()
	// The cap is MECHANICAL, enforced on the read itself, not on the prior
	// stat: read at most ReadCap+1 bytes and refuse on overflow — a file that
	// grows past the cap between stat and read is still refused, never
	// truncated-and-claimed-success.
	body, err := io.ReadAll(io.LimitReader(f, ReadCap+1))
	if err != nil {
		return fail("could not read %s: %v", path, err)
	}
	if len(body) > ReadCap {
		if size := info.Size(); size > ReadCap {
			return fail("file is %d bytes, over the %d KiB read cap", size, ReadCap/1024)
		}
		return fail("file grew past the %d KiB read cap while reading", ReadCap/1024)
	}
	return ok0(string(body))
}

func fsWrite(args map[string]any, d Deps) Outcome {
	path, ok := strArg(args, "path")
	if !ok || path == "" {
		return fail("fs.write needs a 'path'")
	}
	content, ok := strArg(args, "content")
	if !ok {
		return fail("fs.write needs 'content'")
	}
	if refusal := denyCheck(d, path); refusal != nil {
		return *refusal
	}
	// The cap is MECHANICAL and defence-in-depth: the daemon refuses an oversize
	// write even for a fully-verified, core-signed envelope (core caps it too).
	// Byte length, matching core's UTF-8 byte-length check, and refused BEFORE
	// the write so nothing is partially written.
	if len(content) > WriteCap {
		return fail("content is %d bytes, over the %d KiB write cap", len(content), WriteCap/1024)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return fail("could not write %s: %v", path, err)
	}
	return ok0(fmt.Sprintf("wrote %d bytes to %s", len(content), path))
}
