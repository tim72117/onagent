// Small dependency-free canvas charts — kept in-house rather than pulling in
// a charting library, since the widget only ever needs three simple shapes
// (bar, line, heatmap) and this keeps the lazy-loaded bundle tiny.

// Matches apps/console/src/style.css's light-mode --accent/--border/--ink
// tokens (hardcoded — separate bundle, can't share CSS custom properties).
const GOLD = '#c1622b'
const GOLD_SOFT = 'rgba(193, 98, 43, 0.18)'
const GRID_LINE = '#e4e0da'
const TEXT = '#1c1917'
const TEXT_MUTED = '#6b6560'

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas')
  const dpr = window.devicePixelRatio || 1
  canvas.width = width * dpr
  canvas.height = height * dpr
  canvas.style.width = width + 'px'
  canvas.style.height = height + 'px'
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.font = '11px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif')
  return { canvas, ctx }
}

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text
  let t = text
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1)
  return t + '…'
}

// Vertical bar chart. items: [{ label, value }]
export function barChart(items, { width = 640, height = 220, valueSuffix = '' } = {}) {
  const { canvas, ctx } = makeCanvas(width, height)
  const padL = 8
  const padR = 8
  const padT = 14
  const padB = 36
  const chartW = width - padL - padR
  const chartH = height - padT - padB
  const max = Math.max(...items.map((i) => i.value), 1)

  ctx.strokeStyle = GRID_LINE
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(padL, padT + chartH)
  ctx.lineTo(padL + chartW, padT + chartH)
  ctx.stroke()

  const gap = 10
  const barW = (chartW - gap * (items.length - 1)) / items.length
  items.forEach((item, i) => {
    const x = padL + i * (barW + gap)
    const h = (item.value / max) * (chartH - 18)
    const y = padT + chartH - h

    ctx.fillStyle = GOLD
    ctx.beginPath()
    const r = Math.min(6, barW / 2)
    ctx.moveTo(x, y + h)
    ctx.lineTo(x, y + r)
    ctx.arcTo(x, y, x + r, y, r)
    ctx.lineTo(x + barW - r, y)
    ctx.arcTo(x + barW, y, x + barW, y + r, r)
    ctx.lineTo(x + barW, y + h)
    ctx.closePath()
    ctx.fill()

    ctx.fillStyle = TEXT
    ctx.textAlign = 'center'
    ctx.fillText(String(item.value) + valueSuffix, x + barW / 2, y - 5)

    ctx.fillStyle = TEXT_MUTED
    const label = truncate(ctx, String(item.label), barW + gap - 2)
    ctx.fillText(label, x + barW / 2, padT + chartH + 16)
  })

  return canvas
}

// Grouped bar chart for a cross-table: series per column value, grouped by row value.
export function groupedBarChart(rowValues, colValues, table, { width = 640, height = 240 } = {}) {
  const { canvas, ctx } = makeCanvas(width, height)
  const padL = 8
  const padR = 8
  const padT = 14
  const padB = 36
  const chartW = width - padL - padR
  const chartH = height - padT - padB
  const max = Math.max(...table.flatMap((r) => r.cells), 1)
  const colors = [GOLD, '#8a9bb0', '#b07a5c', '#7fa88a', '#a689b0']

  ctx.strokeStyle = GRID_LINE
  ctx.beginPath()
  ctx.moveTo(padL, padT + chartH)
  ctx.lineTo(padL + chartW, padT + chartH)
  ctx.stroke()

  const groupGap = 14
  const groupW = (chartW - groupGap * (rowValues.length - 1)) / rowValues.length
  const barGap = 3
  const barW = (groupW - barGap * (colValues.length - 1)) / colValues.length

  rowValues.forEach((rv, gi) => {
    const gx = padL + gi * (groupW + groupGap)
    colValues.forEach((cv, ci) => {
      const value = table[gi].cells[ci]
      const h = (value / max) * (chartH - 10)
      const x = gx + ci * (barW + barGap)
      const y = padT + chartH - h
      ctx.fillStyle = colors[ci % colors.length]
      ctx.fillRect(x, y, barW, h)
    })
    ctx.fillStyle = TEXT_MUTED
    ctx.textAlign = 'center'
    ctx.fillText(truncate(ctx, String(rv), groupW), gx + groupW / 2, padT + chartH + 16)
  })

  // Legend
  ctx.textAlign = 'left'
  let lx = padL
  colValues.forEach((cv, ci) => {
    ctx.fillStyle = colors[ci % colors.length]
    ctx.fillRect(lx, 2, 9, 9)
    ctx.fillStyle = TEXT_MUTED
    ctx.fillText(String(cv), lx + 13, 10)
    lx += ctx.measureText(String(cv)).width + 30
  })

  return canvas
}

// Line chart. series: [{ period, value }]
export function lineChart(series, { width = 640, height = 220 } = {}) {
  const { canvas, ctx } = makeCanvas(width, height)
  const padL = 36
  const padR = 12
  const padT = 16
  const padB = 28
  const chartW = width - padL - padR
  const chartH = height - padT - padB
  const values = series.map((s) => s.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1

  ctx.strokeStyle = GRID_LINE
  ctx.lineWidth = 1
  for (let i = 0; i <= 3; i++) {
    const y = padT + (chartH / 3) * i
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(padL + chartW, y)
    ctx.stroke()
    const value = max - (range / 3) * i
    ctx.fillStyle = TEXT_MUTED
    ctx.textAlign = 'right'
    ctx.fillText(value.toFixed(0), padL - 6, y + 3)
  }

  const stepX = series.length > 1 ? chartW / (series.length - 1) : 0
  const points = series.map((s, i) => ({
    x: padL + i * stepX,
    y: padT + chartH - ((s.value - min) / range) * chartH,
  }))

  ctx.fillStyle = GOLD_SOFT
  ctx.beginPath()
  ctx.moveTo(points[0].x, padT + chartH)
  points.forEach((p) => ctx.lineTo(p.x, p.y))
  ctx.lineTo(points[points.length - 1].x, padT + chartH)
  ctx.closePath()
  ctx.fill()

  ctx.strokeStyle = GOLD
  ctx.lineWidth = 2.5
  ctx.beginPath()
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.stroke()

  points.forEach((p, i) => {
    ctx.fillStyle = GOLD
    ctx.beginPath()
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = TEXT_MUTED
    ctx.textAlign = 'center'
    ctx.fillText(String(series[i].period), p.x, padT + chartH + 20)
  })

  return canvas
}

// Correlation heatmap. variables: string[], matrix: number[][] in [-1, 1]
export function heatmap(variables, matrix, { cell = 56 } = {}) {
  const labelW = 90
  const width = labelW + cell * variables.length + 8
  const height = 24 + cell * variables.length + 8
  const { canvas, ctx } = makeCanvas(width, height)

  function colorFor(v) {
    // -1 → cool grey-blue, 0 → near-white, +1 → console's accent (rust)
    if (v >= 0) {
      const t = v
      const r = Math.round(255 - t * (255 - 193))
      const g = Math.round(255 - t * (255 - 98))
      const b = Math.round(255 - t * (255 - 43))
      return `rgb(${r},${g},${b})`
    }
    const t = -v
    const r = Math.round(255 - t * (255 - 138))
    const g = Math.round(255 - t * (255 - 155))
    const b = Math.round(255 - t * (255 - 176))
    return `rgb(${r},${g},${b})`
  }

  variables.forEach((v, ci) => {
    ctx.save()
    ctx.translate(labelW + ci * cell + cell / 2, 18)
    ctx.fillStyle = TEXT_MUTED
    ctx.textAlign = 'center'
    ctx.fillText(truncate(ctx, v, cell), 0, 0)
    ctx.restore()
  })

  variables.forEach((rv, ri) => {
    ctx.fillStyle = TEXT_MUTED
    ctx.textAlign = 'left'
    ctx.fillText(truncate(ctx, rv, labelW - 6), 0, 24 + ri * cell + cell / 2 + 4)
    variables.forEach((cv, ci) => {
      const value = matrix[ri][ci]
      const x = labelW + ci * cell
      const y = 24 + ri * cell
      ctx.fillStyle = colorFor(value)
      ctx.fillRect(x, y, cell - 2, cell - 2)
      ctx.fillStyle = Math.abs(value) > 0.6 ? '#fff' : TEXT
      ctx.textAlign = 'center'
      ctx.fillText(value.toFixed(2), x + (cell - 2) / 2, y + (cell - 2) / 2 + 4)
    })
  })

  return canvas
}
