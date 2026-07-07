package ws

import (
	"crypto/rand"
	"encoding/hex"
)

func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing means the system RNG is broken; nothing
		// downstream can recover meaningfully from a bad session ID.
		panic("ws: failed to generate session id: " + err.Error())
	}
	return hex.EncodeToString(b)
}
