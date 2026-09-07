// Bilingual UI copy for the marketing-analysis demo widget. This widget is
// mounted by both landing pages (index.html in English, zh-tw/index.html in
// Traditional Chinese) from the *same* bundle — see mountMarketingDemo's
// `lang` parameter in widget.js. Rather than shipping a third-party i18n
// library for a handful of embedded-widget strings, this is just a plain
// lookup table plus a tiny `t(lang, key, vars)` helper below.
//
// Method labels/result titles are template functions (not plain strings)
// since several of them interpolate a variable title — e.g. "次數分配 —
// 行銷通路" / "Frequency — Channel". Every other entry is a plain string.
//
// Variable *titles* (e.g. "行銷通路" → "Channel") are intentionally kept in
// this same file (VARIABLE_TITLES) rather than in data.js — data.js's
// `VARIABLES[].title` stays the Traditional Chinese label and doubles as the
// canonical lookup key; the English display title for the same variable is
// looked up here by `name`. See widget.js's `title(name)` for how the two
// are combined based on the active language.

export const VARIABLE_TITLES = {
  zh: {
    channel: '行銷通路',
    device: '裝置類型',
    region: '地區',
    ageGroup: '年齡層',
    segment: '客戶分群',
    month: '活動月份',
    spend: '廣告花費',
    impressions: '曝光次數',
    clicks: '點擊次數',
    ctr: '點擊率',
    conversions: '轉換數',
    conversionRate: '轉換率',
    revenue: '營收',
    roi: 'ROI',
    aov: '平均客單價',
  },
  en: {
    channel: 'Channel',
    device: 'Device',
    region: 'Region',
    ageGroup: 'Age group',
    segment: 'Customer segment',
    month: 'Campaign month',
    spend: 'Ad spend',
    impressions: 'Impressions',
    clicks: 'Clicks',
    ctr: 'CTR',
    conversions: 'Conversions',
    conversionRate: 'Conversion rate',
    revenue: 'Revenue',
    roi: 'ROI',
    aov: 'Avg. order value',
  },
}

export const STRINGS = {
  zh: {
    navAnalysis: '分析畫面',
    navData: '資料狀況',
    navCode: 'Code',
    scenarioTitle: '情境',
    scenarioText:
      '一家經營多通路廣告投放的電商團隊，每月從 Facebook、Google、Instagram、Email' +
      '與自然流量等來源收集活動成效資料：花費、曝光、點擊、轉換、營收與 ROI，' +
      '並記錄客戶所在地區、年齡層、分群與使用裝置。這裡用 120 筆模擬活動紀錄，' +
      '示範 AI 助手如何依照你的提問自動挑選變數、執行對應的分析方法並回傳結果。',
    scenarioData: '資料集：120 筆模擬活動紀錄・15 個欄位（6 類別＋9 連續）・6 種分析方法',
    quickTestsLabel: '或點一個問題，帶入右側輸入框：',
    resultPlaceholder: '分析結果會顯示在這裡——在右側輸入問題，或點左邊的範例問題',
    resultErrorInsufficientData: '這個問題選到的變數不是數值型態，無法計算——請換一個問題，或指定連續型的變數（如花費、點擊數、營收等）。',
    chatHint: '在下方輸入你想分析的問題，AI 的回覆會顯示在這裡。',
    inputPlaceholderConnecting: '連線中…',
    inputPlaceholderReady: '輸入你想分析的問題…',
    inputPlaceholderNotWired: '（對話式 demo 尚未上線）',
    sendAriaLabel: '送出',
    statusConnecting: '連線中…',
    statusNotWired: '對話式問答尚未設定完成',
    statusConnectionError: (message) => `連線發生問題：${message}`,
    chatErrorMessage: 'AI 助手暫時連不上，這是示範服務的問題，不是你的操作。',
    chatErrorRetry: '重試',
    statusRemainingPrompts: (remaining) => `本示範剩餘 ${remaining} 次免費提問`,
    usageLimitCta: '立即試用 →',
    usageLimitStatus: (max) => `此瀏覽器已達本示範的免費次數上限（${max} 次）——註冊自己的 onagent 帳號，用自己的額度繼續使用`,
    resultCardShowBtn: '顯示結果',
    resultCardDefaultLabel: '分析結果',
    thinkingLabel: '思考中',
    analyzingLabel: '分析中',
    typeCategory: '類別',
    typeContinuous: '連續',
    dataTabVariables: '變數清單',
    dataTabPreview: '資料預覽',
    dataPreviewCount: (shown, total) => `顯示前 ${shown} 筆，共 ${total} 筆`,
    varListColName: '名稱',
    varListColFieldId: '欄位 id',
    varListColType: '型別',
    intercept: '截距',
    methodLabel: {
      frequency: (v) => `次數分配 — ${v}`,
      crossTable: (row, col) => `交叉分析 — ${row} × ${col}`,
      correlation: (vars) => `相關分析 — ${vars.join('、')}`,
      correlationTitle: '相關分析',
      regression: (dep) => `迴歸分析 — 預測 ${dep}`,
      trend: (v) => `趨勢分析 — ${v}`,
      ranking: (group, metric) => `排名 — ${group}（依 ${metric}）`,
    },
  },
  en: {
    navAnalysis: 'Analysis',
    navData: 'Dataset',
    navCode: 'Code',
    scenarioTitle: 'Scenario',
    scenarioText:
      'An e-commerce team running ads across multiple channels collects monthly campaign ' +
      'performance data from Facebook, Google, Instagram, Email, and organic traffic — spend, ' +
      'impressions, clicks, conversions, revenue, and ROI — along with customer region, age ' +
      'group, segment, and device. This demo uses 120 mock campaign records to show how an AI ' +
      'assistant picks the right variables and analysis method from your question, then returns ' +
      'the result.',
    scenarioData: 'Dataset: 120 mock campaign records · 15 fields (6 categorical + 9 continuous) · 6 analysis methods',
    quickTestsLabel: 'Or click a question to fill the input on the right:',
    resultPlaceholder: 'Analysis results will appear here — ask a question on the right, or pick an example on the left',
    resultErrorInsufficientData: 'The variables picked for this question aren’t numeric, so this can’t be computed — try rephrasing, or ask about a continuous variable (like spend, clicks, or revenue).',
    chatHint: 'Type the question you want analyzed below — the AI’s reply will show up here.',
    inputPlaceholderConnecting: 'Connecting…',
    inputPlaceholderReady: 'Ask a question about the data…',
    inputPlaceholderNotWired: '(Chat demo not live yet)',
    sendAriaLabel: 'Send',
    statusConnecting: 'Connecting…',
    statusNotWired: 'Chat isn’t wired up yet',
    statusConnectionError: (message) => `Connection error: ${message}`,
    chatErrorMessage: 'The AI assistant is temporarily unreachable — this is an issue with the demo service, not something you did.',
    chatErrorRetry: 'Retry',
    statusRemainingPrompts: (remaining) => `${remaining} free ${remaining === 1 ? 'prompt' : 'prompts'} left in this demo`,
    usageLimitCta: 'Try it yourself →',
    usageLimitStatus: (max) => `This browser has hit the demo’s free-prompt limit (${max}) — create your own onagent account to keep going on your own quota`,
    resultCardShowBtn: 'Show result',
    resultCardDefaultLabel: 'Result',
    thinkingLabel: 'Thinking',
    analyzingLabel: 'Analyzing',
    typeCategory: 'Categorical',
    typeContinuous: 'Continuous',
    dataTabVariables: 'Variables',
    dataTabPreview: 'Data',
    dataPreviewCount: (shown, total) => `Showing first ${shown} of ${total} rows`,
    varListColName: 'Name',
    varListColFieldId: 'Field id',
    varListColType: 'Type',
    intercept: 'Intercept',
    methodLabel: {
      frequency: (v) => `Frequency — ${v}`,
      crossTable: (row, col) => `Cross-tab — ${row} × ${col}`,
      correlation: (vars) => `Correlation — ${vars.join(', ')}`,
      correlationTitle: 'Correlation',
      regression: (dep) => `Regression — predicting ${dep}`,
      trend: (v) => `Trend — ${v}`,
      ranking: (group, metric) => `Ranking — ${group} (by ${metric})`,
    },
  },
}

// Natural-language quick-test questions offered per language — these are
// real prompts submitted through the chat path (the AI still picks the
// method + variables itself via select_analysis), not shortcuts to a
// pre-picked answer, so each language gets its own idiomatic phrasing rather
// than a literal translation of the other.
export const QUICK_TESTS = {
  zh: [
    '各行銷通路的活動數量分布如何？',
    '不同裝置在各地區的分布有什麼差異？',
    '廣告花費、點擊數跟營收之間有關聯嗎？',
    '哪些因素影響營收？',
    '這半年營收的變化趨勢如何？',
    '哪個通路的營收表現最好？',
    '客群跟轉換率有關係嗎？',
    '點擊率最近有沒有在變化？',
  ],
  en: [
    'How are campaigns distributed across marketing channels?',
    'How does device usage differ by region?',
    'Is there a relationship between ad spend, clicks, and revenue?',
    'What factors drive revenue?',
    'How has revenue trended over the last six months?',
    'Which channel generates the most revenue?',
    'Is customer segment related to conversion rate?',
    'Has click-through rate been changing recently?',
  ],
}

// Fallback chain: an unsupported lang value falls back to English rather
// than throwing, so a bad/omitted `lang` degrades gracefully instead of
// breaking the widget.
export function resolveLang(lang) {
  return lang === 'zh' ? 'zh' : 'en'
}

export function t(lang, key) {
  const dict = STRINGS[resolveLang(lang)]
  return dict[key]
}
