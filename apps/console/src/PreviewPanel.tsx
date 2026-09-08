import { useState } from 'react'
import type { App } from './schema'
import { toYAML } from './codegen'
import styles from './PreviewPanel.module.css'

const HINT = 'equivalent to what Save persists for this app (stored in the database, not a file on disk)'

export function PreviewPanel({ app }: { app: App }) {
  const [copied, setCopied] = useState(false)
  const content = toYAML(app)

  async function copy() {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={styles.previewPanel}>
      <div className={styles.previewTabs}>
        <span className={styles.tabBtn}>YAML</span>
        <button type="button" className={styles.copyBtn} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className={styles.previewHint}>{HINT}</div>
      <pre className={styles.previewCode}>
        <code>{content}</code>
      </pre>
    </div>
  )
}
