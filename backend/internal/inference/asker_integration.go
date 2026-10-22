//go:build integration

package inference

// LookupAskerForTest exposes lookupAsker to other packages' integration
// tests (internal/ws's transport flow tests), which need to drive a real
// AskInteraction against whatever Session the transport registered. Only
// compiled under the integration build tag, so it never exists in a
// production binary.
func LookupAskerForTest(sessionID string) (InteractionAsker, bool) {
	return lookupAsker(sessionID)
}
