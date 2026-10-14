/**
 * Response parsers — one per catalog adapter, all pure.
 *
 * These were written from the documented response shapes without live access to
 * any of the eight vendors, so every parser is written to *fail loudly rather
 * than guess*. A parser returns a normalized result only when it finds the
 * figure it was looking for; anything else throws `ParseError`, which the
 * caller turns into the `parse-failed` status with the raw response echoed.
 * That is the whole point: a wrong number is worse than no number.
 */

/** Thrown when a 200 response does not contain a figure this parser trusts. */
export class ParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'ParseError'
  }
}

/**
 * @typedef {object} RawResult
 * @property {'balance' | 'quota'} kind
 * @property {string | null} currency
 * @property {number | null} amount      Remaining money for `balance`; null for `quota`.
 * @property {string} display            Short text for the header chip.
 * @property {{ label: string, value: string }[]} detail  Popover rows.
 * @property {{ key: string, label: string, used: number | null, limit: number | null, remainingPct: number | null, note?: string }[]} windows
 */

const CURRENCY_SYMBOLS = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥' }

/**
 * Coerce a value that may be a number or a numeric string.
 * @param {unknown} value
 * @returns {number | null}
 */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Read a dotted path out of a nested object.
 * @param {unknown} root
 * @param {string} path e.g. `data.total_balance`
 * @returns {unknown}
 */
function pick(root, path) {
  let node = root
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[key]
  }
  return node
}

/**
 * Return the first value among `paths` that coerces to a finite number.
 * @param {unknown} root
 * @param {string[]} paths
 * @returns {number | null}
 */
function firstNum(root, paths) {
  for (const path of paths) {
    const value = num(pick(root, path))
    if (value !== null) return value
  }
  return null
}

/**
 * Return the first value among `paths` that is a non-empty string.
 * @param {unknown} root
 * @param {string[]} paths
 * @returns {string | null}
 */
function firstString(root, paths) {
  for (const path of paths) {
    const value = pick(root, path)
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Find every nested object satisfying a predicate.
 * @param {unknown} root
 * @param {(node: Record<string, unknown>) => boolean} predicate
 * @param {number} [depth]
 * @returns {Record<string, unknown>[]}
 */
function findObjects(root, predicate, depth = 6) {
  const found = []
  const seen = new Set()
  /** @param {unknown} node @param {number} level */
  function walk(node, level) {
    if (level > depth || node === null || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item, level + 1)
      return
    }
    if (predicate(node)) found.push(node)
    for (const value of Object.values(node)) walk(value, level + 1)
  }
  walk(root, 0)
  return found
}

/**
 * Format money for display, keeping the sign and two decimals.
 * @param {number} amount
 * @param {string | null} currency
 * @returns {string}
 */
export function formatMoney(amount, currency) {
  const code = typeof currency === 'string' && currency !== '' ? currency.toUpperCase() : null
  const symbol = code === null ? '' : CURRENCY_SYMBOLS[code] ?? `${code} `
  return `${symbol}${amount.toFixed(2)}`
}

/**
 * Build a money result.
 * @param {number} amount @param {string | null} currency
 * @param {{ label: string, value: string }[]} [detail]
 * @returns {RawResult}
 */
function money(amount, currency, detail = []) {
  const code = typeof currency === 'string' && currency !== '' ? currency.toUpperCase() : null
  return {
    kind: 'balance',
    currency: code,
    amount,
    display: formatMoney(amount, code),
    detail: [{ label: '剩余', value: formatMoney(amount, code) }, ...detail],
    windows: [],
  }
}

/**
 * Normalize one quota window, preferring an explicit used/limit pair over a
 * bare percentage — a lone `percentage` field does not say which direction it
 * measures, so it is reported as "已用" rather than silently inverted.
 * @param {{ key: string, label: string, used?: number | null, limit?: number | null, percentage?: number | null, resetAt?: string | null }} input
 * @returns {RawResult['windows'][number]}
 */
function window_(input) {
  const used = num(input.used)
  const limit = num(input.limit)
  const percentage = num(input.percentage)
  /** @type {number | null} */
  let remainingPct = null
  let note = undefined
  if (used !== null && limit !== null && limit > 0) {
    remainingPct = Math.max(0, Math.min(100, (1 - used / limit) * 100))
  } else if (percentage !== null) {
    note = `接口返回占比 ${percentage}%（方向未标注，按已用理解）`
  }
  return {
    key: input.key,
    label: input.label,
    used,
    limit,
    remainingPct,
    ...(note === undefined ? {} : { note }),
    ...(typeof input.resetAt === 'string' && input.resetAt !== '' ? { resetAt: input.resetAt } : {}),
  }
}

/**
 * Build a quota result from normalized windows. The chip shows the tightest
 * window, because that is the one that will run out first.
 * @param {RawResult['windows']} windows
 * @param {{ label: string, value: string }[]} [detail]
 * @returns {RawResult}
 */
function quota(windows, detail = []) {
  if (windows.length === 0) throw new ParseError('响应里没有可识别的额度窗口')
  const measurable = windows.filter((w) => w.remainingPct !== null)
  const tightest = measurable.length
    ? measurable.reduce((min, w) => (w.remainingPct < min.remainingPct ? w : min))
    : null
  const display =
    tightest === null
      ? windows[0].label
      : `${tightest.label} ${tightest.remainingPct.toFixed(0)}%`
  return {
    kind: 'quota',
    currency: null,
    amount: null,
    display,
    detail: [
      ...windows.map((w) => ({ label: w.label, value: describeWindow(w) })),
      ...detail,
    ],
    windows,
  }
}

/**
 * Render one quota window as a single line.
 * @param {RawResult['windows'][number]} w
 * @returns {string}
 */
export function describeWindow(w) {
  if (w.used !== null && w.limit !== null) {
    return `已用 ${w.used} / ${w.limit}（剩 ${w.remainingPct === null ? '?' : w.remainingPct.toFixed(0)}%）`
  }
  if (w.remainingPct !== null) return `剩 ${w.remainingPct.toFixed(0)}%`
  return w.note ?? '接口未给出可读数值'
}

/**
 * Parse a vendor response body.
 * @param {string} adapter Catalog `adapter` name.
 * @param {unknown} body Parsed JSON.
 * @returns {RawResult}
 */
export function parseResponse(adapter, body) {
  const parser = PARSERS[adapter]
  if (parser === undefined) throw new ParseError(`没有为适配器 ${adapter} 注册解析器`)
  return parser(body)
}

/** @type {Record<string, (body: unknown) => RawResult>} */
const PARSERS = {
  /** `GET /user/balance` → `{is_available, balance_infos:[{currency,total_balance,…}]}` */
  deepseek(body) {
    const infos = pick(body, 'balance_infos')
    if (!Array.isArray(infos) || infos.length === 0) {
      throw new ParseError('响应缺少 balance_infos 数组')
    }
    const usable = infos.filter((info) => num(pick(info, 'total_balance')) !== null)
    if (usable.length === 0) throw new ParseError('balance_infos 里没有可读的 total_balance')
    // One entry per currency; sum only same-currency entries and report the
    // first currency, rather than adding unlike currencies together.
    const currency = firstString(usable[0], ['currency'])
    const total = usable
      .filter((info) => firstString(info, ['currency']) === currency)
      .reduce((sum, info) => sum + (num(pick(info, 'total_balance')) ?? 0), 0)
    const detail = usable.map((info) => ({
      label: firstString(info, ['currency']) ?? '余额',
      value: formatMoney(num(pick(info, 'total_balance')) ?? 0, firstString(info, ['currency'])),
    }))
    return money(total, currency, detail)
  },

  /** `GET /api/v1/key` → `{data:{limit, usage, limit_remaining}}` */
  openrouter(body) {
    const remaining = firstNum(body, ['data.limit_remaining', 'limit_remaining'])
    const limit = firstNum(body, ['data.limit', 'limit'])
    const used = firstNum(body, ['data.usage', 'usage'])
    if (remaining === null) {
      // A null limit_remaining means an unlimited key, which is a real answer
      // and must not be reported as a parse failure.
      if (limit === null && used === null) throw new ParseError('响应缺少 limit_remaining / limit / usage')
      return {
        kind: 'balance',
        currency: 'USD',
        amount: null,
        display: '无限额',
        detail: [
          { label: '剩余', value: '无限额（Key 未设上限）' },
          ...(used === null ? [] : [{ label: '已用', value: formatMoney(used, 'USD') }]),
        ],
        windows: [],
      }
    }
    const detail = [
      ...(limit === null ? [] : [{ label: 'Key 上限', value: formatMoney(limit, 'USD') }]),
      ...(used === null ? [] : [{ label: '已用', value: formatMoney(used, 'USD') }]),
    ]
    return money(remaining, 'USD', detail)
  },

  /** `GET /v1/users/me/balance` → `{data:{available_balance,…}}` */
  moonshot(body) {
    const available = firstNum(body, [
      'data.available_balance',
      'data.availableBalance',
      'available_balance',
    ])
    if (available === null) throw new ParseError('响应缺少 data.available_balance')
    const voucher = firstNum(body, ['data.voucher_balance', 'data.voucherBalance'])
    const cash = firstNum(body, ['data.cash_balance', 'data.cashBalance'])
    const detail = [
      ...(cash === null ? [] : [{ label: '现金', value: formatMoney(cash, 'CNY') }]),
      ...(voucher === null ? [] : [{ label: '代金券', value: formatMoney(voucher, 'CNY') }]),
    ]
    return money(available, 'CNY', detail)
  },

  /** `GET /v1/user/info` → `{data:{balance, chargeBalance, totalBalance}}` */
  siliconflow(body) {
    const total = firstNum(body, ['data.totalBalance', 'data.balance'])
    if (total === null) throw new ParseError('响应缺少 data.totalBalance / data.balance')
    const charge = firstNum(body, ['data.chargeBalance'])
    const detail = charge === null ? [] : [{ label: '充值余额', value: formatMoney(charge, 'CNY') }]
    return money(total, 'CNY', detail)
  },

  /**
   * `GET /api/monitor/usage/quota/limit` — subscription windows.
   * Shape is not published; scan for window-shaped objects and prefer explicit
   * used/limit pairs.
   */
  zhipu(body) {
    const candidates = findObjects(body, (node) => {
      const hasPair = num(node.used) !== null && num(node.limit) !== null
      const hasPct = num(node.percentage) !== null || num(node.used_percent) !== null
      return hasPair || hasPct
    })
    if (candidates.length === 0) throw new ParseError('响应里没有可识别的额度对象')
    const windows = candidates.map((node, index) => {
      const hours = num(node.number) ?? num(node.duration) ?? num(node.period)
      const unit = firstString(node, ['unit', 'type', 'name'])
      return window_({
        key: `w${index}`,
        label: labelForWindow({ hours, unit, index }),
        used: num(node.used) ?? num(node.used_tokens),
        limit: num(node.limit) ?? num(node.total) ?? num(node.limit_tokens),
        percentage: num(node.percentage) ?? num(node.used_percent),
        resetAt: firstString(node, ['resetAt', 'reset_at', 'resetTime', 'nextResetTime']),
      })
    })
    return quota(dedupeWindows(windows))
  },

  /** `GET /coding/v1/usages` — subscription windows (5h / weekly). */
  kimiCoding(body) {
    const rows = Array.isArray(pick(body, 'data'))
      ? pick(body, 'data')
      : findObjects(body, (node) => num(node.used) !== null || num(node.usage) !== null)
    if (!Array.isArray(rows) || rows.length === 0) throw new ParseError('响应里没有额度窗口数组')
    const windows = rows.map((node, index) =>
      window_({
        key: `w${index}`,
        label: firstString(node, ['window', 'period', 'name', 'label']) ?? `窗口 ${index + 1}`,
        used: num(pick(node, 'used')) ?? num(pick(node, 'usage')),
        limit: num(pick(node, 'limit')) ?? num(pick(node, 'total')),
        percentage: num(pick(node, 'percentage')),
        resetAt: firstString(node, ['resetAt', 'reset_at', 'resetTime']),
      }),
    )
    return quota(dedupeWindows(windows))
  },

  /** `GET /v1/token_plan/remains` — subscription plan. */
  minimax(body) {
    const nodes = findObjects(
      body,
      (node) => num(node.remaining) !== null || num(node.remains) !== null || num(node.left) !== null,
    )
    if (nodes.length === 0) throw new ParseError('响应里没有可识别的剩余额度字段')
    const detail = nodes.map((node) => {
      const label = firstString(node, ['name', 'model', 'plan', 'type']) ?? '套餐'
      const value = num(node.remaining) ?? num(node.remains) ?? num(node.left) ?? 0
      const total = num(node.total) ?? num(node.limit)
      return { label, value: total === null ? String(value) : `${value} / ${total}` }
    })
    const head = num(nodes[0].remaining) ?? num(nodes[0].remains) ?? num(nodes[0].left) ?? 0
    const headTotal = num(nodes[0].total) ?? num(nodes[0].limit)
    return {
      kind: 'quota',
      currency: null,
      amount: null,
      display: headTotal === null ? String(head) : `${head}/${headTotal}`,
      detail,
      windows: dedupeWindows(
        nodes.map((node, index) =>
          window_({
            key: `w${index}`,
            label: firstString(node, ['name', 'model', 'plan', 'type']) ?? `套餐 ${index + 1}`,
            used:
              num(node.used) ??
              (num(node.total) !== null && num(node.remaining) !== null
                ? num(node.total) - num(node.remaining)
                : null),
            limit: num(node.total) ?? num(node.limit),
            percentage: num(node.percentage),
          }),
        ),
      ),
    }
  },

  /** `GET /zen/go/v1/usage` — rolling / weekly / monthly windows. */
  opencodeGo(body) {
    const nodes = findObjects(body, (node) => {
      const hasPair = num(node.used) !== null && num(node.limit) !== null
      const hasPct = num(node.percentage) !== null || num(node.used_percent) !== null
      const hasWindow = typeof node.window === 'string' || typeof node.period === 'string'
      return hasPair || hasPct || (hasWindow && num(node.remaining) !== null)
    })
    if (nodes.length === 0) throw new ParseError('响应里没有可识别的额度窗口')
    const windows = nodes.map((node, index) =>
      window_({
        key: `w${index}`,
        label: firstString(node, ['window', 'period', 'name', 'label']) ?? `窗口 ${index + 1}`,
        used: num(node.used) ?? num(node.usage),
        limit: num(node.limit) ?? num(node.total),
        percentage: num(node.percentage) ?? num(node.used_percent),
        resetAt: firstString(node, ['resetAt', 'reset_at', 'resetTime', 'resetsAt']),
      }),
    )
    return quota(dedupeWindows(windows))
  },
}

/**
 * Derive a readable label for a window whose shape did not name itself.
 * @param {{ hours: number | null, unit: string | null, index: number }} input
 * @returns {string}
 */
function labelForWindow({ hours, unit, index }) {
  if (hours !== null) return `${hours} 小时窗口`
  if (unit !== null && unit !== '') return unit
  return `窗口 ${index + 1}`
}

/**
 * Drop windows that describe the same thing, so a shape that nests the same
 * quota twice does not render it twice.
 * @param {RawResult['windows']} windows
 * @returns {RawResult['windows']}
 */
function dedupeWindows(windows) {
  const byLabel = new Map()
  for (const w of windows) {
    const key = `${w.label}|${w.used}|${w.limit}|${w.remainingPct}`
    if (!byLabel.has(key)) byLabel.set(key, w)
  }
  return [...byLabel.values()]
}
