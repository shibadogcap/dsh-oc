// Additional OpenCode v2 session sub-routes for the dsh-oc bridge.
//
// The v2 client (OpenCode 2.1.0) drives a session through a wider set of
// sub-routes than the official TUI ever calls, and OpenChamber 2.5 exercises
// them. They are answered here instead of falling through to the catch-all
// stubs. Routes dsh cannot express are answered honestly: the request
// succeeds with the schema-valid empty payload and the bridge logs exactly
// what the host does not support, so no caller mistakes a no-op for a change.
import * as R from '../router.js'
import { randomUUID } from 'node:crypto'
import { badRequest, notFound } from '../errors.js'
import { toQuestionV2 } from '../convert/question.js'
import type { QuestionEntry } from '../convert/question.js'
import type { RouteRegistrar } from '../routes.js'

/** One dsh question rendered as a v2 form field. */
function questionToFormFields(entry: QuestionEntry): Array<Record<string, unknown>> {
  return entry.items.map((item) => ({
    key: item.id,
    title: item.header ?? item.question,
    ...(item.detail === undefined ? {} : { description: item.detail }),
    type: item.multiSelect === true ? 'multiselect' : 'string',
    required: true,
    options: (item.options ?? []).map((option) => ({
      value: option.label,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
  }))
}

/** Title shown for a form that has no backing dsh question. */
const DEFAULT_FORM_TITLE = 'Form'

export function registerSessionV2ExtraRoutes(register: RouteRegistrar): void {
  // ---- session update (rename) ----
  register('PATCH', '/api/session/:sessionID', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const body = R.bodyAsRecord(req.body)
    const title = typeof body.title === 'string' ? body.title : undefined
    if (title !== undefined) {
      // dsh owns the title; an invalid one comes back as a 4xx from the host.
      await R.rpc(ctx, 'session.rename', { sessionId: R.sid(id), title })
      ctx.state.setSessionTitle(id, title)
    }
    if (body.metadata !== undefined || body.permissions !== undefined) {
      // dsh keeps the title in the session record; there is no per-session
      // metadata or permission table to write.
      ctx.log(`[bridge/session-v2] session ${id} metadata/permissions are not persisted by dsh`)
    }
    ctx.state.invalidateSession(id)
    return R.json(204)
  })

  // ---- session remove ----
  register('DELETE', '/api/session/:sessionID', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    ctx.state.invalidateSession(id)
    ctx.log(`[bridge/session-v2] remove is not supported by dsh; the durable record stays (session ${id})`)
    return R.json(204)
  })

  // ---- session command ----
  // The v2 body is `{ name, text?, files? }`; the v1 body was
  // `{ command, arguments }`. The names map onto the same bridge commands.
  register('POST', '/api/session/:sessionID/command', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const body = R.bodyAsRecord(req.body)
    const name = typeof body.name === 'string' ? body.name.replace(/^\//, '') : ''
    const text = typeof body.text === 'string' ? body.text : ''
    if (name === '') throw badRequest('session command requires a name')
    if (name === 'preset') {
      const outcome = await R.runPresetCommand(ctx, id, text.trim())
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(204)
    }
    if (name === 'goal') {
      const outcome = await R.runGoalCommand(ctx, id, text)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(204)
    }
    if (name === 'help') {
      const outcome = R.runHelpCommand(ctx, id, text)
      if (outcome.kind === 'error') throw badRequest(outcome.text, { code: 'command-error' })
      return R.json(204)
    }
    const skills = await R.skillListForSession(ctx, id)
    if (skills.some((skill) => skill.name === name)) {
      const prompt = text.trim() === '' ? `/${name}` : `/${name} ${text.trim()}`
      await R.rpc(ctx, 'session.prompt', {
        sessionId: R.sid(id),
        mode: 'steer',
        content: [{ type: 'text', text: prompt }],
      })
      ctx.state.invalidateSession(id)
      return R.json(204)
    }
    throw badRequest(`unsupported command "${name}"`)
  })

  // ---- synthetic user message ----
  // Injected through the same path the v1 message route uses: the prompt RPC
  // carries the message and the bridge echoes the optimistic user card.
  register('POST', '/api/session/:sessionID/synthetic', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const body = R.bodyAsRecord(req.body)
    const text = typeof body.text === 'string' ? body.text : ''
    if (text.trim() === '') throw badRequest('synthetic message requires text')
    const description = typeof body.description === 'string' ? body.description : undefined
    const messageID = typeof body.id === 'string' && body.id.length > 0
      ? body.id
      : `msg_${randomUUID()}`
    const createdAt = Date.now()
    ctx.state.registerPromptMessageId(id, messageID, createdAt)
    await R.broadcastPromptUserMessage(
      ctx,
      id,
      messageID,
      text,
      createdAt,
      R.promptModelRef(ctx, id, req.body),
    )
    await R.rpc(ctx, 'session.prompt', {
      sessionId: R.sid(id),
      requestId: messageID,
      mode: 'queue',
      content: [{ type: 'text', text }],
    })
    ctx.state.markInput()
    ctx.state.invalidateSession(id)
    return R.json(200, {
      data: {
        id: messageID,
        sessionID: id,
        time: { created: createdAt },
        type: 'synthetic',
        payload: {
          text,
          ...(description === undefined ? {} : { description }),
        },
        delivery: 'queue',
      },
    })
  })

  // ---- session shell ----
  // The v2 body is `{ id?, command }`; the agent is optional here because the
  // session already knows which agent runs it.
  register('POST', '/api/session/:sessionID/shell', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const body = R.bodyAsRecord(req.body)
    const command = typeof body.command === 'string' ? body.command : ''
    if (command.trim() === '') throw badRequest('shell request requires a non-empty command')
    const requested = typeof body.agent === 'string' && body.agent.trim() !== ''
      ? body.agent.trim()
      : undefined
    const agent = requested ?? ctx.state.sessionAgentFor(id)
    if (agent === undefined) throw badRequest('shell request requires a non-empty agent')
    const workdir = req.query.get('directory')
    await R.runShellCommand(ctx, id, {
      command,
      agent,
      ...(workdir === null ? {} : { workdir }),
    })
    return R.json(204)
  })

  // ---- session move ----
  register('POST', '/api/session/:sessionID/move', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const body = R.bodyAsRecord(req.body)
    const directory = typeof body.directory === 'string' ? body.directory : ''
    // dsh binds a session to its directory when the session is created; there
    // is no move RPC. The working directory stays as it is.
    ctx.log(`[bridge/session-v2] move is not supported by dsh; the working directory is unchanged (session ${id} -> ${directory})`)
    return R.json(204)
  })

  // ---- session inbox ----
  register('GET', '/api/session/:sessionID/inbox', 'json', async (_req, _ctx) => {
    // dsh exposes the pending queue through its control frames, not as a
    // per-session inbox list.
    return R.json(200, { data: [] })
  })

  // ---- session forms ----
  register('GET', '/api/session/:sessionID/form', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    return R.json(200, { data: ctx.state.questionsForSession(id).map(toQuestionV2) })
  })

  register('POST', '/api/session/:sessionID/form', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const body = R.bodyAsRecord(req.body)
    const title = typeof body.title === 'string' && body.title.length > 0
      ? body.title
      : DEFAULT_FORM_TITLE
    const fields = Array.isArray(body.fields) ? body.fields : []
    return R.json(200, {
      data: {
        id: `form-${randomUUID()}`,
        sessionID: id,
        title,
        fields,
      },
    })
  })

  register('GET', '/api/session/:sessionID/form/:formID', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    const formID = req.params.formID as string
    const question = ctx.state.questionByOpenCodeId(formID)
    return R.json(200, {
      data: {
        id: formID,
        sessionID: id,
        title: question === undefined
          ? DEFAULT_FORM_TITLE
          : (question.items[0]?.header ?? question.items[0]?.question ?? DEFAULT_FORM_TITLE),
        fields: question === undefined ? [] : questionToFormFields(question),
        state: { status: 'pending' },
      },
    })
  })

  register('POST', '/api/session/:sessionID/form/:formID/reply', 'json', async (req, ctx) => {
    const formID = req.params.formID as string
    if (ctx.state.questionByOpenCodeId(formID) === undefined) {
      throw notFound('form not found', { formID })
    }
    await R.questionReply(ctx, formID, req.body)
    return R.json(204)
  })

  // The v2 client cancels a form with DELETE on the form itself.
  register('DELETE', '/api/session/:sessionID/form/:formID', 'json', async (req, ctx) => {
    const formID = req.params.formID as string
    await R.questionReject(ctx, formID)
    return R.json(204)
  })

  // ---- session environment / view / background ----
  // The v2 client sets the environment with PUT.
  register('PUT', '/api/session/:sessionID/environment', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    ctx.log(`[bridge/session-v2] per-session environment is not supported by dsh (session ${id})`)
    return R.json(204)
  })

  register('POST', '/api/session/:sessionID/view', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    ctx.log(`[bridge/session-v2] viewed timestamps are not tracked by dsh (session ${id})`)
    return R.json(204)
  })

  register('POST', '/api/session/:sessionID/background', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    // dsh sessions always run server-side; there is nothing to detach.
    ctx.log(`[bridge/session-v2] background sessions are not supported by dsh (session ${id})`)
    return R.json(204)
  })

  // ---- session generate ----
  register('POST', '/api/session/:sessionID/generate', 'json', async (req, ctx) => {
    const id = req.params.sessionID as string
    ctx.log(`[bridge/session-v2] text generation is not supported by dsh (session ${id})`)
    // The v2 client unwraps `data` from the generated text.
    return R.json(200, { data: { text: '' } })
  })

  // ---- session log / stats ----
  // The v2 client reads the durable event log from the experimental path.
  // The v2 client reads the durable event log over SSE.
  register('GET', '/api/experimental/session/:sessionID/log', 'sse', async () => ({ status: 200 }))

  register('GET', '/api/session/:sessionID/stats', 'json', async (_req, _ctx) => {
    return R.json(200, { data: {} })
  })
}
