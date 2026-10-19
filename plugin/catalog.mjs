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
 *
 * One class of provider does not fit that model: `CONTROL_ENTRIES` below, whose
 * billing lives on a different host than the inference gateway the route names.
 * They are kept in a separate list so the origin-template invariant above stays
 * literally true of every entry in this one.
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

/**
 * Providers that are NOT origin-template endpoints.
 *
 * These are listed apart from `CATALOG` on purpose, because they break the one
 * invariant the catalog exists to guarantee: that a reading comes from the
 * route's own host. OpenDesign is the case that forced the split — the route's
 * baseURL is Link (`amr-link.open-design.ai`, inference only, every billing
 * path 404s there), while the account's quota and wallet live on the separate
 * control plane `amr-api.open-design.ai`. No `{origin}` template can express
 * "a different host", so these rows carry `controlPlane: true` and the host
 * adapter in `opendesign.mjs` answers them.
 *
 * They also differ in credential: nothing here reads the DSH-held runtime key,
 * which the vendor refuses for billing. `env` stays empty for that reason.
 *
 * @type {(CatalogEntry & { controlPlane: true, env: string[] })[]}
 */
export const CONTROL_ENTRIES = [
  {
    id: 'opendesign',
    label: 'OpenDesign (AMR)',
    hosts: ['amr-link.open-design.ai', 'amr-api.open-design.ai'],
    baseURL: 'https://amr-link.open-design.ai/v1',
    env: [],
    endpoint: null,
    billing: 'subscription',
    adapter: 'opendesignControl',
    note: '',
    controlPlane: true,
  },
]

/** Every entry this plugin knows, catalogued or control-plane. */
const ALL_ENTRIES = [...CATALOG, ...CONTROL_ENTRIES]

/** Hostnames this plugin may contact, i.e. the complete set crossed by any read. */
export const ALLOWED_HOSTS = Object.freeze(
  [...new Set(ALL_ENTRIES.flatMap((entry) => entry.hosts))].sort(),
)

/**
 * Look up an entry by id, catalogued first.
 * @param {string} id
 * @returns {CatalogEntry | undefined}
 */
export function findById(id) {
  if (typeof id !== 'string' || id === '') return undefined
  return ALL_ENTRIES.find((entry) => entry.id === id)
}

/**
 * True for an entry answered by a host adapter rather than an origin template.
 * @param {CatalogEntry | undefined} entry
 * @returns {boolean}
 */
export function isControlPlane(entry) {
  return entry !== undefined && entry !== null && entry.controlPlane === true
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
 * Suffixes an adapter appends to a vendor id to name its own route kind —
 * `deepseek-official`, `deepseek-account`, `moonshot-api-key`. Stripping them
 * lets the vendor's own extra routes resolve to its catalogue entry instead of
 * reporting "not catalogued" when the vendor is plainly known.
 */
const ID_SUFFIXES = ['-official', '-account', '-api-key', '-apikey', '-key']

/**
 * Every id form that should resolve to a catalogue entry, most specific first.
 * @param {unknown} id
 * @returns {string[]}
 */
function idCandidates(id) {
  if (typeof id !== 'string' || id === '') return []
  const forms = [id]
  for (const suffix of ID_SUFFIXES) {
    if (id.endsWith(suffix)) forms.push(id.slice(0, -suffix.length))
  }
  return forms
}

/**
 * Match a live route to a catalog entry.
 *
 * An id match — exact, then with an adapter suffix stripped — wins over a host
 * match, because a user may point a vendor's id at a different gateway.
 * @param {{ id?: string, baseURL?: string }} route
 * @returns {{ entry: CatalogEntry, matchedBy: 'id' | 'id-alias' | 'host' } | undefined}
 */
export function matchRoute(route) {
  if (route === null || typeof route !== 'object') return undefined
  const candidates = idCandidates(route.id)
  for (const [index, candidate] of candidates.entries()) {
    const hit = findById(candidate)
    if (hit !== undefined) return { entry: hit, matchedBy: index === 0 ? 'id' : 'id-alias' }
  }
  const host = hostOf(route.baseURL)
  if (host === undefined) return undefined
  // Control-plane rows are matched by host too: a user who only set the
  // OpenDesign gateway baseURL should still be identified as OpenDesign, rather
  // than reported as an unknown relay and probed with relay presets.
  const byHost = ALL_ENTRIES.find((entry) => entry.hosts.includes(host))
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
  // A control-plane entry has no template by design (its URL is not derivable
  // from the route), and its adapter builds the real URLs itself. An override
  // is still honoured, so a user can pin an endpoint without this plugin
  // shipping one.
  if (entry.endpoint !== null) urls.push(expand(entry.endpoint))
  return [...new Set(urls)]
}
