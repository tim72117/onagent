package quota

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm/clause"
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
	err := s.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"tier", "updated_at"}),
		}).
		Create(&subscriptionUpsertRow{UserID: userID, Tier: string(tier), UpdatedAt: time.Now()}).Error
	if err != nil {
		return fmt.Errorf("quota: set tier: %w", err)
	}
	return nil
}

// subscriptionUpsertRow is a narrower view of subscriptions than
// subscriptionRow — this file's Create only ever supplies user_id/tier/
// updated_at, and giving it its own struct keeps the OnConflict clause's
// DoUpdates list obviously in sync with exactly the columns being set.
type subscriptionUpsertRow struct {
	UserID    int64     `gorm:"column:user_id;primaryKey"`
	Tier      string    `gorm:"column:tier"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
}

func (subscriptionUpsertRow) TableName() string { return "subscriptions" }

// UserSummary is one row of the admin user list: identity plus current plan
// standing. QuotaOverride is non-nil only when this user has a manual
// per-user override set (see subscriptions.monthly_quota).
//
// Tier is "" when this user has no subscriptions row at all — deliberately
// NOT defaulted to DefaultTier the way enforcement (ownerStanding) treats a
// missing row, because that default only works for enforcement (a missing
// row behaves like an explicit free-tier row for the purpose of computing a
// limit). Displaying it as "free" here would be misleading: a real
// subscriptions row has a started_at anchor fixed at insert time (schema
// default now()), while a missing row has no anchor at all, so Used/Limit
// below are both zero rather than computed against a fabricated
// COALESCE(started_at, now()) that resets every time this endpoint is
// called — see the admin-visible symptom this replaced: a real account with
// no subscriptions row (predating Register/LoginOrCreateWithGoogle always
// creating one — see session.go) always showed 0 used, no matter how much
// it had actually been billed for, because "the period" was recomputed as
// starting right now on every single list call.
type UserSummary struct {
	ID            int64     `json:"id"`
	Email         string    `json:"email"`
	Tier          Tier      `json:"tier"` // "" = no subscriptions row (see doc comment above)
	PlanName      string    `json:"planName"`
	Limit         int       `json:"limit"` // effective allowance (override if set, else plan value); 0 when Tier is ""
	Used          int       `json:"used"`  // prompts used in the current period; 0 when Tier is "" (no period to count against)
	QuotaOverride *int      `json:"quotaOverride,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
	AppCount      int       `json:"appCount"` // number of apps this user owns (apps.owner_id)
}

// appOwnerRow mirrors just the column this package needs from the apps
// table, matching the pattern in internal/toolschema (appRow) and
// internal/auth (appAuthRow) — each package defines its own minimal view
// onto shared tables rather than importing another package's model, so a
// future field added to one package's struct can never accidentally widen
// what another package's writes touch.
type appOwnerRow struct {
	OwnerID *int64 `gorm:"column:owner_id"`
}

func (appOwnerRow) TableName() string { return "apps" }

// CountUsers returns the total number of registered developer accounts.
// This is the headline number the admin dashboard shows.
func (s *Service) CountUsers(ctx context.Context) (int, error) {
	if s == nil {
		return 0, fmt.Errorf("quota: service is disabled")
	}
	var n int64
	if err := s.db.WithContext(ctx).Model(&userRow{}).Count(&n).Error; err != nil {
		return 0, fmt.Errorf("quota: count users: %w", err)
	}
	return int(n), nil
}

// ListUsers returns every developer account with its plan standing, newest
// first, for the admin console's user table. A user with no subscriptions
// row is reported with Tier == "" (see UserSummary's doc comment) rather
// than being defaulted to the free tier — that default belongs to
// enforcement (ownerStanding), not to this display-only listing, which
// otherwise fabricates a billing period anchored to "right now" on every
// call and can never show real accumulated usage for such an account.
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
	var scanned []struct {
		ID            int64      `gorm:"column:id"`
		Email         string     `gorm:"column:email"`
		CreatedAt     time.Time  `gorm:"column:created_at"`
		Tier          *string    `gorm:"column:tier"` // NULL when this user has no subscriptions row
		QuotaOverride *int64     `gorm:"column:monthly_quota"`
		StartedAt     *time.Time `gorm:"column:started_at"` // NULL when this user has no subscriptions row
	}
	err := s.db.WithContext(ctx).
		Table("users u").
		Select("u.id, u.email, u.created_at, sub.tier, sub.monthly_quota, sub.started_at").
		Joins("LEFT JOIN subscriptions sub ON sub.user_id = u.id").
		Order("u.id DESC").
		Scan(&scanned).Error
	if err != nil {
		return nil, fmt.Errorf("quota: list users: %w", err)
	}

	type rawUser struct {
		st        ownerStandingRow
		email     string
		createdAt time.Time
		hasSub    bool // false = no subscriptions row at all, not even free
	}
	raw := make([]rawUser, 0, len(scanned))
	for _, row := range scanned {
		ru := rawUser{email: row.Email, createdAt: row.CreatedAt}
		ru.st.ownerID = row.ID
		if row.Tier != nil && row.StartedAt != nil {
			ru.hasSub = true
			ru.st.tier = Tier(*row.Tier)
			ru.st.startedAt = *row.StartedAt
		}
		if row.QuotaOverride != nil {
			v := int(*row.QuotaOverride)
			ru.st.quotaOverride = &v
		}
		raw = append(raw, ru)
	}

	// One GROUP BY over all owners rather than a per-user COUNT (unlike
	// usageSince below, which needs each user's own period start) — app
	// ownership has no time-window parameter, so there's nothing per-user
	// to vary and a single query covers every user in this list.
	var appCounts []struct {
		OwnerID int64 `gorm:"column:owner_id"`
		Count   int   `gorm:"column:count"`
	}
	if err := s.db.WithContext(ctx).
		Model(&appOwnerRow{}).
		Select("owner_id, count(*) as count").
		Where("owner_id IS NOT NULL").
		Group("owner_id").
		Scan(&appCounts).Error; err != nil {
		return nil, fmt.Errorf("quota: count apps per owner: %w", err)
	}
	appCountByOwner := make(map[int64]int, len(appCounts))
	for _, c := range appCounts {
		appCountByOwner[c.OwnerID] = c.Count
	}

	now := time.Now()
	out := make([]UserSummary, 0, len(raw))
	for _, ru := range raw {
		if !ru.hasSub {
			// No real billing-period anchor exists for this account — do not
			// fabricate one via COALESCE(started_at, now()) the way
			// enforcement does, since that resets "the period" to start at
			// call time on every single request, permanently hiding any real
			// usage this account has ever accumulated. Report zero rather
			// than a misleading number.
			out = append(out, UserSummary{
				ID:        ru.st.ownerID,
				Email:     ru.email,
				CreatedAt: ru.createdAt,
				AppCount:  appCountByOwner[ru.st.ownerID],
			})
			continue
		}
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
			AppCount:      appCountByOwner[ru.st.ownerID],
		})
	}
	return out, nil
}
