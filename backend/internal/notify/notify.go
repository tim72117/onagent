// Package notify is the rule engine — the second layer of the event
// -> rule -> notification -> delivery pipeline (see internal/events'
// package doc comment for the full pipeline this is one stage of). It
// subscribes to an events.Bus and decides, per event, whether a
// notification should be written — the "symptom matches a known rule"
// step between "something happened" (internal/events) and "the user sees
// something" (the not-yet-built delivery layer / console front end).
//
// Two rule shapes exist because they need fundamentally different amounts
// of memory between events:
//
//   - Rule: stateless — one event is enough to decide whether to fire.
//     "A tool was just created" needs nothing remembered from before.
//   - PairRule: stateful — needs to remember whether side A has already
//     happened when side B arrives (or vice versa), possibly minutes or
//     days apart, and that memory must survive a process restart (hence
//     ProgressStore, backed by the rule_progress table — see
//     db/schema.sql's own comment on that table for why an in-memory map
//     isn't good enough).
//
// Rules are a plain Go slice built at process startup (see NewEngine's
// caller in cmd/server/main.go), not stored in — or editable from — the
// database: this product's rule set is small and changes rarely enough
// that "change the rule, redeploy" is simpler than building a rule editor
// nobody has asked for yet.
package notify

import (
	"log/slog"

	"github.com/tim72117/onagent/internal/events"
)

// Notification is what a matched rule produces — the exact row shape
// NotificationStore persists (see db/schema.sql's notifications table).
// Title/Body are already-rendered final text, not a template + params:
// this product has no i18n need today, and freezing the wording at the
// moment a rule fires means a notification reads exactly as it did when
// it was created even if the rule's own wording changes later — see
// db/schema.sql's own comment on notifications for the full reasoning.
type Notification struct {
	SubjectID    string
	RuleName     string
	Title        string
	Body         string
	ActionLabel  string // "" means no suggested next step
	ActionTarget string // "" means no suggested next step
}

// Action is what a matched Rule/PairRule actually does — Build (on both
// Rule and PairRule) returns one of these instead of a bare Notification,
// so a rule's effect isn't hardwired to "always create a new notification
// row." Two implementations exist today:
//
//   - CreateNotification: the original, and still the common, case — write
//     a brand-new row (welcomeRule, first_app_and_feedback).
//   - CompleteNotifications: mark existing 'pending' notifications
//     'completed' — for a rule that reacts to "the suggested next step was
//     actually done" (e.g. a usecase.submitted event completing the
//     welcome notification's own "Join Builder" prompt), rather than to
//     "something new happened that's worth telling the user about."
//
// ruleName is passed into apply separately (not stored on the Action
// value itself) because Engine, not the rule author, is the single place
// that knows which rule produced this action — see Engine.Handle's own
// call sites for where ruleName comes from.
type Action interface {
	apply(store NotificationStore, ruleName string) error
}

// CreateNotification inserts a new notification row — see Action's own
// doc comment for how this fits alongside CompleteNotifications. RuleName
// is overwritten by apply (Engine always knows which rule is running, so
// a rule author's own value there is ignored) — but SubjectID must be set
// by the rule's own Build, same as every existing rule already does (see
// cmd/server/main.go's welcomeRule/firstAppAndFeedbackRule).
type CreateNotification Notification

func (a CreateNotification) apply(store NotificationStore, ruleName string) error {
	n := Notification(a)
	n.RuleName = ruleName
	return store.Insert(n)
}

// CompleteNotifications marks every still-'pending' notification whose
// SubjectID is in SubjectIDs and whose ActionTarget equals Target as
// 'completed' — the action a rule like "usecase.submitted completes the
// welcome notification's Join-Builder prompt" needs: it isn't creating
// anything new, it's closing out a notification some EARLIER rule already
// created. Matching by ActionTarget rather than a specific notification id
// is deliberate — the event that triggers this (e.g. a UseCase form
// submission) has no notification id of its own to reference; it only
// knows what STEP was just completed, and ActionTarget is exactly the
// value that names that step (see console.go's putUseCase, which
// publishes "usecase.submitted" with no notification id in its Metadata
// at all).
type CompleteNotifications struct {
	SubjectIDs []string
	Target     string
}

func (a CompleteNotifications) apply(store NotificationStore, ruleName string) error {
	return store.CompleteByActionTarget(a.SubjectIDs, a.Target)
}

// NotificationStore is the write side of the notifications table this
// package depends on — an interface (not a concrete *gorm.DB dependency)
// so Engine's own tests can substitute an in-memory fake instead of
// requiring a live Postgres for every test that isn't specifically
// exercising the real SQL (see notify_integration_test.go for the
// ones that do).
type NotificationStore interface {
	Insert(n Notification) error
	// CompleteByActionTarget marks every 'pending' notification whose
	// SubjectID is one of subjectIDs and whose ActionTarget matches target
	// as 'completed' — the write side of Action.CompleteNotifications (see
	// that type's own doc comment for why matching happens on
	// ActionTarget rather than a specific notification id).
	CompleteByActionTarget(subjectIDs []string, target string) error
}

// ProgressStore is PairRule's state: whatever a→has-A-happened,
// b→has-B-happened bookkeeping a pair of events needs between when side A
// arrives and side B does (or vice versa) — backed by the rule_progress
// table (see db/schema.sql's own comment on why this can't just be an
// in-memory map). MarkDone additionally reports whether this call just
// completed the pair (both sides now done, and this is the very first
// time that became true) — the caller uses that to decide whether THIS
// call is the one that should fire the notification, which is what makes
// "fire exactly once even if A and B arrive nearly simultaneously" safe:
// the atomicity lives inside MarkDone's own implementation (a single
// UPDATE ... RETURNING, or an equivalent transaction), not in a
// check-then-act sequence in Engine that a race could slip between.
type ProgressStore interface {
	// MarkDone records that side (must be "a" or "b") happened for
	// (subjectID, ruleName), creating the row if it doesn't exist yet, and
	// returns whether this call is the one that completed the pair — true
	// at most once per (subjectID, ruleName), no matter how many times
	// MarkDone is called afterward (idempotent replays of an already-fired
	// pair must not fire it again).
	MarkDone(subjectID, ruleName, side string) (completedNow bool, err error)
}

// Rule is a stateless, single-event rule: EventType selects which events
// it's even considered for; Match (nil means "always true") narrows
// further using the event's own SubjectID/ActorID/Metadata — e.g. "only
// when this is the app's first tool," which needs to inspect state Match
// looks up itself (see cmd/server/main.go's own rule construction for a
// concrete Match that queries toolschema.Registry). Build runs only after
// Match passes, and turns the event into the notification's actual
// wording.
type Rule struct {
	Name      string
	EventType string
	Match     func(events.Event) bool
	Build     func(events.Event) Action
}

// PairRule is a stateful, two-event rule: fires once Build is called with
// this rule's own ProgressStore reporting both EventTypeA and EventTypeB
// have happened for the same SubjectID (see ProgressStore's own doc
// comment for how "once" is guaranteed under a race between the two
// sides). MatchA/MatchB (nil means "always true") each narrow their own
// side independently — see the package's own doc comment's worked example
// ("first tool" + "any feedback") for why the two sides often need
// different matching logic (one needs a lookup, the other doesn't).
// Build's subjectID argument is deliberately just the string, not either
// triggering event — by the time both sides are done, which particular
// event object completed the pair isn't meaningful information (it could
// have been either), so Build shouldn't be tempted to depend on it. Build
// is fully responsible for putting subjectID wherever the returned Action
// needs it (e.g. CreateNotification.SubjectID, or as the sole entry of a
// CompleteNotifications.SubjectIDs) — Engine does not stamp it in for you
// (unlike an earlier version of this type, before Action existed, which
// implicitly stamped Notification.SubjectID after Build returned).
type PairRule struct {
	Name       string
	EventTypeA string
	EventTypeB string
	MatchA     func(events.Event) bool
	MatchB     func(events.Event) bool
	Build      func(subjectID string) Action
}

// Engine subscribes itself to an events.Bus (via Register) and evaluates
// every configured Rule/PairRule against each event that arrives. The
// zero value is not usable — construct with NewEngine.
type Engine struct {
	rules     []Rule
	pairRules []PairRule
	notify    NotificationStore
	progress  ProgressStore
	log       *slog.Logger
}

// NewEngine returns an Engine ready to Register on a bus. rules/pairRules
// are copied into the Engine's own slices (the caller's slices are never
// retained), so mutating the slice literal passed in after construction
// has no effect — rules are meant to be fixed for the process's lifetime
// (see this package's own doc comment on why they're not
// database-editable).
func NewEngine(rules []Rule, pairRules []PairRule, notify NotificationStore, progress ProgressStore, log *slog.Logger) *Engine {
	e := &Engine{notify: notify, progress: progress, log: log}
	e.rules = append(e.rules, rules...)
	e.pairRules = append(e.pairRules, pairRules...)
	return e
}

// Register subscribes e.Handle to every distinct event type any configured
// rule cares about. Called once at startup (see cmd/server/main.go) — like
// events.Bus.Subscribe itself, there's no matching Unregister, since
// nothing in this codebase tears down a subscription mid-process.
func (e *Engine) Register(bus *events.Bus) {
	seen := make(map[string]bool)
	subscribe := func(eventType string) {
		if eventType == "" || seen[eventType] {
			return
		}
		seen[eventType] = true
		bus.Subscribe(eventType, e.Handle)
	}
	for _, r := range e.rules {
		subscribe(r.EventType)
	}
	for _, r := range e.pairRules {
		subscribe(r.EventTypeA)
		subscribe(r.EventTypeB)
	}
}

// Handle evaluates every configured rule against ev — this is what
// events.Bus.Publish actually calls (once per subscription Register set
// up), so it runs synchronously on whatever goroutine Publish itself ran
// on (see events.Bus.Publish's own doc comment: today's publishers already
// call Publish from their own goroutine specifically so a slow subscriber
// — this one now does a DB write — never adds latency to the request path
// that triggered the event).
//
// A single-Rule match/build/insert failure, or a single PairRule's store
// failure, is logged and does not stop the rest of Handle's own work — one
// broken rule (or one INSERT that hit a transient DB error) must not
// prevent every OTHER configured rule from still being evaluated against
// this same event.
func (e *Engine) Handle(ev events.Event) {
	for _, r := range e.rules {
		if r.EventType != ev.Type {
			continue
		}
		if r.Match != nil && !r.Match(ev) {
			continue
		}
		action := r.Build(ev)
		if err := action.apply(e.notify, r.Name); err != nil {
			e.log.Error("notify: failed to apply rule action", "rule", r.Name, "err", err)
		}
	}

	for _, r := range e.pairRules {
		e.handlePairRule(r, ev)
	}
}

func (e *Engine) handlePairRule(r PairRule, ev events.Event) {
	var side string
	switch ev.Type {
	case r.EventTypeA:
		if r.MatchA != nil && !r.MatchA(ev) {
			return
		}
		side = "a"
	case r.EventTypeB:
		if r.MatchB != nil && !r.MatchB(ev) {
			return
		}
		side = "b"
	default:
		return
	}

	completedNow, err := e.progress.MarkDone(ev.SubjectID, r.Name, side)
	if err != nil {
		e.log.Error("notify: failed to record pair rule progress", "rule", r.Name, "subjectId", ev.SubjectID, "err", err)
		return
	}
	if !completedNow {
		return
	}

	action := r.Build(ev.SubjectID)
	if err := action.apply(e.notify, r.Name); err != nil {
		e.log.Error("notify: failed to apply rule action", "rule", r.Name, "err", err)
	}
}
