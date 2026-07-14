import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Two static pages, same design, different language — zh-Hant at "/",
// English at "/en/". Vite only builds index.html by default; this input
// map is what makes en/index.html a second build entry instead of being
// silently dropped from `vite build`'s output.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        en: resolve(__dirname, 'en/index.html'),
      },
    },
  },
})
