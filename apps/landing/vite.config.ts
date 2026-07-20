import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Static pages, same design: English at "/", zh-Hant (Taiwan) at "/zh-tw/",
// and the integration docs at "/docs/" (linked from the landing hero). Vite
// only builds index.html by default; this input map is what makes every page
// beyond the root a real build entry instead of being silently dropped
// from `vite build`'s output — an omitted entry here 404s at runtime even
// though its source file exists and is linked to.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        zhTw: resolve(__dirname, 'zh-tw/index.html'),
        docs: resolve(__dirname, 'docs/index.html'),
      },
    },
  },
})
