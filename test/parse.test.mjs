import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ParseError, describeWindow, formatMoney, parseResponse } from '../plugin/parse.mjs'
import { CATALOG } from '../plugin/catalog.mjs'

describe('formatMoney', () => {
  it('prefixes the known currency symbols', () => {
    assert.equal(formatMoney(12.3, 'CNY'), '¥12.30')
    assert.equal(formatMoney(0, 'USD'), '$0.00')
  })

  it('falls back to the code for an unknown currency', () => {
    assert.equal(formatMoney(5, 'SGD'), 'SGD 5.00')
  })

  it('omits any prefix when the currency is unknown', () => {
    assert.equal(formatMoney(5, null), '5.00')
  })
})

describe('every catalog adapter', () => {
  it('has a registered parser', () => {
    for (const entry of CATALOG) {
      // An unregistered adapter would throw its own distinct message; assert
      // the adapter is at least reachable so a typo cannot ship.
      assert.throws(
        () => parseResponse(entry.adapter, {}),
        (error) => error instanceof ParseError && !error.message.includes('没有为适配器'),
        `adapter ${entry.adapter} is not registered`,
      )
    }
  })

  it('reports an unknown adapter rather than guessing', () => {
    assert.throws(() => parseResponse('nope', {}), /没有为适配器 nope 注册解析器/)
  })

  it('rejects an empty body for every adapter', () => {
    for (const entry of CATALOG) {
      assert.throws(
        () => parseResponse(entry.adapter, {}),
        ParseError,
        `${entry.adapter} accepted an empty body`,
      )
    }
  })
})

describe('deepseek', () => {
  it('reads total_balance and keeps the currency', () => {
    const result = parseResponse('deepseek', {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      ],
    })
    assert.equal(result.kind, 'balance')
    assert.equal(result.amount, 110)
    assert.equal(result.currency, 'CNY')
    assert.equal(result.display, '¥110.00')
  })

  it('sums entries that share a currency and ignores other currencies', () => {
    const result = parseResponse('deepseek', {
      balance_infos: [
        { currency: 'CNY', total_balance: '10.00' },
        { currency: 'CNY', total_balance: '5.50' },
        { currency: 'USD', total_balance: '99.00' },
      ],
    })
    assert.equal(result.amount, 15.5)
    assert.equal(result.currency, 'CNY')
  })

  it('accepts numeric rather than string amounts', () => {
    const result = parseResponse('deepseek', { balance_infos: [{ currency: 'USD', total_balance: 3 }] })
    assert.equal(result.amount, 3)
  })

  it('refuses a shape without balance_infos', () => {
    assert.throws(() => parseResponse('deepseek', { data: {} }), /balance_infos/)
  })
})

describe('openrouter', () => {
  it('reads limit_remaining', () => {
    const result = parseResponse('openrouter', {
      data: { label: 'k', limit: 100, usage: 25.5, limit_remaining: 74.5 },
    })
    assert.equal(result.amount, 74.5)
    assert.equal(result.display, '$74.50')
  })

  it('treats a null limit as an unlimited key, not a parse failure', () => {
    const result = parseResponse('openrouter', { data: { limit: null, usage: 12, limit_remaining: null } })
    assert.equal(result.display, '无限额')
    assert.equal(result.amount, null)
  })

  it('refuses a body with no recognisable field', () => {
    assert.throws(() => parseResponse('openrouter', { data: { label: 'x' } }), ParseError)
  })
})

describe('moonshot', () => {
  it('reads available_balance', () => {
    const result = parseResponse('moonshot', {
      code: 0,
      status: true,
      data: { available_balance: 49.58, voucher_balance: 0, cash_balance: 49.58 },
    })
    assert.equal(result.amount, 49.58)
    assert.equal(result.display, '¥49.58')
    assert.ok(result.detail.some((row) => row.label === '现金'))
  })

  it('accepts camelCase field names', () => {
    const result = parseResponse('moonshot', { data: { availableBalance: 1.5 } })
    assert.equal(result.amount, 1.5)
  })

  it('refuses a shape without a balance field', () => {
    assert.throws(() => parseResponse('moonshot', { data: { id: 'x' } }), ParseError)
  })
})

describe('siliconflow', () => {
  it('prefers totalBalance over balance', () => {
    const result = parseResponse('siliconflow', {
      status: true,
      data: { balance: '1.00', chargeBalance: '2.00', totalBalance: '3.00' },
    })
    assert.equal(result.amount, 3)
    assert.equal(result.display, '¥3.00')
  })

  it('falls back to balance', () => {
    assert.equal(parseResponse('siliconflow', { data: { balance: '0.88' } }).amount, 0.88)
  })

  it('refuses a shape without either field', () => {
    assert.throws(() => parseResponse('siliconflow', { data: { id: 'x' } }), ParseError)
  })
})

describe('zhipu', () => {
  it('reads an explicit used/limit pair into a remaining percentage', () => {
    const result = parseResponse('zhipu', { data: { limits: [{ used: 25, limit: 100, number: 5 }] } })
    assert.equal(result.kind, 'quota')
    assert.equal(result.windows.length, 1)
    assert.equal(result.windows[0].remainingPct, 75)
    assert.ok(result.windows[0].label.includes('5 小时'))
  })

  it('labels a bare percentage as 已用 rather than inverting an unlabelled number', () => {
    const result = parseResponse('zhipu', { data: { limits: [{ percentage: 30, type: 'weekly' }] } })
    assert.equal(result.windows[0].remainingPct, null)
    assert.match(result.windows[0].note, /方向未标注/)
  })

  it('shows the tightest window on the chip', () => {
    const result = parseResponse('zhipu', {
      data: { limits: [{ used: 10, limit: 100, name: 'loose' }, { used: 90, limit: 100, name: 'tight' }] },
    })
    assert.match(result.display, /tight/)
    assert.match(result.display, /10%/)
  })

  it('refuses a body with no window-shaped object', () => {
    assert.throws(() => parseResponse('zhipu', { data: { level: 'pro' } }), ParseError)
  })
})

describe('kimiCoding', () => {
  it('reads a data array of windows', () => {
    const result = parseResponse('kimiCoding', {
      data: [
        { window: '5h', used: 3, limit: 10 },
        { window: 'weekly', used: 20, limit: 100 },
      ],
    })
    assert.equal(result.windows.length, 2)
    assert.equal(result.windows[0].remainingPct, 70)
  })

  it('accepts usage as an alias for used', () => {
    const result = parseResponse('kimiCoding', { data: [{ window: 'w', usage: 1, limit: 4 }] })
    assert.equal(result.windows[0].remainingPct, 75)
  })

  it('refuses an empty window list', () => {
    assert.throws(() => parseResponse('kimiCoding', { data: [] }), ParseError)
  })
})

describe('minimax', () => {
  it('reads a remaining field', () => {
    const result = parseResponse('minimax', { remains: [{ name: 'mini', remaining: 40, total: 100 }] })
    assert.equal(result.kind, 'quota')
    assert.equal(result.display, '40/100')
    assert.equal(result.windows[0].used, 60)
  })

  it('refuses a body with no remaining-style field', () => {
    assert.throws(() => parseResponse('minimax', { plan: 'x' }), ParseError)
  })
})

describe('opencodeGo', () => {
  it('reads named windows', () => {
    const result = parseResponse('opencodeGo', {
      data: [
        { window: 'rolling', used: 5, limit: 20 },
        { window: 'monthly', used: 1, limit: 100 },
      ],
    })
    assert.equal(result.windows.length, 2)
    assert.match(result.display, /rolling/)
  })

  it('tolerates a single nested window object rather than an array', () => {
    const result = parseResponse('opencodeGo', { data: { window: 'weekly', used: 1, limit: 2 } })
    assert.equal(result.windows.length, 1)
  })

  it('refuses a body with no window', () => {
    assert.throws(() => parseResponse('opencodeGo', { data: { plan: 'go' } }), ParseError)
  })
})

describe('describeWindow', () => {
  it('renders a used/limit pair', () => {
    assert.equal(
      describeWindow({ key: 'k', label: 'w', used: 25, limit: 100, remainingPct: 75 }),
      '已用 25 / 100（剩 75%）',
    )
  })

  it('never claims a percentage it does not have', () => {
    const line = describeWindow({ key: 'k', label: 'w', used: null, limit: null, remainingPct: null })
    assert.equal(line, '接口未给出可读数值')
  })
})

describe('quota windows', () => {
  it('clamps a percentage into 0..100', () => {
    const result = parseResponse('kimiCoding', { data: [{ window: 'w', used: 150, limit: 100 }] })
    assert.equal(result.windows[0].remainingPct, 0)
  })

  it('de-duplicates a window the response repeats', () => {
    const row = { window: 'w', used: 1, limit: 4 }
    const result = parseResponse('kimiCoding', { data: [row, { ...row }] })
    assert.equal(result.windows.length, 1)
  })

  it('does not divide by a zero limit', () => {
    const result = parseResponse('kimiCoding', { data: [{ window: 'w', used: 1, limit: 0 }] })
    assert.equal(result.windows[0].remainingPct, null)
  })
})
