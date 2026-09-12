import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { AgentBridge, defineTool } from '@onagent/bridge'
import { marked } from 'marked'
import { usePageMeta } from '../../usePageMeta'
import styles from './SupportDemo.module.css'

// AI customer support agent — the "/support" demo shell. Unlike the old
// static mock this replaced, this is a real, working AgentBridge
// connection to support-app (see .env.example's VITE_SUPPORT_* vars) —
// a visitor can actually type a message and get a real LLM reply, and
// check_availability/get_my_appointments/book_appointment's tool calls
// are really dispatched back into this page, same mechanism a real
// developer's own site would use.
//
// The schedule these tools operate on is a hardcoded mock (INITIAL_WEEK
// below), not a real booking database — that's the honest boundary of
// what a public marketing demo can safely expose (see also
// src/marketing-demo/widget.js, which mocks its own data the same way)
// — but the AI's tool-calling decision, the WebSocket round trip, and
// the reply are all real.
//
// The chat panel is framed as a phone (.csPhoneDock), floating over the
// light .siteMock backdrop's bottom-right corner — the way a real
// embedded support widget expands from its launcher bubble — rather than
// a flat sidebar panel. This component's module (SupportDemo.module.css)
// is fully distinct from SupportCase.tsx's own (SupportCase.module.css)
// even though both render a support conversation.
//
// .siteMock is the salon's own weekly stylist schedule, and it's fully
// wired to the tool calls above: check_availability/get_my_appointments
// read the same `week` state this grid renders, and book_appointment's
// success actually flips a cell's booked/bookedBy fields (see `week`
// state and the onBookedRef celebration effect below) — a visitor can
// watch the AI's tool call really touch "their own" calendar.

const WS_URL = import.meta.env.VITE_SUPPORT_WS_URL ?? 'wss://onagent.shuttle.tools/ws'
const APP_ID = import.meta.env.VITE_SUPPORT_APP_ID ?? 'support-app'
const API_KEY = import.meta.env.VITE_SUPPORT_API_KEY

// The assistant's own reply text is Markdown (per support-app-tools.yaml's
// thought, which now explicitly invites lists/tables for multi-slot
// results) — same escape-then-parse pattern as
// src/marketing-demo/widget.js's own escapeHtml/marked.parse: marked has no
// sanitizer of its own, so escape first and let marked's rendering
// re-introduce only the HTML *it* generates from that already-escaped text.
// Safe against the assistant echoing user-supplied HTML/script back
// verbatim; doesn't need to defend against the LLM provider itself being
// compromised.
function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// Frontend-only per-browser usage cap, same mechanism and same limit as
// src/marketing-demo/widget.js's own MAX_PROMPTS_PER_BROWSER — independent
// of and in addition to the backend's own quota system (onQuotaExceeded
// below). This is what keeps a single visitor from running up real LLM
// inference cost against the shared demo key; it's a courtesy limit, not a
// security boundary (it lives in localStorage, so it's trivially reset by
// clearing site data — an accepted tradeoff for a public marketing demo).
const MAX_PROMPTS_PER_BROWSER = 10
const USAGE_STORAGE_KEY = 'onagent-support-demo-prompt-count'

function getPromptCount(): number {
  try {
    return Number(localStorage.getItem(USAGE_STORAGE_KEY)) || 0
  } catch {
    // Storage blocked (private browsing, disabled cookies, etc.) — fail
    // open rather than breaking the demo for those visitors.
    return 0
  }
}

function incrementPromptCount(): void {
  try {
    localStorage.setItem(USAGE_STORAGE_KEY, String(getPromptCount() + 1))
  } catch {
    // Nothing to do if storage is blocked — see getPromptCount.
  }
}

// Each stylist's color + a simple cartoon-avatar emoji, used on the week
// grid's checkmarks and the legend below (keys match STYLISTS[].name).
const STYLISTS = ['Amy', 'Jordan', 'Priya'] as const
const STYLIST_COLORS: Record<(typeof STYLISTS)[number], string> = {
  Amy: '#2f8a53',
  Jordan: '#3f7cc9',
  Priya: '#c9578f',
}
const STYLIST_AVATARS: Record<(typeof STYLISTS)[number], string> = {
  Amy: '👩‍🦰',
  Jordan: '👨‍🦱',
  Priya: '👩🏽‍🦱',
}

// Mock weekly schedule for siteMock's backdrop — a real calendar-app-style
// grid: TIME_ROWS is the shared time axis running down the far-left
// column, Mon-Sun run across the top as columns, and each (day, time)
// cell holds at most one stylist (single-chair-per-slot, matching a real
// salon's own booking grid — see this file's header comment on the
// eventual highlight wiring), either open or already booked.
const TIME_ROWS = ['10am', '11am', '1pm', '2pm', '3pm'] as const
interface DayCellData {
  stylist: (typeof STYLISTS)[number]
  booked: boolean
  // Who holds this slot once booked: true — undefined for a slot that was
  // already booked before the visitor ever opened this demo (an "other
  // customer" placeholder; a real system would store that customer's own
  // name here instead), or CURRENT_CUSTOMER.name once book_appointment
  // itself books it. get_my_appointments filters on this rather than on
  // `booked` alone, so it never claims someone else's pre-existing booking
  // as the visitor's own.
  bookedBy?: string
}
type WeekData = { day: string; date: number; isoDate: string; byTime: Partial<Record<(typeof TIME_ROWS)[number], DayCellData>> }[]

// The mock schedule's byTime content (which stylist/slot is booked) is
// fixed, hand-authored demo data, indexed 0=Mon..6=Sun — a real weekday
// identity, not "days from today." buildInitialWeek below looks each
// displayed day up by its actual weekday index, so the same person's
// same booking always lands on the same real weekday no matter which 7
// real dates happen to be on screen (today's start-of-window date shifts
// daily; which slots are booked on a Tuesday does not).
const WEEK_BY_TIME: Partial<Record<(typeof TIME_ROWS)[number], DayCellData>>[] = [
  {},
  { '10am': { stylist: 'Amy', booked: true }, '2pm': { stylist: 'Jordan', booked: false } },
  { '11am': { stylist: 'Amy', booked: false }, '2pm': { stylist: 'Priya', booked: true } },
  { '10am': { stylist: 'Jordan', booked: true }, '3pm': { stylist: 'Priya', booked: false } },
  { '2pm': { stylist: 'Amy', booked: false }, '3pm': { stylist: 'Priya', booked: true } },
  { '11am': { stylist: 'Jordan', booked: true }, '1pm': { stylist: 'Priya', booked: true } },
  {},
]
const WEEK_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

// Shared with get_today_date's own result below — both need the LOCAL
// calendar date (not now.toISOString(), which reports UTC and silently
// disagrees with local-time day-of-week math within the ~UTC-midnight
// window — see get_today_date's own comment on the bug that caused).
function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Columns stay in a fixed Mon..Sun order (matching WEEK_DAY_NAMES/
// WEEK_BY_TIME's own indexing — see WEEK_BY_TIME's comment), but each
// column's actual date is whichever real occurrence of that weekday is
// CLOSEST to today (today itself counts as 0 days away) — never one
// that's already passed. Concretely: for a given weekday, if today is
// that weekday or earlier in the Mon-first week, the date is THIS
// week's occurrence; if today is later in the week than that weekday,
// the date rolls forward to NEXT week's occurrence instead. E.g. on
// Saturday the 12th: Mon/Tue/Wed/Thu/Fri (earlier in the week than
// Saturday) show next week's 14–18, while Sat/Sun (today or later) show
// this week's own 12/13 — so a visitor scanning left to right sees "how
// many days from today" grow monotonically even though the displayed
// dates aren't in one single unbroken calendar-week block.
function buildInitialWeek(): WeekData {
  const today = new Date()
  // getDay(): 0=Sun..6=Sat. Converts to WEEK_DAY_NAMES/WEEK_BY_TIME's
  // own Monday-first indexing (0=Mon..6=Sun).
  const todayWeekdayIndex = (today.getDay() + 6) % 7
  return WEEK_DAY_NAMES.map((day, weekdayIndex) => {
    // Days from today to this column's weekday, always >= 0 (wraps
    // forward to next week rather than going negative for a weekday
    // earlier than today).
    const daysAhead = (weekdayIndex - todayWeekdayIndex + 7) % 7
    const d = new Date(today)
    d.setDate(today.getDate() + daysAhead)
    return { day, date: d.getDate(), isoDate: toIsoDate(d), byTime: WEEK_BY_TIME[weekdayIndex] }
  })
}
const INITIAL_WEEK: WeekData = buildInitialWeek()

// slotId is just "<isoDate>-<time>" (e.g. "2026-09-15-2pm") —
// isoDate+time is already the natural unique key for a slot
// (single-chair-per-slot, see WEEK's own comment), so this doesn't need
// a separate id-generation scheme. Letling check_availability hand back
// this exact string, and book_appointment accept nothing but this
// string, means the LLM never has to reconstruct date/time/stylist
// correctly from its own memory of the conversation — it just echoes
// back an opaque value it was already given.
//
// Keyed by isoDate (a real calendar date), not the day-of-week label
// ("Tue") the grid displays — the display label is ambiguous across
// weeks (there's a "Tue" every week), while isoDate is unambiguous and
// matches get_today_date's own real-date answer, so a visitor's
// relative-date phrase ("tomorrow") resolves to the same identifier the
// grid itself uses internally.
function slotId(isoDate: string, time: string): string {
  return `${isoDate}-${time}`
}

// Stands in for "the visitor is already logged in" — a real site would
// resolve this from the visitor's actual session, but this demo has no
// login system at all (see this file's header comment on what's mocked
// vs. real). book_appointment reads this directly rather than asking the
// LLM to collect a name, matching how a real embedded widget would already
// know who's chatting.
const CURRENT_CUSTOMER = { name: 'Jordan Lee' }

// The demo's own static UI copy, switchable independently of the rest of
// showcase (which has no i18n at all yet — see this component's own
// language-toggle button below) since a salon-booking assistant is a
// plausible bilingual storefront in a way the marketing-analytics demo
// isn't. Deliberately NOT the LLM's own reply language — that's set by
// support-app-tools.yaml's `thought` on the backend and unaffected by
// this toggle; only the page's own static labels/placeholder/greeting
// switch here.
type Lang = 'en' | 'zh'
const STRINGS: Record<Lang, {
  scheduleTitle: string
  stylistsLabel: string
  greeting: string
  inputPlaceholder: string
  inputPlaceholderOffline: string
}> = {
  en: {
    scheduleTitle: "Acme Salon's Bookings",
    stylistsLabel: 'Stylists:',
    greeting: "Hi! I'm Acme Salon's assistant. Ask me who's free this week, or anything else about booking an appointment.",
    inputPlaceholder: 'Ask who has an opening this week…',
    inputPlaceholderOffline: 'Demo not wired up (missing API key)',
  },
  zh: {
    scheduleTitle: 'Acme 沙龍預約',
    stylistsLabel: '設計師：',
    greeting: '嗨！我是 Acme 沙龍的預約助理。歡迎問我這週誰有空檔，或任何跟預約有關的問題。',
    inputPlaceholder: '問問這週誰有空檔…',
    inputPlaceholderOffline: 'Demo 尚未接上線（缺少 API key）',
  },
}

interface ToolCallEntry {
  kind: 'tool'
  id: number
  name: string
  args: Record<string, unknown>
  result?: Record<string, unknown>
}
interface ChatEntry {
  kind: 'user' | 'assistant'
  id: number
  text: string
}
type Entry = ToolCallEntry | ChatEntry

let nextEntryId = 0

export function SupportDemo() {
  // Defaults to English; toggled via the phone-frame's own language
  // button (see the JSX below) — a page-load-time-only choice (not
  // synced with the browser's locale or the rest of showcase), the
  // same "explicit toggle, not auto-detected" approach
  // src/marketing-demo/widget.js's own lang param uses.
  const [lang, setLang] = useState<Lang>('en')
  const t = STRINGS[lang]
  const [entries, setEntries] = useState<Entry[]>([
    { kind: 'assistant', id: nextEntryId++, text: STRINGS.en.greeting },
  ])
  // Re-translates the greeting in place when the visitor switches
  // language — but only while it's still the sole, untouched entry (a
  // visitor who hasn't sent anything yet). Once a real conversation has
  // started, switching language must not rewrite messages already sent
  // — matching every other STRINGS lookup here, which is applied at
  // render/send time going forward, never retroactively.
  useEffect(() => {
    setEntries((es) =>
      es.length === 1 && es[0].kind === 'assistant' ? [{ ...es[0], text: t.greeting }] : es,
    )
    // Only fires on a lang change, not on every entries update — this
    // effect's own setEntries call would otherwise re-trigger itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  // Mirrors getPromptCount() >= MAX_PROMPTS_PER_BROWSER — kept as its own
  // state (rather than re-reading localStorage on every render) so
  // hitting the cap immediately disables the input/swaps the footer
  // copy, matching widget.js's showUsageLimitReached() behavior.
  const [usageLimitReached, setUsageLimitReached] = useState(() => getPromptCount() >= MAX_PROMPTS_PER_BROWSER)
  // WEEK used to be a static, top-level constant — book_appointment needs
  // to actually mutate a slot's `booked` flag (and have the week grid
  // below re-render to show it), so it's state now. Read/written through
  // weekRef too (see below) since the tool handlers are captured once
  // inside the AgentBridge effect's closure and would otherwise only ever
  // see this state's value from whichever render first created the
  // bridge, not the latest one after a booking.
  const [week, setWeek] = useState<WeekData>(INITIAL_WEEK)
  const weekRef = useRef(week)
  weekRef.current = week
  // Fires once book_appointment actually succeeds, so the week grid can
  // play a "you just got this slot" effect on the exact cell that
  // changed. Not read directly by book_appointment's own handler for the
  // same closure-staleness reason weekRef exists (see above) — .current
  // is always this render's latest callback, even though the handler
  // itself was captured once at mount.
  const onBookedRef = useRef<((booking: { isoDate: string; time: string; stylist: string }) => void) | null>(null)
  const bridgeRef = useRef<AgentBridge | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  // The one in-flight "achievement unlocked" badge animation (see
  // .badgeFly in SupportDemo.module.css): a fixed-position clone of
  // .bookedBadge that pops up large near the shell's center, then flies
  // down and shrinks onto the booked cell's real badge. endX/endY are the
  // real badge's screen coordinates (measured at trigger time), dx/dy the
  // offset back to the starting point — the keyframes animate the offset
  // to zero. Keyed by id so back-to-back bookings each restart the
  // animation cleanly instead of continuing the previous one.
  const [celebration, setCelebration] = useState<{
    id: number
    stylist: (typeof STYLISTS)[number]
    endX: number
    endY: number
    dx: number
    dy: number
  } | null>(null)

  // Wires onBookedRef (called by book_appointment's handler the moment a
  // booking succeeds — see the AgentBridge effect) to the celebration
  // animation. Set once on mount: the ref pattern exists precisely so the
  // tool handler's mount-time closure reads whatever's current.
  useEffect(() => {
    onBookedRef.current = ({ isoDate, time, stylist }) => {
      if (!(stylist in STYLIST_COLORS)) return
      const wrap = document.querySelector(`[data-slot-id="${slotId(isoDate, time)}"]`)
      const shell = shellRef.current
      if (!wrap || !shell) return
      const wrapRect = wrap.getBoundingClientRect()
      // Mobile layout hides .siteMock entirely — a zero-size rect means
      // there's no visible target cell to fly to, so skip the animation.
      if (wrapRect.width === 0) return
      const shellRect = shell.getBoundingClientRect()
      // .bookedBadge sits at top: -6 / right: -6 of the wrap, 20px round —
      // its center is therefore (wrap.right - 4, wrap.top + 4).
      const endX = wrapRect.right - 4
      const endY = wrapRect.top + 4
      const startX = shellRect.left + shellRect.width / 2
      const startY = shellRect.top + shellRect.height / 2
      setCelebration({
        id: nextEntryId++,
        stylist: stylist as (typeof STYLISTS)[number],
        endX,
        endY,
        dx: startX - endX,
        dy: startY - endY,
      })
    }
    return () => {
      onBookedRef.current = null
    }
  }, [])

  // Safety net: onAnimationEnd is the normal cleanup, but if it never
  // fires (element removed mid-flight, animation suppressed) the overlay
  // must not linger over the calendar forever.
  useEffect(() => {
    if (!celebration) return
    const t = setTimeout(() => setCelebration(null), 2500)
    return () => clearTimeout(t)
  }, [celebration])

  useEffect(() => {
    window.dataLayer = window.dataLayer || []
    window.dataLayer.push({ event: 'demo_open', demo_id: 'showcase-support' })
  }, [])

  // Overrides showcase/index.html's shared, marketing-demo-flavored
  // <title>/meta tags (see usePageMeta's own comment) with this page's
  // own — leads with "AI customer support" and "appointment booking" as
  // the two terms most likely to match what someone would actually
  // search for landing on this specific demo, rather than the generic
  // showcase-wide copy every other /showcase/* route falls back to.
  usePageMeta({
    title: 'AI Customer Support & Appointment Booking Demo — onagent',
    description: 'Try a live AI customer support assistant that books, looks up, and cancels real appointments — a real AgentBridge connection, not a mock.',
    path: '/support',
  })

  // Same "unlock the moment the AgentBridge instance is constructed"
  // pattern src/marketing-demo/widget.js's own comment explains — there is
  // no reliable "connection actually succeeded" signal to gate on that
  // doesn't risk a deadlock, so a real connection failure surfaces later,
  // via onError, instead of blocking input upfront.
  useEffect(() => {
    if (!API_KEY) return
    const bridge = new AgentBridge({
      url: WS_URL,
      appId: APP_ID,
      apiKey: API_KEY,
      onAssistantMessage: (text) => {
        setThinking(false)
        setEntries((es) => [...es, { kind: 'assistant', id: nextEntryId++, text }])
      },
      onError: (err) => {
        setThinking(false)
        console.error('[support-demo]', err)
        setEntries((es) => [...es, { kind: 'assistant', id: nextEntryId++, text: "Sorry, something went wrong on my end — I'll get a human to help." }])
      },
      onQuotaExceeded: () => {
        setThinking(false)
        setEntries((es) => [...es, { kind: 'assistant', id: nextEntryId++, text: "This demo has hit its usage limit for now — please check back later." }])
      },
      tools: [
        defineTool(
          'get_today_date',
          (raw) => {
            const args = raw as { format?: unknown }
            const format = args.format
            if (format !== 'date' && format !== 'weekday') {
              throw new Error(`format is required and must be "date" or "weekday" (got: ${String(format)})`)
            }
            return { format }
          },
          ({ format }) => {
            // Real wall-clock time, not a value anchored to
            // INITIAL_WEEK's own Mon 8 – Sun 14 mock dates — this tool
            // only answers "what date is it really," so the LLM can
            // reason about relative-date phrases ("tomorrow," "next
            // Friday") in absolute terms; it deliberately does NOT try
            // to map "today" onto one of the mock week's specific
            // dates, since the two numbering schemes have no real
            // relationship to reconcile.
            //
            // toIsoDate uses the LOCAL calendar date (not
            // now.toISOString(), which reports UTC and would disagree
            // with the visitor's actual local date within the
            // ~UTC-midnight window — see toIsoDate's own comment).
            //
            // `format` is required (not optional) even though the tool
            // could just always return both fields — a real product
            // reason to require it doesn't exist, this exists purely to
            // keep this call's args from ever being `{}`. An empty-args
            // call here was empirically confirmed (via direct Gemini API
            // testing against this exact request) to make the FOLLOWING
            // model turn come back with finishReason: STOP and zero
            // output tokens — no text, no function call — at a ~100%
            // rate; adding any non-empty argument, meaningful or not,
            // dropped that failure rate to roughly 15-25%. want v0.4.1's
            // empty-response detection (see internal/inference/want.go's
            // AgentErrorMessage handling) catches the remaining failures
            // and reports them as an explicit error instead of hanging
            // forever, but avoiding the trigger condition here is cheap
            // and directly cuts how often that fallback needs to fire.
            const now = new Date()
            const result = format === 'date' ? { isoDate: toIsoDate(now) } : { weekday: now.toLocaleDateString('en-US', { weekday: 'long' }) }
            setEntries((es) => [...es, { kind: 'tool', id: nextEntryId++, name: 'get_today_date', args: { format }, result }])
            return result
          },
        ),
        defineTool(
          'check_availability',
          (raw) => {
            const args = raw as { date?: unknown; stylist?: unknown }
            const date = typeof args.date === 'string' ? args.date : undefined
            const stylist = typeof args.stylist === 'string' ? args.stylist : undefined
            // Exact match only — unlike the old day-of-week string this
            // replaced ("Tuesday"/"tues" all resolving to the same "Tue"),
            // an ISO date has no ambiguity worth being lenient about; a
            // malformed/out-of-range date is the LLM's own mistake (it
            // should have called get_today_date first) and should surface
            // as a real error, not silently match nothing.
            const dateMatch = date ? weekRef.current.find((d) => d.isoDate === date) : undefined
            // Spells out the actual searchable range (taken from
            // weekRef.current itself, not a hardcoded "this week"/"7
            // days" claim) so the LLM learns the real boundary from
            // what the tool says, rather than the thought/description
            // having to pre-declare a range in prose that could drift
            // out of sync with what buildInitialWeek() actually builds.
            // This one message covers two real cases the same way: date
            // is a genuinely unrecognized value, or it's a past date —
            // weekRef.current only ever holds today-or-later dates (see
            // buildInitialWeek's own comment), so a past date never
            // matches and hits this same branch, not a separate "that's
            // already passed" message. Good enough for a demo; a real
            // product might want to tell those two apart.
            if (date && !dateMatch) {
              // weekRef.current is in fixed Mon..Sun column order, NOT
              // date order (see buildInitialWeek's own comment on why
              // dates roll forward per-column), so the earliest/latest
              // searchable date has to be found by sorting isoDate
              // values, not by reading the array's first/last entry.
              const sorted = [...weekRef.current].map((d) => d.isoDate).sort()
              throw new Error(`Unknown date: ${date} (can only search ${sorted[0]} through ${sorted[sorted.length - 1]})`)
            }
            const stylistMatch = stylist
              ? STYLISTS.find((s) => s.toLowerCase() === stylist.toLowerCase())
              : undefined
            if (stylist && !stylistMatch) throw new Error(`Unknown stylist: ${stylist}`)
            return { date: dateMatch?.isoDate, stylist: stylistMatch }
          },
          ({ date, stylist }) => {
            // Queries weekRef.current — the same state the week grid
            // itself renders (see this file's header comment) — rather
            // than a module-level constant, so a booking made earlier in
            // this same conversation is reflected in later
            // check_availability calls too. Reads through the ref, not
            // `week` directly, because this callback is captured once
            // inside the AgentBridge effect's closure (mount-once, see the
            // effect's own eslint-disable) and would otherwise only ever
            // see whichever `week` value existed at that first render.
            const days = date ? weekRef.current.filter((d) => d.isoDate === date) : weekRef.current
            // Slots with no stylist scheduled at all are omitted entirely
            // — that time simply isn't part of the salon's week, not a
            // "false" availability worth stating. A slot that DOES have a
            // stylist scheduled is always included, whether already
            // booked or still open, with `available` distinguishing the
            // two (see support-app-tools.yaml's thought for the same rule
            // spelled out to the model: absence means "not on the
            // schedule," not "booked").
            const slots = days.flatMap((d) =>
              TIME_ROWS.map((time) => {
                const cell = d.byTime[time]
                if (!cell) return null
                if (stylist && cell.stylist !== stylist) return null
                return { slotId: slotId(d.isoDate, time), date: d.isoDate, day: d.day, time, stylist: cell.stylist, available: !cell.booked }
              }).filter((s): s is NonNullable<typeof s> => s !== null),
            )
            const result = { slots }
            setEntries((es) => [...es, { kind: 'tool', id: nextEntryId++, name: 'check_availability', args: { date, stylist }, result }])
            return result
          },
        ),
        defineTool(
          'get_my_appointments',
          () => ({}),
          () => {
            // Filters on bookedBy, not just `booked` — a slot that was
            // already booked before this demo even loaded (INITIAL_WEEK's
            // hardcoded true/false, no bookedBy set) belongs to some other
            // customer, not CURRENT_CUSTOMER, and must never show up here
            // just because it happens to be occupied.
            const appointments = weekRef.current.flatMap((d) =>
              TIME_ROWS.map((time) => {
                const cell = d.byTime[time]
                if (!cell || cell.bookedBy !== CURRENT_CUSTOMER.name) return null
                return { slotId: slotId(d.isoDate, time), date: d.isoDate, day: d.day, time, stylist: cell.stylist }
              }).filter((a): a is NonNullable<typeof a> => a !== null),
            )
            const result = { appointments }
            setEntries((es) => [...es, { kind: 'tool', id: nextEntryId++, name: 'get_my_appointments', args: {}, result }])
            return result
          },
        ),
        defineTool(
          'book_appointment',
          (raw) => {
            const args = raw as { slotId?: unknown; action?: unknown }
            if (typeof args.slotId !== 'string') throw new Error('slotId is required')
            const action = args.action === undefined ? 'book' : args.action
            if (action !== 'book' && action !== 'cancel') throw new Error(`Unknown action: ${String(action)} (expected "book" or "cancel")`)
            return { slotId: args.slotId, action }
          },
          ({ slotId: id, action }) => {
            // Parses the same "<isoDate>-<time>" shape slotId() produces
            // — deliberately re-derived here rather than trusting a
            // client-supplied date/time pair, so an LLM can only ever act
            // on an opaque id it was actually handed by check_availability,
            // never fabricate its own date/time combination. A plain
            // split('-') would break here (isoDate itself contains
            // hyphens, e.g. "2026-09-15"), so this splits on the LAST
            // hyphen instead — time values (TIME_ROWS: "10am".."3pm")
            // never contain one themselves.
            const cut = id.lastIndexOf('-')
            const isoDate = id.slice(0, cut)
            const time = id.slice(cut + 1)
            const dayEntry = weekRef.current.find((d) => d.isoDate === isoDate)
            if (!dayEntry) throw new Error(`Unknown slotId: ${id}`)
            const cell = dayEntry.byTime[time as (typeof TIME_ROWS)[number]]
            if (!cell) throw new Error(`Unknown slotId: ${id} (no stylist scheduled for ${isoDate} ${time})`)

            if (action === 'cancel') {
              // Cancelling isn't just "the inverse of booking" — it must
              // never let the LLM free up a slot it doesn't own. A slot
              // that's already open, or booked by someone else entirely
              // (bookedBy unset or a different name), is the LLM's own
              // mistake (it should have called get_my_appointments first),
              // so this throws rather than silently no-op'ing.
              if (!cell.booked || cell.bookedBy !== CURRENT_CUSTOMER.name) {
                throw new Error(`Slot ${id} is not one of ${CURRENT_CUSTOMER.name}'s bookings`)
              }
              const stylist = cell.stylist
              setWeek((w) =>
                w.map((d) =>
                  d.isoDate !== isoDate
                    ? d
                    : { ...d, byTime: { ...d.byTime, [time]: { ...cell, booked: false, bookedBy: undefined } } },
                ),
              )
              const result = { cancelled: true, date: isoDate, time, stylist }
              setEntries((es) => [...es, { kind: 'tool', id: nextEntryId++, name: 'book_appointment', args: { slotId: id, action }, result }])
              return result
            }

            // action === 'book'. Two different failure shapes on purpose,
            // not one blanket { booked: false }: an unparseable/nonexistent
            // slotId is the LLM's own mistake (it fabricated an id, or
            // garbled one it was given) and throws, surfacing as a real
            // tool error the model sees and can react to (re-check
            // availability, tell the visitor something went wrong) — vs. a
            // slotId that WAS valid when check_availability returned it but
            // lost the race to another booking in between, which is a
            // legitimate outcome a real salon's booking system would hit
            // too, not a bug, so it returns booked:false instead of
            // throwing.
            if (cell.booked) {
              const result = { booked: false, date: isoDate, time, stylist: cell.stylist }
              setEntries((es) => [...es, { kind: 'tool', id: nextEntryId++, name: 'book_appointment', args: { slotId: id, action }, result }])
              return result
            }
            const stylist = cell.stylist
            setWeek((w) =>
              w.map((d) =>
                d.isoDate !== isoDate
                  ? d
                  : { ...d, byTime: { ...d.byTime, [time]: { ...cell, booked: true, bookedBy: CURRENT_CUSTOMER.name } } },
              ),
            )
            onBookedRef.current?.({ isoDate, time, stylist })
            // CURRENT_CUSTOMER stands in for a real visitor session (see
            // its own doc comment) — echoed back here so the LLM can
            // confirm the booking by name without ever having asked the
            // visitor for it.
            const result = { booked: true, date: isoDate, time, stylist, customer: CURRENT_CUSTOMER.name }
            setEntries((es) => [...es, { kind: 'tool', id: nextEntryId++, name: 'book_appointment', args: { slotId: id, action }, result }])
            return result
          },
        ),
      ],
    })
    bridgeRef.current = bridge
    return () => {
      bridge.close()
      bridgeRef.current = null
    }
    // Runs once on mount — one connection for this component's whole
    // lifetime, matching MarketingDemo.tsx's own single-mount AgentBridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' })
  }, [entries, thinking])

  function handleSend() {
    const text = input.trim()
    if (!text || !bridgeRef.current) return
    if (getPromptCount() >= MAX_PROMPTS_PER_BROWSER) {
      setUsageLimitReached(true)
      return
    }
    incrementPromptCount()
    setEntries((es) => [...es, { kind: 'user', id: nextEntryId++, text }])
    setInput('')
    setThinking(true)
    bridgeRef.current.prompt(text)
    if (getPromptCount() >= MAX_PROMPTS_PER_BROWSER) setUsageLimitReached(true)
  }

  return (
    <div className={styles.supportShell} ref={shellRef}>
      {/* Backdrop: the salon's own weekly stylist schedule — a plausible
          "why is a support widget embedded in this page" justification,
          and (styling only for now, see this component's header comment)
          the eventual target for highlighting whichever slot a tool call
          actually touched. */}
      <div className={styles.siteMock}>
        <div className={styles.siteMockNav}>
          <div className={styles.siteMockTitleGroup}>
            <div className={styles.siteMockLogo} />
            <span className={styles.siteMockTitleText}>{t.scheduleTitle}</span>
          </div>
          <div className={styles.legend}>
            <span className={styles.legendLabel}>{t.stylistsLabel}</span>
            {STYLISTS.map((name) => (
              <span key={name} className={styles.legendItem}>
                <span className={styles.legendAvatar} style={{ borderColor: STYLIST_COLORS[name] }}>
                  {STYLIST_AVATARS[name]}
                </span>
                {name}
              </span>
            ))}
          </div>
        </div>
        <table className={styles.weekGrid}>
          <thead>
            <tr>
              <th className={styles.timeAxisHead} />
              {week.map((d) => (
                <th key={d.day} className={styles.dayHead}>
                  <div className={styles.dayLabel}>{d.day}</div>
                  <div className={styles.dayDate}>{d.date}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TIME_ROWS.map((time) => (
              <tr key={time}>
                <td className={styles.timeAxisCell}>{time}</td>
                {week.map((d) => {
                  const cell = d.byTime[time]
                  return (
                    <td className={styles.dayCell} key={d.day}>
                      {cell && (
                        <span
                          className={styles.dayAvatarWrap}
                          data-slot-id={slotId(d.isoDate, time)}
                          aria-label={`${cell.stylist}${cell.booked ? ' — booked' : ' available'} ${d.day} ${time}`}
                          title={cell.stylist}
                        >
                          {cell.booked && (
                            /* Filled with the stylist's own color (same
                               source as the avatar ring below) so the badge
                               and ring read as one unit per stylist, rather
                               than a brand-gold dot clashing with each
                               ring's unrelated green/blue/pink. */
                            <span
                              className={styles.bookedBadge}
                              style={{ background: STYLIST_COLORS[cell.stylist] }}
                              aria-hidden="true"
                            >
                              <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
                            </span>
                          )}
                          <span className={styles.dayAvatar} style={{ borderColor: STYLIST_COLORS[cell.stylist] }}>
                            {STYLIST_AVATARS[cell.stylist]}
                          </span>
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The support widget itself — the actual subject of this demo,
          framed as a phone, wired to a real AgentBridge connection.
          On mobile (see SupportDemo.module.css's max-width: 640px block)
          this right while the schedule drawer is open, so a strip of it
          it's pinned low enough to cover only the bottom half of the
          schedule card stacked behind it (see .csPhoneDock's own
          comment), so both are visible at once with no open/close
          interaction needed. */}
      <div className={styles.csPhoneDock}>
        <div className={styles.csPhoneNotch} />
        <div className={styles.csPanel}>
          <div className={styles.csPanelHeader}>
            <span className={`${styles.csAvatar} ${styles.csAvatarLg}`}>
              <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
            </span>
            <div className={styles.csPanelHeaderText}>
              <div className={styles.csPanelTitleRow}>
                <div className={styles.csPanelTitle}>Support</div>
                {/* This demo's own static copy (title/legend/greeting/
                    placeholder, see the STRINGS dict above) switches
                    language on click; the LLM's own reply language is
                    unaffected (that's set by support-app-tools.yaml's
                    thought on the backend, not by this toggle). */}
                <button
                  type="button"
                  className={styles.langToggle}
                  onClick={() => setLang((l) => (l === 'en' ? 'zh' : 'en'))}
                >
                  {lang === 'en' ? '中文' : 'EN'}
                </button>
              </div>
              {/* Same signal the input's own placeholder/disabled state
                  already uses (API_KEY presence) — not a real "connection
                  succeeded" check, since this component has no reliable one
                  to gate on (see the AgentBridge effect's own comment
                  below), but at least this no longer claims "Online" while
                  the demo is fully unwired (no key set at all). */}
              <div className={styles.csPanelSubtitle}>
                <span className={`${styles.csDot} ${API_KEY ? '' : styles.csDotOffline}`} />
                {API_KEY ? 'Online · usually replies instantly' : 'Offline · demo not wired up'}
              </div>
            </div>
          </div>

          <div className={styles.csPanelThread} ref={threadRef}>
            <div className={styles.csDayDivider}>Today</div>

            {/* Tool-call entries (check_availability's args/result) stay in
                `entries` — the tool handler still appends them, see the
                AgentBridge effect above — but are filtered out of what
                actually renders here, so the thread reads as a real
                customer-facing chat rather than exposing the tool-calling
                mechanics under the hood. Kept in state rather than never
                recorded at all, in case a future debug/dev view wants
                them. */}
            {entries
              .filter((entry): entry is ChatEntry => entry.kind !== 'tool')
              .map((entry) => (
                <div className={`${styles.csRow} ${entry.kind === 'user' ? styles.fromUser : styles.fromAi}`} key={entry.id}>
                  {/* Only the assistant's own text is Markdown (per
                      support-app-tools.yaml's thought) — the visitor's own
                      typed message is rendered as plain text, same as
                      before, so nothing they type is ever interpreted as
                      Markdown/HTML. */}
                  {entry.kind === 'assistant' ? (
                    <div
                      className={styles.csBubble}
                      dangerouslySetInnerHTML={{ __html: marked.parse(escapeHtml(entry.text), { async: false }) }}
                    />
                  ) : (
                    <div className={styles.csBubble}>{entry.text}</div>
                  )}
                </div>
              ))}

            {thinking && (
              <div className={`${styles.csRow} ${styles.fromAi}`}>
                <div className={`${styles.csBubble} ${styles.csThinking}`}>
                  <span /><span /><span />
                </div>
              </div>
            )}
          </div>

          <div className={styles.csPanelInput}>
            {/* Once the free per-browser cap is hit (see
                MAX_PROMPTS_PER_BROWSER above, same mechanism as
                src/marketing-demo/widget.js's own showUsageLimitReached),
                the input has nothing left to do — swap it for a CTA into
                the real product instead of just sitting there disabled. */}
            {usageLimitReached ? (
              <>
                <a className={styles.csLimitCta} href="/app">Try it yourself →</a>
                <p className={styles.csLimitStatus}>This browser has hit the demo's free-prompt limit ({MAX_PROMPTS_PER_BROWSER}) — create your own onagent account to keep going on your own quota.</p>
              </>
            ) : (
              <form
                className={`${styles.csInputRow} ${styles.csInputRowHint}`}
                onSubmit={(e) => {
                  e.preventDefault()
                  handleSend()
                }}
              >
                <input
                  className={styles.csTextarea}
                  placeholder={API_KEY ? t.inputPlaceholder : t.inputPlaceholderOffline}
                  value={input}
                  disabled={!API_KEY}
                  onChange={(e) => setInput(e.target.value)}
                />
                <button type="submit" className={styles.csSendBtn} disabled={!API_KEY || !input.trim()} aria-label="Send">
                  <svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                </button>
              </form>
            )}
            <div className={styles.csPowered}>Powered by <b>onagent</b></div>
          </div>
        </div>
      </div>

      {/* The flying achievement badge — a fixed-position clone of the
          booked cell's .bookedBadge (same SVG, same stylist color) that
          pops in large near the shell's center then shrinks onto the real
          badge's exact screen position (measured in the onBookedRef
          effect above). Purely decorative: book_appointment already set
          week state, so the real .bookedBadge is rendering underneath —
          this overlay just plays once and removes itself, revealing it. */}
      {celebration && (
        <span
          key={celebration.id}
          className={styles.badgeFly}
          style={
            {
              left: celebration.endX,
              top: celebration.endY,
              background: STYLIST_COLORS[celebration.stylist],
              '--fly-dx': `${celebration.dx}px`,
              '--fly-dy': `${celebration.dy}px`,
            } as CSSProperties
          }
          onAnimationEnd={() => setCelebration(null)}
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
        </span>
      )}
    </div>
  )
}

declare global {
  interface Window {
    dataLayer?: unknown[]
  }
}
