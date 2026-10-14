/**
 * Test stub for `@deepseek-ai/dsh-tools`.
 *
 * The real package is supplied by the DSH installation, which is not present
 * when these tests run. `defineTool` is an identity function there as far as
 * this plugin is concerned: the registry consumes the definition, and the tests
 * read it back off the stub registry instead.
 */

/**
 * @template T
 * @param {T} definition
 * @returns {T}
 */
export function defineTool(definition) {
  return definition
}

export default { defineTool }
