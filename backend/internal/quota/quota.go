// Package quota enforces per-user monthly prompt allowances backed by the
// subscriptions and usage_events tables (see internal/db/schema.sql).
//
// The whole design is deliberately counter-free: usage is an append-only
// ledger (usage_events), "how much has this user used this period" is a
// COUNT(*) computed at read time, and the period boundary is DERIVED from
// each user's subscriptions.started_at anchor rather than reset by a
// scheduled job. That removes the reset-boundary race a mutable running
// counter would otherwise have to guard against — see
// docs/subscription-usage-quota-design.md sections 2 and 3.
//
// Attribution key is the app_id (already carried on every inference call as
// inference.Request.AppID); a user's usage is the sum across every app they
// own, joined through apps.owner_id. Enforcement runs at two points, both
// calling Check: the WebSocket handshake (ws.Handler) to turn away a
// connection whose owner is already over, and per prompt (ws.Session.
// handlePrompt) to stop a long-lived connection from overrunning.
package quota

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// usageEventRow/subscriptionStandingRow are the GORM-mapped shapes queried
// by this file (see internal/db/schema.sql for the authoritative column
// definitions — schema management stays there, not AutoMigrate). Only the
// columns this file actually reads/writes are declared, same convention as
// the other migrated packages.
type usageEventRow struct {
	AppID     *string   `gorm:"column:app_id"`
	OwnerID   *int64    `gorm:"column:owner_id"`
	EventID   string    `gorm:"column:event_id"`
	Kind      string    `gorm:"column:kind"`
	CreatedAt time.Time `gorm:"column:created_at"`
}

func (usageEventRow) TableName() string { return "usage_events" }

// userRow is quota's own narrow view of the users table — deliberately not
// shared with internal/session's own userRow, same convention as apps being
// independently modeled by internal/auth and internal/toolschema. This
// package only ever counts/reads id/email/created_at.
type userRow struct {
	ID        int64     `gorm:"column:id;primaryKey"`
	Email     string    `gorm:"column:email"`
	CreatedAt time.Time `gorm:"column:created_at"`
}

func (userRow) TableName() string { return "users" }


// standingScanRow is the shared Scan() target for StandingFor/ownerStanding
// — both run a COALESCE'd users/apps + subscriptions join and only differ
// in which table they join from and whether owner_id is selected.
type standingScanRow struct {
	OwnerID       int64     `gorm:"column:owner_id"`
	Tier          string    `gorm:"column:tier"`
	QuotaOverride *int64    `gorm:"column:quota_override"`
	StartedAt     time.Time `gorm:"column:started_at"`
}

// Service checks and records usage against the database. A nil *Service is
// a valid, fully-disabled quota system: every method is a no-op that allows
// everything. This mirrors ws.Handler.Auth being nil for local/dev/mock
// runs that have no database — quota enforcement is opt-in on having a real
// DB, and never gets in the way of a no-auth dev server.
type Service struct {
	db *gorm.DB
}

// New returns a Service backed by db. Pass the same *gorm.DB the other
// migrated stores use. Callers that have no database should keep a nil
// *Service instead of constructing one, which disables enforcement
// entirely.
func New(db *gorm.DB) *Service {
	return &Service{db: db}
}

// Decision is the result of a quota Check.
type Decision struct {
	// Allowed is false only when the owner is known and has met or exceeded
	// their allowance for the current period. It is true whenever quota is
	// disabled, the app has no resolvable owner, or the owner is under quota.
	Allowed bool
	// Used and Limit describe the owner's current-period standing when a
	// real check ran (both zero when quota is disabled). Limit is the
	// monthly allowance; Used is the count already recorded this period.
	Used  int
	Limit int
}

// allowed is the decision returned whenever no enforcement applies.
var allowed = Decision{Allowed: true}

// Check reports whether a new billable prompt is permitted for the owner of
// appID right now. A nil Service (disabled) always allows. An app with no
// owner on record (owner_id NULL, or the app is unknown) also always
// allows: quota is a property of a paying user, and an unowned app has no
// user to bill. Any database error is returned to the caller to decide
// fail-open vs. fail-closed at the call site (see ws.Handler and
// ws.Session, which log-and-allow so a transient DB blip never wrongly
// blocks a legitimate user).
func (s *Service) Check(ctx context.Context, appID string) (Decision, error) {
	if s == nil {
		return allowed, nil
	}

	st, ok, err := s.ownerStanding(ctx, appID)
	if err != nil {
		return Decision{}, err
	}
	if !ok {
		// App unknown or unowned — nobody to charge.
		return allowed, nil
	}

	limit := st.limit()
	periodStart := currentPeriodStart(st.startedAt, time.Now())
	used, err := s.usageSince(ctx, st.ownerID, periodStart)
	if err != nil {
		return Decision{}, err
	}

	return Decision{
		Allowed: used < limit,
		Used:    used,
		Limit:   limit,
	}, nil
}

// Record appends one usage event for appID, keyed by eventID for
// idempotency (a retried request carrying the same RequestID is not counted
// twice — the ON CONFLICT below makes the insert a no-op the second time).
// A nil Service (disabled) is a no-op. Callers should record only after the
// billable work actually succeeded (ws.Session.handlePrompt records after
// inference.Complete returns without error).
// owner_id is resolved from the app and stored on the row at write time,
// rather than joined back through apps at read time: that join is what let
// deleting an app erase its usage history (the FK used to cascade), which
// made quota resettable on demand. Denormalizing here means the ledger
// stays correct even after the app it was recorded against is gone.
//
// Resolved inside Record rather than passed in by callers so ws.Session and
// the console playground don't have to carry billing's ownership model
// around — they already only know the appID (see both call sites).
//
// eventID is stored for audit/debugging only — it is NOT used to
// deduplicate anymore (see docs/known-issues-pending-discussion.md's
// "用量記錄機制" section). This used to INSERT ... ON CONFLICT (app_id,
// event_id) DO NOTHING, on the theory that a client retrying the same
// RequestID after a dropped response shouldn't be charged twice. In
// practice, a caller-supplied identifier turned out to be an unreliable
// dedup key: apps/console's Playground reused requestId="0" (a useRef
// counter that resets on every page reload) across page loads sharing the
// same sessionID, so a brand-new prompt silently collided with a real
// prompt's event_id from a previous session — an uncounted prompt, but
// with zero errors anywhere to catch it. With no real payment processing
// yet (free tier only), an occasional double-count from an actual retry
// is a smaller, cheaper-to-accept risk than silently losing usage that
// already happened. Revisit this once Stripe billing lands (see
// docs/refactor-subscription-billing-cycle-2026-09-03.md) — real money
// changes which side of this tradeoff is safer.
func (s *Service) Record(ctx context.Context, appID, eventID string) error {
	if s == nil {
		return nil
	}
	// Insert-select has no GORM builder equivalent, and deliberately isn't
	// split into "look up owner_id, then insert" — that would open a race
	// window where the app is deleted between the two steps, leaving an
	// orphaned or missing usage row. Kept as raw SQL, executed through
	// *gorm.DB so it still runs on the same connection/pool as everything
	// else this Service does.
	err := s.db.WithContext(ctx).Exec(`
		INSERT INTO usage_events (app_id, owner_id, event_id, kind)
		SELECT $1, a.owner_id, $2, 'prompt'
		  FROM apps a
		 WHERE a.app_id = $1`,
		appID, eventID).Error
	if err != nil {
		return fmt.Errorf("quota: record usage event: %w", err)
	}
	return nil
}

// Standing is one owner's current plan + usage snapshot, returned by
// StandingFor for the developer-facing self-service quota endpoint
// (internal/console's GET /console/quota). Field naming mirrors
// UserSummary (admin.go) — Tier/PlanName/Limit/Used name the same facts the
// admin back-office already exposes for a user, so the two surfaces agree
// on vocabulary even though this one is scoped to "me" rather than an
// admin-chosen userId.
type Standing struct {
	Tier        Tier
	PlanName    string
	Limit       int
	Used        int
	PeriodStart time.Time
	PeriodEnd   time.Time
}

// StandingFor returns ownerID's current plan and usage-this-period, keyed by
// owner account rather than by app: quota.go's package doc and usageSince
// both establish that usage is attributed to the app's owner and summed
// across every app that owner has (a user can own multiple apps, and they
// all draw from one shared monthly allowance) — Check/Record already
// enforce at that scope via ownerStanding+usageSince, so this read-only
// method mirrors the same scope rather than reporting per-app. The query
// here is the single-user analog of ListUsers' row query (admin.go): same
// users/subscriptions join, narrowed to one id instead of every account.
//
// PeriodEnd is the next period's start (one billing cycle after
// PeriodStart), computed with the same monthBoundary primitive
// currentPeriodStart uses — exclusive, matching how usageSince's
// periodStart bound is inclusive.
func (s *Service) StandingFor(ctx context.Context, ownerID int64) (Standing, error) {
	if s == nil {
		return Standing{}, fmt.Errorf("quota: service is disabled")
	}

	var scanned standingScanRow
	// started_at's COALESCE fallback is the SQL now() function, evaluated by
	// Postgres at query execution time — deliberately not a Go-side
	// time.Now() bound as a parameter, which would evaluate slightly
	// earlier and shift the period-boundary race this package's tests
	// already document (see quota_integration_test.go's comments on
	// COALESCE(sub.started_at, now()) timing).
	res := s.db.WithContext(ctx).
		Table("users u").
		Select("COALESCE(sub.tier, ?) AS tier, sub.monthly_quota AS quota_override, COALESCE(sub.started_at, now()) AS started_at", string(DefaultTier)).
		Joins("LEFT JOIN subscriptions sub ON sub.user_id = u.id").
		Where("u.id = ?", ownerID).
		Scan(&scanned)
	if res.Error != nil {
		return Standing{}, fmt.Errorf("quota: resolve standing: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return Standing{}, fmt.Errorf("quota: resolve standing: %w", gorm.ErrRecordNotFound)
	}

	st := ownerStandingRow{ownerID: ownerID, tier: Tier(scanned.Tier), startedAt: scanned.StartedAt}
	if scanned.QuotaOverride != nil {
		v := int(*scanned.QuotaOverride)
		st.quotaOverride = &v
	}
	startedAt := scanned.StartedAt

	now := time.Now()
	periodStart := currentPeriodStart(startedAt, now)
	used, err := s.usageSince(ctx, ownerID, periodStart)
	if err != nil {
		return Standing{}, err
	}
	periodEnd := nextPeriodBoundary(startedAt, periodStart)

	return Standing{
		Tier:        st.tier,
		PlanName:    PlanFor(st.tier).Name,
		Limit:       st.limit(),
		Used:        used,
		PeriodStart: periodStart,
		PeriodEnd:   periodEnd,
	}, nil
}

// ownerStanding resolves appID to its owner and the billing facts needed to
// compute a limit, in one query. ok is false when the app is unknown or has
// no owner_id (an unowned app is not billable).
//
// The limit itself is NOT read from the row — it is derived by Check from
// the tier via PlanFor, so editing a plan applies to everyone on that tier
// immediately. The row supplies three things: the tier (defaulting to the
// free tier when there is no subscriptions row, via COALESCE, so a missing
// row behaves like an explicit free-tier row); the billing-cycle anchor
// (started_at); and an OPTIONAL per-user override (monthly_quota), which is
// NULL for everyone by default and, when set, wins over the plan's number —
// this is the manual "grant this one user more" lever, without which the
// plan value applies.
func (s *Service) ownerStanding(ctx context.Context, appID string) (st ownerStandingRow, ok bool, err error) {
	var scanned standingScanRow
	res := s.db.WithContext(ctx).
		Table("apps a").
		Select("a.owner_id, COALESCE(sub.tier, ?) AS tier, sub.monthly_quota AS quota_override, COALESCE(sub.started_at, now()) AS started_at", string(DefaultTier)).
		Joins("LEFT JOIN subscriptions sub ON sub.user_id = a.owner_id").
		Where("a.app_id = ? AND a.owner_id IS NOT NULL", appID).
		Scan(&scanned)
	if res.Error != nil {
		return ownerStandingRow{}, false, fmt.Errorf("quota: resolve owner standing: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return ownerStandingRow{}, false, nil
	}
	st = ownerStandingRow{ownerID: scanned.OwnerID, tier: Tier(scanned.Tier), startedAt: scanned.StartedAt}
	if scanned.QuotaOverride != nil {
		v := int(*scanned.QuotaOverride)
		st.quotaOverride = &v
	}
	return st, true, nil
}

// ownerStandingRow is the raw billing facts for an app's owner (see
// ownerStanding). limit derivation happens in Check, not here.
type ownerStandingRow struct {
	ownerID       int64
	tier          Tier
	quotaOverride *int // nil unless a per-user override is set on the row
	startedAt     time.Time
}

// limit returns the effective monthly prompt allowance: the per-user
// override if one is set, otherwise the tier's plan value. Centralizing
// this here keeps "override beats plan" in one place.
func (r ownerStandingRow) limit() int {
	if r.quotaOverride != nil {
		return *r.quotaOverride
	}
	return PlanFor(r.tier).MonthlyPrompts
}

// usageSince counts billable events charged to ownerID since periodStart.
// This is the O(n)-over-the-ledger query the
// usage_events(owner_id, created_at) index exists to keep fast.
//
// Deliberately reads owner_id off the ledger row instead of joining apps:
// the join meant a deleted app's rows stopped being counted (and, while the
// FK still cascaded, stopped existing at all), so deleting and recreating an
// app reset the period's usage to zero.
func (s *Service) usageSince(ctx context.Context, ownerID int64, periodStart time.Time) (int, error) {
	var n int64
	if err := s.db.WithContext(ctx).
		Model(&usageEventRow{}).
		Where("owner_id = ? AND created_at >= ?", ownerID, periodStart).
		Count(&n).Error; err != nil {
		return 0, fmt.Errorf("quota: count usage: %w", err)
	}
	return int(n), nil
}

// currentPeriodStart returns the start of the billing period containing now,
// anchored to started_at's day-of-month — mirroring Stripe's
// billing_cycle_anchor. It is the most recent month-boundary at or before
// now: e.g. anchored to the 15th, on the 20th the period started this
// month's 15th; on the 10th it started last month's 15th.
//
// Month-end anchors are clamped to the target month's last day, matching
// Stripe's stated behavior ("a billing cycle anchor of January 31 bills
// February 28/29, then March 31..."): an anchor on the 31st yields Feb 28,
// Apr 30, etc., never rolling over into the following month. All arithmetic
// is done in started_at's own location so the boundary lands at the
// intended local wall-clock instant, not shifted by a UTC/zone mismatch.
func currentPeriodStart(startedAt, now time.Time) time.Time {
	loc := startedAt.Location()
	now = now.In(loc)

	// A period boundary is the anchor day-of-month at the anchor
	// time-of-day. Start from "this month's boundary" and step back a month
	// if it hasn't arrived yet.
	anchorDay := startedAt.Day()

	boundary := monthBoundary(now.Year(), now.Month(), anchorDay, startedAt, loc)
	if !boundary.After(now) {
		return boundary
	}
	// This month's boundary is still in the future — the current period
	// began at last month's boundary.
	prevYear, prevMonth := now.Year(), now.Month()-1
	if prevMonth < time.January {
		prevMonth = time.December
		prevYear--
	}
	return monthBoundary(prevYear, prevMonth, anchorDay, startedAt, loc)
}

// nextPeriodBoundary returns the boundary one billing cycle after
// periodStart (itself assumed to already be a boundary returned by
// currentPeriodStart, anchored to startedAt) — i.e. the current period's
// end / the next period's start. It steps periodStart's (year, month)
// forward by one and re-applies monthBoundary's same clamp-to-last-day
// rule, so a 31st anchor rolling out of a clamped short month still lands
// on the correct following boundary (e.g. an anchor of the 31st, with the
// current period start clamped to Feb 28, ends at Mar 31, not Mar 28).
func nextPeriodBoundary(startedAt, periodStart time.Time) time.Time {
	loc := startedAt.Location()
	periodStart = periodStart.In(loc)
	year, month := periodStart.Year(), periodStart.Month()+1
	if month > time.December {
		month = time.January
		year++
	}
	return monthBoundary(year, month, startedAt.Day(), startedAt, loc)
}

// monthBoundary builds the period-boundary instant in (year, month) for the
// given anchor day, clamping the day to that month's last day so a 31st
// anchor never overflows a shorter month. Hour/min/sec/nsec come from the
// anchor so the boundary reproduces the exact time-of-day the subscription
// started.
func monthBoundary(year int, month time.Month, anchorDay int, anchor time.Time, loc *time.Location) time.Time {
	day := anchorDay
	if last := daysInMonth(year, month); day > last {
		day = last
	}
	return time.Date(year, month, day,
		anchor.Hour(), anchor.Minute(), anchor.Second(), anchor.Nanosecond(), loc)
}

// daysInMonth returns the number of days in the given month, leap years
// included. Trick: day 0 of the next month is the last day of this one.
func daysInMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}
