import type { ReactNode } from 'react'
import styles from './LoginCard.module.css'

// Shared shell for every full-screen login-adjacent state: Login.tsx's own
// sign-in/register form and CliAuthPage.tsx's loading/approve/error/success
// states all render the same .login-screen > .login-welcome + .login-card
// structure — previously each one hand-wrote its own copy of the brand
// mark, which is how they'd drift out of sync.
//
// The brand mark/title/subtitle live in .login-welcome, outside .login-card
// itself, not as the card's first child — a welcoming "Sign in to onagent"
// heading is a greeting meant to be read, while the card holds the actual
// operation (fields, buttons); stacking both inside the same bordered box
// flattens the greeting into just another form row. title left unset skips
// rendering .login-welcome entirely, for states with no heading to show.
export function LoginCard({
  title,
  subtitle,
  children,
}: {
  title?: string
  subtitle?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={styles.loginScreen}>
      {title && (
        <div className={styles.loginWelcome}>
          {/* Plain <a>, not client-side routing — the console SPA is mounted
              at /app, so leaving it entirely means a full navigation. */}
          <a className={styles.loginWelcomeLogo} href="/" aria-label="onagent">
            {/* Same ring as Sidebar.tsx's — its own gradient id, since SVG
                resolves url(#id) globally and both can be mounted at once
                (the login card renders over the console shell). */}
            <span className="sidebar-mark" aria-hidden="true">
              <svg viewBox="0 0 100 100">
                <defs>
                  <linearGradient id="lcMarkG" gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="90" y2="90">
                    <stop offset="0" stopColor="#c9a24b" />
                    <stop offset="1" stopColor="#e0c98a" />
                  </linearGradient>
                </defs>
                <path
                  fill="url(#lcMarkG)"
                  fillRule="evenodd"
                  d="M 10 50 a 40 40 0 1 0 80 0 a 40 40 0 1 0 -80 0 Z M 27 46 a 27 27 0 1 0 54 0 a 27 27 0 1 0 -54 0 Z"
                />
              </svg>
            </span>
            <span>onagent</span>
          </a>
          <h1 className={styles.loginWelcomeTitle}>{title}</h1>
          {subtitle && <p className={styles.loginWelcomeSubtitle}>{subtitle}</p>}
        </div>
      )}
      <div className={styles.loginCard}>{children}</div>
    </div>
  )
}
