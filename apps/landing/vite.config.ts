import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Static pages, same design: English at "/", zh-Hant (Taiwan) at "/zh-tw/",
// the integration docs at "/docs/", pricing at "/pricing/" (linked from
// the landing hero), and the live-demo showcase at "/showcase/". Every page
// but showcase is plain HTML — Vite just serves/builds them, no framework.
// showcase/index.html mounts a small React app (showcase/src/) with its
// own client-side router (react-router-dom's BrowserRouter, basename
// "/showcase") for /showcase/<case>/ sub-routes — see App.tsx. That
// router's sub-paths have no matching file on disk, so backend/cmd/server/
// web.go's mountLanding gives "/showcase/*" the same SPA-fallback
// treatment mountConsole already gives "/app/*".
//
// react() only touches files it's asked to transform (.tsx/.jsx) — it does
// not turn the other, plain-HTML pages into a SPA or change how Vite
// builds them.
//
// Vite only builds index.html by default; this input map is what makes
// every page beyond the root a real build entry instead of being silently
// dropped from `vite build`'s output — an omitted entry here 404s at
// runtime even though its source file exists and is linked to.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        zhTw: resolve(__dirname, 'zh-tw/index.html'),
        docs: resolve(__dirname, 'docs/index.html'),
        pricing: resolve(__dirname, 'pricing/index.html'),
        zhTwPricing: resolve(__dirname, 'zh-tw/pricing/index.html'),
        privacy: resolve(__dirname, 'privacy/index.html'),
        terms: resolve(__dirname, 'terms/index.html'),
        showcase: resolve(__dirname, 'showcase/index.html'),
      },
    },
  },
})
