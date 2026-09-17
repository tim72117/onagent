import { Link } from 'react-router-dom'
import shared from '../../Shared.module.css'
import { type Lang } from '../../lang'
import styles from './SupportCase.module.css'

// This card's own copy — including the phone mockup's scripted thread,
// which is decorative but still reads as English text to a Chinese
// visitor if left untranslated. The tool-call line stays verbatim: it's
// code, not prose.
const STRINGS: Record<Lang, {
  badge: string
  title: string
  body: string
  examples: string[]
  cta: string
  headerName: string
  headerStatus: string
  threadUser1: string
  threadResult: string
  threadAi: string
  threadUser2: string
  inputPlaceholder: string
  tag1: string
  tag2: string
  tag3: string
}> = {
  en: {
    badge: 'UI preview',
    title: 'AI customer support agent',
    body: 'Drop a chat assistant into your site that checks real-time availability, books appointments, and hands off to a human when it should.',
    examples: [
      'Is Amy free on Tuesday?',
      'What appointments do I have?',
      'Talk to a real person, please.',
    ],
    cta: 'Try it live →',
    headerName: 'Support',
    headerStatus: 'Online',
    threadUser1: 'Is Amy free on Tuesday?',
    threadResult: '→ Tue, 2pm: available',
    threadAi: 'Yes — Tue, 2pm is open with Amy. Want me to book it?',
    threadUser2: 'Yes please!',
    inputPlaceholder: 'Type a message…',
    tag1: 'Answers 24/7',
    tag2: 'Calls your APIs',
    tag3: 'Embed in one line',
  },
  zh: {
    badge: '介面預覽',
    title: 'AI 客服助理',
    body: '在你的網站放進一個聊天助理，它能即時查詢空檔、完成預約，並在該轉接時交給真人。',
    examples: [
      'Amy 星期二有空嗎？',
      '我有哪些預約？',
      '我想跟真人說話。',
    ],
    cta: '體驗看看 →',
    headerName: '客服',
    headerStatus: '線上',
    threadUser1: 'Amy 星期二有空嗎？',
    threadResult: '→ 週二 14:00：有空',
    threadAi: '有的——週二下午 2 點 Amy 有空。要幫你預約嗎？',
    threadUser2: '好，麻煩你！',
    inputPlaceholder: '輸入訊息…',
    tag1: '全天候回覆',
    tag2: '呼叫你的 API',
    tag3: '一行就能嵌入',
  },
}

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
export function SupportCase({ lang }: { lang: Lang }) {
  const t = STRINGS[lang]
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
                  <div className={styles.headerName}>{t.headerName}</div>
                  <div className={styles.headerStatus}><span className={styles.dot} />{t.headerStatus}</div>
                </div>
              </div>
              <div className={styles.thread}>
                <span className={`${styles.msg} ${styles.fromUser}`} style={{ animationDelay: '0.2s' }}>{t.threadUser1}</span>
                <div className={styles.tool} style={{ animationDelay: '1.1s' }}>
                  {/* The call itself is code — stays verbatim in both
                      languages; only its result line is prose. */}
                  <span>⚙ check_availability(stylist: "Amy")</span>
                  <span className={styles.toolResult}>{t.threadResult}</span>
                </div>
                <span className={`${styles.msg} ${styles.fromAi}`} style={{ animationDelay: '2.0s' }}>{t.threadAi}</span>
                <span className={`${styles.msg} ${styles.fromUser}`} style={{ animationDelay: '2.9s' }}>{t.threadUser2}</span>
                <span className={`${styles.msg} ${styles.fromAi} ${styles.typing}`} style={{ animationDelay: '3.8s' }}>
                  <span className={styles.dot1} /><span className={styles.dot2} /><span className={styles.dot3} />
                </span>
              </div>
              <div className={styles.input}>
                <span className={styles.inputField}>{t.inputPlaceholder}</span>
                <span className={styles.send}>
                  <svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                </span>
              </div>
            </div>
          </div>
          <span className={`${shared.tag} ${styles.tag1} ${shared.tagGold}`}>
            <svg viewBox="0 0 24 24"><path d="M12 8v4l3 3M12 2a10 10 0 100 20 10 10 0 000-20z" /></svg>
            {t.tag1}
          </span>
          <span className={`${shared.tag} ${styles.tag2} ${shared.tagCream}`}>
            <svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.77z" /></svg>
            {t.tag2}
          </span>
          <span className={`${shared.tag} ${styles.tag3} ${shared.tagDark}`}>
            <svg viewBox="0 0 24 24"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" /></svg>
            {t.tag3}
          </span>
          <span className={styles.bBolt}><svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg></span>
        </div>
      </div>
      <div className={shared.caseContent}>
        <span className={shared.caseBadge}>{t.badge}</span>
        <h2>{t.title}</h2>
        <p>{t.body}</p>
        <div className={shared.chat}>
          {t.examples.map((q) => (
            <span key={q} className={shared.bubbleU}>{q}</span>
          ))}
        </div>
        <div className={shared.caseTryRow}>
          {/* ?lang= has to ride along: SupportDemo reads it at module
              scope to pick its own opening greeting's language. */}
          <Link
            to={lang === 'zh' ? '/support?lang=zh' : '/support'}
            className={`${shared.btn} ${shared.btnPrimary} ${shared.caseTryBtn}`}
          >
            {t.cta}
          </Link>
        </div>
      </div>
    </div>
  )
}
