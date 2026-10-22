import { n as ocHelp } from "./help-B7zNQpiS.js";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn, spawnSync } from "node:child_process";
import { brotliDecompressSync } from "node:zlib";
//#region src/bridge/rpc.ts
/**
* Expand one dsh 0.1.5 durable history record into the bridge's `{ event }`
* rows.
*
* 0.1.5 removed both the packed `chunks` history record and the durable
* `assistant/chunk` session event: one settled step is a single
* `assistant/message` whose `data.stream` embeds the exact timed model stream
* as packed runs (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`, plus
* raw block/usage/finish chunks). The translation layer already consumes those
* packed rows, so history re-materializes each run *before* the message event:
* the runs rebuild the partial streamed card, and the final `assistant/message`
* then splices it into the durable message.
*/
function expandRecord(record) {
	const event = record.event;
	const rows = [];
	if (event.type === "assistant/message" && Array.isArray(event.data?.stream)) {
		const turn = Number(event.data?.turn ?? 0);
		const step = Number(event.data?.step ?? 0);
		for (const streamRecord of event.data.stream) {
			const row = expandStreamRecord(streamRecord, event.seq, turn, step);
			if (row !== void 0) rows.push({ event: row });
		}
	}
	rows.push({ event });
	return rows;
}
/** Re-materialize one packed assistant stream run as a history row event. */
function expandStreamRecord(streamRecord, seq, turn, step) {
	if (streamRecord.type === "text-chunks" || streamRecord.type === "reasoning-chunks") return {
		type: streamRecord.type,
		seq,
		time: streamRecord.time0 + sumGaps(streamRecord.dt),
		time0: streamRecord.time0,
		data: {
			turn,
			step,
			index: streamRecord.index,
			texts: [...streamRecord.texts]
		}
	};
	if (streamRecord.type === "tool-call-chunks") return {
		type: "tool-call-chunks",
		seq,
		time: streamRecord.time0 + sumGaps(streamRecord.dt),
		time0: streamRecord.time0,
		data: {
			turn,
			step,
			index: streamRecord.index,
			id: String(streamRecord.id),
			...streamRecord.name === void 0 ? {} : { name: streamRecord.name },
			args: [...streamRecord.args]
		}
	};
}
function sumGaps(dt) {
	if (!Array.isArray(dt)) return 0;
	let total = 0;
	for (const gap of dt) if (typeof gap === "number") total += gap;
	return total;
}
/** A dsh 0.1.2 Remote failure, rethrown so the HTTP layer can map its code. */
var RpcCallError = class extends Error {
	code;
	details;
	constructor(code, message, details) {
		super(message);
		this.name = "RpcCallError";
		this.code = code;
		this.details = details;
	}
};
/** Normalize a thrown RemoteError-like value into RpcCallError. */
function normalizeRemoteError(error) {
	if (error instanceof RpcCallError) return error;
	if (error instanceof Error) {
		const code = error.code;
		const details = error.details;
		if (typeof code === "string") return new RpcCallError(code, error.message, details);
		return new RpcCallError("gateway/internal", error.message, void 0);
	}
	return new RpcCallError("gateway/internal", String(error), void 0);
}
/**
* Resolve a Session's live Agent through SessionController; a Session-domain
* failure becomes an RpcCallError carrying its code.
*/
async function resolveAgent(api, sessionId) {
	const result = await api.sessionController.resolveAgent(sessionId);
	if ("error" in result) {
		const { code, message, details } = result.error;
		throw new RpcCallError(code, message, details);
	}
	return result.agent;
}
/** Read one opening follow snapshot and close the iterator immediately. */
async function readHistoryThroughFollow(api, sessionId, maxMessages, beforeSeq, signal) {
	const address = api.sessionAddress?.(sessionId) ?? {
		kind: "session",
		sessionId
	};
	const followRequest = {
		address,
		...maxMessages === void 0 ? {} : { maxMessages }
	};
	const it = api.sessionController.follow(followRequest, signal)[Symbol.asyncIterator]();
	try {
		const first = await it.next();
		if (first.done) return {
			events: [],
			hasMore: false
		};
		const snapshot = first.value;
		if (snapshot.type !== "snapshot") return {
			events: [],
			hasMore: false
		};
		let records = snapshot.records;
		let hasMore = snapshot.hasMore;
		if (beforeSeq !== void 0 && beforeSeq <= snapshot.cursor) {
			const page = await api.sessionController.page({
				address,
				throughSeq: snapshot.cursor,
				beforeSeq,
				...maxMessages === void 0 ? {} : { maxMessages }
			}, signal);
			records = page.records;
			hasMore = page.hasMore;
		}
		return {
			events: records.flatMap(expandRecord),
			hasMore,
			...snapshot.projections === void 0 ? {} : { projections: snapshot.projections }
		};
	} finally {
		try {
			await it.return?.();
		} catch {}
	}
}
function modelSelectionFromHistory(history) {
	const projection = history.projections?.values.modelSelection;
	const candidate = projection?.next ?? projection?.lastUsed;
	if (candidate !== null && candidate !== void 0 && typeof candidate.provider === "string" && typeof candidate.model === "string") return {
		provider: candidate.provider,
		model: candidate.model,
		...typeof candidate.reasoningEffort === "string" ? { reasoningEffort: candidate.reasoningEffort } : {}
	};
	for (let index = history.events.length - 1; index >= 0; index--) {
		const event = history.events[index]?.event;
		if (event?.type !== "model/selection") continue;
		const data = event.data;
		if (typeof data.provider !== "string" || typeof data.model !== "string") continue;
		return {
			provider: data.provider,
			model: data.model,
			...typeof data.reasoningEffort === "string" ? { reasoningEffort: data.reasoningEffort } : {}
		};
	}
}
/**
* Call a dsh host business method in-process. The method name uses the
* opencode wire convention (`session.list`, `agentPreset.select`, ...); the
* dispatcher maps it onto the owning host service and unwraps RemoteResult.
*/
async function call(api, method, payload, signal) {
	const sig = signal ?? new AbortController().signal;
	try {
		const sessionId = String(payload.sessionId ?? "");
		switch (method) {
			case "session.list": return await api.sessionController.list({}, sig);
			case "session.search": return await api.sessionController.search(payload, sig);
			case "session.create": return await api.sessionController.create(payload);
			case "session.selectModel": return await api.sessionController.selectModel(payload);
			case "session.models": {
				if (typeof api.sessionController.models === "function") return await api.sessionController.models({ sessionId });
				const catalog = await api.sessionController.modelCatalog();
				try {
					const selected = modelSelectionFromHistory(await readHistoryThroughFollow(api, sessionId, void 0, void 0, sig));
					if (selected !== void 0) return { current: selected };
				} catch {}
				return { current: catalog.default };
			}
			case "llm.models": return await api.sessionController.modelCatalog();
			case "session.rename": return await api.sessionController.rename(payload);
			case "session.fork": return await api.sessionController.fork(payload);
			case "session.prompt": {
				const request = payload;
				const promptRequest = {
					...request,
					...request.requestId === void 0 ? { requestId: randomUUID() } : {}
				};
				return await api.sessionController.prompt(promptRequest, sig);
			}
			case "session.cancel": return await api.sessionController.cancel(payload);
			case "session.history": {
				const maxMessages = typeof payload.maxMessages === "number" ? payload.maxMessages : void 0;
				const beforeSeq = typeof payload.beforeSeq === "number" ? payload.beforeSeq : void 0;
				if (typeof api.sessionController.history === "function") return await api.sessionController.history({
					sessionId,
					maxMessages,
					beforeSeq
				}, sig);
				return await readHistoryThroughFollow(api, sessionId, maxMessages, beforeSeq, sig);
			}
			case "agentPreset.list": return await api.agentPresets.list();
			case "agentPreset.select": {
				const agent = await resolveAgent(api, sessionId);
				return await api.agentPresets.select(agent, String(payload.agentPreset ?? ""));
			}
			case "goal.create":
			case "goal.edit": {
				const agent = await resolveAgent(api, sessionId);
				return method === "goal.create" ? await api.goals.create(agent, payload.request ?? payload) : await api.goals.edit(agent, payload.ref, payload.request ?? payload);
			}
			case "goal.pause":
			case "goal.resume":
			case "goal.complete":
			case "goal.clear": {
				const agent = await resolveAgent(api, sessionId);
				const ref = payload.ref;
				const op = method.slice(5);
				return await api.goals[op](agent, ref);
			}
			case "skill.list": return await api.sessionSkillCatalog.list(payload, signal);
			default: throw new Error(`unknown dsh rpc method "${method}"`);
		}
	} catch (error) {
		throw normalizeRemoteError(error);
	}
}
//#endregion
//#region src/bridge/errors.ts
var HttpError = class extends Error {
	status;
	body;
	constructor(status, body) {
		super(body.message);
		this.status = status;
		this.body = body;
		this.name = "HttpError";
	}
};
function envelope(name, message, data = {}) {
	return {
		name,
		message,
		data: {
			message,
			...data
		}
	};
}
function notFound(message, data) {
	return new HttpError(404, envelope("NotFoundError", message, data));
}
function notImplemented(message) {
	return new HttpError(501, envelope("NotFoundError", message));
}
function badRequest(message, data) {
	return new HttpError(400, envelope("BadRequest", message, data));
}
function conflict(message, data) {
	return new HttpError(409, envelope("ConflictError", message, data));
}
function internalError(message, data) {
	return new HttpError(500, envelope("InternalServerError", message, data));
}
/** Error codes the client can correct by re-issuing the request. */
const CLIENT_FIXABLE = /* @__PURE__ */ new Set([
	"bad-request",
	"title-invalid",
	"command-error",
	"unknown-command",
	"model-unavailable",
	"agent-preset-not-found",
	"agent-preset-invalid",
	"agent-preset-read-only",
	"agent-preset-conflict",
	"settings-rejected",
	"settings-not-exposed",
	"settings-conflict",
	"credential-rejected",
	"attachment-error",
	"session/attachment-invalid",
	"session/model-unavailable",
	"agent-preset/invalid",
	"agent-preset/read-only",
	"gateway/bad-request",
	"workspace/invalid-path",
	"settings/rejected",
	"session/invalid-time-zone",
	"session/title-invalid",
	"directory-unreadable",
	"directory-exists",
	"directory-create-failed",
	"queue-item-not-found",
	"invalid-time-zone",
	"workspace-invalid-path",
	"workspace-name-conflict",
	"model-discovery-failed"
]);
/** Codes that mean the session/turn is currently owned by another actor. */
const CONFLICT_CODES = /* @__PURE__ */ new Set([
	"agent-busy",
	"session/agent-busy",
	"session/conflict",
	"session/steer-unavailable",
	"session/fork-unavailable",
	"agent-preset/conflict",
	"settings/conflict",
	"workspace/name-conflict",
	"fork-unavailable",
	"steer-unavailable",
	"session-conflict",
	"subagent-parent-unavailable",
	"subagent-not-found",
	"subagent-catalog-diagnostic",
	"subagent-not-resumable",
	"subagent-unauthorized",
	"subagent-delivery-unavailable",
	"agent-preset/locked"
]);
/**
* Map a dsh RPC error to an opencode-compatible HTTP error. The dsh `code`
* and `details` are preserved inside `data` so diagnostics never disappear.
*/
function rpcErrorToHttp(error) {
	const data = {
		code: error.code === "session/attachment-invalid" ? "attachment-error" : error.code,
		details: error.details
	};
	if (error.code === "session-not-found" || error.code === "session/not-found" || error.code === "agent-preset/not-found" || error.code === "workspace/not-found" || error.code === "session/queue-item-not-found" || error.code === "subagent/not-found") return notFound(error.message, data);
	if (CONFLICT_CODES.has(error.code)) return conflict(error.message, data);
	if (CLIENT_FIXABLE.has(error.code)) return badRequest(error.message, data);
	return internalError(error.message, data);
}
//#endregion
//#region src/bridge/convert/common.ts
const OPENCODE_VERSION = "2.1.0";
const DEFAULT_AGENT = "build";
/**
* External provider identity. dsh calls its official route
* `deepseek-official`; opencode expects `deepseek` with display name
* `DeepSeek`. Every other provider id passes through unchanged.
*/
function externalProviderId(providerId) {
	return providerId === "deepseek-official" ? "deepseek" : providerId;
}
function externalProviderName(providerId, displayName) {
	if (providerId === "deepseek-official") return "DeepSeek";
	return displayName ?? providerId;
}
/** Reverse of `externalProviderId`: opencode-facing id → dsh route id. */
function dshProviderId(providerId) {
	return providerId === "deepseek" ? "deepseek-official" : providerId;
}
/** Stable short hash used as the opencode project id. */
function projectIdFor(directory) {
	return createHash("sha256").update(directory).digest("hex").slice(0, 16);
}
/**
* Stable provisional assistant message id used by both the live SSE
* translator and history hydration. The TUI reconciles streamed messages with
* `GET /session/{id}/message`, so both surfaces must name the same message.
*/
function provisionalMessageId(sessionId, turn, step) {
	return `msg_pending:${sessionId}:${turn}:${step}`;
}
/**
* Stable provisional text/reasoning part id shared by live SSE events and
* history hydration.
*/
function provisionalPartId(sessionId, turn, step, blockType, index) {
	return `prt_stream:${sessionId}:${turn}:${step}:${blockType}:${index}`;
}
function stableId(seed) {
	return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}
function safeJsonParse(raw) {
	try {
		const value = JSON.parse(raw);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}
function textFromBlocks(content) {
	return content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}
//#endregion
//#region src/bridge/convert/session.ts
function sessionTitleFrom(summary, override) {
	const title = (summary.projections?.values)?.title;
	if (typeof title === "string" && title.length > 0) return title;
	if (override !== void 0 && override.length > 0) return override;
	if (summary.origin === "subagent") return "Subagent session";
	const cwd = summary.cwd;
	if (typeof cwd === "string" && cwd.length > 0) {
		const base = cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
		if (base.length > 0) return base;
	}
	return String(summary.sessionId);
}
/** Metadata marker opencode surfaces use to identify dsh subagent children. */
function sessionMetadataFrom(summary) {
	if (summary.origin !== "subagent") return void 0;
	return { origin: "subagent" };
}
/**
* Convert a dsh `SessionSummary` into the opencode `session.updated`
* projection the SSE stream publishes.
*/
function convertSessionSummary(summary, options) {
	const directory = summary.cwd ?? options.cwd;
	const createdAt = options.createdAt ?? summary.updatedAt;
	const title = sessionTitleFrom(summary, options.title);
	const metadata = options.metadata ?? sessionMetadataFrom(summary);
	return {
		id: String(summary.sessionId),
		slug: String(summary.sessionId),
		projectID: projectIdFor(directory),
		directory,
		...summary.origin === "subagent" && summary.parentSessionId !== void 0 ? { parentID: String(summary.parentSessionId) } : {},
		title,
		agent: options.agent ?? summary.agentPreset ?? "build",
		...options.model === void 0 ? {} : { model: options.model },
		version: OPENCODE_VERSION,
		...metadata === void 0 ? {} : { metadata },
		time: {
			created: createdAt,
			updated: summary.updatedAt
		}
	};
}
/** Convert a summary into the v2 `/api/session` `SessionV2Info` shape. */
function convertSessionSummaryV2(summary, options) {
	const directory = summary.cwd ?? options.cwd;
	const createdAt = options.createdAt ?? summary.updatedAt;
	const metadata = options.metadata ?? sessionMetadataFrom(summary);
	return {
		id: String(summary.sessionId),
		...summary.origin === "subagent" && summary.parentSessionId !== void 0 ? { parentID: String(summary.parentSessionId) } : {},
		projectID: projectIdFor(directory),
		agent: options.agent ?? summary.agentPreset ?? "build",
		...options.model === void 0 ? {} : { model: options.model },
		...metadata === void 0 ? {} : { metadata },
		cost: 0,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache: {
				read: 0,
				write: 0
			}
		},
		time: {
			created: createdAt,
			updated: summary.updatedAt
		},
		title: sessionTitleFrom(summary, options.title),
		...options.revert === void 0 ? {} : { revert: options.revert },
		location: { directory }
	};
}
/** Minimal session view used by SSE when only the session id is known. */
function minimalSession(sessionId, options) {
	const directory = options.cwd;
	const created = options.createdAt ?? Date.now();
	return {
		id: sessionId,
		slug: sessionId,
		projectID: projectIdFor(directory),
		directory,
		title: options.title ?? "",
		agent: options.agent ?? "build",
		...options.model === void 0 ? {} : { model: options.model },
		version: OPENCODE_VERSION,
		...options.parentID === void 0 ? {} : { parentID: options.parentID },
		...options.metadata === void 0 ? {} : { metadata: options.metadata },
		time: {
			created,
			updated: Date.now()
		}
	};
}
/** Minimal v2 session view used when only the session id is known. */
function minimalSessionV2(sessionId, options) {
	const directory = options.cwd;
	const created = options.createdAt ?? Date.now();
	return {
		id: sessionId,
		...options.parentID === void 0 ? {} : { parentID: options.parentID },
		...options.metadata === void 0 ? {} : { metadata: options.metadata },
		projectID: projectIdFor(directory),
		cost: 0,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache: {
				read: 0,
				write: 0
			}
		},
		time: {
			created,
			updated: Date.now()
		},
		title: options.title ?? "",
		...options.revert === void 0 ? {} : { revert: options.revert },
		location: { directory },
		...options.model === void 0 ? {} : { model: options.model }
	};
}
//#endregion
//#region src/bridge/convert/model.ts
const DEFAULT_CONTEXT = 128e3;
const DEFAULT_OUTPUT = 8192;
/** Known dsh-official model capacities, matching dsh-llm-deepseek defaults. */
const DEEPSEEK_LIMITS = {
	"deepseek-v4-flash": {
		context: 1e6,
		output: 256e3
	},
	"deepseek-v4-pro": {
		context: 1e6,
		output: 256e3
	}
};
function limitFor(groupId, modelId) {
	if (groupId === "deepseek-official") {
		const known = DEEPSEEK_LIMITS[modelId];
		if (known) return known;
	}
	return {
		context: DEFAULT_CONTEXT,
		output: DEFAULT_OUTPUT
	};
}
/**
* A readable name for a model id, when the provider gives none.
*
* `deepseek-flash` → `DeepSeek Flash`, `deepseek-v4.1-flash` →
* `DeepSeek V4.1 Flash`.
*/
function displayModelName(modelId) {
	const words = modelId.split(/[-_\s]+/).filter((word) => word.length > 0);
	if (words.length === 0) return modelId;
	return words.map((word) => word.toLowerCase() === "deepseek" ? "DeepSeek" : `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
}
/**
* Match opencode's DeepSeek naming for the official dsh route:
* `DeepSeek-V4-Flash` → `DeepSeek V4 Flash`.
*
* Without a catalog name (a provider with no credential lists no models, so
* the bridge publishes the configured default) the id is made readable.
*/
function modelNameFor(groupId, modelId, modelName) {
	if (modelName === void 0) return displayModelName(modelId);
	return groupId === "deepseek-official" ? modelName.replaceAll("-", " ") : modelName;
}
function v2VariantsFor(model) {
	return (model.reasoning?.efforts ?? []).map((effort) => ({
		id: effort.id,
		headers: {},
		body: {
			reasoningEffort: effort.id,
			name: effort.name
		}
	}));
}
/** `GET /api/model` → `ClientModelInfo[]`. */
function convertToV2Models(groups) {
	return groups.flatMap((group) => {
		const providerId = externalProviderId(group.id);
		return group.models.map((model) => {
			const limit = limitFor(group.id, model.id);
			return {
				id: model.id,
				modelID: model.id,
				providerID: providerId,
				name: modelNameFor(group.id, model.id, model.name),
				api: {
					id: providerId,
					type: "native",
					url: "",
					settings: {}
				},
				capabilities: {
					tools: true,
					input: ["text"],
					output: ["text"]
				},
				request: {
					headers: {},
					body: {}
				},
				variants: v2VariantsFor(model),
				time: { released: 0 },
				cost: [{
					input: 0,
					output: 0,
					cache: {
						read: 0,
						write: 0
					}
				}],
				status: "active",
				enabled: true,
				limit
			};
		});
	});
}
/** `GET /api/provider` → `ClientProviderInfo[]`. */
function convertToV2Providers(groups) {
	return groups.map((group) => ({
		id: externalProviderId(group.id),
		name: externalProviderName(group.id, group.name),
		activation: "enabled",
		package: "@deepseek-ai/dsh",
		api: {
			type: "native",
			url: "",
			settings: {}
		},
		request: {
			headers: {},
			body: {}
		}
	}));
}
//#endregion
//#region src/bridge/convert/question.ts
function toQuestionInfo(item) {
	return {
		question: item.question,
		header: item.header ?? "",
		options: (item.options ?? []).map((option) => ({
			label: option.label,
			description: option.description ?? ""
		})),
		...item.multiSelect === void 0 ? {} : { multiple: item.multiSelect }
	};
}
/** The 1.18.18 question projection the SSE stream still publishes. */
function toQuestionRequest(entry) {
	return {
		id: entry.opencodeId,
		sessionID: entry.sessionId,
		questions: entry.items.map(toQuestionInfo)
	};
}
/** v2 `/api/session/{id}/question` shape. */
function toQuestionV2(entry) {
	return {
		id: entry.opencodeId,
		sessionID: entry.sessionId,
		questions: entry.items.map(toQuestionInfo)
	};
}
/**
* The OpenCode 2.x form of a dsh question batch. 2.x replaced the question
* tool with typed forms, so every dsh question becomes one multi-select field
* (a single-select question keeps `maxItems: 1`).
*/
function toFormInfo(entry) {
	const first = entry.items[0];
	return {
		id: entry.opencodeId,
		sessionID: entry.sessionId,
		title: first?.header || first?.question || "Question",
		fields: entry.items.map((item) => ({
			key: item.id,
			title: item.question,
			type: "multiselect",
			options: (item.options ?? []).map((option) => ({
				value: option.label,
				label: option.label
			})),
			...item.multiSelect === true ? {} : { maxItems: 1 }
		}))
	};
}
/** The OpenCode 2.x answer of a dsh question batch, keyed by question id. */
function toFormAnswer(entry, answers) {
	const answer = {};
	entry.items.forEach((item, index) => {
		answer[item.id] = answers?.[index] ?? [];
	});
	return answer;
}
/**
* Map opencode answers (labels in question order) back to dsh answer items.
* dsh asks one batch; opencode answers each question positionally.
*/
function answersToDsh(entry, answers) {
	return entry.items.map((item, index) => {
		const selected = answers[index] ?? [];
		return {
			id: item.id,
			selected
		};
	});
}
//#endregion
//#region src/bridge/convert/tool.ts
function record(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	return value;
}
function stringValue(value) {
	return typeof value === "string" ? value : void 0;
}
function callView(view) {
	if (view?.for !== "call") return void 0;
	return view.view;
}
function resultView(view) {
	if (view?.for !== "result") return void 0;
	return view.view;
}
function argsRecord(raw) {
	return safeJsonParse(raw);
}
function pathFromArgs(args) {
	return stringValue(args.file_path) ?? stringValue(args.path);
}
/** Recognize dsh's delegation tool family, including configured variants. */
function isSubagentToolName(name) {
	return name === "subagent" || name.startsWith("subagent_");
}
/**
* OpenCode calls this field `subagent_type`; dsh binds the provider into the
* tool name instead. Keep a deterministic display value until a child summary
* supplies a more specific agent preset.
*/
function subagentTypeFromToolName(name) {
	if (name === "subagent") return "spawn";
	if (name.startsWith("subagent_") && name.length > 9) return name.slice(9);
	return "subagent";
}
/**
* Map a dsh tool name to the opencode tool semantic used by the TUI.
* `str_replace_editor view` is a read card; every mutation command becomes
* the native edit card.
*/
function opencodeToolName(name, args) {
	if (isSubagentToolName(name)) return "task";
	switch (name) {
		case "bash":
		case "bash-persistent": return "bash";
		case "pwsh":
		case "powershell": return "powershell";
		case "read":
		case "fs-read":
		case "read_image": return "read";
		case "write":
		case "fs-write": return "edit";
		case "edit":
		case "fs-edit": return "edit";
		case "str_replace_editor": return args.command === "view" ? "read" : "edit";
		default: return name;
	}
}
function normalizedInput(name, args) {
	const input = { ...args };
	if (isSubagentToolName(name)) {
		if (typeof args.description !== "string") input.description = name;
		if (typeof args.prompt !== "string") input.prompt = "";
		if (typeof args.subagent_type !== "string" || args.subagent_type.trim() === "") input.subagent_type = subagentTypeFromToolName(name);
		return input;
	}
	if (name === "read" || name === "fs-read" || name === "read_image") {
		if (typeof args.file_path === "string") input.filePath = args.file_path;
		return input;
	}
	if (name === "write" || name === "fs-write" || name === "edit" || name === "fs-edit") {
		if (typeof args.file_path === "string") input.filePath = args.file_path;
		if (name === "edit" || name === "fs-edit") {
			if (typeof args.old_string === "string") input.oldString = args.old_string;
			if (typeof args.new_string === "string") input.newString = args.new_string;
			if (typeof args.replace_all === "boolean") input.replaceAll = args.replace_all;
		}
		return input;
	}
	if (name === "str_replace_editor") {
		if (typeof args.path === "string") input.filePath = args.path;
		if (typeof args.old_str === "string") input.oldString = args.old_str;
		if (typeof args.new_str === "string") input.newString = args.new_str;
		if (typeof args.insert_line === "number") input.insertLine = args.insert_line;
		if (typeof args.file_text === "string") input.content = args.file_text;
		return input;
	}
	return input;
}
/** OpenCode-facing input shape, including stable Task fields for dsh calls. */
function normalizedToolInput(name, args) {
	return normalizedInput(name, args);
}
function titleFromCall(name, args, view) {
	const present = callView(view);
	if (present?.title) return present.title;
	if (isSubagentToolName(name)) return stringValue(args.description) ?? `${subagentTypeFromToolName(name)} task`;
	const path = pathFromArgs(args);
	switch (name) {
		case "bash":
		case "bash-persistent": return stringValue(args.command) ?? name;
		case "read":
		case "fs-read":
		case "read_image": return `Read ${path ?? ""}`.trim();
		case "write":
		case "fs-write": return `Write ${path ?? ""}`.trim();
		case "edit":
		case "fs-edit": return `Edit ${path ?? ""}`.trim();
		case "str_replace_editor": return `${stringValue(args.command) ?? name} ${path ?? ""}`.trim();
		default: return `${name} ${path ?? ""}`.trim();
	}
}
function diffListFromCall(view) {
	const present = callView(view);
	if (present?.card !== "diff" || !Array.isArray(present.diffs)) return [];
	return present.diffs.flatMap((raw) => {
		const diff = record(raw);
		if (!diff) return [];
		return [{
			path: stringValue(diff.path),
			oldText: diff.oldText === null ? null : stringValue(diff.oldText),
			newText: stringValue(diff.newText)
		}];
	});
}
function diffListFromResult(view) {
	const present = resultView(view);
	if (present?.card !== "diff" || !Array.isArray(present.diffs)) return [];
	return present.diffs.flatMap((raw) => {
		const diff = record(raw);
		if (!diff) return [];
		return [{
			path: stringValue(diff.path),
			oldText: diff.oldText === null ? null : stringValue(diff.oldText),
			newText: stringValue(diff.newText)
		}];
	});
}
function diffListFromMeta(meta) {
	const raw = record(meta)?.diffs;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry) => {
		const diff = record(entry);
		if (!diff) return [];
		return [{
			path: stringValue(diff.path),
			oldText: diff.oldText === null ? null : stringValue(diff.oldText),
			newText: stringValue(diff.newText)
		}];
	});
}
function countPatch(patch) {
	let additions = 0;
	let deletions = 0;
	for (const line of patch.split("\n")) if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
	else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
	return {
		additions,
		deletions
	};
}
function relativePath(file) {
	return file.replace(/\\/g, "/").replace(/^\/+/, "");
}
/**
* Build a compact unified diff from dsh's oldText/newText presenter hunks.
* This is intentionally small: dsh already supplies the hunk-level texts and
* the TUI only needs a valid `---/+++` patch to render.
*/
function unifiedDiffForFile(file, oldText, newText) {
	const oldLines = (oldText ?? "").split("\n");
	const newLines = (newText ?? "").split("\n");
	if (oldLines.join("\n") === newLines.join("\n")) return "";
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
	const removedCount = removed.length;
	const addedCount = added.length;
	const oldStart = removedCount === 0 ? start : start + 1;
	const newStart = addedCount === 0 ? start : start + 1;
	const header = `@@ -${oldStart}${removedCount === 0 ? "" : `,${removedCount}`} +${newStart}${addedCount === 0 ? "" : `,${addedCount}`} @@`;
	const body = [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)];
	return [
		`--- a/${relativePath(file)}`,
		`+++ b/${relativePath(file)}`,
		header,
		...body
	].join("\n") + (body.length > 0 ? "\n" : "");
}
function statusForDiffs(diffs) {
	const allOldNull = diffs.every((diff) => diff.oldText === null || diff.oldText === "");
	const allNewEmpty = diffs.every((diff) => diff.newText === void 0 || diff.newText === "");
	if (allOldNull) return "added";
	if (allNewEmpty) return "deleted";
	return "modified";
}
function insertDiffFromArgs(args) {
	const path = pathFromArgs(args);
	if (!path || args.command !== "insert" && args.command !== "create") return [];
	return [{
		path,
		oldText: "",
		newText: args.command === "insert" ? stringValue(args.new_str) ?? "" : stringValue(args.file_text) ?? stringValue(args.content) ?? ""
	}];
}
/**
* Conservative fallback for shell commands that clearly write to a file.
* dsh does not persist a diff for bash results, so redirection targets are
* surfaced as best-effort file changes until a produced-files projection is
* available.
*/
function bashFileChangesFromArgs(args) {
	const command = stringValue(args.command);
	if (!command) return [];
	const paths = /* @__PURE__ */ new Set();
	for (const match of command.matchAll(/(?:>>|>)\s*["']?([^"'\s;&|]+)["']?/g)) {
		const path = match[1];
		if (path) paths.add(path.replace(/^["']|["']$/g, ""));
	}
	for (const match of command.matchAll(/(?:^|[;&|]\s*)tee\s+["']?([^"'\s;&|]+)["']?/g)) {
		const path = match[1];
		if (path) paths.add(path.replace(/^["']|["']$/g, ""));
	}
	return [...paths].map((file) => ({
		file,
		additions: 0,
		deletions: 0,
		status: "modified"
	}));
}
/**
* Extract opencode file changes from a completed dsh tool. The source of
* truth is result `meta` when the tool persisted contextual diffs (write/edit
* in dsh-tool-fs), then the live/replayed presenter result view, then the
* call-time diff card. `str_replace_editor insert` synthesizes an
* addition-only hunk from its arguments.
*/
function fileChangesFromToolResult(call, result) {
	const args = argsRecord(call.arguments);
	const metaDiffs = diffListFromMeta(result.meta);
	const resultDiffs = diffListFromResult(result.view);
	const callDiffs = diffListFromCall(result.callView ?? call.view);
	const diffs = metaDiffs.length > 0 ? metaDiffs : resultDiffs.length > 0 ? resultDiffs : callDiffs;
	if (diffs.length === 0 && call.name === "str_replace_editor") diffs.push(...insertDiffFromArgs(args));
	if (diffs.length === 0 && (call.name === "write" || call.name === "fs-write")) {
		const filePath = stringValue(args.file_path) ?? stringValue(args.filePath);
		const content = stringValue(args.content);
		if (filePath !== void 0 && content !== void 0) diffs.push({
			path: filePath,
			oldText: null,
			newText: content
		});
	}
	if (diffs.length === 0 && (call.name === "edit" || call.name === "fs-edit")) {
		const filePath = stringValue(args.file_path) ?? stringValue(args.filePath);
		if (filePath !== void 0) diffs.push({
			path: filePath,
			oldText: stringValue(args.old_string) ?? stringValue(args.oldString) ?? "",
			newText: stringValue(args.new_string) ?? stringValue(args.newString) ?? ""
		});
	}
	if (diffs.length === 0 && call.name === "bash") return bashFileChangesFromArgs(args);
	if (diffs.length === 0) return [];
	const byPath = /* @__PURE__ */ new Map();
	const fallbackPath = pathFromArgs(args);
	for (const diff of diffs) {
		const path = diff.path ?? fallbackPath;
		if (!path) continue;
		const list = byPath.get(path) ?? [];
		list.push(diff);
		byPath.set(path, list);
	}
	const changes = [];
	for (const [file, fileDiffs] of byPath) {
		const patch = fileDiffs.map((diff) => unifiedDiffForFile(file, diff.oldText ?? "", diff.newText ?? "")).filter(Boolean).join("\n");
		const { additions, deletions } = countPatch(patch);
		changes.push({
			file,
			...patch ? { patch } : {},
			additions,
			deletions,
			status: statusForDiffs(fileDiffs)
		});
	}
	return changes;
}
function descriptionForStrReplace(args) {
	const command = stringValue(args.command);
	const path = pathFromArgs(args);
	if (!command) return void 0;
	const label = {
		view: "View file",
		create: "Create file",
		str_replace: "Replace text in file",
		insert: "Insert lines into file",
		undo_edit: "Undo last edit to file"
	}[command];
	return label === void 0 ? void 0 : `${label} ${path ?? ""}`.trim();
}
function completedMetadata(call, result, tool, input) {
	const metadata = {};
	if (result.meta !== void 0) metadata.meta = result.meta;
	if (call.subagent !== void 0) {
		if (call.subagent.sessionId !== void 0) metadata.sessionId = call.subagent.sessionId;
		if (call.subagent.parentSessionId !== void 0) metadata.parentSessionId = call.subagent.parentSessionId;
		if (call.subagent.mode !== void 0) metadata.mode = call.subagent.mode;
		if (call.subagent.background !== void 0) metadata.background = call.subagent.background;
	}
	if (tool === "bash") {
		const present = resultView(result.view);
		if (present?.card === "terminal") {
			if (present.output !== void 0) metadata.output = present.output;
			if (present.exitCode !== void 0) metadata.exit = present.exitCode;
			if (present.signal !== void 0) metadata.signal = present.signal;
		} else metadata.output = resultText(result.content);
	}
	if (tool === "read") {
		const loaded = stringValue(record(result.meta)?.path) ?? stringValue(input.filePath);
		if (loaded) metadata.loaded = [loaded];
	}
	if (tool === "edit") {
		const changes = fileChangesFromToolResult(call, result);
		if (changes.length > 0) {
			metadata.files = changes.map((change) => change.file);
			metadata.filediff = changes[0];
			if (changes[0]?.patch) metadata.diff = changes[0].patch;
		}
	}
	if (call.name === "str_replace_editor") {
		metadata.command = stringValue(input.command) ?? "";
		metadata.mode = stringValue(input.command) ?? "";
		const description = descriptionForStrReplace(input);
		if (description) metadata.description = description;
	}
	return metadata;
}
function resultText(content) {
	return textFromBlocks(content);
}
/** Model-facing result text for one tool/result event (used by v2 events). */
function toolResultText(result) {
	return resultText(result.content);
}
/**
* Structured v2 progress payload derived from the dsh result view: terminal
* cards carry output/exitCode/signal; everything else is folded into a
* generic `output` field when content exists.
*/
function toolResultStructured(result) {
	const present = resultView(result.view);
	if (present?.card === "terminal") return {
		...present.output === void 0 ? {} : { output: present.output },
		...present.exitCode === void 0 ? {} : { exitCode: present.exitCode },
		...present.signal === void 0 ? {} : { signal: present.signal }
	};
	const text = resultText(result.content);
	return text.length > 0 ? { output: text } : {};
}
/** Convert attached delegation facts to OpenCode's Task metadata shape. */
function subagentMetadataForCall(call) {
	if (!isSubagentToolName(call.name) || call.subagent === void 0) return {};
	return {
		...call.subagent.sessionId === void 0 ? {} : { sessionId: call.subagent.sessionId },
		...call.subagent.parentSessionId === void 0 ? {} : { parentSessionId: call.subagent.parentSessionId },
		...call.subagent.mode === void 0 ? {} : { mode: call.subagent.mode },
		...call.subagent.background === void 0 ? {} : { background: call.subagent.background }
	};
}
/** A `tool/call` event alone becomes a pending ToolPart. */
function pendingToolPart(call, options) {
	const input = safeJsonParse(call.arguments);
	const tool = opencodeToolName(call.name, input);
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool,
		state: {
			status: "pending",
			input: normalizedInput(call.name, input),
			raw: call.arguments
		},
		metadata: { start: options.time }
	};
}
/**
* A partially-streamed tool call becomes a pending ToolPart whose `raw`
* input grows with every tool-call delta. The TUI upserts by part id, so
* repeated updates progressively reveal the command/arguments.
*/
function streamingToolPart(call, options) {
	const input = safeJsonParse(call.arguments ?? "");
	const name = call.name ?? "tool";
	const tool = opencodeToolName(name, input);
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool,
		state: {
			status: "pending",
			input: normalizedInput(name, input),
			raw: call.arguments ?? ""
		},
		metadata: { start: options.time }
	};
}
/** Placeholder for an in-flight call (dsh does not emit this state today). */
function runningToolPart(call, options) {
	const input = safeJsonParse(call.arguments);
	const tool = opencodeToolName(call.name, input);
	const metadata = subagentMetadataForCall(call);
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool,
		state: {
			status: "running",
			input: normalizedInput(call.name, input),
			title: titleFromCall(call.name, input, call.view),
			...Object.keys(metadata).length === 0 ? {} : { metadata },
			time: { start: options.time }
		}
	};
}
/** A `tool/result` success event becomes a completed ToolPart. */
function completedToolPart(call, result, options) {
	const input = safeJsonParse(call.arguments);
	const tool = opencodeToolName(call.name, input);
	const metadata = completedMetadata(call, result, tool, input);
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool,
		state: {
			status: "completed",
			input: normalizedInput(call.name, input),
			output: resultText(result.content),
			title: titleFromCall(call.name, input, call.view),
			metadata,
			time: {
				start: options.time,
				end: result.time
			}
		}
	};
}
/** A `tool/result` with an error becomes an error ToolPart. */
function errorToolPart(call, result, options) {
	const input = safeJsonParse(call.arguments);
	const tool = opencodeToolName(call.name, input);
	const message = result.error?.name ?? result.error?.code ?? "tool failed";
	const metadata = subagentMetadataForCall(call);
	const output = resultText(result.content);
	if (output.length > 0) metadata.output = output;
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool,
		state: {
			status: "error",
			input: normalizedInput(call.name, input),
			error: message,
			...Object.keys(metadata).length === 0 ? {} : { metadata },
			time: {
				start: options.time,
				end: result.time
			}
		}
	};
}
//#endregion
//#region src/bridge/convert/todo.ts
const PRIORITY = /* @__PURE__ */ new Set([
	"high",
	"medium",
	"low"
]);
/**
* Convert dsh todo projection/`todo/write` items into opencode `Todo[]`.
* dsh items carry no id or priority, so both get stable defaults.
*/
function convertTodos(value) {
	if (!Array.isArray(value)) return [];
	const todos = [];
	for (const raw of value) {
		if (raw === null || typeof raw !== "object") continue;
		const item = raw;
		if (typeof item.content !== "string") continue;
		const status = item.status === "pending" || item.status === "in_progress" || item.status === "completed" ? item.status : "pending";
		const priority = typeof item.priority === "string" && PRIORITY.has(item.priority) ? item.priority : "medium";
		todos.push({
			content: item.content,
			status,
			priority,
			id: typeof item.id === "string" ? item.id : stableId(`${item.content}\0${status}`)
		});
	}
	return todos;
}
//#endregion
//#region src/bridge/convert/goal.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Narrow the dsh goal vocabulary to the fields the bridge renders. Both the
* `goal` projection (`{ goal: GoalSnapshot, ... }`) and the raw snapshot on
* `goal/change` events are accepted so history folds and live mux frames
* share one converter.
*/
function goalSnapshotFrom(value) {
	if (!isRecord(value)) return void 0;
	if (isRecord(value.goal)) return value.goal;
	if (typeof value.objective === "string" || typeof value.phase === "string") return value;
}
/** Map a durable goal phase onto the opencode todo status vocabulary. */
function goalPhaseStatus(phase) {
	if (phase === "active") return "in_progress";
	if (phase === "paused" || phase === "blocked") return "pending";
	if (phase === "complete") return "completed";
}
/**
* Convert one goal snapshot/projection into the opencode todo shown first in
* the sidebar. Returns `undefined` when the value carries no renderable goal.
*/
function goalTodo(value) {
	const snapshot = goalSnapshotFrom(value);
	if (snapshot === void 0) return void 0;
	const objective = typeof snapshot.objective === "string" ? snapshot.objective.trim() : "";
	if (objective.length === 0) return void 0;
	const status = goalPhaseStatus(snapshot.phase);
	if (status === void 0) return void 0;
	return {
		id: `goal:${typeof snapshot.id === "string" && snapshot.id.length > 0 ? snapshot.id : stableId(`${objective}\0${String(snapshot.phase)}`)}`,
		content: `Goal: ${objective}`,
		status,
		priority: "high"
	};
}
/**
* Merge the current goal (first) with dsh todo items. The goal is additive:
* it never replaces or hides the todo projection.
*/
function convertGoalTodos(goalValue, todosValue) {
	const goal = goalTodo(goalValue);
	return [...goal === void 0 ? [] : [goal], ...convertTodos(todosValue)];
}
/**
* One-line human summary of a `goal/change` event for the history/message
* surface. Returns `undefined` for values that are not goal changes.
*/
function goalChangeText(value) {
	if (!isRecord(value)) return void 0;
	if (value.operation === "clear") return "Goal cleared";
	const snapshot = goalSnapshotFrom(value);
	if (snapshot === void 0) return void 0;
	const objective = typeof snapshot.objective === "string" ? snapshot.objective.trim() : "";
	if (objective.length === 0) return void 0;
	switch (value.operation) {
		case "create": return `Goal created: ${objective}`;
		case "edit": return `Goal updated: ${objective}`;
		case "pause": return `Goal paused: ${objective}`;
		case "resume": return `Goal resumed: ${objective}`;
		case "complete": return `Goal completed: ${objective}`;
		case "block": {
			const reason = snapshot.blockedReason;
			const reasonRecord = isRecord(reason) ? reason : void 0;
			const code = typeof reasonRecord?.code === "string" ? reasonRecord.code : "unknown";
			const message = typeof reasonRecord?.message === "string" ? reasonRecord.message : "";
			return `Goal blocked: ${objective} (${code}${message.length === 0 ? "" : `: ${message}`})`;
		}
		default: return;
	}
}
//#endregion
//#region src/bridge/convert/message.ts
/**
* Read the exact block timing and finish reason back out of a dsh 0.1.5
* embedded Assistant stream. History rows only preserve the packed delta runs
* (`expandRecord`), so the raw `block-start` / `block-end` / `finish` chunks
* inside the settlement event are the authoritative source for part durations
* on a cold read.
*/
function assistantStreamTiming(stream, turn, step) {
	const starts = [];
	const ends = [];
	if (!Array.isArray(stream)) return {
		starts,
		ends,
		finish: void 0
	};
	let finish;
	for (const record of stream) {
		if (record.type === "chunk") {
			const chunk = record.chunk;
			if (chunk.type === "block-start") starts.push([`${turn}:${step}:${chunk.index}:${chunk.blockType}`, record.time]);
			else if (chunk.type === "block-end") ends.push([`${turn}:${step}:${chunk.index}:${chunk.block.type}`, record.time]);
			else if (chunk.type === "finish") finish = chunk.reason.kind;
			continue;
		}
		const blockType = record.type === "text-chunks" ? "text" : record.type === "reasoning-chunks" ? "reasoning" : "tool-call";
		let elapsed = 0;
		for (const gap of record.dt) if (typeof gap === "number") elapsed += gap;
		starts.push([`${turn}:${step}:${record.index}:${blockType}`, record.time0]);
		ends.push([`${turn}:${step}:${record.index}:${blockType}`, record.time0 + elapsed]);
	}
	return {
		starts,
		ends,
		finish
	};
}
/** Dsh checkpoint rows written by compaction have a plugin `compact` source. */
function isCompactCheckpoint(event) {
	const source = event.data.source;
	return source?.kind === "plugin" && source.plugin === "compact";
}
/** Manual `/compact` records a sourceCommandId; automatic compaction omits it. */
function isAutoCompactCheckpoint(event) {
	return event.data.source?.sourceCommandId === void 0;
}
function compactionPart(messageId, opts, auto) {
	return {
		id: `${messageId}:compaction`,
		sessionID: opts.sessionId,
		messageID: messageId,
		type: "compaction",
		auto
	};
}
const ZERO_TOKENS = {
	input: 0,
	output: 0,
	reasoning: 0,
	cache: {
		read: 0,
		write: 0
	}
};
function usageTokens(usage) {
	if (!usage) return ZERO_TOKENS;
	return {
		input: usage.inputTokens,
		output: usage.outputTokens,
		reasoning: usage.reasoningTokens ?? 0,
		cache: {
			read: usage.cacheReadTokens ?? 0,
			write: usage.cacheWriteTokens ?? 0
		}
	};
}
function userMessageInfo(id, time, opts) {
	const selected = opts.defaultModel ?? {
		providerID: "deepseek",
		modelID: "deepseek-chat"
	};
	const model = {
		providerID: selected.providerID,
		modelID: selected.modelID,
		...selected.variant === void 0 ? {} : { variant: selected.variant }
	};
	return {
		id,
		sessionID: opts.sessionId,
		role: "user",
		time: { created: time },
		agent: DEFAULT_AGENT,
		model
	};
}
function assistantMessageInfo(message, time, parentID, opts, usage, created, finish) {
	return {
		id: String(message.id),
		sessionID: opts.sessionId,
		role: "assistant",
		time: {
			created: created ?? time,
			completed: time
		},
		parentID,
		agent: DEFAULT_AGENT,
		modelID: message.source.model,
		providerID: externalProviderId(message.source.provider),
		mode: DEFAULT_AGENT,
		path: {
			cwd: opts.cwd,
			root: opts.cwd
		},
		cost: 0,
		tokens: usageTokens(usage),
		...finish === void 0 ? {} : { finish }
	};
}
function textPart(id, messageID, text, time, opts) {
	return {
		id,
		sessionID: opts.sessionId,
		messageID,
		type: "text",
		text,
		time: {
			start: time.start,
			...time.end === void 0 ? {} : { end: time.end }
		}
	};
}
/** Build the SSE text/reasoning/tool parts for one assistant message. */
function assistantPartsFromMessage(message, time, opts, blockStart, blockEnd, partIdFor) {
	const parts = [];
	const calls = /* @__PURE__ */ new Map();
	const messageID = String(message.id);
	message.content.forEach((block, index) => {
		const start = blockStart?.(index, block.type) ?? time;
		if (block.type === "text") parts.push(textPart(partIdFor?.(index, block.type) ?? `${messageID}:${index}`, messageID, block.text, {
			start,
			end: time
		}, opts));
		else if (block.type === "reasoning") parts.push({
			id: partIdFor?.(index, block.type) ?? `${messageID}:${index}`,
			sessionID: opts.sessionId,
			messageID,
			type: "reasoning",
			text: block.text,
			time: {
				start,
				end: blockEnd?.(index, "reasoning") ?? time
			}
		});
		else if (block.type === "tool-call") {
			let call = {
				callId: String(block.id),
				name: block.name,
				arguments: block.arguments
			};
			const subagent = opts.subagentForCall?.(call);
			if (subagent !== void 0) call = {
				...call,
				subagent
			};
			calls.set(call.callId, call);
			parts.push(pendingToolPart(call, {
				sessionID: opts.sessionId,
				messageID,
				time
			}));
		} else opts.onSkip?.("assistant/message", `unhandled content block "${String(block.type)}"`);
	});
	return {
		parts,
		calls
	};
}
function userPartsFromMessage(messageId, content, time, opts) {
	const parts = [];
	content.forEach((block, index) => {
		if (block.type === "text") parts.push(textPart(`${messageId}:${index}`, messageId, block.text, {
			start: time,
			end: time
		}, opts));
		else if (block.type === "image") opts.onSkip?.("user/message", `image block skipped (${String(block.attachment.mediaType ?? "unknown")})`);
		else opts.onSkip?.("user/message", `unhandled content block "${String(block.type)}"`);
	});
	return parts;
}
function earliestBlockStart$1(blockStarts, turn, step) {
	let earliest;
	for (const [key, value] of blockStarts) {
		const [keyTurn, keyStep] = key.split(":");
		if (Number(keyTurn) === turn && Number(keyStep) === step) {
			if (earliest === void 0 || value < earliest) earliest = value;
		}
	}
	return earliest;
}
function accumulateStreamBlock(blocksByStep, turn, step, index, blockType, text, start) {
	const stepKey = `${turn}:${step}`;
	let blocks = blocksByStep.get(stepKey);
	if (!blocks) {
		blocks = /* @__PURE__ */ new Map();
		blocksByStep.set(stepKey, blocks);
	}
	const blockKey = `${index}:${blockType}`;
	const existing = blocks.get(blockKey);
	if (existing) existing.text += text;
	else blocks.set(blockKey, {
		blockType,
		start,
		text
	});
}
/** Single-event conversion used by the SSE bridge. */
function userMessageFromEvent(event, opts) {
	const id = String(event.data.id);
	return {
		info: userMessageInfo(id, event.time, opts),
		parts: isCompactCheckpoint(event) ? [compactionPart(id, opts, isAutoCompactCheckpoint(event))] : userPartsFromMessage(id, event.data.content, event.time, opts)
	};
}
/** Single-event conversion used by the SSE bridge. */
function assistantMessageFromEvent(event, opts, blockStart, blockEnd, created, parentID, finish, partIdFor) {
	const id = String(event.data.message.id);
	const effectivePartIdFor = partIdFor ?? ((index, blockType) => provisionalPartId(opts.sessionId, event.data.turn, event.data.step, blockType, index));
	const { parts } = assistantPartsFromMessage(event.data.message, event.time, opts, blockStart, blockEnd, effectivePartIdFor);
	return {
		info: assistantMessageInfo(event.data.message, event.time, parentID ?? id, opts, event.data.usage, created, finish),
		parts
	};
}
function partialV2Assistant(id, created, opts) {
	const model = opts.defaultModel ?? {
		providerID: "deepseek",
		modelID: "deepseek-chat"
	};
	return {
		id,
		time: { created },
		type: "assistant",
		agent: DEFAULT_AGENT,
		model: {
			id: model.modelID,
			providerID: model.providerID
		},
		content: [],
		cost: 0,
		tokens: ZERO_TOKENS
	};
}
function v2StreamPart(block, partId) {
	if (block.blockType === "text") return {
		type: "text",
		id: partId,
		text: block.text
	};
	return {
		type: "reasoning",
		id: partId,
		text: block.text,
		time: { created: block.start }
	};
}
function upsertPartialV2(messages, pending, blocksByStep, pendingCallsByStep, opts, turn, step, created, seq, pushFn) {
	const stepKey = `${turn}:${step}`;
	let info = pending.get(stepKey);
	if (!info) {
		info = partialV2Assistant(provisionalMessageId(opts.sessionId, turn, step), created, opts);
		pending.set(stepKey, info);
		if (pushFn === void 0) messages.push(info);
		else pushFn(info, seq);
	}
	const blocks = blocksByStep.get(stepKey);
	if (blocks) for (const [blockKey, block] of blocks) {
		const blockIndex = Number(blockKey.slice(0, blockKey.indexOf(":")));
		const partId = provisionalPartId(opts.sessionId, turn, step, block.blockType, blockIndex);
		const replacement = v2StreamPart(block, partId);
		const partIndex = info.content.findIndex((part) => part.id === partId);
		if (partIndex === -1) info.content.push(replacement);
		else info.content[partIndex] = replacement;
	}
	const calls = pendingCallsByStep.get(stepKey) ?? /* @__PURE__ */ new Map();
	for (const call of calls.values()) if (!info.content.some((part) => part.type === "tool" && part.id === `tool:${call.callId}`)) {
		const tool = {
			type: "tool",
			id: `tool:${call.callId}`,
			name: opencodeToolName(call.name, safeJsonParse(call.arguments)),
			state: {
				status: "streaming",
				input: call.arguments
			},
			time: { created }
		};
		info.content.push(tool);
	}
	return {
		info,
		calls
	};
}
function toV2ModelRef(message) {
	return {
		id: message.source.model,
		providerID: externalProviderId(message.source.provider)
	};
}
function toV2Assistant(event, opts, created, blockStart) {
	const data = event.data;
	const messageID = String(data.message.id);
	const content = [];
	const calls = /* @__PURE__ */ new Map();
	data.message.content.forEach((block, index) => {
		if (block.type === "text") {
			const part = {
				type: "text",
				id: provisionalPartId(opts.sessionId, data.turn, data.step, "text", index),
				text: block.text
			};
			content.push(part);
		} else if (block.type === "reasoning") {
			const start = blockStart?.(index, block.type) ?? event.time;
			content.push({
				type: "reasoning",
				id: provisionalPartId(opts.sessionId, data.turn, data.step, "reasoning", index),
				text: block.text,
				time: {
					created: start,
					completed: event.time
				}
			});
		} else if (block.type === "tool-call") {
			let call = {
				callId: String(block.id),
				name: block.name,
				arguments: block.arguments
			};
			const subagent = opts.subagentForCall?.(call);
			if (subagent !== void 0) call = {
				...call,
				subagent
			};
			calls.set(call.callId, call);
			const tool = {
				type: "tool",
				id: `tool:${call.callId}`,
				name: opencodeToolName(call.name, safeJsonParse(call.arguments)),
				state: {
					status: "streaming",
					input: call.arguments
				},
				time: { created: event.time }
			};
			content.push(tool);
		} else opts.onSkip?.("assistant/message", `unhandled v2 block "${String(block.type)}"`);
	});
	return {
		info: {
			id: messageID,
			time: {
				created: created ?? event.time,
				completed: event.time
			},
			type: "assistant",
			agent: DEFAULT_AGENT,
			model: toV2ModelRef(data.message),
			content,
			cost: 0,
			tokens: usageTokens(data.usage)
		},
		calls
	};
}
function applyToolResultV2(messages, state, calls, event, opts) {
	const data = event.data;
	const callId = String(data.message.toolCallId ?? data.message.source.callId);
	const call = calls.get(callId);
	if (!call || !state) {
		opts.onSkip?.("tool/result", `no matching v2 tool/call for "${callId}"`);
		return;
	}
	const blocks = data.message.content;
	const text = textFromBlocks(blocks);
	const content = [{
		type: "text",
		text
	}];
	const tool = state.info.content.find((part) => part.type === "tool" && part.id === `tool:${callId}`);
	if (!tool) {
		opts.onSkip?.("tool/result", `no v2 tool part for "${callId}"`);
		return;
	}
	const metadata = subagentMetadataForCall(call);
	if (data.error !== void 0) tool.state = {
		status: "error",
		input: normalizedToolInput(call.name, safeJsonParse(call.arguments)),
		...text.length > 0 ? { content: [{
			type: "text",
			text
		}] } : {},
		metadata,
		error: {
			type: "unknown",
			message: data.error.name ?? data.error.code ?? "tool failed"
		}
	};
	else tool.state = {
		status: "completed",
		input: normalizedToolInput(call.name, safeJsonParse(call.arguments)),
		content,
		metadata
	};
	tool.time = {
		...tool.time,
		completed: event.time
	};
}
/** Fold dsh history events into the v2 `SessionMessage[]` list. */
function convertMessagesV2(events, opts, views, anchorSeqs) {
	const messages = [];
	const pushMessage = (message, seq) => {
		messages.push(message);
		anchorSeqs?.push(seq);
	};
	const spliceMessage = (index) => {
		messages.splice(index, 1);
		anchorSeqs?.splice(index, 1);
	};
	const calls = /* @__PURE__ */ new Map();
	const blockStarts = /* @__PURE__ */ new Map();
	const turnStarts = /* @__PURE__ */ new Map();
	const finishReasons = /* @__PURE__ */ new Map();
	const blocksByStep = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	const pendingCallsByStep = /* @__PURE__ */ new Map();
	let lastAssistant;
	let lastUserMessageTime;
	const assistantCreatedAt = (turn, step, fallback) => Math.max(earliestBlockStart$1(blockStarts, turn, step) ?? turnStarts.get(turn) ?? fallback, lastUserMessageTime === void 0 ? Number.MIN_SAFE_INTEGER : lastUserMessageTime + 1);
	for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
		const event = events[eventIndex];
		const view = views?.[eventIndex];
		switch (event.type) {
			case "turn/start":
				turnStarts.set(event.data.turn, event.time);
				break;
			case "user/message": {
				const data = event.data;
				const compact = isCompactCheckpoint(event);
				if (data.source?.kind !== "user" && !compact) break;
				const model = opts.defaultModel ?? {
					providerID: "deepseek",
					modelID: "deepseek-chat"
				};
				pushMessage({
					id: String(data.id),
					time: { created: event.time },
					text: compact ? "" : textFromBlocks(data.content),
					type: "user",
					model: {
						id: model.modelID,
						providerID: model.providerID,
						...model.variant === void 0 ? {} : { variant: model.variant }
					}
				}, event.seq);
				lastUserMessageTime = event.time;
				break;
			}
			case "text-chunks":
			case "reasoning-chunks": {
				const chunk = event;
				const blockType = chunk.type === "text-chunks" ? "text" : "reasoning";
				const key = `${chunk.data.turn}:${chunk.data.step}:${chunk.data.index}:${blockType}`;
				const time0 = chunk.time0 ?? chunk.time;
				if (!blockStarts.has(key)) blockStarts.set(key, time0);
				const start = blockStarts.get(key) ?? time0;
				accumulateStreamBlock(blocksByStep, chunk.data.turn, chunk.data.step, chunk.data.index, blockType, chunk.data.texts.join(""), start);
				lastAssistant = upsertPartialV2(messages, pending, blocksByStep, pendingCallsByStep, opts, chunk.data.turn, chunk.data.step, assistantCreatedAt(chunk.data.turn, chunk.data.step, time0), chunk.seq, (message, seq) => pushMessage(message, seq));
				break;
			}
			case "assistant/message": {
				const data = event.data;
				const stepKey = `${data.turn}:${data.step}`;
				const timing = assistantStreamTiming(data.stream, data.turn, data.step);
				for (const [key, time] of timing.starts) blockStarts.set(key, time);
				if (timing.finish !== void 0) finishReasons.set(stepKey, timing.finish);
				const state = toV2Assistant(event, opts, assistantCreatedAt(data.turn, data.step, event.time), (index, blockType) => blockStarts.get(`${data.turn}:${data.step}:${index}:${blockType}`));
				const pendingMessage = pending.get(stepKey);
				const pendingIndex = pendingMessage === void 0 ? -1 : messages.findIndex((message) => message.id === pendingMessage.id);
				pushMessage(state.info, event.seq);
				if (pendingIndex !== -1) spliceMessage(pendingIndex);
				pending.delete(stepKey);
				pendingCallsByStep.delete(stepKey);
				for (const [callId, call] of state.calls) calls.set(callId, call);
				lastAssistant = state;
				break;
			}
			case "tool/call": {
				const data = event.data;
				let call = {
					callId: String(data.callId),
					name: data.name,
					arguments: data.arguments,
					...view === void 0 ? {} : { view }
				};
				const subagent = opts.subagentForCall?.(call);
				if (subagent !== void 0) call = {
					...call,
					subagent
				};
				calls.set(call.callId, call);
				const stepKey = `${data.turn}:${data.step}`;
				let stepCalls = pendingCallsByStep.get(stepKey);
				if (!stepCalls) {
					stepCalls = /* @__PURE__ */ new Map();
					pendingCallsByStep.set(stepKey, stepCalls);
				}
				stepCalls.set(call.callId, call);
				const pendingMessage = pending.get(stepKey);
				if (pendingMessage && !pendingMessage.content.some((part) => part.type === "tool" && part.id === `tool:${call.callId}`)) pendingMessage.content.push({
					type: "tool",
					id: `tool:${call.callId}`,
					name: opencodeToolName(call.name, safeJsonParse(call.arguments)),
					state: {
						status: "streaming",
						input: call.arguments
					},
					time: { created: event.time }
				});
				if (pendingMessage) lastAssistant = {
					info: pendingMessage,
					calls: stepCalls
				};
				break;
			}
			case "tool/result":
				applyToolResultV2(messages, lastAssistant, calls, event, opts);
				break;
			default: if (event.type === "goal/change") {
				const text = goalChangeText(event.data);
				if (text !== void 0) {
					const id = `goal:${event.seq}`;
					const model = opts.defaultModel ?? {
						providerID: "deepseek",
						modelID: "deepseek-chat"
					};
					pushMessage({
						id,
						time: {
							created: event.time,
							completed: event.time
						},
						type: "assistant",
						agent: DEFAULT_AGENT,
						model: {
							id: model.modelID,
							providerID: model.providerID
						},
						content: [{
							type: "text",
							id: `${id}:note`,
							text
						}],
						cost: 0,
						tokens: ZERO_TOKENS
					}, event.seq);
				}
			}
		}
	}
	return messages;
}
//#endregion
//#region src/bridge/convert/permission.ts
/** Map a dsh tool name onto the opencode permission category. */
function permissionActionFromTool(toolName) {
	if (toolName === "bash" || toolName.endsWith(".bash") || toolName.endsWith("_bash")) return "bash";
	if (toolName === "edit" || toolName === "write" || toolName.endsWith(".edit") || toolName.includes("fs_")) return "edit";
	if (toolName === "read" || toolName.endsWith(".read")) return "read";
	if (toolName === "webfetch" || toolName.endsWith(".webfetch")) return "webfetch";
	if (toolName === "ask_user_question") return "unknown";
	return toolName;
}
/** Legacy `/permission` + `permission.asked` SSE shape. */
function toPermissionRequest(entry) {
	return {
		id: entry.opencodeId,
		sessionID: entry.sessionId,
		permission: permissionActionFromTool(entry.toolName),
		patterns: [],
		metadata: {
			toolName: entry.toolName,
			...entry.callId === void 0 ? {} : { callId: entry.callId },
			...entry.reason === void 0 ? {} : { reason: entry.reason }
		},
		always: [],
		...entry.callId === void 0 ? {} : { tool: {
			messageID: "",
			callID: entry.callId
		} }
	};
}
/** v2 `/api/session/{id}/permission` shape. */
function toPermissionV2(entry) {
	return {
		id: entry.opencodeId,
		sessionID: entry.sessionId,
		action: permissionActionFromTool(entry.toolName),
		resources: [],
		metadata: {
			toolName: entry.toolName,
			...entry.callId === void 0 ? {} : { callId: entry.callId },
			...entry.reason === void 0 ? {} : { reason: entry.reason }
		},
		...entry.callId === void 0 ? {} : { source: {
			type: "tool",
			messageID: "",
			callID: entry.callId
		} }
	};
}
//#endregion
//#region src/bridge/git.ts
/**
* Keep only diffs whose path is inside `cwd` and is tracked by git. Calls
* `git ls-files --error-unmatch` through an argv array so paths can never be
* interpreted as shell syntax.
*/
function filterGitTrackedDiffs(cwd, diffs) {
	const root = resolve(cwd);
	return diffs.filter((diff) => {
		if (diff.file === void 0 || diff.file === "") return false;
		const resolved = resolve(root, diff.file);
		const rel = relative(root, resolved);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
		return spawnSync("git", [
			"-C",
			root,
			"ls-files",
			"--error-unmatch",
			"--",
			rel
		], {
			stdio: [
				"ignore",
				"ignore",
				"pipe"
			],
			encoding: "utf8"
		}).status === 0;
	});
}
//#endregion
//#region src/bridge/events-util.ts
/**
* Durable sequence counters, one per aggregate (the session id). OpenCode 2.x
* numbers the events of a session, so the sequence has to advance per session
* rather than per process.
*/
const durableSeqByAggregate = /* @__PURE__ */ new Map();
/** The next durable sequence number of one aggregate. */
function nextDurableSeq(aggregateID) {
	const next = (durableSeqByAggregate.get(aggregateID) ?? 0) + 1;
	durableSeqByAggregate.set(aggregateID, next);
	return next;
}
function makeEvent(directory, type, properties, project, v2) {
	const aggregateID = typeof properties.sessionID === "string" ? properties.sessionID : directory;
	return {
		directory,
		...project === void 0 ? {} : { project },
		payload: {
			id: randomUUID(),
			created: Date.now(),
			type,
			properties,
			data: v2 ?? properties,
			durable: {
				aggregateID,
				seq: nextDurableSeq(aggregateID),
				version: 1
			},
			location: { directory }
		}
	};
}
/**
* Build one OpenCode 2.x native event. The 2.x vocabulary names its events
* differently (`session.text.delta`, not `message.part.delta`) and carries
* the event's own fields under `data`; the 1.18.18 TUI ignores the event
* because it does not know the name.
*/
function makeV2Event(directory, type, data, project, aggregateID) {
	const aggregate = aggregateID ?? (typeof data.sessionID === "string" ? data.sessionID : directory);
	return {
		directory,
		...project === void 0 ? {} : { project },
		payload: {
			id: randomUUID(),
			created: Date.now(),
			type,
			properties: data,
			data,
			durable: {
				aggregateID: aggregate,
				seq: nextDurableSeq(aggregate),
				version: 1
			},
			location: { directory }
		}
	};
}
/**
* Rewrite every occurrence of a dsh session id in an event payload.
*
* A revert forks the dsh session at the boundary, so the events of the fork
* carry the new dsh id while the clients know the session under its
* original id. The ids are unique, so replacing every exact match is safe
* and covers the many shapes a session id can take in an event.
*/
function mapEventSessionId(event, from, to) {
	if (from === to) return event;
	const replace = (value) => {
		if (typeof value === "string") return value === from ? to : value;
		if (Array.isArray(value)) return value.map(replace);
		if (value !== null && typeof value === "object") {
			const out = {};
			for (const [key, item] of Object.entries(value)) out[key] = replace(item);
			return out;
		}
		return value;
	};
	return {
		...event,
		payload: {
			...event.payload,
			properties: replace(event.payload.properties),
			data: replace(event.payload.data),
			...event.payload.durable === void 0 ? {} : { durable: {
				...event.payload.durable,
				aggregateID: event.payload.durable.aggregateID === from ? to : event.payload.durable.aggregateID
			} }
		}
	};
}
function directoryFor(sessionId, deps) {
	return deps.state.sessionDirectories.get(sessionId) ?? deps.cwd;
}
function messageOptions(sessionId, deps) {
	const selected = deps.state.sessionModelSelectionFor(sessionId);
	return {
		sessionId,
		cwd: deps.cwd,
		...selected === void 0 ? deps.defaultModel === void 0 ? {} : { defaultModel: deps.defaultModel } : { defaultModel: selected },
		onSkip: (eventType, reason) => deps.log(`[bridge/events] skip ${eventType}: ${reason}`)
	};
}
function messageEvents(sessionId, deps, build, partsFirst = false) {
	const directory = directoryFor(sessionId, deps);
	const project = projectIdFor(directory);
	const { info, parts } = build();
	const update = makeEvent(directory, "message.updated", {
		sessionID: sessionId,
		info
	}, project);
	const events = partsFirst ? [] : [update];
	for (const part of parts) events.push(makeEvent(directory, "message.part.updated", {
		sessionID: sessionId,
		part,
		time: Date.now()
	}, project));
	if (partsFirst) events.push(update);
	return events;
}
function toolCallId(resultEvent) {
	const message = resultEvent.data.message;
	return String(message.toolCallId ?? message.source?.callId ?? "");
}
/** Best-effort structured progress label for a started tool call. */
function toolProgressStructured(call) {
	const present = call.view?.for === "call" ? call.view.view : void 0;
	return {
		title: typeof present?.title === "string" ? present.title : opencodeToolName(call.name, safeJsonParse(call.arguments)),
		...typeof present?.card === "string" ? { card: present.card } : {}
	};
}
function earliestBlockStart(blockStarts, turn, step) {
	let earliest;
	for (const [key, value] of blockStarts) {
		const [keyTurn, keyStep] = key.split(":");
		if (Number(keyTurn) === turn && Number(keyStep) === step) {
			if (earliest === void 0 || value < earliest) earliest = value;
		}
	}
	return earliest;
}
function zeroTokens() {
	return {
		input: 0,
		output: 0,
		reasoning: 0,
		cache: {
			read: 0,
			write: 0
		}
	};
}
function provisionalAssistantMessage(sessionId, deps, id, created, parentID) {
	const model = deps.state.sessionModelSelectionFor(sessionId) ?? deps.defaultModel ?? {
		providerID: "deepseek",
		modelID: "deepseek-chat"
	};
	const agent = deps.state.sessionAgentFor(sessionId) ?? "build";
	return {
		id,
		sessionID: sessionId,
		role: "assistant",
		agent,
		time: { created },
		parentID,
		modelID: model.modelID,
		providerID: model.providerID,
		mode: agent,
		path: {
			cwd: deps.cwd,
			root: deps.cwd
		},
		cost: 0,
		tokens: zeroTokens()
	};
}
function streamPart(blockType, sessionId, messageId, partId, text, start, end) {
	return {
		id: partId,
		sessionID: sessionId,
		messageID: messageId,
		type: blockType,
		text,
		time: end === void 0 ? { start } : {
			start,
			end
		}
	};
}
/**
* Build the opencode SSE events that make a server-side command result
* visible in the TUI: an optional session status change plus one synthetic
* assistant message with a text part. The message is intentionally
* ephemeral — dsh history is not touched, so no model turn is triggered.
*/
function commandResultMessage(deps, sessionId, text, options = {}) {
	const directory = directoryFor(sessionId, deps);
	const project = projectIdFor(directory);
	const events = [];
	if (options.status !== void 0) events.push(makeEvent(directory, "session.status", {
		sessionID: sessionId,
		status: { type: options.status }
	}, project));
	const id = `msg_cmd:${randomUUID()}`;
	const partId = `prt_cmd:${randomUUID()}`;
	const created = Date.now();
	const model = options.model ?? deps.state.sessionModelSelectionFor(sessionId) ?? deps.defaultModel ?? {
		providerID: "deepseek",
		modelID: "deepseek-chat"
	};
	const agent = deps.state.sessionAgentFor(sessionId) ?? "build";
	const finished = options.status !== "busy";
	const info = {
		id,
		sessionID: sessionId,
		role: "assistant",
		agent,
		time: finished ? {
			created,
			completed: created
		} : { created },
		parentID: options.parentID ?? `pending:${sessionId}:user`,
		modelID: model.modelID,
		providerID: model.providerID,
		...model.variant === void 0 ? {} : { variant: model.variant },
		mode: agent,
		path: {
			cwd: directory,
			root: directory
		},
		cost: 0,
		tokens: zeroTokens()
	};
	const part = {
		id: partId,
		sessionID: sessionId,
		messageID: id,
		type: "text",
		text,
		time: finished ? {
			start: created,
			end: created
		} : { start: created }
	};
	events.push(makeEvent(directory, "message.updated", {
		sessionID: sessionId,
		info
	}, project));
	events.push(makeEvent(directory, "message.part.updated", {
		sessionID: sessionId,
		part,
		time: created
	}, project));
	return {
		events,
		entry: {
			info,
			parts: [part]
		}
	};
}
/** Visible agent-error message used by the host-level error path. */
function opencodeError(code, message) {
	if (code === "message-aborted" || code === "aborted") return {
		name: "MessageAbortedError",
		data: { message }
	};
	if (code === "auth" || code === "invalid_api_key" || code === "authentication") return {
		name: "ProviderAuthError",
		data: {
			providerID: "deepseek",
			message
		}
	};
	return {
		name: "UnknownError",
		data: { message }
	};
}
function agentErrorEvents(sessionId, message, cwd) {
	const project = projectIdFor(cwd);
	const created = Date.now();
	const id = `msg_err:${randomUUID()}`;
	const partId = `${id}:0`;
	return [
		makeEvent(cwd, "session.error", {
			sessionID: sessionId,
			error: opencodeError("agent-error", message)
		}, project),
		makeEvent(cwd, "message.updated", {
			sessionID: sessionId,
			info: {
				id,
				sessionID: sessionId,
				role: "assistant",
				agent: DEFAULT_AGENT,
				time: { created },
				parentID: `pending:${sessionId}:user`,
				modelID: "deepseek-chat",
				providerID: "deepseek",
				mode: DEFAULT_AGENT,
				path: {
					cwd,
					root: cwd
				},
				cost: 0,
				tokens: zeroTokens()
			}
		}, project),
		makeEvent(cwd, "message.part.updated", {
			sessionID: sessionId,
			part: {
				id: partId,
				sessionID: sessionId,
				messageID: id,
				type: "text",
				text: `[错误] ${message}`,
				time: {
					start: created,
					end: created
				}
			},
			time: created
		}, project)
	];
}
//#endregion
//#region src/bridge/events.ts
function minimumAssistantCreatedAt(userTime) {
	return userTime === void 0 ? Number.MIN_SAFE_INTEGER : userTime + 1;
}
/** Map a dsh finish reason onto the OpenCode 2.x finish vocabulary. */
function v2FinishReason(reason) {
	switch (reason) {
		case "stop": return "stop";
		case "tool-calls": return "tool-calls";
		case "max-tokens": return "length";
		case "error": return "error";
		default: return "unknown";
	}
}
/** The text of a dsh content block list, as the 2.x inbox item carries it. */
function inboxItemText(content) {
	return content.map((block) => block).filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}
/** The OpenCode 2.x model reference of a dsh model selection. */ function v2ModelRef(model) {
	return {
		id: model.modelID,
		providerID: model.providerID,
		...model.variant === void 0 ? {} : { variant: model.variant }
	};
}
/** Map a dsh cancellation cause onto the OpenCode 2.x interrupt reason. */ function v2InterruptReason(cause) {
	switch (cause?.kind) {
		case "parent": return "superseded";
		case "disposed": return "shutdown";
		default: return "user";
	}
}
/**
* Extract an error descriptor from a tool-result message content when dsh
* marked the block `isError` (e.g. a permission-rejected tool) without a
* top-level `error` field on the event. Returns the first matching error
* carrying the block's own text, so the opencode TUI renders a readable
* "failed: <text>" (the mini TUI has no tool card title, only the error).
*/
function toolResultContentError(content) {
	for (const block of content) {
		const record = block;
		if (record === null || typeof record !== "object") continue;
		if (record.type !== "tool-result") continue;
		if (record.isError !== true) continue;
		const inner = Array.isArray(record.content) ? record.content : [];
		for (const part of inner) {
			const text = part?.text;
			if (typeof text === "string" && text.length > 0) return {
				name: text,
				code: "tool-rejected"
			};
		}
	}
}
/**
* Per-stream translator: converts one mux frame into zero or more opencode
* GlobalEvents. One instance is created per SSE client because tool/result
* pairing and current-message tracking are stream-ordered state.
*/
var MuxEventTranslator = class {
	deps;
	currentAssistant = /* @__PURE__ */ new Map();
	pendingCalls = /* @__PURE__ */ new Map();
	/** Assistant messages waiting for their tool step to finish before the TUI
	* considers them complete (drives the QUEUED badge for later user prompts).
	* One turn may contain several tool-call assistant messages, so the set is
	* keyed by session then message id. */
	pendingAssistantCompletions = /* @__PURE__ */ new Map();
	streams = /* @__PURE__ */ new Map();
	sessionGoals;
	sessionTodos;
	flushMs;
	setTimer;
	clearTimer;
	constructor(deps) {
		this.deps = deps;
		this.flushMs = deps.toolFlushMs ?? 32;
		this.setTimer = deps.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms));
		this.clearTimer = deps.clearTimeoutImpl ?? ((handle) => {
			if (handle !== void 0) clearTimeout(handle);
		});
		this.sessionGoals = deps.sharedState?.goals ?? /* @__PURE__ */ new Map();
		this.sessionTodos = deps.sharedState?.todos ?? /* @__PURE__ */ new Map();
	}
	/** Drop all live/replay state when the Host reports a Session removal. */
	disposeSession(sessionId) {
		this.currentAssistant.delete(sessionId);
		this.pendingCalls.delete(sessionId);
		this.pendingAssistantCompletions.delete(sessionId);
		this.streams.delete(sessionId);
		this.sessionGoals.delete(sessionId);
		this.sessionTodos.delete(sessionId);
	}
	streamState(sessionId) {
		let state = this.streams.get(sessionId);
		if (!state) {
			state = {
				provisionalMessageIds: /* @__PURE__ */ new Map(),
				provisionalMessageCreatedAt: /* @__PURE__ */ new Map(),
				blockStarts: /* @__PURE__ */ new Map(),
				blockEnds: /* @__PURE__ */ new Map(),
				finishReasons: /* @__PURE__ */ new Map(),
				blocks: /* @__PURE__ */ new Map(),
				blockPartIds: /* @__PURE__ */ new Map(),
				openedMessageIds: /* @__PURE__ */ new Set(),
				completedMessageIds: /* @__PURE__ */ new Set(),
				compactions: /* @__PURE__ */ new Map(),
				toolInputs: /* @__PURE__ */ new Map(),
				ordinalCounters: /* @__PURE__ */ new Map(),
				v2Blocks: /* @__PURE__ */ new Map(),
				v2ToolPhases: /* @__PURE__ */ new Map(),
				endedBlocks: /* @__PURE__ */ new Set()
			};
			this.streams.set(sessionId, state);
		}
		return state;
	}
	/**
	* Snapshot the most recent live provisional assistant for one session.
	* Returns undefined when no turn is streaming (or the stream closed), which
	* is the normal state for every settled history read.
	*/
	pendingAssistantSnapshot(sessionId) {
		const state = this.streams.get(sessionId);
		if (state === void 0 || state.provisionalMessageIds.size === 0) return void 0;
		let bestId;
		let bestCreated = Number.NEGATIVE_INFINITY;
		for (const [stepKey, id] of state.provisionalMessageIds) {
			const created = state.provisionalMessageCreatedAt.get(stepKey) ?? state.blockStarts.get(`${stepKey}:text`) ?? state.blockStarts.get(`${stepKey}:reasoning`) ?? state.turnStartTime ?? Date.now();
			if (created >= bestCreated) {
				bestCreated = created;
				bestId = id;
			}
		}
		if (bestId === void 0) return void 0;
		const parts = [];
		for (const [blockKey, block] of state.blocks) {
			if (block.messageId !== bestId) continue;
			parts.push({
				type: block.blockType,
				id: block.partId,
				text: block.text,
				start: block.start,
				...state.blockEnds.get(`${blockKey}:${block.blockType}`) === void 0 ? {} : { end: state.blockEnds.get(`${blockKey}:${block.blockType}`) }
			});
		}
		parts.sort((a, b) => a.start - b.start);
		return {
			id: bestId,
			created: bestCreated,
			...state.lastUserMessageId === void 0 ? {} : { parentID: state.lastUserMessageId },
			parts
		};
	}
	/** Emit the merged goal + todo list for one session. */
	todoUpdateEvents(sessionId, directory, project) {
		return [makeEvent(directory, "todo.updated", {
			sessionID: sessionId,
			todos: convertGoalTodos(this.sessionGoals.get(sessionId), this.sessionTodos.get(sessionId))
		}, project)];
	}
	/** Preserve child identity on every replacement session.updated payload. */
	sessionLineageOptions(sessionId) {
		const parentID = this.deps.state.sessionParents.get(sessionId);
		if (parentID === void 0) return {};
		return {
			parentID,
			...this.deps.state.isSubagentSession(sessionId) ? { metadata: { origin: "subagent" } } : {}
		};
	}
	toolKey(turn, step, index) {
		return `${turn}:${step}:${index}`;
	}
	/**
	* Publish one OpenCode 2.x native event. The 2.x vocabulary is a channel of
	* its own: the 1.18.18 TUI stream keeps its event names and shapes, and the
	* 2.x clients read the flat envelope of the same stream.
	*/
	v2Event(directory, project, type, data, aggregateID) {
		this.deps.onV2Event?.(makeV2Event(directory, type, data, project, aggregateID));
	}
	/** The OpenCode 2.x model reference of a session. */
	v2Model(sessionId) {
		return v2ModelRef(this.deps.state.sessionModelSelectionFor(sessionId) ?? this.deps.defaultModel ?? {
			providerID: "deepseek",
			modelID: "deepseek-chat"
		});
	}
	/** The OpenCode 2.x agent id of a session. */
	v2Agent(sessionId) {
		return this.deps.state.sessionAgentFor(sessionId) ?? "build";
	}
	/**
	* The next ordinal of a block kind inside one assistant message. The 2.x
	* vocabulary counts text and reasoning blocks separately, in the order they
	* appear, so the counter is kept per `${turn}:${step}:${blockType}`.
	*/
	nextOrdinal(state, stepKey, blockType) {
		const key = `${stepKey}:${blockType}`;
		const ordinal = state.ordinalCounters.get(key) ?? 0;
		state.ordinalCounters.set(key, ordinal + 1);
		return ordinal;
	}
	/**
	* Close one streamed block for the 2.x vocabulary (`session.text.ended` /
	* `session.reasoning.ended`). A block is closed once, even when the final
	* assistant message and the turn end both reach for it.
	*/
	endV2Block(state, sessionId, directory, project, blockKey, meta, text) {
		if (state.endedBlocks.has(blockKey)) return;
		state.endedBlocks.add(blockKey);
		this.v2Event(directory, project, meta.blockType === "text" ? "session.text.ended" : "session.reasoning.ended", {
			sessionID: sessionId,
			assistantMessageID: meta.messageId,
			ordinal: meta.ordinal,
			text
		});
	}
	/**
	* Publish the 2.x `session.created` event of a session the bridge learned
	* about. The 2.x client needs the record before any other event of the
	* session can be routed to it.
	*/
	v2SessionCreated(sessionId, directory, title, project) {
		const parentID = this.deps.state.sessionParents.get(sessionId);
		this.v2Event(directory, project, "session.created", {
			sessionID: sessionId,
			projectID: projectIdFor(directory),
			location: { directory },
			slug: sessionId,
			title,
			...parentID === void 0 ? {} : { parentID },
			...this.deps.state.sessionAgentFor(sessionId) === void 0 ? {} : { agent: this.deps.state.sessionAgentFor(sessionId) },
			model: this.v2Model(sessionId),
			version: OPENCODE_VERSION
		}, sessionId);
	}
	/**
	* Publish the 2.x `session.tool.input.started` of a call, once per call
	* id: the 1.18.18 stream repeats the tool input events when a call
	* arrives both as a `tool/call` and as a `tool/result`.
	*/
	v2ToolInputStarted(sessionId, directory, project, callId, messageID, name) {
		const state = this.streamState(sessionId);
		if (state.v2ToolPhases.has(callId)) return;
		state.v2ToolPhases.set(callId, "started");
		this.v2Event(directory, project, "session.tool.input.started", {
			sessionID: sessionId,
			assistantMessageID: messageID,
			id: callId,
			name
		});
	}
	/**
	* Publish the 2.x `session.tool.input.ended` / `session.tool.called` /
	* `session.tool.progress` of a call, once per call id.
	*/
	v2ToolCalled(sessionId, directory, project, callId, messageID, name, input, text, metadata) {
		const state = this.streamState(sessionId);
		if (state.v2ToolPhases.get(callId) === "called") return;
		state.v2ToolPhases.set(callId, "called");
		this.v2Event(directory, project, "session.tool.input.ended", {
			sessionID: sessionId,
			assistantMessageID: messageID,
			id: callId,
			text
		});
		this.v2Event(directory, project, "session.tool.called", {
			sessionID: sessionId,
			assistantMessageID: messageID,
			id: callId,
			name,
			input,
			executed: false
		});
		this.v2Event(directory, project, "session.tool.progress", {
			sessionID: sessionId,
			assistantMessageID: messageID,
			id: callId,
			metadata
		});
	}
	/**
	* Publish the 2.x execution outcome of a finished turn: the turn either
	* succeeded, failed, or was interrupted.
	*/
	v2ExecutionEnded(sessionId, event, directory, project) {
		const reason = event.data.reason;
		const kind = typeof reason?.kind === "string" ? reason.kind : "completed";
		if (kind === "error") {
			this.v2Event(directory, project, "session.execution.failed", {
				sessionID: sessionId,
				error: {
					type: typeof reason?.error?.code === "string" ? reason.error.code : "turn-failed",
					message: typeof reason?.error?.message === "string" ? reason.error.message : "the turn failed"
				}
			});
			return;
		}
		if (kind === "aborted" || kind === "blocked") {
			this.v2Event(directory, project, "session.execution.interrupted", {
				sessionID: sessionId,
				reason: v2InterruptReason(reason?.reason)
			});
			return;
		}
		this.v2Event(directory, project, "session.execution.succeeded", { sessionID: sessionId });
	}
	/**
	* Publish the 2.x events of one tool result: the call either succeeded or
	* failed, with the output the 1.18.18 card shows.
	*/
	v2ToolResult(sessionId, messageID, callId, call, output, metadata, error, directory, project) {
		const name = opencodeToolName(call.name, safeJsonParse(call.arguments));
		if (error === void 0) {
			this.v2Event(directory, project, "session.tool.success", {
				sessionID: sessionId,
				assistantMessageID: messageID,
				id: callId,
				name,
				content: [{
					type: "text",
					text: output
				}],
				output,
				...metadata === void 0 ? {} : { metadata },
				executed: true
			});
			return;
		}
		this.v2Event(directory, project, "session.tool.failed", {
			sessionID: sessionId,
			assistantMessageID: messageID,
			id: callId,
			name,
			error: {
				type: error.code,
				message: error.name
			},
			...metadata === void 0 ? {} : { metadata },
			executed: true
		});
	}
	/**
	* Publish the 2.x block events of a finished assistant message: every text
	* and reasoning block is closed with its final text, and the blocks the
	* live stream never carried (a cold read) are opened and closed at once.
	*/
	v2FinalBlocks(state, sessionId, messageID, stepKey, content, directory, project) {
		const texts = [];
		const reasonings = [];
		for (const block of content) if (block.type === "text") texts.push(typeof block.text === "string" ? block.text : "");
		else if (block.type === "reasoning") reasonings.push(typeof block.text === "string" ? block.text : "");
		for (const [key, meta] of [...state.v2Blocks]) {
			if (!key.startsWith(`${stepKey}:`)) continue;
			const finalText = meta.blockType === "text" ? texts[meta.ordinal] ?? "" : reasonings[meta.ordinal] ?? "";
			this.endV2Block(state, sessionId, directory, project, key, meta, finalText);
		}
		for (const [ordinal, text] of texts.entries()) {
			const key = `${stepKey}:text:${ordinal}`;
			if (state.v2Blocks.has(key)) continue;
			this.v2Event(directory, project, "session.text.started", {
				sessionID: sessionId,
				assistantMessageID: messageID,
				ordinal
			});
			this.v2Event(directory, project, "session.text.ended", {
				sessionID: sessionId,
				assistantMessageID: messageID,
				ordinal,
				text
			});
		}
		for (const [ordinal, text] of reasonings.entries()) {
			const key = `${stepKey}:reasoning:${ordinal}`;
			if (state.v2Blocks.has(key)) continue;
			this.v2Event(directory, project, "session.reasoning.started", {
				sessionID: sessionId,
				assistantMessageID: messageID,
				ordinal
			});
			this.v2Event(directory, project, "session.reasoning.ended", {
				sessionID: sessionId,
				assistantMessageID: messageID,
				ordinal,
				text
			});
		}
	}
	assistantMessageId(sessionId, turn, step) {
		return this.currentAssistant.get(sessionId) ?? this.streamState(sessionId).provisionalMessageIds.get(`${turn}:${step}`) ?? `assistant:${turn}:${step}`;
	}
	findToolInput(sessionId, callId) {
		for (const state of this.streamState(sessionId).toolInputs.values()) if (state.callId === callId) return state;
	}
	/** Register a dsh delegation in shared state before rendering its part. */
	registerSubagentCall(sessionId, call, messageID, time, turn, step) {
		if (!isSubagentToolName(call.name)) return { call };
		const input = safeJsonParse(call.arguments);
		const record = {
			parentSessionId: sessionId,
			callId: call.callId,
			toolName: call.name,
			arguments: call.arguments,
			messageId: messageID,
			description: typeof input.description === "string" ? input.description : call.name,
			prompt: typeof input.prompt === "string" ? input.prompt : "",
			subagentType: typeof input.subagent_type === "string" && input.subagent_type.trim() !== "" ? input.subagent_type : subagentTypeFromToolName(call.name),
			...input.run_in_background === true ? { background: true } : {},
			...input.run_in_background === false ? { childMode: "one-shot" } : {},
			...turn === void 0 ? {} : { turn },
			...step === void 0 ? {} : { step },
			createdAt: time
		};
		const registered = this.deps.state.registerSubagentCall(record);
		const child = this.deps.state.subagentChildForCall(sessionId, call.callId);
		if (child === void 0) return {
			call,
			record: registered
		};
		return {
			record: registered,
			child,
			call: {
				...call,
				subagent: {
					sessionId: child.sessionId,
					parentSessionId: sessionId,
					...(child.mode ?? registered.childMode) === void 0 ? {} : { mode: child.mode ?? registered.childMode },
					...registered.background === void 0 ? {} : { background: registered.background }
				}
			}
		};
	}
	/** Refresh a stored delegation call with any child identity learned later. */
	callWithSubagentChild(sessionId, call) {
		if (!isSubagentToolName(call.name)) return call;
		const record = this.deps.state.subagentCallFor(sessionId, call.callId);
		const child = this.deps.state.subagentChildForCall(sessionId, call.callId);
		if (child === void 0 && call.subagent === void 0) return call;
		return {
			...call,
			subagent: {
				...call.subagent ?? {},
				...record?.background === void 0 ? {} : { background: record.background },
				...child === void 0 ? {} : {
					sessionId: child.sessionId,
					parentSessionId: sessionId,
					...(child.mode ?? record?.childMode) === void 0 ? {} : { mode: child.mode ?? record?.childMode }
				}
			}
		};
	}
	/** Emit a running Task replacement once the child session is known. */
	subagentTaskUpdate(sessionId, call, record, child, time) {
		if (!isSubagentToolName(call.name) || record?.partEmitted !== true || child === void 0) return void 0;
		const effective = this.callWithSubagentChild(sessionId, {
			...call,
			subagent: {
				sessionId: child.sessionId,
				parentSessionId: sessionId,
				...(child.mode ?? record.childMode) === void 0 ? {} : { mode: child.mode ?? record.childMode },
				...record.background === void 0 ? {} : { background: record.background }
			}
		});
		const directory = directoryFor(sessionId, this.deps);
		const result = record?.resultStatus === void 0 ? void 0 : {
			callId: effective.callId,
			content: record.resultContent ?? [],
			time: record.resultTime ?? time,
			...record.resultError === void 0 ? {} : { error: record.resultError }
		};
		return makeEvent(directory, "message.part.updated", {
			sessionID: sessionId,
			part: result === void 0 ? runningToolPart(effective, {
				sessionID: sessionId,
				messageID: record.messageId,
				time: record.createdAt
			}) : record.resultStatus === "error" ? errorToolPart(effective, result, {
				sessionID: sessionId,
				messageID: record.messageId,
				time: record.createdAt
			}) : completedToolPart(effective, result, {
				sessionID: sessionId,
				messageID: record.messageId,
				time: record.createdAt
			}),
			time
		}, projectIdFor(directory));
	}
	/**
	* Make sure the current step has a provisional assistant message id so tool
	* parts stream under the same message that the final `assistant/message`
	* will reuse (same id, so the TUI updates one card instead of rendering
	* two). The bridge-generated id registered for the user turn is preferred
	* so the streamed reply also merges with the prompt-route placeholder.
	*/
	ensureProvisionalMessage(sessionId, turn, step, time, directory, project) {
		const state = this.streamState(sessionId);
		const stepKey = `${turn}:${step}`;
		const existing = state.provisionalMessageIds.get(stepKey);
		if (existing !== void 0) return {
			messageID: existing,
			events: []
		};
		const bridgeId = this.deps.state.assistantIdForUser(sessionId, state.lastUserMessageId ?? "");
		const alreadyOpen = bridgeId !== void 0 && state.openedMessageIds.has(bridgeId);
		const messageID = alreadyOpen ? provisionalMessageId(sessionId, turn, step) : bridgeId ?? provisionalMessageId(sessionId, turn, step);
		const promptCreatedAt = state.lastUserMessageCreatedAt ?? (state.lastUserMessageId === void 0 ? void 0 : this.deps.state.promptMessageCreatedAt(sessionId, state.lastUserMessageId));
		const createdAt = Math.max(this.deps.state.assistantMessageCreatedAt(sessionId, messageID) ?? time, minimumAssistantCreatedAt(promptCreatedAt));
		state.provisionalMessageIds.set(stepKey, messageID);
		state.provisionalMessageCreatedAt.set(stepKey, createdAt);
		this.deps.state.setAssistantMessageCreatedAt(sessionId, messageID, createdAt);
		this.deps.state.markAssistantPending(sessionId, messageID);
		if (bridgeId !== void 0) state.openedMessageIds.add(bridgeId);
		this.v2Event(directory, project, "session.step.started", {
			sessionID: sessionId,
			assistantMessageID: messageID,
			agent: this.v2Agent(sessionId),
			model: this.v2Model(sessionId)
		});
		return {
			messageID,
			events: alreadyOpen ? [] : [makeEvent(directory, "message.updated", {
				sessionID: sessionId,
				info: provisionalAssistantMessage(sessionId, this.deps, messageID, createdAt, state.lastUserMessageId ?? `pending:${sessionId}:user`)
			}, project)]
		};
	}
	/**
	* Register a streamed tool input on its first `tool-call-delta` and emit the
	* v2 `input.started` event plus a v1 running ToolPart placeholder.
	*/
	startToolInput(sessionId, turn, step, index, chunk, time, directory, project) {
		const key = this.toolKey(turn, step, index);
		const existing = this.streamState(sessionId).toolInputs.get(key);
		if (existing !== void 0) return {
			state: existing,
			events: []
		};
		const callId = String(chunk.id);
		const provisional = this.ensureProvisionalMessage(sessionId, turn, step, time, directory, project);
		const messageID = provisional.messageID;
		const state = {
			key,
			callId,
			name: chunk.name ?? "",
			messageID,
			text: "",
			pendingDelta: "",
			lastTime: time,
			ended: false
		};
		this.streamState(sessionId).toolInputs.set(key, state);
		this.v2ToolInputStarted(sessionId, directory, project, callId, messageID, opencodeToolName(state.name, safeJsonParse(state.text)));
		return {
			state,
			events: [
				...provisional.events,
				makeEvent(directory, "session.next.tool.input.started", {
					timestamp: time,
					sessionID: sessionId,
					assistantMessageID: messageID,
					callID: callId,
					name: state.name
				}, project),
				makeEvent(directory, "message.part.updated", {
					sessionID: sessionId,
					part: streamingToolPart({
						callId,
						name: state.name,
						arguments: ""
					}, {
						sessionID: sessionId,
						messageID,
						time
					}),
					time
				}, project)
			]
		};
	}
	/** Feed one arguments fragment into a streamed tool input (live or packed). */
	feedToolCallDelta(sessionId, turn, step, index, id, name, delta, time, directory, project) {
		const { state, events } = this.startToolInput(sessionId, turn, step, index, {
			id: String(id),
			...typeof name === "string" ? { name } : {}
		}, time, directory, project);
		if (state.name === "" && typeof name === "string") state.name = name;
		state.text += delta;
		state.lastTime = time;
		this.queueToolDelta(sessionId, state, delta, time, directory, project);
		return events;
	}
	/** Coalesce deltas for one tool input into a single pending flush. */
	queueToolDelta(sessionId, state, delta, time, directory, project) {
		state.pendingDelta += delta;
		state.lastTime = time;
		if (state.timer !== void 0) return;
		state.timer = this.setTimer(() => {
			state.timer = void 0;
			const events = this.flushToolDelta(sessionId, state, directory, project);
			if (events.length > 0) this.deps.onFlush?.(events);
		}, this.flushMs);
	}
	/** Flush one coalesced input delta as v2 delta + v1 running part update. */
	flushToolDelta(sessionId, state, directory, project) {
		if (state.timer !== void 0) {
			this.clearTimer(state.timer);
			state.timer = void 0;
		}
		if (state.ended || state.pendingDelta.length === 0) return [];
		const delta = state.pendingDelta;
		state.pendingDelta = "";
		this.v2Event(directory, project, "session.tool.input.delta", {
			sessionID: sessionId,
			assistantMessageID: state.messageID,
			id: state.callId,
			delta
		});
		return [makeEvent(directory, "session.next.tool.input.delta", {
			timestamp: state.lastTime,
			sessionID: sessionId,
			assistantMessageID: state.messageID,
			callID: state.callId,
			delta
		}, project), makeEvent(directory, "message.part.updated", {
			sessionID: sessionId,
			part: streamingToolPart({
				callId: state.callId,
				name: state.name,
				arguments: state.text
			}, {
				sessionID: sessionId,
				messageID: state.messageID,
				time: state.lastTime
			}),
			time: state.lastTime
		}, project)];
	}
	/**
	* Finish a streamed tool input: flush remaining deltas, emit `input.ended`
	* plus `called` with the full parsed input.
	*/
	endToolInput(sessionId, state, directory, project, time) {
		const events = this.flushToolDelta(sessionId, state, directory, project);
		if (state.ended) return events;
		state.ended = true;
		const input = safeJsonParse(state.text);
		this.v2ToolCalled(sessionId, directory, project, state.callId, state.messageID, opencodeToolName(state.name, input), input, state.text, { title: opencodeToolName(state.name, input) });
		events.push(makeEvent(directory, "session.next.tool.input.ended", {
			timestamp: time,
			sessionID: sessionId,
			assistantMessageID: state.messageID,
			callID: state.callId,
			text: state.text
		}, project), makeEvent(directory, "session.next.tool.called", {
			timestamp: time,
			sessionID: sessionId,
			assistantMessageID: state.messageID,
			callID: state.callId,
			tool: opencodeToolName(state.name, input),
			input,
			provider: { executed: false }
		}, project), makeEvent(directory, "session.next.tool.progress", {
			timestamp: time,
			sessionID: sessionId,
			assistantMessageID: state.messageID,
			callID: state.callId,
			structured: { title: opencodeToolName(state.name, safeJsonParse(state.text)) },
			content: []
		}, project));
		return events;
	}
	/** Non-streamed fallback: emit started/ended/called in one batch. */
	completeToolInputImmediately(sessionId, call, messageID, directory, project, time) {
		const input = safeJsonParse(call.arguments);
		const name = opencodeToolName(call.name, input);
		this.v2ToolInputStarted(sessionId, directory, project, call.callId, messageID, name);
		this.v2ToolCalled(sessionId, directory, project, call.callId, messageID, name, input, call.arguments, toolProgressStructured(call));
		return [
			makeEvent(directory, "session.next.tool.input.started", {
				timestamp: time,
				sessionID: sessionId,
				assistantMessageID: messageID,
				callID: call.callId,
				name: call.name
			}, project),
			makeEvent(directory, "session.next.tool.input.ended", {
				timestamp: time,
				sessionID: sessionId,
				assistantMessageID: messageID,
				callID: call.callId,
				text: call.arguments
			}, project),
			makeEvent(directory, "session.next.tool.called", {
				timestamp: time,
				sessionID: sessionId,
				assistantMessageID: messageID,
				callID: call.callId,
				tool: opencodeToolName(call.name, input),
				input,
				provider: { executed: false }
			}, project),
			makeEvent(directory, "session.next.tool.progress", {
				timestamp: time,
				sessionID: sessionId,
				assistantMessageID: messageID,
				callID: call.callId,
				structured: toolProgressStructured(call),
				content: []
			}, project)
		];
	}
	clearToolTimers(sessionId) {
		for (const state of this.streamState(sessionId).toolInputs.values()) if (state.timer !== void 0) {
			this.clearTimer(state.timer);
			state.timer = void 0;
		}
	}
	/** Clear any pending throttle timers; safe to call when the SSE ends. */
	dispose() {
		for (const sessionId of [...this.streams.keys()]) this.clearToolTimers(sessionId);
	}
	/**
	* Translate the dsh compaction lifecycle to the opencode
	* `session.next.compaction.*` family. The replacement checkpoint
	* `user/message` emits `session.next.compaction.ended` itself, so
	* `compaction/end` only emits when the checkpoint never appeared (e.g. a
	* failed summary) to avoid duplicate compaction entries in the TUI.
	*/
	translateCompactionEvent(sessionId, event, directory, project) {
		const key = typeof event.data.compactionId === "string" ? event.data.compactionId : String(event.data.compactionId ?? "");
		if (!key) return [];
		const state = this.streamState(sessionId);
		const reason = event.data.sourceCommandId === void 0 ? "auto" : "manual";
		switch (event.type) {
			case "compaction/start": {
				const messageID = `checkpoint:${key}`;
				state.compactions.set(key, {
					messageID,
					text: "",
					reason,
					ended: false
				});
				this.v2Event(directory, project, "session.compaction.started", {
					sessionID: sessionId,
					reason,
					recent: "",
					inputID: messageID
				});
				return [makeEvent(directory, "session.next.compaction.started", {
					timestamp: event.time,
					sessionID: sessionId,
					messageID,
					reason
				}, project)];
			}
			case "compaction/summary": {
				const pending = state.compactions.get(key);
				if (!pending) return [];
				const previous = pending.text;
				pending.text = textFromBlocks(event.data.summary ?? []);
				this.v2Event(directory, project, "session.compaction.delta", {
					sessionID: sessionId,
					text: pending.text.startsWith(previous) ? pending.text.slice(previous.length) : pending.text
				});
				return [makeEvent(directory, "session.next.compaction.delta", {
					timestamp: event.time,
					sessionID: sessionId,
					messageID: pending.messageID,
					text: pending.text
				}, project)];
			}
			case "compaction/end": {
				const pending = state.compactions.get(key);
				if (!pending || pending.ended) return [];
				pending.ended = true;
				state.compactions.delete(key);
				const text = pending.text || (typeof event.data.error === "string" && event.data.error ? `Compaction failed: ${event.data.error}` : "");
				this.v2Event(directory, project, "session.compaction.ended", {
					sessionID: sessionId,
					reason: pending.reason,
					text,
					recent: "",
					model: this.v2Model(sessionId)
				});
				return [makeEvent(directory, "session.next.compaction.ended", {
					timestamp: event.time,
					sessionID: sessionId,
					messageID: pending.messageID,
					reason: pending.reason,
					text,
					recent: ""
				}, project)];
			}
		}
	}
	/**
	* Translate one dsh 0.1.5 live assistant `StreamChunk` into opencode
	* streaming events. The wire union is unchanged from the deleted
	* `assistant/chunk` session event; only its transport moved to
	* `agent/assistant-stream` frames.
	*/
	translateAssistantChunk(sessionId, turn, step, time, chunk, directory, project) {
		if (chunk.type === "block-start") {
			this.streamState(sessionId).blockStarts.set(`${turn}:${step}:${chunk.index}:${chunk.blockType}`, time);
			return [];
		}
		if (chunk.type === "finish") {
			this.streamState(sessionId).finishReasons.set(`${turn}:${step}`, chunk.reason.kind);
			return [];
		}
		if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") return this.translateStreamChunks(sessionId, {
			type: chunk.type === "text-delta" ? "text-chunks" : "reasoning-chunks",
			seq: 0,
			time,
			time0: time,
			data: {
				turn,
				step,
				index: chunk.index,
				texts: [chunk.text]
			}
		}, directory, project);
		if (chunk.type === "tool-call-delta") return this.feedToolCallDelta(sessionId, turn, step, chunk.index, chunk.id, chunk.name, chunk.argumentsDelta, time, directory, project);
		return [];
	}
	translate(frame) {
		switch (frame.type) {
			case "session/event": return this.translateSessionEvent(frame.sessionId, frame.event, frame.view);
			case "session/assistant-stream": {
				const sessionId = String(frame.sessionId);
				const frameKey = `${sessionId}:${frame.attemptId}:${frame.revision}:${frame.index}`;
				if (this.deps.replayGuard?.chunks?.has(frameKey)) return [];
				this.deps.replayGuard?.chunks?.add(frameKey);
				const directory = directoryFor(sessionId, this.deps);
				return this.translateAssistantChunk(sessionId, frame.turn, frame.step, frame.time, frame.chunk, directory, projectIdFor(directory));
			}
			case "approval/requested": {
				const approvalId = String(frame.approvalId);
				if (this.deps.replayGuard?.approvals.has(approvalId)) return [];
				this.deps.replayGuard?.approvals.add(approvalId);
				const entry = {
					rpcId: String(frame.rpcId),
					sessionId: String(frame.sessionId),
					approvalId,
					toolName: frame.toolName,
					callId: frame.callId === void 0 ? void 0 : String(frame.callId),
					reason: frame.reason
				};
				const registered = this.deps.state.registerApproval({
					opencodeId: randomUUID(),
					...entry
				});
				const directory = directoryFor(registered.sessionId, this.deps);
				const project = projectIdFor(directory);
				return [makeEvent(directory, "permission.asked", toPermissionRequest(registered), project, toPermissionV2(registered))];
			}
			case "approval/resolved": {
				const entry = this.deps.state.permissionByApprovalId(String(frame.approvalId));
				if (!entry) {
					this.deps.log(`[bridge/events] approval/resolved for unknown approval ${String(frame.approvalId)}`);
					return [];
				}
				const directory = directoryFor(entry.sessionId, this.deps);
				const reply = frame.outcome === "allowed-once" ? "once" : "reject";
				const pending = this.deps.state.pendingApprovals.get(entry.rpcId);
				if (pending !== void 0) {
					this.deps.state.pendingApprovals.delete(entry.rpcId);
					pending(frame.outcome);
				}
				this.deps.state.removePermission(entry.opencodeId);
				return [makeEvent(directory, "permission.replied", {
					sessionID: entry.sessionId,
					requestID: entry.opencodeId,
					reply
				}, projectIdFor(directory))];
			}
			case "question/requested": {
				const questionKey = String(frame.rpcId);
				if (this.deps.replayGuard?.questions.has(questionKey)) return [];
				this.deps.replayGuard?.questions.add(questionKey);
				const entry = {
					rpcId: questionKey,
					sessionId: String(frame.sessionId),
					items: frame.questions
				};
				const registered = this.deps.state.registerQuestion({
					opencodeId: randomUUID(),
					...entry
				});
				const directory = directoryFor(registered.sessionId, this.deps);
				const project = projectIdFor(directory);
				this.v2Event(directory, project, "form.created", {
					form: toFormInfo(registered),
					sessionID: registered.sessionId
				}, registered.sessionId);
				return [makeEvent(directory, "question.asked", toQuestionRequest(registered), project)];
			}
			case "question/resolved": {
				const entry = this.deps.state.questionByRpcId(String(frame.questionRpcId));
				if (!entry) {
					this.deps.log(`[bridge/events] question/resolved for unknown rpcId ${String(frame.questionRpcId)}`);
					return [];
				}
				const directory = directoryFor(entry.sessionId, this.deps);
				const project = projectIdFor(directory);
				this.deps.state.removeQuestion(entry.opencodeId);
				const pending = this.deps.state.pendingQuestions.get(entry.rpcId);
				if (pending !== void 0) {
					this.deps.state.pendingQuestions.delete(entry.rpcId);
					pending(frame.outcome === "answered" ? { answers: entry.items.map((item, index) => ({
						id: item.id,
						selected: frame.answers?.[index] ?? []
					})) } : void 0);
				}
				if (frame.outcome === "answered") {
					this.v2Event(directory, project, "form.replied", {
						id: entry.opencodeId,
						formID: entry.opencodeId,
						sessionID: entry.sessionId,
						answer: toFormAnswer(entry, frame.answers)
					}, entry.sessionId);
					return [makeEvent(directory, "question.replied", {
						sessionID: entry.sessionId,
						requestID: entry.opencodeId,
						answers: frame.answers ?? []
					}, project)];
				}
				this.v2Event(directory, project, "form.cancelled", {
					id: entry.opencodeId,
					formID: entry.opencodeId,
					sessionID: entry.sessionId
				}, entry.sessionId);
				return [makeEvent(directory, "question.rejected", {
					sessionID: entry.sessionId,
					requestID: entry.opencodeId
				}, project)];
			}
			case "session/projection": return this.translateProjection(frame.sessionId, frame.key, frame.value, Date.now());
			case "session/jobs": return [];
			case "session/queue": {
				const sessionId = String(frame.sessionId);
				const directory = directoryFor(sessionId, this.deps);
				const project = projectIdFor(directory);
				const items = Array.isArray(frame.items) ? frame.items : [];
				const { added } = this.deps.state.initializeInboxProjection(sessionId, items, Date.now());
				return this.queuedMessageEvents(sessionId, added, directory, project);
			}
			case "control/baseline": {
				const events = [];
				for (const [sessionId, items] of Object.entries(frame.value.queues ?? {})) {
					const directory = directoryFor(sessionId, this.deps);
					const project = projectIdFor(directory);
					const { added, removed } = this.deps.state.initializeInboxProjection(sessionId, items.map((item) => ({
						placement: item.placement,
						rpcId: item.rpcId,
						message: item.message
					})), Date.now(), true);
					events.push(...this.queuedMessageEvents(sessionId, added, directory, project));
					for (const message of removed) {
						if (message.source.kind !== "user") continue;
						events.push(makeEvent(directory, "message.removed", {
							sessionID: sessionId,
							messageID: message.id
						}, project));
					}
				}
				for (const [sessionId, projection] of Object.entries(frame.value.projections ?? {})) for (const [key, value] of Object.entries(projection.values ?? {})) events.push(...this.translateProjection(sessionId, key, value, Date.now()));
				return events;
			}
			case "stream/error":
				this.deps.log(`[bridge/events] stream/error: ${frame.error.code} ${frame.error.message}`);
				return [makeEvent(this.deps.cwd, "session.error", { error: opencodeError(String(frame.error.code), frame.error.message) }, projectIdFor(this.deps.cwd))];
			default:
				this.deps.log(`[bridge/events] unhandled mux frame ${String(frame.type)}`);
				return [];
		}
	}
	translateProjection(sessionId, key, value, time = Date.now()) {
		const directory = directoryFor(sessionId, this.deps);
		const project = projectIdFor(directory);
		if (key === "todos") {
			this.sessionTodos.set(sessionId, value);
			return this.todoUpdateEvents(sessionId, directory, project);
		}
		if (key === "goal") {
			this.sessionGoals.set(sessionId, value);
			return this.todoUpdateEvents(sessionId, directory, project);
		}
		if (key === "produced-files") return [makeEvent(directory, "session.diff", {
			sessionID: sessionId,
			diff: filterGitTrackedDiffs(directory, convertProducedFiles(value))
		}, project)];
		if (key === "title") {
			const title = typeof value === "string" ? value : "";
			this.deps.state.setSessionTitle(sessionId, title);
			this.v2Event(directory, project, "session.renamed", {
				sessionID: sessionId,
				title
			});
			return [makeEvent(directory, "session.updated", {
				sessionID: sessionId,
				info: minimalSession(sessionId, {
					cwd: directory,
					title,
					...this.deps.state.sessionAgentFor(sessionId) === void 0 ? {} : { agent: this.deps.state.sessionAgentFor(sessionId) },
					...this.sessionLineageOptions(sessionId)
				})
			}, project)];
		}
		if (key === "agentPreset") {
			if (typeof value !== "string" || value.length === 0) return [];
			const previous = this.deps.state.sessionAgentFor(sessionId);
			this.deps.state.setSessionAgent(sessionId, value);
			this.v2Event(directory, project, "session.agent.selected", {
				sessionID: sessionId,
				agent: value,
				...previous === void 0 ? {} : { previous }
			});
			return [makeEvent(directory, "session.updated", {
				sessionID: sessionId,
				info: minimalSession(sessionId, {
					cwd: directory,
					title: this.deps.state.sessionTitleFor(sessionId),
					agent: value,
					...this.sessionLineageOptions(sessionId)
				})
			}, project)];
		}
		if (key === "subagent") {
			const childValue = value;
			const mode = childValue?.mode === "one-shot" || childValue?.mode === "continuable" ? childValue.mode : void 0;
			const label = typeof childValue?.label === "string" && childValue.label.length > 0 ? childValue.label : void 0;
			const call = this.deps.state.recordSubagentDescriptor(sessionId, {
				...mode === void 0 ? {} : { mode },
				...label === void 0 ? {} : { label }
			});
			if (call === void 0) return [];
			const child = this.deps.state.subagentChildren.get(sessionId);
			if (child === void 0) return [];
			const original = {
				callId: call.callId,
				name: call.toolName,
				arguments: call.arguments
			};
			const task = this.subagentTaskUpdate(call.parentSessionId, original, call, child, time);
			return task === void 0 ? [] : [task];
		}
		if (key === "modelSelection") {
			const selection = value;
			const current = selection?.next ?? selection?.lastUsed;
			if (current !== null && current !== void 0 && typeof current.provider === "string" && typeof current.model === "string") {
				const previous = this.deps.state.sessionModelSelectionFor(sessionId);
				this.deps.state.setSessionModelSelection(sessionId, {
					providerID: externalProviderId(current.provider),
					modelID: current.model,
					...typeof current.reasoningEffort === "string" ? { variant: current.reasoningEffort } : {}
				});
				this.v2Event(directory, project, "session.model.selected", {
					sessionID: sessionId,
					model: this.v2Model(sessionId),
					...previous === void 0 ? {} : { previous: v2ModelRef(previous) }
				});
			}
			return [];
		}
		return [];
	}
	translateSessionEvent(sessionId, event, view) {
		const directory = directoryFor(sessionId, this.deps);
		const project = projectIdFor(directory);
		switch (event.type) {
			case "agent/inbox/spliced": {
				const splice = event.data;
				const { added, removed } = this.deps.state.applyInboxSplice(sessionId, splice.target, splice.start, splice.removedCount ?? 0, splice.inserted, event.time, splice.outcome);
				const events = this.queuedMessageEvents(sessionId, added, directory, project);
				if (splice.outcome === "canceled") for (const message of removed) {
					if (message.source.kind !== "user") continue;
					events.push(makeEvent(directory, "message.removed", {
						sessionID: sessionId,
						messageID: message.id
					}, project));
				}
				return events;
			}
			case "user/message": {
				this.deps.state.markInput();
				const dshId = String(event.data.id);
				const isUserPrompt = event.data.source?.kind === "user";
				const stream = this.streamState(sessionId);
				if (isUserPrompt) stream.lastUserMessageCreatedAt = event.time;
				const surfaceId = isUserPrompt ? this.deps.state.takePromptMessageId(sessionId, dshId) : dshId;
				if (isUserPrompt) this.v2Event(directory, project, "session.inbox.delivered", {
					sessionID: sessionId,
					inboxID: surfaceId
				});
				if (isUserPrompt && surfaceId !== dshId) {
					this.deps.state.markBroadcastDshId(sessionId, dshId);
					this.streamState(sessionId).lastUserMessageId = surfaceId;
					return [];
				}
				if (isUserPrompt && this.deps.state.isBroadcastDshId(sessionId, dshId)) {
					this.streamState(sessionId).lastUserMessageId = this.deps.state.promptIdForDshId(sessionId, dshId) ?? dshId;
					return [];
				}
				if (isUserPrompt && this.deps.state.hasPresentedQueued(sessionId, dshId)) {
					this.deps.state.clearPresentedQueued(sessionId, dshId);
					this.streamState(sessionId).lastUserMessageId = dshId;
					return [];
				}
				if (!isUserPrompt && !isCompactCheckpoint(event)) return [];
				const events = messageEvents(sessionId, this.deps, () => {
					const entry = userMessageFromEvent(event, messageOptions(sessionId, this.deps));
					return {
						info: {
							...entry.info,
							agent: this.deps.state.sessionAgentFor(sessionId) ?? "build"
						},
						parts: entry.parts
					};
				});
				if (isCompactCheckpoint(event)) {
					const source = event.data.source;
					const key = typeof source.compactionId === "string" ? source.compactionId : void 0;
					if (key !== void 0) {
						const pending = this.streamState(sessionId).compactions.get(key);
						if (pending) {
							pending.messageID = String(event.data.id);
							pending.text = textFromBlocks(event.data.content);
							pending.reason = isAutoCompactCheckpoint(event) ? "auto" : "manual";
							pending.ended = true;
							this.streamState(sessionId).compactions.delete(key);
						}
					}
					events.push(makeEvent(directory, "session.next.compaction.ended", {
						timestamp: event.time,
						sessionID: sessionId,
						messageID: String(event.data.id),
						reason: isAutoCompactCheckpoint(event) ? "auto" : "manual",
						text: textFromBlocks(event.data.content),
						recent: ""
					}, project));
				}
				if (isUserPrompt) this.streamState(sessionId).lastUserMessageId = dshId;
				return events;
			}
			case "compaction/start":
			case "compaction/summary":
			case "compaction/end": return this.translateCompactionEvent(sessionId, event, directory, project);
			case "tool-call-chunks": return this.translateToolCallChunks(sessionId, event, directory, project);
			case "text-chunks":
			case "reasoning-chunks":
				{
					const chunkSeqKey = `${sessionId}:${event.seq}`;
					if (this.deps.replayGuard?.chunks?.has(chunkSeqKey)) return [];
					this.deps.replayGuard?.chunks?.add(chunkSeqKey);
				}
				return this.translateStreamChunks(sessionId, event, directory, project);
			case "assistant/message": {
				const state = this.streamState(sessionId);
				const stepKey = `${event.data.turn}:${event.data.step}`;
				const dshId = String(event.data.message.id);
				const provisionalId = state.provisionalMessageIds.get(stepKey);
				const streamed = provisionalId !== void 0;
				const bridgeForUser = this.deps.state.assistantIdForUser(sessionId, state.lastUserMessageId ?? "");
				const messageID = streamed ? provisionalId : bridgeForUser ?? dshId;
				if (streamed) this.deps.state.recordAssistantId(sessionId, dshId, provisionalId);
				else if (bridgeForUser !== void 0) this.deps.state.recordAssistantId(sessionId, dshId, bridgeForUser);
				const created = state.provisionalMessageCreatedAt.get(stepKey) ?? Math.max(earliestBlockStart(state.blockStarts, event.data.turn, event.data.step) ?? state.turnStartTime ?? event.time, minimumAssistantCreatedAt(state.lastUserMessageCreatedAt));
				this.deps.state.setAssistantMessageCreatedAt(sessionId, messageID, created);
				let stepCost;
				let stepTokens;
				const events = messageEvents(sessionId, this.deps, () => {
					const entry = assistantMessageFromEvent(event, messageOptions(sessionId, this.deps), (index, blockType) => state.blockStarts.get(`${event.data.turn}:${event.data.step}:${index}:${blockType}`), (index, blockType) => state.blockEnds.get(`${event.data.turn}:${event.data.step}:${index}:${blockType}`), created, state.lastUserMessageId, state.finishReasons.get(stepKey) ?? "stop", (index, blockType) => {
						return state.blockPartIds.get(`${event.data.turn}:${event.data.step}:${index}:${blockType}`);
					});
					const info = {
						...entry.info,
						id: messageID,
						agent: this.deps.state.sessionAgentFor(sessionId) ?? "build",
						mode: this.deps.state.sessionAgentFor(sessionId) ?? "build"
					};
					stepCost = typeof info.cost === "number" ? info.cost : void 0;
					stepTokens = info.tokens ?? void 0;
					if (event.data.message.content.some((block) => block.type === "tool-call")) {
						const time = info.time;
						if (time !== void 0) delete time.completed;
						let byMessage = this.pendingAssistantCompletions.get(sessionId);
						if (byMessage === void 0) {
							byMessage = /* @__PURE__ */ new Map();
							this.pendingAssistantCompletions.set(sessionId, byMessage);
						}
						byMessage.set(messageID, {
							messageID,
							stepKey,
							info
						});
					} else if (info.time?.completed !== void 0) {
						state.completedMessageIds.add(messageID);
						this.deps.state.markAssistantCompleted(sessionId, messageID);
					}
					return {
						info,
						parts: entry.parts.map((part) => ({
							...part,
							id: String(part.id).replaceAll(dshId, messageID),
							messageID
						}))
					};
				}, true);
				const last = events.at(-1);
				if (last?.payload.type === "message.updated" && last.payload.properties.info.time?.completed !== void 0) {
					events.pop();
					const info = last.payload.properties.info;
					events.push(makeEvent(directory, "message.updated", {
						sessionID: sessionId,
						info: {
							...info,
							time: { created: info.time.created }
						}
					}, project), last);
				}
				if (streamed) state.provisionalMessageIds.delete(stepKey);
				this.currentAssistant.set(sessionId, messageID);
				if (!streamed) this.v2Event(directory, project, "session.step.started", {
					sessionID: sessionId,
					assistantMessageID: messageID,
					agent: this.v2Agent(sessionId),
					model: this.v2Model(sessionId)
				});
				this.v2FinalBlocks(state, sessionId, messageID, stepKey, event.data.message.content, directory, project);
				this.v2Event(directory, project, "session.step.ended", {
					sessionID: sessionId,
					assistantMessageID: messageID,
					finish: v2FinishReason(state.finishReasons.get(stepKey) ?? "stop"),
					...stepCost === void 0 ? {} : { cost: stepCost },
					...stepTokens === void 0 ? {} : { tokens: stepTokens }
				});
				let calls = this.pendingCalls.get(sessionId);
				if (!calls) {
					calls = /* @__PURE__ */ new Map();
					this.pendingCalls.set(sessionId, calls);
				}
				for (const block of event.data.message.content) if (block.type === "tool-call") {
					calls.set(String(block.id), {
						callId: String(block.id),
						name: block.name,
						arguments: block.arguments
					});
					const inputState = this.findToolInput(sessionId, String(block.id));
					if (inputState !== void 0 && !inputState.ended) events.push(...this.endToolInput(sessionId, inputState, directory, project, event.time));
				}
				for (const key of [...state.blocks.keys()]) if (key.startsWith(`${stepKey}:`)) state.blocks.delete(key);
				return events;
			}
			case "turn/start": {
				const state = this.streamState(sessionId);
				state.turnStartTime = event.time;
				if (state.lastUserMessageId === void 0) state.lastUserMessageId = this.deps.state.peekPromptMessageId(sessionId);
				const promptAnchor = state.lastUserMessageId ?? this.deps.state.peekPromptMessageId(sessionId);
				const hasPromptAssistant = promptAnchor !== void 0 && this.deps.state.assistantIdForUser(sessionId, promptAnchor) !== void 0;
				if (state.lastUserMessageId === void 0 && hasPromptAssistant) state.lastUserMessageId = promptAnchor;
				const provisional = hasPromptAssistant ? this.ensureProvisionalMessage(sessionId, event.data.turn, 1, event.time, directory, project) : { events: [] };
				this.v2Event(directory, project, "session.execution.started", { sessionID: sessionId });
				return [
					...this.deps.state.shouldBroadcastSessionStatus(sessionId, true) ? [makeEvent(directory, "session.status", {
						sessionID: sessionId,
						status: { type: "busy" }
					}, project)] : [],
					makeEvent(directory, "turn.wait", { sessionID: sessionId }, project),
					...provisional.events
				];
			}
			case "turn/end": {
				const state = this.streamState(sessionId);
				const events = [
					...this.deps.state.shouldBroadcastSessionStatus(sessionId, false) ? [makeEvent(directory, "session.status", {
						sessionID: sessionId,
						status: { type: "idle" }
					}, project)] : [],
					makeEvent(directory, "session.idle", { sessionID: sessionId }, project),
					makeEvent(directory, "turn.idle", { sessionID: sessionId }, project)
				];
				this.v2ExecutionEnded(sessionId, event, directory, project);
				for (const [key, candidate] of [...state.blocks]) if (candidate.blockType === "reasoning") {
					events.push(makeEvent(directory, "message.part.updated", {
						sessionID: sessionId,
						part: streamPart("reasoning", sessionId, candidate.messageId, candidate.partId, candidate.text, candidate.start, event.time),
						time: event.time
					}, project));
					this.endV2Block(state, sessionId, directory, project, key, {
						blockType: candidate.blockType,
						ordinal: candidate.ordinal,
						messageId: candidate.messageId
					}, candidate.text);
					state.blocks.delete(key);
				}
				const pendings = this.pendingAssistantCompletions.get(sessionId);
				if (pendings !== void 0) {
					for (const pending of pendings.values()) {
						if (!state.completedMessageIds.has(pending.messageID)) events.push(makeEvent(directory, "message.updated", {
							sessionID: sessionId,
							info: {
								...pending.info,
								time: {
									created: pending.info.time?.created ?? event.time,
									completed: event.time
								}
							}
						}, project));
						this.deps.state.markAssistantCompleted(sessionId, pending.messageID);
					}
					this.pendingAssistantCompletions.delete(sessionId);
				}
				for (const [stepKey, messageID] of [...state.provisionalMessageIds]) {
					if (state.completedMessageIds.has(messageID)) continue;
					const created = state.provisionalMessageCreatedAt.get(stepKey) ?? Math.max(state.blockStarts.get(`${stepKey}:text`) ?? state.blockStarts.get(`${stepKey}:reasoning`) ?? state.turnStartTime ?? event.time, minimumAssistantCreatedAt(state.lastUserMessageCreatedAt));
					const base = provisionalAssistantMessage(sessionId, this.deps, messageID, created, state.lastUserMessageId ?? `pending:${sessionId}:user`);
					const baseTime = base.time;
					events.push(makeEvent(directory, "message.updated", {
						sessionID: sessionId,
						info: {
							...base,
							time: {
								created: baseTime?.created ?? created,
								completed: event.time
							}
						}
					}, project));
					this.v2Event(directory, project, "session.step.failed", {
						sessionID: sessionId,
						assistantMessageID: messageID,
						error: {
							type: "turn-ended",
							message: "the turn ended before the reply completed"
						}
					});
					this.deps.state.markAssistantCompleted(sessionId, messageID);
				}
				state.provisionalMessageIds.clear();
				state.provisionalMessageCreatedAt.clear();
				state.openedMessageIds.clear();
				state.completedMessageIds.clear();
				this.currentAssistant.delete(sessionId);
				this.pendingCalls.delete(sessionId);
				this.clearToolTimers(sessionId);
				this.streams.delete(sessionId);
				this.deps.state.clearPendingAssistants(sessionId);
				return events;
			}
			case "step/end": return [];
			case "todo/write":
				this.sessionTodos.set(sessionId, event.data.todos);
				return this.todoUpdateEvents(sessionId, directory, project);
			case "model/selection": {
				const data = event.data;
				if (typeof data.provider === "string" && typeof data.model === "string") {
					const previous = this.deps.state.sessionModelSelectionFor(sessionId);
					this.deps.state.setSessionModelSelection(sessionId, {
						providerID: externalProviderId(data.provider),
						modelID: data.model,
						...typeof data.reasoningEffort === "string" ? { variant: data.reasoningEffort } : {}
					});
					this.v2Event(directory, project, "session.model.selected", {
						sessionID: sessionId,
						model: this.v2Model(sessionId),
						...previous === void 0 ? {} : { previous: v2ModelRef(previous) }
					});
				}
				return [];
			}
			case "step/start":
			case "request/context":
			case "session/title-llm-request":
			case "permission/preset":
			case "sandbox/mode":
			case "approval/policy":
			case "command/run":
			case "command/done":
			case "session/end-seed":
			case "approval/asked":
			case "approval/decided":
			case "assistant/attempt": return [];
			case "request/header": {
				const config = event.data.header?.config;
				if (typeof config?.provider === "string" && typeof config.model === "string") this.deps.state.setSessionModelSelection(sessionId, {
					providerID: externalProviderId(config.provider),
					modelID: config.model,
					...typeof config.reasoningEffort === "string" ? { variant: config.reasoningEffort } : {}
				});
				return [];
			}
			case "agent-preset/selected": {
				const preset = event.data.agentPreset;
				if (typeof preset === "string") {
					const previous = this.deps.state.sessionAgentFor(sessionId);
					this.deps.state.setSessionAgent(sessionId, preset);
					this.v2Event(directory, project, "session.agent.selected", {
						sessionID: sessionId,
						agent: preset,
						...previous === void 0 ? {} : { previous }
					});
				}
				return [];
			}
			case "subagent/descriptor": {
				const data = event.data;
				const mode = data.mode === "one-shot" || data.mode === "continuable" ? data.mode : void 0;
				const label = typeof data.label === "string" && data.label.length > 0 ? data.label : void 0;
				const call = this.deps.state.recordSubagentDescriptor(sessionId, {
					...mode === void 0 ? {} : { mode },
					...label === void 0 ? {} : { label }
				});
				if (call === void 0) return [];
				const child = this.deps.state.subagentChildren.get(sessionId);
				if (child === void 0) return [];
				const original = {
					callId: call.callId,
					name: call.toolName,
					arguments: call.arguments
				};
				const task = this.subagentTaskUpdate(call.parentSessionId, original, call, child, event.time);
				return task === void 0 ? [] : [task];
			}
			case "goal/change": {
				const data = event.data;
				if (data?.goal !== void 0) this.sessionGoals.set(sessionId, { goal: data.goal });
				else if (data?.cleared !== void 0) this.sessionGoals.set(sessionId, null);
				else return [];
				return this.todoUpdateEvents(sessionId, directory, project);
			}
			case "tool/call": {
				const data = event.data;
				let call = {
					callId: String(data.callId),
					name: data.name,
					arguments: data.arguments,
					...view === void 0 ? {} : { view }
				};
				let calls = this.pendingCalls.get(sessionId);
				if (!calls) {
					calls = /* @__PURE__ */ new Map();
					this.pendingCalls.set(sessionId, calls);
				}
				const provisional = this.currentAssistant.get(sessionId) === void 0 ? this.ensureProvisionalMessage(sessionId, data.turn, data.step, event.time, directory, project) : void 0;
				const messageID = this.currentAssistant.get(sessionId) ?? provisional?.messageID ?? `assistant:${data.turn}:${data.step}`;
				const registered = this.registerSubagentCall(sessionId, call, messageID, event.time, data.turn, data.step);
				call = registered.call;
				calls.set(call.callId, call);
				const inputState = this.findToolInput(sessionId, call.callId);
				const inputEvents = inputState === void 0 ? this.completeToolInputImmediately(sessionId, call, messageID, directory, project, event.time) : this.endToolInput(sessionId, inputState, directory, project, event.time);
				const part = registered.child === void 0 ? pendingToolPart(call, {
					sessionID: sessionId,
					messageID,
					time: event.time
				}) : runningToolPart(call, {
					sessionID: sessionId,
					messageID,
					time: event.time
				});
				if (registered.record !== void 0) registered.record.partEmitted = true;
				return [
					...provisional?.events ?? [],
					...inputEvents,
					makeEvent(directory, "message.part.updated", {
						sessionID: sessionId,
						part,
						time: event.time
					}, project)
				];
			}
			case "tool/result": {
				const data = event.data;
				const callId = toolCallId(event);
				const calls = this.pendingCalls.get(sessionId);
				const call = calls?.get(callId);
				if (!call) {
					this.deps.log(`[bridge/events] tool/result without tool/call for ${callId}`);
					return [];
				}
				const effectiveCall = this.callWithSubagentChild(sessionId, call);
				const provisional = this.currentAssistant.get(sessionId) === void 0 ? this.ensureProvisionalMessage(sessionId, data.turn, data.step, event.time, directory, project) : void 0;
				const messageID = this.currentAssistant.get(sessionId) ?? provisional?.messageID ?? `assistant:${data.turn}:${data.step}`;
				const inputState = this.findToolInput(sessionId, callId);
				const inputEvents = inputState === void 0 ? this.completeToolInputImmediately(sessionId, call, messageID, directory, project, event.time) : this.endToolInput(sessionId, inputState, directory, project, event.time);
				const resultInfo = {
					callId,
					content: data.message.content,
					time: event.time,
					meta: data.meta,
					view,
					callView: call.view
				};
				const contentError = toolResultContentError(data.message.content);
				const resultError = data.error ?? contentError;
				const part = resultError === void 0 ? completedToolPart(effectiveCall, { ...resultInfo }, {
					sessionID: sessionId,
					messageID,
					time: event.time
				}) : errorToolPart(effectiveCall, {
					...resultInfo,
					error: resultError
				}, {
					sessionID: sessionId,
					messageID,
					time: event.time
				});
				const delegation = this.deps.state.subagentCallFor(sessionId, callId);
				if (delegation !== void 0) {
					delegation.resultStatus = resultError === void 0 ? "completed" : "error";
					delegation.resultTime = event.time;
					delegation.resultContent = data.message.content;
					if (resultError === void 0) delete delegation.resultError;
					else delegation.resultError = resultError;
				}
				calls?.delete(callId);
				const events = [...provisional?.events ?? [], makeEvent(directory, "message.part.updated", {
					sessionID: sessionId,
					part,
					time: event.time
				}, project)];
				const output = toolResultText(resultInfo);
				this.v2ToolResult(sessionId, messageID, callId, effectiveCall, output, toolResultStructured(resultInfo), resultError, directory, project);
				const tail = resultError === void 0 ? [makeEvent(directory, "session.next.tool.success", {
					timestamp: event.time,
					sessionID: sessionId,
					assistantMessageID: messageID,
					callID: callId,
					structured: toolResultStructured(resultInfo),
					content: [{
						type: "text",
						text: output
					}],
					provider: { executed: true }
				}, project)] : [makeEvent(directory, "session.next.tool.failed", {
					timestamp: event.time,
					sessionID: sessionId,
					assistantMessageID: messageID,
					callID: callId,
					error: {
						code: resultError.code,
						message: resultError.name
					},
					provider: { executed: true }
				}, project)];
				if (resultError === void 0) {
					const changes = fileChangesFromToolResult(effectiveCall, resultInfo);
					if (changes.length > 0) events.push(...fileChangeEvents(sessionId, messageID, changes, project, directory, event.time));
				}
				return [
					...inputEvents,
					...events,
					...tail
				];
			}
			default: {
				const type = event.type;
				const data = event.data;
				if (type === "session") {
					const header = data ?? event;
					const childDirectory = header.cwd ?? this.deps.state.sessionDirectories.get(sessionId) ?? directory;
					const parentID = this.deps.state.sessionParents.get(sessionId);
					this.v2SessionCreated(sessionId, childDirectory, header.title ?? "", projectIdFor(childDirectory));
					return [makeEvent(childDirectory, "session.updated", {
						sessionID: sessionId,
						info: minimalSession(sessionId, {
							cwd: childDirectory,
							title: header.title ?? "",
							createdAt: header.createdAt ?? Date.now(),
							...this.deps.state.sessionAgentFor(sessionId) === void 0 ? {} : { agent: this.deps.state.sessionAgentFor(sessionId) },
							...parentID === void 0 ? {} : { parentID },
							...this.sessionLineageOptions(sessionId)
						})
					}, projectIdFor(childDirectory))];
				}
				if (type === "session/created") {
					const parentID = this.deps.state.sessionParents.get(sessionId);
					const flat = event;
					this.v2SessionCreated(sessionId, directory, this.deps.state.sessionTitleFor(sessionId) ?? "", project);
					return [makeEvent(directory, "session.updated", {
						sessionID: sessionId,
						info: minimalSession(sessionId, {
							cwd: directory,
							createdAt: data?.time ?? flat.createdAt,
							...this.deps.state.sessionAgentFor(sessionId) === void 0 ? {} : { agent: this.deps.state.sessionAgentFor(sessionId) },
							...parentID === void 0 ? {} : { parentID },
							...this.sessionLineageOptions(sessionId)
						})
					}, project)];
				}
				if (type === "session/title") {
					const title = typeof data.title === "string" ? data.title : typeof data.text === "string" ? data.text : "";
					this.deps.state.setSessionTitle(sessionId, title);
					this.v2Event(directory, project, "session.renamed", {
						sessionID: sessionId,
						title
					});
					const parentID = this.deps.state.sessionParents.get(sessionId);
					return [makeEvent(directory, "session.updated", {
						sessionID: sessionId,
						info: minimalSession(sessionId, {
							cwd: directory,
							title,
							createdAt: data.time,
							...this.deps.state.sessionAgentFor(sessionId) === void 0 ? {} : { agent: this.deps.state.sessionAgentFor(sessionId) },
							...parentID === void 0 ? {} : { parentID },
							...this.sessionLineageOptions(sessionId)
						})
					}, project)];
				}
				this.deps.log(`[bridge/events] unhandled session event ${event.type}`);
				return [];
			}
		}
	}
	/** Surface dsh pending inbox messages as opencode queued user messages. */
	queuedMessageEvents(sessionId, messages, directory, project) {
		const events = [];
		for (const message of messages) {
			if (message.source.kind !== "user") continue;
			const localPromptId = this.deps.state.peekPromptMessageId(sessionId);
			const localCard = localPromptId !== void 0 && message.rpcId === localPromptId;
			if (localPromptId !== void 0 && !localCard) continue;
			if (this.deps.state.isBroadcastDshId(sessionId, String(message.id))) continue;
			const created = localCard && localPromptId !== void 0 ? this.deps.state.promptMessageCreatedAt(sessionId, localPromptId) ?? message.enqueuedAt : message.enqueuedAt;
			const selected = this.deps.state.sessionModelSelectionFor(sessionId);
			const model = selected === void 0 ? this.deps.defaultModel ?? {
				providerID: "deepseek",
				modelID: "deepseek-chat"
			} : selected;
			const agent = this.deps.state.sessionAgentFor(sessionId) ?? "build";
			events.push(makeEvent(directory, "message.updated", {
				sessionID: sessionId,
				info: {
					id: localCard ? localPromptId : message.id,
					sessionID: sessionId,
					role: "user",
					time: { created },
					agent,
					model
				}
			}, project));
			if (localCard) continue;
			this.v2Event(directory, project, "session.inbox.enqueued", {
				sessionID: sessionId,
				inboxID: message.id,
				item: {
					type: "user",
					payload: { text: inboxItemText(message.content) },
					delivery: "queue"
				}
			}, sessionId);
			message.content.forEach((block, index) => {
				const textBlock = block;
				if (textBlock.type !== "text" || typeof textBlock.text !== "string") return;
				events.push(makeEvent(directory, "message.part.updated", {
					sessionID: sessionId,
					part: {
						id: `${localCard ? localPromptId : message.id}:${index}`,
						sessionID: sessionId,
						messageID: localCard ? localPromptId : message.id,
						type: "text",
						text: textBlock.text,
						time: {
							start: created,
							end: created
						}
					}
				}, project));
			});
		}
		return events;
	}
	translateStreamChunks(sessionId, event, directory, project) {
		const state = this.streamState(sessionId);
		const blockType = event.type === "text-chunks" ? "text" : "reasoning";
		const blockKey = `${event.data.turn}:${event.data.step}:${event.data.index}`;
		const blockStartKey = `${blockKey}:${blockType}`;
		const time0 = event.time0 ?? event.time;
		let block = state.blocks.get(blockKey);
		if (block && block.blockType !== blockType) {
			this.deps.log(`[bridge/events] chunk block type changed for ${blockKey} (${block.blockType} -> ${blockType})`);
			return [];
		}
		const events = [];
		if (!block) {
			if (!state.blockStarts.has(blockStartKey)) state.blockStarts.set(blockStartKey, time0);
			if (blockType === "text") {
				for (const [key, candidate] of [...state.blocks]) if (candidate.blockType === "reasoning" && key.startsWith(`${event.data.turn}:${event.data.step}:`)) {
					events.push(makeEvent(directory, "message.part.updated", {
						sessionID: sessionId,
						part: streamPart("reasoning", sessionId, candidate.messageId, candidate.partId, candidate.text, candidate.start, time0),
						time: time0
					}, project));
					this.endV2Block(state, sessionId, directory, project, key, {
						blockType: candidate.blockType,
						ordinal: candidate.ordinal,
						messageId: candidate.messageId
					}, candidate.text);
					state.blocks.delete(key);
				}
			}
			const stepKey = `${event.data.turn}:${event.data.step}`;
			let provisionalId = state.provisionalMessageIds.get(stepKey);
			if (!provisionalId) {
				const bridgeId = this.deps.state.assistantIdForUser(sessionId, state.lastUserMessageId ?? "");
				const alreadyOpen = bridgeId !== void 0 && state.openedMessageIds.has(bridgeId);
				provisionalId = alreadyOpen ? provisionalMessageId(sessionId, event.data.turn, event.data.step) : bridgeId ?? provisionalMessageId(sessionId, event.data.turn, event.data.step);
				const promptCreatedAt = state.lastUserMessageCreatedAt ?? (state.lastUserMessageId === void 0 ? void 0 : this.deps.state.promptMessageCreatedAt(sessionId, state.lastUserMessageId));
				const provisionalCreated = Math.max(state.blockStarts.get(blockStartKey) ?? this.deps.state.assistantMessageCreatedAt(sessionId, provisionalId) ?? state.turnStartTime ?? time0, minimumAssistantCreatedAt(promptCreatedAt));
				state.provisionalMessageIds.set(stepKey, provisionalId);
				state.provisionalMessageCreatedAt.set(stepKey, provisionalCreated);
				this.deps.state.setAssistantMessageCreatedAt(sessionId, provisionalId, provisionalCreated);
				this.deps.state.markAssistantPending(sessionId, provisionalId);
				if (bridgeId !== void 0) state.openedMessageIds.add(bridgeId);
				this.v2Event(directory, project, "session.step.started", {
					sessionID: sessionId,
					assistantMessageID: provisionalId,
					agent: this.v2Agent(sessionId),
					model: this.v2Model(sessionId)
				});
				if (!alreadyOpen) events.push(makeEvent(directory, "message.updated", {
					sessionID: sessionId,
					info: provisionalAssistantMessage(sessionId, this.deps, provisionalId, provisionalCreated, state.lastUserMessageId ?? `pending:${sessionId}:user`)
				}, project));
			}
			const ordinal = this.nextOrdinal(state, `${event.data.turn}:${event.data.step}`, blockType);
			block = {
				blockType,
				partId: provisionalPartId(sessionId, event.data.turn, event.data.step, blockType, event.data.index),
				messageId: provisionalId,
				start: state.blockStarts.get(blockStartKey) ?? time0,
				text: "",
				sent: 0,
				ordinal
			};
			state.blocks.set(blockKey, block);
			state.blockPartIds.set(blockStartKey, block.partId);
			state.v2Blocks.set(`${event.data.turn}:${event.data.step}:${blockType}:${ordinal}`, {
				blockType,
				ordinal,
				messageId: block.messageId
			});
			this.v2Event(directory, project, blockType === "text" ? "session.text.started" : "session.reasoning.started", {
				sessionID: sessionId,
				assistantMessageID: block.messageId,
				ordinal
			});
		}
		const sent = block.sent;
		block.text += event.data.texts.join("");
		state.blockEnds.set(blockStartKey, event.time ?? time0);
		block.sent = block.text.length;
		if (sent === 0) events.push(makeEvent(directory, "message.part.updated", {
			sessionID: sessionId,
			part: streamPart(block.blockType, sessionId, block.messageId, block.partId, "", block.start),
			time: time0
		}, project));
		if (block.sent > sent) {
			const delta = block.text.slice(sent);
			events.push(makeEvent(directory, "message.part.delta", {
				sessionID: sessionId,
				messageID: block.messageId,
				partID: block.partId,
				field: "text",
				delta,
				time: time0
			}, project));
			this.v2Event(directory, project, blockType === "text" ? "session.text.delta" : "session.reasoning.delta", {
				sessionID: sessionId,
				assistantMessageID: block.messageId,
				ordinal: block.ordinal,
				delta
			});
		}
		return events;
	}
	/** Translate a packed `tool-call-chunks` storage row (history replay). */
	translateToolCallChunks(sessionId, event, directory, project) {
		const events = [];
		const time = event.time0 ?? event.time;
		for (const fragment of event.data.args) {
			if (typeof fragment !== "string" || fragment.length === 0) continue;
			events.push(...this.feedToolCallDelta(sessionId, event.data.turn, event.data.step, event.data.index, event.data.id, event.data.name, fragment, time, directory, project));
		}
		return events;
	}
};
/** Best-effort conversion of a produced-files projection to FileDiffInfo[]. */
function convertProducedFiles(value) {
	if (!Array.isArray(value)) return [];
	const result = [];
	for (const raw of value) {
		if (raw === null || typeof raw !== "object") continue;
		const item = raw;
		const additions = typeof item.additions === "number" ? item.additions : 0;
		const deletions = typeof item.deletions === "number" ? item.deletions : 0;
		const file = typeof item.file === "string" ? item.file : typeof item.path === "string" ? item.path : void 0;
		const status = item.status === "added" || item.status === "deleted" || item.status === "modified" ? item.status : file === void 0 ? void 0 : "modified";
		result.push({
			file: file ?? "",
			patch: typeof item.patch === "string" ? item.patch : "",
			additions,
			deletions,
			status: status ?? "modified"
		});
	}
	return result;
}
/** Convert bridge file changes to the opencode FileDiffInfo shape. */
function toFileDiffInfos(changes) {
	return changes.map((change) => ({
		file: change.file,
		patch: change.patch ?? "",
		additions: change.additions,
		deletions: change.deletions,
		status: change.status ?? "modified"
	}));
}
/**
* Emit the message parts and session diff that make a completed file-changing
* tool visible to the opencode TUI (sidebar "Modified Files" plus snapshot /
* patch parts for consumers that render them).
*/
function fileChangeEvents(sessionID, messageID, changes, project, directory, time) {
	if (changes.length === 0) return [];
	const trackedChanges = filterGitTrackedDiffs(directory, changes);
	if (trackedChanges.length === 0) return [];
	const patch = trackedChanges.map((change) => change.patch).filter((value) => value !== void 0).join("\n");
	const files = trackedChanges.map((change) => change.file);
	const hash = stableId(`${sessionID}:${messageID}:${files.join("\0")}:${patch}`);
	const events = [makeEvent(directory, "message.part.updated", {
		sessionID,
		part: {
			id: `patch:${hash}`,
			sessionID,
			messageID,
			type: "patch",
			hash,
			files
		},
		time
	}, project), makeEvent(directory, "session.diff", {
		sessionID,
		diff: toFileDiffInfos(trackedChanges)
	}, project)];
	if (patch) events.unshift(makeEvent(directory, "message.part.updated", {
		sessionID,
		part: {
			id: `snapshot:${hash}`,
			sessionID,
			messageID,
			type: "snapshot",
			snapshot: hash
		},
		time
	}, project));
	return events;
}
/**
* Map a dsh `host/agent-error` frame to opencode events: the protocol
* `session.error` plus a visible assistant message so the TUI conversation
* shows the error text instead of swallowing it or rendering an object.
*/
//#endregion
//#region src/bridge/state.ts
function sourceForQueueItem(placement, source) {
	if (source !== void 0) return source;
	return { kind: placement === "context" ? "context" : "user" };
}
/**
* In-memory correlation maps between opencode-facing request ids and the dsh
* rpcIds/approval ids that answer them. Populated from the mux stream; the
* HTTP reply routes read it back.
*/
var InteractionState = class InteractionState {
	permissions = /* @__PURE__ */ new Map();
	questions = /* @__PURE__ */ new Map();
	byApprovalId = /* @__PURE__ */ new Map();
	byQuestionRpcId = /* @__PURE__ */ new Map();
	sessionDirectories = /* @__PURE__ */ new Map();
	sessionParents = /* @__PURE__ */ new Map();
	/**
	* Sessions whose dsh id changed under a fixed opencode id.
	*
	* A revert forks the dsh session at the boundary, so the opencode session
	* id has to keep pointing at the fork. The map goes from the opencode id
	* to the current dsh id; the reverse map is derived from it.
	*/
	sessionAliases = /* @__PURE__ */ new Map();
	sessionAddressModes = /* @__PURE__ */ new Map();
	/** Sessions whose durable origin is the dsh subagent seam. */
	sessionOrigins = /* @__PURE__ */ new Set();
	/** Pending/associated dsh delegation calls, keyed by parent + call id. */
	subagentCalls = /* @__PURE__ */ new Map();
	/** Child records learned from api-session/added, projection, or summaries. */
	subagentChildren = /* @__PURE__ */ new Map();
	/** Descriptor facts that can precede the host lifecycle summary. */
	subagentDescriptorFacts = /* @__PURE__ */ new Map();
	/** Child additions that arrived before their parent tool/call was translated. */
	pendingSubagentChildren = /* @__PURE__ */ new Map();
	/** Authoritative live Agent state mirrored from dsh api-session/status. */
	sessionRunning = /* @__PURE__ */ new Map();
	/** Last status/activity observation used for reconnect diagnostics. */
	sessionStatusUpdatedAt = /* @__PURE__ */ new Map();
	/** Last realtime status edge broadcast to connected SSE clients. */
	sessionStatusBroadcast = /* @__PURE__ */ new Map();
	savedPermissions = /* @__PURE__ */ new Map();
	/** Last explicit model selection (with variant) per session, for self-heal. */
	sessionModelSelections = /* @__PURE__ */ new Map();
	/** Real durable titles learned from history projections / title events. */
	sessionTitles = /* @__PURE__ */ new Map();
	/** Last known agent preset per session (survives title/projection updates). */
	sessionAgents = /* @__PURE__ */ new Map();
	/** One stale editor-agent value to suppress after an explicit /preset switch. */
	stalePresetPrompts = /* @__PURE__ */ new Map();
	/** Recent bridge-only command result cards retained for history hydration. */
	recentCommandResults = /* @__PURE__ */ new Map();
	/** Revert boundaries staged per session. */
	revertBoundaries = /* @__PURE__ */ new Map();
	/** User shell executions currently owned by this bridge session. */
	shellControllers = /* @__PURE__ */ new Map();
	/** In-flight shell maintenance promises, awaited during bridge teardown. */
	shellPromises = /* @__PURE__ */ new Map();
	/** Sessions removed by the host while a shell callback is still draining. */
	clearedSessions = /* @__PURE__ */ new Set();
	/** Mirror of each session's dsh pending inbox (next-turn / next-step). */
	inboxProjections = /* @__PURE__ */ new Map();
	/** Message ids already surfaced to the TUI as queued user messages. */
	presentQueuedIds = /* @__PURE__ */ new Set();
	/** dsh user message ids already echoed by the prompt route (broadcast). */
	broadcastDshIds = /* @__PURE__ */ new Set();
	/** TUI-generated `messageID`s from prompt submissions, FIFO per session. */
	promptMessageIds = /* @__PURE__ */ new Map();
	/** Original optimistic-card timestamp, keyed by the TUI prompt id. */
	promptMessageTimes = /* @__PURE__ */ new Map();
	/** dsh user message id -> TUI prompt id (kept so history echoes match). */
	dshPromptMessageIds = /* @__PURE__ */ new Map();
	/** Bridge-generated assistant message ids keyed by user message id. */
	assistantIdsByUser = /* @__PURE__ */ new Map();
	/** dsh assistant message id -> bridge assistant id (history echo match). */
	dshAssistantIds = /* @__PURE__ */ new Map();
	/** Canonical live-card timestamp keyed by the bridge assistant id. */
	assistantMessageTimes = /* @__PURE__ */ new Map();
	/** Assistant cards whose turn/tool step is still live. */
	pendingAssistantIds = /* @__PURE__ */ new Set();
	sessionListCache;
	/** In-flight session.list RPC shared by concurrent callers (incl. prefetch). */
	sessionListLoading;
	sessionListGeneration = 0;
	/** One bounded cold seed for the status endpoint; never retry in a poll loop. */
	/** Lightweight counters used to prove the status poll has no list storm. */
	sessionListRpcCalls = 0;
	/** Whether this bridge run accepted new user input (banner-bearing content). */
	newInputDuringRun = false;
	/** The session the TUI most recently created/resumed/opened. */
	currentSessionId;
	/** Last agent preset selected during this run (inherited by new sessions). */
	lastAgentPreset;
	historyCache = /* @__PURE__ */ new Map();
	historyLoading = /* @__PURE__ */ new Map();
	historyGenerations = /* @__PURE__ */ new Map();
	static subagentCallKey(parentSessionId, callId) {
		return `${parentSessionId}\u0000${callId}`;
	}
	static subagentChildMatchesCall(child, call) {
		if (child.parentSessionId !== call.parentSessionId) return false;
		if (child.label === void 0 || child.label.length === 0) return true;
		return child.label === call.description;
	}
	attachSubagentChild(child, call) {
		call.childSessionId = child.sessionId;
		const mode = child.mode ?? call.childMode;
		if (mode !== void 0) call.childMode = mode;
		this.subagentCalls.set(InteractionState.subagentCallKey(call.parentSessionId, call.callId), call);
		this.subagentChildren.set(child.sessionId, child);
		this.sessionOrigins.add(child.sessionId);
		this.sessionParents.set(child.sessionId, child.parentSessionId);
		if (mode !== void 0) this.sessionAddressModes.set(child.sessionId, mode);
		if (child.cwd !== void 0) this.sessionDirectories.set(child.sessionId, child.cwd);
		if (child.title !== void 0 && child.title.length > 0) this.setSessionTitle(child.sessionId, child.title);
		if (child.agent !== void 0 && child.agent.length > 0) this.setSessionAgent(child.sessionId, child.agent);
		const pending = this.pendingSubagentChildren.get(child.parentSessionId);
		if (pending !== void 0) {
			const remaining = pending.filter((candidate) => candidate.sessionId !== child.sessionId);
			if (remaining.length === 0) this.pendingSubagentChildren.delete(child.parentSessionId);
			else if (remaining.length !== pending.length) this.pendingSubagentChildren.set(child.parentSessionId, remaining);
		}
	}
	matchPendingChildForCall(call) {
		const pending = this.pendingSubagentChildren.get(call.parentSessionId);
		if (pending === void 0 || pending.length === 0) return void 0;
		const exactIndex = pending.findIndex((child) => child.label !== void 0 && InteractionState.subagentChildMatchesCall(child, call));
		const fifoIndex = pending.findIndex((child) => child.allowFifo === true);
		if (exactIndex === -1 && fifoIndex === -1) return void 0;
		const index = exactIndex === -1 ? fifoIndex : exactIndex;
		const child = pending.splice(index, 1)[0];
		if (pending.length === 0) this.pendingSubagentChildren.delete(call.parentSessionId);
		return child;
	}
	/** Register a parent tool call and attach any child that arrived first. */
	registerSubagentCall(call) {
		const key = InteractionState.subagentCallKey(call.parentSessionId, call.callId);
		const existing = this.subagentCalls.get(key);
		if (existing !== void 0) {
			if (existing.childSessionId === void 0) {
				const child = this.matchPendingChildForCall(existing);
				if (child !== void 0) this.attachSubagentChild(child, existing);
			}
			return existing;
		}
		this.subagentCalls.set(key, call);
		const child = this.matchPendingChildForCall(call);
		if (child !== void 0) this.attachSubagentChild(child, call);
		return call;
	}
	/** Return a registered dsh delegation call, if any. */
	subagentCallFor(parentSessionId, callId) {
		return this.subagentCalls.get(InteractionState.subagentCallKey(parentSessionId, callId));
	}
	/** Return the child associated with one parent tool call, if known. */
	subagentChildForCall(parentSessionId, callId) {
		const call = this.subagentCallFor(parentSessionId, callId);
		return call?.childSessionId === void 0 ? void 0 : this.subagentChildren.get(call.childSessionId);
	}
	/**
	* Bind a historical delegation to one unclaimed child from the same parent.
	* Labels are authoritative when present; otherwise durable child creation
	* order is the only stable local signal. Persisting the binding means v1
	* and v2 hydration (and repeated page reads) cannot reuse the first child.
	*/
	bindSubagentCallForHistory(call) {
		const key = InteractionState.subagentCallKey(call.parentSessionId, call.callId);
		const registered = this.subagentCalls.get(key) ?? call;
		if (!this.subagentCalls.has(key)) this.subagentCalls.set(key, registered);
		if (registered.childSessionId !== void 0) return this.subagentChildren.get(registered.childSessionId);
		const claimed = /* @__PURE__ */ new Set();
		for (const candidate of this.subagentCalls.values()) if (candidate.childSessionId !== void 0) claimed.add(candidate.childSessionId);
		const candidates = [...this.subagentChildren.values()].filter((child) => child.parentSessionId === registered.parentSessionId && !claimed.has(child.sessionId)).sort((left, right) => left.addedAt - right.addedAt || left.sessionId.localeCompare(right.sessionId));
		const child = candidates.find((candidate) => candidate.label !== void 0 && candidate.label.length > 0 && candidate.label === registered.description) ?? candidates[0];
		if (child === void 0) return void 0;
		this.attachSubagentChild(child, registered);
		return child;
	}
	/**
	* Associate one host/session-added or projection-derived child. The child
	* may arrive before the parent's tool/call event reaches the translator.
	* Label equality wins; otherwise parent-local FIFO is deterministic.
	*/
	associateSubagentChild(child) {
		const previous = this.subagentChildren.get(child.sessionId);
		const descriptor = this.subagentDescriptorFacts.get(child.sessionId);
		const merged = previous === void 0 ? {
			...child,
			...descriptor ?? {}
		} : {
			...previous,
			...child,
			...descriptor ?? {},
			addedAt: previous.addedAt
		};
		this.subagentChildren.set(child.sessionId, merged);
		this.sessionOrigins.add(child.sessionId);
		this.sessionParents.set(child.sessionId, merged.parentSessionId);
		if (merged.mode !== void 0) this.sessionAddressModes.set(child.sessionId, merged.mode);
		if (merged.cwd !== void 0) this.sessionDirectories.set(child.sessionId, merged.cwd);
		if (merged.title !== void 0 && merged.title.length > 0) this.setSessionTitle(child.sessionId, merged.title);
		if (merged.agent !== void 0 && merged.agent.length > 0) this.setSessionAgent(child.sessionId, merged.agent);
		const associated = [...this.subagentCalls.values()].find((call) => call.childSessionId === child.sessionId);
		if (associated !== void 0) return associated;
		const calls = [...this.subagentCalls.values()].filter((call) => call.parentSessionId === merged.parentSessionId && call.childSessionId === void 0).sort((left, right) => left.createdAt - right.createdAt || left.callId.localeCompare(right.callId));
		const call = calls.find((call) => merged.label !== void 0 && InteractionState.subagentChildMatchesCall(merged, call)) ?? (merged.allowFifo === true ? calls[0] : void 0);
		if (call !== void 0) {
			this.attachSubagentChild(merged, call);
			return call;
		}
		const pending = this.pendingSubagentChildren.get(merged.parentSessionId) ?? [];
		const pendingIndex = pending.findIndex((candidate) => candidate.sessionId === merged.sessionId);
		if (pendingIndex === -1) pending.push(merged);
		else pending[pendingIndex] = merged;
		this.pendingSubagentChildren.set(merged.parentSessionId, pending);
	}
	/** Enrich a previously associated child with descriptor/projection facts. */
	enrichSubagentChild(sessionId, update) {
		const child = this.subagentChildren.get(sessionId);
		if (child === void 0) {
			const previous = this.subagentDescriptorFacts.get(sessionId) ?? {};
			this.subagentDescriptorFacts.set(sessionId, {
				...previous,
				...update
			});
			return;
		}
		const next = {
			...child,
			...update
		};
		this.subagentChildren.set(sessionId, next);
		this.sessionOrigins.add(sessionId);
		if (next.mode !== void 0) {
			this.sessionAddressModes.set(sessionId, next.mode);
			const call = [...this.subagentCalls.values()].find((candidate) => candidate.childSessionId === sessionId);
			if (call !== void 0) call.childMode = next.mode;
		}
		if (next.title !== void 0 && next.title.length > 0) this.setSessionTitle(sessionId, next.title);
		if (next.agent !== void 0 && next.agent.length > 0) this.setSessionAgent(sessionId, next.agent);
		if (next.cwd !== void 0) this.sessionDirectories.set(sessionId, next.cwd);
		return [...this.subagentCalls.values()].find((candidate) => candidate.childSessionId === sessionId);
	}
	/** Store descriptor/projection identity even before host/session-added. */
	recordSubagentDescriptor(sessionId, update) {
		const previous = this.subagentDescriptorFacts.get(sessionId) ?? {};
		this.subagentDescriptorFacts.set(sessionId, {
			...previous,
			...update
		});
		return this.enrichSubagentChild(sessionId, update);
	}
	/** Whether a session is a durable subagent child. */
	isSubagentSession(sessionId) {
		return this.sessionOrigins.has(sessionId);
	}
	recordCommandResult(sessionId, entry) {
		const results = this.recentCommandResults.get(sessionId) ?? [];
		if (results.some((item) => item.info.id === entry.info.id)) return;
		results.push(entry);
		if (results.length > 20) results.shift();
		this.recentCommandResults.set(sessionId, results);
	}
	/** Insert or replace one bridge-only card (used by running shell history). */
	upsertCommandResult(sessionId, entry) {
		const results = this.recentCommandResults.get(sessionId) ?? [];
		const index = results.findIndex((item) => item.info.id === entry.info.id);
		if (index === -1) results.push(entry);
		else results[index] = entry;
		if (results.length > 20) results.splice(0, results.length - 20);
		this.recentCommandResults.set(sessionId, results);
	}
	commandResultsFor(sessionId) {
		return this.recentCommandResults.get(sessionId) ?? [];
	}
	/** Register one shell cancellation controller and return its disposer. */
	trackShellController(sessionId, controller) {
		const controllers = this.shellControllers.get(sessionId) ?? /* @__PURE__ */ new Set();
		controllers.add(controller);
		this.shellControllers.set(sessionId, controllers);
		return () => {
			controllers.delete(controller);
			if (controllers.size === 0) this.shellControllers.delete(sessionId);
		};
	}
	trackShellPromise(sessionId, promise) {
		const promises = this.shellPromises.get(sessionId) ?? /* @__PURE__ */ new Set();
		promises.add(promise);
		this.shellPromises.set(sessionId, promises);
		return () => {
			promises.delete(promise);
			if (promises.size === 0) {
				this.shellPromises.delete(sessionId);
				if (this.clearedSessions.has(sessionId)) this.clearedSessions.delete(sessionId);
			}
		};
	}
	/** Abort only shell executions owned by this exact session. */
	abortShell(sessionId) {
		const controllers = this.shellControllers.get(sessionId);
		if (controllers === void 0 || controllers.size === 0) return false;
		for (const controller of controllers) controller.abort();
		return true;
	}
	abortAllShells() {
		for (const sessionId of this.shellControllers.keys()) this.abortShell(sessionId);
	}
	async waitForShells(timeoutMs = 1e3) {
		const pending = [...this.shellPromises.values()].flatMap((promises) => [...promises]);
		if (pending.length === 0) return;
		await Promise.race([Promise.allSettled(pending).then(() => void 0), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
	}
	markSessionPresent(sessionId) {
		this.clearedSessions.delete(sessionId);
	}
	isSessionCleared(sessionId) {
		return this.clearedSessions.has(sessionId);
	}
	getSessionListCache(ttlMs) {
		const cached = this.sessionListCache;
		if (cached !== void 0 && Date.now() - cached.at < ttlMs) return cached.items;
	}
	setSessionListCache(items) {
		this.sessionListCache = {
			items,
			at: Date.now()
		};
	}
	getHistoryCache(key, ttlMs) {
		const entry = this.historyCache.get(key);
		if (entry !== void 0 && Date.now() - entry.at < ttlMs) return entry.value;
	}
	setHistoryCache(key, value) {
		this.historyCache.set(key, {
			value,
			at: Date.now()
		});
	}
	getHistoryLoading(key) {
		return this.historyLoading.get(key);
	}
	setHistoryLoading(key, promise) {
		this.historyLoading.set(key, promise);
	}
	clearHistoryLoading(key, promise) {
		if (this.historyLoading.get(key) === promise) this.historyLoading.delete(key);
	}
	historyGeneration(key) {
		return this.historyGenerations.get(key) ?? 0;
	}
	listGeneration() {
		return this.sessionListGeneration;
	}
	setSessionRunning(sessionId, running, updatedAt = 0) {
		const current = this.sessionStatusUpdatedAt.get(sessionId);
		if (current !== void 0 && updatedAt < current) return;
		this.sessionRunning.set(sessionId, running);
		this.sessionStatusUpdatedAt.set(sessionId, updatedAt);
	}
	sessionRunningFor(sessionId) {
		return this.sessionRunning.get(sessionId);
	}
	sessionStatusUpdatedAtFor(sessionId) {
		return this.sessionStatusUpdatedAt.get(sessionId);
	}
	/**
	* Claim one live session.status edge for broadcast. dsh 0.1.2 reports the
	* same turn edge through both Session events and api-session/status; the
	* authoritative state guard also rejects an older opposite edge before it
	* can mark the session idle/busy incorrectly. SSE snapshots deliberately do
	* not use this method because every new client needs its own snapshot.
	*/
	shouldBroadcastSessionStatus(sessionId, running) {
		const authoritative = this.sessionRunning.get(sessionId);
		if (authoritative !== void 0 && authoritative !== running) return false;
		if (this.sessionStatusBroadcast.get(sessionId) === running) return false;
		this.sessionStatusBroadcast.set(sessionId, running);
		return true;
	}
	markSessionActivity(sessionId, updatedAt) {
		if (updatedAt >= (this.sessionStatusUpdatedAt.get(sessionId) ?? 0)) this.sessionStatusUpdatedAt.set(sessionId, updatedAt);
	}
	/** Drop list and (optionally per-session) history caches after any mutation. */
	invalidateSession(sessionId) {
		this.sessionListCache = void 0;
		this.sessionListLoading = void 0;
		this.sessionListGeneration += 1;
		this.invalidateHistory(sessionId);
	}
	/**
	* Point an opencode session id at another dsh session.
	*
	* A revert forks the dsh session at the boundary, so the opencode id has
	* to keep working while pointing at the fork.
	*/
	setSessionAlias(opencodeId, dshId) {
		if (opencodeId === dshId) return;
		this.sessionAliases.set(opencodeId, dshId);
	}
	/** The dsh session an opencode session id currently points at. */
	resolveSessionId(sessionId) {
		return this.sessionAliases.get(sessionId) ?? sessionId;
	}
	/** The opencode session id a dsh session is published under. */
	openCodeIdFor(sessionId) {
		for (const [opencodeId, dshId] of this.sessionAliases) if (dshId === sessionId) return opencodeId;
		return sessionId;
	}
	/** The opencode session ids that point at a different dsh session. */
	aliasedSessionIds() {
		return [...this.sessionAliases.keys()];
	}
	/**
	* Copy the per-session state of one session onto another.
	*
	* A revert forks the dsh session at the boundary. The fork inherits the
	* conversation, so the model, the agent preset, the title and the message
	* id mappings have to follow it, otherwise the rewritten session would
	* show the deployment defaults and the clients would see the same message
	* under two ids.
	*/
	inheritSessionState(fromSessionId, toSessionId) {
		if (fromSessionId === toSessionId) return;
		const directory = this.sessionDirectories.get(fromSessionId);
		if (directory !== void 0) this.sessionDirectories.set(toSessionId, directory);
		const model = this.sessionModelSelections.get(fromSessionId);
		if (model !== void 0) this.sessionModelSelections.set(toSessionId, model);
		const title = this.sessionTitles.get(fromSessionId);
		if (title !== void 0) this.sessionTitles.set(toSessionId, title);
		const agent = this.sessionAgents.get(fromSessionId);
		if (agent !== void 0) this.sessionAgents.set(toSessionId, agent);
		const parent = this.sessionParents.get(fromSessionId);
		if (parent !== void 0) this.sessionParents.set(toSessionId, parent);
		const addressMode = this.sessionAddressModes.get(fromSessionId);
		if (addressMode !== void 0) this.sessionAddressModes.set(toSessionId, addressMode);
		const prefix = `${fromSessionId}\u0000`;
		for (const [key, value] of this.dshPromptMessageIds) {
			if (!key.startsWith(prefix)) continue;
			this.dshPromptMessageIds.set(`${toSessionId}\u0000${key.slice(prefix.length)}`, value);
		}
		for (const [key, value] of this.promptMessageTimes) {
			if (!key.startsWith(prefix)) continue;
			this.promptMessageTimes.set(`${toSessionId}\u0000${key.slice(prefix.length)}`, value);
		}
		const assistants = this.assistantIdsByUser.get(fromSessionId);
		if (assistants !== void 0) this.assistantIdsByUser.set(toSessionId, new Map(assistants));
	}
	/**
	* Stage a revert boundary. OpenCode's `session.revert.stage` names the
	* message the transcript is cut at and asks for the file changes to be
	* rolled back; the boundary is exclusive, so the named message and
	* everything after it are dropped when the revert commits.
	*/
	stageRevert(sessionId, revert) {
		this.revertBoundaries.set(sessionId, revert);
	}
	clearRevert(sessionId) {
		this.revertBoundaries.delete(sessionId);
	}
	revertBoundary(sessionId) {
		return this.revertBoundaries.get(sessionId);
	}
	/** Drop only history pages (used by the live SSE feed). */
	invalidateHistory(sessionId) {
		const bump = (key) => {
			this.historyGenerations.set(key, (this.historyGenerations.get(key) ?? 0) + 1);
		};
		if (sessionId === void 0) {
			for (const key of [...this.historyCache.keys()]) bump(key);
			for (const key of [...this.historyLoading.keys()]) bump(key);
			this.historyCache.clear();
			this.historyLoading.clear();
			return;
		}
		for (const key of [...this.historyCache.keys()]) if (key === sessionId || key.startsWith(`${sessionId}:`)) {
			bump(key);
			this.historyCache.delete(key);
		}
		for (const key of [...this.historyLoading.keys()]) if (key === sessionId || key.startsWith(`${sessionId}:`)) {
			bump(key);
			this.historyLoading.delete(key);
		}
	}
	static savedKey(sessionId, toolName) {
		return `${sessionId}\u0000${toolName}`;
	}
	savePermission(sessionId, toolName) {
		const saved = {
			sessionId,
			toolName,
			grantedAt: Date.now()
		};
		this.savedPermissions.set(InteractionState.savedKey(sessionId, toolName), saved);
		return saved;
	}
	savedPermissionFor(sessionId, toolName) {
		return this.savedPermissions.get(InteractionState.savedKey(sessionId, toolName));
	}
	savedPermissionsList() {
		return [...this.savedPermissions.values()];
	}
	/** Wire id for `/api/permission/saved/{id}` (unique per session + tool). */
	savedPermissionId(saved) {
		return `${saved.sessionId}:${saved.toolName}`;
	}
	/**
	* Remove one saved grant. Prefers the composite `sessionID:toolName` id;
	* a bare tool name is accepted for compatibility and removes the first
	* matching grant.
	*/
	removeSavedPermission(id) {
		for (const [key, saved] of this.savedPermissions) if (this.savedPermissionId(saved) === id || saved.toolName === id) {
			this.savedPermissions.delete(key);
			return true;
		}
		return false;
	}
	/**
	* Narrow one saved grant. The 2.1 client lets a user change the action or
	* the resource of a remembered permission; the grant is keyed by the
	* session and the tool, so a changed tool name is a new grant.
	*/
	updateSavedPermission(id, change) {
		const key = [...this.savedPermissions.entries()].find(([entryKey, saved]) => entryKey === id || this.savedPermissionId(saved) === id || saved.toolName === id)?.[0];
		if (key === void 0) return void 0;
		const saved = this.savedPermissions.get(key);
		if (saved === void 0) return void 0;
		const toolName = change.resource ?? saved.toolName;
		if (toolName !== saved.toolName) {
			this.savedPermissions.delete(key);
			const next = {
				...saved,
				toolName
			};
			this.savedPermissions.set(InteractionState.savedKey(saved.sessionId, toolName), next);
			return next;
		}
		return saved;
	}
	setSessionModelSelection(sessionId, selection) {
		this.sessionModelSelections.set(sessionId, selection);
	}
	sessionModelSelectionFor(sessionId) {
		return this.sessionModelSelections.get(sessionId);
	}
	/** Per-session inbox projection, created on first touch. */
	inboxProjectionFor(sessionId) {
		let projection = this.inboxProjections.get(sessionId);
		if (projection === void 0) {
			projection = {
				nextTurn: [],
				nextStep: []
			};
			this.inboxProjections.set(sessionId, projection);
		}
		return projection;
	}
	queuedKey(sessionId, messageId) {
		return `${sessionId}\u0000${messageId}`;
	}
	/** Whether a user message id was already surfaced as a queued card. */
	hasPresentedQueued(sessionId, messageId) {
		return this.presentQueuedIds.has(this.queuedKey(sessionId, messageId));
	}
	/** Forget a presented queued id once the same message becomes durable. */
	clearPresentedQueued(sessionId, messageId) {
		this.presentQueuedIds.delete(this.queuedKey(sessionId, messageId));
	}
	/** Remember a durable user message id already broadcast by the prompt route. */
	markBroadcastDshId(sessionId, dshId) {
		this.broadcastDshIds.add(`${sessionId}\u0000${dshId}`);
	}
	/** Whether the durable user message was already broadcast at submission. */
	isBroadcastDshId(sessionId, dshId) {
		return this.broadcastDshIds.has(`${sessionId}\u0000${dshId}`);
	}
	/** Register a TUI-generated message id for the next user echo of a session. */
	registerPromptMessageId(sessionId, promptId, createdAt = Date.now()) {
		const key = this.resolveSessionId(sessionId);
		const queue = this.promptMessageIds.get(key);
		if (queue === void 0) this.promptMessageIds.set(key, [promptId]);
		else queue.push(promptId);
		this.promptMessageTimes.set(`${key}\u0000${promptId}`, createdAt);
	}
	/** Timestamp used by the optimistic user card and its queue-state update. */
	promptMessageCreatedAt(sessionId, promptId) {
		return this.promptMessageTimes.get(`${this.resolveSessionId(sessionId)}\u0000${promptId}`);
	}
	/** Oldest registered prompt id that has not been echoed yet, if any. */
	peekPromptMessageId(sessionId) {
		return this.promptMessageIds.get(this.resolveSessionId(sessionId))?.[0];
	}
	/**
	* Consume the oldest prompt id for a session once its dsh user message
	* arrives; returns the surface id (prompt id when known, else the dsh id).
	*/
	takePromptMessageId(sessionId, dshId) {
		const key = this.resolveSessionId(sessionId);
		const queue = this.promptMessageIds.get(key);
		const promptId = queue?.shift();
		if (queue !== void 0 && queue.length === 0) this.promptMessageIds.delete(key);
		if (promptId === void 0) return dshId;
		this.dshPromptMessageIds.set(`${key}\u0000${dshId}`, promptId);
		return promptId;
	}
	/** Map a durable dsh message id back to its TUI prompt id, if registered. */
	promptIdForDshId(sessionId, dshId) {
		return this.dshPromptMessageIds.get(`${this.resolveSessionId(sessionId)}\u0000${dshId}`);
	}
	/** Reverse lookup: durable dsh id for a bridge/prompt id (user messages). */
	dshIdForPromptId(sessionId, promptId) {
		const prefix = `${this.resolveSessionId(sessionId)}\u0000`;
		for (const [key, value] of this.dshPromptMessageIds) if (key.startsWith(prefix) && value === promptId) return key.slice(prefix.length);
	}
	/** Register the assistant id that will back a user turn's streamed reply. */
	registerAssistantIdForUser(sessionId, userId, assistantId) {
		let byUser = this.assistantIdsByUser.get(sessionId);
		if (byUser === void 0) {
			byUser = /* @__PURE__ */ new Map();
			this.assistantIdsByUser.set(sessionId, byUser);
		}
		byUser.set(userId, assistantId);
	}
	/** Assistant id registered for a user turn, if any. */
	assistantIdForUser(sessionId, userId) {
		return this.assistantIdsByUser.get(sessionId)?.get(userId);
	}
	/** Timestamp that must be retained when history hydrates a live card. */
	assistantMessageCreatedAt(sessionId, assistantId) {
		return this.assistantMessageTimes.get(`${sessionId}\u0000${assistantId}`);
	}
	/** Record the timestamp chosen for a live assistant card. */
	setAssistantMessageCreatedAt(sessionId, assistantId, createdAt) {
		const key = `${sessionId}\u0000${assistantId}`;
		if (!this.assistantMessageTimes.has(key)) this.assistantMessageTimes.set(key, createdAt);
	}
	markAssistantPending(sessionId, assistantId) {
		this.pendingAssistantIds.add(`${sessionId}\u0000${assistantId}`);
	}
	markAssistantCompleted(sessionId, assistantId) {
		this.pendingAssistantIds.delete(`${sessionId}\u0000${assistantId}`);
	}
	isAssistantPending(sessionId, assistantId) {
		return this.pendingAssistantIds.has(`${sessionId}\u0000${assistantId}`);
	}
	clearPendingAssistants(sessionId) {
		const prefix = `${sessionId}\u0000`;
		for (const key of [...this.pendingAssistantIds]) if (key.startsWith(prefix)) this.pendingAssistantIds.delete(key);
	}
	/** Record a dsh->bridge assistant id mapping after a streamed turn. */
	recordAssistantId(sessionId, dshId, bridgeId) {
		this.dshAssistantIds.set(`${sessionId}\u0000${dshId}`, bridgeId);
	}
	/** Map a durable dsh assistant id back to its bridge id, if registered. */
	assistantIdForDshId(sessionId, dshId) {
		return this.dshAssistantIds.get(`${sessionId}\u0000${dshId}`);
	}
	/** Reverse lookup: durable dsh id for a bridge assistant id. */
	dshIdForAssistantId(sessionId, assistantId) {
		const prefix = `${sessionId}\u0000`;
		for (const [key, value] of this.dshAssistantIds) if (key.startsWith(prefix) && value === assistantId) return key.slice(prefix.length);
	}
	/**
	* Apply one durable `agent/inbox/spliced` mutation to the mirrored queue.
	* `added` contains messages that were not yet surfaced to the TUI; `removed`
	* contains messages dropped from the queue (claim or cancellation).
	*/
	applyInboxSplice(sessionId, target, start, removedCount, inserted, enqueuedAt, outcome) {
		const projection = this.inboxProjectionFor(sessionId);
		const list = target === "next-step" ? projection.nextStep : projection.nextTurn;
		const actualStart = Math.max(0, Math.min(start, list.length));
		const actualDelete = Math.max(0, Math.min(removedCount, list.length - actualStart));
		const removed = list.splice(actualStart, actualDelete);
		const added = [];
		for (const message of inserted) {
			const key = this.queuedKey(sessionId, String(message.id));
			if (this.presentQueuedIds.has(key)) continue;
			this.presentQueuedIds.add(key);
			const entry = {
				id: String(message.id),
				...(message.rpcId ?? message.source?.rpcId) === void 0 ? {} : { rpcId: String(message.rpcId ?? message.source?.rpcId) },
				content: message.content,
				source: sourceForQueueItem("queued", message.source),
				enqueuedAt
			};
			added.push(entry);
			list.splice(actualStart + added.length - 1, 0, entry);
		}
		for (const message of removed) if (outcome === "canceled") this.presentQueuedIds.delete(this.queuedKey(sessionId, message.id));
		return {
			added,
			removed
		};
	}
	/**
	* Initialize the inbox projection from the `session/queue` snapshot dsh
	* broadcasts when an SSE mux subscription starts. Later queue snapshots are
	* ignored: they cannot distinguish a claimed message from a cancelled one,
	* so incremental `agent/inbox/spliced` events own the live diff.
	* Returns only the messages that were not yet surfaced to the TUI.
	*/
	initializeInboxProjection(sessionId, items, enqueuedAt, force = false) {
		const previous = this.inboxProjections.get(sessionId);
		const previousItems = previous === void 0 ? [] : [...previous.nextTurn, ...previous.nextStep];
		const previousById = new Map(previousItems.map((item) => [item.id, item]));
		const nextTurn = [];
		const nextStep = [];
		const added = [];
		for (const item of items) {
			const id = String(item.message.id);
			const entry = {
				id,
				...item.rpcId === void 0 ? {} : { rpcId: String(item.rpcId) },
				content: item.message.content,
				source: sourceForQueueItem(item.placement, item.message.source),
				enqueuedAt
			};
			(item.placement === "context" || item.placement === "steering" ? nextStep : nextTurn).push(entry);
			const key = this.queuedKey(sessionId, id);
			if (previousById.has(id) || this.presentQueuedIds.has(key)) this.presentQueuedIds.add(key);
			else {
				this.presentQueuedIds.add(key);
				added.push(entry);
			}
		}
		const nextIds = new Set([...nextTurn, ...nextStep].map((item) => item.id));
		const removed = previousItems.filter((item) => !nextIds.has(item.id));
		if (force) for (const item of removed) this.presentQueuedIds.delete(this.queuedKey(sessionId, item.id));
		this.inboxProjections.set(sessionId, {
			nextTurn,
			nextStep
		});
		return {
			added,
			removed
		};
	}
	setSessionTitle(sessionId, title) {
		if (typeof title === "string" && title.length > 0) this.sessionTitles.set(sessionId, title);
	}
	sessionTitleFor(sessionId) {
		return this.sessionTitles.get(sessionId);
	}
	setSessionAgent(sessionId, agent) {
		if (agent.length > 0) this.sessionAgents.set(sessionId, agent);
	}
	sessionAgentFor(sessionId) {
		return this.sessionAgents.get(sessionId);
	}
	copyPresentationContextTo(target) {
		for (const [id, value] of this.sessionDirectories) target.sessionDirectories.set(id, value);
		for (const [id, value] of this.sessionParents) target.sessionParents.set(id, value);
		for (const [id, value] of this.sessionAddressModes) target.sessionAddressModes.set(id, value);
		for (const id of this.sessionOrigins) target.sessionOrigins.add(id);
		for (const [key, value] of this.subagentCalls) target.subagentCalls.set(key, { ...value });
		for (const [id, value] of this.subagentChildren) target.subagentChildren.set(id, { ...value });
		for (const [id, value] of this.subagentDescriptorFacts) target.subagentDescriptorFacts.set(id, { ...value });
		for (const [id, value] of this.pendingSubagentChildren) target.pendingSubagentChildren.set(id, value.map((child) => ({ ...child })));
		for (const [id, value] of this.sessionTitles) target.sessionTitles.set(id, value);
		for (const [id, value] of this.sessionAgents) target.sessionAgents.set(id, value);
		for (const [id, value] of this.sessionModelSelections) target.sessionModelSelections.set(id, { ...value });
		for (const [id, value] of this.sessionRunning) target.sessionRunning.set(id, value);
		for (const [id, value] of this.sessionStatusUpdatedAt) target.sessionStatusUpdatedAt.set(id, value);
	}
	markStalePresetPrompt(sessionId, from, to) {
		if (from === to) {
			this.stalePresetPrompts.delete(sessionId);
			return;
		}
		this.stalePresetPrompts.set(sessionId, {
			from,
			to
		});
	}
	/** Consume only the one prompt carrying the editor value from before /preset. */
	consumeStalePresetPrompt(sessionId, agent) {
		const pending = this.stalePresetPrompts.get(sessionId);
		if (pending === void 0) return false;
		this.stalePresetPrompts.delete(sessionId);
		return agent !== void 0 && pending.from === agent && pending.to !== agent;
	}
	/** Record that the user submitted new input during this run. */
	markInput() {
		this.newInputDuringRun = true;
	}
	setCurrentSession(sessionId) {
		this.currentSessionId = sessionId;
	}
	/** Agent-preset-lock notices already shown (dedupe per session + agent). */
	lockedAgentNotices = /* @__PURE__ */ new Set();
	lockedAgentNoticeSeen(sessionId, agent) {
		return this.lockedAgentNotices.has(InteractionState.lockedAgentKey(sessionId, agent));
	}
	markLockedAgentNotice(sessionId, agent) {
		this.lockedAgentNotices.add(InteractionState.lockedAgentKey(sessionId, agent));
	}
	static lockedAgentKey(sessionId, agent) {
		return `${sessionId}\u0000${agent}`;
	}
	/** Pending approval decisions keyed by rpcId (answerer → HTTP reply). */
	pendingApprovals = /* @__PURE__ */ new Map();
	/** Pending question decisions keyed by rpcId (answerer → HTTP reply). */
	pendingQuestions = /* @__PURE__ */ new Map();
	registerApproval(entry) {
		this.permissions.set(entry.opencodeId, entry);
		this.byApprovalId.set(entry.approvalId, entry.opencodeId);
		return entry;
	}
	registerQuestion(entry) {
		this.questions.set(entry.opencodeId, entry);
		this.byQuestionRpcId.set(entry.rpcId, entry.opencodeId);
		return entry;
	}
	permissionByOpenCodeId(id) {
		return this.permissions.get(id);
	}
	permissionByApprovalId(approvalId) {
		const opencodeId = this.byApprovalId.get(approvalId);
		return opencodeId === void 0 ? void 0 : this.permissions.get(opencodeId);
	}
	permissionByRpcId(rpcId) {
		for (const entry of this.permissions.values()) if (entry.rpcId === rpcId) return entry;
	}
	questionByOpenCodeId(id) {
		return this.questions.get(id);
	}
	questionByRpcId(rpcId) {
		const opencodeId = this.byQuestionRpcId.get(rpcId);
		return opencodeId === void 0 ? void 0 : this.questions.get(opencodeId);
	}
	removePermission(opencodeId) {
		const entry = this.permissions.get(opencodeId);
		if (entry) this.byApprovalId.delete(entry.approvalId);
		this.permissions.delete(opencodeId);
	}
	removeQuestion(opencodeId) {
		const entry = this.questions.get(opencodeId);
		if (entry) this.byQuestionRpcId.delete(entry.rpcId);
		this.questions.delete(opencodeId);
	}
	/** Resolve and clear every in-flight answerer when the bridge stops. */
	clearPendingInteractions() {
		for (const resolve of this.pendingApprovals.values()) resolve("cancelled");
		this.pendingApprovals.clear();
		for (const resolve of this.pendingQuestions.values()) resolve(void 0);
		this.pendingQuestions.clear();
		this.permissions.clear();
		this.questions.clear();
		this.byApprovalId.clear();
		this.byQuestionRpcId.clear();
	}
	clearSession(sessionId) {
		this.abortShell(sessionId);
		this.shellControllers.delete(sessionId);
		this.clearedSessions.add(sessionId);
		this.sessionDirectories.delete(sessionId);
		this.sessionParents.delete(sessionId);
		this.sessionAddressModes.delete(sessionId);
		this.sessionOrigins.delete(sessionId);
		this.subagentChildren.delete(sessionId);
		this.subagentDescriptorFacts.delete(sessionId);
		for (const [key, call] of this.subagentCalls) if (call.parentSessionId === sessionId || call.childSessionId === sessionId) this.subagentCalls.delete(key);
		this.pendingSubagentChildren.delete(sessionId);
		for (const [parentId, children] of this.pendingSubagentChildren) {
			const remaining = children.filter((child) => child.sessionId !== sessionId);
			if (remaining.length === 0) this.pendingSubagentChildren.delete(parentId);
			else if (remaining.length !== children.length) this.pendingSubagentChildren.set(parentId, remaining);
		}
		this.sessionRunning.delete(sessionId);
		this.sessionStatusUpdatedAt.delete(sessionId);
		this.sessionStatusBroadcast.delete(sessionId);
		this.sessionModelSelections.delete(sessionId);
		this.sessionTitles.delete(sessionId);
		this.sessionAgents.delete(sessionId);
		this.stalePresetPrompts.delete(sessionId);
		this.recentCommandResults.delete(sessionId);
		for (const [key, saved] of this.savedPermissions) if (saved.sessionId === sessionId) this.savedPermissions.delete(key);
		for (const key of [...this.lockedAgentNotices]) if (key.startsWith(`${sessionId}\u0000`)) this.lockedAgentNotices.delete(key);
		this.inboxProjections.delete(sessionId);
		for (const key of [...this.presentQueuedIds]) if (key.startsWith(`${sessionId}\u0000`)) this.presentQueuedIds.delete(key);
		for (const key of [...this.broadcastDshIds]) if (key.startsWith(`${sessionId}\u0000`)) this.broadcastDshIds.delete(key);
		for (const key of [...this.dshPromptMessageIds.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.dshPromptMessageIds.delete(key);
		for (const key of [...this.dshAssistantIds.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.dshAssistantIds.delete(key);
		for (const key of [...this.assistantMessageTimes.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.assistantMessageTimes.delete(key);
		this.clearPendingAssistants(sessionId);
		this.promptMessageIds.delete(sessionId);
		for (const key of [...this.promptMessageTimes.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.promptMessageTimes.delete(key);
		this.assistantIdsByUser.delete(sessionId);
		this.historyCache.delete(sessionId);
		this.inboxProjections.delete(sessionId);
		this.invalidateHistory(sessionId);
		this.removeSessionInteractions(sessionId);
	}
	removeSessionInteractions(sessionId) {
		for (const entry of this.permissionsForSession(sessionId)) this.removePermission(entry.opencodeId);
		for (const entry of this.questionsForSession(sessionId)) this.removeQuestion(entry.opencodeId);
	}
	permissionsForSession(sessionId) {
		return [...this.permissions.values()].filter((entry) => entry.sessionId === sessionId);
	}
	questionsForSession(sessionId) {
		return [...this.questions.values()].filter((entry) => entry.sessionId === sessionId);
	}
};
//#endregion
//#region src/bridge/routes/boot.ts
function registerBootRoutes(register) {
	register("GET", "/api/info", "json", async () => json(200, {
		version: OPENCODE_VERSION,
		pid: process.pid,
		urls: [],
		paths: { tmp: process.env.TMPDIR ?? process.env.TMP ?? "/tmp" }
	}));
	register("GET", "/api/location", "json", async (_req, ctx) => json(200, locationInfo(ctx)));
	register("GET", "/api/agent", "json", async (_req, ctx) => json(200, {
		location: locationInfo(ctx),
		data: await v2AgentList(ctx)
	}));
	register("GET", "/api/command", "json", async (_req, ctx) => json(200, {
		location: locationInfo(ctx),
		data: [
			PRESET_COMMAND_V2,
			GOAL_COMMAND_V2,
			HELP_COMMAND_V2,
			...await skillCommandsV2(ctx, _req.query.get("directory") ?? void 0)
		]
	}));
	register("GET", "/api/skill", "json", async (req, ctx) => json(200, {
		location: locationInfo(ctx),
		data: await skillList(ctx, req.query.get("directory") ?? void 0)
	}));
	register("GET", "/api/reference", "json", async (_req, ctx) => json(200, v2LocationBody(ctx)));
	register("GET", "/api/integration", "json", async (_req, ctx) => json(200, v2LocationBody(ctx)));
	register("GET", "/api/model", "json", async (_req, ctx) => {
		const groups = await modelGroupsForClients(ctx);
		return json(200, {
			location: locationInfo(ctx),
			data: convertToV2Models(groups)
		});
	});
	register("GET", "/api/provider", "json", async (_req, ctx) => {
		const groups = await modelGroupsForClients(ctx);
		return json(200, {
			location: locationInfo(ctx),
			data: convertToV2Providers(groups)
		});
	});
	register("GET", "/api/provider/:providerID", "json", async (req, ctx) => {
		const providerID = req.params.providerID;
		const found = convertToV2Providers(await modelGroupsForClients(ctx)).find((provider) => provider.id === providerID);
		if (found === void 0) throw notFound("provider not found", { providerID });
		return json(200, {
			location: locationInfo(ctx),
			data: found
		});
	});
	register("GET", "/api/permission/request", "json", async (_req, ctx) => json(200, {
		location: locationInfo(ctx),
		data: [...ctx.state.permissions.values()].map(toPermissionV2)
	}));
	register("GET", "/api/question/request", "json", async (_req, ctx) => json(200, {
		location: locationInfo(ctx),
		data: [...ctx.state.questions.values()].map(toQuestionV2)
	}));
	register("GET", "/api/permission/saved", "json", async (_req, ctx) => json(200, { data: ctx.state.savedPermissionsList().map((saved) => ({
		id: ctx.state.savedPermissionId(saved),
		projectID: projectIdFor(ctx.cwd),
		action: permissionActionFromTool(saved.toolName),
		resource: saved.toolName,
		sessionID: saved.sessionId,
		grantedAt: saved.grantedAt
	})) }));
	register("DELETE", "/api/permission/saved/:permissionID", "json", async (req, ctx) => {
		const permissionID = req.params.permissionID;
		if (!ctx.state.removeSavedPermission(permissionID)) throw notFound("saved permission not found", { permissionID });
		return json(204);
	});
	register("PATCH", "/api/permission/saved/:permissionID", "json", async (req, ctx) => {
		const permissionID = req.params.permissionID;
		const body = bodyAsRecord(req.body);
		const saved = ctx.state.updateSavedPermission(permissionID, {
			...typeof body.action === "string" ? { action: body.action } : {},
			...typeof body.resource === "string" ? { resource: body.resource } : {}
		});
		if (saved === void 0) throw notFound("saved permission not found", { permissionID });
		return json(200, { data: {
			id: ctx.state.savedPermissionId(saved),
			projectID: projectIdFor(ctx.cwd),
			action: permissionActionFromTool(saved.toolName),
			resource: saved.toolName,
			sessionID: saved.sessionId,
			grantedAt: saved.grantedAt
		} });
	});
	register("GET", "/api/health", "json", async () => json(200, { healthy: true }));
	register("GET", "/global/health", "json", async () => json(200, {
		healthy: true,
		version: OPENCODE_VERSION
	}));
	register("POST", "/global/dispose", "json", async () => json(200, true));
	register("POST", "/instance/dispose", "json", async () => json(200, true));
	register("POST", "/experimental/session/:sessionID/background", "json", async () => json(200, true));
}
//#endregion
//#region src/bridge/fs.ts
const MAX_READ_BYTES = 5242880;
const MAX_FIND_RESULTS = 500;
const SKIP_DIRS = /* @__PURE__ */ new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".e2e",
	".next",
	".nuxt",
	".venv",
	"venv",
	"__pycache__",
	".dsh"
]);
const TEXT_EXTENSIONS$1 = /* @__PURE__ */ new Set([
	"txt",
	"md",
	"markdown",
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"yml",
	"yaml",
	"toml",
	"xml",
	"html",
	"css",
	"scss",
	"py",
	"sh",
	"bash",
	"zsh",
	"rs",
	"go",
	"java",
	"c",
	"h",
	"cpp",
	"hpp",
	"sql",
	"log",
	"ini",
	"cfg",
	"env",
	"csv",
	"tsv"
]);
const IMAGE_CONTENT_TYPES = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	ico: "image/x-icon"
};
/** Content-Type for one workspace file path (best effort by extension). */
function contentTypeFor(path) {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if (TEXT_EXTENSIONS$1.has(ext)) return "text/plain; charset=utf-8";
	return IMAGE_CONTENT_TYPES[ext] ?? "application/octet-stream";
}
/**
* Resolve a user-supplied relative path inside `cwd`; any path that escapes
* the workspace is rejected before touching the filesystem.
*/
function resolveWithin(cwd, raw) {
	const root = resolve(cwd);
	const target = resolve(root, raw === "" ? "." : raw);
	const rel = relative(root, target);
	if (rel.startsWith("..") || isAbsolute(rel)) throw badRequest("path escapes the workspace", { path: raw });
	return target;
}
/** Read one file inside the workspace as raw bytes (bounded size). */
function readFileWithin(cwd, raw) {
	const target = resolveWithin(cwd, raw);
	let stat;
	try {
		stat = statSync(target);
	} catch {
		throw notFound("file not found", { path: raw });
	}
	if (!stat.isFile()) throw badRequest("not a file", { path: raw });
	if (stat.size > MAX_READ_BYTES) throw badRequest("file exceeds the 5 MiB read limit", {
		path: raw,
		size: stat.size
	});
	try {
		return readFileSync(target);
	} catch (error) {
		throw badRequest("file unreadable", {
			path: raw,
			reason: error instanceof Error ? error.message : String(error)
		});
	}
}
function entryPath(root, target) {
	return relative(root, target).split("\\").join("/");
}
/** List direct children of one workspace-relative directory. */
function listDirWithin(cwd, raw) {
	const root = resolve(cwd);
	const target = resolveWithin(cwd, raw);
	let stat;
	try {
		stat = statSync(target);
	} catch {
		throw notFound("directory not found", { path: raw });
	}
	if (!stat.isDirectory()) throw badRequest("not a directory", { path: raw });
	let entries;
	try {
		entries = readdirSync(target, { withFileTypes: true });
	} catch (error) {
		throw badRequest("directory unreadable", {
			path: raw,
			reason: error instanceof Error ? error.message : String(error)
		});
	}
	return entries.map((entry) => ({
		path: entryPath(root, join(target, entry.name)),
		type: entry.isDirectory() ? "directory" : "file"
	})).sort((a, b) => {
		if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
		return a.path.localeCompare(b.path);
	});
}
/**
* Recursive name/path search inside the workspace. Skips common dependency
* and build directories and hard-bounds the result count.
*/
function findWithin(cwd, query, type, limit = 100) {
	const root = resolve(cwd);
	const needle = query.trim().toLowerCase();
	const max = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 100, MAX_FIND_RESULTS));
	const results = [];
	if (needle === "") return results;
	const walk = (dir) => {
		if (results.length >= max) return false;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return true;
		}
		const ordered = [...entries].sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of ordered) {
			if (results.length >= max) return false;
			if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
			const entryType = entry.isDirectory() ? "directory" : "file";
			const path = entryPath(root, join(dir, entry.name));
			if ((type === void 0 || entryType === type) && path.toLowerCase().includes(needle)) results.push({
				path,
				type: entryType
			});
			if (entry.isDirectory() && !walk(join(dir, entry.name))) return false;
		}
		return true;
	};
	walk(root);
	return results;
}
//#endregion
//#region src/bridge/routes/fs.ts
function registerFsRoutes(register) {
	register("GET", "/api/fs/read/*", "json", async (req, ctx) => {
		const raw = decodeURIComponent(req.params["*"] ?? "");
		return {
			status: 200,
			raw: readFileWithin(ctx.cwd, raw),
			headers: { "Content-Type": contentTypeFor(raw) }
		};
	});
	register("GET", "/api/fs/list", "json", async (req, ctx) => {
		const raw = req.query.get("path") ?? "";
		return json(200, {
			location: locationInfo(ctx),
			data: listDirWithin(ctx.cwd, raw)
		});
	});
	register("GET", "/api/fs/find", "json", async (req, ctx) => {
		const query = req.query.get("query") ?? "";
		const typeRaw = req.query.get("type");
		const type = typeRaw === "file" || typeRaw === "directory" ? typeRaw : void 0;
		const limitRaw = req.query.get("limit");
		const limit = limitRaw === null ? void 0 : Number(limitRaw);
		return json(200, {
			location: locationInfo(ctx),
			data: findWithin(ctx.cwd, query, type, limit)
		});
	});
}
//#endregion
//#region src/bridge/routes/session-v2.ts
/** Convert one bridge-only command card to the 2.x message shape. */
function commandResultToV2(entry) {
	const info = entry.info;
	const rawTime = info.time;
	const created = typeof rawTime?.created === "number" ? rawTime.created : 0;
	const completed = typeof rawTime?.completed === "number" ? rawTime.completed : void 0;
	const rawModel = info.model;
	const providerID = typeof rawModel?.providerID === "string" ? rawModel.providerID : typeof info.providerID === "string" ? info.providerID : void 0;
	const modelID = typeof rawModel?.modelID === "string" ? rawModel.modelID : typeof info.modelID === "string" ? info.modelID : void 0;
	const model = providerID !== void 0 && modelID !== void 0 ? {
		id: modelID,
		providerID,
		...typeof rawModel?.variant === "string" ? { variant: rawModel.variant } : typeof info.variant === "string" ? { variant: info.variant } : {}
	} : void 0;
	const text = entry.parts.map((part) => part.type === "text" && "text" in part ? String(part.text) : "").join("");
	if (info.role === "user") return {
		id: String(info.id),
		time: { created },
		text,
		type: "user",
		...typeof info.agent === "string" ? { agent: info.agent } : {},
		...model === void 0 ? {} : { model }
	};
	const toolPart = entry.parts.find((part) => part.type === "tool");
	if (toolPart !== void 0) {
		const state = toolPart.state ?? {};
		const output = typeof state.output === "string" ? state.output : typeof state.metadata?.output === "string" ? String(state.metadata.output) : "";
		const status = state.status === "error" ? "error" : state.status === "running" ? "running" : "completed";
		const content = output === "" ? [] : [{
			type: "text",
			text: output
		}];
		return {
			id: String(info.id),
			time: completed === void 0 ? { created } : {
				created,
				completed
			},
			type: "assistant",
			agent: typeof info.agent === "string" ? info.agent : "build",
			model: {
				id: typeof info.modelID === "string" ? info.modelID : "deepseek-chat",
				providerID: typeof info.providerID === "string" ? info.providerID : "deepseek",
				...typeof info.variant === "string" ? { variant: info.variant } : {}
			},
			content: [{
				type: "tool",
				id: String(toolPart.id ?? `tool:${String(toolPart.callID ?? "")}`),
				name: typeof toolPart.tool === "string" ? toolPart.tool : "bash",
				time: {
					created,
					...completed === void 0 ? {} : { completed }
				},
				state: {
					status,
					input: state.input ?? {},
					content,
					structured: {},
					...status === "error" ? { error: {
						type: "unknown",
						message: String(state.error ?? output ?? "shell failed")
					} } : {}
				}
			}]
		};
	}
	return {
		id: String(info.id),
		time: completed === void 0 ? { created } : {
			created,
			completed
		},
		type: "assistant",
		agent: typeof info.agent === "string" ? info.agent : "build",
		model: {
			id: typeof info.modelID === "string" ? info.modelID : "deepseek-chat",
			providerID: typeof info.providerID === "string" ? info.providerID : "deepseek",
			...typeof info.variant === "string" ? { variant: info.variant } : {}
		},
		content: text === "" ? [] : [{
			type: "text",
			text
		}]
	};
}
/** Insert bridge-only cards without reordering durable converter output. */
function mergeCommandResultsV2(entries, commandResults) {
	if (commandResults.length === 0) return;
	const seen = new Set(entries.map((entry) => String(entry.id ?? "")));
	for (const source of commandResults) {
		const entry = commandResultToV2(source);
		if (seen.has(String(entry.id ?? ""))) continue;
		seen.add(String(entry.id ?? ""));
		const createdAt = entry.time.created;
		const index = entries.findIndex((candidate) => candidate.time.created > createdAt);
		entries.splice(index === -1 ? entries.length : index, 0, entry);
	}
}
function remapV2Messages(ctx, sessionId, messages) {
	const remapped = [];
	for (const message of messages) {
		const promptId = ctx.state.promptIdForDshId(sessionId, message.id);
		const assistantId = promptId === void 0 ? ctx.state.assistantIdForDshId(sessionId, message.id) : void 0;
		const surfaceId = promptId ?? assistantId;
		const sessionAgent = ctx.state.sessionAgentFor(sessionId);
		const messageType = "type" in message ? message.type : void 0;
		const synthetic = String(message.id).startsWith("msg_cmd:") || String(message.id).startsWith("msg_preset:") || String(message.id).startsWith("msg_shell:");
		if (surfaceId === void 0 && sessionAgent === void 0) {
			remapped.push(message);
			continue;
		}
		let result;
		if (!("content" in message) || !Array.isArray(message.content)) result = {
			...message,
			...surfaceId === void 0 ? {} : { id: surfaceId },
			...!synthetic && sessionAgent !== void 0 && (messageType === "assistant" || messageType === "user") ? { agent: sessionAgent } : {}
		};
		else {
			const content = message.content.map((part) => ({
				...part,
				...surfaceId === void 0 ? {} : {
					id: String(part.id ?? "").replaceAll(message.id, surfaceId),
					messageID: surfaceId
				}
			}));
			result = {
				...message,
				...surfaceId === void 0 ? {} : { id: surfaceId },
				...!synthetic && sessionAgent !== void 0 && (messageType === "assistant" || messageType === "user") ? { agent: sessionAgent } : {},
				content
			};
		}
		if (assistantId !== void 0) {
			const created = ctx.state.assistantMessageCreatedAt(sessionId, assistantId);
			if (created !== void 0 && result.type === "assistant") {
				const time = {
					...result.time,
					created
				};
				if (ctx.state.isAssistantPending(sessionId, assistantId)) delete time.completed;
				result = {
					...result,
					time
				};
			}
		}
		if (promptId !== void 0 && result.type === "user") {
			const created = ctx.state.promptMessageCreatedAt(sessionId, promptId);
			if (created !== void 0) result = {
				...result,
				time: {
					...result.time,
					created
				}
			};
		}
		if (surfaceId !== void 0 && result.type === "assistant") {
			const existing = remapped.find((candidate) => candidate.id === surfaceId);
			if (existing !== void 0 && "content" in existing && Array.isArray(existing.content) && "content" in result && Array.isArray(result.content)) {
				existing.content.push(...result.content);
				continue;
			}
		}
		remapped.push(result);
	}
	return remapped;
}
function promptText(content) {
	return content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}
function registerSessionV2Routes(register) {
	register("GET", "/api/session", "json", async (req, ctx) => {
		const search = req.query.get("search");
		let all;
		if (search !== null && search.length > 0) {
			const results = await rpc(ctx, "session.search", { query: search });
			const ids = new Set(results.items.map((item) => String(item.sessionId)));
			all = (await cachedSessionList(ctx)).filter((item) => ids.has(String(item.sessionId)));
		} else all = await cachedSessionList(ctx);
		const replaced = new Set(ctx.state.aliasedSessionIds());
		const filtered = filterSessionsByDirectory(all.filter((item) => !replaced.has(String(item.sessionId))).map((item) => ({
			item,
			dshId: String(item.sessionId)
		})).map((entry) => entry.item), req.query.get("directory") ?? void 0, ctx.cwd);
		const limitRaw = req.query.get("limit");
		const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100;
		const cursorRaw = req.query.get("cursor");
		const offset = cursorRaw === null ? 0 : decodeSessionCursor(cursorRaw);
		const page = (req.query.get("order") === "asc" ? [...filtered].reverse() : filtered).slice(offset, offset + limit);
		const nextOffset = offset + page.length;
		recordSessionSummaries(ctx, page);
		await warmListTitles(ctx, page);
		return json(200, {
			data: page.map((item) => {
				const dshId = String(item.sessionId);
				const opencodeId = ctx.state.openCodeIdFor(dshId);
				return {
					...convertSessionSummaryV2(item, {
						cwd: ctx.state.sessionDirectories.get(dshId) ?? ctx.cwd,
						title: ctx.state.sessionTitleFor(dshId),
						...ctx.state.sessionAgentFor(dshId) === void 0 ? {} : { agent: ctx.state.sessionAgentFor(dshId) }
					}),
					id: opencodeId
				};
			}),
			cursor: {
				...nextOffset < filtered.length ? { next: encodeSessionCursor(nextOffset) } : {},
				...offset > 0 ? { previous: encodeSessionCursor(Math.max(0, offset - limit)) } : {}
			}
		});
	});
	register("GET", "/experimental/session", "json", async (req, ctx) => {
		const search = req.query.get("search");
		let all = await cachedSessionList(ctx);
		if (search !== null && search.length > 0) {
			const results = await rpc(ctx, "session.search", { query: search });
			const ids = new Set(results.items.map((item) => String(item.sessionId)));
			all = all.filter((item) => ids.has(String(item.sessionId)));
		}
		const filtered = filterSessionsByDirectory(all, req.query.get("directory") ?? void 0, ctx.cwd);
		const limitRaw = req.query.get("limit");
		const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100;
		const page = filtered.slice(0, limit);
		recordSessionSummaries(ctx, page);
		await warmListTitles(ctx, page);
		return json(200, page.map((item) => convertSessionSummary(item, {
			cwd: ctx.state.sessionDirectories.get(String(item.sessionId)) ?? ctx.cwd,
			title: ctx.state.sessionTitleFor(String(item.sessionId)),
			...ctx.state.sessionAgentFor(String(item.sessionId)) === void 0 ? {} : { agent: ctx.state.sessionAgentFor(String(item.sessionId)) }
		})));
	});
	register("POST", "/api/session", "json", (req, ctx) => createSession(req, ctx));
	register("GET", "/api/session/active", "json", async (_req, ctx) => {
		const id = ctx.state.currentSessionId;
		if (id === void 0) return json(200, { data: {} });
		const item = (await cachedSessionList(ctx)).find((entry) => String(entry.sessionId) === id);
		if (item === void 0 || !item.running) return json(200, { data: {} });
		return json(200, { data: { [id]: { type: "running" } } });
	});
	register("POST", "/api/session/:sessionID/wait", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const deadline = Date.now() + 3e4;
		while (Date.now() < deadline) {
			const item = (await rpc(ctx, "session.list", {})).items.find((entry) => String(entry.sessionId) === id);
			if (item === void 0) throw notFound("session not found", { sessionID: id });
			if (!item.running) return json(204);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		return json(503, {
			name: "ServiceUnavailableError",
			message: "session still busy"
		});
	});
	register("POST", "/api/session/:sessionID/fork", "json", (req, ctx) => forkSession(req, ctx));
	register("POST", "/api/session/:sessionID/compact", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		await runCompactCommand(ctx, id);
		return json(200, { data: {
			id: `msg_${randomUUID()}`,
			sessionID: id,
			time: { created: Date.now() },
			type: "compaction",
			payload: {},
			delivery: "queue"
		} });
	});
	register("POST", "/api/session/:sessionID/prompt", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const body = bodyAsRecord(req.body);
		await commitStagedRevert(ctx, id);
		const content = Array.isArray(body.parts) ? parsePromptParts(body.parts, ctx.cwd) : parseV2PromptInput(body, ctx.cwd);
		const slash = slashPromptCapture(content);
		if (slash !== void 0) {
			const outcome = await runSlashCommand(ctx, id, slash);
			if (outcome.kind === "error") throw badRequest(outcome.text, { code: "command-error" });
			return json(200, { data: {
				id: `msg_${randomUUID()}`,
				sessionID: id,
				time: { created: Date.now() },
				type: "user",
				payload: { text: promptText(content) },
				delivery: "queue"
			} });
		}
		const rawPromptID = typeof body.id === "string" && body.id.length > 0 ? body.id : typeof body.messageID === "string" && body.messageID.length > 0 ? body.messageID : `msg_${randomUUID()}`;
		const createdAt = Date.now();
		const promptUserID = rawPromptID;
		ctx.state.registerPromptMessageId(id, promptUserID, createdAt);
		const assistantID = `msg_${randomUUID()}`;
		ctx.state.registerAssistantIdForUser(id, promptUserID, assistantID);
		await applyAgentFromBody(ctx, id, req.body);
		if (!await applyModelSelection(ctx, id, req.body)) await reconcileModelSelection(ctx, id);
		await broadcastPromptUserMessage(ctx, id, promptUserID, promptText(content), createdAt, promptModelRef(ctx, id, req.body), body.delivery === "queue" ? "queue" : "steer");
		const delivery = body.delivery === "queue" ? "queue" : "steer";
		await rpc(ctx, "session.prompt", {
			sessionId: sid(id),
			requestId: promptUserID,
			mode: delivery,
			content
		});
		ctx.state.markInput();
		ctx.state.invalidateSession(id);
		return json(200, { data: {
			id: promptUserID,
			sessionID: id,
			time: { created: createdAt },
			type: "user",
			payload: { text: promptText(content) },
			delivery
		} });
	});
	register("GET", "/api/session/:sessionID", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		return json(200, { data: toV2Session(await sessionView(ctx, id), id, ctx) });
	});
	register("POST", "/api/session/:sessionID/model", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		try {
			await applyModelSelection(ctx, id, req.body);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/model-unavailable|Select an available model/i.test(message)) throw badRequest(`model is not available: ${message} The provider has no usable credential; set its API key (for the DeepSeek route, DEEPSEEK_API_KEY) and restart dsh.`, {
				code: "session/model-unavailable",
				sessionID: id
			});
			throw error;
		}
		return json(204);
	});
	register("GET", "/api/session/:sessionID/event", "sse", async () => ({ status: 200 }));
	register("POST", "/api/session/:sessionID/agent", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const agent = typeof bodyAsRecord(req.body).agent === "string" ? bodyAsRecord(req.body).agent : "";
		if (agent === "") throw badRequest("agent switch requires a string agent");
		await switchAgentPreset(ctx, id, agent);
		broadcastSessionAgent(ctx, id, agent);
		ctx.state.invalidateSession(id);
		return json(204);
	});
	register("POST", "/api/session/:sessionID/interrupt", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		abortShellCommand(ctx, id);
		await rpc(ctx, "session.cancel", { sessionId: sid(id) });
		return json(200, { interrupted: true });
	});
	register("GET", "/api/session/:sessionID/message", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const limitRaw = req.query.get("limit");
		const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : void 0;
		const cursorRaw = req.query.get("cursor");
		const history = await cachedSessionHistory(ctx, id, {
			maxMessages: limit,
			beforeSeq: cursorRaw === null ? void 0 : decodeMessageCursor(cursorRaw)
		});
		await ensureSubagentHistoryContext(ctx, id, history.events);
		const defaultModel = await sessionModelRef(ctx, id);
		const entries = history.events;
		const oldest = oldestSurfaceSeq(entries);
		const data = convertMessagesV2(entries.map((entry) => entry.event), {
			sessionId: id,
			cwd: ctx.cwd,
			defaultModel,
			subagentForCall: (call) => subagentMetadataForHistory(ctx, id, call),
			onSkip: (type, reason) => ctx.log(`[bridge/messages-v2] ${type}: ${reason}`)
		}, entries.map((entry) => entry.view));
		mergeCommandResultsV2(data, ctx.state.commandResultsFor(id));
		const remapped = remapV2Messages(ctx, id, data);
		mergePendingAssistantV2(ctx, id, remapped);
		return json(200, {
			data: req.query.get("order") === "desc" ? remapped.reverse() : remapped,
			cursor: { ...history.hasMore && oldest !== void 0 ? { previous: encodeMessageCursor(oldest) } : {} }
		});
	});
	register("GET", "/api/session/:sessionID/history", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const limitRaw = req.query.get("limit");
		const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100;
		const afterRaw = req.query.get("after");
		const after = afterRaw === null ? void 0 : Number(afterRaw);
		if (after !== void 0 && (!Number.isInteger(after) || after < 0)) throw badRequest("after must be a non-negative integer");
		const history = await cachedSessionHistory(ctx, id, {
			maxMessages: limit,
			...after === void 0 ? {} : { beforeSeq: after }
		});
		await ensureSubagentHistoryContext(ctx, id, history.events);
		const defaultModel = await sessionModelRef(ctx, id);
		const entries = history.events;
		const anchorSeqs = [];
		const withSeq = convertMessagesV2(entries.map((entry) => entry.event), {
			sessionId: id,
			cwd: ctx.cwd,
			defaultModel,
			subagentForCall: (call) => subagentMetadataForHistory(ctx, id, call),
			onSkip: (type, reason) => ctx.log(`[bridge/history-v2] ${type}: ${reason}`)
		}, entries.map((entry) => entry.view), anchorSeqs).map((message, index) => ({
			message,
			seq: anchorSeqs[index] ?? 0
		}));
		const oldest = withSeq.reduce((min, entry) => Math.min(min, entry.seq), Number.MAX_SAFE_INTEGER);
		const next = !history.hasMore || withSeq.length === 0 ? null : oldest;
		return json(200, {
			data: remapV2Messages(ctx, id, withSeq.map((entry) => entry.message)),
			hasMore: history.hasMore,
			next
		});
	});
	register("GET", "/api/session/:sessionID/context", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const history = await cachedSessionHistory(ctx, id, { maxMessages: 500 });
		await ensureSubagentHistoryContext(ctx, id, history.events);
		const defaultModel = await sessionModelRef(ctx, id);
		const entries = history.events;
		return json(200, { data: convertMessagesV2(entries.map((entry) => entry.event), {
			sessionId: id,
			cwd: ctx.cwd,
			defaultModel,
			subagentForCall: (call) => subagentMetadataForHistory(ctx, id, call),
			onSkip: (type, reason) => ctx.log(`[bridge/messages-v2] ${type}: ${reason}`)
		}, entries.map((entry) => entry.view)) });
	});
	register("GET", "/api/session/:sessionID/message/:messageID", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const messageID = req.params.messageID;
		const history = await cachedSessionHistory(ctx, id, { maxMessages: 500 });
		await ensureSubagentHistoryContext(ctx, id, history.events);
		const defaultModel = await sessionModelRef(ctx, id);
		const entries = history.events;
		const remapped = remapV2Messages(ctx, id, convertMessagesV2(entries.map((entry) => entry.event), {
			sessionId: id,
			cwd: ctx.cwd,
			defaultModel,
			subagentForCall: (call) => subagentMetadataForHistory(ctx, id, call),
			onSkip: (type, reason) => ctx.log(`[bridge/messages-v2] ${type}: ${reason}`)
		}, entries.map((entry) => entry.view)));
		mergePendingAssistantV2(ctx, id, remapped);
		const found = remapped.find((message) => message.id === messageID);
		if (found === void 0) throw notFound("message not found", { messageID });
		return json(200, { data: found });
	});
	register("GET", "/api/session/:sessionID/diff", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const history = await cachedSessionHistory(ctx, id);
		return json(200, { data: filterGitTrackedDiffs(ctx.cwd, historyFileDiffs(history)) });
	});
	register("GET", "/api/session/:sessionID/permission", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		return json(200, { data: ctx.state.permissionsForSession(id).map(toPermissionV2) });
	});
	register("GET", "/api/session/:sessionID/permission/:requestID", "json", async (req, ctx) => {
		const sessionID = req.params.sessionID;
		const requestID = req.params.requestID;
		const entry = ctx.state.permissionByOpenCodeId(requestID);
		if (entry === void 0 || entry.sessionId !== sessionID) throw notFound("permission request not found", { requestID });
		return json(200, { data: toPermissionV2(entry) });
	});
	register("POST", "/api/session/:sessionID/permission/:requestID/reply", "json", async (req, ctx) => {
		const requestID = req.params.requestID;
		await permissionReply(ctx, requestID, req.body);
		return json(204);
	});
	register("GET", "/api/session/:sessionID/question", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		return json(200, { data: ctx.state.questionsForSession(id).map(toQuestionV2) });
	});
	register("POST", "/api/session/:sessionID/question/:requestID/reply", "json", async (req, ctx) => {
		const requestID = req.params.requestID;
		await questionReply(ctx, requestID, req.body);
		return json(204);
	});
	register("POST", "/api/session/:sessionID/question/:requestID/reject", "json", async (req, ctx) => {
		const requestID = req.params.requestID;
		await questionReject(ctx, requestID);
		return json(204);
	});
	register("POST", "/api/session/:sessionID/revert/stage", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const body = bodyAsRecord(req.body);
		const messageID = typeof body.messageID === "string" ? body.messageID : "";
		if (messageID.length === 0) throw badRequest("revert stage needs a message id", { sessionID: id });
		const location = await locateMessage(ctx, id, messageID);
		const boundary = {
			turn: location.turn,
			includeTurn: location.role === "user"
		};
		const dshId = ctx.state.resolveSessionId(id);
		const files = ctx.api.rewind?.filesAfter(dshId, boundary) ?? [];
		const restored = ctx.api.rewind?.restoreFilesAfter(dshId, boundary) ?? [];
		if (restored.length > 0) ctx.log(`[bridge/revert] rolled ${restored.length} file(s) back for session ${id}`);
		ctx.state.stageRevert(id, {
			messageID,
			turn: boundary.turn,
			includeTurn: boundary.includeTurn,
			files
		});
		const revert = {
			messageID,
			...files.length === 0 ? {} : { files }
		};
		publishV2Event(ctx, "session.revert.staged", {
			sessionID: id,
			revert
		}, id);
		return json(200, { data: revert });
	});
	register("DELETE", "/api/session/:sessionID/revert", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const staged = ctx.state.revertBoundary(id);
		ctx.state.clearRevert(id);
		if (staged === void 0) return json(204);
		const restored = ctx.api.rewind?.undoRestore(ctx.state.resolveSessionId(id)) ?? [];
		if (restored.length > 0) ctx.log(`[bridge/revert] put ${restored.length} file(s) back for session ${id}`);
		publishV2Event(ctx, "session.revert.cleared", { sessionID: id }, id);
		return json(204);
	});
	register("POST", "/api/session/:sessionID/revert/commit", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		await commitStagedRevert(ctx, id);
		return json(204);
	});
}
//#endregion
//#region src/bridge/routes/session-v2-extra.ts
/** One dsh question rendered as a v2 form field. */
function questionToFormFields(entry) {
	return entry.items.map((item) => ({
		key: item.id,
		title: item.header ?? item.question,
		...item.detail === void 0 ? {} : { description: item.detail },
		type: item.multiSelect === true ? "multiselect" : "string",
		required: true,
		options: (item.options ?? []).map((option) => ({
			value: option.label,
			label: option.label,
			...option.description === void 0 ? {} : { description: option.description }
		}))
	}));
}
/** Title shown for a form that has no backing dsh question. */
const DEFAULT_FORM_TITLE = "Form";
function registerSessionV2ExtraRoutes(register) {
	register("PATCH", "/api/session/:sessionID", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const body = bodyAsRecord(req.body);
		const title = typeof body.title === "string" ? body.title : void 0;
		if (title !== void 0) {
			await rpc(ctx, "session.rename", {
				sessionId: sid(id),
				title
			});
			ctx.state.setSessionTitle(id, title);
		}
		if (body.metadata !== void 0 || body.permissions !== void 0) ctx.log(`[bridge/session-v2] session ${id} metadata/permissions are not persisted by dsh`);
		ctx.state.invalidateSession(id);
		return json(204);
	});
	register("DELETE", "/api/session/:sessionID", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		ctx.state.invalidateSession(id);
		ctx.log(`[bridge/session-v2] remove is not supported by dsh; the durable record stays (session ${id})`);
		return json(204);
	});
	register("POST", "/api/session/:sessionID/command", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const body = bodyAsRecord(req.body);
		const name = typeof body.name === "string" ? body.name.replace(/^\//, "") : "";
		const text = typeof body.text === "string" ? body.text : "";
		if (name === "") throw badRequest("session command requires a name");
		if (name === "preset") {
			const outcome = await runPresetCommand(ctx, id, text.trim());
			if (outcome.kind === "error") throw badRequest(outcome.text, { code: "command-error" });
			return json(204);
		}
		if (name === "goal") {
			const outcome = await runGoalCommand(ctx, id, text);
			if (outcome.kind === "error") throw badRequest(outcome.text, { code: "command-error" });
			return json(204);
		}
		if (name === "help") {
			const outcome = runHelpCommand(ctx, id, text);
			if (outcome.kind === "error") throw badRequest(outcome.text, { code: "command-error" });
			return json(204);
		}
		if ((await skillListForSession(ctx, id)).some((skill) => skill.name === name)) {
			const prompt = text.trim() === "" ? `/${name}` : `/${name} ${text.trim()}`;
			await rpc(ctx, "session.prompt", {
				sessionId: sid(id),
				mode: "steer",
				content: [{
					type: "text",
					text: prompt
				}]
			});
			ctx.state.invalidateSession(id);
			return json(204);
		}
		throw badRequest(`unsupported command "${name}"`);
	});
	register("POST", "/api/session/:sessionID/synthetic", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const body = bodyAsRecord(req.body);
		const text = typeof body.text === "string" ? body.text : "";
		if (text.trim() === "") throw badRequest("synthetic message requires text");
		const description = typeof body.description === "string" ? body.description : void 0;
		const messageID = typeof body.id === "string" && body.id.length > 0 ? body.id : `msg_${randomUUID()}`;
		const createdAt = Date.now();
		ctx.state.registerPromptMessageId(id, messageID, createdAt);
		await broadcastPromptUserMessage(ctx, id, messageID, text, createdAt, promptModelRef(ctx, id, req.body));
		await rpc(ctx, "session.prompt", {
			sessionId: sid(id),
			requestId: messageID,
			mode: "queue",
			content: [{
				type: "text",
				text
			}]
		});
		ctx.state.markInput();
		ctx.state.invalidateSession(id);
		return json(200, { data: {
			id: messageID,
			sessionID: id,
			time: { created: createdAt },
			type: "synthetic",
			payload: {
				text,
				...description === void 0 ? {} : { description }
			},
			delivery: "queue"
		} });
	});
	register("POST", "/api/session/:sessionID/shell", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const body = bodyAsRecord(req.body);
		const command = typeof body.command === "string" ? body.command : "";
		if (command.trim() === "") throw badRequest("shell request requires a non-empty command");
		const agent = (typeof body.agent === "string" && body.agent.trim() !== "" ? body.agent.trim() : void 0) ?? ctx.state.sessionAgentFor(id);
		if (agent === void 0) throw badRequest("shell request requires a non-empty agent");
		const workdir = req.query.get("directory");
		await runShellCommand(ctx, id, {
			command,
			agent,
			...workdir === null ? {} : { workdir }
		});
		return json(204);
	});
	register("POST", "/api/session/:sessionID/move", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const body = bodyAsRecord(req.body);
		const directory = typeof body.directory === "string" ? body.directory : "";
		ctx.log(`[bridge/session-v2] move is not supported by dsh; the working directory is unchanged (session ${id} -> ${directory})`);
		return json(204);
	});
	register("GET", "/api/session/:sessionID/inbox", "json", async (_req, _ctx) => {
		return json(200, { data: [] });
	});
	register("GET", "/api/session/:sessionID/form", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		return json(200, { data: ctx.state.questionsForSession(id).map(toQuestionV2) });
	});
	register("POST", "/api/session/:sessionID/form", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const body = bodyAsRecord(req.body);
		const title = typeof body.title === "string" && body.title.length > 0 ? body.title : DEFAULT_FORM_TITLE;
		const fields = Array.isArray(body.fields) ? body.fields : [];
		return json(200, { data: {
			id: `form-${randomUUID()}`,
			sessionID: id,
			title,
			fields
		} });
	});
	register("GET", "/api/session/:sessionID/form/:formID", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const formID = req.params.formID;
		const question = ctx.state.questionByOpenCodeId(formID);
		return json(200, { data: {
			id: formID,
			sessionID: id,
			title: question === void 0 ? DEFAULT_FORM_TITLE : question.items[0]?.header ?? question.items[0]?.question ?? DEFAULT_FORM_TITLE,
			fields: question === void 0 ? [] : questionToFormFields(question),
			state: { status: "pending" }
		} });
	});
	register("POST", "/api/session/:sessionID/form/:formID/reply", "json", async (req, ctx) => {
		const formID = req.params.formID;
		if (ctx.state.questionByOpenCodeId(formID) === void 0) throw notFound("form not found", { formID });
		await questionReply(ctx, formID, req.body);
		return json(204);
	});
	register("DELETE", "/api/session/:sessionID/form/:formID", "json", async (req, ctx) => {
		const formID = req.params.formID;
		await questionReject(ctx, formID);
		return json(204);
	});
	register("PUT", "/api/session/:sessionID/environment", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		ctx.log(`[bridge/session-v2] per-session environment is not supported by dsh (session ${id})`);
		return json(204);
	});
	register("POST", "/api/session/:sessionID/view", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		ctx.log(`[bridge/session-v2] viewed timestamps are not tracked by dsh (session ${id})`);
		return json(204);
	});
	register("POST", "/api/session/:sessionID/background", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		ctx.log(`[bridge/session-v2] background sessions are not supported by dsh (session ${id})`);
		return json(204);
	});
	register("POST", "/api/session/:sessionID/generate", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		ctx.log(`[bridge/session-v2] text generation is not supported by dsh (session ${id})`);
		return json(200, { data: { text: "" } });
	});
	register("GET", "/api/experimental/session/:sessionID/log", "sse", async () => ({ status: 200 }));
	register("GET", "/api/session/:sessionID/stats", "json", async (_req, _ctx) => {
		return json(200, { data: {} });
	});
}
//#endregion
//#region src/bridge/routes/v2-shapes.ts
/** `ShellInfo` — a shell that never ran. */
function emptyShellInfo(shellID, cwd) {
	return {
		id: shellID,
		status: "exited",
		command: "",
		cwd,
		shell: "",
		file: "",
		metadata: {},
		time: { started: 0 }
	};
}
/** `PersistentPtyInfo` — a persistent terminal that never started. */
function emptyPersistentPtyInfo(ptyID, sessionID, cwd) {
	return {
		id: ptyID,
		title: "",
		command: "",
		args: [],
		cwd,
		status: "exited",
		pid: 0,
		sessionID,
		foregroundProcess: null,
		size: {
			cols: 80,
			rows: 24
		},
		output: {
			head: 0,
			tail: 0
		}
	};
}
/** `PersistentPtyReadResult` — an empty terminal screen. */
function emptyPersistentPtyRead(ptyID, cwd) {
	return {
		ptyID,
		title: "",
		cwd,
		foregroundProcess: null,
		screen: {
			text: "",
			cols: 80,
			rows: 24,
			cursor: {
				x: 0,
				y: 0
			}
		}
	};
}
/** `Pty` — a pty that never ran. */
function emptyPty(ptyID, cwd) {
	return {
		id: ptyID,
		title: "",
		command: "",
		args: [],
		cwd,
		status: "exited",
		pid: 0
	};
}
/** `CredentialEntry` — an empty credential slot. */
function emptyCredentialEntry(id) {
	return {
		id,
		integrationID: "",
		label: "",
		active: false,
		value: {
			type: "key",
			key: ""
		}
	};
}
/** `SessionStatsInfo` — an empty statistics window. */
function emptySessionStats() {
	return {
		range: {
			from: 0,
			to: 0
		},
		sessions: 0,
		subagents: 0,
		prompts: 0,
		steps: 0,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache: {
				read: 0,
				write: 0
			}
		},
		cost: 0,
		tools: { mode: "none" },
		activeDays: 0,
		streak: 0,
		activity: [],
		models: []
	};
}
/** `SessionInfo` — an empty session record. */
function emptySessionInfo(sessionID, cwd) {
	return {
		id: sessionID,
		projectID: "",
		cost: 0,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache: {
				read: 0,
				write: 0
			}
		},
		time: {
			created: 0,
			updated: 0
		},
		location: { directory: cwd }
	};
}
/** `IntegrationInfo` — an integration without methods or connections. */
function emptyIntegrationInfo(integrationID) {
	return {
		id: integrationID,
		name: "",
		methods: [],
		connections: []
	};
}
/** Log a stubbed route so the limitation is visible in the bridge log. */
function logStub(ctx, route, limitation) {
	ctx.log(`[bridge/compat] ${route} is a no-op: ${limitation}`);
}
//#endregion
//#region src/bridge/routes/v2-stubs.ts
function registerV2StubRoutes(register) {
	const L = (ctx) => typeof locationInfo === "function" ? locationInfo(ctx) : {};
	register("GET", "/api/project", "json", async (_req, ctx) => json(200, [projectInfo(ctx)]));
	register("GET", "/api/project/:projectID", "json", async (req, ctx) => {
		const projectID = req.params.projectID;
		const project = projectInfo(ctx);
		if (project.id !== projectID) throw notFound("project not found", { projectID });
		return json(200, project);
	});
	register("PATCH", "/api/project/:projectID", "json", async (req, ctx) => {
		const projectID = req.params.projectID;
		const project = projectInfo(ctx);
		if (project.id !== projectID) throw notFound("project not found", { projectID });
		return json(200, project);
	});
	register("GET", "/api/config", "json", async (_req, ctx) => {
		const fallback = await modelCatalogDefault(ctx);
		const agent = ctx.api.agentPresets?.defaultId;
		if (fallback === void 0 && agent === void 0) return json(200, []);
		return json(200, [{
			type: "document",
			info: {
				...fallback === void 0 ? {} : { model: {
					providerID: externalProviderId(fallback.provider),
					model: fallback.model
				} },
				...agent === void 0 ? {} : { default_agent: agent }
			}
		}]);
	});
	register("PATCH", "/api/config", "json", async () => json(200));
	register("GET", "/api/config/shell", "json", async () => json(200, []));
	register("GET", "/api/config/shells", "json", async () => json(200, []));
	register("GET", "/api/model/default", "json", async (_req, ctx) => {
		const fallback = await modelCatalogDefault(ctx);
		if (fallback === void 0) return json(200, {
			location: L(ctx),
			data: null
		});
		const model = convertToV2Models(await modelGroupsForClients(ctx)).find((item) => item.providerID === externalProviderId(fallback.provider) && item.id === fallback.model);
		return json(200, {
			location: L(ctx),
			data: model ?? null
		});
	});
	register("GET", "/api/session/active", "json", async (_req, ctx) => {
		const fn = ctx.state.activeSessions;
		return json(200, fn ? fn() : {});
	});
	register("GET", "/api/permission", "json", async (_req, ctx) => json(200, {
		location: L(ctx),
		data: [...ctx.state.permissions.values()]
	}));
	register("GET", "/api/permission/:requestID", "json", async (req, ctx) => {
		const p = ctx.state.permissions.get(req.params.requestID);
		if (!p) throw notFound("not found");
		return json(200, {
			location: L(ctx),
			data: p
		});
	});
	register("POST", "/api/permission/:requestID/reply", "json", async () => json(200));
	register("POST", "/api/permission", "json", async () => json(200, {
		id: "",
		effect: "allow"
	}));
	register("GET", "/api/form", "json", async (_req, ctx) => json(200, {
		location: L(ctx),
		data: [...ctx.state.questions.values()]
	}));
	register("POST", "/api/form", "json", async () => json(200, { id: "" }));
	register("GET", "/api/form/:formID", "json", async () => json(200, { id: "" }));
	register("POST", "/api/form/:formID/reply", "json", async () => json(200));
	register("POST", "/api/form/:formID/cancel", "json", async () => json(200));
	register("GET", "/api/vcs", "json", async (_req, ctx) => json(200, {
		location: L(ctx),
		data: null
	}));
	register("POST", "/api/vcs/init", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/vcs/init", "dsh owns the working copy; the bridge cannot create one");
		return json(204);
	});
	register("GET", "/api/vcs/base", "json", async () => json(200, {
		location: {},
		data: null
	}));
	register("GET", "/api/vcs/status", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("GET", "/api/vcs/branch", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("GET", "/api/vcs/diff", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("GET", "/api/worktree", "json", async (_req, ctx) => json(200, []));
	register("POST", "/api/worktree", "json", async (_req, ctx) => json(200, { directory: ctx.cwd ?? "" }));
	register("DELETE", "/api/worktree", "json", async (_req, ctx) => {
		logStub(ctx, "DELETE /api/worktree", "dsh owns the working copy; the bridge cannot remove it");
		return json(204);
	});
	register("POST", "/api/worktree/refresh", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/worktree/refresh", "dsh owns the working copy; there is nothing to refresh");
		return json(204);
	});
	register("GET", "/api/mcp", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("POST", "/api/mcp", "json", async () => json(200));
	register("DELETE", "/api/mcp/:name", "json", async () => json(200));
	register("POST", "/api/mcp/:name/connect", "json", async () => json(200));
	register("POST", "/api/mcp/:name/disconnect", "json", async () => json(200));
	register("GET", "/api/mcp/resource", "json", async () => json(200, {
		location: {},
		data: {
			resources: [],
			templates: []
		}
	}));
	register("GET", "/api/credential", "json", async () => json(200, { data: [] }));
	register("POST", "/api/credential", "json", async () => json(200, { data: emptyCredentialEntry("") }));
	register("PATCH", "/api/credential/:id", "json", async (_req, ctx) => {
		logStub(ctx, "PATCH /api/credential/:id", "dsh has no credential store");
		return json(204);
	});
	register("POST", "/api/credential/:id/activate", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/credential/:id/activate", "dsh has no credential store");
		return json(204);
	});
	register("DELETE", "/api/credential/:id", "json", async (_req, ctx) => {
		logStub(ctx, "DELETE /api/credential/:id", "dsh has no credential store");
		return json(204);
	});
	register("GET", "/api/shell", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("POST", "/api/shell", "json", async (_req, ctx) => json(200, {
		location: L(ctx),
		data: emptyShellInfo("", ctx.cwd)
	}));
	register("GET", "/api/shell/:shellID", "json", async (req, ctx) => json(200, {
		location: L(ctx),
		data: emptyShellInfo(req.params.shellID, ctx.cwd)
	}));
	register("GET", "/api/shell/:shellID/output", "json", async () => json(200, {
		location: {},
		data: {
			output: "",
			cursor: 0,
			size: 0,
			truncated: false
		}
	}));
	register("DELETE", "/api/shell/:shellID", "json", async (_req, ctx) => {
		logStub(ctx, "DELETE /api/shell/:shellID", "dsh has no persistent shell registry");
		return json(204);
	});
	register("GET", "/api/debug/location", "json", async () => json(200, []));
	register("POST", "/api/debug/location/evict", "json", async () => json(200));
	register("GET", "/api/migration/v1/status", "json", async () => json(200, { status: "completed" }));
	register("GET", "/api/websearch/providers", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("POST", "/api/websearch/query", "json", async () => json(200, {
		location: {},
		data: { text: "" }
	}));
	register("POST", "/api/generate", "json", async () => json(200, { text: "" }));
	register("POST", "/api/generate/text", "json", async () => json(200, { text: "" }));
	register("POST", "/api/rpc/:method", "json", async () => json(200, { data: null }));
	register("POST", "/api/pair", "json", async () => json(200, {
		code: "",
		expires_in: 0
	}));
	register("POST", "/api/server/connect", "json", async () => json(200, { token: "" }));
	register("GET", "/api/plugin", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("POST", "/api/plugin/check", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("POST", "/api/plugin/update", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/plugin/update", "dsh-oc installs no opencode plugin");
		return json(204);
	});
	register("GET", "/api/integration/:id", "json", async (req) => json(200, {
		location: {},
		data: emptyIntegrationInfo(req.params.id)
	}));
	register("POST", "/api/integration/wellknown", "json", async () => json(200));
	register("GET", "/api/experimental/config", "json", async () => json(200, {
		location: {},
		data: {}
	}));
	register("POST", "/api/experimental/fs/write", "json", async (req, ctx) => {
		const body = bodyAsRecord(req.body);
		const path = typeof body.path === "string" ? body.path : "";
		logStub(ctx, "POST /api/experimental/fs/write", "dsh owns the file tools; the bridge does not write files itself");
		return json(200, {
			location: L(ctx),
			data: { path }
		});
	});
	register("GET", "/api/experimental/session/stats", "json", async () => json(200, { data: emptySessionStats() }));
	register("POST", "/api/experimental/session/import", "json", async (_req, ctx) => json(200, { data: emptySessionInfo("", ctx.cwd) }));
	register("POST", "/api/experimental/session/export", "json", async () => json(200, {}));
	register("GET", "/api/experimental/session/log", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("POST", "/api/experimental/generate", "json", async () => json(200, { data: { text: "" } }));
	register("GET", "/api/experimental/mcp", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("GET", "/api/experimental/migration/v1", "json", async () => json(200, { status: "completed" }));
	register("POST", "/api/experimental/voice/session", "json", async () => json(200, { data: { transport: {
		type: "websocket",
		url: "",
		token: "",
		expiresAt: 0
	} } }));
	register("GET", "/api/experimental/terminal", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("POST", "/api/experimental/session/wait", "json", async () => json(200));
	register("POST", "/api/experimental/persistent-pty", "json", async () => json(200, { id: "" }));
	register("GET", "/api/experimental/persistent-pty", "json", async () => json(200, {
		location: {},
		data: []
	}));
	register("GET", "/api/experimental/persistent-pty/:id", "json", async (req, ctx) => json(200, { data: emptyPersistentPtyInfo(req.params.id, "", ctx.cwd) }));
	register("DELETE", "/api/experimental/persistent-pty/:id", "json", async (_req, ctx) => {
		logStub(ctx, "DELETE /api/experimental/persistent-pty/:id", "dsh has no persistent pty; nothing is killed");
		return json(204);
	});
	register("POST", "/api/experimental/persistent-pty/:id/connect-token", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/experimental/persistent-pty/:id/connect-token", "dsh has no persistent pty; no terminal ticket is issued");
		return json(200, { data: {
			ticket: "",
			expires_in: 0
		} });
	});
	register("POST", "/api/location/reload", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/location/reload", "the bridge serves a single location; there is nothing to reload");
		return json(204);
	});
}
//#endregion
//#region src/bridge/routes/v2-client-compat.ts
function registerV2ClientCompatRoutes(register) {
	const L = (ctx) => locationInfo(ctx);
	register("GET", "/api/agent/:agentID", "json", async (req, ctx) => {
		const agentID = req.params.agentID;
		const found = (await v2AgentList(ctx)).find((agent) => agent.id === agentID);
		if (found === void 0) throw notFound("agent not found", { agentID });
		const agent = {
			...found,
			name: found.name ?? found.id
		};
		return json(200, {
			location: L(ctx),
			data: agent
		});
	});
	register("GET", "/api/websearch/provider", "json", async (_req, ctx) => {
		logStub(ctx, "GET /api/websearch/provider", "dsh has no web search provider");
		return json(200, {
			location: L(ctx),
			data: []
		});
	});
	register("POST", "/api/websearch", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/websearch", "dsh has no web search provider; the query returns no results");
		return json(200, {
			location: L(ctx),
			data: {
				providerID: "",
				results: []
			}
		});
	});
	register("GET", "/auth/connect/:code", "json", async (req, ctx) => {
		logStub(ctx, "GET /auth/connect/:code", "dsh-oc runs in-process; there is no remote server to pair with");
		return json(200, { token: "" });
	});
	register("POST", "/api/rpc/:rpcID/:method", "json", async (req, ctx) => {
		const rpcID = req.params.rpcID;
		const method = req.params.method;
		logStub(ctx, "POST /api/rpc/:rpcID/:method", `dsh has no rpc target "${rpcID}"; method "${method}" is not dispatched`);
		return json(200, { output: null });
	});
	register("GET", "/api/pty", "json", async (_req, ctx) => {
		logStub(ctx, "GET /api/pty", "dsh has no pty");
		return json(200, {
			location: L(ctx),
			data: []
		});
	});
	register("POST", "/api/pty", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/pty", "dsh has no pty; no terminal is started");
		return json(200, {
			location: L(ctx),
			data: emptyPty(`pty_${randomUUID()}`, ctx.cwd)
		});
	});
	register("GET", "/api/pty/:ptyID", "json", async (req, ctx) => {
		const ptyID = req.params.ptyID;
		logStub(ctx, "GET /api/pty/:ptyID", "dsh has no pty");
		return json(200, {
			location: L(ctx),
			data: emptyPty(ptyID, ctx.cwd)
		});
	});
	register("PUT", "/api/pty/:ptyID", "json", async (req, ctx) => {
		const ptyID = req.params.ptyID;
		logStub(ctx, "PUT /api/pty/:ptyID", "dsh has no pty; the title/size change is not stored");
		return json(200, {
			location: L(ctx),
			data: emptyPty(ptyID, ctx.cwd)
		});
	});
	register("DELETE", "/api/pty/:ptyID", "json", async (req, ctx) => {
		logStub(ctx, "DELETE /api/pty/:ptyID", "dsh has no pty; nothing is killed");
		return json(204);
	});
	register("POST", "/api/pty/:ptyID/connect-token", "json", async (req, ctx) => {
		logStub(ctx, "POST /api/pty/:ptyID/connect-token", "dsh has no pty; no terminal ticket is issued");
		return json(200, {
			location: L(ctx),
			data: {
				ticket: "",
				expires_in: 0
			}
		});
	});
	register("GET", "/api/experimental/persistent-pty/:ptyID/snapshot", "json", async (req, ctx) => {
		const ptyID = req.params.ptyID;
		logStub(ctx, "GET /api/experimental/persistent-pty/:ptyID/snapshot", "dsh has no persistent pty");
		return json(200, { data: {
			info: emptyPersistentPtyInfo(ptyID, "", ctx.cwd),
			text: "",
			checkpoint: "",
			cursor: {
				x: 0,
				y: 0
			}
		} });
	});
	register("PUT", "/api/experimental/persistent-pty/:ptyID", "json", async (req, ctx) => {
		const ptyID = req.params.ptyID;
		logStub(ctx, "PUT /api/experimental/persistent-pty/:ptyID", "dsh has no persistent pty");
		return json(200, { data: emptyPersistentPtyInfo(ptyID, "", ctx.cwd) });
	});
	register("POST", "/api/experimental/persistent-pty/handoff", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/experimental/persistent-pty/handoff", "dsh has no persistent pty; there is nothing to hand off");
		return json(200, { handoff: null });
	});
	register("POST", "/api/experimental/persistent-pty/shutdown", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/experimental/persistent-pty/shutdown", "dsh has no persistent pty; nothing is shut down");
		return json(204);
	});
	register("GET", "/api/experimental/session/:sessionID/terminal", "json", async (_req, ctx) => {
		logStub(ctx, "GET /api/experimental/session/:sessionID/terminal", "dsh has no per-session terminal");
		return json(200, { data: [] });
	});
	register("GET", "/api/experimental/session/:sessionID/terminal/read", "json", async (_req, ctx) => {
		logStub(ctx, "GET /api/experimental/session/:sessionID/terminal/read", "dsh has no per-session terminal");
		return json(200, { data: emptyPersistentPtyRead("", ctx.cwd) });
	});
	register("POST", "/api/experimental/session/:sessionID/terminal", "json", async (req, ctx) => {
		const sessionID = req.params.sessionID;
		logStub(ctx, "POST /api/experimental/session/:sessionID/terminal", "dsh has no per-session terminal; no process is started");
		return json(200, { data: emptyPersistentPtyInfo(`pty_${randomUUID()}`, sessionID, ctx.cwd) });
	});
	register("GET", "/api/experimental/session/:sessionID/instructions/entries", "json", async (req, ctx) => {
		logStub(ctx, "GET /api/experimental/session/:sessionID/instructions/entries", "dsh keeps instructions in AGENTS.md files, not per session");
		return json(200, { data: [] });
	});
	register("PUT", "/api/experimental/session/:sessionID/instructions/entries/:key", "json", async (_req, ctx) => {
		logStub(ctx, "PUT /api/experimental/session/:sessionID/instructions/entries/:key", "dsh keeps instructions in AGENTS.md files, not per session");
		return json(204);
	});
	register("DELETE", "/api/experimental/session/:sessionID/instructions/entries/:key", "json", async (_req, ctx) => {
		logStub(ctx, "DELETE /api/experimental/session/:sessionID/instructions/entries/:key", "dsh keeps instructions in AGENTS.md files, not per session");
		return json(204);
	});
	register("DELETE", "/api/session/:sessionID/inbox/:inboxID", "json", async (_req, ctx) => {
		logStub(ctx, "DELETE /api/session/:sessionID/inbox/:inboxID", "dsh has no client visible inbox; queued follow-ups are delivered by the bridge itself");
		return json(204);
	});
	register("PATCH", "/api/session/:sessionID/inbox/:inboxID", "json", async (_req, ctx) => {
		logStub(ctx, "PATCH /api/session/:sessionID/inbox/:inboxID", "dsh has no client visible inbox; the delivery mode cannot be changed");
		return json(204);
	});
	register("POST", "/api/experimental/session/:sessionID/wait", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const deadline = Date.now() + 3e4;
		while (Date.now() < deadline) {
			const item = (await rpc(ctx, "session.list", {})).items.find((entry) => String(entry.sessionId) === id);
			if (item === void 0) throw notFound("session not found", { sessionID: id });
			if (!item.running) return json(204);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		return json(503, {
			name: "ServiceUnavailableError",
			message: "session still busy"
		});
	});
	register("POST", "/api/experimental/session/:sessionID/skill", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const body = bodyAsRecord(req.body);
		const skillID = typeof body.id === "string" ? body.id : "";
		if (skillID === "") throw notFound("skill not found", { skill: skillID });
		const skill = (await skillListForSession(ctx, id)).find((entry) => entry.name === skillID);
		if (skill === void 0) throw notFound("skill not found", { skill: skillID });
		await rpc(ctx, "session.prompt", {
			sessionId: sid(id),
			mode: "steer",
			content: [{
				type: "text",
				text: `/${skill.name}`
			}]
		});
		ctx.state.invalidateSession(id);
		return json(204);
	});
	register("GET", "/api/experimental/session/:sessionID/export", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const info = toV2Session(await sessionView(ctx, id), id, ctx);
		const history = await cachedSessionHistory(ctx, id, { maxMessages: 500 });
		await ensureSubagentHistoryContext(ctx, id, history.events);
		const defaultModel = await sessionModelRef(ctx, id);
		const messages = convertMessagesV2(history.events.map((entry) => entry.event), {
			sessionId: id,
			cwd: ctx.cwd,
			defaultModel,
			subagentForCall: (call) => subagentMetadataForHistory(ctx, id, call),
			onSkip: (type, reason) => ctx.log(`[bridge/export-v2] ${type}: ${reason}`)
		}, history.events.map((entry) => entry.view));
		return json(200, { data: {
			info,
			messages: req.query.get("sanitize") === "true" ? redactMessages(messages) : messages
		} });
	});
	register("POST", "/api/session/:sessionID/permission", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const body = bodyAsRecord(req.body);
		const action = typeof body.action === "string" ? body.action : "";
		const resources = Array.isArray(body.resources) ? body.resources.map((entry) => String(entry)) : [];
		const requestID = typeof body.id === "string" && body.id.length > 0 ? body.id : `perm_${randomUUID()}`;
		const effect = ctx.state.savedPermissionFor(id, action) !== void 0 ? "allow" : "ask";
		ctx.state.registerApproval({
			opencodeId: requestID,
			rpcId: `client:${requestID}`,
			sessionId: id,
			approvalId: `client:${requestID}`,
			toolName: action,
			...resources.length === 0 ? {} : { reason: resources.join(" ") }
		});
		ctx.log(`[bridge/compat] POST /api/session/:sessionID/permission registered a bridge local request (${requestID}); dsh cannot raise approvals on demand`);
		return json(200, { data: {
			id: requestID,
			effect
		} });
	});
	register("POST", "/api/experimental/integration/wellknown", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/experimental/integration/wellknown", "dsh has no integration registry");
		return json(204);
	});
	register("POST", "/api/integration/:integrationID/connect/key", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/integration/:integrationID/connect/key", "dsh has no integration registry");
		return json(204);
	});
	register("POST", "/api/integration/:integrationID/connect/external", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/integration/:integrationID/connect/external", "dsh has no integration registry");
		return json(204);
	});
	register("POST", "/api/integration/:integrationID/connect/oauth", "json", async (req, ctx) => {
		logStub(ctx, "POST /api/integration/:integrationID/connect/oauth", "dsh has no integration registry; no oauth attempt is started");
		return json(200, {
			location: L(ctx),
			data: {
				attemptID: `attempt_${randomUUID()}`,
				url: "",
				instructions: "",
				mode: "code",
				time: {
					created: Date.now(),
					expires: 0
				}
			}
		});
	});
	register("GET", "/api/integration/:integrationID/connect/oauth/:attemptID", "json", async (_req, ctx) => {
		logStub(ctx, "GET /api/integration/:integrationID/connect/oauth/:attemptID", "dsh has no integration registry; no oauth attempt is alive");
		return json(200, {
			location: L(ctx),
			data: {
				status: "expired",
				time: {
					created: 0,
					expires: 0
				}
			}
		});
	});
	register("POST", "/api/integration/:integrationID/connect/oauth/:attemptID/complete", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/integration/:integrationID/connect/oauth/:attemptID/complete", "dsh has no integration registry");
		return json(204);
	});
	register("DELETE", "/api/integration/:integrationID/connect/oauth/:attemptID", "json", async (_req, ctx) => {
		logStub(ctx, "DELETE /api/integration/:integrationID/connect/oauth/:attemptID", "dsh has no integration registry");
		return json(204);
	});
	register("POST", "/api/integration/:integrationID/connect/command", "json", async (req, ctx) => {
		logStub(ctx, "POST /api/integration/:integrationID/connect/command", "dsh has no integration registry; no command attempt is started");
		return json(200, {
			location: L(ctx),
			data: {
				attemptID: `attempt_${randomUUID()}`,
				time: {
					created: Date.now(),
					expires: 0
				}
			}
		});
	});
	register("GET", "/api/integration/:integrationID/connect/command/:attemptID", "json", async (_req, ctx) => {
		logStub(ctx, "GET /api/integration/:integrationID/connect/command/:attemptID", "dsh has no integration registry; no command attempt is alive");
		return json(200, {
			location: L(ctx),
			data: {
				status: "expired",
				time: {
					created: 0,
					expires: 0
				}
			}
		});
	});
	register("DELETE", "/api/integration/:integrationID/connect/command/:attemptID", "json", async (_req, ctx) => {
		logStub(ctx, "DELETE /api/integration/:integrationID/connect/command/:attemptID", "dsh has no integration registry");
		return json(204);
	});
	register("PUT", "/api/experimental/mcp/:server", "json", async (_req, ctx) => {
		logStub(ctx, "PUT /api/experimental/mcp/:server", "dsh has no mcp server registry");
		return json(204);
	});
	register("DELETE", "/api/experimental/mcp/:server", "json", async (_req, ctx) => {
		logStub(ctx, "DELETE /api/experimental/mcp/:server", "dsh has no mcp server registry");
		return json(204);
	});
	register("POST", "/api/experimental/mcp/:server/connect", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/experimental/mcp/:server/connect", "dsh has no mcp server registry");
		return json(204);
	});
	register("POST", "/api/experimental/mcp/:server/disconnect", "json", async (_req, ctx) => {
		logStub(ctx, "POST /api/experimental/mcp/:server/disconnect", "dsh has no mcp server registry");
		return json(204);
	});
	register("DELETE", "/api/debug/location", "json", async (_req, ctx) => {
		logStub(ctx, "DELETE /api/debug/location", "the bridge owns exactly one location; there is nothing to evict");
		return json(204);
	});
	register("PATCH", "/api/experimental/config", "json", async (_req, ctx) => {
		logStub(ctx, "PATCH /api/experimental/config", "dsh-oc has no writable config file; the shell setting is ignored");
		return json(204);
	});
}
/**
* Blank every free-text field of an exported message list.
*
* `GET /api/experimental/session/:sessionID/export?sanitize=true` asks the
* server for a redacted export. dsh-oc has no per-message redaction flag, so
* the text fields are emptied instead of being shipped verbatim.
*/
function redactMessages(messages) {
	const REDACTED_KEYS = /* @__PURE__ */ new Set([
		"text",
		"output",
		"reasoning",
		"description"
	]);
	const walk = (value) => {
		if (Array.isArray(value)) return value.map(walk);
		if (value === null || typeof value !== "object") return value;
		const source = value;
		const out = {};
		for (const [key, entry] of Object.entries(source)) out[key] = REDACTED_KEYS.has(key) && typeof entry === "string" ? "" : walk(entry);
		return out;
	};
	return walk(messages);
}
//#endregion
//#region src/bridge/routes.ts
function registerRoutes(register) {
	registerBootRoutes(register);
	registerSessionV2Routes(register);
	registerSessionV2ExtraRoutes(register);
	registerFsRoutes(register);
	registerV2StubRoutes(register);
	registerV2ClientCompatRoutes(register);
	register("GET", "/api/event", "sse", async () => ({ status: 200 }));
}
//#endregion
//#region src/bridge/sse.ts
/** The SSE comment frame the official opencode server sends every 15 s. */
const HEARTBEAT_FRAME = ": heartbeat\n\n";
/** Default heartbeat interval; the same cadence the official server uses. */
const DEFAULT_HEARTBEAT_MS = 15e3;
/**
* The wire object of one event.
*
* It carries the OpenCode 2.x envelope at the top level (`id`, `created`,
* `type`, `durable`, `location`, `data`), so a 2.x client reads the stream
* without knowing the 1.18.18 wrapper, and it keeps that wrapper
* (`directory`, `payload`) for the bundled 1.18.18 TUI.
*/
function toWireEvent(event) {
	const { id, created, type, data, durable, location } = event.payload;
	return {
		id,
		...created === void 0 ? {} : { created },
		type,
		...durable === void 0 ? {} : { durable },
		...location === void 0 ? {} : { location },
		data,
		directory: event.directory,
		...event.project === void 0 ? {} : { project: event.project },
		payload: event.payload
	};
}
/** Registry of active SSE connections plus the encoder/cleanup logic. */
var SseHub = class {
	log;
	clients = /* @__PURE__ */ new Set();
	/** Events enqueued before any client connected (raw replay mode). */
	pending = [];
	replay = [];
	replayBytes = 0;
	maxReplayEvents;
	maxReplayBytes;
	heartbeatMs;
	heartbeatTimer;
	nextId = 1;
	constructor(log, options = {}) {
		this.log = log;
		this.maxReplayEvents = Math.max(1, Math.floor(options.maxReplayEvents ?? 512));
		this.maxReplayBytes = Math.max(1, Math.floor(options.maxReplayBytes ?? 4194304));
		this.heartbeatMs = Math.max(0, Math.floor(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS));
		if (this.heartbeatMs > 0) {
			this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
			this.heartbeatTimer.unref?.();
		}
	}
	/**
	* Write the SSE comment heartbeat to every open connection.
	*
	* The official opencode server sends `": heartbeat\n\n"` every 15 seconds.
	* Without it a quiet session looks like a dead stream: the opencode client
	* drops the connection with "Event stream stalled" and the OpenChamber
	* upstream reader reconnects in a tight loop.
	*/
	heartbeat() {
		for (const client of [...this.clients]) {
			if (client.closed || client.res.destroyed) continue;
			try {
				client.res.write(HEARTBEAT_FRAME);
			} catch (error) {
				this.log(`[bridge/sse] heartbeat to client ${client.id} failed: ${error instanceof Error ? error.message : String(error)}`);
				this.remove(client);
			}
		}
	}
	/** Stop the heartbeat timer. */
	dispose() {
		if (this.heartbeatTimer !== void 0) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = void 0;
		}
	}
	add(res, filter) {
		const client = {
			id: this.nextId++,
			res,
			controller: new AbortController(),
			closed: false,
			filter
		};
		this.clients.add(client);
		if (this.pending.length > 0) {
			const queued = this.pending.splice(0);
			for (const event of queued) this.send(client, event);
		}
		res.on("close", () => this.remove(client));
		res.on("error", (error) => {
			this.log(`[bridge/sse] client ${client.id} error: ${error.message}`);
			this.remove(client);
		});
		return client;
	}
	remove(client) {
		if (client.closed) return;
		client.closed = true;
		this.clients.delete(client);
		client.controller.abort();
	}
	send(client, event) {
		if (client.closed || client.res.destroyed) return;
		if (client.filter !== void 0 && !client.filter(event)) return;
		this.sendWire(client, this.encode(event));
	}
	encode(event) {
		const data = JSON.stringify(toWireEvent(event));
		const wire = `id: ${event.payload.id}\ndata: ${data}\n\n`;
		return {
			event,
			wire,
			bytes: Buffer.byteLength(wire)
		};
	}
	sendWire(client, entry) {
		if (client.closed || client.res.destroyed) return;
		try {
			client.res.write(entry.wire);
		} catch (error) {
			this.log(`[bridge/sse] write to client ${client.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			this.remove(client);
		}
	}
	remember(event) {
		const entry = this.encode(event);
		this.replay.push(entry);
		this.replayBytes += entry.bytes;
		while (this.replay.length > this.maxReplayEvents || this.replayBytes > this.maxReplayBytes) {
			const removed = this.replay.shift();
			if (removed === void 0) break;
			this.replayBytes -= removed.bytes;
		}
		return entry;
	}
	/** Replay events strictly after a known event id; return false when the id
	* is outside the bounded ring (or was never observed). */
	replayAfter(client, lastEventId) {
		const index = this.replay.findIndex((entry) => entry.event.payload.id === lastEventId);
		if (index === -1) return false;
		for (const entry of this.replay.slice(index + 1)) {
			if (client.filter !== void 0 && !client.filter(entry.event)) continue;
			this.sendWire(client, entry);
		}
		return true;
	}
	/** Fan one event batch out to every connected SSE client. */
	broadcast(events) {
		const entries = events.map((event) => this.remember(event));
		for (const client of [...this.clients]) for (const entry of entries) {
			if (client.filter !== void 0 && !client.filter(entry.event)) continue;
			this.sendWire(client, entry);
		}
	}
	/**
	* Broadcast a batch while retaining it for the first client when the
	* bridge has not acquired an SSE subscriber yet.  Unlike calling
	* `enqueue()` followed by `broadcast()`, this remembers each event in the
	* Last-Event-ID ring exactly once.
	*/
	broadcastAndBufferIfIdle(events) {
		if (this.clients.size === 0) this.pending.push(...events);
		this.broadcast(events);
	}
	/** Broadcast now, or buffer until the first client connects. */
	enqueue(events) {
		if (this.clients.size === 0) {
			this.pending.push(...events);
			return;
		}
		this.broadcast(events);
	}
	closeAll() {
		for (const client of [...this.clients]) this.remove(client);
	}
	get size() {
		return this.clients.size;
	}
};
//#endregion
//#region src/bridge/stubs.ts
/**
* Schema-valid stub routes: the TUI probes these at startup and must always
* receive 2xx JSON, even though dsh does not back the capability.
*/
const stubRoutes = [
	jsonRoute("GET", "/lsp", []),
	jsonRoute("GET", "/mcp", {}),
	jsonRoute("GET", "/formatter", []),
	jsonRoute("GET", "/experimental/resource", []),
	jsonRoute("GET", "/experimental/console", {
		consoleManagedProviders: [],
		switchableOrgCount: 0
	}),
	jsonRoute("GET", "/experimental/capabilities", { backgroundSubagents: true }),
	jsonRoute("GET", "/experimental/workspace", []),
	jsonRoute("GET", "/experimental/workspace/status", [])
];
function jsonRoute(method, pattern, body) {
	return {
		method,
		pattern,
		kind: "json",
		handler: async () => ({
			status: 200,
			body
		})
	};
}
//#endregion
//#region src/bridge/web-ui.ts
/** The mime types the web UI needs; the official server uses the same set. */
const MIME_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".wasm": "application/wasm",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".pdf": "application/pdf"
};
function mimeTypeFor(path) {
	return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
/** The directory the extracted UI lives in, if it is already there. */
function webUiDir(explicit) {
	if (explicit === void 0 || explicit.length === 0) return void 0;
	const dir = resolve(explicit);
	return existsSync(join(dir, "index.html")) ? dir : void 0;
}
/**
* Find the directory of the official opencode web UI.
*
* The order is the same as the official setup: an explicit directory wins,
* then the extracted copy under `$DSH_HOME/opencode/web-ui/<version>`, and
* the assets are extracted from the opencode binary when they are missing.
* Returns undefined when there is no opencode binary to extract them from, so
* the bridge simply does not serve a web UI.
*/
function resolveWebUiDir(options = { version: "0.0.0" }) {
	const explicit = webUiDir(options.explicit);
	if (explicit !== void 0) return explicit;
	if (options.home === void 0 || options.binary === void 0) return void 0;
	const dir = join(options.home, "opencode", "web-ui", options.version);
	const existing = webUiDir(dir);
	if (existing !== void 0) return existing;
	if (!existsSync(options.binary)) return void 0;
	try {
		const written = extractWebUi(options.binary, dir);
		if (written === 0) return void 0;
		options.log?.(`extracted ${written} web UI assets from ${options.binary} into ${dir}`);
		return webUiDir(dir);
	} catch (error) {
		options.log?.(`web UI extraction failed: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
}
/**
* Extract the web UI assets the opencode binary embeds into `dir`.
*
* Returns the number of files written. The archive is searched for by its
* shape (a JSON index of [offset, length] pairs whose byte length matches the
* u32 header in front of it), so no build detail has to be known here.
*/
function extractWebUi(binary, dir) {
	const data = readFileSync(binary);
	const index = findArchiveIndex(data);
	if (index === void 0) return 0;
	const body = index.at + index.length;
	let written = 0;
	for (const [key, [offset, length]] of Object.entries(index.entries)) {
		const compressed = data.subarray(body + offset, body + offset + length);
		let content;
		try {
			content = brotliDecompressSync(compressed);
		} catch {
			content = compressed;
		}
		const target = join(dir, key);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
		written++;
	}
	return written;
}
function findArchiveIndex(data) {
	const needle = Buffer.from("{\"");
	let at = 0;
	while (at < data.length) {
		const start = data.indexOf(needle, at);
		if (start === -1) break;
		at = start + 1;
		if (start < 4) continue;
		const end = data.indexOf("}", start);
		if (end === -1) continue;
		const length = data.readUInt32LE(start - 4);
		if (length !== end + 1 - start) continue;
		let parsed;
		try {
			parsed = JSON.parse(data.subarray(start, start + length).toString("utf8"));
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		const values = Object.values(parsed);
		if (values.length < 3) continue;
		if (!values.every((value) => Array.isArray(value) && value.length === 2 && value.every((entry) => Number.isInteger(entry)))) continue;
		return {
			at: start,
			length,
			entries: parsed
		};
	}
}
/**
* Serve one file of the web UI.
*
* The official server serves `index.html` for unknown paths (the app is a
* single page application) but answers 404 for a missing asset, so a broken
* build fails loudly instead of silently returning the shell.
*/
function serveWebUiFile(res, dir, pathname, method) {
	const key = decodeURIComponent(pathname).replace(/^\//, "");
	const name = key.length === 0 ? "index.html" : key;
	const target = join(dir, name);
	if (!target.startsWith(dir)) return false;
	const revalidate = name === "index.html" || name === "sw.js" || name === "registerSW.js";
	const isAsset = name.startsWith("_assets/") || name.startsWith("icons/");
	if (!existsSync(target)) {
		if (isAsset) {
			res.writeHead(404, { "cache-control": "no-store" });
			res.end();
			return true;
		}
		return serveWebUiFile(res, dir, "/index.html", method);
	}
	const content = readFileSync(target);
	const headers = {
		"content-type": mimeTypeFor(name),
		"cache-control": revalidate ? "no-cache" : "public, max-age=31536000, immutable",
		"x-content-type-options": "nosniff"
	};
	if (method === "HEAD") {
		res.writeHead(200, headers);
		res.end();
		return true;
	}
	res.writeHead(200, headers);
	res.end(content);
	return true;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-util-crypto@0.2.1-rc.2_@deepseek-ai+cordis@4.0.5/node_modules/@deepseek-ai/dsh-util-crypto/lib/index.js
/**
* Random v4 UUID, minted from `crypto.getRandomValues`.
* @returns the UUID string.
*/
function randomUUID$1() {
	const bytes = globalThis.crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(16));
	const hex = Array.from(bytes, (byte, index) => {
		return (index === 6 ? byte & 15 | 64 : index === 8 ? byte & 63 | 128 : byte).toString(16).padStart(2, "0");
	}).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-brand@0.2.1-rc.2_@deepseek-ai+cordis@4.0.5/node_modules/@deepseek-ai/dsh-brand/lib/index.js
/**
* Duplicate-install-safe nominal primitive helpers.
*
* A brand makes structurally identical strings or numbers non-interchangeable
* at the type level: a `SessionId` cannot be passed where a `ToolCallId` is
* expected, and an event sequence cannot be passed as a log offset. Comparison,
* logging, and serialization retain the underlying primitive behavior.
*
* This package owns no concrete domain value and keeps no runtime identity or mutable
* state, so independently installed copies produce interchangeable values.
*
* @module @deepseek-ai/dsh-brand
*/
/**
* Apply a compile-time string brand without changing the value.
* @param value - string admitted by the domain that owns the target brand.
* @returns the same string with the requested compile-time brand.
*/
function brandString(value) {
	return value;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-util-values@0.2.1-rc.2_@deepseek-ai+cordis@4.0.5/node_modules/@deepseek-ai/dsh-util-values/lib/index.js
/**
* Lazily scanned view of one JSON object's top-level fields, built from text
* that may still be streaming or from an already parsed object. Nothing is
* scanned until a reader asks; the view remembers every question it answered
* and reports changed answers when the owner refreshes for publication.
* Used for model tool-call arguments: a row reads the fields it
* cares about at whatever granularity it displays, at every stage of the call.
* @module @deepseek-ai/dsh-util-values/src/partial-json
*/
const SIMPLE_ESCAPES = {
	"\"": "\"",
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "	"
};
const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
function isWhitespace(c) {
	return c === " " || c === "\n" || c === "\r" || c === "	";
}
function isHex(c) {
	return c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F";
}
(class PartialArguments {
	/** The view of a call with no arguments available. */
	static EMPTY = PartialArguments.fromObject({});
	/**
	* View finished argument text without scanning it until a reader asks.
	* @param text - the complete argument JSON text.
	* @returns a sealed view.
	*/
	static fromText(text) {
		const view = new PartialArguments();
		view.append(text);
		view.sealed = true;
		return view;
	}
	/**
	* View an already parsed argument payload, such as a PTC dispatch object.
	* @param value - the parsed argument value.
	* @returns a sealed view; a non-object payload has no fields.
	*/
	static fromObject(value) {
		const view = new PartialArguments();
		view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
		view.sealed = true;
		return view;
	}
	/**
	* The source: text so far or a parsed object, plus whether it can still grow.
	* These are the only enumerable fields, so two views over the same source
	* compare equal structurally however far each has been read.
	*/
	chunks = [];
	object;
	sealed = false;
	#ends = [];
	#size = 0;
	#consumed = 0;
	#mode = "root";
	#escape = false;
	#keyStart = 0;
	#keyEscaped = false;
	#key = "";
	#current = null;
	#nestedEnds = [];
	#nestedInString = false;
	#invalidAt;
	#invalidValue = false;
	#entries = /* @__PURE__ */ new Map();
	#order = [];
	#reads = /* @__PURE__ */ new Map();
	/** Whether this view rejects further appends; does not scan text or register reads. */
	get isSealed() {
		return this.sealed;
	}
	/** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
	get invalid() {
		this.scan();
		return this.#mode === "invalid" || this.#invalidValue;
	}
	/**
	* Retain streamed argument text without scanning or comparing observed answers.
	* @param fragment - the text following every fragment appended before.
	*/
	append(fragment) {
		if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
		if (fragment.length === 0) return;
		this.chunks.push(fragment);
		this.#size += fragment.length;
		this.#ends.push(this.#size);
	}
	/**
	* Reconcile a streamed prefix with authoritative complete text without joining the fragments.
	* @param text - the final argument text, which replaces missing or conflicting deltas.
	* @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
	*/
	settle(text) {
		if (this.object !== void 0 || text.length !== this.#size) return PartialArguments.fromText(text);
		let offset = 0;
		for (const chunk of this.chunks) {
			if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text);
			offset += chunk.length;
		}
		this.chunks = text.length === 0 ? [] : [text];
		this.#ends = text.length === 0 ? [] : [text.length];
		this.sealed = true;
		return this;
	}
	/**
	* Compare observed answers and advance their publication baseline. Unread views remain unscanned.
	* @returns whether any observed answer changed since its first read or the preceding refresh.
	*/
	refresh() {
		if (this.#reads.size === 0) return false;
		this.scan();
		let changed = false;
		let completions = false;
		for (const read of this.#reads.values()) {
			if (read.completion) {
				completions = true;
				continue;
			}
			changed = this.refreshRead(read) || changed;
		}
		if (completions) {
			for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
		}
		if (this.sealed) this.#reads.clear();
		return changed;
	}
	refreshRead(read) {
		const now = read.answer();
		if (Object.is(now, read.last)) return false;
		read.last = now;
		return true;
	}
	/**
	* Check whether no further fields can arrive.
	* @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
	*/
	closed() {
		return this.remember("closed", "", () => this.closedNow());
	}
	/**
	* List discovered fields in first-appearance order.
	* @returns top-level keys seen so far, in first-appearance order.
	*/
	keys() {
		return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
	}
	/**
	* Check whether a top-level field has appeared.
	* @param key - argument name.
	* @returns whether the field has appeared (a string opened or another value began).
	*/
	has(key) {
		return this.remember("has", key, () => this.hasNow(key));
	}
	/**
	* Check whether a field's closing delimiter has arrived, without validating its contents.
	* @param key - argument name.
	* @returns whether its delimiter arrived and no content reader has reported an error for this value.
	*/
	complete(key) {
		return this.remember("complete", key, () => this.completeNow(key));
	}
	/**
	* Read string length without materializing its text.
	* @param key - argument name.
	* @param options - change granularity for a streaming string.
	* @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
	*/
	stringLength(key, options) {
		const step = Math.max(1, Math.floor(options?.step ?? 1));
		const offset = options?.offset ?? 0;
		return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key), (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step));
	}
	/**
	* Check a string against a decoded UTF-16 length limit without materializing it.
	* @param key - argument name.
	* @param maxLength - decoded UTF-16 limit, floored to at least zero.
	* @returns whether the string is longer than the limit; false when absent or not a string.
	*/
	stringExceeds(key, maxLength) {
		const limit = Math.max(0, Math.floor(maxLength));
		return this.remember(`exceeds:${limit}`, key, () => (this.lengthNow(key, limit + 1) ?? 0) > limit);
	}
	/**
	* Read a decoded string, including a streaming prefix.
	* @param key - argument name.
	* @returns the string field's decoded text so far; undefined when absent or not a string.
	*/
	text(key) {
		return this.remember("text", key, () => this.textNow(key));
	}
	/**
	* Read at most the first decoded UTF-16 units of a string.
	* @param key - argument name.
	* @param maxLength - maximum decoded UTF-16 length, floored to at least one.
	* @returns the bounded string prefix; undefined when absent or not a string.
	*/
	textPrefix(key, maxLength) {
		const limit = Math.max(1, Math.floor(maxLength));
		return this.remember(`prefix:${limit}`, key, () => this.textPrefixNow(key, limit));
	}
	/**
	* Read a completed non-string argument.
	* @param key - argument name.
	* @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
	*/
	value(key) {
		return this.remember("value", key, () => this.valueNow(key));
	}
	/** Answer a question and, on a streaming view, remember it for change detection. */
	remember(kind, key, read, comparison) {
		this.scan();
		const result = read();
		if (!this.sealed) {
			const id = `${kind}/${key}`;
			if (!this.#reads.has(id)) this.#reads.set(id, {
				completion: kind === "complete",
				answer: comparison === void 0 ? read : () => comparison(read()),
				last: comparison === void 0 ? result : comparison(result)
			});
		}
		return result;
	}
	closedNow() {
		return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
	}
	keysNow() {
		return this.object === void 0 ? this.#order : Object.keys(this.object);
	}
	hasNow(key) {
		return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
	}
	completeNow(key) {
		if (this.object !== void 0) return Object.hasOwn(this.object, key);
		const entry = this.#entries.get(key);
		return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
	}
	lengthNow(key, limit = Number.POSITIVE_INFINITY) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.length : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
		const read = entry.length ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, limit, false);
		return read.length;
	}
	textNow(key) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
			let text;
			try {
				text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
			} catch (_error) {}
			if (text !== void 0) entry.text = {
				at: entry.end,
				length: text.length,
				text
			};
		}
		const read = entry.text ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, Number.POSITIVE_INFINITY, true);
		return read.text;
	}
	textPrefixNow(key, maxLength) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.slice(0, maxLength) : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
		let read = prefixes.get(maxLength);
		if (read === void 0) {
			read = {
				at: entry.start,
				length: 0,
				text: ""
			};
			prefixes.set(maxLength, read);
		}
		this.readString(entry, read, maxLength, true);
		return read.text;
	}
	valueNow(key) {
		if (this.object !== void 0) {
			if (!Object.hasOwn(this.object, key)) return void 0;
			const field = this.object[key];
			return typeof field === "string" ? void 0 : field;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
		if (entry.parsed === void 0) try {
			entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
		} catch (_error) {
			entry.invalid = true;
			this.#invalidValue = true;
		}
		return entry.parsed;
	}
	chunkAt(at) {
		let low = 0;
		let high = this.#ends.length;
		while (low < high) {
			const mid = low + high >>> 1;
			if (this.#ends[mid] <= at) low = mid + 1;
			else high = mid;
		}
		return low;
	}
	/** Materialize only a requested range, never the cumulative source. */
	slice(start, end) {
		if (start >= end) return "";
		const first = this.chunkAt(start);
		const last = this.chunkAt(end - 1);
		const base = first === 0 ? 0 : this.#ends[first - 1];
		if (first === last) return this.chunks[first].slice(start - base, end - base);
		const parts = [this.chunks[first].slice(start - base)];
		for (let i = first + 1; i < last; i++) parts.push(this.chunks[i]);
		parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
		return parts.join("");
	}
	readString(entry, read, limit, materialize) {
		const end = Math.min(entry.end < 0 ? this.#consumed : entry.end, entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY);
		if (!entry.needsDecoding) {
			const length = Math.min(end - read.at, limit - read.length);
			if (length <= 0) return;
			if (materialize) read.text += this.slice(read.at, read.at + length);
			read.at += length;
			read.length += length;
			return;
		}
		let chunkIndex = this.chunkAt(read.at);
		while (read.at < end && read.length < limit) {
			const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
			const chunk = this.chunks[chunkIndex];
			const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
			const boundary = remaining.search(CONTENT_ESCAPE);
			const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
			if (length > 0) {
				if (materialize) read.text += remaining.slice(0, length);
				read.at += length;
				read.length += length;
				if (read.at === base + chunk.length) chunkIndex++;
				continue;
			}
			const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
			let decoded;
			let width = 2;
			if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
			if (remaining[0] === "\\" && type === "u") {
				const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
				let valid = true;
				for (let i = 0; i < hex.length; i++) if (!isHex(hex[i])) valid = false;
				if (valid) {
					if (hex.length < 4 && entry.end < 0) return;
					if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
				}
				width = 6;
			} else if (remaining[0] === "\\" && type !== void 0) decoded = SIMPLE_ESCAPES[type];
			if (decoded === void 0) {
				entry.invalidAt = read.at;
				this.#invalidValue = true;
				return;
			}
			if (materialize) read.text += decoded;
			read.length++;
			read.at += width;
			while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
		}
	}
	/** Locate new field ranges without decoding or parsing their contents. */
	scan() {
		if (this.object !== void 0 || this.#consumed === this.#size) return;
		for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === void 0; i++) {
			const pending = this.chunks[i];
			const base = i === 0 ? 0 : this.#ends[i - 1];
			for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
				if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
					const end = this.stringBoundary(pending, index);
					this.#consumed += end - index;
					index = end;
					if (index === pending.length) break;
				}
				this.step(pending[index], this.#consumed);
				this.#consumed++;
			}
		}
	}
	/** Only raw quotes and their preceding backslash runs can terminate a string. */
	stringBoundary(fragment, start) {
		let at = start;
		while (true) {
			const quote = fragment.indexOf("\"", at);
			const end = quote < 0 ? fragment.length : quote;
			if (this.#mode === "string") {
				const entry = this.#current;
				if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true;
			}
			let slashStart = end;
			while (slashStart > at && fragment[slashStart - 1] === "\\") slashStart--;
			const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at && this.#escape);
			this.#escape = quote < 0 && escaped;
			if (quote < 0 || !escaped) return end;
			at = quote + 1;
		}
	}
	step(c, at) {
		switch (this.#mode) {
			case "root":
				if (isWhitespace(c)) return;
				if (c === "{") {
					this.#mode = "key-or-end";
					return;
				}
				this.fail();
				return;
			case "key-or-end":
				if (isWhitespace(c)) return;
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key-only":
				if (isWhitespace(c)) return;
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key":
				this.stepKey(c, at);
				return;
			case "colon":
				if (isWhitespace(c)) return;
				if (c === ":") {
					this.#mode = "value";
					return;
				}
				this.fail();
				return;
			case "value":
				this.beginValue(c, at);
				return;
			case "string": {
				const entry = this.#current;
				entry.end = at;
				this.#current = null;
				this.#mode = "comma-or-end";
				return;
			}
			case "scalar":
				this.stepScalar(c, at);
				return;
			case "nested":
				this.stepNested(c, at);
				return;
			case "comma-or-end":
				if (isWhitespace(c)) return;
				if (c === ",") {
					this.#mode = "key-only";
					return;
				}
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				this.fail();
				return;
			case "closed":
				if (isWhitespace(c)) return;
				this.fail();
				return;
			/* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
			case "invalid": return;
			/* v8 ignore next 2 -- Every scanner mode has a handler above. */
			default: assertNever(this.#mode);
		}
	}
	fail() {
		this.#invalidAt = this.#consumed;
		this.#mode = "invalid";
		this.#current = null;
	}
	beginKey(at) {
		this.#mode = "key";
		this.#keyStart = at + 1;
		this.#keyEscaped = false;
		this.#escape = false;
	}
	stepKey(c, at) {
		if (c < " ") {
			this.fail();
			return;
		}
		if (this.#escape) {
			this.#escape = false;
			return;
		}
		if (c === "\\") {
			this.#escape = true;
			this.#keyEscaped = true;
			return;
		}
		if (c !== "\"") return;
		const raw = this.slice(this.#keyStart, at);
		if (this.#keyEscaped) try {
			this.#key = JSON.parse(`"${raw}"`);
		} catch (_error) {
			this.fail();
			return;
		}
		else this.#key = raw;
		this.#mode = "colon";
	}
	open(entry) {
		if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
		this.#entries.set(this.#key, entry);
		this.#current = entry;
	}
	beginValue(c, at) {
		if (isWhitespace(c)) return;
		if (c === "\"") {
			this.open({
				kind: "string",
				start: at + 1,
				end: -1,
				needsDecoding: false,
				invalidAt: void 0,
				length: void 0,
				text: void 0,
				prefixes: void 0
			});
			this.#escape = false;
			this.#mode = "string";
			return;
		}
		if (c === "}" || c === "," || c === ":" || c === "]") {
			this.fail();
			return;
		}
		this.open({
			kind: "value",
			start: at,
			end: -1,
			parsed: void 0,
			invalid: false
		});
		if (c === "{" || c === "[") {
			this.#mode = "nested";
			this.#nestedEnds = [c === "{" ? "}" : "]"];
			this.#nestedInString = false;
			this.#escape = false;
			return;
		}
		this.#mode = "scalar";
	}
	stepScalar(c, at) {
		if (c !== "," && c !== "}" && !isWhitespace(c)) return;
		this.closeValue(at);
		this.#mode = c === "," ? "key-only" : c === "}" ? "closed" : "comma-or-end";
	}
	stepNested(c, at) {
		if (this.#nestedInString) {
			this.#nestedInString = false;
			return;
		}
		if (c === "\"") {
			this.#nestedInString = true;
			return;
		}
		if (c === "{" || c === "[") {
			this.#nestedEnds.push(c === "{" ? "}" : "]");
			return;
		}
		if (c === "}" || c === "]") {
			if (this.#nestedEnds.pop() !== c) {
				this.fail();
				return;
			}
			if (this.#nestedEnds.length === 0) {
				this.closeValue(at + 1);
				this.#mode = "comma-or-end";
			}
		}
	}
	closeValue(end) {
		const entry = this.#current;
		entry.end = end;
		this.#current = null;
	}
});
/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */
/**
* Mark an unreachable closed-union branch.
* @param value - impossible value; an unhandled typed variant fails at the call site.
* @param context - optional switch-site label included in the failure message.
* @returns never; a runtime value that escaped its type always throws.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
/**
* Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
* @param value - value to freeze.
* @returns the same value after every reachable enumerable child is frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		/* v8 ignore next -- the loop condition guarantees one pending task. */
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.2.1-rc.2_@deepseek-ai+cordis@4.0.5/node_modules/@deepseek-ai/dsh-llm/lib/types/message.js
/** Message value types, identity, and immutable construction helpers. */
/**
* Create one identified message and freeze it before publication.
* @param input - complete role, content, and source for a new message.
* @returns an immutable message with a fresh stable identity.
*/
function createMessage(input) {
	return deepFreeze(structuredClone({
		...input,
		id: brandString(randomUUID$1())
	}));
}
/**
* Create one identified user-role message and freeze it before publication.
* @param input - complete content and source for a new user message.
* @returns an immutable user message with a fresh stable identity.
*/
function createUserMessage(input) {
	return createMessage({
		...input,
		role: "user"
	});
}
//#endregion
//#region src/bridge/shell.ts
const SHELL_CONTEXT_PLUGIN = "dsh-oc";
/** Bounded per-stream retention; the child is always drained past the cap. */
const SHELL_OUTPUT_LIMIT_BYTES = 1048576;
/** Separate, smaller budgets for text sent to the configured model. */
const SHELL_CONTEXT_COMMAND_LIMIT_BYTES = 16384;
const SHELL_CONTEXT_STREAM_LIMIT_BYTES = 65536;
const SHELL_CONTEXT_TOTAL_LIMIT_BYTES = 147456;
const SHELL_CONTEXT_WARNING_LIMIT_BYTES = 1024;
function shellInvocation(command) {
	if (process.platform === "win32") return {
		file: process.env.ComSpec ?? "cmd.exe",
		args: [
			"/d",
			"/s",
			"/c",
			command
		],
		detached: false
	};
	return {
		file: process.env.SHELL && isAbsolute(process.env.SHELL) ? process.env.SHELL : "/bin/sh",
		args: ["-c", command],
		detached: true
	};
}
function signalOwnedProcess(child, signal) {
	if (process.platform === "win32") {
		if (child.pid !== void 0 && child.pid > 0) execFile("taskkill", [
			"/PID",
			String(child.pid),
			"/T"
		], { windowsHide: true }, () => {});
		return;
	}
	try {
		if (!child.killed) child.kill(signal);
	} catch {}
	if (child.pid !== void 0 && child.pid > 0) try {
		process.kill(-child.pid, signal);
	} catch {}
}
function forceKillOwnedProcess(child) {
	if (process.platform === "win32") {
		if (child.pid !== void 0 && child.pid > 0) execFile("taskkill", [
			"/PID",
			String(child.pid),
			"/T",
			"/F"
		], { windowsHide: true }, () => {});
		return;
	}
	signalOwnedProcess(child, "SIGKILL");
}
function runShellProcess(command, cwd, signal) {
	if (signal.aborted) return Promise.resolve({
		stdout: "",
		stderr: "",
		stdoutTruncated: false,
		stderrTruncated: false,
		exitCode: null,
		signal: null,
		aborted: true
	});
	const invocation = shellInvocation(command);
	let child;
	try {
		child = spawn(invocation.file, invocation.args, {
			cwd,
			detached: invocation.detached,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			env: {
				...process.env,
				TERM: "dumb"
			},
			windowsHide: true
		});
	} catch (error) {
		return Promise.resolve({
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			exitCode: null,
			signal: null,
			aborted: false,
			errorMessage: error instanceof Error ? error.message : String(error)
		});
	}
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let aborted = false;
		let settled = false;
		let forceTimer;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (forceTimer !== void 0) clearTimeout(forceTimer);
			signal.removeEventListener("abort", onAbort);
			resolve({
				...result,
				stdout,
				stderr,
				stdoutTruncated,
				stderrTruncated
			});
		};
		const appendLimited = (current, chunk, stream) => {
			const bytes = Buffer.from(String(chunk));
			const used = Buffer.byteLength(current);
			if (used >= 1048576) {
				if (stream === "stdout") stdoutTruncated = true;
				else stderrTruncated = true;
				return current;
			}
			if (used + bytes.byteLength <= 1048576) return current + bytes.toString();
			const keep = bytes.subarray(0, SHELL_OUTPUT_LIMIT_BYTES - used).toString();
			if (stream === "stdout") stdoutTruncated = true;
			else stderrTruncated = true;
			return current + keep;
		};
		const onAbort = () => {
			if (settled || aborted) return;
			aborted = true;
			signalOwnedProcess(child, "SIGTERM");
			forceTimer = setTimeout(() => forceKillOwnedProcess(child), 3e3);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		child.stdout.on("data", (chunk) => {
			stdout = appendLimited(stdout, chunk, "stdout");
		});
		child.stderr.on("data", (chunk) => {
			stderr = appendLimited(stderr, chunk, "stderr");
		});
		child.once("error", (error) => {
			finish({
				stdout,
				stderr,
				stdoutTruncated,
				stderrTruncated,
				exitCode: null,
				signal: null,
				aborted,
				errorMessage: error.message
			});
		});
		child.once("close", (exitCode, closeSignal) => {
			finish({
				stdout,
				stderr,
				stdoutTruncated,
				stderrTruncated,
				exitCode,
				signal: closeSignal,
				aborted
			});
		});
	});
}
function shellMessageInfo(sessionId, id, role, created, directory, agent, model, parentID) {
	if (role === "user") return {
		id,
		sessionID: sessionId,
		role,
		time: { created },
		agent,
		model
	};
	return {
		id,
		sessionID: sessionId,
		role,
		agent,
		mode: agent,
		time: { created },
		parentID,
		modelID: model.modelID,
		providerID: model.providerID,
		path: {
			cwd: directory,
			root: directory
		},
		cost: 0,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache: {
				read: 0,
				write: 0
			}
		}
	};
}
function shellUserPart(sessionId, messageId, created) {
	return {
		id: `${messageId}:0`,
		sessionID: sessionId,
		messageID: messageId,
		type: "text",
		text: "The following tool was executed by the user",
		synthetic: true,
		time: {
			start: created,
			end: created
		}
	};
}
function renderShellOutput(result) {
	let output = result.stdout;
	if (result.stdoutTruncated) output += `${output.length > 0 && !output.endsWith("\n") ? "\n" : ""}[stdout truncated after ${SHELL_OUTPUT_LIMIT_BYTES} bytes]`;
	if (result.stderr.length > 0) {
		if (output.length > 0 && !output.endsWith("\n")) output += "\n";
		output += `[stderr]\n${result.stderr}`;
	}
	if (result.stderrTruncated) {
		if (output.length > 0 && !output.endsWith("\n")) output += "\n";
		output += `[stderr truncated after ${SHELL_OUTPUT_LIMIT_BYTES} bytes]`;
	}
	if (result.errorMessage !== void 0) {
		if (output.length > 0 && !output.endsWith("\n")) output += "\n";
		output += `Error: ${result.errorMessage}`;
	}
	if (result.aborted) {
		if (output.length > 0 && !output.endsWith("\n")) output += "\n";
		output += "<metadata>\nUser aborted the command\n</metadata>";
	} else if (result.signal !== null) {
		if (output.length > 0 && !output.endsWith("\n")) output += "\n";
		output += `[killed by signal: ${result.signal}]`;
	} else if (result.exitCode !== null && result.exitCode !== 0) {
		if (output.length > 0 && !output.endsWith("\n")) output += "\n";
		output += `[exit code: ${result.exitCode}]`;
	}
	if (result.contextWarning !== void 0) {
		if (output.length > 0 && !output.endsWith("\n")) output += "\n";
		output += result.contextWarning;
	}
	return output.length === 0 ? "(no output)" : output;
}
/** Truncate on Unicode code-point boundaries while accounting in UTF-8 bytes. */
function truncateUtf8(value, limitBytes, marker) {
	if (Buffer.byteLength(value, "utf8") <= limitBytes) return value;
	const markerBytes = Buffer.byteLength(marker, "utf8");
	if (markerBytes >= limitBytes) {
		let clipped = "";
		let used = 0;
		for (const character of marker) {
			const size = Buffer.byteLength(character, "utf8");
			if (used + size > limitBytes) break;
			clipped += character;
			used += size;
		}
		return clipped;
	}
	let clipped = "";
	let used = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (used + size + markerBytes > limitBytes) break;
		clipped += character;
		used += size;
	}
	return clipped + marker;
}
function compactContextWarning(error) {
	return truncateUtf8((error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim() || "unknown injection error", SHELL_CONTEXT_WARNING_LIMIT_BYTES, " [truncated]");
}
function shellContextStatus(result) {
	const status = [];
	if (result.errorMessage !== void 0) status.push(`Error: ${compactContextWarning(result.errorMessage)}`);
	if (result.aborted) status.push("User aborted the command");
	else if (result.signal !== null) status.push(`killed by signal: ${result.signal}`);
	else if (result.exitCode !== null && result.exitCode !== 0) status.push(`[exit code: ${result.exitCode}]`);
	return status.join("\n");
}
function renderShellContextOutput(result) {
	const stdoutMarker = `[stdout truncated for model context after ${SHELL_CONTEXT_STREAM_LIMIT_BYTES} UTF-8 bytes]`;
	const stderrMarker = `[stderr truncated for model context after ${SHELL_CONTEXT_STREAM_LIMIT_BYTES} UTF-8 bytes]`;
	const stdoutNeedsMarker = result.stdoutTruncated || Buffer.byteLength(result.stdout, "utf8") > 65536;
	const stderrNeedsMarker = result.stderrTruncated || Buffer.byteLength(result.stderr, "utf8") > 65536;
	const stdoutLimit = stdoutNeedsMarker ? Math.max(0, SHELL_CONTEXT_STREAM_LIMIT_BYTES - Buffer.byteLength(stdoutMarker, "utf8") - 1) : SHELL_CONTEXT_STREAM_LIMIT_BYTES;
	const stderrLimit = stderrNeedsMarker ? Math.max(0, SHELL_CONTEXT_STREAM_LIMIT_BYTES - Buffer.byteLength(stderrMarker, "utf8") - 1) : SHELL_CONTEXT_STREAM_LIMIT_BYTES;
	let output = "";
	if (stdoutNeedsMarker) output += `${stdoutMarker}\n`;
	if (stderrNeedsMarker) output += `${stderrMarker}\n`;
	output += truncateUtf8(result.stdout, stdoutLimit, "");
	if (result.stderr.length > 0 || result.stderrTruncated) {
		if (output.length > 0 && !output.endsWith("\n")) output += "\n";
		output += "[stderr]\n";
		output += truncateUtf8(result.stderr, stderrLimit, "");
	}
	return output.length === 0 ? "(no output)" : output;
}
/**
* Build the model-facing record for a completed `!` shell command.
*
* `Agent.inject()` is the dsh host seam for non-waking context.  The command
* therefore enters the durable `agent/inbox/spliced` next-step pending queue;
* after the agent claims it, the message is included in the next model request
* together with the real prompt, without opening an LLM turn by itself. Keep
* the prose explicit: the model must distinguish a command the human ran from
* a command it requested through a tool call.
*/
function shellContextMessage(command, result) {
	const commandText = truncateUtf8(command, SHELL_CONTEXT_COMMAND_LIMIT_BYTES, `[command truncated for model context after ${SHELL_CONTEXT_COMMAND_LIMIT_BYTES} UTF-8 bytes]`);
	const status = shellContextStatus(result);
	return createUserMessage({
		content: [{
			type: "text",
			text: truncateUtf8([
				"The user manually executed a shell command through OpenCode ! shell mode.",
				"Source: user manually executed this command; it was not a model-requested tool call.",
				...status === "" ? [] : [`Status:\n${status}`],
				`Command:\n${commandText}`,
				`Output:\n${renderShellContextOutput(result)}`
			].join("\n\n"), SHELL_CONTEXT_TOTAL_LIMIT_BYTES, `[dsh-oc] shell model context truncated after ${SHELL_CONTEXT_TOTAL_LIMIT_BYTES} UTF-8 bytes`)
		}],
		source: {
			kind: "dsh-oc",
			plugin: SHELL_CONTEXT_PLUGIN,
			form: "notice",
			summary: "The user manually executed a shell command"
		}
	});
}
function shellError(result) {
	if (result.errorMessage !== void 0) return { name: result.errorMessage };
}
function agentForShell(value) {
	if (value === null || typeof value !== "object") return void 0;
	const candidate = value;
	return typeof candidate.runMaintenance === "function" ? candidate : void 0;
}
function shellDirectory(ctx, sessionId, requested) {
	const sessionDirectory = ctx.state.sessionDirectories.get(sessionId);
	if (sessionDirectory !== void 0) return sessionDirectory;
	if (requested === void 0) return ctx.cwd;
	return isAbsolute(requested) ? requested : resolve(ctx.cwd, requested);
}
/**
* Execute one OpenCode shell-mode request as a user-authorized maintenance
* operation.  This deliberately does not call `ctx.tools.execute`: that API
* is model-direct and collapses non-`run_code` calls for PTC agents; moreover
* dsh approval audit events require an open model turn.  OpenCode's explicit
* `!` is the authorization boundary, so this path inherits the OS user and
* owns only its exact child process/group.
*/
async function runShellCommand(ctx, sessionId, body) {
	if (typeof body.command !== "string" || body.command.trim().length === 0) throw badRequest("shell command requires a non-empty command");
	let resolvedAgent;
	try {
		resolvedAgent = ctx.api.agents?.get(sessionId);
		if (resolvedAgent === void 0) resolvedAgent = await resolveAgent(ctx.api, sessionId);
	} catch (error) {
		if (error instanceof RpcCallError) throw rpcErrorToHttp(error);
		throw conflict(`shell mode unavailable: ${error instanceof Error ? error.message : String(error)}`, { sessionId });
	}
	const agent = agentForShell(resolvedAgent);
	if (agent === void 0) throw internalError("shell mode unavailable: Agent.runMaintenance ABI is missing", { sessionId });
	if (typeof agent.inject !== "function") throw internalError("shell mode unavailable: Agent.inject ABI is missing", { sessionId });
	const requestedAgent = body.agent?.trim();
	if (body.agent !== void 0 && requestedAgent === "") throw badRequest("shell request agent must be non-empty");
	const knownAgent = ctx.state.sessionAgentFor(sessionId);
	if (requestedAgent !== void 0 && knownAgent !== void 0 && requestedAgent !== knownAgent) throw badRequest(`shell request agent "${requestedAgent}" does not match active session agent "${knownAgent}"`);
	if (requestedAgent !== void 0 && requestedAgent !== "build") {
		if (!(await ctx.api.agentPresets.list()).some((preset) => preset.id === requestedAgent && preset.broken === void 0)) throw badRequest(`agent "${requestedAgent}" is not available for shell mode`);
	}
	const directory = shellDirectory(ctx, sessionId, body.workdir);
	if (ctx.state.isSessionCleared(sessionId)) throw notFound(`session "${sessionId}" not found`);
	const project = projectIdFor(directory);
	const agentName = requestedAgent ?? knownAgent ?? "build";
	const sessionModel = ctx.state.sessionModelSelectionFor(sessionId);
	const model = {
		providerID: externalProviderId(body.model?.providerID?.trim() || sessionModel?.providerID || "deepseek"),
		modelID: body.model?.modelID?.trim() || sessionModel?.modelID || "deepseek-chat"
	};
	ctx.state.markSessionPresent(sessionId);
	let maintenance;
	try {
		maintenance = agent.runMaintenance(async (agentSignal) => {
			const userId = `msg_shell:user:${randomUUID()}`;
			const assistantId = `msg_shell:${randomUUID()}`;
			const callId = `call_shell:${randomUUID()}`;
			const created = Date.now();
			const userInfo = shellMessageInfo(sessionId, userId, "user", created, directory, agentName, model);
			const userPart = shellUserPart(sessionId, userId, created);
			const assistantInfo = shellMessageInfo(sessionId, assistantId, "assistant", created, directory, agentName, model, userId);
			const call = {
				callId,
				name: "bash",
				arguments: JSON.stringify({
					command: body.command,
					description: `Run shell command: ${body.command}`
				})
			};
			const running = runningToolPart(call, {
				sessionID: sessionId,
				messageID: assistantId,
				time: created
			});
			const controller = new AbortController();
			const disposeController = ctx.state.trackShellController(sessionId, controller);
			const onAgentAbort = () => controller.abort(agentSignal.reason);
			let result = {
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				exitCode: null,
				signal: null,
				aborted: false,
				errorMessage: "shell execution did not settle"
			};
			let finalized = false;
			let finishedInfo = assistantInfo;
			let finishedPart;
			const finalize = () => {
				if (finalized) return;
				finalized = true;
				const completed = Date.now();
				const output = renderShellOutput(result);
				const resultInfo = {
					callId,
					content: [{
						type: "text",
						text: output
					}],
					time: completed,
					...shellError(result) === void 0 ? {} : { error: shellError(result) }
				};
				finishedPart = shellError(result) === void 0 ? completedToolPart(call, resultInfo, {
					sessionID: sessionId,
					messageID: assistantId,
					time: created
				}) : errorToolPart(call, resultInfo, {
					sessionID: sessionId,
					messageID: assistantId,
					time: created
				});
				finishedInfo = {
					...assistantInfo,
					time: {
						created,
						completed
					}
				};
				if (ctx.state.isSessionCleared(sessionId)) return;
				try {
					ctx.state.upsertCommandResult(sessionId, {
						info: finishedInfo,
						parts: [finishedPart]
					});
					ctx.state.setSessionRunning(sessionId, false, completed);
					const idle = ctx.state.shouldBroadcastSessionStatus(sessionId, false);
					ctx.hub.broadcast([
						makeEvent(directory, "message.updated", {
							sessionID: sessionId,
							info: finishedInfo
						}, project),
						makeEvent(directory, "message.part.updated", {
							sessionID: sessionId,
							part: finishedPart
						}, project),
						...idle ? [makeEvent(directory, "session.status", {
							sessionID: sessionId,
							status: { type: "idle" }
						}, project)] : [],
						makeEvent(directory, "session.idle", { sessionID: sessionId }, project)
					]);
				} catch (error) {
					ctx.log(`[bridge] shell finalization failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			};
			try {
				agentSignal.addEventListener("abort", onAgentAbort, { once: true });
				if (agentSignal.aborted) onAgentAbort();
				ctx.state.setSessionRunning(sessionId, true, created);
				const busy = ctx.state.shouldBroadcastSessionStatus(sessionId, true);
				ctx.hub.broadcast([
					...busy ? [makeEvent(directory, "session.status", {
						sessionID: sessionId,
						status: { type: "busy" }
					}, project)] : [],
					makeEvent(directory, "message.updated", {
						sessionID: sessionId,
						info: userInfo
					}, project),
					makeEvent(directory, "message.part.updated", {
						sessionID: sessionId,
						part: userPart
					}, project),
					makeEvent(directory, "message.updated", {
						sessionID: sessionId,
						info: assistantInfo
					}, project),
					makeEvent(directory, "message.part.updated", {
						sessionID: sessionId,
						part: running
					}, project)
				]);
				ctx.state.recordCommandResult(sessionId, {
					info: userInfo,
					parts: [userPart]
				});
				ctx.state.recordCommandResult(sessionId, {
					info: assistantInfo,
					parts: [running]
				});
				result = await runShellProcess(body.command, directory, controller.signal);
				if (!ctx.state.isSessionCleared(sessionId)) try {
					agent.inject(shellContextMessage(body.command, result));
				} catch (error) {
					const reason = compactContextWarning(error);
					result = {
						...result,
						contextWarning: `[dsh-oc] shell command/output was not added to model context: ${reason}`
					};
					ctx.log(`[bridge] shell context injection failed: ${reason}`);
				}
			} catch (error) {
				result = {
					stdout: "",
					stderr: "",
					stdoutTruncated: false,
					stderrTruncated: false,
					exitCode: null,
					signal: null,
					aborted: controller.signal.aborted,
					errorMessage: error instanceof Error ? error.message : String(error)
				};
			} finally {
				agentSignal.removeEventListener("abort", onAgentAbort);
				disposeController();
				finalize();
			}
			return {
				info: finishedInfo,
				parts: finishedPart === void 0 ? [] : [finishedPart]
			};
		});
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw conflict(`shell mode unavailable: ${error instanceof Error ? error.message : String(error)}`, { sessionId });
	}
	const disposeMaintenance = ctx.state.trackShellPromise(sessionId, maintenance);
	try {
		return await maintenance;
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw conflict(`shell mode unavailable: ${error instanceof Error ? error.message : String(error)}`, { sessionId });
	} finally {
		disposeMaintenance();
	}
}
//#endregion
//#region src/bridge/router.ts
/** Abort only user shell calls started by this bridge/session. */
function abortShellCommand(ctx, sessionId) {
	return ctx.state.abortShell(sessionId);
}
function json(status, body) {
	return {
		status,
		body
	};
}
function sid(id) {
	return id;
}
async function rpc(ctx, method, payload, signal) {
	try {
		return await call(ctx.api, method, resolveSessionPayload(ctx, payload), signal);
	} catch (error) {
		if (error instanceof RpcCallError) throw rpcErrorToHttp(error);
		throw internalError(error instanceof Error ? error.message : String(error));
	}
}
/**
* Point a dsh call at the session the opencode id currently maps to.
*
* A revert forks the dsh session at the boundary, so the opencode session id
* keeps its identity while the conversation moves to the fork. Every dsh
* call goes through `rpc`, so resolving the id here covers all of them.
*/
function resolveSessionPayload(ctx, payload) {
	const raw = payload.sessionId;
	if (typeof raw !== "string") return payload;
	const resolved = ctx.state.resolveSessionId(raw);
	if (resolved === raw) return payload;
	return {
		...payload,
		sessionId: resolved
	};
}
function bodyAsRecord(body) {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
	return body;
}
function locationInfo(ctx) {
	return {
		directory: ctx.cwd,
		project: {
			id: projectIdFor(ctx.cwd),
			directory: ctx.cwd
		}
	};
}
function v2LocationBody(ctx) {
	return {
		location: locationInfo(ctx),
		data: []
	};
}
function sessionDirectoryFrom(items, summary, fallback) {
	if (summary?.cwd) return summary.cwd;
	if (summary?.parentSessionId !== void 0) {
		const parent = items.find((item) => String(item.sessionId) === String(summary.parentSessionId));
		if (parent?.cwd) return parent.cwd;
	}
	return fallback;
}
function projectionValuesFor(item) {
	return item.projections?.values ?? {};
}
function stringProjection(values, key) {
	const value = values[key];
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
/** Convert one dsh list row into the child facts needed by Task rendering. */
function subagentChildFromSummary(item, fallbackCwd, addedAt = Date.now(), allowFifo = false) {
	if (item.origin !== "subagent" || item.parentSessionId === void 0) return void 0;
	const values = projectionValuesFor(item);
	const identity = values.subagent;
	const mode = identity?.mode === "one-shot" || identity?.mode === "continuable" ? identity.mode : values.mode === "one-shot" || values.mode === "continuable" ? values.mode : void 0;
	const label = typeof identity?.label === "string" && identity.label.length > 0 ? identity.label : void 0;
	const title = stringProjection(values, "title");
	const agent = typeof item.agentPreset === "string" && item.agentPreset.length > 0 ? item.agentPreset : stringProjection(values, "agentPreset");
	return {
		sessionId: String(item.sessionId),
		parentSessionId: String(item.parentSessionId),
		...label === void 0 ? {} : { label },
		...mode === void 0 ? {} : { mode },
		...title === void 0 ? {} : { title },
		...agent === void 0 ? {} : { agent },
		cwd: item.cwd ?? fallbackCwd,
		addedAt,
		...allowFifo ? { allowFifo: true } : {}
	};
}
/** Lineage fields that every replacement `session.updated` must retain. */
function sessionLineageOptions(ctx, sessionId) {
	const parentID = ctx.state.sessionParents.get(sessionId);
	if (parentID === void 0) return {};
	return {
		parentID,
		...ctx.state.isSubagentSession(sessionId) ? { metadata: { origin: "subagent" } } : {}
	};
}
/** Resolve a historical dsh delegation against cached child summaries. */
function subagentMetadataForHistory(ctx, parentSessionId, call) {
	if (!isSubagentToolName(call.name)) return void 0;
	const existing = ctx.state.subagentChildForCall(parentSessionId, call.callId);
	const record = subagentCallRecord(parentSessionId, call, `history:${call.callId}`, 0);
	const child = existing ?? (record === void 0 ? void 0 : ctx.state.bindSubagentCallForHistory(record));
	if (child === void 0) return void 0;
	return {
		sessionId: child.sessionId,
		parentSessionId,
		...child.mode === void 0 ? {} : { mode: child.mode },
		...bodyAsRecord(safeJsonParse(call.arguments)).run_in_background === true ? { background: true } : {}
	};
}
/** Whether a history page contains a dsh delegation whose child can be linked. */
function historyNeedsSubagentContext(events) {
	return events.some((entry) => {
		const event = entry.event;
		if (event.type === "tool/call") return isSubagentToolName(String(event.data?.name ?? ""));
		if (event.type !== "assistant/message") return false;
		const content = event.data?.message?.content;
		return Array.isArray(content) && content.some((block) => {
			const value = block;
			return value?.type === "tool-call" && isSubagentToolName(String(value.name ?? ""));
		});
	});
}
/** Lazily seed child summaries for direct history requests that skipped /session. */
async function ensureSubagentHistoryContext(ctx, sessionId, events) {
	if (!historyNeedsSubagentContext(events)) return;
	if ([...ctx.state.subagentChildren.values()].some((child) => child.parentSessionId === sessionId)) return;
	try {
		recordSessionSummaries(ctx, await cachedSessionList(ctx));
	} catch (error) {
		ctx.log(`[bridge/subagent] history child seed failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/** Build the shared record used by live and host-side delegation correlation. */
function subagentCallRecord(parentSessionId, call, messageId, time, turn, step) {
	if (!isSubagentToolName(call.name)) return void 0;
	const input = safeJsonParse(call.arguments);
	const description = typeof input.description === "string" ? input.description : call.name;
	const prompt = typeof input.prompt === "string" ? input.prompt : "";
	const subagentType = typeof input.subagent_type === "string" && input.subagent_type.trim() !== "" ? input.subagent_type : subagentTypeFromToolName(call.name);
	return {
		parentSessionId,
		callId: call.callId,
		toolName: call.name,
		messageId,
		description,
		prompt,
		subagentType,
		...input.run_in_background === true ? { background: true } : {},
		...turn === void 0 ? {} : { turn },
		...step === void 0 ? {} : { step },
		createdAt: time,
		arguments: call.arguments
	};
}
/**
* Record child cwd and parent lineage from a session list. A subagent child
* without its own cwd inherits the nearest parent's cwd so the TUI opens and
* filters its events in the same project directory.
*/
function recordSessionSummaries(ctx, items, allowSubagentFifo = false) {
	const directories = /* @__PURE__ */ new Map();
	for (const item of items) if (item.cwd) directories.set(String(item.sessionId), item.cwd);
	for (const item of items) {
		const id = String(item.sessionId);
		if (!directories.has(id)) {
			const parentId = item.parentSessionId === void 0 ? void 0 : String(item.parentSessionId);
			directories.set(id, (parentId === void 0 ? void 0 : directories.get(parentId)) ?? ctx.cwd);
		}
	}
	for (const item of items) {
		const id = String(item.sessionId);
		ctx.state.markSessionPresent(id);
		ctx.state.sessionDirectories.set(id, directories.get(id) ?? ctx.cwd);
		if (ctx.state.sessionRunningFor(id) === void 0) ctx.state.setSessionRunning(id, item.running, item.updatedAt);
		const projectionValues = projectionValuesFor(item);
		const projectedTitle = stringProjection(projectionValues, "title");
		if (projectedTitle !== void 0 && ctx.state.sessionTitleFor(id) === void 0) ctx.state.setSessionTitle(id, projectedTitle);
		const projectedAgent = projectionValues.agentPreset;
		const agent = item.agentPreset ?? item.agent ?? projectedAgent;
		if (typeof agent === "string" && agent.length > 0 && ctx.state.sessionAgentFor(id) === void 0) ctx.state.setSessionAgent(id, agent);
		if (item.origin === "subagent" && item.parentSessionId !== void 0) {
			const child = subagentChildFromSummary(item, directories.get(id) ?? ctx.cwd, Date.now(), allowSubagentFifo);
			if (child !== void 0) ctx.state.associateSubagentChild(child);
			else {
				ctx.state.sessionOrigins.add(id);
				ctx.state.sessionParents.set(id, String(item.parentSessionId));
			}
		}
	}
}
/** Filter dsh session summaries by a TUI-provided `directory` query. */
function filterSessionsByDirectory(items, directory, base) {
	if (directory === void 0 || directory.length === 0) return [...items];
	const normalized = resolve(base, directory);
	return items.filter((item) => {
		if (typeof item.cwd !== "string") return true;
		return resolve(base, item.cwd) === normalized;
	});
}
async function sessionView(ctx, id) {
	ctx.state.setCurrentSession(id);
	const dshId = ctx.state.resolveSessionId(id);
	const list = await cachedSessionList(ctx);
	const summary = list.find((item) => String(item.sessionId) === dshId);
	recordSessionSummaries(ctx, list);
	const cwd = sessionDirectoryFrom(list, summary, ctx.cwd);
	const history = await cachedSessionHistory(ctx, dshId);
	let model;
	try {
		const selection = await sessionModelSelectionRef(ctx, dshId);
		model = {
			id: selection.modelID,
			providerID: selection.providerID,
			...selection.variant === void 0 ? {} : { variant: selection.variant }
		};
	} catch (error) {
		ctx.log(`[bridge/session] model selection unavailable for ${id}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		summary,
		events: history.events,
		createdAt: history.events[0]?.event.time,
		...model === void 0 ? {} : { model },
		cwd
	};
}
/** Encode an opaque v2 message cursor pointing before a surface event seq. */
function encodeMessageCursor(beforeSeq) {
	return Buffer.from(JSON.stringify({
		v: 1,
		beforeSeq
	}), "utf8").toString("base64url");
}
/** Decode an opaque v2 message cursor produced by {@link encodeMessageCursor}. */
function decodeMessageCursor(raw) {
	try {
		const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (parsed.v === 1 && typeof parsed.beforeSeq === "number" && Number.isFinite(parsed.beforeSeq)) return parsed.beforeSeq;
	} catch {}
	throw badRequest("invalid message cursor");
}
/** Encode an opaque v2 session-list cursor for the next page offset. */
function encodeSessionCursor(offset) {
	return Buffer.from(JSON.stringify({
		v: 1,
		offset
	}), "utf8").toString("base64url");
}
/** Decode an opaque v2 session-list cursor produced by {@link encodeSessionCursor}. */
function decodeSessionCursor(raw) {
	try {
		const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (parsed.v === 1 && typeof parsed.offset === "number" && Number.isFinite(parsed.offset) && parsed.offset >= 0) return parsed.offset;
	} catch {}
	throw badRequest("invalid session cursor");
}
/** Oldest surface-message seq in a history page (pagination anchor). */
function oldestSurfaceSeq(events) {
	let oldest;
	for (const entry of events) {
		const type = entry.event.type;
		if (type === "user/message" || type === "assistant/message" || type === "tool/result") {
			if (oldest === void 0 || entry.event.seq < oldest) oldest = entry.event.seq;
		}
	}
	return oldest;
}
const SESSION_LIST_CACHE_MS = 1e3;
function historyCacheKey(sessionId, maxMessages, beforeSeq) {
	return `${sessionId}:${maxMessages ?? "tail"}:${beforeSeq ?? "tail"}`;
}
/** Read session.list through a short-lived cache (invalidated by mutations/SSE). */
async function cachedSessionList(ctx) {
	const cached = ctx.state.getSessionListCache(SESSION_LIST_CACHE_MS);
	if (cached !== void 0) {
		recordSessionSummaries(ctx, cached);
		return cached;
	}
	const existing = ctx.state.sessionListLoading;
	if (existing !== void 0) return existing;
	const generation = ctx.state.listGeneration();
	ctx.state.sessionListRpcCalls++;
	const promise = rpc(ctx, "session.list", {}).then((list) => list.items);
	ctx.state.sessionListLoading = promise;
	try {
		const items = await promise;
		if (ctx.state.listGeneration() === generation) ctx.state.setSessionListCache(items);
		recordSessionSummaries(ctx, items);
		return items;
	} finally {
		if (ctx.state.sessionListLoading === promise) ctx.state.sessionListLoading = void 0;
	}
}
/** Read a history page through a short-lived per-page cache. */
async function cachedSessionHistory(ctx, sessionId, options = {}) {
	const key = historyCacheKey(sessionId, options.maxMessages, options.beforeSeq);
	const cached = ctx.state.getHistoryCache(key, 500);
	if (cached !== void 0) return cached;
	const existing = ctx.state.getHistoryLoading(key);
	if (existing !== void 0) return existing;
	const generation = ctx.state.historyGeneration(key);
	const promise = rpc(ctx, "session.history", {
		sessionId: sid(sessionId),
		...options.maxMessages === void 0 ? {} : { maxMessages: options.maxMessages },
		...options.beforeSeq === void 0 ? {} : { beforeSeq: options.beforeSeq }
	}).then((history) => ({
		events: history.events,
		hasMore: history.hasMore,
		...history.projections === void 0 ? {} : { projections: history.projections }
	}));
	ctx.state.setHistoryLoading(key, promise);
	try {
		const value = await promise;
		if (ctx.state.historyGeneration(key) === generation) {
			ctx.state.setHistoryCache(key, value);
			const title = value.projections === void 0 ? void 0 : value.projections.values.title;
			ctx.state.setSessionTitle(sessionId, title);
			seedDerivedHistoryPage(ctx, sessionId, value, options);
		}
		return value;
	} finally {
		ctx.state.clearHistoryLoading(key, promise);
	}
}
/**
* dsh's `session.list` rows carry no projections, so real titles only come
* from each session's history tail. Warm the first few visible sessions
* (bounded, parallel) so the list shows durable titles instead of directory
* basenames; blank sessions have no title and are skipped.
*/
async function warmListTitles(ctx, items) {
	const missing = items.filter((item) => !item.blank && ctx.state.sessionTitleFor(String(item.sessionId)) === void 0);
	if (missing.length === 0) return;
	if (missing.length <= 40) {
		await warmTitles(ctx, missing);
		return;
	}
	warmTitles(ctx, missing.slice(0, 24));
}
/** Read the title-bearing history tail for candidates with bounded concurrency. */
async function warmTitles(ctx, candidates) {
	if (candidates.length === 0) return;
	let next = 0;
	const workers = Array.from({ length: Math.min(2, candidates.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= candidates.length) return;
			const id = String(candidates[index].sessionId);
			try {
				await cachedSessionHistory(ctx, id, { maxMessages: 1 });
			} catch (error) {
				ctx.log(`[bridge/session-title] warm failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});
	await Promise.allSettled(workers);
}
/**
* The TUI opens a session through `/session/:id` (full tail) and then fetches
* `/session/:id/message` (default limit 100). Those are different cache keys,
* so without seeding the second read would repeat the same dsh history RPC.
* Seed the derived page when the loaded window provably covers it (and vice
* versa when a 100-message page is the whole history).
*/
function seedDerivedHistoryPage(ctx, sessionId, value, options) {
	if (options.beforeSeq !== void 0) return;
	if (options.maxMessages === void 0 && !value.hasMore) {
		const pageKey = historyCacheKey(sessionId, 100, void 0);
		if (ctx.state.getHistoryCache(pageKey, 500) === void 0) ctx.state.setHistoryCache(pageKey, {
			events: value.events,
			hasMore: false,
			...value.projections === void 0 ? {} : { projections: value.projections }
		});
	} else if (options.maxMessages === 100 && !value.hasMore) {
		const tailKey = historyCacheKey(sessionId, void 0, void 0);
		if (ctx.state.getHistoryCache(tailKey, 500) === void 0) ctx.state.setHistoryCache(tailKey, value);
	}
}
/** Pick a session for a directory query (or the most recent one). */
async function sessionForDirectory(ctx, directory) {
	const items = await cachedSessionList(ctx);
	if (directory !== void 0 && directory.length > 0) {
		const normalized = resolve(ctx.cwd, directory);
		return items.find((item) => typeof item.cwd === "string" && resolve(ctx.cwd, item.cwd) === normalized);
	}
	return items[0];
}
/** Resolve the dsh skill catalog for the session matching a directory query. */
async function skillList(ctx, directory) {
	const session = await sessionForDirectory(ctx, directory);
	const skills = [];
	if (session !== void 0) try {
		const result = await rpc(ctx, "skill.list", { sessionId: sid(String(session.sessionId)) });
		skills.push(...result.skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			...skill.whenToUse === void 0 ? {} : { whenToUse: skill.whenToUse }
		})));
	} catch (error) {
		ctx.log(`[bridge] skill.list failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	skills.push(...fakeSkillEntries());
	return skills;
}
/** dsh skills exposed as opencode v2 slash commands. */
async function skillCommandsV2(ctx, directory) {
	return (await skillList(ctx, directory)).map((skill) => ({
		name: skill.name,
		template: skill.name,
		description: skill.description
	}));
}
/** Skill catalog for one specific session (used by the command route). */
async function skillListForSession(ctx, sessionId) {
	const skills = [];
	try {
		const result = await rpc(ctx, "skill.list", { sessionId: sid(sessionId) });
		skills.push(...result.skills.map((skill) => ({
			name: skill.name,
			description: skill.description
		})));
	} catch (error) {
		ctx.log(`[bridge] skill.list failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
	}
	skills.push(...fakeSkillEntries());
	return skills;
}
/** Test-only fake skills injected via `DSH_OC_E2E_FAKE_SKILLS=name1,name2`. */
function fakeSkillEntries() {
	const raw = process.env.DSH_OC_E2E_FAKE_SKILLS;
	if (raw === void 0 || raw.trim() === "") return [];
	return raw.split(",").map((item) => item.trim()).filter(Boolean).map((name) => ({
		name,
		description: `e2e fake skill ${name}`,
		whenToUse: `Use ${name} in e2e`
	}));
}
/**
* The project the bridge serves.
*
* The official opencode server derives its project list from the directories
* it serves, so the bridge publishes the working directory it runs in. A
* browser UI picks a workspace from that list.
*/
function projectInfo(ctx) {
	const directory = ctx.cwd;
	return {
		id: projectIdFor(directory),
		canonical: directory,
		name: directory.split(/[/\\]+/).filter(Boolean).pop() ?? directory,
		time: {
			created: 0,
			updated: 0,
			active: 0
		},
		sandboxes: []
	};
}
function toV2Session(view, id, ctx) {
	const revert = stagedRevertFor(ctx, id);
	return {
		...view.summary === void 0 ? minimalSessionV2(id, {
			cwd: view.cwd ?? ctx.cwd,
			createdAt: view.createdAt,
			...view.model === void 0 ? {} : { model: view.model },
			...ctx.state.sessionAgentFor(id) === void 0 ? {} : { agent: ctx.state.sessionAgentFor(id) },
			...ctx.state.sessionParents.get(id) === void 0 ? {} : { parentID: ctx.state.sessionParents.get(id) },
			...sessionLineageOptions(ctx, id),
			...revert === void 0 ? {} : { revert }
		}) : convertSessionSummaryV2(view.summary, {
			cwd: view.cwd ?? ctx.cwd,
			createdAt: view.createdAt,
			...view.model === void 0 ? {} : { model: view.model },
			...ctx.state.sessionAgentFor(id) === void 0 ? {} : { agent: ctx.state.sessionAgentFor(id) },
			...sessionLineageOptions(ctx, id).metadata === void 0 ? {} : { metadata: sessionLineageOptions(ctx, id).metadata },
			...revert === void 0 ? {} : { revert }
		}),
		id
	};
}
/**
* The staged revert of a session in the shape OpenCode reports it
* (`Session.Info.revert`).
*/
function stagedRevertFor(ctx, sessionId) {
	const staged = ctx.state.revertBoundary(sessionId);
	if (staged === void 0) return void 0;
	return {
		messageID: staged.messageID,
		...staged.files.length === 0 ? {} : { files: staged.files }
	};
}
/**
* Publish one OpenCode 2.x native event from a route handler.
*
* The dsh event translator owns the events that come from a session's
* history, but a few OpenCode features (the revert boundary) are driven by
* the client and have no dsh counterpart, so the route publishes them
* itself.
*/
function publishV2Event(ctx, type, data, sessionId) {
	const directory = sessionId === void 0 ? ctx.cwd : ctx.state.sessionDirectories.get(sessionId) ?? ctx.cwd;
	ctx.hub.broadcast([makeV2Event(directory, type, data, projectIdFor(directory), sessionId)]);
}
async function modelGroups(ctx) {
	return (await rpc(ctx, "llm.models", {})).groups;
}
/** The model dsh uses for a session that has no explicit selection. */
async function modelCatalogDefault(ctx) {
	try {
		const catalog = await rpc(ctx, "llm.models", {});
		const provider = catalog.default?.provider;
		const model = catalog.default?.model;
		if (typeof provider !== "string" || typeof model !== "string") return void 0;
		return {
			provider,
			model,
			...typeof catalog.default?.reasoningEffort === "string" ? { reasoningEffort: catalog.default.reasoningEffort } : {}
		};
	} catch (error) {
		ctx.log(`[bridge/model] default selection unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
}
/**
* The model catalog the OpenCode clients read, with the configured default
* standing in when dsh reports no catalog group.
*
* dsh only lists a provider's models once the provider has a usable
* credential. Without one the catalog is empty, and a client that resolves its
* model against that catalog (the TUI does) has nothing to select: it shows
* "No provider selected" and offers the OpenCode integration flow, which dsh
* does not use. Publishing the configured default keeps the model visible;
* the missing credential then surfaces on the first prompt instead of hiding
* the model entirely.
*/
async function modelGroupsForClients(ctx) {
	const groups = await modelGroups(ctx);
	if (groups.length > 0) return groups;
	const fallback = await modelCatalogDefault(ctx);
	if (fallback === void 0) return groups;
	return [{
		id: fallback.provider,
		name: externalProviderName(fallback.provider),
		models: [{
			id: fallback.model,
			name: displayModelName(fallback.model)
		}]
	}];
}
const TEXT_MIME_PREFIXES = /* @__PURE__ */ new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/typescript",
	"application/x-yaml",
	"application/yaml",
	"application/toml",
	"application/x-toml",
	"application/x-sh",
	"application/x-python"
]);
const TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
	".txt",
	".md",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".jsonc",
	".yaml",
	".yml",
	".toml",
	".sh",
	".py",
	".rs",
	".go",
	".c",
	".h",
	".cpp",
	".hpp",
	".java",
	".sql",
	".css",
	".html",
	".xml",
	".csv",
	".log"
]);
function isTextMime(mime) {
	const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
	return normalized.startsWith("text/") || TEXT_MIME_PREFIXES.has(normalized);
}
function isTextFile(path, mime) {
	return isTextMime(mime) || TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}
function filePartToContent(part, cwd) {
	const url = typeof part.url === "string" ? part.url : "";
	const mime = typeof part.mime === "string" ? part.mime : "";
	if (url.length === 0 || mime.length === 0) throw badRequest("file part requires url and mime");
	const dataMatch = /^data:([^;,]+);base64,(.+)$/.exec(url);
	if (dataMatch) {
		const [, mediaType, data] = dataMatch;
		if (!mediaType || !data) throw badRequest("invalid file data URL");
		if (mediaType.startsWith("image/")) return {
			type: "image",
			mediaType,
			data
		};
		if (isTextMime(mediaType)) return {
			type: "text",
			text: Buffer.from(data, "base64").toString("utf8")
		};
		throw badRequest(`unsupported file mime "${mediaType}" (dsh supports text and image parts)`);
	}
	let filePath;
	if (url.startsWith("file://")) try {
		filePath = fileURLToPath(url);
	} catch {
		throw badRequest(`invalid file part url: ${url}`);
	}
	else filePath = url;
	const resolved = resolve(cwd, filePath);
	const rel = relative(cwd, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) throw badRequest("file part path must be inside the session cwd");
	let stat;
	try {
		stat = statSync(resolved);
	} catch {
		throw badRequest(`file part path not readable: ${filePath}`);
	}
	if (!stat.isFile()) throw badRequest("file part path must be a file");
	const mediaType = mime.split(";")[0]?.trim() ?? "";
	if (mediaType.startsWith("image/")) return {
		type: "image",
		mediaType,
		data: readFileSync(resolved).toString("base64")
	};
	if (isTextFile(resolved, mediaType)) return {
		type: "text",
		text: readFileSync(resolved, "utf8")
	};
	throw badRequest(`unsupported file mime "${mediaType}" (dsh supports text and image parts)`);
}
function parsePromptParts(raw, cwd) {
	if (!Array.isArray(raw)) throw badRequest("prompt body requires a parts array");
	const parts = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object") throw badRequest("invalid prompt part");
		const part = entry;
		if (part.type === "text") {
			if (typeof part.text !== "string") throw badRequest("text part requires a string text");
			parts.push({
				type: "text",
				text: part.text
			});
			continue;
		}
		if (part.type === "file") {
			parts.push(filePartToContent(part, cwd));
			continue;
		}
		throw badRequest(`unsupported prompt part type "${String(part.type)}"`);
	}
	return parts;
}
/**
* Convert an OpenCode v2 prompt body into dsh content parts.
*
* The v2 client sends `{ text, files, agents, skills, metadata }` rather than
* the v1 `parts` array. `files` entries carry a `uri` (not a v1 `url`) and
* optional `mime`, so each one is normalised into the v1 file-part shape
* before the shared file reader runs.
*/
function parseV2PromptInput(body, cwd) {
	const record = bodyAsRecord(body);
	const parts = [];
	const text = typeof record.text === "string" ? record.text : "";
	if (text.length > 0) parts.push({
		type: "text",
		text
	});
	if (Array.isArray(record.files)) for (const entry of record.files) {
		if (entry === null || typeof entry !== "object") throw badRequest("invalid prompt file");
		const file = entry;
		const uri = typeof file.uri === "string" ? file.uri : "";
		if (uri.length === 0) throw badRequest("prompt file requires a uri");
		const mime = typeof file.mime === "string" && file.mime.length > 0 ? file.mime : mimeFromPath(uri);
		parts.push(filePartToContent({
			url: uri,
			mime,
			name: file.name
		}, cwd));
	}
	if (Array.isArray(record.agents) && record.agents.length > 0) {
		const names = record.agents.map((entry) => entry !== null && typeof entry === "object" ? entry.name : void 0).filter((name) => typeof name === "string" && name.length > 0);
		if (names.length > 0) parts.push({
			type: "text",
			text: `@${names.join(" @")}`
		});
	}
	if (Array.isArray(record.skills) && record.skills.length > 0) {
		const names = record.skills.map((entry) => entry !== null && typeof entry === "object" ? entry.id : void 0).filter((id) => typeof id === "string" && id.length > 0);
		if (names.length > 0) parts.push({
			type: "text",
			text: `/skill ${names.join(" /skill ")}`
		});
	}
	if (parts.length === 0) throw badRequest("prompt body requires text or files");
	return parts;
}
/** Guess a mime type from a file path so a v2 `uri` without a mime still loads. */
function mimeFromPath(uri) {
	const path = uri.startsWith("file://") ? uri.slice(7) : uri;
	return {
		".txt": "text/plain",
		".md": "text/markdown",
		".ts": "text/plain",
		".tsx": "text/plain",
		".js": "text/plain",
		".jsx": "text/plain",
		".json": "application/json",
		".yaml": "application/yaml",
		".yml": "application/yaml",
		".toml": "application/toml",
		".sh": "text/x-sh",
		".py": "text/x-python",
		".rs": "text/plain",
		".go": "text/plain",
		".c": "text/plain",
		".h": "text/plain",
		".cpp": "text/plain",
		".hpp": "text/plain",
		".java": "text/plain",
		".sql": "text/plain",
		".css": "text/plain",
		".html": "text/plain",
		".xml": "text/xml",
		".csv": "text/csv",
		".log": "text/plain",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".svg": "image/svg+xml"
	}[extname(path).toLowerCase()] ?? "application/octet-stream";
}
/** Optional model/agent a provisional card should carry. */
/**
* Append the live provisional assistant (dsh 0.1.5: no durable chunks) to the
* 2.x history page. The entry keeps `time.completed` unset so the OpenCode TUI
* and the queue-ordering oracle see the same in-flight contract as 0.1.2,
* where the partial assistant was present in the durable log.
*/
function mergePendingAssistantV2(ctx, sessionId, messages) {
	const snapshot = ctx.pendingAssistant?.(sessionId);
	if (snapshot === void 0) return;
	if (messages.some((message) => message.id === snapshot.id)) return;
	const selected = ctx.state.sessionModelSelectionFor(sessionId);
	const agent = ctx.state.sessionAgentFor(sessionId) ?? "build";
	messages.push({
		id: snapshot.id,
		time: { created: snapshot.created },
		type: "assistant",
		agent,
		model: selected === void 0 ? {
			id: "deepseek-chat",
			providerID: "deepseek"
		} : {
			id: selected.modelID,
			providerID: selected.providerID,
			...selected.variant === void 0 ? {} : { variant: selected.variant }
		},
		content: snapshot.parts.map((part) => part.type === "text" ? {
			type: "text",
			id: part.id,
			text: part.text
		} : {
			type: "reasoning",
			id: part.id,
			text: part.text,
			time: {
				created: part.start,
				...part.end === void 0 ? {} : { completed: part.end }
			}
		}),
		cost: 0,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache: {
				read: 0,
				write: 0
			}
		}
	});
}
const PRESET_COMMAND_V2 = {
	name: "preset",
	template: "preset",
	description: "List or switch the session dsh agent preset"
};
const GOAL_COMMAND_V2 = {
	name: "goal",
	template: "goal",
	description: "Set or view the goal for a long-running task"
};
const HELP_COMMAND_V2 = {
	name: "help",
	template: "help",
	description: "Show the dsh-oc capability summary and documentation entry points"
};
async function defaultAgents(ctx) {
	try {
		const catalog = await rpc(ctx, "llm.models", {});
		if (typeof catalog.default?.provider === "string" && typeof catalog.default.model === "string") return {
			providerID: externalProviderId(catalog.default.provider),
			modelID: catalog.default.model
		};
		const first = catalog.groups[0];
		const firstModel = first?.models[0];
		if (first !== void 0 && firstModel !== void 0) return {
			providerID: externalProviderId(first.id),
			modelID: firstModel.id
		};
	} catch (error) {
		ctx.log(`[bridge] default agent model fallback: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		providerID: "deepseek",
		modelID: "deepseek-chat"
	};
}
async function defaultModelRef(ctx) {
	return defaultAgents(ctx);
}
/**
* Resolve the model currently attached to one dsh session.  The bridge-level
* default is only a last-resort fallback: a blank session may already have a
* model selected by the TUI, and a preset command must show that selection in
* its synthetic cards.  Keep a cached explicit variant when the host's read
* does not return one but still reports the same provider/model; this avoids
* making a preset switch look like it silently changed reasoning effort.
*/
async function sessionModelSelectionRef(ctx, sessionId, fallback) {
	const cached = ctx.state.sessionModelSelectionFor(sessionId);
	try {
		const selection = await rpc(ctx, "session.models", { sessionId: sid(sessionId) });
		const providerID = externalProviderId(selection.current.provider);
		const variant = selection.current.reasoningEffort;
		let resolved;
		if (variant !== void 0) resolved = {
			providerID,
			modelID: selection.current.model,
			variant
		};
		else if (cached !== void 0 && cached.providerID === providerID && cached.modelID === selection.current.model && cached.variant !== void 0) resolved = { ...cached };
		else resolved = {
			providerID,
			modelID: selection.current.model
		};
		ctx.state.setSessionModelSelection(sessionId, resolved);
		return resolved;
	} catch (error) {
		ctx.log(`[bridge] session model selection unavailable for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		if (cached !== void 0) return { ...cached };
		if (fallback !== void 0) return { ...fallback };
		return defaultAgents(ctx);
	}
}
/**
* The opencode-facing model ref a session is actually running. The TUI
* restores its prompt model from the last user message when the session
* changes, so user cards and history must name the session's real selection
* (e.g. deepseek-v4-pro), not the first catalog model (deepseek-v4-flash) —
* stamping the catalog default made the next prompt silently revert to flash.
*/
async function sessionModelRef(ctx, sessionId) {
	return sessionModelSelectionRef(ctx, sessionId);
}
/**
* Resolve the model ref for an optimistic prompt card after model selection
* has been applied. The selectModel response is authoritative for a prompt
* whose variant was omitted (OpenCode's Default), while explicit max/off is
* copied directly from the official top-level field.
*/
function promptModelRef(ctx, sessionId, body) {
	const input = modelInputFromBody(body);
	const cached = ctx.state.sessionModelSelectionFor(sessionId);
	if (input === void 0) return cached === void 0 ? void 0 : { ...cached };
	if (input.variantSpecified) return {
		providerID: input.providerID,
		modelID: input.modelID,
		variant: input.variant
	};
	if (cached !== void 0 && cached.providerID === input.providerID && cached.modelID === input.modelID) return { ...cached };
	return {
		providerID: input.providerID,
		modelID: input.modelID
	};
}
/**
* The agent list the 2.1.0 client reads. The first entry is the default
* selection, so it must be the deployment's configured default preset — not
* the hardcoded "build" placeholder — or a fresh session claims a preset the
* harness never runs.
*/
async function v2AgentList(ctx) {
	const { providerID, modelID } = await defaultAgents(ctx);
	const presets = await presetRoster(ctx);
	const defaultId = await defaultPresetId(ctx);
	const defaultName = defaultId ?? "build";
	return [{
		id: defaultName,
		mode: "primary",
		hidden: false,
		request: {
			headers: {},
			body: {}
		},
		permissions: [],
		model: {
			id: modelID,
			providerID
		},
		description: defaultName === "build" ? "dsh-oc default build agent" : "dsh-oc default agent (dsh default preset)"
	}, ...presets.filter((preset) => preset.id !== "build" && preset.id !== defaultId).map((preset) => ({
		id: preset.id,
		description: preset.name ?? preset.description,
		mode: "primary",
		hidden: false,
		request: {
			headers: {},
			body: {}
		},
		permissions: []
	}))];
}
async function presetRoster(ctx) {
	return (await rpc(ctx, "agentPreset.list", {})).filter((preset) => preset.broken === void 0);
}
async function defaultPresetId(ctx) {
	try {
		return ctx.api.agentPresets.defaultId;
	} catch (error) {
		ctx.log(`[bridge] agent preset roster unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
}
async function presetIdForAgent(ctx, agentName) {
	if (agentName === "build") return defaultPresetId(ctx);
	try {
		return (await presetRoster(ctx)).find((preset) => preset.id === agentName)?.id;
	} catch (error) {
		ctx.log(`[bridge] agent preset roster unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
}
async function switchAgentPreset(ctx, sessionId, agentName) {
	const presetId = await presetIdForAgent(ctx, agentName);
	if (presetId === void 0) {
		if (agentName === "build") return agentName;
		throw badRequest(`agent "${agentName}" is not a switchable dsh preset`);
	}
	const selected = await rpc(ctx, "agentPreset.select", {
		sessionId: sid(sessionId),
		agentPreset: presetId
	});
	const resolved = typeof selected === "string" && selected.length > 0 ? selected : presetId;
	ctx.state.lastAgentPreset = resolved;
	return resolved;
}
/** All text parts of a prompt body, joined the way the TUI renders them. */
function textFromPromptParts(content) {
	return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
/**
* A slash command typed with a trailing space (or after dismissing the slash
* popup) reaches the prompt routes as a plain prompt. Commands handled by the
* bridge are captured here so they never trigger a model turn.
*/
function slashPromptCapture(content) {
	const text = textFromPromptParts(content).trim();
	if (/^\/preset(?:\s|$)/.test(text)) return {
		name: "preset",
		argument: text.slice(7).trim()
	};
	if (/^\/goal(?:\s|$)/.test(text)) return {
		name: "goal",
		argument: text.slice(5).trim()
	};
	if (/^\/help(?:\s|$)/.test(text)) return {
		name: "help",
		argument: text.slice(5).trim()
	};
}
async function presetCommandOutcome(ctx, sessionId, argument) {
	try {
		if (argument === "") {
			const roster = await presetRoster(ctx);
			const defaultId = await defaultPresetId(ctx);
			return {
				kind: "success",
				text: roster.length === 0 ? "No switchable dsh agent presets" : roster.map((preset) => `${preset.id}${preset.id === defaultId ? " (default)" : ""}`).join("\n")
			};
		}
		const targetAgent = await switchAgentPreset(ctx, sessionId, argument);
		return {
			kind: "success",
			text: `Switched dsh agent preset to ${argument}`,
			targetAgent
		};
	} catch (error) {
		return {
			kind: "error",
			text: error instanceof Error ? error.message : String(error)
		};
	}
}
/** Broadcast one synthetic command-result message (with optional status). */
function broadcastCommandResult(ctx, sessionId, text, status, model) {
	const { events, entry } = commandResultMessage({
		cwd: ctx.cwd,
		state: ctx.state,
		log: ctx.log
	}, sessionId, text, {
		...status === void 0 ? {} : { status },
		...model === void 0 ? {} : { model }
	});
	ctx.hub.broadcast(events);
	if (status !== "busy") ctx.state.recordCommandResult(sessionId, entry);
}
/** Push a `session.updated` carrying the new agent so the TUI label refreshes. */
function broadcastSessionAgent(ctx, sessionId, agent) {
	ctx.state.setSessionAgent(sessionId, agent);
	const directory = ctx.state.sessionDirectories.get(sessionId) ?? ctx.cwd;
	const project = projectIdFor(directory);
	ctx.hub.broadcast([makeEvent(directory, "session.updated", {
		sessionID: sessionId,
		info: minimalSession(sessionId, {
			cwd: directory,
			title: ctx.state.sessionTitleFor(sessionId),
			agent,
			...sessionLineageOptions(ctx, sessionId)
		})
	}, project)]);
}
/** Persist an ephemeral `/preset` switch card so a fresh TUI sync keeps it. */
async function broadcastPresetSwitchEcho(ctx, sessionId, agent, model) {
	const directory = ctx.state.sessionDirectories.get(sessionId) ?? ctx.cwd;
	const project = projectIdFor(directory);
	const id = `msg_preset:${randomUUID()}`;
	const partId = `prt_preset:${randomUUID()}`;
	const created = Date.now();
	const info = {
		id,
		sessionID: sessionId,
		role: "user",
		agent,
		model: model ?? await sessionModelSelectionRef(ctx, sessionId),
		time: { created }
	};
	const part = {
		id: partId,
		sessionID: sessionId,
		messageID: id,
		type: "text",
		text: `preset switched to ${agent}`,
		time: {
			start: created,
			end: created
		}
	};
	ctx.hub.broadcast([makeEvent(directory, "message.updated", {
		sessionID: sessionId,
		info
	}, project), makeEvent(directory, "message.part.updated", {
		sessionID: sessionId,
		part
	}, project)]);
	ctx.state.recordCommandResult(sessionId, {
		info,
		parts: [part]
	});
}
/** Echo a submitted user prompt immediately (the official TUI's QUEUED card). */
async function broadcastPromptUserMessage(ctx, sessionId, userId, text, created, model, delivery = "steer") {
	const directory = ctx.state.sessionDirectories.get(sessionId) ?? ctx.cwd;
	const project = projectIdFor(directory);
	const resolved = model ?? await sessionModelRef(ctx, sessionId);
	const events = [makeEvent(directory, "message.updated", {
		sessionID: sessionId,
		info: {
			id: userId,
			sessionID: sessionId,
			role: "user",
			time: { created },
			agent: ctx.state.sessionAgentFor(sessionId) ?? "build",
			model: resolved
		}
	}, project), makeEvent(directory, "message.part.updated", {
		sessionID: sessionId,
		part: {
			id: `${userId}:0`,
			sessionID: sessionId,
			messageID: userId,
			type: "text",
			text,
			time: {
				start: created,
				end: created
			}
		}
	}, project)];
	ctx.hub.broadcastAndBufferIfIdle(events);
	ctx.hub.broadcastAndBufferIfIdle([makeV2Event(directory, "session.inbox.enqueued", {
		sessionID: sessionId,
		inboxID: userId,
		item: {
			type: "user",
			payload: { text },
			delivery
		}
	}, project, sessionId)]);
}
/** Run a `/preset` list/switch with visible TUI progress and result. */
async function runPresetCommand(ctx, sessionId, argument) {
	let model = await sessionModelSelectionRef(ctx, sessionId);
	broadcastCommandResult(ctx, sessionId, "Running /preset…", "busy", model);
	const previousAgent = ctx.state.sessionAgentFor(sessionId) ?? ctx.state.lastAgentPreset ?? "build";
	const outcome = await presetCommandOutcome(ctx, sessionId, argument);
	if (outcome.kind === "success" && argument.trim() !== "") {
		model = await sessionModelSelectionRef(ctx, sessionId, model);
		const targetAgent = outcome.targetAgent ?? argument.trim();
		broadcastSessionAgent(ctx, sessionId, targetAgent);
		ctx.state.markStalePresetPrompt(sessionId, previousAgent, targetAgent);
		await broadcastPresetSwitchEcho(ctx, sessionId, targetAgent, model);
	}
	ctx.state.invalidateSession(sessionId);
	broadcastCommandResult(ctx, sessionId, outcome.text, "idle", model);
	return outcome;
}
/**
* Run one dsh registered command (`/goal`, ...) through the live session
* agent with visible busy/idle progress in the TUI. Infra failures (missing
* agent/registry/command) throw; a command-level error becomes an outcome
* the caller can turn into a 400.
*/
async function runRegistryCommand(ctx, sessionId, commandLine, label) {
	broadcastCommandResult(ctx, sessionId, `Running ${label}…`, "busy");
	const agent = ctx.api.agents?.get(sessionId);
	if (agent === void 0) {
		const text = `${label} unavailable: session is not attached`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw conflict(text, { sessionId });
	}
	if (!ctx.api.commands) {
		const text = `${label} unavailable: dsh command registry is missing`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw internalError(text, { sessionId });
	}
	let execution;
	try {
		execution = await ctx.api.commands.execute(agent, commandLine, [], new AbortController().signal);
	} catch (error) {
		const text = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw internalError(text, { sessionId });
	}
	ctx.state.invalidateSession(sessionId);
	if (execution === void 0) {
		const text = `${label} failed: unknown command ${commandLine.split(/\s+/)[0] ?? commandLine}`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw badRequest(text, {
			code: "unknown-command",
			sessionId
		});
	}
	if (execution.result.kind === "error") {
		const text = execution.result.text ?? `${label} failed`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		return {
			kind: "error",
			text
		};
	}
	const text = execution.result.text ?? `${label} completed`;
	broadcastCommandResult(ctx, sessionId, text, "idle");
	ctx.log(`[bridge] ${commandLine}: ${text}`);
	return {
		kind: "success",
		text
	};
}
/** Run `/goal` with an optional argument through the dsh command registry. */
async function runGoalCommand(ctx, sessionId, argument) {
	const trimmed = argument.trim();
	if (trimmed === "complete") return completeGoalCommand(ctx, sessionId);
	const outcome = await runRegistryCommand(ctx, sessionId, trimmed === "" ? "/goal" : `/goal ${trimmed}`, "/goal");
	if (outcome.kind === "success" && outcome.text.includes("Commands:")) return {
		kind: "success",
		text: `${outcome.text}, /goal complete`
	};
	return outcome;
}
/**
* dsh's `/goal` command registry has no `complete` verb (completion is
* normally automatic), so the bridge implements it directly through the
* `goal.complete` RPC with the current projection ref.
*/
async function completeGoalCommand(ctx, sessionId) {
	broadcastCommandResult(ctx, sessionId, "Running /goal complete…", "busy");
	try {
		const current = goalFromHistory(await cachedSessionHistory(ctx, sessionId));
		const ref = current?.goal;
		if (current === void 0 || ref === void 0) {
			const text = current === null ? "No goal to complete." : "Goal state unavailable; run /goal to view the current goal.";
			broadcastCommandResult(ctx, sessionId, text, "idle");
			return {
				kind: "error",
				text
			};
		}
		await rpc(ctx, "goal.complete", {
			sessionId: sid(sessionId),
			ref: {
				id: ref.id,
				revision: ref.revision
			}
		});
		ctx.state.invalidateSession(sessionId);
		const text = "Goal completed";
		broadcastCommandResult(ctx, sessionId, text, "idle");
		return {
			kind: "success",
			text
		};
	} catch (error) {
		const text = `/goal complete failed: ${error instanceof Error ? error.message : String(error)}`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		return {
			kind: "error",
			text
		};
	}
}
/** Run `/help`: broadcast the shared capability summary without a model turn. */
function runHelpCommand(ctx, sessionId, _argument) {
	const text = ocHelp();
	broadcastCommandResult(ctx, sessionId, text);
	return {
		kind: "success",
		text
	};
}
/**
* Dispatch a captured slash command to its bridge-side implementation.
*/
async function runSlashCommand(ctx, sessionId, slash) {
	if (slash.name === "preset") return await runPresetCommand(ctx, sessionId, slash.argument);
	if (slash.name === "goal") return await runGoalCommand(ctx, sessionId, slash.argument);
	if (slash.name === "help") return runHelpCommand(ctx, sessionId, slash.argument);
	throw badRequest(`unsupported command /${slash.name}`);
}
function modelInputFromBody(body) {
	const record = bodyAsRecord(body);
	const input = bodyAsRecord(record.model !== void 0 && bodyAsRecord(record.model) ? record.model : body);
	const providerID = typeof input.providerID === "string" ? input.providerID : void 0;
	const modelID = typeof input.modelID === "string" ? input.modelID : typeof input.id === "string" ? input.id : void 0;
	if (providerID === void 0 || modelID === void 0) return void 0;
	const rawVariant = typeof record.variant === "string" ? record.variant : input.variant;
	const variantSpecified = typeof rawVariant === "string" && rawVariant !== "default";
	return {
		providerID,
		modelID,
		...typeof rawVariant === "string" && rawVariant !== "default" ? { variant: rawVariant } : {},
		variantSpecified
	};
}
async function applyModelSelection(ctx, sessionId, body) {
	const input = modelInputFromBody(body);
	if (input === void 0) return false;
	const resolved = (await rpc(ctx, "session.selectModel", {
		sessionId: sid(sessionId),
		provider: dshProviderId(input.providerID),
		model: input.modelID,
		...input.variant === void 0 ? {} : { reasoningEffort: input.variant }
	})).selected;
	const providerID = typeof resolved?.provider === "string" ? externalProviderId(resolved.provider) : input.providerID;
	const modelID = typeof resolved?.model === "string" ? resolved.model : input.modelID;
	const reasoningEffort = typeof resolved?.reasoningEffort === "string" ? resolved.reasoningEffort : input.variantSpecified ? input.variant : void 0;
	ctx.state.setSessionModelSelection(sessionId, {
		providerID,
		modelID,
		...reasoningEffort === void 0 ? {} : { variant: reasoningEffort }
	});
	return true;
}
/**
* Self-heal an explicit variant selection: dsh can lose the reasoning effort
* after some operations (model re-selection, preset switches). Before the next
* prompt we compare the cached explicit selection with `session.models` and
* re-apply it when the variant went missing.
*/
async function reconcileModelSelection(ctx, sessionId) {
	const cached = ctx.state.sessionModelSelectionFor(sessionId);
	if (cached === void 0 || cached.variant === void 0) return;
	let current;
	try {
		current = await rpc(ctx, "session.models", { sessionId: sid(sessionId) });
	} catch (error) {
		ctx.log(`[bridge] model selection check failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const currentVariant = current.current.reasoningEffort;
	if (current.current.provider === dshProviderId(cached.providerID) && current.current.model === cached.modelID && currentVariant === cached.variant) return;
	try {
		await rpc(ctx, "session.selectModel", {
			sessionId: sid(sessionId),
			provider: dshProviderId(cached.providerID),
			model: cached.modelID,
			reasoningEffort: cached.variant
		});
		ctx.log(`[bridge] restored variant ${cached.variant} for session ${sessionId}`);
	} catch (error) {
		ctx.log(`[bridge] variant restore failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/** Apply the agent carried in a prompt body (Tab/agent picker selection). */
async function applyAgentFromBody(ctx, sessionId, body) {
	const record = bodyAsRecord(body);
	const agent = typeof record.agent === "string" && record.agent.length > 0 ? record.agent : void 0;
	if (agent === void 0) {
		ctx.state.consumeStalePresetPrompt(sessionId, void 0);
		return;
	}
	if (ctx.state.consumeStalePresetPrompt(sessionId, agent)) return;
	if (ctx.state.sessionAgentFor(sessionId) === agent) return;
	if (agent === "build") {
		if (ctx.state.sessionAgentFor(sessionId) === void 0) {
			const presetId = await defaultPresetId(ctx);
			if (presetId !== void 0) ctx.state.setSessionAgent(sessionId, presetId);
		}
		return;
	}
	try {
		broadcastSessionAgent(ctx, sessionId, await switchAgentPreset(ctx, sessionId, agent));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.log(`[bridge] prompt agent switch failed for ${sessionId}: ${message}`);
		const errorBody = error.body;
		if ((typeof errorBody?.data?.code === "string" ? errorBody.data.code : "") === "agent-preset/locked" && !ctx.state.lockedAgentNoticeSeen(sessionId, agent)) {
			ctx.state.markLockedAgentNotice(sessionId, agent);
			broadcastCommandResult(ctx, sessionId, `Agent switch locked: 该会话已产生回复，agent preset 已固定；请新建会话后切换（Tab 或 /preset ${agent}）`, "idle");
		}
	}
}
/**
* The dsh event seq that carries the OpenCode message `messageId`, and the
* turn it belongs to.
*
* Message lists expose bridge ids for prompts echoed by the route, so the id
* is resolved back to the durable dsh id before the history is scanned.
*/
async function locateMessage(ctx, sessionId, messageId) {
	const resolved = ctx.state.dshIdForPromptId(sessionId, messageId) ?? ctx.state.dshIdForAssistantId(sessionId, messageId) ?? messageId;
	const history = await cachedSessionHistory(ctx, sessionId);
	let turn = 0;
	for (const entry of history.events) {
		const event = entry.event;
		if (event.type === "turn/start") {
			const opened = Number(event.data.turn);
			if (Number.isFinite(opened)) turn = opened;
			continue;
		}
		if ((event.type === "user/message" ? String(event.data.id) : event.type === "assistant/message" ? String(event.data.message.id) : void 0) === resolved) {
			const own = event.type === "assistant/message" ? Number(event.data.turn) : NaN;
			return {
				seq: event.seq,
				turn: Number.isFinite(own) ? own : turn,
				role: event.type === "assistant/message" ? "assistant" : "user"
			};
		}
	}
	throw badRequest("message not found for fork", {
		sessionId,
		messageId,
		resolved
	});
}
/**
* The inclusive dsh event seq a fork has to cut at to drop `messageId` and
* everything after it.
*
* OpenCode's cut points are exclusive in both shapes that use them:
*
* - `POST /api/session/:id/fork` with `before` copies the messages whose seq
*   is *less* than the boundary message's seq.
* - `POST /api/session/:id/revert/commit` deletes the messages whose seq is
*   *greater than or equal* to the boundary message's seq.
*
* dsh's `session.fork` takes an inclusive event seq (`buildForkSeed` copies
* `events.slice(0, boundary + 1)`), so the cut has to move one event back.
* The event right before the message is the last event of the previous turn
* (a tool result, a turn marker or the previous message), so the fork keeps
* every message that precedes the cut and nothing after it.
*/
async function atSeqBeforeMessage(ctx, sessionId, messageId) {
	const location = await locateMessage(ctx, sessionId, messageId);
	if (location.seq <= 0) throw badRequest("cannot cut before the first message", {
		sessionId,
		messageId,
		seq: location.seq
	});
	return location.seq - 1;
}
/**
* Commit the staged revert of a session.
*
* OpenCode commits a staged revert when the next prompt arrives, so the
* bridge does the same. The conversation is forked at the boundary and the
* opencode session id keeps pointing at the fork, so the client keeps
* talking to the same session while the transcript is trimmed.
*/
async function commitStagedRevert(ctx, sessionId) {
	const staged = ctx.state.revertBoundary(sessionId);
	if (staged === void 0) return false;
	const rewind = ctx.api.rewind;
	if (rewind !== void 0) {
		const dshId = ctx.state.resolveSessionId(sessionId);
		const atSeq = await atSeqBeforeMessage(ctx, sessionId, staged.messageID);
		const childId = await rewind.fork(sessionId, atSeq);
		rewind.setAlias(sessionId, childId);
		ctx.state.inheritSessionState(sessionId, childId);
		ctx.state.setSessionAlias(sessionId, childId);
		ctx.state.setCurrentSession(sessionId);
		ctx.state.invalidateSession();
		rewind.commitRestore(dshId);
	}
	ctx.state.clearRevert(sessionId);
	publishV2Event(ctx, "session.revert.committed", {
		sessionID: sessionId,
		to: staged.messageID
	}, sessionId);
	return true;
}
async function forkSession(req, ctx) {
	const id = req.params.id ?? req.params.sessionID ?? "";
	const body = bodyAsRecord(req.body);
	const rawMessageId = typeof body.before === "string" && body.before.length > 0 ? body.before : typeof body.messageID === "string" && body.messageID.length > 0 ? body.messageID : void 0;
	const childId = await forkFromSource(ctx, id, rawMessageId === void 0 ? void 0 : await atSeqBeforeMessage(ctx, id, rawMessageId));
	ctx.state.setCurrentSession(childId);
	return json(200, { data: toV2Session(await sessionView(ctx, childId), childId, ctx) });
}
/**
* dsh forks are independent conversations, not subagent children. Derive a
* user-visible `(fork #N)` title from the source session and the number of
* existing non-subagent forks before calling `session.rename`.
*/
function forkChainBase(title) {
	let base = title;
	for (;;) {
		const match = /^(.*?)\s+\(fork #\d+\)$/.exec(base);
		if (!match?.[1]) return base;
		base = match[1];
	}
}
function forkNumberInTitle(title) {
	let max = 0;
	for (const match of title.matchAll(/\(fork #(\d+)\)/g)) {
		const value = Number(match[1]);
		if (Number.isFinite(value) && value > max) max = value;
	}
	return max;
}
async function forkTitleForSource(ctx, sourceId) {
	const list = await cachedSessionList(ctx);
	const source = list.find((item) => String(item.sessionId) === sourceId);
	const sourceTitle = source === void 0 ? "Session" : sessionTitleFrom(source) || "Session";
	const base = forkChainBase(sourceTitle);
	const sourceForkNumber = forkNumberInTitle(sourceTitle);
	if (sourceForkNumber > 0) return `${base} (fork #${sourceForkNumber + 1})`;
	return `${base} (fork #${list.filter((item) => String(item.sessionId) !== sourceId && String(item.parentSessionId) === sourceId && item.origin !== "subagent").length + 1})`;
}
async function forkFromSource(ctx, sourceId, atSeq) {
	const title = await forkTitleForSource(ctx, sourceId);
	const result = await rpc(ctx, "session.fork", {
		sessionId: sid(sourceId),
		...atSeq === void 0 ? {} : { atSeq }
	});
	const childId = String(result.sessionId);
	ctx.state.inheritSessionState(sourceId, childId);
	try {
		await rpc(ctx, "session.rename", {
			sessionId: sid(childId),
			title
		});
	} catch (error) {
		ctx.log(`[bridge] rename of forked session ${childId} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	ctx.state.invalidateSession();
	return childId;
}
/**
* Run dsh's registered `/compact` command directly through the command
* registry. The opencode TUI's slash command is `session.summarize`, which
* posts `/session/{id}/summarize`; dsh owns the model-backed compaction
* inside command-compact, so we address the live session agent here rather
* than sending a slash prompt to the model. Every outcome is broadcast as a
* synthetic assistant message plus busy/idle status so the TUI visibly moves
* while the command runs, even when the mock LLM cannot produce a summary.
*/
async function runCompactCommand(ctx, sessionId) {
	broadcastCommandResult(ctx, sessionId, "Running /compact…", "busy");
	const agent = ctx.api.agents?.get(sessionId);
	if (agent === void 0) {
		broadcastCommandResult(ctx, sessionId, "Compaction unavailable: session is not attached", "idle");
		throw conflict("session is not attached; cannot compact", { sessionId });
	}
	if (!ctx.api.commands) {
		broadcastCommandResult(ctx, sessionId, "Compaction unavailable: dsh command registry is missing", "idle");
		throw internalError("dsh command registry is unavailable; cannot compact", { sessionId });
	}
	let execution;
	try {
		execution = await ctx.api.commands.execute(agent, "/compact", [], new AbortController().signal);
	} catch (error) {
		const text = `Compaction failed: ${error instanceof Error ? error.message : String(error)}`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw internalError(text, { sessionId });
	}
	if (execution === void 0) {
		broadcastCommandResult(ctx, sessionId, "Compaction failed: unknown command /compact", "idle");
		throw badRequest("unknown command /compact", {
			code: "unknown-command",
			sessionId
		});
	}
	if (execution.result.kind === "error") {
		const text = execution.result.text ?? "Compaction failed";
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw badRequest(text, {
			code: "command-error",
			sessionId
		});
	}
	const text = execution.result.text ?? "Compaction completed";
	ctx.state.invalidateSession(sessionId);
	broadcastCommandResult(ctx, sessionId, text, "idle");
	ctx.log(`[bridge] /compact: ${text}`);
}
async function createSession(req, ctx) {
	const body = bodyAsRecord(req.body);
	const parentID = typeof body.parentID === "string" ? body.parentID : void 0;
	const sessionIdInput = typeof body.id === "string" ? body.id : void 0;
	const title = typeof body.title === "string" ? body.title : void 0;
	const agentName = typeof body.agent === "string" ? body.agent : void 0;
	const inheritedAgent = agentName ?? ctx.state.lastAgentPreset;
	const agentPreset = inheritedAgent === void 0 ? void 0 : await presetIdForAgent(ctx, inheritedAgent);
	let id;
	if (parentID) id = await forkFromSource(ctx, parentID);
	else {
		const location = body.location;
		const queryDirectory = req.query.get("directory");
		const result = await rpc(ctx, "session.create", {
			cwd: typeof location?.directory === "string" ? location.directory : queryDirectory ?? ctx.cwd,
			...sessionIdInput === void 0 ? {} : { sessionId: sid(sessionIdInput) },
			...agentPreset === void 0 ? {} : { agentPreset }
		});
		id = String(result.sessionId);
		if (title) try {
			await rpc(ctx, "session.rename", {
				sessionId: sid(id),
				title
			});
		} catch (error) {
			ctx.log(`[bridge] rename of new session ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (body.model !== void 0) try {
		await applyModelSelection(ctx, id, body);
	} catch (error) {
		ctx.log(`[bridge] model selection on create failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (agentName !== void 0) ctx.state.lastAgentPreset = agentName;
	if (agentPreset !== void 0) ctx.state.setSessionAgent(id, agentPreset);
	else if (agentName !== void 0) ctx.state.setSessionAgent(id, agentName);
	ctx.state.setCurrentSession(id);
	ctx.state.invalidateSession();
	return json(200, { data: toV2Session(await sessionView(ctx, id), id, ctx) });
}
/**
* Translate one dsh `host/session-added` frame into the opencode
* `session.updated` the TUI needs to learn about a session born mid-run.
*
* Subagent children are spawned inside dsh while the TUI's session list is
* already loaded; without a live push the child never reaches
* `sync.data.session`, so the TUI subagent panel (Ctrl+x ↓) stays empty.
* The frame carries the full lineage fields, so the push also seeds the
* bridge state (parent map, directory, agent) for later event translation.
*/
function hostSessionAddedEvents(ctx, payload) {
	const sessionId = String(payload.sessionId ?? "");
	if (sessionId === "") return [];
	recordSessionSummaries(ctx, [{
		sessionId,
		updatedAt: Date.now(),
		running: false,
		agentAvailable: false,
		blank: payload.blank !== false,
		...payload.agentAvailable === void 0 ? {} : { agentAvailable: payload.agentAvailable === true },
		...payload.parentSessionId === void 0 ? {} : { parentSessionId: String(payload.parentSessionId) },
		...payload.origin === "subagent" ? { origin: "subagent" } : {},
		...payload.cwd === void 0 ? {} : { cwd: String(payload.cwd) },
		...payload.agentPreset === void 0 ? {} : { agentPreset: String(payload.agentPreset) },
		...payload.projections === void 0 ? {} : { projections: payload.projections }
	}], true);
	const directory = ctx.state.sessionDirectories.get(sessionId) ?? ctx.cwd;
	const project = projectIdFor(directory);
	const parentID = ctx.state.sessionParents.get(sessionId);
	const agent = ctx.state.sessionAgentFor(sessionId);
	const events = [makeEvent(directory, "session.updated", {
		sessionID: sessionId,
		info: minimalSession(sessionId, {
			cwd: directory,
			title: ctx.state.sessionTitleFor(sessionId),
			createdAt: Date.now(),
			...agent === void 0 ? {} : { agent },
			...parentID === void 0 ? {} : { parentID },
			...sessionLineageOptions(ctx, sessionId)
		})
	}, project), makeV2Event(directory, "session.created", {
		sessionID: sessionId,
		projectID: project,
		location: { directory },
		slug: sessionId,
		title: ctx.state.sessionTitleFor(sessionId) ?? "",
		...parentID === void 0 ? {} : { parentID },
		...agent === void 0 ? {} : { agent },
		version: OPENCODE_VERSION
	}, project, sessionId)];
	const call = [...ctx.state.subagentCalls.values()].find((candidate) => candidate.childSessionId === sessionId && candidate.partEmitted === true);
	if (call !== void 0) {
		const child = ctx.state.subagentChildren.get(sessionId) ?? {
			sessionId,
			parentSessionId: call.parentSessionId,
			addedAt: Date.now()
		};
		const callInfo = {
			callId: call.callId,
			name: call.toolName,
			arguments: call.arguments,
			subagent: {
				sessionId,
				parentSessionId: call.parentSessionId,
				...(child.mode ?? call.childMode) === void 0 ? {} : { mode: child.mode ?? call.childMode },
				...call.background === void 0 ? {} : { background: call.background }
			}
		};
		const resultInfo = call.resultStatus === void 0 ? void 0 : {
			callId: call.callId,
			content: call.resultContent ?? [],
			time: call.resultTime ?? Date.now(),
			...call.resultError === void 0 ? {} : { error: call.resultError }
		};
		const part = resultInfo === void 0 ? runningToolPart(callInfo, {
			sessionID: call.parentSessionId,
			messageID: call.messageId,
			time: call.createdAt
		}) : call.resultStatus === "error" ? errorToolPart(callInfo, resultInfo, {
			sessionID: call.parentSessionId,
			messageID: call.messageId,
			time: call.createdAt
		}) : completedToolPart(callInfo, resultInfo, {
			sessionID: call.parentSessionId,
			messageID: call.messageId,
			time: call.createdAt
		});
		events.push(makeEvent(ctx.state.sessionDirectories.get(call.parentSessionId) ?? ctx.cwd, "message.part.updated", {
			sessionID: call.parentSessionId,
			part,
			time: Date.now()
		}, projectIdFor(ctx.state.sessionDirectories.get(call.parentSessionId) ?? ctx.cwd)));
	}
	return events;
}
async function permissionReply(ctx, requestID, body) {
	const entry = ctx.state.permissionByOpenCodeId(requestID);
	if (!entry) throw notFound("permission request not found", { requestID });
	const reply = bodyAsRecord(body).reply;
	let outcome;
	if (reply === "once") outcome = "allowed-once";
	else if (reply === "reject") outcome = "rejected";
	else if (reply === "always") {
		ctx.state.savePermission(entry.sessionId, entry.toolName);
		ctx.log(`[bridge] permission "always" saved for ${entry.sessionId} ${entry.toolName} (memory scope)`);
		outcome = "allowed-once";
	} else throw badRequest("invalid permission reply", { reply });
	const resolve = ctx.state.pendingApprovals.get(entry.rpcId);
	if (resolve === void 0) throw conflict("permission request is no longer pending");
	ctx.state.pendingApprovals.delete(entry.rpcId);
	resolve(outcome);
	ctx.state.removePermission(requestID);
	const directory = ctx.state.sessionDirectories.get(entry.sessionId) ?? ctx.cwd;
	ctx.hub.broadcast([makeEvent(directory, "permission.replied", {
		sessionID: entry.sessionId,
		requestID: entry.opencodeId,
		reply: outcome === "allowed-once" ? "once" : "reject"
	}, projectIdFor(directory))]);
}
async function questionReply(ctx, requestID, body) {
	const entry = ctx.state.questionByOpenCodeId(requestID);
	if (!entry) throw notFound("question request not found", { requestID });
	const answers = bodyAsRecord(body).answers;
	if (!Array.isArray(answers) || !answers.every((answer) => Array.isArray(answer) && answer.every((label) => typeof label === "string"))) throw badRequest("question reply requires answers: Array<Array<string>>");
	const mapped = answersToDsh(entry, answers);
	const resolve = ctx.state.pendingQuestions.get(entry.rpcId);
	if (resolve === void 0) throw conflict("question request is no longer pending");
	ctx.state.pendingQuestions.delete(entry.rpcId);
	resolve(mapped);
	ctx.state.removeQuestion(requestID);
	const qDirectory = ctx.state.sessionDirectories.get(entry.sessionId) ?? ctx.cwd;
	ctx.hub.broadcast([makeEvent(qDirectory, "question.replied", {
		sessionID: entry.sessionId,
		requestID: entry.opencodeId,
		answers
	}, projectIdFor(qDirectory)), makeV2Event(qDirectory, "form.replied", {
		id: entry.opencodeId,
		formID: entry.opencodeId,
		sessionID: entry.sessionId,
		answer: toFormAnswer(entry, answers)
	}, projectIdFor(qDirectory), entry.sessionId)]);
}
async function questionReject(ctx, requestID) {
	const entry = ctx.state.questionByOpenCodeId(requestID);
	if (!entry) throw notFound("question request not found", { requestID });
	const resolve = ctx.state.pendingQuestions.get(entry.rpcId);
	if (resolve === void 0) throw conflict("question request is no longer pending");
	ctx.state.pendingQuestions.delete(entry.rpcId);
	resolve(void 0);
	ctx.state.removeQuestion(requestID);
	const qDirectory = ctx.state.sessionDirectories.get(entry.sessionId) ?? ctx.cwd;
	ctx.hub.broadcast([makeEvent(qDirectory, "question.rejected", {
		sessionID: entry.sessionId,
		requestID: entry.opencodeId
	}, projectIdFor(qDirectory)), makeV2Event(qDirectory, "form.cancelled", {
		id: entry.opencodeId,
		formID: entry.opencodeId,
		sessionID: entry.sessionId
	}, projectIdFor(qDirectory), entry.sessionId)]);
}
function historyChanges(history) {
	const calls = /* @__PURE__ */ new Map();
	const changes = [];
	for (const entry of history.events) {
		const event = entry.event;
		if (event.type === "tool/call") calls.set(String(event.data.callId), {
			callId: String(event.data.callId),
			name: event.data.name,
			arguments: event.data.arguments,
			...entry.view?.for === "call" ? { view: entry.view } : {}
		});
		else if (event.type === "tool/result") {
			const message = event.data.message;
			const callId = String(message.toolCallId ?? message.source?.callId ?? "");
			const call = calls.get(callId);
			if (!call) continue;
			changes.push(...fileChangesFromToolResult(call, {
				callId,
				content: event.data.message.content,
				error: event.data.error,
				time: event.time,
				meta: event.data.meta,
				...entry.view?.for === "result" ? { view: entry.view } : {}
			}));
		}
	}
	return changes;
}
function historyFileDiffs(history) {
	const values = history.projections?.values;
	if (values?.["produced-files"] !== void 0) return convertProducedFiles(values["produced-files"]);
	return toFileDiffInfos(historyChanges(history));
}
/**
* Current goal for one session: prefer the durable `goal` projection, then
* fold the latest `goal/change` event when the projection is unavailable.
* `null` (clear tombstone) means no goal is rendered.
*/
function goalFromHistory(history) {
	if (history.projections?.values?.goal !== void 0) return history.projections.values.goal;
	for (let index = history.events.length - 1; index >= 0; index--) {
		const event = history.events[index].event;
		if (event.type !== "goal/change") continue;
		const data = event.data;
		if (data?.goal !== void 0) return { goal: data.goal };
		if (data?.cleared !== void 0) return null;
		return;
	}
}
/**
* Seed one SSE connection's shared goal/todo projection state from durable
* history. Translators accumulate projections from live mux frames only, so
* an attach to an existing session would otherwise miss the goal or todos and
* emit partial `todo.updated` lists (one side replacing the other in the TUI
* sidebar). History is authoritative here, and existing live state wins.
*/
async function seedProjectionState(ctx, state, sessionId) {
	const history = await cachedSessionHistory(ctx, sessionId);
	let todos;
	for (const entry of history.events) if (entry.event.type === "todo/write") todos = entry.event.data.todos;
	const values = history.projections?.values;
	if (todos === void 0 && values?.todos !== void 0) todos = values.todos;
	const goal = goalFromHistory(history);
	if (!state.todos.has(sessionId) && todos !== void 0) state.todos.set(sessionId, todos);
	if (!state.goals.has(sessionId) && goal !== void 0) state.goals.set(sessionId, goal);
	const selection = history.projections?.values?.modelSelection;
	const current = selection?.next ?? selection?.lastUsed;
	if (current !== null && current !== void 0 && typeof current.provider === "string" && typeof current.model === "string" && ctx.state.sessionModelSelectionFor(sessionId) === void 0) ctx.state.setSessionModelSelection(sessionId, {
		providerID: externalProviderId(current.provider),
		modelID: current.model,
		...typeof current.reasoningEffort === "string" ? { variant: current.reasoningEffort } : {}
	});
}
function createBridgeRouter(api, options = {}) {
	let cwd = options.cwd ?? process.cwd();
	const log = options.log ?? (() => {});
	const state = new InteractionState();
	const hub = new SseHub(log);
	const ctx = {
		api,
		cwd,
		state,
		log,
		hub
	};
	api.sessionAddress = (sessionId) => {
		const parentSessionId = state.sessionParents.get(sessionId);
		if (parentSessionId === void 0) return {
			kind: "session",
			sessionId
		};
		return {
			kind: "subagent",
			parentSessionId,
			childSessionId: sessionId,
			mode: state.sessionAddressModes.get(sessionId) ?? "continuable"
		};
	};
	const routes = [];
	/**
	* Publish a batch of events, rewriting the session id of the sessions
	* that a revert moved to a fork.
	*
	* A revert forks the dsh session at the boundary, so the events of the
	* fork carry the new dsh id while the clients know the session under its
	* original id.
	*/
	function broadcastEvents(events) {
		if (events.length === 0) return;
		const aliases = state.aliasedSessionIds();
		if (aliases.length === 0) {
			hub.broadcast(events);
			return;
		}
		hub.broadcast(events.map((event) => {
			let mapped = event;
			for (const opencodeId of aliases) {
				const dshId = state.resolveSessionId(opencodeId);
				if (dshId === opencodeId) continue;
				mapped = mapEventSessionId(mapped, dshId, opencodeId);
			}
			return mapped;
		}));
	}
	const register = (method, pattern, kind, handler) => {
		routes.push({
			method,
			pattern,
			kind,
			handler
		});
	};
	registerRoutes(register);
	for (const route of stubRoutes) routes.push(route);
	function match(method, pathname) {
		return routes.find((route) => route.method === method && matchPattern(route.pattern, pathname));
	}
	function startSse(req, res) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
			Connection: "keep-alive"
		});
		res.write("retry: 3000\n\n");
		const sessionFilter = req.params.sessionID ?? req.query.get("sessionID") ?? void 0;
		const client = hub.add(res, (event) => {
			if (sessionFilter === void 0) return true;
			return event.payload.properties?.sessionID === sessionFilter;
		});
		hub.send(client, makeEvent(cwd, "server.connected", {}));
		const rawLastEventId = req.headers["last-event-id"];
		const lastEventId = Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId;
		if (lastEventId !== void 0 && lastEventId.length > 0) {
			if (!hub.replayAfter(client, lastEventId)) log(`[bridge/sse] Last-Event-ID ${lastEventId} is outside the replay ring; using snapshots`);
		}
		replaySessionStatusSnapshot(client);
		replayControlSnapshot(client).catch((error) => {
			log(`[bridge/sse] control snapshot replay failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
	let translator;
	let translatorLoading;
	let listRefreshTimer;
	ctx.pendingAssistant = (sessionId) => translator?.pendingAssistantSnapshot(sessionId);
	const sessionFeedQueues = /* @__PURE__ */ new Map();
	const replayGuard = {
		approvals: /* @__PURE__ */ new Set(),
		questions: /* @__PURE__ */ new Set(),
		chunks: /* @__PURE__ */ new Set()
	};
	const sharedState = {
		todos: /* @__PURE__ */ new Map(),
		goals: /* @__PURE__ */ new Map()
	};
	const seededProjection = /* @__PURE__ */ new Set();
	const controlQueues = /* @__PURE__ */ new Map();
	const controlProjections = /* @__PURE__ */ new Map();
	let translatorDefaultModel;
	async function ensureTranslator() {
		if (translator !== void 0) return translator;
		const loading = translatorLoading;
		if (loading !== void 0) return loading;
		const next = (async () => {
			const defaultModel = await defaultModelRef(ctx);
			translatorDefaultModel = defaultModel;
			const instance = new MuxEventTranslator({
				cwd,
				state,
				defaultModel,
				log,
				replayGuard,
				sharedState,
				onFlush: (events) => {
					broadcastEvents(events);
				},
				onV2Event: (event) => {
					broadcastEvents([event]);
				}
			});
			translator = instance;
			return instance;
		})();
		translatorLoading = next;
		try {
			return await next;
		} finally {
			if (translatorLoading === next) translatorLoading = void 0;
		}
	}
	function scheduleListRefresh() {
		if (listRefreshTimer !== void 0) return;
		listRefreshTimer = setTimeout(() => {
			listRefreshTimer = void 0;
			(async () => {
				try {
					const list = await rpc(ctx, "session.list", {});
					ctx.state.setSessionListCache(list.items);
					recordSessionSummaries(ctx, list.items);
				} catch (error) {
					log(`[bridge/sse] session list refresh failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			})();
		}, 250);
	}
	function frameSessionId(frame) {
		if (frame.type === "session/event" || frame.type === "session/queue" || frame.type === "session/assistant-stream" || frame.type === "session/jobs" || frame.type === "session/projection" || frame.type === "approval/requested" || frame.type === "approval/resolved" || frame.type === "question/requested" || frame.type === "question/resolved") return String(frame.sessionId);
	}
	async function processFrame(frame) {
		const t = await ensureTranslator();
		if (frame.type === "control/baseline") {
			controlQueues.clear();
			for (const [sessionId, items] of Object.entries(frame.value.queues ?? {})) controlQueues.set(sessionId, items.map((item) => ({
				placement: item.placement,
				...item.rpcId === void 0 ? {} : { rpcId: item.rpcId },
				message: item.message
			})));
			controlProjections.clear();
			for (const [sessionId, projection] of Object.entries(frame.value.projections ?? {})) controlProjections.set(sessionId, {
				asOfSeq: projection.asOfSeq,
				values: { ...projection.values }
			});
		} else if (frame.type === "session/queue") controlQueues.set(String(frame.sessionId), frame.items.map((item) => ({
			placement: item.placement,
			...item.rpcId === void 0 ? {} : { rpcId: item.rpcId },
			message: item.message
		})));
		else if (frame.type === "session/projection") {
			const sessionId = String(frame.sessionId);
			const projection = controlProjections.get(sessionId) ?? {
				asOfSeq: frame.seq,
				values: {}
			};
			projection.asOfSeq = frame.seq;
			projection.values[frame.key] = frame.value;
			controlProjections.set(sessionId, projection);
		}
		if (frame.type === "session/event") {
			const sessionId = String(frame.sessionId);
			if (!seededProjection.has(sessionId)) {
				seededProjection.add(sessionId);
				try {
					await seedProjectionState(ctx, sharedState, sessionId);
				} catch (error) {
					log(`[bridge/sse] projection seed failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			const sessionEvent = frame.event;
			ctx.state.invalidateHistory(sessionId);
			if (sessionEvent.type === "turn/start") ctx.state.setSessionRunning(sessionId, true, frame.event.time);
			else if (sessionEvent.type === "turn/end") ctx.state.setSessionRunning(sessionId, false, frame.event.time);
			if (sessionEvent.type === "session" || sessionEvent.type === "session/created" || sessionEvent.type === "session/title") {
				ctx.state.invalidateSession();
				scheduleListRefresh();
			}
		}
		try {
			const translated = t.translate(frame);
			for (const event of translated) hub.broadcast([event]);
		} catch (error) {
			log(`[bridge/sse] frame translate failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	function currentControlBaseline() {
		const queues = {};
		for (const [sessionId, items] of controlQueues) queues[sessionId] = items;
		const projections = {};
		for (const [sessionId, projection] of controlProjections) projections[sessionId] = {
			asOfSeq: projection.asOfSeq,
			values: { ...projection.values }
		};
		return {
			queues,
			projections
		};
	}
	async function replayControlSnapshot(client) {
		if (controlQueues.size === 0 && controlProjections.size === 0) return;
		const snapshotState = new InteractionState();
		state.copyPresentationContextTo(snapshotState);
		const snapshotTranslator = new MuxEventTranslator({
			cwd,
			state: snapshotState,
			defaultModel: translatorDefaultModel ?? {
				providerID: "deepseek",
				modelID: "deepseek-chat"
			},
			log,
			sharedState: {
				todos: new Map(sharedState.todos),
				goals: new Map(sharedState.goals)
			}
		});
		for (const event of snapshotTranslator.translate({
			type: "control/baseline",
			value: currentControlBaseline()
		})) hub.send(client, event);
	}
	/** Replay the authoritative status edge missed while an SSE client was away. */
	function replaySessionStatusSnapshot(client) {
		const running = [...state.sessionRunning].filter(([, value]) => value);
		const recent = [...state.sessionRunning].filter(([, value]) => !value).sort((a, b) => (state.sessionStatusUpdatedAt.get(b[0]) ?? 0) - (state.sessionStatusUpdatedAt.get(a[0]) ?? 0)).slice(0, Math.max(0, 20 - running.length));
		for (const [sessionId] of [...running, ...recent]) {
			const isRunning = state.sessionRunning.get(sessionId) === true;
			const directory = state.sessionDirectories.get(sessionId) ?? cwd;
			hub.send(client, makeEvent(directory, "session.status", {
				sessionID: sessionId,
				status: { type: isRunning ? "busy" : "idle" }
			}, projectIdFor(directory)));
		}
	}
	function enqueueSessionTask(sessionId, task) {
		const current = (sessionFeedQueues.get(sessionId) ?? Promise.resolve()).catch((error) => {
			log(`[bridge/sse] previous ${sessionId} feed failed: ${error instanceof Error ? error.message : String(error)}`);
		}).then(task).catch((error) => {
			log(`[bridge/sse] ${sessionId} feed failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		sessionFeedQueues.set(sessionId, current);
		current.finally(() => {
			if (sessionFeedQueues.get(sessionId) === current) sessionFeedQueues.delete(sessionId);
		});
	}
	async function feed(frame) {
		const sessionId = frameSessionId(frame);
		if (sessionId === void 0) {
			await processFrame(frame).catch((error) => {
				log(`[bridge/sse] frame processing failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			return;
		}
		const current = (sessionFeedQueues.get(sessionId) ?? Promise.resolve()).catch((error) => {
			log(`[bridge/sse] previous ${sessionId} feed failed: ${error instanceof Error ? error.message : String(error)}`);
		}).then(() => processFrame(frame)).catch((error) => {
			log(`[bridge/sse] ${sessionId} feed failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		sessionFeedQueues.set(sessionId, current);
		await current;
		if (sessionFeedQueues.get(sessionId) === current) sessionFeedQueues.delete(sessionId);
	}
	function feedHostFrame(frame) {
		const sessionId = String(frame.sessionId);
		enqueueSessionTask(sessionId, () => {
			if (frame.type === "host/session-status") {
				const updatedAt = frame.updatedAt ?? Date.now();
				ctx.state.setSessionRunning(sessionId, frame.running, updatedAt);
				if (!ctx.state.shouldBroadcastSessionStatus(sessionId, frame.running)) return;
				const directory = ctx.state.sessionDirectories.get(sessionId) ?? cwd;
				hub.broadcast([makeEvent(directory, "session.status", {
					sessionID: sessionId,
					status: { type: frame.running ? "busy" : "idle" }
				}, projectIdFor(directory))]);
				return;
			}
			if (frame.type === "host/session-activity") {
				ctx.state.markSessionActivity(sessionId, frame.updatedAt);
				return;
			}
			if (frame.type === "host/agent-error") {
				const directory = ctx.state.sessionDirectories.get(sessionId) ?? cwd;
				for (const event of agentErrorEvents(sessionId, frame.message, directory)) hub.broadcast([event]);
				return;
			}
			ctx.state.invalidateSession();
			scheduleListRefresh();
			if (frame.type === "host/session-removed") {
				ctx.state.clearSession(sessionId);
				seededProjection.delete(sessionId);
				for (const key of [...replayGuard.chunks]) if (key.startsWith(`${sessionId}:`)) replayGuard.chunks.delete(key);
				translator?.disposeSession(sessionId);
				return;
			}
			if (frame.type === "host/session-added") {
				const summary = frame.summary ?? frame;
				if (typeof summary.running === "boolean") {
					const updatedAt = summary.updatedAt;
					if (ctx.state.sessionRunningFor(sessionId) === void 0 || typeof updatedAt === "number") ctx.state.setSessionRunning(sessionId, summary.running, typeof updatedAt === "number" ? updatedAt : void 0);
				}
				for (const event of hostSessionAddedEvents(ctx, {
					sessionId: frame.sessionId,
					...summary === void 0 ? {} : summary
				})) hub.broadcast([event]);
			}
		});
	}
	return {
		ctx,
		match,
		startSse,
		feed,
		feedHostFrame,
		serveWebUi(req, res) {
			if (options.webUiDir === void 0) return false;
			return serveWebUiFile(res, options.webUiDir, req.pathname, req.method);
		},
		setCwd(directory) {
			cwd = directory;
			ctx.cwd = directory;
		},
		prefetchSessionList() {
			(async () => {
				try {
					const items = await cachedSessionList(ctx);
					await Promise.allSettled(items.slice(0, 5).map((item) => cachedSessionHistory(ctx, String(item.sessionId), { maxMessages: 100 })));
				} catch (error) {
					log(`[bridge] session list prefetch failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			})();
		},
		prefetchSession(sessionId) {
			ctx.state.setCurrentSession(sessionId);
			cachedSessionHistory(ctx, sessionId, { maxMessages: 100 }).catch((error) => {
				log(`[bridge] session history prefetch failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		},
		hasNewActivity() {
			return ctx.state.newInputDuringRun;
		},
		async exitNoteNeeded() {
			if (ctx.state.newInputDuringRun) return true;
			const sessionId = ctx.state.currentSessionId;
			if (sessionId === void 0) return false;
			try {
				const history = await cachedSessionHistory(ctx, sessionId, { maxMessages: 100 });
				const title = history.projections === void 0 ? void 0 : history.projections.values.title;
				return typeof title === "string" && title.length > 0;
			} catch {
				return false;
			}
		}
	};
}
function matchPattern(pattern, pathname) {
	const patternSegments = pattern.split("/");
	const pathSegments = pathname.split("/");
	const starIndex = patternSegments.indexOf("*");
	if (starIndex !== -1) {
		if (starIndex !== patternSegments.length - 1) return false;
		if (pathSegments.length <= starIndex) return false;
		const prefixPattern = patternSegments.slice(0, starIndex);
		const prefixPath = pathSegments.slice(0, starIndex);
		if (prefixPattern.length !== prefixPath.length) return false;
		return prefixPattern.every((segment, index) => segment === prefixPath[index] || segment.startsWith(":"));
	}
	if (patternSegments.length !== pathSegments.length) return false;
	return patternSegments.every((segment, index) => segment === pathSegments[index] || segment.startsWith(":"));
}
function extractParams(pattern, pathname) {
	const patternSegments = pattern.split("/");
	const pathSegments = pathname.split("/");
	const params = {};
	const starIndex = patternSegments.indexOf("*");
	if (starIndex !== -1) {
		params["*"] = pathSegments.slice(starIndex).join("/");
		patternSegments.slice(0, starIndex).forEach((segment, index) => {
			if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(pathSegments[index] ?? "");
		});
		return params;
	}
	patternSegments.forEach((segment, index) => {
		if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(pathSegments[index] ?? "");
	});
	return params;
}
//#endregion
//#region src/bridge/http.ts
const MAX_BODY_BYTES = 1048576;
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
function isAllowedCorsOrigin(origin, extra = []) {
	if (origin === void 0 || origin.length === 0) return true;
	if (origin.startsWith("http://localhost:")) return true;
	if (origin.startsWith("http://127.0.0.1:")) return true;
	if (origin.startsWith("oc://renderer")) return true;
	if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") return true;
	if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(origin)) return true;
	return extra.includes(origin);
}
/** The CORS headers for one request. */
function corsHeaders(origin, extra = []) {
	if (!isAllowedCorsOrigin(origin, extra)) return {};
	return {
		"Access-Control-Allow-Origin": origin ?? "*",
		"Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Last-Event-ID",
		"Access-Control-Allow-Credentials": "true",
		"Access-Control-Max-Age": "86400"
	};
}
/**
* Start the loopback HTTP server. `url`/`port` are available once the
* returned promise resolves (after `listen` on 127.0.0.1:0).
*/
async function startBridgeServer(router, options = {}) {
	const host = options.host ?? "127.0.0.1";
	const listenPort = options.port ?? 0;
	const sockets = /* @__PURE__ */ new Set();
	const server = http.createServer((req, res) => {
		handleRequest(router, req, res, options.corsOrigins ?? []).catch((error) => {
			sendError(res, error instanceof HttpError ? error : internalError(error instanceof Error ? error.message : String(error)));
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(listenPort, host);
	});
	const port = server.address().port;
	return {
		url: `http://${host}:${port}`,
		port,
		server,
		close: async () => {
			router.ctx.hub.closeAll();
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		}
	};
}
async function handleRequest(router, req, res, corsOrigins = []) {
	const method = req.method ?? "GET";
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const pathname = url.pathname;
	const origin = req.headers.origin;
	const cors = corsHeaders(typeof origin === "string" ? origin : void 0, corsOrigins);
	for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);
	if (method === "OPTIONS") {
		res.writeHead(204, cors);
		res.end();
		return;
	}
	if (process.env.DSH_OC_HTTP_LOG === "1") process.stderr.write(`[bridge/http] ${method} ${pathname}\n`);
	let body;
	if (method !== "GET" && method !== "HEAD") body = await readBody(req);
	const route = router.match(method, pathname);
	if (!route) {
		if (!(pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/auth/") || pathname === "/openapi.json") && router.serveWebUi !== void 0 && (method === "GET" || method === "HEAD")) {
			if (router.serveWebUi({
				method,
				pathname,
				query: url.searchParams,
				params: {},
				headers: req.headers,
				body: void 0
			}, res)) return;
		}
		throw notImplemented(`${method} ${pathname} is not implemented by oc-bridge`);
	}
	const request = {
		method,
		pathname,
		query: url.searchParams,
		params: extractParams(route.pattern, pathname),
		headers: req.headers,
		body
	};
	if (route.kind === "sse") {
		req.socket.setTimeout(0);
		router.startSse(request, res);
		return;
	}
	const result = await route.handler(request, router.ctx);
	sendResult(res, result.status, result.body, result.raw, result.headers);
}
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw badRequest("request body exceeds 1 MiB limit");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return void 0;
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.length === 0) return void 0;
	try {
		return JSON.parse(raw);
	} catch {
		throw badRequest("invalid JSON body");
	}
}
/**
* Write the response body.
*
* The CORS headers are already on the response (they depend on the request's
* origin), so they are not repeated here: `writeHead` would replace them.
*/
function sendResult(res, status, body, raw, headers) {
	if (raw !== void 0) {
		const data = typeof raw === "string" ? raw : raw.toString("utf8");
		res.writeHead(status, {
			...headers,
			"Content-Type": headers?.["Content-Type"] ?? "text/plain; charset=utf-8",
			"Content-Length": Buffer.byteLength(data)
		});
		res.end(data);
		return;
	}
	if (status === 204 || status === 304 || body === void 0) {
		res.writeHead(status, {
			...headers,
			"Content-Length": "0"
		});
		res.end();
		return;
	}
	const data = JSON.stringify(body);
	res.writeHead(status, {
		...headers,
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(data)
	});
	res.end(data);
}
function sendError(res, error) {
	sendResult(res, error.status, error.body);
}
//#endregion
export { makeEvent as a, webUiDir as i, createBridgeRouter as n, OPENCODE_VERSION as o, resolveWebUiDir as r, projectIdFor as s, startBridgeServer as t };

//# sourceMappingURL=http-BPnSGWma.js.map