package caps

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// fs.search (S30a T6) walks a directory tree and reports every line matching
// a regex (RE2) or a literal, honouring .gitignore, as `relpath:line: text`.
const (
	// SearchDefaultMatches is max_matches when the call gives none.
	SearchDefaultMatches = 200
	// SearchMaxMatches is the ceiling on max_matches; a larger ask is a
	// stated refusal, never silently lowered.
	SearchMaxMatches = 2000
	// SearchLineCap is the most of one matching line's text the output
	// carries; a longer line is cut there and ends with searchTruncMark.
	SearchLineCap = 512
	// binarySniff is how much of a file is read to decide it is binary (a NUL
	// byte in it means binary, and the file is skipped).
	binarySniff = 8 << 10
)

// searchTruncMark ends a matching line's text cut at SearchLineCap.
const searchTruncMark = " [truncated]"

// searchBuf is the per-file read buffer. A line that fits is matched in place
// (fast path); a longer one is streamed rune by rune through the regex, so
// memory stays bounded whatever a line's length.
const searchBuf = 64 << 10

// searchNoteRoom is the output kept free for the closing notes, so the
// output with its notes never passes OutputCap.
const searchNoteRoom = 256

// gitignoreCap bounds how much of one .gitignore is read.
const gitignoreCap = 1 << 20

// errSearchStopped is a walk cut by the context (the command's deadline).
var errSearchStopped = errors.New("stopped")

// errSearchFull ends the walk once a cap is reached.
var errSearchFull = errors.New("full")

type searcher struct {
	ctx     context.Context
	re      *regexp.Regexp
	max     int
	rules   *ignoreRules
	out     strings.Builder
	matches int
	scanned int
	skipped int
	// stopNote is the closing "[stopped ...]" line once a cap is reached.
	stopNote string
	br       *bufio.Reader
}

func fsSearch(ctx context.Context, args map[string]any, d Deps) Outcome {
	root, ok := strArg(args, "path")
	if !ok || root == "" {
		return fail("fs.search needs a 'path'")
	}
	pattern, ok := strArg(args, "pattern")
	if !ok || pattern == "" {
		return fail("fs.search needs a non-empty 'pattern'")
	}
	literal, err := boolArg(args, "literal")
	if err != nil {
		return fail("%v", err)
	}
	ignoreCase, err := boolArg(args, "ignore_case")
	if err != nil {
		return fail("%v", err)
	}
	max := SearchDefaultMatches
	if v, present := args["max_matches"]; present {
		f, isNum := numberArg(v)
		if !isNum || math.IsNaN(f) || f != math.Trunc(f) || f < 1 || f > SearchMaxMatches {
			return fail("fs.search 'max_matches' must be a whole number from 1 to %d, got %v", SearchMaxMatches, v)
		}
		max = int(f)
	}
	expr := pattern
	if literal {
		expr = regexp.QuoteMeta(pattern)
	}
	if ignoreCase {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return fail("fs.search 'pattern' is not a valid regular expression: %v", err)
	}

	root, err = resolvePath(root)
	if err != nil {
		return fail("%v", err)
	}
	info, err := os.Stat(root)
	if err != nil {
		return fail("could not search %s: %v", root, err)
	}
	if !info.IsDir() {
		return fail("%s is not a directory", root)
	}
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}

	s := &searcher{ctx: ctx, re: re, max: max, rules: newIgnoreRules(),
		br: bufio.NewReaderSize(nil, searchBuf)}
	baseRel := s.loadRepoRules(root)
	if _, err := os.ReadDir(root); err != nil {
		return fail("could not search %s: %v", root, err)
	}
	err = s.walk(root, "", baseRel)
	if errors.Is(err, errSearchStopped) {
		return fail("fs.search stopped before it finished (%v); nothing is reported from a partial walk", ctx.Err())
	}

	if s.matches == 0 {
		fmt.Fprintf(&s.out, "[no matches in %d files searched]\n", s.scanned)
	}
	if s.skipped > 0 {
		fmt.Fprintf(&s.out, "[skipped %d unreadable files or directories]\n", s.skipped)
	}
	if s.stopNote != "" {
		s.out.WriteString(s.stopNote + "\n")
	}
	out := ok0(s.out.String())
	out.Meta = map[string]any{
		"matches":       s.matches,
		"files_scanned": s.scanned,
		"capped":        s.stopNote != "",
	}
	return out
}

func boolArg(args map[string]any, key string) (bool, error) {
	v, present := args[key]
	if !present {
		return false, nil
	}
	b, ok := v.(bool)
	if !ok {
		return false, fmt.Errorf("fs.search '%s' must be true or false, got %T", key, v)
	}
	return b, nil
}

// loadRepoRules finds the repository root (the nearest ancestor of root
// holding a .git entry, dir or file) and loads every .gitignore from it down
// to root itself. It returns root's slash path relative to the base the rules
// are written against: the repository root, else root ("" then).
func (s *searcher) loadRepoRules(root string) string {
	repo := ""
	for dir := root; ; {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			repo = dir
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if repo == "" {
		s.loadIgnore(root, "")
		return ""
	}
	rel, err := filepath.Rel(repo, root)
	if err != nil {
		s.loadIgnore(root, "")
		return ""
	}
	rel = filepath.ToSlash(rel)
	if rel == "." {
		rel = ""
	}
	s.loadIgnore(repo, "")
	if rel != "" {
		parts := strings.Split(rel, "/")
		for i := range parts {
			sub := strings.Join(parts[:i+1], "/")
			s.loadIgnore(filepath.Join(repo, filepath.FromSlash(sub)), sub)
		}
	}
	return rel
}

// loadIgnore adds dir's .gitignore, if it is a regular file, under baseRel.
func (s *searcher) loadIgnore(dir, baseRel string) {
	p := filepath.Join(dir, ".gitignore")
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	f, err := os.Open(p)
	if err != nil {
		return
	}
	defer f.Close()
	body, err := io.ReadAll(io.LimitReader(f, gitignoreCap))
	if err != nil {
		return
	}
	s.rules.add(baseRel, string(body))
}

func joinRel(a, b string) string {
	if a == "" {
		return b
	}
	return a + "/" + b
}

// walk searches dir (rel: its slash path relative to the search root;
// baseRel: relative to the rules' base) depth first, entries by name. The
// search root's own .gitignore is already loaded; a subdirectory's is loaded
// on entry. Symlinks and non-regular files are skipped, never followed.
func (s *searcher) walk(dir, rel, baseRel string) error {
	if rel != "" {
		s.loadIgnore(dir, baseRel)
	}
	entries, err := os.ReadDir(dir) // sorted by name
	if err != nil {
		s.skipped++
		return nil
	}
	for _, e := range entries {
		if s.ctx.Err() != nil {
			return errSearchStopped
		}
		name := e.Name()
		if name == ".git" {
			continue
		}
		t := e.Type()
		if t&os.ModeSymlink != 0 {
			continue
		}
		isDir := e.IsDir()
		if !isDir && !t.IsRegular() {
			continue
		}
		eRel, eBase := joinRel(rel, name), joinRel(baseRel, name)
		if s.rules.matchSelf(eBase, isDir) {
			continue
		}
		path := filepath.Join(dir, name)
		if isDir {
			err = s.walk(path, eRel, eBase)
		} else {
			err = s.file(path, eRel)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// file searches one regular file line by line.
func (s *searcher) file(path, rel string) error {
	f, err := os.Open(path)
	if err != nil {
		s.skipped++
		return nil
	}
	defer f.Close()
	br := s.br
	br.Reset(f)
	head, err := br.Peek(binarySniff)
	if err != nil && err != io.EOF && !errors.Is(err, bufio.ErrBufferFull) {
		s.skipped++
		return nil
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return nil // binary: skipped, not counted
	}
	s.scanned++
	for n := 1; ; n++ {
		if n%4096 == 0 && s.ctx.Err() != nil {
			return errSearchStopped
		}
		line, err := br.ReadSlice('\n')
		if len(line) == 0 && err == io.EOF {
			return nil
		}
		var matched bool
		var text string
		switch {
		case err == nil || err == io.EOF:
			body := trimEOL(line)
			matched = s.re.Match(body)
			if matched {
				text = cutLine(body)
			}
		case errors.Is(err, bufio.ErrBufferFull):
			// Longer than the buffer: stream the rest of the line.
			lr := newLongLine(line, br)
			matched = s.re.MatchReader(lr)
			lr.drain()
			if lr.err != nil {
				s.skipped++
				return nil
			}
			text = lr.text()
			err = lr.end
		default:
			s.skipped++
			return nil
		}
		if matched {
			if done := s.emit(rel, n, text); done {
				return errSearchFull
			}
		}
		if err == io.EOF {
			return nil
		}
	}
}

// emit records one matching line, or the cap it reached. It reports true when
// the walk must stop.
func (s *searcher) emit(rel string, n int, text string) bool {
	if s.matches == s.max {
		// A match past max_matches exists: only now is the search capped.
		s.stopNote = fmt.Sprintf("[stopped at max_matches %d; more matches exist]", s.max)
		return true
	}
	line := rel + ":" + strconv.Itoa(n) + ": " + text + "\n"
	if s.out.Len()+len(line) > OutputCap-searchNoteRoom {
		s.stopNote = fmt.Sprintf("[stopped at the %d KiB output cap after %d matches; more matches exist]", OutputCap/1024, s.matches)
		return true
	}
	s.out.WriteString(line)
	s.matches++
	return false
}

// trimEOL drops a line's "\n" and then "\r".
func trimEOL(b []byte) []byte {
	b = bytes.TrimSuffix(b, []byte("\n"))
	return bytes.TrimSuffix(b, []byte("\r"))
}

// cutLine is a line's output text: whole if it fits SearchLineCap, else cut
// at a rune boundary at or before it, with searchTruncMark.
func cutLine(b []byte) string {
	if len(b) <= SearchLineCap {
		return string(b)
	}
	k := SearchLineCap
	for k > 0 && !utf8.RuneStart(b[k]) {
		k--
	}
	return string(b[:k]) + searchTruncMark
}

// longLine is an io.RuneReader over one line longer than the read buffer: the
// buffered head, then the reader up to the line's end. It strips "\n" and a
// "\r" before it, keeps only the first SearchLineCap bytes for the output,
// and holds no more than that whatever the line's length.
type longLine struct {
	src  *bufio.Reader // head then rest-of-line, rune decoded
	keep []byte
	cut  bool
	done bool
	err  error // a read error (not EOF)
	end  error // io.EOF when the file ended on this line
}

func newLongLine(head []byte, br *bufio.Reader) *longLine {
	l := &longLine{}
	rest := &untilNL{br: br, owner: l}
	l.src = bufio.NewReaderSize(io.MultiReader(bytes.NewReader(append([]byte(nil), head...)), rest), 4096)
	return l
}

func (l *longLine) ReadRune() (rune, int, error) {
	if l.done {
		return 0, 0, io.EOF
	}
	r, size, err := l.src.ReadRune()
	if err != nil {
		l.done = true
		if err != io.EOF {
			l.err = err
		}
		return 0, 0, io.EOF
	}
	switch r {
	case '\n':
		l.done = true
		return 0, 0, io.EOF
	case '\r':
		next, _, nerr := l.src.ReadRune()
		if nerr != nil || next == '\n' {
			l.done = true
			if nerr != nil && nerr != io.EOF {
				l.err = nerr
			}
			return 0, 0, io.EOF
		}
		_ = l.src.UnreadRune()
	}
	if !l.cut {
		// An invalid byte is kept as U+FFFD (the result frame's JSON would
		// replace it anyway), so count the bytes appended, not size.
		if len(l.keep)+utf8.RuneLen(r) <= SearchLineCap {
			l.keep = utf8.AppendRune(l.keep, r)
		} else {
			l.cut = true
		}
	}
	return r, size, nil
}

// drain reads the rest of the line once the regex has its answer.
func (l *longLine) drain() {
	for {
		if _, _, err := l.ReadRune(); err != nil {
			return
		}
	}
}

func (l *longLine) text() string {
	if l.cut {
		return string(l.keep) + searchTruncMark
	}
	return string(l.keep)
}

// untilNL reads br up to and including the next "\n", then reports EOF. It
// notes on its owner whether the file itself ended.
type untilNL struct {
	br    *bufio.Reader
	owner *longLine
	done  bool
}

func (u *untilNL) Read(p []byte) (int, error) {
	if u.done {
		return 0, io.EOF
	}
	n := 0
	for n < len(p) {
		c, err := u.br.ReadByte()
		if err != nil {
			u.done = true
			if err == io.EOF {
				u.owner.end = io.EOF
				if n == 0 {
					return 0, io.EOF
				}
				return n, nil
			}
			return n, err
		}
		p[n] = c
		n++
		if c == '\n' {
			u.done = true
			return n, nil
		}
	}
	return n, nil
}
