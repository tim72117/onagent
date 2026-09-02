import type { ReactNode } from 'react'

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
    <div className="login-screen">
      {title && (
        <div className="login-welcome">
          {/* Plain <a>, not client-side routing — the console SPA is mounted
              at /app, so leaving it entirely means a full navigation. */}
          <a className="login-welcome-logo" href="/" aria-label="onagent">
            <span className="sidebar-mark" aria-hidden="true">
              ⌘
            </span>
            <span>onagent</span>
          </a>
          <h1 className="login-welcome-title">{title}</h1>
          {subtitle && <p className="login-welcome-subtitle">{subtitle}</p>}
        </div>
      )}
      <div className="login-card">{children}</div>
    </div>
  )
}
