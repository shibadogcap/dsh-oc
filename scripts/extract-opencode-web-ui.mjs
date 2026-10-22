#!/usr/bin/env node
// Extract the official opencode web UI assets from the opencode binary.
//
// The CLI embeds the web UI as one AppArchive (see the opencode source,
// packages/cli/src/app-archive.ts): a little-endian u32 byte length of a JSON
// index, the index of each asset's [offset, length] in the body, then the body
// of brotli-compressed assets.
//
//   node scripts/extract-opencode-web-ui.mjs --bin <path> --out <dir>
//
// The dsh-oc bridge serves the result, so the browser loads the official
// OpenCode UI from the same origin as the API and needs no CORS or login.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const bin = option('--bin', '')
const out = resolve(option('--out', 'opencode-web-ui'))
if (!bin || !existsSync(bin)) {
  console.error('usage: node scripts/extract-opencode-web-ui.mjs --bin <opencode binary> --out <dir>')
  process.exit(2)
}

const data = readFileSync(bin)
console.log(`binary: ${bin} (${data.length} bytes)`)

// The archive starts with a u32 length followed by a JSON index of
// [offset, length] pairs. Scan for a JSON object whose values are such pairs
// and whose byte length matches the header.
let found = -1
let indexLength = 0
let index = null
const needle = Buffer.from('{"')
let at = 0
while (at < data.length) {
  const start = data.indexOf(needle, at)
  if (start === -1) break
  at = start + 1
  if (start < 4) continue
  const end = data.indexOf('}', start)
  if (end === -1) continue
  const length = data.readUInt32LE(start - 4)
  if (length !== end + 1 - start) continue
  let parsed
  try {
    parsed = JSON.parse(data.subarray(start, start + length).toString('utf8'))
  } catch {
    continue
  }
  if (!parsed || typeof parsed !== 'object') continue
  const values = Object.values(parsed)
  if (values.length < 3) continue
  const ok = values.every((value) => Array.isArray(value) && value.length === 2 && value.every((n) => Number.isInteger(n)))
  if (!ok) continue
  found = start
  indexLength = length
  index = parsed
  break
}
if (found === -1) {
  console.error('no AppArchive found in the binary')
  process.exit(1)
}
console.log(`AppArchive: index at ${found}, ${indexLength} bytes, ${Object.keys(index).length} assets`)

const body = found + indexLength
let written = 0
for (const [key, [offset, length]] of Object.entries(index)) {
  const compressed = data.subarray(body + offset, body + offset + length)
  let content
  try {
    content = brotliDecompressSync(compressed)
  } catch {
    content = compressed
  }
  const target = join(out, key)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  written++
}
console.log(`extracted ${written} assets to ${out}`)
