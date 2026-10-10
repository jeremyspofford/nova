package caps

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
)

// S30a: fs.read by line or byte range, on a file of any size. The cap
// (ReadCap) applies to the RANGE, never the file: a range whose bytes exceed
// it is a stated refusal, never a truncated read.
//
// Memory is bounded on both paths. A byte range Seeks and reads at most
// `length` bytes (length <= ReadCap is checked first). A line range streams
// the file through a fixed bufio.Reader, keeps only the requested lines
// (refusing the moment they pass ReadCap), and then keeps reading to EOF ONLY
// to count newlines — lines_total needs that full pass; nothing past the range
// is held. A byte range never scans, so it states no lines_total.

// rangeKeys are the four optional fs.read args; any one present makes the
// read a ranged read (and then a whole pair is required).
var rangeKeys = [...]string{"start_line", "end_line", "offset", "length"}

// fsRange is a validated request: lines (start/end, 1-based, inclusive) or
// bytes (offset/length).
type fsRange struct {
	lines      bool
	start, end int64 // line range
	off, n     int64 // byte range
}

// hasRange reports whether any range key was sent.
func hasRange(args map[string]any) bool {
	for _, k := range rangeKeys {
		if _, ok := args[k]; ok {
			return true
		}
	}
	return false
}

// wholeArg reads a non-negative whole number sent as a JSON number (float64).
// A string, a fraction, a negative, NaN/Inf or a value past 2^53 is refused.
func wholeArg(args map[string]any, key string) (int64, error) {
	f, ok := args[key].(float64)
	if !ok {
		return 0, fmt.Errorf("fs.read '%s' must be a whole number, got %T", key, args[key])
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || f < 0 || f > 1<<53 {
		return 0, fmt.Errorf("fs.read '%s' must be a whole number >= 0, got %v", key, f)
	}
	return int64(f), nil
}

func parseRange(args map[string]any) (fsRange, error) {
	_, sl := args["start_line"]
	_, el := args["end_line"]
	_, of := args["offset"]
	_, ln := args["length"]
	lineAny, byteAny := sl || el, of || ln
	switch {
	case lineAny && byteAny:
		return fsRange{}, errors.New("fs.read takes a line range (start_line, end_line) OR a byte range (offset, length), not both")
	case lineAny && !(sl && el):
		return fsRange{}, errors.New("a line range needs both 'start_line' and 'end_line'")
	case byteAny && !(of && ln):
		return fsRange{}, errors.New("a byte range needs both 'offset' and 'length'")
	}
	if lineAny {
		start, err := wholeArg(args, "start_line")
		if err != nil {
			return fsRange{}, err
		}
		end, err := wholeArg(args, "end_line")
		if err != nil {
			return fsRange{}, err
		}
		if start < 1 {
			return fsRange{}, fmt.Errorf("'start_line' is 1-based, got %d", start)
		}
		if end < start {
			return fsRange{}, fmt.Errorf("'end_line' %d is before 'start_line' %d", end, start)
		}
		return fsRange{lines: true, start: start, end: end}, nil
	}
	off, err := wholeArg(args, "offset")
	if err != nil {
		return fsRange{}, err
	}
	n, err := wholeArg(args, "length")
	if err != nil {
		return fsRange{}, err
	}
	if n < 1 {
		return fsRange{}, fmt.Errorf("'length' must be at least 1, got %d", n)
	}
	return fsRange{off: off, n: n}, nil
}

// fsReadRange performs a ranged read of an already-stat'ed regular path.
func fsReadRange(path string, r fsRange) Outcome {
	f, err := os.Open(path)
	if err != nil {
		return fail("could not read %s: %v", path, err)
	}
	defer f.Close()
	if r.lines {
		return readLines(path, f, r)
	}
	return readBytes(path, f, r)
}

func readBytes(path string, f *os.File, r fsRange) Outcome {
	if r.n > ReadCap {
		return fail("the range is %d bytes, over the %d KiB read cap", r.n, ReadCap/1024)
	}
	info, err := f.Stat()
	if err != nil {
		return fail("could not read %s: %v", path, err)
	}
	total := info.Size()
	var body []byte
	if r.off < total {
		if _, err := f.Seek(r.off, io.SeekStart); err != nil {
			return fail("could not read %s: %v", path, err)
		}
		body, err = io.ReadAll(io.LimitReader(f, r.n))
		if err != nil {
			return fail("could not read %s: %v", path, err)
		}
	}
	out := ok0(string(body))
	out.Meta = map[string]any{
		"bytes_total": total,
		"range":       map[string]any{"offset": r.off, "length": r.n},
		"eof":         r.off+r.n > total,
	}
	return out
}

func readLines(path string, f *os.File, r fsRange) Outcome {
	br := bufio.NewReaderSize(f, 64*1024)
	var (
		body     []byte
		total    int64 // bytes seen
		newlines int64 // "\n" seen so far; the current line is newlines+1
		last     byte  // last byte of the file, to count a final line with no "\n"
	)
	// Phase 1: collect the range. ReadSlice returns up to and including one
	// "\n", or a full buffer of a longer line (bufio.ErrBufferFull), so a line
	// may be any length and no chunk spans two lines.
	for newlines < r.end {
		chunk, err := br.ReadSlice('\n')
		if len(chunk) > 0 {
			total += int64(len(chunk))
			last = chunk[len(chunk)-1]
			if line := newlines + 1; line >= r.start {
				if int64(len(body))+int64(len(chunk)) > ReadCap {
					return fail("the range of lines %d-%d is over the %d KiB read cap", r.start, r.end, ReadCap/1024)
				}
				body = append(body, chunk...)
			}
			if last == '\n' {
				newlines++
			}
		}
		if err == nil || errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			break
		}
		return fail("could not read %s: %v", path, err)
	}
	// Phase 2: the range is done; read on to EOF only to count lines
	// (lines_total), holding nothing but the reader's fixed buffer.
	buf := make([]byte, 64*1024)
	for {
		n, err := br.Read(buf)
		if n > 0 {
			total += int64(n)
			last = buf[n-1]
			newlines += int64(bytes.Count(buf[:n], []byte{'\n'}))
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fail("could not read %s: %v", path, err)
		}
	}
	linesTotal := newlines
	if total > 0 && last != '\n' {
		linesTotal++
	}
	out := ok0(string(body))
	out.Meta = map[string]any{
		"bytes_total": total,
		"lines_total": linesTotal,
		"range":       map[string]any{"start_line": r.start, "end_line": r.end},
		"eof":         r.end > linesTotal,
	}
	return out
}
