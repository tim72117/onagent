import { Link } from 'react-router-dom'
import shared from '../../Shared.module.css'
import styles from './MarketingCase.module.css'

// Marketing analytics assistant — the first showcase case's list-page
// card. shared holds the ".case-*"/".chat"/".bubble-u" shape every case's
// card uses; styles is this component's own browser-window collage —
// see homepage index.html's #cases section, which this mirrors.
export function MarketingCase() {
  return (
    <div className={shared.caseSplit}>
      <div className={shared.caseIllustration}>
        <div className={styles.collage} aria-hidden="true">
          <div className={styles.win}>
            <div className={styles.winBar}>
              <span className={styles.winDot} /><span className={styles.winDot} /><span className={styles.winDot} />
              <span className={styles.winSearch} />
            </div>
            <div className={styles.winBody}>
              <div className={styles.winSide}>
                <i className={styles.on} /><i /><i /><i /><i />
              </div>
              <div className={styles.winMain}>
                <div className={styles.winKpis}>
                  <div className={styles.kpi}><div className={styles.kpiLabel} /><div className={styles.kpiValue}>$18.2k</div></div>
                  <div className={styles.kpi}><div className={styles.kpiLabel} /><div className={styles.kpiValue}>2.4×</div></div>
                </div>
                <div className={styles.winChart}>
                  <svg viewBox="0 0 200 46" preserveAspectRatio="none">
                    <polygon points="0,40 25,30 50,34 75,18 100,24 125,10 150,16 175,6 200,12 200,46 0,46" fill="#f0dfae" />
                    <polyline points="0,40 25,30 50,34 75,18 100,24 125,10 150,16 175,6 200,12" fill="none" stroke="#c9a24b" strokeWidth="2" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
          <div className={styles.floatChart}>
            <div className={styles.floatChartTitle}>Revenue by channel</div>
            <div className={styles.floatBars}>
              <div className={`${styles.b} ${styles.dark}`} style={{ height: '60%' }} />
              <div className={`${styles.b} ${styles.light}`} style={{ height: '40%' }} />
              <div className={`${styles.b} ${styles.dark}`} style={{ height: '85%' }} />
              <div className={`${styles.b} ${styles.light}`} style={{ height: '30%' }} />
            </div>
            <div className={styles.floatLabels}><span>FB</span><span>IG</span><span>Google</span><span>Email</span></div>
          </div>
          <span className={`${styles.bubble} ${styles.bPlus}`}><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></span>
          <span className={`${styles.bubble} ${styles.bChat}`}><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg></span>
          <span className={`${styles.bubble} ${styles.bRing}`} />
          <span className={`${styles.bubble} ${styles.bMini}`}><svg viewBox="0 0 24 24"><path d="M4 19V9M12 19V5M20 19v-7" /></svg></span>
        </div>
      </div>
      <div className={shared.caseContent}>
        <span className={shared.caseBadge}>Live integration</span>
        <h2>Marketing analytics assistant</h2>
        <p>Describe what you want to know about your campaign data, and AI picks the right variables and analysis method.</p>
        <div className={shared.chat}>
          <span className={shared.bubbleU}>Is there a relationship between ad spend, clicks, and revenue?</span>
          <span className={shared.bubbleU}>Which channel has the best revenue this quarter?</span>
          <span className={shared.bubbleU}>How has click-through rate trended over the last few months?</span>
        </div>
        <div className={shared.caseTryRow}>
          <Link to="/marketing" className={`${shared.btn} ${shared.btnPrimary} ${shared.caseTryBtn}`}>
            Try it live →
          </Link>
        </div>
      </div>
    </div>
  )
}
