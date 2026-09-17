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
            <span className={styles.mark}>⌘</span>
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
