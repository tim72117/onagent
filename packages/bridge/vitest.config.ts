import { defineConfig } from 'vitest/config'

// jsdom, not node: the connection-lifecycle behaviour under test is driven
// by document.visibilityState and the visibilitychange event, which only
// exist in a DOM environment. Matches apps/console's own vitest setup.
export default defineConfig({
  test: {
    environment: 'jsdom',
  },
})
