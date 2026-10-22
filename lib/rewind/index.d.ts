import { Context, Service } from "@deepseek-ai/cordis";
//#region src/rewind/index.d.ts
declare const name = "@chiro2001/dsh-oc/rewind";
/** One captured file, keyed by its path relative to the session directory. */
interface FileSnapshot {
  /** Path relative to the session working directory. */
  path: string;
  /** The content before the mutation. */
  content: Buffer;
  /** Whether the file existed before the mutation. */
  existed: boolean;
}
/** The file diff OpenCode reports for a staged revert. */
interface RewindFileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
}
/**
 * The file boundary of a revert.
 *
 * OpenCode rolls back the files of the assistant messages that come *after*
 * the boundary message. A user prompt therefore also rolls back the files its
 * own turn changed (the assistant reply follows it), while an assistant reply
 * does not.
 */
interface RewindBoundary {
  /** The dsh turn the boundary message belongs to. */
  turn: number;
  /** Whether the boundary turn's own file changes roll back. */
  includeTurn: boolean;
}
interface RewindService {
  /** Fork the session at an exact event seq and return the new session id. */
  fork(sessionId: string, atSeq: number): Promise<string>;
  /** The dsh session an OpenCode session id currently points at. */
  resolveAlias(sessionId: string): string;
  /** Point an OpenCode session id at a different dsh session. */
  setAlias(opencodeId: string, dshId: string): void;
  /** The diffs of the files the revert rolls back. */
  filesAfter(sessionId: string, boundary: RewindBoundary): RewindFileDiff[];
  /** Restore the files the revert rolls back; returns the paths. */
  restoreFilesAfter(sessionId: string, boundary: RewindBoundary): string[];
  /** Put the restored files back (the staged revert was cleared). */
  undoRestore(sessionId: string): string[];
  /** Drop the restore state (the staged revert was committed). */
  commitRestore(sessionId: string): void;
  /** Forget the captured files of a session. */
  forgetFiles(sessionId: string): void;
}
/**
 * Build a compact unified diff from two file contents.
 *
 * OpenCode's revert reports the diff of every file it rolls back, and the
 * official TUI renders it. The diff only has to be a valid `---/+++` patch,
 * so one hunk around the first and last changed line is enough.
 */
declare function unifiedDiff(file: string, oldText: string, newText: string): {
  patch: string;
  additions: number;
  deletions: number;
};
/**
 * The file copies a rewind restores. Kept separate from the Cordis service so
 * the copy-and-restore logic is testable without a host context.
 */
declare class FileSnapshots {
  /** Captured files per session, grouped by the turn that changed them. */
  private readonly captures;
  /** The working directory of a session, keyed by session id. */
  private readonly directories;
  /** The turn a session is currently in, keyed by session id. */
  private readonly currentTurn;
  /** The content the restored files had when the revert was staged. */
  private readonly staged;
  setDirectory(sessionId: string, directory: string): void;
  /**
   * Record the turn a session entered. A new turn starts a new capture group,
   * so a revert can roll back only the turns after its boundary.
   */
  beginTurn(sessionId: string, turn: number): void;
  /** The turn a session is currently in. */
  turn(sessionId: string): number;
  /**
   * Capture a file's current content once per turn. A second mutation of the
   * same path in the same turn keeps the first capture, so the restore
   * returns the state before the earliest change of that turn.
   */
  capture(sessionId: string, path: string): void;
  /**
   * The files the revert rolls back, with the content from before the
   * earliest of those changes.
   */
  private affected;
  /** The diffs of the files the revert rolls back. */
  diffsAfter(sessionId: string, boundary: RewindBoundary): RewindFileDiff[];
  /**
   * Restore the files the revert rolls back. The content the files had at
   * that moment is kept so a cleared revert can put them back.
   */
  restore(sessionId: string, boundary: RewindBoundary): string[];
  /** Put the restored files back; used when a staged revert is cleared. */
  unstage(sessionId: string): string[];
  /** Drop the staged content without restoring it; used on commit. */
  commit(sessionId: string): void;
  forget(sessionId: string): void;
}
declare class RewindServiceImpl extends Service<RewindService> {
  private aliases;
  private readonly files;
  /** The session a tool execution belongs to, keyed by the execution object. */
  private executions;
  constructor(ctx: Context);
  fork(sessionId: string, atSeq: number): Promise<string>;
  resolveAlias(sessionId: string): string;
  setAlias(opencodeId: string, dshId: string): void;
  /** The diffs of the files the revert rolls back. */
  filesAfter(sessionId: string, boundary: RewindBoundary): RewindFileDiff[];
  /** Restore the files the revert rolls back. */
  restoreFilesAfter(sessionId: string, boundary: RewindBoundary): string[];
  /** Put the restored files back (the staged revert was cleared). */
  undoRestore(sessionId: string): string[];
  /** Drop the restore state (the staged revert was committed). */
  commitRestore(sessionId: string): void;
  forgetFiles(sessionId: string): void;
  /**
   * Watch the tool and filesystem seams so the plugin knows which session a
   * mutation belongs to and can capture the file before it changes.
   */
  private watchExecutions;
  /**
   * Track the turn every session is in, so a captured file belongs to the
   * turn that changed it. dsh opens a turn with a `turn/start` event that
   * carries the turn number.
   */
  private watchTurns;
}
declare function apply(ctx: Context): void;
//#endregion
export { FileSnapshot, FileSnapshots, RewindBoundary, RewindFileDiff, RewindService, RewindServiceImpl, apply, name, unifiedDiff };
//# sourceMappingURL=index.d.ts.map