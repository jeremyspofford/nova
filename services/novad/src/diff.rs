//! Unified line diff for staged device writes (FR-210, docs/23 §4.1): the Hub shows it before a commit.
#![allow(dead_code)]

use std::collections::HashMap;

/// Past this many insertions plus deletions the diff stops looking for a minimal script and
/// shows a whole-file replacement, so a hostile or unrelated pair of files costs bounded time.
const MAX_EDIT_DISTANCE: usize = 20_000;
/// Past this many lines on either side, likewise.
const MAX_LINES: usize = 200_000;
const NO_NEWLINE_MARKER: &str = "\\ No newline at end of file\n";
const TRUNCATED_MARKER: &str = "... diff truncated\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffSummary {
    /// Unified diff text with ---/+++ headers and @@ hunks.
    pub unified: String,
    /// Added lines (all of them, even when the text is truncated).
    pub additions: usize,
    /// Removed lines (all of them, even when the text is truncated).
    pub deletions: usize,
    /// The text was cut at `max_output_bytes` (at a line boundary, then a final line
    /// "... diff truncated").
    pub truncated: bool,
}

/// Line diff of two texts (split on '\n'; a missing final newline is shown with the standard
/// "\ No newline at end of file" marker line). `context` lines around changes (3 is typical).
/// Identical inputs give an empty `unified` and zero counts. Uses Myers' O(ND) algorithm; when the
/// edit distance would exceed 20_000 (or either side has more than 200_000 lines) fall back to
/// treating the whole file as replaced (all old lines deleted, all new lines added) so the cost
/// stays bounded.
pub fn unified_diff(
    old: &str,
    new: &str,
    old_label: &str,
    new_label: &str,
    context: usize,
    max_output_bytes: usize,
) -> DiffSummary {
    if old == new {
        return DiffSummary {
            unified: String::new(),
            additions: 0,
            deletions: 0,
            truncated: false,
        };
    }
    // Lines keep their '\n', so a last line without one differs from the same text with one.
    let a: Vec<&str> = old.split_inclusive('\n').collect();
    let b: Vec<&str> = new.split_inclusive('\n').collect();
    let (deleted, inserted) = changed_lines(&a, &b, MAX_EDIT_DISTANCE)
        .unwrap_or_else(|| (vec![true; a.len()], vec![true; b.len()]));
    let ops = edit_script(&deleted, &inserted);
    let mut out = Output::new(max_output_bytes);
    out.push(&format!("--- {}\n", one_line(old_label)));
    out.push(&format!("+++ {}\n", one_line(new_label)));
    for (lo, hi) in hunks(&ops, context) {
        render_hunk(&mut out, &ops[lo..=hi], &a, &b);
    }
    let truncated = out.truncated;
    if truncated {
        out.text.push_str(TRUNCATED_MARKER);
    }
    DiffSummary {
        unified: out.text,
        additions: inserted.iter().filter(|&&x| x).count(),
        deletions: deleted.iter().filter(|&&x| x).count(),
        truncated,
    }
}

/// A label must not break the header line it sits on.
fn one_line(label: &str) -> String {
    label.replace(['\n', '\r'], " ")
}

/// Which old lines are deleted and which new lines are inserted in a minimal edit script, or
/// None when the edit distance exceeds `max_cost` or either side is too long.
fn changed_lines<'a>(
    a: &[&'a str],
    b: &[&'a str],
    max_cost: usize,
) -> Option<(Vec<bool>, Vec<bool>)> {
    if a.len() > MAX_LINES || b.len() > MAX_LINES {
        return None;
    }
    // Intern lines so the search compares integers, not strings.
    let mut ids: HashMap<&'a str, u32> = HashMap::new();
    let xs = intern(&mut ids, a);
    let ys = intern(&mut ids, b);
    // A line with no partner on the other side is an edit whatever the alignment, so this
    // lower bound rejects unrelated files without running the search.
    let mut counts = vec![(0usize, 0usize); ids.len()];
    for &x in &xs {
        counts[x as usize].0 += 1;
    }
    for &y in &ys {
        counts[y as usize].1 += 1;
    }
    let common: usize = counts.iter().map(|&(p, q)| p.min(q)).sum();
    if xs.len() + ys.len() - 2 * common > max_cost {
        return None;
    }
    let mut search = Search::new(&xs, &ys, max_cost);
    search.compare(0, xs.len(), 0, ys.len())?;
    Some((search.deleted, search.inserted))
}

/// Equal lines get equal ids, numbered in order of first appearance.
fn intern<'a>(ids: &mut HashMap<&'a str, u32>, lines: &[&'a str]) -> Vec<u32> {
    lines
        .iter()
        .map(|&line| {
            let next = ids.len() as u32;
            *ids.entry(line).or_insert(next)
        })
        .collect()
}

/// Myers' divide-and-conquer search in linear space: find the middle snake of an optimal
/// path, recurse on both sides, and mark the lines the path deletes or inserts.
struct Search<'a> {
    a: &'a [u32],
    b: &'a [u32],
    /// Furthest x reached per diagonal (x - y) by the forward and the backward search,
    /// indexed by diagonal + `offset`.
    fd: Vec<isize>,
    bd: Vec<isize>,
    offset: isize,
    max_cost: usize,
    deleted: Vec<bool>,
    inserted: Vec<bool>,
}

impl<'a> Search<'a> {
    fn new(a: &'a [u32], b: &'a [u32], max_cost: usize) -> Self {
        // Diagonals run from -len(b) to len(a), plus a sentinel slot at each end.
        let slots = a.len() + b.len() + 3;
        Self {
            a,
            b,
            fd: vec![0; slots],
            bd: vec![0; slots],
            offset: b.len() as isize + 1,
            max_cost,
            deleted: vec![false; a.len()],
            inserted: vec![false; b.len()],
        }
    }

    fn compare(
        &mut self,
        mut xoff: usize,
        mut xlim: usize,
        mut yoff: usize,
        mut ylim: usize,
    ) -> Option<()> {
        // Common ends need no search, and stripping them is what lets the split below assume
        // the box starts and ends with a difference.
        while xoff < xlim && yoff < ylim && self.a[xoff] == self.b[yoff] {
            xoff += 1;
            yoff += 1;
        }
        while xoff < xlim && yoff < ylim && self.a[xlim - 1] == self.b[ylim - 1] {
            xlim -= 1;
            ylim -= 1;
        }
        if xoff == xlim {
            self.inserted[yoff..ylim].fill(true);
        } else if yoff == ylim {
            self.deleted[xoff..xlim].fill(true);
        } else {
            let (x, y) = self.split(xoff, xlim, yoff, ylim)?;
            // Both halves must be strictly smaller, or the recursion would not end; a split
            // that breaks this is a bug, answered with the bounded fallback instead of a hang.
            let inside = (xoff..=xlim).contains(&x) && (yoff..=ylim).contains(&y);
            if !inside || (x, y) == (xoff, yoff) || (x, y) == (xlim, ylim) {
                return None;
            }
            self.compare(xoff, x, yoff, y)?;
            self.compare(x, xlim, y, ylim)?;
        }
        Some(())
    }

    /// A point on an optimal path through the box, about halfway in edit cost. Runs the
    /// forward search from the top-left and the backward search from the bottom-right one
    /// edit at a time until they meet. None when the box's distance exceeds `max_cost`.
    fn split(
        &mut self,
        xoff: usize,
        xlim: usize,
        yoff: usize,
        ylim: usize,
    ) -> Option<(usize, usize)> {
        let (xoff, xlim) = (xoff as isize, xlim as isize);
        let (yoff, ylim) = (yoff as isize, ylim as isize);
        let at = |d: isize, offset: isize| (d + offset) as usize;
        let o = self.offset;
        let dmin = xoff - ylim;
        let dmax = xlim - yoff;
        let fmid = xoff - yoff;
        let bmid = xlim - ylim;
        // With an odd delta the paths meet after an odd total, so the forward pass checks.
        let odd = (fmid - bmid) & 1 != 0;
        let (mut fmin, mut fmax, mut bmin, mut bmax) = (fmid, fmid, bmid, bmid);
        self.fd[at(fmid, o)] = xoff;
        self.bd[at(bmid, o)] = xlim;
        let mut cost = 0usize;
        loop {
            cost += 1;
            // A meeting in this forward pass means a distance of 2 * cost - 1.
            if 2 * cost - 1 > self.max_cost {
                return None;
            }
            // Widen by one diagonal at each end while inside the box; at an edge, step
            // inward so the active diagonals keep the parity of `cost`. The slot past each
            // end gets a sentinel that is never chosen.
            if fmin > dmin {
                fmin -= 1;
                self.fd[at(fmin - 1, o)] = -1;
            } else {
                fmin += 1;
            }
            if fmax < dmax {
                fmax += 1;
                self.fd[at(fmax + 1, o)] = -1;
            } else {
                fmax -= 1;
            }
            let mut d = fmax;
            while d >= fmin {
                let (lo, hi) = (self.fd[at(d - 1, o)], self.fd[at(d + 1, o)]);
                let mut x = if lo < hi { hi } else { lo + 1 };
                let mut y = x - d;
                while x < xlim && y < ylim && self.a[x as usize] == self.b[y as usize] {
                    x += 1;
                    y += 1;
                }
                self.fd[at(d, o)] = x;
                if odd && bmin <= d && d <= bmax && self.bd[at(d, o)] <= x {
                    return Some((x as usize, y as usize));
                }
                d -= 2;
            }
            // A meeting in this backward pass means a distance of 2 * cost.
            if 2 * cost > self.max_cost {
                return None;
            }
            if bmin > dmin {
                bmin -= 1;
                self.bd[at(bmin - 1, o)] = isize::MAX;
            } else {
                bmin += 1;
            }
            if bmax < dmax {
                bmax += 1;
                self.bd[at(bmax + 1, o)] = isize::MAX;
            } else {
                bmax -= 1;
            }
            let mut d = bmax;
            while d >= bmin {
                let (lo, hi) = (self.bd[at(d - 1, o)], self.bd[at(d + 1, o)]);
                let mut x = if lo < hi { lo } else { hi - 1 };
                let mut y = x - d;
                while x > xoff && y > yoff && self.a[(x - 1) as usize] == self.b[(y - 1) as usize] {
                    x -= 1;
                    y -= 1;
                }
                self.bd[at(d, o)] = x;
                if !odd && fmin <= d && d <= fmax && x <= self.fd[at(d, o)] {
                    return Some((x as usize, y as usize));
                }
                d -= 2;
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    /// Old line, new line: unchanged.
    Keep(usize, usize),
    /// Old line removed; the new-side position is where it would have been.
    Delete(usize, usize),
    /// New line added; the old-side position is where it goes.
    Insert(usize, usize),
}

impl Op {
    /// Old and new line positions at this op.
    fn position(self) -> (usize, usize) {
        match self {
            Op::Keep(i, j) | Op::Delete(i, j) | Op::Insert(i, j) => (i, j),
        }
    }
}

/// Walk both files in order; within a change, deletions come before insertions.
fn edit_script(deleted: &[bool], inserted: &[bool]) -> Vec<Op> {
    let (n, m) = (deleted.len(), inserted.len());
    let mut ops = Vec::with_capacity(n.max(m));
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && (deleted[i] || j == m) {
            ops.push(Op::Delete(i, j));
            i += 1;
        } else if j < m && (inserted[j] || i == n) {
            ops.push(Op::Insert(i, j));
            j += 1;
        } else {
            ops.push(Op::Keep(i, j));
            i += 1;
            j += 1;
        }
    }
    ops
}

/// Inclusive op ranges of the hunks: each change with `context` unchanged lines around it,
/// merging changes whose gap is at most `2 * context` (their contexts touch).
fn hunks(ops: &[Op], context: usize) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut current: Option<(usize, usize)> = None;
    for (k, op) in ops.iter().enumerate() {
        if matches!(op, Op::Keep(..)) {
            continue;
        }
        current = match current {
            Some((first, last)) if k - last - 1 <= 2 * context => Some((first, k)),
            Some(done) => {
                out.push(done);
                Some((k, k))
            }
            None => Some((k, k)),
        };
    }
    out.extend(current);
    out.into_iter()
        .map(|(first, last)| {
            (
                first.saturating_sub(context),
                last.saturating_add(context).min(ops.len() - 1),
            )
        })
        .collect()
}

fn render_hunk(out: &mut Output, ops: &[Op], a: &[&str], b: &[&str]) {
    let (old_start, new_start) = ops[0].position();
    let old_count = ops.iter().filter(|op| !matches!(op, Op::Insert(..))).count();
    let new_count = ops.iter().filter(|op| !matches!(op, Op::Delete(..))).count();
    // An empty range names the line before it, so an empty old file reads "-0,0".
    let old_first = if old_count == 0 { old_start } else { old_start + 1 };
    let new_first = if new_count == 0 { new_start } else { new_start + 1 };
    out.push(&format!(
        "@@ -{old_first},{old_count} +{new_first},{new_count} @@\n"
    ));
    for op in ops {
        match *op {
            Op::Keep(i, _) => out.line(' ', a[i]),
            Op::Delete(i, _) => out.line('-', a[i]),
            Op::Insert(_, j) => out.line('+', b[j]),
        }
    }
}

/// Text with a byte budget: once a line would not fit, it and everything after is dropped.
struct Output {
    text: String,
    max: usize,
    truncated: bool,
}

impl Output {
    fn new(max: usize) -> Self {
        Self {
            text: String::new(),
            max,
            truncated: false,
        }
    }

    fn push(&mut self, piece: &str) {
        if self.truncated {
            return;
        }
        if self.text.len() + piece.len() > self.max {
            self.truncated = true;
            return;
        }
        self.text.push_str(piece);
    }

    /// One diff line; a line without its newline carries the marker, kept with it so a cut
    /// never separates the two.
    fn line(&mut self, prefix: char, text: &str) {
        let mut piece = String::with_capacity(text.len() + 2 + NO_NEWLINE_MARKER.len());
        piece.push(prefix);
        piece.push_str(text);
        if !text.ends_with('\n') {
            piece.push('\n');
            piece.push_str(NO_NEWLINE_MARKER);
        }
        self.push(&piece);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    const BIG: usize = 1 << 24;

    fn numbered(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("line {i}")).collect()
    }

    fn text(lines: &[String]) -> String {
        lines.iter().map(|l| format!("{l}\n")).collect()
    }

    fn hunk_headers(unified: &str) -> Vec<&str> {
        unified.lines().filter(|l| l.starts_with("@@")).collect()
    }

    #[test]
    fn identical_texts_give_an_empty_diff() {
        let d = unified_diff("a\nb\n", "a\nb\n", "old", "new", 3, BIG);
        assert_eq!(
            d,
            DiffSummary {
                unified: String::new(),
                additions: 0,
                deletions: 0,
                truncated: false,
            }
        );
        assert_eq!(unified_diff("", "", "o", "n", 3, BIG).unified, "");
    }

    #[test]
    fn insertion_into_an_empty_file() {
        let d = unified_diff("", "x\ny\n", "a/f", "b/f", 3, BIG);
        assert_eq!(d.unified, "--- a/f\n+++ b/f\n@@ -0,0 +1,2 @@\n+x\n+y\n");
        assert_eq!((d.additions, d.deletions, d.truncated), (2, 0, false));
    }

    #[test]
    fn pure_deletion() {
        let d = unified_diff("x\ny\n", "", "a/f", "b/f", 3, BIG);
        assert_eq!(d.unified, "--- a/f\n+++ b/f\n@@ -1,2 +0,0 @@\n-x\n-y\n");
        assert_eq!((d.additions, d.deletions), (0, 2));

        let d = unified_diff("a\nb\nc\nd\n", "a\nd\n", "o", "n", 3, BIG);
        assert_eq!(d.unified, "--- o\n+++ n\n@@ -1,4 +1,2 @@\n a\n-b\n-c\n d\n");
    }

    #[test]
    fn middle_change_has_three_context_lines_each_side() {
        let old = numbered(100);
        let mut new = old.clone();
        new[49] = "changed 50".into();
        let d = unified_diff(&text(&old), &text(&new), "o", "n", 3, BIG);
        assert_eq!(
            d.unified,
            concat!(
                "--- o\n+++ n\n@@ -47,7 +47,7 @@\n",
                " line 47\n line 48\n line 49\n",
                "-line 50\n+changed 50\n",
                " line 51\n line 52\n line 53\n",
            )
        );
        assert_eq!((d.additions, d.deletions), (1, 1));
    }

    #[test]
    fn distant_changes_make_two_hunks() {
        let old = numbered(100);
        let mut new = old.clone();
        new[9] = "ten".into();
        new[79] = "eighty".into();
        let d = unified_diff(&text(&old), &text(&new), "o", "n", 3, BIG);
        assert_eq!(hunk_headers(&d.unified), ["@@ -7,7 +7,7 @@", "@@ -77,7 +77,7 @@"]);
    }

    #[test]
    fn changes_within_twice_the_context_share_a_hunk() {
        let old = numbered(40);
        let headers = |second: usize| {
            let mut new = old.clone();
            new[9] = "first".into();
            new[second] = "second".into();
            let d = unified_diff(&text(&old), &text(&new), "o", "n", 3, BIG);
            hunk_headers(&d.unified)
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        };
        // Lines 10 and 17: six unchanged lines between, the contexts touch.
        assert_eq!(headers(16), ["@@ -7,14 +7,14 @@"]);
        // Lines 10 and 18: seven between, two hunks.
        assert_eq!(headers(17), ["@@ -7,7 +7,7 @@", "@@ -15,7 +15,7 @@"]);
    }

    #[test]
    fn missing_final_newline_is_marked_on_either_side() {
        let d = unified_diff("a\nb", "a\nc", "o", "n", 3, BIG);
        assert_eq!(
            d.unified,
            concat!(
                "--- o\n+++ n\n@@ -1,2 +1,2 @@\n a\n",
                "-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n",
            )
        );
        let d = unified_diff("a\nb\n", "a\nb", "o", "n", 3, BIG);
        assert_eq!(
            d.unified,
            "--- o\n+++ n\n@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n"
        );
        let d = unified_diff("a", "a\n", "o", "n", 3, BIG);
        assert_eq!(
            d.unified,
            "--- o\n+++ n\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+a\n"
        );
    }

    #[test]
    fn counts_match_the_marked_lines() {
        let old = "keep\nold1\nold2\nkeep2\nx\n";
        let new = "keep\nnew1\nkeep2\nx\ny\nz\n";
        let d = unified_diff(old, new, "o", "n", 1, BIG);
        let body: Vec<&str> = d.unified.lines().skip(2).collect();
        let plus = body.iter().filter(|l| l.starts_with('+')).count();
        let minus = body.iter().filter(|l| l.starts_with('-')).count();
        assert_eq!((d.additions, d.deletions), (3, 2));
        assert_eq!((plus, minus), (3, 2));
    }

    #[test]
    fn truncation_cuts_at_a_line_boundary_and_keeps_full_counts() {
        let old = text(&numbered(50));
        let new: String = (1..=50).map(|i| format!("other {i}\n")).collect();
        let d = unified_diff(&old, &new, "o", "n", 3, 100);
        assert!(d.truncated);
        let kept = d
            .unified
            .strip_suffix(TRUNCATED_MARKER)
            .expect("ends with the truncation line");
        assert!(kept.len() <= 100, "{}", kept.len());
        assert!(kept.ends_with('\n'));
        assert!(kept.starts_with("--- o\n+++ n\n@@ -1,50 +1,50 @@\n-line 1\n"));
        assert_eq!((d.additions, d.deletions), (50, 50));
        assert!(!unified_diff(&old, &new, "o", "n", 3, BIG).truncated);
    }

    #[test]
    fn unrelated_large_texts_fall_back_quickly() {
        let old: String = (0..30_000).map(|i| format!("old {i}\n")).collect();
        let new: String = (0..30_000).map(|i| format!("new {i}\n")).collect();
        let started = Instant::now();
        let d = unified_diff(&old, &new, "o", "n", 3, 1 << 16);
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        assert_eq!((d.additions, d.deletions), (30_000, 30_000));
        assert!(d.truncated);
        assert!(d.unified.starts_with("--- o\n+++ n\n@@ -1,30000 +1,30000 @@\n-old 0\n"));
    }

    #[test]
    fn search_gives_up_past_its_cost_budget() {
        // Same lines in another order: the multiset bound passes, so the search itself
        // must notice the distance.
        let a = ["p\n", "q\n"];
        let b = ["q\n", "p\n"];
        assert!(changed_lines(&a, &b, 2).is_some());
        assert!(changed_lines(&a, &b, 1).is_none());

        let lines: Vec<String> = (0..200).map(|i| format!("{i}\n")).collect();
        let a: Vec<&str> = lines.iter().map(String::as_str).collect();
        let b: Vec<&str> = a.iter().rev().copied().collect();
        assert!(changed_lines(&a, &b, 50).is_none());
        let (del, ins) = changed_lines(&a, &b, usize::MAX).unwrap();
        // Reversal keeps exactly one line in common.
        assert_eq!(del.iter().filter(|&&x| x).count() + ins.iter().filter(|&&x| x).count(), 398);
    }

    #[test]
    fn edit_scripts_are_valid_and_minimal() {
        // Compare against a dynamic-programming LCS on many small pseudo-random inputs,
        // including lopsided sizes that push the search into the box edges.
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = move |bound: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % bound) as usize
        };
        for case in 0..3000 {
            let (n, m) = match case % 3 {
                0 => (next(25), next(25)),
                1 => (next(40), next(4)),
                _ => (next(4), next(40)),
            };
            let alphabet = 1 + next(5) as u64;
            let a: Vec<String> = (0..n).map(|_| format!("{}\n", next(alphabet))).collect();
            let b: Vec<String> = (0..m).map(|_| format!("{}\n", next(alphabet))).collect();
            let a: Vec<&str> = a.iter().map(String::as_str).collect();
            let b: Vec<&str> = b.iter().map(String::as_str).collect();
            let (del, ins) = changed_lines(&a, &b, usize::MAX).expect("no budget");
            let mut kept = 0;
            for op in edit_script(&del, &ins) {
                if let Op::Keep(i, j) = op {
                    assert_eq!(a[i], b[j], "case {case}: kept lines differ");
                    kept += 1;
                }
            }
            let mut lcs = vec![vec![0usize; m + 1]; n + 1];
            for i in (0..n).rev() {
                for j in (0..m).rev() {
                    lcs[i][j] = if a[i] == b[j] {
                        lcs[i + 1][j + 1] + 1
                    } else {
                        lcs[i + 1][j].max(lcs[i][j + 1])
                    };
                }
            }
            assert_eq!(kept, lcs[0][0], "case {case}: not minimal");
            assert_eq!(del.iter().filter(|&&x| x).count(), n - kept);
            assert_eq!(ins.iter().filter(|&&x| x).count(), m - kept);
        }
    }

    #[test]
    fn output_is_deterministic() {
        let old = "a\nb\nc\nd\ne\nf\ng\n";
        let new = "a\nc\nb\nd\nx\nf\ng\nh\n";
        let first = unified_diff(old, new, "o", "n", 2, BIG);
        for _ in 0..20 {
            assert_eq!(unified_diff(old, new, "o", "n", 2, BIG), first);
        }
        // The classic example from Myers' paper has distance 5.
        let d = unified_diff("a\nb\nc\na\nb\nb\na\n", "c\nb\na\nb\na\nc\n", "o", "n", 3, BIG);
        assert_eq!(d.additions + d.deletions, 5);
    }
}
