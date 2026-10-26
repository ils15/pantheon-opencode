import { access, lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, parse, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
//#region src/quota-cli.ts
const CLI_TIMEOUT_MS = 5e3;
const MAX_STDOUT_BYTES = 16384;
const MAX_STDERR_BYTES = 4096;
const CLI_ARGS = [
	"usage",
	"token-plan",
	"--output",
	"json"
];
const TRUSTED_EXECUTABLE_ENV = "PANTHEON_TRUSTED_BL_EXECUTABLE";
const SAFE_ENV_NAMES = [
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_MESSAGES",
	"TZ"
];
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Parse only the documented Bailian CLI JSON fields for Personal Token Plan. */
function parseAlibabaTokenPlanPercentage(output) {
	try {
		const value = JSON.parse(output);
		if (!isRecord(value)) return void 0;
		if (Object.keys(value).some((key) => !["per1MonthPercentage", "per1MonthResetTime"].includes(key))) return;
		if ("per1MonthResetTime" in value && (typeof value.per1MonthResetTime !== "number" || !Number.isSafeInteger(value.per1MonthResetTime) || value.per1MonthResetTime < 0)) return;
		const percentage = value.per1MonthPercentage;
		return typeof percentage === "number" && Number.isFinite(percentage) && percentage >= 0 && percentage <= 1 ? percentage : void 0;
	} catch {
		return;
	}
}
function safeCliEnvironment(environment) {
	if (typeof environment.HOME !== "string" || environment.HOME.length === 0) return void 0;
	const result = {};
	for (const name of SAFE_ENV_NAMES) {
		const value = environment[name];
		if (typeof value === "string" && value.length <= 4096) result[name] = value;
	}
	return result;
}
async function trustedExecutable(environment) {
	const path = environment[TRUSTED_EXECUTABLE_ENV];
	if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || resolve(path) !== path || basename(path) !== "bl" || process.platform === "win32") return;
	try {
		const resolvedPath = await realpath(path);
		if (resolvedPath !== path) return void 0;
		const root = parse(resolvedPath).root;
		const components = resolvedPath.slice(root.length).split(sep);
		let currentPath = root;
		let executable;
		for (const [index, component] of components.entries()) {
			if (!component) continue;
			currentPath = join(currentPath, component);
			const metadata = await lstat(currentPath);
			if (metadata.isSymbolicLink()) return void 0;
			if (index === components.length - 1) {
				executable = metadata;
				continue;
			}
			if (!metadata.isDirectory()) return void 0;
			const permissions = metadata.mode & 4095;
			const isSticky = (permissions & 512) !== 0;
			if ((permissions & 146) !== 0 && !isSticky) return void 0;
		}
		if (!executable?.isFile() || (Number(executable.mode) & 73) === 0 || (Number(executable.mode) & 146) !== 0) return;
		await access(resolvedPath, constants.X_OK);
		if (await realpath(path) !== resolvedPath) return void 0;
		const verifiedExecutable = await lstat(resolvedPath);
		if (verifiedExecutable.isSymbolicLink() || !verifiedExecutable.isFile() || (Number(verifiedExecutable.mode) & 73) === 0 || (Number(verifiedExecutable.mode) & 146) !== 0) return;
		return resolvedPath;
	} catch {
		return;
	}
}
function isMissingExecutable(error) {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "EACCES";
}
/**
* Run the fixed Bailian command only through an explicitly trusted absolute
* executable path. Credentials remain in the CLI's own login store; Pantheon
* passes no provider secrets or arbitrary arguments.
*/
async function queryAlibabaTokenPlanUsage(signal, spawnProcess = spawn, environment = process.env) {
	if (signal.aborted) return { reason: "provider_error" };
	const env = safeCliEnvironment(environment);
	if (!env?.HOME) return { reason: "cli_identity_unavailable" };
	const executable = await trustedExecutable(environment);
	if (!executable) return { reason: "cli_identity_unavailable" };
	if (signal.aborted) return { reason: "provider_error" };
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnProcess(executable, [...CLI_ARGS], {
				shell: false,
				windowsHide: true,
				cwd: env.HOME,
				env,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
		} catch (error) {
			resolve({ reason: isMissingExecutable(error) ? "cli_identity_unavailable" : "provider_error" });
			return;
		}
		if (!child.stdout || !child.stderr) {
			child.kill();
			resolve({ reason: "provider_error" });
			return;
		}
		let settled = false;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const chunks = [];
		let forceKillTimer;
		const timeout = setTimeout(() => fail("provider_error", true), CLI_TIMEOUT_MS);
		timeout.unref();
		const terminate = () => {
			try {
				child.kill("SIGTERM");
			} catch {}
			forceKillTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, 250);
			forceKillTimer.unref();
		};
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const fail = (reason, kill = false) => {
			if (kill) terminate();
			finish({ reason });
		};
		const onAbort = () => fail("provider_error", true);
		child.stdout.on("data", (chunk) => {
			if (settled) return;
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			stdoutBytes += bytes.byteLength;
			if (stdoutBytes > MAX_STDOUT_BYTES) {
				fail("provider_error", true);
				return;
			}
			chunks.push(bytes);
		});
		child.stderr.on("data", (chunk) => {
			if (settled) return;
			stderrBytes += chunk.byteLength;
			if (stderrBytes > MAX_STDERR_BYTES) fail("provider_error", true);
		});
		child.on("error", (error) => fail(isMissingExecutable(error) ? "cli_identity_unavailable" : "provider_error"));
		child.on("close", (code) => {
			if (forceKillTimer) clearTimeout(forceKillTimer);
			if (settled) return;
			if (code !== 0) {
				fail("provider_error");
				return;
			}
			const percentage = parseAlibabaTokenPlanPercentage(Buffer.concat(chunks).toString("utf8"));
			finish(percentage === void 0 ? { reason: "provider_error" } : { percentage });
		});
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}
//#endregion
export { parseAlibabaTokenPlanPercentage, queryAlibabaTokenPlanUsage };

//# sourceMappingURL=quota-cli.js.map
