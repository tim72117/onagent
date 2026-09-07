// Full variable set for the marketing-analysis demo widget: 6 categorical +
// 9 continuous fields on a multi-channel e-commerce ad-campaign scenario.
// Every analysis method in analysis.js operates on this same dataset.
//
// `title` here is the Traditional Chinese label used as the variable's
// canonical id-to-label lookup key (see widget.js's title()) — it is NOT
// shown directly in the English UI. The English display title for each
// variable lives in strings.js's VARIABLE_TITLES.en, keyed by `name`, and
// widget.js picks between the two based on the active language. Keeping the
// Chinese title here (rather than splitting data.js into per-language
// copies) avoids two divergent copies of the dataset/variable list itself.
export const VARIABLES = [
  { name: 'channel', title: '行銷通路', type: 'category' },
  { name: 'device', title: '裝置類型', type: 'category' },
  { name: 'region', title: '地區', type: 'category' },
  { name: 'ageGroup', title: '年齡層', type: 'category' },
  { name: 'segment', title: '客戶分群', type: 'category' },
  { name: 'month', title: '活動月份', type: 'category' },
  { name: 'spend', title: '廣告花費', type: 'continuous' },
  { name: 'impressions', title: '曝光次數', type: 'continuous' },
  { name: 'clicks', title: '點擊次數', type: 'continuous' },
  { name: 'ctr', title: '點擊率', type: 'continuous' },
  { name: 'conversions', title: '轉換數', type: 'continuous' },
  { name: 'conversionRate', title: '轉換率', type: 'continuous' },
  { name: 'revenue', title: '營收', type: 'continuous' },
  { name: 'roi', title: 'ROI', type: 'continuous' },
  { name: 'aov', title: '平均客單價', type: 'continuous' },
]

// Row values (channel names, device types, etc.) are plain English strings
// — not translated per UI language like VARIABLE_TITLES/QUICK_TESTS in
// strings.js. Keeping the underlying data language-neutral avoids a second
// value-translation layer on top of every table/chart renderer in
// widget.js just to keep the Chinese page showing Chinese data values; the
// Traditional Chinese UI already translates variable *titles* and static
// copy, which is what actually establishes the page's language for a
// visitor.
const CHANNELS = ['Facebook', 'Google', 'Instagram', 'Email', 'Organic']
const DEVICES = ['Mobile', 'Desktop', 'Tablet']
const REGIONS = ['North', 'Central', 'South', 'East']
const AGE_GROUPS = ['18-24', '25-34', '35-44', '45-54', '55+']
const SEGMENTS = ['New', 'Returning', 'VIP']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']

// Per-channel base effectiveness multipliers — deliberately uneven so
// cross-table/correlation/regression results show real, inspectable
// structure (e.g. Email skews toward VIP/Returning with higher AOV) rather
// than noise, since the whole point of the demo is a distribution worth
// looking at.
const CHANNEL_PROFILE = {
  Facebook: { ctrBase: 0.018, convBase: 0.022, aovBase: 780, costPerClick: 9.5 },
  Google: { ctrBase: 0.032, convBase: 0.035, aovBase: 850, costPerClick: 12.0 },
  Instagram: { ctrBase: 0.024, convBase: 0.018, aovBase: 690, costPerClick: 8.0 },
  Email: { ctrBase: 0.045, convBase: 0.05, aovBase: 1050, costPerClick: 2.5 },
  Organic: { ctrBase: 0.028, convBase: 0.04, aovBase: 920, costPerClick: 0 },
}

function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rand, arr, weights) {
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rand() * total
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i]
    if (r <= 0) return arr[i]
  }
  return arr[arr.length - 1]
}

function jitter(rand, base, spread) {
  return base * (1 + (rand() - 0.5) * 2 * spread)
}

// 120 mock campaign-level records with internally-consistent derived metrics
// (impressions → clicks via ctr, clicks → conversions via conversion rate,
// conversions → revenue via aov) so every analysis method surfaces a
// coherent, explorable story instead of independently-random columns.
export function generateDataset() {
  const rand = mulberry32(42)
  const rows = []
  for (let i = 0; i < 120; i++) {
    const channel = pick(rand, CHANNELS, [30, 28, 20, 12, 10])
    const profile = CHANNEL_PROFILE[channel]
    const segment = pick(
      rand,
      SEGMENTS,
      channel === 'Email' ? [20, 35, 45] : channel === 'Organic' ? [25, 40, 35] : [45, 35, 20],
    )
    const segmentAovBoost = segment === 'VIP' ? 1.35 : segment === 'Returning' ? 1.1 : 1

    const impressions = Math.round(jitter(rand, 8000, 0.5))
    const ctr = Math.max(0.002, jitter(rand, profile.ctrBase, 0.35))
    const clicks = Math.round(impressions * ctr)
    const conversionRate = Math.max(0.002, jitter(rand, profile.convBase, 0.4))
    const conversions = Math.max(0, Math.round(clicks * conversionRate))
    const aov = Math.round(jitter(rand, profile.aovBase, 0.25) * segmentAovBoost)
    const revenue = conversions * aov
    const spend = Math.round(clicks * profile.costPerClick)
    const roi = spend > 0 ? +((revenue - spend) / spend).toFixed(2) : null

    rows.push({
      channel,
      device: pick(rand, DEVICES, [55, 35, 10]),
      region: pick(rand, REGIONS, [35, 25, 30, 10]),
      ageGroup: pick(rand, AGE_GROUPS, [22, 30, 24, 14, 10]),
      segment,
      month: MONTHS[i % MONTHS.length],
      spend,
      impressions,
      clicks,
      ctr: +(ctr * 100).toFixed(2),
      conversions,
      conversionRate: +(conversionRate * 100).toFixed(2),
      revenue,
      roi,
      aov,
    })
  }
  return rows
}
