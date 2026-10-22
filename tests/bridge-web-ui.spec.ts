import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridgeRouter } from '../src/bridge/router.js'
import { startBridgeServer, type BridgeServerHandle } from '../src/bridge/http.js'
import { mimeTypeFor, serveWebUiFile, webUiDir } from '../src/bridge/web-ui.js'
import { fakeApi } from './helpers.js'

// The official opencode web UI is embedded in the opencode binary as one
// AppArchive. The bridge extracts it and serves it from its own origin, so a
// browser reaches the API same-origin: no CORS, no cookie, exactly like the
// official `opencode serve` setup.
const servers: BridgeServerHandle[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function uiFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-oc-web-ui-'))
  dirs.push(dir)
  mkdirSync(join(dir, '_assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>OpenCode</title>')
  writeFileSync(join(dir, '_assets', 'app.js'), 'export const app = 1')
  writeFileSync(join(dir, 'sw.js'), 'self.skipWaiting()')
  return dir
}

describe('bridge: the official opencode web UI', () => {
  it('serves the shell at the root', async () => {
    const dir = uiFixture()
    const router = createBridgeRouter(fakeApi(), { cwd: '/work', webUiDir: dir })
    const server = await startBridgeServer(router)
    servers.push(server)

    const root = await fetch(`${server.url}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toContain('text/html')
    expect(await root.text()).toContain('OpenCode')
  })

  it('serves the assets with the content type of the file', async () => {
    const dir = uiFixture()
    const router = createBridgeRouter(fakeApi(), { cwd: '/work', webUiDir: dir })
    const server = await startBridgeServer(router)
    servers.push(server)

    const asset = await fetch(`${server.url}/_assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')
  })

  it('answers a missing asset with 404 and a missing route with the shell', async () => {
    const dir = uiFixture()
    const router = createBridgeRouter(fakeApi(), { cwd: '/work', webUiDir: dir })
    const server = await startBridgeServer(router)
    servers.push(server)

    const missing = await fetch(`${server.url}/_assets/nope.js`)
    expect(missing.status).toBe(404)

    // The single page application handles its own routes.
    const route = await fetch(`${server.url}/session/abc`)
    expect(route.status).toBe(200)
    expect(await route.text()).toContain('OpenCode')
  })

  it('keeps the API 404 for an unknown API route', async () => {
    const dir = uiFixture()
    const router = createBridgeRouter(fakeApi(), { cwd: '/work', webUiDir: dir })
    const server = await startBridgeServer(router)
    servers.push(server)

    // The official server reserves these paths for the API, so they keep
    // their own error instead of falling back to the application shell.
    for (const path of ['/api/nope', '/auth/nope', '/openapi.json']) {
      const response = await fetch(`${server.url}${path}`)
      expect(response.status).toBe(501)
      expect(response.headers.get('content-type')).toContain('application/json')
    }
  })

  it('keeps the API routes working', async () => {
    const dir = uiFixture()
    const router = createBridgeRouter(fakeApi(), { cwd: '/work', webUiDir: dir })
    const server = await startBridgeServer(router)
    servers.push(server)

    const info = await fetch(`${server.url}/api/info`)
    expect(info.status).toBe(200)
    const payload = (await info.json()) as { version?: string }
    expect(payload.version).toBeTruthy()
  })

  it('reports the working directory as the project', async () => {
    const router = createBridgeRouter(fakeApi(), { cwd: '/work' })
    const server = await startBridgeServer(router)
    servers.push(server)

    const projects = await fetch(`${server.url}/api/project`)
    expect(projects.status).toBe(200)
    const data = (await projects.json()) as Array<{ id: string; canonical: string }>
    expect(data).toHaveLength(1)
    expect(data[0]?.canonical).toBe('/work')
  })

  it('ignores a directory without an index', () => {
    expect(webUiDir('/nonexistent')).toBeUndefined()
  })

  it('knows the content types the UI needs', () => {
    expect(mimeTypeFor('index.html')).toContain('text/html')
    expect(mimeTypeFor('app.js')).toContain('text/javascript')
    expect(mimeTypeFor('style.css')).toContain('text/css')
    expect(mimeTypeFor('font.woff2')).toContain('font/woff2')
    expect(mimeTypeFor('module.wasm')).toContain('application/wasm')
  })
})

describe('bridge: the web UI file handler', () => {
  it('does not serve a file outside the directory', () => {
    const dir = uiFixture()
    const chunks: string[] = []
    const res = {
      writeHead: () => res,
      end: (body?: string) => { if (body !== undefined) chunks.push(body) },
    }
    const served = serveWebUiFile(res as never, dir, '/../../etc/passwd', 'GET')
    expect(served).toBe(false)
    expect(chunks).toEqual([])
  })
})
