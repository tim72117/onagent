import type { Tool } from './schema'
import type { AppSummary } from './api'
import type { ValidationIssue } from './validate'
import { AgentNav } from './AgentNav'
import { ToolList } from './ToolList'
import { SidebarFooter } from './SidebarFooter'
import styles from './Sidebar.module.css'
import navStyles from './SidebarNav.module.css'

export function Sidebar({
  userEmail,
  activeAppId,
  summaries,
  tools,
  activeToolIndex,
  agentSelected,
  playgroundSelected,
  settingsSelected,
  appSettingsSelected,
  previewSelected,
  issuesByTool,
  onSelectTool,
  onSelectAgent,
  onSelectPlayground,
  onSelectSettings,
  onSelectAppSettings,
  onSelectPreview,
  onAddTool,
  onAddToolWizard,
}: {
  userEmail: string
  activeAppId: string | null
  // Only used for the App settings / YAML nav items' visibility condition
  // below — AppList itself moved to DesktopAppBar.tsx, which now owns the
  // actual app-switching UI (App.tsx renders it above the workspace, not
  // here).
  summaries: AppSummary[]
  tools: Tool[] | null // null when no app is selected
  activeToolIndex: number | null
  agentSelected: boolean
  playgroundSelected: boolean
  settingsSelected: boolean
  appSettingsSelected: boolean
  previewSelected: boolean
  issuesByTool: Map<number, ValidationIssue[]>
  onSelectTool: (index: number) => void
  onSelectAgent: () => void
  onSelectPlayground: () => void
  onSelectSettings: () => void
  onSelectAppSettings: () => void
  onSelectPreview: () => void
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

      {/* YAML preview (PreviewPanel.tsx) — used to render permanently in
          the tool editor's right-hand pane; moved to its own nav item /
          full workspace view (App.tsx's 'preview' view kind) so it doesn't
          eat workspace width on every tool-editing screen, only when
          actually wanted. Same visibility condition and "needs some app"
          shape as App settings below (selectPreview mirrors
          selectAppSettings's own default-to-first-app fallback). */}
      {(activeAppId || summaries.length > 0) && (
        <div className={navStyles.section}>
          <ul className={navStyles.list}>
            <li>
              <button
                type="button"
                className={`${navStyles.item}${previewSelected ? ' ' + navStyles.active : ''}`}
                onClick={onSelectPreview}
              >
                <span className={navStyles.itemMain}>
                  <svg
                    className={navStyles.itemIcon}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    width="13"
                    height="13"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                    <line x1="9" y1="13" x2="15" y2="13" />
                    <line x1="9" y1="17" x2="15" y2="17" />
                  </svg>
                  <span className={navStyles.itemLabel}>YAML</span>
                </span>
              </button>
            </li>
          </ul>
        </div>
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
                <span className={navStyles.itemMain}>
                  {/* Same gear path as MobileTopBar.tsx's App settings button, at
                      this list's smaller icon size, for one consistent gear glyph
                      across the desktop and mobile entry points to the same screen. */}
                  <svg
                    className={navStyles.itemIcon}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    width="13"
                    height="13"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span className={navStyles.itemLabel}>Settings</span>
                </span>
              </button>
            </li>
          </ul>
        </div>
      )}

      <SidebarFooter userEmail={userEmail} settingsSelected={settingsSelected} onSelectSettings={onSelectSettings} />
    </nav>
  )
}
