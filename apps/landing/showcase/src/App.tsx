import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ShowcaseList } from './ShowcaseList'
import { MarketingDemo } from './cases/marketing/MarketingDemo'
import { SupportDemo } from './cases/support/SupportDemo'

// basename "/showcase" — every route below is written relative to that
// (e.g. "/" here means "/showcase/", "marketing" means "/showcase/
// marketing/"), matching how this app is actually served: backend/cmd/
// server/web.go's mountLanding gives "/showcase/*" SPA-fallback treatment
// (any sub-path that isn't a real static file gets showcase/index.html),
// the same pattern mountConsole already uses for "/app/*".
//
// Each case has its own route rather than query-string state, so a shared
// link/refresh lands directly on that case's demo instead of the list —
// adding another case is one more <Route> here (plus a cases/<name>/
// directory), not a change to this shape.
export function App() {
  return (
    <BrowserRouter basename="/showcase">
      <Routes>
        <Route path="/" element={<ShowcaseList />} />
        <Route path="/marketing" element={<MarketingDemo />} />
        <Route path="/support" element={<SupportDemo />} />
      </Routes>
    </BrowserRouter>
  )
}
