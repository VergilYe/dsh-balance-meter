/**
 * Guards the shape of the plugin's `Config` against schemastery's volatile rule.
 *
 * A structurally invalid `Config` does not fail any behavioural test: the
 * plugin's logic is fine, and it is only the Loader that rejects the schema —
 * at load time, in the user's install, with the plugin simply not activating.
 * That is how `routes[].id` shipped as a volatile field inside an array and
 * broke the first real install. This file exists so it cannot happen again.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Config } from '../plugin/index.mjs'
import { SchemaNode, validateVolatile } from './harness/stubs/schemastery.mjs'

describe('Config schema', () => {
  it('passes the volatile fixed-path rule the real Loader enforces', () => {
    assert.doesNotThrow(
      () => validateVolatile(Config),
      'Config has a volatile field at a non-fixed path; the real Loader would refuse to activate the plugin',
    )
  })

  it('still exposes the top-level settings the form edits as volatile', () => {
    for (const field of ['primary', 'autoRefresh', 'minIntervalSec']) {
      const node = Config.dict[field]
      assert.ok(node instanceof SchemaNode, `Config.${field} is missing`)
      assert.equal(
        node.meta.volatile,
        true,
        `Config.${field} must be volatile or the Plugins-page form cannot edit it`,
      )
    }
  })

  it('keeps the routes list out of the volatile projection', () => {
    // schemastery validates every array element as blocked, so a volatile
    // element schema is structurally impossible — and a volatile array would
    // block its own children too. `routes` is therefore an ordinary field,
    // written through configEditor.edit (which reloads the row) rather than
    // through the settings form.
    const routes = Config.dict.routes
    assert.equal(routes.kind, 'array')
    assert.notEqual(routes.meta.volatile, true)
    assert.notEqual(routes.inner.meta.volatile, true)
  })
})

describe('the stub mirrors the real rule', () => {
  it('rejects a volatile field nested inside a plain array element', () => {
    const schema = SchemaNode.prototype.volatile.call(new SchemaNode('object', {
      shape: { id: new SchemaNode('string').volatile() },
    }))
    assert.throws(() => validateVolatile(schema), /fixed object path/)
  })

  it('rejects a volatile field inside an array even when the array is volatile', () => {
    const item = new SchemaNode('object', { shape: { id: new SchemaNode('string').volatile() } })
    const schema = new SchemaNode('array', { item }).volatile()
    assert.throws(() => validateVolatile(schema), /fixed object path/)
  })

  it('rejects a volatile object whose children are volatile', () => {
    const schema = new SchemaNode('object', {
      shape: { nested: new SchemaNode('string').volatile() },
    }).volatile()
    assert.throws(() => validateVolatile(schema), /fixed object path/)
  })

  it('accepts a volatile field at a fixed top-level path', () => {
    const schema = new SchemaNode('object', {
      shape: { primary: new SchemaNode('string').volatile() },
    })
    assert.doesNotThrow(() => validateVolatile(schema))
  })

  it('accepts an ordinary array of objects', () => {
    const schema = new SchemaNode('object', {
      shape: {
        routes: new SchemaNode('array', {
          item: new SchemaNode('object', { shape: { id: new SchemaNode('string') } }),
        }),
      },
    })
    assert.doesNotThrow(() => validateVolatile(schema))
  })
})
