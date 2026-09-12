package inference

import (
	"os"
	"testing"
)

// setMaxPromptLengthEnv sets MAX_PROMPT_LENGTH for the duration of the test
// and restores whatever was there before on cleanup — SystemMaxPromptLength
// reads the env var fresh on every call, so tests can't just set it once at
// package init and expect isolation between cases.
func setMaxPromptLengthEnv(t *testing.T, value string) {
	t.Helper()
	prev, had := os.LookupEnv("MAX_PROMPT_LENGTH")
	if value == "" {
		os.Unsetenv("MAX_PROMPT_LENGTH")
	} else {
		os.Setenv("MAX_PROMPT_LENGTH", value)
	}
	t.Cleanup(func() {
		if had {
			os.Setenv("MAX_PROMPT_LENGTH", prev)
		} else {
			os.Unsetenv("MAX_PROMPT_LENGTH")
		}
	})
}

func intPtr(n int) *int { return &n }

func TestEffectiveMaxPromptLength(t *testing.T) {
	cases := []struct {
		name     string
		envValue string // "" means unset
		appLimit *int
		want     int
	}{
		{
			name:     "unset env, no app limit falls back to platform default",
			envValue: "",
			appLimit: nil,
			want:     defaultMaxPromptLength,
		},
		{
			name:     "invalid env value falls back to platform default",
			envValue: "not-a-number",
			appLimit: nil,
			want:     defaultMaxPromptLength,
		},
		{
			name:     "non-positive env value falls back to platform default",
			envValue: "0",
			appLimit: nil,
			want:     defaultMaxPromptLength,
		},
		{
			name:     "system-wide value used verbatim with no app limit",
			envValue: "500",
			appLimit: nil,
			want:     500,
		},
		{
			name:     "app limit tighter than system-wide is honored",
			envValue: "500",
			appLimit: intPtr(200),
			want:     200,
		},
		{
			name:     "app limit looser than system-wide is clamped down",
			envValue: "500",
			appLimit: intPtr(9000),
			want:     500,
		},
		{
			name:     "app limit equal to system-wide is unaffected",
			envValue: "500",
			appLimit: intPtr(500),
			want:     500,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setMaxPromptLengthEnv(t, tc.envValue)
			got := EffectiveMaxPromptLength(tc.appLimit)
			if got != tc.want {
				t.Errorf("EffectiveMaxPromptLength(%v) = %d, want %d", tc.appLimit, got, tc.want)
			}
		})
	}
}
