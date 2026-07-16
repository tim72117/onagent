package quota

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// This file holds the read/write operations the admin back-office
// (internal/adminconsole) uses to view accounts and change their plans.
// They live in the quota package because that is where the subscriptions
// table and the plan model already live; the admin API layer only presents
// what these return and calls SetTier to make changes.

// SetTier changes a user's subscription tier, creating the subscriptions
// row if the user somehow lacks one (upsert), so setting a plan always
// takes effect even for a user predating the subscriptions table. The tier
// must be one defined in plans — an unknown tier is rejected rather than
// silently stored (a stored-but-undefined tier would resolve back to Free
// via PlanFor, which would be a confusing silent downgrade). This does NOT
// touch monthly_quota: the per-user override, if any, is left as-is.
func (s *Service) SetTier(ctx context.Context, userID int64, tier Tier) error {
	if s == nil {
		return fmt.Errorf("quota: service is disabled")
	}
	if _, ok := plans[tier]; !ok {
		return fmt.Errorf("quota: unknown tier %q", tier)
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO subscriptions (user_id, tier, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (user_id) DO UPDATE SET tier = EXCLUDED.tier, updated_at = now()`,
		userID, string(tier))
	if err != nil {
		return fmt.Errorf("quota: set tier: %w", err)
	}
	return nil
}

// UserSummary is one row of the admin user list: identity plus current plan
// standing. QuotaOverride is non-nil only when this user has a manual
// per-user override set (see subscriptions.monthly_quota).
type UserSummary struct {
	ID            int64      `json:"id"`
	Email         string     `json:"email"`
	Tier          Tier       `json:"tier"`
	PlanName      string     `json:"planName"`
	Limit         int        `json:"limit"` // effective allowance (override if set, else plan value)
	Used          int        `json:"used"`  // prompts used in the current period
	QuotaOverride *int       `json:"quotaOverride,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
}

// CountUsers returns the total number of registered developer accounts.
// This is the headline number the admin dashboard shows.
func (s *Service) CountUsers(ctx context.Context) (int, error) {
	if s == nil {
		return 0, fmt.Errorf("quota: service is disabled")
	}
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		return 0, fmt.Errorf("quota: count users: %w", err)
	}
	return n, nil
}

// ListUsers returns every developer account with its plan standing, newest
// first, for the admin console's user table. A user with no subscriptions
// row is reported on the default (free) tier with no override, matching how
// enforcement treats them.
//
// Per-user current usage is computed in Go (one COUNT per user, each over
// that user's own billing period) rather than in a single SQL statement,
// because each user's period start depends on their own anchor day —
// straightforward in Go, awkward in SQL. This is a low-frequency admin
// listing over an early-stage user count, so the per-user query is fine;
// if the account count ever grows large this is the place to switch to a
// windowed/aggregated query.
func (s *Service) ListUsers(ctx context.Context) ([]UserSummary, error) {
	if s == nil {
		return nil, fmt.Errorf("quota: service is disabled")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, u.email, u.created_at,
		       COALESCE(sub.tier, $1) AS tier,
		       sub.monthly_quota,
		       COALESCE(sub.started_at, now()) AS started_at
		  FROM users u
		  LEFT JOIN subscriptions sub ON sub.user_id = u.id
		 ORDER BY u.id DESC`,
		string(DefaultTier))
	if err != nil {
		return nil, fmt.Errorf("quota: list users: %w", err)
	}
	defer rows.Close()

	type rawUser struct {
		st        ownerStandingRow
		email     string
		createdAt time.Time
	}
	var raw []rawUser
	for rows.Next() {
		var (
			ru       rawUser
			tier     string
			override *int
		)
		var overrideN sql.NullInt64
		if err := rows.Scan(&ru.st.ownerID, &ru.email, &ru.createdAt, &tier, &overrideN, &ru.st.startedAt); err != nil {
			return nil, fmt.Errorf("quota: scan user: %w", err)
		}
		ru.st.tier = Tier(tier)
		if overrideN.Valid {
			v := int(overrideN.Int64)
			override = &v
		}
		ru.st.quotaOverride = override
		raw = append(raw, ru)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("quota: iterate users: %w", err)
	}

	now := time.Now()
	out := make([]UserSummary, 0, len(raw))
	for _, ru := range raw {
		periodStart := currentPeriodStart(ru.st.startedAt, now)
		used, err := s.usageSince(ctx, ru.st.ownerID, periodStart)
		if err != nil {
			return nil, err
		}
		out = append(out, UserSummary{
			ID:            ru.st.ownerID,
			Email:         ru.email,
			Tier:          ru.st.tier,
			PlanName:      PlanFor(ru.st.tier).Name,
			Limit:         ru.st.limit(),
			Used:          used,
			QuotaOverride: ru.st.quotaOverride,
			CreatedAt:     ru.createdAt,
		})
	}
	return out, nil
}
