import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ALLOWED_HOSTS,
  CATALOG,
  candidateURLs,
  findById,
  hostOf,
  matchRoute,
} from '../plugin/catalog.mjs'

describe('catalog data', () => {
  it('has eight entries with unique ids', () => {
    assert.equal(CATALOG.length, 8)
    assert.equal(new Set(CATALOG.map((e) => e.id)).size, 8)
  })

  it('gives every entry a parser adapter, a label, and at least one credential variable', () => {
    for (const entry of CATALOG) {
      assert.ok(entry.label.length > 0, `${entry.id} has no label`)
      assert.ok(entry.adapter.length > 0, `${entry.id} has no adapter`)
      assert.ok(entry.env.length > 0, `${entry.id} has no credential variable`)
      assert.ok(['api', 'subscription'].includes(entry.billing), `${entry.id} has odd billing`)
    }
  })

  it('declares a note exactly when it has no endpoint', () => {
    for (const entry of CATALOG) {
      if (entry.endpoint === null) {
        assert.ok(entry.note.length > 0, `${entry.id} has no endpoint and no note`)
      }
    }
  })

  it('keeps every endpoint template on the entry’s own hosts', () => {
    // This is the guarantee that the plugin only ever contacts vendor domains.
    for (const entry of CATALOG) {
      assert.ok(entry.endpoint !== null)
      assert.ok(entry.endpoint.startsWith('{origin}'), `${entry.id} endpoint is not origin-relative`)
    }
  })
})

describe('findById', () => {
  it('finds a known id', () => {
    assert.equal(findById('deepseek')?.label, 'DeepSeek')
  })

  it('returns undefined for unknown or malformed input', () => {
    assert.equal(findById('nope'), undefined)
    assert.equal(findById(''), undefined)
    assert.equal(findById(undefined), undefined)
    assert.equal(findById(42), undefined)
  })
})

describe('hostOf', () => {
  it('reads a hostname from an absolute URL', () => {
    assert.equal(hostOf('https://api.deepseek.com/v1'), 'api.deepseek.com')
  })

  it('lowercases and tolerates a bare host', () => {
    assert.equal(hostOf('API.DeepSeek.com'), 'api.deepseek.com')
  })

  it('returns undefined rather than throwing on junk', () => {
    assert.equal(hostOf(''), undefined)
    assert.equal(hostOf(undefined), undefined)
    assert.equal(hostOf('http://'), undefined)
  })
})

describe('matchRoute', () => {
  it('matches on an exact provider id', () => {
    const match = matchRoute({ id: 'deepseek', baseURL: 'https://example.com' })
    assert.equal(match?.entry.id, 'deepseek')
    assert.equal(match?.matchedBy, 'id')
  })

  it('matches on hostname when the id is unknown', () => {
    const match = matchRoute({ id: 'my-route', baseURL: 'https://api.moonshot.cn/v1' })
    assert.equal(match?.entry.id, 'moonshot')
    assert.equal(match?.matchedBy, 'host')
  })

  it('matches an alias hostname', () => {
    assert.equal(matchRoute({ baseURL: 'https://api.moonshot.ai/v1' })?.entry.id, 'moonshot')
    assert.equal(matchRoute({ baseURL: 'https://api.siliconflow.com/v1' })?.entry.id, 'siliconflow')
    assert.equal(matchRoute({ baseURL: 'https://api.z.ai/api/paas/v4' })?.entry.id, 'zhipu')
  })

  it('returns undefined for an uncatalogued gateway', () => {
    assert.equal(matchRoute({ id: 'my-relay', baseURL: 'https://relay.example.com/v1' }), undefined)
  })

  it('returns undefined for malformed input', () => {
    assert.equal(matchRoute(null), undefined)
    assert.equal(matchRoute(undefined), undefined)
    assert.equal(matchRoute('deepseek'), undefined)
    assert.equal(matchRoute({}), undefined)
  })

  it('prefers the id match over a conflicting host', () => {
    // A user may deliberately point a vendor id at a different gateway.
    const match = matchRoute({ id: 'moonshot', baseURL: 'https://api.deepseek.com' })
    assert.equal(match?.entry.id, 'moonshot')
    assert.equal(match?.matchedBy, 'id')
  })

  it('resolves an adapter-suffixed id to the vendor entry', () => {
    // Adapters name their own routes `deepseek-official`, `deepseek-account`,
    // and the like. The vendor is plainly known, so treating these as
    // uncatalogued would be wrong.
    for (const [id, expected] of [
      ['deepseek-official', 'deepseek'],
      ['deepseek-account', 'deepseek'],
      ['deepseek-api-key', 'deepseek'],
      ['moonshot-official', 'moonshot'],
    ]) {
      const match = matchRoute({ id })
      assert.equal(match?.entry.id, expected, `${id} did not resolve to ${expected}`)
      assert.equal(match?.matchedBy, 'id-alias')
    }
  })

  it('still reports an unrelated id as uncatalogued', () => {
    assert.equal(matchRoute({ id: 'deepseek-proxy' }), undefined)
    assert.equal(matchRoute({ id: 'official' }), undefined)
  })

  it('matches an aliased id even when the host is unknown', () => {
    const match = matchRoute({ id: 'deepseek-official', baseURL: 'https://relay.example.com/v1' })
    assert.equal(match?.entry.id, 'deepseek')
    assert.equal(match?.matchedBy, 'id-alias')
  })
})

describe('candidateURLs', () => {
  it('builds an absolute URL from the origin template', () => {
    const urls = candidateURLs(findById('deepseek'))
    assert.deepEqual(urls, ['https://api.deepseek.com/user/balance'])
  })

  it('ignores the route path, so a /v1 suffix cannot leak into the path', () => {
    const urls = candidateURLs(findById('moonshot'), { baseURL: 'https://api.moonshot.cn/v1' })
    assert.deepEqual(urls, ['https://api.moonshot.cn/v1/users/me/balance'])
  })

  it('tries a user endpoint first, then the catalog default', () => {
    const urls = candidateURLs(findById('deepseek'), { endpoint: '{origin}/custom/balance' })
    assert.deepEqual(urls, [
      'https://api.deepseek.com/custom/balance',
      'https://api.deepseek.com/user/balance',
    ])
  })

  it('expands {base} to the route baseURL', () => {
    const urls = candidateURLs(findById('deepseek'), {
      baseURL: 'https://api.deepseek.com',
      endpoint: '{base}/user/balance',
    })
    assert.equal(urls[0], 'https://api.deepseek.com/user/balance')
  })

  it('de-duplicates when the override equals the default', () => {
    const urls = candidateURLs(findById('deepseek'), { endpoint: '{origin}/user/balance' })
    assert.equal(urls.length, 1)
  })

  it('returns nothing when the vendor has no endpoint and the user set none', () => {
    const synthetic = { ...findById('deepseek'), endpoint: null }
    assert.deepEqual(candidateURLs(synthetic), [])
  })

  it('still offers a user endpoint for a vendor with no catalog endpoint', () => {
    const synthetic = { ...findById('deepseek'), endpoint: null }
    assert.deepEqual(candidateURLs(synthetic, { endpoint: '{origin}/x' }), [
      'https://api.deepseek.com/x',
    ])
  })
})

describe('ALLOWED_HOSTS', () => {
  it('lists every vendor host, and nothing else', () => {
    for (const host of ALLOWED_HOSTS) {
      assert.ok(CATALOG.some((entry) => entry.hosts.includes(host)), `${host} is not a vendor host`)
    }
    assert.ok(ALLOWED_HOSTS.includes('api.deepseek.com'))
    assert.ok(!ALLOWED_HOSTS.includes('example.com'))
  })
})
