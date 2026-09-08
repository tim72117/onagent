import styles from './SidebarNav.module.css'

// Desktop-only Agent/Playground nav — mobile has no equivalent nav item
// (Playground is reached from MobileBottomBar.tsx instead).
export function AgentNav({
  agentSelected,
  playgroundSelected,
  onSelectAgent,
  onSelectPlayground,
}: {
  agentSelected: boolean
  playgroundSelected: boolean
  onSelectAgent: () => void
  onSelectPlayground: () => void
}) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <span>Agent</span>
      </div>
      <ul className={styles.list}>
        <li>
          <button
            type="button"
            className={`${styles.item}${agentSelected ? ' ' + styles.active : ''}`}
            onClick={onSelectAgent}
          >
            <span className={styles.itemLabel}>Thought</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`${styles.item}${playgroundSelected ? ' ' + styles.active : ''}`}
            onClick={onSelectPlayground}
          >
            <span className={styles.itemLabel}>Playground</span>
          </button>
        </li>
      </ul>
    </div>
  )
}
