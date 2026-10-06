package platform

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
)

// FileSHA256 is the lowercase hex sha256 of the file at path, streamed from
// disk. It is the one file hash novad checks a build with (S42b): supervise
// before it swaps a staged update in, install after it copies itself into
// place. A missing file stays fs.ErrNotExist (errors.Is).
func FileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
