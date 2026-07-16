import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Admin back-office SPA, served under /admin (base below). Builds to the
// default dist/ (gitignored); the Dockerfile copies dist/. into
// backend/cmd/server/web/admin/ (the //go:embed target) at image-build
// time, exactly as it does for apps/console and apps/landing. Locally,
// `go run ./cmd/server` serves only the checked-in placeholder under
// web/admin/ — for real admin UI development run this app's own Vite dev
// server (`npm run dev`, :5174, a port distinct from the console's 5173 so
// both can run at once).
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
})
