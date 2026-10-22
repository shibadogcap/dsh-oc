#!/usr/bin/env node
// E2E of the OpenCode 2.x revert flow against a live bridge.
//
//   node scripts/e2e-revert-flow.mjs --bridge http://127.0.0.1:41800
//
// The flow is the one the official TUI and the OpenChamber UI run:
//
//   1. stage a boundary  -> the session record carries the boundary
//   2. clear the boundary -> the record drops it again
//   3. stage and commit  -> the transcript is cut at the boundary
//   4. prompt again       -> the new turn lands in the same session
//
// The cut is exclusive: the boundary message and everything after it are
// dropped, and the messages before it keep their ids.
import { writeFileSync } from 'node:fs'

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const bridge = option('--bridge', 'http://127.0.0.1:41800').replace(/\/$/, '')
const out = option('--out', '/tmp/dsh-oc-revert-e2e.txt')
const settle = Number(option('--settle', '4000'))

async function call(method, path, body) {
  const response = await fetch(bridge + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text }
  }
}

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`)
}

const created = await call('POST', '/api/session', { agent: 'minimal' })
if (created.status !== 200) {
  console.error(`session create -> ${created.status}`)
  process.exit(1)
}
const sessionId = created.body.data.id

for (const [index, id] of ['u1', 'u2', 'u3'].entries()) {
  await call('POST', `/api/session/${sessionId}/prompt`, { id, text: `turn ${index + 1}` })
  await new Promise((resolve) => setTimeout(resolve, settle))
}

const messages = async () =>
  (await call('GET', `/api/session/${sessionId}/message`)).body.data.map((m) => m.id)

let ids = await messages()
check('three prompts recorded', ids.length === 3, ids.join(','))

// 1. stage
const stage = await call('POST', `/api/session/${sessionId}/revert/stage`, { messageID: 'u2' })
check('stage answered 200', stage.status === 200, JSON.stringify(stage.body?.data))
const record = (await call('GET', `/api/session/${sessionId}`)).body.data
check('the session record carries the boundary', record?.revert?.messageID === 'u2', JSON.stringify(record?.revert))

// 2. clear
const cleared = await call('DELETE', `/api/session/${sessionId}/revert`)
check('clear answered 204', cleared.status === 204)
const clearedRecord = (await call('GET', `/api/session/${sessionId}`)).body.data
check('the session record drops the boundary', clearedRecord?.revert === undefined)

// 3. stage and commit
await call('POST', `/api/session/${sessionId}/revert/stage`, { messageID: 'u2' })
const commit = await call('POST', `/api/session/${sessionId}/revert/commit`)
check('commit answered 204', commit.status === 204)
await new Promise((resolve) => setTimeout(resolve, 1500))
ids = await messages()
check('the transcript is cut at the boundary', ids.length === 1 && ids[0] === 'u1', ids.join(','))
check('the surviving message keeps its id', ids.includes('u1'), ids.join(','))

// 4. the next prompt lands in the same session
await call('POST', `/api/session/${sessionId}/prompt`, { id: 'u4', text: 'after the revert' })
await new Promise((resolve) => setTimeout(resolve, settle))
ids = await messages()
check('the new turn is in the same session', ids.includes('u4'), ids.join(','))
check('the reverted messages stayed gone', !ids.includes('u2') && !ids.includes('u3'), ids.join(','))

// 5. a second revert in the same session
await call('POST', `/api/session/${sessionId}/revert/stage`, { messageID: 'u4' })
await call('POST', `/api/session/${sessionId}/revert/commit`)
await new Promise((resolve) => setTimeout(resolve, 1500))
ids = await messages()
check('a second revert cuts again', !ids.includes('u4') && ids.includes('u1'), ids.join(','))

// 6. the session is published under the id the client knows
const list = (await call('GET', '/api/session')).body.data
const published = list.filter((item) => item.id === sessionId)
check('the session keeps its id in the list', published.length === 1, `count=${published.length}`)

const failed = results.filter((entry) => !entry.ok)
const summary = [
  `${results.length - failed.length}/${results.length} revert checks passed`,
  failed.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed.map((entry) => entry.label).join(', ')})`,
  '',
].join('\n')
console.log('')
console.log(summary.trim())
writeFileSync(out, `${summary}\n`)
process.exit(failed.length === 0 ? 0 : 1)
