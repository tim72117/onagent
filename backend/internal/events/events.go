// Package events is a small, in-process publish/subscribe bus — the first
// layer of the event → rule → notification pipeline (see this repo's own
// design notes on that pipeline). It deliberately knows nothing about
// notifications, rules, or persistence: a publisher (e.g.
// toolschema.Registry.SaveTool) calls Publish with a fact that already
// happened; a subscriber (eventually a notification rule engine) calls
// Subscribe to react to it. Neither side knows the other exists — that
// decoupling is the entire point (see this package's own design
// discussion: business code shouldn't scatter "if X then notify" calls
// throughout itself).
//
// In-process only, not backed by an external queue (Kafka/SQS/etc.) — this
// backend is a single process talking to a single Postgres, so there's no
// cross-process delivery problem to solve yet. If that changes (multiple
// backend instances needing to see the same event), this package's
// Publish/Subscribe signatures are the seam to swap the in-memory fan-out
// for a real message broker without every publisher/subscriber call site
// changing.
package events

import (
	"log/slog"
	"sync"
)

// Event is a fact that already happened, not a command to do something —
// past tense (Type is "tool.created", not "create_tool"). SubjectID is
// whatever the event is about (an app id, in every publisher so far);
// ActorID is who caused it (0 if unknown/not applicable — e.g. a
// system-initiated event with no human actor). Metadata carries whatever
// event-specific detail a subscriber might want, deliberately typed as
// map[string]any rather than one struct per event Type: a rule engine
// subscribing to many event types doesn't need a Go type switch just to
// read a field, and adding a new event Type never requires a matching new
// Go struct.
type Event struct {
	Type      string
	SubjectID string
	ActorID   int64
	Metadata  map[string]any
}

// Handler reacts to one Event. Errors are not returned to Publish's caller
// (see Publish's own doc comment for why) — a Handler that can fail should
// log the failure itself.
type Handler func(Event)

// Bus is a thread-safe, in-process event bus. The zero value is not usable
// — construct with NewBus so Bus always has a non-nil subscribers map and
// logger.
type Bus struct {
	mu          sync.RWMutex
	subscribers map[string][]Handler
	log         *slog.Logger
}

// NewBus returns a ready-to-use Bus. log is used only to report a
// subscriber panic (see Publish) — pass slog.Default() if the caller has
// no logger of its own handy.
func NewBus(log *slog.Logger) *Bus {
	return &Bus{
		subscribers: make(map[string][]Handler),
		log:         log,
	}
}

// Subscribe registers fn to run on every future Publish call whose Type
// matches eventType exactly (no wildcard/prefix matching — a rule engine
// wanting "every event" would need its own explicit list of types to
// subscribe to, keeping what's actually being listened for visible at the
// call site rather than implicit in a pattern). Safe to call concurrently
// with Publish. There is no Unsubscribe: every current caller subscribes
// once at process startup and lives for the process's whole lifetime,
// matching this repo's own inference.RegisterAppRole/RegisterAsker
// registries, which have the same one-way-registration shape for the same
// reason — nothing in this codebase tears down a subscription mid-process.
func (b *Bus) Subscribe(eventType string, fn Handler) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subscribers[eventType] = append(b.subscribers[eventType], fn)
}

// Publish fans e out to every Handler subscribed to e.Type, synchronously,
// on the calling goroutine — this is a deliberate choice, not an
// oversight: today's only subscribers (once the notification rule engine
// exists) are expected to do cheap, in-memory work (matching a rule,
// queuing a DB write), not block on slow I/O. A publisher that can't
// tolerate added latency from a slow subscriber should run Publish in its
// own goroutine at the call site instead of this package hiding that
// decision — see toolschema.Registry.SaveTool's own call for the current
// convention (fire-and-forget via `go events.Publish(...)`).
//
// A panicking Handler is recovered and logged, not propagated — one buggy
// subscriber must not crash the publisher's own request path (e.g. a tool
// save succeeding or failing should never depend on whether some unrelated
// notification rule panics). Handlers run in registration order; if two
// handlers for the same Type both mutate shared state, that ordering
// dependency is the handlers' own problem to avoid, not this bus's to
// enforce.
func (b *Bus) Publish(e Event) {
	b.mu.RLock()
	handlers := b.subscribers[e.Type]
	b.mu.RUnlock()

	for _, fn := range handlers {
		b.runHandler(fn, e)
	}
}

func (b *Bus) runHandler(fn Handler, e Event) {
	defer func() {
		if r := recover(); r != nil {
			b.log.Error("panic recovered in event handler", "eventType", e.Type, "subjectId", e.SubjectID, "err", r)
		}
	}()
	fn(e)
}
