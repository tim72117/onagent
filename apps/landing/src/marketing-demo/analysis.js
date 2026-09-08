// Six analysis methods, each taking the dataset plus the variable(s) the AI
// (or a quick-test button) selected, returning a plain-object result shape
// the widget renders — one function + one render branch per method, so the
// result-flow contract stays the same as methods are added.
//
// correlation/regression/ranking additionally return `error:
// 'insufficient_numeric_data'` (with the rest of the result's fields present
// but null/empty) when the variable(s) passed in filter out to zero (or, for
// regression, fewer rows than predictors) usable numeric values — most
// commonly because the AI picked a categorical variable for a
// numeric-only slot. widget.js's renderResult checks this before its normal
// per-method branches and shows an honest message instead of a
// misleading result (a fabricated zero correlation/R², or a crash on a
// non-numeric ranking metric). See each function's own comment for why its
// particular no-data fallback (denom===0, ssTot===0, string concatenation)
// would otherwise be indistinguishable from a genuine result.

export function frequency(rows, variableName) {
  const counts = new Map()
  for (const row of rows) {
    const v = row[variableName]
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return {
    method: 'frequency',
    variable: variableName,
    counts: [...counts.entries()].map(([value, count]) => ({ value, count })),
  }
}

export function crossTable(rows, rowVariable, colVariable) {
  const rowValues = [...new Set(rows.map((r) => r[rowVariable]))]
  const colValues = [...new Set(rows.map((r) => r[colVariable]))]
  const table = rowValues.map((rv) => {
    const cells = colValues.map((cv) => rows.filter((r) => r[rowVariable] === rv && r[colVariable] === cv).length)
    return { rowValue: rv, cells }
  })
  return { method: 'crossTable', rowVariable, colVariable, rowValues, colValues, table }
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length
}

function pearson(xs, ys) {
  const mx = mean(xs)
  const my = mean(ys)
  let num = 0
  let dx2 = 0
  let dy2 = 0
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    num += dx * dy
    dx2 += dx * dx
    dy2 += dy * dy
  }
  const denom = Math.sqrt(dx2 * dy2)
  return denom === 0 ? 0 : num / denom
}

export function correlation(rows, variableNames) {
  // Number.isFinite, not typeof === 'number': typeof NaN and
  // typeof Infinity are BOTH 'number' in JS, so a typeof-only check lets a
  // NaN/Infinity value (e.g. from upstream malformed data) straight through
  // this filter — pearson() then propagates that single bad value into
  // NaN for every pair involving that variable (mean/dx/dy all become NaN),
  // which reaches heatmap()'s colorFor unguarded and renders as an invalid
  // "rgb(NaN,NaN,NaN)" fill (silently ignored by canvas, leaving a stale
  // color) with a literal "NaN" text label — a misleading result exactly
  // like the ones this insufficient_numeric_data path exists to avoid.
  // Number.isFinite(NaN)/(Infinity) are both false, so this closes that gap.
  const clean = rows.filter((r) => variableNames.every((v) => Number.isFinite(r[v])))
  // Fewer than 2 numeric rows makes every pairwise correlation undefined —
  // most commonly because the caller (the AI, picking variable names from
  // its own inference) passed a non-numeric/categorical variable, which
  // filters every row out here. Reporting this honestly (an error field the
  // renderer shows) matters because pearson's own denom===0 fallback below
  // returns a plain 0 for "no valid pairs," which is indistinguishable from
  // a genuine zero correlation — a real result, not a refusal, once this
  // check passes.
  if (clean.length < 2) {
    return { method: 'correlation', variables: variableNames, matrix: null, error: 'insufficient_numeric_data' }
  }
  const matrix = variableNames.map((a) =>
    variableNames.map((b) => +pearson(clean.map((r) => r[a]), clean.map((r) => r[b])).toFixed(2)),
  )
  return { method: 'correlation', variables: variableNames, matrix }
}

// Simple OLS multiple regression via normal equations — fine for a handful
// of predictors on a demo dataset; not meant to be a general-purpose solver.
export function regression(rows, dependentVariable, independentVariables) {
  // Number.isFinite, not typeof === 'number' — see correlation's own
  // comment above for why: an Infinity/NaN value passing this filter would
  // propagate through the XtX/Xty sums and Gaussian elimination below
  // (Infinity - Infinity, Infinity / Infinity, etc. all produce NaN),
  // yielding coefficients/rSquared that are NaN/Infinity instead of a
  // clean number OR an honest insufficient_numeric_data — silently
  // defeating the point of this whole guard.
  const clean = rows.filter(
    (r) => Number.isFinite(r[dependentVariable]) && independentVariables.every((v) => Number.isFinite(r[v])),
  )
  const n = clean.length
  const k = independentVariables.length + 1
  // Same reasoning as correlation's clean.length check above: with n < k,
  // the normal-equations system is underdetermined (or, at n===0, every
  // sum is 0 and Gaussian elimination's `aug[col][col] || 1e-9` fallback
  // masks that with a division-by-near-zero instead of failing loudly), and
  // ssTot===0 below would report a fabricated rSquared of 0 — the same
  // "genuine zero vs. no valid data" ambiguity correlation's denom===0
  // fallback has. Most commonly hit when the AI passes a categorical
  // variable as dependentVariable/independentVariables, filtering every row
  // out above.
  if (n < k) {
    return {
      method: 'regression',
      dependentVariable,
      independentVariables,
      intercept: null,
      coefficients: independentVariables.map((v) => ({ variable: v, coefficient: null })),
      rSquared: null,
      error: 'insufficient_numeric_data',
    }
  }
  const X = clean.map((r) => [1, ...independentVariables.map((v) => r[v])])
  const y = clean.map((r) => r[dependentVariable])

  const XtX = Array.from({ length: k }, () => new Array(k).fill(0))
  const Xty = new Array(k).fill(0)
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i]
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b]
    }
  }

  // Gaussian elimination on the augmented [XtX | Xty] matrix.
  const aug = XtX.map((row, i) => [...row, Xty[i]])
  for (let col = 0; col < k; col++) {
    let pivot = col
    for (let r2 = col + 1; r2 < k; r2++) if (Math.abs(aug[r2][col]) > Math.abs(aug[pivot][col])) pivot = r2
    ;[aug[col], aug[pivot]] = [aug[pivot], aug[col]]
    const pv = aug[col][col] || 1e-9
    for (let c2 = col; c2 <= k; c2++) aug[col][c2] /= pv
    for (let r2 = 0; r2 < k; r2++) {
      if (r2 === col) continue
      const factor = aug[r2][col]
      for (let c2 = col; c2 <= k; c2++) aug[r2][c2] -= factor * aug[col][c2]
    }
  }
  const coefficients = aug.map((row) => +row[k].toFixed(4))

  const predicted = X.map((xi) => xi.reduce((sum, xij, j) => sum + xij * coefficients[j], 0))
  const yMean = mean(y)
  const ssTot = y.reduce((sum, yi) => sum + (yi - yMean) ** 2, 0)
  const ssRes = y.reduce((sum, yi, i) => sum + (yi - predicted[i]) ** 2, 0)
  const rSquared = ssTot === 0 ? 0 : +(1 - ssRes / ssTot).toFixed(3)

  return {
    method: 'regression',
    dependentVariable,
    independentVariables,
    intercept: coefficients[0],
    coefficients: independentVariables.map((v, i) => ({ variable: v, coefficient: coefficients[i + 1] })),
    rSquared,
  }
}

// `order`/timeVariable values are internal keys matched against data.js's
// `month` field ('Jan'..'Jun'), not user-facing text — they never render
// directly (widget.js always looks up a display title via title()/t()), so
// they stay as-is regardless of UI language.
export function trend(rows, variableName, timeVariable = 'month') {
  const order = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']
  const byPeriod = new Map()
  for (const row of rows) {
    // Same reasoning as correlation/regression/ranking above: a
    // variableName that isn't numeric on this row (most commonly the AI
    // passing a categorical/misspelled variable, which makes every
    // row[variableName] undefined) would otherwise silently feed
    // undefined/non-numeric values into mean() below, producing a
    // fabricated NaN per period — charts.js's lineChart doesn't throw on
    // NaN (canvas coordinate ops silently no-op), so this would render as
    // a blank/garbled line with "NaN" point labels instead of an honest
    // failure. Rows are still grouped by period even when filtered here,
    // so a variable that's numeric on some rows and not others (shouldn't
    // happen with this dataset, but not assumed) still contributes its
    // valid values.
    // Number.isFinite, not typeof === 'number' — see correlation's own
    // comment for why: a NaN/Infinity value would otherwise poison mean()
    // for its whole period, and worse, poison min/max (and therefore every
    // OTHER period's plotted position too) once it reaches lineChart.
    if (!Number.isFinite(row[variableName])) continue
    const period = row[timeVariable]
    const list = byPeriod.get(period) ?? []
    list.push(row[variableName])
    byPeriod.set(period, list)
  }
  if (byPeriod.size === 0) {
    return { method: 'trend', variable: variableName, timeVariable, series: [], error: 'insufficient_numeric_data' }
  }
  const series = order
    .filter((p) => byPeriod.has(p))
    .map((period) => ({ period, value: +mean(byPeriod.get(period)).toFixed(2) }))
  return { method: 'trend', variable: variableName, timeVariable, series }
}

export function ranking(rows, groupVariable, metricVariable, topN = 5) {
  // Same reasoning as correlation/regression above: a metricVariable that
  // isn't numeric (e.g. the AI passing a categorical variable) would
  // otherwise concatenate into a string (0 + "New" = "0New") and crash on
  // .toFixed below, rather than failing loudly or honestly. Rows where the
  // metric is null (e.g. data.js's roi for the zero-spend Organic channel)
  // are filtered the same way — summing through a null silently understates
  // that group's total instead of reflecting that it has no valid value.
  // Number.isFinite, not typeof === 'number' — see correlation's own
  // comment for why: a NaN/Infinity metric value would otherwise sum into
  // that group's total (NaN poisons the whole sum; Infinity silently wins
  // "top" regardless of the other groups' real values) instead of being
  // excluded the same way a null/non-numeric metric already is below.
  const clean = rows.filter((r) => Number.isFinite(r[metricVariable]))
  if (clean.length === 0) {
    return { method: 'ranking', groupVariable, metricVariable, items: [], error: 'insufficient_numeric_data' }
  }
  const sums = new Map()
  for (const row of clean) {
    const key = row[groupVariable]
    sums.set(key, (sums.get(key) ?? 0) + row[metricVariable])
  }
  const items = [...sums.entries()]
    .map(([value, total]) => ({ value, total: +total.toFixed(2) }))
    .sort((a, b) => b.total - a.total)
    // Math.max(0, topN), not a bare topN: Array.prototype.slice treats a
    // negative end as "count back from the array's end" (e.g.
    // [a,b,c].slice(0,-1) is [a,b], not []), so a negative topN (an
    // off-by-one in the AI's tool call, or any other malformed input —
    // tools.yaml's schema has no `minimum` on topN) would otherwise
    // silently return "all but the last N" as if that were a legitimate
    // ranking, instead of the empty/error-shaped result a negative "how
    // many top items" actually calls for.
    .slice(0, Math.max(0, topN))
  return { method: 'ranking', groupVariable, metricVariable, items }
}
