package quota

// This file is the single place plans are defined. A plan maps a
// subscription tier to the concrete limits that tier grants. Quota
// enforcement (quota.go) resolves a user's tier to a Plan here at check
// time and never reads a per-row copy of the number — so changing a plan's
// MonthlyPrompts below immediately applies to every user on that tier, with
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
)

// DefaultTier is assigned to new accounts and assumed for any user whose
// tier can't be resolved (missing row, or a stored tier no longer defined
// in plans — see PlanFor).
const DefaultTier = TierFree

// Plan is the set of limits a tier grants. Today that's just a monthly
// prompt allowance; new limit dimensions (token budgets, concurrent
// sessions, ...) are added as fields here and read wherever they apply.
type Plan struct {
	// Tier is the identifier this plan is keyed by; stored on the user's
	// subscriptions row.
	Tier Tier
	// Name is a human-readable label for UIs and CLI output (e.g. "Free").
	Name string
	// MonthlyPrompts is how many billable prompts this tier includes per
	// billing period. This is THE quota number — editing it here changes the
	// allowance for every user on this tier at once. Placeholder value until
	// a real pricing strategy is decided.
	MonthlyPrompts int
}

// plans is the authoritative table of every defined plan, keyed by tier.
// Only the free tier exists today; paid tiers get added here.
var plans = map[Tier]Plan{
	TierFree: {
		Tier:           TierFree,
		Name:           "Free",
		MonthlyPrompts: 100, // placeholder — set when pricing is decided
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
