import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PRESETS, runPresetQuery } from '../plugin/presets.mjs'
import { STATUS } from '../plugin/state.mjs'

/** A fetch stub that routes by URL substring, recording every call. */
function routeFetch(table) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    for (const [needle, handler] of table) {
      if (String(url).includes(needle)) return handler(String(url), init)
    }
    return new Response('', { status: 404 })
  }
  impl.calls = calls
  return impl
}

/** Build a JSON response. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Run a probe with sensible defaults. */
function probe(fetchImpl, overrides = {}) {
  return runPresetQuery({
    baseURL: 'https://relay.example.com',
    apiKey: 'sk-relay',
    fetchImpl,
    ...overrides,
  })
}

describe('preset chain', () => {
  it('tries presets in order and stops at the first that yields a figure', async () => {
    const fetchImpl = routeFetch([
      ['/api/usage/token/', () => json({ data: { total_available: 42, unlimited_quota: false } })],
      ['/v1/usage', () => json({ data: [] })],
    ])
    const outcome = await probe(fetchImpl)
    assert.equal(outcome.status, STATUS.OK)
    assert.equal(outcome.result.amount, 42)
    // The New-API preset calibrates first, so its unauthenticated status read is
    // expected; what must not happen is a later preset being tried.
    assert.deepEqual(
      fetchImpl.calls.map((c) => c.url.replace('https://relay.example.com', '')),
      ['/api/status', '/api/usage/token/'],
    )
  })

  it('moves on past a panel that does not answer that path', async () => {
    const fetchImpl = routeFetch([
      ['/dashboard/billing/credit_grants', () => json({ total_available: 3.5, total_granted: 10 })],
    ])
    const outcome = await probe(fetchImpl)
    assert.equal(outcome.status, STATUS.OK)
    assert.equal(outcome.result.amount, 3.5)
  })

  it('sends the credential as a bearer token by default', async () => {
    const fetchImpl = routeFetch([['/api/usage/token/', () => json({ data: { total_available: 1 } })]])
    await probe(fetchImpl)
    assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer sk-relay')
  })

  it('sends x-api-key instead for the preset that wants it', async () => {
    // Everything else 404s, so the chain walks down to the claude-code-hub
    // preset, which authenticates differently from the rest.
    const fetchImpl = routeFetch([
      ['/api/v1/me/quota', () => json({ data: { remaining: 7 } })],
    ])
    const outcome = await probe(fetchImpl)
    assert.equal(outcome.status, STATUS.OK)

    const hit = fetchImpl.calls.find((c) => c.url.endsWith('/api/v1/me/quota'))
    assert.ok(hit !== undefined, 'the x-api-key preset was never reached')
    assert.equal(hit.init.headers['x-api-key'], 'sk-relay')
    assert.equal(hit.init.headers.authorization, undefined)
  })

  it('refuses to keep trying the same credential after a 401', async () => {
    const fetchImpl = routeFetch([
      ['/api/usage/token/', () => new Response('', { status: 401 })],
    ])
    const outcome = await probe(fetchImpl)
    assert.equal(outcome.status, STATUS.HTTP_ERROR)
    assert.match(outcome.message, /拒绝了本次凭据/)
    // The calibration read happens first; no authenticated path after the
    // refused one may be attempted.
    assert.deepEqual(
      fetchImpl.calls.map((c) => c.url.replace('https://relay.example.com', '')),
      ['/api/status', '/api/usage/token/'],
    )
  })

  it('reports a clean miss, naming the plugin rather than blaming the vendor', async () => {
    const outcome = await probe(routeFetch([]))
    assert.equal(outcome.status, STATUS.UNKNOWN_PROVIDER)
    assert.match(outcome.message, /未收录/)
    assert.match(outcome.message, /不代表该供应商没有余额接口/)
    assert.match(outcome.message, /routes/)
  })

  it('redacts the echoed body of the last attempt', async () => {
    const outcome = await probe(routeFetch([
      ['/api/user/self', () => new Response('{"api_key":"sk-abcdef123456","x":1}')],
    ]))
    assert.equal(outcome.raw !== null, true)
    assert.ok(!outcome.raw.includes('sk-abcdef123456'))
  })

  it('reports a transport failure instead of guessing', async () => {
    const outcome = await probe(routeFetch([
      ['/api/usage/token/', () => {
        throw new Error('ENOTFOUND')
      }],
    ]))
    assert.equal(outcome.status, STATUS.NETWORK_ERROR)
    assert.match(outcome.message, /ENOTFOUND/)
  })

  it('refuses to probe without a gateway address', async () => {
    const outcome = await runPresetQuery({
      baseURL: '',
      apiKey: 'sk-x',
      fetchImpl: routeFetch([]),
    })
    assert.equal(outcome.status, STATUS.UNKNOWN_PROVIDER)
    assert.match(outcome.message, /没有已知的网关地址/)
  })
})

describe('New-API calibration', () => {
  it('reads quota_per_unit before converting a New-API figure', async () => {
    // A panel that reconfigured its unit: hardcoding 500000 would be wrong by
    // orders of magnitude here.
    const fetchImpl = routeFetch([
      ['/api/status', () => json({ data: { quota_per_unit: 100, quota_display_type: 'USD' } })],
      ['/api/usage/token/', () => json({ data: { total_available: 250, unlimited_quota: false } })],
    ])
    const outcome = await probe(fetchImpl)
    assert.equal(outcome.status, STATUS.OK)
    assert.equal(outcome.result.amount, 2.5)
    assert.equal(outcome.result.display, '$2.50')
  })

  it('falls back to raw units when the panel does not declare one', async () => {
    const fetchImpl = routeFetch([
      ['/api/usage/token/', () => json({ data: { total_available: 250 } })],
    ])
    const outcome = await probe(fetchImpl)
    assert.equal(outcome.result.amount, 250)
  })

  it('reports an unlimited panel as unlimited rather than as zero', async () => {
    const fetchImpl = routeFetch([
      ['/api/usage/token/', () => json({ data: { unlimited_quota: true } })],
    ])
    const outcome = await probe(fetchImpl)
    assert.equal(outcome.result.display, '无限额')
  })

  it('still succeeds when the calibration read fails', async () => {
    const fetchImpl = routeFetch([
      ['/api/status', () => new Response('', { status: 500 })],
      ['/api/usage/token/', () => json({ data: { total_available: 5 } })],
    ])
    const outcome = await probe(fetchImpl)
    assert.equal(outcome.status, STATUS.OK)
    assert.equal(outcome.result.amount, 5)
  })
})

describe('user-supplied endpoint', () => {
  it('outranks every preset, because the user knows their gateway', async () => {
    const fetchImpl = routeFetch([
      ['/custom/balance', () => json({ balance: 99 })],
      ['/api/usage/token/', () => json({ data: { total_available: 1 } })],
    ])
    const outcome = await probe(fetchImpl, { endpoint: '{origin}/custom/balance' })
    assert.equal(outcome.status, STATUS.OK)
    assert.equal(outcome.result.amount, 99)
    assert.equal(fetchImpl.calls.length, 1)
  })

  it('falls through to the presets when the custom endpoint yields nothing', async () => {
    const fetchImpl = routeFetch([
      ['/custom/balance', () => json({ hello: 'world' })],
      ['/api/usage/token/', () => json({ data: { total_available: 4 } })],
    ])
    const outcome = await probe(fetchImpl, { endpoint: '{origin}/custom/balance' })
    assert.equal(outcome.status, STATUS.OK)
    assert.equal(outcome.result.amount, 4)
  })

  it('reads quota windows out of a custom shape', async () => {
    const fetchImpl = routeFetch([
      ['/custom/quota', () => json({ data: { usage: { rolling: { used: 1, limit: 4 } } } })],
    ])
    const outcome = await probe(fetchImpl, { endpoint: '{origin}/custom/quota' })
    assert.equal(outcome.status, STATUS.OK)
    assert.equal(outcome.result.kind, 'quota')
    assert.equal(outcome.result.windows[0].remainingPct, 75)
  })
})

describe('preset table', () => {
  it('every preset declares the fields the probe needs', () => {
    for (const preset of PRESETS) {
      assert.ok(preset.id.length > 0, 'a preset has no id')
      assert.ok(preset.label.length > 0, `${preset.id} has no label`)
      assert.ok(preset.path.startsWith('{origin}'), `${preset.id} is not origin-relative`)
      assert.equal(typeof preset.parse, 'function', `${preset.id} has no parser`)
    }
  })

  it('has no duplicate ids', () => {
    assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length)
  })

  it('orders the one-call New-API shape first', () => {
    assert.equal(PRESETS[0].id, 'new-api-token')
  })
})
