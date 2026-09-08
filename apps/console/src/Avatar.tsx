import styles from './Avatar.module.css'

// Email-initial fallback avatar — no profile picture support yet, but the
// size/shape here is deliberately generic enough that a future `src?` prop
// could swap in a real image without changing callers.
export function Avatar({ email, size = 32 }: { email: string; size?: number }) {
  const initial = email.trim().charAt(0) || '?'
  return (
    <span className={styles.avatar} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      {initial}
    </span>
  )
}
