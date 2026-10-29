package sessionstore

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/tim72117/want/types"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// blobRow is the GORM-mapped shape of the agent_blobs table (see
// internal/db/schema.sql for why it exists and how it is keyed).
type blobRow struct {
	AppID     string `gorm:"column:app_id;primaryKey"`
	Hash      string `gorm:"column:hash;primaryKey"`
	MediaType string `gorm:"column:media_type"`
	Data      []byte `gorm:"column:data"`
}

func (blobRow) TableName() string { return "agent_blobs" }

const blobRefPrefix = "sha256:"

var blobHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// BlobsForApp returns a types.BlobStore scoped to appID, the image
// counterpart of ForApp: every Put is stored under appID, and Get only
// finds blobs stored under that same appID. A ref copied from another
// app's history therefore reads as types.ErrBlobNotFound (want degrades
// it to a text placeholder) rather than leaking that app's image.
//
// Injected next to ForApp's SessionStore in
// inference.WantService.buildOrchestrator; want then keeps only a ref in
// agent_experiences.data and restores the base64 on Load.
func (s *Store) BlobsForApp(appID string) types.BlobStore {
	return &scopedBlobs{db: s.db, appID: appID}
}

type scopedBlobs struct {
	db    *gorm.DB
	appID string
}

// Put stores data under its sha256 and returns "sha256:<hex>". Storing the
// same bytes again is a no-op that returns the same ref, as types.BlobStore
// requires.
func (b *scopedBlobs) Put(data []byte, mediaType string) (string, error) {
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	row := blobRow{AppID: b.appID, Hash: hash, MediaType: mediaType, Data: data}
	if err := b.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
		return "", fmt.Errorf("sessionstore: put blob: %w", err)
	}
	return blobRefPrefix + hash, nil
}

// Get returns the bytes behind ref, or types.ErrBlobNotFound when this app
// has no such blob. A malformed ref is reported as an error rather than
// not-found: want only ever hands back refs Put produced, so a malformed
// one means corrupted history, not an expired image.
func (b *scopedBlobs) Get(ref string) ([]byte, error) {
	hash, ok := strings.CutPrefix(ref, blobRefPrefix)
	if !ok || !blobHashPattern.MatchString(hash) {
		return nil, fmt.Errorf("sessionstore: invalid blob ref %q", ref)
	}
	var row blobRow
	err := b.db.Select("data").Where("app_id = ? AND hash = ?", b.appID, hash).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, types.ErrBlobNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("sessionstore: get blob: %w", err)
	}
	return row.Data, nil
}
