import { Service } from "@deepseek-ai/cordis";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
//#region src/rewind/index.ts
const name = "@chiro2001/dsh-oc/rewind";
/**
* Build a compact unified diff from two file contents.
*
* OpenCode's revert reports the diff of every file it rolls back, and the
* official TUI renders it. The diff only has to be a valid `---/+++` patch,
* so one hunk around the first and last changed line is enough.
*/
function unifiedDiff(file, oldText, newText) {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
		oldEnd -= 1;
		newEnd -= 1;
	}
	const removed = oldLines.slice(start, oldEnd);
	const added = newLines.slice(start, newEnd);
	if (removed.length === 0 && added.length === 0) return {
		patch: "",
		additions: 0,
		deletions: 0
	};
	const oldStart = removed.length === 0 ? start : start + 1;
	const newStart = added.length === 0 ? start : start + 1;
	const name = file.replace(/\\/g, "/").replace(/^\/+/, "");
	const header = `@@ -${oldStart}${removed.length === 0 ? "" : `,${removed.length}`} +${newStart}${added.length === 0 ? "" : `,${added.length}`} @@`;
	const body = [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)];
	return {
		patch: [
			`--- a/${name}`,
			`+++ b/${name}`,
			header,
			...body
		].join("\n") + "\n",
		additions: added.length,
		deletions: removed.length
	};
}
/**
* The file copies a rewind restores. Kept separate from the Cordis service so
* the copy-and-restore logic is testable without a host context.
*/
var FileSnapshots = class {
	/** Captured files per session, grouped by the turn that changed them. */
	captures = /* @__PURE__ */ new Map();
	/** The working directory of a session, keyed by session id. */
	directories = /* @__PURE__ */ new Map();
	/** The turn a session is currently in, keyed by session id. */
	currentTurn = /* @__PURE__ */ new Map();
	/** The content the restored files had when the revert was staged. */
	staged = /* @__PURE__ */ new Map();
	setDirectory(sessionId, directory) {
		this.directories.set(sessionId, directory);
	}
	/**
	* Record the turn a session entered. A new turn starts a new capture group,
	* so a revert can roll back only the turns after its boundary.
	*/
	beginTurn(sessionId, turn) {
		this.currentTurn.set(sessionId, turn);
	}
	/** The turn a session is currently in. */
	turn(sessionId) {
		return this.currentTurn.get(sessionId) ?? 0;
	}
	/**
	* Capture a file's current content once per turn. A second mutation of the
	* same path in the same turn keeps the first capture, so the restore
	* returns the state before the earliest change of that turn.
	*/
	capture(sessionId, path) {
		const root = this.directories.get(sessionId) ?? process.cwd();
		const absolute = resolve(root, path);
		const rel = relative(root, absolute);
		if (rel.length === 0 || rel.startsWith("..")) return;
		const turn = this.turn(sessionId);
		let groups = this.captures.get(sessionId);
		if (groups === void 0) {
			groups = [];
			this.captures.set(sessionId, groups);
		}
		let group = groups.find((entry) => entry.turn === turn);
		if (group === void 0) {
			group = {
				turn,
				files: /* @__PURE__ */ new Map()
			};
			groups.push(group);
		}
		if (group.files.has(rel)) return;
		const existed = existsSync(absolute);
		group.files.set(rel, {
			path: rel,
			content: existed ? readFileSync(absolute) : Buffer.alloc(0),
			existed
		});
	}
	/**
	* The files the revert rolls back, with the content from before the
	* earliest of those changes.
	*/
	affected(sessionId, boundary) {
		const groups = this.captures.get(sessionId) ?? [];
		const affected = /* @__PURE__ */ new Map();
		for (const group of groups) {
			if (group.turn < boundary.turn) continue;
			if (group.turn === boundary.turn && !boundary.includeTurn) continue;
			for (const [path, snapshot] of group.files) if (!affected.has(path)) affected.set(path, snapshot);
		}
		return affected;
	}
	/** The diffs of the files the revert rolls back. */
	diffsAfter(sessionId, boundary) {
		const root = this.directories.get(sessionId) ?? process.cwd();
		const diffs = [];
		for (const snapshot of this.affected(sessionId, boundary).values()) {
			const absolute = join(root, snapshot.path);
			const exists = existsSync(absolute);
			const current = exists ? readFileSync(absolute).toString("utf8") : "";
			const original = snapshot.content.toString("utf8");
			const { patch, additions, deletions } = unifiedDiff(snapshot.path, original, current);
			diffs.push({
				file: snapshot.path,
				patch,
				additions,
				deletions,
				status: !snapshot.existed ? "added" : !exists ? "deleted" : "modified"
			});
		}
		return diffs;
	}
	/**
	* Restore the files the revert rolls back. The content the files had at
	* that moment is kept so a cleared revert can put them back.
	*/
	restore(sessionId, boundary) {
		const root = this.directories.get(sessionId) ?? process.cwd();
		const affected = this.affected(sessionId, boundary);
		const staged = /* @__PURE__ */ new Map();
		const restored = [];
		for (const snapshot of affected.values()) {
			const absolute = join(root, snapshot.path);
			try {
				const exists = existsSync(absolute);
				staged.set(snapshot.path, {
					path: snapshot.path,
					content: exists ? readFileSync(absolute) : Buffer.alloc(0),
					existed: exists
				});
				if (snapshot.existed) {
					mkdirSync(dirname(absolute), { recursive: true });
					writeFileSync(absolute, snapshot.content);
				} else if (exists) rmSync(absolute);
				restored.push(snapshot.path);
			} catch {}
		}
		this.staged.set(sessionId, staged);
		return restored;
	}
	/** Put the restored files back; used when a staged revert is cleared. */
	unstage(sessionId) {
		const staged = this.staged.get(sessionId);
		if (staged === void 0) return [];
		const root = this.directories.get(sessionId) ?? process.cwd();
		const restored = [];
		for (const snapshot of staged.values()) {
			const absolute = join(root, snapshot.path);
			try {
				if (snapshot.existed) {
					mkdirSync(dirname(absolute), { recursive: true });
					writeFileSync(absolute, snapshot.content);
				} else if (existsSync(absolute)) rmSync(absolute);
				restored.push(snapshot.path);
			} catch {}
		}
		this.staged.delete(sessionId);
		return restored;
	}
	/** Drop the staged content without restoring it; used on commit. */
	commit(sessionId) {
		this.staged.delete(sessionId);
	}
	forget(sessionId) {
		this.captures.delete(sessionId);
		this.staged.delete(sessionId);
	}
};
var RewindServiceImpl = class extends Service {
	aliases = /* @__PURE__ */ new Map();
	files = new FileSnapshots();
	/** The session a tool execution belongs to, keyed by the execution object. */
	executions = /* @__PURE__ */ new WeakMap();
	constructor(ctx) {
		super(ctx, "rewind");
		this.watchExecutions();
		this.watchTurns();
	}
	async fork(sessionId, atSeq) {
		const result = await this.ctx.get("sessionController").fork({
			sessionId: this.resolveAlias(sessionId),
			atSeq,
			allowMigration: true
		});
		return String(result.sessionId);
	}
	resolveAlias(sessionId) {
		return this.aliases.get(sessionId) ?? sessionId;
	}
	setAlias(opencodeId, dshId) {
		this.aliases.set(opencodeId, dshId);
	}
	/** The diffs of the files the revert rolls back. */
	filesAfter(sessionId, boundary) {
		return this.files.diffsAfter(sessionId, boundary);
	}
	/** Restore the files the revert rolls back. */
	restoreFilesAfter(sessionId, boundary) {
		return this.files.restore(sessionId, boundary);
	}
	/** Put the restored files back (the staged revert was cleared). */
	undoRestore(sessionId) {
		return this.files.unstage(sessionId);
	}
	/** Drop the restore state (the staged revert was committed). */
	commitRestore(sessionId) {
		this.files.commit(sessionId);
	}
	forgetFiles(sessionId) {
		this.files.forget(sessionId);
	}
	/**
	* Watch the tool and filesystem seams so the plugin knows which session a
	* mutation belongs to and can capture the file before it changes.
	*/
	watchExecutions() {
		const ctx = this.ctx;
		ctx.on("tools/pre-execute", async (exec, next) => {
			const session = exec?.agent?.session;
			const id = session?.id;
			if (typeof id === "string") {
				this.executions.set(exec, id);
				const cwd = session?.header?.cwd;
				if (typeof cwd === "string") this.files.setDirectory(id, cwd);
			}
			return next();
		});
		const capture = async (target, actor) => {
			const exec = actor;
			if (exec === void 0 || typeof exec !== "object") return;
			const sessionId = this.executions.get(exec);
			if (sessionId === void 0) return;
			const path = ctx.fs?.processPath(target);
			if (typeof path !== "string" || path.length === 0) return;
			this.files.capture(sessionId, path);
		};
		ctx.on("fs/write-intent", async (target, actor, next) => {
			const intent = await next();
			await capture(target, actor);
			return intent;
		}, { prepend: true });
		ctx.on("fs/edit-intent", async (target, actor, next) => {
			const intent = await next();
			await capture(target, actor);
			return intent;
		}, { prepend: true });
	}
	/**
	* Track the turn every session is in, so a captured file belongs to the
	* turn that changed it. dsh opens a turn with a `turn/start` event that
	* carries the turn number.
	*/
	watchTurns() {
		this.ctx.on("session/event", (session, event) => {
			const sessionId = session?.id;
			if (typeof sessionId !== "string") return;
			if (event?.type !== "turn/start") return;
			const turn = event?.data?.turn;
			if (typeof turn !== "number") return;
			this.files.beginTurn(sessionId, turn);
		}, { global: true });
	}
};
function apply(ctx) {
	ctx.plugin(RewindServiceImpl);
}
//#endregion
export { FileSnapshots, RewindServiceImpl, apply, name, unifiedDiff };

//# sourceMappingURL=index.js.map