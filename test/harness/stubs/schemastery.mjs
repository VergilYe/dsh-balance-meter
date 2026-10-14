/**
 * Test stub for `@deepseek-ai/schemastery`.
 *
 * Only the surface this plugin's `Config` actually uses is implemented. The
 * point is not to re-implement the real schema engine — it is to let `apply()`
 * run unmodified under test, so the tests exercise the shipping code path
 * rather than a copy of it.
 */

/** A chainable, permissive stand-in for a schemastery schema node. */
class SchemaNode {
  constructor(kind, meta = {}) {
    this.kind = kind
    this.meta = meta
  }

  /** @param {unknown} value */
  default(value) {
    return new SchemaNode(this.kind, { ...this.meta, default: value })
  }

  /** Mark the field volatile, as the real builder does. */
  volatile() {
    return new SchemaNode(this.kind, { ...this.meta, volatile: true })
  }

  /** @param {unknown} value */
  role(value) {
    return new SchemaNode(this.kind, { ...this.meta, role: value })
  }

  /** @param {unknown} value */
  required(value = true) {
    return new SchemaNode(this.kind, { ...this.meta, required: value })
  }
}

/**
 * Build a schema node of the given kind.
 * @param {string} kind
 * @returns {SchemaNode}
 */
function node(kind) {
  return new SchemaNode(kind)
}

const Schema = {
  object: (shape) => new SchemaNode('object', { shape }),
  string: () => node('string'),
  number: () => node('number'),
  boolean: () => node('boolean'),
  array: (item) => new SchemaNode('array', { item }),
  union: () => node('union'),
  const: () => node('const'),
}

export default Schema
export { Schema, SchemaNode }
