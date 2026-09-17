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
            {/* Same sphere as Sidebar.tsx's — its own gradient ids, since
                SVG resolves url(#id) globally and both can be mounted at
                once (the login card renders over the console shell). See
                Sidebar.tsx for why the rim is a stroke and not a fill. */}
            <span className="sidebar-mark" aria-hidden="true">
              <svg viewBox="0 0 64 64">
                <defs>
                  <radialGradient id="lcMarkS" cx="36%" cy="28%" r="76%">
                    <stop offset="0" stopColor="#4a4030" />
                    <stop offset="0.22" stopColor="#2e2819" />
                    <stop offset="0.48" stopColor="#181410" />
                    <stop offset="0.74" stopColor="#0a0907" />
                    <stop offset="1" stopColor="#030302" />
                  </radialGradient>
                  <radialGradient id="lcMarkB" cx="50%" cy="50%" r="50%">
                    <stop offset="0.62" stopColor="#c9a24b" stopOpacity="0" />
                    <stop offset="0.88" stopColor="#8a6f34" stopOpacity="0.30" />
                    <stop offset="1" stopColor="#6b5528" stopOpacity="0.16" />
                  </radialGradient>
                  <linearGradient id="lcMarkR" x1="0" y1="0" x2="0.35" y2="1">
                    <stop offset="0" stopColor="#f6e6bd" stopOpacity="0.85" />
                    <stop offset="0.45" stopColor="#c9a24b" stopOpacity="0.55" />
                    <stop offset="1" stopColor="#8a6f34" stopOpacity="0.40" />
                  </linearGradient>
                  <radialGradient id="lcMarkSp" cx="50%" cy="50%" r="50%">
                    <stop offset="0" stopColor="#ffffff" stopOpacity="0.50" />
                    <stop offset="0.45" stopColor="#fff4d6" stopOpacity="0.16" />
                    <stop offset="1" stopColor="#f0dfae" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id="lcMarkSo" cx="50%" cy="46%" r="52%">
                    <stop offset="0.55" stopColor="#000000" stopOpacity="0.55" />
                    <stop offset="1" stopColor="#000000" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id="lcMarkG" cx="50%" cy="50%" r="50%">
                    <stop offset="0" stopColor="#f6e6bd" stopOpacity="0.44" />
                    <stop offset="0.5" stopColor="#e0c98a" stopOpacity="0.15" />
                    <stop offset="1" stopColor="#c9a24b" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id="lcMarkI" cx="42%" cy="36%" r="68%">
                    <stop offset="0" stopColor="#fffdf4" />
                    <stop offset="0.34" stopColor="#ffeec4" />
                    <stop offset="0.68" stopColor="#e8c982" />
                    <stop offset="1" stopColor="#a8813a" />
                  </radialGradient>
                </defs>
                <circle cx="32" cy="32" r="31" fill="url(#lcMarkS)" />
                <circle cx="32" cy="32" r="31" fill="url(#lcMarkB)" />
                <circle cx="32" cy="32" r="30" fill="none" stroke="url(#lcMarkR)" strokeWidth="2" />
                <ellipse cx="22" cy="17" rx="13" ry="8.5" fill="url(#lcMarkSp)" transform="rotate(-24 22 17)" />
                <circle cx="23" cy="28" r="11" fill="url(#lcMarkSo)" />
                <circle cx="41" cy="28" r="11" fill="url(#lcMarkSo)" />
                <circle cx="23" cy="28" r="10" fill="url(#lcMarkG)" />
                <circle cx="41" cy="28" r="10" fill="url(#lcMarkG)" />
                <circle cx="23" cy="28" r="5.6" fill="url(#lcMarkI)" />
                <circle cx="41" cy="28" r="5.6" fill="url(#lcMarkI)" />
                <circle cx="21.2" cy="26.2" r="1.7" fill="#ffffff" opacity="0.92" />
                <circle cx="39.2" cy="26.2" r="1.7" fill="#ffffff" opacity="0.92" />
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
