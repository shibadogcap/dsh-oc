// dsh-oc rewind plugin: session transcript rewind via sessionController.fork,
// plus copy-on-write file snapshots so a rolled-back turn also restores the
// files it changed.
//
// The transcript half is dsh's own seam: `sessionController.fork` copies an
// exact event prefix into a new session, so the rewound conversation is a
// real dsh session rather than a UI fiction. The file half has no dsh
// equivalent, so this plugin keeps the copies itself. It listens to the same
// `fs/write-intent` and `fs/edit-intent` waterfalls dsh's own
// `workspace-changes` plugin uses, and keeps the content from before the
// earliest change to each path.
//
// The snapshot is grouped per turn, because OpenCode's revert rolls back the
// files of the turns *after* the boundary message, not the whole session.
// `session/event` tells the plugin which turn is running, so a capture
// belongs to the turn that produced it.
import { Service, type Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const name = '@chiro2001/dsh-oc/rewind'

/** One captured file, keyed by its path relative to the session directory. */
export interface FileSnapshot {
  /** Path relative to the session working directory. */
  path: string
  /** The content before the mutation. */
  content: Buffer
  /** Whether the file existed before the mutation. */
  existed: boolean
}

/** The file diff OpenCode reports for a staged revert. */
export interface RewindFileDiff {
  file: string
  patch: string
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'modified'
}

/** The files one turn changed, with the content from before the change. */
interface TurnCapture {
  turn: number
  files: Map<string, FileSnapshot>
}

/**
 * The file boundary of a revert.
 *
 * OpenCode rolls back the files of the assistant messages that come *after*
 * the boundary message. A user prompt therefore also rolls back the files its
 * own turn changed (the assistant reply follows it), while an assistant reply
 * does not.
 */
export interface RewindBoundary {
  /** The dsh turn the boundary message belongs to. */
  turn: number
  /** Whether the boundary turn's own file changes roll back. */
  includeTurn: boolean
}

export interface RewindService {
  /** Fork the session at an exact event seq and return the new session id. */
  fork(sessionId: string, atSeq: number): Promise<string>
  /** The dsh session an OpenCode session id currently points at. */
  resolveAlias(sessionId: string): string
  /** Point an OpenCode session id at a different dsh session. */
  setAlias(opencodeId: string, dshId: string): void
  /** The diffs of the files the revert rolls back. */
  filesAfter(sessionId: string, boundary: RewindBoundary): RewindFileDiff[]
  /** Restore the files the revert rolls back; returns the paths. */
  restoreFilesAfter(sessionId: string, boundary: RewindBoundary): string[]
  /** Put the restored files back (the staged revert was cleared). */
  undoRestore(sessionId: string): string[]
  /** Drop the restore state (the staged revert was committed). */
  commitRestore(sessionId: string): void
  /** Forget the captured files of a session. */
  forgetFiles(sessionId: string): void
}

/**
 * Build a compact unified diff from two file contents.
 *
 * OpenCode's revert reports the diff of every file it rolls back, and the
 * official TUI renders it. The diff only has to be a valid `---/+++` patch,
 * so one hunk around the first and last changed line is enough.
 */
export function unifiedDiff(file: string, oldText: string, newText: string): {
  patch: string
  additions: number
  deletions: number
} {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }
  const removed = oldLines.slice(start, oldEnd)
  const added = newLines.slice(start, newEnd)
  if (removed.length === 0 && added.length === 0) {
    return { patch: '', additions: 0, deletions: 0 }
  }
  const oldStart = removed.length === 0 ? start : start + 1
  const newStart = added.length === 0 ? start : start + 1
  const name = file.replace(/\\/g, '/').replace(/^\/+/, '')
  const header = `@@ -${oldStart}${removed.length === 0 ? '' : `,${removed.length}`} +${newStart}${added.length === 0 ? '' : `,${added.length}`} @@`
  const body = [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)]
  return {
    patch: [`--- a/${name}`, `+++ b/${name}`, header, ...body].join('\n') + '\n',
    additions: added.length,
    deletions: removed.length,
  }
}

/**
 * The file copies a rewind restores. Kept separate from the Cordis service so
 * the copy-and-restore logic is testable without a host context.
 */
export class FileSnapshots {
  /** Captured files per session, grouped by the turn that changed them. */
  private readonly captures = new Map<string, TurnCapture[]>()
  /** The working directory of a session, keyed by session id. */
  private readonly directories = new Map<string, string>()
  /** The turn a session is currently in, keyed by session id. */
  private readonly currentTurn = new Map<string, number>()
  /** The content the restored files had when the revert was staged. */
  private readonly staged = new Map<string, Map<string, FileSnapshot>>()

  setDirectory(sessionId: string, directory: string): void {
    this.directories.set(sessionId, directory)
  }

  /**
   * Record the turn a session entered. A new turn starts a new capture group,
   * so a revert can roll back only the turns after its boundary.
   */
  beginTurn(sessionId: string, turn: number): void {
    this.currentTurn.set(sessionId, turn)
  }

  /** The turn a session is currently in. */
  turn(sessionId: string): number {
    return this.currentTurn.get(sessionId) ?? 0
  }

  /**
   * Capture a file's current content once per turn. A second mutation of the
   * same path in the same turn keeps the first capture, so the restore
   * returns the state before the earliest change of that turn.
   */
  capture(sessionId: string, path: string): void {
    const root = this.directories.get(sessionId) ?? process.cwd()
    const absolute = resolve(root, path)
    const rel = relative(root, absolute)
    if (rel.length === 0 || rel.startsWith('..')) return
    const turn = this.turn(sessionId)
    let groups = this.captures.get(sessionId)
    if (groups === undefined) {
      groups = []
      this.captures.set(sessionId, groups)
    }
    let group = groups.find((entry) => entry.turn === turn)
    if (group === undefined) {
      group = { turn, files: new Map() }
      groups.push(group)
    }
    if (group.files.has(rel)) return
    const existed = existsSync(absolute)
    group.files.set(rel, {
      path: rel,
      content: existed ? readFileSync(absolute) : Buffer.alloc(0),
      existed,
    })
  }

  /**
   * The files the revert rolls back, with the content from before the
   * earliest of those changes.
   */
  private affected(sessionId: string, boundary: RewindBoundary): Map<string, FileSnapshot> {
    const groups = this.captures.get(sessionId) ?? []
    const affected = new Map<string, FileSnapshot>()
    for (const group of groups) {
      if (group.turn < boundary.turn) continue
      if (group.turn === boundary.turn && !boundary.includeTurn) continue
      for (const [path, snapshot] of group.files) {
        // The earliest capture of a path is the state before the first
        // change, so it wins over a later group's copy.
        if (!affected.has(path)) affected.set(path, snapshot)
      }
    }
    return affected
  }

  /** The diffs of the files the revert rolls back. */
  diffsAfter(sessionId: string, boundary: RewindBoundary): RewindFileDiff[] {
    const root = this.directories.get(sessionId) ?? process.cwd()
    const diffs: RewindFileDiff[] = []
    for (const snapshot of this.affected(sessionId, boundary).values()) {
      const absolute = join(root, snapshot.path)
      const exists = existsSync(absolute)
      const current = exists ? readFileSync(absolute).toString('utf8') : ''
      const original = snapshot.content.toString('utf8')
      const { patch, additions, deletions } = unifiedDiff(snapshot.path, original, current)
      diffs.push({
        file: snapshot.path,
        patch,
        additions,
        deletions,
        status: !snapshot.existed ? 'added' : !exists ? 'deleted' : 'modified',
      })
    }
    return diffs
  }

  /**
   * Restore the files the revert rolls back. The content the files had at
   * that moment is kept so a cleared revert can put them back.
   */
  restore(sessionId: string, boundary: RewindBoundary): string[] {
    const root = this.directories.get(sessionId) ?? process.cwd()
    const affected = this.affected(sessionId, boundary)
    const staged = new Map<string, FileSnapshot>()
    const restored: string[] = []
    for (const snapshot of affected.values()) {
      const absolute = join(root, snapshot.path)
      try {
        const exists = existsSync(absolute)
        staged.set(snapshot.path, {
          path: snapshot.path,
          content: exists ? readFileSync(absolute) : Buffer.alloc(0),
          existed: exists,
        })
        if (snapshot.existed) {
          mkdirSync(dirname(absolute), { recursive: true })
          writeFileSync(absolute, snapshot.content)
        } else if (exists) {
          rmSync(absolute)
        }
        restored.push(snapshot.path)
      } catch {
        // A file that cannot be restored stays as it is; the caller logs it.
      }
    }
    this.staged.set(sessionId, staged)
    return restored
  }

  /** Put the restored files back; used when a staged revert is cleared. */
  unstage(sessionId: string): string[] {
    const staged = this.staged.get(sessionId)
    if (staged === undefined) return []
    const root = this.directories.get(sessionId) ?? process.cwd()
    const restored: string[] = []
    for (const snapshot of staged.values()) {
      const absolute = join(root, snapshot.path)
      try {
        if (snapshot.existed) {
          mkdirSync(dirname(absolute), { recursive: true })
          writeFileSync(absolute, snapshot.content)
        } else if (existsSync(absolute)) {
          rmSync(absolute)
        }
        restored.push(snapshot.path)
      } catch {
        // A file that cannot be restored stays as it is; the caller logs it.
      }
    }
    this.staged.delete(sessionId)
    return restored
  }

  /** Drop the staged content without restoring it; used on commit. */
  commit(sessionId: string): void {
    this.staged.delete(sessionId)
  }

  forget(sessionId: string): void {
    this.captures.delete(sessionId)
    this.staged.delete(sessionId)
  }
}

export class RewindServiceImpl extends Service<RewindService> {
  private aliases = new Map<string, string>()
  private readonly files = new FileSnapshots()
  /** The session a tool execution belongs to, keyed by the execution object. */
  private executions = new WeakMap<object, string>()

  constructor(ctx: Context) {
    super(ctx, 'rewind')
    this.watchExecutions()
    this.watchTurns()
  }

  async fork(sessionId: string, atSeq: number): Promise<string> {
    const api = this.ctx.get('sessionController') as {
      fork: (req: { sessionId: any; atSeq?: number; allowMigration?: boolean }) => Promise<{ sessionId: any }>
    }
    // A revert that was committed before moved the conversation to a fork, so
    // the fork has to be taken from the session the opencode id points at.
    const result = await api.fork({ sessionId: this.resolveAlias(sessionId), atSeq, allowMigration: true })
    return String(result.sessionId)
  }

  resolveAlias(sessionId: string): string {
    return this.aliases.get(sessionId) ?? sessionId
  }

  setAlias(opencodeId: string, dshId: string): void {
    this.aliases.set(opencodeId, dshId)
  }

  /** The diffs of the files the revert rolls back. */
  filesAfter(sessionId: string, boundary: RewindBoundary): RewindFileDiff[] {
    return this.files.diffsAfter(sessionId, boundary)
  }

  /** Restore the files the revert rolls back. */
  restoreFilesAfter(sessionId: string, boundary: RewindBoundary): string[] {
    return this.files.restore(sessionId, boundary)
  }

  /** Put the restored files back (the staged revert was cleared). */
  undoRestore(sessionId: string): string[] {
    return this.files.unstage(sessionId)
  }

  /** Drop the restore state (the staged revert was committed). */
  commitRestore(sessionId: string): void {
    this.files.commit(sessionId)
  }

  forgetFiles(sessionId: string): void {
    this.files.forget(sessionId)
  }

  /**
   * Watch the tool and filesystem seams so the plugin knows which session a
   * mutation belongs to and can capture the file before it changes.
   */
  private watchExecutions(): void {
    const ctx = this.ctx as unknown as {
      fs?: { processPath: (target: unknown) => string }
      on: (event: string, handler: (...args: any[]) => any, options?: unknown) => void
    }
    ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<unknown>) => {
      const session = exec?.agent?.session
      const id = session?.id
      if (typeof id === 'string') {
        this.executions.set(exec, id)
        const cwd = session?.header?.cwd
        if (typeof cwd === 'string') this.files.setDirectory(id, cwd)
      }
      return next()
    })

    const capture = async (target: unknown, actor: unknown): Promise<void> => {
      const exec = actor as object | undefined
      if (exec === undefined || typeof exec !== 'object') return
      const sessionId = this.executions.get(exec)
      if (sessionId === undefined) return
      const path = ctx.fs?.processPath(target)
      if (typeof path !== 'string' || path.length === 0) return
      this.files.capture(sessionId, path)
    }

    ctx.on('fs/write-intent', async (target: unknown, actor: unknown, next: () => Promise<unknown>) => {
      const intent = await next()
      await capture(target, actor)
      return intent
    }, { prepend: true })
    ctx.on('fs/edit-intent', async (target: unknown, actor: unknown, next: () => Promise<unknown>) => {
      const intent = await next()
      await capture(target, actor)
      return intent
    }, { prepend: true })
  }

  /**
   * Track the turn every session is in, so a captured file belongs to the
   * turn that changed it. dsh opens a turn with a `turn/start` event that
   * carries the turn number.
   */
  private watchTurns(): void {
    const ctx = this.ctx as unknown as {
      on: (event: string, handler: (...args: any[]) => any, options?: unknown) => void
    }
    ctx.on('session/event', (session: any, event: any) => {
      const sessionId = session?.id
      if (typeof sessionId !== 'string') return
      if (event?.type !== 'turn/start') return
      const turn = event?.data?.turn
      if (typeof turn !== 'number') return
      this.files.beginTurn(sessionId, turn)
    }, { global: true })
  }
}

export function apply(ctx: Context): void {
  ctx.plugin(RewindServiceImpl)
}
