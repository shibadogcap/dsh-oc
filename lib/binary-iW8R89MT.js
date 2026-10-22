import { OPENCODE_BIN_ENV, OPENCODE_VERSION } from "./index.js";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
//#region src/tui/platform.ts
/**
* Platform/asset selection for the official opencode release binaries.
*
* This mirrors the platform-selection semantics of the official
* `opencode-ai` postinstall script: the same platform/arch mapping, the same
* musl and AVX2 probes, and the same candidate ordering. The returned keys
* are `opencode-assets.json` keys (without the `opencode-` prefix used by the
* npm platform packages).
*/
const PLATFORM_MAP = {
	darwin: "darwin",
	linux: "linux",
	win32: "windows"
};
const ARCH_MAP = {
	x64: "x64",
	arm64: "arm64",
	arm: "arm"
};
const AVX2_CPUINFO = /(^|\s)avx2(\s|$)/i;
const WINDOWS_AVX2_COMMAND = "(Add-Type -MemberDefinition \"[DllImport(\"\"kernel32.dll\"\")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);\" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)";
const WINDOWS_EXECUTABLES = [
	"powershell.exe",
	"pwsh.exe",
	"pwsh",
	"powershell"
];
function defaultReadFile(path) {
	return readFileSync(path, "utf8");
}
function defaultExists(path) {
	return existsSync(path);
}
function defaultExecFileSync(file, args, options = {}) {
	return spawnSync(file, args, {
		encoding: "utf8",
		timeout: 1500,
		windowsHide: true,
		...options
	});
}
/**
* Resolve the platform selection with injectable probes.
* @param deps - optional probe overrides; defaults read the real host.
* @returns the selected asset key and platform facts.
*/
function resolvePlatform(deps = {}) {
	const rawPlatform = deps.platform ?? process.platform;
	const platform = PLATFORM_MAP[rawPlatform] ?? rawPlatform;
	const arch = ARCH_MAP[deps.arch ?? process.arch] ?? deps.arch ?? process.arch;
	const readFile = deps.readFile ?? defaultReadFile;
	const exists = deps.exists ?? defaultExists;
	const execFileSync = deps.execFileSync ?? defaultExecFileSync;
	const avx2 = supportsAvx2(platform, arch, readFile, execFileSync);
	const musl = isMusl(platform, exists, execFileSync);
	const candidates = candidateKeys(platform, arch, musl, avx2);
	return {
		platform,
		arch,
		musl,
		avx2,
		candidates,
		key: candidates[0] ?? "",
		extension: platform === "linux" ? ".tar.gz" : ".zip",
		executableName: rawPlatform === "win32" ? "opencode.exe" : "opencode"
	};
}
function supportsAvx2(platform, arch, readFile, execFileSync) {
	if (arch !== "x64") return false;
	if (platform === "linux") try {
		return AVX2_CPUINFO.test(readFile("/proc/cpuinfo"));
	} catch {
		return false;
	}
	if (platform === "darwin") try {
		const result = execFileSync("sysctl", ["-n", "hw.optional.avx2_0"], {
			encoding: "utf8",
			timeout: 1500
		});
		if (result.status !== 0) return false;
		return String(result.stdout ?? "").trim() === "1";
	} catch {
		return false;
	}
	if (platform === "windows") for (const executable of WINDOWS_EXECUTABLES) try {
		const result = execFileSync(executable, [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			WINDOWS_AVX2_COMMAND
		], {
			encoding: "utf8",
			timeout: 3e3,
			windowsHide: true
		});
		if (result.status !== 0) continue;
		const output = String(result.stdout ?? "").trim().toLowerCase();
		if (output === "true" || output === "1") return true;
		if (output === "false" || output === "0") return false;
	} catch {
		continue;
	}
	return false;
}
function isMusl(platform, exists, execFileSync) {
	if (platform !== "linux") return false;
	try {
		if (exists("/etc/alpine-release")) return true;
	} catch {}
	try {
		const result = execFileSync("ldd", ["--version"], { encoding: "utf8" });
		return `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`.toLowerCase().includes("musl");
	} catch {
		return false;
	}
}
function candidateKeys(platform, arch, musl, avx2) {
	const base = `${platform}-${arch}`;
	const baseline = arch === "x64" && !avx2;
	if (platform === "linux") {
		if (musl) {
			if (arch === "x64") return baseline ? [
				`${base}-baseline-musl`,
				`${base}-musl`,
				`${base}-baseline`,
				base
			] : [
				`${base}-musl`,
				`${base}-baseline-musl`,
				base,
				`${base}-baseline`
			];
			return [`${base}-musl`, base];
		}
		if (arch === "x64") return baseline ? [
			`${base}-baseline`,
			base,
			`${base}-baseline-musl`,
			`${base}-musl`
		] : [
			base,
			`${base}-baseline`,
			`${base}-musl`,
			`${base}-baseline-musl`
		];
		return [base, `${base}-musl`];
	}
	if (arch === "x64") return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`];
	if (platform === "windows" && arch === "arm64") return [
		base,
		`${platform}-x64-baseline`,
		`${platform}-x64`
	];
	return [base];
}
//#endregion
//#region src/tui/download.ts
/**
* Lazy resolution of the official opencode binary from the npm platform
* packages (`@opencode/cli-<platform>-<arch>[-baseline][-musl]`): install the
* matching package, copy its binary into the dsh opencode cache, verify the
* version, and return the cached path.
*/
const MIRROR_ENV = "DSH_OC_OPENCODE_MIRROR";
const GITHUB_PREFIX = "https://github.com/";
/**
* Rewrite a GitHub asset URL through `DSH_OC_OPENCODE_MIRROR` when set.
* @param url - the manifest asset URL.
* @param env - environment mapping.
* @returns the URL to request.
*/
function resolveAssetUrl(url, env = process.env) {
	const mirror = env[MIRROR_ENV];
	if (mirror === void 0 || mirror.trim().length === 0 || !url.startsWith(GITHUB_PREFIX)) return url;
	return `${mirror.replace(/\/+$/, "")}/${url.slice(19)}`;
}
/**
* Resolve, install and cache the opencode binary from npm platform packages.
* @param options - overrides for tests and non-default homes.
* @returns the absolute path of the cached executable.
*/
async function downloadOpenCode(options = {}) {
	const env = options.env ?? process.env;
	const home = options.home ?? resolveDshHome(void 0, env);
	const version = options.version ?? "2.1.0";
	const platform = options.platform ?? resolvePlatform();
	const key = options.key ?? platform.key;
	const spawnImpl = options.spawnSyncImpl ?? spawnSync;
	const probe = options.probe ?? defaultProbe$1;
	const exists = existsSync;
	const target = join(home, "opencode", "bin", version, platform.executableName);
	if (exists(target)) try {
		verifyVersion(target, version, probe);
		return target;
	} catch {}
	const candidates = platform.candidates && platform.candidates.length > 0 ? platform.candidates : [key];
	let lastError;
	for (const candidate of candidates) {
		const packageName = npmPackageNameFor(candidate);
		const tmpBase = join(home, "opencode", "tmp");
		join(tmpBase, randomUUID());
		const installDir = join(home, "opencode", "packages", candidate);
		mkdirSync(tmpBase, { recursive: true });
		try {
			let installed = false;
			if (options.installNpmPackage !== void 0) {
				installed = await options.installNpmPackage(packageName, version, installDir);
				if (installed) {
					const src = join(installDir, "node_modules", packageName, "bin", platform.executableName);
					if (exists(src)) {
						mkdirSync(dirname(target), { recursive: true });
						if (exists(target)) rmSync(target, { force: true });
						try {
							linkSync(src, target);
						} catch {
							const { copyFileSync } = await import("node:fs");
							copyFileSync(src, target);
						}
						chmodSync(target, 493);
					}
				}
			} else {
				const temp = join(tmpBase, randomUUID());
				mkdirSync(temp, { recursive: true });
				try {
					const result = spawnImpl("npm", [
						"install",
						"--ignore-scripts",
						"--no-save",
						"--no-audit",
						"--no-fund",
						"--loglevel=error",
						"--prefix",
						temp,
						`${packageName}@${version}`
					], {
						stdio: "ignore",
						windowsHide: true,
						timeout: 12e4
					});
					if (result.error === void 0 && result.status === 0) {
						const src = join(temp, "node_modules", packageName, "bin", platform.executableName);
						if (exists(src)) {
							mkdirSync(dirname(target), { recursive: true });
							if (exists(target)) rmSync(target, { force: true });
							try {
								linkSync(src, target);
							} catch {
								const { copyFileSync } = await import("node:fs");
								copyFileSync(src, target);
							}
							chmodSync(target, 493);
							installed = true;
						}
					}
					if (!installed) {
						const pnpmResult = spawnImpl("pnpm", [
							"install",
							"--ignore-scripts",
							"--no-save",
							"--dir",
							temp,
							`${packageName}@${version}`
						], {
							stdio: "ignore",
							windowsHide: true,
							timeout: 12e4
						});
						if (pnpmResult.error === void 0 && pnpmResult.status === 0) {
							const src = join(temp, "node_modules", packageName, "bin", platform.executableName);
							if (exists(src)) {
								mkdirSync(dirname(target), { recursive: true });
								if (exists(target)) rmSync(target, { force: true });
								try {
									linkSync(src, target);
								} catch {
									const { copyFileSync } = await import("node:fs");
									copyFileSync(src, target);
								}
								chmodSync(target, 493);
								installed = true;
							}
						}
					}
				} finally {
					rmSync(temp, {
						recursive: true,
						force: true
					});
				}
			}
			if (!installed || !exists(target)) throw new Error(`failed to install ${packageName}@${version}`);
			verifyVersion(target, version, probe);
			rmSync(tmpBase, {
				recursive: true,
				force: true
			});
			return target;
		} catch (error) {
			lastError = error;
			rmSync(tmpBase, {
				recursive: true,
				force: true
			});
			continue;
		}
	}
	const message = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`Failed to download opencode ${version} (asset ${key}): ${message}\nYou can recover by:\n  - setting ${OPENCODE_BIN_ENV} to an absolute path of a working opencode binary,\n  - running: dsh plugin --profile oc add opencode-ai@2.1.0 (or @opencode/cli@2.1.0)\n  - or manually downloading the @opencode/cli platform package and placing the executable at ${target}`);
}
function verifyVersion(bin, version, probe) {
	const probeImpl = probe ?? defaultProbe$1;
	let output;
	try {
		output = probeImpl(bin);
	} catch {
		output = void 0;
	}
	if (output === void 0 || !output.includes(version)) throw new Error(`extracted binary at ${bin} did not report opencode ${version} (got ${JSON.stringify(output)})`);
}
function defaultProbe$1(bin) {
	try {
		const result = spawnSync(bin, ["--version"], {
			encoding: "utf8",
			timeout: 5e3,
			windowsHide: true
		});
		if (result.error !== void 0 || result.status !== 0) return void 0;
		return String(result.stdout ?? "");
	} catch {
		return;
	}
}
//#endregion
//#region src/tui/binary.ts
/**
* opencode binary resolver for oc-tui.
*
* Priority:
* 1. `DSH_OC_OPENCODE_BIN` (absolute path only)
* 2. `$DSH_HOME/opencode/bin/<version>/opencode(.exe)`
* 3. `opencode` on `PATH`
* 4. official npm platform package (`opencode-<platform>-<arch>[-baseline][-musl]`)
*    lazily installed under `$DSH_HOME/opencode/packages/<platform-key>`
* 5. an installed `opencode-ai` package (its official postinstall is run first)
* 6. lazy GitHub Release download (per-platform `sha256` from the manifest)
*/
/**
* Extract the first `x.y.z` semver from an opencode `--version` probe.
* Accepts `1.18.18`, `opencode 1.18.18` and `v1.18.18` outputs.
*/
function parseOpenCodeVersion(output) {
	if (output === void 0) return void 0;
	const match = /\b(?:v)?(\d+)\.(\d+)\.(\d+)\b/.exec(output);
	if (match === null) return void 0;
	return `${match[1]}.${match[2]}.${match[3]}`;
}
/**
* Probe a binary and verify its `--version` matches the expected opencode
* version. Throws with a clear remediation message on mismatch.
*/
async function verifyOpenCodeVersion(bin, expected = OPENCODE_VERSION, probe = defaultProbe) {
	const output = await probe(bin);
	const actual = parseOpenCodeVersion(output);
	if (actual !== expected) throw new Error(`opencode binary ${JSON.stringify(bin)} reports version ${actual ?? "unknown"} (${JSON.stringify(output ?? "")}), expected ${expected}. Clear the versioned cache under $DSH_HOME/opencode/bin or set ${OPENCODE_BIN_ENV} to a binary matching ${expected}.`);
	return actual;
}
/**
* Resolve the opencode binary with the documented priority.
* @param deps - overrides for tests and non-default environments.
* @returns the selected executable and its source.
*/
async function resolveOpenCodeBinary(deps = {}) {
	const env = deps.env ?? process.env;
	const home = deps.home ?? resolveDshHome(void 0, env);
	const version = deps.version ?? "2.1.0";
	const platform = deps.platform ?? resolvePlatform();
	const exists = deps.exists ?? existsSync;
	const probe = deps.probe ?? defaultProbe;
	const matches = async (bin) => {
		try {
			return parseOpenCodeVersion(await probe(bin)) === version;
		} catch {
			return false;
		}
	};
	const override = deps.binaryOverride ?? env["DSH_OC_OPENCODE_BIN"];
	if (override !== void 0) {
		if (!isAbsolute(override)) throw new Error(`${OPENCODE_BIN_ENV} must be an absolute path, got ${JSON.stringify(override)}`);
		if (!exists(override)) throw new Error(`${OPENCODE_BIN_ENV} points to a missing binary: ${JSON.stringify(override)}`);
		if (await matches(override)) return {
			bin: override,
			source: "env"
		};
		await verifyOpenCodeVersion(override, version, probe);
	}
	const cacheBin = join(home, "opencode", "bin", version, platform.executableName);
	if (exists(cacheBin) && await matches(cacheBin)) return {
		bin: cacheBin,
		source: "cache"
	};
	for (const dir of pathEntries(env.PATH ?? "")) {
		const candidate = join(dir, platform.executableName);
		if (exists(candidate) && await matches(candidate)) return {
			bin: candidate,
			source: "path"
		};
	}
	for (const key of platform.candidates) {
		const packageName = npmPackageNameFor(key);
		const targetDir = npmPackageTargetDir(home, key);
		const packageBin = npmPackageBinaryPath(targetDir, packageName, platform);
		if (exists(packageBin) && await matches(packageBin)) return {
			bin: packageBin,
			source: "package"
		};
		const install = deps.installNpmPackage ?? installNpmPackage;
		try {
			if (await install(packageName, version, targetDir) && exists(packageBin) && await matches(packageBin)) return {
				bin: packageBin,
				source: "package"
			};
		} catch {}
	}
	for (const packageDir of findPackageDirs(home, deps)) {
		if (!exists(join(packageDir, "package.json"))) continue;
		const runPostinstall = deps.runPackagePostinstall ?? runOfficialPostinstall;
		try {
			await runPostinstall(packageDir);
		} catch {}
		const binaryPath = packageBinaryPath(packageDir, platform, exists, deps.readFile);
		if (binaryPath === void 0) continue;
		if (await matches(binaryPath)) return {
			bin: binaryPath,
			source: "package"
		};
	}
	return {
		bin: await (deps.download ?? downloadOpenCode)({
			env,
			home,
			version,
			platform
		}),
		source: "download"
	};
}
/** Official npm platform package name for a manifest asset key. */
function npmPackageNameFor(key) {
	return `@opencode/cli-${key}`;
}
/** Cache directory for an installed npm platform package. */
function npmPackageTargetDir(home, key) {
	return join(home, "opencode", "packages", key);
}
/** Binary path inside an npm platform package installed with `npm --prefix`. */
function npmPackageBinaryPath(targetDir, packageName, platform) {
	return join(targetDir, "node_modules", packageName, "bin", platform.executableName);
}
async function installNpmPackage(packageName, version, targetDir) {
	const spec = `${packageName}@${version}`;
	const npmResult = spawnSync("npm", [
		"install",
		"--ignore-scripts",
		"--no-save",
		"--no-audit",
		"--no-fund",
		"--loglevel=error",
		"--prefix",
		targetDir,
		spec
	], {
		encoding: "utf8",
		timeout: 12e4,
		windowsHide: true,
		stdio: "ignore"
	});
	if (npmResult.error === void 0 && npmResult.status === 0) return true;
	const pnpmResult = spawnSync("pnpm", [
		"install",
		"--ignore-scripts",
		"--no-save",
		"--dir",
		targetDir,
		spec
	], {
		encoding: "utf8",
		timeout: 12e4,
		windowsHide: true,
		stdio: "ignore"
	});
	return pnpmResult.error === void 0 && pnpmResult.status === 0;
}
function defaultProbe(bin) {
	try {
		const result = spawnSync(bin, ["--version"], {
			encoding: "utf8",
			timeout: 5e3,
			windowsHide: true
		});
		if (result.error !== void 0 || result.status !== 0) return void 0;
		return String(result.stdout ?? "");
	} catch {
		return;
	}
}
function pathEntries(pathValue) {
	return pathValue.split(delimiter).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
function findPackageDirs(home, deps) {
	const dirs = [...deps.packageRoots ?? []];
	const packageNames = ["opencode-ai", "@opencode/cli"];
	const profilesDir = join(home, "profiles");
	for (const name of packageNames) dirs.push(join(profilesDir, "node_modules", name));
	try {
		for (const entry of deps.readdir?.(profilesDir) ?? readdirSync(profilesDir, { withFileTypes: true })) if (entry.isDirectory()) for (const name of packageNames) dirs.push(join(profilesDir, entry.name, "node_modules", name));
	} catch {}
	for (const name of packageNames) dirs.push(join(home, "node_modules", name));
	const seen = /* @__PURE__ */ new Set();
	return dirs.filter((dir) => {
		const normalized = resolve(dir);
		if (seen.has(normalized)) return false;
		seen.add(normalized);
		return (deps.exists ?? existsSync)(normalized);
	});
}
function packageBinaryPath(packageDir, platform, exists, readFile) {
	let manifest;
	try {
		manifest = JSON.parse((readFile ?? ((path) => readFileSync(path, "utf8")))(join(packageDir, "package.json")));
	} catch {
		return;
	}
	const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[platform.executableName] ?? manifest.bin?.opencode;
	return [
		bin !== void 0 ? join(packageDir, bin) : void 0,
		join(packageDir, "bin", platform.executableName),
		join(packageDir, "bin", "opencode.exe")
	].filter((candidate) => candidate !== void 0).find((candidate) => exists(candidate));
}
async function runOfficialPostinstall(packageDir) {
	const result = spawnSync("node", ["postinstall.mjs"], {
		cwd: packageDir,
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error !== void 0) throw result.error;
	if (result.status !== 0) throw new Error(`opencode-ai postinstall failed with exit code ${String(result.status)}`);
}
//#endregion
export { verifyOpenCodeVersion as n, resolveAssetUrl as r, resolveOpenCodeBinary as t };

//# sourceMappingURL=binary-iW8R89MT.js.map