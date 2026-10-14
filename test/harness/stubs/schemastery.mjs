/**
 * Test stub for `@deepseek-ai/schemastery`.
 *
 * Only the surface this plugin's `Config` uses is implemented. The point is not
 * to re-implement the real schema engine — it is to let `apply()` run unmodified
 * under test, so the tests exercise the shipping code path rather than a copy of
 * it.
 *
 * One rule IS modelled faithfully, because getting it wrong is silent here and
 * fatal in DSH: `validateVolatileSchema`. A `.volatile()` field must sit at a
 * fixed object path, and array elements are always "blocked". An over-permissive
 * stub lets a structurally invalid `Config` pass every test and then fail to
 * load in the real harness, which is exactly what happened once.
 * See `validateVolatile` for the mirrored rule.
 */

/** A chainable, permissive stand-in for a schemastery schema node. */
class SchemaNode {
  constructor(kind, meta = {}) {
    this.kind = kind
    this.meta = meta
  }

  /** Object properties, when this node is an object schema. */
  get dict() {
    return this.kind === 'object' ? this.meta.shape : undefined
  }

  /** The element schema, when this node is an array schema. */
  get inner() {
    return this.kind === 'array' ? this.meta.item : undefined
  }

  /** @param {unknown} value */
  default(value) {
    return new SchemaNode(this.kind, { ...this.meta, default: value })
  }

  /** Mark the field volatile, as the real builder does. */
  volatile() {
    if (this.meta.volatile === true) {
      throw new TypeError('volatile schema is already wrapped')
    }
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
 * Mirror of schemastery's `validateVolatileSchema`.
 *
 * The real rule, read from the shipping implementation:
 *   - a volatile node under a "blocked" ancestor throws;
 *   - an object's properties inherit the parent's blocked/volatile state;
 *   - an array's element schema is validated blocked, ALWAYS — so a volatile
 *     field can never live inside an array, volatile array or not.
 * @param {SchemaNode} schema
 * @param {string[]} [path]
 * @param {boolean} [blocked]
 * @throws {TypeError} when a volatile field sits at a non-fixed path.
 */
export function validateVolatile(schema, path = [], blocked = false) {
  if (schema === undefined || schema === null) return
  if (!(schema instanceof SchemaNode)) return
  if (schema.meta?.volatile === true && blocked) {
    const error = new TypeError(
      'volatile fields require a fixed object path without an enclosing volatile field',
    )
    error.name = 'ValidationError'
    error.path = path
    throw error
  }
  const nested = blocked || schema.meta?.volatile === true
  if (schema.dict !== undefined) {
    for (const [key, child] of Object.entries(schema.dict)) {
      validateVolatile(child, [...path, key], nested)
    }
  }
  if (schema.inner !== undefined) {
    validateVolatile(schema.inner, [...path, '*'], true)
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
