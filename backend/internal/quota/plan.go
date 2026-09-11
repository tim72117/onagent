package quota

// This file is the single place plans are defined. A plan maps a
// subscription tier to the concrete limits that tier grants. Quota
// enforcement (quota.go) resolves a user's tier to a Plan here at check
// time and never reads a per-row copy of the number — so changing a plan's
// MonthlyTokens below immediately applies to every user on that tier, with
// no migration and no backfill. Add a new paid tier by adding one entry to
// plans and (optionally) a matching Tier constant.

// Tier is a subscription tier identifier, stored as subscriptions.tier.
// Kept as a plain string (not a DB enum) so a new tier is a code change
// here, never a schema migration.
type Tier string

const (
	// TierFree is the tier every account starts on at signup, and the tier
	// any user with no subscriptions row is treated as.
	TierFree Tier = "free"

	// TierUltra is admin-assignable only — there is no developer-facing
	// console surface that lets a user pick their own tier at all (every
	// caller of SetTier is admin.go's setUserPlan, itself behind
	// adminconsole's withAdmin), so adding it here does not expose any
	// self-service path to it. Existing purely as a manual "grant this one
	// account a much larger allowance" lever, distinct from
	// subscriptions.monthly_quota's per-user override (see
	// userStandingRow.limit): that column has no write path at all today,
	// while this is a normal tier an admin assigns via the existing
	// SetTier/setUserPlan endpoint.
	TierUltra Tier = "ultra"
)

// DefaultTier is assigned to new accounts and assumed for any user whose
// tier can't be resolved (missing row, or a stored tier no longer defined
// in plans — see PlanFor).
const DefaultTier = TierFree

// Plan is the set of limits a tier grants. Today that's just a monthly
// token allowance; new limit dimensions (concurrent sessions, ...) are added
// as fields here and read wherever they apply.
type Plan struct {
	// Tier is the identifier this plan is keyed by; stored on the user's
	// subscriptions row.
	Tier Tier
	// Name is a human-readable label for UIs and CLI output (e.g. "Free").
	Name string
	// MonthlyTokens is how many LLM tokens (prompt + completion, summed from
	// usage_events.total_tokens) this tier includes per billing period. This
	// is THE quota number — editing it here changes the allowance for every
	// user on this tier at once. Replaces the earlier per-prompt-count model
	// (MonthlyPrompts): a plan of N prompts was a poor proxy for actual LLM
	// cost once a single prompt could trigger a variable number of internal
	// provider round-trips (tool-calling loops) each with very different
	// token weight — see quota.usageSince's doc comment.
	MonthlyTokens int
}

// plans is the authoritative table of every defined plan, keyed by tier.
var plans = map[Tier]Plan{
	TierFree: {
		Tier:          TierFree,
		Name:          "Free",
		MonthlyTokens: 100_000,
	},
	// Ultra is not self-service — see TierUltra's own doc comment. An admin
	// assigns it via PUT /admin/api/users/{userId}/plan the same way any
	// other tier is set; it appears in GET /admin/api/plans (AllPlans)
	// automatically, since that endpoint reads this table directly rather
	// than hardcoding a tier list.
	TierUltra: {
		Tier:          TierUltra,
		Name:          "Ultra",
		MonthlyTokens: 10_000_000,
	},
}

// FreePlan is the free tier's plan, the fallback used whenever a specific
// tier can't be resolved. Guaranteed to exist (TierFree is always in plans).
var FreePlan = plans[TierFree]

// PlanFor returns the plan for tier, falling back to the free plan for any
// tier not present in plans. The fallback matters for forward/backward
// safety: a subscriptions row could hold a tier written by a newer build
// (a paid tier since removed, or a typo from a manual UPDATE); resolving it
// to Free fails safe (least privilege) rather than erroring or granting
// unlimited access.
func PlanFor(tier Tier) Plan {
	if p, ok := plans[tier]; ok {
		return p
	}
	return FreePlan
}

// AllPlans returns every defined plan. Order is not guaranteed (map
// iteration); callers that need a stable order should sort. Intended for
// surfacing the plan catalog to a console/CLI.
func AllPlans() []Plan {
	out := make([]Plan, 0, len(plans))
	for _, p := range plans {
		out = append(out, p)
	}
	return out
}
