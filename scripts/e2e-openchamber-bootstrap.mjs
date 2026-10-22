#!/usr/bin/env node
// OpenChamber UI bootstrap E2E: run the exact client calls the OpenChamber
// 2.5 UI makes on boot, against a running oc-bridge.
//
//   node scripts/e2e-openchamber-bootstrap.mjs --bridge http://127.0.0.1:41800
//
// These are the calls from packages/ui/src/sync/bootstrap.ts. Each one must
// answer with a shape the UI can store; a failure here is a real break in the
// OpenChamber integration, not a rendering problem.
import { writeFileSync } from 'node:fs'

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const bridge = option('--bridge', 'http://127.0.0.1:41800').replace(/\/$/, '')
const outFile = option('--out', '/tmp/dsh-oc-bootstrap-e2e.txt')
const lines = []
const log = (line) => {
  lines.push(line)
  writeFileSync(outFile, lines.join('\n') + '\n')
}

const results = []
async function check(name, run) {
  try {
    const value = await run()
    results.push({ name, ok: true, value })
    log(`PASS ${name} ${summarize(value)}`)
    return value
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
    log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function summarize(value) {
  const text = JSON.stringify(value)
  return text === undefined ? 'undefined' : text.slice(0, 160)
}

async function get(path) {
  const response = await fetch(`${bridge}${path}`, { headers: { accept: 'application/json' } })
  if (response.status !== 200) {
    throw new Error(`GET ${path} -> ${response.status} ${(await response.text()).slice(0, 120)}`)
  }
  return response.json()
}

// The UI's client sends the resolved directory in this header.
const directory = process.cwd()
const scoped = { 'x-opencode-directory': encodeURIComponent(directory) }

async function getScoped(path) {
  const response = await fetch(`${bridge}${path}`, { headers: { accept: 'application/json', ...scoped } })
  if (response.status !== 200) {
    throw new Error(`GET ${path} -> ${response.status} ${(await response.text()).slice(0, 120)}`)
  }
  return response.json()
}

log(`bridge: ${bridge}`)
log(`directory: ${directory}`)

await check('server.info (OpenChamber >= 2.0.20 gate)', async () => {
  const info = await get('/api/info')
  if (typeof info.version !== 'string') throw new Error('version missing')
  // The same release comparison OpenChamber's compatibility gate uses.
  const parts = (value) => value.split(/[-+]/, 1)[0].split('.').map(Number)
  const [a, b] = [parts(info.version), parts('2.0.20')]
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      if ((a[index] ?? 0) < (b[index] ?? 0)) {
        throw new Error(`version ${info.version} is below the 2.0.20 gate`)
      }
      break
    }
  }
  if ((a[0] ?? 0) !== 2) throw new Error(`version ${info.version} is not a 2.x release`)
  return info.version
})

await check('location.get', async () => {
  const location = await get('/api/location')
  if (typeof location.directory !== 'string') throw new Error('directory missing')
  if (location.project?.id === undefined) throw new Error('project.id missing')
  return { directory: location.directory, project: location.project.id }
})

await check('project.list', async () => {
  const projects = await get('/api/project')
  if (!Array.isArray(projects)) throw new Error('expected an array')
  return { count: projects.length }
})

await check('config.get', async () => {
  const config = await get('/api/config')
  if (typeof config !== 'object' || config === null) throw new Error('expected an object')
  return { keys: Object.keys(config).length }
})

await check('model.list', async () => {
  const models = await get('/api/model')
  if (!Array.isArray(models.data)) throw new Error('expected a data array')
  return { count: models.data.length }
})

await check('provider.list', async () => {
  const providers = await get('/api/provider')
  if (!Array.isArray(providers.data)) throw new Error('expected a data array')
  return { count: providers.data.length }
})

await check('agent.list', async () => {
  const agents = await get('/api/agent')
  if (!Array.isArray(agents.data)) throw new Error('expected a data array')
  return { count: agents.data.length }
})

await check('session.list', async () => {
  const sessions = await get('/api/session')
  if (!Array.isArray(sessions.data)) throw new Error('expected a data array')
  return { count: sessions.data.length }
})

await check('session.active (status snapshot)', async () => {
  const active = await get('/api/session/active')
  if (active === null || typeof active !== 'object') throw new Error('expected an object')
  return { running: Object.keys(active).length }
})

await check('permission.request.list (pending permissions)', async () => {
  const permissions = await get('/api/permission/request')
  if (!Array.isArray(permissions.data)) throw new Error('expected a data array')
  return { count: permissions.data.length }
})

await check('form.list (pending forms)', async () => {
  const forms = await get('/api/form')
  if (!Array.isArray(forms.data)) throw new Error('expected a data array')
  return { count: forms.data.length }
})

await check('vcs.get (workspace VCS state)', async () => {
  const vcs = await get('/api/vcs')
  if (!('data' in vcs)) throw new Error('expected a data field')
  return { data: vcs.data }
})

await check('shell.list (background shells)', async () => {
  const shells = await get('/api/shell')
  if (!Array.isArray(shells.data)) throw new Error('expected a data array')
  return { count: shells.data.length }
})

await check('command.list (slash commands)', async () => {
  const commands = await get('/api/command')
  if (!Array.isArray(commands.data)) throw new Error('expected a data array')
  return { count: commands.data.length }
})

await check('skill.list', async () => {
  const skills = await get('/api/skill')
  if (!Array.isArray(skills.data)) throw new Error('expected a data array')
  return { count: skills.data.length }
})

await check('location.get (directory-scoped)', async () => {
  const location = await getScoped('/api/location')
  if (typeof location.directory !== 'string') throw new Error('directory missing')
  return { directory: location.directory }
})

await check('event stream opens as SSE', async () => {
  const response = await fetch(`${bridge}/api/event`, {
    headers: { accept: 'text/event-stream', ...scoped },
    signal: AbortSignal.timeout(3000),
  })
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('text/event-stream')) throw new Error(`content-type is ${type}`)
  const reader = response.body?.getReader()
  const chunk = reader ? await reader.read() : undefined
  reader?.cancel()
  const text = chunk?.value ? new TextDecoder().decode(chunk.value) : ''
  if (!text.includes('data:') && !text.includes('retry:')) throw new Error('no SSE frame')
  return { firstFrame: text.split('\n')[0] }
})

// ---- the chat flow the UI runs when the user sends a message ----

let sessionId

await check('session.create', async () => {
  const response = await fetch(`${bridge}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...scoped },
    body: JSON.stringify({ agent: 'minimal' }),
  })
  if (response.status !== 200) {
    throw new Error(`POST /api/session -> ${response.status} ${(await response.text()).slice(0, 120)}`)
  }
  const body = await response.json()
  if (typeof body.data?.id !== 'string') throw new Error('session id missing')
  sessionId = body.data.id
  return { id: sessionId, agent: body.data.agent }
})

await check('session.prompt (the v2 body the client sends)', async () => {
  const response = await fetch(`${bridge}/api/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...scoped },
    body: JSON.stringify({ id: 'msg_e2e_1', text: 'hello from the e2e' }),
  })
  if (response.status !== 200) {
    throw new Error(`POST /api/session/:id/prompt -> ${response.status} ${(await response.text()).slice(0, 120)}`)
  }
  const body = await response.json()
  if (body.data?.type !== 'user') throw new Error('expected a user inbox item')
  if (body.data?.payload?.text !== 'hello from the e2e') throw new Error('text not echoed')
  return { id: body.data.id, delivery: body.data.delivery }
})

await check('message.list (the prompt reaches the durable history)', async () => {
  // The prompt is queued in dsh's inbox; the agent appends it to the durable
  // log when it claims the message, so the history read is polled.
  const deadline = Date.now() + 15000
  let last
  while (Date.now() < deadline) {
    const messages = await get(`/api/session/${sessionId}/message`)
    if (!Array.isArray(messages.data)) throw new Error('expected a data array')
    const user = messages.data.find((entry) => entry.id === 'msg_e2e_1')
    if (user !== undefined) {
      if (user.type !== 'user') throw new Error('the prompt is not a user message')
      return { count: messages.data.length, text: user.text }
    }
    last = messages.data.length
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`the prompt never reached the history (${last} messages)`)
})

await check('session.get', async () => {
  const session = await get(`/api/session/${sessionId}`)
  if (session.data?.id !== sessionId) throw new Error('session id mismatch')
  return { id: session.data.id, title: session.data.title }
})

await check('session.interrupt', async () => {
  const response = await fetch(`${bridge}/api/session/${sessionId}/interrupt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...scoped },
  })
  if (response.status !== 200) throw new Error(`-> ${response.status}`)
  const body = await response.json()
  if (typeof body.interrupted !== 'boolean') throw new Error('interrupted flag missing')
  return body
})

const failed = results.filter((result) => !result.ok)
log('')
log(`${results.length - failed.length}/${results.length} bootstrap calls answered`)
log(failed.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exitCode = failed.length === 0 ? 0 : 1
