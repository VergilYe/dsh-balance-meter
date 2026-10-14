/**
 * Preset endpoint probing for routes that are NOT in the catalogue.
 *
 * A gateway the catalogue does not know may still expose a balance behind one
 * of a handful of conventional paths — the relay-panel shapes that New-API,
 * Sub2API, claude-code-hub, CloseAI and OpenAI-compatible billing endpoints all
 * use. Each preset is tried in a fixed order and the first one that yields a
 * figure wins; if none do, the caller reports the route as uncatalogued and the
 * user can set an endpoint by hand.
 *
 * Scope of the claim: the *mechanism* here is tested, and every extraction path
 * has a fixture. The individual shapes are transcribed from the reference
 * project's catalogue of relay panels, which the author cannot re-verify —
 * so a preset that misses reports `parse-failed` with its response echoed
 * rather than returning a wrong number.
 *
 * Every request goes to the route's own host: the gateway the user configured
 * in DSH, never a third-party domain.
 */

import { clampPct, findObjects, firstNum, firstString, num, pick } from './parse.mjs'
import { STATUS } from './state.mjs'

/** How many bytes of a preset response may be echoed on failure. */
const ECHO_LIMIT = 400

/**
 * @typedef {object} Preset
 * @property {string} id
 * @property {string} label           Shown in the detail panel as the endpoint that hit.
 * @property {string} path            Template; `{origin}` and `{base}` are expanded.
 * @property {string} [statusPath]    Unauthenticated read that calibrates the figure.
 * @property {(body: unknown, cal: object) => object} parse
 */

/**
 * Read New-API's self-declared accounting unit.
 *
 * New-API lets a panel operator change `quota_per_unit`, so a hardcoded 500000
 * is off by orders of magnitude on a reconfigured panel. The endpoint is
 * unauthenticated, so this is read before the authenticated call.
 * @param {unknown} body
 * @returns {{ perUnit: number | null, display: string | null }}
 */
function readCalibration(body) {
  const perUnit = firstNum(body, ['data.quota_per_unit', 'quota_per_unit'])
  const display = firstString(body, ['data.quota_display_type', 'quota_display_type'])
  return {
    perUnit: perUnit !== null && perUnit > 0 ? perUnit : null,
    display: display === null ? null : display.toUpperCase(),
  }
}

/**
 * Convert a New-API quota figure to money.
 *
 * Panels report either raw quota units or an already-converted amount; the
 * calibration decides which, and the caller falls back to raw units when the
 * panel did not say.
 * @param {number} quota
 * @param {{ perUnit: number | null, display: string | null }} cal
 * @returns {{ amount: number, currency: string | null }}
 */
function fromQuotaUnits(quota, cal) {
  if (cal.perUnit === null || cal.display === 'TOKENS') {
    return { amount: quota, currency: cal.display === 'TOKENS' ? null : 'USD' }
  }
  return { amount: quota / cal.perUnit, currency: 'USD' }
}

/**
 * Build a money result in the shape `query.mjs` expects.
 * @param {number} amount
 * @param {string | null} currency
 * @param {{ label: string, value: string }[]} [detail]
 */
function money(amount, currency, detail = []) {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''
  return {
    kind: 'balance',
    currency,
    amount,
    display: `${symbol}${amount.toFixed(2)}`,
    detail: [{ label: '剩余', value: `${symbol}${amount.toFixed(2)}` }, ...detail],
    windows: [],
  }
}

/**
 * Build a quota result from windows found in an unknown shape.
 *
 * Throws when there is nothing to report, so the caller moves on to the next
 * preset rather than accepting an empty reading as a success.
 * @param {{key: string, label: string, used: number | null, limit: number | null, remainingPct: number | null}[]} windows
 */
function quota(windows) {
  if (windows.length === 0) nothing()
  const first = windows.find((w) => w.remainingPct !== null) ?? windows[0]
  return {
    kind: 'quota',
    currency: null,
    amount: null,
    display: first === undefined
      ? '—'
      : first.remainingPct === null
        ? first.label
        : `${first.label} 剩 ${first.remainingPct.toFixed(0)}%`,
    detail: windows.map((w) => ({
      label: w.label,
      value: w.remainingPct === null
        ? '接口未给出可读数值'
        : `剩 ${w.remainingPct.toFixed(0)}%`,
    })),
    windows,
  }
}

/** Throw when a body yielded nothing, so the next preset is tried. */
function nothing() {
  throw new Error('no readable figure')
}

/** @type {Preset[]} */
export const PRESETS = [
  {
    // New-API >= v0.9.0 — answers the remaining quota in one authenticated call,
    // after one unauthenticated calibration read.
    id: 'new-api-token',
    label: 'New-API /api/usage/token/',
    path: '{origin}/api/usage/token/',
    statusPath: '{origin}/api/status',
    parse(body, cal) {
      const data = pick(body, 'data') ?? body
      const unlimited = pick(data, 'unlimited_quota')
      if (unlimited === true) {
        return { ...money(0, null), display: '无限额', detail: [{ label: '剩余', value: '无限额' }] }
      }
      const available = firstNum(data, ['total_available', 'available', 'remain', 'remain_quota'])
      if (available === null) nothing()
      const { amount, currency } = fromQuotaUnits(available, cal)
      const granted = firstNum(data, ['total_granted', 'granted'])
      const used = firstNum(data, ['total_used', 'used'])
      const detail = []
      if (granted !== null) {
        detail.push({ label: '总额', value: String(fromQuotaUnits(granted, cal).amount.toFixed(2)) })
      }
      if (used !== null) {
        detail.push({ label: '已用', value: String(fromQuotaUnits(used, cal).amount.toFixed(2)) })
      }
      return money(amount, currency, detail)
    },
  },
  {
    // OpenAI-compatible dashboard billing. `/usage` is in cents; the subscription
    // call is in dollars, so the two are only comparable after scaling.
    id: 'openai-billing',
    label: 'OpenAI 风格 billing/subscription',
    path: '{origin}/v1/dashboard/billing/subscription',
    parse(body, cal, extra) {
      const limit = firstNum(body, ['hard_limit_usd', 'soft_limit_usd', 'system_hard_limit_usd'])
      if (limit === null) nothing()
      const usedCents = extra === undefined || extra === null
        ? null
        : firstNum(extra, ['total_usage', 'total_usage_usd'])
      if (usedCents === null) return money(limit, 'USD', [{ label: '总额', value: `$${limit.toFixed(2)}` }])
      const used = usedCents / 100
      return money(Math.max(0, limit - used), 'USD', [
        { label: '总额', value: `$${limit.toFixed(2)}` },
        { label: '已用', value: `$${used.toFixed(2)}` },
      ])
    },
    secondPath: '{origin}/v1/dashboard/billing/usage',
  },
  {
    // Sub2API-style usage windows.
    id: 'sub2api-usage',
    label: 'Sub2API /v1/usage',
    path: '{origin}/v1/usage',
    parse(body) {
      return quota(scanWindows(body))
    },
  },
  {
    // claude-code-hub, which authenticates with the key in `x-api-key` rather
    // than a bearer token.
    id: 'claude-code-hub',
    label: 'claude-code-hub /api/v1/me/quota',
    path: '{origin}/api/v1/me/quota',
    header: { name: 'x-api-key', scheme: '' },
    parse(body) {
      const remaining = firstNum(body, [
        'data.remaining', 'data.remaining_quota', 'remaining', 'data.quota_remaining',
      ])
      const limit = firstNum(body, ['data.quota', 'data.limit', 'quota', 'limit'])
      const used = firstNum(body, ['data.used', 'data.used_quota', 'used'])
      if (remaining !== null) {
        const detail = limit === null ? [] : [{ label: '总额', value: String(limit) }]
        if (used !== null) detail.push({ label: '已用', value: String(used) })
        return money(remaining, null, detail)
      }
      if (limit !== null && used !== null) {
        return money(Math.max(0, limit - used), null, [{ label: '总额', value: String(limit) }])
      }
      return quota(scanWindows(body))
    },
  },
  {
    // CloseAI-family credit grants.
    id: 'credit-grants',
    label: 'CloseAI /dashboard/billing/credit_grants',
    path: '{origin}/dashboard/billing/credit_grants',
    parse(body) {
      const available = firstNum(body, ['total_available', 'available'])
      if (available === null) nothing()
      const granted = firstNum(body, ['total_granted', 'granted'])
      const used = firstNum(body, ['total_used', 'used'])
      const detail = []
      if (granted !== null) detail.push({ label: '总额', value: `$${granted.toFixed(2)}` })
      if (used !== null) detail.push({ label: '已用', value: `$${used.toFixed(2)}` })
      return money(available, 'USD', detail)
    },
  },
  {
    id: 'credits',
    label: '/api/v1/credits',
    path: '{origin}/api/v1/credits',
    parse(body) {
      const total = firstNum(body, ['data.total_credits', 'total_credits', 'total_granted'])
      const used = firstNum(body, ['data.total_usage', 'total_usage', 'total_used'])
      if (total !== null && used !== null) {
        return money(Math.max(0, total - used), 'USD', [
          { label: '总额', value: `$${total.toFixed(2)}` },
          { label: '已用', value: `$${used.toFixed(2)}` },
        ])
      }
      const available = firstNum(body, ['data.total_available', 'total_available', 'data.balance', 'balance'])
      if (available === null) nothing()
      return money(available, 'USD')
    },
  },
  {
    // Only some New-API variants answer this without a panel access token; a
    // genuine panel needs `sk-` plus a console session, which this plugin does
    // not have and will not try to obtain.
    id: 'new-api-user-self',
    label: 'New-API /api/user/self',
    path: '{origin}/api/user/self',
    parse(body, cal) {
      const data = pick(body, 'data') ?? body
      const quota = firstNum(data, ['quota', 'remain_quota'])
      if (quota === null) nothing()
      const used = firstNum(data, ['used_quota', 'used'])
      const { amount, currency } = fromQuotaUnits(quota, cal)
      const detail = used === null
        ? []
        : [{ label: '已用', value: fromQuotaUnits(used, cal).amount.toFixed(2) }]
      return money(amount, currency, detail)
    },
  },
]

/**
 * Extract quota windows from a shape with no documented contract.
 * @param {unknown} body
 * @returns {{key: string, label: string, used: number | null, limit: number | null, remainingPct: number | null}[]}
 */
function scanWindows(body) {
  const nodes = findObjects(body, (node) => {
    const pair = num(node.used) !== null && num(node.limit) !== null
    const pct = num(node.percentage) !== null || num(node.used_percent) !== null
    const remaining = num(node.remaining) !== null
    return pair || pct || remaining
  })
  const windows = nodes.map((node, index) => {
    const used = num(node.used) ?? num(node.usage)
    const limit = num(node.limit) ?? num(node.total)
    const percentage = num(node.percentage) ?? num(node.used_percent)
    let remainingPct = null
    if (used !== null && limit !== null && limit > 0) remainingPct = clampPct((1 - used / limit) * 100)
    else if (percentage !== null) remainingPct = clampPct(100 - percentage)
    else {
      const remaining = num(node.remaining)
      const total = num(node.total)
      if (remaining !== null && total !== null && total > 0) remainingPct = clampPct((remaining / total) * 100)
    }
    return {
      key: `w${index}`,
      label: firstString(node, ['window', 'period', 'name', 'label', 'type']) ?? `窗口 ${index + 1}`,
      used,
      limit,
      remainingPct,
    }
  })
  const seen = new Set()
  return windows.filter((w) => {
    const key = `${w.label}|${w.used}|${w.limit}|${w.remainingPct}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * A user-supplied endpoint, tried before the presets.
 *
 * Its shape is whatever the user's gateway returns, so the parser looks for the
 * common money fields first and falls back to scanning for quota windows.
 * @param {string} template
 * @returns {Preset}
 */
function userEndpointPreset(template) {
  return {
    id: 'user-endpoint',
    label: '自定义接口',
    path: template,
    parse(body) {
      const available = firstNum(body, [
        'data.total_available', 'data.balance', 'data.available_balance',
        'total_available', 'balance', 'available_balance', 'remaining', 'data.remaining',
      ])
      if (available !== null) {
        const granted = firstNum(body, ['data.total_granted', 'total_granted', 'data.balance', 'balance'])
        const used = firstNum(body, ['data.total_used', 'total_used', 'used'])
        const detail = []
        if (granted !== null && granted !== available) detail.push({ label: '总额', value: String(granted) })
        if (used !== null) detail.push({ label: '已用', value: String(used) })
        return money(available, null, detail)
      }
      return quota(scanWindows(body))
    },
  }
}

/**
 * Expand a path template against a route's base URL.
 * @param {string} template
 * @param {string} base
 * @returns {string}
 */
function expand(template, base) {
  let origin = base
  try {
    const parsed = new URL(base)
    origin = `${parsed.protocol}//${parsed.host}`
  } catch {
    // An unparseable base leaves the template unresolved, and the request below
    // fails as a network error rather than being sent somewhere unintended.
  }
  return template.replace(/\{origin\}/g, origin).replace(/\{base\}/g, base)
}

/**
 * Cut a response body down to a safe echo.
 * @param {string} text
 * @returns {string}
 */
function echo(text) {
  const value = String(text)
  // Reuse the query layer's redaction by importing lazily is not possible here
  // without a cycle, so apply the same key-shape masking inline.
  const masked = value
    .replace(/\b(sk|pk|rk|xai|gsk|hf)-[A-Za-z0-9_-]{6,}/gi, '$1-***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi, 'Bearer ***')
    .replace(/("(?:api[_-]?key|key|token|secret|authorization)"\s*:\s*)"[^"]*"/gi, '$1"***"')
  return masked.length <= ECHO_LIMIT ? masked : `${masked.slice(0, ECHO_LIMIT)}…（已截断）`
}

/**
 * Probe a route's host with the preset chain.
 *
 * Presets are tried in order and the first that yields a figure wins. A 401 or
 * 403 means the credential is refused, which stops the chain: every remaining
 * path would use the same credential. A 404 means this panel simply is not that
 * kind of panel, so the chain continues.
 *
 * @param {object} input
 * @param {string} input.baseURL
 * @param {string} input.apiKey
 * @param {typeof fetch} input.fetchImpl
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.timeoutMs]
 * @returns {Promise<{status: string, result: object | null, url: string | null, message: string | null, raw: string | null}>}
 */
export async function runPresetQuery(input) {
  const { baseURL, apiKey, fetchImpl } = input
  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 8000
  if (typeof baseURL !== 'string' || baseURL === '') {
    return {
      status: STATUS.UNKNOWN_PROVIDER,
      result: null,
      url: null,
      message: '该路由没有已知的网关地址，也没有内置目录条目，因此无法探测余额接口。'
        + '可在插件配置的 routes 里为它填 baseURL 与 endpoint。',
      raw: null,
    }
  }

  // An endpoint the user set outranks every guess: they know their gateway.
  const chain = typeof input.endpoint === 'string' && input.endpoint.trim() !== ''
    ? [userEndpointPreset(input.endpoint.trim()), ...PRESETS]
    : PRESETS

  let calibration = { perUnit: null, display: null }
  let lastRaw = null
  let lastUrl = null
  let sawRefusal = false

  for (const preset of chain) {
    const url = expand(preset.path, baseURL)
    lastUrl = url

    const call = async (target, header) => {
      const response = await fetchImpl(target, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(header === undefined
            ? { authorization: `Bearer ${apiKey}` }
            : { [header.name]: `${header.scheme}${apiKey}` }),
        },
        signal: withTimeout(input.signal, timeoutMs),
      })
      const text = await response.text()
      return { response, text }
    }

    try {
      // The unauthenticated calibration read happens once, before any preset
      // needs it, and a failure there is not a reason to skip the preset.
      if (preset.statusPath !== undefined && calibration.perUnit === null) {
        try {
          const probe = await call(expand(preset.statusPath, baseURL), undefined)
          if (probe.response.ok) calibration = readCalibration(safeJson(probe.text))
        } catch {
          // Uncalibrated is a usable state; the figure is then raw units.
        }
      }

      const { response, text } = await call(url, preset.header)
      lastRaw = echo(text)
      if (response.status === 401 || response.status === 403) {
        sawRefusal = true
        break
      }
      if (!response.ok) continue

      const body = safeJson(text)
      if (body === undefined) continue

      let extra
      if (preset.secondPath !== undefined) {
        try {
          const second = await call(expand(preset.secondPath, baseURL), preset.header)
          if (second.response.ok) extra = safeJson(second.text)
        } catch {
          // Without the usage half the subscription figure still stands alone.
        }
      }

      try {
        const result = preset.parse(body, calibration, extra)
        return { status: STATUS.OK, result, url, message: null, raw: null }
      } catch {
        continue
      }
    } catch (error) {
      return {
        status: STATUS.NETWORK_ERROR,
        result: null,
        url,
        message: `探测 ${url} 失败：${error instanceof Error ? error.message : String(error)}`,
        raw: null,
      }
    }
  }

  if (sawRefusal) {
    return {
      status: STATUS.HTTP_ERROR,
      result: null,
      url: lastUrl,
      message: '该路由的网关拒绝了本次凭据。请确认这条路由的 API key 有查询余额的权限。',
      raw: null,
    }
  }

  return {
    status: STATUS.UNKNOWN_PROVIDER,
    result: null,
    url: lastUrl,
    message: `本插件未收录该路由（内置目录里没有它），`
      + `也已按 ${chain.length} 条常见中转站接口依次探测过，都没有返回可读的余额或额度。`
      + '这不代表该供应商没有余额接口——可在插件配置的 routes 里为它填一条自定义接口'
      + '（用 balance_set_endpoint 工具，或直接编辑 profile 的 cordis.patch.yml）。',
    raw: lastRaw,
  }
}

/**
 * Parse JSON without throwing.
 * @param {string} text
 * @returns {unknown}
 */
function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Combine the caller's signal with a timeout.
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}
