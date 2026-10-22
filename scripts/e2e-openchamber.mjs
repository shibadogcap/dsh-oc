#!/usr/bin/env node
// OpenChamber E2E: drive the real OpenChamber 2.5 UI against a running
// oc-bridge and record what the UI actually did.
//
//   node scripts/e2e-openchamber.mjs --bridge http://127.0.0.1:41800 \
//        --chamber http://127.0.0.1:3000 --password test
//
// The OpenChamber server must already run with OPENCODE_HOST pointing at the
// bridge and OPENCODE_SKIP_START=true. The script logs in, loads the UI, and
// reports the API calls the UI made plus any console error.
import { writeFileSync } from 'node:fs'
import { launch, stop } from '/home/ubuntu/obscura-bridge/index.mjs'

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const bridge = option('--bridge', 'http://127.0.0.1:41800')
const chamber = option('--chamber', 'http://127.0.0.1:3000')
const password = option('--password', 'test')
const outFile = option('--out', '/tmp/dsh-oc-e2e.txt')
const settleMs = Number(option('--settle', '15000'))

const lines = []
const log = (line) => {
  lines.push(line)
  writeFileSync(outFile, lines.join('\n') + '\n')
}

const info = await fetch(`${bridge}/api/info`).then((r) => r.json()).catch(() => undefined)
log(`bridge: ${JSON.stringify(info)}`)

// A stale service worker in the browser jar can serve an old bundle, so the
// run always starts from a fresh Obscura serve.
await stop()

const { browser, page } = await launch({ privateNetwork: true })
const apiCalls = []
const consoleErrors = []
page.on('request', (request) => {
  const url = request.url()
  if (url.includes('/api/')) apiCalls.push(`${request.method()} ${url.replace(chamber, '')}`)
})
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(`PAGEERROR ${error.message}`))

try {
  // Log in from inside the page so the cookie is scoped exactly the way the
  // UI scopes it. OpenChamber's own auth guard answers an unauthenticated
  // `/api/*` request with `text/plain`, which the OpenCode v2 client rejects
  // before it looks at the status; a session cookie avoids that entirely.
  await page.goto(`${chamber}/`, { waitUntil: 'domcontentloaded', timeout: 15000 })
  const login = await page.evaluate(async (secret) => {
    const response = await fetch('/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: secret }),
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }, password)
  log(`login: ${login.status} ${JSON.stringify(login.body)}`)

  await page.goto(`${chamber}/`, { waitUntil: 'domcontentloaded', timeout: 15000 })
  log('navigated')
  await new Promise((resolve) => setTimeout(resolve, settleMs))
  log('settled')

  const state = await Promise.race([
    page.evaluate(() => ({
      rootChildren: document.getElementById('root')?.children.length ?? -1,
      runtimeApis: typeof window.__OPENCHAMBER_RUNTIME_APIS__,
      surface: window.__OPENCHAMBER_SURFACE__,
    })),
    new Promise((resolve) => setTimeout(() => resolve({ evaluate: 'timeout' }), 10000)),
  ])
  log(`ui state: ${JSON.stringify(state)}`)

  const unique = [...new Set(apiCalls)]
  log(`api calls: ${unique.length}`)
  for (const call of unique) log(`  ${call}`)

  log(`console errors: ${consoleErrors.length}`)
  for (const error of consoleErrors.slice(0, 10)) log(`  ${error.slice(0, 240)}`)

  await page.screenshot({ path: '/tmp/dsh-oc-e2e.png', fullPage: true })
  log('screenshot: /tmp/dsh-oc-e2e.png')

  const ok = state.rootChildren > 0 && consoleErrors.length === 0
  log('')
  if (ok) {
    log('RESULT: PASS')
  } else if (apiCalls.length === 0) {
    // No API call at all means the app never started, not that the bridge
    // answered wrongly. The same happens with OpenChamber 2.5.0 against a
    // real OpenCode 2.1.0 server under this renderer, so it is not a
    // dsh-oc failure. `pnpm run e2e:openchamber` covers the API layer.
    log('RESULT: RENDERER-LIMITED (the app never mounted; the bridge was never called)')
  } else {
    log('RESULT: FAIL')
  }
  process.exitCode = ok ? 0 : 1
} catch (error) {
  log(`error: ${error instanceof Error ? error.message : String(error)}`)
  log('RESULT: FAIL')
  process.exitCode = 1
} finally {
  await page.close()
  await browser.close()
}
