/**
 * Module resolution hook for the test run.
 *
 * The host half imports `@deepseek-ai/*` packages that only exist inside a DSH
 * installation. Mapping them to local stubs lets `apply()` be imported and run
 * unmodified, so the integration tests exercise the shipping code rather than a
 * copy of it kept in sync by hand.
 */

import { pathToFileURL } from 'node:url'

/** Stub modules, keyed by the package name they stand in for. */
const STUBS = {
  '@deepseek-ai/dsh-tools': './stubs/dsh-tools.mjs',
  '@deepseek-ai/schemastery': './stubs/schemastery.mjs',
  '@deepseek-ai/dsh-credentials': './stubs/dsh-credentials.mjs',
}

/**
 * @param {string} specifier
 * @param {object} context
 * @param {(specifier: string, context: object) => Promise<object>} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier]
  if (stub !== undefined) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export { pathToFileURL }
