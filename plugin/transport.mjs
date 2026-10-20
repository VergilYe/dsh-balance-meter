/**
 * One HTTP GET with a bounded retry for transient transport failures.
 *
 * Why this exists: a fresh TLS connection to some of these hosts is
 * intermittently reset — measured on a real machine, `opencode.ai` failed 2 of 4
 * cold connections with `ECONNRESET`, `amr-link.open-design.ai` 1 of 4, while a
 * warm connection succeeded ten times in a row. Nothing is wrong with the
 * request or the credential; the connection was torn down before it was
 * established.
 *
 * Without a retry that surfaces to the user as "请求失败：fetch failed" on the
 * first open of the panel and then works on the next trigger, because by then the
 * pool holds a warm connection. That is exactly the bug this module fixes — and
 * it is not specific to one vendor, so the retry lives here rather than in any
 * vendor adapter.
 *
 * What is retried, and what is not:
 *   - transport failures (`fetch` rejects) are retried;
 *   - a timeout is retried only when the caller's overall budget allows it,
 *     because a hung request already consumed the time it had;
 *   - HTTP statuses are never retried. A 401 will be 401 again, and retrying a
 *     429 or 5xx is the vendor's problem to answer with Retry-After, not
 *     something to hammer blindly.
 *
 * The attempt budget is small on purpose: two attempts catch a cold-connection
 * reset, and a third adds latency to a genuinely broken network for no benefit.
 */

/** How many times one URL is attempted before its failure is final. */
export const ATTEMPTS = 2

/**
 * How long to wait between attempts.
 *
 * Short enough not to be felt on a cold-start recovery, long enough that a
 * reset connection has actually been torn down before the retry opens a new one.
 */
export const RETRY_DELAY_MS = 150

/**
 * Is this thrown value a transport failure that a retry could plausibly fix?
 *
 * `fetch` rejects with a generic `TypeError: fetch failed` and hangs the real
 * reason on `cause`, so the classification has to look there. A caller-driven
 * abort is deliberately excluded: cancelling is not a transient fault.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientTransportError(error) {
  if (error === null || typeof error !== 'object') return false
  const name = error.name
  // Aborts are the caller's decision, or the deadline. Retrying either is wrong
  // here: the deadline has already been spent.
  if (name === 'AbortError') return false
  // A timeout is handled separately by the caller, which knows the budget.
  if (name === 'TimeoutError') return false

  const cause = error.cause
  const code = cause !== null && typeof cause === 'object' ? cause.code : undefined
  if (typeof code === 'string') {
    if (
      code === 'ECONNRESET'
      || code === 'ECONNREFUSED'
      || code === 'EPIPE'
      || code === 'ETIMEDOUT'
      || code === 'EAI_AGAIN'
      || code === 'ENOTFOUND'
      || code === 'UND_ERR_SOCKET'
      || code === 'UND_ERR_CLOSED'
      || code === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      return true
    }
  }
  // A bare "fetch failed" with no usable cause is still a transport failure, not
  // a programming error.
  return name === 'TypeError' && /fetch failed/i.test(String(error.message ?? ''))
}

/**
 * Resolve after `ms`, honouring an abort signal so a cancelled query does not
 * keep a timer alive.
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => done()
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run one GET, retrying transient transport failures.
 *
 * The caller supplies the full signal (deadline already combined), so this
 * function owns no timeout logic — it only decides whether an attempt is worth
 * repeating.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {AbortSignal | undefined} signal
 * @param {{ attempts?: number, delayMs?: number }} [options]
 * @returns {Promise<{ response: Response | null, error: unknown, attempts: number }>}
 */
export async function fetchWithRetry(fetchImpl, url, headers, signal, options = {}) {
  const attempts = Number.isFinite(options.attempts) && options.attempts > 0
    ? Math.floor(options.attempts)
    : ATTEMPTS
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : RETRY_DELAY_MS

  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted === true) return { response: null, error: lastError, attempts: attempt - 1 }
    try {
      const response = await fetchImpl(url, { method: 'GET', headers, signal })
      return { response, error: null, attempts: attempt }
    } catch (error) {
      lastError = error
      const retryable = isTransientTransportError(error)
      if (!retryable || attempt === attempts) return { response: null, error, attempts: attempt }
      await sleep(delayMs, signal)
    }
  }
  return { response: null, error: lastError, attempts }
}
