import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { findById } from '../plugin/catalog.mjs'
import { RAW_ECHO_LIMIT, echoOf, redact, runQuery, truncate } from '../plugin/query.mjs'
import { STATUS } from '../plugin/state.mjs'

/** A fetch stub that returns one scripted response per call. */
function stubFetch(script) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const next = script.shift()
    if (next === undefined) throw new Error(`unexpected fetch #${calls.length}: ${url}`)
    if (next instanceof Error) throw next
    return next
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

const DEEPSEEK = findById('deepseek')
const DEEPSEEK_OK = { balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] }

/** Run a query against the DeepSeek entry with sensible defaults. */
function query(fetchImpl, overrides = {}) {
  return runQuery({
    entry: DEEPSEEK,
    route: { id: 'deepseek', baseURL: 'https://api.deepseek.com' },
    apiKey: 'sk-test-key-value',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    fetchImpl,
    ...overrides,
  })
}

describe('runQuery — success', () => {
  it('returns a normalized result and the endpoint that worked', async () => {
    const fetchImpl = stubFetch([json(DEEPSEEK_OK)])
    const outcome = await query(fetchImpl)
    assert.equal(outcome.status, STATUS.OK)
    assert.equal(outcome.result.display, '¥12.34')
    assert.equal(outcome.url, 'https://api.deepseek.com/user/balance')
  })

  it('sends the credential as a bearer token', async () => {
    const fetchImpl = stubFetch([json(DEEPSEEK_OK)])
    await query(fetchImpl)
    assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer sk-test-key-value')
  })

  it('passes an abort signal so the request can time out', async () => {
    const fetchImpl = stubFetch([json(DEEPSEEK_OK)])
    await query(fetchImpl, { timeoutMs: 50 })
    assert.ok(fetchImpl.calls[0].init.signal instanceof AbortSignal)
  })
})

describe('runQuery — preconditions', () => {
  it('reports a missing credential without calling the network', async () => {
    const fetchImpl = stubFetch([])
    const outcome = await query(fetchImpl, { apiKey: null })
    assert.equal(outcome.status, STATUS.NO_CREDENTIAL)
    assert.match(outcome.message, /DEEPSEEK_API_KEY/)
    assert.equal(fetchImpl.calls.length, 0)
  })

  it('treats an empty-string credential as missing', async () => {
    const outcome = await query(stubFetch([]), { apiKey: '' })
    assert.equal(outcome.status, STATUS.NO_CREDENTIAL)
  })

  it('reports a vendor with no public endpoint, using the catalog note', async () => {
    const synthetic = { ...DEEPSEEK, endpoint: null, note: '该家没有公开接口。' }
    const outcome = await query(stubFetch([]), { entry: synthetic })
    assert.equal(outcome.status, STATUS.NO_PUBLIC_ENDPOINT)
    assert.equal(outcome.message, '该家没有公开接口。')
  })

  it('falls back to a generated message when the note is empty', async () => {
    const synthetic = { ...DEEPSEEK, endpoint: null, note: '' }
    const outcome = await query(stubFetch([]), { entry: synthetic })
    assert.match(outcome.message, /没有公开的余额接口/)
  })
})

describe('runQuery — failures', () => {
  it('reports a rejected credential and stops without trying another endpoint', async () => {
    const fetchImpl = stubFetch([new Response('nope', { status: 401 })])
    const outcome = await query(fetchImpl, {
      entry: { ...DEEPSEEK, endpoint: '{origin}/other' },
      route: { endpoint: '{origin}/user/balance' },
    })
    assert.equal(outcome.status, STATUS.HTTP_ERROR)
    assert.match(outcome.message, /拒绝了本次凭据/)
    assert.equal(fetchImpl.calls.length, 1, 'a 401 must not be retried against another path')
  })

  it('explains a 404 as a moved or withdrawn endpoint', async () => {
    const outcome = await query(stubFetch([new Response('', { status: 404 })]))
    assert.equal(outcome.status, STATUS.HTTP_ERROR)
    assert.match(outcome.message, /404/)
  })

  it('explains a 429 as rate limiting', async () => {
    const outcome = await query(stubFetch([new Response('', { status: 429 })]))
    assert.match(outcome.message, /限流/)
  })

  it('reports a transport error without a raw body', async () => {
    const outcome = await query(stubFetch([new Error('getaddrinfo ENOTFOUND')]))
    assert.equal(outcome.status, STATUS.NETWORK_ERROR)
    assert.match(outcome.message, /ENOTFOUND/)
    assert.equal(outcome.raw, null)
  })

  it('labels a timeout distinctly from a generic abort', async () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    const outcome = await query(stubFetch([timeout]))
    assert.match(outcome.message, /请求超时/)
  })

  it('reports a non-JSON body as a parse failure with the body echoed', async () => {
    const outcome = await query(stubFetch([new Response('<html>gateway error</html>')]))
    assert.equal(outcome.status, STATUS.PARSE_FAILED)
    assert.match(outcome.raw, /gateway error/)
  })

  it('reports an unrecognised JSON shape as a parse failure with the body echoed', async () => {
    const outcome = await query(stubFetch([json({ hello: 'world' })]))
    assert.equal(outcome.status, STATUS.PARSE_FAILED)
    assert.match(outcome.message, /无法解析/)
    assert.match(outcome.raw, /hello/)
  })
})

describe('runQuery — endpoint candidates', () => {
  it('falls through a custom endpoint to the catalog default', async () => {
    const fetchImpl = stubFetch([new Response('', { status: 500 }), json(DEEPSEEK_OK)])
    const outcome = await query(fetchImpl, {
      route: { id: 'deepseek', baseURL: 'https://api.deepseek.com', endpoint: '{origin}/custom' },
    })
    assert.equal(outcome.status, STATUS.OK)
    assert.equal(fetchImpl.calls[0].url, 'https://api.deepseek.com/custom')
    assert.equal(fetchImpl.calls[1].url, 'https://api.deepseek.com/user/balance')
  })

  it('reports the last failure when every candidate is exhausted', async () => {
    const fetchImpl = stubFetch([new Response('', { status: 500 }), new Response('', { status: 500 })])
    const outcome = await query(fetchImpl, {
      route: { id: 'deepseek', baseURL: 'https://api.deepseek.com', endpoint: '{origin}/custom' },
    })
    assert.equal(outcome.status, STATUS.HTTP_ERROR)
    assert.equal(outcome.url, 'https://api.deepseek.com/user/balance')
    assert.equal(fetchImpl.calls.length, 2)
  })

  it('reports a credential error as soon as it sees one, even mid-list', async () => {
    const fetchImpl = stubFetch([new Response('', { status: 500 }), new Response('', { status: 403 })])
    const outcome = await query(fetchImpl, {
      route: { id: 'deepseek', baseURL: 'https://api.deepseek.com', endpoint: '{origin}/custom' },
    })
    assert.match(outcome.message, /拒绝了本次凭据/)
  })
})

describe('redact', () => {
  it('masks vendor key shapes', () => {
    assert.equal(redact('key sk-abcdef123456 ok'), 'key sk-*** ok')
    assert.equal(redact('gsk-abcdef123456'), 'gsk-***')
  })

  it('masks a bearer token', () => {
    assert.match(redact('authorization: Bearer abc123def456'), /Bearer \*\*\*/)
  })

  it('masks named secret fields in a JSON body', () => {
    assert.equal(redact('{"api_key":"hunter2"}'), '{"api_key":"***"}')
    assert.equal(redact('{"access_token":"hunter2"}'), '{"access_token":"***"}')
  })

  it('masks an environment-style assignment', () => {
    assert.match(redact('DEEPSEEK_API_KEY=sk-realsecret'), /\*\*\*/)
  })

  it('leaves ordinary content alone', () => {
    assert.equal(redact('{"balance_infos":[{"currency":"CNY"}]}'), '{"balance_infos":[{"currency":"CNY"}]}')
  })
})

describe('truncate', () => {
  it('passes short text through', () => {
    assert.equal(truncate('abc', 10), 'abc')
  })

  it('cuts long text and says how long it was', () => {
    const out = truncate('x'.repeat(50), 10)
    assert.ok(out.startsWith('x'.repeat(10)))
    assert.match(out, /已截断，原长 50 字符/)
  })
})

describe('echoOf', () => {
  it('redacts and truncates in one step', () => {
    const out = echoOf(`{"api_key":"sk-abcdef123456","x":"${'y'.repeat(RAW_ECHO_LIMIT)}"}`)
    assert.ok(!out.includes('sk-abcdef123456'))
    assert.ok(out.length < RAW_ECHO_LIMIT + 100)
  })
})
