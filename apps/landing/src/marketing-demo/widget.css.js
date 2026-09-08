// The marketing-demo widget's own styles, injected into a <style> tag inside
// the Shadow DOM that mountMarketingDemo attaches to its host element (see
// widget.js). Moved here (out of index.html/zh-tw/index.html's global
// <style> blocks) so these rules are genuinely scoped — they can no longer
// leak onto the host page, and the host page's own styles can no longer
// bleed into the widget, instead of relying purely on the md-demo-/md-sheet-/
// t- naming convention to avoid collisions.
//
// NOT included here — these stay in each page's own global <style>, since
// they belong to markup index.html/zh-tw/index.html write directly (the
// modal shell), not to anything widget.js renders:
//   .md-modal-backdrop, .md-modal-panel, .md-modal-bar, .md-modal-title,
//   .md-modal-bar-actions, .md-modal-code-btn, .md-modal-close, .md-modal-body
//   body.md-modal-open (the iOS Safari scroll-lock fix — a global body rule,
//     toggled by index.html's own openDemo/closeDemo, nothing to do with the
//     widget's internal DOM)
// See widget.js's own header comment on mountMarketingDemo for why the modal
// shell itself was left out of this Shadow DOM pass.
//
// CSS custom properties (--sans, --mono, --accent, --ok, etc.) referenced
// below are defined on the host page's :root — custom properties are
// inherited through the Shadow DOM boundary by spec (unlike normal style
// rules), so they keep resolving correctly here with no extra work. The vast
// majority of this widget's own palette is hardcoded literal values (see the
// comment index.html carried on this block: it deliberately mirrors
// apps/console's light-mode tokens verbatim rather than sharing custom
// properties across separate bundles) — only a handful of rules reach for
// the page's --sans/--mono/--accent/--ok tokens, called out inline below.
export const WIDGET_STYLES = `
  /* Resets inherited CSS properties the host page might otherwise leak in
     (font, color, line-height, etc. all inherit through the shadow
     boundary by default — "all" does not, custom properties aside — so
     without this a page-level font-family/color override on an ancestor
     of the shadow host would still visibly reach in). "revert" (not
     "initial") for display specifically: the host page's own
     ".md-modal-body { display: flex }" rule needs #marketing-demo-inner
     (the shadow host, in the light DOM) to still behave as a flex item —
     "all: initial" would reset display too and break that layout, since
     the shadow host's own box model is still governed from outside the
     shadow tree by the host page's stylesheet. */
  :host {
    all: initial;
    display: revert;
    box-sizing: border-box;
    /* all: initial resets EVERY inheritable property to its initial value
       — including pointer-events, whose initial value is auto. That
       silently broke the host page's own click-through mechanism: when
       the demo modal closes, .md-modal-backdrop sets pointer-events: none
       so clicks pass through to whatever's behind it (e.g. re-clicking
       "Try the Demo" to reopen) — that none was meant to inherit all the
       way down through .md-modal-panel/.md-modal-body to this shadow
       host, but "all: initial" reset it back to auto right here, making
       this host (and thus the still-mounted widget behind the invisible
       backdrop) eat clicks meant for the page underneath. inherit
       restores the normal chain instead of hardcoding a value here. */
    pointer-events: inherit;
  }
  /* .md-demo-shadow-root is the plain wrapper div mountMarketingDemo creates
     inside the shadow tree (see widget.js) — everything else this widget
     renders (.md-demo and its descendants) lives inside it. It just needs
     to pass through the full size the host element receives from the host
     page's ".md-modal-body { flex: 1 }" layout. */
  :host, .md-demo-shadow-root, .md-demo {
    width: 100%; height: 100%; min-height: 0; flex: 1;
  }
  .md-demo-shadow-root { display: flex; }
  * { box-sizing: border-box; }
  /* The host page's own global reset (index.html/zh-tw/index.html's plain
     p and a element rules) no longer reaches inside this Shadow DOM.
     widget.js's markup is full of bare p.md-demo-* and a.btn elements that
     were built assuming that reset was already in place — none of their
     own classes re-declare margin/color/text-decoration — so it has to be
     reproduced here, or every paragraph in the widget gets the browser's
     default ~1em top/bottom margin and links go blue-and-underlined. */
  p { margin: 0; }
  a { color: inherit; text-decoration: none; }

  /* Syntax highlighting classes for the Code tab (see highlightYaml/
     highlightJs below) — emitted directly as innerHTML spans, so they're
     plain t-key/t-str/etc. names, not scoped under .md-demo-*. Formerly
     lived in the host page's global stylesheet (shared, in principle, with
     any other .t-* consumer on the page) — grep across both index.html files
     found no other markup using these classes, so nothing outside this
     widget actually depended on them being global; they move here in full. */
  pre { margin: 0; font-family: var(--mono); font-size: 13.5px; line-height: 1.75; white-space: pre; tab-size: 2; }
  .t-key { color: #cbb98f; }
  .t-str { color: #a8c98a; }
  .t-com { color: var(--text-3); font-style: italic; }
  .t-fn { color: var(--accent-2); }
  .t-kw { color: #d9a463; }
  .t-punc { color: var(--text-2); }

  /* Three columns: a narrow view-switcher on the left, the active view's
     content in the middle (scrolls independently), conversation sidebar
     on the right — the chat log needs to stay visible as its own column
     rather than sharing scroll with the results area, since a long
     analysis result would otherwise push the conversation out of view. */
  .md-demo {
    font-family: var(--sans); color: #1c1917;
    display: flex; flex: 1; min-height: 0;
    width: 100%; height: 100%;
  }
  .md-demo-nav {
    flex: none; width: 168px; display: flex; flex-direction: column; gap: 2px;
    padding: 16px 10px; border-right: 1px solid #e4e0da; background: #f1efec;
  }
  .md-demo-nav-btn {
    text-align: left; padding: 9px 12px; border-radius: 4px; border: none;
    background: transparent; color: #6b6560; font-family: var(--sans); font-size: 13.5px;
    font-weight: 600; cursor: pointer; transition: background 0.15s, color 0.15s;
    display: flex; align-items: center; gap: 9px;
  }
  .md-demo-nav-btn svg { width: 16px; height: 16px; stroke: currentColor; stroke-width: 1.8; fill: none; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  .md-demo-nav-btn:hover { background: #e4e0da; color: #1c1917; }
  .md-demo-nav-btn.is-active { background: #c1622b; color: #ffffff; }
  /* .md-demo-main-slide is a plain pass-through wrapper on desktop (no
     positioning of its own there — see its mobile-only rule further down
     for why it exists at all) — it just needs to be the flex item
     .md-demo-main used to be, with .md-demo-main filling 100% of it. */
  .md-demo-main-slide { flex: 1; min-width: 0; display: flex; }
  /* display: flex (not the old plain block) so #md-demo-view-data below can
     size itself against a real, bounded cross-axis height via height: 100%
     — a block .md-demo-main only gives its children their natural content
     height to grow into, which is exactly what let the Data view's own
     scroll chain (.md-demo-subtab-body → .md-demo-data-scroll) size itself
     to fit the WHOLE table with no overflow at all: .md-demo-data-scroll's
     flex: 1/min-height: 0 need a finite parent height to flex against, and
     a plain block parent never gives them one, so they just grow to
     content size instead of being capped. The practical effect (found by
     actually reproducing the desktop Data tab and scrolling — this is not
     a transform/Shadow-DOM/border-collapse issue) was that the *entire*
     Data view (tab strip + table, easily taller than .md-demo-main's
     visible box) became the thing .md-demo-main's own overflow-y: auto
     scrolled as one unit, so .md-sheet thead th's position: sticky never
     got a chance to matter — its actual scrolling ancestor was
     .md-demo-main, not the intended .md-demo-data-scroll, well before the
     table's own content was even tall enough to overflow
     .md-demo-data-scroll on typical viewports. overflow-y: auto stays here
     so Analysis/Code (plain block content, no internal scroll region of
     their own) keep scrolling the same way they always did. */
  .md-demo-main { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
  /* Analysis/Code have no internal scroll region of their own — flex: none
     keeps them sized to their natural content height (same as before this
     file made .md-demo-main a flex container) rather than stretching to
     fill .md-demo-main's box the way Data's flex: 1 (declared further down,
     next to the comment explaining why it's needed) does. */
  .md-demo-view#md-demo-view-analysis, .md-demo-view#md-demo-view-code { flex: none; }
  .md-demo-view { padding: 24px; box-sizing: border-box; }
  /* Code view keeps the same inset/padded card positioning as the Data
     view's tab+pane card (not edge-to-edge — that read as visually
     inconsistent with Data's tabs sitting in the same nav position), but
     fills its own padding zone with a dark surface instead of the
     light .md-demo-view default, so the editor card doesn't look like a
     dark island dropped on a light background. :not([hidden]) matters:
     an ID selector otherwise outranks the browser's own
     [hidden] { display: none } (attribute selector, lower specificity),
     so an unconditional rule here would force this view visible even
     while its "hidden" attribute is set. */
  .md-demo-view#md-demo-view-code:not([hidden]) {
    background: #0d0b07;
    min-height: 100%;
  }
  .md-demo-chart { margin-top: 10px; overflow-x: auto; }
  .md-demo-chart canvas { display: block; }
  /* Skeleton pulse shown in the result pane from the moment a prompt is
     sent until select_analysis actually renders a real result. */
  .md-demo-result-loading { display: flex; flex-direction: column; gap: 10px; }
  .md-demo-skel { border-radius: 4px; background: #e4e0da; animation: mdSkelPulse 1.4s ease-in-out infinite; }
  .md-demo-skel-title { width: 45%; height: 12px; }
  .md-demo-skel-row { width: 100%; height: 34px; }
  @keyframes mdSkelPulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    .md-demo-skel { animation: none; opacity: 0.7; }
  }
  .md-demo-subtabs { display: flex; background: #f1efec; border: 1px solid #e4e0da; border-radius: 6px 6px 0 0; overflow: hidden; }
  .md-demo-subtab {
    display: flex; align-items: center; gap: 7px; padding: 9px 16px;
    font-family: var(--sans); font-size: 13.5px; font-weight: 600; color: #6b6560;
    background: transparent; border: none; border-right: 1px solid #e4e0da; cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }
  .md-demo-subtab-dot { width: 7px; height: 7px; border-radius: 50%; background: #d2ccc3; flex: none; }
  .md-demo-subtab.is-active { background: #fff; color: #1c1917; }
  .md-demo-subtab.is-active .md-demo-subtab-dot { background: #c1622b; }
  .md-demo-subtab:hover:not(.is-active) { color: #1c1917; }
  /* min-height: 0 is required for the flex chain below (.md-demo-view →
     .md-demo-subtab-body → .md-demo-data-scroll) to actually cap its
     height and hand off scrolling to .md-demo-data-scroll's own
     overflow: auto — without it, this flex item defaults to
     min-height: auto (i.e. its content's natural height), which grows to
     fit the ENTIRE table instead of stopping at .md-demo-main's own
     scroll boundary. The visible symptom was the whole tab strip+table
     scrolling as one block inside .md-demo-main (the outer sheet), with
     the sticky thead never getting a bounded scroll container to stick
     within. */
  .md-demo-view#md-demo-view-data:not([hidden]) { display: flex; flex-direction: column; min-height: 0; }
  /* flex: 1 (both desktop and mobile — see .md-demo-main's own comment
     further up for the desktop half of this fix) so this actually claims
     the bounded height its flex parent now gives itself — without it, this
     stays a plain block sized to its content inside a flex parent, which
     is the same "min-height: auto grows to fit everything" trap
     min-height: 0 alone doesn't solve on its own; the two need each other
     here. Previously scoped under .is-mobile only, which happened to work
     on mobile (where .md-demo-main-slide:has(...) forces a fixed height
     regardless) but left desktop's .md-demo-main a plain non-flex block
     with no bounded height to hand down at all — see that rule's comment
     for the actual repro. */
  .md-demo-view#md-demo-view-data:not([hidden]) { flex: 1; }
  /* min-width: 0 overrides the flex item default of min-width: auto —
     without it, a flex child never shrinks below its content's natural
     width no matter how narrow the flex container is, which is exactly
     why the Variables table (inside .md-demo-subtab-body, inside this
     flex column) could push wider than its container instead of being
     clipped/scrolled by overflow-x on the body below. */
  .md-demo-view#md-demo-view-data .md-demo-subtab-body { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .md-demo-subtab-body {
    border: 1px solid #e4e0da; border-top: none; border-radius: 0 0 6px 6px; padding: 20px;
    box-sizing: border-box;
    /* .md-demo-table (Variables pane's table, among others reusing this
       class elsewhere) has no table-layout: fixed, so its columns size to
       their own content's natural width — width: 100% only sets a floor,
       not a ceiling. On a narrow mobile sheet the "Type" column's
       "Category"/"Continuous" text is enough to push the table wider than
       this container, which clipped instead of scrolling before this
       rule. overflow-x: auto lets it scroll horizontally rather than
       being cut off; not adding table-layout: fixed here since that would
       need per-column width tuning across every table shape this class
       renders (frequency counts, regression coefficients, etc.), not just
       this one. */
    overflow-x: auto;
  }
  .md-demo-data-scroll {
    overflow: auto; flex: 1; min-height: 0; max-width: calc(100% - 20px); margin-right: 20px;
    box-sizing: border-box; border: 1px solid #e4e0da; border-radius: 6px;
  }
  .md-demo-data-scroll table { margin: 0; }
  .md-sheet-gutter { width: 28px !important; border: none !important; padding: 0 !important; }
  .md-demo-data-scroll thead th { position: sticky; top: 0; background: #f1efec; }
  /* border-collapse: collapse is a well-known trap for position: sticky
     on <thead>/<th> — WebKit (and some other engines) simply doesn't
     stick a collapsed-border table's header cells, no matter how correct
     the sticky/top/z-index setup otherwise is. separate + border-spacing:
     0 keeps cells visually flush (no gaps) while letting sticky actually
     work; each cell now draws its own full border instead of sharing one
     with its neighbor, so border-right/border-bottom only (not a full
     border) avoids doubled-up lines between adjacent cells. */
  .md-sheet { border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: 12.5px; font-family: var(--mono); }
  .md-sheet th, .md-sheet td {
    border-right: 1px solid #d2ccc3; border-bottom: 1px solid #d2ccc3; padding: 5px 10px; width: 92px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .md-sheet tr th:first-child, .md-sheet tr td:first-child { border-left: 1px solid #d2ccc3; }
  .md-sheet thead tr:first-child th { border-top: 1px solid #d2ccc3; }
  .md-sheet thead th { position: sticky; top: 0; background: #e4e0da; color: #1c1917; font-weight: 700; z-index: 1; }
  .md-sheet thead tr:first-child th { color: #6b6560; font-weight: 400; font-size: 11px; }
  .md-sheet .md-sheet-rownum {
    position: sticky; left: 0; width: 34px; text-align: center;
    background: #e4e0da; color: #6b6560; font-weight: 400; z-index: 2;
  }
  .md-sheet thead .md-sheet-rownum { z-index: 3; }
  .md-sheet tbody tr:nth-child(even) td:not(.md-sheet-rownum) { background: #faf9f7; }
  .md-sheet tbody tr:nth-child(odd) td:not(.md-sheet-rownum) { background: #fff; }
  .md-demo-code-tabs { display: flex; background: #100d08; border-radius: 6px 6px 0 0; overflow: hidden; }
  .md-demo-code-tab {
    display: flex; align-items: center; gap: 7px; padding: 9px 16px;
    font-family: var(--mono); font-size: 12.5px; color: #8c8468;
    background: transparent; border: none; border-right: 1px solid #100d08; cursor: pointer;
  }
  .md-demo-code-tab-dot { width: 7px; height: 7px; border-radius: 50%; background: #4a4536; }
  .md-demo-code-tab.is-active { background: #16130c; color: #f0ead9; }
  .md-demo-code-tab.is-active .md-demo-code-tab-dot { background: #e08544; }
  .md-demo-code-tab:hover:not(.is-active) { color: #c9bfa0; }
  .md-demo-code-body {
    margin: 0; background: #16130c; color: #f0ead9; padding: 16px; border-radius: 0 0 6px 6px;
    font-family: var(--mono); font-size: 12.5px; line-height: 1.65; overflow-x: auto; white-space: pre;
  }
  /* :not([hidden]) matters here: an unqualified "display: flex" on a
     plain class rule still overrides the browser's [hidden] { display:
     none } (author stylesheet beats the UA stylesheet at this
     specificity), which is exactly why toggling chatEl.hidden in
     widget.js had no visible effect until this was added. */
  .md-demo-chat:not([hidden]) {
    flex: none; width: 340px; display: flex; flex-direction: column; min-height: 0;
    border-left: 1px solid #e4e0da; background: #f1efec;
  }
  .md-demo-chat-log { flex: 1; min-height: 0; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
  .md-demo-chat-hint { font-size: 13px; color: #6b6560; line-height: 1.6; }
  .md-demo-chat-msg { font-size: 13.5px; line-height: 1.55; padding: 9px 12px; border-radius: 6px; max-width: 92%; }
  .md-demo-chat-msg-user {
    align-self: flex-end; background: #c1622b; color: #ffffff; font-weight: 600;
    border-radius: 6px 6px 2px 6px;
  }
  .md-demo-chat-msg-assistant {
    align-self: flex-start; background: #fff; border: 1px solid #e4e0da; color: #1c1917;
    border-radius: 6px 6px 6px 2px;
  }
  .md-demo-chat-msg-error {
    align-self: flex-start; background: #fdf1ee; border: 1px solid #f0c4b8; color: #8a3b26;
    border-radius: 6px 6px 6px 2px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
  }
  .md-demo-chat-msg-error-retry {
    padding: 5px 12px; border-radius: 4px; border: 1px solid #c1622b;
    background: transparent; color: #c1622b; font-size: 12px; font-weight: 700; cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .md-demo-chat-msg-error-retry:hover { background: #c1622b; color: #fff; }
  .md-demo-result-card {
    align-self: stretch; display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 10px 12px; border: 1px dashed #d2ccc3; border-radius: 6px; background: #faf9f7;
  }
  .md-demo-result-card-label { font-size: 12.5px; color: #6b6560; font-weight: 600; }
  .md-demo-result-card-btn {
    flex: none; padding: 5px 12px; border-radius: 4px; border: 1px solid #c1622b;
    background: transparent; color: #c1622b; font-size: 12px; font-weight: 700; cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .md-demo-result-card-btn:hover { background: #c1622b; color: #fff; }
  .md-demo-chat-msg-thinking { display: flex; gap: 8px; padding: 12px 14px; align-items: center; }
  .md-demo-chat-msg-thinking-dots { display: flex; gap: 4px; align-items: center; }
  .md-demo-chat-msg-thinking-dots span {
    width: 6px; height: 6px; border-radius: 50%; background: #a39d96;
    animation: mdThinkBounce 1.1s ease-in-out infinite;
  }
  .md-demo-chat-msg-thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
  .md-demo-chat-msg-thinking-dots span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes mdThinkBounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
    30% { transform: translateY(-4px); opacity: 1; }
  }
  .md-demo-chat-msg-thinking-label {
    font-size: 13px; font-weight: 600; color: #6b6560;
    display: inline-flex; align-items: center;
  }
  .md-demo-chat-msg-thinking-label span {
    opacity: 0; animation: mdEllipsisDot 1.2s steps(1, end) infinite;
  }
  .md-demo-chat-msg-thinking-label span:nth-child(1) { animation-delay: 0s; }
  .md-demo-chat-msg-thinking-label span:nth-child(2) { animation-delay: 0.3s; }
  .md-demo-chat-msg-thinking-label span:nth-child(3) { animation-delay: 0.6s; }
  @media (prefers-reduced-motion: reduce) {
    .md-demo-chat-msg-thinking-dots span { animation: none; opacity: 0.8; }
    .md-demo-chat-msg-thinking-label span { animation: none; opacity: 1; }
  }
  .md-demo-chat-msg-analyzing { display: flex; align-items: center; gap: 10px; padding: 12px 14px; }
  .md-demo-eq { display: flex; align-items: flex-end; gap: 3px; height: 16px; }
  .md-demo-eq span {
    width: 3px; border-radius: 2px; background: #c1622b;
    animation: mdEqBounce 0.9s ease-in-out infinite;
  }
  .md-demo-eq span:nth-child(1) { animation-delay: 0s; }
  .md-demo-eq span:nth-child(2) { animation-delay: 0.15s; }
  .md-demo-eq span:nth-child(3) { animation-delay: 0.3s; }
  .md-demo-eq span:nth-child(4) { animation-delay: 0.45s; }
  @keyframes mdEqBounce {
    0%, 100% { height: 4px; opacity: 0.55; }
    50% { height: 16px; opacity: 1; }
  }
  .md-demo-chat-msg-analyzing-label {
    font-size: 13px; font-weight: 600; color: #c1622b;
    display: inline-flex; align-items: center;
  }
  .md-demo-chat-msg-analyzing-label span {
    opacity: 0; animation: mdEllipsisDot 1.2s steps(1, end) infinite;
  }
  .md-demo-chat-msg-analyzing-label span:nth-child(1) { animation-delay: 0s; }
  .md-demo-chat-msg-analyzing-label span:nth-child(2) { animation-delay: 0.3s; }
  .md-demo-chat-msg-analyzing-label span:nth-child(3) { animation-delay: 0.6s; }
  @keyframes mdEllipsisDot {
    0%, 20% { opacity: 0; } 30%, 100% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .md-demo-eq span { animation: none; height: 10px; opacity: 0.8; }
    .md-demo-chat-msg-analyzing-label span { animation: none; opacity: 1; }
  }
  .md-demo-chat-msg-markdown > *:first-child { margin-top: 0; }
  .md-demo-chat-msg-markdown > *:last-child { margin-bottom: 0; }
  .md-demo-chat-msg-markdown p { margin: 0 0 8px; }
  .md-demo-chat-msg-markdown ul, .md-demo-chat-msg-markdown ol { margin: 0 0 8px; padding-left: 20px; }
  .md-demo-chat-msg-markdown li { margin-bottom: 3px; }
  .md-demo-chat-msg-markdown strong { color: #1c1917; }
  .md-demo-chat-msg-markdown code {
    font-family: var(--mono); font-size: 12px; background: #f6e6db;
    padding: 1px 5px; border-radius: 4px;
  }
  .md-demo-chat-msg-markdown pre {
    background: #1c1917; color: #efe9e1; padding: 10px 12px; border-radius: 6px;
    overflow-x: auto; margin: 0 0 8px;
  }
  .md-demo-chat-msg-markdown pre code { background: none; padding: 0; color: inherit; }
  .md-demo-chat-msg-markdown a { color: #c1622b; text-decoration: underline; }
  .md-demo-footer { flex: none; padding: 14px 16px; border-top: 1px solid #e4e0da; background: #faf9f7; }
  /* Belt-and-braces: the base "a { text-decoration: none }" rule further up
     this stylesheet already covers this, but .md-demo-cta (an <a> — see
     mountMarketingDemo's showUsageLimitReached) sets it explicitly too, so
     it doesn't depend on rule order if this block is ever reorganized. */
  .md-demo-cta {
    display: block; width: 100%; text-align: center; padding: 13px 16px;
    border-radius: 6px; background: #c1622b; color: #fff; font-weight: 700; font-size: 15px;
    text-decoration: none;
    box-shadow: 0 6px 18px -6px rgba(193, 98, 43, 0.55);
    transition: transform 0.15s ease, box-shadow 0.2s, background 0.15s;
  }
  .md-demo-cta:hover {
    background: #a8531f; transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(193, 98, 43, 0.65);
  }
  /* 168px nav + 340px chat = 508px reserved before .md-demo-main gets any
     space at all — below roughly 960px that leaves the middle column too
     narrow for its own tables. */
  @media (max-width: 960px) and (min-width: 721px) {
    .md-demo { flex-direction: column; }
    .md-demo-chat:not([hidden]) { width: auto; border-left: none; border-top: 1px solid #e4e0da; }
    .md-demo-nav { width: auto; flex-direction: row; border-right: none; border-bottom: 1px solid #e4e0da; }
    .md-demo-nav-btn { flex: 1; justify-content: center; }
  }
  /* Rough first-pass mobile layout — container positions only, not final
     polish. See widget.js's own #md-demo-nav comment for the phone-pattern
     rationale (chat becomes the fixed-bottom composer, content opens as an
     on-demand sheet). */
  .md-demo-nav-sheet-backdrop { display: none; }
  /* State-driven (.is-mobile, toggled in widget.js via matchMedia), not a
     bare @media block — see widget.js's own comment on syncMobileClass
     for why: a plain @media override only wins over a same-specificity
     base rule if it happens to be written LATER in this file, which is
     fragile and already broke once (silently) for .md-demo-input's
     font-size. ".is-mobile .md-demo-x" has strictly higher specificity
     than ".md-demo-x" alone, so these always win regardless of where
     they're written in the file. */
  .is-mobile .md-demo { position: relative; flex-direction: column; }
  .is-mobile .md-demo-nav { display: none; }
  .is-mobile .md-demo-nav-sheet-backdrop {
    display: block; position: absolute; inset: 0; z-index: 25; background: rgba(28,25,23,0.35);
    opacity: 0; pointer-events: none; transition: opacity 0.2s ease;
  }
  .is-mobile .md-demo-nav-sheet-backdrop.is-open { opacity: 1; pointer-events: auto; }
  .is-mobile .md-demo-chat:not([hidden]), .is-mobile .md-demo-chat[hidden] {
    display: flex; flex-direction: column; position: absolute; inset: 0;
    width: auto; z-index: 20; border: none; border-radius: 0;
  }
  .is-mobile .md-demo-chat-log { padding: 16px 20px; gap: 12px; }
  .is-mobile .md-demo-quick-tests { padding: 0; }
  .is-mobile .md-demo-footer { padding: 14px 20px calc(14px + env(safe-area-inset-bottom, 0px)); }
  /* .md-demo-main-slide owns the slide-in/out animation (position,
     transform, transition) — .md-demo-main itself (below) must stay free
     of transform, since a transformed ancestor becomes the new containing
     block for every descendant position: sticky/fixed element. That
     silently broke the Data view's sticky <thead>: it was sticking
     relative to this slide wrapper's own animated box instead of
     .md-demo-data-scroll's scroll container, since .md-demo-main used to
     carry the transform itself and sit between them in the ancestor
     chain. */
  .is-mobile .md-demo-main-slide {
    position: absolute; left: 0; right: 0; bottom: 0; top: auto;
    z-index: 30; max-height: 85%;
    transform: translateY(100%); transition: transform 0.3s cubic-bezier(0.32,0.72,0,1);
  }
  .is-mobile .md-demo-main-slide.is-sheet-open { transform: translateY(0); }
  .is-mobile .md-demo-main {
    height: 100%; overflow-y: auto;
    border-radius: 16px 16px 0 0;
    padding: 20px 20px calc(20px + env(safe-area-inset-bottom, 0px));
    box-shadow: 0 -12px 32px -12px rgba(0,0,0,0.35); background: #faf9f7;
    display: flex; flex-direction: column;
  }
  /* max-height alone (.md-demo-main-slide's base rule above) lets the
     sheet shrink-wrap to its content and hand ALL scrolling to
     .md-demo-main itself (overflow-y: auto there) — fine for
     Analysis/Code, whose content doesn't usually need its own internal
     scroll region, but wrong for the Data view's raw-data table: with
     only max-height, the flex chain below (.md-demo-view →
     .md-demo-subtab-body → .md-demo-data-scroll) never gets a bounded
     height to cap itself against, so .md-demo-data-scroll's own
     overflow: auto never actually engages — the whole sheet scrolls as
     one block instead of the table scrolling within a fixed-height frame
     with its thead pinned. height (not max-height) here forces the slide
     wrapper to actually BE 85% tall regardless of content, which is what
     lets the inner flex chain compute a real, finite height to hand off
     to .md-demo-data-scroll. Scoped narrowly (:has, not the base rule) so
     Analysis/Code aren't forced to this same fixed height when their
     content is short. */
  .is-mobile .md-demo-main-slide:has(#md-demo-view-data:not([hidden])) {
    height: 85%;
  }
  .is-mobile .md-demo-main-slide:has(#md-demo-view-data:not([hidden])) .md-demo-main {
    overflow-y: hidden;
  }
  /* .md-demo-view's own 24px padding (desktop's own breathing room, see
     its base rule) stacks on top of .md-demo-main's 20px above, wasting
     ~44px of an already-narrow mobile sheet's width and pushing table
     content further into overflow. .md-demo-main's padding alone is
     enough here. */
  .is-mobile .md-demo-view { padding: 0; }
  /* Data/Code's own tab strip (.md-demo-subtabs / .md-demo-code-tabs) now
     carries the close button as a real flex child (see renderDataView/
     renderCodeView in widget.js) instead of a separate button living
     above the tab strip in its own row — that row was pure vertical
     padding pushing the tab strip down from the sheet's top edge, when
     the point of zeroing .md-demo-view's padding above was to let the tab
     strip sit flush against it. Making the strip itself sticky (not the
     button alone) keeps the whole row — tabs AND close button — pinned
     together as .md-demo-main's content scrolls underneath, rather than
     the button needing its own absolute/float positioning relative to a
     different scroll ancestor than the tabs it's meant to share a row
     with. The Analysis view has no tab strip and isn't affected — it
     keeps whatever behavior it already had. */
  .is-mobile .md-demo-subtabs,
  .is-mobile .md-demo-code-tabs {
    position: sticky; top: 0; z-index: 1;
  }
  .is-mobile .md-demo-main-sheet-close {
    display: grid; place-items: center; margin-left: auto;
    width: 26px; height: 26px; border-radius: 50%; flex: none;
    border: 1px solid #e4e0da; background: #fff; color: #6b6560; cursor: pointer;
  }
  /* .md-demo-code-tabs is a dark surface (#100d08, see its base rule) —
     the light close button above reads fine on Data's light tab strip but
     needs its own dark-surface treatment here, same idea as
     .md-demo-quick-test-btn.btn-ghost overriding a light-surface button
     for a light card elsewhere in this file. */
  .is-mobile .md-demo-code-tabs .md-demo-main-sheet-close {
    border-color: #3a3325; background: #1c1811; color: #c9bfa0;
  }
  .md-demo-main-sheet-close { display: none; }
  .md-demo-scenario { border-bottom: 1px dashed #e6e1d3; padding-bottom: 14px; margin-bottom: 14px; }
  .md-demo-scenario-title { font-size: 12.5px; font-weight: 700; color: #8c8468; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; }
  .md-demo-scenario-text { font-size: 13.5px; line-height: 1.65; color: #4a4536; margin-bottom: 8px; }
  .md-demo-scenario-data { font-size: 12.5px; color: #8c8468; font-family: var(--mono); margin-bottom: 10px; }
  .md-demo-scenario-data-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px; border-radius: 6px; border: 1px solid #d2ccc3; background: #fff;
    color: #1c1917; font-family: var(--sans); font-size: 12.5px; font-weight: 600; cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .md-demo-scenario-data-btn:hover { background: #f3efe4; border-color: #c1622b; }
  .md-demo-scenario-data-btn svg { width: 15px; height: 15px; stroke: currentColor; stroke-width: 1.8; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .md-demo-quick-tests { margin-bottom: 14px; }
  .md-demo-quick-tests-label { font-size: 12.5px; color: #8c8468; margin-bottom: 8px; }
  .md-demo-quick-test-btns { display: flex; gap: 8px; flex-wrap: wrap; }
  /* .btn/.btn-ghost were previously the host page's own global button
     classes, reused here by widget.js's quick-test buttons and (via
     mountMarketingDemo's usage-limit CTA) .btn-primary. Now that the
     widget's DOM lives in a separate Shadow DOM, the host page's .btn rules
     no longer reach these elements at all, so the base .btn/.btn-primary/
     .btn-ghost rules are reproduced here in full — not just the
     .md-demo-quick-test-btn override that used to be layered on top of
     them. */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    font-family: var(--sans); font-weight: 600; font-size: 14.5px;
    padding: 11px 18px; border-radius: 10px; border: 1px solid transparent;
    cursor: pointer; transition: transform 0.15s ease, box-shadow 0.2s, background 0.2s, border-color 0.2s;
    white-space: nowrap; text-decoration: none;
  }
  .btn-primary { background: var(--grad); color: #1a1408; box-shadow: 0 10px 30px -10px rgba(201, 162, 75, 0.5); }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 16px 40px -12px rgba(201, 162, 75, 0.65); }
  .btn-ghost { background: rgba(255,255,255,0.03); border-color: var(--border); color: var(--text); }
  .btn-ghost:hover { border-color: #4a4128; background: rgba(255,255,255,0.05); transform: translateY(-1px); }
  /* Overrides .btn-ghost's dark-page treatment (near-invisible pale-on-pale
     otherwise) — this card is a light surface, so its buttons get their
     own light-surface styling instead of inheriting the dark theme's. */
  .md-demo-quick-test-btn.btn-ghost {
    padding: 7px 14px; font-size: 13px;
    background: #fff; border-color: #e6e1d3; color: #4a4536;
    /* .btn's base white-space: nowrap is fine for short button labels
       elsewhere, but these are full question sentences — long ones (esp.
       the English translations, which run longer than their Chinese
       counterparts) would otherwise overflow the button/container instead
       of wrapping within it. */
    white-space: normal; text-align: left;
  }
  .md-demo-quick-test-btn.btn-ghost:hover { background: #f3efe4; border-color: #d8d0ba; }
  .md-demo-result { min-height: 60px; margin-bottom: 12px; }
  .md-demo-placeholder { color: #8c8468; font-size: 13.5px; }
  .md-demo-result-title { font-size: 12.5px; font-weight: 700; color: #8c8468; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; }
  .md-demo-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .md-demo-table td { padding: 6px 10px; border-bottom: 1px solid #e6e1d3; }
  .md-demo-table td:last-child { text-align: right; font-family: var(--mono); color: var(--accent); font-weight: 700; }
  .md-demo-table-grid td:last-child { text-align: center; font-family: var(--mono); color: inherit; font-weight: 400; }
  .md-demo-table-grid th { padding: 6px 10px; font-size: 12px; color: #8c8468; text-align: center; border-bottom: 1px solid #e6e1d3; }
  .md-demo-table-grid td:first-child, .md-demo-table-grid th:first-child { text-align: left; font-weight: 700; color: #4a4536; }
  .md-demo-table-grid td { text-align: center; font-family: var(--mono); }
  .md-demo-assistant-note { font-size: 13.5px; color: #4a4536; margin-top: 8px; }
  .md-demo-input-row { display: flex; align-items: flex-end; gap: 10px; }
  .md-demo-input {
    flex: 1; border: 1px solid #e4e0da; border-radius: 6px; padding: 9px 12px;
    font-family: var(--sans); font-size: 14px; background: #fff; color: #1c1917;
    resize: none; max-height: 140px; overflow-y: hidden; line-height: 1.4;
  }
  .md-demo-input:focus { outline: 2px solid #c1622b; outline-offset: 1px; }
  .md-demo-send-btn {
    flex: none; width: 38px; height: 38px; border-radius: 50%; border: none;
    background: #c1622b; color: #fff; display: grid; place-items: center;
    cursor: pointer; transition: background 0.15s, transform 0.15s;
  }
  .md-demo-send-btn svg { width: 16px; height: 16px; stroke: currentColor; }
  .md-demo-send-btn:hover:not(:disabled) { background: #a8531f; transform: translateY(-1px); }
  .md-demo-send-btn:disabled { background: #d2ccc3; cursor: not-allowed; }
  .md-demo-status { margin-top: 8px; font-size: 12.5px; color: #6b6560; min-height: 1em; }

  /* .is-mobile (not a bare @media block) so this reliably beats
     .md-demo-input's own base rule (font-size: 14px, above) regardless of
     where either is written in this file — see widget.js's
     syncMobileClass comment and this same rule's history: a @media
     override previously placed earlier in the file than the base rule it
     was meant to override silently lost every time (14px always won on
     real devices) despite reading correctly at a glance. iOS Safari
     auto-zooms the page on focus for any input/textarea whose font-size
     is under 16px — the desktop 14px would otherwise make every tap into
     the composer jump-zoom the whole page in and back out on blur. 16px
     is the documented threshold, not an arbitrary round number. */
  .is-mobile .md-demo-input { font-size: 16px; }
`
