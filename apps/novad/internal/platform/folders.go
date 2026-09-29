package platform

import "slices"

// FolderNames are the folders a fs path may name as @<name> (S42b P16),
// resolved on the machine as its OS names them — never guessed from a user
// name. "home" is the user's profile directory.
var FolderNames = []string{"home", "desktop", "documents", "downloads"}

// KnownFolder is whether name is one of FolderNames.
func KnownFolder(name string) bool { return slices.Contains(FolderNames, name) }
