import type { Tool } from './schema'
import type { AppSummary } from './api'
import type { ValidationIssue } from './validate'
import { AgentNav, PlaygroundNav } from './AgentNav'
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
        {/* Sphere brand mark — kept in sync with LoginCard.tsx's copy, which
            differs only in its gradient id prefix (SVG resolves url(#id)
            globally, and both can be mounted at once).

            The rim light is a *stroke* inset to r=30, not a fill at r=31
            like the sphere body: as a fill, its bright band spanned the
            outermost 4% of the radius — under a pixel wide at this size —
            and shared an edge with two other r=31 circles, so three
            independently-antialiased boundaries composited into a visibly
            jagged ring. A stroke rasterises against a defined width and no
            longer touches the silhouette. Its gradient is linear, not
            radial, so the rim brightens toward the same upper-left light
            source as the specular highlight; a radial one would just ring
            the sphere evenly. */}
        <span className="sidebar-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64">
            <defs>
              <radialGradient id="sbMarkS" cx="36%" cy="28%" r="76%">
                <stop offset="0" stopColor="#4a4030" />
                <stop offset="0.22" stopColor="#2e2819" />
                <stop offset="0.48" stopColor="#181410" />
                <stop offset="0.74" stopColor="#0a0907" />
                <stop offset="1" stopColor="#030302" />
              </radialGradient>
              {/* Bounce light: the underside of a real sphere picks up
                  reflected light instead of going dead black. */}
              <radialGradient id="sbMarkB" cx="50%" cy="50%" r="50%">
                <stop offset="0.62" stopColor="#c9a24b" stopOpacity="0" />
                <stop offset="0.88" stopColor="#8a6f34" stopOpacity="0.30" />
                <stop offset="1" stopColor="#6b5528" stopOpacity="0.16" />
              </radialGradient>
              <linearGradient id="sbMarkR" x1="0" y1="0" x2="0.35" y2="1">
                <stop offset="0" stopColor="#f6e6bd" stopOpacity="0.85" />
                <stop offset="0.45" stopColor="#c9a24b" stopOpacity="0.55" />
                <stop offset="1" stopColor="#8a6f34" stopOpacity="0.40" />
              </linearGradient>
              <radialGradient id="sbMarkSp" cx="50%" cy="50%" r="50%">
                <stop offset="0" stopColor="#ffffff" stopOpacity="0.50" />
                <stop offset="0.45" stopColor="#fff4d6" stopOpacity="0.16" />
                <stop offset="1" stopColor="#f0dfae" stopOpacity="0" />
              </radialGradient>
              {/* Socket shadow seats each eye into the surface rather than
                  leaving it pasted on top. */}
              <radialGradient id="sbMarkSo" cx="50%" cy="46%" r="52%">
                <stop offset="0.55" stopColor="#000000" stopOpacity="0.55" />
                <stop offset="1" stopColor="#000000" stopOpacity="0" />
              </radialGradient>
              <radialGradient id="sbMarkG" cx="50%" cy="50%" r="50%">
                <stop offset="0" stopColor="#f6e6bd" stopOpacity="0.44" />
                <stop offset="0.5" stopColor="#e0c98a" stopOpacity="0.15" />
                <stop offset="1" stopColor="#c9a24b" stopOpacity="0" />
              </radialGradient>
              <radialGradient id="sbMarkI" cx="42%" cy="36%" r="68%">
                <stop offset="0" stopColor="#fffdf4" />
                <stop offset="0.34" stopColor="#ffeec4" />
                <stop offset="0.68" stopColor="#e8c982" />
                <stop offset="1" stopColor="#a8813a" />
              </radialGradient>
            </defs>
            <circle cx="32" cy="32" r="31" fill="url(#sbMarkS)" />
            <circle cx="32" cy="32" r="31" fill="url(#sbMarkB)" />
            <circle cx="32" cy="32" r="30" fill="none" stroke="url(#sbMarkR)" strokeWidth="2" />
            <ellipse cx="22" cy="17" rx="13" ry="8.5" fill="url(#sbMarkSp)" transform="rotate(-24 22 17)" />
            <circle cx="23" cy="28" r="11" fill="url(#sbMarkSo)" />
            <circle cx="41" cy="28" r="11" fill="url(#sbMarkSo)" />
            <circle cx="23" cy="28" r="10" fill="url(#sbMarkG)" />
            <circle cx="41" cy="28" r="10" fill="url(#sbMarkG)" />
            <circle cx="23" cy="28" r="5.6" fill="url(#sbMarkI)" />
            <circle cx="41" cy="28" r="5.6" fill="url(#sbMarkI)" />
            {/* Catchlights sit up-left, matching the specular highlight —
                that shared direction is what reads as one light source. */}
            <circle cx="21.2" cy="26.2" r="1.7" fill="#ffffff" opacity="0.92" />
            <circle cx="39.2" cy="26.2" r="1.7" fill="#ffffff" opacity="0.92" />
          </svg>
        </span>
        <span className={styles.brandName}>onagent</span>
      </div>

      {/* Thought and Tools are peer items inside the Agent section, with the
          individual tool rows nested under Tools; Playground is its own
          section below that one, at the same level as the section itself. */}
      {tools !== null && (
        <AgentNav
          agentSelected={agentSelected}
          onSelectAgent={onSelectAgent}
          toolsSlot={
            <ToolList
              tools={tools}
              activeToolIndex={activeToolIndex}
              issuesByTool={issuesByTool}
              onSelectTool={onSelectTool}
              onAddTool={onAddTool}
              onAddToolWizard={onAddToolWizard}
            />
          }
        />
      )}

      {tools !== null && (
        <PlaygroundNav playgroundSelected={playgroundSelected} onSelectPlayground={onSelectPlayground} />
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
