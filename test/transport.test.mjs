/**
 * Transport retry tests.
 *
 * The behaviour under test was found by measurement, not assumption: on this
 * machine a fresh TLS connection to `opencode.ai` was reset in 2 of 4 cold
 * attempts (`ECONNRESET`) while a warm connection succeeded 10 times in a row.
 * With no retry, that surfaced to the user as "请求失败：fetch failed" on the first
 * open of the panel, and then worked on the next trigger — a bug that looks
 * intermittent but is entirely reproducible.
 *
 * So these tests pin the policy: repeat a transport failure, never repeat an HTTP
 * status, and never repeat a cancellation.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ATTEMPTS, RETRY_DELAY_MS, fetchWithRetry, isTransientTransportError } from '../plugin/transport.mjs'

/** Build the error shape `fetch` rejects with on a transport failure. */
function transportError(code = 'ECONNRESET') {
  const error = new TypeError('fetch failed')
  error.cause = Object.assign(new Error(code), { code })
  return error
}

/** A `fetch` stub that replays a scripted sequence of outcomes. */
function scriptedFetch(outcomes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]
    if (typeof next === 'function') return next(url, init)
    if (next instanceof Error) throw next
    return next
  }
  return { impl, calls }
}

/** A minimal OK response. */
function okResponse(body = '{}') {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('isTransientTransportError', () => {
  it('accepts the socket errors a retry can fix', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
      assert.equal(isTransientTransportError(transportError(code)), true, `${code} should be retried`)
    }
  })

  it('accepts a bare "fetch failed" with no usable cause', () => {
    assert.equal(isTransientTransportError(new TypeError('fetch failed')), true)
  })

  it('refuses a cancellation, because cancelling is not a fault', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    assert.equal(isTransientTransportError(abort), false)
  })

  it('refuses a deadline, because the time has already been spent', () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    assert.equal(isTransientTransportError(timeout), false)
  })

  it('refuses a programming error that only looks like a TypeError', () => {
    assert.equal(isTransientTransportError(new TypeError('x is not a function')), false)
  })

  it('refuses values that are not errors at all', () => {
    for (const value of [null, undefined, 'boom', 42, {}]) {
      assert.equal(isTransientTransportError(value), false)
    }
  })
})

describe('fetchWithRetry', () => {
  it('returns the first response when it succeeds, without retrying', async () => {
    const { impl, calls } = scriptedFetch([okResponse()])
    const result = await fetchWithRetry(impl, 'https://x/y', { accept: 'application/json' }, undefined, { delayMs: 0 })
    assert.equal(result.attempts, 1)
    assert.equal(result.error, null)
    assert.equal(result.response.status, 200)
    assert.equal(calls.length, 1)
  })

  it('recovers when a reset connection is followed by a good one', async () => {
    // This is the exact sequence measured in the wild.
    const { impl, calls } = scriptedFetch([transportError('ECONNRESET'), okResponse('{"a":1}')])
    const result = await fetchWithRetry(impl, 'https://x/y', {}, undefined, { delayMs: 0 })
    assert.equal(calls.length, 2)
    assert.equal(result.attempts, 2)
    assert.equal(result.error, null)
    assert.equal(result.response.status, 200)
    assert.equal(await result.response.text(), '{"a":1}')
  })

  it('gives up after the attempt budget and reports the last error', async () => {
    const { impl, calls } = scriptedFetch([transportError('ECONNRESET')])
    const result = await fetchWithRetry(impl, 'https://x/y', {}, undefined, { delayMs: 0 })
    assert.equal(calls.length, ATTEMPTS)
    assert.equal(result.response, null)
    assert.equal(result.error.cause.code, 'ECONNRESET')
  })

  it('never retries an HTTP error, because the status would repeat', async () => {
    // A 401 is final. Retrying it would delay the real answer for no benefit,
    // and the query layer stops after one credential rejection on purpose.
    const unauthorized = new Response('{"error":"x"}', { status: 401 })
    const { impl, calls } = scriptedFetch([unauthorized])
    const result = await fetchWithRetry(impl, 'https://x/y', {}, undefined, { delayMs: 0 })
    assert.equal(calls.length, 1, 'a status response must not be retried')
    assert.equal(result.response.status, 401)
    assert.equal(result.error, null)
  })

  it('never retries a cancellation', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const { impl, calls } = scriptedFetch([abort])
    const result = await fetchWithRetry(impl, 'https://x/y', {}, undefined, { delayMs: 0 })
    assert.equal(calls.length, 1)
    assert.equal(result.error, abort)
  })

  it('stops immediately when the signal is already aborted', async () => {
    const { impl, calls } = scriptedFetch([okResponse()])
    const controller = new AbortController()
    controller.abort()
    const result = await fetchWithRetry(impl, 'https://x/y', {}, controller.signal, { delayMs: 0 })
    assert.equal(calls.length, 0, 'an aborted query must not open a connection')
    assert.equal(result.response, null)
  })

  it('does not keep waiting between attempts once the signal aborts', async () => {
    // A retry delay must not outlive a cancellation: otherwise a cancelled query
    // still holds a timer, and the caller's teardown races it.
    const controller = new AbortController()
    const { impl, calls } = scriptedFetch([transportError('ECONNRESET'), okResponse()])
    const pending = fetchWithRetry(impl, 'https://x/y', {}, controller.signal, { delayMs: 5_000 })
    controller.abort()
    const result = await pending
    assert.equal(result.response, null)
    assert.ok(calls.length <= 1)
  })

  it('passes the method, headers and signal straight through', async () => {
    const { impl, calls } = scriptedFetch([okResponse()])
    const controller = new AbortController()
    await fetchWithRetry(impl, 'https://x/y', { authorization: 'Bearer k' }, controller.signal, { delayMs: 0 })
    assert.equal(calls[0].init.method, 'GET')
    assert.deepEqual(calls[0].init.headers, { authorization: 'Bearer k' })
    assert.equal(calls[0].init.signal, controller.signal)
  })
})
