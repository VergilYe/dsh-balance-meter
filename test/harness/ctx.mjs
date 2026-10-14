/**
 * A minimal stand-in for the DSH plugin context.
 *
 * Implements only the cordis surface `apply()` touches: `tools.register`,
 * `inject`, `effect`, `logger`, and `fiber`. Anything a test needs from a
 * service is passed in through `services`, so each test states exactly which
 * part of the runtime it is pretending to be.
 */

/**
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.services] Services `inject` may provide.
 * @param {object[]} [options.entries] Loader rows `configEditor.entries()` returns.
 * @returns {{ ctx: object, registered: object[], effects: object[], restore: () => void }}
 */
export function makeCtx(options = {}) {
  const services = options.services ?? {}
  const registered = []
  const effects = []

  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {
          const index = registered.indexOf(tool)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    logger: { warn() {}, info() {}, error() {} },
    fiber: { entry: options.entries?.[0] },
    /**
     * Run `callback` when every named service is present, mirroring cordis's
     * all-or-nothing injection.
     * @param {string[]} names
     * @param {(ctx: object) => unknown} callback
     */
    inject(names, callback) {
      const bag = {}
      for (const name of names) {
        if (services[name] === undefined) return () => {}
        bag[name] = services[name]
      }
      const child = { ...ctx, ...bag }
      const produced = callback(child)
      return () => {
        if (typeof produced === 'function') produced()
      }
    },
    /** Run the effect body and keep its disposer for teardown. */
    effect(body, label) {
      const disposer = typeof body === 'function' ? body() : undefined
      const row = { label, disposer }
      effects.push(row)
      return () => {
        if (typeof disposer === 'function') disposer()
        const index = effects.indexOf(row)
        if (index >= 0) effects.splice(index, 1)
      }
    },
  }

  return {
    ctx,
    registered,
    effects,
    /** Tear everything down, as unloading the plugin row would. */
    restore() {
      for (const row of [...effects].reverse()) {
        if (typeof row.disposer === 'function') row.disposer()
      }
      effects.length = 0
    },
  }
}

/**
 * Install a fetch stub, returning a handle that records calls and restores the
 * previous global afterwards.
 * @param {(url: string, init: object) => Response | Promise<Response>} handler
 */
export function stubGlobalFetch(handler) {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = previous
    },
  }
}

/**
 * Build a JSON response.
 * @param {unknown} body
 * @param {number} [status]
 */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
