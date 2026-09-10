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
            <span className={styles.itemMain}>
              <svg
                className={styles.itemIcon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="13"
                height="13"
              >
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
              <span className={styles.itemLabel}>Thought</span>
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`${styles.item}${playgroundSelected ? ' ' + styles.active : ''}`}
            onClick={onSelectPlayground}
          >
            <span className={styles.itemMain}>
              <svg
                className={styles.itemIcon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="13"
                height="13"
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span className={styles.itemLabel}>Playground</span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  )
}
