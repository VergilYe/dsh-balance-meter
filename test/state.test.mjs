import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { EMPTY_RETRY_MS, HISTORY_POINTS, STATUS, createStore } from '../plugin/state.mjs'

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

  it('waits the full cooldown after a failure when a reading is already showing', () => {
    // There is something to look at, so waiting is only being polite.
    const clock = fakeClock()
    const store = createStore({ now: clock.now, cooldownMs: 600_000 })
    store.recordSuccess('r', { result: { display: '¥1.00' }, url: 'u' })
    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    assert.equal(store.mayAutoRefresh('r'), false)
    clock.advance(599_999)
    assert.equal(store.mayAutoRefresh('r'), false)
    clock.advance(1)
    assert.equal(store.mayAutoRefresh('r'), true)
  })

  it('retries quickly when there is nothing to show, and backs off from there', () => {
    // With no reading, the cooldown is all the user experiences: a blank
    // readout. So a transient miss must recover in seconds, while repeating
    // failures still grow toward the ceiling.
    const clock = fakeClock()
    const store = createStore({ now: clock.now, cooldownMs: 600_000, minIntervalMs: 0 })

    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    clock.advance(EMPTY_RETRY_MS - 1)
    assert.equal(store.mayAutoRefresh('r'), false)
    clock.advance(1)
    assert.equal(store.mayAutoRefresh('r'), true)

    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    clock.advance(EMPTY_RETRY_MS * 2 - 1)
    assert.equal(store.mayAutoRefresh('r'), false, 'the second wait doubles')
    clock.advance(1)
    assert.equal(store.mayAutoRefresh('r'), true)
  })

  it('caps the backoff at the configured cooldown', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now, cooldownMs: 60_000, minIntervalMs: 0 })
    for (let i = 0; i < 12; i += 1) {
      store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    }
    clock.advance(60_000 - 1)
    assert.equal(store.mayAutoRefresh('r'), false)
    clock.advance(1)
    assert.equal(store.mayAutoRefresh('r'), true)
  })

  it('resets the backoff once a reading arrives', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now, cooldownMs: 600_000, minIntervalMs: 0 })
    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    store.recordFailure('r', { status: STATUS.NETWORK_ERROR, message: 'boom' })
    store.recordSuccess('r', { result: { display: '¥1.00' }, url: 'u' })
    assert.equal(store.get('r').failures, 0)
  })

  it('keeps every failure status retryable, because a miss can be transient', () => {
    // Carving out "answers that cannot change on their own" latched a miss
    // forever when it came from a transient condition, leaving the readout dead
    // until the user clicked. Nothing may latch.
    const clock = fakeClock()
    for (const status of Object.values(STATUS)) {
      const store = createStore({ now: clock.now, cooldownMs: 1_000, minIntervalMs: 0 })
      store.recordFailure('r', { status, message: 'x' })
      clock.advance(1_000)
      assert.equal(store.mayAutoRefresh('r'), true, `${status} must remain retryable`)
    }
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

describe('history', () => {
  /** A quota result carrying the given window shares. */
  function quota(...pcts) {
    return {
      kind: 'quota',
      display: `${pcts[0]}%`,
      amount: null,
      detail: [],
      windows: pcts.map((pct, index) => ({
        key: `w${index}`,
        label: `窗口 ${index + 1}`,
        used: null,
        limit: null,
        remainingPct: pct,
      })),
    }
  }

  it('starts empty, because no reading has happened yet', () => {
    const store = createStore({ now: fakeClock().now })
    assert.deepEqual(store.history('r'), [])
  })

  it('keeps one sample per window per successful reading', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now })
    store.recordSuccess('r', { result: quota(90, 80), url: 'u' })
    clock.advance(1000)
    store.recordSuccess('r', { result: quota(85, 78), url: 'u' })

    const series = store.history('r')
    assert.equal(series.length, 2)
    assert.deepEqual(series.map((s) => s.key).sort(), ['w0', 'w1'])
    const first = series.find((s) => s.key === 'w0')
    assert.deepEqual(first.points.map((p) => p.pct), [90, 85])
  })

  it('does not record a failed attempt as a sample', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now, cooldownMs: 0 })
    store.recordSuccess('r', { result: quota(90), url: 'u' })
    store.recordFailure('r', { status: 'http-error', message: 'boom' })
    assert.equal(store.history('r')[0].points.length, 1)
  })

  it('skips a window that reported no readable share', () => {
    const store = createStore({ now: fakeClock().now })
    store.recordSuccess('r', {
      result: {
        kind: 'quota',
        display: 'x',
        amount: null,
        detail: [],
        windows: [
          { key: 'good', label: 'a', used: 1, limit: 2, remainingPct: 50 },
          { key: 'bad', label: 'b', used: null, limit: null, remainingPct: null },
        ],
      },
      url: 'u',
    })
    assert.deepEqual(store.history('r').map((s) => s.key), ['good'])
  })

  it('stores nothing for a balance-only reading', () => {
    const store = createStore({ now: fakeClock().now })
    store.recordSuccess('r', {
      result: { kind: 'balance', currency: 'USD', amount: 5, display: '$5.00', detail: [], windows: [] },
      url: 'u',
    })
    assert.deepEqual(store.history('r'), [])
  })

  it('bounds the ring so a long-lived process cannot grow without limit', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now })
    for (let i = 0; i < HISTORY_POINTS + 25; i++) {
      store.recordSuccess('r', { result: quota(100 - (i % 10)), url: 'u' })
      clock.advance(1000)
    }
    assert.equal(store.history('r')[0].points.length, HISTORY_POINTS)
  })

  it('keeps routes apart', () => {
    const clock = fakeClock()
    const store = createStore({ now: clock.now })
    store.recordSuccess('a', { result: quota(50), url: 'u' })
    store.recordSuccess('b', { result: quota(70), url: 'u' })
    assert.deepEqual(store.history('a')[0].points.map((p) => p.pct), [50])
    assert.deepEqual(store.history('b')[0].points.map((p) => p.pct), [70])
  })

  it('returns copies, so a caller cannot mutate the retained series', () => {
    const store = createStore({ now: fakeClock().now })
    store.recordSuccess('r', { result: quota(50), url: 'u' })
    const series = store.history('r')
    series[0].points.push({ at: 0, pct: 1 })
    assert.equal(store.history('r')[0].points.length, 1)
  })
})