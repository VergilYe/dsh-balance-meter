/**
 * OpenDesign (AMR) control-plane adapter.
 *
 * Two things are being pinned here, and they are different in kind:
 *
 *   1. the *credential* rules — which file, which profile, and the fact that a
 *      missing controlKey is a first-class answer rather than a parse failure;
 *   2. the *shape* rules — the wallet balance and the Coding Plan windows, both
 *      transcribed from OpenDesign's own clients (see the module docblock).
 *
 * Nothing here reaches the network: `fetchImpl` is always a stub, and the login
 * file is a fixture in a temp directory named through the vendor's own
 * `AMR_HOME` variable.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  DEFAULT_AMR_API_URL,
  creditCount,
  parseCodingPlanUsage,
  parsePreflight,
  parseWalletBalance,
  pickWorkspace,
  readAmrConfigFile,
  readAmrLogin,
  remainingPercent,
  resolveConfigPath,
  resolveProfileName,
  runOpenDesignQuery,
  windowLabel,
} from '../plugin/opendesign.mjs'
import { STATUS } from '../plugin/state.mjs'

/** Directories created by a test, removed afterwards. */
const created = []

afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

/**
 * Write an AMR config file into a fresh temp home and point AMR_HOME at it.
 * @param {unknown} config
 * @returns {{ home: string, configPath: string }}
 */
function useAmrHome(config) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-amr-'))
  created.push(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify(config))
  return { home, configPath: join(home, 'config.json') }
}

/** A login profile as the vendor's CLI writes it. */
function profile(overrides = {}) {
  return {
    controlKey: 'ctrl-key-from-vela-login',
    runtimeKey: 'sk-amr-runtime-key-not-used-here',
    linkUrl: 'https://amr-link.open-design.ai',
    ...overrides,
  }
}

/**
 * Run the adapter with an explicit AMR_HOME and a scripted fetch.
 * @param {{ config: unknown, script: (url: string) => Response }} input
 */
async function query(input) {
  const { home } = useAmrHome(input.config)
  const env = { ...process.env, AMR_HOME: home }
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return input.script(String(url))
  }
  const outcome = await runOpenDesignQuery({ fetchImpl, io: { env }, timeoutMs: 50 })
  return { outcome, calls }
}

/** Build a JSON response. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const WALLET = { balanceUsd: '42.50', updatedAt: '2026-10-19T10:00:00.000Z' }
const WORKSPACES = { items: [{ workspaceId: 'ws-personal', workspaceType: 'personal' }] }
const PLAN = {
  eligible: true,
  tier: 'pro',
  windows: [
    {
      policyId: 'plan-7d',
      durationSeconds: 604_800,
      resetMode: 'anchored_recurring',
      usedCredits: '120000000000',
      remainingCredits: '240000000000',
      limitCredits: '360000000000',
      windowStart: '2026-10-15T00:00:00.000Z',
      resetsAt: '2026-10-22T00:00:00.000Z',
    },
  ],
}

/** The preflight snapshot the control plane actually returns for this account. */
const PREFLIGHT = { balanceUsd: '42.50', codingPlan: PLAN, funding: 'wallet' }

/** A scripted control plane: preflight, wallet, workspace list. */
function happyPath() {
  return (url) => {
    if (url.includes('/billing/preflight')) return json(PREFLIGHT)
    if (url.endsWith('/api/v1/wallet/balance')) return json(WALLET)
    if (url.endsWith('/api/v1/workspaces')) return json(WORKSPACES)
    return json({ error: 'unexpected' }, 404)
  }
}

describe('opendesign — config path and profile resolution', () => {
  it('defaults to ~/.amr/config.json like the vendor daemon', () => {
    const path = resolveConfigPath({})
    assert.match(path, /\.amr[\\/]config\.json$/)
  })

  it('honours the vendor AMR_HOME variable', () => {
    assert.equal(resolveConfigPath({ AMR_HOME: 'D:/amr' }), join('D:/amr', 'config.json'))
    assert.match(resolveConfigPath({ AMR_HOME: '~' }), /config\.json$/)
  })

  it('only accepts the profile names the CLI accepts, else prod', () => {
    assert.equal(resolveProfileName({}), 'prod')
    assert.equal(resolveProfileName({ VELA_PROFILE: 'test' }), 'test')
    assert.equal(resolveProfileName({ OPEN_DESIGN_AMR_PROFILE: 'local' }), 'local')
    // An unknown name is not a reason to read the wrong account.
    assert.equal(resolveProfileName({ VELA_PROFILE: 'nonsense' }), 'prod')
  })

  it('reads the controlKey and the control-plane URL from the profile', () => {
    const login = readAmrLogin({ profiles: { prod: profile() } }, {})
    assert.equal(login.ok, true)
    assert.equal(login.controlKey, 'ctrl-key-from-vela-login')
    assert.equal(login.apiUrl, DEFAULT_AMR_API_URL)
    assert.equal(login.profile, 'prod')
  })

  it('prefers the apiUrl stored in the profile', () => {
    const login = readAmrLogin(
      { profiles: { prod: profile({ apiUrl: 'https://amr-feature-api.powerformer.net' }) } },
      {},
    )
    assert.equal(login.apiUrl, 'https://amr-feature-api.powerformer.net')
  })

  it('uses the only profile present when the reasoned one is missing', () => {
    const login = readAmrLogin({ profiles: { local: profile({ controlKey: 'ck-local' }) } }, {})
    assert.equal(login.ok, true)
    assert.equal(login.profile, 'local')
    assert.equal(login.controlKey, 'ck-local')
  })

  it('refuses to pick an account when several profiles exist and none matches', () => {
    const login = readAmrLogin(
      { profiles: { local: profile(), 'feature-test': profile() } },
      { VELA_PROFILE: 'test' },
    )
    assert.equal(login.ok, false)
    assert.match(login.reason, /OPEN_DESIGN_AMR_PROFILE/)
  })

  it('treats a profile without controlKey as not signed in, never as valid', () => {
    const login = readAmrLogin({ profiles: { prod: { runtimeKey: 'sk-amr-x' } } }, {})
    assert.equal(login.ok, false)
    assert.equal(login.controlKey, null)
    assert.match(login.reason, /controlKey/)
  })

  it('reports structural problems instead of throwing', () => {
    for (const config of [null, {}, { profiles: {} }, { profiles: 'nope' }]) {
      const login = readAmrLogin(config, {})
      assert.equal(login.ok, false)
      assert.equal(typeof login.reason, 'string')
    }
  })

  it('names a missing file as "not signed in yet"', () => {
    const result = readAmrConfigFile(join(tmpdir(), 'definitely-absent-amr', 'config.json'), {
      readFile() {
        const error = new Error('missing')
        error.code = 'ENOENT'
        throw error
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /vela login/)
  })

  it('reports malformed JSON as such', () => {
    const result = readAmrConfigFile('x.json', { readFile: () => '{not json' })
    assert.equal(result.ok, false)
    assert.match(result.reason, /不是合法 JSON/)
  })
})

describe('opendesign — response parsers', () => {
  it('reads balanceUsd as the decimal string the contract declares', () => {
    assert.deepEqual(parseWalletBalance(WALLET), {
      amount: 42.5,
      updatedAt: '2026-10-19T10:00:00.000Z',
    })
    assert.deepEqual(parseWalletBalance({ balanceUsd: '0.00' }), { amount: 0, updatedAt: null })
  })

  it('refuses a balance it cannot read rather than guessing one', () => {
    for (const body of [{}, { balanceUsd: 'lots' }, { balanceUsd: null }, null, 'text']) {
      assert.throws(() => parseWalletBalance(body), /balanceUsd/)
    }
  })

  it('keeps credit counts exact past Number.MAX_SAFE_INTEGER', () => {
    assert.equal(creditCount('9007199254740993'), 9007199254740993n)
    assert.equal(creditCount(12), 12n)
    assert.equal(creditCount('-1'), null)
    assert.equal(creditCount('1.5'), null)
    assert.equal(creditCount(undefined), null)
  })

  it('derives the remaining share in BigInt, like the vendor panel', () => {
    assert.equal(remainingPercent('0', '100'), 100)
    assert.equal(remainingPercent('100', '100'), 0)
    assert.equal(remainingPercent('1', '3'), 67)
    assert.equal(remainingPercent('0', '0'), null)
    assert.equal(remainingPercent('x', '10'), null)
  })

  it('names a window from its duration rather than a policy table', () => {
    assert.equal(windowLabel(18_000), '5 小时')
    assert.equal(windowLabel(604_800), '7 天')
    assert.equal(windowLabel(5_400), '2 小时')
    assert.equal(windowLabel(0), '额度窗口')
    assert.equal(windowLabel(undefined), '额度窗口')
  })

  it('parses the Coding Plan windows the console renders', () => {
    const usage = parseCodingPlanUsage(PLAN)
    assert.equal(usage.tier, 'pro')
    assert.equal(usage.eligible, true)
    assert.equal(usage.windows.length, 1)
    const window = usage.windows[0]
    assert.equal(window.key, 'plan-7d')
    assert.equal(window.label, 'Design Plan · 7 天')
    assert.equal(window.remainingPct, 67)
    assert.equal(window.resetAt, '2026-10-22T00:00:00.000Z')
    assert.equal(window.durationSeconds, 604_800)
  })

  it('orders windows shortest span first', () => {
    const usage = parseCodingPlanUsage({
      windows: [
        { policyId: 'week', durationSeconds: 604_800, usedCredits: '1', limitCredits: '10' },
        { policyId: 'five', durationSeconds: 18_000, usedCredits: '1', limitCredits: '10' },
      ],
    })
    assert.deepEqual(usage.windows.map((window) => window.key), ['five', 'week'])
  })

  it('falls back to limit-minus-remaining when usedCredits is absent', () => {
    const usage = parseCodingPlanUsage({
      windows: [{ policyId: 'w', durationSeconds: 604_800, remainingCredits: '25', limitCredits: '100' }],
    })
    assert.equal(usage.windows[0].remainingPct, 25)
  })

  it('still lists a window whose pair is unreadable, without inventing a share', () => {
    const usage = parseCodingPlanUsage({ windows: [{ policyId: 'w', durationSeconds: 604_800 }] })
    assert.equal(usage.windows.length, 1)
    assert.equal(usage.windows[0].remainingPct, null)
    assert.equal(typeof usage.windows[0].note, 'string')
  })

  it('treats a body with no windows as an empty plan, not a crash', () => {
    for (const body of [{}, { windows: [] }, { windows: 'nope' }, null]) {
      const usage = parseCodingPlanUsage(body)
      assert.deepEqual(usage.windows, [])
      assert.equal(usage.tier, null)
      assert.equal(usage.eligible, false)
    }
  })

  it('parses the preflight snapshot, which carries balance and windows together', () => {
    const snapshot = parsePreflight(PREFLIGHT)
    assert.equal(snapshot.amount, 42.5)
    assert.equal(snapshot.tier, 'pro')
    assert.equal(snapshot.windows.length, 1)
    assert.equal(snapshot.windows[0].remainingPct, 67)
  })

  it('accepts a preflight with a plan but no balance, and vice versa', () => {
    assert.equal(parsePreflight({ codingPlan: PLAN }).windows.length, 1)
    const moneyOnly = parsePreflight({ balanceUsd: '3.25' })
    assert.equal(moneyOnly.amount, 3.25)
    assert.deepEqual(moneyOnly.windows, [])
  })

  it('returns null for a preflight it cannot read, rather than a zero reading', () => {
    for (const body of [{}, null, { unexpected: 1 }, { balanceUsd: 'nope' }]) {
      assert.equal(parsePreflight(body), null)
    }
  })

  it('prefers the personal workspace, and accepts either id spelling', () => {
    assert.deepEqual(
      pickWorkspace({
        items: [
          { id: 'team-1', workspaceType: 'team' },
          { workspaceId: 'personal-1', workspaceType: 'personal', workspaceMemberId: 'm-1' },
        ],
      }),
      { workspaceId: 'personal-1', type: 'personal', memberId: 'm-1' },
    )
    assert.deepEqual(
      pickWorkspace({ workspaces: [{ workspaceId: 'only-team', workspaceType: 'team' }] }),
      { workspaceId: 'only-team', type: 'team', memberId: null },
    )
    assert.equal(pickWorkspace([]), null)
    assert.equal(pickWorkspace({}), null)
    assert.equal(pickWorkspace(null), null)
  })

  it('reads the {"items":[…]} envelope the live control plane returns', () => {
    // Regression: the first live run parsed this as "no workspaces" because the
    // envelope key was assumed rather than observed. The id here is a fixture,
    // not the account it was observed on.
    const picked = pickWorkspace({
      items: [{ workspaceId: 'ws-observed-envelope', workspaceType: 'personal' }],
    })
    assert.equal(picked.workspaceId, 'ws-observed-envelope')
  })
})

describe('opendesign — query flow', () => {
  it('reports NO_CREDENTIAL with an actionable message when there is no login', async () => {
    const { outcome, calls } = await query({
      config: { profiles: {} },
      script: happyPath(),
    })
    assert.equal(outcome.status, STATUS.NO_CREDENTIAL)
    assert.equal(calls.length, 0, 'must not touch the network without a credential')
    assert.match(outcome.message, /controlKey/)
    assert.match(outcome.message, /controlKey|vela login/)
  })

  it('reads the wallet and the plan windows from one preflight call', async () => {
    const { outcome, calls } = await query({ config: { profiles: { prod: profile() } }, script: happyPath() })
    assert.equal(outcome.status, STATUS.OK)
    assert.equal(outcome.result.currency, 'USD')
    assert.equal(outcome.result.amount, 42.5)
    assert.equal(outcome.result.kind, 'quota')
    assert.equal(outcome.result.windows.length, 1)
    assert.equal(outcome.result.display, '7 天 剩 67%')
    // The control plane, not the inference gateway, is what gets contacted.
    assert.ok(calls.every((call) => call.url.startsWith(DEFAULT_AMR_API_URL)))
    assert.ok(calls.some((call) => call.url.endsWith('/billing/preflight')))
    assert.equal(calls[0].url, `${DEFAULT_AMR_API_URL}/api/v1/workspaces`)
    // Every call carries the controlKey, never the runtime key.
    for (const call of calls) {
      assert.equal(call.init.headers.authorization, 'Bearer ctrl-key-from-vela-login')
    }
  })

  it('never calls the session-only coding-plan-usage route', async () => {
    // That route answers 401 to a controlKey; reading it would guarantee a
    // failed plan block even on a healthy account.
    const { calls } = await query({ config: { profiles: { prod: profile() } }, script: happyPath() })
    for (const call of calls) {
      assert.ok(!call.url.includes('coding-plan-usage'), call.url)
    }
  })

  it('resolves the workspace id before asking for the snapshot', async () => {
    const { calls } = await query({ config: { profiles: { prod: profile() } }, script: happyPath() })
    assert.ok(calls.some((call) => call.url.endsWith('/api/v1/workspaces')))
    assert.ok(
      calls.some((call) => call.url.includes('/api/v1/workspaces/ws-personal/billing/preflight')),
    )
  })

  it('reports the wallet alone when preflight is unavailable', async () => {
    const { outcome } = await query({
      config: { profiles: { prod: profile() } },
      script: (url) => {
        if (url.endsWith('/api/v1/workspaces')) return json(WORKSPACES)
        if (url.includes('/billing/preflight')) return json({ error: 'nope' }, 500)
        if (url.endsWith('/api/v1/wallet/balance')) return json(WALLET)
        if (url.endsWith('/api/v1/billing/summary')) return json({ membershipTier: 'go' })
        return json({}, 404)
      },
    })
    assert.equal(outcome.status, STATUS.OK)
    assert.equal(outcome.result.kind, 'balance')
    assert.equal(outcome.result.display, '$42.50')
    assert.equal(outcome.result.amount, 42.5)
    // The tier still comes from the summary, so the readout keeps naming the plan.
    assert.ok(outcome.result.detail.some((row) => row.label === '套餐' && row.value === 'GO'))
    // The failure is still disclosed rather than silently dropped — as a detail
    // row, because `message` is cleared on success by the store.
    assert.equal(outcome.message, null)
    const note = outcome.result.detail.find((row) => row.label === '说明')
    assert.ok(note !== undefined, 'the partial read must be explained')
    assert.match(note.value, /钱包余额仍可正常读取/)
  })

  it('explains a rejected controlKey without blaming the API key', async () => {
    // Both the preflight and the fallback wallet read reject the key.
    const { outcome } = await query({
      config: { profiles: { prod: profile() } },
      script: (url) => {
        if (url.endsWith('/api/v1/workspaces')) return json(WORKSPACES)
        return json({ error: 'unauthenticated' }, 401)
      },
    })
    assert.equal(outcome.status, STATUS.HTTP_ERROR)
    assert.match(outcome.message, /401/)
    assert.match(outcome.message, /vela login/)
    assert.match(outcome.message, /runtime key/)
  })

  it('reports a network failure as such', async () => {
    const { home } = useAmrHome({ profiles: { prod: profile() } })
    const outcome = await runOpenDesignQuery({
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      },
      io: { env: { ...process.env, AMR_HOME: home } },
      timeoutMs: 50,
    })
    assert.equal(outcome.status, STATUS.NETWORK_ERROR)
    assert.match(outcome.message, /失败/)
  })

  it('reports a malformed preflight body as parse-failed with the body echoed', async () => {
    const { outcome } = await query({
      config: { profiles: { prod: profile() } },
      script: (url) => {
        if (url.endsWith('/api/v1/workspaces')) return json(WORKSPACES)
        return json({ unexpected: true })
      },
    })
    assert.equal(outcome.status, STATUS.PARSE_FAILED)
    assert.match(outcome.message, /无法识别的结构/)
  })

  it('reports a malformed wallet body as parse-failed when preflight is down', async () => {
    const { outcome } = await query({
      config: { profiles: { prod: profile() } },
      script: (url) => {
        if (url.endsWith('/api/v1/workspaces')) return json(WORKSPACES)
        if (url.includes('/billing/preflight')) return json({ error: 'down' }, 503)
        if (url.endsWith('/api/v1/billing/summary')) return json({}, 503)
        return json({ unexpected: true })
      },
    })
    assert.equal(outcome.status, STATUS.PARSE_FAILED)
    assert.match(outcome.message, /钱包接口返回了无法识别的结构/)
  })

  it('never sends the runtime key', async () => {
    const { calls } = await query({ config: { profiles: { prod: profile() } }, script: happyPath() })
    for (const call of calls) {
      const header = String(call.init.headers.authorization)
      assert.ok(!header.includes('sk-amr-runtime-key-not-used-here'), 'runtime key must never be sent')
    }
  })
})
