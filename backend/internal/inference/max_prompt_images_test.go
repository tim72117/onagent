package inference

import (
	"os"
	"testing"
)

func setMaxPromptImagesEnv(t *testing.T, value string) {
	t.Helper()
	prev, had := os.LookupEnv("MAX_PROMPT_IMAGES")
	if value == "" {
		os.Unsetenv("MAX_PROMPT_IMAGES")
	} else {
		os.Setenv("MAX_PROMPT_IMAGES", value)
	}
	t.Cleanup(func() {
		if had {
			os.Setenv("MAX_PROMPT_IMAGES", prev)
		} else {
			os.Unsetenv("MAX_PROMPT_IMAGES")
		}
	})
}

func TestEffectiveMaxPromptImages(t *testing.T) {
	cases := []struct {
		name     string
		envValue string // "" means unset
		appLimit *int
		want     int
	}{
		{
			name:     "no app setting means images are off, whatever the system cap",
			envValue: "10",
			appLimit: nil,
			want:     0,
		},
		{
			name:     "app limit under the default system cap is honored",
			envValue: "",
			appLimit: intPtr(2),
			want:     2,
		},
		{
			name:     "app limit over the default system cap is clamped down",
			envValue: "",
			appLimit: intPtr(50),
			want:     defaultMaxPromptImages,
		},
		{
			name:     "invalid env value falls back to the default system cap",
			envValue: "lots",
			appLimit: intPtr(50),
			want:     defaultMaxPromptImages,
		},
		{
			name:     "non-positive env value falls back to the default system cap",
			envValue: "0",
			appLimit: intPtr(50),
			want:     defaultMaxPromptImages,
		},
		{
			name:     "a raised system cap lets a larger app limit through",
			envValue: "8",
			appLimit: intPtr(6),
			want:     6,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setMaxPromptImagesEnv(t, tc.envValue)
			got := EffectiveMaxPromptImages(tc.appLimit)
			if got != tc.want {
				t.Errorf("EffectiveMaxPromptImages(%v) = %d, want %d", tc.appLimit, got, tc.want)
			}
		})
	}
}
