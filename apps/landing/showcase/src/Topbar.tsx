import { useLocation } from 'react-router-dom'
import { CHROME_STRINGS, type Lang } from './lang'
import styles from './Topbar.module.css'

// Maps App.tsx's route paths (relative to the BrowserRouter's "/showcase"
// basename — see useLocation below) to the short label the breadcrumb
// shows for that case. "" is the list page itself ("/showcase/"), which
// gets no second segment at all. Adding a case here is the same one-line
// addition ShowcaseList.tsx/App.tsx already ask for when a new
// cases/<name>/ directory + <Route> is added.
//
// Deliberately NOT translated: these mirror the URL segment they stand
// for ("/showcase/marketing"), so a breadcrumb reading "行銷" beside an
// address bar reading "marketing" would be describing a path that does
// not exist.
const CASE_LABELS: Record<string, string> = {
  marketing: 'marketing',
  support: 'support',
}

// The showcase app's page chrome — previously static markup in
// index.html; moved into React (see main.tsx) specifically so it can use
// CSS Modules' hashed class names like every other component here. Static
// HTML outside #root has no way to reference a module's generated names,
// which is exactly the gap the old ".tag" class-name collision (index.html
// used a bare ".tag" span for decoration text; base.css's own ".tag" rule,
// for feature-tag bubbles, absolutely-positioned it) fell into — Modules
// make that whole category of bug impossible, not just less likely.
export function Topbar({ lang, onLangChange }: { lang: Lang; onLangChange: (next: Lang) => void }) {
  // useLocation's pathname is ALREADY relative to the BrowserRouter's
  // "/showcase" basename (App.tsx) — on the real URL "/showcase/support"
  // this is "/support", not "/showcase/support". Stripping a leading
  // "/showcase" here (as an earlier version of this did) never matched
  // anything, so caseLabel was always undefined and the breadcrumb never
  // grew a second segment on any case page.
  const location = useLocation()
  const caseSegment = location.pathname.replace(/^\/|\/$/g, '')
  const caseLabel = CASE_LABELS[caseSegment]
  const t = CHROME_STRINGS[lang]

  return (
    <>
      <div className={styles.bgFx} />
      <header className={styles.topbar}>
        {/* A real breadcrumb, not one <a> wrapping the whole string — each
            segment must link to ITS OWN level (site root / showcase list /
            nothing for the current page), not all three collapsed onto one
            href. Absolute paths, not "../index.html": this component
            renders at every depth App.tsx's router serves (/showcase/,
            /showcase/marketing, /showcase/support all share this one
            Topbar), and a relative "../" only walks up one real URL segment
            regardless of which case page it's rendered on. */}
        <div className={styles.brand}>
          <a className={styles.brandLink} href={lang === 'zh' ? '/zh-tw/' : '/'}>
            {/* The sphere logo, inline rather than an <img>: it has to inherit
                nothing and load nothing, and this Topbar renders on a light
                ground where a gold tile behind it would fight the mark.

                Rim light is a stroke inset to r=30, not a fill at r=31 — see
                apps/console/src/Sidebar.tsx for why (sub-pixel gradient band
                sharing an edge with two other r=31 circles rasterised into a
                jagged ring). */}
            <span className={styles.mark}>
              <svg viewBox="0 0 64 64" aria-hidden="true">
                <defs>
                  <radialGradient id="scMarkS" cx="36%" cy="28%" r="76%">
                    <stop offset="0" stopColor="#4a4030" />
                    <stop offset="0.22" stopColor="#2e2819" />
                    <stop offset="0.48" stopColor="#181410" />
                    <stop offset="0.74" stopColor="#0a0907" />
                    <stop offset="1" stopColor="#030302" />
                  </radialGradient>
                  <radialGradient id="scMarkB" cx="50%" cy="50%" r="50%">
                    <stop offset="0.62" stopColor="#c9a24b" stopOpacity="0" />
                    <stop offset="0.88" stopColor="#8a6f34" stopOpacity="0.30" />
                    <stop offset="1" stopColor="#6b5528" stopOpacity="0.16" />
                  </radialGradient>
                  <linearGradient id="scMarkR" x1="0" y1="0" x2="0.35" y2="1">
                    <stop offset="0" stopColor="#f6e6bd" stopOpacity="0.85" />
                    <stop offset="0.45" stopColor="#c9a24b" stopOpacity="0.55" />
                    <stop offset="1" stopColor="#8a6f34" stopOpacity="0.40" />
                  </linearGradient>
                  <radialGradient id="scMarkSp" cx="50%" cy="50%" r="50%">
                    <stop offset="0" stopColor="#ffffff" stopOpacity="0.50" />
                    <stop offset="0.45" stopColor="#fff4d6" stopOpacity="0.16" />
                    <stop offset="1" stopColor="#f0dfae" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id="scMarkSo" cx="50%" cy="46%" r="52%">
                    <stop offset="0.55" stopColor="#000000" stopOpacity="0.55" />
                    <stop offset="1" stopColor="#000000" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id="scMarkG" cx="50%" cy="50%" r="50%">
                    <stop offset="0" stopColor="#f6e6bd" stopOpacity="0.44" />
                    <stop offset="0.5" stopColor="#e0c98a" stopOpacity="0.15" />
                    <stop offset="1" stopColor="#c9a24b" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id="scMarkI" cx="42%" cy="36%" r="68%">
                    <stop offset="0" stopColor="#fffdf4" />
                    <stop offset="0.34" stopColor="#ffeec4" />
                    <stop offset="0.68" stopColor="#e8c982" />
                    <stop offset="1" stopColor="#a8813a" />
                  </radialGradient>
                </defs>
                <circle cx="32" cy="32" r="31" fill="url(#scMarkS)" />
                <circle cx="32" cy="32" r="31" fill="url(#scMarkB)" />
                <circle cx="32" cy="32" r="30" fill="none" stroke="url(#scMarkR)" strokeWidth="2" />
                <ellipse cx="22" cy="17" rx="13" ry="8.5" fill="url(#scMarkSp)" transform="rotate(-24 22 17)" />
                <circle cx="23" cy="28" r="11" fill="url(#scMarkSo)" />
                <circle cx="41" cy="28" r="11" fill="url(#scMarkSo)" />
                <circle cx="23" cy="28" r="10" fill="url(#scMarkG)" />
                <circle cx="41" cy="28" r="10" fill="url(#scMarkG)" />
                <circle cx="23" cy="28" r="5.6" fill="url(#scMarkI)" />
                <circle cx="41" cy="28" r="5.6" fill="url(#scMarkI)" />
                <circle cx="21.2" cy="26.2" r="1.7" fill="#ffffff" opacity="0.92" />
                <circle cx="39.2" cy="26.2" r="1.7" fill="#ffffff" opacity="0.92" />
              </svg>
            </span>
            onagent
          </a>
          <span className={styles.sep}>/</span>
          {caseLabel ? (
            <a className={styles.brandLink} href={lang === 'zh' ? '/showcase?lang=zh' : '/showcase'}>
              showcase
            </a>
          ) : (
            <span className={styles.suffix}>showcase</span>
          )}
          {/* Only appended on a case page, not the list itself — matches
              the URL depth: "/showcase/" is just "showcase", "/showcase/
              support" is "showcase / support". Current page, so plain text
              rather than a link to itself. */}
          {caseLabel && (
            <>
              <span className={styles.sep}>/</span>
              <span className={styles.suffix}>{caseLabel}</span>
            </>
          )}
        </div>
        <div className={styles.links}>
          {/* Home and Pricing have real zh-tw counterparts; Docs gets its
              own href from CHROME_STRINGS for the same reason. */}
          <a href={lang === 'zh' ? '/zh-tw/' : '/'}>{t.home}</a>
          <a href={lang === 'zh' ? '/zh-tw/pricing/' : '/pricing/'}>{t.pricing}</a>
          <a href={t.docsHref}>{t.docs}</a>
          {/* Stays visible at phone width (unlike the links beside it,
              which .links hides under 640px) — switching language is the
              one control a visitor on the wrong one cannot do without. */}
          <button
            type="button"
            className={styles.langToggle}
            onClick={() => onLangChange(lang === 'en' ? 'zh' : 'en')}
          >
            {lang === 'en' ? '中文' : 'EN'}
          </button>
        </div>
      </header>
    </>
  )
}
