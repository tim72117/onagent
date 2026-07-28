import { lazy, Suspense, useState } from 'react'
import type { App } from './schema'
import { toLLMToolsJSON, toTypeScript, toYAML } from './codegen'

// Lazy-loaded so CodeMirror (a real dependency, see YamlEditor.tsx's doc
// comment) is only ever downloaded by someone who actually clicks the
// "YAML (edit)" tab — the other three tabs stay exactly as light as before.
const YamlEditor = lazy(() => import('./YamlEditor').then((m) => ({ default: m.YamlEditor })))

type Tab = 'yaml' | 'yaml-edit' | 'json' | 'ts'

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'yaml', label: 'YAML', hint: 'equivalent to what Save persists for this app (stored in the database, not a file on disk)' },
  {
    id: 'yaml-edit',
    label: 'YAML (edit) — prototype',
    hint: "Prototype: syntax-highlighted editing. Doesn't parse back or save yet — see docs/console-yaml-editor-2026-07-28.md.",
  },
  { id: 'json', label: 'LLM tool JSON', hint: 'shape returned by GET /apps/{appId}/tools.json' },
  { id: 'ts', label: 'TypeScript', hint: 'shape returned by GET /apps/{appId}/tools.ts' },
]

export function PreviewPanel({ app }: { app: App }) {
  const [tab, setTab] = useState<Tab>('yaml')
  const [copied, setCopied] = useState(false)
  // Only the prototype tab needs to hold edited text locally — every other
  // tab is a pure function of `app`, regenerated on every render.
  const [yamlDraft, setYamlDraft] = useState(() => toYAML(app))

  const content = tab === 'yaml' ? toYAML(app) : tab === 'json' ? toLLMToolsJSON(app) : toTypeScript(app)

  async function copy() {
    const text = tab === 'yaml-edit' ? yamlDraft : content
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="preview-panel">
      <div className="preview-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'tab-btn active' : 'tab-btn'}
            onClick={() => {
              // Reset the draft from the current app every time the edit tab
              // is (re-)entered, same as the read-only tabs always showing
              // the live app — this prototype has no Save, so there's no
              // edited state worth preserving across a tab switch yet.
              if (t.id === 'yaml-edit') setYamlDraft(toYAML(app))
              setTab(t.id)
            }}
          >
            {t.label}
          </button>
        ))}
        <button type="button" className="copy-btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="preview-hint">{TABS.find((t) => t.id === tab)!.hint}</div>
      {tab === 'yaml-edit' ? (
        <Suspense fallback={<div className="preview-code">Loading editor…</div>}>
          <YamlEditor value={yamlDraft} onChange={setYamlDraft} />
        </Suspense>
      ) : (
        <pre className="preview-code">
          <code>{content}</code>
        </pre>
      )}
    </div>
  )
}
