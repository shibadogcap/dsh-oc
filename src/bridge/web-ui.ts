// The official opencode web UI, served by the bridge from its own origin.
//
// The opencode CLI embeds the web UI as one AppArchive (packages/cli/src/
// app-archive.ts in the opencode source): a little-endian u32 byte length of
// a JSON index, the index of each asset's [offset, length] in the body, then
// the body of brotli-compressed assets. The bridge extracts that archive once
// and serves the files itself.
//
// Serving the UI from the API's own origin is what the official setup does
// (`opencode serve` serves both), and it removes the two obstacles a browser
// UI runs into otherwise: the app talks to the API same-origin (no CORS, no
// cookie) and the app needs no login.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'
import { dirname, extname, join, resolve } from 'node:path'
import type { ServerResponse } from 'node:http'

/** The mime types the web UI needs; the official server uses the same set. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
}

export function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** The directory the extracted UI lives in, if it is already there. */
export function webUiDir(explicit?: string): string | undefined {
  if (explicit === undefined || explicit.length === 0) return undefined
  const dir = resolve(explicit)
  return existsSync(join(dir, 'index.html')) ? dir : undefined
}

/**
 * Find the directory of the official opencode web UI.
 *
 * The order is the same as the official setup: an explicit directory wins,
 * then the extracted copy under `$DSH_HOME/opencode/web-ui/<version>`, and
 * the assets are extracted from the opencode binary when they are missing.
 * Returns undefined when there is no opencode binary to extract them from, so
 * the bridge simply does not serve a web UI.
 */
export function resolveWebUiDir(options: {
  explicit?: string
  home?: string
  version: string
  binary?: string
  log?: (message: string) => void
} = { version: '0.0.0' }): string | undefined {
  const explicit = webUiDir(options.explicit)
  if (explicit !== undefined) return explicit
  if (options.home === undefined || options.binary === undefined) return undefined
  const dir = join(options.home, 'opencode', 'web-ui', options.version)
  const existing = webUiDir(dir)
  if (existing !== undefined) return existing
  if (!existsSync(options.binary)) return undefined
  try {
    const written = extractWebUi(options.binary, dir)
    if (written === 0) return undefined
    options.log?.(`extracted ${written} web UI assets from ${options.binary} into ${dir}`)
    return webUiDir(dir)
  } catch (error) {
    options.log?.(`web UI extraction failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Extract the web UI assets the opencode binary embeds into `dir`.
 *
 * Returns the number of files written. The archive is searched for by its
 * shape (a JSON index of [offset, length] pairs whose byte length matches the
 * u32 header in front of it), so no build detail has to be known here.
 */
export function extractWebUi(binary: string, dir: string): number {
  const data = readFileSync(binary)
  const index = findArchiveIndex(data)
  if (index === undefined) return 0
  const body = index.at + index.length
  let written = 0
  for (const [key, [offset, length]] of Object.entries(index.entries)) {
    const compressed = data.subarray(body + offset, body + offset + length)
    let content: Buffer
    try {
      content = brotliDecompressSync(compressed)
    } catch {
      content = compressed
    }
    const target = join(dir, key)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    written++
  }
  return written
}

interface ArchiveIndex {
  at: number
  length: number
  entries: Record<string, [number, number]>
}

function findArchiveIndex(data: Buffer): ArchiveIndex | undefined {
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
    let parsed: unknown
    try {
      parsed = JSON.parse(data.subarray(start, start + length).toString('utf8'))
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const values = Object.values(parsed as Record<string, unknown>)
    if (values.length < 3) continue
    const ok = values.every((value) =>
      Array.isArray(value)
      && value.length === 2
      && value.every((entry) => Number.isInteger(entry)))
    if (!ok) continue
    return {
      at: start,
      length,
      entries: parsed as Record<string, [number, number]>,
    }
  }
  return undefined
}

/**
 * Serve one file of the web UI.
 *
 * The official server serves `index.html` for unknown paths (the app is a
 * single page application) but answers 404 for a missing asset, so a broken
 * build fails loudly instead of silently returning the shell.
 */
export function serveWebUiFile(
  res: ServerResponse,
  dir: string,
  pathname: string,
  method: string,
): boolean {
  const key = decodeURIComponent(pathname).replace(/^\//, '')
  const name = key.length === 0 ? 'index.html' : key
  const target = join(dir, name)
  if (!target.startsWith(dir)) return false
  const revalidate = name === 'index.html' || name === 'sw.js' || name === 'registerSW.js'
  const isAsset = name.startsWith('_assets/') || name.startsWith('icons/')
  if (!existsSync(target)) {
    if (isAsset) {
      res.writeHead(404, { 'cache-control': 'no-store' })
      res.end()
      return true
    }
    // The single page application handles its own routes.
    return serveWebUiFile(res, dir, '/index.html', method)
  }
  const content = readFileSync(target)
  const headers: Record<string, string> = {
    'content-type': mimeTypeFor(name),
    'cache-control': revalidate
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  }
  if (method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return true
  }
  res.writeHead(200, headers)
  res.end(content)
  return true
}
