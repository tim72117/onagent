import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: {
    // Go's //go:embed can't reach outside its own package directory (no
    // "..", enforced by the compiler — see `go doc embed`), so
    // backend/cmd/server/web.go's `//go:embed all:web/console` can only
    // ever embed files that are already inside backend/cmd/server/web/
    // console/. Building straight there means `npm run build` alone is
    // enough to produce a real embed — no separate manual copy step needed
    // before `go build ./cmd/server` (still required for a real Docker/
    // production build; this only removes the copy, not the ordering).
    outDir: '../../backend/cmd/server/web/console',
    emptyOutDir: true,
  },
})
