#!/usr/bin/env node
// Compare the OpenCode client's route surface against the routes the
// oc-bridge registers. Both sides are reduced to `METHOD /segment/:p` so the
// client's `${encodeURIComponent(input.x)}` placeholders and the bridge's
// `:sessionID` placeholders compare equal.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

const CLIENT_CHUNKS = 'node_modules/@opencode/client/dist/chunks'

/**
 * The client's chunk file names carry a content hash, so the file holding the
 * route table is found by size rather than by name.
 */
function clientSource() {
  const dir = join(root, CLIENT_CHUNKS)
  let best = ''
  let bestRoutes = 0
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue
    const source = readFileSync(join(dir, file), 'utf8')
    const count = (source.match(/path: `/g) ?? []).length
    if (count > bestRoutes) {
      bestRoutes = count
      best = source
    }
  }
  return best
}

function clientRoutes() {
  const source = clientSource()
  const pattern = /method: "(GET|POST|PATCH|PUT|DELETE)",\s*\n\s*path: `([^`]+)`/g
  const routes = []
  for (const match of source.matchAll(pattern)) {
    routes.push([match[1], match[2]])
  }
  return routes
}

function bridgeRoutes() {
  const routesDir = join(root, 'src', 'bridge', 'routes')
  const files = [
    join(root, 'src', 'bridge', 'router.ts'),
    join(root, 'src', 'bridge', 'routes.ts'),
    ...(existsSync(routesDir) ? readdirSync(routesDir).map((file) => join(routesDir, file)) : []),
  ]
  const routes = new Map()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/register\(\s*'(GET|POST|PATCH|PUT|DELETE)'\s*,\s*'([^']+)'/g)) {
      const key = `${match[1]} ${match[2]}`
      if (!routes.has(key)) routes.set(key, file.replace(root + '/', ''))
    }
  }
  return routes
}

/** Reduce a path to `METHOD /a/:p/b` so both spellings compare equal. */
function normalize(method, path) {
  const reduced = path
    .replace(/\$\{encodeURIComponent\(input\.[A-Za-z]+\)\}/g, ':p')
    .replace(/\$\{encodePath\(input\.path\)\}/g, ':p')
    .replace(/\*/g, ':p')
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, ':p')
  return `${method} ${reduced}`
}

const registered = bridgeRoutes()
const normalizedRegistered = new Map()
for (const [key, file] of registered) {
  const [method, ...rest] = key.split(' ')
  normalizedRegistered.set(normalize(method, rest.join(' ')), file)
}

const clientKeys = new Set(clientRoutes().map(([m, p]) => normalize(m, p)))
const missing = []
for (const [method, path] of clientRoutes()) {
  const key = normalize(method, path)
  if (!normalizedRegistered.has(key) && !missing.includes(key)) missing.push(key)
}

const extra = []
for (const key of normalizedRegistered.keys()) {
  if (!clientKeys.has(key)) extra.push(key)
}

console.log(`client routes: ${clientRoutes().length}`)
console.log(`bridge routes: ${registered.size}`)
console.log(`missing: ${missing.length}`)
for (const key of missing.sort()) console.log(`  MISSING ${key}`)
console.log(`bridge-only: ${extra.length}`)
for (const key of extra.sort()) console.log(`  EXTRA   ${key}`)

process.exit(missing.length === 0 ? 0 : 1)
