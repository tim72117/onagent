import type { ReactNode } from 'react'
import styles from './SidebarNav.module.css'

// Desktop-only Agent nav — mobile has no equivalent nav item (Playground is
// reached from MobileBottomBar.tsx instead).
//
// Two exports rather than one: Thought and Tools are peer items inside the
// Agent section, while Playground is its own section rendered *below* that
// one — same level as the Agent section itself, not a row within it.
// Keeping them in one component would mean rendering a section and a
// sibling section from the same place, which is exactly the nesting the
// sidebar is trying to express.

// The Agent section: Thought and Tools as peer rows, tool rows nested
// under Tools. `toolsSlot` is ToolList.tsx's rendered output, passed in
// rather than imported so this component stays unaware of tool state —
// Sidebar.tsx already owns every tool prop.
export function AgentNav({
  agentSelected,
  onSelectAgent,
  toolsSlot,
}: {
  agentSelected: boolean
  onSelectAgent: () => void
  toolsSlot?: ReactNode
}) {
  return (
    <div className={styles.sectionAgent}>
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
      </ul>
      {toolsSlot}
    </div>
  )
}

// Standalone row below the Agent section — same level as that section, not
// an item within it. Mirrors the YAML/Settings rows in Sidebar.tsx, which
// use this same bare-list-in-a-section shape.
export function PlaygroundNav({
  playgroundSelected,
  onSelectPlayground,
}: {
  playgroundSelected: boolean
  onSelectPlayground: () => void
}) {
  return (
    <div className={styles.section}>
      <ul className={styles.list}>
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
