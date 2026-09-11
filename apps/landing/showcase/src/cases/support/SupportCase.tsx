import { Link } from 'react-router-dom'
import shared from '../../Shared.module.css'
import styles from './SupportCase.module.css'

// AI customer support agent — the second showcase case's list-page card.
// A phone mockup (not the browser-window collage the marketing case uses)
// since a support widget's natural home is a mobile chat thread; the two
// cases read as a matched pair (one portrait, one landscape) rather than
// duplicates. styles is this component's own; SupportDemo.module.css
// (the "/support" route's separate module) can never collide with it even
// where both happen to use a similar name, since each is scoped by import.
//
// styles.msg's animation-delay staggers each bubble/tool card/typing-
// indicator into view in conversation order, on a loop — a static
// "here's a finished chat log" read as inert; this reads as "the
// conversation is happening" without needing any real interactivity.
export function SupportCase() {
  return (
    <div className={shared.caseSplit}>
      <div className={shared.caseIllustration}>
        <div className={styles.collage} aria-hidden="true">
          <div className={styles.phone}>
            <div className={styles.notch} />
            <div className={styles.screen}>
              <div className={styles.header}>
                <span className={styles.avatar}>
                  <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
                </span>
                <div>
                  <div className={styles.headerName}>Support</div>
                  <div className={styles.headerStatus}><span className={styles.dot} />Online</div>
                </div>
              </div>
              <div className={styles.thread}>
                <span className={`${styles.msg} ${styles.fromUser}`} style={{ animationDelay: '0.2s' }}>Where's my order #48213?</span>
                <div className={styles.tool} style={{ animationDelay: '1.1s' }}>
                  <span>⚙ lookup_order(id: "48213")</span>
                  <span className={styles.toolResult}>→ status: in_transit</span>
                </div>
                <span className={`${styles.msg} ${styles.fromAi}`} style={{ animationDelay: '2.0s' }}>It shipped yesterday and is out for delivery — expected today by 6pm.</span>
                <span className={`${styles.msg} ${styles.fromUser}`} style={{ animationDelay: '2.9s' }}>Can I change the address?</span>
                <span className={`${styles.msg} ${styles.fromAi} ${styles.typing}`} style={{ animationDelay: '3.8s' }}>
                  <span className={styles.dot1} /><span className={styles.dot2} /><span className={styles.dot3} />
                </span>
              </div>
              <div className={styles.input}>
                <span className={styles.inputField}>Type a message…</span>
                <span className={styles.send}>
                  <svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                </span>
              </div>
            </div>
          </div>
          <span className={`${shared.tag} ${styles.tag1} ${shared.tagGold}`}>
            <svg viewBox="0 0 24 24"><path d="M12 8v4l3 3M12 2a10 10 0 100 20 10 10 0 000-20z" /></svg>
            Answers 24/7
          </span>
          <span className={`${shared.tag} ${styles.tag2} ${shared.tagCream}`}>
            <svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.77z" /></svg>
            Calls your APIs
          </span>
          <span className={`${shared.tag} ${styles.tag3} ${shared.tagDark}`}>
            <svg viewBox="0 0 24 24"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" /></svg>
            Embed in one line
          </span>
          <span className={styles.bBolt}><svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg></span>
        </div>
      </div>
      <div className={shared.caseContent}>
        <span className={shared.caseBadge}>UI preview</span>
        <h2>AI customer support agent</h2>
        <p>Drop a chat assistant into your site that answers from your own docs, looks up orders, and hands off to a human when it should.</p>
        <div className={shared.chat}>
          <span className={shared.bubbleU}>Where's my order #48213?</span>
          <span className={shared.bubbleU}>Can I return this after 30 days?</span>
          <span className={shared.bubbleU}>Talk to a real person, please.</span>
        </div>
        <div className={shared.caseTryRow}>
          <Link to="/support" className={`${shared.btn} ${shared.btnPrimary} ${shared.caseTryBtn}`}>
            Try it live →
          </Link>
        </div>
      </div>
    </div>
  )
}
