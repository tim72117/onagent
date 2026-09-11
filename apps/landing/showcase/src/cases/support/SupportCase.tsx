import { Link } from 'react-router-dom'

// AI customer support agent — the second showcase case's list-page card.
// A phone mockup (not the browser-window collage the marketing case uses)
// since a support widget's natural home is a mobile chat thread; the two
// cases read as a matched pair (one portrait, one landscape) rather than
// duplicates. Styling in support.css, prefixed ".pc-*" ("phone card") —
// deliberately distinct from SupportDemo.tsx's ".cs-*" ("chat shell")
// classes even though both render a support conversation, so editing one
// can never accidentally restyle the other.
//
// .pc-msg's animation-delay (see support.css) staggers each bubble/tool
// card/typing-indicator into view in conversation order, on a loop — a
// static "here's a finished chat log" read as inert; this reads as "the
// conversation is happening" without needing any real interactivity.
export function SupportCase() {
  return (
    <div className="case-split">
      <div className="case-illustration">
        <div className="collage pc-collage" aria-hidden="true">
          <div className="pc-phone">
            <div className="pc-notch" />
            <div className="pc-screen">
              <div className="pc-header">
                <span className="pc-avatar">
                  <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
                </span>
                <div>
                  <div className="pc-header-name">Support</div>
                  <div className="pc-header-status"><span className="pc-dot" />Online</div>
                </div>
              </div>
              <div className="pc-thread">
                <span className="pc-msg pc-from-user" style={{ animationDelay: '0.2s' }}>Where's my order #48213?</span>
                <div className="pc-tool" style={{ animationDelay: '1.1s' }}>
                  <span>⚙ lookup_order(id: "48213")</span>
                  <span className="pc-tool-result">→ status: in_transit</span>
                </div>
                <span className="pc-msg pc-from-ai" style={{ animationDelay: '2.0s' }}>It shipped yesterday and is out for delivery — expected today by 6pm.</span>
                <span className="pc-msg pc-from-user" style={{ animationDelay: '2.9s' }}>Can I change the address?</span>
                <span className="pc-msg pc-from-ai pc-typing" style={{ animationDelay: '3.8s' }}>
                  <span className="pc-dot-1" /><span className="pc-dot-2" /><span className="pc-dot-3" />
                </span>
              </div>
              <div className="pc-input">
                <span className="pc-input-field">Type a message…</span>
                <span className="pc-send">
                  <svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                </span>
              </div>
            </div>
          </div>
          <span className="tag tag-1 tag-gold">
            <svg viewBox="0 0 24 24"><path d="M12 8v4l3 3M12 2a10 10 0 100 20 10 10 0 000-20z" /></svg>
            Answers 24/7
          </span>
          <span className="tag tag-2 tag-cream">
            <svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.77z" /></svg>
            Calls your APIs
          </span>
          <span className="tag tag-3 tag-dark">
            <svg viewBox="0 0 24 24"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" /></svg>
            Embed in one line
          </span>
          <span className="bubble b-bolt"><svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg></span>
        </div>
      </div>
      <div className="case-content">
        <span className="case-badge">UI preview</span>
        <h2>AI customer support agent</h2>
        <p>Drop a chat assistant into your site that answers from your own docs, looks up orders, and hands off to a human when it should.</p>
        <div className="chat">
          <span className="bubble-u">Where's my order #48213?</span>
          <span className="bubble-u">Can I return this after 30 days?</span>
          <span className="bubble-u">Talk to a real person, please.</span>
        </div>
        <div className="case-try-row">
          <Link to="/support" className="btn btn-primary case-try-btn">
            Try it live →
          </Link>
        </div>
      </div>
    </div>
  )
}
