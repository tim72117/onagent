// Full interface slice: 15 variables, 6 analysis methods, all runnable
// locally against mock data via quick-test buttons — no backend required.
// The chat-style prompt box wires up a real AgentBridge connection using
// VITE_ANALYSIS_WS_URL/VITE_ANALYSIS_APP_ID/VITE_ANALYSIS_API_KEY (see
// .env.example) once VITE_ANALYSIS_API_KEY is actually set; until then it
// shows a clear "not wired up yet" state, but the analysis logic and
// rendering are fully demonstrable today via the buttons.
//
// i18n: this same bundle is imported by both landing pages — index.html
// (English) and zh-tw/index.html (Traditional Chinese) — see each page's own
// `mod.mountMarketingDemo(inner, { lang: 'en' | 'zh' })` call. There is no
// browser-language auto-detection here on purpose: the caller (the page
// that knows which locale it is) tells the widget which language to render,
// the same way it already passes other init-time config. See strings.js for
// the actual zh/en copy and the t()/title() helpers below for how a given
// UI string is looked up for the active language.
import { AgentBridge, defineTool } from '@onagent/bridge'
import { marked } from 'marked'
import { VARIABLES, generateDataset } from './data.js'
import { frequency, crossTable, correlation, regression, trend, ranking } from './analysis.js'
import { barChart, groupedBarChart, lineChart, heatmap } from './charts.js'
import { STRINGS, VARIABLE_TITLES, QUICK_TESTS, resolveLang } from './strings.js'

// The assistant's own reply text is Markdown (per the thought prompt's
// instructions), rendered to HTML for display — marked has no sanitizer of
// its own, so escape first and let marked's rendering re-introduce only the
// HTML *it* generates from that already-escaped text. This is safe against
// the assistant echoing user-supplied HTML/script back verbatim; it does not
// need to defend against the LLM provider itself being compromised.
function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// Read from .env.local (see .env.example) rather than hardcoded, so local
// dev can point at a docker-compose stack (see tmp/docker-compose.yml) or
// any other backend without editing this file, and production can be
// configured the same way at build time. VITE_ANALYSIS_API_KEY is left
// undefined (not a placeholder string) when unset — see the
// "not wired up yet" check below, which relies on that.
const WS_URL = import.meta.env.VITE_ANALYSIS_WS_URL ?? 'wss://onagent.shuttle.tools/ws'
const APP_ID = import.meta.env.VITE_ANALYSIS_APP_ID ?? 'analysis-app'
const API_KEY = import.meta.env.VITE_ANALYSIS_API_KEY

// Frontend-only per-browser usage cap — independent of and in addition to
// the backend's own quota system (onQuotaExceeded below). This is what
// keeps a single visitor from running up real LLM inference cost against
// the shared demo key; it's a courtesy limit, not a security boundary (it
// lives in localStorage, so it's trivially reset by clearing site data —
// that's an accepted tradeoff for a public marketing demo, not a gap to
// close here).
const MAX_PROMPTS_PER_BROWSER = 10
const USAGE_STORAGE_KEY = 'onagent-marketing-demo-prompt-count'

// See select_analysis's handler for why this exists — purely cosmetic
// pacing, not real processing time.
const ANALYSIS_DELAY_MS = 1000

function getPromptCount() {
  try {
    return Number(localStorage.getItem(USAGE_STORAGE_KEY)) || 0
  } catch {
    // Storage blocked (private browsing, disabled cookies, etc.) — fail
    // open rather than breaking the demo for those visitors.
    return 0
  }
}

function incrementPromptCount() {
  try {
    localStorage.setItem(USAGE_STORAGE_KEY, String(getPromptCount() + 1))
  } catch {
    // Nothing to do if storage is blocked — see getPromptCount.
  }
}

// Persists the chat log (user/assistant messages and result cards, in
// order) across reloads/re-opens — same "lives in localStorage, cleared by
// clearing site data" tradeoff as the prompt-count cap above. Kept
// separate from that key since it's cleared independently (see
// getHistory's own JSON.parse failure handling) and grows unbounded
// otherwise: HISTORY_MAX_ENTRIES caps it so a long-running visitor's
// localStorage entry doesn't grow forever.
const HISTORY_STORAGE_KEY = 'onagent-marketing-demo-history'
const HISTORY_MAX_ENTRIES = 50

function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Storage blocked, or a corrupted/incompatible entry from an earlier
    // version of this schema — fail open to an empty history rather than
    // breaking the widget.
    return []
  }
}

function appendHistory(entry) {
  try {
    const next = [...getHistory(), entry].slice(-HISTORY_MAX_ENTRIES)
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Nothing to do if storage is blocked — see getPromptCount.
  }
}

function parseSelectAnalysisArgs(raw) {
  const r = raw ?? {}
  return {
    method: typeof r.method === 'string' ? r.method : undefined,
    variables: Array.isArray(r.variables) ? r.variables.filter((v) => typeof v === 'string') : undefined,
    topN: typeof r.topN === 'number' ? r.topN : undefined,
  }
}

function parseListVariablesArgs(raw) {
  const r = raw ?? {}
  return { limit: typeof r.limit === 'number' ? r.limit : undefined }
}

function runByMethod(rows, method, variables, topN) {
  const [a, b, c] = variables ?? []
  switch (method) {
    case 'frequency':
      return a ? frequency(rows, a) : null
    case 'crossTable':
      return a && b ? crossTable(rows, a, b) : null
    case 'correlation':
      return variables && variables.length >= 2 ? correlation(rows, variables) : null
    case 'regression':
      return a && b ? regression(rows, a, variables.slice(1)) : null
    case 'trend':
      return a ? trend(rows, a) : null
    case 'ranking':
      return a && b ? ranking(rows, a, b, topN ?? 5) : null
    default:
      return null
  }
}

function chartHost() {
  const div = document.createElement('div')
  div.className = 'md-demo-chart'
  return div
}

export function mountMarketingDemo(root, options = {}) {
  const lang = resolveLang(options.lang)
  const s = STRINGS[lang]
  const titles = VARIABLE_TITLES[lang]
  const title = (name) => titles[name] ?? name

  const dataset = generateDataset()

  // Short human label for a computed result — used on its chat-log result
  // card (see addResultCard below) so past turns stay identifiable in the
  // conversation history without re-deriving the full render.
  function resultLabel(result) {
    switch (result.method) {
      case 'frequency':
        return s.methodLabel.frequency(title(result.variable))
      case 'crossTable':
        return s.methodLabel.crossTable(title(result.rowVariable), title(result.colVariable))
      case 'correlation':
        return s.methodLabel.correlation(result.variables.map(title))
      case 'regression':
        return s.methodLabel.regression(title(result.dependentVariable))
      case 'trend':
        return s.methodLabel.trend(title(result.variable))
      case 'ranking':
        return s.methodLabel.ranking(title(result.groupVariable), title(result.metricVariable))
      default:
        return s.resultCardDefaultLabel
    }
  }

  // Shown in the result area from the moment a prompt is sent until
  // select_analysis actually calls renderResult (which overwrites resultEl's
  // content, naturally clearing this) — a skeleton pulse rather than the chat
  // sidebar's dots, since this is a different pane the visitor is watching.
  function showResultLoading(resultEl) {
    resultEl.innerHTML = `
      <div class="md-demo-result-loading">
        <div class="md-demo-skel md-demo-skel-title"></div>
        <div class="md-demo-skel md-demo-skel-row"></div>
        <div class="md-demo-skel md-demo-skel-row"></div>
        <div class="md-demo-skel md-demo-skel-row" style="width:70%"></div>
      </div>
    `
  }

  function renderResult(resultEl, result) {
    if (!result) return
    resultEl.innerHTML = ''

    // A method can compute successfully but still have nothing valid to
    // show — e.g. correlation.js's insufficient_numeric_data, when the
    // chosen variables filtered out every row. Rendered as an honest
    // message here instead of the method's normal table+chart, which would
    // otherwise show a misleading all-zero/all-blank result.
    if (result.error === 'insufficient_numeric_data') {
      resultEl.innerHTML = `<p class="md-demo-placeholder">${s.resultErrorInsufficientData}</p>`
      return
    }

    if (result.method === 'frequency') {
      const rows = result.counts.map((c) => `<tr><td>${c.value}</td><td>${c.count}</td></tr>`).join('')
      resultEl.innerHTML = `
        <p class="md-demo-result-title">${s.methodLabel.frequency(title(result.variable))}</p>
        <table class="md-demo-table"><tbody>${rows}</tbody></table>
      `
      const host = chartHost()
      host.appendChild(barChart(result.counts.map((c) => ({ label: c.value, value: c.count }))))
      resultEl.appendChild(host)
    } else if (result.method === 'crossTable') {
      const head = `<tr><th></th>${result.colValues.map((c) => `<th>${c}</th>`).join('')}</tr>`
      const body = result.table
        .map((r) => `<tr><td>${r.rowValue}</td>${r.cells.map((n) => `<td>${n}</td>`).join('')}</tr>`)
        .join('')
      resultEl.innerHTML = `
        <p class="md-demo-result-title">${s.methodLabel.crossTable(title(result.rowVariable), title(result.colVariable))}</p>
        <table class="md-demo-table md-demo-table-grid"><tbody>${head}${body}</tbody></table>
      `
      const host = chartHost()
      host.appendChild(groupedBarChart(result.rowValues, result.colValues, result.table))
      resultEl.appendChild(host)
    } else if (result.method === 'correlation') {
      const head = `<tr><th></th>${result.variables.map((v) => `<th>${title(v)}</th>`).join('')}</tr>`
      const body = result.variables
        .map((v, i) => `<tr><td>${title(v)}</td>${result.matrix[i].map((n) => `<td>${n}</td>`).join('')}</tr>`)
        .join('')
      resultEl.innerHTML = `
        <p class="md-demo-result-title">${s.methodLabel.correlationTitle}</p>
        <table class="md-demo-table md-demo-table-grid"><tbody>${head}${body}</tbody></table>
      `
      const host = chartHost()
      host.appendChild(heatmap(result.variables.map(title), result.matrix))
      resultEl.appendChild(host)
    } else if (result.method === 'regression') {
      const rows = result.coefficients.map((c) => `<tr><td>${title(c.variable)}</td><td>${c.coefficient}</td></tr>`).join('')
      resultEl.innerHTML = `
        <p class="md-demo-result-title">${s.methodLabel.regression(title(result.dependentVariable))}</p>
        <table class="md-demo-table"><tbody>
          <tr><td>${s.intercept}</td><td>${result.intercept}</td></tr>
          ${rows}
          <tr><td>R²</td><td>${result.rSquared}</td></tr>
        </tbody></table>
      `
      const host = chartHost()
      host.appendChild(barChart(result.coefficients.map((c) => ({ label: title(c.variable), value: c.coefficient }))))
      resultEl.appendChild(host)
    } else if (result.method === 'trend') {
      const rows = result.series.map((p) => `<tr><td>${p.period}</td><td>${p.value}</td></tr>`).join('')
      resultEl.innerHTML = `
        <p class="md-demo-result-title">${s.methodLabel.trend(title(result.variable))}</p>
        <table class="md-demo-table"><tbody>${rows}</tbody></table>
      `
      const host = chartHost()
      host.appendChild(lineChart(result.series))
      resultEl.appendChild(host)
    } else if (result.method === 'ranking') {
      const rows = result.items.map((it) => `<tr><td>${it.value}</td><td>${it.total}</td></tr>`).join('')
      resultEl.innerHTML = `
        <p class="md-demo-result-title">${s.methodLabel.ranking(title(result.groupVariable), title(result.metricVariable))}</p>
        <table class="md-demo-table"><tbody>${rows}</tbody></table>
      `
      const host = chartHost()
      host.appendChild(barChart(result.items.map((it) => ({ label: it.value, value: it.total }))))
      resultEl.appendChild(host)
    }
  }

  const DATA_PREVIEW_ROWS = 30
  // A-Z, then AA, AB... — real spreadsheets label columns this way, and it
  // also reads as "these are raw underlying fields," distinct from the
  // human-title header row above it (same two-row-header idea Sheets uses
  // for a named range vs. the literal column letter).
  function columnLetter(index) {
    let n = index + 1
    let str = ''
    while (n > 0) {
      const rem = (n - 1) % 26
      str = String.fromCharCode(65 + rem) + str
      n = Math.floor((n - 1) / 26)
    }
    return str
  }

  function renderDataView(el, dataset) {
    const varRows = VARIABLES.map(
      (v) => `<tr><td>${title(v.name)}</td><td><code>${v.name}</code></td><td>${v.type === 'category' ? s.typeCategory : s.typeContinuous}</td></tr>`,
    ).join('')

    const cols = VARIABLES.map((v) => v.name)
    const letterHead = cols.map((_, i) => `<th>${columnLetter(i)}</th>`).join('')
    const titleHead = cols.map((c) => `<th>${title(c)}</th>`).join('')
    // Trailing empty column on every row (header and body alike — a table's
    // columns are positional, so the gutter needs one cell per row, not just
    // a wrapper div) so the last real column never sits flush against the
    // scroll container's edge.
    const body = dataset
      .slice(0, DATA_PREVIEW_ROWS)
      .map(
        (row, i) =>
          `<tr><td class="md-sheet-rownum">${i + 1}</td>${cols.map((c) => `<td>${row[c]}</td>`).join('')}<td class="md-sheet-gutter"></td></tr>`,
      )
      .join('')

    const panes = [
      {
        name: s.dataTabVariables,
        html: `
          <table class="md-demo-table">
            <thead><tr><th>${s.varListColName}</th><th>${s.varListColFieldId}</th><th>${s.varListColType}</th></tr></thead>
            <tbody>${varRows}</tbody>
          </table>
        `,
      },
      {
        name: s.dataTabPreview,
        html: `
          <p class="md-demo-scenario-data" style="margin-bottom:10px">${s.dataPreviewCount(DATA_PREVIEW_ROWS, dataset.length)}</p>
          <div class="md-demo-data-scroll">
            <table class="md-sheet">
              <thead>
                <tr><th class="md-sheet-rownum"></th>${letterHead}<th class="md-sheet-gutter"></th></tr>
                <tr><th class="md-sheet-rownum">#</th>${titleHead}<th class="md-sheet-gutter"></th></tr>
              </thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        `,
      },
    ]

    el.innerHTML = `
      <div class="md-demo-subtabs" id="md-demo-data-tabs">
        ${panes.map((p, i) => `<button type="button" class="md-demo-subtab${i === 0 ? ' is-active' : ''}" data-pane="${i}"><span class="md-demo-subtab-dot"></span>${p.name}</button>`).join('')}
      </div>
      <div class="md-demo-subtab-body" id="md-demo-data-tab-body"></div>
    `
    const tabsEl = el.querySelector('#md-demo-data-tabs')
    const bodyEl = el.querySelector('#md-demo-data-tab-body')

    function showPane(i) {
      tabsEl.querySelectorAll('.md-demo-subtab').forEach((btn) => btn.classList.toggle('is-active', +btn.dataset.pane === i))
      bodyEl.innerHTML = panes[i].html
    }
    tabsEl.querySelectorAll('.md-demo-subtab').forEach((btn) => {
      btn.addEventListener('click', () => showPane(+btn.dataset.pane))
    })
    showPane(0)
  }

  function escapeCode(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  // Deliberately simple line-by-line regex highlighting — not a real
  // tokenizer, just enough to make the two file types readable at a glance.
  // Reuses the .t-* classes already defined for the "How it works" code
  // panel elsewhere on this page, so no new color tokens are introduced.
  function highlightYaml(code) {
    return escapeCode(code)
      .split('\n')
      .map((line) => {
        const comment = line.match(/^(\s*)(#.*)$/)
        if (comment) return `${comment[1]}<span class="t-com">${comment[2]}</span>`
        const kv = line.match(/^(\s*(?:- )?)([\w.]+)(:)(.*)$/)
        if (kv) {
          const [, indent, key, colon, rest] = kv
          const restHighlighted = rest.replace(/\[([^\]]*)\]/g, (m, inner) => `[<span class="t-str">${inner}</span>]`)
          return `${indent}<span class="t-key">${key}</span><span class="t-punc">${colon}</span>${restHighlighted}`
        }
        return line
      })
      .join('\n')
  }

  function highlightJs(code) {
    const KEYWORDS = /\b(import|from|const|let|new|function|return|export)\b/g
    return escapeCode(code)
      .split('\n')
      .map((line) => {
        const comment = line.match(/^(.*?)(\/\/.*)$/)
        const rest = comment ? comment[1] : line
        let highlighted = rest
          .replace(/'([^']*)'/g, `<span class="t-str">'$1'</span>`)
          .replace(KEYWORDS, '<span class="t-kw">$1</span>')
          .replace(/\b([a-zA-Z_][\w]*)(?=\()/g, '<span class="t-fn">$1</span>')
        if (comment) highlighted += `<span class="t-com">${comment[2]}</span>`
        return highlighted
      })
      .join('\n')
  }

  // Code samples shown in the "Code" tab reflect the actual tools.yaml /
  // widget.js source (see tools.yaml's own `thought`, which is intentionally
  // out of scope for UI-language switching — it's the assistant's own
  // system prompt, not rendered page copy). The tool descriptions below are
  // the one part of this literal snippet translated per language (rather
  // than always showing tools.yaml's real Chinese text) — this is display
  // code shown to visitors on the English page, and Chinese description
  // strings there would read as broken/unfinished, the same reason
  // widget.js's own hardcoded url/appId sample values below don't leak a
  // local dev target.
  const toolDescriptions =
    lang === 'zh'
      ? {
          listVariables: '取得目前頁面上可用的分析變數清單',
          selectAnalysis: '執行分析方法並在頁面顯示結果',
        }
      : {
          listVariables: 'List the analysis variables available on this page',
          selectAnalysis: 'Run an analysis method and display the result on the page',
        }
  const CODE_FILES = [
    {
      name: 'tools.yaml',
      lang: 'yaml',
      code: `tools:
  - name: list_variables
    kind: query
    description: ${toolDescriptions.listVariables}
    parameters:
      type: object
      properties:
        limit: { type: integer }
      required: [limit]

  - name: select_analysis
    description: ${toolDescriptions.selectAnalysis}
    parameters:
      type: object
      properties:
        method:
          type: string
          enum: [frequency, crossTable, correlation, regression, trend, ranking]
        variables:
          type: array
          items: { type: string }
        topN:
          type: integer
      required: [method, variables]`,
    },
    {
      name: 'widget.js',
      lang: 'js',
      // Deliberately hardcoded production-shaped values, not the runtime
      // WS_URL/APP_ID constants — this is display code shown to visitors,
      // and interpolating whatever this session actually connects to would
      // leak a local dev URL (or any other non-production target) straight
      // into the page. See widget.js's own header comment for where the
      // real values come from.
      code: `import { AgentBridge, defineTool } from '@onagent/bridge'

const bridge = new AgentBridge({
  url: 'wss://onagent.shuttle.tools/ws',
  appId: 'analysis-app',
  apiKey: API_KEY,
  onAssistantMessage: (text) => addChatMessage('assistant', text),
  tools: [
    defineTool('list_variables', parseListVariablesArgs, () =>
      VARIABLES.map((v) => ({ name: v.name, title: v.title, type: v.type })),
    ),
    defineTool('select_analysis', parseSelectAnalysisArgs, ({ method, variables, topN }) => {
      renderResult(resultEl, runByMethod(dataset, method, variables, topN))
    }),
  ],
})

bridge.prompt(text) // called when the user submits a question`,
    },
  ]

  function renderCodeView(el) {
    el.innerHTML = `
      <div class="md-demo-code-tabs" id="md-demo-code-tabs">
        ${CODE_FILES.map((f, i) => `<button type="button" class="md-demo-code-tab${i === 0 ? ' is-active' : ''}" data-file="${i}"><span class="md-demo-code-tab-dot"></span>${f.name}</button>`).join('')}
      </div>
      <pre class="md-demo-code-body"><code id="md-demo-code-content"></code></pre>
    `
    const tabsEl = el.querySelector('#md-demo-code-tabs')
    const codeEl = el.querySelector('#md-demo-code-content')

    function showFile(i) {
      tabsEl.querySelectorAll('.md-demo-code-tab').forEach((btn) => btn.classList.toggle('is-active', +btn.dataset.file === i))
      const file = CODE_FILES[i]
      codeEl.innerHTML = file.lang === 'yaml' ? highlightYaml(file.code) : highlightJs(file.code)
    }
    tabsEl.querySelectorAll('.md-demo-code-tab').forEach((btn) => {
      btn.addEventListener('click', () => showFile(+btn.dataset.file))
    })
    showFile(0)
  }

  root.innerHTML = `
    <div class="md-demo">
      <!-- Desktop keeps the full sidebar nav (all three tabs). On mobile
         this nav plays no role at all — hidden entirely (see index.html's
         @media max-width:720px) — since Data/Code are reached via direct
         buttons there instead (Data under the scenario blurb, Code next to
         the modal's own outer close button via mountMarketingDemo's
         returned openCode()), and Analysis is reached via a result card's
         "show result" button, not browsed to directly. -->
      <nav class="md-demo-nav" id="md-demo-nav">
        <button type="button" class="md-demo-nav-btn is-active" data-view="analysis">
          <svg viewBox="0 0 24 24"><path d="M4 19V9M12 19V5M20 19v-7"/></svg>${s.navAnalysis}
        </button>
        <button type="button" class="md-demo-nav-btn" data-view="data">
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/></svg>${s.navData}
        </button>
        <button type="button" class="md-demo-nav-btn" data-view="code">
          <svg viewBox="0 0 24 24"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/></svg>${s.navCode}
        </button>
      </nav>
      <div class="md-demo-nav-sheet-backdrop" id="md-demo-nav-sheet-backdrop"></div>
      <div class="md-demo-main" id="md-demo-main">
        <!-- Mobile-only rough prototype: closes the content sheet
           (Analysis/Data/Code — see .md-demo-main's bottom-sheet CSS) back
           down to the chat panel. Hidden on desktop, where .md-demo-main is
           just a normal column, not a sheet. -->
        <button type="button" class="md-demo-main-sheet-close" id="md-demo-main-sheet-close" aria-label="${lang === 'zh' ? '關閉' : 'Close'}">✕</button>
        <div class="md-demo-view" id="md-demo-view-analysis">
          <div class="md-demo-result" id="md-demo-result">
            <p class="md-demo-placeholder">${s.resultPlaceholder}</p>
          </div>
        </div>
        <div class="md-demo-view" id="md-demo-view-data" hidden></div>
        <div class="md-demo-view" id="md-demo-view-code" hidden></div>
      </div>
      <div class="md-demo-chat" id="md-demo-chat">
        <!-- The scenario blurb and the quick-test questions are just the
           first entries in the chat log now (desktop and mobile alike) —
           plain content within the conversation's own scroll, not a
           separate fixed block above it, so they scroll away with
           everything else instead of needing their own layout treatment. -->
        <div class="md-demo-chat-log" id="md-demo-chat-log">
          <div class="md-demo-chat-scenario">
            <p class="md-demo-scenario-title">${s.scenarioTitle}</p>
            <p class="md-demo-scenario-text">${s.scenarioText}</p>
            <button type="button" class="md-demo-scenario-data-btn" id="md-demo-scenario-data-btn">
              <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/></svg>${s.navData}
            </button>
          </div>
          <div class="md-demo-quick-tests" id="md-demo-quick-tests">
            <p class="md-demo-quick-tests-label">${s.quickTestsLabel}</p>
            <div class="md-demo-quick-test-btns" id="md-demo-quick-test-btns"></div>
          </div>
          <p class="md-demo-chat-hint">${s.chatHint}</p>
        </div>
        <div class="md-demo-footer" id="md-demo-footer">
          <form class="md-demo-input-row" id="md-demo-form">
            <textarea class="md-demo-input" id="md-demo-input" placeholder="${s.inputPlaceholderConnecting}" rows="1" disabled></textarea>
            <button type="submit" class="md-demo-send-btn" id="md-demo-send" disabled aria-label="${s.sendAriaLabel}">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>
            </button>
          </form>
          <p class="md-demo-status" id="md-demo-status">${s.statusConnecting}</p>
        </div>
      </div>
    </div>
  `

  const navEl = root.querySelector('#md-demo-nav')
  const chatEl = root.querySelector('#md-demo-chat')
  const navSheetBackdrop = root.querySelector('#md-demo-nav-sheet-backdrop')

  const mainEl = root.querySelector('#md-demo-main')
  const mainSheetCloseBtn = root.querySelector('#md-demo-main-sheet-close')

  // Mobile-only: the content sheet (Analysis/Data/Code) shares its backdrop
  // with the sidebar nav's desktop styling being irrelevant there — see
  // each element's own comment for why mobile reaches Data/Code via direct
  // buttons instead of picking a tab from #md-demo-nav.
  function closeMainSheet() {
    mainEl.classList.remove('is-sheet-open')
    navSheetBackdrop.classList.remove('is-open')
  }
  function openMainSheet() {
    mainEl.classList.add('is-sheet-open')
    navSheetBackdrop.classList.add('is-open')
  }
  navSheetBackdrop.addEventListener('click', closeMainSheet)
  mainSheetCloseBtn.addEventListener('click', closeMainSheet)
  const views = {
    analysis: root.querySelector('#md-demo-view-analysis'),
    data: root.querySelector('#md-demo-view-data'),
    code: root.querySelector('#md-demo-view-code'),
  }
  function switchView(id) {
    const activeBtn = [...navEl.querySelectorAll('.md-demo-nav-btn')].find((b) => b.dataset.view === id)
    navEl.querySelectorAll('.md-demo-nav-btn').forEach((b) => b.classList.toggle('is-active', b === activeBtn))
    Object.entries(views).forEach(([key, el]) => (el.hidden = key !== id))
    // Data/Code are reference views, not part of the conversation — only
    // the Analysis view needs the chat sidebar alongside it.
    chatEl.hidden = id !== 'analysis'
    // Mobile-only — a harmless no-op on desktop, where .md-demo-main is
    // just a normal column, not a sheet.
    openMainSheet()
  }
  navEl.querySelectorAll('.md-demo-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view))
  })
  root.querySelector('#md-demo-scenario-data-btn').addEventListener('click', () => switchView('data'))
  renderDataView(views.data, dataset)
  renderCodeView(views.code)

  const resultEl = root.querySelector('#md-demo-result')
  const chatLogEl = root.querySelector('#md-demo-chat-log')
  const statusEl = root.querySelector('#md-demo-status')
  const inputEl = root.querySelector('#md-demo-input')
  const sendBtn = root.querySelector('#md-demo-send')
  const formEl = root.querySelector('#md-demo-form')
  const footerEl = root.querySelector('#md-demo-footer')
  const quickTestBtnsEl = root.querySelector('#md-demo-quick-test-btns')

  // Once the free per-browser cap is hit, the input has nothing left to do —
  // swap it for a CTA into the real product instead of just sitting there
  // disabled. Relative /app path, same as the rest of this page's
  // data-console links (backend/cmd/server/web.go mounts console there).
  function showUsageLimitReached() {
    footerEl.innerHTML = `
      <a class="btn btn-primary md-demo-cta" href="/app">${s.usageLimitCta}</a>
      <p class="md-demo-status">${s.usageLimitStatus(MAX_PROMPTS_PER_BROWSER)}</p>
    `
  }

  function addChatMessage(role, text, persist = true) {
    const hint = chatLogEl.querySelector('.md-demo-chat-hint')
    if (hint) hint.remove()
    const el = document.createElement('div')
    if (role === 'user') {
      el.className = 'md-demo-chat-msg md-demo-chat-msg-user'
      el.textContent = text
    } else {
      // Assistant replies are Markdown (per the app's thought prompt) —
      // rendered to HTML; user text stays plain (a user typing "**bold**"
      // means the literal characters, not a formatting request).
      el.className = 'md-demo-chat-msg md-demo-chat-msg-assistant md-demo-chat-msg-markdown'
      el.innerHTML = marked.parse(escapeHtml(text))
    }
    chatLogEl.appendChild(el)
    chatLogEl.scrollTop = chatLogEl.scrollHeight
    // persist=false when replaying saved history on mount — otherwise a
    // reload would re-append every entry to itself on each load.
    if (persist) appendHistory({ type: 'message', role, text })
  }

  // Appended to the chat log (in chronological order alongside the
  // conversation, not attached to any specific text bubble — the tool call
  // and the assistant's own text reply can arrive in either order, so
  // correlating a button to "the message that goes with this result" isn't
  // reliable) each time select_analysis actually produces a result, so past
  // turns stay reachable after later questions overwrite the result pane.
  function addResultCard(result, persist = true) {
    const hint = chatLogEl.querySelector('.md-demo-chat-hint')
    if (hint) hint.remove()
    const card = document.createElement('div')
    card.className = 'md-demo-result-card'
    card.innerHTML = `
      <span class="md-demo-result-card-label">${resultLabel(result)}</span>
      <button type="button" class="md-demo-result-card-btn">${s.resultCardShowBtn}</button>
    `
    card.querySelector('.md-demo-result-card-btn').addEventListener('click', () => {
      switchView('analysis')
      renderResult(resultEl, result)
    })
    chatLogEl.appendChild(card)
    chatLogEl.scrollTop = chatLogEl.scrollHeight
    // persist=false when replaying saved history on mount — see
    // addChatMessage's own comment on the same parameter. result is already
    // plain JSON-serializable data (analysis.js's functions return only
    // arrays/objects/numbers/strings), so it can go straight into storage.
    if (persist) appendHistory({ type: 'resultCard', result })
  }

  // Shown from the moment a prompt is sent until the real reply (or an
  // error) arrives, so the wait for an actual inference round-trip has
  // something moving on screen rather than a static chat log.
  let thinkingEl = null
  function showThinking() {
    hideThinking()
    thinkingEl = document.createElement('div')
    thinkingEl.className = 'md-demo-chat-msg md-demo-chat-msg-assistant md-demo-chat-msg-thinking'
    thinkingEl.innerHTML = `
      <span class="md-demo-chat-msg-thinking-dots"><span></span><span></span><span></span></span>
      <span class="md-demo-chat-msg-thinking-label">${s.thinkingLabel}<span>.</span><span>.</span><span>.</span></span>
    `
    chatLogEl.appendChild(thinkingEl)
    chatLogEl.scrollTop = chatLogEl.scrollHeight
  }
  function hideThinking() {
    if (thinkingEl) {
      thinkingEl.remove()
      thinkingEl = null
    }
  }

  // A more specific indicator than the generic "thinking" dots — shown
  // once the AI has actually decided on a method/variables and called
  // select_analysis, for the artificial ANALYSIS_DELAY_MS pause before the
  // (real, instant) computation renders — see select_analysis's handler
  // below for why that delay exists.
  let analyzingEl = null
  function showAnalyzing() {
    hideThinking()
    hideAnalyzing()
    analyzingEl = document.createElement('div')
    analyzingEl.className = 'md-demo-chat-msg md-demo-chat-msg-assistant md-demo-chat-msg-analyzing'
    analyzingEl.innerHTML = `
      <span class="md-demo-eq"><span></span><span></span><span></span><span></span></span>
      <span class="md-demo-chat-msg-analyzing-label">${s.analyzingLabel}<span>.</span><span>.</span><span>.</span></span>
    `
    chatLogEl.appendChild(analyzingEl)
    chatLogEl.scrollTop = chatLogEl.scrollHeight
  }
  function hideAnalyzing() {
    if (analyzingEl) {
      analyzingEl.remove()
      analyzingEl = null
    }
  }

  // A failed prompt surfaces here, in the chat log itself, with a retry
  // button that resends lastPromptText — not a line of text under the
  // input box, which a visitor's attention (on the log, waiting for a
  // reply) is easy to miss. See onError below for what calls this.
  function addErrorMessage() {
    const hint = chatLogEl.querySelector('.md-demo-chat-hint')
    if (hint) hint.remove()
    const el = document.createElement('div')
    el.className = 'md-demo-chat-msg md-demo-chat-msg-error'
    const textEl = document.createElement('span')
    textEl.textContent = s.chatErrorMessage
    const retryBtn = document.createElement('button')
    retryBtn.type = 'button'
    retryBtn.className = 'md-demo-chat-msg-error-retry'
    retryBtn.textContent = s.chatErrorRetry
    retryBtn.addEventListener('click', () => {
      el.remove()
      if (lastPromptText) sendPrompt(lastPromptText)
    })
    el.appendChild(textEl)
    el.appendChild(retryBtn)
    chatLogEl.appendChild(el)
    chatLogEl.scrollTop = chatLogEl.scrollHeight
  }

  // Set once the real connection is up (see below) — buttons stay disabled
  // until then, since a "quick test" now means "submit this question through
  // the real AI," not a canned local calculation.
  let bridge = null

  // The text of the most recent sendPrompt call, so the error bubble's
  // retry button can resend it without the visitor retyping — cleared once
  // a reply (success or otherwise-handled) arrives so a later unrelated
  // error doesn't retry a stale prompt.
  let lastPromptText = null

  function sendPrompt(text) {
    if (!bridge || !text) return
    if (getPromptCount() >= MAX_PROMPTS_PER_BROWSER) {
      quickTestBtns.forEach((btn) => (btn.disabled = true))
      showUsageLimitReached()
      return
    }
    lastPromptText = text
    incrementPromptCount()
    addChatMessage('user', text)
    showThinking()
    showResultLoading(resultEl)
    bridge.prompt(text)
    const remaining = MAX_PROMPTS_PER_BROWSER - getPromptCount()
    statusEl.textContent = remaining > 0 ? s.statusRemainingPrompts(remaining) : ''
  }

  const quickTestBtns = QUICK_TESTS[lang].map((question) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-ghost md-demo-quick-test-btn'
    btn.textContent = question
    btn.disabled = true
    // Fills the input rather than sending immediately — the user still
    // reviews/edits and clicks send themselves, same as if they'd typed it.
    btn.addEventListener('click', () => {
      inputEl.value = question
      autoGrow()
      inputEl.focus()
    })
    quickTestBtnsEl.appendChild(btn)
    return btn
  })

  // Replay any saved history from a previous visit/reload — see
  // appendHistory's own comment for the storage shape. Unrecognized entry
  // shapes (a future schema change, or storage shared with some other
  // version of this widget) are skipped rather than thrown on, since a
  // corrupted single entry shouldn't block restoring the rest.
  for (const entry of getHistory()) {
    if (entry?.type === 'message' && typeof entry.role === 'string' && typeof entry.text === 'string') {
      addChatMessage(entry.role, entry.text, false)
    } else if (entry?.type === 'resultCard' && entry.result && typeof entry.result === 'object') {
      addResultCard(entry.result, false)
    }
  }

  if (!API_KEY) {
    statusEl.textContent = s.statusNotWired
    inputEl.placeholder = s.inputPlaceholderNotWired
    return
  }

  // AgentBridge has no onOpen/onReady callback (see packages/bridge/src/
  // client.ts's AgentBridgeOptions) — it's a stub-queue design where
  // prompt() calls made before the socket is ready are buffered and
  // flushed once an "ack" arrives from the backend, and that "ack" handling
  // is entirely internal to the SDK: it doesn't fire onAssistantMessage,
  // onError, or any other callback. There is therefore no reliable signal
  // this widget can wait on to know the connection actually succeeded
  // before enabling the input — waiting on one (a previous version of this
  // code tried gating on the first onAssistantMessage/onError) creates a
  // deadlock, since a visitor can never trigger either of those without
  // first being able to send a prompt. So the UI unlocks as soon as the
  // AgentBridge instance is constructed, same as gtag.js-style SDKs that
  // queue calls before "ready" — a prompt sent against a connection that
  // never comes up still surfaces as a real, user-visible error via
  // onError below, just later than an upfront "connecting" state would.
  bridge = new AgentBridge({
    url: WS_URL,
    appId: APP_ID,
    apiKey: API_KEY,
    onAssistantMessage: (text) => {
      hideThinking()
      hideAnalyzing()
      // If select_analysis never actually fired this turn (e.g. the AI just
      // answered in text, or asked a clarifying question), the skeleton
      // would otherwise sit there forever — fall back to the original
      // placeholder instead of leaving a permanently "loading" pane.
      if (resultEl.querySelector('.md-demo-result-loading')) {
        resultEl.innerHTML = `<p class="md-demo-placeholder">${s.resultPlaceholder}</p>`
      }
      addChatMessage('assistant', text)
    },
    onError: (err) => {
      hideThinking()
      hideAnalyzing()
      if (resultEl.querySelector('.md-demo-result-loading')) {
        resultEl.innerHTML = `<p class="md-demo-placeholder">${s.resultPlaceholder}</p>`
      }
      // console.error, not the chat log, gets the raw protocol/transport
      // message (err.message) — a visitor sees a plain-language bubble
      // instead (see addErrorMessage), never the technical detail.
      console.error('[marketing-demo]', err)
      addErrorMessage()
    },
    onQuotaExceeded: () => {
      hideThinking()
      quickTestBtns.forEach((btn) => (btn.disabled = true))
      showUsageLimitReached()
    },
    tools: [
      defineTool('list_variables', parseListVariablesArgs, () =>
        VARIABLES.map((v) => ({ name: v.name, title: title(v.name), type: v.type })),
      ),
      defineTool('select_analysis', parseSelectAnalysisArgs, ({ method, variables, topN }) => {
        // The actual computation is instant (pure JS on 120 rows) — an
        // artificial pause plus a visible "analyzing" cue makes the demo
        // read as doing real work, rather than results just teleporting in
        // the moment the AI decides on a method.
        showAnalyzing()
        setTimeout(() => {
          hideAnalyzing()
          const result = runByMethod(dataset, method, variables, topN)
          renderResult(resultEl, result)
          if (result) addResultCard(result)
        }, ANALYSIS_DELAY_MS)
      }),
    ],
  })

  statusEl.textContent = ''
  inputEl.disabled = false
  inputEl.placeholder = s.inputPlaceholderReady
  sendBtn.disabled = false
  quickTestBtns.forEach((btn) => (btn.disabled = false))

  // Auto-grow the textarea as content wraps to new lines, up to a max
  // height (see .md-demo-input's max-height) beyond which it scrolls
  // internally rather than pushing the rest of the sidebar around.
  const INPUT_MAX_HEIGHT = 140 // px — matches .md-demo-input's max-height
  function autoGrow() {
    inputEl.style.height = 'auto'
    const needed = inputEl.scrollHeight
    inputEl.style.height = Math.min(needed, INPUT_MAX_HEIGHT) + 'px'
    // Only show the scrollbar once content genuinely exceeds the cap —
    // see .md-demo-input's own comment for why overflow:auto alone isn't
    // enough (some browsers reserve scrollbar space pre-emptively).
    inputEl.style.overflowY = needed > INPUT_MAX_HEIGHT ? 'auto' : 'hidden'
  }
  inputEl.addEventListener('input', autoGrow)

  function submitInput() {
    const text = inputEl.value.trim()
    if (!text) return
    sendPrompt(text)
    inputEl.value = ''
    autoGrow()
  }

  formEl.addEventListener('submit', (e) => {
    e.preventDefault()
    submitInput()
  })
  // Enter sends; Shift+Enter inserts a newline (textarea's own default
  // behavior, so no handling needed for that case). e.isComposing guards
  // against IME composition (Chinese/Japanese/Korean input methods etc.):
  // confirming a candidate word with Enter also fires a keydown with
  // key === 'Enter', which would otherwise submit the half-typed sentence
  // instead of just committing the selected characters into the textarea.
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submitInput()
    }
  })

  // Small public API for the outer static page (index.html/zh-tw/index.html
  // — outside this mounted root) to reach in: the mobile Code button lives
  // next to the modal's own outer close button, not inside this widget's
  // own markup, so there's no in-root element for it to wire a click to
  // directly.
  return {
    openCode: () => switchView('code'),
  }
}
