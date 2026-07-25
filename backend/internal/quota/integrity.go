package quota

import (
	"context"
	"fmt"
)

// Data-integrity checks for the billing ledger, surfaced in the admin
// back-office (internal/adminconsole's GET /admin/api/integrity).
//
// These exist because the ledger has invariants the schema alone cannot
// fully enforce, and a violation is silent by nature: usage simply comes out
// lower than it should, and nobody notices until the numbers are audited.
// The specific bug that motivated this file — usage_events.app_id being
// ON DELETE CASCADE, so deleting an app erased its billing history and reset
// the owner's monthly quota — was invisible in every existing surface,
// because the "correct" count was computed from whatever rows still existed.
//
// Each check is a counting query: 0 means healthy. They are deliberately
// cheap and read-only, so the admin page can run all of them on load.

// IntegrityCheck is one invariant's result. Count is how many rows violate
// it; OK is Count == 0. Detail explains what a non-zero count means, so the
// admin page doesn't have to hardcode an explanation per check.
type IntegrityCheck struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Count    int    `json:"count"`
	OK       bool   `json:"ok"`
	Severity string `json:"severity"` // "critical" | "warning" | "info"
	Detail   string `json:"detail"`
}

// integrityQueries is the check registry. Adding an invariant here is all it
// takes for it to appear in the admin UI — the handler and the frontend both
// iterate whatever this returns rather than naming checks individually.
var integrityQueries = []struct {
	key      string
	label    string
	severity string
	detail   string
	query    string
}{
	{
		key:      "usage_events_without_owner",
		label:    "Usage rows with no owner",
		severity: "critical",
		detail: "These prompts are billed to nobody: they will never be counted " +
			"against any plan. Rows predating the owner_id column whose app was " +
			"already deleted are unrecoverable; anything newer means Record() " +
			"wrote a row for an app with no owner_id.",
		query: `SELECT count(*) FROM usage_events WHERE owner_id IS NULL`,
	},
	{
		key:      "apps_without_owner",
		label:    "Apps with no owner",
		severity: "critical",
		detail: "An app nobody owns cannot be quota-enforced (ownerStanding " +
			"requires owner_id IS NOT NULL, so Check() fails open) and is " +
			"invisible in the console, which lists apps by owner.",
		query: `SELECT count(*) FROM apps WHERE owner_id IS NULL`,
	},
	{
		key:      "orphaned_usage_events",
		label:    "Usage rows whose app was deleted",
		severity: "info",
		detail: "Expected and healthy: the ledger outlives the app it was " +
			"recorded against (app_id is ON DELETE SET NULL), which is what " +
			"stops delete-and-recreate from resetting someone's quota. Shown " +
			"so the number is auditable, not because it is a problem.",
		query: `SELECT count(*) FROM usage_events WHERE app_id IS NULL AND owner_id IS NOT NULL`,
	},
	{
		key:      "subscriptions_without_user",
		label:    "Subscriptions with no matching user",
		severity: "warning",
		detail: "A plan attached to an account that no longer exists. Should be " +
			"impossible (user_id is ON DELETE CASCADE); a non-zero count means " +
			"rows were written outside the normal path.",
		query: `SELECT count(*) FROM subscriptions s
		          WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id)`,
	},
}

// CheckIntegrity runs every registered invariant and returns one result per
// check, in registry order. An error from any single query aborts the whole
// run: a partial integrity report is worse than none, because a missing
// check reads as a passing one.
func (s *Service) CheckIntegrity(ctx context.Context) ([]IntegrityCheck, error) {
	if s == nil {
		return nil, fmt.Errorf("quota: service is disabled")
	}
	out := make([]IntegrityCheck, 0, len(integrityQueries))
	for _, q := range integrityQueries {
		var n int
		if err := s.db.QueryRowContext(ctx, q.query).Scan(&n); err != nil {
			return nil, fmt.Errorf("quota: integrity check %q: %w", q.key, err)
		}
		out = append(out, IntegrityCheck{
			Key:      q.key,
			Label:    q.label,
			Count:    n,
			OK:       n == 0,
			Severity: q.severity,
			Detail:   q.detail,
		})
	}
	return out, nil
}
