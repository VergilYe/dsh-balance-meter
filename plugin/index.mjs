/**
 * dsh-balance-meter — host half.
 *
 * A standard DSH plugin: named exports `name` / `inject` / `Config` / `apply`,
 * tools built with the official `defineTool` and registered through
 * `ctx.tools.register`.
 *
 * What it deliberately does NOT do, and why: it spawns no subprocess and
 * requests no `exec:*` capability (the reference CC GUI plugin had to, because
 * that host's network egress required a declared domain and its credentials
 * live in files). DSH exposes both natively — `ctx.credentials` for secrets and
 * a plain `fetch` inside the host process — so the whole query path is a normal
 * outbound HTTPS request to a vendor domain listed in catalog.mjs.
 *
 * Refresh policy: the host owns no timer. The header chip polls the snapshot
 * route, and this half decides per poll whether that poll is allowed to become
 * a real vendor request (`mayAutoRefresh`). Keeping the clock in the browser
 * removes a class of lifecycle bugs, and nothing is lost: the chip is the only
 * thing that cares about freshness, and it is only visible when the page is.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'

import { CATALOG } from './catalog.mjs'
import { runQuery } from './query.mjs'
import { STATUS, createStore } from './state.mjs'
import { collectLlmRows, discoverRoutes, pickPrimaryRoute } from './routes.mjs'

export const name = 'dsh-balance-meter'

/** `tools` is the one hard requirement; everything else is wired opportunistically. */
export const inject = ['tools']

/** Path the browser half fetches. Registered only when a Connection exists. */
export const SNAPSHOT_PATH = '/api/balance-meter/snapshot'

/** Settings namespace of this plugin's own Loader row; the client form keys off it. */
export const ENTRY_NS = 'balance-meter'

/**
 * Mark a schema field volatile so the Plugins-page form can edit it live.
 *
 * On DSH >= 0.2 a volatile field resolves to a frozen `{ get() }` reference
 * updated in place; on older schemastery builds it is the plain value. Callers
 * must read through `read()` either way.
 * @param {object} field
 * @returns {object}
 */
function volatileField(field) {
  return typeof field.volatile === 'function' ? field.volatile() : field
}

/**
 * Unwrap a config field, whichever shape the runtime gave us.
 * @param {unknown} value
 * @returns {unknown}
 */
function read(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

/**
 * One route override. Deliberately NOT volatile — see `Config` below.
 */
const routeOverrideSchema = Schema.object({
  id: Schema.string().default(''),
  baseURL: Schema.string().default(''),
  apiKeyEnv: Schema.string().default(''),
  endpoint: Schema.string().default(''),
})

/**
 * User-owned configuration. Nothing here is preset by the plugin author beyond
 * behaviour defaults.
 *
 * The scalar fields are volatile so the Plugins-page form can edit them in
 * place. `routes` is deliberately an ordinary field, and that is a hard
 * constraint rather than a preference: schemastery validates every array
 * element as "blocked", so a volatile field can never live inside an array —
 * `routes[].id` as volatile makes the Loader refuse to activate this plugin at
 * all ("volatile fields require a fixed object path"). Only statically declared
 * object paths may be volatile, and route ids are user-chosen, so there is no
 * schema shape that would let route overrides be volatile.
 *
 * The consequence: `balance_set_endpoint` writes `routes` through
 * `configEditor.edit`, which reconciles the row through the Loader's normal
 * lifecycle instead of updating it in place.
 */
export const Config = Schema.object({
  routes: Schema.array(routeOverrideSchema).default([]),
  primary: volatileField(Schema.string().default('')),
  autoRefresh: volatileField(Schema.boolean().default(true)),
  minIntervalSec: volatileField(Schema.number().default(30)),
  timeoutMs: volatileField(Schema.number().default(8000)),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  const tools = ctx.tools
  if (tools === undefined) return

  const store = createStore({
    minIntervalMs: secondsToMs(read(config.minIntervalSec), 30),
  })

  /** Services that may be absent, populated by the optional injections below. */
  let credentials = undefined
  let llm = undefined
  let connection = undefined
  let configEditor = undefined

  ctx.inject(['credentials'], (cctx) => {
    credentials = cctx.credentials
  })
  ctx.inject(['llm'], (cctx) => {
    llm = cctx.llm
  })
  ctx.inject(['connection'], (cctx) => {
    connection = cctx.connection
  })
  ctx.inject(['configEditor'], (cctx) => {
    configEditor = cctx.configEditor
  })

  // ── configuration reads ──────────────────────────────────────────────────
  /** Read the current value of a config field, tolerating both shapes. */
  const cfg = (key) => read(config[key])

  /** The user's route overrides, normalised to plain objects. */
  function routeOverrides() {
    const raw = cfg('routes')
    if (!Array.isArray(raw)) return []
    return raw
      .map((row) => (row === null || typeof row !== 'object' ? null : {
        id: textOf(read(row.id)),
        baseURL: textOf(read(row.baseURL)),
        apiKeyEnv: textOf(read(row.apiKeyEnv)),
        endpoint: textOf(read(row.endpoint)),
      }))
      .filter((row) => row !== null && row.id !== '')
  }

  // ── route discovery ──────────────────────────────────────────────────────
  /**
   * Collect the profile's `llm-*` rows from the config editor when it is
   * available. This is the fallback for adapters that do not surface `baseURL`
   * or `apiKeyEnv` through `listProviders()`.
   * @returns {Map<string, { baseURL: string | null, apiKeyEnv: string | null }>}
   */
  function llmRowInfo() {
    const editor = configEditor
    if (editor === undefined || editor === null) return new Map()
    try {
      const entries = typeof editor.entries === 'function' ? editor.entries() : []
      const rows = entries.map((entry) => ({
        id: entry?.options?.id,
        name: entry?.options?.name,
        config: entry?.options?.config,
      }))
      const collected = collectLlmRows(rows)
      // `configuration()` merges every layer, so prefer it when present: it
      // sees values a row's own `options.config` may not carry.
      if (typeof editor.configuration === 'function') {
        try {
          for (const row of editor.configuration() ?? []) {
            const name = row?.entry?.options?.name
            const inherited = row?.inherited
            if (inherited === null || typeof inherited !== 'object') continue
            for (const [providerId, info] of collectLlmRows([{ id: row?.entry?.options?.id, name, config: inherited }])) {
              const existing = collected.get(providerId)
              collected.set(providerId, {
                baseURL: info.baseURL ?? existing?.baseURL ?? null,
                apiKeyEnv: info.apiKeyEnv ?? existing?.apiKeyEnv ?? null,
              })
            }
          }
        } catch {
          // A configuration read that drifts must not cost the routes we
          // already collected from the entries themselves.
        }
      }
      return collected
    } catch {
      return new Map()
    }
  }

  /** Discover the routes to display and query. */
  function routes() {
    const providers = (() => {
      const service = llm
      if (service === undefined || service === null) return []
      try {
        return typeof service.listProviders === 'function' ? service.listProviders() ?? [] : []
      } catch {
        return []
      }
    })()
    return discoverRoutes({ providers, llmRows: llmRowInfo(), overrides: routeOverrides() })
  }

  /** Ensure every known route has a state row, so the snapshot is complete. */
  function knownRoutes() {
    const list = routes()
    for (const route of list) store.get(route.id)
    return list
  }

  // ── querying ─────────────────────────────────────────────────────────────
  /**
   * Resolve the credential for a route.
   *
   * The name comes from the route (override → adapter → catalog), and an
   * unparseable name is reported as "not set" rather than thrown — a provider
   * library may hand us a name outside the reference grammar, which has no
   * reference to miss.
   * @param {{ id: string, apiKeyEnv: string | null, entry?: object }} route
   * @returns {Promise<{ value: string | null, name: string | null }>}
   */
  async function resolveKey(route) {
    const name = route.apiKeyEnv
    if (name === null || name === '' || !isCredentialRefName(name)) return { value: null, name }
    const service = credentials
    if (service === undefined || service === null) return { value: null, name }
    try {
      const hit = await service.resolve(credentialRef(name))
      const value = hit !== null && typeof hit === 'object' ? hit.value : undefined
      return { value: typeof value === 'string' && value !== '' ? value : null, name }
    } catch {
      return { value: null, name }
    }
  }

  /**
   * Query one route and record the outcome. Concurrent callers share one
   * request through the store's coalescing.
   * @param {object} route
   * @param {{ timeoutMs?: number }} [options]
   */
  function queryRoute(route, options = {}) {
    const key = route.id
    return store.coalesce(key, async () => {
      if (route.entry === undefined) {
        store.recordFailure(key, {
          status: STATUS.UNKNOWN_PROVIDER,
          message:
            `本插件未收录路由「${route.id}」。这不代表该供应商没有余额接口，`
            + '只是它不在本插件的目录里；可在插件配置的 routes 里为它填一条自定义接口。',
        })
        return store.get(key)
      }

      const { value: apiKey, name: apiKeyEnv } = await resolveKey(route)
      const outcome = await runQuery({
        entry: route.entry,
        route: { id: route.id, baseURL: route.baseURL ?? undefined, endpoint: route.endpoint ?? undefined },
        apiKey,
        apiKeyEnv,
        fetchImpl: fetch,
        timeoutMs: options.timeoutMs ?? timeoutMs(),
      })

      if (outcome.status === STATUS.OK) {
        store.recordSuccess(key, { result: outcome.result, url: outcome.url })
      } else {
        store.recordFailure(key, {
          status: outcome.status,
          message: outcome.message ?? '查询失败。',
          url: outcome.url,
          raw: outcome.raw,
        })
      }
      return store.get(key)
    })
  }

  /** The configured request timeout, clamped to something sane. */
  function timeoutMs() {
    const value = Number(cfg('timeoutMs'))
    return Number.isFinite(value) && value > 0 ? Math.min(value, 60_000) : 8000
  }

  /** The interval below which an automatic refresh is skipped. */
  function minIntervalMs() {
    return secondsToMs(cfg('minIntervalSec'), 30)
  }

  /**
   * Refresh a set of routes, subject to the auto-refresh policy.
   * @param {{ routes?: object[], force?: boolean, only?: string }} [input]
   * @returns {Promise<object[]>}
   */
  async function refresh(input = {}) {
    const list = input.routes ?? knownRoutes()
    const selected = input.only === undefined || input.only === ''
      ? list
      : list.filter((route) => route.id === input.only)

    if (input.force === true) {
      for (const route of selected) store.clearCooldown(route.id)
    } else if (cfg('autoRefresh') === false) {
      return selected.map((route) => store.get(route.id))
    }

    // Sequential on purpose: eight parallel vendor calls on a poll would be
    // needlessly bursty, and the chip only needs the primary route promptly.
    const results = []
    for (const route of selected) {
      if (input.force !== true && !store.mayAutoRefresh(route.id, minIntervalMs())) {
        results.push(store.get(route.id))
        continue
      }
      results.push(await queryRoute(route, { timeoutMs: timeoutMs() }))
    }
    return results
  }

  /**
   * Refresh only the route the chip describes, which is the one worth keeping
   * fresh automatically. The rest are refreshed on demand.
   * @param {boolean} force
   */
  async function refreshPrimary(force) {
    const primary = pickPrimaryRoute(knownRoutes(), textOf(cfg('primary')))
    if (primary === null) return
    await refresh({ routes: [primary], force })
  }

  // ── tools ────────────────────────────────────────────────────────────────
  const balanceCheckTool = defineTool({
    name: 'balance_check',
    description:
      'Query the API balance or subscription quota of an LLM provider route configured in '
      + 'this DSH profile. Reports the vendor, billing mode, remaining amount or quota windows, '
      + 'the endpoint used, and when it was read. '
      + 'Use it when the user asks how much credit or quota is left. '
      + 'When the result has a non-ok status, report its `message` to the user verbatim — do NOT '
      + 'guess, estimate, or infer a number the tool did not return, and do not describe a '
      + '"no credential" or "not catalogued" result as the vendor lacking an endpoint.',
    parameters: {
      route: {
        type: 'string',
        description:
          'Provider route id to query, e.g. "deepseek". Omit to query the primary route shown in the header.',
      },
      refresh: {
        type: 'boolean',
        description:
          'Force a fresh vendor request, bypassing the failure cooldown. Use when the user explicitly asks for an up-to-date figure.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const list = knownRoutes()
      const wanted = textOf(args.route)
      const targets = wanted === ''
        ? [pickPrimaryRoute(list, textOf(cfg('primary')))].filter((route) => route !== null)
        : list.filter((route) => route.id === wanted)

      if (targets.length === 0) {
        return JSON.stringify({
          status: 'unknown-route',
          message: wanted === ''
            ? '当前 profile 里没有发现任何已注册的模型路由。'
            : `没有找到路由「${wanted}」。已知路由：${list.map((route) => route.id).join('、') || '（无）'}。`,
          routes: list.map((route) => route.id),
        }, null, 2)
      }

      if (args.refresh === true) {
        for (const route of targets) store.clearCooldown(route.id)
      }
      const states = await refresh({ routes: targets, force: args.refresh === true })
      const payload = states.map((state) => {
        const route = targets.find((candidate) => candidate.id === state.key)
        return describe(route, state)
      })
      return JSON.stringify(payload.length === 1 ? payload[0] : { results: payload }, null, 2)
    },
  })

  const setEndpointTool = defineTool({
    name: 'balance_set_endpoint',
    description:
      'Persist a custom balance endpoint for one provider route into this profile\'s plug-in '
      + 'configuration, applied immediately. Use it when a vendor moved its endpoint, or when a '
      + 'route is not in the built-in catalog. The template may contain {origin} (scheme and host '
      + 'of the route) and {base} (the route base URL).',
    parameters: {
      route: {
        type: 'string',
        required: true,
        description: 'Provider route id the endpoint belongs to, e.g. "deepseek".',
      },
      endpoint: {
        type: 'string',
        required: true,
        description: 'Endpoint template, e.g. "{origin}/user/balance". Empty string clears the override.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const routeId = textOf(args.route)
      const endpoint = textOf(args.endpoint)
      if (routeId === '') return '必须给出路由 id。'

      const editor = configEditor
      const own = ownEntry(editor)
      if (own === undefined) {
        return '无法定位本插件的配置条目（可能由 home patch 或命令行 overlay 拥有）。'
          + '请手工在本 profile 的 cordis.patch.yml 中，给 balance-meter 那一行加 config.routes 覆盖。'
      }

      try {
        await editor.edit(own, (previous) => {
          const base = previous !== null && typeof previous === 'object' ? previous : {}
          const existing = Array.isArray(base.routes) ? base.routes : []
          const others = existing.filter((row) => textOf(read(row?.id)) !== routeId)
          const prior = existing.find((row) => textOf(read(row?.id)) === routeId) ?? {}
          const next = endpoint === ''
            ? others
            : [...others, {
              id: routeId,
              baseURL: textOf(read(prior.baseURL)),
              apiKeyEnv: textOf(read(prior.apiKeyEnv)),
              endpoint,
            }]
          return { ...base, routes: next }
        })
      } catch (error) {
        return `写入配置失败：${error instanceof Error ? error.message : String(error)}`
      }

      // The endpoint changed, so the previous reading is no longer evidence of
      // anything; drop the cooldown so the next call re-queries.
      store.clearCooldown(routeId)
      return endpoint === ''
        ? `已清除路由 ${routeId} 的自定义接口。`
        : `已把路由 ${routeId} 的接口设为 ${endpoint}，立即生效。`
    },
  })

  ctx.effect(() => tools.register(balanceCheckTool), 'balance-meter: balance_check')
  ctx.effect(() => tools.register(setEndpointTool), 'balance-meter: balance_set_endpoint')

  // ── snapshot route for the browser half ──────────────────────────────────
  // Registered inside the Connection's authentication fence, so only an
  // authenticated page of this host can read it. Absent in a headless profile,
  // where the tools still work.
  ctx.inject(['connection'], (cctx) => {
    const conn = cctx.connection
    if (conn === undefined || conn === null || conn.fetch === undefined) return
    try {
      cctx.effect(() => conn.fetch.register({
        path: SNAPSHOT_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleSnapshot(request),
      }), 'balance-meter: snapshot route')
    } catch (error) {
      warn(ctx, `snapshot route registration skipped: ${errorMessage(error)}`)
    }
  })

  /**
   * Answer one snapshot request.
   *
   * `?refresh=1` asks for a fresh reading: the primary route is re-queried when
   * policy allows, and the response always carries the current cache either way.
   * The route never returns 5xx — a vendor problem is data (`status`), not a
   * transport failure, so the chip can render the reason.
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handleSnapshot(request) {
    const url = new URL(request.url)
    const wantsRefresh = url.searchParams.get('refresh') === '1'
    const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' }
    try {
      const all = knownRoutes()
      if (wantsRefresh) {
        // A manual refresh re-reads every catalogued route, because the user
        // opening the detail popover wants all of them current, not just the chip.
        await refresh({ force: true })
      } else {
        await refreshPrimary(false)
      }
      const list = knownRoutes()
      const primary = pickPrimaryRoute(list, textOf(cfg('primary')))
      return Response.json({
        primary: primary === null ? null : primary.id,
        routes: list.map((route) => describeRoute(route)),
        states: store.snapshot(),
        autoRefresh: cfg('autoRefresh') !== false,
        minIntervalSec: Math.round(minIntervalMs() / 1000),
        catalogSize: CATALOG.length,
        known: all.length,
      }, { headers })
    } catch (error) {
      return Response.json({
        primary: null,
        routes: [],
        states: [],
        error: `快照生成失败：${errorMessage(error)}`,
      }, { headers })
    }
  }

  // ── shared shaping ───────────────────────────────────────────────────────
  /**
   * Describe a route as plain data for the browser half.
   *
   * Never includes a credential value — only the variable name the key would
   * come from. The browser half has no business holding a secret.
   * @param {object} route
   */
  function describeRoute(route) {
    return {
      key: route.id,
      id: route.id,
      label: route.label,
      billing: route.entry?.billing ?? null,
      catalogued: route.catalogued,
      apiKeyEnv: route.apiKeyEnv,
      source: route.source,
      endpoint: route.endpoint,
      note: route.entry?.note ?? '',
    }
  }

  /**
   * Describe a route plus its latest state, for a tool result.
   * @param {object} route
   * @param {object} state
   */
  function describe(route, state) {
    const base = {
      route: route.id,
      provider: route.label,
      billing: route.entry?.billing ?? null,
      status: state.status,
      endpoint: state.url ?? null,
      queriedAt: state.queriedAt === null ? null : new Date(state.queriedAt).toISOString(),
      message: state.message,
    }
    if (state.status !== STATUS.OK || state.result === null) {
      return { ...base, raw: state.raw ?? undefined }
    }
    return {
      ...base,
      display: state.result.display,
      currency: state.result.currency,
      amount: state.result.amount,
      detail: state.result.detail,
      windows: state.result.windows ?? [],
    }
  }

  /**
   * Locate this plugin's own Loader row, which is what `configEditor.edit`
   * addresses.
   * @param {object} editor
   */
  function ownEntry(editor) {
    if (editor === undefined || editor === null || typeof editor.edit !== 'function') return undefined
    try {
      const own = ctx.fiber !== undefined && ctx.fiber.entry !== undefined ? ctx.fiber.entry : null
      const rows = typeof editor.entries === 'function' ? editor.entries() : []
      return rows.find((row) => row === own)
        ?? rows.find((row) => row?.options?.id === ENTRY_NS)
        ?? rows.find((row) => row?.options?.name === 'dsh-balance-meter')
    } catch {
      return undefined
    }
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Convert a possibly-odd seconds value to milliseconds.
 * @param {unknown} value
 * @param {number} fallbackSeconds
 * @returns {number}
 */
function secondsToMs(value, fallbackSeconds) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackSeconds * 1000
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Log without letting a logging failure escape.
 * @param {object} ctx
 * @param {string} message
 */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`[balance-meter] ${message}`)
  } catch {
    // A logger that is missing or broken must not be the reason a plugin fails.
  }
}

