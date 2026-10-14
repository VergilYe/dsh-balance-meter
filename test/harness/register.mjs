/**
 * Installs the harness-stub resolution hook. Loaded with `node --import`.
 */

import { register } from 'node:module'

register('./loader.mjs', import.meta.url)
