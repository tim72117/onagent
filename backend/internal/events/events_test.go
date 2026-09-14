package events

import (
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestPublish_DeliversToMatchingSubscriber(t *testing.T) {
	b := NewBus(testLogger())
	var got Event
	var called bool
	b.Subscribe("tool.created", func(e Event) {
		got = e
		called = true
	})

	want := Event{Type: "tool.created", SubjectID: "my-app", ActorID: 42, Metadata: map[string]any{"toolName": "search"}}
	b.Publish(want)

	if !called {
		t.Fatal("subscriber was not called")
	}
	if got.Type != want.Type || got.SubjectID != want.SubjectID || got.ActorID != want.ActorID {
		t.Errorf("handler received %+v, want %+v", got, want)
	}
	if got.Metadata["toolName"] != "search" {
		t.Errorf("handler received Metadata %+v, want toolName=search", got.Metadata)
	}
}

func TestPublish_DoesNotDeliverToOtherEventTypes(t *testing.T) {
	b := NewBus(testLogger())
	called := false
	b.Subscribe("tool.deleted", func(e Event) { called = true })

	b.Publish(Event{Type: "tool.created", SubjectID: "my-app"})

	if called {
		t.Error("subscriber for a different event type was called")
	}
}

func TestPublish_NoSubscribersIsANoOp(t *testing.T) {
	b := NewBus(testLogger())
	// Must not panic or block when nobody is subscribed to this type.
	b.Publish(Event{Type: "nobody.listening"})
}

func TestPublish_DeliversToEveryMatchingSubscriberInRegistrationOrder(t *testing.T) {
	b := NewBus(testLogger())
	var order []int
	b.Subscribe("tool.created", func(e Event) { order = append(order, 1) })
	b.Subscribe("tool.created", func(e Event) { order = append(order, 2) })
	b.Subscribe("tool.created", func(e Event) { order = append(order, 3) })

	b.Publish(Event{Type: "tool.created"})

	want := []int{1, 2, 3}
	if len(order) != len(want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}
}

// TestPublish_RecoversFromPanickingHandler is the core resilience
// guarantee this bus exists to provide: a buggy subscriber must not crash
// the publisher's own call stack, and must not stop other subscribers
// (registered before or after the panicking one) from still running.
func TestPublish_RecoversFromPanickingHandler(t *testing.T) {
	b := NewBus(testLogger())
	before, after := false, false
	b.Subscribe("tool.created", func(e Event) { before = true })
	b.Subscribe("tool.created", func(e Event) { panic("boom") })
	b.Subscribe("tool.created", func(e Event) { after = true })

	// Must not panic out of Publish itself.
	b.Publish(Event{Type: "tool.created"})

	if !before {
		t.Error("handler registered before the panicking one did not run")
	}
	if !after {
		t.Error("handler registered after the panicking one did not run")
	}
}

// TestBus_ConcurrentPublishAndSubscribe exercises the mutex: Subscribe and
// Publish racing from many goroutines must not trip Go's race detector
// (run this file with `go test -race`) and must not deadlock.
func TestBus_ConcurrentPublishAndSubscribe(t *testing.T) {
	b := NewBus(testLogger())
	var wg sync.WaitGroup
	done := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			b.Subscribe("tool.created", func(e Event) {})
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			b.Publish(Event{Type: "tool.created"})
		}
	}()

	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("concurrent Subscribe/Publish did not complete — possible deadlock")
	}
}
