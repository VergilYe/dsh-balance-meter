/**
 * One balance query against one route: build candidate URLs, call the vendor,
 * parse, and classify the outcome. All I/O goes through the injected `fetchImpl`
 * so the flow is testable without a network.
 */

import { candidateURLs } from './catalog.mjs'
import { ParseError, parseResponse } from './parse.mjs'
import { STATUS } from './state.mjs'

/** How much of an unparseable response body is echoed back for diagnosis. */
export const RAW_ECHO_LIMIT = 800

/**
 * Mask anything that looks like a credential so it can never reach a log, a
 * tool result, or the browser snapshot.
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  return String(text)
    // Vendor key shapes, with or without a scheme prefix.
    .replace(/\b(sk|pk|rk|xai|gsk|hf)-[A-Za-z0-9_-]{6,}/gi, '$1-***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi, 'Bearer ***')
    // Named secret fields in JSON or form bodies.
    .replace(
      /("(?:api[_-]?key|key|token|secret|authorization|access[_-]?token)"\s*:\s*)"[^"]*"/gi,
      '$1"***"',
    )
    .replace(/\b([A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET))\s*[=:]\s*[^\s,;"']+/gi, '$1=***')
}

/**
 * Cut a body down to the echoed portion, with a marker when it was longer.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function truncate(text, limit = RAW_ECHO_LIMIT) {
  const value = String(text)
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…（已截断，原长 ${value.length} 字符）`
}

/**
 * Turn a response body into the string echoed on `parse-failed`.
 * @param {string} body
 * @returns {string}
 */
export function echoOf(body) {
  return truncate(redact(body))
}

/**
 * @typedef {object} QueryOutcome
 * @property {string} status
 * @property {object | null} result
 * @property {string | null} url
 * @property {string | null} message
 * @property {string | null} raw
 */

/**
 * Query one route.
 *
 * @param {object} input
 * @param {import('./catalog.mjs').CatalogEntry} input.entry
 * @param {{ baseURL?: string, endpoint?: string, id?: string, label?: string }} input.route
 * @param {string | null} input.apiKey        Resolved credential value, or null when unset.
 * @param {string | null} input.apiKeyEnv     Name of the variable the key came from, for messages.
 * @param {typeof fetch} input.fetchImpl
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.timeoutMs]
 * @returns {Promise<QueryOutcome>}
 */
export async function runQuery(input) {
  const { entry, route, apiKey, apiKeyEnv, fetchImpl } = input
  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 8000

  if (entry.endpoint === null) {
    return {
      status: STATUS.NO_PUBLIC_ENDPOINT,
      result: null,
      url: null,
      message: entry.note !== '' ? entry.note : `${entry.label} 官方没有公开的余额接口。`,
      raw: null,
    }
  }
  if (typeof apiKey !== 'string' || apiKey === '') {
    const name = apiKeyEnv ?? entry.env[0] ?? 'API key'
    return {
      status: STATUS.NO_CREDENTIAL,
      result: null,
      url: null,
      message: `未找到凭据 ${name}。请在 DSH 的凭据设置里配置它，或在本插件的路由覆盖里指定正确的变量名。`,
      raw: null,
    }
  }

  const urls = candidateURLs(entry, route)
  if (urls.length === 0) {
    return {
      status: STATUS.NO_PUBLIC_ENDPOINT,
      result: null,
      url: null,
      message: `${entry.label} 没有可用的接口地址。`,
      raw: null,
    }
  }

  let lastFailure = {
    status: STATUS.NETWORK_ERROR,
    result: null,
    url: urls[0],
    message: '查询未执行。',
    raw: null,
  }

  for (const url of urls) {
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        signal: withTimeout(input.signal, timeoutMs),
      })
    } catch (error) {
      lastFailure = {
        status: STATUS.NETWORK_ERROR,
        result: null,
        url,
        message: `请求失败：${errorMessage(error)}`,
        raw: null,
      }
      continue
    }

    let body = ''
    try {
      body = await response.text()
    } catch (error) {
      lastFailure = {
        status: STATUS.NETWORK_ERROR,
        result: null,
        url,
        message: `读取响应失败：${errorMessage(error)}`,
        raw: null,
      }
      continue
    }

    if (!response.ok) {
      lastFailure = {
        status: STATUS.HTTP_ERROR,
        result: null,
        url,
        message: httpMessage(response.status, url, body),
        raw: response.status === 401 || response.status === 403 ? null : echoOf(body),
      }
      // 401/403 mean the credential is wrong, and a second endpoint would use
      // the same credential — stop rather than repeat a doomed request.
      if (response.status === 401 || response.status === 403) return lastFailure
      continue
    }

    let json
    try {
      json = JSON.parse(body)
    } catch {
      lastFailure = {
        status: STATUS.PARSE_FAILED,
        result: null,
        url,
        message: '接口返回了非 JSON 内容。',
        raw: echoOf(body),
      }
      continue
    }

    try {
      return { status: STATUS.OK, result: parseResponse(entry.adapter, json), url, message: null, raw: null }
    } catch (error) {
      if (!(error instanceof ParseError)) throw error
      lastFailure = {
        status: STATUS.PARSE_FAILED,
        result: null,
        url,
        message: `接口已连通，但响应结构无法解析：${error.message}`,
        raw: echoOf(body),
      }
      continue
    }
  }

  return lastFailure
}

/**
 * Combine the caller's signal with a timeout.
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  // `AbortSignal.any` exists on Node 20.3+, which is below DSH's bundled 24.
  return AbortSignal.any([signal, timeout])
}

/**
 * Turn an HTTP status into copy that says what to do about it.
 * @param {number} status
 * @param {string} url
 * @param {string} body
 * @returns {string}
 */
function httpMessage(status, url, body) {
  const host = safeHost(url)
  if (status === 401 || status === 403) {
    return `${host} 拒绝了本次凭据（HTTP ${status}）。请确认该路由的 API key 有查询余额的权限。`
  }
  if (status === 404) {
    return `${host} 返回 404：该接口可能已下线或改址。可在本插件的路由覆盖里填自定义接口。`
  }
  if (status === 429) {
    return `${host} 触发限流（HTTP 429）。稍后再试；自动刷新会按冷却间隔退避。`
  }
  const excerpt = echoOf(body)
  return `${host} 返回 HTTP ${status}。${excerpt === '' ? '' : `响应片段：${excerpt}`}`
}

/**
 * Read a URL's host without throwing.
 * @param {string} url
 * @returns {string}
 */
function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Extract a message from an unknown thrown value.
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时'
    if (error.name === 'AbortError') return '请求已取消'
    return error.message
  }
  return String(error)
}
