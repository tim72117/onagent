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
	"database/sql"
	"fmt"
	"time"

	"github.com/tim72117/want/types"
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
	// monthly token allowance; Used is the tokens already recorded this
	// period (sum of usage_events.total_tokens, not a prompt count — see
	// usageSince's doc comment).
	Used  int
	Limit int
}

// allowed is the decision returned whenever no enforcement applies.
var allowed = Decision{Allowed: true}

// Check reports whether a new billable prompt is permitted for userID right
// now. A nil Service (disabled) always allows. A userID with no resolvable
// standing (unknown user id — should not happen for a real caller, see each
// AppResolver's own doc comment on where userID comes from) also always
// allows: quota is a property of a paying user, and there is no one to bill.
// Any database error is returned to the caller to decide fail-open vs.
// fail-closed at the call site (see ws.Handler and ws.Session, which
// log-and-allow so a transient DB blip never wrongly blocks a legitimate
// user).
//
// userID is deliberately NOT derived from appID here (that was this
// function's original design, via ownerStanding — an app's OWNER's
// standing, regardless of who is actually connected). Every caller now
// resolves userID itself at the point it already knows who is billed for
// this specific connection — APIKeyResolver.ResolveApp resolves the app's
// owner (a real end-user site has no billable account of its own),
// internal/console's playgroundResolver resolves the signed-in Playground
// visitor (who, for a Public app, may be a completely different person from
// the app's owner) — see AppResolver.ResolveApp's own doc comment. This is
// what closes the gap where a public app's quota gate checked the owner's
// standing while quota.Record billed the connecting visitor: the two were
// silently checking/billing two different people for the same connection.
func (s *Service) Check(ctx context.Context, userID int64) (Decision, error) {
	if s == nil {
		return allowed, nil
	}

	st, ok, err := s.userStanding(ctx, userID)
	if err != nil {
		return Decision{}, err
	}
	if !ok {
		// Unknown user id — nobody to charge.
		return allowed, nil
	}

	limit := st.limit()
	periodStart := currentPeriodStart(st.startedAt, time.Now())
	used, err := s.usageSince(ctx, userID, periodStart)
	if err != nil {
		return Decision{}, err
	}

	return Decision{
		Allowed: used < limit,
		Used:    used,
		Limit:   limit,
	}, nil
}

// Record appends one usage event for appID, billed to userID. A nil Service
// (disabled) is a no-op. WantService.Complete (internal/inference/want.go)
// calls this once per provider round-trip, as that round-trip's own usage
// event arrives — not once at the very end of a prompt — specifically so a
// prompt whose connection closes mid-turn (while waiting on a tool_result)
// still gets the tokens it already spent recorded, rather than losing them
// when the caller's Complete call returns an error instead of a Result. A
// single user-visible prompt that triggers several round-trips (a
// tool-calling loop) therefore produces several rows here, all sharing that
// prompt's RequestID as eventID; usageSince sums total_tokens across all of
// them rather than de-duplicating by eventID, since each row's usage is that
// round-trip's OWN token cost, not a running total (see
// TestComplete_SumsUsageAcrossToolUseRounds).
//
// usage is the LLM provider's own token accounting for this event
// (inference.Result.Usage / the per-round-trip usage want reports) and IS
// what quota enforcement checks (see usageSince). nil is a supported value
// (MockService, or a provider event that never reported usage) and leaves
// the token columns NULL, contributing 0 toward the owner's period total.
//
// userID is who this event is billed to — the connection's actual operator
// at the moment the usage happened, not necessarily appID's owner. For the
// real Agent Bridge SDK path (ws.APIKeyResolver) that IS the app's owner
// (an anonymous site visitor has no billable account of their own — the
// developer who owns the app pays for their traffic); for the console
// Playground (playgroundResolver) it is the signed-in developer actually
// driving that Playground session, who may not own the app being tried (see
// toolschema.App.Public). Both resolvers compute this once at handshake
// time and it rides along on ws.Session for the life of the connection —
// see AppResolver.ResolveApp's userID return and Session.userID.
//
// Passed in rather than resolved here by joining through apps (the previous
// design): that join meant Record could only ever bill the app's owner,
// which is wrong once a public app's usage must bill its actual visitor,
// not its owner. A caller that has already verified appID exists (both
// resolvers do, at handshake, before a Session/AgentID ever forms) supplying
// userID directly is both correct for that case and one less query per
// event. A Record call against an app_id that no longer exists by the time
// this INSERT runs is now a foreign-key error, not a silent no-op — see
// TestRecordAgainstUnknownAppIsANoOp's rename/doc-comment update explaining
// why that's an acceptable, even correct, behavior change.
//
// eventID is stored for audit/debugging only — it is NOT a deduplication
// key (see docs/known-issues-pending-discussion.md's "用量記錄機制"
// section for the history of why an INSERT ... ON CONFLICT DO NOTHING
// dedup was tried and abandoned). A caller retrying the same RequestID, or
// a single prompt's several round-trips sharing one RequestID, are both
// expected to each insert their own row — undercounting a real cost is a
// worse failure mode here than an occasional overcount, with no real
// payment processing yet (free tier only). Revisit this once Stripe
// billing lands (see docs/refactor-subscription-billing-cycle-2026-09-03.md)
// — real money changes which side of this tradeoff is safer.
func (s *Service) Record(ctx context.Context, appID string, userID int64, eventID string, usage *types.Usage) error {
	if s == nil {
		return nil
	}
	var promptTokens, completionTokens, totalTokens *int
	if usage != nil {
		promptTokens = &usage.PromptTokens
		completionTokens = &usage.CompletionTokens
		totalTokens = &usage.TotalTokens
	}
	// A plain INSERT now that owner_id comes from the caller instead of a
	// join through apps — no more insert-select, and no more race window to
	// avoid (the previous design's SELECT ... FROM apps existed purely to
	// resolve owner_id at write time; userID replaces that read entirely).
	// Kept as raw SQL rather than a GORM struct Create for symmetry with the
	// rest of this file's writes and to keep the token-columns-as-NULL
	// handling (promptTokens etc. as *int) explicit at the call site.
	tx := s.db.WithContext(ctx).Exec(`
		INSERT INTO usage_events (app_id, owner_id, event_id, kind, prompt_tokens, completion_tokens, total_tokens)
		VALUES ($1, $2, $3, 'prompt', $4, $5, $6)`,
		appID, userID, eventID, promptTokens, completionTokens, totalTokens)
	if tx.Error != nil {
		return fmt.Errorf("quota: record usage event: %w", tx.Error)
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

	// Deliberately NOT er.RowsAffected == 0 semantics — StandingFor has
	// always run this query directly and treated a missing users row as an
	// error condition (gorm.ErrRecordNotFound below), unlike userStanding's
	// ok=false (which Check treats as "nobody to charge", not an error).
	// Kept as its own query rather than delegating to userStanding for that
	// reason: the two callers want different behavior on a not-found user,
	// not just a different return shape.
	st, ok, err := s.userStanding(ctx, ownerID)
	if err != nil {
		return Standing{}, fmt.Errorf("quota: resolve standing: %w", err)
	}
	if !ok {
		return Standing{}, fmt.Errorf("quota: resolve standing: %w", gorm.ErrRecordNotFound)
	}
	startedAt := st.startedAt

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

// userStanding resolves userID directly to the billing facts needed to
// compute a limit, in one query — the same users/subscriptions join
// StandingFor runs, but returning the raw row (pre-limit, pre-Used) rather
// than an assembled Standing, since Check also needs periodStart before it
// can call usageSince. ok is false when userID has no row in `users` at all
// (should not happen for a real caller — see Check's own doc comment on
// where userID comes from).
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
func (s *Service) userStanding(ctx context.Context, userID int64) (st userStandingRow, ok bool, err error) {
	var scanned standingScanRow
	res := s.db.WithContext(ctx).
		Table("users u").
		Select("COALESCE(sub.tier, ?) AS tier, sub.monthly_quota AS quota_override, COALESCE(sub.started_at, now()) AS started_at", string(DefaultTier)).
		Joins("LEFT JOIN subscriptions sub ON sub.user_id = u.id").
		Where("u.id = ?", userID).
		Scan(&scanned)
	if res.Error != nil {
		return userStandingRow{}, false, fmt.Errorf("quota: resolve user standing: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return userStandingRow{}, false, nil
	}
	st = userStandingRow{tier: Tier(scanned.Tier), startedAt: scanned.StartedAt}
	if scanned.QuotaOverride != nil {
		v := int(*scanned.QuotaOverride)
		st.quotaOverride = &v
	}
	return st, true, nil
}

// userStandingRow is the raw billing facts for a user (see userStanding).
// limit derivation happens in Check, not here.
type userStandingRow struct {
	tier          Tier
	quotaOverride *int // nil unless a per-user override is set on the row
	startedAt     time.Time
}

// limit returns the effective monthly token allowance: the per-user
// override if one is set, otherwise the tier's plan value. Centralizing
// this here keeps "override beats plan" in one place.
func (r userStandingRow) limit() int {
	if r.quotaOverride != nil {
		return *r.quotaOverride
	}
	return PlanFor(r.tier).MonthlyTokens
}

// usageSince sums total_tokens charged to ownerID since periodStart — this
// IS what quota enforcement checks against a plan's Limit (see Check),
// alongside being what StandingFor/ListUsers surface as "used" for display.
// This is the O(n)-over-the-ledger query the
// usage_events(owner_id, created_at) index exists to keep fast.
//
// SUM over total_tokens, not COUNT(*) or COUNT(DISTINCT event_id): a plan
// measured in prompt *count* was a poor proxy for actual LLM cost once a
// single prompt could trigger a variable number of internal provider
// round-trips (tool-calling loops), each with very different token weight —
// see plan.go's MonthlyTokens doc comment. WantService.Complete (see
// internal/inference/want.go) records one usage_events row per round-trip,
// all sharing that prompt's RequestID as event_id; summing every row's
// total_tokens (rather than de-duplicating by event_id first) is correct
// here specifically because each round-trip's usage event is that
// round-trip's OWN token cost, not a running total that already includes
// the rounds before it — see TestComplete_SumsUsageAcrossToolUseRounds
// (internal/inference/want_test.go), which locks in that assumption at the
// provider-usage layer.
//
// Deliberately reads owner_id off the ledger row instead of joining apps:
// the join meant a deleted app's rows stopped being counted (and, while the
// FK still cascaded, stopped existing at all), so deleting and recreating an
// app reset the period's usage to zero.
//
// SUM over a NULL-only column returns SQL NULL, not 0, hence the
// sql.NullInt64 scan target — a period with no usage rows, or whose rows
// never reported usage (MockService, or a provider event that never
// arrived), must read back as 0 tokens, not an error.
func (s *Service) usageSince(ctx context.Context, ownerID int64, periodStart time.Time) (int, error) {
	var total sql.NullInt64
	if err := s.db.WithContext(ctx).
		Model(&usageEventRow{}).
		Where("owner_id = ? AND created_at >= ?", ownerID, periodStart).
		Select("SUM(total_tokens)").
		Scan(&total).Error; err != nil {
		return 0, fmt.Errorf("quota: sum token usage: %w", err)
	}
	return int(total.Int64), nil
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
