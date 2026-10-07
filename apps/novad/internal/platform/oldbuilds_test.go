package platform

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// OldBuilds lists the builds moved aside in its own directory, by name shape
// alone, and never another directory's: the directory is read, not globbed
// (Task 32 Phase C, C3). "[ab]" as a glob would name the folder "a" beside it.
func TestOldBuildsListsOnlyTheBuildsMovedAsideInItsOwnDirectory(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "[ab]")
	sibling := filepath.Join(root, "a")
	for _, d := range []string{dir, sibling} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	listed := []string{
		"novad.old-1790000000000000001",
		"novad.prev.old-1790000000000000002",
		"novad.new.old-1790000000000000003",
		"novad.failed.old-1790000000000000004",
		"novad.installing.old-1790000000000000005",
	}
	unlisted := []string{
		"novad", "novad.prev", "novad.new", "novad.old-", "novad.old-backup",
		"novad.prev.old-17x", "novad.other.old-1790000000000000006",
		"novadx.old-1790000000000000007", "other.old-1790000000000000008",
	}
	for _, f := range append(append([]string{}, listed...), unlisted...) {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("a build"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range listed {
		if err := os.WriteFile(filepath.Join(sibling, f), []byte("a build"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got, err := OldBuilds(dir, "novad")
	if err != nil {
		t.Fatal(err)
	}
	var want []string
	for _, f := range listed {
		want = append(want, filepath.Join(dir, f))
	}
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("OldBuilds(%s) = %q\nwant %q", dir, got, want)
	}
	if none, err := OldBuilds(filepath.Join(root, "absent"), "novad"); none != nil || err != nil {
		t.Fatalf("a directory that does not exist holds no builds, got %q, %v", none, err)
	}
}
