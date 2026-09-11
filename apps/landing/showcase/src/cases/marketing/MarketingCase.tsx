import { Link } from 'react-router-dom'

// Marketing analytics assistant — the first showcase case's list-page
// card. Styling in marketing.css (the ".collage"/".win-*"/".float-*"
// browser-window mockup) plus base.css's shared ".case-*"/".chat"/
// ".bubble-u" rules every case's card uses — see homepage index.html's
// #cases section, which this mirrors.
export function MarketingCase() {
  return (
    <div className="case-split">
      <div className="case-illustration">
        <div className="collage" aria-hidden="true">
          <div className="win">
            <div className="win-bar">
              <span className="win-dot" /><span className="win-dot" /><span className="win-dot" />
              <span className="win-search" />
            </div>
            <div className="win-body">
              <div className="win-side">
                <i className="on" /><i /><i /><i /><i />
              </div>
              <div className="win-main">
                <div className="win-kpis">
                  <div className="kpi"><div className="kpi-label" /><div className="kpi-value">$18.2k</div></div>
                  <div className="kpi"><div className="kpi-label" /><div className="kpi-value">2.4×</div></div>
                </div>
                <div className="win-chart">
                  <svg viewBox="0 0 200 46" preserveAspectRatio="none">
                    <polygon points="0,40 25,30 50,34 75,18 100,24 125,10 150,16 175,6 200,12 200,46 0,46" fill="#f0dfae" />
                    <polyline points="0,40 25,30 50,34 75,18 100,24 125,10 150,16 175,6 200,12" fill="none" stroke="#c9a24b" strokeWidth="2" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
          <div className="float-chart">
            <div className="float-chart-title">Revenue by channel</div>
            <div className="float-bars">
              <div className="b dark" style={{ height: '60%' }} />
              <div className="b light" style={{ height: '40%' }} />
              <div className="b dark" style={{ height: '85%' }} />
              <div className="b light" style={{ height: '30%' }} />
            </div>
            <div className="float-labels"><span>FB</span><span>IG</span><span>Google</span><span>Email</span></div>
          </div>
          <span className="bubble b-plus"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></span>
          <span className="bubble b-chat"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg></span>
          <span className="bubble b-ring" />
          <span className="bubble b-mini"><svg viewBox="0 0 24 24"><path d="M4 19V9M12 19V5M20 19v-7" /></svg></span>
        </div>
      </div>
      <div className="case-content">
        <span className="case-badge">Live integration</span>
        <h2>Marketing analytics assistant</h2>
        <p>Describe what you want to know about your campaign data, and AI picks the right variables and analysis method.</p>
        <div className="chat">
          <span className="bubble-u">Is there a relationship between ad spend, clicks, and revenue?</span>
          <span className="bubble-u">Which channel has the best revenue this quarter?</span>
          <span className="bubble-u">How has click-through rate trended over the last few months?</span>
        </div>
        <div className="case-try-row">
          <Link to="/marketing" className="btn btn-primary case-try-btn">
            Try it live →
          </Link>
        </div>
      </div>
    </div>
  )
}
