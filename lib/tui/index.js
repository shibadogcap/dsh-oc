import { n as helpRequested, r as ocHelp, t as helpLanguageFromEnv } from "../help-CSc5dFMy.js";
import { n as verifyOpenCodeVersion, r as resolveAssetUrl, t as resolveOpenCodeBinary$1 } from "../binary-iW8R89MT.js";
import { Service } from "@deepseek-ai/cordis";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { z } from "zod";
//#region tui-branding/art.ts
/** "DSH" rendered in figlet Slant. */
const DSH = [
	"    ____  _____ __  __",
	"   / __ \\/ ___// / / /",
	"  / / / /\\__ \\/ /_/ / ",
	" / /_/ /___/ / __  /  ",
	"/_____//____/_/ /_/   "
];
/** "OC" rendered in figlet Slant. */
const OC = [
	"   ____  ______",
	"  / __ \\/ ____/",
	" / / / / /     ",
	"/ /_/ / /___   ",
	"\\____/\\____/   "
];
//#endregion
//#region src/tui/brand.ts
const GAP = "   ";
const SUBTITLE = "DeepSeek Harness × OpenCode TUI";
/**
* Plain-text DSH OC brand banner for `--mini` launches. The official mini
* interface does not load TUI plugins (its entry splash is hard-coded), so
* dsh-oc prints the brand itself before spawning the child.
*/
function renderMiniBrand() {
	return `${DSH.map((line, index) => `${line}${GAP}${OC[index] ?? ""}`).join("\n")}\n${SUBTITLE}\n`;
}
//#endregion
//#region src/tui/temp.ts
/**
* OpenTUI 0.5.x embeds its native renderer as a Bun `type: "file"` asset.
* Bun 1.3.x materializes that asset as `.<hash>-00000000.<ext>` in the
* process temp directory and does not remove it. Keep those files in a
* dsh-owned, per-process directory so a renderer leak cannot fill the shared
* system `/tmp` (or another user's quota).
*/
const OPENCODE_TMP_ROOT = "tmp";
const TUI_TMP_PREFIX = "tui-";
const NATIVE_TEMP_FILE = /^\.[0-9a-f]+-00000000\.(?:so|dylib|dll|node)$/i;
const TUI_TMP_DIR = /^tui-(\d+)$/;
function opencodeTuiTempDir(dshHome, pid = process.pid) {
	return join(dshHome, "opencode", OPENCODE_TMP_ROOT, `${TUI_TMP_PREFIX}${pid}`);
}
/** Whether a process id still belongs to a live process. Injectable in tests. */
function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
/**
* Remove only the native files known to be produced by OpenTUI's Bun loader.
* Unknown files are deliberately left untouched because this directory also
* hosts download transaction files used by the binary resolver.
*/
function cleanupOpenCodeNativeTemp(directory) {
	if (!existsSync(directory)) return 0;
	let removed = 0;
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !NATIVE_TEMP_FILE.test(entry.name)) continue;
		try {
			unlinkSync(join(directory, entry.name));
			removed++;
		} catch {}
	}
	return removed;
}
/**
* Prepare this run's isolated OpenTUI temp directory and reap directories
* left by dsh processes that are no longer alive. The liveness check is
* injectable so cleanup behavior stays deterministic in unit tests.
*/
function prepareOpenCodeTemp(dshHome, pid = process.pid, isAlive = processAlive) {
	const root = join(dshHome, "opencode", OPENCODE_TMP_ROOT);
	mkdirSync(root, { recursive: true });
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const match = TUI_TMP_DIR.exec(entry.name);
			if (match === null || Number(match[1]) === pid) continue;
			if (isAlive(Number(match[1]))) continue;
			try {
				rmSync(join(root, entry.name), {
					recursive: true,
					force: true
				});
			} catch {}
		}
	} catch {}
	const current = opencodeTuiTempDir(dshHome, pid);
	mkdirSync(current, { recursive: true });
	cleanupOpenCodeNativeTemp(current);
	return current;
}
//#endregion
//#region src/tui/index.ts
/**
* oc-tui Cordis plugin: resolve the opencode binary, spawn
* `opencode --server <bridge-url>` with an isolated data home, forward parent
* signals, and request a bounded dsh exit when the child exits.
*/
/** Environment variable that seeds the opencode TUI with timestamps shown. */
const DSH_OC_TUI_TIMESTAMPS = "DSH_OC_TUI_TIMESTAMPS";
/** TUI config file name under OPENCODE_CONFIG_DIR. */
const OPENCODE_TUI_FILE = "tui.json";
/** Main opencode config file name under OPENCODE_CONFIG_DIR. */
const OPENCODE_CONFIG_FILE = "opencode.json";
/** KV state file used by the opencode TUI for per-feature signals. */
const OPENCODE_KV_FILE = "kv.json";
/** Branding TUI plugin directory name inside the isolated opencode config. */
const OPENCODE_BRANDING_PLUGIN = "dsh-oc-logo";
/**
* Verified opencode 1.18.18 switches that disable background update checks,
* remote model catalog fetches and LSP binary downloads. Set before the child
* process spawns; the values are read from the process environment.
*/
const OPENCODE_NETWORK_SAFETY_ENV = {
	OPENCODE_DISABLE_AUTOUPDATE: "1",
	OPENCODE_DISABLE_MODELS_FETCH: "1",
	OPENCODE_DISABLE_LSP_DOWNLOAD: "1"
};
/**
* Whether timestamps should be enabled for the opencode TUI child.
* Accepts `1`, `true`, `yes` and `on` (case-insensitive).
*/
function tuiTimestampsEnabled(env = process.env) {
	const value = env[DSH_OC_TUI_TIMESTAMPS]?.toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}
function readJsonObject(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
/**
* Seed the isolated opencode state so `DSH_OC_TUI_TIMESTAMPS=1` takes effect
* on the next TUI boot.
*
* The opencode 1.18.18 TUI stores the timestamps toggle in its KV state file
* (`$XDG_STATE_HOME/opencode/kv.json`), so this writes that state and also
* writes a minimal `tui.json` with `session_toggle_timestamps` /
* `messages_toggle_timestamps` bound to `ctrl+shift+t` for toggling at runtime.
* Existing config/state values are preserved by merging.
*/
/** Absolute path of the shipped `tui-branding/` plugin package. */
function brandingSourceDir() {
	return fileURLToPath(new URL("../../tui-branding/", import.meta.url));
}
/**
* Seed the isolated opencode TUI state:
* - always copies the dsh-oc branding plugin into the config dir and lists it
*   in `tui.json` (replacing the OpenCode ASCII logo on the home screen);
* - when `DSH_OC_TUI_TIMESTAMPS=1`, additionally enables default timestamps
*   through `kv.json` and `tui.json` keybinds.
* Existing config/state values are preserved by merging.
*/
function prepareOpenCodeTuiState(dshHome, env = process.env) {
	const configDir = join(dshHome, "opencode", "config");
	const tuiConfigPath = join(configDir, OPENCODE_TUI_FILE);
	const pluginDir = join(configDir, "plugins", OPENCODE_BRANDING_PLUGIN);
	mkdirSync(configDir, { recursive: true });
	cpSync(brandingSourceDir(), pluginDir, {
		recursive: true,
		force: true
	});
	const tuiConfig = readJsonObject(tuiConfigPath);
	const pluginList = Array.isArray(tuiConfig.plugin) ? tuiConfig.plugin : [];
	const merged = {
		...tuiConfig,
		plugin: [.../* @__PURE__ */ new Set([...pluginList, pluginDir])]
	};
	if (tuiTimestampsEnabled(env)) merged.keybinds = {
		...typeof tuiConfig.keybinds === "object" && tuiConfig.keybinds !== null && !Array.isArray(tuiConfig.keybinds) ? tuiConfig.keybinds : {},
		session_toggle_timestamps: "ctrl+shift+t",
		messages_toggle_timestamps: "ctrl+shift+t"
	};
	writeFileSync(tuiConfigPath, `${JSON.stringify(merged, null, 2)}\n`);
	if (tuiTimestampsEnabled(env)) {
		const kvPath = join(dshHome, "opencode", "state", "opencode", OPENCODE_KV_FILE);
		mkdirSync(dirname(kvPath), { recursive: true });
		const kv = readJsonObject(kvPath);
		writeFileSync(kvPath, `${JSON.stringify({
			...kv,
			timestamps: "show"
		}, null, 2)}\n`);
	}
}
/**
* Seed the isolated opencode config with `autoupdate: false`, preserving any
* existing values. This is the config-level counterpart of
* `OPENCODE_DISABLE_AUTOUPDATE` and keeps the TUI child from downloading or
* hot-replacing itself even if a future opencode version changes the env flag.
*/
function prepareOpenCodeConfig(dshHome) {
	const configDir = join(dshHome, "opencode", "config");
	const configPath = join(configDir, OPENCODE_CONFIG_FILE);
	mkdirSync(configDir, { recursive: true });
	const config = readJsonObject(configPath);
	writeFileSync(configPath, `${JSON.stringify({
		...config,
		autoupdate: false
	}, null, 2)}\n`);
}
/** oc-tui configuration schema; both fields are optional. */
const OcTuiConfig = z.object({
	/** Absolute path override for the opencode binary (test/debug friendly). */
	binary: z.string().optional(),
	/** Extra arguments appended before the dsh command line arguments. */
	args: z.array(z.string()).optional()
}).default({});
/** Spawn `opencode --server <url>` with stdio inherit and signal/termination helpers. */
function startOpenCodeTui(options) {
	const bridgeUrl = options.bridge.url.length > 0 ? options.bridge.url : `http://127.0.0.1:${options.bridge.port}`;
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	if (options.tuiArgs.includes("--mini")) process.stdout.write(`${renderMiniBrand()}\n`);
	const spawnImpl = options.spawn ?? defaultSpawn;
	const setTimeoutImpl = options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimeoutImpl = options.clearTimeoutImpl ?? ((handle) => {
		if (handle !== void 0) clearTimeout(handle);
	});
	const killTimeoutMs = options.killTimeoutMs ?? 5e3;
	const mini = options.tuiArgs.includes("--mini");
	const rest = options.tuiArgs.filter((arg) => arg !== "--mini");
	const child = spawnImpl(options.bin, [
		...mini ? ["mini"] : [],
		"--server",
		bridgeUrl,
		...rest
	], {
		cwd,
		stdio: "inherit",
		env
	});
	let exited = false;
	let killTimer;
	child.on("error", (error) => {
		if (exited) return;
		exited = true;
		clearTimeoutImpl(killTimer);
		options.onError?.(error);
	});
	child.on("exit", (code, signal) => {
		if (exited) return;
		exited = true;
		clearTimeoutImpl(killTimer);
		const exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
		options.onExit?.(exitCode);
	});
	return {
		child,
		forward(signal) {
			if (!exited) child.kill(signal);
		},
		terminate() {
			if (exited) return;
			child.kill("SIGTERM");
			killTimer = setTimeoutImpl(() => {
				if (!exited) child.kill("SIGKILL");
			}, killTimeoutMs);
		}
	};
}
const defaultSpawn = (command, args, options) => {
	return spawn(command, args, options);
};
/**
* Forward parent SIGINT/SIGTERM to the running child without force-killing.
* @param processLike - process or fake process.
* @param getRunning - returns the current running TUI, if any.
* @param signals - signals to forward.
* @returns a disposer removing the listeners.
*/
function installSignalForwarding(processLike, getRunning, signals = ["SIGINT", "SIGTERM"]) {
	const handlers = [];
	for (const signal of signals) {
		const listener = () => getRunning()?.forward(signal);
		processLike.on(signal, listener);
		handlers.push({
			signal,
			listener
		});
	}
	return () => {
		for (const { signal, listener } of handlers.splice(0)) processLike.removeListener(signal, listener);
	};
}
/** Supported `opencode` flags passed through unchanged. */
const BOOLEAN_TUI_ARGS = /* @__PURE__ */ new Set([
	"--continue",
	"-c",
	"--fork",
	"--mini",
	"--print-logs",
	"--auto",
	"--standalone"
]);
const VALUE_TUI_ARGS = /* @__PURE__ */ new Set([
	"--session",
	"-s",
	"--log-level"
]);
/**
* Flags dsh-oc consumes itself. `--dir` moves the bridge's working
* directory; the 2.x CLI takes the directory as a positional argument, so it
* is not forwarded.
*/
const CONSUMED_TUI_ARGS = /* @__PURE__ */ new Set(["--dir"]);
/**
* Filter dsh app arguments into opencode arguments.
* Unknown/malformed arguments are reported, never silently dropped.
*/
function filterSupportedArgs(args) {
	const pass = [];
	const ignored = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const equalsAt = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = equalsAt >= 0 ? arg.slice(0, equalsAt) : arg;
		if (CONSUMED_TUI_ARGS.has(name)) {
			if (equalsAt < 0 && args[index + 1] !== void 0 && !args[index + 1].startsWith("-")) index++;
			continue;
		}
		if (BOOLEAN_TUI_ARGS.has(name)) {
			pass.push(arg);
			continue;
		}
		if (VALUE_TUI_ARGS.has(name)) {
			if (equalsAt >= 0) {
				pass.push(arg);
				continue;
			}
			const value = args[index + 1];
			if (value !== void 0 && !value.startsWith("-")) {
				pass.push(arg, value);
				index++;
				continue;
			}
			ignored.push(arg);
			continue;
		}
		ignored.push(arg);
	}
	return {
		pass,
		ignored
	};
}
/** Extract the `--dir <path>` / `--dir=<path>` value from raw dsh args. */
function tuiDirFromArgs(args) {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--dir") {
			const value = args[index + 1];
			if (value !== void 0 && !value.startsWith("-")) return value;
			continue;
		}
		if (arg.startsWith("--dir=")) return arg.slice(6);
	}
}
/** Extract the `--session <id>` / `-s <id>` / `--session=<id>` value. */
function tuiSessionFromArgs(args) {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--session" || arg === "-s") {
			const value = args[index + 1];
			if (value !== void 0 && !value.startsWith("-")) return value;
			continue;
		}
		if (arg.startsWith("--session=")) return arg.slice(10);
	}
}
/** Resolve and validate a `--dir` value before handing it to opencode. */
function resolveTuiDir(dir) {
	const resolved = resolve(dir);
	let stat;
	try {
		stat = statSync(resolved);
	} catch {
		throw new Error(`--dir path does not exist: ${resolved}`);
	}
	if (!stat.isDirectory()) throw new Error(`--dir is not a directory: ${resolved}`);
	return resolved;
}
/**
* Build the child environment: inherit the parent and isolate opencode state
* under `$DSH_HOME/opencode`. `OPENCODE_CONFIG_CONTENT` is intentionally
* never introduced.
*/
function buildChildEnv(env = process.env, dshHome = resolveDshHome()) {
	const tuiTempDir = opencodeTuiTempDir(dshHome);
	const childEnv = {
		...env,
		...OPENCODE_NETWORK_SAFETY_ENV,
		OPENCODE_CONFIG_DIR: join(dshHome, "opencode", "config"),
		XDG_CONFIG_HOME: join(dshHome, "opencode", "config"),
		XDG_DATA_HOME: join(dshHome, "opencode", "data"),
		XDG_STATE_HOME: join(dshHome, "opencode", "state"),
		XDG_CACHE_HOME: join(dshHome, "opencode", "cache"),
		TMPDIR: tuiTempDir,
		TMP: tuiTempDir,
		TEMP: tuiTempDir
	};
	if (tuiTimestampsEnabled(env)) childEnv.OPENCODE_TUI_CONFIG = join(dshHome, "opencode", "config", OPENCODE_TUI_FILE);
	delete childEnv.OPENCODE_CONFIG_CONTENT;
	return childEnv;
}
/**
* Request a bounded process exit through `ctx.appExit` when available.
* @param ctx - context with an optional `appExit`.
* @param code - desired exit code.
* @param fallback - exit-code setter used when no `appExit` exists.
* @returns true when `ctx.appExit` handled the request.
*/
function requestExit(ctx, code, fallback = (value) => {
	process.exitCode = value;
}) {
	const exit = ctx.get("appExit");
	if (typeof exit === "function") {
		exit(code);
		return true;
	}
	fallback(code);
	return false;
}
/**
* One-line clarification printed after the opencode mini TUI exits. The
* banner above belongs to the official opencode binary; the printed session
* id is a dsh session id and must be resumed through dsh, not opencode.
*/
function ocExitNote() {
	return "[dsh-oc] 上面是 opencode 的退出提示；session id 是 dsh 会话 id，恢复请使用 dsh --profile oc --session <id>，不要直接运行 opencode 的恢复命令";
}
/**
* Whether the exit hint is enabled. Set `DSH_OC_DISABLE_EXIT_NOTE=1` to turn
* it off for users who do not want the extra line after the TUI exits.
*/
function exitNoteEnabled(env = process.env) {
	const value = env.DSH_OC_DISABLE_EXIT_NOTE?.toLowerCase();
	return value !== "1" && value !== "true" && value !== "yes" && value !== "on";
}
/**
* Test/debug helper resolving the binary without spawning the TUI.
* Accepts either resolver deps or a context-like object carrying `config.binary`.
*/
async function resolveOpenCodeBinary(input = {}) {
	const { config, ...deps } = input;
	return resolveOpenCodeBinary$1({
		...deps,
		...config?.binary !== void 0 ? { binaryOverride: config.binary } : {}
	});
}
/**
* The oc-tui Cordis service. Mounts after `ocBridge` and owns the child's
* lifetime, signal forwarding, and exit handoff.
*/
var OcTuiService = class extends Service {
	config;
	static inject = ["ocBridge"];
	static Config = OcTuiConfig;
	running;
	removeSignalForwarding;
	constructor(ctx, config) {
		super(ctx, "ocTui");
		this.config = config;
		this.removeSignalForwarding = installSignalForwarding(process, () => this.running);
		ctx.effect(() => () => this.running?.terminate(), "ocTui.childTeardown");
		ctx.effect(() => () => this.removeSignalForwarding(), "ocTui.signalDisposer");
	}
	async [Service.init]() {
		const bridge = this.ctx.get("ocBridge");
		if (bridge === void 0) throw new Error("oc-tui: ocBridge service is unavailable");
		const rawArgs = [...this.config.args ?? [], ...this.ctx.cmdlineArgs?.get() ?? []];
		if (helpRequested(rawArgs)) {
			process.stdout.write(ocHelp());
			requestExit(this.ctx, 0);
			return;
		}
		const dirArg = tuiDirFromArgs(rawArgs);
		if (dirArg !== void 0) try {
			bridge.setCwd?.(resolveTuiDir(dirArg));
		} catch (error) {
			this.fail(error);
			return;
		}
		const sessionId = tuiSessionFromArgs(rawArgs);
		if (sessionId !== void 0) bridge.prefetchSession?.(sessionId);
		let resolved;
		try {
			resolved = await resolveOpenCodeBinary({
				env: process.env,
				binaryOverride: this.config.binary
			});
			if (process.env.DSH_OC_BYPASS_VERSION_CHECK === "1") this.ctx.logger.warn?.(`[dsh-oc] version check bypassed for ${resolved.bin}`);
			else await verifyOpenCodeVersion(resolved.bin);
		} catch (error) {
			this.fail(error);
			return;
		}
		const { pass: tuiArgs, ignored } = filterSupportedArgs(rawArgs);
		for (const arg of ignored) process.stderr.write(`[dsh-oc] ignored unsupported arg: ${arg}\n`);
		const dshHome = resolveDshHome();
		const tuiTempDir = prepareOpenCodeTemp(dshHome);
		const childEnv = buildChildEnv(process.env, dshHome);
		for (const dir of [
			join(dshHome, "opencode", "config"),
			join(dshHome, "opencode", "data"),
			join(dshHome, "opencode", "state"),
			join(dshHome, "opencode", "cache")
		]) mkdirSync(dir, { recursive: true });
		prepareOpenCodeConfig(dshHome);
		prepareOpenCodeTuiState(dshHome, process.env);
		try {
			this.running = startOpenCodeTui({
				bin: resolved.bin,
				bridge,
				tuiArgs,
				cwd: process.cwd(),
				env: childEnv,
				onExit: async (code) => {
					cleanupOpenCodeNativeTemp(tuiTempDir);
					const needed = bridge.exitNoteNeeded ? await bridge.exitNoteNeeded().catch(() => false) : bridge.hasNewActivity?.() ?? false;
					if (exitNoteEnabled(process.env) && needed) process.stdout.write(`${ocExitNote()}\n`);
					requestExit(this.ctx, code);
				},
				onError: (error) => {
					cleanupOpenCodeNativeTemp(tuiTempDir);
					this.ctx.logger.error(error);
					requestExit(this.ctx, 1);
				}
			});
		} catch (error) {
			cleanupOpenCodeNativeTemp(tuiTempDir);
			this.fail(error);
		}
	}
	fail(error) {
		const message = error instanceof Error ? error.message : String(error);
		this.ctx.logger.error(message);
		process.stderr.write(`[dsh-oc] ${message}\n`);
		requestExit(this.ctx, 1);
	}
};
//#endregion
export { DSH_OC_TUI_TIMESTAMPS, OPENCODE_BRANDING_PLUGIN, OPENCODE_CONFIG_FILE, OPENCODE_KV_FILE, OPENCODE_NETWORK_SAFETY_ENV, OPENCODE_TUI_FILE, OcTuiConfig, OcTuiService, OcTuiService as default, brandingSourceDir, buildChildEnv, cleanupOpenCodeNativeTemp, exitNoteEnabled, filterSupportedArgs, helpLanguageFromEnv, helpRequested, installSignalForwarding, ocExitNote, ocHelp, opencodeTuiTempDir, prepareOpenCodeConfig, prepareOpenCodeTemp, prepareOpenCodeTuiState, processAlive, requestExit, resolveAssetUrl, resolveOpenCodeBinary, resolveTuiDir, startOpenCodeTui, tuiDirFromArgs, tuiSessionFromArgs, tuiTimestampsEnabled };

//# sourceMappingURL=index.js.map