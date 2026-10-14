import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { STATUS, createStore } from '../plugin/state.mjs'

/** A clock the test drives by hand. */
function fakeClock(start = 1_000_000) {
  let at = start
  return {
    now: () => at,
    advance: (ms) => {
      at += ms
    },
  }
}

describe('mayAutoRefresh', () => {
  it('allows the first refresh', () => {
    const store = createStore({ now: fakeClock().now })
    assert.equal(store.mayAutoRefresh('r'), true)
  })

  it('blocks a second refresh inside the interval', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now, minIntervalMs: 30_000 })
    store.recordSuccess('r', { result: {}, url: 'u' })
    assert.equal(store.mayAutoRefresh('r'), false)
    clock.advance(29_999)
    assert.equal(store.mayAutoRefresh('r'), false)
  })

  it('allows a refresh once the interval has passed', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now, minIntervalMs: 30_000 })
    store.recordSuccess('r', { result: {}, url: 'u' })
    clock.advance(30_000)
    assert.equal(store.mayAutoRefresh('r'), true)
  })

  it('honours a per-call interval override', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now, minIntervalMs: 30_000 })
    store.recordSuccess('r', { result: {}, url: 'u' })
    clock.advance(5_000)
    assert.equal(store.mayAutoRefresh('r', 1_000), true)
  })

  it('blocks while a query is in flight', async () => {
    const store = createStore({ now: fakeClock().now })
    let release
    const pending = store.coalesce('r', () => new Promise((resolve) => {
      release = resolve
    }))
    assert.equal(store.mayAutoRefresh('r'), false)
    release()
    await pending
    assert.equal(store.mayAutoRefresh('r'), true)
  })

  it('blocks during the cooldown after a failure', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now, cooldownMs: 600_000 })
    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    assert.equal(store.mayAutoRefresh('r'), false)
    clock.advance(599_999)
    assert.equal(store.mayAutoRefresh('r'), false)
    clock.advance(1)
    assert.equal(store.mayAutoRefresh('r'), true)
  })

  it('never auto-refreshes a route whose answer cannot change on its own', () => {
    const clock = fakeClock()
    for (const status of [STATUS.UNKNOWN_PROVIDER, STATUS.NO_PUBLIC_ENDPOINT]) {
      const store = createStore({ now: clock.now, cooldownMs: 0 })
      store.recordFailure('r', { status, message: 'x' })
      clock.advance(999_999)
      assert.equal(store.mayAutoRefresh('r'), false, `${status} should not auto-refresh`)
    }
  })

  it('does retry a missing credential, because that can resolve on its own', () => {
    // A key may be added, or a file-backed credential may appear, without
    // anyone touching this plugin. Resolving one is a local lookup, so leaving
    // it stuck until the user refreshes by hand would be a needless dead end.
    const clock = fakeClock()
    const store = createStore({ now: clock.now, cooldownMs: 1_000, minIntervalMs: 0 })
    store.recordFailure('r', { status: STATUS.NO_CREDENTIAL, message: 'x' })
    clock.advance(1_000)
    assert.equal(store.mayAutoRefresh('r'), true)
  })

  it('still auto-refreshes a transient failure once the cooldown ends', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now, cooldownMs: 1_000, minIntervalMs: 0 })
    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    clock.advance(1_000)
    assert.equal(store.mayAutoRefresh('r'), true)
  })
})

describe('coalesce', () => {
  it('shares one in-flight promise between concurrent callers', async () => {
    const store = createStore({ now: fakeClock().now })
    let calls = 0
    const work = async () => {
      calls += 1
      return calls
    }
    const [a, b] = await Promise.all([store.coalesce('r', work), store.coalesce('r', work)])
    assert.equal(calls, 1)
    assert.equal(a, 1)
    assert.equal(b, 1)
  })

  it('does not coalesce different routes', async () => {
    const store = createStore({ now: fakeClock().now })
    let calls = 0
    const work = async () => {
      calls += 1
    }
    await Promise.all([store.coalesce('a', work), store.coalesce('b', work)])
    assert.equal(calls, 2)
  })

  it('allows a fresh call after the previous one settles', async () => {
    const store = createStore({ now: fakeClock().now })
    let calls = 0
    const work = async () => {
      calls += 1
    }
    await store.coalesce('r', work)
    await store.coalesce('r', work)
    assert.equal(calls, 2)
  })

  it('clears the in-flight slot even when the work rejects', async () => {
    const store = createStore({ now: fakeClock().now })
    await assert.rejects(store.coalesce('r', async () => {
      throw new Error('nope')
    }))
    assert.equal(store.get('r').inflight, null)
  })
})

describe('recordSuccess', () => {
  it('stores the reading, the endpoint, and the query time', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now })
    store.recordSuccess('r', { result: { display: '¥1.00' }, url: 'https://x/y' })
    const state = store.get('r')
    assert.equal(state.status, STATUS.OK)
    assert.equal(state.url, 'https://x/y')
    assert.equal(state.queriedAt, clock.now())
    assert.equal(state.cooldownUntil, 0)
    assert.equal(state.message, null)
  })

  it('clears a previous failure message', () => {
    const store = createStore({ now: fakeClock().now })
    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    store.recordSuccess('r', { result: {}, url: 'u' })
    assert.equal(store.get('r').message, null)
    assert.equal(store.get('r').raw, null)
  })
})

describe('recordFailure', () => {
  it('keeps the last good reading alongside the failure', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now })
    store.recordSuccess('r', { result: { display: '¥5.00' }, url: 'u' })
    clock.advance(60_000)
    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    const state = store.get('r')
    assert.equal(state.result.display, '¥5.00')
    assert.equal(state.status, STATUS.NETWORK_ERROR)
    assert.equal(state.queriedAt, 1_000_000)
  })
})

describe('clearCooldown', () => {
  it('lets a manual refresh retry immediately', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now, cooldownMs: 600_000 })
    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    assert.equal(store.mayAutoRefresh('r'), false)
    store.clearCooldown('r')
    assert.equal(store.mayAutoRefresh('r'), true)
  })
})

describe('snapshot', () => {
  it('detaches plain data with no live objects', () => {
    const store = createStore({ now: fakeClock().now })
    store.recordSuccess('r', { result: { display: '¥1.00' }, url: 'u' })
    const [row] = store.snapshot()
    assert.deepEqual(row, {
      key: 'r',
      status: STATUS.OK,
      result: { display: '¥1.00' },
      url: 'u',
      message: null,
      raw: null,
      queriedAt: 1_000_000,
      value: '¥1.00',
      stale: false,
    })
    assert.ok(!('inflight' in row))
  })

  it('marks a stale reading as stale', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now })
    store.recordSuccess('r', { result: { display: '¥1.00' }, url: 'u' })
    clock.advance(1)
    store.recordFailure('r', { status: STATUS.HTTP_ERROR, message: 'boom' })
    assert.equal(store.snapshot()[0].stale, true)
  })

  it('still offers the last good figure to render after a failed attempt', () => {
    // The whole point of keeping `result` across a failure is that the reader
    // keeps seeing the figure. `value` is what the readout renders, so the
    // decision "is there something to show" belongs here, next to the rule that
    // keeps the value — not in the browser half, which cannot see the rule.
    const clock = fakeClock()
    const store = createStore({ now: clock.now })
    store.recordSuccess('r', { result: { display: '¥1.00' }, url: 'u' })
    clock.advance(1)
    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })

    const [row] = store.snapshot()
    assert.equal(row.status, STATUS.NETWORK_ERROR)
    assert.equal(row.value, '¥1.00')
    assert.equal(row.stale, true)
    assert.equal(row.message, 'boom', 'the reason must still be available alongside the value')
  })

  it('reports no value when there has never been a successful reading', () => {
    const store = createStore({ now: fakeClock().now })
    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    const [row] = store.snapshot()
    assert.equal(row.value, null)
    assert.equal(row.stale, false)
  })

  it('reports no value for a result that carries no display text', () => {
    const store = createStore({ now: fakeClock().now })
    store.recordSuccess('r', { result: { kind: 'quota' }, url: 'u' })
    assert.equal(store.snapshot()[0].value, null)
  })
})
