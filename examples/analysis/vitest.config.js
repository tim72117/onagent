import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Separate from vite.config.js/vite.dev.config.js on purpose: those carry
// build-output and dev-server settings that have no meaning for a test run
// and would only add noise/risk of tests accidentally depending on them.
export default defineConfig({
    plugins: [vue()],
    test: {
        environment: 'jsdom',
        setupFiles: ['./test/setup.js'],
        // Vitest's Node-style module loader externalizes vuetify by
        // default (skipping Vite's own transform pipeline), which is what
        // trips on `import 'vuetify/styles'` resolving to a raw .css file
        // ("Unknown file extension \".css\""). Forcing it inline routes it
        // through Vite's transform instead, where CSS imports are handled.
        server: {
            deps: {
                inline: ['vuetify'],
            },
        },
    },
})
