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
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// fs.search (S30a T6) walks a directory tree and reports every line matching
// a regex (RE2) or a literal, honouring .gitignore, as `relpath:line: text`.
// S38c T2: an optional `glob` picks the files searched before any is opened,
// and past a cap the walk keeps counting (no output) so meta.total_matches
// says how many matching lines the answer left out.
const (
	// SearchDefaultMatches is max_matches when the call gives none (S38c
	// §12 Q7: 50, was 200).
	SearchDefaultMatches = 50
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

// searchCountBudget (S38c T2) bounds the count walk past the cap: a broad
// search on a huge tree answers within it with a lower-bound total
// (total_complete false), not at the command's deadline. A var so tests can
// cut it.
var searchCountBudget = 5 * time.Second

// gitignoreCap bounds how much of one .gitignore is read.
const gitignoreCap = 1 << 20

// errSearchStopped is a walk cut by the context (the command's deadline).
var errSearchStopped = errors.New("stopped")

type searcher struct {
	ctx     context.Context
	re      *regexp.Regexp
	max     int
	rules   *ignoreRules
	glob    []string // the glob's "/" segments; nil when none was given
	out     strings.Builder
	matches int // matching lines output
	total   int // matching lines found, output or only counted
	scanned int
	skipped int
	// capNote names the cap that stopped the output ("" while none has);
	// from then on the walk only counts, until countUntil.
	capNote    string
	countUntil time.Time
	// countCut is a count walk the time ran out on: total is a lower bound.
	countCut bool
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
		f, isNum := wireWholeArg(v)
		if !isNum || math.IsNaN(f) || f != math.Trunc(f) || f < 1 || f > SearchMaxMatches {
			return fail("fs.search 'max_matches' must be a whole number from 1 to %d, got %v", SearchMaxMatches, v)
		}
		max = int(f)
	}
	globText, globSegs := "", []string(nil)
	if v, present := args["glob"]; present {
		g, isStr := v.(string)
		if !isStr {
			return fail("fs.search 'glob' must be a string, got %T", v)
		}
		if globSegs, err = parseGlob(g); err != nil {
			return fail("fs.search 'glob' %v", err)
		}
		globText = g
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

	s := &searcher{ctx: ctx, re: re, max: max, rules: newIgnoreRules(), glob: globSegs,
		br: bufio.NewReaderSize(nil, searchBuf)}
	baseRel := s.loadRepoRules(root)
	if _, err := os.ReadDir(root); err != nil {
		return fail("could not search %s: %v", root, err)
	}
	err = s.walk(root, "", baseRel)
	if errors.Is(err, errSearchStopped) {
		if s.capNote == "" {
			return fail("fs.search stopped before it finished (%v); nothing is reported from a partial walk", ctx.Err())
		}
		// The answer's lines were all found before the cap; only the count
		// of the rest was cut, and it is stated as a lower bound.
		s.countCut = true
	}

	if s.matches == 0 {
		fmt.Fprintf(&s.out, "[no matches in %d files searched]\n", s.scanned)
	}
	if s.skipped > 0 {
		fmt.Fprintf(&s.out, "[skipped %d unreadable files or directories]\n", s.skipped)
	}
	if s.capNote != "" {
		if s.countCut {
			fmt.Fprintf(&s.out, "[stopped at %s; at least %d matches in all — the count ran out of time]\n", s.capNote, s.total)
		} else {
			fmt.Fprintf(&s.out, "[stopped at %s; %d matches in all]\n", s.capNote, s.total)
		}
	}
	out := ok0(s.out.String())
	out.Meta = map[string]any{
		"matches":        s.matches,
		"files_scanned":  s.scanned,
		"capped":         s.capNote != "",
		"total_matches":  s.total,
		"total_complete": !s.countCut,
	}
	if globSegs != nil {
		out.Meta["glob"] = globText
	}
	return out
}

// parseGlob splits a glob on "/" and checks every segment: none empty (a
// leading, trailing or doubled "/" is refused, not guessed at), each a valid
// path.Match pattern ("**" is its own segment, spanning directories).
func parseGlob(g string) ([]string, error) {
	if g == "" {
		return nil, errors.New("must not be empty")
	}
	segs := strings.Split(g, "/")
	for _, seg := range segs {
		if seg == "" {
			return nil, fmt.Errorf("%q has an empty path segment (a leading, trailing or doubled '/')", g)
		}
		if _, err := path.Match(seg, ""); err != nil {
			return nil, fmt.Errorf("%q is not a valid glob: %v", g, err)
		}
	}
	return segs, nil
}

// wantFile is whether the glob (if any) selects rel, the file's slash path
// relative to the search root: a glob without "/" matches the base name at
// any depth, one with "/" the whole relpath.
func (s *searcher) wantFile(rel string) bool {
	switch {
	case s.glob == nil:
		return true
	case len(s.glob) == 1:
		ok, _ := path.Match(s.glob[0], rel[strings.LastIndexByte(rel, '/')+1:])
		return ok
	default:
		return matchSegs(s.glob, strings.Split(rel, "/"))
	}
}

// stopped is whether the walk must end here: the command's deadline, or,
// once only counting, the count's own budget.
func (s *searcher) stopped() bool {
	if s.ctx.Err() != nil {
		return true
	}
	return s.capNote != "" && !time.Now().Before(s.countUntil)
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
		if s.stopped() {
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
		full := filepath.Join(dir, name)
		if isDir {
			err = s.walk(full, eRel, eBase)
		} else if s.wantFile(eRel) {
			err = s.file(full, eRel)
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
		if n%4096 == 0 && s.stopped() {
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
			if matched && s.capNote == "" {
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
			s.emit(rel, n, text)
		}
		if err == io.EOF {
			return nil
		}
	}
}

// emit records one matching line: output while no cap is reached, then only
// counted. The first match past a cap starts the count walk.
func (s *searcher) emit(rel string, n int, text string) {
	s.total++
	if s.capNote != "" {
		return
	}
	if s.matches == s.max {
		// A match past max_matches exists: only now is the search capped.
		s.startCounting(fmt.Sprintf("max_matches %d", s.max))
		return
	}
	line := rel + ":" + strconv.Itoa(n) + ": " + text + "\n"
	if s.out.Len()+len(line) > OutputCap-searchNoteRoom {
		s.startCounting(fmt.Sprintf("the %d KiB output cap after %d matches", OutputCap/1024, s.matches))
		return
	}
	s.out.WriteString(line)
	s.matches++
}

// startCounting ends the output at a cap; the walk goes on counting matches
// for at most searchCountBudget.
func (s *searcher) startCounting(note string) {
	s.capNote = note
	s.countUntil = time.Now().Add(searchCountBudget)
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
