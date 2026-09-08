import type { Tool } from './schema'
import type { AppSummary } from './api'
import type { ValidationIssue } from './validate'
import { AppList } from './AppList'
import { AgentNav } from './AgentNav'
import { ToolList } from './ToolList'
import { SidebarFooter } from './SidebarFooter'
import styles from './Sidebar.module.css'
import navStyles from './SidebarNav.module.css'

export function Sidebar({
  userEmail,
  summaries,
  activeAppId,
  onSelectApp,
  onAddApp,
  tools,
  activeToolIndex,
  agentSelected,
  playgroundSelected,
  settingsSelected,
  appSettingsSelected,
  issuesByTool,
  onSelectTool,
  onSelectAgent,
  onSelectPlayground,
  onSelectSettings,
  onSelectAppSettings,
  onAddTool,
  onAddToolWizard,
}: {
  userEmail: string
  summaries: AppSummary[]
  activeAppId: string | null
  onSelectApp: (appId: string) => void
  onAddApp: () => void
  tools: Tool[] | null // null when no app is selected
  activeToolIndex: number | null
  agentSelected: boolean
  playgroundSelected: boolean
  settingsSelected: boolean
  appSettingsSelected: boolean
  issuesByTool: Map<number, ValidationIssue[]>
  onSelectTool: (index: number) => void
  onSelectAgent: () => void
  onSelectPlayground: () => void
  onSelectSettings: () => void
  onSelectAppSettings: () => void
  onAddTool: () => void
  onAddToolWizard: () => void
}) {
  return (
    <nav className="sidebar">
      <div className={styles.brand}>
        <span className="sidebar-mark" aria-hidden="true">
          ⌘
        </span>
        <span className={styles.brandName}>Console</span>
      </div>

      <AppList summaries={summaries} activeAppId={activeAppId} onSelectApp={onSelectApp} onAddApp={onAddApp} />

      {tools !== null && (
        <AgentNav
          agentSelected={agentSelected}
          playgroundSelected={playgroundSelected}
          onSelectAgent={onSelectAgent}
          onSelectPlayground={onSelectPlayground}
        />
      )}

      {tools !== null && (
        <ToolList
          tools={tools}
          activeToolIndex={activeToolIndex}
          issuesByTool={issuesByTool}
          onSelectTool={onSelectTool}
          onAddTool={onAddTool}
          onAddToolWizard={onAddToolWizard}
        />
      )}

      {/* Per-app connection settings (key/origin) — a distinct concept
          from the account Settings reached via the avatar below (see
          AppSettingsView.tsx's own comment), only shown once at least one
          app exists (activeAppId or a non-empty summaries list — this
          nav item stays visible even if the currently open view is Agent/
          Playground/a tool, not just when an app is actively selected,
          since onSelectAppSettings itself picks a default app if needed). */}
      {(activeAppId || summaries.length > 0) && (
        <div className={navStyles.section}>
          <ul className={navStyles.list}>
            <li>
              <button
                type="button"
                className={`${navStyles.item}${appSettingsSelected ? ' ' + navStyles.active : ''}`}
                onClick={onSelectAppSettings}
              >
                <span className={navStyles.itemLabel}>App settings</span>
              </button>
            </li>
          </ul>
        </div>
      )}

      <SidebarFooter userEmail={userEmail} settingsSelected={settingsSelected} onSelectSettings={onSelectSettings} />
    </nav>
  )
}
