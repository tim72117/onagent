import type { Tool } from './schema'
import type { ValidationIssue } from './validate'
import styles from './ToolList.module.css'
import navStyles from './SidebarNav.module.css'

// Desktop-only Tools nav — mobile has no equivalent nav item.
export function ToolList({
  tools,
  activeToolIndex,
  issuesByTool,
  onSelectTool,
  onAddTool,
  onAddToolWizard,
}: {
  tools: Tool[]
  activeToolIndex: number | null
  issuesByTool: Map<number, ValidationIssue[]>
  onSelectTool: (index: number) => void
  onAddTool: () => void
  onAddToolWizard: () => void
}) {
  return (
    <div className={`${navStyles.section} ${styles.sectionGrow}`}>
      <div className={navStyles.sectionHead}>
        <span>Tools</span>
        <span className={styles.sectionActions}>
          <button
            type="button"
            className={navStyles.iconBtn}
            onClick={onAddToolWizard}
            aria-label="New tool, guided"
            title="New tool, guided"
            data-track="tool_creation_method_selected:wizard"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
              <path d="M12 4v4M12 16v4M4 12h4M16 12h4" />
              <path d="M8 8l1.5 1.5M14.5 14.5L16 16M16 8l-1.5 1.5M9.5 14.5L8 16" />
            </svg>
          </button>
          <button
            type="button"
            className={navStyles.iconBtn}
            onClick={onAddTool}
            aria-label="New tool"
            data-track="tool_creation_method_selected:blank"
          >
            +
          </button>
        </span>
      </div>
      {tools.length === 0 ? (
        <p className="sidebar-empty">No tools yet</p>
      ) : (
        <ul className={navStyles.list}>
          {tools.map((tool, i) => {
            const issueCount = issuesByTool.get(i)?.length ?? 0
            return (
              <li key={i}>
                <button
                  type="button"
                  className={`${navStyles.item} ${styles.itemTool}${i === activeToolIndex ? ' ' + navStyles.active : ''}`}
                  onClick={() => onSelectTool(i)}
                >
                  <span className={navStyles.itemLabel}>
                    {tool.name || <em>unnamed_tool</em>}
                  </span>
                  {issueCount > 0 && (
                    <span className={`${navStyles.statusDot} ${navStyles.error}`} title={`${issueCount} issue(s)`} />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
