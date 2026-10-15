/**
 * Per-route query state: endpoint cache, auto-refresh throttle, failure
 * cooldown, and in-flight coalescing.
 *
 * Pure apart from the injected clock, so the timing rules are testable without
 * DSH and without waiting on wall time.
 */

/** Statuses a route's last query can end in. */
export const STATUS = Object.freeze({
  OK: 'ok',
  NO_CREDENTIAL: 'no-credential',
  UNKNOWN_PROVIDER: 'unknown-provider',
  NO_PUBLIC_ENDPOINT: 'no-public-endpoint',
  PARSE_FAILED: 'parse-failed',
  NETWORK_ERROR: 'network-error',
  HTTP_ERROR: 'http-error',
  PENDING: 'pending',
})

/**
 * First retry delay when a route has no reading at all to fall back on.
 *
 * Doubles per consecutive failure and is capped at the configured cooldown, so
 * a transient miss recovers in seconds while a route that is genuinely
 * unreachable costs no more than the full cooldown would have.
 */
export const EMPTY_RETRY_MS = 15_000

/**
 * The text to render for a result, or null when it carries none.
 * @param {object | null} result
 * @returns {string | null}
 */
function displayOf(result) {
  if (result === null || typeof result !== 'object') return null
  const display = result.display
  return typeof display === 'string' && display !== '' ? display : null
}

/**
 * Create the store.
 * @param {{ now?: () => number, cooldownMs?: number, minIntervalMs?: number }} [options]
 */
export function createStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : 600_000
  const defaultMinIntervalMs = Number.isFinite(options.minIntervalMs) ? options.minIntervalMs : 30_000

  /** @type {Map<string, RouteState>} */
  const routes = new Map()

  /**
   * @typedef {object} RouteState
   * @property {string} key
   * @property {string} status
   * @property {object | null} result      Normalized parse result.
   * @property {string | null} url         Endpoint that last worked or last failed.
   * @property {string | null} message     Human-readable reason for a non-ok status.
   * @property {string | null} raw         Truncated, redacted response body for `parse-failed`.
   * @property {number | null} queriedAt   Timestamp of the last successful query.
   * @property {number | null} attemptedAt Timestamp of the last attempt of any outcome.
   * @property {number} cooldownUntil      No automatic retry before this timestamp.
   * @property {Promise<unknown> | null} inflight
   */

  /**
   * Ensure a route has a state row.
   * @param {string} key
   * @returns {RouteState}
   */
  function ensure(key) {
    let state = routes.get(key)
    if (state === undefined) {
      state = {
        key,
        status: STATUS.PENDING,
        result: null,
        url: null,
        message: null,
        raw: null,
        queriedAt: null,
        attemptedAt: null,
        cooldownUntil: 0,
        /** Consecutive failures with no reading to fall back on; drives the backoff. */
        failures: 0,
        inflight: null,
      }
      routes.set(key, state)
    }
    return state
  }

  return {
    /**
     * Decide whether an automatic (non-manual) refresh may run now.
     * @param {string} key
     * @param {number} [minIntervalMs]
     * @returns {boolean}
     */
    mayAutoRefresh(key, minIntervalMs) {
      const state = ensure(key)
      const at = now()
      if (state.inflight !== null) return false
      if (at < state.cooldownUntil) return false
      const interval = Number.isFinite(minIntervalMs) ? minIntervalMs : defaultMinIntervalMs
      if (state.attemptedAt !== null && at - state.attemptedAt < interval) return false
      // Every status stays retryable. Carving out "answers that cannot change on
      // their own" looked like a saving and was actually a trap: a miss recorded
      // from a transient condition — a provider list read at the wrong moment, a
      // route key that briefly disagreed with the session's — latched forever,
      // leaving the readout dead until the user clicked. The cooldown below is
      // what keeps retries cheap, and it is enough.
      return true
    },

    /**
     * Run `work` at most once per key while a call is in flight; concurrent
     * callers share the same promise.
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} work
     * @returns {Promise<T>}
     */
    coalesce(key, work) {
      const state = ensure(key)
      if (state.inflight !== null) return /** @type {Promise<T>} */ (state.inflight)
      const promise = (async () => work())()
      state.inflight = promise
      const clear = () => {
        if (state.inflight === promise) state.inflight = null
      }
      promise.then(clear, clear)
      return promise
    },

    /**
     * Record a successful query.
     * @param {string} key
     * @param {{ result: object, url: string }} input
     */
    recordSuccess(key, input) {
      const state = ensure(key)
      state.status = STATUS.OK
      state.result = input.result
      state.url = input.url
      state.message = null
      state.raw = null
      state.queriedAt = now()
      state.attemptedAt = state.queriedAt
      state.cooldownUntil = 0
      state.failures = 0
    },

    /**
     * Record a failed query and start the cooldown.
     *
     * How long that cooldown lasts depends on whether there is anything to show:
     *
     *   - With a previous reading, the readout still displays it, so waiting the
     *     full cooldown is simply being polite to the vendor.
     *   - With *no* reading, the cooldown is all the user experiences — a blank
     *     readout with no way back short of clicking. So it retries soon, and
     *     backs off exponentially from there, which keeps a genuinely broken
     *     route cheap while letting a transient one recover in seconds.
     *
     * `result` is deliberately left as-is either way: a failure keeps the last
     * good figure, and `snapshot()` marks it stale so the UI can say the number
     * is old without pretending it is current.
     *
     * @param {string} key
     * @param {{ status: string, message: string, url?: string | null, raw?: string | null }} input
     */
    recordFailure(key, input) {
      const state = ensure(key)
      state.status = input.status
      state.message = input.message
      state.raw = input.raw ?? null
      state.url = input.url ?? state.url
      state.failures += 1
      state.attemptedAt = now()
      state.cooldownUntil = now() + (state.result !== null
        ? cooldownMs
        : Math.min(cooldownMs, EMPTY_RETRY_MS * 2 ** (state.failures - 1)))
    },

    /**
     * Clear the cooldown so the next call retries immediately. Used by manual
     * refreshes, which are allowed to re-probe.
     * @param {string} key
     */
    clearCooldown(key) {
      const state = ensure(key)
      state.cooldownUntil = 0
      state.attemptedAt = null
    },

    /**
     * Read one route's state.
     * @param {string} key
     */
    get(key) {
      return ensure(key)
    },

    /**
     * Detach the rows as plain data for the browser half.
     *
     * Secrets never reach here: only the credential *variable name* and whether
     * it resolved, never its value.
     * @returns {object[]}
     */
    snapshot() {
      return [...routes.values()].map((state) => ({
        key: state.key,
        status: state.status,
        result: state.result,
        url: state.url,
        message: state.message,
        raw: state.raw,
        queriedAt: state.queriedAt,
        // The text a readout should render, or null when there is nothing to
        // render. It is deliberately derived from the presence of a *result*
        // and not from `status`: a failed attempt must not blank a figure that
        // is still the best thing known. `stale` below carries the doubt.
        value: displayOf(state.result),
        stale: state.status !== STATUS.OK && state.result !== null,
      }))
    },
  }
}
