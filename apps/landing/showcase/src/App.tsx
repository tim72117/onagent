import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Topbar } from './Topbar'
import { Footer } from './Footer'
import { ShowcaseList } from './ShowcaseList'
import { useLang } from './lang'
import { MarketingDemo } from './cases/marketing/MarketingDemo'
import { SupportDemo } from './cases/support/SupportDemo'
import shared from './Shared.module.css'

// basename "/showcase" — every route below is written relative to that
// (e.g. "/" here means "/showcase/", "marketing" means "/showcase/
// marketing/"), matching how this app is actually served: backend/cmd/
// server/web.go's mountLanding gives "/showcase/*" SPA-fallback treatment
// (any sub-path that isn't a real static file gets showcase/index.html),
// the same pattern mountConsole already uses for "/app/*".
//
// Topbar/Footer render around every route (previously static markup in
// index.html, moved into React so they can use CSS Modules — see
// Topbar.tsx's own comment). Each case has its own demo route rather than
// query-string state, so a shared link/refresh lands directly on that
// case's demo instead of the list — adding another case is one more
// <Route> here (plus a cases/<name>/ directory), not a change to this
// shape.
//
// The UI language is owned here and passed down, not read independently
// by each component: useLang holds state, so calling it in Topbar and in
// each card would give every one of them a private copy and the toggle
// would change only the Topbar's own labels. One owner, props downward.
export function App() {
  const [lang, setLang] = useLang()
  return (
    <BrowserRouter basename="/showcase">
      <Topbar lang={lang} onLangChange={setLang} />
      <main className={shared.main}>
        <div className={shared.wrap}>
          <Routes>
            <Route path="/" element={<ShowcaseList lang={lang} />} />
            <Route path="/marketing" element={<MarketingDemo lang={lang} />} />
            <Route path="/support" element={<SupportDemo lang={lang} />} />
          </Routes>
        </div>
      </main>
      <Footer lang={lang} />
    </BrowserRouter>
  )
}
