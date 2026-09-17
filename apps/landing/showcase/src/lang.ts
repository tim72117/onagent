import { useCallback, useEffect, useState } from 'react'

// Showcase-wide UI language. Mirrors the mechanism SupportDemo.tsx
// already uses for its own panel copy (and src/marketing-demo/widget.js's
// `lang` param): an explicit choice only — read from ?lang= at load, or
// picked with the Topbar toggle. Never auto-detected from the browser
// locale, since these URLs arrive from ad sitelinks and shared links
// where the sender's intent is what matters, not the recipient's OS.
export type Lang = 'en' | 'zh'

// Read once at module scope, not in an effect: an effect would render
// English for one frame and then swap, which is visible as a flash on
// every /showcase/?lang=zh load.
export function initialLang(): Lang {
  if (typeof window === 'undefined') return 'en'
  return new URLSearchParams(window.location.search).get('lang') === 'zh' ? 'zh' : 'en'
}

// Anything other than "zh" falls back to English rather than throwing —
// these values come from outside the app.
function langFromSearch(search: string): Lang {
  return new URLSearchParams(search).get('lang') === 'zh' ? 'zh' : 'en'
}

// The chosen language lives in the URL, not just React state, so a
// visitor who switches to Chinese and then copies the address bar shares
// the Chinese version — and so the back button moves between languages
// the way it moves between pages. replaceState (not pushState) on toggle:
// flipping a label is not a navigation step worth its own history entry.
//
// popstate keeps state in sync when the visitor navigates with the back/
// forward buttons across entries that differ in ?lang=.
export function useLang(): [Lang, (next: Lang) => void] {
  const [lang, setLangState] = useState<Lang>(initialLang)

  useEffect(() => {
    const onPop = () => setLangState(langFromSearch(window.location.search))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    const url = new URL(window.location.href)
    // "en" is the default, so it stays absent from the URL rather than
    // adding ?lang=en to every link a visitor might share.
    if (next === 'zh') url.searchParams.set('lang', 'zh')
    else url.searchParams.delete('lang')
    window.history.replaceState(window.history.state, '', url)
  }, [])

  return [lang, setLang]
}

// Route-independent chrome copy (Topbar, ShowcaseList, Footer). Each case
// card keeps its own strings next to the component that renders them —
// see cases/*/\*Case.tsx — so adding a third case doesn't mean editing a
// central table that lives four directories away.
export const CHROME_STRINGS: Record<Lang, {
  home: string
  pricing: string
  docs: string
  docsHref: string
  privacy: string
  terms: string
  listEyebrow: string
  listHeadA: string
  listHeadB: string
  listSub: string
  loadingDemo: string
}> = {
  en: {
    home: 'Home',
    pricing: 'Pricing',
    docs: 'Docs',
    docsHref: '/docs/',
    privacy: 'Privacy',
    terms: 'Terms',
    listEyebrow: 'Live demo',
    listHeadA: 'See onagent',
    listHeadB: 'answer real questions about real data.',
    listSub:
      'A live AgentBridge connection, not a recording — describe what you want to know and watch it pick the right analysis method.',
    loadingDemo: 'Loading demo…',
  },
  zh: {
    home: '首頁',
    pricing: '費用方案',
    docs: '文件',
    // The zh-tw pages are separate static files, not ?lang= variants of
    // the English ones, so these two links need their own hrefs rather
    // than only their own labels.
    docsHref: '/zh-tw/docs/',
    privacy: '隱私權政策',
    terms: '服務條款',
    listEyebrow: '線上展示',
    listHeadA: '看 onagent',
    listHeadB: '用真實資料回答真實問題。',
    listSub:
      '這是一條真的 AgentBridge 連線，不是錄影——描述你想知道什麼，看它自己挑出合適的分析方式。',
    loadingDemo: '載入 demo 中…',
  },
}
