/**
 * Integration tests for the host half.
 *
 * These run the real `apply()` against a stubbed context, so they exercise the
 * shipping wiring — tool registration, route discovery, credential resolution,
 * and the snapshot route — rather than a hand-copied model of it.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { apply, name as pluginName, SNAPSHOT_PATH } from '../plugin/index.mjs'
import { jsonResponse, makeCtx, stubGlobalFetch } from './harness/ctx.mjs'

/** Config as DSH would hand it over with no profile overrides. */
function defaultConfig(overrides = {}) {
  return {
    routes: [],
    primary: '',
    autoRefresh: true,
    minIntervalSec: 0,
    timeoutMs: 8000,
    ...overrides,
  }
}

const DEEPSEEK_BODY = { balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] }

/** Build a context with the services a normal profile provides. */
function fullContext(extra = {}, entries = []) {
  return makeCtx({
    entries,
    services: {
      credentials: {
        async resolve(ref) {
          return ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-live-secret', source: 'file' } : undefined
        },
      },
      llm: { listProviders: () => [{ id: 'deepseek' }] },
      connection: {
        fetch: {
          register(route) {
            extra.routes?.push(route)
            return () => {}
          },
        },
      },
      ...extra.services,
    },
  })
}

/** A context that also registers the snapshot route, for route-scoped tests. */
function snapshotContext(providers) {
  const routes = []
  const harness = makeCtx({
    services: {
      credentials: { resolve: async () => ({ value: 'sk-x', source: 'file' }) },
      llm: { listProviders: () => providers },
      connection: { fetch: { register: (route) => routes.push(route) } },
    },
  })
  return { ...harness, routes }
}

/** @type {ReturnType<typeof stubGlobalFetch> | undefined} */
let fetchStub

afterEach(() => {
  fetchStub?.restore()
  fetchStub = undefined
})

/** Find a registered tool by name. */
function toolNamed(registered, toolName) {
  const tool = registered.find((candidate) => candidate.name === toolName)
  assert.ok(tool !== undefined, `tool ${toolName} was not registered`)
  return tool
}

describe('apply — registration', () => {
  it('exports the plugin name DSH addresses it by', () => {
    assert.equal(pluginName, 'dsh-balance-meter')
  })

  it('registers exactly the two documented tools', () => {
    const { ctx, registered } = fullContext()
    apply(ctx, defaultConfig())
    assert.deepEqual(
      registered.map((tool) => tool.name).sort(),
      ['balance_check', 'balance_set_endpoint'],
    )
  })

  it('declares required parameters on balance_set_endpoint', () => {
    const { ctx, registered } = fullContext()
    apply(ctx, defaultConfig())
    const tool = toolNamed(registered, 'balance_set_endpoint')
    assert.equal(tool.parameters.route.required, true)
    assert.equal(tool.parameters.endpoint.required, true)
  })

  it('gives every tool an output renderer, so results reach the model', () => {
    const { ctx, registered } = fullContext()
    apply(ctx, defaultConfig())
    for (const tool of registered) {
      assert.equal(typeof tool.output.render, 'function', `${tool.name} has no render`)
      const blocks = tool.output.render({}, 'hello')
      assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }])
    }
  })

  it('registers the snapshot route on the connection', () => {
    const routes = []
    const { ctx } = fullContext({ routes })
    apply(ctx, defaultConfig())
    assert.equal(routes.length, 1)
    assert.equal(routes[0].path, SNAPSHOT_PATH)
    assert.deepEqual(routes[0].methods, ['GET'])
  })

  it('still registers its tools when no connection exists (headless profile)', () => {
    const { ctx, registered } = makeCtx({ services: { llm: { listProviders: () => [] } } })
    apply(ctx, defaultConfig())
    assert.equal(registered.length, 2)
  })

  it('does not throw when no optional service is present at all', () => {
    const { ctx, registered } = makeCtx()
    assert.doesNotThrow(() => apply(ctx, defaultConfig()))
    assert.equal(registered.length, 2)
  })
})

describe('balance_check — no routes', () => {
  it('says so rather than pretending an amount is unknown', async () => {
    const { ctx, registered } = makeCtx({ services: { llm: { listProviders: () => [] } } })
    apply(ctx, defaultConfig())
    const out = JSON.parse(await toolNamed(registered, 'balance_check').execute({}))
    assert.equal(out.status, 'unknown-route')
    assert.match(out.message, /没有发现任何已注册的模型路由/)
  })

  it('lists the known routes when a named one is missing', async () => {
    const { ctx, registered } = makeCtx({
      services: { llm: { listProviders: () => [{ id: 'deepseek' }] } },
    })
    apply(ctx, defaultConfig())
    const out = JSON.parse(await toolNamed(registered, 'balance_check').execute({ route: 'ghost' }))
    assert.equal(out.status, 'unknown-route')
    assert.match(out.message, /deepseek/)
  })
})

describe('balance_check — success', () => {
  it('returns the parsed reading, the vendor, and the endpoint used', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const { ctx, registered } = fullContext()
    apply(ctx, defaultConfig())
    const out = JSON.parse(await toolNamed(registered, 'balance_check').execute({}))

    assert.equal(out.status, 'ok')
    assert.equal(out.route, 'deepseek')
    assert.equal(out.provider, 'DeepSeek')
    assert.equal(out.billing, 'api')
    assert.equal(out.display, '¥12.34')
    assert.equal(out.amount, 12.34)
    assert.equal(out.endpoint, 'https://api.deepseek.com/user/balance')
    assert.ok(typeof out.queriedAt === 'string')
    assert.equal(fetchStub.calls.length, 1)
  })

  it('sends the resolved credential to the vendor', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const { ctx, registered } = fullContext()
    apply(ctx, defaultConfig())
    await toolNamed(registered, 'balance_check').execute({})
    assert.equal(fetchStub.calls[0].init.headers.authorization, 'Bearer sk-live-secret')
  })

  it('queries a named route on request', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const { ctx, registered } = fullContext()
    apply(ctx, defaultConfig())
    const out = JSON.parse(await toolNamed(registered, 'balance_check').execute({ route: 'deepseek' }))
    assert.equal(out.status, 'ok')
  })
})

describe('balance_check — the four miss levels', () => {
  it('no-credential names the variable to configure', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const { ctx, registered } = fullContext({ services: { credentials: { resolve: async () => undefined } } })
    apply(ctx, defaultConfig())
    const out = JSON.parse(await toolNamed(registered, 'balance_check').execute({}))
    assert.equal(out.status, 'no-credential')
    assert.match(out.message, /DEEPSEEK_API_KEY/)
    assert.equal(fetchStub.calls.length, 0, 'a missing credential must not reach the network')
  })

  it('unknown-provider says "not catalogued", never "the vendor has no endpoint"', async () => {
    // Every preset path 404s: the host answers, but as none of the shapes the
    // plugin knows. That is the state this message is for.
    fetchStub = stubGlobalFetch(() => new Response('', { status: 404 }))
    const { ctx, registered } = makeCtx({
      services: {
        credentials: { resolve: async () => ({ value: 'sk-relay', source: 'file' }) },
        llm: { listProviders: () => [] },
      },
    })
    apply(ctx, defaultConfig({
      routes: [{ id: 'my-relay', baseURL: 'https://relay.example.com', apiKeyEnv: 'RELAY_KEY', endpoint: '' }],
    }))
    const out = JSON.parse(await toolNamed(registered, 'balance_check').execute({}))

    assert.equal(out.status, 'unknown-provider')
    assert.match(out.message, /未收录/)
    assert.match(out.message, /不代表该供应商没有余额接口/)
    assert.ok(fetchStub.calls.length > 1, 'the preset chain should have been tried')
  })

  it('does not send a preset probe without a credential for the route', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const { ctx, registered } = makeCtx({
      services: { llm: { listProviders: () => [{ id: 'my-relay', baseURL: 'https://relay.example.com' }] } },
    })
    apply(ctx, defaultConfig())
    const out = JSON.parse(await toolNamed(registered, 'balance_check').execute({}))
    assert.equal(out.status, 'no-credential')
    assert.equal(fetchStub.calls.length, 0)
  })

  it('parse-failed echoes a redacted response body', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse({ api_key: 'sk-abcdef123456', hello: 'world' }))
    const { ctx, registered } = fullContext()
    apply(ctx, defaultConfig())
    const out = JSON.parse(await toolNamed(registered, 'balance_check').execute({}))
    assert.equal(out.status, 'parse-failed')
    assert.match(out.message, /无法解析/)
    assert.ok(out.raw.includes('hello'))
    assert.ok(!out.raw.includes('sk-abcdef123456'), 'the echoed body must be redacted')
  })

  it('http-error explains a rejected credential', async () => {
    fetchStub = stubGlobalFetch(() => new Response('', { status: 401 }))
    const { ctx, registered } = fullContext()
    apply(ctx, defaultConfig())
    const out = JSON.parse(await toolNamed(registered, 'balance_check').execute({}))
    assert.equal(out.status, 'http-error')
    assert.match(out.message, /拒绝了本次凭据/)
  })
})

describe('snapshot route', () => {
  /** Invoke the registered snapshot handler. */
  async function snapshot(routes, url = `http://localhost${SNAPSHOT_PATH}`) {
    const handler = routes.find((route) => route.path === SNAPSHOT_PATH)
    assert.ok(handler !== undefined, 'snapshot route was not registered')
    const response = await handler.fetch(new Request(url))
    return { response, body: await response.json() }
  }

  it('reports the primary route, the route list, and their states', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const routes = []
    const { ctx } = fullContext({ routes })
    apply(ctx, defaultConfig())
    const { body } = await snapshot(routes)

    assert.equal(body.primary, 'deepseek')
    assert.equal(body.routes.length, 1)
    assert.equal(body.routes[0].id, 'deepseek')
    assert.equal(body.routes[0].label, 'DeepSeek')
    assert.equal(body.states[0].status, 'ok')
    assert.equal(body.states[0].result.display, '¥12.34')
    assert.equal(body.autoRefresh, true)
  })

  it('never leaks a credential value to the browser', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const routes = []
    const { ctx } = fullContext({ routes })
    apply(ctx, defaultConfig())
    const { response, body } = await snapshot(routes)
    const text = JSON.stringify(body) + [...response.headers].flat().join(' ')
    assert.ok(!text.includes('sk-live-secret'), 'the snapshot must not carry a secret')
    assert.equal(body.routes[0].apiKeyEnv, 'DEEPSEEK_API_KEY')
  })

  it('sets a no-store cache header so the chip never reads a stale body', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const routes = []
    const { ctx } = fullContext({ routes })
    apply(ctx, defaultConfig())
    const { response } = await snapshot(routes)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })

  it('does not re-query on a poll inside the throttle window', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const routes = []
    const { ctx } = fullContext({ routes })
    apply(ctx, defaultConfig({ minIntervalSec: 300 }))
    await snapshot(routes)
    await snapshot(routes)
    assert.equal(fetchStub.calls.length, 1, 'the throttle must absorb the second poll')
  })

  it('re-queries on ?refresh=1 even inside the throttle window', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const routes = []
    const { ctx } = fullContext({ routes })
    apply(ctx, defaultConfig({ minIntervalSec: 300 }))
    await snapshot(routes)
    await snapshot(routes, `http://localhost${SNAPSHOT_PATH}?refresh=1`)
    assert.equal(fetchStub.calls.length, 2)
  })

  it('absorbs a vendor failure into the body rather than returning 5xx', async () => {
    fetchStub = stubGlobalFetch(() => {
      throw new Error('offline')
    })
    const routes = []
    const { ctx } = fullContext({ routes })
    apply(ctx, defaultConfig())
    const { response, body } = await snapshot(routes)
    assert.equal(response.status, 200)
    assert.equal(body.states[0].status, 'network-error')
  })

  it('reports an empty route list without throwing', async () => {
    const routes = []
    const { ctx } = makeCtx({ services: { llm: { listProviders: () => [] }, connection: { fetch: { register: (route) => routes.push(route) } } } })
    apply(ctx, defaultConfig())
    const { body } = await snapshot(routes)
    assert.equal(body.primary, null)
    assert.deepEqual(body.routes, [])
  })
})

describe('snapshot route scoping', () => {
  /** Invoke a registered snapshot handler for one route id. */
  async function ask(handler, query) {
    const response = await handler.fetch(new Request(`http://localhost${SNAPSHOT_PATH}${query}`))
    return response.json()
  }

  it('reports only the requested route, not the whole discovered catalogue', async () => {
    // A real profile reports built-in adapters the user never configured.
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const { ctx, routes } = snapshotContext([
      { id: 'deepseek' },
      { id: 'deepseek-official' },
      { id: 'deepseek-account' },
    ])
    apply(ctx, defaultConfig())
    const body = await ask(routes[0], '?route=deepseek')

    assert.equal(body.primary, 'deepseek')
    assert.deepEqual(body.routes.map((route) => route.id), ['deepseek'])
    assert.deepEqual(body.states.map((state) => state.key), ['deepseek'])
  })

  it('queries only the requested route, leaving the others untouched', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const { ctx, routes } = snapshotContext([{ id: 'deepseek' }, { id: 'moonshot' }])
    apply(ctx, defaultConfig())
    await ask(routes[0], '?route=deepseek')
    assert.equal(fetchStub.calls.length, 1)
    assert.match(fetchStub.calls[0].url, /deepseek/)
  })

  it('resolves an adapter-owned route kind to its vendor, rather than calling it uncatalogued', async () => {
    // `deepseek-official` is the DeepSeek adapter's own name for its route. The
    // vendor is plainly known, so this must not report "not catalogued".
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const { ctx, routes } = snapshotContext([{ id: 'deepseek-official' }])
    apply(ctx, defaultConfig())
    const body = await ask(routes[0], '?route=deepseek-official')

    assert.equal(body.primary, 'deepseek-official')
    assert.equal(body.states[0].status, 'ok')
    assert.equal(body.routes[0].label, 'DeepSeek')
  })

  it('says so when it knows nothing about the route at all', async () => {
    const { ctx, routes } = snapshotContext([{ id: 'deepseek' }])
    apply(ctx, defaultConfig())
    const body = await ask(routes[0], '?route=ghost')
    assert.match(body.error, /没有关于路由「ghost」的任何信息/)
  })

  it('falls back to the primary route when no route is named', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const { ctx, routes } = snapshotContext([{ id: 'deepseek' }, { id: 'moonshot' }])
    apply(ctx, defaultConfig())
    const body = await ask(routes[0], '')
    assert.equal(body.primary, 'deepseek')
    assert.deepEqual(body.routes.map((route) => route.id), ['deepseek'])
  })
})

describe('refresh after each turn', () => {
  it('re-queries the primary route when a turn ends', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const harness = fullContext()
    apply(harness.ctx, defaultConfig({ minIntervalSec: 0 }))
    assert.equal(fetchStub.calls.length, 0)

    harness.emit('session/event', {}, { type: 'turn/end', data: { turn: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(fetchStub.calls.length, 1)
  })

  it('ignores every other session event', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const harness = fullContext()
    apply(harness.ctx, defaultConfig({ minIntervalSec: 0 }))
    for (const type of ['turn/start', 'step/end', 'tool/result', 'assistant/message']) {
      harness.emit('session/event', {}, { type })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(fetchStub.calls.length, 0)
  })

  it('survives a malformed event without throwing', () => {
    const harness = fullContext()
    apply(harness.ctx, defaultConfig())
    assert.doesNotThrow(() => {
      harness.emit('session/event', {}, null)
      harness.emit('session/event', {}, 'nope')
      harness.emit('session/event', {})
    })
  })

  it('still honours the throttle, so a burst of turns is not a burst of requests', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse(DEEPSEEK_BODY))
    const harness = fullContext()
    apply(harness.ctx, defaultConfig({ minIntervalSec: 300 }))
    harness.emit('session/event', {}, { type: 'turn/end' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    harness.emit('session/event', {}, { type: 'turn/end' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(fetchStub.calls.length, 1)
  })
})

describe('balance_set_endpoint', () => {
  /** A config editor stub recording the change it was handed. */
  function editorStub(entries) {
    const edits = []
    return {
      edits,
      service: {
        entries: () => entries,
        async edit(entry, change) {
          edits.push({ entry, before: entry.options.config, after: change(entry.options.config) })
        },
      },
    }
  }

  it('writes the endpoint into this plugin\'s own row', async () => {
    const entries = [{ options: { id: 'balance-meter', name: 'dsh-balance-meter', config: {} } }]
    const editor = editorStub(entries)
    const { ctx, registered } = makeCtx({
      entries,
      services: { configEditor: editor.service },
    })
    apply(ctx, defaultConfig())
    const out = await toolNamed(registered, 'balance_set_endpoint').execute({
      route: 'deepseek',
      endpoint: '{origin}/custom',
    })
    assert.match(out, /已把路由 deepseek 的接口设为/)
    assert.deepEqual(editor.edits[0].after.routes, [
      { id: 'deepseek', baseURL: '', apiKeyEnv: '', endpoint: '{origin}/custom' },
    ])
  })

  it('preserves other routes already in the config', async () => {
    const entries = [{
      options: {
        id: 'balance-meter',
        name: 'dsh-balance-meter',
        config: { routes: [{ id: 'moonshot', baseURL: '', apiKeyEnv: '', endpoint: '{origin}/x' }] },
      },
    }]
    const editor = editorStub(entries)
    const { ctx, registered } = makeCtx({ entries, services: { configEditor: editor.service } })
    apply(ctx, defaultConfig())
    await toolNamed(registered, 'balance_set_endpoint').execute({ route: 'deepseek', endpoint: '{origin}/y' })
    assert.deepEqual(editor.edits[0].after.routes.map((row) => row.id), ['moonshot', 'deepseek'])
  })

  it('replaces rather than duplicates an existing route entry', async () => {
    const entries = [{
      options: {
        id: 'balance-meter',
        name: 'dsh-balance-meter',
        config: { routes: [{ id: 'deepseek', baseURL: 'https://kept', apiKeyEnv: 'KEPT_KEY', endpoint: '{origin}/old' }] },
      },
    }]
    const editor = editorStub(entries)
    const { ctx, registered } = makeCtx({ entries, services: { configEditor: editor.service } })
    apply(ctx, defaultConfig())
    await toolNamed(registered, 'balance_set_endpoint').execute({ route: 'deepseek', endpoint: '{origin}/new' })
    assert.deepEqual(editor.edits[0].after.routes, [
      { id: 'deepseek', baseURL: 'https://kept', apiKeyEnv: 'KEPT_KEY', endpoint: '{origin}/new' },
    ])
  })

  it('clears an override when given an empty endpoint', async () => {
    const entries = [{
      options: {
        id: 'balance-meter',
        name: 'dsh-balance-meter',
        config: { routes: [{ id: 'deepseek', endpoint: '{origin}/x' }] },
      },
    }]
    const editor = editorStub(entries)
    const { ctx, registered } = makeCtx({ entries, services: { configEditor: editor.service } })
    apply(ctx, defaultConfig())
    const out = await toolNamed(registered, 'balance_set_endpoint').execute({ route: 'deepseek', endpoint: '' })
    assert.match(out, /已清除/)
    assert.deepEqual(editor.edits[0].after.routes, [])
  })

  it('explains how to set it by hand when the config entry cannot be found', async () => {
    const { ctx, registered } = makeCtx({
      services: { configEditor: { entries: () => [], async edit() {} } },
    })
    apply(ctx, defaultConfig())
    const out = await toolNamed(registered, 'balance_set_endpoint').execute({ route: 'deepseek', endpoint: '{origin}/x' })
    assert.match(out, /cordis\.patch\.yml/)
  })

  it('refuses an empty route id', async () => {
    const { ctx, registered } = makeCtx()
    apply(ctx, defaultConfig())
    const out = await toolNamed(registered, 'balance_set_endpoint').execute({ route: '', endpoint: '{origin}/x' })
    assert.match(out, /必须给出路由 id/)
  })

  it('surfaces a write failure instead of claiming success', async () => {
    const entries = [{ options: { id: 'balance-meter', name: 'dsh-balance-meter', config: {} } }]
    const { ctx, registered } = makeCtx({
      entries,
      services: {
        configEditor: {
          entries: () => entries,
          async edit() {
            throw new Error('disk full')
          },
        },
      },
    })
    apply(ctx, defaultConfig())
    const out = await toolNamed(registered, 'balance_set_endpoint').execute({ route: 'deepseek', endpoint: '{origin}/x' })
    assert.match(out, /写入配置失败/)
    assert.match(out, /disk full/)
  })
})

describe('profile config as a route source', () => {
  it('fills a route that listProviders does not describe', async () => {
    fetchStub = stubGlobalFetch(() => jsonResponse({ data: { available_balance: 7 } }))
    const entries = [{
      options: {
        id: 'llm-moonshot',
        name: '@deepseek-ai/dsh-llm-moonshot-api-key',
        config: { baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' },
      },
    }]
    const { ctx, registered } = makeCtx({
      entries,
      services: {
        llm: { listProviders: () => [] },
        configEditor: { entries: () => entries },
        credentials: { resolve: async () => ({ value: 'sk-x', source: 'file' }) },
      },
    })
    apply(ctx, defaultConfig())
    const out = JSON.parse(await toolNamed(registered, 'balance_check').execute({}))
    assert.equal(out.route, 'moonshot')
    assert.equal(out.display, '¥7.00')
  })
})
