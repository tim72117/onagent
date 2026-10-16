package main

// Pure argument-parsing tests for dispatchResource — no HTTP involved.
// These prove dispatchResource resolves a verb (and, for requireSet
// commands, the mandatory "set"/"get" sub-verb immediately after it) to the
// right run/getRun function with the right remaining args, independent of
// what that function actually does once called. apiclient_test.go is the
// layer above this: it proves the real runAppOrigin/runAppThought/etc.
// functions, once dispatched to, build the HTTP request the backend
// expects.

import (
	"strings"
	"testing"
)

// recordingRun returns a run function that saves the args it was called
// with (nil until called), for a test to assert against without a real
// apiClient/HTTP round trip.
func recordingRun(called *[]string) func([]string) error {
	return func(args []string) error {
		*called = args
		return nil
	}
}

func TestDispatchResource_PlainVerb_NoRequireSet(t *testing.T) {
	var got []string
	r := &resource{name: "app", commands: []resourceCommand{
		{verb: "get", run: recordingRun(&got), usage: "onagent app get <appId>"},
	}}

	if err := dispatchResource(r, []string{"get", "myapp"}); err != nil {
		t.Fatalf("dispatchResource: %v", err)
	}
	if want := []string{"myapp"}; !equalStrings(got, want) {
		t.Errorf("run called with %v, want %v", got, want)
	}
}

func TestDispatchResource_RequireSet_Set_Succeeds(t *testing.T) {
	var got []string
	r := &resource{name: "app", commands: []resourceCommand{
		{verb: "thought", requireSet: true, run: recordingRun(&got),
			usage: "onagent app thought set <appId> <thought>"},
	}}

	if err := dispatchResource(r, []string{"thought", "set", "myapp", "be nice"}); err != nil {
		t.Fatalf("dispatchResource: %v", err)
	}
	if want := []string{"myapp", "be nice"}; !equalStrings(got, want) {
		t.Errorf("run called with %v, want %v", got, want)
	}
}

func TestDispatchResource_RequireSet_MissingSet_Errors(t *testing.T) {
	r := &resource{name: "app", commands: []resourceCommand{
		{verb: "thought", requireSet: true, run: recordingRun(&[]string{}),
			usage: "onagent app thought set <appId> <thought>"},
	}}

	err := dispatchResource(r, []string{"thought", "myapp", "be nice"})
	if err == nil {
		t.Fatal("expected an error when \"set\" is omitted, got nil")
	}
	if !strings.Contains(err.Error(), "onagent app thought set") {
		t.Errorf("error %q doesn't mention the usage string", err.Error())
	}
}

func TestDispatchResource_RequireSet_NoGetRun_GetIsTreatedAsMissingSet(t *testing.T) {
	// origin/maxpromptlength-shaped command: requireSet but no getRun —
	// "get" here isn't a recognized sub-verb, so it falls into the same
	// "usage" error as any other non-"set" first token, not a panic or a
	// silent no-op. This is the regression this test guards against: a
	// future edit to dispatchResource's branching must not let a getRun-less
	// command's args accidentally be dispatched to run() with "get" as part
	// of appID.
	var got []string
	r := &resource{name: "app", commands: []resourceCommand{
		{verb: "origin", requireSet: true, run: recordingRun(&got),
			usage: "onagent app origin set <appId> <origin>"},
	}}

	err := dispatchResource(r, []string{"origin", "get", "myapp"})
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if got != nil {
		t.Errorf("run should not have been called, got args %v", got)
	}
}

func TestDispatchResource_RequireSet_Get_Succeeds(t *testing.T) {
	var got []string
	r := &resource{name: "app", commands: []resourceCommand{
		{verb: "thought", requireSet: true, run: recordingRun(&[]string{}),
			usage: "onagent app thought set <appId> <thought>",
			getRun: recordingRun(&got), getUsage: "onagent app thought get <appId>"},
	}}

	if err := dispatchResource(r, []string{"thought", "get", "myapp"}); err != nil {
		t.Fatalf("dispatchResource: %v", err)
	}
	if want := []string{"myapp"}; !equalStrings(got, want) {
		t.Errorf("getRun called with %v, want %v", got, want)
	}
}

func TestDispatchResource_RequireSet_WithGetRun_MissingSubVerb_ErrorsMentionsBoth(t *testing.T) {
	r := &resource{name: "app", commands: []resourceCommand{
		{verb: "thought", requireSet: true, run: recordingRun(&[]string{}),
			usage: "onagent app thought set <appId> <thought>",
			getRun: recordingRun(&[]string{}), getUsage: "onagent app thought get <appId>"},
	}}

	err := dispatchResource(r, []string{"thought", "myapp"})
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "thought set") || !strings.Contains(err.Error(), "thought get") {
		t.Errorf("error %q doesn't mention both set and get usage", err.Error())
	}
}

func TestDispatchResource_UnknownVerb_Errors(t *testing.T) {
	r := &resource{name: "app", commands: []resourceCommand{
		{verb: "get", run: recordingRun(&[]string{}), usage: "onagent app get <appId>"},
	}}

	err := dispatchResource(r, []string{"bogus"})
	if err == nil || !strings.Contains(err.Error(), `"bogus"`) {
		t.Errorf("expected an error naming the unknown verb, got %v", err)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
