/**
 * Test stub for `@deepseek-ai/dsh-credentials`.
 *
 * Only the two pure helpers the host half imports are needed. The grammar is
 * the documented one — a POSIX shell identifier — because the plugin relies on
 * `isCredentialRefName` returning false for names outside it, and a stub that
 * accepted anything would hide that branch.
 */

/** A credential reference name must be a POSIX shell identifier. */
export const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Brand a raw string as a credential reference.
 * @param {unknown} value
 * @returns {string}
 */
export function credentialRef(value) {
  if (!isCredentialRefName(value)) {
    throw new TypeError(`credential ref "${String(value)}" must match ${String(REF_PATTERN)}`)
  }
  return value
}

/**
 * Whether a raw value could name a reference at all.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCredentialRefName(value) {
  return typeof value === 'string' && REF_PATTERN.test(value)
}

export default { credentialRef, isCredentialRefName, REF_PATTERN }
