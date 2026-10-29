//go:build integration

package sessionstore

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/png"
	"strings"
	"testing"

	"github.com/tim72117/want/orchestrator"
	"github.com/tim72117/want/types"
)

func testPNG(t *testing.T, size int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, size, size))); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
}

func cleanupBlobs(t *testing.T, s *Store, appIDs ...string) {
	t.Helper()
	del := func() {
		for _, id := range appIDs {
			s.db.Where("app_id = ?", id).Delete(&blobRow{})
		}
	}
	del()
	t.Cleanup(del)
}

func TestBlobs_PutGetRoundTripAndDedup(t *testing.T) {
	s := openTestStore(t)
	cleanupBlobs(t, s, "test-blob-app")
	blobs := s.BlobsForApp("test-blob-app")
	data := testPNG(t, 3)

	ref, err := blobs.Put(data, "image/png")
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if !strings.HasPrefix(ref, "sha256:") {
		t.Errorf("ref = %q, want a sha256: ref", ref)
	}
	again, err := blobs.Put(data, "image/png")
	if err != nil {
		t.Fatalf("second Put of the same bytes: %v", err)
	}
	if again != ref {
		t.Errorf("second Put ref = %q, want the same %q", again, ref)
	}
	var rows int64
	s.db.Model(&blobRow{}).Where("app_id = ?", "test-blob-app").Count(&rows)
	if rows != 1 {
		t.Errorf("rows after two Puts of the same bytes = %d, want 1", rows)
	}

	got, err := blobs.Get(ref)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Error("Get returned different bytes than were Put")
	}
}

// TestBlobs_ScopedPerApp: a ref is only readable by the app that stored
// it — the same isolation ForApp gives session history.
func TestBlobs_ScopedPerApp(t *testing.T) {
	s := openTestStore(t)
	cleanupBlobs(t, s, "test-blob-owner", "test-blob-other")

	ref, err := s.BlobsForApp("test-blob-owner").Put(testPNG(t, 4), "image/png")
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, err := s.BlobsForApp("test-blob-other").Get(ref); !errors.Is(err, types.ErrBlobNotFound) {
		t.Errorf("other app's Get: err = %v, want ErrBlobNotFound", err)
	}
}

func TestBlobs_GetMissingAndMalformed(t *testing.T) {
	blobs := openTestStore(t).BlobsForApp("test-blob-app")

	missing := "sha256:" + strings.Repeat("0", 64)
	if _, err := blobs.Get(missing); !errors.Is(err, types.ErrBlobNotFound) {
		t.Errorf("missing ref: err = %v, want ErrBlobNotFound", err)
	}
	for _, ref := range []string{"", "sha256:abc", "md5:" + strings.Repeat("0", 32), "sha256:" + strings.Repeat("G", 64)} {
		_, err := blobs.Get(ref)
		if err == nil || errors.Is(err, types.ErrBlobNotFound) {
			t.Errorf("malformed ref %q: err = %v, want a non-not-found error", ref, err)
		}
	}
}

// TestBlobs_WiredThroughWant checks the arrangement buildOrchestrator sets
// up: with both stores injected, a user message's image lands in
// agent_blobs, agent_experiences keeps only a ref, and Load hands want the
// original base64 back.
func TestBlobs_WiredThroughWant(t *testing.T) {
	s := openTestStore(t)
	const appID, sessionID = "test-blob-want-app", "test-blob-want-session"
	cleanupBlobs(t, s, appID)
	sessions := s.ForApp(appID)
	sessions.(types.SessionStoreDeleter).DeleteSession(sessionID)
	t.Cleanup(func() { sessions.(types.SessionStoreDeleter).DeleteSession(sessionID) })

	orch := orchestrator.NewOrchestrator("general")
	orch.SetSessionStore(sessions)
	orch.SetBlobStore(s.BlobsForApp(appID))

	data := base64.StdEncoding.EncodeToString(testPNG(t, 5))
	exp := types.Experience{Role: "user", Content: []types.Content{
		types.NewImageContent("image/png", data),
		types.NewTextContent("what is this?"),
	}}
	if err := orch.SessionStore().Append(sessionID, exp, "exp-image"); err != nil {
		t.Fatalf("Append: %v", err)
	}

	var raw experienceRow
	if err := s.db.Where("app_id = ? AND session_id = ?", appID, sessionID).Take(&raw).Error; err != nil {
		t.Fatalf("read stored row: %v", err)
	}
	if bytes.Contains(raw.Data, []byte(data)) {
		t.Error("agent_experiences row still carries the image's base64")
	}
	// JSONB re-serializes with its own spacing, so match the ref's value,
	// not a literal `"ref":"...` key/value pair.
	if !bytes.Contains(raw.Data, []byte(`"sha256:`)) {
		t.Errorf("agent_experiences row has no blob ref: %s", raw.Data)
	}

	history, err := orch.SessionStore().Load(sessionID)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(history) != 1 || len(history[0].Content) != 2 {
		t.Fatalf("Load = %+v, want the one two-part message back", history)
	}
	src := history[0].Content[0].Source
	if src == nil || src.Type != "base64" || src.Data != data {
		t.Errorf("restored image source = %+v, want the original base64", src)
	}
}
