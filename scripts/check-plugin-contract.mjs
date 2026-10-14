#!/usr/bin/env node
/**
 * Static contract check — runs with no DSH installed.
 *
 * DSH's plugin failure modes are mostly silent: a bare `@deepseek-ai/*` import
 * that is not declared, a bundle patch that does not name the package, an
 * `exports["./client"]` that is missing or unshipped, or a browser half whose
 * module id does not equal the package name. Each of those produces a plugin
 * that simply does not load, with the reason buried in a launcher log. This
 * script turns them into a list.
 *
 * Usage: node scripts/check-plugin-contract.mjs [--dir <plugin-root>]
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..')

/** Modules the browser host seeds for every client bundle. */
const PLATFORM_SEEDS = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'])

/** Capabilities a DSH plugin row may request of the profile. */
const failures = []
const notes = []

/**
 * Record a failed check.
 * @param {string} message
 */
function fail(message) {
  failures.push(message)
}

/**
 * Record a passing check worth seeing.
 * @param {string} message
 */
function note(message) {
  notes.push(message)
}

/**
 * Read and parse a JSON file, recording a failure instead of throwing.
 * @param {string} path
 * @returns {object | undefined}
 */
function readJson(path) {
  if (!existsSync(path)) {
    fail(`missing file: ${path}`)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`invalid JSON in ${path}: ${error.message}`)
    return undefined
  }
}

/**
 * Read a text file, recording a failure instead of throwing.
 * @param {string} path
 * @returns {string | undefined}
 */
function readText(path) {
  if (!existsSync(path)) {
    fail(`missing file: ${path}`)
    return undefined
  }
  return readFileSync(path, 'utf8')
}

/**
 * Assert a file exists and is non-empty.
 * @param {string} root
 * @param {string} relative
 * @param {string} what
 */
function requireFile(root, relative, what) {
  const path = join(root, relative)
  if (!existsSync(path)) {
    fail(`${what}: ${relative} does not exist`)
    return false
  }
  if (statSync(path).size === 0) {
    fail(`${what}: ${relative} is empty`)
    return false
  }
  return true
}

/**
 * Collect the specifiers of bare (non-relative, non-node:) static imports.
 * @param {string} source
 * @returns {string[]}
 */
function bareImports(source) {
  const specifiers = []
  const patterns = [
    /^\s*import\s+[^'"]*?from\s+['"]([^'"]+)['"]/gm,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /^\s*export\s+[^'"]*?from\s+['"]([^'"]+)['"]/gm,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
      specifiers.push(specifier)
    }
  }
  return [...new Set(specifiers)]
}

/**
 * Reduce a bare specifier to the package name it resolves from.
 * @param {string} specifier
 * @returns {string}
 */
function packageOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * Normalise a manifest path for comparison: drop a leading `./` and any
 * trailing slash, so `./client/client.js` and `client/` compare predictably.
 * @param {string} value
 * @returns {string}
 */
function normalize(value) {
  return value.replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * Remove comments so a source scan cannot be tripped by prose.
 *
 * The style check below looks for `@import` and remote `url()`. Without this,
 * a doc comment that *describes* those rules (as this project's own browser
 * half does) reads as a violation of them.
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/)/.test(line))
    .join('\n')
}

/**
 * Run every check.
 * @param {string} root
 */
function check(root) {
  const manifest = readJson(join(root, 'package.json'))
  if (manifest === undefined) return

  // ── manifest basics ──────────────────────────────────────────────────────
  const name = manifest.name
  if (typeof name !== 'string' || name === '') fail('package.json: missing "name"')
  if (manifest.type !== 'module') fail('package.json: "type" must be "module"')
  if (typeof manifest.description !== 'string' || manifest.description === '') {
    fail('package.json: missing "description" (shown on the Plugins page)')
  }

  // ── entry points ─────────────────────────────────────────────────────────
  const main = manifest.main ?? manifest.exports?.['.']
  if (typeof main !== 'string') {
    fail('package.json: no "main" or exports["."]')
  } else if (requireFile(root, main, 'host entry')) {
    note(`host entry: ${main}`)
  }

  const clientExport = manifest.exports?.['./client']
  if (typeof clientExport !== 'string') {
    fail('package.json: missing exports["./client"], so the browser half can never load')
  } else if (requireFile(root, clientExport, 'browser entry')) {
    note(`browser entry: ${clientExport}`)
  }

  const files = Array.isArray(manifest.files) ? manifest.files : []
  if (files.length > 0) {
    for (const [label, target] of [['host entry', main], ['browser entry', clientExport]]) {
      if (typeof target !== 'string') continue
      const wanted = normalize(target)
      const covered = files.some((entry) => {
        const shipped = normalize(entry)
        return wanted === shipped || wanted.startsWith(`${shipped}/`)
      })
      if (!covered) fail(`package.json: "files" does not ship the ${label} (${target})`)
    }
  } else {
    notes.push('note: package.json has no "files" list, so everything is published')
  }

  // ── bundle declaration ───────────────────────────────────────────────────
  const bundle = manifest.dsh?.bundle
  if (bundle === undefined) {
    fail('package.json: missing dsh.bundle, so `dsh plugin add` will not register a bundle layer')
  } else if (typeof bundle.patch !== 'string') {
    fail('package.json: dsh.bundle.patch must be a path')
  } else if (requireFile(root, bundle.patch, 'bundle patch')) {
    const patch = readText(join(root, bundle.patch)) ?? ''
    if (typeof name === 'string' && !patch.includes(name)) {
      fail(`dsh.bundle.patch (${bundle.patch}) never names the package "${name}"`)
    }
    const rowIds = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((match) => match[1])
    if (rowIds.length === 0) {
      fail(`dsh.bundle.patch (${bundle.patch}) declares no row id`)
    } else {
      note(`bundle rows: ${rowIds.join(', ')}`)
    }
  }

  // ── client declaration ───────────────────────────────────────────────────
  const client = manifest.dsh?.client
  if (client === undefined) {
    fail('package.json: missing dsh.client, so the browser half is never scanned')
  } else {
    if (client.platform !== 'web') {
      fail(`package.json: dsh.client.platform is "${String(client.platform)}", expected "web"`)
    }
    if (client.external !== undefined && !Array.isArray(client.external)) {
      fail('package.json: dsh.client.external must be an array')
    }
  }

  // ── peer dependencies ────────────────────────────────────────────────────
  const peers = manifest.peerDependencies ?? {}
  const hostSource = typeof main === 'string' && existsSync(join(root, main))
    ? readText(join(root, main)) ?? ''
    : ''
  const hostModules = bareImports(hostSource)
  const undeclared = hostModules.filter((specifier) => {
    const pkg = packageOf(specifier)
    if (pkg.startsWith('@deepseek-ai/') && !(pkg in peers)) return true
    return false
  })
  if (undeclared.length > 0) {
    fail(
      `host half imports ${undeclared.join(', ')} without declaring them in peerDependencies`
      + ' — a linked or symlinked install resolves harness packages only for declared names',
    )
  }
  for (const specifier of hostModules) {
    note(`host imports: ${specifier}`)
  }

  // ── host half exports ────────────────────────────────────────────────────
  if (hostSource !== '') {
    for (const symbol of ['name', 'inject', 'apply']) {
      const pattern = new RegExp(`export\\s+(?:const|function|async function)\\s+${symbol}\\b`)
      if (!pattern.test(hostSource)) {
        fail(`host half does not export ${symbol} — DSH will not load it as a plugin`)
      }
    }
    if (!/export\s+(?:const|function)\s+Config\b/.test(hostSource)) {
      fail('host half does not export Config, so the Plugins page has no settings to project')
    }
  }

  // ── browser half ─────────────────────────────────────────────────────────
  if (typeof clientExport === 'string' && existsSync(join(root, clientExport))) {
    const clientSource = readText(join(root, clientExport)) ?? ''

    if (/^\s*import\s/m.test(clientSource)) {
      fail(`${clientExport}: uses a top-level "import" — client bundles are classic scripts and must use require()`)
    }

    const loaderMatch = clientSource.match(/__ModuleLoader__\s*\.\s*load\(\s*\{[\s\S]*?id\s*:\s*['"]([^'"]+)['"]/)
    if (loaderMatch === null) {
      fail(`${clientExport}: no window.__ModuleLoader__.load({ id, factory }) call`)
    } else if (loaderMatch[1] !== name) {
      fail(
        `${clientExport}: module id is "${loaderMatch[1]}" but the package name is "${name}"`
        + ' — the loader addresses bundles by package name',
      )
    } else {
      note(`browser module id: ${loaderMatch[1]}`)
    }

    const requires = [...clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map((match) => match[1])
    const extras = manifest.dsh?.client?.external ?? []
    for (const specifier of requires) {
      if (PLATFORM_SEEDS.has(specifier)) continue
      if (extras.includes(specifier)) continue
      fail(
        `${clientExport}: requires "${specifier}", which is not a platform seed`
        + ` (${[...PLATFORM_SEEDS].join(', ')}) and is not listed in dsh.client.external`,
      )
    }
    note(`browser requires: ${[...new Set(requires)].join(', ') || '(none)'}`)

    const configKey = clientSource.match(
      /name\s*:\s*['"]plugins\.bundle\.config['"]\s*,\s*key\s*:\s*['"]([^'"]+)['"]/,
    )
    if (configKey !== null && configKey[1] !== name) {
      fail(
        `${clientExport}: the plugins.bundle.config slot is keyed "${configKey[1]}" but the`
        + ` package name is "${name}" — the page dispatches on the package name`,
      )
    } else if (configKey !== null) {
      note(`bundle config key: ${configKey[1]}`)
    }

    if (/@import|url\(\s*['"]?https?:/i.test(stripComments(clientSource))) {
      fail(`${clientExport}: styles must be self-contained (no @import, no remote url())`)
    }
  }
}

const argv = process.argv.slice(2)
const dirIndex = argv.indexOf('--dir')
const root = dirIndex >= 0 && argv[dirIndex + 1] !== undefined ? resolve(argv[dirIndex + 1]) : DEFAULT_ROOT

check(root)

for (const line of notes) console.log(`  ok   ${line}`)
if (failures.length === 0) {
  console.log(`\ncontract check passed (${root})`)
  process.exit(0)
}
console.error('')
for (const line of failures) console.error(`  FAIL ${line}`)
console.error(`\ncontract check failed: ${failures.length} problem(s)`)
process.exit(1)
