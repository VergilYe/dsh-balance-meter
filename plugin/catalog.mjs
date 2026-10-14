/**
 * Built-in provider catalog — pure data plus matching. No I/O, no ctx.
 *
 * Scope is deliberately narrow: only providers whose *official* domain exposes
 * a documented balance/quota endpoint. Relay stations and self-hosted gateways
 * are NOT probed (see the design spec, §5) — a route that does not match a
 * catalog entry is reported as `unknown-provider`, which means "this plugin has
 * not catalogued it", never "the vendor has no endpoint".
 *
 * Endpoint templates use `{origin}` (scheme://host of the live route) rather
 * than `{base}`, so they stay correct regardless of which path segment the
 * route's baseURL happens to include. `{base}` is supported too, for endpoints
 * a user supplies through config.
 */

/** @typedef {'api' | 'subscription'} Billing */

/**
 * @typedef {object} CatalogEntry
 * @property {string} id            Stable key; a DSH provider id that matches exactly wins over host matching.
 * @property {string} label         Human-facing vendor name.
 * @property {string[]} hosts       Hostnames that identify this vendor, including aliases.
 * @property {string} baseURL       Official base URL, used when the route does not expose one.
 * @property {string[]} env         Credential variable names to try, in order.
 * @property {string | null} endpoint  Balance endpoint template; null when the vendor has no public one.
 * @property {Billing} billing
 * @property {string} adapter       Response parser name in parse.mjs.
 * @property {string} note          Deterministic copy shown when the endpoint is null.
 */

/** @type {CatalogEntry[]} */
export const CATALOG = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hosts: ['api.deepseek.com'],
    baseURL: 'https://api.deepseek.com',
    env: ['DEEPSEEK_API_KEY'],
    endpoint: '{origin}/user/balance',
    billing: 'api',
    adapter: 'deepseek',
    note: '',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hosts: ['openrouter.ai'],
    baseURL: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    // /api/v1/credits needs a Management key and 403s for ordinary keys, so the
    // per-key limit from /api/v1/key is the only endpoint that works here.
    endpoint: '{origin}/api/v1/key',
    billing: 'api',
    adapter: 'openrouter',
    note: '',
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    hosts: ['api.moonshot.cn', 'api.moonshot.ai'],
    baseURL: 'https://api.moonshot.cn/v1',
    env: ['MOONSHOT_API_KEY'],
    endpoint: '{origin}/v1/users/me/balance',
    billing: 'api',
    adapter: 'moonshot',
    note: '',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    hosts: ['api.siliconflow.cn', 'api.siliconflow.com'],
    baseURL: 'https://api.siliconflow.cn/v1',
    env: ['SILICONFLOW_API_KEY'],
    endpoint: '{origin}/v1/user/info',
    billing: 'api',
    adapter: 'siliconflow',
    note: '',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM / Z.AI',
    hosts: ['open.bigmodel.cn', 'api.z.ai'],
    baseURL: 'https://open.bigmodel.cn/api',
    env: ['ZHIPU_API_KEY', 'ZAI_API_KEY'],
    endpoint: '{origin}/api/monitor/usage/quota/limit',
    billing: 'subscription',
    adapter: 'zhipu',
    note: '',
  },
  {
    id: 'kimi-coding',
    label: 'Kimi Coding',
    hosts: ['api.kimi.com'],
    baseURL: 'https://api.kimi.com',
    env: ['KIMI_API_KEY', 'KIMI_CODE_API_KEY'],
    endpoint: '{origin}/coding/v1/usages',
    billing: 'subscription',
    adapter: 'kimiCoding',
    note: '',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    hosts: ['api.minimaxi.com', 'api.minimax.io', 'api.minimax.chat'],
    baseURL: 'https://api.minimaxi.com',
    env: ['MINIMAX_API_KEY'],
    endpoint: '{origin}/v1/token_plan/remains',
    billing: 'subscription',
    adapter: 'minimax',
    note: '',
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    hosts: ['opencode.ai'],
    baseURL: 'https://opencode.ai',
    env: ['OPENCODE_GO_API_KEY'],
    endpoint: '{origin}/zen/go/v1/usage',
    billing: 'subscription',
    adapter: 'opencodeGo',
    note: '',
  },
]

/** Hostnames inside the catalog, i.e. the complete set this plugin will contact. */
export const ALLOWED_HOSTS = Object.freeze(
  [...new Set(CATALOG.flatMap((entry) => entry.hosts))].sort(),
)

/**
 * Look up a catalog entry by id.
 * @param {string} id
 * @returns {CatalogEntry | undefined}
 */
export function findById(id) {
  if (typeof id !== 'string' || id === '') return undefined
  return CATALOG.find((entry) => entry.id === id)
}

/**
 * Read the hostname of a URL without throwing on malformed input.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function hostOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    return url.hostname.toLowerCase() || undefined
  } catch {
    return undefined
  }
}

/**
 * Strip trailing slashes so joining never produces a doubled separator.
 * @param {string} value
 * @returns {string}
 */
function trimTrailing(value) {
  return value.replace(/\/+$/, '')
}

/**
 * Match a live route to a catalog entry. An exact provider-id match wins over a
 * host match, because a user may point a vendor's id at a different gateway.
 * @param {{ id?: string, baseURL?: string }} route
 * @returns {{ entry: CatalogEntry, matchedBy: 'id' | 'host' } | undefined}
 */
export function matchRoute(route) {
  if (route === null || typeof route !== 'object') return undefined
  const byId = findById(route.id)
  if (byId !== undefined) return { entry: byId, matchedBy: 'id' }
  const host = hostOf(route.baseURL)
  if (host === undefined) return undefined
  const byHost = CATALOG.find((entry) => entry.hosts.includes(host))
  return byHost === undefined ? undefined : { entry: byHost, matchedBy: 'host' }
}

/**
 * Build the concrete URLs to try for a route, in order.
 *
 * A catalog vendor has exactly one candidate, so a failure is reported rather
 * than probed around. A user-supplied endpoint is appended as a second
 * candidate and tried first, because an explicit override outranks the default.
 * @param {CatalogEntry} entry
 * @param {{ baseURL?: string, endpoint?: string }} [override]
 * @returns {string[]}
 */
export function candidateURLs(entry, override = {}) {
  const base = trimTrailing(
    typeof override.baseURL === 'string' && override.baseURL !== '' ? override.baseURL : entry.baseURL,
  )
  let origin = base
  try {
    const parsed = new URL(base)
    origin = `${parsed.protocol}//${parsed.host}`
  } catch {
    // A base that is not a URL cannot yield a trustworthy origin; the
    // unresolved template below will fail URL parsing and be reported instead.
  }

  const expand = (template) =>
    template.replace(/\{origin\}/g, origin).replace(/\{base\}/g, base)

  const urls = []
  if (typeof override.endpoint === 'string' && override.endpoint.trim() !== '') {
    urls.push(expand(override.endpoint.trim()))
  }
  if (entry.endpoint !== null) urls.push(expand(entry.endpoint))
  return [...new Set(urls)]
}
