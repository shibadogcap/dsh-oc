import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  extractParams,
  type BridgeRequest,
  type BridgeRouter,
} from './router.js'
import {
  badRequest,
  internalError,
  notImplemented,
  HttpError,
  type OpenCodeErrorBody,
} from './errors.js'

export interface BridgeServerHandle {
  url: string
  port: number
  server: http.Server
  close(): Promise<void>
}

const MAX_BODY_BYTES = 1024 * 1024

/**
 * The CORS policy of the official opencode server.
 *
 * The official server answers a browser's cross-origin request with the
 * request's own origin (never `*`) and allows credentials, so a web UI can
 * talk to it directly. Answering `*` instead breaks every credentialed
 * request: the browser rejects it with "credentialed request requires
 * Access-Control-Allow-Origin '<origin>'".
 *
 * `http://localhost:<port>` and `http://127.0.0.1:<port>` are always
 * allowed, plus the origins named in `DSH_OC_CORS` (comma separated) for
 * a LAN address.
 */
export function isAllowedCorsOrigin(origin: string | undefined, extra: readonly string[] = []): boolean {
  if (origin === undefined || origin.length === 0) return true
  if (origin.startsWith('http://localhost:')) return true
  if (origin.startsWith('http://127.0.0.1:')) return true
  if (origin.startsWith('oc://renderer')) return true
  if (origin === 'tauri://localhost' || origin === 'http://tauri.localhost' || origin === 'https://tauri.localhost') return true
  if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(origin)) return true
  return extra.includes(origin)
}

/** The CORS headers for one request. */
export function corsHeaders(origin: string | undefined, extra: readonly string[] = []): Record<string, string> {
  const allowed = isAllowedCorsOrigin(origin, extra)
  if (!allowed) return {}
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Last-Event-ID',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  }
}

/**
 * Start the loopback HTTP server. `url`/`port` are available once the
 * returned promise resolves (after `listen` on 127.0.0.1:0).
 */
export async function startBridgeServer(
  router: BridgeRouter,
  options: { host?: string; port?: number; corsOrigins?: readonly string[] } = {},
): Promise<BridgeServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const listenPort = options.port ?? 0
  const sockets = new Set<import('node:net').Socket>()
  const server = http.createServer((req, res) => {
    void handleRequest(router, req, res, options.corsOrigins ?? []).catch((error: unknown) => {
      sendError(res, error instanceof HttpError
        ? error
        : internalError(error instanceof Error ? error.message : String(error)))
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(listenPort, host)
  })
  const address = server.address() as AddressInfo
  const port = address.port

  return {
    url: `http://${host}:${port}`,
    port,
    server,
    close: async () => {
      router.ctx.hub.closeAll()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}

async function handleRequest(
  router: BridgeRouter,
  req: IncomingMessage,
  res: ServerResponse,
  corsOrigins: readonly string[] = [],
): Promise<void> {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname
  const origin = req.headers.origin
  const cors = corsHeaders(typeof origin === 'string' ? origin : undefined, corsOrigins)
  for (const [key, value] of Object.entries(cors)) res.setHeader(key, value)

  if (method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }

  // `DSH_OC_HTTP_LOG=1` traces every request, which is how a browser UI's
  // call pattern is checked without a browser in the loop. The line is
  // written when the request arrives, so a long-lived stream shows up too.
  if (process.env.DSH_OC_HTTP_LOG === '1') {
    process.stderr.write(`[bridge/http] ${method} ${pathname}\n`)
  }

  let body: unknown
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readBody(req)
  }

  const route = router.match(method, pathname)
  if (!route) {
    // The official opencode web UI is a single page application: a path it
    // does not know is still the shell. The API keeps its own 404, and so do
    // the paths the official server reserves for the API.
    const isApiPath = pathname === '/api'
      || pathname.startsWith('/api/')
      || pathname.startsWith('/auth/')
      || pathname === '/openapi.json'
    if (!isApiPath && router.serveWebUi !== undefined && (method === 'GET' || method === 'HEAD')) {
      const served = router.serveWebUi({ method, pathname, query: url.searchParams, params: {}, headers: req.headers, body: undefined }, res)
      if (served) return
    }
    throw notImplemented(`${method} ${pathname} is not implemented by oc-bridge`)
  }

  const request: BridgeRequest = {
    method,
    pathname,
    query: url.searchParams,
    params: extractParams(route.pattern, pathname),
    headers: req.headers,
    body,
  }

  if (route.kind === 'sse') {
    req.socket.setTimeout(0)
    router.startSse(request, res)
    return
  }

  const result = await route.handler(request, router.ctx)
  sendResult(res, result.status, result.body, result.raw, result.headers)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw badRequest('request body exceeds 1 MiB limit')
    }
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw badRequest('invalid JSON body')
  }
}

/**
 * Write the response body.
 *
 * The CORS headers are already on the response (they depend on the request's
 * origin), so they are not repeated here: `writeHead` would replace them.
 */
function sendResult(
  res: ServerResponse,
  status: number,
  body?: unknown,
  raw?: string | Buffer,
  headers?: Record<string, string>,
): void {
  if (raw !== undefined) {
    const data = typeof raw === 'string' ? raw : raw.toString('utf8')
    res.writeHead(status, {
      ...headers,
      'Content-Type': headers?.['Content-Type'] ?? 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
    })
    res.end(data)
    return
  }
  if (status === 204 || status === 304 || body === undefined) {
    res.writeHead(status, { ...headers, 'Content-Length': '0' })
    res.end()
    return
  }
  const data = JSON.stringify(body)
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

function sendError(res: ServerResponse, error: HttpError): void {
  sendResult(res, error.status, error.body as OpenCodeErrorBody)
}
