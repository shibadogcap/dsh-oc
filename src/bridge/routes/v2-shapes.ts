// Minimal, schema-valid placeholders for the OpenCode v2 wire types.
//
// The official `@opencode/client@2.1.0` validates nothing at runtime, but the
// generated `*Output` types describe the wire contract. These builders return
// the smallest value that still satisfies those types, so a stubbed route
// never answers with a shape the client cannot read.
//
// Every placeholder is empty by construction (no fabricated ids, titles or
// process state): a stub must not look like real data.
import type { BridgeRouteContext } from '../router.js'

/** `Project` — the 2.1.0 client reads a bare array/object, not an envelope. */
export function emptyProject(projectID: string, cwd: string) {
  return {
    id: projectID,
    canonical: cwd,
    time: { created: 0, updated: 0, active: 0 },
    sandboxes: [] as string[],
  }
}

/** `ShellInfo` — a shell that never ran. */
export function emptyShellInfo(shellID: string, cwd: string) {
  return {
    id: shellID,
    status: 'exited' as const,
    command: '',
    cwd,
    shell: '',
    file: '',
    metadata: {} as Record<string, unknown>,
    time: { started: 0 },
  }
}

/** `PersistentPtyInfo` — a persistent terminal that never started. */
export function emptyPersistentPtyInfo(ptyID: string, sessionID: string, cwd: string) {
  return {
    id: ptyID,
    title: '',
    command: '',
    args: [] as string[],
    cwd,
    status: 'exited' as const,
    pid: 0,
    sessionID,
    foregroundProcess: null as string | null,
    size: { cols: 80, rows: 24 },
    output: { head: 0, tail: 0 },
  }
}

/** `PersistentPtyReadResult` — an empty terminal screen. */
export function emptyPersistentPtyRead(ptyID: string, cwd: string) {
  return {
    ptyID,
    title: '',
    cwd,
    foregroundProcess: null as string | null,
    screen: { text: '', cols: 80, rows: 24, cursor: { x: 0, y: 0 } },
  }
}

/** `Pty` — a pty that never ran. */
export function emptyPty(ptyID: string, cwd: string) {
  return {
    id: ptyID,
    title: '',
    command: '',
    args: [] as string[],
    cwd,
    status: 'exited' as const,
    pid: 0,
  }
}

/** `CredentialEntry` — an empty credential slot. */
export function emptyCredentialEntry(id: string) {
  return {
    id,
    integrationID: '',
    label: '',
    active: false,
    value: { type: 'key' as const, key: '' },
  }
}

/** `SessionStatsInfo` — an empty statistics window. */
export function emptySessionStats() {
  return {
    range: { from: 0, to: 0 },
    sessions: 0,
    subagents: 0,
    prompts: 0,
    steps: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    tools: { mode: 'none' as const },
    activeDays: 0,
    streak: 0,
    activity: [] as unknown[],
    models: [] as unknown[],
  }
}

/** `SessionInfo` — an empty session record. */
export function emptySessionInfo(sessionID: string, cwd: string) {
  return {
    id: sessionID,
    projectID: '',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: cwd },
  }
}

/** `IntegrationInfo` — an integration without methods or connections. */
export function emptyIntegrationInfo(integrationID: string) {
  return {
    id: integrationID,
    name: '',
    methods: [] as unknown[],
    connections: [] as unknown[],
  }
}

/** Log a stubbed route so the limitation is visible in the bridge log. */
export function logStub(
  ctx: Pick<BridgeRouteContext, 'log'>,
  route: string,
  limitation: string,
): void {
  ctx.log(`[bridge/compat] ${route} is a no-op: ${limitation}`)
}
