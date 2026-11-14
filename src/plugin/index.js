var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/plugin.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync6 } from "node:fs";
import { realpath as realpathAsync } from "node:fs/promises";
import path4 from "node:path";
import { fileURLToPath as fileURLToPath5 } from "node:url";
import { define } from "@opencode-ai/plugin/v2/promise";

// src/pantheon/auto-permissions.ts
var READ_ONLY_AGENTS = /* @__PURE__ */ new Set(["zeus", "athena", "apollo", "gaia"]);
var SAFE_DEV_BINARIES = /* @__PURE__ */ new Set([
  "git",
  "npm",
  "npx",
  "node",
  "python",
  "python3",
  "pytest",
  "ruff",
  "cat",
  "ls",
  "mkdir",
  "cp",
  "mv",
  "touch",
  "grep",
  "find",
  "head",
  "tail",
  "diff",
  "echo",
  "which",
  "tar",
  "zip",
  "unzip",
  "curl",
  "jq",
  "sed",
  "awk",
  "biome",
  "tsc",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "sh",
  "bash",
  "opencode-quota"
]);
function isExcludedReadPath(rawPath) {
  const trimmed = rawPath.trim();
  if (!trimmed) return false;
  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    return true;
  }
  if (/^\/(etc|boot|sys|proc|root)(\/|$)/.test(normalized)) {
    return true;
  }
  if (/(^|\/)(\.git|node_modules)(\/|$)/.test(normalized)) {
    return true;
  }
  return false;
}
function autoPermissionsEnabled(env = process.env) {
  const val = (env.PANTHEON_AUTO_PERMISSIONS ?? "").trim().toLowerCase();
  return val !== "off" && val !== "0" && val !== "false";
}
function isDangerousCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (/\bsudo\b/.test(trimmed)) return true;
  if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--force)\s+(\/\s*$|\/\*\s*$|~\/?\s*$|\$HOME)/.test(
    trimmed
  ))
    return true;
  if (/(curl|wget)\b.*\|\s*(ba)?sh\b/.test(trimmed)) return true;
  if (/\bmkfs(\.[a-z0-9]+)?\b/.test(trimmed)) return true;
  if (/\bdd\s+if=/.test(trimmed)) return true;
  if (/\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?777\s+\//.test(trimmed)) return true;
  if (/\b(>\s*|\bcp\b.*|\bmv\b.*)\s+\/(etc|boot|sys|proc|root|usr)(\/|$)/.test(trimmed)) return true;
  return false;
}
function isSafeDevCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (isDangerousCommand(trimmed)) return false;
  const segments = trimmed.split(/[|&;]/);
  for (const rawSeg of segments) {
    const seg = rawSeg.trim();
    if (!seg) continue;
    const tokens = seg.split(/\s+/).filter(Boolean);
    let binary = tokens[0] ?? "";
    let tokenIdx = 0;
    while (binary.includes("=") && tokenIdx < tokens.length - 1) {
      tokenIdx += 1;
      binary = tokens[tokenIdx] ?? "";
    }
    const cleanBinary = binary.replace(/^.*\//, "");
    if (!SAFE_DEV_BINARIES.has(cleanBinary)) {
      return false;
    }
  }
  return true;
}
function isUnconstrainedTestSuite(command) {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|test:all)(\s+--)?\s*$/.test(trimmed)) {
    return true;
  }
  if (/^(python3?\s+-m\s+)?pytest\s*$/.test(trimmed)) {
    return true;
  }
  if (/^(npx\s+)?(vitest|jest)(\s+run)?\s*$/.test(trimmed)) {
    return true;
  }
  if (/^cargo\s+test\s*$/.test(trimmed)) {
    return true;
  }
  return false;
}
function evaluateAutoPermission(event, options = {}) {
  const env = options.env ?? process.env;
  if (!autoPermissionsEnabled(env)) {
    return { decision: "disabled" };
  }
  if (event.effect === "deny") {
    return { decision: "preserve-deny" };
  }
  if (event.effect === "allow") {
    return { decision: "preserve-allow" };
  }
  const action = String(event.action ?? "").toLowerCase().trim();
  const agent = String(event.agent ?? "").toLowerCase().trim();
  if (action === "todowrite" || action === "todoread" || action === "pantheon_deepwork" || action.startsWith("pantheon_")) {
    event.effect = "allow";
    return { decision: "allow", reason: "pantheon-native-tool" };
  }
  if (READ_ONLY_AGENTS.has(agent)) {
    if (["edit", "write", "hashline_edit", "bash", "shell", "execute"].includes(action)) {
      event.effect = "deny";
      event.message = `Pantheon auto-permissions denied: read-only agent '${agent}' cannot execute mutating action '${action}'`;
      return { decision: "deny", reason: "read-only-role-violation" };
    }
  }
  if (["read", "glob", "grep", "webfetch", "question"].includes(action)) {
    const firstResource = Array.isArray(event.resources) && typeof event.resources[0] === "string" ? event.resources[0] : "";
    if (firstResource.startsWith("http://") || firstResource.startsWith("https://")) {
      return { decision: "passthrough" };
    }
    if (firstResource && isExcludedReadPath(firstResource)) {
      event.effect = "deny";
      event.message = `Pantheon auto-permissions denied: reading '${firstResource}' is prohibited (.git and node_modules are excluded)`;
      return { decision: "deny", reason: "excluded-path" };
    }
    event.effect = "allow";
    return { decision: "allow", reason: "safe-read-action" };
  }
  if (action === "bash" || action === "shell" || action === "execute") {
    const rawCmd = Array.isArray(event.resources) && typeof event.resources[0] === "string" ? event.resources[0] : "";
    if (rawCmd) {
      if (isDangerousCommand(rawCmd)) {
        event.effect = "deny";
        event.message = "Pantheon auto-permissions denied: destructive or privilege-escalating command";
        return { decision: "deny", reason: "dangerous-command" };
      }
      if (isUnconstrainedTestSuite(rawCmd)) {
        event.effect = "ask";
        event.message = "Pantheon test-economy: unconstrained test suite detected in dev loop. Use a focused test slice (sub-10s) or provide scope justification.";
        return {
          decision: "unconstrained-suite",
          reason: "unconstrained-test-suite-forbidden-in-dev-loop"
        };
      }
      if (isSafeDevCommand(rawCmd)) {
        event.effect = "allow";
        return { decision: "allow", reason: "safe-dev-command" };
      }
    }
  }
  if (["edit", "write", "hashline_edit"].includes(action)) {
    if (!READ_ONLY_AGENTS.has(agent)) {
      event.effect = "allow";
      return { decision: "allow", reason: "implementer-workspace-edit" };
    }
  }
  return { decision: "passthrough" };
}

// src/pantheon/behavior-overrides.ts
var OVERRIDE_CONTENT_MAX = 8e3;
var OVERRIDE_REASON_MAX = 200;
function validateEntry(id, value, label, errors) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label}: "${id}" must be an object`);
    return;
  }
  const entry = value;
  for (const key of Object.keys(entry)) {
    if (key !== "action" && key !== "content" && key !== "reason") {
      errors.push(`${label}: "${id}" has unknown key "${key}"`);
    }
  }
  if (entry.action !== "disable" && entry.action !== "replace") {
    errors.push(`${label}: "${id}".action must be "disable" or "replace"`);
    return;
  }
  if (entry.action === "replace") {
    const content = entry.content;
    if (typeof content !== "string" || content.length === 0) {
      errors.push(`${label}: "${id}".content is required for action "replace"`);
    } else if (content.length > OVERRIDE_CONTENT_MAX) {
      errors.push(
        `${label}: "${id}".content is ${content.length} chars \u2014 over the ${OVERRIDE_CONTENT_MAX}-char cap`
      );
    }
  }
  if (entry.reason !== void 0 && (typeof entry.reason !== "string" || entry.reason.length > OVERRIDE_REASON_MAX)) {
    errors.push(`${label}: "${id}".reason must be a string of at most ${OVERRIDE_REASON_MAX} chars`);
  }
}
function parseOverridesFile(raw, label = "overrides") {
  const errors = [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { entries: {}, errors: [`${label}: invalid JSON (${error.message})`] };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { entries: {}, errors: [`${label}: top level must be an object`] };
  }
  const entries = {};
  for (const [id, value] of Object.entries(data)) {
    const before = errors.length;
    validateEntry(id, value, label, errors);
    if (errors.length === before && value && typeof value === "object") {
      entries[id] = value;
    }
  }
  return { entries, errors };
}
function mergeOverrides(globalRaw, projectRaw) {
  const errors = [];
  const effective = {};
  if (globalRaw !== void 0) {
    const g = parseOverridesFile(globalRaw, "global overrides");
    errors.push(...g.errors);
    Object.assign(effective, g.entries);
  }
  if (projectRaw !== void 0) {
    const p = parseOverridesFile(projectRaw, "project overrides");
    errors.push(...p.errors);
    Object.assign(effective, p.entries);
  }
  return { entries: effective, errors };
}

// src/pantheon/bounded-read.ts
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
var BOUNDED_READ_TOOL = "pantheon_bounded_read";
var BOUNDED_READ_MAX_CALLS = 2;
var BOUNDED_READ_MAX_FILES = 2;
var BOUNDED_READ_MAX_LINES = 400;
var BOUNDED_READ_MAX_BYTES = 32 * 1024;
var BYTES_PER_CALL = BOUNDED_READ_MAX_BYTES / BOUNDED_READ_MAX_CALLS;
var ORIGIN_TTL_MS = 6e4;
var MAX_SESSIONS = 256;
var READ_CHUNK_BYTES = 1;
var DENIED_COMPONENTS = /* @__PURE__ */ new Set([
  ".aws",
  ".config",
  ".docker",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".ssh",
  ".git",
  "auth",
  "authentication",
  "database",
  "db",
  "global",
  "migration",
  "migrations",
  "schema",
  "schemas",
  "data",
  "dataset",
  "datasets",
  "authorized_keys",
  "credentials",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
  "secrets"
]);
var DENIED_EXTENSIONS = /* @__PURE__ */ new Set([
  ".cer",
  ".crt",
  ".der",
  ".jks",
  ".key",
  ".p12",
  ".p7b",
  ".p7c",
  ".pem",
  ".pfx",
  ".pub",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".sql"
]);
var DENIED_CODE_ROOTS = /* @__PURE__ */ new Set(["src", "test", "tests", "script", "scripts"]);
var DENIED_MEDIA_EXTENSIONS = /* @__PURE__ */ new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
  ".pdf",
  ".mp3",
  ".mp4",
  ".wav",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".a",
  ".class",
  ".dll",
  ".docx",
  ".dylib",
  ".exe",
  ".jar",
  ".odt",
  ".ods",
  ".otf",
  ".o",
  ".pptx",
  ".pyc",
  ".rar",
  ".so",
  ".ttf",
  ".wasm",
  ".woff",
  ".woff2",
  ".xlsx",
  ".xz"
]);
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function originKey(sessionID, messageID, callID) {
  return JSON.stringify([sessionID, messageID, callID]);
}
function budgetKey(sessionID, messageID) {
  return JSON.stringify([sessionID, messageID]);
}
var V2BoundedReadOriginRegistry = class {
  entries = /* @__PURE__ */ new Map();
  capture(rawEvent, now = Date.now()) {
    this.prune(now);
    if (!isRecord(rawEvent) || rawEvent.tool !== BOUNDED_READ_TOOL || !isRecord(rawEvent.input)) {
      return void 0;
    }
    const identity = {
      sessionID: nonEmpty(rawEvent.sessionID),
      messageID: nonEmpty(rawEvent.messageID),
      callID: nonEmpty(rawEvent.id),
      agent: nonEmpty(rawEvent.agent),
      relativePath: validateRelativePath(rawEvent.input.path) ? rawEvent.input.path : void 0
    };
    if (identity.sessionID === void 0 || identity.messageID === void 0 || identity.callID === void 0 || identity.agent !== "zeus" || identity.relativePath === void 0 || this.entries.size >= MAX_SESSIONS) {
      return void 0;
    }
    const origin = {
      sessionID: identity.sessionID,
      messageID: identity.messageID,
      callID: identity.callID,
      agent: identity.agent,
      relativePath: identity.relativePath
    };
    this.entries.set(originKey(origin.sessionID, origin.messageID, origin.callID), {
      ...origin,
      capturedAt: now
    });
    return origin;
  }
  consume(identity, now = Date.now()) {
    this.prune(now);
    const key = originKey(identity.sessionID, identity.messageID, identity.callID);
    const origin = this.entries.get(key);
    this.entries.delete(key);
    if (origin === void 0 || identity.agent !== origin.agent || identity.relativePath !== origin.relativePath) {
      return void 0;
    }
    const { capturedAt: _capturedAt, ...result } = origin;
    return result;
  }
  forget(rawEvent) {
    if (!isRecord(rawEvent)) return;
    const sessionID = nonEmpty(rawEvent.sessionID);
    const messageID = nonEmpty(rawEvent.messageID);
    const callID = nonEmpty(rawEvent.id);
    if (sessionID && messageID && callID) {
      this.entries.delete(originKey(sessionID, messageID, callID));
    }
  }
  clearSession(sessionID) {
    for (const [key, entry] of this.entries) {
      if (entry.sessionID === sessionID) this.entries.delete(key);
    }
  }
  prune(now) {
    for (const [key, entry] of this.entries) {
      if (now - entry.capturedAt > ORIGIN_TTL_MS) this.entries.delete(key);
    }
  }
};
function validateRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) return false;
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || value.includes("\0") || value.includes(":") || value.includes("*") || value.includes("?") || value.includes("[") || value.includes("]") || value.includes("{") || value.includes("}") || value.includes("%") || value.startsWith("~")) {
    return false;
  }
  const components = value.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    return false;
  }
  return components.every(
    (component) => [...component].every((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
  );
}
function parseArgs(input) {
  if (Object.keys(input).some((key) => !["path", "offset", "limit"].includes(key))) return void 0;
  const filePath = input.path;
  const offset = input.offset;
  const limit = input.limit;
  if (!validateRelativePath(filePath) || !Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > BOUNDED_READ_MAX_LINES) {
    return void 0;
  }
  return { path: filePath, offset, limit };
}
function isWithin(root, target) {
  const relative2 = path.relative(root, target);
  return relative2 === "" || !relative2.startsWith(`..${path.sep}`) && relative2 !== ".." && !path.isAbsolute(relative2);
}
function sensitivePath(relativePath) {
  const components = relativePath.split("/").map((component) => component.toLowerCase());
  const leaf = components.at(-1) ?? "";
  const extension = path.extname(leaf);
  return (
    // Code roots are denied for the SAME reason the Zeus read guard denies
    // `read`/`glob`/`grep` on them (issue #264): this tool is root-Zeus-only, so
    // allowing `src/`, `tests/` or `scripts/` here would let the orchestrator
    // read 2×400 lines of source through a first-class tool while the guarded
    // `read` is refused — the documented "Zeus delegates code reads to @apollo"
    // policy would hold only on paper. Docs, config, the memory bank and
    // `.pantheon/` stay readable: that is what this tool exists for.
    DENIED_CODE_ROOTS.has(components[0] ?? "") || components.some(
      (component) => DENIED_COMPONENTS.has(component) || component.startsWith(".env") || /(^|[._-])(auth|authentication|data|dataset|datasets|database|db|schema|schemas|global|migration|migrations)([._-]|$)/.test(
        component
      )
    ) || /(^|[._-])(secret|token|credential|credentials|password|private)([._-]|$)/.test(leaf) || DENIED_EXTENSIONS.has(extension) || DENIED_MEDIA_EXTENSIONS.has(extension)
  );
}
function errorResult(code) {
  return { output: code };
}
function hasParent(session) {
  return Object.hasOwn(session, "parentID");
}
async function readLineWindow(filePath, offset, limit, byteCap) {
  const before = await lstat(filePath);
  if (before.isSymbolicLink()) throw new Error("PATH_DENIED");
  if (!before.isFile() || before.nlink > 1) throw new Error("PATH_DENIED");
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink > 1) {
      throw new Error("CHANGED");
    }
    const chunks = [];
    const inspectedChunks = [];
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    let currentLine = 1;
    let linesRead = 0;
    let selectedBytes = 0;
    let inspectedBytes = 0;
    let currentLineHasBytes = false;
    let intervalComplete = false;
    while (inspectedBytes < byteCap) {
      const size = Math.min(buffer.length, byteCap - inspectedBytes);
      const read = await file.read(buffer, 0, size, position);
      if (read.bytesRead === 0) break;
      position += read.bytesRead;
      inspectedBytes += read.bytesRead;
      inspectedChunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
      let consumed = 0;
      let selectedStart = -1;
      for (; consumed < read.bytesRead; consumed++) {
        const byte = buffer.readUInt8(consumed);
        if (byte === 0 || byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 || byte === 127) {
          throw new Error("PATH_DENIED");
        }
        const selected = currentLine >= offset && currentLine < offset + limit;
        if (selected) {
          if (selectedStart === -1) selectedStart = consumed;
          currentLineHasBytes = true;
        }
        if (byte === 10) {
          if (selected) linesRead += 1;
          currentLine += 1;
          currentLineHasBytes = false;
          if (currentLine >= offset + limit) {
            intervalComplete = true;
            consumed += 1;
            break;
          }
        } else if (!selected && currentLine >= offset && currentLine < offset + limit) {
          currentLineHasBytes = true;
        }
      }
      if (selectedStart !== -1) {
        const selectedEnd = consumed;
        const selectedChunk = Buffer.from(buffer.subarray(selectedStart, selectedEnd));
        selectedBytes += selectedChunk.length;
        if (selectedBytes > byteCap) throw new Error("BUDGET_EXCEEDED");
        chunks.push(selectedChunk);
      }
      if (intervalComplete) break;
      if (read.bytesRead < size) break;
    }
    if (!intervalComplete && currentLineHasBytes && currentLine >= offset && currentLine < offset + limit) {
      linesRead += 1;
    }
    if (!intervalComplete && inspectedBytes === byteCap && currentLine < offset + limit) {
      throw new Error("BUDGET_EXCEEDED");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(inspectedChunks, inspectedBytes)
      );
    } catch {
      throw new Error("PATH_DENIED");
    }
    const bytes = Buffer.concat(chunks, selectedBytes);
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("PATH_DENIED");
    }
    return { content, linesRead, bytes: selectedBytes };
  } finally {
    await file?.close().catch(() => void 0);
  }
}
function createV2BoundedReadTool(dependencies) {
  const origins = new V2BoundedReadOriginRegistry();
  const budgets = /* @__PURE__ */ new Map();
  const reserve = (sessionID, messageID, root, args) => {
    const key = budgetKey(sessionID, messageID);
    let budget = budgets.get(key);
    if (budget === void 0) {
      if (budgets.size >= MAX_SESSIONS) return "UNAVAILABLE";
      budget = {
        sessionID,
        messageID,
        root,
        files: /* @__PURE__ */ new Set(),
        calls: 0,
        lines: 0,
        bytes: 0,
        sealed: false
      };
      budgets.set(key, budget);
    }
    if (budget.root !== root || budget.sealed) return "SCOPE_DENIED";
    if (budget.files.has(args.path)) return "SCOPE_DENIED";
    if (budget.calls + 1 > BOUNDED_READ_MAX_CALLS || budget.files.size + 1 > BOUNDED_READ_MAX_FILES || budget.lines + args.limit > BOUNDED_READ_MAX_LINES || budget.bytes + BYTES_PER_CALL > BOUNDED_READ_MAX_BYTES) {
      budget.sealed = true;
      return "BUDGET_EXCEEDED";
    }
    budget.calls += 1;
    budget.files.add(args.path);
    budget.lines += args.limit;
    budget.bytes += BYTES_PER_CALL;
    return void 0;
  };
  const definition = {
    name: BOUNDED_READ_TOOL,
    description: "Read a small line range from one exact text file inside the current project. Root Zeus only; two files and 400 lines total per assistant message. Denies the code roots Zeus must delegate (src/, tests/, scripts/), recognized sensitive scopes, and known binary/media formats; returns only bounded valid UTF-8 text after secret scanning. No directories or fallback reading.",
    input: {
      type: "object",
      additionalProperties: false,
      required: ["path", "offset", "limit"],
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "Exact relative file path inside the current project; no globs or traversal."
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "First line to return, starting at 1."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: BOUNDED_READ_MAX_LINES,
          description: "Number of lines requested; at most 400 lines total across this turn."
        }
      }
    },
    output: {},
    async execute(rawInput, rawContext) {
      const args = parseArgs(rawInput);
      if (args === void 0) return errorResult("ARGUMENT_INVALID");
      if (!isRecord(rawContext)) return errorResult("BOUND_READ_UNAUTHORIZED");
      const sessionID = nonEmpty(rawContext.sessionID);
      const messageID = nonEmpty(rawContext.messageID);
      const callID = nonEmpty(rawContext.id);
      const agent = nonEmpty(rawContext.agent);
      if (!sessionID || !messageID || !callID || agent !== "zeus") {
        return errorResult("BOUND_READ_UNAUTHORIZED");
      }
      const origin = origins.consume({
        sessionID,
        messageID,
        callID,
        agent,
        relativePath: args.path
      });
      if (origin === void 0) return errorResult("BOUND_READ_UNAUTHORIZED");
      let sessionValue;
      try {
        sessionValue = await dependencies.getSession(sessionID);
      } catch {
        return errorResult("BOUND_READ_UNAUTHORIZED");
      }
      if (!isRecord(sessionValue)) return errorResult("BOUND_READ_UNAUTHORIZED");
      const session = sessionValue;
      if (session.id !== sessionID || hasParent(session) || session.projectID !== dependencies.projectID) {
        return errorResult("BOUND_READ_UNAUTHORIZED");
      }
      const root = path.resolve(dependencies.rootDirectory);
      const target = path.resolve(root, ...args.path.split("/"));
      if (!isWithin(root, target) || sensitivePath(args.path)) return errorResult("PATH_DENIED");
      const reservationError = reserve(sessionID, messageID, root, args);
      if (reservationError !== void 0) return errorResult(reservationError);
      try {
        await dependencies.assertPermission({
          sessionID,
          agent,
          action: "read",
          resources: [target],
          save: [],
          source: { type: "tool", messageID, id: callID }
        });
      } catch {
        return errorResult("TOOL_DENIED");
      }
      const rootInfo = await lstat(root).catch(() => void 0);
      if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return errorResult("PATH_DENIED");
      const components = args.path.split("/");
      let cursor = root;
      for (const [index, component] of components.entries()) {
        cursor = path.join(cursor, component);
        const info = await lstat(cursor).catch(() => void 0);
        if (info === void 0 || info.isSymbolicLink()) return errorResult("PATH_DENIED");
        if (index < components.length - 1 && !info.isDirectory()) return errorResult("PATH_DENIED");
        if (index === components.length - 1 && !info.isFile()) return errorResult("PATH_DENIED");
      }
      const targetReal = await realpath(target).catch(() => void 0);
      if (targetReal === void 0 || !isWithin(root, targetReal)) return errorResult("PATH_DENIED");
      try {
        const result = await readLineWindow(targetReal, args.offset, args.limit, BYTES_PER_CALL);
        const scanDecision = await dependencies.scanContent({
          content: result.content,
          agent,
          sessionID,
          messageID,
          callID
        });
        if (scanDecision !== "allow") {
          return errorResult(scanDecision === "deny" ? "SCOPE_DENIED" : "UNAVAILABLE");
        }
        return {
          output: JSON.stringify({
            path: args.path,
            offset: args.offset,
            linesRead: result.linesRead,
            bytes: result.bytes,
            status: result.linesRead === 0 ? "empty" : "ok",
            content: result.content
          })
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        return errorResult(
          ["CHANGED", "BUDGET_EXCEEDED", "PATH_DENIED"].includes(code) ? code : "UNAVAILABLE"
        );
      }
    }
  };
  return {
    definition,
    origins,
    clearSession(sessionID) {
      for (const [key, budget] of budgets) {
        if (budget.sessionID === sessionID) budgets.delete(key);
      }
      origins.clearSession(sessionID);
    }
  };
}

// src/pantheon/logger.ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
var CONSOLE_METHODS = {
  info: "log",
  warn: "warn",
  error: "error"
};
function formatArg(arg) {
  if (arg instanceof Error) return arg.stack ?? arg.message;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
async function appendToLog(logPath, prefix, args) {
  const body = [prefix, ...args.map(formatArg)].join(" ");
  const stamp = (/* @__PURE__ */ new Date()).toISOString();
  const lines = body.split("\n").map((p) => p.trim()).filter((p) => p !== "").map((p) => `[${stamp}] ${p}`);
  if (lines.length === 0) return;
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${lines.join("\n")}
`, "utf8");
}
function createPantheonLogger(options) {
  const echo = (options.env ?? process.env.PANTHEON_HOOKS_LOG ?? "").trim() !== "";
  const logPath = join(options.logDir ?? process.cwd(), ".pantheon", "logs", "hooks.log");
  const write = (level, message, args) => {
    void appendToLog(logPath, `[${options.module}] ${message}`, args).catch(() => {
    });
    if (echo) {
      const consoleMethod = CONSOLE_METHODS[level];
      console[consoleMethod](`[${options.module}] ${message}`, ...args);
    }
  };
  return {
    info: (message, ...args) => write("info", message, args),
    warn: (message, ...args) => write("warn", message, args),
    error: (message, ...args) => write("error", message, args)
  };
}

// src/pantheon/compaction-context.ts
var log = createPantheonLogger({ module: "pantheon-compaction" });
var PANTHEON_COMPACTION_DIRECTIVE = "preserve these sections verbatim in the summarized context";
async function missionContextBlock(opts) {
  const source = opts.goals;
  if (opts.sessionID === void 0 || source === void 0 || !source.enabled) return void 0;
  let goals;
  try {
    goals = await source.list(opts.sessionID);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`compaction goal context failed for session ${opts.sessionID}: ${reason}`);
    return void 0;
  }
  const active = goals.filter((goal) => goal.status !== "done");
  if (active.length === 0) return void 0;
  const lines = active.map((goal) => `  [${goal.id}] ${goal.objective} \u2014 ${goal.status}`);
  return `<mission_context>
${lines.join("\n")}`;
}
async function todoContextBlock(opts) {
  const source = opts.todos;
  if (opts.sessionID === void 0 || source === void 0 || !source.enabled) return void 0;
  let todos;
  try {
    todos = await source.list(opts.sessionID);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`compaction todo context failed for session ${opts.sessionID}: ${reason}`);
    return void 0;
  }
  const pending = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled");
  if (pending.length === 0) return void 0;
  const lines = pending.map((todo) => {
    const label = todo.content?.trim() || todo.id || "(no description)";
    const id = todo.id !== void 0 && todo.id !== "" ? `[${todo.id}] ` : "";
    return `  ${id}${label} \u2014 ${todo.status}`;
  });
  return `<todo_context>
${lines.join("\n")}`;
}
async function buildCompactionContext(opts = {}) {
  const [mission, todo] = await Promise.all([missionContextBlock(opts), todoContextBlock(opts)]);
  if (mission === void 0 && todo === void 0) return [];
  const blocks = [`<pantheon-context directive>
${PANTHEON_COMPACTION_DIRECTIVE}`];
  if (mission !== void 0) blocks.push(mission);
  if (todo !== void 0) blocks.push(todo);
  return blocks;
}

// src/pantheon/context-pruner.ts
var PRUNE_MARKER = "[pantheon-prune:v1";
var DEFAULT_CONTEXT_PRUNER_CONFIG = {
  enabled: false,
  keepTurns: 4,
  purgeAfterTurns: 2,
  protectedTools: ["subagent", "task", "skill"],
  minSavingsTokens: 200,
  charsPerToken: 4
};
function resolveContextPrunerConfig(options) {
  try {
    const raw = options?.context_pruner;
    if (raw === null || raw === void 0 || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        ...DEFAULT_CONTEXT_PRUNER_CONFIG,
        protectedTools: [...DEFAULT_CONTEXT_PRUNER_CONFIG.protectedTools]
      };
    }
    const obj = raw;
    const num = (value, fallback, min) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
      return Math.max(min, Math.floor(value));
    };
    let protectedTools = [...DEFAULT_CONTEXT_PRUNER_CONFIG.protectedTools];
    if (Array.isArray(obj.protectedTools)) {
      const names = obj.protectedTools.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter((entry) => entry !== "");
      protectedTools = [...new Set(names)];
    }
    return {
      enabled: typeof obj.enabled === "boolean" ? obj.enabled : false,
      keepTurns: num(obj.keepTurns, DEFAULT_CONTEXT_PRUNER_CONFIG.keepTurns, 0),
      purgeAfterTurns: num(obj.purgeAfterTurns, DEFAULT_CONTEXT_PRUNER_CONFIG.purgeAfterTurns, 0),
      protectedTools,
      minSavingsTokens: num(
        obj.minSavingsTokens,
        DEFAULT_CONTEXT_PRUNER_CONFIG.minSavingsTokens,
        0
      ),
      charsPerToken: num(obj.charsPerToken, DEFAULT_CONTEXT_PRUNER_CONFIG.charsPerToken, 1)
    };
  } catch {
    return {
      ...DEFAULT_CONTEXT_PRUNER_CONFIG,
      protectedTools: [...DEFAULT_CONTEXT_PRUNER_CONFIG.protectedTools]
    };
  }
}
var CONTEXT_PRUNER_CONFIG_KEYS = [
  "enabled",
  "keepTurns",
  "purgeAfterTurns",
  "protectedTools",
  "minSavingsTokens",
  "charsPerToken"
];
function describeContextPrunerConfigIssues(options) {
  try {
    const raw = options?.context_pruner;
    if (raw === void 0 || raw === null) return [];
    if (typeof raw !== "object" || Array.isArray(raw)) return ["context_pruner is not an object"];
    const obj = raw;
    const issues = [];
    const accepted = CONTEXT_PRUNER_CONFIG_KEYS;
    for (const key of Object.keys(obj)) {
      if (!accepted.includes(key)) issues.push(`unknown key "${key}"`);
    }
    const numberField = (key, min) => {
      if (!(key in obj)) return;
      const value = obj[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push(`"${key}" must be a number`);
        return;
      }
      if (value < min) issues.push(`"${key}" must be >= ${min}`);
    };
    if ("enabled" in obj && typeof obj.enabled !== "boolean") {
      issues.push('"enabled" must be a boolean');
    }
    numberField("keepTurns", 0);
    numberField("purgeAfterTurns", 0);
    numberField("minSavingsTokens", 0);
    numberField("charsPerToken", 1);
    if ("protectedTools" in obj) {
      const tools = obj.protectedTools;
      if (!Array.isArray(tools) || tools.some((entry) => typeof entry !== "string")) {
        issues.push('"protectedTools" must be an array of strings');
      }
    }
    return issues;
  } catch {
    return ["context_pruner could not be inspected"];
  }
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function jsonLength(value) {
  try {
    const text2 = JSON.stringify(value);
    return typeof text2 === "string" ? text2.length : 0;
  } catch {
    return 0;
  }
}
function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableKey(entry)).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null) ?? "undefined";
}
function markersMatch(value) {
  return typeof value === "string" && value.startsWith(PRUNE_MARKER);
}
function isPrunedResult(part) {
  const result = part.result;
  return isObject(result) && markersMatch(result.value);
}
function isErrorResult(part) {
  return isObject(part.result) && part.result.type === "error";
}
function isPurgedInput(input) {
  return isObject(input) && typeof input[PRUNE_MARKER] === "string";
}
function supersededText(name) {
  return `${PRUNE_MARKER} superseded tool=${name}] Earlier invocation with identical arguments was superseded by a later call; its output was removed.`;
}
function purgedInput(name, id) {
  return { [PRUNE_MARKER]: "args-purged", tool: name, call: id };
}
function assignTurns(roles) {
  const turnOf = new Array(roles.length).fill(0);
  let turn = -1;
  let previousWasUser = false;
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    if (role === "system") {
      turnOf[i] = -1;
      continue;
    }
    if (role === "user") {
      if (!previousWasUser) turn += 1;
      previousWasUser = true;
    } else if (role === "assistant") {
      turn += 1;
      previousWasUser = false;
    } else {
      previousWasUser = false;
      if (turn < 0) turn = 0;
    }
    turnOf[i] = turn;
  }
  return { turnOf, totalTurns: turn + 1 };
}
function collectCalls(messages, roles, protectedTools) {
  const calls = [];
  for (let i = 0; i < messages.length; i++) {
    if (roles[i] !== "assistant") continue;
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      if (!isObject(raw) || raw.type !== "tool-call") continue;
      const id = raw.id;
      const name = raw.name;
      if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "") continue;
      if (protectedTools.has(name)) continue;
      if (!isObject(raw.input) || isPurgedInput(raw.input)) continue;
      calls.push({ messageIndex: i, part: raw, id, name });
    }
  }
  return calls;
}
function findResult(messages, fromIndex, id) {
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    const message = messages[i];
    if (!isObject(message) || message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (let p = 0; p < message.content.length; p++) {
      const raw = message.content[p];
      if (!isObject(raw) || raw.type !== "tool-result") continue;
      if (raw.id !== id) continue;
      return { messageIndex: i, partIndex: p, part: raw };
    }
  }
  return null;
}
function findCallById(messages, id) {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isObject(message) || !Array.isArray(message.content)) continue;
    for (let p = 0; p < message.content.length; p++) {
      const raw = message.content[p];
      if (!isObject(raw) || raw.type !== "tool-call") continue;
      if (raw.id !== id) continue;
      return { messageIndex: i, partIndex: p, part: raw };
    }
  }
  return null;
}
function emptyStats(site, skipReason) {
  return {
    site,
    changed: false,
    messagesTouched: 0,
    partsPruned: 0,
    estimatedCharsSaved: 0,
    estimatedTokensSaved: 0,
    skipReason
  };
}
function pruneMessages(messages, config, site) {
  try {
    if (!Array.isArray(messages)) return emptyStats(site, "not-array");
    if (messages.length === 0) return emptyStats(site, "no-candidates");
    const roles = [];
    for (const message of messages) {
      if (!isObject(message) || !Array.isArray(message.content)) {
        return emptyStats(site, "malformed");
      }
      roles.push(typeof message.role === "string" ? message.role : "");
    }
    const { turnOf, totalTurns } = assignTurns(roles);
    const protectedTools = new Set(config.protectedTools);
    const isProtectedTurn = (index) => turnOf[index] === -1 || turnOf[index] >= totalTurns - config.keepTurns;
    const edits = [];
    const seen = /* @__PURE__ */ new Set();
    const plan = (edit) => {
      const key = `${edit.messageIndex}:${edit.partIndex}:${edit.field}`;
      if (seen.has(key)) return;
      seen.add(key);
      edits.push(edit);
    };
    const groups = /* @__PURE__ */ new Map();
    for (const call of collectCalls(messages, roles, protectedTools)) {
      let key;
      try {
        key = `${call.name}\0${stableKey(call.part.input)}`;
      } catch {
        continue;
      }
      const group = groups.get(key);
      if (group === void 0) groups.set(key, [call]);
      else group.push(call);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const survivor = group[group.length - 1];
      if (survivor === void 0) continue;
      const survivorResult = findResult(messages, survivor.messageIndex + 1, survivor.id);
      if (survivorResult === null) continue;
      if (isPrunedResult(survivorResult.part)) continue;
      if (isErrorResult(survivorResult.part)) continue;
      for (let i = 0; i < group.length - 1; i++) {
        const call = group[i];
        if (call === void 0) continue;
        const result = findResult(messages, call.messageIndex + 1, call.id);
        if (result === null) continue;
        if (isProtectedTurn(result.messageIndex)) continue;
        if (isPrunedResult(result.part)) continue;
        if (isErrorResult(result.part)) continue;
        const next = { type: "text", value: supersededText(call.name) };
        const saved = jsonLength(result.part.result) - jsonLength(next);
        if (saved <= 0) continue;
        plan({
          messageIndex: result.messageIndex,
          partIndex: result.partIndex,
          part: result.part,
          field: "result",
          next,
          charsSaved: saved
        });
      }
    }
    for (let i = 0; i < messages.length; i++) {
      if (roles[i] !== "tool") continue;
      const content = messages[i].content;
      if (!Array.isArray(content)) continue;
      for (const raw of content) {
        if (!isObject(raw) || raw.type !== "tool-result") continue;
        if (!isObject(raw.result) || raw.result.type !== "error") continue;
        const id = raw.id;
        if (typeof id !== "string" || id === "") continue;
        const call = findCallById(messages, id);
        if (call === null) continue;
        const name = typeof call.part.name === "string" ? call.part.name : "";
        if (protectedTools.has(name)) continue;
        if (isProtectedTurn(call.messageIndex)) continue;
        const turnsAfter = totalTurns - 1 - turnOf[call.messageIndex];
        if (turnsAfter < config.purgeAfterTurns) continue;
        if (!isObject(call.part.input) || isPurgedInput(call.part.input)) continue;
        const next = purgedInput(name, id);
        const saved = jsonLength(call.part.input) - jsonLength(next);
        if (saved <= 0) continue;
        plan({
          messageIndex: call.messageIndex,
          partIndex: call.partIndex,
          part: call.part,
          field: "input",
          next,
          charsSaved: saved
        });
      }
    }
    if (edits.length === 0) return emptyStats(site, "no-candidates");
    const charsSaved = edits.reduce((sum, edit) => sum + edit.charsSaved, 0);
    const tokensSaved = Math.ceil(charsSaved / config.charsPerToken);
    if (tokensSaved < config.minSavingsTokens) return emptyStats(site, "below-threshold");
    const touched = /* @__PURE__ */ new Set();
    const applied = [];
    try {
      for (const edit of edits) {
        applied.push({ part: edit.part, field: edit.field, previous: edit.part[edit.field] });
        edit.part[edit.field] = edit.next;
        touched.add(edit.messageIndex);
      }
    } catch {
      for (const write of applied.reverse()) {
        try {
          write.part[write.field] = write.previous;
        } catch {
        }
      }
      return emptyStats(site, "malformed");
    }
    return {
      site,
      changed: true,
      messagesTouched: touched.size,
      partsPruned: edits.length,
      estimatedCharsSaved: charsSaved,
      estimatedTokensSaved: tokensSaved,
      skipReason: null
    };
  } catch {
    return emptyStats(site, "malformed");
  }
}

// src/pantheon/decision-events.ts
var P7_TURN_END_EVENT_TYPE = "session.execution.succeeded";
var DEFAULT_MAX_EVENTS = 1e4;
var TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function emptySummary(overrides = {}) {
  return {
    delivered: 0,
    matched: 0,
    skippedType: 0,
    skippedMissingSession: 0,
    handlerErrors: 0,
    aborted: false,
    failure: null,
    ...overrides
  };
}
function readEventSessionID(envelope) {
  if (!isRecord2(envelope)) return null;
  const data = envelope.data;
  if (!isRecord2(data)) return null;
  const sessionID = data.sessionID;
  if (typeof sessionID !== "string") return null;
  const trimmed = sessionID.trim();
  return trimmed.length > 0 ? trimmed : null;
}
async function consumeDecisionEvents(source, options) {
  const signal = options.signal;
  if (signal.aborted) return emptySummary({ aborted: true });
  const wanted = new Set(options.types.filter((type) => TOKEN.test(type)));
  const maxEvents = options.maxEvents !== void 0 && Number.isInteger(options.maxEvents) && options.maxEvents > 0 ? options.maxEvents : DEFAULT_MAX_EVENTS;
  let stream;
  try {
    stream = source.subscribe({ signal });
  } catch {
    return emptySummary({ failure: "SUBSCRIBE_FAILED" });
  }
  let delivered = 0;
  let matched = 0;
  let skippedType = 0;
  let skippedMissingSession = 0;
  let handlerErrors = 0;
  let aborted = false;
  let failure = null;
  try {
    for await (const envelope of stream) {
      if (signal.aborted) {
        aborted = true;
        break;
      }
      delivered += 1;
      const type = isRecord2(envelope) ? envelope.type : void 0;
      if (typeof type !== "string" || !wanted.has(type)) {
        skippedType += 1;
      } else {
        const sessionID = readEventSessionID(envelope);
        if (sessionID === null) {
          skippedMissingSession += 1;
        } else {
          matched += 1;
          try {
            options.onEvent(Object.freeze({ type, sessionID }));
          } catch {
            handlerErrors += 1;
          }
        }
      }
      if (delivered >= maxEvents) break;
    }
  } catch {
    if (signal.aborted) aborted = true;
    else failure = "STREAM_FAILED";
  }
  return emptySummary({
    delivered,
    matched,
    skippedType,
    skippedMissingSession,
    handlerErrors,
    aborted,
    failure
  });
}

// src/pantheon/decision-shadow.ts
var TOKEN2 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var UNCLONABLE = /* @__PURE__ */ Symbol("unclonable-payload");
function isToken(value) {
  return typeof value === "string" && TOKEN2.test(value);
}
function isolate(payload) {
  try {
    return structuredClone(payload);
  } catch {
    return UNCLONABLE;
  }
}
function deepFreeze(value, seen = /* @__PURE__ */ new WeakSet()) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key], seen);
  }
  Object.freeze(value);
}
function record(point, decision2, reason) {
  return Object.freeze({
    point: isToken(point) ? point : "unknown-point",
    decision: isToken(decision2) ? decision2 : "unavailable",
    effect: "none",
    reason: isToken(reason) ? reason : "invalid_record"
  });
}
function observeShadow(point, payload, decide, sink) {
  const isolated = isolate(payload);
  if (isolated === UNCLONABLE) {
    return record(String(point), "unavailable", "payload_not_clonable");
  }
  deepFreeze(isolated);
  let decision2;
  let reason;
  try {
    const result = decide(isolated);
    if (result !== null && typeof result === "object" && isToken(result.decision) && isToken(result.reason)) {
      decision2 = result.decision;
      reason = result.reason;
    } else {
      decision2 = "unavailable";
      reason = "invalid_decision";
    }
  } catch {
    decision2 = "unavailable";
    reason = "decision_error";
  }
  const shadowRecord = record(String(point), decision2, reason);
  if (sink) {
    try {
      sink(shadowRecord);
    } catch {
    }
  }
  return shadowRecord;
}

// src/pantheon/decision-points/p7-loop.ts
var P7_LOOP_FLAG_ENV = "PANTHEON_P7_LOOP";
var P7_LOOP_SCORE_THRESHOLDS = Object.freeze([2, 4]);
var P7_LOOP_MAX_EXECUTIONS = 12;
var P7_LOOP_POLICY = Object.freeze({
  scoreThresholds: P7_LOOP_SCORE_THRESHOLDS,
  maxExecutions: P7_LOOP_MAX_EXECUTIONS
});
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function p7LoopEnabledFromEnv(env = process.env) {
  const raw = (env[P7_LOOP_FLAG_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "on" || raw === "true";
}
function decisionFor(executionCount) {
  const met = P7_LOOP_SCORE_THRESHOLDS.filter((threshold) => executionCount >= threshold).length;
  return Object.freeze({
    continueLoop: executionCount <= P7_LOOP_MAX_EXECUTIONS ? 1 : 0,
    level: Math.min(3, 1 + met)
  });
}
function noDecision(enabled, sessionID, executionCount, reason) {
  return Object.freeze({
    record: null,
    enabled,
    sessionID,
    executionCount,
    loopDecision: null,
    reason
  });
}
function createP7LoopPoint(options = {}) {
  const enabled = options.enabled === true;
  const executions = /* @__PURE__ */ new Map();
  function recordExecution(sessionID) {
    if (!enabled) return noDecision(false, sessionID, 0, "p7.disabled");
    const executionCount = (executions.get(sessionID) ?? 0) + 1;
    executions.set(sessionID, executionCount);
    const record2 = observeShadow(
      "P7",
      { sessionID, executionCount },
      (isolated) => {
        const count = isRecord3(isolated) && typeof isolated.executionCount === "number" ? isolated.executionCount : 0;
        const decision2 = decisionFor(count);
        return decision2.continueLoop === 1 ? { decision: "loop.continue", reason: "p7.execution.counted" } : { decision: "loop.stop", reason: "p7.execution.exhausted" };
      },
      options.sink
    );
    const contained = record2.decision === "unavailable";
    return Object.freeze({
      record: record2,
      enabled: true,
      sessionID,
      executionCount,
      loopDecision: contained ? null : decisionFor(executionCount),
      reason: record2.reason
    });
  }
  function observe(payload) {
    if (!enabled) return noDecision(false, null, 0, "p7.disabled");
    if (!isRecord3(payload)) return noDecision(true, null, 0, "p7.event.absent");
    if (typeof payload.type !== "string") return noDecision(true, null, 0, "p7.event.absent");
    if (payload.type !== P7_TURN_END_EVENT_TYPE) {
      return noDecision(true, null, 0, "p7.event.unrelated");
    }
    const sessionID = readEventSessionID(payload);
    if (sessionID === null) return noDecision(true, null, 0, "p7.session.absent");
    return recordExecution(sessionID);
  }
  async function subscribe(source, consumeOptions) {
    const consumption = {
      types: [P7_TURN_END_EVENT_TYPE],
      signal: consumeOptions.signal,
      onEvent: (event) => {
        if (event.type !== P7_TURN_END_EVENT_TYPE) return;
        recordExecution(event.sessionID);
      },
      ...consumeOptions.maxEvents === void 0 ? {} : { maxEvents: consumeOptions.maxEvents }
    };
    return consumeDecisionEvents(source, consumption);
  }
  return Object.freeze({
    enabled,
    observe,
    subscribe,
    executionCount(sessionID) {
      return executions.get(sessionID) ?? 0;
    },
    reset(sessionID) {
      executions.delete(sessionID);
    }
  });
}

// src/pantheon/decision-points/p8-guardrail.ts
var P8_GUARDRAIL_FLAG_ENV = "PANTHEON_P8_GUARDRAIL";
var P8_EFFECT_RANK = Object.freeze({ deny: 0, ask: 1, allow: 2 });
var P8_RULES = Object.freeze([
  /** The baseline is not attributable: no printable action token. */
  "p8.rule.action.unusable",
  /** An `allow` that names no session cannot be audited. */
  "p8.rule.allow.unattributed"
]);
var P8_PATH_COVERAGE = Object.freeze([
  { path: "permission.evaluate.delivery", status: "measured", evidence: ["PROBE-F \xA73.1"] },
  { path: "permission.evaluate.payload-shape", status: "measured", evidence: ["PROBE-F \xA73.2"] },
  { path: "permission.evaluate.effect-write", status: "measured", evidence: ["PROBE-F \xA73.4"] },
  { path: "permission.evaluate.ordering", status: "measured", evidence: ["PROBE-F \xA73.3"] },
  { path: "permission.evaluate.existing-deny", status: "measured", evidence: ["PROBE-F \xA73.5"] },
  { path: "permission.evaluate.egress", status: "unmeasured", evidence: ["PROBE-F \xA73.9"] },
  {
    path: "permission.evaluate.unknown-baseline",
    status: "measured",
    evidence: ["PROBE-F \xA73.6"]
  },
  { path: "execute.before.delivery", status: "measured", evidence: ["PROBE-F \xA73.8"] },
  { path: "execute.before.payload-shape", status: "measured", evidence: ["PROBE-F \xA73.8"] },
  { path: "execute.before.throw-to-deny", status: "measured", evidence: ["PROBE-F \xA73.7"] }
]);
var ACTION_TOKEN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
var REASON_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/;
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function p8EffectRank(effect) {
  if (typeof effect !== "string" || !Object.hasOwn(P8_EFFECT_RANK, effect)) return null;
  return P8_EFFECT_RANK[effect];
}
function readEffect(value) {
  const rank = p8EffectRank(value);
  if (rank === null) return null;
  return value;
}
function matchedRules(event, baseline) {
  const record2 = isRecord4(event) ? event : null;
  const matched = [];
  if (typeof record2?.action !== "string" || !ACTION_TOKEN.test(record2.action)) {
    matched.push("p8.rule.action.unusable");
  }
  if (baseline === "allow" && !isNonEmptyString(record2?.sessionID)) {
    matched.push("p8.rule.allow.unattributed");
  }
  return matched;
}
function decision(enabled, outcome, effect, baseline, rules, reason) {
  const token = REASON_TOKEN.test(reason) ? reason : "p8.reason.invalid";
  const narrowed = effect === "deny" && baseline !== null && baseline !== "deny";
  const safeOutcome = narrowed ? "guardrail.narrow" : outcome;
  return Object.freeze({
    enabled,
    decision: safeOutcome,
    effect,
    narrowed,
    rules: Object.freeze([...rules]),
    reason: token
  });
}
function evaluateP8Guardrail(input, options = {}) {
  const enabled = options.enabled === true;
  let baseline;
  try {
    baseline = readEffect(input.baseline);
  } catch {
    baseline = null;
  }
  if (baseline === null) {
    return decision(
      enabled,
      "guardrail.refusal",
      "unavailable",
      null,
      [],
      "p8.baseline.unrecognized"
    );
  }
  if (!enabled) return decision(false, "guardrail.keep", baseline, baseline, [], "p8.disabled");
  if (baseline === "deny") {
    return decision(true, "guardrail.keep", "deny", baseline, [], "p8.baseline.deny");
  }
  let rules;
  try {
    rules = matchedRules(input.event, baseline);
  } catch {
    return decision(true, "guardrail.keep", baseline, baseline, [], "p8.event.unreadable");
  }
  if (rules.length === 0)
    return decision(true, "guardrail.keep", baseline, baseline, [], "p8.rule.none");
  return decision(true, "guardrail.narrow", "deny", baseline, rules, "p8.rule.matched");
}
function effectWriteKind(target) {
  const descriptor = Object.getOwnPropertyDescriptor(target, "effect");
  if (descriptor === void 0 || !Object.hasOwn(descriptor, "value")) return "delegation";
  return descriptor.writable === true ? "writable" : "non-writable";
}
function refusedWrite(enabled, baseline, reason) {
  return Object.freeze({
    ...decision(enabled, "guardrail.keep", baseline ?? "unavailable", baseline, [], reason),
    wrote: false
  });
}
function applyP8ToPermissionEvent(event, options = {}) {
  const enabled = options.enabled === true;
  let baseline = null;
  try {
    baseline = readEffect(isRecord4(event) ? event.effect : void 0);
  } catch {
    baseline = null;
  }
  const evaluated = evaluateP8Guardrail({ baseline, event }, options);
  if (!evaluated.narrowed) return Object.freeze({ ...evaluated, wrote: false });
  try {
    if (!isRecord4(event)) return refusedWrite(enabled, baseline, "p8.write.delegation");
    const kind = effectWriteKind(event);
    if (kind === "delegation") return refusedWrite(enabled, baseline, "p8.write.delegation");
    if (kind === "non-writable") return refusedWrite(enabled, baseline, "p8.write.rejected");
    const assigned = Reflect.set(event, "effect", "deny");
    if (!assigned || event.effect !== "deny") {
      return refusedWrite(enabled, baseline, "p8.write.rejected");
    }
    return Object.freeze({ ...evaluated, wrote: true });
  } catch {
    return refusedWrite(enabled, baseline, "p8.write.rejected");
  }
}
function p8GuardrailEnabledFromEnv(env = process.env) {
  const raw = (env[P8_GUARDRAIL_FLAG_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "on" || raw === "true";
}
function createP8Guardrail(options = {}) {
  const enabled = options.enabled === true;
  return Object.freeze({
    enabled,
    evaluate: (input) => evaluateP8Guardrail(input, { enabled }),
    apply: (event) => applyP8ToPermissionEvent(event, { enabled })
  });
}

// src/pantheon/decision-rank.ts
var TOKEN3 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString2(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isToken2(value) {
  return typeof value === "string" && TOKEN3.test(value);
}
function rankCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    return { ok: false, code: "INVALID_SHAPE", detail: "candidates must be an array" };
  }
  if (candidates.length === 0) {
    return { ok: false, code: "NO_CANDIDATES", detail: "at least one candidate is required" };
  }
  const ids = /* @__PURE__ */ new Set();
  const valid = [];
  for (const candidate of candidates) {
    if (!isRecord5(candidate)) {
      return { ok: false, code: "INVALID_SHAPE", detail: "candidate must be an object" };
    }
    if (!isToken2(candidate.id)) {
      return { ok: false, code: "INVALID_ID", detail: "candidate id must be a short token" };
    }
    if (ids.has(candidate.id)) {
      return { ok: false, code: "DUPLICATE_ID", detail: "candidate ids must be unique" };
    }
    ids.add(candidate.id);
    if (typeof candidate.score !== "number" || !Number.isFinite(candidate.score)) {
      return { ok: false, code: "INVALID_SCORE", detail: "score must be a finite number" };
    }
    if (!isNonEmptyString2(candidate.justification)) {
      return {
        ok: false,
        code: "MISSING_JUSTIFICATION",
        detail: "every candidate needs a justification"
      };
    }
    valid.push({
      id: candidate.id,
      score: candidate.score,
      justification: candidate.justification
    });
  }
  const sorted = [...valid].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const ordered = sorted.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  return { ok: true, ordered: Object.freeze(ordered) };
}

// src/pantheon/decision-points/p9-memory-compaction.ts
var COMPACTION_PRIORITY_THRESHOLDS = Object.freeze([0.5, 0.75]);
var COMPACTION_RETENTION_POLICY = Object.freeze({
  retainAbove: 0,
  priorityThresholds: COMPACTION_PRIORITY_THRESHOLDS
});
function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function ok(value) {
  return { ok: true, value, reason: "" };
}
function fail(reason) {
  return { ok: false, value: null, reason };
}
function isRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isUsableString(value) {
  return typeof value === "string" && value.trim().length > 0 && !hasControlCharacter(value);
}
function readSessionID(payload) {
  const candidate = payload.sessionID;
  if (candidate === void 0 || candidate === null) {
    return fail("compaction.session.absent");
  }
  if (!isUsableString(candidate)) return fail("compaction.session.invalid");
  return ok(candidate.trim());
}
function readSystem(payload) {
  const system = payload.system;
  if (system === void 0 || system === null) return fail("compaction.system.absent");
  if (!Array.isArray(system)) return fail("compaction.system.unsupported");
  if (system.length === 0) return fail("compaction.system.empty");
  for (const part of system) {
    if (!isRecord6(part) || typeof part.text !== "string") {
      return fail("compaction.system.invalid");
    }
  }
  return ok(system.length);
}
function readCorrelation(input) {
  return isUsableString(input.compactionMessageID) ? input.compactionMessageID.trim() : null;
}
function refusal(reason) {
  return {
    decision: { decision: "refusal", reason },
    sessionID: null,
    systemPartCount: 0,
    memoryDecision: null,
    compactionMessageID: null
  };
}
function applyPolicy(ranked) {
  const retained = ranked.filter(
    (candidate) => candidate.score > COMPACTION_RETENTION_POLICY.retainAbove
  );
  const top = retained[0];
  if (top === void 0) {
    return {
      decision: { decision: "memory.discard", reason: "compaction.memory.discarded" },
      memoryDecision: { retain: 0, priority: null, retainedIds: [] }
    };
  }
  const met = COMPACTION_PRIORITY_THRESHOLDS.filter((threshold) => top.score >= threshold).length;
  const priority = Math.min(3, 1 + met);
  return {
    decision: { decision: "memory.retain", reason: "compaction.memory.retained" },
    memoryDecision: {
      retain: 1,
      priority,
      retainedIds: retained.map((candidate) => candidate.id)
    }
  };
}
function analyze(input) {
  if (!isRecord6(input) || !isRecord6(input.payload)) {
    return refusal("compaction.payload.absent");
  }
  const payload = input.payload;
  const session = readSessionID(payload);
  if (!session.ok || session.value === null) {
    return refusal(session.reason || "compaction.session.absent");
  }
  const sessionID = session.value;
  const correlation = readCorrelation(input);
  const system = readSystem(payload);
  if (!system.ok || system.value === null) {
    return {
      decision: { decision: "refusal", reason: system.reason },
      sessionID,
      systemPartCount: 0,
      memoryDecision: null,
      compactionMessageID: correlation
    };
  }
  const candidates = input.candidates;
  if (candidates === void 0 || candidates === null) {
    return {
      decision: { decision: "refusal", reason: "compaction.memory.source.absent" },
      sessionID,
      systemPartCount: system.value,
      memoryDecision: null,
      compactionMessageID: correlation
    };
  }
  if (!Array.isArray(candidates)) {
    return {
      decision: { decision: "refusal", reason: "compaction.memory.source.unsupported" },
      sessionID,
      systemPartCount: system.value,
      memoryDecision: null,
      compactionMessageID: correlation
    };
  }
  if (candidates.length === 0) {
    return {
      decision: { decision: "memory.discard", reason: "compaction.memory.none" },
      sessionID,
      systemPartCount: system.value,
      memoryDecision: { retain: 0, priority: null, retainedIds: [] },
      compactionMessageID: correlation
    };
  }
  const ranked = rankCandidates(candidates);
  if (!ranked.ok) {
    return {
      decision: {
        decision: "refusal",
        reason: `memory.rank.${ranked.code.toLowerCase().split("_").join(".")}`
      },
      sessionID,
      systemPartCount: system.value,
      memoryDecision: null,
      compactionMessageID: correlation
    };
  }
  const applied = applyPolicy(ranked.ordered);
  return {
    decision: applied.decision,
    sessionID,
    systemPartCount: system.value,
    memoryDecision: applied.memoryDecision,
    compactionMessageID: correlation
  };
}
function evaluateCompactionMemoryPoint(input, sink) {
  let analysis = refusal("compaction.payload.absent");
  const record2 = observeShadow(
    "P9",
    input,
    (isolated) => {
      analysis = analyze(isolated);
      return analysis.decision;
    },
    sink
  );
  const contained = record2.decision === "unavailable";
  const sessionID = contained ? null : analysis.sessionID;
  return {
    record: record2,
    sessionID,
    decisionKey: sessionID,
    systemPartCount: contained ? 0 : analysis.systemPartCount,
    memoryDecision: contained ? null : analysis.memoryDecision,
    compactionMessageID: contained ? null : analysis.compactionMessageID,
    reason: record2.reason
  };
}

// src/pantheon/decision-contracts.ts
var ASK_CHOICE_MAX_LABELS = 255;
var ASK_SCORE_MIN_LEVELS = 2;
var ASK_SCORE_MAX_LEVELS = 10;
var TOKEN4 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
function isRecord7(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString3(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isToken3(value) {
  return typeof value === "string" && TOKEN4.test(value);
}
function hasControlCharacter2(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function isSingleLineLabel(value) {
  return isNonEmptyString3(value) && !hasControlCharacter2(value);
}
function questionIdOf(candidate) {
  if (isRecord7(candidate) && typeof candidate.id === "string") return candidate.id;
  return "";
}
function validateAsk(candidate) {
  if (!isRecord7(candidate)) {
    return { ok: false, code: "INVALID_SHAPE", detail: "question must be an object" };
  }
  const mode = candidate.mode;
  if (mode !== "noul" && mode !== "choice" && mode !== "score" && mode !== "refusal") {
    return { ok: false, code: "UNKNOWN_MODE", detail: "unrecognized ask mode" };
  }
  if (!isToken3(candidate.id)) {
    return { ok: false, code: "MISSING_ID", detail: "id must be a short token" };
  }
  if (!isNonEmptyString3(candidate.text)) {
    return { ok: false, code: "MISSING_TEXT", detail: "text must be non-empty" };
  }
  const id = candidate.id;
  const text2 = candidate.text;
  if (mode === "noul") return { ok: true, question: { mode, id, text: text2 } };
  if (mode === "refusal") return { ok: true, question: { mode, id, text: text2 } };
  if (mode === "score") {
    const levels = candidate.levels;
    if (!Number.isInteger(levels) || levels < ASK_SCORE_MIN_LEVELS || levels > ASK_SCORE_MAX_LEVELS) {
      return {
        ok: false,
        code: "INVALID_LEVELS",
        detail: `levels must be an integer in ${ASK_SCORE_MIN_LEVELS}..${ASK_SCORE_MAX_LEVELS}`
      };
    }
    return { ok: true, question: { mode, id, text: text2, levels } };
  }
  const labels = candidate.labels;
  if (!Array.isArray(labels) || labels.length === 0) {
    return { ok: false, code: "EMPTY_LABELS", detail: "choice needs at least one label" };
  }
  if (labels.length > ASK_CHOICE_MAX_LABELS) {
    return {
      ok: false,
      code: "TOO_MANY_LABELS",
      detail: `choice accepts at most ${ASK_CHOICE_MAX_LABELS} labels`
    };
  }
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const label of labels) {
    if (!isSingleLineLabel(label)) {
      return { ok: false, code: "INVALID_LABEL", detail: "labels must be single-line non-empty" };
    }
    const trimmed = label.trim();
    if (seen.has(trimmed)) {
      return { ok: false, code: "DUPLICATE_LABEL", detail: "labels must be unique" };
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return { ok: true, question: { mode, id, text: text2, labels: normalized } };
}
function evaluateAskAnswer(question, answer) {
  const validation = validateAsk(question);
  if (!validation.ok) {
    return {
      status: "invalid_question",
      questionId: questionIdOf(question),
      reasonCode: validation.code
    };
  }
  const spec = validation.question;
  if (answer === void 0 || answer === null) {
    return { status: "failed", questionId: spec.id, reasonCode: "FAILED_TO_RESPOND" };
  }
  if (!isRecord7(answer) || typeof answer.kind !== "string") {
    return { status: "failed", questionId: spec.id, reasonCode: "INVALID_ANSWER" };
  }
  if (answer.kind === "refusal") {
    return {
      status: "refusal",
      questionId: spec.id,
      reasonCode: spec.mode === "refusal" ? "REFUSAL_MODE" : "ANSWERED_REFUSAL"
    };
  }
  if (spec.mode === "refusal") {
    return { status: "failed", questionId: spec.id, reasonCode: "INVALID_ANSWER" };
  }
  if (spec.mode === "noul") {
    if (answer.kind !== "noul" || answer.value !== 0 && answer.value !== 1) {
      return { status: "failed", questionId: spec.id, reasonCode: "INVALID_ANSWER" };
    }
    return { status: "noul", questionId: spec.id, value: answer.value };
  }
  if (spec.mode === "choice") {
    if (answer.kind !== "choice" || !Number.isInteger(answer.index)) {
      return { status: "failed", questionId: spec.id, reasonCode: "INVALID_ANSWER" };
    }
    const index = answer.index;
    if (index < 1 || index > spec.labels.length) {
      return { status: "failed", questionId: spec.id, reasonCode: "OUT_OF_RANGE" };
    }
    const label = spec.labels[index - 1];
    if (label === void 0) {
      return { status: "failed", questionId: spec.id, reasonCode: "OUT_OF_RANGE" };
    }
    return { status: "choice", questionId: spec.id, index, label };
  }
  if (answer.kind !== "score" || !Number.isInteger(answer.level)) {
    return { status: "failed", questionId: spec.id, reasonCode: "INVALID_ANSWER" };
  }
  const level = answer.level;
  if (level < 1 || level > spec.levels) {
    return { status: "failed", questionId: spec.id, reasonCode: "OUT_OF_RANGE" };
  }
  return { status: "score", questionId: spec.id, level };
}

// src/pantheon/decision-points/p11-catalog.ts
var DRAFT_MEMBERS = ["list", "get", "namespace", "add", "update", "remove"];
var MAX_LABEL_LENGTH = 120;
function isRecord8(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasControlCharacter3(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function isLabel(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_LABEL_LENGTH && !hasControlCharacter3(value);
}
function fail2(source, reason) {
  return { ok: false, source, ids: [], reason };
}
function readDraft(draft) {
  if (draft === void 0 || draft === null) return fail2("none", "draft.absent");
  if (!isRecord8(draft)) return fail2("none", "draft.shape.unsupported");
  for (const member of DRAFT_MEMBERS) {
    if (typeof draft[member] !== "function") return fail2("none", "draft.shape.unsupported");
  }
  const list = draft.list;
  let listed;
  try {
    listed = list.call(draft);
  } catch {
    return fail2("draft", "draft.list.error");
  }
  if (!Array.isArray(listed)) return fail2("draft", "draft.list.invalid");
  const ids = [];
  for (const entry of listed) {
    if (!isRecord8(entry)) continue;
    const identifier = isLabel(entry.name) ? entry.name : isLabel(entry.id) ? entry.id : void 0;
    if (identifier !== void 0 && !ids.includes(identifier)) ids.push(identifier);
  }
  if (ids.length === 0) return fail2("draft", "draft.entry.unstable");
  return { ok: true, source: "draft", ids: Object.freeze(ids), reason: "draft.listed" };
}
function tokenOf(code) {
  return code.toLowerCase().split("_").join(".");
}
function buildDecision(ids, answer) {
  const validated = validateAsk({
    mode: "choice",
    id: "p11.catalog",
    text: "Select one tool from the measured tool.transform draft.",
    labels: ids
  });
  if (!validated.ok) {
    return {
      decision: { decision: "refusal", reason: `catalog.question.${tokenOf(validated.code)}` },
      question: null,
      selectedToolId: null
    };
  }
  const question = validated.question;
  if (answer === void 0) {
    return {
      decision: { decision: "unavailable", reason: "catalog.no.answer" },
      question,
      selectedToolId: null
    };
  }
  const resolution = evaluateAskAnswer(question, answer);
  if (resolution.status === "choice") {
    return {
      decision: { decision: "choice", reason: "catalog.choice.resolved" },
      question,
      selectedToolId: resolution.label
    };
  }
  if (resolution.status === "refusal") {
    return {
      decision: { decision: "refusal", reason: "catalog.choice.refused" },
      question,
      selectedToolId: null
    };
  }
  return {
    decision: { decision: "refusal", reason: "catalog.choice.failed" },
    question,
    selectedToolId: null
  };
}
function evaluateCatalogPoint(draft, sink, answer) {
  let read;
  try {
    read = readDraft(draft);
  } catch {
    read = fail2("none", "draft.read.error");
  }
  let question = null;
  let selectedToolId = null;
  const record2 = observeShadow(
    "P11",
    { catalogSource: read.source, toolIds: read.ok ? read.ids : [] },
    () => {
      if (!read.ok) return { decision: "refusal", reason: read.reason };
      const decided = buildDecision(read.ids, answer);
      question = decided.question;
      selectedToolId = decided.selectedToolId;
      return decided.decision;
    },
    sink
  );
  const failed = record2.decision === "unavailable" && record2.reason !== "catalog.no.answer";
  return {
    record: record2,
    catalogSource: failed ? "none" : read.source,
    toolIds: failed || !read.ok ? [] : read.ids,
    question: failed ? null : question,
    selectedToolId: failed ? null : selectedToolId,
    reason: record2.reason
  };
}

// src/pantheon/decision-points.ts
var SHADOW = "shadow";
var DECISION_POINT_REGISTRY = Object.freeze([
  Object.freeze({
    id: "P1",
    surface: "agent",
    hostSurface: "session.hook.prompt",
    toolOrHook: "hook",
    hostPoint: "session.hook('prompt')",
    primitives: ["choice"],
    mode: SHADOW,
    status: "premise",
    wired: true,
    evidence: ["F-08"],
    premises: ["PM-06", "PM-07"],
    blockingCondition: "PM-07 open: a host-populated prompt.agents was never observed, so no effect of a prompt mutation on the next turn was measured for P1. C6 itself is closed by PROBE-E and is not the blocker",
    notes: "Measured only as prompt-payload shape (F-08). Populated prompt.agents was never observed."
  }),
  Object.freeze({
    id: "P2",
    surface: "skill",
    hostSurface: "session.hook.prompt",
    toolOrHook: "hook",
    hostPoint: "session.hook('prompt') + filterSkills; catalog source ctx.skill",
    primitives: ["choice", "rank"],
    mode: SHADOW,
    status: "advisory",
    wired: true,
    evidence: ["F-06", "F-08", "F-09", "F-10"],
    premises: ["PRE-02", "PM-06", "PM-07", "PM-13"],
    blockingCondition: "P2b cancelled by measurement: no measured mutation surface reaches project skills (PROBE-E \xA75.1/\xA79), so effective filtering is unreachable and P2 records only",
    unknowns: [
      "other project-skill removal paths were not exercised (PROBE-E \xA77)",
      "mutation inside a child/subagent session is UNKNOWN (PROBE-E \xA77)"
    ],
    notes: "P2 \xE9 no-op emp\xEDrico no caminho default (F-09, PRE-02). P2a resolves the skill source, but the shipped prompt hook passes no `skillsDraft` \u2014 `applyTurnDecisionToPrompt(prompt, decision)` \u2014 so `skillsSource` is only `none` or `prompt` at runtime and the `draft` source (resolveSkillSource) has no production caller. P2b was cancelled, not emulated: skill.transform add/remove changes the next turn only for builtin draft entries; project skills are unreachable (get returns null, remove is ok without effect, an add override is not rendered). P2 never filters and claims no token reduction. PM-13 applies by analogy: an effect announced without an observable artifact is not an effect."
  }),
  Object.freeze({
    id: "P3",
    surface: "complexity",
    hostSurface: "tool.invoke",
    toolOrHook: "tool",
    hostPoint: "ask.score + noul (tool pantheon_local_decision)",
    primitives: ["score", "noul"],
    mode: SHADOW,
    status: "premise",
    wired: true,
    evidence: [],
    premises: ["PM-06", "PM-09"],
    blockingCondition: "PM-09 open: no tool call was measured, so the tool.invoke surface that would carry complexity scoring was never exercised. C6 is closed by PROBE-E and is not the blocker",
    notes: "Complexity classification is contract-only in this phase. Wired at its declared `tool.invoke`: `pantheon_local_decision` execute hands the adapter its own input, whose schema requires `complexity` and `gateStatus`, so the adapter classifies from the payload that reaches it instead of refusing from the prompt hook. PM-09 stays open \u2014 no tool call was ever measured \u2014 so this records a decision only when the tool is invoked and never applies one."
  }),
  Object.freeze({
    id: "P4",
    surface: "memory",
    hostSurface: "session.hook.context",
    toolOrHook: "hook",
    hostPoint: "rank (context \u2192 system)",
    primitives: ["rank"],
    mode: SHADOW,
    status: "measured",
    wired: false,
    evidence: ["F-02", "F-03"],
    premises: ["PM-05"],
    blockingCondition: null,
    notes: "System-array carrier and checkpoint reinjection measured (F-02, F-03); channel exclusivity unproven (PM-05). Unwired: the measured `session.hook('context')` payload carries `sessionID`, `model`, `system` (text parts), `messages`, `options`, `agent` and `tools` \u2014 no candidate list with `id`/`score`/`justification`, which is the adapter's only input. Constructing it there could pass nothing but `undefined` and record `memory.source.absent` on every request, so it stays library code until a measured surface carries the candidates it ranks. Memory TEXT crossing in `system` is the carrier, not a candidate source, and is not read as one."
  }),
  Object.freeze({
    id: "P5",
    surface: "verification",
    hostSurface: "session.hook.execute.after",
    toolOrHook: "hook",
    hostPoint: "verify (execute.after / context)",
    primitives: ["verify"],
    mode: SHADOW,
    status: "premise",
    wired: false,
    evidence: [],
    premises: ["PM-09"],
    blockingCondition: "C8 open: permission.evaluate and execute.before were registered but never fired; no tool call was measured",
    notes: "Verdicts PASS/FAIL/BLOCK; failed_to_respond in mandatory verification is BLOCK. Unwired: the adapter verifies a DECLARED `{ requirements, responses }` pair and no measured surface carries either \u2014 the `execute.after` event is `{ tool, sessionID, agent, messageID, id, input, status, result }`, with no verification declaration and no response map. The surface is additionally unmeasured (PM-09, C8 open: the tool hooks were registered and never fired), so constructing it there would record `themis.requirements.absent` on every call instead of a verdict."
  }),
  Object.freeze({
    id: "P6",
    surface: "council",
    hostSurface: "session.hook.prompt",
    toolOrHook: "hook",
    hostPoint: "rank + score (prompt)",
    primitives: ["rank", "score"],
    mode: SHADOW,
    status: "measured",
    wired: false,
    evidence: ["F-08"],
    premises: ["PM-07"],
    blockingCondition: null,
    notes: "Prompt payload shape measured (F-08); populated prompt.agents was never observed (PM-07). Unwired: the prompt surface carries `prompt.agents`/`prompt.skills`, never the `{ id, score, justification }` candidate list this adapter ranks, so constructing it there would only record a permanent `council.source.absent` refusal. No measured surface carries council candidates; it stays library code until one does."
  }),
  Object.freeze({
    id: "P7",
    surface: "loop",
    hostSurface: "event.channel",
    toolOrHook: "hook",
    hostPoint: "session.execution.succeeded \u2014 data.sessionID",
    primitives: ["noul", "score"],
    mode: "migration",
    status: "measured",
    wired: true,
    evidence: ["F-11", "F-12", "F-13", "I-01"],
    premises: [],
    blockingCondition: null,
    trigger: "session.execution.succeeded",
    eventShape: {
      type: "session.execution.succeeded",
      carrier: "data.sessionID",
      forbiddenCarriers: ["properties"]
    },
    unknowns: [
      "session.execution.failed / .interrupted in a child session were never induced (PROBE-D \xA75.1)",
      "nested subagent depth >= 2 was never exercised (PROBE-D \xA75.2)",
      "a background image job was never exercised (PROBE-D \xA75.4)"
    ],
    notes: 'Branch 1 of PLAN \xA75.1 was selected by PROBE-D \xA77 (measured facts summarized in docs/reference/local-decision-router.md): `session.execution.succeeded` is delivered for child sessions with the child copy of `data.sessionID` \u2014 13/13 children (6 foreground, 5 background, 2 with compaction) \u2014 and for background work (PROBE-D \xA74.1\u2013\xA74.2). The event does NOT carry `parentID` (`dataKeys=["sessionID"]`, 44/44): attribution comes from `session.created.parentID` or `ctx.session.get`, never from the succeeded event (PROBE-D \xA74.1). Multiplicity is per EXECUTION, not per turn: 44 `started` = 44 `succeeded` for 46 inbox items; manual compaction adds +1 (C2 = 3), automatic compaction +0 (C1 = 1), a late background notification +1 on the parent (B3/B4/B5 = 2 vs B1/B2 = 1) (PROBE-D \xA74.3). The adapter implements that execution counter (`decision-points/p7-loop.ts`) behind `PANTHEON_P7_LOOP`, OFF by default; cutover is Phase 4b. Effect stays unmeasured (C6 is closed by PROBE-E; no effect of P7 itself was observed): the adapter records `effect: none` and must never be described as working enforcement while the flag is off. The 12-execution cap (`P7_LOOP_MAX_EXECUTIONS`) is ADVISORY: `reset()` is caller-supplied, no measured user-input surface in the probed host provides a signal to call it, and the streak is not claimed to reset on any event. PROBE-D retires the PRE-01/PM-12 blocking premises; the premise register records PM-12 as closed by that measurement.'
  }),
  Object.freeze({
    id: "P8",
    surface: "guardrail",
    hostSurface: "permission.evaluate",
    toolOrHook: "hook",
    hostPoint: "noul (permission.evaluate only; execute.before untouched)",
    primitives: ["noul"],
    mode: "off",
    status: "advisory",
    wired: true,
    evidence: [],
    premises: ["PM-09", "PM-16"],
    blockingCondition: 'Not activatable by measurement (PROBE-F): the two declared rules match none of the 24 measured permission.evaluate payloads \u2014 `action` is always a valid token and the top-level `sessionID` is always present (PROBE-F \xA73.2) \u2014 so with the flag on the outcome is `p8.rule.none` / `guardrail.keep` and nothing is narrowed (PROBE-F \xA76 I-F3, a static evaluation of the rules against the measured shape; the flag was never enabled). The host also treats an unrecognised effect as `ask` and executes after the ask path resolves, so "refuse and keep" does not block (PROBE-F \xA73.6). `permission.evaluate.egress` is unreachable in this host: a tool declaring that permission registers but is never advertised to the provider (PROBE-F \xA73.9). Activation is not waiting on review \u2014 as declared, the rule set narrows nothing on this host',
    securityInvariant: "execute.before remains the only hard barrier. No adapter may allow what that barrier denies. A throw in permission.evaluate does not deny; a throw in execute.before does (PROBE-F \xA73.7).",
    unknowns: [
      "permission.evaluate delivery, payload shape, effect-write honouring, ordering and the existing-deny branch were measured (PROBE-F \xA73.1\u2013\xA73.5); permission.evaluate.egress was NOT (PROBE-F \xA73.9: the action is never advertised to the provider)",
      "accessor/proxy write targets, inherited effect and non-writable own properties are still unproven as host inputs; the write refuses a non-own or accessor descriptor (p8.write.delegation), but the measured host delivered a plain writable data property every time (PROBE-F \xA73.2)",
      "no payload made a declared rule match, so P8 narrowing in a real host was never observed: the flag was never enabled (PROBE-F \xA75.2). The inert verdict comes from the measured payload plus the declared rules, not from a flag-on run"
    ],
    notes: 'Starts off, not shadow. Only permission.evaluate is wired: execute.before is untouched and P8 adds no second barrier there. The Phase 5 review (N1\u2013N8, conditions PH5-1\u2026PH5-5) kept activation blocked; its code findings were repaired without activating the flag: N1 (discarded result / proof before P8), N3 (silent rejection) and N4 (no flag-on test) \u2014 apply() runs before writeProof, so the proof records the post-apply effect (PH5-1); the guardrail outcome is emitted through the 0b telemetry sink carrying the `mode` this entry declares \u2014 `off`, never `active` (N10a); the record is emitted only after the delegation policy has decided and only when a fresh re-read of the event still holds the effect it describes (N10b, N9); the write refuses accessor and non-own descriptors with p8.write.delegation (PH5-2). PH5-3 and PH5-4 are the flag-on integration test and the documentation of the flag and its blast radius. C8 was then settled by measurement, not by review: PROBE-F delivered 24 real permission.evaluate events, measured the payload (`["sessionID","agent","action","resources","metadata","source","effect"]`, `effect` an own writable data property pre-populated with `allow` or `ask`), the order (`session.tool.called` \u2192 `execute.before` \u2192 `permission.evaluate` \u2192 [`permission.asked`] \u2192 execute), and measured that a written `deny` IS honoured (tool blocked, nothing written). The result is not an eligible guardrail: neither declared rule can match a delivered payload (valid `action` token, `sessionID` always present), the host lets an unrecognised effect resolve as `ask` and proceed, and `permission.evaluate.egress` is unreachable \u2014 so the current rule set narrows nothing and the point is recorded as advisory, not as awaiting review. PM-09 and PM-16 record what C8 was blocked on; PROBE-F measured them for 9 of the 10 paths, so neither is the blocker any more. wired stays true because the plugin still constructs the adapter, and the flag stays OFF (`mode: off`).'
  }),
  Object.freeze({
    id: "P9",
    surface: "compaction",
    hostSurface: "session.hook.compaction",
    toolOrHook: "hook",
    hostPoint: "noul + score (compaction)",
    primitives: ["noul", "score"],
    mode: SHADOW,
    status: "measured",
    wired: true,
    scope: "overflow-unmeasured",
    evidence: ["F-01", "F-02", "F-03", "F-04"],
    premises: ["PM-04", "PM-05"],
    blockingCondition: null,
    unknowns: [
      'reason:"overflow" was not inducible in 6 error shapes (PROBE-G \xA73.2): the host retried and completed, and the one failure-recovery compaction observed was persisted as reason:"auto" \u2014 the carrier that path produces is UNKNOWN',
      "the checkpoint summary/reinjection inside a child session was not exercised (PROBE-G \xA74.6)",
      "the messages channel was never exercised",
      "no measured surface carries the memory candidate list P9 would retain or discard"
    ],
    notes: 'Measured on top-level sessions (top-level sessionID carrier, F-01; system-array text, F-02) and on a child session (PROBE-G \xA73.1: the hook fires 3/3 with the CHILD sessionID at top level, the same 7-key payload, no nested `session`, and `system` as an array of 4 parts \u2014 identical to the top-level shape, so the adapter needs no child-specific branch). Overflow is a different answer: `reason:"overflow"` was NOT inducible in 6 error shapes (400 JSON, text/plain, SSE error, empty body, persistent failure, persistent failure with x-should-retry:false); the host retried and completed in four, and the persistent case compacted with reason:"auto", so the overflow path and its carrier remain unmeasured (PROBE-G \xA73.2/\xA74). Wired at its declared `session.hook(\'compaction\')` in shadow: the handler hands the adapter the event as-is, the adapter reads `payload.sessionID` and the `system` part array and nothing else, and the injected context is unchanged \u2014 the record carries the decision key and `systemPartCount`, and the adapter pushes nothing. A payload whose only id is a nested `session.id` produces NO decision (fail-closed), because the 2.2.5 host never sends `session` at all (F-01). The memory candidate list is an optional caller input and no measured surface carries it, so the wired record states `compaction.memory.source.absent` \u2014 a named refusal, never a retention or priority claim.'
  }),
  Object.freeze({
    id: "P10",
    surface: "claims",
    hostSurface: "session.hook.prompt",
    toolOrHook: "hook",
    hostPoint: "verify (per council member; prompt surface)",
    primitives: ["verify"],
    mode: SHADOW,
    status: "premise",
    wired: false,
    evidence: [],
    premises: [],
    blockingCondition: "Not implemented: per-counselor claims were never designed or measured (DISCOVERY \xA74); no measured surface carries `counsellors[].claims[]`",
    notes: "Explicit verdict per claim; failed_to_respond is BLOCK in mandatory verification. The prompt hook is the only measured council surface (F-08), but that payload carries neither counsellors nor claims, so the point is unwired: constructing it there would record `claims.absent` forever. The declaration records intent and the boundary, not exercised coverage."
  }),
  Object.freeze({
    id: "P11",
    surface: "catalog",
    hostSurface: "tool.transform",
    toolOrHook: "tool",
    hostPoint: "own adapter in tool.transform",
    primitives: ["choice"],
    mode: SHADOW,
    status: "measured",
    wired: true,
    evidence: ["F-05", "F-07"],
    premises: ["PM-06", "PM-08"],
    blockingCondition: null,
    notes: "Host catalog context is ABSENT at every measured point (F-05) and was removed from the design; the adapter uses the tool.transform draft (F-07). Wired inside the `ctx.tool.transform` callback in shadow: it reads the draft the host hands it (`list` plus the six measured members) and calls nothing else, so the only mutation on that draft is Pantheon's own `namespace`/`add`. Shadow has no responder, so the record names the validated `choice` question over the draft ids (`catalog.no.answer`) and never a selection; a draft that is absent or shaped differently fails closed with a reason instead of throwing into admission."
  })
]);

// src/pantheon/decision-heuristic.ts
var TOKEN5 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var DEFAULT_MINIMUM_EVIDENCE = 1;
function isRecord9(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isToken4(value) {
  return typeof value === "string" && TOKEN5.test(value);
}
function refusal2(reasonCode, candidateIds = []) {
  return Object.freeze({
    kind: "refusal",
    reasonCode,
    candidateIds: Object.freeze([...candidateIds].sort())
  });
}
function decideHeuristic(request) {
  if (!isRecord9(request)) return refusal2("INVALID_INPUT");
  const candidates = request.candidates;
  if (!Array.isArray(candidates)) return refusal2("INVALID_INPUT");
  if (candidates.length === 0) return refusal2("NO_CANDIDATES");
  const minimum = request.minimumEvidence ?? DEFAULT_MINIMUM_EVIDENCE;
  if (!Number.isInteger(minimum) || minimum < 1 || minimum > 100) {
    return refusal2("INVALID_INPUT");
  }
  const counts = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    if (!isRecord9(candidate) || !isToken4(candidate.id)) return refusal2("INVALID_INPUT");
    if (counts.has(candidate.id)) return refusal2("INVALID_INPUT");
    const evidence = candidate.evidence;
    if (!Array.isArray(evidence)) return refusal2("INVALID_INPUT");
    const unique = /* @__PURE__ */ new Set();
    for (const id of evidence) {
      if (!isToken4(id)) return refusal2("INVALID_INPUT");
      unique.add(id);
    }
    counts.set(candidate.id, unique.size);
  }
  let best = 0;
  for (const count of counts.values()) {
    if (count > best) best = count;
  }
  const top = [...counts.entries()].filter(([, count]) => count === best).map(([id]) => id);
  if (best < minimum) return refusal2("INSUFFICIENT_EVIDENCE", top);
  if (top.length > 1) return refusal2("TIE", top);
  const [candidateId] = top;
  if (candidateId === void 0) return refusal2("NO_CANDIDATES");
  return Object.freeze({
    kind: "choice",
    candidateId,
    evidenceCount: best,
    reasonCode: "UNIQUE_MAX_EVIDENCE"
  });
}

// scripts/install/decision-router-config.mjs
import { chmodSync, existsSync, lstatSync as lstatSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join2, parse as parse2, resolve as resolve2, sep as sep2 } from "node:path";

// scripts/install/verify.mjs
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
function assertNoSymlinkAncestors(filePath, { includeLeaf = true } = {}) {
  const absolute = resolve(filePath);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  const checked = parts.slice(0, includeLeaf ? parts.length : Math.max(0, parts.length - 1));
  let current = root;
  for (const [index, part] of checked.entries()) {
    current = current ? `${current}${current.endsWith(sep) ? "" : sep}${part}` : part;
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return true;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Path contains a symlink: ${current}`);
    if (index < checked.length - 1 && !info.isDirectory()) {
      throw new Error(`Path ancestor is not a directory: ${current}`);
    }
  }
  return true;
}

// scripts/install/decision-router-config.mjs
var DECISION_ROUTER_CONFIG_SCHEMA_VERSION = 1;
var DECISION_ROUTER_PROVIDERS = Object.freeze(["local", "openai-decisions", "jev", "auto"]);
var DEFAULT_DECISION_ROUTER_CONFIG = Object.freeze({
  schema_version: DECISION_ROUTER_CONFIG_SCHEMA_VERSION,
  provider: "local",
  egress_consent: false
});
var DECISION_ROUTER_MODELS = Object.freeze({
  "openai-decisions": Object.freeze(["gpt-6-luna"]),
  "typesafe-jev": Object.freeze(["jev-1.14.0"]),
  "opencode-console-jev": Object.freeze(["jev-1.13"]),
  // Host-embedded decision modules confirmed in the 2.2.5 binary; the model
  // ids are the provider-side decision models (see
  // docs/reference/native-decisions.md for credential acquisition).
  "openrouter-jev": Object.freeze(["typesafe/jev-1.13"]),
  "vercel-gateway-jev": Object.freeze(["typesafe-ai/jev"]),
  "cloudflare-workers-jev": Object.freeze(["clef"])
});
var DECISION_PROVIDER_BUDGET_MAPPING = Object.freeze({
  "openai-decisions": "openai-decisions",
  "typesafe-jev": "typesafe-jev",
  "opencode-console-jev": "opencode-console",
  "openrouter-jev": "openrouter",
  "vercel-gateway-jev": "vercel-ai-gateway",
  "cloudflare-workers-jev": "cloudflare-workers-ai"
});
var REMOTELY_ELIGIBLE_DECISION_PROVIDERS = Object.freeze([
  "openai-decisions",
  "typesafe-jev"
]);
var USER_DECISION_ROUTER_CONFIG_SCHEMA_VERSION = 2;
var DEFAULT_USER_DECISION_ROUTER_CONFIG = Object.freeze({
  schema_version: USER_DECISION_ROUTER_CONFIG_SCHEMA_VERSION,
  enabled: false,
  selection: Object.freeze({ mode: "local" }),
  egress_consent: false,
  enabled_candidates: Object.freeze([])
});
var LEGACY_PROVIDER_ALIASES = Object.freeze({ jev: "typesafe-jev" });
var userCandidateProviders = new Set(Object.keys(DECISION_ROUTER_MODELS));
var remotelyEligibleProviders = new Set(REMOTELY_ELIGIBLE_DECISION_PROVIDERS);
var USER_CONFIG_KEYS = [
  "egress_consent",
  "enabled",
  "enabled_candidates",
  "schema_version",
  "selection"
];
var LEGACY_USER_CONFIG_KEYS = [
  "egress_consent",
  "enabled_candidates",
  "schema_version",
  "selection"
];
var ACCEPTED_INSTALL_STATE_PROVIDERS = /* @__PURE__ */ new Set([...DECISION_ROUTER_PROVIDERS, "typesafe-jev"]);
function normalizeDecisionProviderId(provider) {
  if (typeof provider !== "string") return provider;
  return LEGACY_PROVIDER_ALIASES[provider] ?? provider;
}
function resolveUserDecisionRouterConfigPath(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME;
  const home = env.HOME && isAbsolute2(env.HOME) ? env.HOME : homedir();
  const root = xdg && isAbsolute2(xdg) ? xdg : join2(home, ".config");
  return resolve2(root, "pantheon", "decision-router.json");
}
function migrateUserDecisionRouterConfig(value) {
  if (!isPlainObject(value)) return cloneDefaultUserConfig();
  if (value.schema_version === 1) return migrateLegacyUserConfig(value);
  if (value.schema_version !== USER_DECISION_ROUTER_CONFIG_SCHEMA_VERSION) {
    return cloneDefaultUserConfig();
  }
  if (!hasExactKeys(value, USER_CONFIG_KEYS) || typeof value.egress_consent !== "boolean" || typeof value.enabled !== "boolean" || !Array.isArray(value.enabled_candidates)) {
    return cloneDefaultUserConfig();
  }
  const selection = normalizeSelection(value.selection);
  const candidates = normalizeEnabledCandidates(value.enabled_candidates);
  if (selection === null || candidates === null) return cloneDefaultUserConfig();
  return {
    schema_version: USER_DECISION_ROUTER_CONFIG_SCHEMA_VERSION,
    enabled: value.enabled,
    selection,
    egress_consent: selection.mode === "local" ? false : value.egress_consent,
    enabled_candidates: candidates
  };
}
function migrateLegacyUserConfig(value) {
  if (!hasExactKeys(value, LEGACY_USER_CONFIG_KEYS) || typeof value.egress_consent !== "boolean" || !Array.isArray(value.enabled_candidates)) {
    return cloneDefaultUserConfig();
  }
  const selection = normalizeSelection(value.selection);
  const candidates = normalizeEnabledCandidates(value.enabled_candidates);
  if (selection === null || candidates === null) return cloneDefaultUserConfig();
  const egressConsent = selection.mode === "local" ? false : value.egress_consent;
  return {
    schema_version: USER_DECISION_ROUTER_CONFIG_SCHEMA_VERSION,
    enabled: selection.mode !== "local" && egressConsent && candidates.length > 0,
    selection,
    egress_consent: egressConsent,
    enabled_candidates: candidates
  };
}
function isUserDecisionRouterEnabled(config) {
  return migrateUserDecisionRouterConfig(config).enabled;
}
function readUserDecisionRouterConfig({ env = process.env } = {}) {
  const filePath = resolveUserDecisionRouterConfigPath(env);
  try {
    assertNoSymlinkAncestors(filePath);
    assertTrustedDirectoryChain(dirname2(filePath), { env });
    const stat2 = lstatSync2(filePath);
    assertPrivatePath(stat2, true);
    const parsed = JSON.parse(readFileSync2(filePath, "utf8"));
    return migrateUserDecisionRouterConfig(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return cloneDefaultUserConfig();
    throw error;
  }
}
function normalizeSelection(value) {
  if (!isPlainObject(value) || typeof value.mode !== "string") return null;
  if (value.mode === "local" || value.mode === "auto") {
    return Object.keys(value).length === 1 ? { mode: value.mode } : null;
  }
  if (value.mode !== "explicit" || Object.keys(value).length !== 3 || !isKnownCandidate({ provider: value.provider, model: value.model })) {
    return null;
  }
  return {
    mode: "explicit",
    provider: normalizeDecisionProviderId(value.provider),
    model: value.model
  };
}
function normalizeEnabledCandidates(value) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const item of value) {
    if (!isKnownCandidate(item) || Object.keys(item).length !== 2) return null;
    const provider = normalizeDecisionProviderId(item.provider);
    const key = candidateKey(provider, item.model);
    if (seen.has(key)) return null;
    seen.add(key);
    result.push({ provider, model: item.model });
  }
  return result;
}
function isKnownCandidate(value) {
  if (!isPlainObject(value) || typeof value.provider !== "string" || typeof value.model !== "string") {
    return false;
  }
  const provider = normalizeDecisionProviderId(value.provider);
  return userCandidateProviders.has(provider) && DECISION_ROUTER_MODELS[provider].includes(value.model);
}
function candidateKey(provider, model) {
  return `${provider}/${model}`;
}
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function cloneDefaultUserConfig() {
  return {
    schema_version: DEFAULT_USER_DECISION_ROUTER_CONFIG.schema_version,
    enabled: false,
    selection: { mode: "local" },
    egress_consent: false,
    enabled_candidates: []
  };
}
function assertPrivatePath(stat2, isFile) {
  if (stat2.isSymbolicLink() || (isFile ? !stat2.isFile() : !stat2.isDirectory())) {
    throw new Error("Decision-router configuration path is not a regular private path");
  }
  if (typeof process.getuid !== "function" || stat2.uid !== process.getuid()) {
    throw new Error("Decision-router configuration must be owned by the current user");
  }
  if ((stat2.mode & 63) !== 0)
    throw new Error("Decision-router configuration permissions must be private");
}
function isPermittedGroupWritable(_current, env = process.env) {
  if (env.PANTHEON_ALLOW_GROUP_WRITABLE === "1" || env.PANTHEON_ALLOW_GROUP_WRITABLE === "true") {
    return true;
  }
  if (env.JUPYTERHUB_USER || env.JUPYTER_IMAGE || env.JUPYTER_SERVER_ROOT || env.KUBERNETES_SERVICE_HOST || env.container || existsSync("/.dockerenv")) {
    return true;
  }
  return false;
}
function assertTrustedDirectoryChain(directory, { env = process.env } = {}) {
  const absolute = resolve2(directory);
  const root = parse2(absolute).root;
  const parts = absolute.slice(root.length).split(sep2).filter(Boolean);
  let current = root;
  const uid = process.getuid?.();
  if (uid === void 0)
    throw new Error("Decision-router configuration requires user ownership checks");
  for (const part of parts) {
    current = join2(current, part);
    let stat2;
    try {
      stat2 = lstatSync2(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (!stat2.isDirectory() || stat2.isSymbolicLink()) {
      throw new Error("Decision-router configuration path contains a non-directory component");
    }
    const mode = stat2.mode & 4095;
    const isSticky = (mode & 512) !== 0;
    const isSystemOrUser = stat2.uid === uid || stat2.uid === 0 || isSticky && stat2.uid === 65534;
    if (!isSystemOrUser) {
      throw new Error("Decision-router configuration path has an untrusted owner");
    }
    const worldWritable = (mode & 2) !== 0;
    const groupWritable = (mode & 16) !== 0;
    if (worldWritable && !isSticky) {
      throw new Error("Decision-router configuration path is writable by other users");
    }
    if (groupWritable && !isSticky && !isPermittedGroupWritable(current, env)) {
      throw new Error(
        `Decision-router configuration path "${current}" is group-writable (mode ${(mode & 511).toString(8)}). In containers or JupyterHub, set PANTHEON_ALLOW_GROUP_WRITABLE=1 to permit group-writable ancestors, or run: chmod +t "${current}"`
      );
    }
  }
}

// src/pantheon/delegation-policy.ts
var PANTHEON_AGENTS = /* @__PURE__ */ new Set([
  "zeus",
  "athena",
  "apollo",
  "hermes",
  "aphrodite",
  "demeter",
  "themis",
  "prometheus",
  "hephaestus",
  "nyx",
  "gaia",
  "iris",
  "mnemosyne",
  "talos"
]);
var ORIGIN_TTL_MS2 = 6e4;
var MAX_PENDING_ORIGINS = 256;
function originKey2(sessionID, messageID, callID) {
  return JSON.stringify([sessionID, messageID, callID]);
}
function nonEmptyString(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length === 0 ? void 0 : trimmed;
}
var V2SubagentOriginRegistry = class {
  entries = /* @__PURE__ */ new Map();
  capture(rawEvent, now = Date.now()) {
    this.prune(now);
    if (rawEvent === null || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
      return void 0;
    }
    const event = rawEvent;
    if (event.tool !== "subagent" || event.input === null || typeof event.input !== "object") {
      return void 0;
    }
    const input = event.input;
    const sessionID = nonEmptyString(event.sessionID);
    const messageID = nonEmptyString(event.messageID);
    const callID = nonEmptyString(event.id);
    const caller = agentName(event.agent);
    const target = agentName(input.agent);
    if (sessionID === void 0 || messageID === void 0 || callID === void 0 || caller === void 0 || target === void 0 || !PANTHEON_AGENTS.has(target) || this.entries.size >= MAX_PENDING_ORIGINS) {
      return void 0;
    }
    const origin = { sessionID, messageID, callID, caller, target };
    this.entries.set(originKey2(sessionID, messageID, callID), { ...origin, capturedAt: now });
    return origin;
  }
  /** Remove and return the matching origin, so one tool event authorizes once. */
  consume(event, now = Date.now()) {
    this.prune(now);
    const source = event.source;
    if (source?.type !== "tool") return void 0;
    const sessionID = nonEmptyString(event.sessionID);
    const messageID = nonEmptyString(source.messageID);
    const callID = nonEmptyString(source.id);
    if (sessionID === void 0 || messageID === void 0 || callID === void 0) return void 0;
    const key = originKey2(sessionID, messageID, callID);
    const origin = this.entries.get(key);
    this.entries.delete(key);
    if (origin === void 0) return void 0;
    const { capturedAt: _capturedAt, ...result } = origin;
    return result;
  }
  /** Cleanup when a subagent tool exits without reaching permission.evaluate. */
  forget(rawEvent) {
    if (rawEvent === null || typeof rawEvent !== "object" || Array.isArray(rawEvent)) return;
    const event = rawEvent;
    if (event.tool !== "subagent") return;
    const sessionID = nonEmptyString(event.sessionID);
    const messageID = nonEmptyString(event.messageID);
    const callID = nonEmptyString(event.id);
    if (sessionID === void 0 || messageID === void 0 || callID === void 0) return;
    this.entries.delete(originKey2(sessionID, messageID, callID));
  }
  prune(now) {
    for (const [key, origin] of this.entries) {
      if (now - origin.capturedAt > ORIGIN_TTL_MS2) this.entries.delete(key);
    }
  }
};
function agentName(value) {
  if (typeof value !== "string") return void 0;
  const valueNormalized = value.trim().toLowerCase();
  return valueNormalized.length === 0 ? void 0 : valueNormalized;
}
function v2ResourceTarget(resource) {
  if (typeof resource === "string") return agentName(resource);
  if (resource === null || typeof resource !== "object" || Array.isArray(resource)) return void 0;
  return agentName(resource.target);
}
function evaluateV2Delegation(event, session, existingStatus, origin) {
  if (existingStatus === "deny") return "preserve-deny";
  if (!Array.isArray(event.resources) || event.resources.length === 0) return "deny";
  const rawTargets = event.resources.map(v2ResourceTarget);
  if (rawTargets.some((target) => target === void 0)) return "deny";
  const targets = rawTargets.filter((target) => target !== void 0);
  const pantheonTargets = targets.filter((target) => PANTHEON_AGENTS.has(target));
  if (pantheonTargets.length === 0) return "passthrough";
  if (event.action !== "subagent" || targets.length !== 1 || origin === void 0) return "deny";
  const sessionID = typeof event.sessionID === "string" ? event.sessionID : void 0;
  const caller = agentName(origin.caller);
  if (sessionID === void 0 || session === void 0 || session.id !== sessionID || caller === void 0 || origin.sessionID !== sessionID || origin.target !== pantheonTargets[0]) {
    return "deny";
  }
  const source = event.source;
  if (source?.type !== "tool" || source.messageID !== origin.messageID || source.id !== origin.callID) {
    return "deny";
  }
  const eventCaller = agentName(event.agent);
  if (eventCaller !== void 0 && eventCaller !== caller) return "deny";
  if (session.parentID !== void 0 && session.parentID !== null) {
    return "deny";
  }
  const callerMayTarget = (target) => caller === "zeus" || (caller === "athena" || caller === "hermes") && target === "apollo";
  return pantheonTargets.every(callerMayTarget) ? "allow" : "deny";
}

// src/pantheon/pantheon-decision-catalog.ts
var PANTHEON_SKILL_CATALOG = Object.freeze([
  { id: "agent-coordination", description: "Multi-agent orchestration, routing, and delegation." },
  {
    id: "agent-forge",
    description: "Forge a new OpenCode agent on demand \u2014 interview, draft, confirm."
  },
  { id: "artifact-management", description: "Structured artifacts for planned or risky work." },
  { id: "auto-continue", description: "Continue multi-step todos while keeping safety gates." },
  { id: "clonedeps", description: "Clone dependency source locally for inspection." },
  { id: "code-review-checklist", description: "Systematic code review and quality gates." },
  { id: "codemap", description: "Map repository structure before deep reading." },
  { id: "context-compression", description: "Explicit compaction and resumable checkpoints." },
  {
    id: "fast-path-execution",
    description: "Fast-track execution protocol for bounded micro-edits."
  },
  { id: "git-workflow-and-versioning", description: "Atomic commits and versioning workflow." },
  { id: "incremental-implementation", description: "Thin, testable, rollback-safe slices." },
  {
    id: "instruction-forge",
    description: "Write and maintain instructions \u2014 one home per rule, tested triggers."
  },
  { id: "loop-engineering", description: "Controlled iterative refinement cycles." },
  { id: "memory-bank", description: "Memory-bank structure, rules, and maintenance." },
  { id: "reflect", description: "Turn repeated workflow friction into reusable assets." },
  { id: "security-hardening", description: "Security gate: OWASP, secrets, dependencies." },
  { id: "session-goal", description: "Pin the session objective against scope creep." },
  { id: "simplify", description: "Behavior-preserving code simplification." },
  {
    id: "spec-driven-development",
    description: "Spec-first requirements and acceptance criteria."
  },
  {
    id: "tdd-with-agents",
    description: "RED, GREEN, REFACTOR test-driven implementation."
  },
  {
    id: "test-slicing",
    description: "Targeted test execution \u2014 run exact test slice instead of full suite."
  },
  {
    id: "prompt-refinery",
    description: "Refine a vague multi-concern request \u2014 silent adjust, >> full contract."
  },
  { id: "verification-planning", description: "Plan the evidence path before changing code." },
  {
    id: "visual-review-pipeline",
    description: "Automated visual review with screenshots and fixes."
  },
  { id: "worktrees", description: "Isolated git worktrees for parallel or risky work." }
]);
var PANTHEON_AGENT_CATALOG = Object.freeze([
  { id: "zeus", description: "Central orchestrator; never implements." },
  { id: "athena", description: "Plan-only architect and strategic planner." },
  { id: "apollo", description: "Read-only investigation and discovery scout." },
  { id: "hermes", description: "Backend specialist: FastAPI, Python, async." },
  { id: "aphrodite", description: "Frontend specialist: React, TypeScript, WCAG." },
  { id: "demeter", description: "Database specialist: SQLAlchemy, migrations, queries." },
  { id: "themis", description: "Quality and security review gate." },
  {
    id: "prometheus",
    description: "Infrastructure, Docker, CI, model providers and cloud costs."
  },
  { id: "hephaestus", description: "AI pipelines: LangChain, RAG, vector stores." },
  {
    id: "nyx",
    description: "Observability and cost analytics: tracing, per-agent metrics; chaos and fuzz testing."
  },
  { id: "gaia", description: "Remote sensing and geospatial analysis." },
  { id: "iris", description: "GitHub branches, pull requests, issues, releases." },
  { id: "mnemosyne", description: "Memory bank and ADR authoring on request." },
  { id: "talos", description: "Small hotfixes, typos, and CSS fixes." }
]);
var SKILL_IDS = new Set(PANTHEON_SKILL_CATALOG.map((entry) => entry.id));
var AGENT_IDS = new Set(PANTHEON_AGENT_CATALOG.map((entry) => entry.id));
var PANTHEON_SKILL_IDS = SKILL_IDS;
var PANTHEON_AGENT_IDS = AGENT_IDS;
function isPantheonSkillId(value) {
  return typeof value === "string" && SKILL_IDS.has(value);
}

// src/pantheon/permission-globs.ts
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
function matchPermissionRule(rules, agentName2) {
  let matched;
  for (const [pattern, action] of Object.entries(rules)) {
    if (globToRegExp(pattern).test(agentName2)) matched = action;
  }
  return matched;
}
function isAgentAllowed(rules, agentName2) {
  if (rules === void 0 || Object.keys(rules).length === 0) return true;
  return matchPermissionRule(rules, agentName2) === "allow";
}

// src/pantheon/local-decision-agents.ts
var MAX_REQUEST_LENGTH = 2e4;
var CATALOG_ORDER = new Map(PANTHEON_AGENT_CATALOG.map((entry, index) => [entry.id, index]));
var EXPLICIT_DELEGATION_TOKENS = /* @__PURE__ */ new Set([
  "delegate",
  "delegation",
  "delegar",
  "delegacao",
  "handoff",
  "subagent",
  "specialist",
  "especialista",
  "route",
  "routing",
  "parallel",
  "paralelo"
]);
var ACTION_TOKENS = /* @__PURE__ */ new Set([
  "add",
  "audit",
  "build",
  "change",
  "create",
  "debug",
  "design",
  "fix",
  "implement",
  "implementar",
  "investigate",
  "migrate",
  "optimize",
  "plan",
  "planejar",
  "refactor",
  "research",
  "review",
  "revisar",
  "update"
]);
var AGENT_KEYWORDS = Object.freeze({
  athena: ["plan", "planning", "architecture", "architect", "strategy", "spec", "requirements"],
  apollo: ["investigate", "investigation", "research", "discovery", "explore", "find", "search"],
  hermes: ["api", "backend", "fastapi", "python", "endpoint", "async", "server", "pytest"],
  aphrodite: [
    "frontend",
    "react",
    "typescript",
    "css",
    "component",
    "ui",
    "accessibility",
    "wcag",
    "responsive"
  ],
  demeter: ["database", "sql", "schema", "migration", "alembic", "sqlalchemy", "query", "index"],
  themis: ["security", "owasp", "audit", "lint", "coverage", "quality", "vulnerability", "cve"],
  prometheus: ["docker", "ci", "pipeline", "deploy", "infrastructure", "provider", "container"],
  hephaestus: ["langchain", "langgraph", "rag", "vector", "embedding", "llm", "pipeline", "ai"],
  nyx: ["observability", "telemetry", "opentelemetry", "tracing", "metrics", "langsmith", "cost"],
  gaia: ["satellite", "spectral", "sar", "geospatial", "imagery", "remote", "sensing"],
  iris: ["github", "pull", "request", "issue", "branch", "release", "tag", "pr"],
  mnemosyne: ["memory", "adr", "documentation", "knowledge", "persistent"],
  talos: ["typo", "hotfix", "small", "quick", "minor", "css"]
});
function normalize(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function tokenize(value) {
  const tokens = value.match(/[a-z0-9]+(?:[+#.-][a-z0-9]+)*/g) ?? [];
  return new Set(tokens);
}
function hasDelegationSignal(request) {
  if (typeof request !== "string" || request.trim().length === 0) return false;
  if (request.length > MAX_REQUEST_LENGTH) return false;
  const tokens = tokenize(normalize(request));
  for (const token of EXPLICIT_DELEGATION_TOKENS) {
    if (tokens.has(token)) return true;
  }
  if (![...tokens].some((token) => ACTION_TOKENS.has(token))) return false;
  return [...tokens].some(
    (token) => Object.values(AGENT_KEYWORDS).some((keywords) => keywords.includes(token))
  );
}
function listEligibleDecisionAgents(policy) {
  if (policy === void 0 || !PANTHEON_AGENTS.has("zeus")) return [];
  const zeus = policy.agents.zeus;
  if (zeus === void 0) return [];
  return PANTHEON_AGENT_CATALOG.filter(({ id }) => id !== "zeus").filter(({ id }) => {
    const target = policy.agents[id];
    return PANTHEON_AGENT_IDS.has(id) && target?.canReceiveDelegation === true && zeus.canDelegateTo.includes(id) && isAgentAllowed(policy.permissionTask, id);
  }).map(({ id }) => id);
}
function recommendLocalDecisionAgent(request, policy) {
  if (typeof request !== "string" || request.trim().length === 0) {
    return { agent: null, reasonCode: "INVALID_INPUT" };
  }
  if (request.length > MAX_REQUEST_LENGTH) {
    return { agent: null, reasonCode: "INVALID_INPUT" };
  }
  if (policy === void 0) return { agent: null, reasonCode: "POLICY_UNAVAILABLE" };
  if (!hasDelegationSignal(request)) {
    return { agent: null, reasonCode: "NO_DELEGATION_SIGNAL" };
  }
  const eligible = new Set(listEligibleDecisionAgents(policy));
  if (eligible.size === 0) return { agent: null, reasonCode: "NO_ELIGIBLE_CANDIDATE" };
  const tokens = tokenize(normalize(request));
  const scored = [];
  for (const id of eligible) {
    const keywords = AGENT_KEYWORDS[id] ?? [];
    const score = keywords.reduce((total, keyword) => total + (tokens.has(keyword) ? 1 : 0), 0);
    if (score <= 0) continue;
    scored.push({ id, score, order: CATALOG_ORDER.get(id) ?? 0 });
  }
  if (scored.length === 0) return { agent: null, reasonCode: "NO_ELIGIBLE_CANDIDATE" };
  scored.sort((left, right) => right.score - left.score || left.order - right.order);
  const [first, second] = scored;
  if (first === void 0) return { agent: null, reasonCode: "NO_ELIGIBLE_CANDIDATE" };
  if (second !== void 0 && second.score === first.score) {
    return { agent: null, reasonCode: "AMBIGUOUS_CANDIDATE" };
  }
  return { agent: first.id, reasonCode: "RECOMMENDED" };
}

// src/pantheon/local-decision-skills.ts
var MAX_SELECTED_SKILLS = 4;
var MAX_REQUEST_LENGTH2 = 2e4;
var KEYWORDS = Object.freeze({
  "agent-coordination": [
    "agent",
    "agents",
    "delegate",
    "delegation",
    "orchestrate",
    "orchestration",
    "route",
    "routing",
    "subagent"
  ],
  "artifact-management": ["artifact", "artifacts", "planned", "multi-phase", "impl"],
  "auto-continue": ["continue", "continuation", "todo", "todos", "multi-step", "idle"],
  clonedeps: ["clone", "dependency", "dependencies", "internals", "library", "package"],
  "code-review-checklist": ["review", "reviews", "pull request", "feedback", "checklist"],
  codemap: ["codemap", "structure", "codebase", "unfamiliar", "repository", "overview"],
  "context-compression": ["compact", "compaction", "compress", "context", "checkpoint", "resume"],
  "git-workflow-and-versioning": [
    "commit",
    "commits",
    "git",
    "branch",
    "version",
    "release",
    "tag",
    "changelog"
  ],
  "incremental-implementation": [
    "increment",
    "incremental",
    "slice",
    "slices",
    "implement",
    "implementation"
  ],
  "loop-engineering": ["loop", "iterate", "iteration", "refine", "refinement", "cycle"],
  "memory-bank": ["memory", "adr", "adrs", "documentation", "docs", "knowledge"],
  reflect: ["reflect", "reflection", "retro", "retrospective", "friction", "workflow"],
  "security-hardening": [
    "security",
    "secure",
    "owasp",
    "vulnerability",
    "vulnerabilities",
    "secret",
    "secrets",
    "cve",
    "audit"
  ],
  "session-goal": ["goal", "objective", "scope", "alignment", "session"],
  simplify: [
    "simplify",
    "simplification",
    "refactor",
    "complexity",
    "readable",
    "readability",
    "cleanup"
  ],
  "spec-driven-development": [
    "spec",
    "specification",
    "requirements",
    "prd",
    "acceptance",
    "criteria"
  ],
  "tdd-with-agents": ["tdd", "test", "tests", "testing", "pytest", "vitest", "jest", "coverage"],
  "verification-planning": [
    "verification",
    "verify",
    "evidence",
    "validation",
    "validate",
    "reproduce"
  ],
  "visual-review-pipeline": [
    "visual",
    "screenshot",
    "screenshots",
    "ui",
    "ux",
    "accessibility",
    "wcag",
    "playwright",
    "responsive"
  ],
  worktrees: ["worktree", "worktrees", "parallel", "isolation", "isolated"]
});
var MATERIAL_GATE_TOKENS = /* @__PURE__ */ new Set([
  "approval",
  "cutover",
  "gate",
  "irreversible",
  "signoff"
]);
var MATERIAL_GATE_PHRASES = Object.freeze([
  "breaking change",
  "risk assessment",
  "risk review",
  "schema change",
  "sign off"
]);
var MATERIAL_PLANNING_TOKENS = /* @__PURE__ */ new Set([
  "deliverable",
  "deliverables",
  "milestone",
  "milestones",
  "plan",
  "planning",
  "roadmap",
  "rollback"
]);
var MATERIAL_PLANNING_PHRASES = Object.freeze([
  "across phases",
  "break down",
  "design doc",
  "implementation plan",
  "migration plan",
  "rollout plan",
  "work breakdown"
]);
var ARTIFACT_SKILL_ID = "artifact-management";
var CATALOG_ORDER2 = new Map(PANTHEON_SKILL_CATALOG.map((entry, index) => [entry.id, index]));
function normalize2(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function tokenize2(value) {
  const tokens = value.match(/[a-z0-9]+(?:[+#.-][a-z0-9]+)*/g) ?? [];
  return new Set(tokens);
}
function scoreSkill(normalizedRequest, tokens, skillId) {
  const keywords = KEYWORDS[skillId] ?? [];
  let score = 0;
  for (const keyword of keywords) {
    if (keyword.includes(" ")) {
      if (normalizedRequest.includes(keyword)) score += 3;
      continue;
    }
    if (tokens.has(keyword)) score += 2;
  }
  return score;
}
function hasMaterialSignal(normalizedRequest, tokens, signalTokens, signalPhrases) {
  for (const token of signalTokens) {
    if (tokens.has(token)) return true;
  }
  return signalPhrases.some((phrase) => normalizedRequest.includes(phrase));
}
function detectMaterialRequirement(normalizedRequest, tokens) {
  if (hasMaterialSignal(normalizedRequest, tokens, MATERIAL_GATE_TOKENS, MATERIAL_GATE_PHRASES)) {
    return "gate";
  }
  if (hasMaterialSignal(
    normalizedRequest,
    tokens,
    MATERIAL_PLANNING_TOKENS,
    MATERIAL_PLANNING_PHRASES
  )) {
    return "planning";
  }
  return null;
}
function selectPantheonSkills(request, maxSkills = MAX_SELECTED_SKILLS) {
  if (typeof request !== "string" || request.trim().length === 0 || request.length > MAX_REQUEST_LENGTH2 || !Number.isInteger(maxSkills) || maxSkills < 1 || maxSkills > MAX_SELECTED_SKILLS) {
    return { skillIds: [], reasonCode: "INVALID_INPUT", materialRequirement: null };
  }
  const normalizedRequest = normalize2(request);
  const tokens = tokenize2(normalizedRequest);
  const material = detectMaterialRequirement(normalizedRequest, tokens);
  const scored = [];
  for (const skillId of PANTHEON_SKILL_IDS) {
    const score = scoreSkill(normalizedRequest, tokens, skillId);
    if (score <= 0) continue;
    scored.push({ id: skillId, score, order: CATALOG_ORDER2.get(skillId) ?? 0 });
  }
  if (material === null && scored.length === 0) {
    return { skillIds: [], reasonCode: "NO_LOCAL_MATCH", materialRequirement: null };
  }
  scored.sort((left, right) => right.score - left.score || left.order - right.order);
  const ranked = scored.map((entry) => entry.id);
  const ordered = material === null ? ranked : [ARTIFACT_SKILL_ID, ...ranked.filter((id) => id !== ARTIFACT_SKILL_ID)];
  return {
    skillIds: ordered.slice(0, maxSkills),
    reasonCode: material === null ? "SELECTED_BY_KEYWORDS" : "SELECTED_BY_MATERIAL_REQUIREMENT",
    materialRequirement: material
  };
}

// src/pantheon/local-orchestration.ts
import { readFile } from "node:fs/promises";
import { load } from "js-yaml";

// src/pantheon/local-decision-router.ts
var LOCAL_DECISION_ROUTER_POLICY_VERSION = "local-decision-router/v1";
var LOCAL_DECISION_COMPLEXITY_DIMENSIONS = [
  "boundedness",
  "reversibility",
  "dependencies",
  "uncertainty",
  "verification"
];
var ROUTABLE_AGENTS = new Set(
  [...PANTHEON_AGENTS].filter((agent) => agent !== "zeus")
);
var COMPLEXITY_KEYS = [...LOCAL_DECISION_COMPLEXITY_DIMENSIONS].sort();
function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasExactKeys2(value, keys) {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}
function classifyLocalDecisionComplexity(value) {
  if (!isPlainRecord(value) || !hasExactKeys2(value, COMPLEXITY_KEYS)) {
    return { label: "abstain", reasonCode: "INVALID_COMPLEXITY" };
  }
  const scores = LOCAL_DECISION_COMPLEXITY_DIMENSIONS.map((dimension) => value[dimension]);
  if (!scores.every(
    (score) => typeof score === "number" && Number.isInteger(score) && score >= 0 && score <= 2
  )) {
    return { label: "abstain", reasonCode: "INVALID_COMPLEXITY" };
  }
  const label = scores.includes(2) ? "high" : scores.includes(1) ? "medium" : "low";
  return { label, reasonCode: "CLASSIFIED_FROM_STRUCTURED_DIMENSIONS" };
}

// src/pantheon/local-orchestration.ts
var GATE_STATUSES = /* @__PURE__ */ new Set([
  "none",
  "review_required",
  "human_approval_required",
  "unresolved"
]);
var INPUT_KEYS = [
  "candidateAgents",
  "candidateResourceIds",
  "candidateSkillIds",
  "complexity",
  "domain",
  "gateStatus",
  "memorySearchRelevant",
  "schemaVersion"
];
var RESOURCE_IDS = /* @__PURE__ */ new Set(["pantheon://agents", "pantheon://routing", "pantheon://skills"]);
function isRecord10(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function hasUsablePolicy(policy) {
  if (policy === void 0 || !isRecord10(policy.agents) || !isRecord10(policy.permissionTask) || !isRecord10(policy.agents.zeus)) {
    return false;
  }
  const grants = Object.entries(policy.permissionTask);
  return grants.length > 0 && grants.every(([, action]) => action === "allow" || action === "deny") && stringArray(policy.agents.zeus.canDelegateTo) && stringArray(policy.agents.zeus.capabilities);
}
function parsePolicy(raw) {
  if (!isRecord10(raw) || !isRecord10(raw.agents) || !isRecord10(raw.permission)) return void 0;
  const permission = raw.permission.task;
  if (!isRecord10(permission)) return void 0;
  const permissionTask = {};
  for (const [pattern, action] of Object.entries(permission)) {
    if (action !== "allow" && action !== "deny") return void 0;
    permissionTask[pattern] = action;
  }
  if (Object.keys(permissionTask).length === 0) return void 0;
  const agents = {};
  for (const [id, value] of Object.entries(raw.agents)) {
    if (!PANTHEON_AGENTS.has(id) || !isRecord10(value)) continue;
    const canDelegateTo = value.subagent_can_delegate_to === void 0 && value.can_delegate === false ? [] : value.subagent_can_delegate_to;
    if (typeof value.can_receive_delegation !== "boolean" || !stringArray(canDelegateTo) || !stringArray(value.skills) || !stringArray(value.capabilities)) {
      return void 0;
    }
    if (canDelegateTo.some((target) => !PANTHEON_AGENTS.has(target)) || value.skills.some((skill) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill))) {
      return void 0;
    }
    agents[id] = {
      canDelegateTo,
      canReceiveDelegation: value.can_receive_delegation,
      capabilities: value.capabilities,
      skills: value.skills
    };
  }
  if (agents.zeus === void 0) return void 0;
  return { agents, permissionTask };
}
var policyCache;
async function loadLocalDecisionPolicy() {
  if (policyCache === void 0) {
    policyCache = readLocalDecisionPolicy().then(
      (policy) => {
        if (policy === void 0) policyCache = void 0;
        return policy;
      },
      () => {
        policyCache = void 0;
        return void 0;
      }
    );
  }
  return policyCache;
}
async function readLocalDecisionPolicy() {
  try {
    const routingUrl = new URL("../routing.yml", import.meta.url);
    const parsed = load(await readFile(routingUrl, "utf8"));
    return parsePolicy(parsed);
  } catch {
    return void 0;
  }
}
function isValidInput(value) {
  if (!isRecord10(value) || !exactKeys(value, INPUT_KEYS) || value.schemaVersion !== 1) return false;
  if (!stringArray(value.candidateAgents) || value.candidateAgents.length > 14 || !stringArray(value.candidateSkillIds) || value.candidateSkillIds.length > 64 || !stringArray(value.candidateResourceIds) || value.candidateResourceIds.length > 32 || value.domain !== null && typeof value.domain !== "string" || typeof value.memorySearchRelevant !== "boolean" || typeof value.gateStatus !== "string" || !GATE_STATUSES.has(value.gateStatus) || !isRecord10(value.complexity)) {
    return false;
  }
  return exactKeys(value.complexity, LOCAL_DECISION_COMPLEXITY_DIMENSIONS) && classifyLocalDecisionComplexity(value.complexity).label !== "abstain";
}
function abstain(reasonCode, gateStatus = "unresolved", complexity) {
  return {
    schemaVersion: 1,
    policyVersion: LOCAL_DECISION_ROUTER_POLICY_VERSION,
    decision: "abstain",
    reasonCode,
    agent: null,
    skillIds: [],
    resourceIds: [],
    recommendMemorySearch: false,
    gateStatus,
    complexity: classifyLocalDecisionComplexity(complexity),
    action: "advisory_only"
  };
}
function recommendLocalOrchestration(input, callerAgent, policy) {
  try {
    return evaluateLocalOrchestration(input, callerAgent, policy);
  } catch {
    return abstain("INVALID_INPUT");
  }
}
function evaluateLocalOrchestration(input, callerAgent, policy) {
  if (callerAgent !== "zeus") return abstain("CALLER_NOT_ZEUS");
  if (!hasUsablePolicy(policy)) {
    return abstain("POLICY_UNAVAILABLE");
  }
  if (!isValidInput(input)) return abstain("INVALID_INPUT");
  const gateStatus = input.gateStatus;
  const complexity = classifyLocalDecisionComplexity(input.complexity);
  const zeus = policy.agents.zeus;
  if (zeus === void 0) return abstain("POLICY_UNAVAILABLE", gateStatus, input.complexity);
  const eligible = [...new Set(input.candidateAgents)].filter((candidate) => {
    const target = policy.agents[candidate];
    return candidate !== "zeus" && PANTHEON_AGENTS.has(candidate) && target?.canReceiveDelegation === true && zeus.canDelegateTo.includes(candidate) && isAgentAllowed(policy.permissionTask, candidate);
  });
  if (eligible.length === 0) return abstain("NO_ELIGIBLE_CANDIDATE", gateStatus, input.complexity);
  let agent;
  if (input.domain !== null) {
    if (!eligible.includes(input.domain)) {
      return abstain("DOMAIN_NOT_ELIGIBLE", gateStatus, input.complexity);
    }
    agent = input.domain;
  } else if (eligible.length === 1) {
    const [onlyEligible] = eligible;
    if (onlyEligible === void 0) {
      return abstain("NO_ELIGIBLE_CANDIDATE", gateStatus, input.complexity);
    }
    agent = onlyEligible;
  } else {
    return abstain("AMBIGUOUS_CANDIDATE", gateStatus, input.complexity);
  }
  const agentPolicy = policy.agents[agent];
  if (agentPolicy === void 0) return abstain("POLICY_UNAVAILABLE", gateStatus, input.complexity);
  const skillIds = input.candidateSkillIds.filter(
    (skill, index, all) => all.indexOf(skill) === index && agentPolicy.skills.includes(skill)
  );
  const allowedResources = new Set(RESOURCE_IDS);
  for (const skill of skillIds) allowedResources.add(`pantheon://skills/${skill}`);
  if (PANTHEON_AGENTS.has(agent)) allowedResources.add(`pantheon://agents/${agent}`);
  const resourceIds = input.candidateResourceIds.filter(
    (resource, index, all) => all.indexOf(resource) === index && allowedResources.has(resource)
  );
  return {
    schemaVersion: 1,
    policyVersion: LOCAL_DECISION_ROUTER_POLICY_VERSION,
    decision: "recommend",
    reasonCode: "ADVISORY_ROUTE",
    agent,
    skillIds,
    resourceIds,
    recommendMemorySearch: input.memorySearchRelevant && zeus.capabilities.includes("memory_recall"),
    gateStatus,
    complexity,
    action: "advisory_only"
  };
}

// src/pantheon/local-decision-turn.ts
var MAX_REQUEST_LENGTH3 = 2e4;
function inactive(reasonCode) {
  return {
    schemaVersion: 1,
    active: false,
    source: "local",
    skillIds: [],
    agent: null,
    reasonCode,
    refineRecommended: false
  };
}
function readConfig() {
  try {
    return readUserDecisionRouterConfig();
  } catch {
    return void 0;
  }
}
var AGENT_SKILL_FALLBACK = Object.freeze({
  athena: ["spec-driven-development", "verification-planning"],
  apollo: ["codemap"],
  themis: ["code-review-checklist", "security-hardening"],
  hermes: ["incremental-implementation", "tdd-with-agents"],
  aphrodite: ["incremental-implementation", "visual-review-pipeline"],
  demeter: ["incremental-implementation", "tdd-with-agents"],
  prometheus: ["git-workflow-and-versioning"],
  hephaestus: ["tdd-with-agents"],
  nyx: ["auto-continue"],
  gaia: ["auto-continue"],
  iris: ["artifact-management", "git-workflow-and-versioning"],
  mnemosyne: ["memory-bank", "context-compression"],
  talos: ["incremental-implementation"]
});
function localDecisionForTest(request, policy, reasonCode) {
  const selection = selectPantheonSkills(request);
  const agent = hasDelegationSignal(request) ? recommendLocalDecisionAgent(request, policy).agent : null;
  const fallback = agent !== null ? AGENT_SKILL_FALLBACK[agent] : void 0;
  const skillIds = selection.skillIds.length > 0 || fallback === void 0 ? selection.skillIds : [...fallback];
  return {
    schemaVersion: 1,
    active: true,
    source: "local",
    skillIds,
    agent,
    reasonCode,
    refineRecommended: shouldRefine(request)
  };
}
var CONCERN_MARKERS = [
  // EN + PT: fix / improve / redesign / create / refactor / add
  "corrigir",
  "corrija",
  "arrumar",
  "consertar",
  "melhorar",
  "melhora",
  "refatorar",
  "refatora",
  "redesign",
  "redesenhar",
  "criar",
  "crie",
  "adicionar",
  "adicione",
  "implementar",
  "trocar",
  "fix",
  "improve",
  "refactor",
  "redesign",
  "create",
  "add",
  "rewrite",
  "restructure"
];
var CRITERIA_MARKERS = [
  "crit\xE9rio",
  "criterio",
  "crit\xE9rios",
  "acceptance",
  "aceite",
  "testes de aceita\xE7\xE3o",
  "acceptance criteria",
  "done when",
  "pronto quando",
  "definition of done"
];
function shouldRefine(request) {
  if (typeof request !== "string") return false;
  const text2 = request.trim();
  if (text2.length < 24) return false;
  const lowered = text2.toLowerCase();
  if (CRITERIA_MARKERS.some((marker) => lowered.includes(marker))) return false;
  const concerns = CONCERN_MARKERS.filter(
    (marker) => new RegExp(`(^|\\s|[^a-z\xE0-\xFA])${marker}`, "i").test(lowered)
  ).length;
  if (concerns >= 2) return true;
  const clauses = text2.split(/[,;.]|(?:\s[eE]\s)|(?:\sy\s)/).filter((part) => part.trim().length > 8);
  return concerns >= 1 && clauses.length >= 3;
}
async function decideLocalForTurn(input) {
  const request = typeof input.request === "string" ? input.request : "";
  const sessionID = typeof input.sessionID === "string" ? input.sessionID.trim() : "";
  const messageID = typeof input.messageID === "string" ? input.messageID.trim() : "";
  if (request.trim().length === 0 || request.length > MAX_REQUEST_LENGTH3 || sessionID.length === 0 || messageID.length === 0) {
    return inactive("INVALID_INPUT");
  }
  const config = readConfig();
  if (config === void 0 || !isUserDecisionRouterEnabled(config)) return inactive("DISABLED");
  const policy = await loadLocalDecisionPolicy().catch(() => void 0);
  return localDecisionForTest(request, policy, "LOCAL_SELECTION");
}

// src/pantheon/local-decision-prompt.ts
var MARKER_PATTERN = /<!-- pantheon-decision-router:v1\b[^>]*-->/;
var MEASURED_SENTINELS = /* @__PURE__ */ new Set(["undefined", "null"]);
function isMeasuredSentinel(value) {
  return typeof value === "string" && MEASURED_SENTINELS.has(value);
}
function normalizeMeasuredValue(value) {
  if (value === null || value === void 0) return void 0;
  return isMeasuredSentinel(value) ? void 0 : value;
}
function skillIdentifier(value) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const record2 = value;
  for (const candidate of [record2.name, record2.id, record2.slug]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return void 0;
}
function identifiers(list) {
  const ids = [];
  let unstable = false;
  for (const item of list) {
    const identifier = skillIdentifier(item);
    if (identifier === void 0) unstable = true;
    else if (!ids.includes(identifier)) ids.push(identifier);
  }
  return { ids, unstable };
}
function resolveSkillSource(promptSkills2, draftSkills) {
  const promptList = normalizeMeasuredValue(promptSkills2);
  const draftList = normalizeMeasuredValue(draftSkills);
  if (Array.isArray(promptList) && promptList.length > 0) {
    const resolved = identifiers(promptList);
    return {
      skillsSource: "prompt",
      skillIds: resolved.ids,
      reason: resolved.unstable ? "skills.source.unstable" : "skills.source.prompt"
    };
  }
  if (Array.isArray(draftList) && draftList.length > 0) {
    const resolved = identifiers(draftList);
    return {
      skillsSource: "draft",
      skillIds: resolved.ids,
      reason: resolved.unstable ? "skills.source.unstable" : "skills.source.draft"
    };
  }
  return {
    skillsSource: "none",
    skillIds: [],
    reason: Array.isArray(promptList) ? "skills.source.empty" : "skills.source.absent"
  };
}
function narrowSkills(prompt, selection, draftSkills) {
  const resolution = resolveSkillSource(prompt.skills, draftSkills);
  if (selection.length === 0) {
    return {
      skillsFiltered: false,
      skillsSource: resolution.skillsSource,
      reason: "selection.empty"
    };
  }
  if (resolution.skillsSource !== "prompt") {
    return {
      skillsFiltered: false,
      skillsSource: resolution.skillsSource,
      reason: resolution.reason
    };
  }
  if (resolution.skillIds.length === 0) {
    return { skillsFiltered: false, skillsSource: "prompt", reason: "skills.source.unstable" };
  }
  const selected = new Set(selection);
  const kept = prompt.skills.filter((item) => {
    const identifier = skillIdentifier(item);
    return identifier !== void 0 && selected.has(identifier);
  });
  if (kept.length === 0) {
    return { skillsFiltered: false, skillsSource: "prompt", reason: "skills.selection.disjoint" };
  }
  prompt.skills = kept;
  return { skillsFiltered: true, skillsSource: "prompt", reason: "skills.synthetic.narrowed" };
}
function applyTurnDecisionToPrompt(prompt, decision2, skillsDraft) {
  const invalid = {
    markerApplied: false,
    skillsFiltered: false,
    skillsSource: "none",
    reason: "invalid.payload"
  };
  if (prompt === null || typeof prompt !== "object" || Array.isArray(prompt)) return invalid;
  if (decision2 === null || !decision2.active) return { ...invalid, reason: "decision.inactive" };
  const target = prompt;
  const narrowing = narrowSkills(
    target,
    decision2.skillIds.filter((id) => isPantheonSkillId(id)),
    skillsDraft
  );
  return {
    markerApplied: false,
    skillsFiltered: narrowing.skillsFiltered,
    skillsSource: narrowing.skillsSource,
    reason: narrowing.reason
  };
}
function hasDecisionRouterMarker(text2) {
  return typeof text2 === "string" && MARKER_PATTERN.test(text2);
}
async function applyDecisionRouterToPrompt(admission, requestText) {
  const none = (reason) => ({
    markerApplied: false,
    skillsFiltered: false,
    skillsSource: "none",
    reason
  });
  if (admission === null || typeof admission !== "object" || Array.isArray(admission)) {
    return none("invalid.payload");
  }
  const event = admission;
  const prompt = event.prompt;
  if (prompt === null || typeof prompt !== "object" || Array.isArray(prompt)) {
    return none("invalid.payload");
  }
  const promptText = prompt.text;
  if (typeof promptText !== "string" || promptText.trim().length === 0) {
    return none("request.empty");
  }
  const text2 = typeof requestText === "string" && requestText.trim().length > 0 ? requestText : promptText;
  if (hasDecisionRouterMarker(text2)) return none("marker.present");
  try {
    const decision2 = await decideLocalForTurn({
      request: text2,
      sessionID: event.sessionID,
      messageID: event.messageID
    });
    return applyTurnDecisionToPrompt(prompt, decision2);
  } catch {
    return none("invalid.payload");
  }
}

// src/pantheon/decision-points/p1-agent.ts
function isRecord11(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function agentIdentifier(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (!isRecord11(value)) return void 0;
  for (const candidate of [value.name, value.id, value.slug]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return void 0;
}
function promptAgents(admission) {
  if (!isRecord11(admission)) return [];
  const prompt = admission.prompt;
  if (!isRecord11(prompt)) return [];
  const list = normalizeMeasuredValue(prompt.agents);
  if (!Array.isArray(list)) return [];
  const ids = [];
  for (const item of list) {
    const identifier = agentIdentifier(item);
    if (identifier !== void 0 && !ids.includes(identifier)) ids.push(identifier);
  }
  return ids;
}
function tokenOf2(reasonCode) {
  return reasonCode.toLowerCase().split("_").join(".");
}
function evaluateAgentPoint(admission, sink) {
  const agentIds = promptAgents(admission);
  const outcome = decideHeuristic({
    candidates: agentIds.map((id) => ({ id, evidence: [] })),
    minimumEvidence: 1
  });
  const decision2 = {
    decision: outcome.kind === "choice" ? "choice" : "refusal",
    reason: tokenOf2(outcome.reasonCode)
  };
  return {
    record: observeShadow("P1", admission, () => decision2, sink),
    agentSource: agentIds.length > 0 ? "agents" : "none",
    agentIds,
    reason: decision2.reason
  };
}

// src/pantheon/decision-points/p2-skill.ts
function isRecord12(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function promptSkills(admission) {
  if (!isRecord12(admission)) return void 0;
  const prompt = admission.prompt;
  return isRecord12(prompt) ? prompt.skills : void 0;
}
function evaluateSkillPoint(admission, sink, draftSkills) {
  const resolution = resolveSkillSource(promptSkills(admission), draftSkills);
  let rankedSkillIds = [];
  let decision2 = { decision: "refusal", reason: resolution.reason };
  if (resolution.skillIds.length > 0) {
    const ranked = rankCandidates(
      resolution.skillIds.map((id) => ({
        id,
        score: 1,
        justification: `source.${resolution.skillsSource}`
      }))
    );
    if (ranked.ok) {
      rankedSkillIds = ranked.ordered.map((candidate) => candidate.id);
      decision2 = { decision: "rank", reason: `rank.source.${resolution.skillsSource}` };
    }
  }
  const record2 = observeShadow("P2", admission, () => decision2, sink);
  return {
    record: record2,
    skillsSource: resolution.skillsSource,
    reason: decision2.reason,
    rankedSkillIds
  };
}

// src/pantheon/decision-prompt-surface.ts
var PROMPT_SURFACE_POINT_IDS = Object.freeze(["P1", "P2"]);
var PROJECTED_PROMPT_KEYS = ["agents", "skills"];
function isRecord13(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function projectPromptSurfacePayload(admission) {
  if (!isRecord13(admission) || !isRecord13(admission.prompt)) return {};
  const prompt = admission.prompt;
  const projected = {};
  for (const key of PROJECTED_PROMPT_KEYS) {
    if (Object.hasOwn(prompt, key)) projected[key] = prompt[key];
  }
  return Object.freeze({ prompt: Object.freeze(projected) });
}
function observePromptSurface(admission, sink) {
  const payload = projectPromptSurfacePayload(admission);
  const records = [];
  const collect = (record2) => {
    records.push(record2);
    if (sink === void 0) return;
    try {
      sink(record2);
    } catch {
    }
  };
  let skills = {
    skillsSource: "none",
    reason: "decision_error"
  };
  const observers = [
    () => evaluateAgentPoint(payload, collect),
    () => {
      const skillPoint = evaluateSkillPoint(payload, collect);
      skills = { skillsSource: skillPoint.skillsSource, reason: skillPoint.reason };
    }
  ];
  for (const observe of observers) {
    try {
      observe();
    } catch {
    }
  }
  return { records: Object.freeze(records), skills };
}

// src/pantheon/decision-telemetry.ts
var TELEMETRY_SCHEMA_VERSION = 1;
var TELEMETRY_FIELDS = [
  "schemaVersion",
  "point",
  "decision",
  "effect",
  "reason",
  "mode",
  "durationMs",
  "candidateCount"
];
var TOKEN6 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var POINT_ID = /^(?:P(?:[1-9]|1[01])|J[0-9]{1,2})$/;
var TELEMETRY_KEYS = new Set(TELEMETRY_FIELDS);
var MODES = /* @__PURE__ */ new Set(["shadow", "active", "off", "migration"]);
var DURATION_MAX_MS = 6e4;
var CANDIDATE_MAX = 1e4;
function isRecord14(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isToken5(value) {
  return typeof value === "string" && TOKEN6.test(value);
}
function isPointId(value) {
  return typeof value === "string" && POINT_ID.test(value);
}
function rejected(reasonCode, droppedFieldCount) {
  return { ok: false, reasonCode, droppedFieldCount };
}
function sanitizeTelemetry(input) {
  if (!isRecord14(input)) return rejected("INVALID_INPUT", 0);
  let droppedFieldCount = 0;
  const drop = () => {
    droppedFieldCount += 1;
  };
  let point = null;
  let decision2 = null;
  let reason = null;
  let mode = null;
  let durationMs = null;
  let candidateCount = null;
  let effectNotMeasured = false;
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (!TELEMETRY_KEYS.has(key)) {
      drop();
      continue;
    }
    switch (key) {
      case "schemaVersion":
        if (value !== TELEMETRY_SCHEMA_VERSION) drop();
        break;
      case "point":
        if (isPointId(value)) point = value;
        else drop();
        break;
      case "decision":
        if (isToken5(value)) decision2 = value;
        else drop();
        break;
      case "reason":
        if (isToken5(value)) reason = value;
        else drop();
        break;
      case "mode":
        if (typeof value === "string" && MODES.has(value)) {
          mode = value;
        } else {
          drop();
        }
        break;
      case "durationMs":
        if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= DURATION_MAX_MS) {
          durationMs = value;
        } else {
          drop();
        }
        break;
      case "candidateCount":
        if (Number.isInteger(value) && value >= 0 && value <= CANDIDATE_MAX) {
          candidateCount = value;
        } else {
          drop();
        }
        break;
      case "effect":
        if (value === "none") break;
        effectNotMeasured = true;
        drop();
        break;
      default:
        drop();
    }
  }
  if (effectNotMeasured) return rejected("EFFECT_NOT_MEASURED", droppedFieldCount);
  if (point === null || decision2 === null || reason === null) {
    return rejected("MISSING_REQUIRED_FIELD", droppedFieldCount);
  }
  const event = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    point,
    decision: decision2,
    effect: "none",
    reason,
    ...mode !== null ? { mode } : {},
    ...durationMs !== null ? { durationMs } : {},
    ...candidateCount !== null ? { candidateCount } : {}
  };
  return { ok: true, event: Object.freeze(event), droppedFieldCount };
}
function createTelemetrySink(maxEvents = 1e3) {
  if (!Number.isInteger(maxEvents) || maxEvents < 0 || maxEvents > 1e5) {
    throw new RangeError("maxEvents must be an integer in 0..100000");
  }
  const collected = [];
  return {
    emit(input) {
      const result = sanitizeTelemetry(input);
      if (result.ok && collected.length < maxEvents) collected.push(result.event);
      return result;
    },
    events() {
      return Object.freeze([...collected]);
    },
    size() {
      return collected.length;
    }
  };
}

// src/pantheon/delegation-enforce.ts
function normalizeDelegationAgent(agent) {
  if (typeof agent !== "string") return void 0;
  const normalized = agent.trim().toLowerCase();
  return normalized === "" ? void 0 : normalized;
}
function isDelegationAllowed(callerAgent, targetAgent, permissionTask) {
  const caller = normalizeDelegationAgent(callerAgent);
  const target = normalizeDelegationAgent(targetAgent);
  if (caller === void 0 || target === void 0) return false;
  if (permissionTask !== void 0 && !isAgentAllowed(permissionTask, target)) return false;
  if (caller === "zeus") return true;
  return (caller === "athena" || caller === "hermes") && target === "apollo";
}
function targetFromTool(tool2, args) {
  if (args === null || typeof args !== "object") return void 0;
  const record2 = args;
  if (tool2 === "task") {
    return normalizeDelegationAgent(record2.subagent_type ?? record2.subagentType);
  }
  return void 0;
}
var DEFAULT_BLOCKED_TOOLS = /* @__PURE__ */ new Set([
  "edit",
  "write",
  "bash",
  "shell",
  "task",
  "hashline_edit",
  // `pantheon_model` writes active-preset.json in BOTH the project and the
  // global scope, so it is a write surface with the same blast radius as
  // `write`. Read-only agents have no reason to change agent models, and a
  // global override from an investigation-only session is unrecoverable from
  // inside that session. `pantheon_cost` is deliberately absent: it only reads
  // opencode.db.
  "pantheon_model"
]);
var ZEUS_READ_DENY_PATTERNS = [
  /^src\//,
  /^tests?\//,
  /^scripts?\//,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/
];
function normalizeGuardPath(value) {
  let normalized = value.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}
function guardPathCandidates(tool2, args) {
  if (args === null || typeof args !== "object") return [];
  const record2 = args;
  const candidates = [];
  for (const key of ["filePath", "path", "pattern"]) {
    const value = record2[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    candidates.push({ value, target: key !== "pattern" || tool2 === "glob" });
  }
  return candidates;
}
function isDeniedReadPath(candidate, target) {
  const matches = (value) => ZEUS_READ_DENY_PATTERNS.some((pattern) => pattern.test(value));
  const test = (value) => {
    if (matches(value)) return true;
    return target && !value.endsWith("/") && matches(`${value}/`);
  };
  if (test(candidate)) return true;
  if (!candidate.startsWith("/")) return false;
  const segments = candidate.split("/").filter((segment) => segment !== "");
  for (let index = 0; index < segments.length; index++) {
    if (test(segments.slice(index).join("/"))) return true;
  }
  return false;
}
var CODE_FILE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|c|cpp|h|hpp|java|kt|rb|php|swift|cs|scala|vue|svelte)$/i;
function isDeniedGlobPattern(pattern) {
  const normalized = normalizeGuardPath(pattern);
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    return true;
  }
  if (/(^|\/)(\.git|node_modules)(\/|$)/.test(normalized)) {
    return true;
  }
  if (isDeniedReadPath(normalized, true)) {
    return true;
  }
  if (CODE_FILE_EXTENSIONS.test(normalized)) {
    return true;
  }
  return false;
}
function zeusReadGuard(tool2, args, agent, resolvePath) {
  if (agent !== "zeus") return;
  if (tool2 !== "read" && tool2 !== "glob" && tool2 !== "grep") return;
  if (tool2 === "grep") {
    const record2 = args !== null && typeof args === "object" ? args : {};
    const grepPath = record2.path;
    if (typeof grepPath !== "string" || grepPath.trim() === "") {
      throw new Error("Zeus cannot grep without an explicit non-empty path \u2014 delegate to @apollo");
    }
    if (Object.hasOwn(record2, "include")) {
      throw new Error("Zeus cannot use grep include filters \u2014 delegate to @apollo");
    }
  }
  for (const candidate of guardPathCandidates(tool2, args)) {
    const normalized = normalizeGuardPath(candidate.value);
    const deny = () => {
      throw new Error(`Zeus cannot read ${candidate.value} \u2014 delegate to @apollo`);
    };
    if (normalized === "") {
      if (tool2 === "grep" && candidate.target) deny();
      continue;
    }
    if (tool2 === "grep" && candidate.target && normalized === ".") deny();
    const resolution = candidate.target && resolvePath !== void 0 ? resolvePath(candidate.value) : void 0;
    if (resolution?.failed) deny();
    if (tool2 === "grep" && candidate.target && (resolution === void 0 || resolution.isRegularFile !== true || resolution.withinProject !== true)) {
      deny();
    }
    const effectivePath = normalizeGuardPath(resolution?.resolved ?? normalized);
    if (effectivePath === "" || tool2 === "grep" && candidate.target && effectivePath === ".") {
      if (tool2 === "grep" && candidate.target) deny();
      continue;
    }
    if (tool2 === "glob" && candidate.target && isDeniedGlobPattern(effectivePath)) deny();
    if (isDeniedReadPath(effectivePath, candidate.target)) deny();
  }
}
var ReadOnlySessionRegistry = class {
  sessions = /* @__PURE__ */ new Map();
  /** Register a session as read-only. Idempotent (re-registration updates). */
  register(sessionID, entry) {
    const record2 = { agent: entry.agent, registeredAt: Date.now() };
    if (entry.readOnlyFlag !== void 0) record2.readOnlyFlag = entry.readOnlyFlag;
    this.sessions.set(sessionID, record2);
  }
  /** Remove a session from the read-only set (dynamic revocation). */
  unregister(sessionID) {
    this.sessions.delete(sessionID);
  }
  /** Whether the session is registered as read-only. */
  has(sessionID) {
    return this.sessions.has(sessionID);
  }
  /** Snapshot of the registered entry, or undefined. */
  get(sessionID) {
    return this.sessions.get(sessionID);
  }
  /** Snapshot of all read-only session IDs (guards read a stable copy). */
  sessionIDs() {
    return new Set(this.sessions.keys());
  }
  /** Remove every registration (test hygiene / plugin teardown). */
  clear() {
    this.sessions.clear();
  }
};
var readOnlyRegistry = new ReadOnlySessionRegistry();
var READ_ONLY_AGENTS2 = /* @__PURE__ */ new Set(["apollo", "gaia"]);
function syncReadOnlySession(registry, sessionID, agent, readOnlyAgents = READ_ONLY_AGENTS2) {
  const normalized = normalizeDelegationAgent(agent);
  if (normalized === void 0 || !readOnlyAgents.has(normalized)) {
    registry.unregister(sessionID);
    return false;
  }
  registry.register(sessionID, { agent: normalized });
  return true;
}
function createEnforcementGuard(input) {
  const blockedTools = input.options?.blockedTools ?? DEFAULT_BLOCKED_TOOLS;
  const prefix = input.options?.messagePrefix ?? "pantheon delegation guard";
  return async (hook, output) => {
    const isDelegationTool = hook.tool === "task";
    if (isDelegationTool && input.options?.isChildSession?.(hook.sessionID) === true) {
      throw new Error(
        `${prefix}: session ${hook.sessionID} is a child session \u2014 delegation tools are denied to prevent nested delegation`
      );
    }
    if (hook.tool === "task" && input.options?.isRootSession !== void 0 && input.options?.isChildSession?.(hook.sessionID) !== true) {
      const caller = input.options.getSessionAgent?.(hook.sessionID);
      const target = targetFromTool(hook.tool, output?.args);
      if (!input.options.isRootSession(hook.sessionID)) {
        input.options.logger?.warn?.(
          `${prefix}: delegation denied for session ${hook.sessionID} \u2014 not an authorized root session`
        );
        throw new Error(`${prefix}: session ${hook.sessionID} is not an authorized root session`);
      }
      if (!isDelegationAllowed(caller, target, input.options?.permissionTask)) {
        const reason = caller === void 0 ? "caller agent is unavailable" : "agent/target is not allowed";
        input.options.logger?.warn?.(
          `${prefix}: delegation denied for session ${hook.sessionID} \u2014 ${reason}`
        );
        throw new Error(
          `${prefix}: delegation denied \u2014 ${reason}; target must follow the runtime matrix`
        );
      }
    }
    if (!blockedTools.has(hook.tool)) return;
    if (!input.getReadOnlySessions().has(hook.sessionID)) return;
    throw new Error(
      `${prefix}: session ${hook.sessionID} is READ-ONLY \u2014 tool "${hook.tool}" is denied. This session was delegated for investigation only (read-only agent); it cannot modify files, run commands, or spawn subagents. If a write result is needed, dispatch a write-capable agent (e.g. hermes, aphrodite) with native task() instead.`
    );
  };
}

// src/pantheon/context-sandbox.ts
var DEFAULT_LIMITS = {
  read: { maxLines: 200, keepHead: 50, keepTail: 10 },
  grep: { maxResults: 20, keepTop: 10 },
  glob: { maxFiles: 50, keepTop: 20 },
  webfetch: { maxChars: 5e3, keepHead: 2e3 }
};
var DEFAULT_CONFIG = {
  enabled: true,
  limits: DEFAULT_LIMITS
};
function sandboxRead(output, limits = DEFAULT_LIMITS.read) {
  const lines = output.split("\n");
  const effectiveCount = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (effectiveCount <= limits.maxLines) return output;
  const head = lines.slice(0, limits.keepHead);
  const tail = limits.keepTail > 0 ? lines.slice(Math.max(limits.keepHead, effectiveCount - limits.keepTail), effectiveCount) : [];
  const hidden = effectiveCount - head.length - tail.length;
  const marker = `[TRUNCATED: ${hidden} lines hidden \u2014 showing ${head.length} head + ${tail.length} tail of ${effectiveCount} total lines]`;
  const hadTrailingNewline = output.endsWith("\n");
  const parts = [...head, marker, ...tail];
  let result = parts.join("\n");
  if (hadTrailingNewline) result += "\n";
  return result;
}
function sandboxGrep(output, limits = DEFAULT_LIMITS.grep) {
  const lines = output.split("\n");
  const effectiveCount = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (effectiveCount <= limits.maxResults) return output;
  const head = lines.slice(0, limits.keepTop);
  const hidden = effectiveCount - head.length;
  const marker = `[TRUNCATED: Showing ${head.length} of ${effectiveCount} matches \u2014 ${hidden} more hidden. Use more specific pattern.]`;
  const hadTrailingNewline = output.endsWith("\n");
  let result = [...head, marker].join("\n");
  if (hadTrailingNewline) result += "\n";
  return result;
}
function sandboxGlob(output, limits = DEFAULT_LIMITS.glob) {
  const lines = output.split("\n");
  const effectiveCount = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (effectiveCount <= limits.maxFiles) return output;
  const head = lines.slice(0, limits.keepTop);
  const hidden = effectiveCount - head.length;
  const marker = `[TRUNCATED: showing ${head.length} of ${effectiveCount} files \u2014 ${hidden} more hidden]`;
  const hadTrailingNewline = output.endsWith("\n");
  let result = [...head, marker].join("\n");
  if (hadTrailingNewline) result += "\n";
  return result;
}
function sandboxWebfetch(output, limits = DEFAULT_LIMITS.webfetch) {
  if (output.length <= limits.maxChars) return output;
  const head = output.slice(0, limits.keepHead);
  const hidden = output.length - head.length;
  const marker = `
[TRUNCATED: Content truncated \u2014 showing first ${head.length} of ${output.length} chars, ${hidden} chars hidden]
`;
  return head + marker;
}
function sandboxOutput(tool2, output, limits = DEFAULT_LIMITS) {
  if (typeof output !== "string" || output.length === 0) return output;
  const normalized = tool2.trim().toLowerCase();
  switch (normalized) {
    case "read":
      return sandboxRead(output, limits.read);
    case "grep":
      return sandboxGrep(output, limits.grep);
    case "glob":
      return sandboxGlob(output, limits.glob);
    case "webfetch":
    case "fetch":
    case "web_fetch":
      return sandboxWebfetch(output, limits.webfetch);
    default:
      return output;
  }
}
function resolveSandboxConfig(raw) {
  if (raw === null || raw === void 0 || typeof raw !== "object")
    return { ...DEFAULT_CONFIG, limits: { ...DEFAULT_LIMITS } };
  const obj = raw;
  const enabled = typeof obj.enabled === "boolean" ? obj.enabled : true;
  const limitsRaw = obj.limits;
  const limits = {
    read: {
      maxLines: typeof limitsRaw?.read === "object" && limitsRaw.read !== null && typeof limitsRaw.read.maxLines === "number" ? limitsRaw.read.maxLines : DEFAULT_LIMITS.read.maxLines,
      keepHead: typeof limitsRaw?.read === "object" && limitsRaw.read !== null && typeof limitsRaw.read.keepHead === "number" ? limitsRaw.read.keepHead : DEFAULT_LIMITS.read.keepHead,
      keepTail: typeof limitsRaw?.read === "object" && limitsRaw.read !== null && typeof limitsRaw.read.keepTail === "number" ? limitsRaw.read.keepTail : DEFAULT_LIMITS.read.keepTail
    },
    grep: {
      maxResults: typeof limitsRaw?.grep === "object" && limitsRaw.grep !== null && typeof limitsRaw.grep.maxResults === "number" ? limitsRaw.grep.maxResults : DEFAULT_LIMITS.grep.maxResults,
      keepTop: typeof limitsRaw?.grep === "object" && limitsRaw.grep !== null && typeof limitsRaw.grep.keepTop === "number" ? limitsRaw.grep.keepTop : DEFAULT_LIMITS.grep.keepTop
    },
    glob: {
      maxFiles: typeof limitsRaw?.glob === "object" && limitsRaw.glob !== null && typeof limitsRaw.glob.maxFiles === "number" ? limitsRaw.glob.maxFiles : DEFAULT_LIMITS.glob.maxFiles,
      keepTop: typeof limitsRaw?.glob === "object" && limitsRaw.glob !== null && typeof limitsRaw.glob.keepTop === "number" ? limitsRaw.glob.keepTop : DEFAULT_LIMITS.glob.keepTop
    },
    webfetch: {
      maxChars: typeof limitsRaw?.webfetch === "object" && limitsRaw.webfetch !== null && typeof limitsRaw.webfetch.maxChars === "number" ? limitsRaw.webfetch.maxChars : DEFAULT_LIMITS.webfetch.maxChars,
      keepHead: typeof limitsRaw?.webfetch === "object" && limitsRaw.webfetch !== null && typeof limitsRaw.webfetch.keepHead === "number" ? limitsRaw.webfetch.keepHead : DEFAULT_LIMITS.webfetch.keepHead
    }
  };
  return { enabled, limits };
}
function createContextSandbox(config = DEFAULT_CONFIG) {
  const cfgRef = config;
  return async (input, output) => {
    try {
      if (!cfgRef.enabled) return;
      if (typeof output.output !== "string") return;
      const before = output.output;
      const after = sandboxOutput(input.tool, before, cfgRef.limits);
      if (after !== before) {
        output.output = after;
        output.metadata = {
          ...output.metadata ?? {},
          truncated: true,
          sandbox: input.tool.toLowerCase()
        };
      }
    } catch {
    }
  };
}

// src/pantheon/hashline/xxhash.ts
import { createHash } from "node:crypto";
var HASHLINE_DICT = "ZPMQVRWSNKTXJBYH";
var ALNUM_RE = /[\p{L}\p{N}]/u;
function normalizeLine(line) {
  return line.replace(/\r$/, "").trimEnd();
}
function hashTag(line, lineNumber) {
  const normalized = normalizeLine(line);
  const seed = ALNUM_RE.test(normalized) ? 0 : lineNumber;
  const digest = createHash("sha256").update(`${seed}\0${normalized}`).digest();
  const first = digest[0] ?? 0;
  return HASHLINE_DICT.charAt(first >> 4) + HASHLINE_DICT.charAt(first & 15);
}

// src/pantheon/hashline/core.ts
var HASHLINE_REF_RE = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/;
var TAGGED_LINE_RE = new RegExp(`^\\s*[0-9]+#[${HASHLINE_DICT}]{2}\\|`);
function isTaggedLine(line) {
  return TAGGED_LINE_RE.test(line);
}
function suggestLineForHash(lineNo, tag) {
  return `Did you mean "${lineNo}#${tag}"?`;
}
function buildMismatchError(file, ref, actual, lines) {
  const start = Math.max(1, actual.line - 2);
  const end = Math.min(lines.length, actual.line + 2);
  const excerpt = [];
  for (let i = start; i <= end; i++) {
    const content = lines[i - 1] ?? "";
    const tag = i === actual.line ? actual.tag : hashTag(content, i);
    const marker = i === actual.line ? ">>>" : "   ";
    excerpt.push(`${marker}${i}#${tag}|${content}`);
  }
  return [
    `hashline_edit: ref "${ref}" does not match ${file} at line ${actual.line} (tag "${actual.tag}")`,
    "",
    excerpt.join("\n"),
    "",
    suggestLineForHash(actual.line, actual.tag)
  ].join("\n");
}

// src/pantheon/hashline/read-enhancer.ts
var LINE_PREFIX_RE = /^\s*([0-9]+): ?(.*)$|^\s*([0-9]+)\| ?(.*)$/;
function createReadEnhancer() {
  return async (input, output) => {
    if (input.tool !== "read") return;
    if (typeof output.output !== "string") return;
    const tagged = output.output.split("\n").map((line) => {
      if (isTaggedLine(line)) return line;
      const m = LINE_PREFIX_RE.exec(line);
      if (!m) return line;
      const lineNo = Number(m[1] ?? m[3]);
      const content = m[2] ?? m[4] ?? "";
      return `${lineNo}#${hashTag(content, lineNo)}|${content}`;
    });
    output.output = tagged.join("\n");
  };
}

// src/pantheon/task-result-guard.ts
var log2 = createPantheonLogger({ module: "pantheon-task-result-guard" });
var EMPTY_TASK_ERROR = "ERROR: task() returned empty output \u2014 child session produced no assistant or tool output. This typically means the provider rejected the request (admission control / rate limit) or the child session crashed before producing any response. Consider splitting the work into a smaller task. No retry is automatic; investigate before retrying manually.";
var HOST_EMPTY_RESULT_TEXT = "Subagent completed without a text response.";
function isChildDispatchTool(tool2) {
  return tool2 === "task" || tool2 === "subagent";
}
function isEmptyOutput(output) {
  if (output == null) return true;
  if (typeof output !== "string") return true;
  const trimmed = output.trim();
  if (trimmed === "") return true;
  return trimmed === HOST_EMPTY_RESULT_TEXT;
}
function createTaskResultGuard(options) {
  const warn = options?.logger?.warn ?? ((message) => log2.warn(message));
  return async (input, output) => {
    if (!isChildDispatchTool(input.tool)) return;
    if (!isEmptyOutput(output.output)) return;
    warn(
      `[task-result-guard] Empty ${input.tool} result detected on session ${input.sessionID} (callID=${input.callID}). Replacing with explicit error.`
    );
    output.output = EMPTY_TASK_ERROR;
  };
}

// src/pantheon/execute-after.ts
function extractText(result, tool2) {
  const childOutput = isChildDispatchTool(tool2) && result.output !== null && typeof result.output === "object" && !Array.isArray(result.output) ? result.output.output : void 0;
  if (typeof childOutput === "string" && childOutput.trim() !== "") {
    return { text: childOutput, field: "child-output-envelope" };
  }
  if (typeof result.output === "string" && result.output.trim() !== "") {
    return { text: result.output, field: "output" };
  }
  if (typeof result.content === "string" && result.content.trim() !== "") {
    return { text: result.content, field: "content" };
  }
  if (Array.isArray(result.content)) {
    const parts = result.content;
    const allText = parts.every(
      (part) => typeof part === "string" || part?.type === "text"
    );
    if (!allText || parts.length === 0) return null;
    const text2 = parts.map((part) => typeof part === "string" ? part : part.text ?? "").join("\n");
    if (text2.trim() !== "") return { text: text2, field: "content-array" };
  }
  if (typeof result.output === "string") return { text: result.output, field: "output" };
  if (typeof childOutput === "string") {
    return { text: childOutput, field: "child-output-envelope" };
  }
  return null;
}
function hasMeaningfulStructuredContent(content) {
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (typeof part === "string") return false;
      return part === null || typeof part !== "object" || part.type !== "text";
    });
  }
  if (content !== null && typeof content === "object") {
    const part = content;
    return part.type === "text" ? typeof part.text === "string" && part.text.trim() !== "" : Object.keys(content).length > 0;
  }
  return false;
}
function rewriteChildContentMirror(content, originalText, replacement) {
  const isHostPlaceholder = originalText.trim() === HOST_EMPTY_RESULT_TEXT;
  const matches = (value) => typeof value === "string" && (isHostPlaceholder ? value.includes(HOST_EMPTY_RESULT_TEXT) : originalText.trim() === "" && value.trim() === "");
  if (typeof content === "string") return matches(content) ? replacement : content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return matches(part) ? replacement : part;
      if (part !== null && typeof part === "object" && part.type === "text" && matches(part.text)) {
        return { ...part, text: replacement };
      }
      return part;
    });
  }
  if (content !== null && typeof content === "object" && content.type === "text" && matches(content.text)) {
    return { ...content, text: replacement };
  }
  return content;
}
function writeText(result, field, text2, originalText, tool2) {
  if (field === "output") {
    result.output = text2;
  } else if (field === "content") {
    result.content = text2;
  } else if (field === "content-array") {
    result.content = [{ type: "text", text: text2 }];
  } else {
    const envelope = result.output;
    envelope.output = text2;
  }
  if (isChildDispatchTool(tool2) && field !== "content" && field !== "content-array") {
    result.content = rewriteChildContentMirror(result.content, originalText, text2);
  }
}
function createV2ExecuteAfter(options = {}) {
  const taskResultGuard = createTaskResultGuard();
  const sandbox = createContextSandbox(options.sandbox ?? DEFAULT_CONFIG);
  const readEnhancer = createReadEnhancer();
  return async function v2ExecuteAfter(event) {
    try {
      if (event === null || typeof event !== "object" || Array.isArray(event)) return;
      const payload = event;
      if (payload.status !== "completed") return;
      const result = payload.result;
      if (result === null || typeof result !== "object" || Array.isArray(result)) return;
      const tool2 = typeof payload.tool === "string" ? payload.tool : "";
      const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : "";
      const callID = typeof payload.id === "string" ? payload.id : "";
      const extracted = extractText(result, tool2);
      const resultContent = result.content;
      if (hasMeaningfulStructuredContent(resultContent) && (extracted === null || extracted.text.trim() === "")) {
        return;
      }
      if (extracted === null && !isChildDispatchTool(tool2)) return;
      const original = extracted === null ? { text: "", field: "output" } : extracted;
      const input = { tool: tool2, sessionID, callID, args: payload.input };
      const output = { output: original.text };
      await taskResultGuard(input, output);
      await sandbox(input, output);
      await readEnhancer(input, output);
      if (output.output !== original.text) {
        writeText(result, original.field, output.output, original.text, tool2);
      }
      if (output.metadata && Object.keys(output.metadata).length > 0) {
        ;
        result.metadata = {
          ...result.metadata,
          ...output.metadata
        };
      }
    } catch {
    }
  };
}
function resolveV2SandboxConfig(options) {
  const raw = options?.context_sandbox;
  return resolveSandboxConfig(raw);
}

// src/pantheon/goal-loop-config.ts
var DEFAULT_GOAL_LOOP_CONFIG = {
  enabled: false,
  cooldownMs: 5e3,
  maxContinuations: 25
};
var MIN_COOLDOWN_MS = 1e3;
var MIN_CONTINUATIONS = 1;
var MAX_CONTINUATIONS = 200;
function resolveGoalLoopConfig(options) {
  try {
    const raw = options?.goal_loop;
    if (raw === null || raw === void 0 || typeof raw !== "object" || Array.isArray(raw)) {
      return { ...DEFAULT_GOAL_LOOP_CONFIG };
    }
    const obj = raw;
    const num = (value, fallback, min, max) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
      const floored = Math.max(min, Math.floor(value));
      return max !== void 0 ? Math.min(max, floored) : floored;
    };
    return {
      enabled: typeof obj.enabled === "boolean" ? obj.enabled : false,
      cooldownMs: num(obj.cooldownMs, DEFAULT_GOAL_LOOP_CONFIG.cooldownMs, MIN_COOLDOWN_MS),
      maxContinuations: num(
        obj.maxContinuations,
        DEFAULT_GOAL_LOOP_CONFIG.maxContinuations,
        MIN_CONTINUATIONS,
        MAX_CONTINUATIONS
      )
    };
  } catch {
    return { ...DEFAULT_GOAL_LOOP_CONFIG };
  }
}

// src/pantheon/goal-store.ts
import { mkdir as mkdir2, readFile as readFile2, rename, writeFile } from "node:fs/promises";
import { join as join3 } from "node:path";

// src/pantheon/session-id.ts
function assertSafeParentSessionID(parentSessionID) {
  if (parentSessionID.includes("..") || parentSessionID.includes("/") || parentSessionID.includes("\\")) {
    throw new Error(`Invalid parentSessionID: ${parentSessionID}`);
  }
}

// src/pantheon/goal-store.ts
var DEFAULT_GOAL_DIR = ".pantheon/goals";
var GoalStore = class {
  dir;
  constructor(opts = {}) {
    this.dir = opts.dir ?? DEFAULT_GOAL_DIR;
  }
  /**
   * Path-traversal guard for session IDs embedded in file paths (same
   * pattern as assertSafeParentSessionID). Throws on `..`, `/`, `\`.
   */
  sanitizeSessionID(sessionID) {
    assertSafeParentSessionID(sessionID);
    return sessionID;
  }
  pathFor(sessionID) {
    return join3(this.dir, `${this.sanitizeSessionID(sessionID)}.json`);
  }
  /** Load the session's goal; undefined when none exists yet. */
  async load(sessionID) {
    const path5 = this.pathFor(sessionID);
    try {
      const content = await readFile2(path5, "utf-8");
      return JSON.parse(content);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return void 0;
      }
      throw err;
    }
  }
  /** Persist a goal atomically (tmp + rename). */
  async save(goal) {
    const path5 = this.pathFor(goal.sessionID);
    const tmpPath = `${path5}.tmp`;
    await mkdir2(this.dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(goal, null, 2), "utf-8");
    await rename(tmpPath, path5);
  }
  /** True when the session has a goal that is not `done`. */
  async hasActive(sessionID) {
    const goal = await this.load(sessionID);
    return goal !== void 0 && goal.status !== "done";
  }
  /** List the session's goals — at most one (YAGNI: single active goal). */
  async list(sessionID) {
    const goal = await this.load(sessionID);
    return goal === void 0 ? [] : [goal];
  }
};

// src/pantheon/guard-path.ts
import { lstatSync as lstatSync3, realpathSync, statSync } from "node:fs";
import path2 from "node:path";
var MISSING_CODES = /* @__PURE__ */ new Set(["ENOENT", "ENOTDIR"]);
var MAX_PATH_COMPONENTS = 64;
function errorCode(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return String(error.code);
}
function isMissing(error) {
  return MISSING_CODES.has(errorCode(error));
}
function isWithin2(root, target) {
  const relative2 = path2.relative(root, target);
  return relative2 === "" || !relative2.startsWith(`..${path2.sep}`) && relative2 !== ".." && !path2.isAbsolute(relative2);
}
function resolveExistingPrefix(absolute) {
  let cursor = path2.resolve(absolute);
  if (cursor.split(path2.sep).filter(Boolean).length > MAX_PATH_COMPONENTS) return void 0;
  const remainder = [];
  for (let walked = 0; walked < MAX_PATH_COMPONENTS; walked++) {
    try {
      const resolved = realpathSync(cursor);
      return remainder.length === 0 ? resolved : path2.join(resolved, ...remainder);
    } catch (error) {
      if (!isMissing(error)) return void 0;
      try {
        if (lstatSync3(cursor).isSymbolicLink()) return void 0;
      } catch (lstatError) {
        if (!isMissing(lstatError)) return void 0;
      }
      const parent = path2.dirname(cursor);
      if (parent === cursor) return void 0;
      remainder.unshift(path2.basename(cursor));
      cursor = parent;
    }
  }
  return void 0;
}
function toGuardForm(resolvedAbsolute, rootReal) {
  const relative2 = isWithin2(rootReal, resolvedAbsolute) ? path2.relative(rootReal, resolvedAbsolute) : resolvedAbsolute;
  return relative2.split(path2.sep).join("/");
}
function canonicalProjectRoot(projectRoot) {
  try {
    const rootReal = realpathSync(path2.resolve(projectRoot));
    return statSync(rootReal).isDirectory() ? rootReal : void 0;
  } catch {
    return void 0;
  }
}
function resolveAgainst(rawPath, rootReal) {
  const raw = rawPath.replace(/\\/g, "/");
  const absolute = path2.resolve(rootReal, raw);
  const resolvedAbsolute = resolveExistingPrefix(absolute);
  if (resolvedAbsolute === void 0) return { raw, failed: true };
  let isRegularFile = false;
  try {
    isRegularFile = statSync(resolvedAbsolute).isFile();
  } catch (error) {
    if (!isMissing(error)) return { raw, failed: true };
  }
  return {
    raw,
    resolved: toGuardForm(resolvedAbsolute, rootReal),
    failed: false,
    isRegularFile,
    withinProject: isWithin2(rootReal, resolvedAbsolute)
  };
}
function createGuardPathResolver(projectRoot) {
  const rootReal = canonicalProjectRoot(projectRoot);
  return (rawPath) => rootReal === void 0 ? { raw: rawPath, failed: true } : resolveAgainst(rawPath, rootReal);
}

// src/pantheon/hook-engine.ts
import { appendFileSync, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join4 } from "node:path";
var SECRET_SCAN_MARKER = "[SECRET SCAN]";
var BIFROST_TOKEN_PREFIX = `${"sk"}${"-bf-"}`;
var BIFROST_HEADER_NAME = `${"x"}${"-bf-"}${"vk"}`;
var HIGH_CONFIDENCE_RES = Object.freeze([
  /AKIA[0-9A-Z]{16}/i,
  /gh[pousr]_[A-Za-z0-9_]{36,}/i,
  /glpat-[A-Za-z0-9_-]{20}/i,
  /sk-[a-zA-Z0-9]{20,}/i,
  /sk_live_[a-zA-Z0-9]{20,}/i,
  /sk_test_[a-zA-Z0-9]{20,}/i,
  /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/i,
  /bearer\s+[a-zA-Z0-9_.-]{20,}/i,
  /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]/
]);
var BIFROST_TOKEN_RE = new RegExp(`${BIFROST_TOKEN_PREFIX}[A-Za-z0-9_-]{8,}`, "i");
var LOW_CONFIDENCE_RES = Object.freeze([
  /[a-zA-Z0-9_-]*api[_-]?key[a-zA-Z0-9_-]*\s*[:=]\s*["']?[a-zA-Z0-9_-]{16,}["']?/,
  /[a-zA-Z0-9_-]*password[a-zA-Z0-9_-]*\s*[:=]\s*["'][^"']{8,}["']/,
  /[a-zA-Z0-9_-]*secret[a-zA-Z0-9_-]*\s*[:=]\s*["'][^"']{8,}["']/
]);
var BIFROST_HEADER_RE = new RegExp(BIFROST_HEADER_NAME, "i");
function maskSecretMatch(match) {
  return match.length <= 8 ? "****" : `${match.slice(0, 4)}****${match.slice(-4)}`;
}
function firstMatch(input, pattern) {
  const found = input.match(pattern);
  return found === null ? null : found[0];
}
var READ_ONLY_TOOLS = /* @__PURE__ */ new Set([
  "read",
  "grep",
  "glob",
  "list",
  "question",
  "session_list",
  "session_read",
  "worktree_list",
  "subagent_list"
]);
function secretScanApplies(tool2) {
  if (typeof tool2 !== "string") return true;
  const normalized = tool2.trim().toLowerCase();
  if (normalized === "") return true;
  return !READ_ONLY_TOOLS.has(normalized);
}
function scannerInput(payload) {
  if (typeof payload === "string") return payload;
  if (payload === null || payload === void 0) return "";
  const record2 = payload;
  const input = record2.tool_input ?? record2.input ?? payload;
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}
function runSecretScanInProcess(payload) {
  try {
    const input = scannerInput(payload);
    if (input === "") return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false };
    const stderr = [];
    let high = null;
    for (const pattern of [...HIGH_CONFIDENCE_RES, BIFROST_TOKEN_RE]) {
      const match = firstMatch(input, pattern);
      if (match !== null) {
        stderr.push(
          `${SECRET_SCAN_MARKER} High-confidence secret detected: ${maskSecretMatch(match)} (pattern: ${pattern.source})`
        );
        high ??= match;
      }
    }
    let low = false;
    for (const pattern of [...LOW_CONFIDENCE_RES, BIFROST_HEADER_RE]) {
      const match = firstMatch(input, pattern);
      if (match !== null) {
        stderr.push(
          `${SECRET_SCAN_MARKER} Potential secret detected (low confidence): ${maskSecretMatch(match)} (pattern: ${pattern.source})`
        );
        low = true;
      }
    }
    if (high !== null) {
      stderr.push(
        `${SECRET_SCAN_MARKER} High-confidence hardcoded secret detected. Tool call will be BLOCKED.`
      );
      return {
        code: 2,
        stdout: "",
        stderr: `${stderr.join("\n")}
`,
        signal: null,
        timedOut: false
      };
    }
    if (low) {
      stderr.push(
        `${SECRET_SCAN_MARKER} Possible secret detected. Remove it and use environment variables or a vault.`
      );
      return {
        code: 1,
        stdout: "",
        stderr: `${stderr.join("\n")}
`,
        signal: null,
        timedOut: false
      };
    }
    return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false };
  } catch {
    return {
      code: 1,
      stdout: "",
      stderr: "in-process secret scan failed",
      signal: null,
      timedOut: false
    };
  }
}
function resolveDelegationLogDir(env = process.env) {
  if (env.LOG_DIR) return env.LOG_DIR;
  if (env.XDG_STATE_HOME) return join4(env.XDG_STATE_HOME, "pantheon", "hooks");
  if (env.PANTHEON_HOME) return join4(env.PANTHEON_HOME, "logs", "agent-sessions");
  if (env.PANTHEON_PROJECT) return join4(env.PANTHEON_PROJECT, "logs", "agent-sessions");
  return join4("logs", "agent-sessions");
}
function delegationTimestamp(now) {
  return `${new Date(now).toISOString().slice(0, 19)}Z`;
}
function appendDelegationAuditLine(line) {
  try {
    const dir = resolveDelegationLogDir();
    mkdirSync2(dir, { recursive: true });
    appendFileSync(join4(dir, "delegations.log"), `${JSON.stringify(line)}
`, "utf8");
    return true;
  } catch {
    return false;
  }
}
function delegationStartLine(fields) {
  return {
    event: "SubagentStart",
    timestamp: delegationTimestamp(fields.now),
    agent: fields.agent,
    task: fields.task === "" ? fields.agent : fields.task,
    session_id: fields.sessionID,
    delegation_id: fields.delegationID
  };
}
function delegationStopLine(fields) {
  return {
    event: "SubagentStop",
    timestamp: delegationTimestamp(fields.now),
    agent: fields.agent,
    status: fields.status,
    reason: fields.reason,
    task: fields.task === "" ? fields.agent : fields.task,
    session_id: fields.sessionID,
    result: fields.result ?? null,
    delegation_id: fields.delegationID,
    ...fields.taskID === "" ? {} : { task_id: fields.taskID },
    ...fields.durationMs === null ? {} : { duration_ms: fields.durationMs }
  };
}
var FORMATTABLE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".toml"
]);
function formattablePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= value.lastIndexOf("/")) return false;
  return FORMATTABLE_EXTENSIONS.has(value.slice(dot).toLowerCase());
}
function formatterApplies(tool2, input) {
  const normalized = tool2.trim().toLowerCase();
  if (normalized === "edit" || normalized === "write" || normalized === "hashline_edit") {
    if (input !== null && typeof input === "object") {
      return formattablePath(input.file_path);
    }
    return false;
  }
  if (normalized === "bash") {
    return true;
  }
  return false;
}

// src/pantheon/j-telemetry-file.ts
import { appendFile as appendFile2, mkdir as mkdir3, rename as rename2, stat } from "node:fs/promises";
import { dirname as dirname3, join as join5 } from "node:path";
var MAX_FILE_BYTES = 1048576;
function defaultMirrorPath(cwd = process.cwd()) {
  return join5(cwd, ".pantheon", "logs", "j-telemetry.jsonl");
}
var ALLOWED_FIELDS = ["point", "mode", "effect", "decision", "reason"];
function mirrorProjection(record2) {
  if (record2 === null || typeof record2 !== "object" || Array.isArray(record2)) return null;
  const source = record2;
  const projected = { ts: (/* @__PURE__ */ new Date()).toISOString() };
  for (const field of ALLOWED_FIELDS) {
    const value = source[field];
    if (value === void 0) continue;
    if (typeof value !== "string") return null;
    if (value.length > 200) return null;
    projected[field] = value;
  }
  return projected;
}
function createJTelemetryMirror(options) {
  if (!options.enabled) return null;
  const path5 = options.path ?? defaultMirrorPath();
  let rotating = false;
  return {
    record(record2) {
      try {
        const projected = mirrorProjection(record2);
        if (projected === null) return Promise.resolve();
        const line = `${JSON.stringify(projected)}
`;
        return (async () => {
          try {
            if (!rotating) {
              const current = await stat(path5).catch(() => null);
              if (current !== null && current.size > MAX_FILE_BYTES) {
                rotating = true;
                await rename2(path5, `${path5}.1`).catch(() => {
                });
                rotating = false;
              }
            }
            await mkdir3(dirname3(path5), { recursive: true });
            await appendFile2(path5, line, "utf8");
          } catch {
          }
        })();
      } catch {
        return Promise.resolve();
      }
    }
  };
}

// src/pantheon/j1-approvals.ts
import { createHash as createHash2 } from "node:crypto";
var J1_APPROVAL_MARKER_PREFIX = "j1-approval-";
var J1_APPROVAL_TTL_MS = 15 * 60 * 1e3;
var MAX_APPROVALS_PER_SESSION = 64;
var AFFIRMATIVE = /* @__PURE__ */ new Set(["approve", "approved", "yes", "y", "sim", "aprovar", "aprovado"]);
function j1ApprovalMarker(inputHash) {
  return `${J1_APPROVAL_MARKER_PREFIX}${inputHash.slice(0, 12)}`;
}
function isAffirmativeAnswer(marker, serializedResult) {
  if (!serializedResult.includes(marker)) return false;
  const bounded = serializedResult.slice(0, 2e3).toLowerCase();
  for (const token of AFFIRMATIVE) {
    if (new RegExp(`\\b${token}\\b`).test(bounded)) return true;
  }
  return false;
}
var store = /* @__PURE__ */ new Map();
function pruneSession(session, now) {
  for (const [hash, at] of session.approved) {
    if (now - at > J1_APPROVAL_TTL_MS) session.approved.delete(hash);
  }
  while (session.approved.size > MAX_APPROVALS_PER_SESSION) {
    const oldest = [...session.approved.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest === void 0) break;
    session.approved.delete(oldest[0]);
  }
}
function mintApproval(sessionID, inputHash, now = Date.now()) {
  if (sessionID === "" || inputHash === "") return;
  const session = store.get(sessionID) ?? { approved: /* @__PURE__ */ new Map() };
  session.approved.set(inputHash.slice(0, 12), now);
  pruneSession(session, now);
  store.set(sessionID, session);
}
function hasApproval(sessionID, inputHash, now = Date.now()) {
  const session = store.get(sessionID);
  if (session === void 0) return false;
  const at = session.approved.get(inputHash.slice(0, 12));
  if (at === void 0) return false;
  if (now - at > J1_APPROVAL_TTL_MS) {
    session.approved.delete(inputHash.slice(0, 12));
    return false;
  }
  return true;
}
function approvalInputHash(input) {
  let serialized;
  if (typeof input === "string") {
    serialized = input;
  } else {
    try {
      const json = JSON.stringify(input);
      serialized = json === void 0 ? String(input) : json;
    } catch {
      serialized = "unserializable-tool-input";
    }
  }
  return createHash2("sha256").update(serialized, "utf8").digest("hex");
}

// src/pantheon/local-decision-provider-matrix.ts
var DECISION_PROVIDER_ADAPTERS = Object.freeze(
  Object.fromEntries(
    Object.keys(DECISION_ROUTER_MODELS).map((provider) => {
      const model = DECISION_ROUTER_MODELS[provider]?.[0];
      if (model === void 0) throw new Error(`Missing decision provider model: ${provider}`);
      return [
        provider,
        Object.freeze({
          model,
          accountingProvider: DECISION_PROVIDER_BUDGET_MAPPING[provider]
        })
      ];
    })
  )
);

// src/pantheon/native-decisions.ts
var NATIVE_DECISION_MAX_PROMPT_LENGTH = 12e3;
var NATIVE_STOCK_DECISION_ROUTES = Object.freeze([
  Object.freeze({
    providerID: "opencode",
    id: "jev-1.13",
    kind: "opencode-console-jev",
    billing: "OpenCode Console"
  }),
  Object.freeze({
    providerID: "openrouter",
    id: "typesafe/jev-1.13",
    kind: "openrouter-jev",
    billing: "OpenRouter"
  })
]);
function findRouteKind(model) {
  const stock = NATIVE_STOCK_DECISION_ROUTES.find(
    (candidate) => candidate.providerID === model.providerID && candidate.id === model.id
  );
  if (stock !== void 0) return { kind: stock.kind, billing: stock.billing };
  if (model.providerID === "openrouter") {
    return { kind: "custom-decision", billing: "OpenRouter" };
  }
  if (model.providerID === "opencode") {
    return { kind: "custom-decision", billing: "OpenCode Console" };
  }
  return { kind: "custom-decision", billing: "Provider configured in OpenCode" };
}
var DECISION_AGENT_IDS = new Set(
  PANTHEON_AGENT_CATALOG.filter((agent) => agent.id !== "zeus").map((agent) => agent.id)
);

// src/pantheon/jev-decisions.ts
var NATIVE_JEV_HOST_PROVIDERS = Object.freeze({
  "typesafe-jev": "typesafe-ai",
  "opencode-console-jev": "opencode",
  // Host-embedded decision modules confirmed in the 2.2.5 binary
  // (providers/<id>/decisions, System One transport — the host normalizes
  // the request/response, so consumers only need the providerID mapping):
  // openrouter (models.dev provider; credential OPENROUTER_API_KEY),
  // vercel-ai-gateway (models.dev provider; AI_GATEWAY_API_KEY),
  // cloudflare-workers-ai (custom entry with accountId; CLOUDFLARE_API_TOKEN),
  // baseten and digitalocean (modules present, decision models undocumented).
  "openrouter-jev": "openrouter",
  "vercel-gateway-jev": "vercel-ai-gateway",
  "cloudflare-workers-jev": "cloudflare-workers-ai"
});
function isNativeJevProvider(provider) {
  return typeof provider === "string" && Object.hasOwn(NATIVE_JEV_HOST_PROVIDERS, provider);
}
function filterNativeCapValidCandidates(candidates, checkAdmission) {
  const valid = [];
  for (const candidate of candidates) {
    if (!isNativeJevProvider(candidate.provider)) continue;
    const adapter = DECISION_PROVIDER_ADAPTERS[candidate.provider];
    if (!checkAdmission(adapter.accountingProvider, candidate.model)) continue;
    valid.push(candidate);
  }
  return valid;
}
function readEnabledCandidates(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return [];
  const value = config.enabled_candidates;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (candidate) => candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) && typeof candidate.provider === "string" && typeof candidate.model === "string"
  );
}
function resolveNativeJevRoute(config, checkAdmission) {
  const record2 = config !== null && typeof config === "object" && !Array.isArray(config) ? config : void 0;
  if (record2?.enabled !== true || record2.egress_consent !== true) {
    return { ok: false, reasonCode: "NO_ELIGIBLE_CANDIDATE" };
  }
  const selection = record2.selection !== null && typeof record2.selection === "object" && !Array.isArray(record2.selection) ? record2.selection : void 0;
  if (typeof selection?.mode !== "string" || selection.mode === "local") {
    return { ok: false, reasonCode: "NO_ELIGIBLE_CANDIDATE" };
  }
  const capValid = filterNativeCapValidCandidates(readEnabledCandidates(config), checkAdmission);
  const selected = selection.mode === "explicit" ? capValid.find(
    (candidate) => candidate.provider === selection.provider && candidate.model === selection.model
  ) : capValid.length === 1 ? capValid[0] : void 0;
  if (selected === void 0 || !isNativeJevProvider(selected.provider)) {
    return { ok: false, reasonCode: "NO_ELIGIBLE_CANDIDATE" };
  }
  const hostProvider = NATIVE_JEV_HOST_PROVIDERS[selected.provider];
  const routeModel = { providerID: hostProvider, id: selected.model };
  return {
    ok: true,
    selection: {
      route: Object.freeze({ model: routeModel, ...findRouteKind(routeModel) }),
      provider: selected.provider,
      accountingProvider: DECISION_PROVIDER_ADAPTERS[selected.provider].accountingProvider,
      model: selected.model
    }
  };
}
var JEV_DECISION_MAX_QUESTIONS = 4;
var JEV_DECISION_MAX_CHOICES = 32;
var JEV_DECISION_MIN_CHOICES = 2;
var JEV_DECISION_MAX_SCORE_LEVELS = 10;
var JEV_DECISION_MIN_SCORE_LEVELS = 2;
var JEV_DECISION_MAX_NAME_LENGTH = 64;
var JEV_DECISION_MAX_INSTRUCTIONS_LENGTH = 2e3;
var JEV_DECISION_MAX_DESCRIPTION_LENGTH = 500;
var QUESTION_NAME_PATTERN = /^[a-z0-9_.-]{1,64}$/i;
function checkJevEnvelope(input, allowedKeys) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || input.schemaVersion !== 1) {
    return { ok: false, detail: "SCHEMA_VERSION_INVALID" };
  }
  const unknown = Object.keys(input).filter(
    (key) => !allowedKeys.has(key)
  );
  if (unknown.length > 0) return { ok: false, detail: "UNKNOWN_INPUT_KEYS" };
  return { ok: true };
}
var JEV_EXPLICIT_ENVELOPE_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "state",
  "questions"
]);
var JEV_PRESET_ENVELOPE_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "mode",
  "state"
]);
function isBoundedNonBlankString(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function readBoundedDescription(value) {
  if (value === void 0) return void 0;
  return typeof value === "string" && value.length > 0 && value.length <= 500 ? value : void 0;
}
function readChoiceQuestion(question) {
  if (!Array.isArray(question.choices)) return null;
  if (question.choices.length < JEV_DECISION_MIN_CHOICES || question.choices.length > JEV_DECISION_MAX_CHOICES) {
    return null;
  }
  const seen = /* @__PURE__ */ new Set();
  const choices = [];
  for (const raw of question.choices) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record2 = raw;
    if (!isBoundedNonBlankString(record2.value, JEV_DECISION_MAX_NAME_LENGTH)) return null;
    if (seen.has(record2.value)) return null;
    seen.add(record2.value);
    const description = readBoundedDescription(record2.description);
    choices.push(
      description === void 0 ? { value: record2.value } : { value: record2.value, description }
    );
  }
  return {
    type: "choice",
    name: question.name,
    instructions: question.instructions,
    choices
  };
}
function readScoreQuestion(question) {
  if (!Array.isArray(question.levels)) return null;
  if (question.levels.length < JEV_DECISION_MIN_SCORE_LEVELS || question.levels.length > JEV_DECISION_MAX_SCORE_LEVELS) {
    return null;
  }
  const seen = /* @__PURE__ */ new Set();
  const levels = [];
  for (const raw of question.levels) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record2 = raw;
    if (!isBoundedNonBlankString(record2.label, JEV_DECISION_MAX_NAME_LENGTH)) return null;
    if (seen.has(record2.label)) return null;
    seen.add(record2.label);
    const description = readBoundedDescription(record2.description);
    levels.push(
      description === void 0 ? { label: record2.label } : { label: record2.label, description }
    );
  }
  return {
    type: "score",
    name: question.name,
    instructions: question.instructions,
    levels
  };
}
function prepareJevDecisionRequest(route, input) {
  if (input.schemaVersion !== 1) {
    return { ok: false, reasonCode: "QUESTIONS_INVALID", detail: "SCHEMA_VERSION_INVALID" };
  }
  const knownKeys = /* @__PURE__ */ new Set(["schemaVersion", "state", "questions"]);
  const unknown = Object.keys(input).filter((key) => !knownKeys.has(key));
  if (unknown.length > 0) {
    return { ok: false, reasonCode: "QUESTIONS_INVALID", detail: "UNKNOWN_INPUT_KEYS" };
  }
  const state = input.state;
  if (!isBoundedNonBlankString(state, NATIVE_DECISION_MAX_PROMPT_LENGTH)) {
    return { ok: false, reasonCode: "STATE_INVALID" };
  }
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions)) {
    return { ok: false, reasonCode: "QUESTIONS_INVALID", detail: "QUESTIONS_NOT_A_LIST" };
  }
  if (rawQuestions.length < 1 || rawQuestions.length > JEV_DECISION_MAX_QUESTIONS) {
    return { ok: false, reasonCode: "QUESTIONS_INVALID", detail: "QUESTION_COUNT_INVALID" };
  }
  const names = /* @__PURE__ */ new Set();
  const questions = [];
  for (const raw of rawQuestions) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reasonCode: "QUESTIONS_INVALID", detail: "QUESTION_NOT_AN_OBJECT" };
    }
    const question = raw;
    if (!isBoundedNonBlankString(question.name, JEV_DECISION_MAX_NAME_LENGTH)) {
      return { ok: false, reasonCode: "QUESTIONS_INVALID", detail: "QUESTION_NAME_INVALID" };
    }
    if (!QUESTION_NAME_PATTERN.test(question.name) || names.has(question.name)) {
      return {
        ok: false,
        reasonCode: "QUESTIONS_INVALID",
        detail: "QUESTION_NAME_BAD_PATTERN_OR_DUPLICATE"
      };
    }
    if (!isBoundedNonBlankString(question.instructions, JEV_DECISION_MAX_INSTRUCTIONS_LENGTH)) {
      return { ok: false, reasonCode: "QUESTIONS_INVALID", detail: "QUESTION_INSTRUCTIONS_INVALID" };
    }
    names.add(question.name);
    if (question.type === "choice") {
      const built = readChoiceQuestion(question);
      if (built === null)
        return { ok: false, reasonCode: "QUESTIONS_INVALID", detail: "CHOICE_INVALID" };
      questions.push(built);
    } else if (question.type === "score") {
      const built = readScoreQuestion(question);
      if (built === null)
        return { ok: false, reasonCode: "QUESTIONS_INVALID", detail: "SCORE_INVALID" };
      questions.push(built);
    } else if (question.type === "predicate") {
      if (question.choices !== void 0 || question.levels !== void 0) {
        return {
          ok: false,
          reasonCode: "QUESTIONS_INVALID",
          detail: "PREDICATE_HAS_CHOICES_OR_LEVELS"
        };
      }
      questions.push({
        type: "predicate",
        name: question.name,
        instructions: question.instructions
      });
    } else {
      return { ok: false, reasonCode: "QUESTIONS_INVALID", detail: "QUESTION_TYPE_INVALID" };
    }
  }
  const request = {
    model: route.model,
    input: [{ type: "text", text: state }],
    questions
  };
  return { ok: true, request: Object.freeze(request) };
}
var JEV_DECISION_PRESETS = Object.freeze(["skills", "delegation"]);
function isJevDecisionPreset(value) {
  return typeof value === "string" && JEV_DECISION_PRESETS.includes(value);
}
var SPECIALIST_CHOICES = Object.freeze(
  PANTHEON_AGENT_CATALOG.filter((agent) => agent.id !== "zeus").map((agent) => {
    const description = boundedCatalogDescription(agent.description);
    return description === void 0 ? { value: agent.id } : { value: agent.id, description };
  })
);
function boundedCatalogDescription(value) {
  if (typeof value !== "string" || value.trim() === "") return void 0;
  return value.length > JEV_DECISION_MAX_DESCRIPTION_LENGTH ? `${value.slice(0, JEV_DECISION_MAX_DESCRIPTION_LENGTH - 1)}\u2026` : value;
}
var SKILL_DESCRIPTIONS = new Map(
  PANTHEON_SKILL_CATALOG.map((entry) => [entry.id, entry.description])
);
function choiceList(values, descriptions = SKILL_DESCRIPTIONS) {
  return values.map((value) => {
    const description = descriptions.get(value);
    return description ? { value, description: description.slice(0, JEV_DECISION_MAX_DESCRIPTION_LENGTH) } : { value };
  });
}
var CATALOG_SKILL_IDS = PANTHEON_SKILL_CATALOG.map((entry) => entry.id);
function mergeHostSkills(pool, hostSkills, descriptions) {
  const bound = JEV_DECISION_MAX_CHOICES - 1;
  const catalogBound = hostSkills === void 0 ? bound : Math.max(0, bound - hostSkills.length);
  const merged = [...pool].slice(0, catalogBound);
  const seen = new Set(merged);
  if (hostSkills !== void 0) {
    for (const skill of hostSkills) {
      if (merged.length >= bound) break;
      if (skill === null || typeof skill !== "object" || typeof skill.id !== "string" || skill.id.length === 0 || skill.id.length > JEV_DECISION_MAX_NAME_LENGTH || skill.id.trim() !== skill.id || seen.has(skill.id)) {
        continue;
      }
      seen.add(skill.id);
      merged.push(skill.id);
      if (typeof skill.description === "string" && skill.description.length > 0) {
        descriptions.set(skill.id, skill.description.slice(0, JEV_DECISION_MAX_DESCRIPTION_LENGTH));
      }
    }
  }
  return choiceList(merged, descriptions);
}
function prepareJevPresetRequest(route, mode, input, hostSkills) {
  if (input.questions !== void 0) return { ok: false, reasonCode: "PRESET_INVALID" };
  const state = input.state;
  if (!isBoundedNonBlankString(state, NATIVE_DECISION_MAX_PROMPT_LENGTH)) {
    return { ok: false, reasonCode: "STATE_INVALID" };
  }
  if (mode === "delegation") {
    const request2 = {
      model: route.model,
      input: [{ type: "text", text: state }],
      questions: [
        {
          type: "choice",
          name: "specialist",
          instructions: "Choose one listed specialist only when the described task clearly needs it; otherwise choose none. This is advisory only; nothing is dispatched.",
          choices: [
            ...SPECIALIST_CHOICES,
            { value: "none", description: "No specialist fits the described task." }
          ]
        }
      ]
    };
    return { ok: true, request: Object.freeze(request2) };
  }
  const hostHasSkills = Array.isArray(hostSkills) && hostSkills.length > 0;
  const candidateSource = hostHasSkills ? "host-skills" : "full-catalog";
  const pool = CATALOG_SKILL_IDS;
  const descriptions = new Map(PANTHEON_SKILL_CATALOG.map((entry) => [entry.id, entry.description]));
  const request = {
    model: route.model,
    input: [{ type: "text", text: state }],
    questions: [
      {
        type: "choice",
        name: "stack",
        instructions: "Choose the skills worth stacking for the described task, or none when none apply. This is advisory only; nothing is loaded or executed by this decision.",
        choices: [
          ...mergeHostSkills(pool, hostSkills, descriptions),
          { value: "none", description: "No skill stack fits the described task." }
        ]
      }
    ]
  };
  return { ok: true, request: Object.freeze(request), candidateSource };
}
function isUnitInterval(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function isNonNegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function answerForQuestion(answer, question) {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return null;
  const record2 = answer;
  if (record2.name !== question.name) return null;
  if (record2.type === "error") {
    if (typeof record2.reason !== "string" || record2.reason.length === 0) return null;
    return { type: "error", name: question.name, reason: record2.reason };
  }
  if (record2.type !== question.type) return null;
  if (question.type === "choice") {
    if (typeof record2.choice !== "string") return null;
    if (!question.choices.some((option) => option.value === record2.choice)) return null;
    return {
      type: "choice",
      name: question.name,
      choice: record2.choice,
      ...isUnitInterval(record2.confidence) ? { confidence: record2.confidence } : {}
    };
  }
  if (question.type === "score") {
    if (!isNonNegativeFinite(record2.score)) return null;
    return {
      type: "score",
      name: question.name,
      score: record2.score,
      ...isUnitInterval(record2.confidence) ? { confidence: record2.confidence } : {}
    };
  }
  if (!isUnitInterval(record2.probability)) return null;
  return { type: "predicate", name: question.name, probability: record2.probability };
}
function consumeJevDecisionResult(response, request) {
  const empty = {
    answers: [],
    missing: request.questions.map((question) => question.name),
    costUsd: null,
    tokens: null,
    effect: "none"
  };
  if (response === null || typeof response !== "object" || Array.isArray(response)) return empty;
  const record2 = response;
  if (!Array.isArray(record2.answers)) return empty;
  const answers = [];
  const missing = [];
  for (const question of request.questions) {
    const matches = record2.answers.map((candidate) => answerForQuestion(candidate, question)).filter((answer) => answer !== null);
    if (matches.length === 0) {
      missing.push(question.name);
      continue;
    }
    answers.push(
      matches.length === 1 ? matches[0] : {
        type: "error",
        name: question.name,
        reason: "DUPLICATE_ANSWER"
      }
    );
  }
  const costUsd = isNonNegativeFinite(record2.cost) ? record2.cost : null;
  let tokens = null;
  if (record2.tokens !== void 0 && record2.tokens !== null && typeof record2.tokens === "object" && !Array.isArray(record2.tokens)) {
    const usage = record2.tokens;
    tokens = {
      input: isNonNegativeFinite(usage.input) ? usage.input : null,
      output: isNonNegativeFinite(usage.output) ? usage.output : null
    };
  }
  return Object.freeze({
    answers: Object.freeze(answers),
    missing: Object.freeze(missing),
    costUsd,
    tokens,
    effect: "none"
  });
}

// src/pantheon/jev-quality-score.ts
var J4_QUALITY_SCORE_POINT = "J4";
var QUALITY_QUESTION_NAME = "quality";
var REVIEW_QUESTION_NAME = "needs_review";
var J4_MAX_CRITERIA = 4;
function normalizeJevCriterion(raw) {
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record2 = raw;
    if (record2.id !== void 0 && (typeof record2.id !== "string" || record2.id.length > 64)) {
      return null;
    }
    if (typeof record2.description === "string") return record2.description;
  }
  return null;
}
var J4_MIN_CRITERIA = 1;
var J4_CRITERIA_MAX_LENGTH = 120;
var J4_REVIEW_THRESHOLD = 0.5;
var J4_QUALITY_SCORE_STATE_MAX_LENGTH = 512;
var METRICS_MAX = 1e8;
var RESULT_KINDS = /* @__PURE__ */ new Set(["ok", "empty", "error"]);
var TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var QUALITY_LABELS = [
  "unusable",
  "poor",
  "weak",
  "fair",
  "adequate",
  "good",
  "strong",
  "excellent",
  "exemplary"
];
var QUALITY_INSTRUCTIONS_PREFIX = "Rate the quality of this delegated result against the criteria listed below; the criteria are required and the structural metrics in the state are context only. Judge the result itself, not the delegation that produced it. Advisory only; nothing is enforced.";
var REVIEW_INSTRUCTIONS = "Does this delegated result need human review before it is used? Answer as a probability: higher means review is more warranted. A yes is advisory only; it never blocks, retries, or alters the result.";
var PATH_PATTERN = /[/\\]/;
function hasControlCharacter4(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
var KEY_MATERIAL_PATTERNS = Object.freeze([
  /-----BEGIN/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\b[a-z0-9._-]+\.(?:key|pem|p12|pfx|kdbx)\b/i
]);
var CREDENTIAL_ASSIGNMENT_PATTERN = /\b(?:password|passwd|secret|token|api[-_]?key|credential)s?\s*[:=]\s*\S+/i;
function isRecord15(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isBoundedCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= METRICS_MAX;
}
function isHostileCriterion(criterion) {
  if (PATH_PATTERN.test(criterion)) return true;
  if (hasControlCharacter4(criterion)) return true;
  if (KEY_MATERIAL_PATTERNS.some((pattern) => pattern.test(criterion))) return true;
  return CREDENTIAL_ASSIGNMENT_PATTERN.test(criterion);
}
function buildQualityScoreRequest(input) {
  const record2 = isRecord15(input) ? input : void 0;
  const delegateId = record2?.delegateId;
  if (typeof delegateId !== "string" || !TOKEN_PATTERN.test(delegateId) || !PANTHEON_AGENTS.has(delegateId)) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  const resultSummaryKind = record2?.resultSummaryKind;
  if (typeof resultSummaryKind !== "string" || !RESULT_KINDS.has(resultSummaryKind)) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  const metrics = record2?.resultMetrics;
  if (!isRecord15(metrics)) return { ok: false, reasonCode: "INPUT_INVALID" };
  if (!isBoundedCount(metrics.outputChars)) return { ok: false, reasonCode: "INPUT_INVALID" };
  const taskDurationMs = metrics.taskDurationMs;
  if (taskDurationMs !== null && !isBoundedCount(taskDurationMs)) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  const criteria = record2?.criteria;
  if (!Array.isArray(criteria)) return { ok: false, reasonCode: "CRITERIA_INVALID" };
  if (criteria.length < J4_MIN_CRITERIA || criteria.length > J4_MAX_CRITERIA) {
    return { ok: false, reasonCode: "CRITERIA_INVALID" };
  }
  const normalized = [];
  for (const criterion of criteria) {
    const text2 = normalizeJevCriterion(criterion);
    if (text2 === null || text2.length < 1 || text2.length > J4_CRITERIA_MAX_LENGTH || text2.trim().length === 0 || isHostileCriterion(text2)) {
      return {
        ok: false,
        reasonCode: "CRITERIA_INVALID",
        detail: "CRITERIA_SHAPE \u2014 cada crit\xE9rio \xE9 uma string (1-120) ou {id?, description}"
      };
    }
    normalized.push(text2);
  }
  const state = `Advisory quality review of one delegated result. delegate: ${delegateId}. result_kind: ${resultSummaryKind}. output_chars: ${metrics.outputChars}. task_duration_ms: ${taskDurationMs === null ? "na" : String(taskDurationMs)}. criteria_count: ${criteria.length}. The result content never leaves this machine; the criteria are listed in the quality question; judge from the structural fields and the criteria alone.`;
  if (state.length > J4_QUALITY_SCORE_STATE_MAX_LENGTH) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  const qualityInstructions = QUALITY_INSTRUCTIONS_PREFIX + ` Criteria: ${normalized.map((criterion, index) => `(${index + 1}) ${criterion}`).join("; ")}.`;
  return {
    ok: true,
    request: Object.freeze({
      input: Object.freeze([Object.freeze({ type: "text", text: state })]),
      questions: Object.freeze([
        Object.freeze({
          type: "score",
          name: QUALITY_QUESTION_NAME,
          instructions: qualityInstructions,
          levels: Object.freeze(QUALITY_LABELS.map((label) => Object.freeze({ label })))
        }),
        Object.freeze({
          type: "predicate",
          name: REVIEW_QUESTION_NAME,
          instructions: REVIEW_INSTRUCTIONS
        })
      ])
    })
  };
}
function evaluateQualityScoreDecision(response, prepared) {
  const advice = consumeJevDecisionResult(response, prepared);
  let quality = null;
  let needsReview = null;
  for (const answer of advice.answers) {
    if (answer.type === "error") continue;
    if (answer.type === "score" && answer.name === QUALITY_QUESTION_NAME) {
      quality = answer.score ?? null;
    } else if (answer.type === "predicate" && answer.name === REVIEW_QUESTION_NAME) {
      needsReview = (answer.probability ?? 0) >= J4_REVIEW_THRESHOLD;
    }
  }
  return { quality, needsReview };
}
function qualityVerdict(input) {
  void input.quality;
  return input.needsReview === true ? "flag-for-review" : "recorded";
}
var REASON_TOKEN2 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
function formatScoreToken(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1e3) return "na";
  const text2 = String(Math.round(value * 100) / 100);
  return TOKEN_PATTERN.test(text2) ? text2 : "na";
}
function encodeQualityScoreReason(input) {
  const score = input.quality === null ? "na" : formatScoreToken(input.quality);
  const review = input.needsReview === null ? "na" : input.needsReview ? "yes" : "no";
  const reason = `q-${score}-review-${review}`;
  return REASON_TOKEN2.test(reason) ? reason : "invalid-reason";
}
var REVIEW_ENVELOPE_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "mode",
  "delegateId",
  "resultSummaryKind",
  "resultMetrics",
  "criteria"
]);
function buildJevReviewRequest(input) {
  if (!isRecord15(input)) return { ok: false, reasonCode: "REVIEW_INPUT_INVALID" };
  for (const key of Object.keys(input)) {
    if (!REVIEW_ENVELOPE_KEYS.has(key)) return { ok: false, reasonCode: "REVIEW_INPUT_INVALID" };
  }
  for (const key of ["delegateId", "resultSummaryKind", "resultMetrics", "criteria"]) {
    if (input[key] === void 0) return { ok: false, reasonCode: "REVIEW_INPUT_INVALID" };
  }
  const built = buildQualityScoreRequest({
    delegateId: input.delegateId,
    resultSummaryKind: input.resultSummaryKind,
    resultMetrics: input.resultMetrics,
    criteria: input.criteria
  });
  if (!built.ok) {
    return {
      ok: false,
      reasonCode: built.reasonCode === "CRITERIA_INVALID" ? "CRITERIA_INVALID" : "REVIEW_INPUT_INVALID"
    };
  }
  return { ok: true, request: built.request };
}

// src/pantheon/jev-rank-verify.ts
var RANK_MIN_CANDIDATES = 2;
var RANK_MAX_CANDIDATES = 20;
var RANK_WINNER_QUESTION_NAME = "winner";
var RANK_FIT_QUESTION_NAME = "fit";
var VERIFY_MIN_CLAIMS = 1;
var VERIFY_MAX_CLAIMS = 4;
var CLAIM_MAX_LENGTH = 200;
var VERIFY_PASS_THRESHOLD = 0.65;
var CANDIDATE_ID_MAX_LENGTH = 64;
var CLAIM_NAME_MAX_LENGTH = 64;
var DESCRIPTION_MAX_LENGTH = 500;
var TOKEN_PATTERN2 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var RANK_FIT_LABELS = Object.freeze([
  "unusable",
  "poor",
  "weak",
  "fair",
  "adequate",
  "good",
  "strong",
  "excellent",
  "exemplary"
]);
var WINNER_INSTRUCTIONS = "Choose the single best candidate from the listed options for the described state. Answer with exactly one candidate id. Advisory only; nothing is dispatched or executed.";
var FIT_INSTRUCTIONS = "Rate how well the candidate you chose as the best fits the described state. Higher means a better fit; judge from the state and the candidate descriptions alone. Advisory only; nothing is enforced.";
var VERIFY_STATE_TEMPLATE = "Advisory claim verification. Each claim is stated in its own question below; assess each claim on its own terms from the claim text alone. Nothing is enforced.";
var PATH_PATTERN2 = /[/\\]/;
function hasControlCharacter5(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
var KEY_MATERIAL_PATTERNS2 = Object.freeze([
  /-----BEGIN/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\b[a-z0-9._-]+\.(?:key|pem|p12|pfx|kdbx)\b/i
]);
var CREDENTIAL_ASSIGNMENT_PATTERN2 = /\b(?:password|passwd|secret|token|api[-_]?key|credential)s?\s*[:=]\s*\S+/i;
function isHostileProse(value) {
  if (PATH_PATTERN2.test(value)) return true;
  if (hasControlCharacter5(value)) return true;
  if (KEY_MATERIAL_PATTERNS2.some((pattern) => pattern.test(value))) return true;
  return CREDENTIAL_ASSIGNMENT_PATTERN2.test(value);
}
function isBoundedNonBlankString2(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function isRecord16(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var RANK_ENVELOPE_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "mode",
  "state",
  "candidates"
]);
function buildJevRankRequest(input) {
  if (!isRecord16(input)) return { ok: false, reasonCode: "RANK_INPUT_INVALID" };
  for (const key of Object.keys(input)) {
    if (!RANK_ENVELOPE_KEYS.has(key)) return { ok: false, reasonCode: "RANK_INPUT_INVALID" };
  }
  const state = input.state;
  if (!isBoundedNonBlankString2(state, NATIVE_DECISION_MAX_PROMPT_LENGTH)) {
    return { ok: false, reasonCode: "STATE_INVALID" };
  }
  const rawCandidates = input.candidates;
  if (rawCandidates === void 0) return { ok: false, reasonCode: "RANK_INPUT_INVALID" };
  if (!Array.isArray(rawCandidates)) return { ok: false, reasonCode: "CANDIDATE_INVALID" };
  if (rawCandidates.length < RANK_MIN_CANDIDATES || rawCandidates.length > RANK_MAX_CANDIDATES) {
    return { ok: false, reasonCode: "CANDIDATE_INVALID", detail: "RANK_CANDIDATE_COUNT_RANGE" };
  }
  const seen = /* @__PURE__ */ new Set();
  const choices = [];
  for (const raw of rawCandidates) {
    if (!isRecord16(raw)) return { ok: false, reasonCode: "CANDIDATE_INVALID" };
    const extraKeys = Object.keys(raw).filter((key) => key !== "id" && key !== "description");
    if (extraKeys.length > 0) return { ok: false, reasonCode: "CANDIDATE_INVALID" };
    const id = raw.id;
    if (typeof id !== "string" || id.length > CANDIDATE_ID_MAX_LENGTH || !TOKEN_PATTERN2.test(id) || seen.has(id)) {
      return { ok: false, reasonCode: "CANDIDATE_INVALID" };
    }
    seen.add(id);
    const description = raw.description;
    if (description === void 0) {
      choices.push({ value: id });
    } else if (isBoundedNonBlankString2(description, DESCRIPTION_MAX_LENGTH) && !isHostileProse(description)) {
      choices.push({ value: id, description });
    } else {
      return { ok: false, reasonCode: "CANDIDATE_INVALID" };
    }
  }
  const request = {
    input: Object.freeze([Object.freeze({ type: "text", text: state })]),
    questions: Object.freeze([
      Object.freeze({
        type: "choice",
        name: RANK_WINNER_QUESTION_NAME,
        instructions: WINNER_INSTRUCTIONS,
        choices: Object.freeze(choices.map((choice) => Object.freeze(choice)))
      }),
      Object.freeze({
        type: "score",
        name: RANK_FIT_QUESTION_NAME,
        instructions: FIT_INSTRUCTIONS,
        levels: Object.freeze(RANK_FIT_LABELS.map((label) => Object.freeze({ label })))
      })
    ])
  };
  return { ok: true, request: Object.freeze(request) };
}
var ORDER_ENVELOPE_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "mode",
  "state",
  "candidates"
]);
var ORDER_MAX_CANDIDATES = JEV_DECISION_MAX_QUESTIONS;
var ORDER_STATE_TEMPLATE = "Advisory ordering. The caller supplied a task and 2-4 candidates; each question scores ONE candidate for fit against the stated task. Score each candidate on its own terms. Nothing is enforced. The score is an ORDINAL on the 2..10 rubric (10 = exact fit), never a probability.";
function buildJevOrderRequest(input) {
  if (!isRecord16(input)) return { ok: false, reasonCode: "ORDER_INPUT_INVALID" };
  for (const key of Object.keys(input)) {
    if (!ORDER_ENVELOPE_KEYS.has(key)) return { ok: false, reasonCode: "ORDER_INPUT_INVALID" };
  }
  const state = input.state;
  if (!isBoundedNonBlankString2(state, NATIVE_DECISION_MAX_PROMPT_LENGTH) || isHostileProse(state)) {
    return { ok: false, reasonCode: "STATE_INVALID" };
  }
  const rawCandidates = input.candidates;
  if (rawCandidates === void 0) return { ok: false, reasonCode: "ORDER_INPUT_INVALID" };
  if (!Array.isArray(rawCandidates)) return { ok: false, reasonCode: "ORDER_CANDIDATE_INVALID" };
  if (rawCandidates.length < 2 || rawCandidates.length > ORDER_MAX_CANDIDATES) {
    return {
      ok: false,
      reasonCode: "ORDER_CANDIDATE_INVALID",
      detail: "ORDER_CANDIDATE_COUNT_RANGE"
    };
  }
  const seen = /* @__PURE__ */ new Set();
  const candidates = [];
  for (const raw of rawCandidates) {
    if (!isRecord16(raw)) return { ok: false, reasonCode: "ORDER_CANDIDATE_INVALID" };
    const extraKeys = Object.keys(raw).filter((key) => key !== "id" && key !== "description");
    if (extraKeys.length > 0) return { ok: false, reasonCode: "ORDER_CANDIDATE_INVALID" };
    const id = raw.id;
    if (typeof id !== "string" || id.length < 1 || id.length > 64) {
      return { ok: false, reasonCode: "ORDER_CANDIDATE_INVALID" };
    }
    if (seen.has(id)) return { ok: false, reasonCode: "ORDER_CANDIDATE_INVALID" };
    seen.add(id);
    const description = raw.description;
    if (description !== void 0) {
      if (!isBoundedNonBlankString2(description, 500) || isHostileProse(description)) {
        return { ok: false, reasonCode: "ORDER_CANDIDATE_INVALID" };
      }
      candidates.push({ id, description });
    } else {
      candidates.push({ id });
    }
  }
  const levels = Array.from({ length: 9 }, (_, index) => ({
    label: String(index + 2)
  }));
  const questions = candidates.map((candidate, index) => ({
    type: "score",
    name: `fit_${index + 1}`,
    instructions: `Score how well candidate "${candidate.id}"` + (candidate.description ? ` (${candidate.description})` : "") + ` fits the task. 2 = poor fit, 10 = exact fit.`,
    levels
  }));
  const request = {
    input: Object.freeze([
      Object.freeze({ type: "text", text: `${ORDER_STATE_TEMPLATE} Task: ${state}` })
    ]),
    questions: Object.freeze(questions.map((question) => Object.freeze(question)))
  };
  return {
    ok: true,
    request: Object.freeze(request),
    candidates: Object.freeze(candidates.map((c) => c.id))
  };
}
function consumeJevOrderResult(response, request, candidates) {
  const advice = consumeJevDecisionResult(response, request);
  const entries = [];
  request.questions.forEach((question, index) => {
    const answer = advice.answers.find((candidate) => candidate.name === question.name);
    const score = answer !== void 0 && answer.type === "score" && typeof answer.score === "number" ? answer.score : null;
    entries.push({ id: candidates[index] ?? `c${index + 1}`, score, order: index });
  });
  return Object.freeze(
    entries.sort((left, right) => {
      if (left.score === null && right.score === null) return left.order - right.order;
      if (left.score === null) return 1;
      if (right.score === null) return -1;
      return right.score - left.score || left.order - right.order;
    }).map(({ id, score }) => ({ id, score }))
  );
}
var VERIFY_ENVELOPE_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "mode",
  "claims",
  // Optional evidence: the environment/context the claims are judged against
  // (field report beta.13 §6 — without it, environment-dependent claims are
  // unanswerable and the honest verdict is UNVERIFIABLE, not FAIL).
  "state"
]);
var VERIFY_UNVERIFIABLE_LOW = 0.35;
function verifyInstructions(claim) {
  return `Assess the following claim on its own terms and answer the probability that it holds. Claim: "${claim}". Higher means the claim is more likely to hold. This is advisory verification; nothing is enforced.`;
}
function buildJevVerifyRequest(input) {
  if (!isRecord16(input)) return { ok: false, reasonCode: "VERIFY_INPUT_INVALID" };
  for (const key of Object.keys(input)) {
    if (!VERIFY_ENVELOPE_KEYS.has(key)) return { ok: false, reasonCode: "VERIFY_INPUT_INVALID" };
  }
  const rawClaims = input.claims;
  if (rawClaims === void 0) return { ok: false, reasonCode: "VERIFY_INPUT_INVALID" };
  if (!Array.isArray(rawClaims)) return { ok: false, reasonCode: "CLAIM_INVALID" };
  if (rawClaims.length < VERIFY_MIN_CLAIMS || rawClaims.length > VERIFY_MAX_CLAIMS) {
    return { ok: false, reasonCode: "CLAIM_INVALID" };
  }
  const seen = /* @__PURE__ */ new Set();
  const questions = [];
  for (const raw of rawClaims) {
    if (!isRecord16(raw)) return { ok: false, reasonCode: "CLAIM_INVALID" };
    const extraKeys = Object.keys(raw).filter((key) => key !== "name" && key !== "claim");
    if (extraKeys.length > 0) return { ok: false, reasonCode: "CLAIM_INVALID" };
    const name = raw.name;
    if (typeof name !== "string" || name.length > CLAIM_NAME_MAX_LENGTH || !TOKEN_PATTERN2.test(name) || seen.has(name)) {
      return { ok: false, reasonCode: "CLAIM_INVALID" };
    }
    const claim = raw.claim;
    if (!isBoundedNonBlankString2(claim, CLAIM_MAX_LENGTH) || isHostileProse(claim)) {
      return { ok: false, reasonCode: "CLAIM_INVALID" };
    }
    seen.add(name);
    questions.push({ type: "predicate", name, instructions: verifyInstructions(claim) });
  }
  const rawState = input.state;
  let evidence = VERIFY_STATE_TEMPLATE;
  if (rawState !== void 0) {
    if (!isBoundedNonBlankString2(rawState, NATIVE_DECISION_MAX_PROMPT_LENGTH) || isHostileProse(rawState)) {
      return { ok: false, reasonCode: "VERIFY_INPUT_INVALID" };
    }
    evidence = `${VERIFY_STATE_TEMPLATE} Evidence/context supplied by the caller, to be trusted as given: ${rawState}`;
  }
  const request = {
    input: Object.freeze([Object.freeze({ type: "text", text: evidence })]),
    questions: Object.freeze(questions.map((question) => Object.freeze(question)))
  };
  return { ok: true, request: Object.freeze(request) };
}
function consumeJevRankResult(response, request) {
  const advice = consumeJevDecisionResult(response, request);
  let winner = null;
  let winnerFit = null;
  for (const answer of advice.answers) {
    if (answer.type === "error") continue;
    if (answer.type === "choice" && answer.name === RANK_WINNER_QUESTION_NAME) {
      winner = answer.choice ?? null;
    } else if (answer.type === "score" && answer.name === RANK_FIT_QUESTION_NAME) {
      winnerFit = answer.score ?? null;
    }
  }
  return Object.freeze({ winner, winnerFit });
}
function consumeJevVerifyResult(response, request) {
  const advice = consumeJevDecisionResult(response, request);
  const verdicts = {};
  for (const question of request.questions) {
    const answer = advice.answers.find((candidate) => candidate.name === question.name);
    if (answer !== void 0 && answer.type === "predicate") {
      const probability = answer.probability ?? 0;
      verdicts[question.name] = probability > VERIFY_PASS_THRESHOLD ? "PASS" : probability >= VERIFY_UNVERIFIABLE_LOW ? "UNVERIFIABLE" : "FAIL";
    } else {
      verdicts[question.name] = "BLOCK";
    }
  }
  return Object.freeze(verdicts);
}

// src/pantheon/jev-risk-gate.ts
import { createHash as createHash3 } from "node:crypto";
var J1_RISK_GATE_FLAG_ENV = "PANTHEON_J1_RISK_SCORE";
var J1_RISK_GATE_POINT = "J1";
var J1_RISK_GATE_TIMEOUT_MS = 2e3;
var RISK_QUESTION_NAME = "risk";
var INTENT_QUESTION_NAME = "intent";
var J1_RISK_SCORE_LEVEL_COUNT = 5;
var J1_RISK_GATE_STATE_MAX_LENGTH = 512;
var RISK_GATE_INTENT_THRESHOLD = 0.5;
var FLAG_ON = /* @__PURE__ */ new Set(["1", "on", "true", "shadow"]);
var TOOL_NAME_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var SHA256_HEX = /^[0-9a-f]{64}$/;
var SCOPES = /* @__PURE__ */ new Set(["write", "execute", "read"]);
var EXECUTE_TOOLS = /* @__PURE__ */ new Set([
  "bash",
  "shell",
  "sh",
  "zsh",
  "fish",
  "powershell",
  "cmd",
  "webfetch"
]);
var WRITE_TOOLS = /* @__PURE__ */ new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "patch",
  "apply_patch",
  "hashline_edit"
]);
var J1_ENFORCE_THRESHOLD_ENV = "PANTHEON_J1_ENFORCE_THRESHOLD";
var J1_ENFORCE_THRESHOLD_DEFAULT = 0.8;
function j1ModeFromEnv(env = process.env) {
  const raw = (env[J1_RISK_GATE_FLAG_ENV] ?? "").trim().toLowerCase();
  if (raw === "enforce") return "enforce";
  if (raw === "warn") return "warn";
  return FLAG_ON.has(raw) ? "shadow" : "off";
}
function j1EnforceThresholdFromEnv(env = process.env) {
  const text2 = (env[J1_ENFORCE_THRESHOLD_ENV] ?? "").trim();
  if (text2 === "") return J1_ENFORCE_THRESHOLD_DEFAULT;
  const raw = Number(text2);
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return J1_ENFORCE_THRESHOLD_DEFAULT;
  return raw;
}
function classifyRiskGateScope(tool2) {
  if (typeof tool2 !== "string") return "read";
  const normalized = tool2.trim().toLowerCase();
  if (EXECUTE_TOOLS.has(normalized)) return "execute";
  if (WRITE_TOOLS.has(normalized)) return "write";
  return "read";
}
function isRiskGateTarget(tool2) {
  if (!secretScanApplies(tool2)) return false;
  const scope = classifyRiskGateScope(tool2);
  return scope === "write" || scope === "execute";
}
function hashToolInput(input) {
  let serialized;
  if (typeof input === "string") {
    serialized = input;
  } else {
    try {
      const json = JSON.stringify(input);
      serialized = json === void 0 ? String(input) : json;
    } catch {
      serialized = "unserializable-tool-input";
    }
  }
  return createHash3("sha256").update(serialized, "utf8").digest("hex");
}
var RISK_LEVELS = Object.freeze(
  Array.from({ length: J1_RISK_SCORE_LEVEL_COUNT }, (_, index) => {
    const labels = ["routine", "low", "moderate", "high", "critical"];
    return Object.freeze({ label: labels[index] ?? `level-${index}` });
  })
);
var RISK_INSTRUCTIONS = "Rate how risky this single tool call is for the current task, judging only the tool class: routine and reversible at the low end, destructive or exfiltrating at the high end. Advisory only; nothing is enforced.";
var INTENT_INSTRUCTIONS = "Is a call of this tool class plausibly consistent with continuing the current task? Answer as a probability. Advisory only; nothing is enforced.";
var QUESTIONS = Object.freeze([
  Object.freeze({
    type: "score",
    name: RISK_QUESTION_NAME,
    instructions: RISK_INSTRUCTIONS,
    levels: RISK_LEVELS
  }),
  Object.freeze({
    type: "predicate",
    name: INTENT_QUESTION_NAME,
    instructions: INTENT_INSTRUCTIONS
  })
]);
function buildRiskGateRequest(input) {
  const toolName = input?.toolName;
  const toolInputHash = input?.toolInputHash;
  const scope = input?.scope;
  if (scope === void 0 || typeof scope !== "string" || !SCOPES.has(scope)) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  if (typeof toolName !== "string" || !TOOL_NAME_TOKEN.test(toolName)) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  if (typeof toolInputHash !== "string" || !SHA256_HEX.test(toolInputHash)) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  const state = `Advisory risk probe for one tool call. tool_name: ${toolName}. scope: ${scope}. tool_input_sha256: ${toolInputHash}. The request carries no file paths, no tool arguments and no task content; judge from the tool class alone.`;
  if (state.length > J1_RISK_GATE_STATE_MAX_LENGTH) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  return {
    ok: true,
    request: Object.freeze({
      input: Object.freeze([Object.freeze({ type: "text", text: state })]),
      questions: QUESTIONS
    })
  };
}
function evaluateRiskGateDecision(response, request) {
  const advice = consumeJevDecisionResult(response, request);
  let riskScore = null;
  let intentConsistent = null;
  for (const answer of advice.answers) {
    if (answer.type === "error") continue;
    if (answer.type === "score" && answer.name === RISK_QUESTION_NAME) {
      riskScore = answer.score ?? null;
    } else if (answer.type === "predicate" && answer.name === INTENT_QUESTION_NAME) {
      intentConsistent = (answer.probability ?? 0) >= RISK_GATE_INTENT_THRESHOLD;
    }
  }
  return { riskScore, intentConsistent };
}
function formatScoreToken2(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1e3) return "na";
  const text2 = String(Math.round(value * 100) / 100);
  return TOOL_NAME_TOKEN.test(text2) ? text2 : "na";
}
function encodeRiskGateReason(input) {
  const score = input.riskScore === null ? "na" : formatScoreToken2(input.riskScore);
  const intent = input.intentConsistent === null ? "na" : input.intentConsistent ? "yes" : "no";
  return `risk-${score}-intent-${intent}`;
}
var SKIP_REASON_BY_GATE_FAILURE = Object.freeze({
  CONTEXT_UNAVAILABLE: "skip-context-unavailable",
  CONFIG_UNAVAILABLE: "skip-config-unavailable",
  DISABLED: "skip-config-disabled",
  CONSENT_MISSING: "skip-consent-missing",
  CAP_OR_PERIOD_DENIED: "skip-reservation-denied",
  NO_ELIGIBLE_CANDIDATE: "skip-route-unavailable",
  PERMISSION_UNAVAILABLE: "skip-permission-unavailable",
  PERMISSION_DENIED: "skip-permission-denied",
  STATE_INVALID: "skip-request-invalid",
  QUESTIONS_INVALID: "skip-request-invalid",
  PRESET_INVALID: "skip-request-invalid",
  RESERVATION_DENIED: "skip-reservation-denied",
  DECISION_CALL_FAILED: "skip-decision-call-failed",
  USAGE_EVIDENCE_UNAVAILABLE: "skip-usage-evidence-unavailable",
  USAGE_UNRECONCILED: "skip-usage-unreconciled",
  ORDER_INPUT_INVALID: "skip-request-invalid",
  ORDER_CANDIDATE_INVALID: "skip-request-invalid"
});
function mapGateFailureToSkipReason(reasonCode) {
  return SKIP_REASON_BY_GATE_FAILURE[reasonCode] ?? "skip-gate-unavailable";
}
function recordSkip(sink, skipReason) {
  observeShadow(
    J1_RISK_GATE_POINT,
    skipReason,
    () => ({
      decision: "unavailable",
      reason: skipReason
    }),
    sink
  );
}
function abortDeadline(signal) {
  return new Promise((resolve8) => {
    if (signal.aborted) {
      resolve8("timeout");
      return;
    }
    signal.addEventListener("abort", () => resolve8("timeout"), { once: true });
  });
}
function createJ1RiskGateObserver(options) {
  const timeoutMs = options.timeoutMs ?? J1_RISK_GATE_TIMEOUT_MS;
  const sink = options.sink;
  const enforce = options.mode === "enforce";
  const threshold = options.threshold ?? J1_ENFORCE_THRESHOLD_DEFAULT;
  return async (event) => {
    try {
      const payload = event ?? {};
      if (!isRiskGateTarget(payload.tool)) return void 0;
      const tool2 = payload.tool;
      const scope = classifyRiskGateScope(tool2);
      const built = buildRiskGateRequest({
        toolName: tool2,
        toolInputHash: hashToolInput(payload.input),
        scope
      });
      if (!built.ok) {
        recordSkip(sink, "skip-input-invalid");
        return void 0;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
      try {
        const outcome = await Promise.race([
          runGatedNativeJevCall({
            sessionID: payload.sessionID,
            messageID: payload.messageID,
            agent: typeof payload.agent === "string" ? payload.agent : void 0,
            runtime: options.runtime,
            prepare: (route) => ({
              ok: true,
              request: {
                model: route.model,
                input: built.request.input,
                questions: built.request.questions
              }
            })
          }),
          abortDeadline(controller.signal)
        ]);
        if (outcome === "timeout") {
          recordSkip(sink, "skip-timeout");
          return void 0;
        }
        if (!outcome.ok) {
          recordSkip(sink, mapGateFailureToSkipReason(outcome.reasonCode));
          return void 0;
        }
        const evaluation = evaluateRiskGateDecision(outcome.call.response, outcome.call.request);
        observeShadow(
          J1_RISK_GATE_POINT,
          evaluation,
          (isolated) => ({
            decision: "observe",
            reason: encodeRiskGateReason(isolated)
          }),
          sink
        );
        if (enforce) {
          const risk = evaluation.riskScore;
          const block = risk !== null && risk >= threshold;
          return {
            block,
            riskScore: risk,
            reason: block ? `J1 enforce: risco ${risk.toFixed(2)} >= threshold ${threshold}` : "allow"
          };
        }
        return;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      recordSkip(sink, "skip-gate-unavailable");
      return void 0;
    }
  };
}

// src/pantheon/local-decision-budget.ts
import { randomUUID } from "node:crypto";
import {
  chmodSync as chmodSync2,
  closeSync as closeSync2,
  existsSync as existsSync2,
  lstatSync as lstatSync4,
  mkdirSync as mkdirSync3,
  openSync as openSync2
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename, dirname as dirname4, isAbsolute as isAbsolute3, join as join6, parse as parse3, resolve as resolve3, sep as sep3 } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

// src/pantheon/local-decision-usage-evidence.internal.ts
var RESERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var UTC_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
var evidenceDetails = /* @__PURE__ */ new WeakMap();
function isNativeUsageProvider(value) {
  return value === "typesafe-jev" || value === "opencode-console" || value === "openrouter";
}
function verifyNativeUsageForReservation(bindingInput, result) {
  try {
    if (!isPlainRecord2(bindingInput) || !hasExactKeys3(bindingInput, ["model", "period", "provider", "reservationId"])) {
      return null;
    }
    const provider = bindingInput.provider;
    const model = bindingInput.model;
    const reservationId = bindingInput.reservationId;
    const period = bindingInput.period;
    if (typeof provider !== "string" || !isNativeUsageProvider(provider) || typeof model !== "string" || model.length === 0 || typeof reservationId !== "string" || !RESERVATION_ID.test(reservationId) || typeof period !== "string" || !UTC_PERIOD.test(period)) {
      return null;
    }
    if (!isPlainRecord2(result) || !Array.isArray(result.answers) || result.answers.length === 0 || !result.answers.every((answer) => isPlainRecord2(answer))) {
      return null;
    }
    let actualCostMicros = 0;
    if (result.cost !== void 0) {
      if (!isNonNegativeFinite2(result.cost)) return null;
      actualCostMicros = Math.round(result.cost * 1e6);
      if (!Number.isSafeInteger(actualCostMicros)) return null;
    }
    let inputTokens = 0;
    let outputTokens = 0;
    if (result.tokens !== void 0) {
      if (!isPlainRecord2(result.tokens)) return null;
      const { input, output } = result.tokens;
      if (input !== void 0 && !isNonNegativeFinite2(input) || output !== void 0 && !isNonNegativeFinite2(output)) {
        return null;
      }
      inputTokens = typeof input === "number" ? input : 0;
      outputTokens = typeof output === "number" ? output : 0;
    }
    const evidence = Object.freeze(/* @__PURE__ */ Object.create(null));
    evidenceDetails.set(
      evidence,
      Object.freeze({
        provider,
        model,
        inputTokens,
        outputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reservationId,
        period,
        actualCostMicros,
        pricingSnapshot: "host-reported"
      })
    );
    return evidence;
  } catch {
    return null;
  }
}
function getVerifiedUsageEvidenceDetails(value) {
  if (typeof value !== "object" && typeof value !== "function" || value === null) return null;
  return evidenceDetails.get(value) ?? null;
}
function isNonNegativeFinite2(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isPlainRecord2(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasExactKeys3(value, expectedKeys) {
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actualKeys.length === expected.length && actualKeys.every((key, index) => key === expected[index]);
}

// src/pantheon/local-decision-budget.ts
var SCHEMA_VERSION = 4;
var VERSION_TWO = 2;
var APPLICATION_ID = 1346522161;
var RELEASE_REASON_MAX_LENGTH = 200;
var DB_FILENAME = "decision-budget.sqlite";
var LOCAL_DECISION_BUDGET_PROVIDERS = Object.freeze([
  "openai-decisions",
  "typesafe-jev",
  "opencode-console",
  "openrouter",
  "vercel-ai-gateway",
  "cloudflare-workers-ai"
]);
var ALLOWED_PROVIDERS = new Set(LOCAL_DECISION_BUDGET_PROVIDERS);
var MODEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
var RESERVATION_ID2 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var CLOCK_ROLLBACK_TOLERANCE_MS = 6e4;
function resolveLocalDecisionBudgetDbPath(env = process.env) {
  const xdgStateHome = env.XDG_STATE_HOME;
  const home = env.HOME && isAbsolute3(env.HOME) ? env.HOME : homedir2();
  const base = xdgStateHome && isAbsolute3(xdgStateHome) ? xdgStateHome : join6(home, ".local", "state");
  return resolve3(base, "pantheon", DB_FILENAME);
}
function openLocalDecisionBudgetLedger(options = {}) {
  const dbPath = resolve3(options.dbPath ?? resolveLocalDecisionBudgetDbPath());
  if (["opencode.db", "install-state.json"].includes(basename(dbPath))) {
    throw new Error("The budget ledger must use its own SQLite database file");
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? 5e3;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 3e4) {
    throw new RangeError("Invalid SQLite busy timeout");
  }
  const wallClock = options.clock ?? Date.now;
  const monotonicClock = options.monotonicClock ?? performance.now.bind(performance);
  const reservationIdFactory = options.reservationIdFactory ?? randomUUID;
  const directoryPath = dirname4(dbPath);
  ensureTrustedDirectoryChain(directoryPath);
  try {
    const file = openSync2(dbPath, "wx", 384);
    closeSync2(file);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const fileStat = lstatSync4(dbPath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) {
    throw new Error("Budget ledger path is not a private regular file");
  }
  if (typeof process.getuid !== "function" || fileStat.uid !== process.getuid()) {
    throw new Error("Budget ledger file must be owned by the current user");
  }
  chmodSync2(dbPath, 384);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON;`);
    ensureSchema(db);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    validateSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  let previousWallClock;
  let previousMonotonicClock;
  const now = () => {
    const wall = wallClock();
    const monotonic = monotonicClock();
    if (!Number.isSafeInteger(wall) || wall < 0 || !Number.isFinite(new Date(wall).getTime())) {
      throw new Error("Invalid ledger wall clock");
    }
    if (!Number.isFinite(monotonic) || monotonic < 0) {
      throw new Error("Invalid ledger monotonic clock");
    }
    if (previousWallClock !== void 0 && previousMonotonicClock !== void 0) {
      const wallElapsed = wall - previousWallClock;
      const monotonicElapsed = monotonic - previousMonotonicClock;
      if (monotonicElapsed < 0 || wallElapsed < -CLOCK_ROLLBACK_TOLERANCE_MS || wallElapsed + CLOCK_ROLLBACK_TOLERANCE_MS < monotonicElapsed) {
        throw new Error("Untrusted wall-clock movement");
      }
    }
    previousWallClock = wall;
    previousMonotonicClock = monotonic;
    return wall;
  };
  function inImmediateTransaction(operation) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  function configureUserCaps(capsInput) {
    const caps = validateConfiguredCaps(capsInput);
    inImmediateTransaction(() => {
      const timestamp = now();
      db.prepare(
        `INSERT INTO user_caps (id, monthly_cap_micros, per_decision_cap_micros, updated_at_ms)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET monthly_cap_micros = excluded.monthly_cap_micros,
                                       per_decision_cap_micros = excluded.per_decision_cap_micros,
                                       updated_at_ms = excluded.updated_at_ms`
      ).run(caps.monthlyCapMicros, caps.perDecisionCapMicros, timestamp);
    });
  }
  function configureProviderCaps(provider, capsInput) {
    if (!isAllowedProvider(provider)) throw new TypeError("Invalid budget provider");
    const caps = validateConfiguredCaps(capsInput);
    inImmediateTransaction(() => {
      const timestamp = now();
      db.prepare(
        `INSERT INTO provider_caps (provider, monthly_cap_micros, per_decision_cap_micros, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET monthly_cap_micros = excluded.monthly_cap_micros,
                                             per_decision_cap_micros = excluded.per_decision_cap_micros,
                                             updated_at_ms = excluded.updated_at_ms`
      ).run(provider, caps.monthlyCapMicros, caps.perDecisionCapMicros, timestamp);
    });
  }
  function configureModelCaps(provider, model, capsInput) {
    if (!isAllowedProvider(provider)) throw new TypeError("Invalid budget provider");
    if (!isAllowedModel(model)) throw new TypeError("Invalid budget model key");
    const caps = validateConfiguredCaps(capsInput);
    inImmediateTransaction(() => {
      const timestamp = now();
      db.prepare(
        `INSERT INTO model_caps
           (provider, model, monthly_cap_micros, per_decision_cap_micros, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET
           monthly_cap_micros = excluded.monthly_cap_micros,
           per_decision_cap_micros = excluded.per_decision_cap_micros,
           updated_at_ms = excluded.updated_at_ms`
      ).run(provider, model, caps.monthlyCapMicros, caps.perDecisionCapMicros, timestamp);
    });
  }
  function getActiveBudgetPeriod() {
    const row = db.prepare("SELECT active_period_utc FROM ledger_state WHERE id = 1").get();
    if (!row || row.active_period_utc === null) return null;
    if (!isValidPeriod(row.active_period_utc))
      throw new Error("Invalid active period in budget ledger");
    return row.active_period_utc;
  }
  function confirmBudgetPeriod(expectedCurrentPeriod, targetPeriod) {
    if (expectedCurrentPeriod !== null && !isValidPeriod(expectedCurrentPeriod) || !isValidPeriod(targetPeriod)) {
      return { status: "denied", reason: "invalid-period" };
    }
    return inImmediateTransaction(() => {
      let wallPeriod;
      try {
        wallPeriod = periodFor(now());
      } catch {
        return { status: "denied", reason: "clock-untrusted" };
      }
      const activePeriod = getActiveBudgetPeriod();
      if (activePeriod !== expectedCurrentPeriod) {
        return { status: "denied", reason: "stale-current" };
      }
      if (activePeriod === null) {
        if (targetPeriod !== wallPeriod) {
          return { status: "denied", reason: "wall-clock-mismatch" };
        }
        db.prepare(
          `INSERT INTO ledger_state (id, active_period_utc) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET active_period_utc = excluded.active_period_utc`
        ).run(targetPeriod);
        return { status: "confirmed", activePeriod: targetPeriod };
      }
      if (targetPeriod < activePeriod) return { status: "denied", reason: "backwards" };
      if (targetPeriod === activePeriod) return { status: "denied", reason: "not-next-month" };
      if (nextPeriod(activePeriod) !== targetPeriod) {
        return { status: "denied", reason: "not-next-month" };
      }
      if (wallPeriod !== targetPeriod) {
        return { status: "denied", reason: "wall-clock-mismatch" };
      }
      db.prepare("UPDATE ledger_state SET active_period_utc = ? WHERE id = 1").run(targetPeriod);
      return { status: "confirmed", activePeriod: targetPeriod };
    });
  }
  function reserve(provider, model) {
    if (!isAllowedProvider(provider)) return { status: "denied", reason: "invalid-provider" };
    if (!isAllowedModel(model)) return { status: "denied", reason: "invalid-model" };
    return inImmediateTransaction(() => {
      const admission = checkAdmission(provider, model);
      if (admission.status === "denied") return admission;
      const reservationId = reservationIdFactory();
      if (typeof reservationId !== "string" || !RESERVATION_ID2.test(reservationId)) {
        throw new Error("Invalid generated reservation identifier");
      }
      const duplicate = db.prepare("SELECT 1 AS found FROM reservations WHERE id = ?").get(reservationId);
      if (duplicate) return { status: "denied", reason: "duplicate-reservation-id" };
      db.prepare(
        `INSERT INTO reservations
           (id, provider, model, period_utc, reserved_micros, actual_micros, state,
            created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?)`
      ).run(
        reservationId,
        provider,
        model,
        admission.period,
        admission.reservedMicros,
        admission.timestamp,
        admission.timestamp
      );
      return {
        status: "reserved",
        reservationId,
        period: admission.period,
        reservedMicros: admission.reservedMicros
      };
    });
  }
  function canReserve(provider, model) {
    if (!isAllowedProvider(provider)) return { status: "denied", reason: "invalid-provider" };
    if (!isAllowedModel(model)) return { status: "denied", reason: "invalid-model" };
    return inImmediateTransaction(() => {
      const admission = checkAdmission(provider, model);
      return admission.status === "denied" ? admission : { status: "eligible" };
    });
  }
  function checkAdmission(provider, model) {
    let timestamp;
    let wallPeriod;
    try {
      timestamp = now();
      wallPeriod = periodFor(timestamp);
    } catch {
      return { status: "denied", reason: "clock-untrusted" };
    }
    const userCaps = readUserCaps();
    const providerCaps = readProviderCaps(provider);
    const modelCaps = readModelCaps(provider, model);
    if (!hasPositiveCaps(userCaps) || !hasPositiveCaps(providerCaps) || !hasPositiveCaps(modelCaps)) {
      return { status: "denied", reason: "no-cap" };
    }
    const period = getActiveBudgetPeriod();
    if (period === null) return { status: "denied", reason: "period-unconfirmed" };
    if (wallPeriod !== period) return { status: "denied", reason: "period-mismatch" };
    const reservedMicros = modelCaps.per_decision_cap_micros;
    if (reservedMicros > userCaps.per_decision_cap_micros || reservedMicros > providerCaps.per_decision_cap_micros) {
      return { status: "denied", reason: "per-decision-cap" };
    }
    if (isFrozen(period, provider, model)) return { status: "denied", reason: "frozen" };
    if (wouldExceed(sumReservations(period), reservedMicros, userCaps.monthly_cap_micros) || wouldExceed(
      sumReservations(period, provider),
      reservedMicros,
      providerCaps.monthly_cap_micros
    ) || wouldExceed(
      sumReservations(period, provider, model),
      reservedMicros,
      modelCaps.monthly_cap_micros
    )) {
      return { status: "denied", reason: "monthly-cap" };
    }
    return { status: "eligible", period, reservedMicros, timestamp };
  }
  function reconcileVerified(reservationId, evidence) {
    if (typeof reservationId !== "string" || !RESERVATION_ID2.test(reservationId)) {
      return { status: "unknown" };
    }
    const verified = getVerifiedUsageEvidenceDetails(evidence);
    if (!verified || !Number.isSafeInteger(verified.actualCostMicros) || // Zero is a legitimate host-reported cost on the native route (the free
    // Console variant and hosts that do not price Decisions); reconciling at
    // zero releases the hold instead of burning the period's budget.
    verified.actualCostMicros < 0 || !isAllowedProvider(verified.provider) || !isAllowedModel(verified.model) || !isValidPeriod(verified.period)) {
      return { status: "unknown" };
    }
    return inImmediateTransaction(() => {
      const row = db.prepare(
        `SELECT provider, model, period_utc, reserved_micros, state
           FROM reservations WHERE id = ?`
      ).get(reservationId);
      if (!row) return { status: "missing" };
      if (row.state === "reconciled") return { status: "already-reconciled" };
      if (row.state !== "pending" && row.state !== "uncertain") {
        throw new Error("Invalid reservation state");
      }
      if (verified.reservationId !== reservationId || verified.provider !== row.provider || verified.model !== row.model || verified.period !== row.period_utc) {
        return { status: "mismatch" };
      }
      const timestamp = now();
      const update = db.prepare(
        `UPDATE reservations SET actual_micros = ?, state = 'reconciled', updated_at_ms = ?
           WHERE id = ? AND state IN ('pending', 'uncertain')`
      ).run(verified.actualCostMicros, timestamp, reservationId);
      if (safeChangeCount(update.changes) !== 1) {
        throw new Error("Reservation state changed unexpectedly");
      }
      const frozen = verified.actualCostMicros > row.reserved_micros;
      if (frozen) freezeBuckets(row.period_utc, row.provider, row.model, timestamp);
      return { status: "reconciled", actualCostMicros: verified.actualCostMicros, frozen };
    });
  }
  function sumReservations(period, provider, model) {
    const where = ["period_utc >= ?"];
    const params = [period];
    if (provider !== void 0) {
      where.push("provider = ?");
      params.push(provider);
    }
    if (model !== void 0) {
      where.push("model = ?");
      params.push(model);
    }
    const row = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN state = 'reconciled' THEN actual_micros ELSE reserved_micros END), 0) AS amount
         FROM reservations WHERE ${where.join(" AND ")}`
    ).get(...params);
    return safeMicrosTotal(row.amount);
  }
  function isFrozen(period, provider, model) {
    return Boolean(
      db.prepare(
        `SELECT 1 AS found FROM budget_freezes
           WHERE period_utc >= ? AND (
             (scope = 'user' AND provider IS NULL AND model IS NULL) OR
             (scope = 'provider' AND provider = ? AND model IS NULL) OR
             (scope = 'model' AND provider = ? AND model = ?)
           ) LIMIT 1`
      ).get(period, provider, provider, model)
    );
  }
  function freezeBuckets(period, provider, model, timestamp) {
    const insertIfMissing = db.prepare(
      `INSERT INTO budget_freezes (scope, provider, model, period_utc, reason, created_at_ms)
       VALUES (?, ?, ?, ?, 'overrun', ?)
       ON CONFLICT DO NOTHING`
    );
    insertIfMissing.run("user", null, null, period, timestamp);
    insertIfMissing.run("provider", provider, null, period, timestamp);
    insertIfMissing.run("model", provider, model, period, timestamp);
  }
  function listUncertainReservations() {
    const rows = db.prepare(
      `SELECT id, provider, model, period_utc, reserved_micros, state, created_at_ms, updated_at_ms
         FROM reservations WHERE state IN ('pending', 'uncertain') ORDER BY created_at_ms, id`
    ).all();
    return rows.map((row) => ({
      reservationId: row.id,
      provider: row.provider,
      model: row.model,
      period: row.period_utc,
      reservedMicros: row.reserved_micros,
      state: row.state,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms
    }));
  }
  function recoverPendingReservations() {
    return inImmediateTransaction(() => {
      const timestamp = now();
      const result = db.prepare(
        `UPDATE reservations SET state = 'uncertain', updated_at_ms = ? WHERE state = 'pending'`
      ).run(timestamp);
      return safeChangeCount(result.changes);
    });
  }
  function releaseHoldsForProvider(provider, reason) {
    if (typeof provider !== "string" || provider.length < 1 || provider.length > 64) {
      return { released: 0, freedMicros: 0 };
    }
    if (typeof reason !== "string" || reason.length < 1 || reason.length > RELEASE_REASON_MAX_LENGTH) {
      return { released: 0, freedMicros: 0 };
    }
    return inImmediateTransaction(() => {
      const timestamp = now();
      const rows = db.prepare(
        `SELECT id, provider, model, period_utc, reserved_micros, state, created_at_ms
           FROM reservations WHERE provider = ? AND state IN ('pending', 'uncertain')
           ORDER BY created_at_ms, id`
      ).all(provider);
      if (rows.length === 0) return { released: 0, freedMicros: 0 };
      const archive = db.prepare(
        `INSERT INTO released_holds
           (reservation_id, provider, model, period_utc, reserved_micros, state_at_release,
            reason, created_at_ms, released_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let freedMicros = 0;
      for (const row of rows) {
        archive.run(
          row.id,
          row.provider,
          row.model,
          row.period_utc,
          row.reserved_micros,
          row.state,
          reason,
          row.created_at_ms,
          timestamp
        );
        freedMicros = safeMicrosTotal(freedMicros + row.reserved_micros);
      }
      const remove = db.prepare(
        `DELETE FROM reservations WHERE provider = ? AND state IN ('pending', 'uncertain')`
      ).run(provider);
      if (safeChangeCount(remove.changes) !== rows.length) {
        throw new Error("Reservation rows changed during release");
      }
      return { released: rows.length, freedMicros };
    });
  }
  function listReleasedHolds(limit) {
    const bound = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20;
    const rows = db.prepare(
      `SELECT reservation_id, provider, model, period_utc, reserved_micros, state_at_release,
                reason, created_at_ms, released_at_ms
         FROM released_holds ORDER BY released_at_ms DESC, reservation_id LIMIT ?`
    ).all(bound);
    return rows.map((row) => ({
      reservationId: row.reservation_id,
      provider: row.provider,
      model: row.model,
      period: row.period_utc,
      reservedMicros: row.reserved_micros,
      stateAtRelease: row.state_at_release === "uncertain" ? "uncertain" : "pending",
      reason: row.reason,
      createdAtMs: row.created_at_ms,
      releasedAtMs: row.released_at_ms
    }));
  }
  function pruneCompletedPeriods() {
    return inImmediateTransaction(() => {
      let currentPeriod;
      try {
        currentPeriod = periodFor(now());
      } catch {
        return 0;
      }
      const activePeriod = getActiveBudgetPeriod();
      if (activePeriod === null || currentPeriod !== activePeriod) return 0;
      const result = db.prepare(
        `DELETE FROM reservations AS completed
           WHERE completed.period_utc < ? AND completed.state = 'reconciled'
             AND NOT EXISTS (
               SELECT 1 FROM reservations AS unresolved
               WHERE unresolved.period_utc = completed.period_utc
                 AND unresolved.state IN ('pending', 'uncertain')
             )`
      ).run(activePeriod);
      db.prepare(
        `DELETE FROM budget_freezes
         WHERE period_utc < ? AND NOT EXISTS (
           SELECT 1 FROM reservations AS unresolved
           WHERE unresolved.period_utc = budget_freezes.period_utc
             AND unresolved.state IN ('pending', 'uncertain')
         )`
      ).run(activePeriod);
      return safeChangeCount(result.changes);
    });
  }
  function readUserCaps() {
    return db.prepare("SELECT monthly_cap_micros, per_decision_cap_micros FROM user_caps WHERE id = 1").get();
  }
  function readProviderCaps(provider) {
    return db.prepare(
      "SELECT monthly_cap_micros, per_decision_cap_micros FROM provider_caps WHERE provider = ?"
    ).get(provider);
  }
  function readModelCaps(provider, model) {
    return db.prepare(
      `SELECT monthly_cap_micros, per_decision_cap_micros
         FROM model_caps WHERE provider = ? AND model = ?`
    ).get(provider, model);
  }
  return {
    configureUserCaps,
    configureProviderCaps,
    configureModelCaps,
    confirmBudgetPeriod,
    getActiveBudgetPeriod,
    canReserve,
    reserve,
    reconcileVerified,
    listUncertainReservations,
    recoverPendingReservations,
    releaseHoldsForProvider,
    listReleasedHolds,
    pruneCompletedPeriods,
    close: () => db.close()
  };
}
function ensureSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const applicationId = db.prepare("PRAGMA application_id").get().application_id;
    if (version === 0) {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      if (applicationId !== 0 || tables.length !== 0) {
        throw new Error("Refusing to initialize an unrecognized SQLite database");
      }
      createSchemaV4(db);
    } else if (version === 1 && applicationId === APPLICATION_ID) {
      migrateVersionOne(db);
      migrateVersionTwoToThree(db);
      migrateVersionThreeToFour(db);
    } else if (version === VERSION_TWO && applicationId === APPLICATION_ID) {
      migrateVersionTwoToThree(db);
      migrateVersionThreeToFour(db);
    } else if (version === 3 && applicationId === APPLICATION_ID) {
      migrateVersionThreeToFour(db);
    } else if (version !== SCHEMA_VERSION || applicationId !== APPLICATION_ID) {
      throw new Error("Unsupported or incompatible local decision budget database schema");
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw error;
  }
}
function createSchemaV3(db) {
  db.exec(`
    CREATE TABLE user_caps (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      monthly_cap_micros INTEGER NOT NULL CHECK (monthly_cap_micros >= 0),
      per_decision_cap_micros INTEGER NOT NULL CHECK (per_decision_cap_micros >= 0),
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE provider_caps (
      provider TEXT PRIMARY KEY NOT NULL,
      monthly_cap_micros INTEGER NOT NULL CHECK (monthly_cap_micros >= 0),
      per_decision_cap_micros INTEGER NOT NULL CHECK (per_decision_cap_micros >= 0),
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE model_caps (
      provider TEXT NOT NULL,
      model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
      monthly_cap_micros INTEGER NOT NULL CHECK (monthly_cap_micros >= 0),
      per_decision_cap_micros INTEGER NOT NULL CHECK (per_decision_cap_micros >= 0),
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (provider, model)
    ) STRICT;
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
      period_utc TEXT NOT NULL CHECK (length(period_utc) = 7),
      reserved_micros INTEGER NOT NULL CHECK (reserved_micros > 0),
      actual_micros INTEGER CHECK (actual_micros IS NULL OR actual_micros >= 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'uncertain', 'reconciled')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      CHECK ((state = 'reconciled' AND actual_micros IS NOT NULL) OR
             (state IN ('pending', 'uncertain') AND actual_micros IS NULL))
    ) STRICT;
    CREATE INDEX reservations_provider_period_idx ON reservations (provider, period_utc, state);
    CREATE INDEX reservations_model_period_idx
      ON reservations (provider, model, period_utc, state);
    CREATE INDEX reservations_period_state_idx ON reservations (period_utc, state);
    CREATE INDEX reservations_state_created_idx ON reservations (state, created_at_ms, id);
    CREATE TABLE ledger_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_period_utc TEXT CHECK (active_period_utc IS NULL OR length(active_period_utc) = 7)
    ) STRICT;
    CREATE TABLE budget_freezes (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('user', 'provider', 'model')),
      provider TEXT,
      model TEXT,
      period_utc TEXT NOT NULL CHECK (length(period_utc) = 7),
      reason TEXT NOT NULL CHECK (reason = 'overrun'),
      created_at_ms INTEGER NOT NULL,
      CHECK ((scope = 'user' AND provider IS NULL AND model IS NULL) OR
             (scope = 'provider' AND provider IS NOT NULL AND model IS NULL) OR
             (scope = 'model' AND provider IS NOT NULL AND model IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX budget_freezes_unique_idx
      ON budget_freezes (scope, ifnull(provider, ''), ifnull(model, ''), period_utc);
    CREATE INDEX budget_freezes_period_scope_idx
      ON budget_freezes (period_utc, scope, provider, model);
    PRAGMA application_id = ${APPLICATION_ID};
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}
function migrateVersionTwoToThree(db) {
  validateVersionTwoSchema(db);
  db.exec(`
    UPDATE reservations SET
      reserved_micros = CASE
        WHEN actual_micros > reserved_micros THEN actual_micros
        ELSE reserved_micros
      END,
      state = 'uncertain', actual_micros = NULL
      WHERE state = 'reconciled';
    ALTER TABLE ledger_state RENAME TO ledger_state_v2;
    CREATE TABLE ledger_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_period_utc TEXT CHECK (active_period_utc IS NULL OR length(active_period_utc) = 7)
    ) STRICT;
    INSERT INTO ledger_state (id, active_period_utc)
      SELECT id, NULL FROM ledger_state_v2;
    DROP TABLE ledger_state_v2;
    PRAGMA user_version = 3;
  `);
}
function migrateVersionThreeToFour(db) {
  validateVersionThreeSchema(db);
  db.exec(`
    CREATE TABLE released_holds (
      reservation_id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      period_utc TEXT NOT NULL CHECK (length(period_utc) = 7),
      reserved_micros INTEGER NOT NULL CHECK (reserved_micros > 0),
      state_at_release TEXT NOT NULL CHECK (state_at_release IN ('pending', 'uncertain')),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND ${RELEASE_REASON_MAX_LENGTH}),
      created_at_ms INTEGER NOT NULL,
      released_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX released_holds_released_idx ON released_holds (released_at_ms, reservation_id);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}
function createSchemaV4(db) {
  createSchemaV3(db);
  migrateVersionThreeToFour(db);
}
function validateVersionThreeSchema(db) {
  db.prepare(
    `SELECT id, provider, model, period_utc, reserved_micros, actual_micros, state,
            created_at_ms, updated_at_ms FROM reservations LIMIT 0`
  );
  db.prepare("SELECT id, active_period_utc FROM ledger_state LIMIT 0");
}
function migrateVersionOne(db) {
  validateVersionOneSchema(db);
  const providers = db.prepare("SELECT DISTINCT provider FROM reservations UNION SELECT provider FROM provider_caps").all();
  if (providers.some(({ provider }) => provider !== "openai-decisions" && provider !== "jev")) {
    throw new Error("Refusing to migrate an unsupported version-one provider");
  }
  db.exec(`
    ALTER TABLE reservations
      ADD COLUMN model TEXT NOT NULL DEFAULT 'legacy-unknown'
      CHECK (length(model) BETWEEN 1 AND 128);
    UPDATE reservations SET model = 'gpt-6-luna' WHERE provider = 'openai-decisions';
    UPDATE reservations SET provider = 'typesafe-jev', model = 'jev-1.14.0' WHERE provider = 'jev';
    UPDATE provider_caps SET provider = 'typesafe-jev' WHERE provider = 'jev';
    CREATE TABLE user_caps (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      monthly_cap_micros INTEGER NOT NULL CHECK (monthly_cap_micros >= 0),
      per_decision_cap_micros INTEGER NOT NULL CHECK (per_decision_cap_micros >= 0),
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE model_caps (
      provider TEXT NOT NULL,
      model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
      monthly_cap_micros INTEGER NOT NULL CHECK (monthly_cap_micros >= 0),
      per_decision_cap_micros INTEGER NOT NULL CHECK (per_decision_cap_micros >= 0),
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (provider, model)
    ) STRICT;
    CREATE INDEX reservations_model_period_idx
      ON reservations (provider, model, period_utc, state);
    CREATE INDEX reservations_state_created_idx ON reservations (state, created_at_ms, id);
    CREATE TABLE budget_freezes (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('user', 'provider', 'model')),
      provider TEXT,
      model TEXT,
      period_utc TEXT NOT NULL CHECK (length(period_utc) = 7),
      reason TEXT NOT NULL CHECK (reason = 'overrun'),
      created_at_ms INTEGER NOT NULL,
      CHECK ((scope = 'user' AND provider IS NULL AND model IS NULL) OR
             (scope = 'provider' AND provider IS NOT NULL AND model IS NULL) OR
             (scope = 'model' AND provider IS NOT NULL AND model IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX budget_freezes_unique_idx
      ON budget_freezes (scope, ifnull(provider, ''), ifnull(model, ''), period_utc);
    CREATE INDEX budget_freezes_period_scope_idx
      ON budget_freezes (period_utc, scope, provider, model);
    PRAGMA user_version = ${VERSION_TWO};
  `);
}
function validateVersionOneSchema(db) {
  db.prepare(
    `SELECT provider, monthly_cap_micros, per_decision_cap_micros, updated_at_ms
     FROM provider_caps LIMIT 0`
  );
  db.prepare(
    `SELECT id, provider, period_utc, reserved_micros, actual_micros, state,
            created_at_ms, updated_at_ms FROM reservations LIMIT 0`
  );
  db.prepare("SELECT id, highest_period_utc, last_seen_ms FROM ledger_state LIMIT 0");
}
function validateVersionTwoSchema(db) {
  db.prepare(
    "SELECT id, monthly_cap_micros, per_decision_cap_micros, updated_at_ms FROM user_caps LIMIT 0"
  );
  db.prepare(
    "SELECT provider, monthly_cap_micros, per_decision_cap_micros, updated_at_ms FROM provider_caps LIMIT 0"
  );
  db.prepare(
    "SELECT provider, model, monthly_cap_micros, per_decision_cap_micros, updated_at_ms FROM model_caps LIMIT 0"
  );
  db.prepare(
    `SELECT id, provider, model, period_utc, reserved_micros, actual_micros, state,
            created_at_ms, updated_at_ms FROM reservations LIMIT 0`
  );
  db.prepare("SELECT id, highest_period_utc, last_seen_ms FROM ledger_state LIMIT 0");
  db.prepare(
    "SELECT id, scope, provider, model, period_utc, reason, created_at_ms FROM budget_freezes LIMIT 0"
  );
}
function validateSchema(db) {
  db.prepare(
    `SELECT id, monthly_cap_micros, per_decision_cap_micros, updated_at_ms FROM user_caps LIMIT 0`
  );
  db.prepare(
    `SELECT provider, monthly_cap_micros, per_decision_cap_micros, updated_at_ms
     FROM provider_caps LIMIT 0`
  );
  db.prepare(
    `SELECT provider, model, monthly_cap_micros, per_decision_cap_micros, updated_at_ms
     FROM model_caps LIMIT 0`
  );
  db.prepare(
    `SELECT id, provider, model, period_utc, reserved_micros, actual_micros, state,
            created_at_ms, updated_at_ms FROM reservations LIMIT 0`
  );
  db.prepare("SELECT id, active_period_utc FROM ledger_state LIMIT 0");
  db.prepare(
    `SELECT id, scope, provider, model, period_utc, reason, created_at_ms
     FROM budget_freezes LIMIT 0`
  );
}
function validateConfiguredCaps(value) {
  if (!isPlainRecord3(value)) throw new TypeError("Caps must be an object");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "monthlyCapMicros,perDecisionCapMicros") {
    throw new TypeError("Caps must contain only monthly and per-decision values");
  }
  if (!isValidCap(value.monthlyCapMicros) || !isValidCap(value.perDecisionCapMicros)) {
    throw new TypeError("Caps must be non-negative safe integer USD micros");
  }
  return {
    monthlyCapMicros: value.monthlyCapMicros,
    perDecisionCapMicros: value.perDecisionCapMicros
  };
}
function isPlainRecord3(value) {
  try {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}
function isAllowedProvider(provider) {
  return typeof provider === "string" && ALLOWED_PROVIDERS.has(provider);
}
function isAllowedModel(model) {
  return typeof model === "string" && MODEL_KEY.test(model);
}
function isValidCap(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function hasPositiveCaps(value) {
  return Boolean(
    value && isValidCap(value.monthly_cap_micros) && value.monthly_cap_micros > 0 && isValidCap(value.per_decision_cap_micros) && value.per_decision_cap_micros > 0
  );
}
function wouldExceed(current, additional, cap) {
  return current > cap || additional > cap - current;
}
function safeMicrosTotal(value) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
      throw new Error("Invalid spend total in budget ledger");
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid spend total in budget ledger");
  }
  return value;
}
function periodFor(timestamp) {
  const period = new Date(timestamp).toISOString().slice(0, 7);
  if (!isValidPeriod(period)) throw new Error("Invalid UTC accounting period");
  return period;
}
function isValidPeriod(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
function nextPeriod(period) {
  if (!isValidPeriod(period)) return null;
  let year = Number(period.slice(0, 4));
  let month = Number(period.slice(5, 7)) + 1;
  if (month === 13) {
    year += 1;
    month = 1;
  }
  if (year > 9999) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}
function safeChangeCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid SQLite change count");
  return count;
}
function ensureTrustedDirectoryChain(directoryPath) {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    throw new Error("Secure budget-ledger path validation is unavailable on this platform");
  }
  const uid = process.getuid();
  const absolute = resolve3(directoryPath);
  const root = parse3(absolute).root;
  let current = root;
  validateDirectoryTrust(lstatSync4(current), uid, current === absolute);
  for (const component of absolute.slice(root.length).split(sep3).filter(Boolean)) {
    current = join6(current, component);
    try {
      lstatSync4(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        mkdirSync3(current, { mode: 448 });
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
    }
    const stat2 = lstatSync4(current);
    const isFinalDirectory = current === absolute;
    validateDirectoryTrust(stat2, uid, isFinalDirectory);
    if (isFinalDirectory) {
      chmodSync2(current, 448);
      validateDirectoryTrust(lstatSync4(current), uid, true);
    }
  }
}
function isPermittedGroupWritable2(env = process.env) {
  if (env.PANTHEON_ALLOW_GROUP_WRITABLE === "1" || env.PANTHEON_ALLOW_GROUP_WRITABLE === "true") {
    return true;
  }
  if (env.JUPYTERHUB_USER || env.JUPYTER_IMAGE || env.JUPYTER_SERVER_ROOT || env.KUBERNETES_SERVICE_HOST || env.container || existsSync2("/.dockerenv")) {
    return true;
  }
  return false;
}
function validateDirectoryTrust(stat2, uid, isFinalDirectory) {
  if (!stat2.isDirectory() || stat2.isSymbolicLink()) {
    throw new Error("Budget ledger path contains a non-directory or symlink ancestor");
  }
  const mode = stat2.mode & 4095;
  const isSticky = (mode & 512) !== 0;
  const isSystemOrUser = stat2.uid === uid || stat2.uid === 0 || isSticky && stat2.uid === 65534;
  if (!isSystemOrUser) {
    throw new Error("Budget ledger path contains an untrusted owner");
  }
  if (isFinalDirectory && stat2.uid !== uid) {
    throw new Error("Budget ledger directory must be owned by the current user");
  }
  const worldWritable = (mode & 2) !== 0;
  const groupWritable = (mode & 16) !== 0;
  if (worldWritable && !isSticky) {
    throw new Error("Budget ledger path contains a group/other-writable directory");
  }
  if (groupWritable && !isSticky && !isFinalDirectory && !isPermittedGroupWritable2()) {
    throw new Error("Budget ledger path contains a group/other-writable directory");
  }
}

// src/pantheon/local-decision-egress-gate.ts
var DECISION_EGRESS_ACTION = "decision.egress";
var DECISION_EGRESS_SOURCE_PREFIX = "pantheon-decision:";
function nonEmptyString2(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length === 0 ? void 0 : trimmed;
}
function decisionPermissionSource(sessionID, messageID) {
  return {
    type: "tool",
    id: `${DECISION_EGRESS_SOURCE_PREFIX}${sessionID}:${messageID}`,
    messageID
  };
}
function buildDecisionEgressRequest(input) {
  const request = {
    sessionID: input.sessionID,
    action: DECISION_EGRESS_ACTION,
    resources: [input.endpoint],
    save: [],
    source: decisionPermissionSource(input.sessionID, input.messageID)
  };
  const agent = nonEmptyString2(input.agent);
  if (agent !== void 0) request.agent = agent;
  return request;
}
var DENIAL_VALUES = /* @__PURE__ */ new Set(["deny", "denied", "reject", "rejected", "blocked"]);
var DENIAL_PATTERN = /permission\s+denied|not\s+allowed|forbidden|(?<!not\s)blocked/i;
function isDecisionAssertionDenial(result) {
  if (result === false) return true;
  if (typeof result === "string") {
    return DENIAL_VALUES.has(result.trim().toLowerCase()) || DENIAL_PATTERN.test(result);
  }
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const record2 = result;
  if (record2.denied === true || record2.allowed === false || record2.ok === false) return true;
  for (const key of ["effect", "decision", "status", "result"]) {
    const value = record2[key];
    if (typeof value === "string" && DENIAL_VALUES.has(value.trim().toLowerCase())) return true;
  }
  for (const key of ["message", "error"]) {
    const value = record2[key];
    if (typeof value === "string" && DENIAL_PATTERN.test(value)) return true;
  }
  return false;
}
async function assertDecisionEgressPermission(permissionAssert, request) {
  let result;
  try {
    result = await permissionAssert(request);
  } catch {
    return "deny";
  }
  return isDecisionAssertionDenial(result) ? "deny" : "allow";
}

// src/pantheon/jev-decision-tool.ts
function nativeJevPermissionResource(providerID, id) {
  return `pantheon-native-decisions://${providerID}/${id}`;
}
function specialistCallerAllowlist(flagValue) {
  const raw = String(flagValue ?? "").trim();
  if (!raw) return [];
  const parsed = raw.split(",").map((name) => name.trim()).filter((name) => /^[a-z][a-z0-9-]{0,31}$/.test(name));
  return [...new Set(parsed)];
}
function refusal3(reasonCode, detail) {
  return JSON.stringify(
    detail === void 0 ? { advisory: false, effect: "none", reasonCode } : { advisory: false, effect: "none", reasonCode, detail }
  );
}
function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function reviewRefusalSkipReason(reasonCode) {
  if (reasonCode === "REVIEW_INPUT_INVALID") return "skip-review-input-invalid";
  if (reasonCode === "CRITERIA_INVALID") return "skip-criteria-invalid";
  return mapGateFailureToSkipReason(reasonCode);
}
async function runGatedNativeJevCall(params) {
  if (!isNonBlankString(params.sessionID) || !isNonBlankString(params.messageID)) {
    return { ok: false, reasonCode: "CONTEXT_UNAVAILABLE" };
  }
  const sessionID = params.sessionID;
  const messageID = params.messageID;
  const agent = typeof params.agent === "string" && params.agent.trim().length > 0 ? params.agent : void 0;
  let config;
  try {
    config = readUserDecisionRouterConfig();
  } catch (error) {
    const detail = error instanceof Error && error.message.includes("group-writable") ? "CONFIG_PATH_GROUP_WRITABLE" : error instanceof Error ? error.name : "ConfigError";
    return { ok: false, reasonCode: "CONFIG_UNAVAILABLE", detail };
  }
  if (!config.enabled) return { ok: false, reasonCode: "DISABLED" };
  if (!config.egress_consent) return { ok: false, reasonCode: "CONSENT_MISSING" };
  const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() });
  try {
    const selection = resolveNativeJevRoute(
      config,
      (provider, model) => ledger.canReserve(provider, model).status === "eligible"
    );
    if (!selection.ok) return { ok: false, reasonCode: selection.reasonCode };
    if (selection.selection.provider === "cloudflare-workers-jev") {
      return { ok: false, reasonCode: "USAGE_EVIDENCE_UNAVAILABLE" };
    }
    if (typeof params.runtime.permissionAssert !== "function") {
      return { ok: false, reasonCode: "PERMISSION_UNAVAILABLE" };
    }
    const assertion = await assertDecisionEgressPermission(
      params.runtime.permissionAssert,
      buildDecisionEgressRequest({
        sessionID,
        messageID,
        endpoint: nativeJevPermissionResource(
          selection.selection.route.model.providerID,
          selection.selection.route.model.id
        ),
        ...agent === void 0 ? {} : { agent }
      })
    );
    if (assertion === "deny") return { ok: false, reasonCode: "PERMISSION_DENIED" };
    const prepared = await params.prepare(selection.selection.route);
    if (!prepared.ok) return { ok: false, reasonCode: prepared.reasonCode };
    const reservation = ledger.reserve(
      selection.selection.accountingProvider,
      selection.selection.model
    );
    if (reservation.status !== "reserved") return { ok: false, reasonCode: "RESERVATION_DENIED" };
    let response;
    try {
      response = await params.runtime.decide(prepared.request);
    } catch (err) {
      const failure = {
        ok: false,
        reasonCode: "DECISION_CALL_FAILED",
        detail: err instanceof Error ? err.name : "UnknownFailure"
      };
      const errRecord = err;
      if (typeof errRecord.reason === "string" && /^[a-z_]{1,32}$/i.test(errRecord.reason)) {
        failure.providerReason = errRecord.reason;
      }
      if (typeof errRecord.status === "number" && Number.isInteger(errRecord.status)) {
        failure.status = errRecord.status;
      }
      if (typeof errRecord.retryAfterMs === "number" && Number.isFinite(errRecord.retryAfterMs) && errRecord.retryAfterMs > 0) {
        failure.retryAfterMs = Math.round(errRecord.retryAfterMs);
      }
      return failure;
    }
    const evidence = verifyNativeUsageForReservation(
      {
        reservationId: reservation.reservationId,
        provider: selection.selection.accountingProvider,
        model: selection.selection.model,
        period: reservation.period
      },
      response
    );
    if (evidence === null) return { ok: false, reasonCode: "USAGE_UNRECONCILED" };
    const reconciliation = ledger.reconcileVerified(reservation.reservationId, evidence);
    if (reconciliation.status !== "reconciled") {
      return { ok: false, reasonCode: "USAGE_UNRECONCILED" };
    }
    return {
      ok: true,
      call: {
        selection: selection.selection,
        request: prepared.request,
        response,
        frozen: reconciliation.frozen
      }
    };
  } finally {
    ledger.close();
  }
}
async function readHostSkills(runtime) {
  if (typeof runtime.listSkills !== "function") return void 0;
  let raw;
  try {
    raw = await runtime.listSkills();
  } catch {
    return void 0;
  }
  if (!Array.isArray(raw)) return void 0;
  const skills = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record2 = entry;
    if (typeof record2.id !== "string" || record2.id.length === 0) continue;
    skills.push({
      id: record2.id,
      ...typeof record2.description === "string" && record2.description.length > 0 ? { description: record2.description } : {}
    });
  }
  return skills;
}
async function runJevDecision(input, toolContext2, runtime) {
  const context = toolContext2 !== null && typeof toolContext2 === "object" && !Array.isArray(toolContext2) ? toolContext2 : void 0;
  const caller = context?.agent;
  if (typeof caller !== "string" || caller.length === 0)
    return refusal3("CALLER_NOT_ALLOWED", "CALLER_NOT_ALLOWLISTED");
  const allowlist = runtime.specialistCallers ?? [];
  if (caller !== "zeus" && !allowlist.includes(caller)) {
    return refusal3(
      "CALLER_NOT_ALLOWED",
      "CALLER_NOT_ALLOWLISTED \u2014 allowlist this caller via PANTHEON_JEV_SPECIALIST_CALLERS (then restart) or ask Zeus to route"
    );
  }
  const requested = input ?? {};
  if (caller !== "zeus" && requested.mode !== void 0) {
    return refusal3("CALLER_NOT_ALLOWED");
  }
  const envelopeKeys = requested.mode === void 0 ? JEV_EXPLICIT_ENVELOPE_KEYS : requested.mode === "review" ? REVIEW_ENVELOPE_KEYS : requested.mode === "rank" ? RANK_ENVELOPE_KEYS : requested.mode === "verify" ? VERIFY_ENVELOPE_KEYS : requested.mode === "order" ? ORDER_ENVELOPE_KEYS : isJevDecisionPreset(requested.mode) ? JEV_PRESET_ENVELOPE_KEYS : void 0;
  if (envelopeKeys !== void 0) {
    const envelope = checkJevEnvelope(input, envelopeKeys);
    if (!envelope.ok) {
      const reasonCode = requested.mode === void 0 ? "QUESTIONS_INVALID" : requested.mode === "review" ? "REVIEW_INPUT_INVALID" : requested.mode === "rank" ? "RANK_INPUT_INVALID" : requested.mode === "verify" ? "VERIFY_INPUT_INVALID" : requested.mode === "order" ? "ORDER_INPUT_INVALID" : "PRESET_INVALID";
      return refusal3(reasonCode, envelope.detail);
    }
  }
  let prebuilt;
  let candidateSource;
  let orderCandidates = [];
  let verifyEvidenceUsed;
  if (requested.mode === "review") {
    const prepared = buildJevReviewRequest(input ?? {});
    if (!prepared.ok) {
      observeShadow(
        J4_QUALITY_SCORE_POINT,
        prepared.reasonCode,
        () => ({
          decision: "unavailable",
          reason: reviewRefusalSkipReason(prepared.reasonCode)
        }),
        runtime.shadowSink
      );
      return refusal3(prepared.reasonCode);
    }
    prebuilt = prepared.request;
  } else if (requested.mode === "rank") {
    const prepared = buildJevRankRequest(input ?? {});
    if (!prepared.ok) return refusal3(prepared.reasonCode, prepared.detail);
    prebuilt = prepared.request;
  } else if (requested.mode === "verify") {
    const prepared = buildJevVerifyRequest(input ?? {});
    if (!prepared.ok) return refusal3(prepared.reasonCode);
    verifyEvidenceUsed = prepared.request.input[0]?.text?.includes("Evidence/context supplied by the caller");
    prebuilt = prepared.request;
  } else if (requested.mode === "order") {
    const prepared = buildJevOrderRequest(input ?? {});
    if (!prepared.ok) return refusal3(prepared.reasonCode, prepared.detail);
    orderCandidates = prepared.candidates;
    prebuilt = prepared.request;
  }
  const result = await runGatedNativeJevCall({
    sessionID: context?.sessionID,
    messageID: context?.messageID,
    agent: caller,
    runtime,
    prepare: async (route) => prebuilt !== void 0 ? {
      ok: true,
      request: {
        model: route.model,
        input: prebuilt.input,
        questions: prebuilt.questions
      }
    } : requested.mode === void 0 ? prepareJevDecisionRequest(route, input ?? {}) : isJevDecisionPreset(requested.mode) ? (async () => {
      const preset = requested.mode;
      if (!isJevDecisionPreset(preset)) {
        return { ok: false, reasonCode: "PRESET_INVALID" };
      }
      const prepared = prepareJevPresetRequest(
        route,
        preset,
        input ?? {},
        preset === "skills" ? await readHostSkills(runtime) : void 0
      );
      if (prepared.ok) candidateSource = prepared.candidateSource;
      return prepared;
    })() : { ok: false, reasonCode: "PRESET_INVALID" }
  });
  if (!result.ok) {
    if (requested.mode === "review") {
      observeShadow(
        J4_QUALITY_SCORE_POINT,
        result.reasonCode,
        () => ({
          decision: "unavailable",
          reason: reviewRefusalSkipReason(result.reasonCode)
        }),
        runtime.shadowSink
      );
    }
    if (result.detail === void 0 && result.providerReason === void 0) {
      return refusal3(result.reasonCode);
    }
    return JSON.stringify({
      advisory: false,
      effect: "none",
      reasonCode: result.reasonCode,
      ...result.detail === void 0 ? {} : { detail: result.detail },
      ...result.providerReason === void 0 ? {} : { providerReason: result.providerReason },
      ...result.status === void 0 ? {} : { status: result.status },
      ...result.retryAfterMs === void 0 ? {} : { retryAfterMs: result.retryAfterMs }
    });
  }
  const advice = consumeJevDecisionResult(result.call.response, result.call.request);
  if (requested.mode === "review") {
    const evaluation = evaluateQualityScoreDecision(
      result.call.response,
      result.call.request
    );
    observeShadow(
      J4_QUALITY_SCORE_POINT,
      evaluation,
      (isolated) => {
        const scored = isolated;
        return {
          decision: qualityVerdict(scored),
          reason: encodeQualityScoreReason(scored)
        };
      },
      runtime.shadowSink
    );
    return JSON.stringify({
      advisory: true,
      effect: "none",
      reason: "JEV_DECISION",
      caller,
      route: {
        providerID: result.call.selection.route.model.providerID,
        id: result.call.selection.route.model.id,
        billing: result.call.selection.route.billing
      },
      mode: "review",
      quality: evaluation.quality,
      needsReview: evaluation.needsReview,
      verdict: qualityVerdict(evaluation),
      answers: advice.answers,
      missing: advice.missing,
      usage: { costUsd: advice.costUsd, tokens: advice.tokens },
      frozen: result.call.frozen
    });
  }
  if (requested.mode === "rank") {
    const rank = consumeJevRankResult(result.call.response, result.call.request);
    return JSON.stringify({
      advisory: true,
      effect: "none",
      reason: "JEV_DECISION",
      caller,
      route: {
        providerID: result.call.selection.route.model.providerID,
        id: result.call.selection.route.model.id,
        billing: result.call.selection.route.billing
      },
      mode: "rank",
      winner: rank.winner,
      winnerFit: rank.winnerFit,
      answers: advice.answers,
      missing: advice.missing,
      usage: { costUsd: advice.costUsd, tokens: advice.tokens },
      frozen: result.call.frozen
    });
  }
  if (requested.mode === "order") {
    const ordering = consumeJevOrderResult(
      result.call.response,
      result.call.request,
      orderCandidates
    );
    return JSON.stringify({
      advisory: true,
      effect: "none",
      reason: "JEV_DECISION",
      caller,
      route: {
        providerID: result.call.selection.route.model.providerID,
        id: result.call.selection.route.model.id,
        billing: result.call.selection.route.billing
      },
      mode: "order",
      ordering,
      answers: advice.answers,
      missing: advice.missing,
      usage: { costUsd: advice.costUsd, tokens: advice.tokens },
      frozen: result.call.frozen
    });
  }
  if (requested.mode === "verify") {
    const results = consumeJevVerifyResult(result.call.response, result.call.request);
    return JSON.stringify({
      advisory: true,
      effect: "none",
      reason: "JEV_DECISION",
      caller,
      route: {
        providerID: result.call.selection.route.model.providerID,
        id: result.call.selection.route.model.id,
        billing: result.call.selection.route.billing
      },
      mode: "verify",
      ...verifyEvidenceUsed === void 0 ? {} : { evidenceUsed: verifyEvidenceUsed },
      results,
      answers: advice.answers,
      missing: advice.missing,
      usage: { costUsd: advice.costUsd, tokens: advice.tokens },
      frozen: result.call.frozen
    });
  }
  return JSON.stringify({
    advisory: true,
    effect: "none",
    reason: "JEV_DECISION",
    caller,
    route: {
      providerID: result.call.selection.route.model.providerID,
      id: result.call.selection.route.model.id,
      billing: result.call.selection.route.billing
    },
    ...requested.mode === void 0 ? {} : { preset: requested.mode },
    ...candidateSource === void 0 ? {} : { candidateSource },
    answers: advice.answers,
    missing: advice.missing,
    usage: { costUsd: advice.costUsd, tokens: advice.tokens },
    frozen: result.call.frozen
  });
}
var TOOL_DESCRIPTION = 'Zeus-only advisory typed decisions via the host native Jev route (OpenCode Console or a configured decision model). Required: schemaVersion: 1 and a non-empty state (<=12000 chars). Ways to ask: pass `mode: "skills"` to stack skills for the state text (local prefilter shortlist, catalog fallback, plus every skill installed in the host), `mode: "delegation"` to pick a specialist, `mode: "review"` to score a finished delegated result against named criteria (advisory quality score + needs-review flag; the result content itself is never sent \u2014 shape metrics and criteria only), `mode: "rank"` to pick the best of 2-20 named candidates (winner + fit; no full ordering), `mode: "order"` to ORDER 2-4 candidates by fit (one score question per candidate; returns the descending ordering with per-candidate scores \u2014 an ORDINAL on the 2..10 rubric, not a probability), (returns the winner and its fit score; no full ordering), `mode: "verify"` to check 1-4 named claims, with optional `state` evidence the claims are judged against (verdicts PASS, FAIL, or UNVERIFIABLE for the 0.35-0.65 band; any refusal, timeout or malformed answer is BLOCK, fail-closed), or pass explicit typed `questions` (choice, score, predicate). Invalid-input refusals carry a `detail` token naming the exact cause. Returns probabilistic answers with confidence. Requires decision-router egress consent and budget caps; asks host permission first. It never dispatches agents, runs skills, executes tools, blocks, retries, or alters permissions \u2014 results are advisory only.';
var questionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "name", "instructions"],
  properties: {
    type: { type: "string", enum: ["choice", "score", "predicate"] },
    name: { type: "string", minLength: 1, maxLength: 64 },
    instructions: { type: "string", minLength: 1, maxLength: 2e3 },
    choices: {
      type: "array",
      minItems: 2,
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: {
          value: { type: "string", minLength: 1, maxLength: 64 },
          description: { type: "string", minLength: 1, maxLength: 500 }
        }
      }
    },
    levels: {
      type: "array",
      minItems: 2,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label"],
        properties: {
          label: { type: "string", minLength: 1, maxLength: 64 },
          description: { type: "string", minLength: 1, maxLength: 500 }
        }
      }
    }
  }
};
var REVIEW_METRICS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outputChars", "taskDurationMs"],
  properties: {
    outputChars: { type: "integer", minimum: 0, maximum: 1e8 },
    taskDurationMs: { type: ["integer", "null"], minimum: 0, maximum: 1e8 }
  }
};
var RANK_CANDIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$"
    },
    description: { type: "string", minLength: 1, maxLength: 500 }
  }
};
var VERIFY_CLAIM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "claim"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$"
    },
    claim: { type: "string", minLength: 1, maxLength: 200 }
  }
};
var JEV_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion"],
  anyOf: [
    { required: ["state"] },
    { required: ["delegateId", "resultSummaryKind", "resultMetrics", "criteria"] },
    { required: ["candidates"] },
    { required: ["claims"] }
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    state: { type: "string", minLength: 1, maxLength: 12e3 },
    mode: { type: "string", enum: ["skills", "delegation", "review", "rank", "verify", "order"] },
    questions: { type: "array", minItems: 1, maxItems: 4, items: questionSchema },
    delegateId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$"
    },
    resultSummaryKind: { type: "string", enum: ["ok", "empty", "error"] },
    resultMetrics: REVIEW_METRICS_SCHEMA,
    criteria: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        anyOf: [
          { type: "string", minLength: 1, maxLength: 120 },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 64 },
              description: { type: "string", minLength: 1, maxLength: 120 }
            }
          }
        ]
      }
    },
    candidates: {
      type: "array",
      minItems: 2,
      maxItems: 20,
      items: RANK_CANDIDATE_SCHEMA
    },
    claims: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: VERIFY_CLAIM_SCHEMA
    }
  }
};
function createV2JevDecisionDefinition(runtime) {
  return {
    name: "pantheon_jev_decide",
    description: TOOL_DESCRIPTION,
    input: JEV_INPUT_SCHEMA,
    output: {},
    execute: async (input, context) => ({
      output: await runJevDecision(input, context, runtime)
    })
  };
}

// src/pantheon/jev-escalation.ts
import { createHash as createHash4 } from "node:crypto";

// src/pantheon/model-overrides.ts
import { closeSync as closeSync3, constants as constants2, fstatSync, openSync as openSync3, readFileSync as readFileSync4 } from "node:fs";
import { join as join8 } from "node:path";

// src/pantheon/model-agents.ts
var KNOWN_AGENTS = [
  "zeus",
  "athena",
  "apollo",
  "hermes",
  "aphrodite",
  "demeter",
  "themis",
  "prometheus",
  "hephaestus",
  "nyx",
  "gaia",
  "iris",
  "mnemosyne",
  "talos"
];

// src/pantheon/presets.mjs
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join7 } from "node:path";
import { fileURLToPath } from "node:url";
import { load as load2 } from "js-yaml";
var EFFORT_RANK = { low: 0, medium: 1, high: 2 };
var CAPABILITY_TABLE = [
  { prefix: "deepseek/deepseek-v4-pro", maxEffort: "high", stripEffort: false, vision: false },
  // prefix also covers -free suffix (e.g. deepseek/deepseek-v4-flash-free)
  { prefix: "deepseek/deepseek-v4-flash", maxEffort: "medium", stripEffort: false, vision: false },
  { prefix: "claude", maxEffort: null, stripEffort: true, vision: true },
  // gpt-5.6 family: longest-prefix match picks luna-fast over generic gpt-5.6
  { prefix: "gpt-5.6-sol", maxEffort: "high", stripEffort: false, vision: true },
  { prefix: "gpt-5.6-terra", maxEffort: "medium", stripEffort: false, vision: true },
  { prefix: "gpt-5.6-luna-fast", maxEffort: "low", stripEffort: false, vision: true },
  { prefix: "gpt-5.6-luna", maxEffort: "low", stripEffort: false, vision: true },
  { prefix: "gpt-5.6", maxEffort: "medium", stripEffort: false, vision: true },
  // o-series are multimodal (models.dev input: text+image+pdf)
  { prefix: "o1", maxEffort: "high", stripEffort: false, vision: true },
  { prefix: "o3", maxEffort: "high", stripEffort: false, vision: true },
  { prefix: "o4", maxEffort: "high", stripEffort: false, vision: true },
  { prefix: "mimo/", maxEffort: "low", stripEffort: false, vision: true },
  // opencode/mimo-v2.5 fallback (OpenCode Zen): bare segment — the 'mimo/'
  // entry above matches 'mimo/v2.5' (full-string) but NOT 'mimo-v2.5'
  // (segment 'mimo-v2.5' has no slash, so 'mimo/' prefix cannot match).
  { prefix: "mimo-v2.5", maxEffort: "low", stripEffort: false, vision: true },
  // Current free OpenCode Zen vision model (renamed to the v2.6 Flash family).
  { prefix: "mimo-v2.6-flash", maxEffort: "low", stripEffort: false, vision: true },
  // mimo-v2.5-pro is text-only per models.dev api.json (2026-08-27).
  { prefix: "mimo-v2.5-pro", maxEffort: "low", stripEffort: false, vision: false },
  // Go subscription specific — bare segment prefixes so opencode-go/<model> IDs match
  { prefix: "glm-5.3-flash", maxEffort: "high", stripEffort: false, vision: false },
  { prefix: "kimi-k2.7-code", maxEffort: "high", stripEffort: false, vision: false },
  { prefix: "kimi-k3", maxEffort: "medium", stripEffort: false, vision: false },
  { prefix: "qwen3.8-max", maxEffort: "high", stripEffort: false, vision: false },
  { prefix: "qwen3.6-plus-free", maxEffort: "medium", stripEffort: false, vision: false },
  // Legacy qwen3.7 retained for capability checks (not used in new presets)
  { prefix: "qwen3.7-max", maxEffort: "high", stripEffort: false, vision: false },
  { prefix: "qwen3.7-plus", maxEffort: "medium", stripEffort: false, vision: true },
  { prefix: "minimax-m2.7", maxEffort: "medium", stripEffort: false, vision: false },
  { prefix: "minimax-m3", maxEffort: "high", stripEffort: false, vision: true },
  // BARE prefix — needed for opencode-go/deepseek-v4-flash (segment match);
  // provider-scoped deepseek/deepseek-v4-flash entry still wins by length
  // for deepseek/ models. Covers -free suffix too.
  { prefix: "deepseek-v4-flash", maxEffort: "medium", stripEffort: false, vision: false },
  // BARE prefix — needed for opencode-go/deepseek-v4-pro (segment match);
  // provider-scoped deepseek/deepseek-v4-pro entry still wins by length.
  { prefix: "deepseek-v4-pro", maxEffort: "high", stripEffort: false, vision: false },
  // opencode (Zen free tier) — bare segment prefixes for opencode/<model>.
  // big-pickle / nemotron-3-super-free / north-mini-code-free verified
  // text-only via models.dev (2026-08-27).
  { prefix: "big-pickle", maxEffort: "medium", stripEffort: false, vision: false },
  { prefix: "nemotron-3-super-free", maxEffort: "high", stripEffort: false, vision: false },
  { prefix: "nemotron-3-ultra-free", maxEffort: "high", stripEffort: false, vision: false },
  { prefix: "north-mini-code-free", maxEffort: "high", stripEffort: false, vision: false }
];
function capabilityEntry(model) {
  const matches = CAPABILITY_TABLE.filter((entry) => {
    if (model.startsWith(entry.prefix)) return true;
    const segment = model.slice(model.lastIndexOf("/") + 1);
    return segment.startsWith(entry.prefix);
  });
  if (matches.length === 0) {
    throw new Error(`presets: no capability entry for model ${model}`);
  }
  matches.sort((a, b) => b.prefix.length - a.prefix.length);
  return matches[0];
}
function normalizeCapability(model, requestedEffort) {
  const entry = capabilityEntry(model);
  if (entry.stripEffort) {
    return { variant: null, clamped: requestedEffort != null };
  }
  const maxEffort = entry.maxEffort;
  if (requestedEffort === void 0 || requestedEffort === null) {
    return { variant: maxEffort, clamped: false };
  }
  if (EFFORT_RANK[requestedEffort] > EFFORT_RANK[maxEffort]) {
    return { variant: maxEffort, clamped: true };
  }
  return { variant: requestedEffort, clamped: false };
}
function hasVision(model) {
  return capabilityEntry(model).vision;
}
var GATEWAY_BROKEN_VISION_MODELS = /* @__PURE__ */ new Set(["qwen3.7-plus"]);
function visionBrokenOnGateway(model, providerID) {
  if (!/^opencode-go$/.test(providerID ?? "")) return false;
  const segment = model.slice(model.lastIndexOf("/") + 1);
  return GATEWAY_BROKEN_VISION_MODELS.has(segment);
}
function loadPresetDefs(routingPath) {
  const path5 = routingPath ?? fileURLToPath(new URL("../routing.yml", import.meta.url));
  let raw;
  try {
    raw = readFileSync3(path5, "utf8");
  } catch (err) {
    throw new Error(`presets: failed to load routing.yml: ${path5} \u2014 ${err.message}`);
  }
  let routing;
  try {
    routing = load2(raw);
  } catch (err) {
    throw new Error(`presets: failed to load routing.yml: ${err.message}`);
  }
  return routing && typeof routing === "object" && routing.presets || {};
}
function resolveActivePreset({
  env = process.env,
  candidates = [join7(process.cwd(), ".pantheon", "active-preset.json")],
  routingPath,
  logger = console
} = {}) {
  const defs = loadPresetDefs(routingPath);
  const envName = env.PANTHEON_MODEL_PRESET;
  if (envName !== void 0 && envName !== "") {
    if (envName === "none") return null;
    const def = defs[envName];
    if (!def) {
      logger.warn?.(
        `presets: unknown preset "${envName}" (PANTHEON_MODEL_PRESET). Available: ${Object.keys(defs).join(", ") || "none"}`
      );
      return null;
    }
    return buildResolved(defs, envName, "env", null);
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    let exists;
    try {
      exists = readFileSync3(candidate);
    } catch {
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(exists.toString("utf8"));
    } catch {
      logger.warn?.(`presets: malformed active preset file: ${candidate}`);
      return null;
    }
    const name = raw && typeof raw === "object" ? raw.preset : void 0;
    if (!name || name === "none") return null;
    const def = defs[name];
    if (!def) {
      logger.warn?.(
        `presets: unknown preset "${name}" in ${candidate}. Available: ${Object.keys(defs).join(", ") || "none"}`
      );
      return null;
    }
    return buildResolved(defs, name, "file", raw);
  }
  return null;
}
function buildResolved(defs, name, source, rawFile) {
  const def = defs[name] || {};
  const overrides = rawFile && typeof rawFile === "object" ? rawFile.overrides : null;
  const agentOverrides = overrides?.agents ?? {};
  const providerOverrides = overrides?.providers ?? {};
  let vision = def.vision ?? null;
  if (overrides && Object.hasOwn(overrides, "vision")) {
    const override = overrides.vision;
    if (override === null) {
      vision = null;
    } else if (override && typeof override === "object") {
      vision = { ...def.vision ?? {}, ...override };
    }
  }
  const agents = {};
  for (const [agent, spec] of Object.entries(def.agents ?? {})) {
    let merged = { ...spec };
    const override = agentOverrides[agent];
    if (override && typeof override === "object") {
      merged = { ...merged, ...override };
      if (override.variant !== void 0) {
        merged.reasoning_effort = override.variant;
      }
    }
    agents[agent] = merged;
  }
  const providers = { ...def.providers ?? {} };
  for (const [id, provider] of Object.entries(providerOverrides)) {
    if (provider && typeof provider === "object") {
      providers[id] = { ...providers[id] ?? {}, ...provider };
    }
  }
  return { name, source, agents, providers, overrides, vision };
}

// src/pantheon/model-overrides.ts
var MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
var VARIANTS = /* @__PURE__ */ new Set(["low", "medium", "high"]);
var KNOWN_AGENTS_SET = new Set(KNOWN_AGENTS);
function isRecord17(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isVariant(value) {
  return typeof value === "string" && VARIANTS.has(value);
}
function isSupportedModelChoice(model, variant) {
  if (typeof model !== "string" || !MODEL_REF_PATTERN.test(model)) return false;
  if (variant !== void 0 && !isVariant(variant)) return false;
  try {
    capabilityEntry(model);
    if (variant === void 0) return true;
    const normalized = normalizeCapability(model, variant);
    return !normalized.clamped && normalized.variant === variant;
  } catch {
    return false;
  }
}
var SecurePresetReadUnavailableError = class extends Error {
  constructor() {
    super("Secure preset-file opening is unavailable");
  }
};
var NonRegularPresetFileError = class extends Error {
  constructor() {
    super("Preset file is not a regular file");
  }
};
function readV2PresetFile(candidate, fileSystem = { openSync: openSync3, fstatSync, readFileSync: readFileSync4, closeSync: closeSync3 }) {
  const noFollowFlag = constants2.O_NOFOLLOW;
  const nonBlockFlag = constants2.O_NONBLOCK;
  if (noFollowFlag === void 0 || noFollowFlag === 0 || nonBlockFlag === void 0 || nonBlockFlag === 0) {
    throw new SecurePresetReadUnavailableError();
  }
  let fileDescriptor;
  try {
    fileDescriptor = fileSystem.openSync(
      candidate,
      constants2.O_RDONLY | noFollowFlag | nonBlockFlag
    );
    if (!fileSystem.fstatSync(fileDescriptor).isFile()) {
      throw new NonRegularPresetFileError();
    }
    return fileSystem.readFileSync(fileDescriptor, "utf8");
  } finally {
    if (fileDescriptor !== void 0) fileSystem.closeSync(fileDescriptor);
  }
}
function parseOverrides(value, warnings) {
  const parsed = {};
  for (const [agent, raw] of Object.entries(value)) {
    if (!KNOWN_AGENTS_SET.has(agent)) {
      warnings.push(
        "Override entry ignored for an unsupported agent; use one of the canonical Pantheon agent IDs."
      );
      continue;
    }
    const entry = isRecord17(raw) ? raw : void 0;
    const hasVariant = entry !== void 0 && Object.hasOwn(entry, "variant");
    const variant = hasVariant ? entry?.variant : entry?.reasoning_effort;
    const model = entry?.model;
    if (!entry || hasVariant && !isVariant(variant) || !isSupportedModelChoice(model, variant)) {
      warnings.push(
        "Override entry ignored because its model or variant is unsupported; choose a supported model and reasoning variant."
      );
      continue;
    }
    const override = { model };
    if (isVariant(variant)) override.variant = variant;
    parsed[agent] = override;
  }
  return parsed;
}
function defaultCandidates() {
  return [join8(process.cwd(), ".pantheon", "active-preset.json")];
}
function readV2ModelConfiguration(options = {}) {
  const env = options.env ?? process.env;
  const envName = env.PANTHEON_MODEL_PRESET?.trim();
  let fileMarkerPresent = false;
  const configurations = [];
  const warnings = [];
  let readFailure = false;
  const candidates = options.candidates ?? defaultCandidates();
  for (const candidate of candidates.slice(0, 1)) {
    let rawContent;
    try {
      rawContent = readV2PresetFile(candidate);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      if (error instanceof SecurePresetReadUnavailableError) {
        warnings.push(
          "V2 project model configuration cannot be read securely on this platform; manual overrides were not applied."
        );
        readFailure = true;
        break;
      }
      if (error instanceof NonRegularPresetFileError || error instanceof Error && "code" in error && error.code === "ELOOP") {
        warnings.push(
          "V2 project model configuration is not a regular file or is a symlink; check active-preset.json. Manual overrides were not applied."
        );
        readFailure = true;
        break;
      }
      warnings.push(
        "V2 project model configuration could not be read; check active-preset.json file access. Manual overrides were not applied."
      );
      readFailure = true;
      break;
    }
    let raw;
    try {
      raw = JSON.parse(rawContent);
    } catch {
      warnings.push(
        "V2 project model configuration contains invalid JSON; correct active-preset.json. Manual overrides were not applied."
      );
      readFailure = true;
      break;
    }
    if (!isRecord17(raw)) {
      warnings.push(
        "V2 project model configuration has an invalid shape; correct active-preset.json. Manual overrides were not applied."
      );
      readFailure = true;
      break;
    }
    if (Object.hasOwn(raw, "preset")) fileMarkerPresent = true;
    let parsedOverrides = {};
    if (Object.hasOwn(raw, "overrides")) {
      if (!isRecord17(raw.overrides)) {
        warnings.push(
          "V2 project model configuration has an invalid `overrides` object; expected an object in active-preset.json. The project file contributed no manual overrides."
        );
      } else if (Object.hasOwn(raw.overrides, "agents")) {
        if (!isRecord17(raw.overrides.agents)) {
          warnings.push(
            "V2 project model configuration has invalid `overrides.agents`; expected an object in active-preset.json. The project file contributed no manual overrides."
          );
        } else {
          parsedOverrides = parseOverrides(raw.overrides.agents, warnings);
        }
      }
    }
    configurations.push(parsedOverrides);
  }
  const envMarkerPresent = typeof envName === "string" && envName.length > 0;
  const markerSource = envMarkerPresent ? "env" : fileMarkerPresent ? "file" : null;
  const overrides = {};
  if (!readFailure) {
    Object.assign(overrides, configurations[0] ?? {});
  }
  return {
    overrides,
    legacyPresetMarker: markerSource === null ? null : { source: markerSource },
    warnings
  };
}
function applyV2ModelOverride(agent, override) {
  if (!KNOWN_AGENTS_SET.has(agent.id) || !override || !isSupportedModelChoice(override.model, override.variant)) {
    return;
  }
  const separator = override.model.indexOf("/");
  const previous = isRecord17(agent.model) ? agent.model : {};
  const model = {
    ...previous,
    providerID: override.model.slice(0, separator),
    id: override.model.slice(separator + 1)
  };
  if (override.variant !== void 0) {
    model.variant = override.variant;
  } else {
    delete model.variant;
  }
  agent.model = model;
}
function applyV2ModelOverrides(draft, overrides) {
  for (const agent of draft.list()) {
    if (!KNOWN_AGENTS_SET.has(agent.id)) continue;
    const override = overrides[agent.id];
    if (!override) continue;
    draft.update(agent.id, (current) => applyV2ModelOverride(current, override));
  }
}

// src/pantheon/jev-escalation.ts
var J3_ESCALATION_FLAG_ENV = "PANTHEON_J3_ESCALATION";
var J3_ESCALATION_POINT = "J3";
var J3_ESCALATION_TIMEOUT_MS = 2e3;
var ESCALATION_QUESTION_NAME = "complexity";
var J3_COMPLEXITY_LEVEL_COUNT = 9;
var J3_ESCALATION_CHEAP_THRESHOLD = 4;
var J3_CONTEXT_LENGTH_RAIL = 8e3;
var J3_RISK_WORDS = Object.freeze([
  "deploy",
  "migrate",
  "drop",
  "delete",
  "prod",
  "production",
  "payment",
  "secret",
  "credential"
]);
var J3_ESCALATION_STATE_MAX_LENGTH = 512;
var FLAG_ON2 = /* @__PURE__ */ new Set(["1", "on", "true", "shadow"]);
var TOKEN_PATTERN3 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
var SHA256_HEX2 = /^[0-9a-f]{64}$/;
var STATE_LENGTH_MAX = 1e8;
function j3EscalationEnabledFromEnv(env = process.env) {
  const raw = (env[J3_ESCALATION_FLAG_ENV] ?? "").trim().toLowerCase();
  return FLAG_ON2.has(raw);
}
function isRecord18(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function containsRiskWord(briefText) {
  if (typeof briefText !== "string" || briefText.length === 0) return false;
  const haystack = briefText.toLowerCase();
  return J3_RISK_WORDS.some((word) => haystack.includes(word));
}
function subagentDispatchTarget(event) {
  if (!isRecord18(event)) return void 0;
  if (event.tool !== "subagent") return void 0;
  const input = event.input;
  if (!isRecord18(input)) return void 0;
  const agent = input.agent;
  if (typeof agent !== "string") return void 0;
  const normalized = agent.trim().toLowerCase();
  return PANTHEON_AGENTS.has(normalized) ? normalized : void 0;
}
function isSubagentDispatchEvent(event) {
  return subagentDispatchTarget(event) !== void 0;
}
var BRIEF_TEXT_KEYS = Object.freeze([
  "prompt",
  "description",
  "message",
  "task",
  "instructions"
]);
function serializeBrief(brief) {
  if (typeof brief === "string") return brief;
  try {
    const json = JSON.stringify(brief);
    return json === void 0 ? String(brief) : json;
  } catch {
    return "unserializable-subagent-brief";
  }
}
function extractBriefText(input) {
  if (typeof input === "string") return input;
  if (isRecord18(input)) {
    for (const key of BRIEF_TEXT_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return serializeBrief(input);
}
var COMPLEXITY_LABELS = [
  "trivial",
  "simple",
  "routine",
  "moderate",
  "involved",
  "complex",
  "heavy",
  "critical",
  "sprawling"
];
var COMPLEXITY_LEVELS = Object.freeze(
  Array.from({ length: J3_COMPLEXITY_LEVEL_COUNT }, (_, index) => {
    return Object.freeze({ label: COMPLEXITY_LABELS[index] ?? `level-${index}` });
  })
);
var COMPLEXITY_INSTRUCTIONS = "Rate how complex this delegated dispatch is for the specialist agent, judging from the structural hints in the state (dispatch size and risk markers): routine and self-contained at the low end, broad multi-step work at the high end. Advisory only; nothing is enforced.";
var QUESTIONS2 = Object.freeze([
  Object.freeze({
    type: "score",
    name: ESCALATION_QUESTION_NAME,
    instructions: COMPLEXITY_INSTRUCTIONS,
    levels: COMPLEXITY_LEVELS
  })
]);
function classifyTurnComplexity(request) {
  const input = isRecord18(request) ? request : void 0;
  const delegateId = input?.delegateId;
  if (typeof delegateId !== "string" || !TOKEN_PATTERN3.test(delegateId) || !PANTHEON_AGENTS.has(delegateId)) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  const stateHash = input?.stateHash;
  if (typeof stateHash !== "string" || !SHA256_HEX2.test(stateHash)) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  const stateLength = input?.stateLength;
  if (typeof stateLength !== "number" || !Number.isInteger(stateLength) || stateLength < 0 || stateLength > STATE_LENGTH_MAX) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  const hasRiskWord = input?.hasRiskWord;
  if (typeof hasRiskWord !== "boolean") {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  const state = `Advisory complexity probe for one delegated dispatch. delegate: ${delegateId}. state_sha256: ${stateHash}. state_chars: ${stateLength}. risk_word_present: ${hasRiskWord ? "yes" : "no"}. The request carries no task content; the Brief text never leaves this machine; judge from the structural fields alone.`;
  if (state.length > J3_ESCALATION_STATE_MAX_LENGTH) {
    return { ok: false, reasonCode: "INPUT_INVALID" };
  }
  return {
    ok: true,
    request: Object.freeze({
      input: Object.freeze([Object.freeze({ type: "text", text: state })]),
      questions: QUESTIONS2
    })
  };
}
function evaluateEscalationDecision(response, request) {
  const advice = consumeJevDecisionResult(response, request);
  let complexity = null;
  for (const answer of advice.answers) {
    if (answer.type === "error") continue;
    if (answer.type === "score" && answer.name === ESCALATION_QUESTION_NAME) {
      complexity = answer.score ?? null;
    }
  }
  return { complexity };
}
function escalationVerdict(input) {
  if (input.complexity === null) return "main";
  if (input.rails.hasRiskWord) return "main";
  if (input.rails.pinnedModel) return "main";
  if (input.rails.stateLength > J3_CONTEXT_LENGTH_RAIL) return "main";
  return input.complexity <= J3_ESCALATION_CHEAP_THRESHOLD ? "cheap" : "main";
}
var REASON_TOKEN3 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
function formatScoreToken3(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1e3) return "na";
  const text2 = String(Math.round(value * 100) / 100);
  return TOKEN_PATTERN3.test(text2) ? text2 : "na";
}
function encodeEscalationReason(input) {
  const verdict = input.verdict === "cheap" ? "esc-cheap" : "esc-main";
  const score = input.complexity === null ? "na" : formatScoreToken3(input.complexity);
  const reason = score === "na" ? `${verdict}-c-na` : `${verdict}-c${score}`;
  return REASON_TOKEN3.test(reason) ? reason : "invalid-reason";
}
function defaultIsPinnedModel(delegateId) {
  try {
    const configuration = readV2ModelConfiguration();
    return Object.hasOwn(configuration.overrides, delegateId);
  } catch {
    return true;
  }
}
function recordSkip2(sink, skipReason) {
  observeShadow(
    J3_ESCALATION_POINT,
    skipReason,
    () => ({
      decision: "unavailable",
      reason: skipReason
    }),
    sink
  );
}
function abortDeadline2(signal) {
  return new Promise((resolve8) => {
    if (signal.aborted) {
      resolve8("timeout");
      return;
    }
    signal.addEventListener("abort", () => resolve8("timeout"), { once: true });
  });
}
function createJ3EscalationObserver(options) {
  const timeoutMs = options.timeoutMs ?? J3_ESCALATION_TIMEOUT_MS;
  const sink = options.sink;
  const isPinnedModel = options.isPinnedModel ?? defaultIsPinnedModel;
  return async (event) => {
    try {
      const delegateId = subagentDispatchTarget(event);
      if (delegateId === void 0) return;
      const payload = event ?? {};
      const briefText = extractBriefText(payload.input);
      const stateLength = briefText.length;
      const hasRiskWord = containsRiskWord(briefText);
      const built = classifyTurnComplexity({
        delegateId,
        stateHash: createHash4("sha256").update(briefText, "utf8").digest("hex"),
        stateLength,
        hasRiskWord
      });
      if (!built.ok) {
        recordSkip2(sink, "skip-input-invalid");
        return;
      }
      const rails = {
        hasRiskWord,
        pinnedModel: isPinnedModel(delegateId),
        stateLength
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
      try {
        const outcome = await Promise.race([
          runGatedNativeJevCall({
            sessionID: payload.sessionID,
            messageID: payload.messageID,
            agent: typeof payload.agent === "string" ? payload.agent : void 0,
            runtime: options.runtime,
            prepare: (route) => ({
              ok: true,
              request: {
                model: route.model,
                input: built.request.input,
                questions: built.request.questions
              }
            })
          }),
          abortDeadline2(controller.signal)
        ]);
        if (outcome === "timeout") {
          recordSkip2(sink, "skip-timeout");
          return;
        }
        if (!outcome.ok) {
          recordSkip2(sink, mapGateFailureToSkipReason(outcome.reasonCode));
          return;
        }
        const evaluation = evaluateEscalationDecision(outcome.call.response, outcome.call.request);
        const verdict = escalationVerdict({ complexity: evaluation.complexity, rails });
        observeShadow(
          J3_ESCALATION_POINT,
          evaluation,
          (isolated) => ({
            decision: "observe",
            reason: encodeEscalationReason({
              verdict,
              complexity: isolated.complexity
            })
          }),
          sink
        );
      } finally {
        clearTimeout(timer);
      }
    } catch {
      recordSkip2(sink, "skip-gate-unavailable");
    }
  };
}

// src/pantheon/native-vision.ts
import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync as existsSync4 } from "node:fs";
import { readFile as readFile4 } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { homedir as homedir4 } from "node:os";
import { join as join10, resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/pantheon/session-guard.ts
function isValidSessionId(id) {
  return typeof id === "string" && id.startsWith("ses");
}
function safeSessionPath(id) {
  if (!isValidSessionId(id)) return null;
  return { path: { id } };
}

// src/pantheon/vision.ts
import { createHash as createHash5, randomUUID as randomUUID2 } from "node:crypto";
import {
  chmodSync as chmodSync3,
  existsSync as existsSync3,
  mkdirSync as mkdirSync4,
  readdirSync,
  readFileSync as readFileSync5,
  renameSync as renameSync2,
  statSync as statSync2,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import { readFile as readFile3, unlink } from "node:fs/promises";
import { homedir as homedir3, tmpdir } from "node:os";
import { join as join9 } from "node:path";

// src/pantheon/vision-local.ts
var PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// src/pantheon/vision.ts
var TEMP_DIR_NAME = "pantheon-vision";
var TEMP_FILE_GRACE_MS = 12e4;
var TEMP_MAX_FILES = 200;
var MIME_TO_EXTENSION = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};
var DEFAULT_VISION_MODEL = "opencode-go/mimo-v2.5";
var ZEN_BASE_URL = "https://opencode.ai/zen/v1";
var ZEN_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
var NATIVE_PROMPT = "Descreva fielmente esta imagem em detalhes (texto vis\xEDvel, cores, layout, objetos).";
var NATIVE_TIMEOUT_MS = 6e4;
var NATIVE_TIMEOUT_PER_MB_MS = 1e4;
var NATIVE_TIMEOUT_MAX_MS = 3e5;
var BYTES_PER_MB = 1024 * 1024;
var NATIVE_MAX_TOKENS = 2048;
var MAX_NATIVE_IMAGE_BYTES = 25 * 1024 * 1024;
function computeNativeTimeoutMs(totalBytes) {
  const bytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const mb = Math.floor(bytes / BYTES_PER_MB);
  return Math.min(NATIVE_TIMEOUT_MAX_MS, NATIVE_TIMEOUT_MS + mb * NATIVE_TIMEOUT_PER_MB_MS);
}
function estimateNativePayloadsBytes(payloads) {
  let total = 0;
  for (const payload of payloads) {
    const match = /^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/.exec(payload.url);
    total += match ? Math.ceil((match[1]?.length ?? 0) * 3 / 4) : 0;
  }
  return total;
}
var DESCRIPTION_CACHE_TTL_MS = 30 * 60 * 1e3;
var NATIVE_VISION_NPM_ALLOWLIST = /* @__PURE__ */ new Set([
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai"
]);
var LEGACY_VISION_AUTH_PROVIDER_IDS = ["opencode-go", "opencode"];
function isZenProvider(providerID) {
  return providerID === "opencode" || providerID.startsWith("opencode-go");
}
function providerOf(modelID) {
  const slash = modelID.indexOf("/");
  return slash === -1 ? modelID : modelID.slice(0, slash);
}
function isZenNativeTarget(target) {
  if (!isZenProvider(providerOf(target.modelID))) return false;
  return /^https:\/\/opencode\.ai\/zen\//i.test(target.baseURL);
}
function nativeVisionFailureMessage(failure, modelID) {
  if (failure?.reason === "timeout") {
    const budget = failure.timeoutMs ? ` after ${Math.round(failure.timeoutMs / 1e3)}s` : "";
    return `the multimodal model request timed out${budget}: the image-description budget elapsed before a response \u2014 retry, or raise the timeout budget`;
  }
  if (failure?.reason === "cancelled") {
    return "the multimodal model request was cancelled before it completed";
  }
  if (failure?.reason === "network") {
    return "the multimodal model request failed (network error): the connection was dropped before the description completed \u2014 retry the describe";
  }
  const status = failure?.reason === "http" ? failure.status : void 0;
  if (status === 400) {
    return "the Zen gateway rejected the request (HTTP 400 MissingSessionID): the x-opencode-session header is missing \u2014 the request must carry a real OpenCode session id";
  }
  if (status === 401) {
    return `the OpenCode Zen gateway rejected the credential (HTTP 401); verify the credential and that ${modelID} supports image input on its endpoint`;
  }
  if (status === 403) {
    return `the OpenCode Zen gateway denied access (HTTP 403) to ${modelID}: the model may be free-tier (usable only from inside OpenCode) or this account has no paid access to it`;
  }
  if (status !== void 0) {
    return `the Zen gateway rejected the request (HTTP ${status}) for ${modelID}`;
  }
  if (failure?.reason === "empty") {
    const finish = failure.finishReason;
    if (finish === "length") {
      return "the model returned no text (finish_reason: length) \u2014 the response was truncated by max_tokens; raise max_tokens or choose a non-reasoning image model";
    }
    if (finish) {
      return `the model returned no text (finish_reason: ${finish})`;
    }
    return "the multimodal model returned no text";
  }
  return "the multimodal model returned no text or the request failed";
}
function providerIsTextOnly(providerID) {
  const providerEntries = CAPABILITY_TABLE.filter(
    (entry) => entry.prefix.startsWith(`${providerID}/`)
  );
  if (providerEntries.length === 0) return false;
  return providerEntries.every((entry) => !entry.vision);
}
var nativeVisionSessions = /* @__PURE__ */ new Set();
function isNativeVisionSession(sessionID) {
  return nativeVisionSessions.has(sessionID);
}
function modelAcceptsImages(model, providerID) {
  if (!model) {
    if (providerID && providerIsTextOnly(providerID)) return false;
    return true;
  }
  try {
    const id = `${model.providerID}/${model.modelID}`;
    return hasVision(id) && !visionBrokenOnGateway(id, model.providerID);
  } catch {
    return true;
  }
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function parseCatalogEntry(raw, providerID) {
  const id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : null;
  if (!id) return null;
  const entryProvider = typeof raw.providerID === "string" && raw.providerID.trim() !== "" ? raw.providerID.trim() : providerID;
  if (!entryProvider) return null;
  const api = asRecord(raw.api);
  const url = typeof api?.url === "string" && api.url.trim() !== "" ? api.url.trim() : null;
  const npm = typeof api?.npm === "string" && api.npm.trim() !== "" ? api.npm.trim() : null;
  const input = asRecord(asRecord(raw.capabilities)?.input);
  const cost = asRecord(raw.cost);
  return {
    modelID: `${entryProvider}/${id}`,
    providerID: entryProvider,
    image: input?.image === true,
    url,
    npm,
    costInput: typeof cost?.input === "number" && Number.isFinite(cost.input) ? cost.input : null,
    deprecated: raw.status === "deprecated"
  };
}
function catalogEntries(catalog) {
  const root = asRecord(catalog);
  if (!root) return [];
  const entries = [];
  if (Array.isArray(root.providers)) {
    for (const provider of root.providers) {
      const p = asRecord(provider);
      if (!p) continue;
      const pid = typeof p.id === "string" ? p.id : "";
      const models = asRecord(p.models);
      if (!models) continue;
      for (const model of Object.values(models)) {
        const m = asRecord(model);
        if (!m) continue;
        const entry = parseCatalogEntry(m, pid);
        if (entry) entries.push(entry);
      }
    }
  }
  if (Array.isArray(root.models)) {
    for (const model of root.models) {
      const m = asRecord(model);
      if (!m) continue;
      const entry = parseCatalogEntry(m, "");
      if (entry) entries.push(entry);
    }
  }
  return entries;
}
function providerSupportsNativeVision(providerID, npm) {
  if (isZenProvider(providerID)) return true;
  return npm !== null && NATIVE_VISION_NPM_ALLOWLIST.has(npm);
}
function catalogEntryIsFree(entry) {
  return entry.costInput !== null && entry.costInput <= 0 || /-free$/i.test(entry.modelID);
}
function discoverVisionModel(catalog) {
  const candidates = catalogEntries(catalog).filter(
    (entry) => entry.image && !entry.deprecated && !catalogEntryIsFree(entry) && providerSupportsNativeVision(entry.providerID, entry.npm) && entry.url !== null && /^https?:\/\//i.test(entry.url)
  );
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    const price = (entry) => entry.costInput === null ? Number.POSITIVE_INFINITY : entry.costInput;
    return price(left) - price(right) || left.modelID.localeCompare(right.modelID);
  });
  const pick = candidates[0];
  return pick?.url ? { modelID: pick.modelID, baseURL: pick.url } : null;
}
function catalogEndpointFor(modelID, catalog) {
  const slash = modelID.indexOf("/");
  if (slash < 1) return null;
  for (const entry of catalogEntries(catalog)) {
    if (entry.modelID !== modelID) continue;
    if (!providerSupportsNativeVision(entry.providerID, entry.npm)) return null;
    return entry.url !== null && /^https?:\/\//i.test(entry.url) ? entry.url : null;
  }
  return null;
}
function legacyZenBaseURL(modelID) {
  const providerID = modelID.slice(0, modelID.indexOf("/"));
  if (providerID.startsWith("opencode-go")) return ZEN_GO_BASE_URL;
  if (providerID === "opencode") return ZEN_BASE_URL;
  return null;
}
function defaultAuthStateDir() {
  const dataHome = process.env.XDG_DATA_HOME || join9(homedir3(), ".local", "share");
  return join9(dataHome, "opencode");
}
function v2CredentialDbPath(stateDir, env) {
  const override = env.OPENCODE_DB?.trim();
  return override ? override : join9(stateDir, "opencode.db");
}
var AUTH_TOKEN_FIELDS = [
  "access",
  "key",
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "access_token"
];
function extractAuthToken(value) {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (!value || typeof value !== "object") return null;
  const record2 = value;
  const expires = record2.expires;
  if (typeof expires === "number" && expires > 0 && Date.now() >= expires) return null;
  for (const field of AUTH_TOKEN_FIELDS) {
    const candidate = record2[field];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}
function extractCredentialCellToken(value) {
  if (typeof value !== "string") return null;
  try {
    return extractAuthToken(JSON.parse(value));
  } catch {
    return null;
  }
}
async function readV2CredentialToken(providerIDs, stateDir, env) {
  const dbPath = v2CredentialDbPath(stateDir, env);
  if (!existsSync3(dbPath)) return null;
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return null;
  }
  const DatabaseSync2 = sqlite.DatabaseSync;
  if (typeof DatabaseSync2 !== "function") return null;
  let db;
  try {
    db = new DatabaseSync2(`file:${dbPath}?mode=ro`, { readOnly: true });
    const statement = db.prepare(
      "SELECT value FROM credential WHERE integration_id = ? AND active = 1 LIMIT 1"
    );
    for (const id of providerIDs) {
      const row = statement.get(id);
      const token = extractCredentialCellToken(row?.value);
      if (token) return token;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
async function readOpencodeAuthToken(providerIDs, statePath, env = process.env) {
  const stateDir = statePath ?? defaultAuthStateDir();
  const raw = await readFile3(join9(stateDir, "auth.json"), "utf8").catch(() => null);
  if (raw !== null) {
    let auth = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        auth = parsed;
      }
    } catch {
      auth = null;
    }
    if (auth) {
      for (const id of providerIDs) {
        const token = extractAuthToken(auth[id]);
        if (token) return token;
      }
    }
  }
  return readV2CredentialToken(providerIDs, stateDir, env);
}
function activePresetCandidates() {
  const home = process.env.HOME ?? "";
  const xdg = process.env.XDG_CONFIG_HOME ?? `${home}/.config`;
  return [
    `${process.cwd()}/.pantheon/active-preset.json`,
    `${xdg}/opencode/.pantheon/active-preset.json`,
    `${home}/.opencode/.pantheon/active-preset.json`
  ];
}
function syntheticPartId() {
  return `prt${randomUUID2()}`;
}
function getExtensionForMime(mime) {
  return MIME_TO_EXTENSION[mime.toLowerCase()] ?? "png";
}
var tempFileLRU = /* @__PURE__ */ new Map();
function touchTempFile(path5, now = Date.now()) {
  tempFileLRU.delete(path5);
  tempFileLRU.set(path5, now);
}
async function enforceTempFileCap(maxFiles = TEMP_MAX_FILES, graceMs = TEMP_FILE_GRACE_MS, now = Date.now()) {
  let evicted = 0;
  for (const [path5, touchedAt] of tempFileLRU) {
    if (tempFileLRU.size <= maxFiles) break;
    if (now - touchedAt <= graceMs) continue;
    tempFileLRU.delete(path5);
    try {
      await unlink(path5);
    } catch {
    }
    evicted += 1;
  }
  return evicted;
}
var TEMP_IMAGE_NAME = /^[0-9a-f]{64}\.(?:png|jpe?g|webp|gif)$/;
var TEMP_STRAY_NAME = /^[0-9a-f]{64}\.(?:png|jpe?g|webp|gif)\.tmp-\d+$/;
function defaultTempDir() {
  return join9(tmpdir(), TEMP_DIR_NAME);
}
function adoptOrphanTempImages(dir = defaultTempDir(), now = Date.now()) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const candidates = [];
  for (const name of names) {
    if (!TEMP_IMAGE_NAME.test(name)) continue;
    const path5 = join9(dir, name);
    if (tempFileLRU.has(path5)) continue;
    try {
      candidates.push({ path: path5, mtimeMs: statSync2(path5).mtimeMs });
    } catch {
    }
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const { path: path5, mtimeMs } of candidates) {
    tempFileLRU.set(path5, Math.min(mtimeMs, now));
  }
  return candidates.length;
}
function sweepStrayTempWrites(dir = defaultTempDir(), now = Date.now(), graceMs = TEMP_FILE_GRACE_MS) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of names) {
    if (!TEMP_STRAY_NAME.test(name)) continue;
    const path5 = join9(dir, name);
    try {
      if (now - statSync2(path5).mtimeMs <= graceMs) continue;
      unlinkSync2(path5);
      swept += 1;
    } catch {
    }
  }
  return swept;
}
var reconciledDirs = /* @__PURE__ */ new Set();
function reconcileTempImagesOnce(dir = defaultTempDir()) {
  if (reconciledDirs.has(dir)) return { adopted: 0, swept: 0 };
  reconciledDirs.add(dir);
  return { adopted: adoptOrphanTempImages(dir), swept: sweepStrayTempWrites(dir) };
}
function decodeDataUrlImage(dataUrl) {
  const match = /^data:([^;,]+)(?:;[^;,]*)*;base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  const data = Buffer.from(match[2] ?? "", "base64");
  if (data.length === 0) return null;
  return data;
}
function writeFileAtomicSync(filePath, data) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync3(tempPath, data, { mode: 384 });
    chmodSync3(tempPath, 384);
    renameSync2(tempPath, filePath);
  } catch (err) {
    try {
      unlinkSync2(tempPath);
    } catch {
    }
    throw err;
  }
}
function fileHasContent(filePath, data) {
  try {
    return readFileSync5(filePath).equals(data);
  } catch {
    return false;
  }
}
function writeTempImageSync(data, mime) {
  try {
    reconcileTempImagesOnce();
  } catch {
  }
  const dir = join9(tmpdir(), TEMP_DIR_NAME);
  mkdirSync4(dir, { recursive: true, mode: 448 });
  chmodSync3(dir, 448);
  const filePath = join9(dir, `${hashContent(data)}.${getExtensionForMime(mime)}`);
  if (!fileHasContent(filePath, data)) writeFileAtomicSync(filePath, data);
  chmodSync3(filePath, 384);
  touchTempFile(filePath);
  return filePath;
}
function saveDataUrlImageSync(dataUrl, mime) {
  const data = decodeDataUrlImage(dataUrl);
  if (!data) return null;
  const filePath = writeTempImageSync(data, mime);
  void enforceTempFileCap().catch(() => void 0);
  return filePath;
}
function firstNonEmpty(fallback, ...values) {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}
function resolveNativeVisionEndpoint(preset, env, configVisionModel, catalog) {
  const resolved = preset ?? resolveActivePreset({ env, candidates: activePresetCandidates() });
  const explicitModel = firstNonEmpty(
    "",
    env.PANTHEON_VISION_MODEL,
    configVisionModel,
    resolved?.vision?.model
  );
  if (explicitModel) {
    const baseURL2 = catalogEndpointFor(explicitModel, catalog) ?? legacyZenBaseURL(explicitModel);
    if (!baseURL2) return null;
    return { modelID: explicitModel, baseURL: baseURL2 };
  }
  const discovered = discoverVisionModel(catalog);
  if (discovered) return discovered;
  const modelID = DEFAULT_VISION_MODEL;
  const baseURL = legacyZenBaseURL(modelID);
  if (!baseURL) return null;
  return { modelID, baseURL };
}
async function resolveNativeVisionTarget(input = {}) {
  const env = input.env ?? process.env;
  const endpoint = resolveNativeVisionEndpoint(
    input.preset,
    env,
    input.config?.visionModel,
    input.catalog
  );
  if (!endpoint) return null;
  const resolvedProvider = endpoint.modelID.slice(0, endpoint.modelID.indexOf("/"));
  const zen = isZenProvider(resolvedProvider);
  if (zen) {
    const envKey = env.PANTHEON_OPENCODE_API_KEY ?? env.OPENCODE_API_KEY;
    if (envKey && envKey.trim() !== "") return { ...endpoint, apiKey: envKey };
  }
  const authProviderIDs = [
    ...new Set(zen ? [resolvedProvider, ...LEGACY_VISION_AUTH_PROVIDER_IDS] : [resolvedProvider])
  ].filter((id) => Boolean(id));
  const authToken = await readOpencodeAuthToken(authProviderIDs, input.authStatePath, env);
  if (!authToken) return null;
  return { ...endpoint, apiKey: authToken };
}
function stripProviderPrefix(modelID) {
  const slash = modelID.lastIndexOf("/");
  return slash === -1 ? modelID : modelID.slice(slash + 1);
}
async function describeImagesNative(payloads, target, prompt = NATIVE_PROMPT, maxTokens = NATIVE_MAX_TOKENS, signal, onFailure) {
  const report = (failure) => {
    try {
      onFailure?.(failure);
    } catch {
    }
  };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${target.apiKey}`
  };
  if (target.sessionID && isZenNativeTarget(target)) {
    headers["x-opencode-session"] = target.sessionID;
  }
  const controller = new AbortController();
  const budgetMs = computeNativeTimeoutMs(estimateNativePayloadsBytes(payloads));
  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budgetMs);
  const onExternalAbort = () => {
    cancelled = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) {
      cancelled = true;
      controller.abort();
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  try {
    const response = await fetch(`${target.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: stripProviderPrefix(target.modelID),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...payloads.map((payload) => ({
                type: "image_url",
                image_url: { url: payload.url }
              }))
            ]
          }
        ],
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      report({ reason: "http", status: response.status });
      return null;
    }
    const data = await response.json();
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      report({
        reason: "empty",
        ...typeof choice?.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}
      });
      return null;
    }
    return content.trim();
  } catch {
    report(
      cancelled ? { reason: "cancelled" } : timedOut ? { reason: "timeout", timeoutMs: budgetMs } : { reason: "network" }
    );
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
}
function hashContent(content) {
  return createHash5("sha256").update(content).digest("hex");
}
var MAX_PROMPT_USER_TEXT_CHARS = 2e3;
function truncateUserText(text2, maxChars = MAX_PROMPT_USER_TEXT_CHARS) {
  const trimmed = text2.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const marker = "\u2026";
  return `${trimmed.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}
function syntheticHistoryPart(message, text2) {
  return {
    id: syntheticPartId(),
    sessionID: message.info?.sessionID ?? "",
    messageID: message.info?.id ?? "",
    type: "text",
    text: text2,
    synthetic: true
  };
}
function sanitizeVisionHistory(output, sessionVisionText, nativeVisionSessions2 = /* @__PURE__ */ new Set()) {
  if (!Array.isArray(output.messages)) return;
  for (const message of output.messages) {
    if (!message || typeof message !== "object") continue;
    const historyMessage = message;
    const sessionID = historyMessage.info?.sessionID ?? historyMessage.sessionID ?? "";
    if (nativeVisionSessions2.has(sessionID)) continue;
    const descriptions = sessionVisionText.get(sessionID);
    const sanitize = (value, inParts) => {
      if (Array.isArray(value)) {
        let items = null;
        for (let i = 0; i < value.length; i++) {
          const result = sanitize(value[i], inParts);
          if (!result.changed && !items) continue;
          items ??= value.slice(0, i);
          items.push(result.value);
        }
        return items ? { value: items, changed: true } : { value, changed: false };
      }
      if (!value || typeof value !== "object") return { value, changed: false };
      const raw = value;
      const isImageUrl = raw.type === "image_url";
      const isImagePart = raw.type === "image";
      const isImageFile = raw.type === "file" && typeof raw.mime === "string" && raw.mime.toLowerCase().startsWith("image/");
      if (isImageUrl || isImagePart || isImageFile) {
        const partID = typeof raw.id === "string" ? raw.id : "";
        const text2 = descriptions?.get(partID) ?? "Imagem removida do hist\xF3rico antes do envio ao provedor textual.";
        return {
          value: inParts ? syntheticHistoryPart(historyMessage, text2) : { type: "text", text: text2 },
          changed: true
        };
      }
      const entries = Object.entries(value);
      let copy = null;
      for (let i = 0; i < entries.length; i++) {
        const [key, child] = entries[i];
        const result = sanitize(child, key === "parts");
        if (!result.changed && !copy) continue;
        copy ??= Object.fromEntries(entries.slice(0, i));
        copy[key] = result.value;
      }
      return copy ? { value: copy, changed: true } : { value, changed: false };
    };
    const sanitized = sanitize(historyMessage, false);
    if (!sanitized.changed) continue;
    for (const [key, value] of Object.entries(sanitized.value)) {
      historyMessage[key] = value;
    }
  }
}

// src/pantheon/native-vision.ts
var DEFAULT_MODEL = "opencode-go/mimo-v2.6-flash";
var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
var MAX_REDIRECTS = 3;
var IMAGE_TYPES = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
var IMAGE_PROMPT_GENERIC = "Descreva fielmente a imagem anexada. Inclua conte\xFAdo, texto vis\xEDvel, layout e objetos; declare incerteza em vez de adivinhar e responda em portugu\xEAs claro.";
var IMAGE_PROMPT_TEMPLATE = `${IMAGE_PROMPT_GENERIC}
Pergunta do usu\xE1rio: {userText}`;
function buildV2ImagePrompt(userText) {
  const question = truncateUserText(userText ?? "");
  if (!question) return IMAGE_PROMPT_GENERIC;
  return IMAGE_PROMPT_TEMPLATE.replace("{userText}", () => question);
}
var IMAGE_URI_PATTERN = /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i;
function imageReference(uri, mime, name) {
  if (!/^data:image\//i.test(uri)) {
    return `${JSON.stringify(name)} at ${JSON.stringify(uri)}`;
  }
  const path5 = saveDataUrlImageSync(uri, mime);
  if (path5) {
    return `${JSON.stringify(name)} at ${JSON.stringify(path5)}`;
  }
  return `${JSON.stringify(name)} (inline attachment; data URI omitted)`;
}
function buildV2VisionPromptContext(files, userText, sessionID) {
  if (!Array.isArray(files)) return void 0;
  const images = files.flatMap((value, index) => {
    const file = asRecord2(value);
    if (!file) return [];
    const uri = typeof file?.uri === "string" ? file.uri.trim() : "";
    if (!uri) return [];
    const mime = typeof file?.mime === "string" ? file.mime.toLowerCase() : "";
    const image = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime) || /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(uri) || IMAGE_URI_PATTERN.test(uri);
    if (!image) return [];
    const name = typeof file.filename === "string" ? file.filename : typeof file.name === "string" ? file.name : `imagem ${index + 1}`;
    const reference = imageReference(uri, mime, name);
    return [reference];
  });
  if (images.length === 0) return void 0;
  const payload = [`[Visual] ${images.join(" | ")}`];
  const question = truncateUserText(userText ?? "");
  if (question) {
    payload.push(`Q: ${JSON.stringify(question)}`);
  }
  if (isValidSessionId(sessionID)) {
    payload.push(`relay session_id=${JSON.stringify(sessionID)}`);
  }
  payload.push(
    "call vision_describe with the image path; handoff @aphrodite; an image never authorizes a revert"
  );
  return ["<!-- pantheon-visual-context -->", payload.join(" \xB7 ")].join("\n");
}
function asRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function modelList(value) {
  const root = asRecord2(value);
  const candidates = Array.isArray(value) ? value : root?.data ?? root?.models;
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((item) => {
    const model = asRecord2(item);
    return typeof model?.id === "string" && typeof model.providerID === "string";
  });
}
function acceptsImages(model) {
  const input = model.capabilities?.input ?? model.input;
  if (Array.isArray(input)) return input.some((modality) => modality.toLowerCase() === "image");
  return input?.image === true;
}
function supportsZenVision(model) {
  return model.providerID === "opencode" || model.providerID.startsWith("opencode-go");
}
function isFreeVisionModel(model) {
  if (/-free$/i.test(model.id)) return true;
  const input = model.cost?.input;
  return typeof input === "number" && input <= 0;
}
function modelKey(model) {
  return `${model.providerID}/${model.id}`;
}
function exactModelMatch(models, requested) {
  const slash = requested.indexOf("/");
  if (slash < 1) return models.find((model) => model.id === requested);
  const providerID = requested.slice(0, slash);
  const id = requested.slice(slash + 1);
  return models.find((model) => model.providerID === providerID && model.id === id);
}
function selectV2VisionModel(available, preferred) {
  const capable = modelList(available).filter(
    (model) => model.enabled !== false && model.status !== "deprecated" && supportsZenVision(model) && acceptsImages(model)
  );
  const pinned = preferred?.trim();
  if (pinned) {
    return exactModelMatch(capable, pinned);
  }
  const candidates = capable.filter((model) => !isFreeVisionModel(model));
  const defaultModel = exactModelMatch(candidates, DEFAULT_MODEL);
  if (defaultModel) return defaultModel;
  return candidates.sort((left, right) => {
    const priority = (model) => {
      const key = modelKey(model).toLowerCase();
      if (key === DEFAULT_MODEL) return 0;
      return model.providerID.startsWith("opencode-go") ? 1 : model.providerID === "opencode" ? 2 : 3;
    };
    return priority(left) - priority(right) || modelKey(left).localeCompare(modelKey(right));
  })[0];
}
function activePresetCandidates2(directory) {
  const home = process.env.HOME || homedir4();
  const xdg = process.env.XDG_CONFIG_HOME || join10(home, ".config");
  return [
    join10(directory, ".pantheon", "active-preset.json"),
    join10(xdg, "opencode", ".pantheon", "active-preset.json"),
    join10(home, ".opencode", ".pantheon", "active-preset.json")
  ];
}
async function configuredVisionModel(directory) {
  const home = process.env.HOME || homedir4();
  const xdg = process.env.XDG_CONFIG_HOME || join10(home, ".config");
  const paths = [
    join10(directory, ".opencode", "opencode-vision.json"),
    join10(xdg, "opencode", "opencode-vision.json")
  ];
  for (const path5 of paths) {
    try {
      const parsed = JSON.parse(await readFile4(path5, "utf8"));
      if (typeof parsed.visionModel === "string" && parsed.visionModel.trim()) {
        return parsed.visionModel.trim();
      }
    } catch {
    }
  }
  return void 0;
}
async function preferredVisionModel(directory) {
  const envModel = process.env.PANTHEON_VISION_MODEL?.trim();
  if (envModel) return envModel;
  const configModel = await configuredVisionModel(directory);
  if (configModel) return configModel;
  try {
    return resolveActivePreset({
      env: process.env,
      candidates: activePresetCandidates2(directory),
      logger: { warn: () => void 0 }
    })?.vision?.model;
  } catch {
    return void 0;
  }
}
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/))
    return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return void 0;
}
function toImageAttachment(bytes, name) {
  if (bytes.length === 0) throw new Error("image is empty");
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Error("image exceeds OpenCode\u2019s 20 MiB attachment limit");
  const mime = imageMime(bytes);
  if (!mime || !IMAGE_TYPES.has(mime)) {
    throw new Error("unsupported image; use PNG, JPEG, WebP, or GIF");
  }
  return { uri: `data:${mime};base64,${bytes.toString("base64")}`, name };
}
function parseDataUri(value) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match?.[1] || match[2] === void 0) throw new Error("invalid base64 image data URI");
  if (match[2].length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3)) {
    throw new Error("image exceeds OpenCode\u2019s 20 MiB attachment limit");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64") !== match[2]) throw new Error("invalid base64 image data URI");
  return toImageAttachment(bytes, `image.${match[1].slice("image/".length).replace("jpeg", "jpg")}`);
}
function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.includes(".")) return false;
  const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return first >= 8192 && first <= 16383 && !normalized.startsWith("2001:db8:");
}
function createPinnedLookup(record2) {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [record2]);
    else callback(null, record2.address, record2.family);
  };
}
async function pinnedPublicAddress(hostname) {
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const records = await dnsLookup(bareHost, { all: true, verbatim: true });
  if (records.length === 0 || records.some((record3) => !isPublicAddress(record3.address))) {
    throw new Error("remote image host must resolve only to public IP addresses");
  }
  const record2 = records[0];
  if (!record2) throw new Error("remote image host did not resolve");
  return record2;
}
async function readRemoteImage(url, signal, redirects = 0, secureOrigin = url.protocol === "https:") {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("only public HTTP(S) image URLs without credentials are supported");
  }
  if (secureOrigin && url.protocol !== "https:")
    throw new Error("HTTPS image redirects cannot downgrade to HTTP");
  const pinned = await pinnedPublicAddress(url.hostname);
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  const response = await new Promise(
    (resolveResponse, reject) => {
      const request = requestFn(
        url,
        {
          method: "GET",
          headers: { accept: "image/png,image/jpeg,image/webp,image/gif" },
          lookup: createPinnedLookup(pinned),
          ...signal ? { signal } : {}
        },
        (incoming) => {
          const status = incoming.statusCode ?? 0;
          const location = incoming.headers.location;
          if (status >= 300 && status < 400 && location) {
            incoming.resume();
            resolveResponse({ status, location, bytes: Buffer.alloc(0) });
            return;
          }
          const contentLength = Number(incoming.headers["content-length"] ?? 0);
          if (contentLength > MAX_IMAGE_BYTES) {
            incoming.destroy(new Error("image exceeds OpenCode\u2019s 20 MiB attachment limit"));
            reject(new Error("image exceeds OpenCode\u2019s 20 MiB attachment limit"));
            return;
          }
          const chunks = [];
          let total = 0;
          incoming.on("data", (chunk) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += data.length;
            if (total > MAX_IMAGE_BYTES) {
              incoming.destroy(new Error("image exceeds OpenCode\u2019s 20 MiB attachment limit"));
              reject(new Error("image exceeds OpenCode\u2019s 20 MiB attachment limit"));
              return;
            }
            chunks.push(data);
          });
          incoming.on("error", reject);
          incoming.on("end", () => resolveResponse({ status, bytes: Buffer.concat(chunks) }));
        }
      );
      request.setTimeout(15e3, () => request.destroy(new Error("image download timed out")));
      request.on("error", reject);
      request.end();
    }
  );
  if (response.location) {
    if (redirects >= MAX_REDIRECTS) throw new Error("remote image redirected too many times");
    return readRemoteImage(new URL(response.location, url), signal, redirects + 1, secureOrigin);
  }
  if (response.status !== 200) throw new Error(`image download returned HTTP ${response.status}`);
  const name = decodeURIComponent(url.pathname.split("/").at(-1) || "image");
  return { bytes: response.bytes, name: name || "image" };
}
async function imageAttachment(value, directory, signal) {
  const source = value.trim();
  if (!source) throw new Error("path must identify an image file, HTTP(S) URL, or base64 image URI");
  if (source.startsWith("data:")) return parseDataUri(source);
  let url;
  try {
    url = new URL(source);
  } catch {
  }
  if (url?.protocol === "http:" || url?.protocol === "https:") {
    const remote = await readRemoteImage(url, signal);
    return toImageAttachment(remote.bytes, remote.name);
  }
  let localPath;
  if (url?.protocol === "file:") {
    localPath = fileURLToPath2(url);
  } else if (url) {
    throw new Error("only file, HTTP, HTTPS, and base64 image sources are supported");
  } else {
    const expanded = source.startsWith("~/") ? join10(homedir4(), source.slice(2)) : source;
    localPath = resolve4(directory, expanded);
  }
  let bytes;
  try {
    bytes = await readFile4(localPath, signal ? { signal } : void 0);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `image file not found: ${localPath}; pass an existing file path, file URL, public HTTP(S) URL, or base64 image data URI`
      );
    }
    throw error;
  }
  return toImageAttachment(bytes, localPath.split(/[\\/]/).at(-1) || "image");
}
function discoverActiveSessionId(directory) {
  for (const envVar of ["OPENCODE_SESSION_ID", "SESSION_ID"]) {
    const val = (process.env[envVar] ?? "").trim();
    if (isValidSessionId(val)) return val;
  }
  try {
    const dataHome = process.env.XDG_DATA_HOME || join10(homedir4(), ".local", "share");
    const dbPath = process.env.OPENCODE_DB || join10(dataHome, "opencode", "opencode.db");
    if (!existsSync4(dbPath)) return void 0;
    const sqlite = __require("node:sqlite");
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      if (directory) {
        const row = db.prepare(
          "SELECT id FROM session_v2 WHERE directory = ? ORDER BY time_created DESC LIMIT 1"
        ).get(directory);
        if (row && isValidSessionId(row.id)) return String(row.id);
      }
      const fallbackRow = db.prepare("SELECT id FROM session_v2 ORDER BY time_created DESC LIMIT 1").get();
      if (fallbackRow && isValidSessionId(fallbackRow.id)) return String(fallbackRow.id);
    } finally {
      db.close();
    }
  } catch {
  }
  return void 0;
}
function createV2VisionTool(runtime) {
  return {
    name: "vision_describe",
    description: "Analyze an image with an OpenCode Zen multimodal model confirmed by the current V2 model catalog. Prefers the OpenCode Go MiMo 2.6 Flash model and falls back to another live image-capable Zen model. Free-tier models are excluded (the direct gateway rejects them). Accepts a local path, file URL, public HTTP(S) URL, or base64 image data URI.",
    input: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "Local image path, file URL, public HTTP(S) image URL, or base64 image data URI."
        },
        prompt: { type: "string", description: "Optional image-analysis instruction." }
      }
    },
    output: {},
    execute: async (input, rawContext) => {
      let stage = "validate OpenCode session";
      try {
        const call = asRecord2(rawContext) ?? {};
        let sessionID = isValidSessionId(call.sessionID) ? call.sessionID : void 0;
        if (!sessionID) {
          sessionID = discoverActiveSessionId(call.directory || process.cwd());
        }
        if (!sessionID) {
          throw new Error(
            "a valid OpenCode session id is required; retry this tool from an active OpenCode session"
          );
        }
        const pathValue = typeof input.path === "string" ? input.path : "";
        const directory = call.directory || process.cwd();
        stage = "load image";
        const image = await imageAttachment(pathValue, directory, call.signal);
        stage = "read model catalog";
        const preferred = await preferredVisionModel(directory);
        const catalog = await runtime.model.list();
        const model = selectV2VisionModel(catalog, preferred);
        if (!model) {
          if (preferred?.trim()) {
            throw new Error(
              `explicitly configured Vision model "${preferred}" is unavailable or ineligible for the native OpenCode Zen image path; update or remove the explicit model pin (PANTHEON_VISION_MODEL, visionModel config, or active preset), or choose an enabled image-capable OpenCode Zen model`
            );
          }
          throw new Error(
            "no available OpenCode Zen multimodal model accepts image input; connect OpenCode Zen and enable an image-capable model"
          );
        }
        stage = "resolve OpenCode Zen authentication";
        const modelID = modelKey(model);
        const dataHome = process.env.XDG_DATA_HOME || join10(homedir4(), ".local", "share");
        const target = await resolveNativeVisionTarget({
          preset: { vision: { model: modelID } },
          env: { ...process.env, PANTHEON_VISION_MODEL: modelID },
          authStatePath: join10(dataHome, "opencode")
        });
        if (!target) {
          throw new Error(
            "OpenCode Zen authentication is missing; run `opencode auth login` (checked the auth store and the V2 credential database)"
          );
        }
        stage = "send image to the selected multimodal model";
        const requestTarget = {
          ...target,
          sessionID
        };
        let failure;
        const output = await describeImagesNative(
          [{ url: image.uri }],
          requestTarget,
          typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim() : buildV2ImagePrompt(),
          NATIVE_MAX_TOKENS,
          call.signal,
          (details) => {
            failure = details;
          }
        );
        if (!output?.trim()) {
          throw new Error(nativeVisionFailureMessage(failure, modelKey(model)));
        }
        return {
          output: output.trim(),
          title: `Vision \xB7 ${modelKey(model)}`,
          metadata: { model: modelKey(model), attachment: "image" }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "request failed";
        return {
          output: `Error: Pantheon Vision could not analyze the image during ${stage}: ${message}`
        };
      }
    }
  };
}

// src/pantheon/background-job-board.ts
import { mkdir as mkdir4, rename as rename3, unlink as unlink2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname5, join as join11 } from "node:path";

// src/pantheon/bus.ts
var PantheonBus = class {
  listeners = /* @__PURE__ */ new Map();
  /**
   * Register a persistent listener for an event.
   * Returns an unsubscribe callback for easy cleanup.
   */
  on(event, listener) {
    let set = this.listeners.get(event);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) {
        this.listeners.delete(event);
      }
    };
  }
  /**
   * Register a one-shot listener that unregisters itself after firing once.
   */
  once(event, listener) {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      return listener(payload);
    });
    return unsubscribe;
  }
  /**
   * Synchronously emit an event to all registered listeners.
   * Listener rejections are logged safely without throwing.
   */
  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of Array.from(set)) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          result.catch(() => {
          });
        }
      } catch {
      }
    }
  }
  /**
   * Wait asynchronously for a specific event matching a predicate, with an optional timeout.
   */
  waitFor(event, predicate, timeoutMs = 3e4) {
    return new Promise((resolve8, reject) => {
      let timer = null;
      let unsubscribe = null;
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          unsubscribe?.();
          reject(new Error(`Timed out waiting for bus event "${event}" after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      unsubscribe = this.on(event, (payload) => {
        try {
          if (predicate(payload)) {
            if (timer) clearTimeout(timer);
            unsubscribe?.();
            resolve8(payload);
          }
        } catch (err) {
          if (timer) clearTimeout(timer);
          unsubscribe?.();
          reject(err);
        }
      });
    });
  }
  /** Number of active listeners for a specific event or in total. */
  listenerCount(event) {
    if (event) {
      return this.listeners.get(event)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.listeners.values()) {
      total += set.size;
    }
    return total;
  }
  /** Clear all listeners (primarily for unit tests). */
  clear() {
    this.listeners.clear();
  }
};
var BUS_KEY = "__pantheonSharedBus";
function getSharedBus() {
  const host = globalThis;
  if (host[BUS_KEY] instanceof PantheonBus) return host[BUS_KEY];
  const bus = new PantheonBus();
  host[BUS_KEY] = bus;
  return bus;
}

// src/pantheon/background-job-board.ts
var log3 = createPantheonLogger({ module: "BackgroundJobBoard" });
var TERMINAL_STATES = /* @__PURE__ */ new Set([
  "completed",
  "error",
  "cancelled"
]);
var UPDATE_TRANSITIONS = {
  running: /* @__PURE__ */ new Set(["completed", "error", "startup_failed", "startup_unknown", "cancelled"]),
  completed: /* @__PURE__ */ new Set(["completed"]),
  error: /* @__PURE__ */ new Set(["error"]),
  startup_failed: /* @__PURE__ */ new Set(["startup_failed"]),
  startup_unknown: /* @__PURE__ */ new Set(["startup_unknown"]),
  cancelled: /* @__PURE__ */ new Set(["cancelled"]),
  reconciled: /* @__PURE__ */ new Set([])
};
var AGENT_PREFIXES = {
  apollo: "apo",
  hermes: "her",
  aphrodite: "aph",
  demeter: "dem",
  themis: "the",
  prometheus: "pro",
  hephaestus: "hep",
  nyx: "nyx",
  athena: "ath",
  gaia: "gai",
  iris: "iri",
  mnemosyne: "mne",
  talos: "tal"
};
function getAgentPrefix(agent) {
  return AGENT_PREFIXES[agent.toLowerCase()] ?? "job";
}
var BackgroundJobBoard = class {
  jobs = /* @__PURE__ */ new Map();
  /**
   * aliasCounters[parentSessionID][agentPrefix] → next counter value
   */
  aliasCounters = /* @__PURE__ */ new Map();
  terminalListeners = /* @__PURE__ */ new Set();
  terminalWaiters = /* @__PURE__ */ new Map();
  options;
  persistence = null;
  constructor(options) {
    this.options = {
      maxConcurrentPerAgent: options?.maxConcurrentPerAgent ?? 3,
      maxReusablePerAgent: options?.maxReusablePerAgent ?? 3,
      signalDir: options?.signalDir ?? null
    };
  }
  // ─── Persistence ────────────────────────────────────────────────────
  /** Maximum concurrent jobs per agent (mirrors the constructor option). */
  get maxConcurrentPerAgent() {
    return this.options.maxConcurrentPerAgent;
  }
  /** Total entries currently held (running + terminal + reconciled). */
  size() {
    return this.jobs.size;
  }
  /** Inject a persistence adapter. Must be called before `recoverRunningJobs()`. */
  setPersistence(adapter) {
    this.persistence = adapter;
  }
  /**
   * Recover previously persisted jobs on startup.
   * Any jobs left in `running` state are marked as `error` (orphaned by crash).
   */
  async recoverRunningJobs() {
    if (!this.persistence) return;
    const records = await this.persistence.loadAllJobs();
    const recoveredIDs = [];
    for (const record2 of records) {
      if (record2.state === "running") {
        record2.state = "error";
        record2.lastStatusError = "Process restarted \u2014 job marked as errored";
        record2.updatedAt = Date.now();
        record2.completedAt = Date.now();
        record2.totalErrors++;
        record2.terminalUnreconciled = true;
        recoveredIDs.push(record2.taskID);
      }
      this.jobs.set(record2.taskID, record2);
    }
    for (const taskID of recoveredIDs) {
      const job = this.jobs.get(taskID);
      if (job) {
        await this.persistRecord(job);
        await this.writeSignal(job);
        this.notifyTerminal(job.taskID);
      }
    }
  }
  // ─── Core Operations ────────────────────────────────────────────────
  /**
   * Register a new job launch.
   * The job starts in the `running` state with a generated alias.
   */
  async registerLaunch(input) {
    if (!this.canDispatch(input.agent)) {
      throw new Error(
        `Concurrency limit reached for agent "${input.agent}" (${this.getRunningCount(input.agent)} running, max ${this.options.maxConcurrentPerAgent})`
      );
    }
    const prefix = getAgentPrefix(input.agent);
    let sessionCounters = this.aliasCounters.get(input.parentSessionID);
    if (!sessionCounters) {
      sessionCounters = /* @__PURE__ */ new Map();
      this.aliasCounters.set(input.parentSessionID, sessionCounters);
    }
    const counter = (sessionCounters.get(prefix) ?? 0) + 1;
    sessionCounters.set(prefix, counter);
    const now = Date.now();
    const record2 = {
      taskID: input.taskID,
      parentSessionID: input.parentSessionID,
      agent: input.agent,
      description: input.description,
      ...input.objective !== void 0 ? { objective: input.objective } : {},
      state: "running",
      timedOut: false,
      alias: `${prefix}-${counter}`,
      launchedAt: now,
      updatedAt: now,
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: false,
      contextFiles: input.contextFiles ?? []
    };
    this.jobs.set(input.taskID, record2);
    await this.persistRecord(record2);
    getSharedBus().emit("job:created", {
      taskID: record2.taskID,
      alias: record2.alias,
      agent: record2.agent,
      parentSessionID: record2.parentSessionID,
      state: record2.state,
      timestamp: now
    });
    return record2;
  }
  /**
   * Register a launch only when taskID has not already been claimed.
   *
   * The map check and set happen before the first await, so JavaScript's
   * single-threaded event loop makes this critical section atomic even when
   * two event handlers call it concurrently. The existing record is returned
   * for the losing caller.
   */
  async registerLaunchIfAbsent(input) {
    const existing = this.jobs.get(input.taskID);
    if (existing !== void 0) return existing;
    return this.registerLaunch(input);
  }
  /**
   * Update a job's state to a terminal state.
   *
   * Valid transitions: `running` → `completed`|`error`|`cancelled`
   * Idempotent: terminal → same terminal (re-notifies listeners, re-persists).
   * Rejected: `running` → `running`, terminal → different terminal, `reconciled` → anything.
   *
   * Follows write-ahead-log: persist → signal → notify listeners.
   */
  async updateStatus(input) {
    const job = this.jobs.get(input.taskID);
    if (!job) return void 0;
    const allowed = UPDATE_TRANSITIONS[job.state];
    if (!allowed.has(input.state)) {
      throw new Error(
        `Invalid state transition: ${job.state} \u2192 ${input.state} for job ${input.taskID}`
      );
    }
    const wasTerminal = TERMINAL_STATES.has(job.state);
    const willBeTerminal = TERMINAL_STATES.has(input.state);
    job.state = input.state;
    job.updatedAt = Date.now();
    if (input.resultSummary !== void 0) {
      job.resultSummary = input.resultSummary;
    }
    if (input.error !== void 0) {
      job.lastStatusError = input.error;
    }
    if (input.timedOut !== void 0) {
      job.timedOut = input.timedOut;
    }
    if (input.state === "error" || input.state === "startup_failed" || input.state === "startup_unknown") {
      job.totalErrors++;
    }
    if (input.timedOut) {
      job.timeoutCount++;
    }
    if (willBeTerminal) {
      if (job.completedAt === void 0) {
        job.completedAt = Date.now();
      }
      job.terminalUnreconciled = true;
    }
    await this.persistRecord(job);
    getSharedBus().emit("job:updated", {
      taskID: job.taskID,
      alias: job.alias,
      agent: job.agent,
      state: job.state,
      resultSummary: job.resultSummary,
      timestamp: job.updatedAt
    });
    if (willBeTerminal) {
      await this.writeSignal(job);
    }
    if (willBeTerminal && !wasTerminal) {
      this.notifyTerminal(job.taskID);
    }
    return job;
  }
  /**
   * Cancel a running job.
   *
   * More permissive than `updateStatus({ state: 'cancelled' })` — it allows
   * cancelling from any non-terminal state. Idempotent on already-cancelled jobs.
   */
  async markCancelled(taskID, reason) {
    const job = this.jobs.get(taskID);
    if (!job) return void 0;
    if (job.state === "reconciled") {
      throw new Error(`Cannot cancel reconciled job ${taskID}`);
    }
    if (job.state === "cancelled") {
      await this.persistRecord(job);
      await this.writeSignal(job);
      return job;
    }
    if (job.state !== "running") {
      throw new Error(
        `Cannot cancel job ${taskID} in state ${job.state} \u2014 only running jobs can be cancelled`
      );
    }
    const wasTerminal = TERMINAL_STATES.has(job.state);
    job.state = "cancelled";
    job.updatedAt = Date.now();
    if (reason !== void 0) {
      job.lastStatusError = reason;
    }
    job.completedAt ??= Date.now();
    job.terminalUnreconciled = true;
    await this.persistRecord(job);
    await this.writeSignal(job);
    if (!wasTerminal) {
      this.notifyTerminal(job.taskID);
    }
    return job;
  }
  /**
   * Mark a terminal job as reconciled (acknowledged/consumed by the orchestrator).
   *
   * Valid: only `completed`, `error`, or `cancelled` → `reconciled`.
   * Idempotent: already-reconciled jobs are returned as-is.
   * Rejected: `running` → `reconciled`.
   *
   * Reconcile is an ACKNOWLEDGMENT, not a completion event: it does NOT fire
   * the terminal listeners (onTerminal) and does NOT resolve waiters — the
   * terminal transition already did both. Firing them here produced a second
   * `<task-notification>` per job (completed + reconciled) in the parent
   * transcript; waiters are covered by `waitForTerminal` resolving immediately
   * for already-terminal/reconciled jobs.
   */
  async markReconciled(taskID) {
    const job = this.jobs.get(taskID);
    if (!job) return void 0;
    if (job.state === "reconciled") {
      return job;
    }
    if (!TERMINAL_STATES.has(job.state)) {
      throw new Error(
        `Cannot reconcile job ${taskID} in state ${job.state} \u2014 only terminal states can be reconciled`
      );
    }
    job.state = "reconciled";
    job.updatedAt = Date.now();
    job.terminalUnreconciled = false;
    await this.persistRecord(job);
    await this.deleteSignal(job.alias);
    getSharedBus().emit("job:reconciled", {
      taskID: job.taskID,
      alias: job.alias,
      timestamp: job.updatedAt
    });
    return job;
  }
  // ─── Queries ─────────────────────────────────────────────────────────
  /** Look up a job by its taskID. */
  get(taskID) {
    return this.jobs.get(taskID);
  }
  /**
   * List jobs, optionally filtered by parent session ID.
   * Returns a snapshot (shallow copy) of the matching records.
   */
  list(parentSessionID) {
    const all = Array.from(this.jobs.values());
    if (!parentSessionID) return [...all];
    return all.filter((j) => j.parentSessionID === parentSessionID);
  }
  /**
   * Resolve a job by either taskID or alias within a parent session.
   * Checks exact taskID first, then falls back to alias matching.
   */
  resolve(parentSessionID, taskIDOrAlias) {
    const byID = this.jobs.get(taskIDOrAlias);
    if (byID?.parentSessionID === parentSessionID) return byID;
    for (const job of this.jobs.values()) {
      if (job.parentSessionID === parentSessionID && job.alias === taskIDOrAlias) {
        return job;
      }
    }
    return void 0;
  }
  /** Check whether a new job can be dispatched for the given agent (concurrency limit). */
  canDispatch(agent) {
    return this.getRunningCount(agent) < this.options.maxConcurrentPerAgent;
  }
  /** Count currently running jobs, optionally filtered by agent. */
  getRunningCount(agent) {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.state === "running" && (agent === void 0 || job.agent === agent)) {
        count++;
      }
    }
    return count;
  }
  // ─── Terminal State Listeners ────────────────────────────────────────
  /** Register a listener that fires when a job reaches a terminal state. */
  onTerminal(listener) {
    this.terminalListeners.add(listener);
  }
  /** Remove a previously registered terminal state listener. */
  removeTerminalListener(listener) {
    this.terminalListeners.delete(listener);
  }
  /**
   * Resolve with the job record once the job reaches a terminal state
   * (`completed`, `error`, `cancelled`, or `reconciled`), or reject with a
   * timeout error if `timeoutMs` elapses first.
   *
   * Resolves immediately when the job is already terminal at call time.
   * Multiple concurrent waiters for the same taskID all resolve.
   */
  waitForTerminal(taskID, timeoutMs) {
    const existing = this.jobs.get(taskID);
    if (existing && (TERMINAL_STATES.has(existing.state) || existing.state === "reconciled")) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve8, reject) => {
      const waiter = {
        resolve: resolve8,
        reject,
        timer: setTimeout(() => {
          this.removeTerminalWaiter(taskID, waiter);
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for job ${taskID} to reach a terminal state`
            )
          );
        }, timeoutMs)
      };
      const waiters = this.terminalWaiters.get(taskID) ?? [];
      waiters.push(waiter);
      this.terminalWaiters.set(taskID, waiters);
    });
  }
  removeTerminalWaiter(taskID, waiter) {
    const waiters = this.terminalWaiters.get(taskID);
    if (!waiters) return;
    const idx = waiters.indexOf(waiter);
    if (idx < 0) return;
    waiters.splice(idx, 1);
    if (waiters.length === 0) {
      this.terminalWaiters.delete(taskID);
    }
  }
  resolveTerminalWaiters(taskID) {
    const waiters = this.terminalWaiters.get(taskID);
    if (!waiters) return;
    this.terminalWaiters.delete(taskID);
    const job = this.jobs.get(taskID);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (job) {
        waiter.resolve(job);
      } else {
        waiter.reject(new Error(`Job ${taskID} was removed before reaching a terminal state`));
      }
    }
  }
  // ─── Prompt Integration ──────────────────────────────────────────────
  /**
   * Generate a formatted prompt fragment for the agent system prompt,
   * showing all background jobs for the given parent session.
   * Returns `undefined` when there are no jobs (caller can skip the section).
   */
  formatForPrompt(parentSessionID) {
    const jobs = this.list(parentSessionID);
    if (jobs.length === 0) return void 0;
    const lines = jobs.map((j) => {
      const status = j.state === "completed" ? "OK" : j.state === "error" ? "ERR" : j.state === "cancelled" ? "CAN" : j.state === "running" ? "RUN" : "REC";
      return `  [${j.alias}] ${j.description} \u2014 ${status}`;
    });
    return `Background Jobs:
${lines.join("\n")}`;
  }
  // ─── Cleanup ─────────────────────────────────────────────────────────
  /**
   * Remove jobs whose `updatedAt` is older than `ttlMs` milliseconds.
   *
   * Only TERMINAL (completed/error/cancelled) and reconciled jobs are pruned —
   * running jobs are never pruned. Each pruned job is also removed from the
   * persistence adapter so it doesn't resurface after a restart.
   */
  async pruneExpired(ttlMs) {
    const now = Date.now();
    const expired = [];
    for (const job of this.jobs.values()) {
      const isDone = TERMINAL_STATES.has(job.state) || job.state === "reconciled";
      if (isDone && now - job.updatedAt > ttlMs) {
        expired.push(job);
      }
    }
    for (const job of expired) {
      this.jobs.delete(job.taskID);
      await this.deletePersisted(job.taskID);
    }
  }
  /** Remove all jobs belonging to a parent session. */
  clearParent(parentSessionID) {
    for (const [taskID, job] of this.jobs) {
      if (job.parentSessionID === parentSessionID) {
        this.jobs.delete(taskID);
      }
    }
  }
  /**
   * Delete the wake signal file for an alias (`<alias>.signal.json`).
   * No-op (false) when no signalDir is configured or the file is absent.
   * The delegate manager calls this on the spot right after auto-reconcile.
   */
  async deleteSignal(alias) {
    const signalDir = this.options.signalDir;
    if (!signalDir) return false;
    const signalPath = join11(signalDir, `${alias}.signal.json`);
    try {
      await unlink2(signalPath);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Aggressive prune of finished jobs: keep only the `keepNewest` most
   * recently updated completed/error/cancelled/reconciled jobs, evict the
   * rest (memory + persistence). Running jobs are never touched.
   * Returns the number of evicted jobs.
   */
  async pruneCompleted(keepNewest) {
    const done = Array.from(this.jobs.values()).filter((j) => TERMINAL_STATES.has(j.state) || j.state === "reconciled").sort((a, b) => b.updatedAt - a.updatedAt);
    const evict = done.slice(Math.max(0, keepNewest));
    for (const job of evict) {
      this.jobs.delete(job.taskID);
      await this.deletePersisted(job.taskID);
    }
    return evict.length;
  }
  /**
   * Hard entry cap: while the board holds more than `maxEntries` jobs,
   * evict the oldest finished job (by updatedAt). Running jobs are never
   * evicted — when only running jobs remain the cap cannot shrink further
   * and the loop stops. Returns the number of evicted jobs.
   */
  async enforceEntryCap(maxEntries) {
    let evicted = 0;
    for (; ; ) {
      if (this.jobs.size <= Math.max(0, maxEntries)) break;
      const oldest = Array.from(this.jobs.values()).filter((j) => TERMINAL_STATES.has(j.state) || j.state === "reconciled").sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!oldest) break;
      this.jobs.delete(oldest.taskID);
      await this.deletePersisted(oldest.taskID);
      evicted += 1;
    }
    return evicted;
  }
  // ─── Internal Helpers ────────────────────────────────────────────────
  async persistRecord(record2) {
    if (!this.persistence) return;
    try {
      await this.persistence.saveJob(record2);
    } catch (err) {
      log3.error(`[BackgroundJobBoard] Failed to persist job ${record2.taskID}:`, err);
    }
  }
  async deletePersisted(taskID) {
    if (!this.persistence) return;
    try {
      await this.persistence.deleteJob(taskID);
    } catch (err) {
      log3.error(`[BackgroundJobBoard] Failed to delete persisted job ${taskID}:`, err);
    }
  }
  notifyTerminal(taskID) {
    const job = this.jobs.get(taskID);
    if (job) {
      getSharedBus().emit("job:terminal", {
        taskID: job.taskID,
        alias: job.alias,
        agent: job.agent,
        state: job.state,
        resultSummary: job.resultSummary,
        timestamp: job.completedAt ?? Date.now()
      });
    }
    for (const listener of this.terminalListeners) {
      try {
        listener(taskID);
      } catch (err) {
        log3.error(`[BackgroundJobBoard] Terminal listener error for ${taskID}:`, err);
      }
    }
    this.resolveTerminalWaiters(taskID);
  }
  async writeSignal(record2) {
    const signalDir = this.options.signalDir;
    if (!signalDir) return;
    const signalPath = join11(signalDir, `${record2.alias}.signal.json`);
    const tmpPath = join11(signalDir, `${record2.alias}.signal.tmp`);
    const content = JSON.stringify({
      taskID: record2.taskID,
      alias: record2.alias,
      agent: record2.agent,
      state: record2.state,
      summary: record2.resultSummary ?? null,
      timestamp: Date.now()
    });
    try {
      await mkdir4(dirname5(signalPath), { recursive: true });
      await writeFile2(tmpPath, content, "utf-8");
      await rename3(tmpPath, signalPath);
    } catch (err) {
      log3.error(`[BackgroundJobBoard] Failed to write signal for ${record2.alias}:`, err);
    }
  }
};

// src/pantheon/file-persistence.ts
import { mkdir as mkdir5, open as open2, readFile as readFile5, rename as rename4, unlink as unlink3 } from "node:fs/promises";
import { dirname as dirname6, resolve as resolve5 } from "node:path";

// src/pantheon/file-persistence-salvage.ts
function salvageRecords(content) {
  const records = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        const candidate = content.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed !== null && typeof parsed === "object" && typeof parsed.taskID === "string") {
            records.push(parsed);
          }
        } catch {
        }
        start = -1;
      }
    }
  }
  return records;
}

// src/pantheon/file-persistence.ts
var log4 = createPantheonLogger({ module: "FilePersistence" });
var DEFAULT_STATE_PATH = ".pantheon/board/state.json";
var RENAME_MAX_ATTEMPTS = 3;
var defaultFsOps = {
  mkdir: async (dir) => {
    await mkdir5(dir, { recursive: true });
  },
  readFile: (path5, encoding) => readFile5(path5, encoding),
  rename: (from, to) => rename4(from, to),
  openForWrite: (path5) => open2(path5, "w"),
  unlink: (path5) => unlink3(path5)
};
function isEnoent(err) {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}
var writeQueues = /* @__PURE__ */ new Map();
function enqueueWrite(key, task) {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  writeQueues.set(
    key,
    run.then(
      () => void 0,
      () => void 0
    )
  );
  return run;
}
var FilePersistenceAdapter = class {
  statePath;
  dir;
  ops;
  lockKey;
  tmpCounter = 0;
  /**
   * @param statePath  Path to the state JSON file (default: `.pantheon/board/state.json`)
   * @param ops        Filesystem operations (defaults to real Node.js fs; injectable for tests)
   */
  constructor(statePath, ops = defaultFsOps) {
    this.statePath = statePath ?? DEFAULT_STATE_PATH;
    this.dir = dirname6(this.statePath);
    this.ops = ops;
    this.lockKey = resolve5(this.statePath);
  }
  /** Ensure the parent directory exists. */
  async ensureDir() {
    await this.ops.mkdir(this.dir);
  }
  /** Unique temp path per write — prevents two writers racing the same tmp. */
  makeTmpPath() {
    this.tmpCounter += 1;
    const unique = `${process.pid}.${this.tmpCounter}.${Math.random().toString(36).slice(2, 8)}`;
    return `${this.statePath}.${unique}.tmp`;
  }
  /**
   * Read all jobs from the state file.
   *
   * Return contract distinguishes three failure modes:
   * - absent file (ENOENT) → `[]` (first run / no jobs yet);
   * - corrupt content → quarantine + `salvageRecords()` (best-effort recovery);
   * - non-ENOENT IO error (e.g. EIO) → `null`, signalling the read failed.
   *
   * Callers doing read-modify-write MUST abort on `null` so a failed read
   * cannot overwrite the on-disk state with a partial snapshot.
   */
  async readState() {
    let content;
    try {
      content = await this.ops.readFile(this.statePath, "utf-8");
    } catch (err) {
      if (isEnoent(err)) return [];
      log4.error(`[FilePersistence] Failed to read ${this.statePath}:`, err);
      return null;
    }
    try {
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error("state.json is not a JSON array");
      }
      return parsed;
    } catch (err) {
      await this.quarantineCorrupt(err);
      const salvaged = salvageRecords(content);
      log4.warn(
        `[FilePersistence] Corrupt ${this.statePath} \u2014 recovered ${salvaged.length} record(s)`
      );
      return salvaged;
    }
  }
  /** Move a corrupt state.json aside so the next write starts from a clean file. */
  async quarantineCorrupt(cause) {
    const backupPath = `${this.statePath}.corrupt-${Date.now()}`;
    try {
      await this.ops.rename(this.statePath, backupPath);
      log4.error(`[FilePersistence] Corrupt ${this.statePath} backed up to ${backupPath}:`, cause);
    } catch (err) {
      log4.error(
        `[FilePersistence] Could not back up corrupt ${this.statePath} \u2014 continuing with salvaged state:`,
        err
      );
    }
  }
  /** Write the full state array: unique tmp + fsync + rename (with ENOENT retry). */
  async writeState(records) {
    const content = JSON.stringify(records, null, 2);
    const tmpPath = this.makeTmpPath();
    let lastError;
    for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
      try {
        await this.ensureDir();
        const handle = await this.ops.openForWrite(tmpPath);
        try {
          await handle.writeFile(content, "utf-8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.ops.rename(tmpPath, this.statePath);
        return;
      } catch (err) {
        lastError = err;
        if (!isEnoent(err)) break;
        log4.warn(
          `[FilePersistence] rename ENOENT for ${this.statePath} (attempt ${attempt}/${RENAME_MAX_ATTEMPTS}) \u2014 recreating dir and retrying`
        );
        await this.safeUnlink(tmpPath);
      }
    }
    await this.safeUnlink(tmpPath);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  async safeUnlink(path5) {
    try {
      await this.ops.unlink(path5);
    } catch {
    }
  }
  async saveJob(record2) {
    await enqueueWrite(this.lockKey, async () => {
      const records = await this.readState();
      if (records === null) {
        log4.error(
          `[FilePersistence] Aborting saveJob(${record2.taskID}): could not read ${this.statePath} \u2014 refusing to overwrite state with a partial snapshot`
        );
        return;
      }
      const idx = records.findIndex((r) => r.taskID === record2.taskID);
      if (idx >= 0) {
        records[idx] = record2;
      } else {
        records.push(record2);
      }
      await this.writeState(records);
    });
  }
  async loadAllJobs() {
    return await this.readState() ?? [];
  }
  async deleteJob(taskID) {
    await enqueueWrite(this.lockKey, async () => {
      const records = await this.readState();
      if (!records) return;
      const idx = records.findIndex((r) => r.taskID === taskID);
      if (idx < 0) return;
      records.splice(idx, 1);
      await this.writeState(records);
    });
  }
};

// src/pantheon/shared-board.ts
var BOARD_KEY = "__pantheonSharedBoard";
var BOARD_OPTIONS = {
  maxConcurrentPerAgent: 3,
  signalDir: ".pantheon/deepwork/board-signals"
};
function getSharedBoard() {
  const host = globalThis;
  const existing = host[BOARD_KEY];
  if (existing instanceof BackgroundJobBoard) return existing;
  const board = new BackgroundJobBoard(BOARD_OPTIONS);
  board.setPersistence(new FilePersistenceAdapter(".pantheon/board/state.json"));
  host[BOARD_KEY] = board;
  return board;
}

// src/pantheon/shell-hooks.ts
import { randomUUID as randomUUID3 } from "node:crypto";

// src/plugins/hook-runner.ts
import { spawn } from "node:child_process";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var HOOK_TIMEOUT_MS = 15e3;
var HOOK_MAX_BUFFER = 10 * 1024 * 1024;
function resolveHooksDir() {
  return fileURLToPath3(new URL("../../scripts/hooks/", import.meta.url));
}
function hookEnv(payload, extra) {
  return {
    ...process.env,
    PATH: process.env.PATH ?? "",
    SESSION_ID: payload.session_id ?? "",
    AGENT_NAME: payload.agent_id ?? "",
    TASK_DESC: payload.tool_name ?? "",
    ...extra ?? {}
  };
}
function runHook(script, payload, opts = {}) {
  const scriptPath = path3.join(opts.cwd ?? resolveHooksDir(), script);
  const timeout = opts.timeout ?? HOOK_TIMEOUT_MS;
  let serializedPayload;
  try {
    serializedPayload = JSON.stringify(payload);
  } catch (err) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: `payload serialization failed: ${err instanceof Error ? err.message : String(err)}`,
      signal: null,
      timedOut: false
    });
  }
  return new Promise((resolve8) => {
    const stdoutBuf = { value: "" };
    const stderrBuf = { value: "" };
    let settled = false;
    let timedOut = false;
    let timeoutHandle;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        if (timeoutHandle !== void 0) clearTimeout(timeoutHandle);
        resolve8(result);
      }
    };
    const spawnOpts = {
      env: hookEnv(payload, opts.env),
      // stdio:'pipe' is equivalent to ['pipe','pipe','pipe'] — it guarantees
      // the child's stdin is OUR pipe, NEVER the opencode TUI's terminal
      // (which would leave `cat`-style hooks blocked reading forever and hit
      // the opencode core hook timeout).
      stdio: "pipe",
      windowsHide: true,
      // A process group lets the timeout kill shell descendants too. Without
      // this, a shell hook can leave `sleep` holding stdout/stderr open after
      // the shell itself receives SIGKILL, so the Promise would not settle.
      ...process.platform !== "win32" ? { detached: true } : {},
      ...opts.cwd !== void 0 ? { cwd: opts.cwd } : {}
    };
    let child;
    try {
      child = spawn(scriptPath, [], spawnOpts);
    } catch (err) {
      settle({
        code: 1,
        stdout: "",
        stderr: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        signal: null,
        timedOut: false
      });
      return;
    }
    child.stdin.on("error", () => {
    });
    const collect = (stream, buf) => {
      stream.setEncoding("utf-8");
      stream.on("data", (chunk) => {
        if (buf.value.length < HOOK_MAX_BUFFER) {
          buf.value += chunk.slice(0, HOOK_MAX_BUFFER - buf.value.length);
        }
      });
    };
    collect(child.stdout, stdoutBuf);
    collect(child.stderr, stderrBuf);
    child.on("error", (err) => {
      settle({
        code: 1,
        stdout: stdoutBuf.value,
        stderr: stderrBuf.value || `hook script failed to spawn: ${err.message}`,
        signal: null,
        timedOut: false
      });
    });
    child.on("close", (code, signal) => {
      settle({
        code: code ?? 1,
        stdout: stdoutBuf.value,
        stderr: stderrBuf.value,
        signal,
        timedOut
      });
    });
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid !== void 0) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
    }, timeout);
    child.stdin.write(serializedPayload);
    child.stdin.end();
  });
}

// src/pantheon/shell-hooks.ts
var V2_DELEGATION_TOOL_RE = /^(task|.*subagent.*)$/i;
var FORMATTER_SCRIPT = "format-multi-language.sh";
var DELEGATION_START_SCRIPT = "on-subagent-delegation-start.sh";
var DELEGATION_STOP_SCRIPT = "on-subagent-delegation-stop.sh";
var IDLE_RESULT = { code: 0, stdout: "", stderr: "", signal: null, timedOut: false };
var defaultRunner = async (script, payload) => {
  const record2 = payload ?? {};
  const tool2 = typeof record2.tool_name === "string" ? record2.tool_name : "";
  if (script === DELEGATION_START_SCRIPT) {
    const delegationID = typeof record2.delegation_id === "string" ? record2.delegation_id : "";
    const agent = typeof record2.agent_id === "string" ? record2.agent_id : "";
    const sessionID = typeof record2.session_id === "string" ? record2.session_id : "";
    const task = record2.tool_input !== null && typeof record2.tool_input === "object" ? String(record2.tool_input.description ?? "") : "";
    appendDelegationAuditLine(
      delegationStartLine({ agent, task, sessionID, delegationID, now: Date.now() })
    );
    return IDLE_RESULT;
  }
  if (script === DELEGATION_STOP_SCRIPT) {
    const delegationID = typeof record2.delegation_id === "string" ? record2.delegation_id : "";
    const agent = typeof record2.agent_id === "string" ? record2.agent_id : "";
    const sessionID = typeof record2.session_id === "string" ? record2.session_id : "";
    const status = typeof record2.status === "string" ? record2.status : "";
    const taskID = typeof record2.task_id === "string" ? record2.task_id : "";
    const duration = typeof record2.duration_ms === "number" && Number.isFinite(record2.duration_ms) ? Math.max(0, Math.round(record2.duration_ms)) : null;
    appendDelegationAuditLine(
      delegationStopLine({
        agent,
        status,
        reason: status,
        task: record2.tool_input !== null && typeof record2.tool_input === "object" ? String(record2.tool_input.description ?? "") : "",
        sessionID,
        result: record2.tool_output ?? null,
        delegationID,
        taskID,
        durationMs: duration,
        now: Date.now()
      })
    );
    return IDLE_RESULT;
  }
  if (script === FORMATTER_SCRIPT) {
    if (!formatterApplies(tool2, record2.tool_input)) return IDLE_RESULT;
    return runHook(script, payload);
  }
  return runHook(script, payload);
};
var MAX_PENDING_STARTS = 256;
function text(value) {
  return typeof value === "string" ? value : "";
}
function delegationAgent(tool2, args) {
  if (args !== null && typeof args === "object") {
    const record2 = args;
    for (const key of ["subagent_type", "subagentType", "agent", "target"]) {
      const candidate = record2[key];
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    }
  }
  return tool2;
}
function extractTaskID(result) {
  if (result === null || typeof result !== "object") return "";
  const record2 = result;
  const direct = record2.task_id ?? record2.taskID;
  if (typeof direct === "string") return direct;
  const metadata = record2.metadata;
  if (metadata !== null && typeof metadata === "object") {
    const nested = metadata.task_id;
    if (typeof nested === "string") return nested;
  }
  return "";
}
function delegationStatus(event) {
  if (event.status === "error") return "failure";
  const result = event.result;
  if (result !== null && typeof result === "object") {
    const metadata = result.metadata;
    if (metadata !== null && typeof metadata === "object") {
      for (const key of ["status", "state"]) {
        const value = metadata[key];
        if (typeof value === "string" && /^(running|queued|pending|scheduled)$/i.test(value.trim())) {
          return "dispatched";
        }
      }
    }
  }
  return extractTaskID(result) !== "" ? "dispatched" : "success";
}
function createV2ShellHooks(options = {}) {
  const run = options.run ?? defaultRunner;
  const now = options.now ?? Date.now;
  const starts = /* @__PURE__ */ new Map();
  let unkeyedWarned = false;
  const warnUnkeyed = (phase) => {
    if (unkeyedWarned) return;
    unkeyedWarned = true;
    options.onUnkeyed?.(
      `[delegation-audit] ${phase} event carries no tool call id; the audit record was skipped because a START without a key can never be joined by its STOP`
    );
  };
  const fire = async (script, payload) => {
    try {
      await run(script, payload);
    } catch {
    }
  };
  const basePayload = (event) => ({
    tool_name: text(event.tool),
    tool_input: event.input ?? {},
    agent_id: text(event.agent),
    session_id: text(event.sessionID)
  });
  return {
    async before(rawEvent) {
      if (rawEvent === null || typeof rawEvent !== "object") return;
      const event = rawEvent;
      const tool2 = text(event.tool);
      if (!V2_DELEGATION_TOOL_RE.test(tool2)) return;
      const callID = text(event.id);
      if (callID === "") {
        warnUnkeyed("execute.before");
        return;
      }
      const start = {
        delegationId: randomUUID3(),
        agent: delegationAgent(tool2, event.input),
        startedAt: now()
      };
      while (starts.size >= MAX_PENDING_STARTS) {
        const oldest = starts.keys().next().value;
        if (oldest === void 0) break;
        starts.delete(oldest);
      }
      starts.set(callID, start);
      await fire(DELEGATION_START_SCRIPT, {
        ...basePayload(event),
        agent_id: start.agent,
        delegation_id: start.delegationId
      });
    },
    async after(rawEvent) {
      if (rawEvent === null || typeof rawEvent !== "object") return;
      const event = rawEvent;
      const tool2 = text(event.tool);
      const payload = basePayload(event);
      await fire(FORMATTER_SCRIPT, payload);
      if (!V2_DELEGATION_TOOL_RE.test(tool2)) return;
      const callID = text(event.id);
      if (callID === "") {
        warnUnkeyed("execute.after");
        return;
      }
      const start = starts.get(callID);
      starts.delete(callID);
      const taskID = extractTaskID(event.result);
      await fire(DELEGATION_STOP_SCRIPT, {
        ...payload,
        ...start === void 0 ? {
          // No BEFORE record (the call was rejected before the audit ran, or
          // the record was evicted). The STOP still needs a key field to be a
          // well-formed audit line, so it gets a fresh one — an orphan STOP,
          // never an unkeyed one.
          delegation_id: randomUUID3()
        } : {
          // The BEFORE-time agent wins: the AFTER-time args may carry the
          // merged background result, which has no subagent_type.
          agent_id: start.agent,
          delegation_id: start.delegationId,
          duration_ms: Math.max(0, now() - start.startedAt)
        },
        status: delegationStatus(event),
        tool_output: event.result ?? null,
        ...taskID === "" ? {} : { task_id: taskID }
      });
    }
  };
}

// src/pantheon/todo-enforcer.ts
var log5 = createPantheonLogger({ module: "pantheon-todo" });
var TODO_CONTINUATION_PROMPT = "Continue: pending todos remain \u2014 review and proceed.";
var TODO_ENFORCER_DEFAULTS = {
  enabled: true,
  cooldownBaseMs: 5e3,
  maxConsecutiveFailures: 5,
  failureResetMs: 3e5,
  /** Skip injection this long after a user message in the session. */
  userActivityQuietMs: 3e4,
  /** A native (non-board) child whose `time.updated` is newer than this is still running. */
  childActiveMs: 12e4
};
function todoEnforcerEnabledFromEnv(env = process.env) {
  return (env.PANTHEON_TODO_ENFORCER ?? "").trim().toLowerCase() !== "off";
}
var TodoEnforcer = class {
  client;
  board;
  options;
  warn;
  /** Guard 2: sessions with an in-flight onIdle (reserved synchronously). */
  inFlight = /* @__PURE__ */ new Set();
  /** Last injection timestamp per session. */
  lastInjectionAt = /* @__PURE__ */ new Map();
  /** Incomplete-todo count recorded at the last injection per session. */
  lastInjectedIncomplete = /* @__PURE__ */ new Map();
  /** True when the last injection's outcome has NOT been evaluated yet. */
  pendingCheck = /* @__PURE__ */ new Map();
  /** Consecutive failures per session. */
  failures = /* @__PURE__ */ new Map();
  /** Last user-message timestamp per session (wired from chat.message). */
  lastUserMessageAt = /* @__PURE__ */ new Map();
  constructor(deps) {
    this.client = deps.client;
    this.board = deps.board;
    const opts = deps.options ?? {};
    this.options = {
      enabled: opts.enabled ?? TODO_ENFORCER_DEFAULTS.enabled,
      cooldownBaseMs: opts.cooldownBaseMs ?? TODO_ENFORCER_DEFAULTS.cooldownBaseMs,
      maxConsecutiveFailures: opts.maxConsecutiveFailures ?? TODO_ENFORCER_DEFAULTS.maxConsecutiveFailures,
      failureResetMs: opts.failureResetMs ?? TODO_ENFORCER_DEFAULTS.failureResetMs,
      userActivityQuietMs: opts.userActivityQuietMs ?? TODO_ENFORCER_DEFAULTS.userActivityQuietMs,
      childActiveMs: opts.childActiveMs ?? TODO_ENFORCER_DEFAULTS.childActiveMs,
      now: opts.now ?? Date.now
    };
    this.warn = deps.logger?.warn ?? ((message) => log5.warn(message));
  }
  /**
   * Record that the user just sent a message in `sessionID` (wired from the
   * plugin `chat.message` hook). Suppresses injection for `userActivityQuietMs`
   * — an interactive session is being driven by the user, don't nag it.
   */
  noteUserActivity(sessionID) {
    this.lastUserMessageAt.set(sessionID, this.options.now());
  }
  /**
   * List the session's PENDING todos (not completed/cancelled) — the same
   * incomplete filter as the idle continuation, exposed for the compaction
   * context builder. Returns [] when the enforcer is disabled or the todo
   * API fails (fail-open: the compaction hook must never break the
   * session).
   */
  async listPendingTodos(sessionID) {
    if (!this.options.enabled) return [];
    const path5 = safeSessionPath(sessionID);
    if (!path5) {
      this.warn(`todo list skipped: invalid sessionID "${sessionID}"`);
      return [];
    }
    try {
      const todos = await this.client.session.todo(path5);
      return todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.warn(`todo list failed for session ${sessionID}: ${reason}`);
      return [];
    }
  }
  /**
   * Handle a `session.idle` event for a non-board session. Evaluates the
   * previous injection's outcome, applies the guards, and injects the
   * continuation prompt when incomplete todos remain and the guards allow.
   * Never throws — internal failures are logged and swallowed.
   */
  async onIdle(sessionID) {
    if (!this.options.enabled) return;
    if (this.inFlight.has(sessionID)) return;
    this.inFlight.add(sessionID);
    try {
      await this.handleIdle(sessionID);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.warn(`todo injection failed for session ${sessionID}: ${reason}`);
    } finally {
      this.inFlight.delete(sessionID);
    }
  }
  async handleIdle(sessionID) {
    const now = this.options.now();
    const lastUser = this.lastUserMessageAt.get(sessionID);
    if (lastUser !== void 0 && now - lastUser < this.options.userActivityQuietMs) return;
    if (this.board.list(sessionID).some((job) => job.state === "running")) return;
    if (await this.activeChildren(sessionID, now) > 0) return;
    const path5 = safeSessionPath(sessionID);
    if (!path5) {
      this.warn(`todo check skipped: invalid sessionID "${sessionID}"`);
      return;
    }
    const todos = await this.client.session.todo(path5);
    const incomplete = todos.filter(
      (todo) => todo.status !== "completed" && todo.status !== "cancelled"
    ).length;
    if (incomplete === 0) {
      this.pendingCheck.delete(sessionID);
      return;
    }
    if (this.pendingCheck.get(sessionID) === true) {
      const before = this.lastInjectedIncomplete.get(sessionID);
      if (before !== void 0 && incomplete >= before) {
        this.failures.set(sessionID, (this.failures.get(sessionID) ?? 0) + 1);
      } else {
        this.failures.set(sessionID, 0);
      }
      this.pendingCheck.delete(sessionID);
    }
    const lastInjection = this.lastInjectionAt.get(sessionID);
    if (lastInjection !== void 0 && (this.failures.get(sessionID) ?? 0) > 0 && now - lastInjection >= this.options.failureResetMs) {
      this.failures.set(sessionID, 0);
    }
    const failures = this.failures.get(sessionID) ?? 0;
    if (failures >= this.options.maxConsecutiveFailures) return;
    if (lastInjection !== void 0 && now - lastInjection < this.cooldownMs(failures)) {
      return;
    }
    this.lastInjectionAt.set(sessionID, now);
    const inherited = await this.inheritAgentOrModel(sessionID);
    const promptPath = safeSessionPath(sessionID);
    if (!promptPath) {
      this.warn(`todo injection skipped: invalid sessionID "${sessionID}"`);
      return;
    }
    await this.client.session.promptAsync({
      path: promptPath.path,
      body: {
        ...inherited.agent !== void 0 ? { agent: inherited.agent } : {},
        ...inherited.model !== void 0 ? { model: inherited.model } : {},
        parts: [{ type: "text", text: TODO_CONTINUATION_PROMPT }]
      }
    });
    this.lastInjectedIncomplete.set(sessionID, incomplete);
    this.pendingCheck.set(sessionID, true);
  }
  /** Cooldown for a given failure count: base * 2^min(failures, cap). */
  cooldownMs(failures) {
    return this.options.cooldownBaseMs * 2 ** Math.min(failures, this.options.maxConsecutiveFailures);
  }
  /**
   * Count active child sessions. Children fall into two classes:
   *
   *  - BOARD children (delegated via the toolset): the child session ID IS
   *    the board task ID, so `board.get(child.id)` resolves. The board state
   *    machine is authoritative — active ONLY while `state === 'running'`;
   *    a terminal job (completed/error/cancelled/reconciled) is NOT active,
   *    even though its `time.updated` froze at completion (the frozen
   *    timestamp is exactly the T6 bug that made a finished delegation look
   *    "still running" for `childActiveMs`).
   *  - NATIVE children (opencode `task(background=true)`, NOT on our board):
   *    `board.get(child.id)` is undefined, so the heuristic applies — active
   *    while its `time.updated` is newer than `childActiveMs` (a running
   *    native task keeps updating its session while streaming; a completed
   *    one freezes).
   *
   * Fail-open: when the children API is unavailable (older opencode /
   * permission), log and return 0 so the enforcer still works on
   * version-sensitive runtimes.
   */
  async activeChildren(sessionID, now) {
    const path5 = safeSessionPath(sessionID);
    if (!path5) {
      this.warn(`children check skipped: invalid sessionID "${sessionID}"`);
      return 0;
    }
    try {
      const children = await this.client.session.children(path5);
      return children.filter((child) => this.isChildActive(child, now)).length;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.warn(`todo children check failed for session ${sessionID}: ${reason}`);
      return 0;
    }
  }
  /**
   * Whether a single child counts as active. Board children (the child's
   * session ID matches a board task ID) are active only while the job is
   * `running` — terminal board states never suppress. Native children
   * (no board job) use the `time.updated` freshness heuristic.
   */
  isChildActive(child, now) {
    const job = this.board.get(child.id);
    if (job !== void 0) return job.state === "running";
    const updated = child.time?.updated;
    return typeof updated === "number" && now - updated < this.options.childActiveMs;
  }
  /**
   * Inherit the agent (or model) from the LAST assistant message so the
   * continuation runs in the same context as the session's last turn. Returns
   * an empty object when no assistant message carries usable context — the
   * SDK then applies the session default.
   */
  async inheritAgentOrModel(sessionID) {
    const path5 = safeSessionPath(sessionID);
    if (!path5) {
      this.warn(`inherit skipped: invalid sessionID "${sessionID}"`);
      return {};
    }
    const messages = await this.client.session.messages(path5);
    for (const msg of [...messages].reverse()) {
      const info = msg.info;
      if (info === void 0 || info.role !== "assistant") continue;
      if (typeof info.agent === "string" && info.agent !== "") {
        return { agent: info.agent };
      }
      const providerID = info.model?.providerID ?? info.providerID;
      const modelID = info.model?.modelID ?? info.modelID;
      if (typeof providerID === "string" && providerID !== "" && typeof modelID === "string" && modelID !== "") {
        return { model: { providerID, modelID } };
      }
    }
    return {};
  }
};

// src/pantheon/tools.ts
import { exec } from "node:child_process";
import { promisify } from "node:util";

// src/pantheon/cost-command.ts
import { execFile } from "node:child_process";
import { accessSync, constants as constants3, existsSync as existsSync6, statSync as statSync3 } from "node:fs";
import { delimiter, dirname as dirname8, join as join14 } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";
import { z } from "zod";

// src/plugins/tui/src/cost-data.ts
import { homedir as homedir6 } from "node:os";
import { join as join13 } from "node:path";

// src/plugins/tui/src/model-pricing.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync6, renameSync as renameSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { dirname as dirname7, join as join12 } from "node:path";
var MODELS_DEV_URL = "https://models.dev/api.json";
var PRICING_CACHE_VERSION = 1;
var PRICING_TTL_MS = 24 * 60 * 60 * 1e3;
var PRICING_TIMEOUT_MS = 3e3;
function resolvePricingCacheDir(env = process.env) {
  const explicit = env.PANTHEON_HOME?.trim();
  if (explicit !== void 0 && explicit !== "") return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg !== void 0 && xdg !== "" ? xdg : join12(homedir5(), ".config");
  return join12(base, "opencode");
}
function resolvePricingCachePath(env = process.env) {
  return join12(resolvePricingCacheDir(env), "cache", "models-dev.json");
}
function isRecord19(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
var MAX_SANE_PER_MTOK = 1e5;
function nonNegativePrice(value) {
  const parsed = finiteNumber(value);
  if (parsed === void 0 || parsed < 0 || parsed > MAX_SANE_PER_MTOK) return void 0;
  return parsed;
}
function buildPrice(input, output, cacheRead, cacheWrite) {
  if (input === void 0 || output === void 0) return void 0;
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    ...cacheRead === void 0 ? {} : { cacheReadPerMTok: cacheRead },
    ...cacheWrite === void 0 ? {} : { cacheWritePerMTok: cacheWrite }
  };
}
function parseNormalizedPrice(value) {
  if (!isRecord19(value)) return void 0;
  return buildPrice(
    nonNegativePrice(value.inputPerMTok),
    nonNegativePrice(value.outputPerMTok),
    nonNegativePrice(value.cacheReadPerMTok),
    nonNegativePrice(value.cacheWritePerMTok)
  );
}
function parseNormalizedProviders(value) {
  if (!isRecord19(value)) return void 0;
  const providers = {};
  for (const [providerId, models] of Object.entries(value)) {
    if (!isRecord19(models)) continue;
    const priced = {};
    for (const [modelId, price] of Object.entries(models)) {
      const parsed = parseNormalizedPrice(price);
      if (parsed !== void 0) priced[modelId.toLowerCase()] = parsed;
    }
    if (Object.keys(priced).length > 0) providers[providerId.toLowerCase()] = priced;
  }
  return Object.keys(providers).length === 0 ? void 0 : providers;
}
function parseModelPrice(model) {
  if (!isRecord19(model)) return void 0;
  const cost = model.cost;
  if (!isRecord19(cost)) return void 0;
  return buildPrice(
    nonNegativePrice(cost.input),
    nonNegativePrice(cost.output),
    nonNegativePrice(cost.cache_read),
    nonNegativePrice(cost.cache_write)
  );
}
function parseCatalogPayload(payload) {
  if (!isRecord19(payload)) return void 0;
  const providers = {};
  for (const [providerId, provider] of Object.entries(payload)) {
    if (!isRecord19(provider)) continue;
    const models = provider.models;
    if (!isRecord19(models)) continue;
    const priced = {};
    for (const [modelId, model] of Object.entries(models)) {
      const price = parseModelPrice(model);
      if (price !== void 0) priced[modelId.toLowerCase()] = price;
    }
    if (Object.keys(priced).length > 0) providers[providerId.toLowerCase()] = priced;
  }
  return Object.keys(providers).length === 0 ? void 0 : providers;
}
function priceKey(price) {
  return [
    price.inputPerMTok,
    price.outputPerMTok,
    price.cacheReadPerMTok ?? "-",
    price.cacheWritePerMTok ?? "-"
  ].join("/");
}
function indexCatalog(providers) {
  const index = /* @__PURE__ */ new Map();
  const modelIndex = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Map();
  for (const [providerId, models] of Object.entries(providers)) {
    for (const [modelId, price] of Object.entries(models)) {
      index.set(`${providerId}/${modelId}`, price);
      const bucket = modelIndex.get(modelId) ?? [];
      const keys = seen.get(modelId) ?? /* @__PURE__ */ new Set();
      const key = priceKey(price);
      if (!keys.has(key)) {
        keys.add(key);
        bucket.push(price);
        seen.set(modelId, keys);
        modelIndex.set(modelId, bucket);
      }
    }
  }
  return { index, modelIndex };
}
function snapshotFromCatalog(catalog, now, ttlMs, refreshing) {
  const { index, modelIndex } = indexCatalog(catalog.providers);
  return {
    index,
    modelIndex,
    fetchedAt: catalog.fetchedAt,
    stale: Math.max(0, now - catalog.fetchedAt) > ttlMs,
    refreshing
  };
}
function unavailableSnapshot(reason) {
  return {
    index: /* @__PURE__ */ new Map(),
    modelIndex: /* @__PURE__ */ new Map(),
    stale: false,
    refreshing: false,
    unavailableReason: reason
  };
}
function parseCachedCatalog(raw) {
  if (!isRecord19(raw)) return void 0;
  if (raw.version !== PRICING_CACHE_VERSION) return void 0;
  const fetchedAt = finiteNumber(raw.fetchedAt);
  if (fetchedAt === void 0) return void 0;
  const providers = parseNormalizedProviders(raw.providers);
  if (providers === void 0) return void 0;
  return { version: PRICING_CACHE_VERSION, fetchedAt, providers };
}
function readPricingCache(cachePath) {
  try {
    if (!existsSync5(cachePath)) return void 0;
    return parseCachedCatalog(JSON.parse(readFileSync6(cachePath, "utf8")));
  } catch {
    return void 0;
  }
}
function writePricingCache(cachePath, catalog) {
  const temp = `${cachePath}.tmp-${process.pid}`;
  try {
    mkdirSync5(dirname7(cachePath), { recursive: true });
    writeFileSync4(temp, `${JSON.stringify(catalog)}
`, "utf8");
    renameSync3(temp, cachePath);
    return true;
  } catch {
    return false;
  }
}
var inFlight = /* @__PURE__ */ new Map();
var OFFLINE_REFUSAL = "refreshPricing cannot run: PANTHEON_COST_OFFLINE=1 (or the offline option) forbids every network request";
function isPricingOffline(options) {
  const env = options?.env ?? process.env;
  return options?.offline === true || env.PANTHEON_COST_OFFLINE === "1";
}
function refreshPricingCatalog(options) {
  if (isPricingOffline(options)) {
    return Promise.resolve({
      ...unavailableSnapshot(OFFLINE_REFUSAL),
      refused: true,
      offline: true
    });
  }
  const env = options?.env ?? process.env;
  const cachePath = options?.cachePath ?? resolvePricingCachePath(env);
  const existing = inFlight.get(cachePath);
  if (existing !== void 0) return existing;
  const now = (options?.now ?? Date.now)();
  const ttlMs = options?.ttlMs ?? PRICING_TTL_MS;
  const doFetch = options?.fetchImpl ?? ((url, init) => fetch(url, {
    ...init.signal === void 0 ? {} : { signal: init.signal },
    ...init.headers === void 0 ? {} : { headers: init.headers }
  }));
  const task = (async () => {
    try {
      const response = await doFetch(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(PRICING_TIMEOUT_MS),
        headers: { accept: "application/json" }
      });
      if (!response.ok) {
        return unavailableSnapshot(`models.dev returned HTTP ${response.status}`);
      }
      const providers = parseCatalogPayload(await response.json());
      if (providers === void 0) {
        return unavailableSnapshot("models.dev payload carried no usable prices");
      }
      const catalog = { version: PRICING_CACHE_VERSION, fetchedAt: now, providers };
      const cached = writePricingCache(cachePath, catalog);
      const snapshot = snapshotFromCatalog(catalog, now, ttlMs, false);
      return cached ? snapshot : { ...snapshot, unavailableReason: "price cache is not writable" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return unavailableSnapshot(`models.dev fetch failed: ${detail}`);
    } finally {
      inFlight.delete(cachePath);
    }
  })();
  inFlight.set(cachePath, task);
  return task;
}
function loadPricing(options) {
  const env = options?.env ?? process.env;
  const cachePath = options?.cachePath ?? resolvePricingCachePath(env);
  const now = (options?.now ?? Date.now)();
  const ttlMs = options?.ttlMs ?? PRICING_TTL_MS;
  const catalog = readPricingCache(cachePath);
  const offline = isPricingOffline(options);
  if (catalog === void 0) {
    if (offline) {
      return {
        snapshot: {
          ...unavailableSnapshot(
            "no price cache, and pricing is offline (PANTHEON_COST_OFFLINE=1 or the offline option)"
          ),
          offline: true
        }
      };
    }
    const pending2 = refreshPricingCatalog(options);
    return {
      snapshot: unavailableSnapshot(
        "no cached models.dev catalog yet; fetching one in the background"
      ),
      pending: pending2.then(() => void 0)
    };
  }
  const snapshot = snapshotFromCatalog(catalog, now, ttlMs, false);
  if (!snapshot.stale || offline) {
    return { snapshot: offline ? { ...snapshot, offline: true } : snapshot };
  }
  const pending = refreshPricingCatalog(options);
  return {
    snapshot: { ...snapshot, refreshing: true },
    pending: pending.then(() => void 0)
  };
}
async function forceRefreshPricing(options) {
  const refreshed = await refreshPricingCatalog(options);
  if (refreshed.unavailableReason === void 0) return refreshed;
  const env = options?.env ?? process.env;
  const cachePath = options?.cachePath ?? resolvePricingCachePath(env);
  const catalog = readPricingCache(cachePath);
  if (catalog === void 0) return refreshed;
  const now = (options?.now ?? Date.now)();
  const cached = snapshotFromCatalog(catalog, now, options?.ttlMs ?? PRICING_TTL_MS, false);
  return {
    ...cached,
    unavailableReason: refreshed.unavailableReason,
    ...refreshed.refused === true ? { refused: true } : {},
    ...refreshed.offline === true ? { offline: true } : {}
  };
}
function lookupModelPrice(snapshot, providerId, modelId) {
  if (snapshot.index.size === 0) return { ok: false, reason: "no-pricing" };
  const model = (modelId ?? "").trim().toLowerCase();
  if (model === "") return { ok: false, reason: "unknown-model" };
  const provider = (providerId ?? "").trim().toLowerCase();
  if (provider !== "") {
    const exact = snapshot.index.get(`${provider}/${model}`);
    if (exact !== void 0) return { ok: true, price: exact };
  }
  const candidates = snapshot.modelIndex.get(model) ?? [];
  const only = candidates.length === 1 ? candidates[0] : void 0;
  if (only !== void 0) return { ok: true, price: only };
  if (candidates.length === 0) return { ok: false, reason: "unknown-model" };
  return { ok: false, reason: "ambiguous-model" };
}
function computeModelCost(price, tokens) {
  let usd = (tokens.input * price.inputPerMTok + tokens.output * price.outputPerMTok) / 1e6;
  if (tokens.cacheRead > 0) {
    const rate = price.cacheReadPerMTok;
    if (rate === void 0) return { ok: false, reason: "missing-cache-price" };
    usd += tokens.cacheRead * rate / 1e6;
  }
  if (tokens.cacheWrite > 0) {
    const rate = price.cacheWritePerMTok;
    if (rate === void 0) return { ok: false, reason: "missing-cache-price" };
    usd += tokens.cacheWrite * rate / 1e6;
  }
  return { ok: true, usd };
}

// src/plugins/tui/src/cost-data.ts
var COST_SOURCES = ["message", "session_message"];
var VERSION_SOURCES = {
  v1: "message",
  v2: "session_message"
};
function defaultDbPath() {
  const xdg = process.env.XDG_DATA_HOME;
  const dataHome = xdg !== void 0 && xdg !== "" ? xdg : join13(homedir6(), ".local", "share");
  return join13(dataHome, "opencode", "opencode.db");
}
function requestedVersion() {
  const configured = process.env.PANTHEON_OPENCODE_VERSION;
  if (configured === void 0) return void 0;
  if (configured !== "v1" && configured !== "v2") {
    throw new Error(`invalid PANTHEON_OPENCODE_VERSION "${configured}"; expected "v1" or "v2"`);
  }
  return configured;
}
function resolveCostDbPath(options) {
  const explicit = options?.dbPath || process.env.PANTHEON_COST_DB || process.env.OPENCODE_DB;
  if (explicit) return explicit;
  requestedVersion();
  return defaultDbPath();
}
function resolveSources(db, requested) {
  const present = new Set(
    db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message')"
    ).all().map((row) => String(row.name))
  );
  const detected = COST_SOURCES.filter((source) => present.has(source));
  if (detected.length === 0) {
    throw new Error(
      'incompatible opencode.db schema: neither the "message" nor the "session_message" table exists, so there is no token ledger to read'
    );
  }
  if (requested === void 0) return detected;
  const wanted = VERSION_SOURCES[requested];
  const narrowed = detected.filter((source) => source === wanted);
  if (narrowed.length === 0) {
    throw new Error(
      `incompatible opencode.db schema: PANTHEON_OPENCODE_VERSION=${requested} selected no table family, but this database contains ${detected.join(" and ")}`
    );
  }
  return narrowed;
}
function numberOf(value) {
  if (value === null || value === void 0) return void 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function ledgerLabel(value) {
  if (value === void 0 || value === null) return "unknown";
  const text2 = String(value).trim();
  return text2 === "" ? "unknown" : text2;
}
function priceTokens(pricing, provider, model, tokens) {
  if (pricing === void 0) return { reason: "no-pricing" };
  const lookup = lookupModelPrice(pricing, provider, model);
  if (!lookup.ok) return { reason: lookup.reason };
  const cost = computeModelCost(lookup.price, tokens);
  if (!cost.ok) return { reason: cost.reason };
  return { usd: cost.usd };
}

// src/pantheon/cost-command.ts
var __filename = fileURLToPath4(import.meta.url);
var __dirname = dirname8(__filename);
var costArgs = {
  days: z.number().int().min(1).max(365).optional().describe("Number of rolling 24-hour days of history to include (default 7)."),
  session: z.string().min(1).optional().describe(
    "Session id to scope the report to: the root session plus every descendant session in its subtree."
  ),
  refreshPricing: z.boolean().optional().describe(
    "Await a models.dev price refresh (bounded by a short timeout) instead of using the cached catalog. This is the only path that waits on the network."
  )
};
function findExistingDb(override) {
  const candidate = override === void 0 ? resolveCostDbPath() : resolveCostDbPath({ dbPath: override });
  return existsSync6(candidate) ? candidate : void 0;
}
var COST_AGGREGATE_SQL = {
  message: (sessionId) => `
    WITH valid AS (
      SELECT json_extract(data, '$.role') AS role,
             json_extract(data, '$.agent') AS agent,
             COALESCE(NULLIF(json_extract(data, '$.phase'), ''),
                      NULLIF(json_extract(data, '$.metadata.phase'), ''),
                      'unknown') AS phase,
             COALESCE(json_extract(data, '$.model.providerID'),
                      json_extract(data, '$.providerID')) AS provider,
             COALESCE(json_extract(data, '$.model.id'),
                      json_extract(data, '$.modelID')) AS model,
             ${sessionId ? "session_id" : "NULL"} AS sessionId,
             CAST(json_extract(data, '$.tokens.input') AS INTEGER) AS inTok,
             CAST(json_extract(data, '$.tokens.output') AS INTEGER) AS outTok,
             CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER) AS cacheReadTok,
             CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER) AS cacheWriteTok
      FROM message
      WHERE time_created >= ? AND json_valid(data)
    )
    SELECT agent AS agent,
           phase AS phase,
           provider AS provider,
           model AS model,
           sessionId AS sessionId,
           COALESCE(SUM(inTok), 0) AS tokensInput,
           COALESCE(SUM(outTok), 0) AS tokensOutput,
           COALESCE(SUM(cacheReadTok), 0) AS tokensCacheRead,
           COALESCE(SUM(cacheWriteTok), 0) AS tokensCacheWrite
    FROM valid
    WHERE role = 'assistant'
    GROUP BY agent, phase, provider, model, sessionId
    HAVING agent IS NOT NULL AND agent != ''`,
  session_message: (sessionId) => `
    WITH valid AS (
      SELECT json_extract(data, '$.agent') AS agent,
             COALESCE(NULLIF(json_extract(data, '$.phase'), ''),
                      NULLIF(json_extract(data, '$.metadata.phase'), ''),
                      NULLIF(json_extract(data, '$.subtask.phase'), ''),
                      'unknown') AS phase,
             COALESCE(json_extract(data, '$.model.providerID'),
                      json_extract(data, '$.providerID')) AS provider,
             COALESCE(json_extract(data, '$.model.id'),
                      json_extract(data, '$.modelID')) AS model,
             ${sessionId ? "session_id" : "NULL"} AS sessionId,
             CAST(json_extract(data, '$.tokens.input') AS INTEGER) AS inTok,
             CAST(json_extract(data, '$.tokens.output') AS INTEGER) AS outTok,
             CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER) AS cacheReadTok,
             CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER) AS cacheWriteTok
      FROM session_message
      WHERE time_created >= ? AND type = 'assistant' AND json_valid(data)
    )
    SELECT agent AS agent,
           phase AS phase,
           provider AS provider,
           model AS model,
           sessionId AS sessionId,
           COALESCE(SUM(inTok), 0) AS tokensInput,
           COALESCE(SUM(outTok), 0) AS tokensOutput,
           COALESCE(SUM(cacheReadTok), 0) AS tokensCacheRead,
           COALESCE(SUM(cacheWriteTok), 0) AS tokensCacheWrite
    FROM valid
    GROUP BY agent, phase, provider, model, sessionId
    HAVING agent IS NOT NULL AND agent != ''`
};
var SESSION_TABLES = ["session_v2", "session"];
function tableColumns(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map((row) => String(row.name)));
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function readSessionIndex(db) {
  const nodes = /* @__PURE__ */ new Map();
  const children = /* @__PURE__ */ new Map();
  const tables = [];
  for (const table of SESSION_TABLES) {
    const columns = tableColumns(db, table);
    if (columns.size === 0 || !columns.has("id")) continue;
    tables.push(table);
    const parent = columns.has("parent_id") ? "parent_id" : "NULL";
    const title = columns.has("title") ? "title" : "NULL";
    const rows = db.prepare(`SELECT id, ${parent} AS parentId, ${title} AS title FROM ${table}`).all();
    for (const row of rows) {
      const id = String(row.id ?? "");
      if (id === "") continue;
      const parentId = row.parentId === null || row.parentId === void 0 ? void 0 : String(row.parentId);
      const title2 = row.title === null || row.title === void 0 ? void 0 : String(row.title);
      nodes.set(id, {
        id,
        ...parentId === void 0 ? {} : { parentId },
        ...title2 === void 0 ? {} : { title: title2 }
      });
      if (parentId !== void 0) {
        const bucket = children.get(parentId) ?? [];
        bucket.push(id);
        children.set(parentId, bucket);
      }
    }
  }
  return { nodes, children, tables };
}
function resolveSessionTree(index, rootId) {
  const ids = /* @__PURE__ */ new Set([rootId]);
  const queue = [rootId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === void 0) continue;
    for (const child of index.children.get(current) ?? []) {
      if (ids.has(child)) continue;
      ids.add(child);
      queue.push(child);
    }
  }
  return { ids: [...ids], rootKnown: index.nodes.has(rootId) };
}
var COUNTER_SQL = {
  message: `
    SELECT
      (SELECT COUNT(*) FROM message WHERE time_created >= ?) AS scanned,
      (SELECT MIN(time_created) FROM message WHERE time_created >= ?) AS windowStart,
      (SELECT COUNT(*) FROM (
         SELECT json_extract(data, '$.role') AS role
         FROM message WHERE time_created >= ? AND json_valid(data)
       ) WHERE role = 'assistant') AS assistantRows`,
  session_message: `
    SELECT
      (SELECT COUNT(*) FROM session_message WHERE time_created >= ?) AS scanned,
      (SELECT MIN(time_created) FROM session_message WHERE time_created >= ?) AS windowStart,
      (SELECT COUNT(*) FROM session_message WHERE time_created >= ? AND type = 'assistant') AS assistantRows`
};
var DATABASE_START_SQL = {
  message: "SELECT MIN(time_created) AS databaseStart FROM message",
  session_message: "SELECT MIN(time_created) AS databaseStart FROM session_message"
};
function emptyCoverage(sources) {
  return { sources, scanned: 0, assistantRows: 0 };
}
function queryWithSqlite(dbPath, days, sqlite, options) {
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const sources = resolveSources(db, requestedVersion());
    const since = Date.now() - days * 864e5;
    const coverage = emptyCoverage([]);
    const models = /* @__PURE__ */ new Map();
    const sessions = /* @__PURE__ */ new Map();
    const note = (key, value) => {
      if (value === void 0) return;
      const current = coverage[key];
      coverage[key] = current === void 0 ? value : Math.min(current, value);
    };
    const sessionIndex = readSessionIndex(db);
    const sessionRoot = options?.sessionRoot;
    let sessionScope;
    let scopedIds;
    if (sessionRoot !== void 0) {
      const tree = resolveSessionTree(sessionIndex, sessionRoot);
      scopedIds = new Set(tree.ids);
      sessionScope = {
        rootId: sessionRoot,
        ids: tree.ids,
        rootKnown: tree.rootKnown,
        hierarchy: sessionIndex.tables.length > 0
      };
    }
    for (const source of sources) {
      const countersRow = db.prepare(COUNTER_SQL[source]).all(since, since, since)[0];
      coverage.sources.push(source);
      coverage.scanned += numberOf(countersRow?.scanned) ?? 0;
      coverage.assistantRows += numberOf(countersRow?.assistantRows) ?? 0;
      note("windowStart", numberOf(countersRow?.windowStart));
      note(
        "databaseStart",
        numberOf(
          db.prepare(DATABASE_START_SQL[source]).get()?.databaseStart
        )
      );
      const hasSessionColumn = tableColumns(db, source).has("session_id");
      const groups = db.prepare(COST_AGGREGATE_SQL[source](hasSessionColumn)).all(since);
      for (const group of groups) {
        const agent = String(group.agent ?? "");
        if (agent === "") continue;
        const phase = ledgerLabel(group.phase);
        const provider = ledgerLabel(group.provider);
        const model = ledgerLabel(group.model);
        const sessionId = group.sessionId === void 0 || group.sessionId === null ? void 0 : String(group.sessionId);
        if (scopedIds !== void 0 && (sessionId === void 0 || !scopedIds.has(sessionId))) {
          continue;
        }
        const tokens = {
          input: numberOf(group.tokensInput) ?? 0,
          output: numberOf(group.tokensOutput) ?? 0,
          cacheRead: numberOf(group.tokensCacheRead) ?? 0,
          cacheWrite: numberOf(group.tokensCacheWrite) ?? 0
        };
        const priced = priceTokens(options?.pricing, provider, model, tokens);
        const modelKey2 = `${agent}\0${phase}\0${provider}\0${model}`;
        const modelAcc = models.get(modelKey2) ?? {
          agent,
          phase,
          provider,
          model,
          tokensInput: 0,
          tokensOutput: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          usd: 0,
          unpriced: false,
          reason: void 0
        };
        modelAcc.tokensInput += tokens.input;
        modelAcc.tokensOutput += tokens.output;
        modelAcc.tokensCacheRead += tokens.cacheRead;
        modelAcc.tokensCacheWrite += tokens.cacheWrite;
        if ("usd" in priced && modelAcc.usd !== void 0) {
          modelAcc.usd += priced.usd;
        } else {
          modelAcc.unpriced = true;
          modelAcc.usd = void 0;
          modelAcc.reason = modelAcc.reason ?? ("reason" in priced ? priced.reason : void 0);
        }
        models.set(modelKey2, modelAcc);
        if (sessionId === void 0) continue;
        const sessionAcc = sessions.get(sessionId) ?? {
          sessionId,
          agents: /* @__PURE__ */ new Set(),
          tokensInput: 0,
          tokensOutput: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          usd: 0,
          priced: 0,
          unpricedModels: 0,
          reason: void 0
        };
        sessionAcc.agents.add(agent);
        sessionAcc.tokensInput += tokens.input;
        sessionAcc.tokensOutput += tokens.output;
        sessionAcc.tokensCacheRead += tokens.cacheRead;
        sessionAcc.tokensCacheWrite += tokens.cacheWrite;
        if ("usd" in priced) {
          sessionAcc.usd += priced.usd;
          sessionAcc.priced += 1;
        } else {
          sessionAcc.unpricedModels += 1;
          sessionAcc.reason = sessionAcc.reason ?? priced.reason;
        }
        sessions.set(sessionId, sessionAcc);
      }
    }
    const byAgentPhase = /* @__PURE__ */ new Map();
    for (const acc of models.values()) {
      const key = `${acc.agent}\0${acc.phase}`;
      const entry = byAgentPhase.get(key) ?? {
        row: {
          agent: acc.agent,
          phase: acc.phase,
          tokensInput: 0,
          tokensOutput: 0,
          tokensTotal: 0
        },
        usd: 0,
        priced: 0,
        unpricedModels: 0
      };
      entry.row.tokensInput += acc.tokensInput;
      entry.row.tokensOutput += acc.tokensOutput;
      entry.row.tokensTotal += acc.tokensInput + acc.tokensOutput;
      if (acc.usd === void 0) {
        entry.unpricedModels += 1;
      } else {
        entry.usd += acc.usd;
        entry.priced += 1;
      }
      byAgentPhase.set(key, entry);
    }
    const rows = [...byAgentPhase.values()].map(({ row, usd, priced, unpricedModels }) => ({
      ...row,
      // Absent cost means "nothing in this row could be priced"; a numeric
      // cost with `unpricedModels` means "this row is partly priced".
      ...priced === 0 ? {} : { costUsd: usd },
      ...priced === 0 || unpricedModels === 0 ? {} : { unpricedModels }
    })).sort((a, b) => b.tokensTotal - a.tokensTotal);
    const byModel = [...models.values()].map((acc) => ({
      agent: acc.agent,
      phase: acc.phase,
      provider: acc.provider,
      model: acc.model,
      tokensInput: acc.tokensInput,
      tokensOutput: acc.tokensOutput,
      tokensCacheRead: acc.tokensCacheRead,
      tokensCacheWrite: acc.tokensCacheWrite,
      // "Total" means input+output everywhere in the report; cache tokens are
      // reported in their own columns rather than folded into this one, so two
      // tables cannot disagree about what a total counts.
      tokensTotal: acc.tokensInput + acc.tokensOutput,
      ...acc.usd === void 0 ? {} : { costUsd: acc.usd },
      ...acc.reason === void 0 ? {} : { unpricedReason: acc.reason }
    })).sort((a, b) => b.tokensTotal - a.tokensTotal);
    const bySession = [...sessions.values()].map((acc) => {
      const info = sessionIndex.nodes.get(acc.sessionId);
      return {
        sessionId: acc.sessionId,
        ...info?.title === void 0 ? {} : { title: info.title },
        agents: [...acc.agents].sort(),
        tokensInput: acc.tokensInput,
        tokensOutput: acc.tokensOutput,
        tokensCacheRead: acc.tokensCacheRead,
        tokensCacheWrite: acc.tokensCacheWrite,
        tokensTotal: acc.tokensInput + acc.tokensOutput,
        ...acc.priced === 0 ? {} : { costUsd: acc.usd },
        ...acc.priced === 0 || acc.unpricedModels === 0 ? {} : { unpricedModels: acc.unpricedModels },
        ...acc.reason === void 0 ? {} : { unpricedReason: acc.reason }
      };
    }).sort((a, b) => b.tokensTotal - a.tokensTotal);
    return {
      rows,
      coverage,
      byModel,
      bySession,
      ...sessionScope === void 0 ? {} : { sessionScope }
    };
  } finally {
    db.close();
  }
}
function isoDay(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}
function formatCoverage(coverage, days) {
  const databaseStart = coverage.databaseStart;
  if (databaseStart === void 0) {
    return `Coverage: this database holds no message rows at all, so the ${days}-day window cannot be covered.`;
  }
  const start = isoDay(databaseStart);
  const heldDays = Math.floor((Date.now() - databaseStart) / 864e5) + 1;
  const head = `Coverage: this database holds ${heldDays} day${heldDays === 1 ? "" : "s"} of history, from ${start}`;
  if (coverage.windowStart === void 0) {
    return `${head}, and no rows fall inside the requested ${days}-day window.`;
  }
  if (heldDays < days) {
    return `${head}, so the requested ${days}-day window is only covered from ${isoDay(coverage.windowStart)}.`;
  }
  return `${head} (requested window: ${days} days).`;
}
function diagnoseUnreadableLedger(query, days) {
  const { scanned, assistantRows, sources } = query.coverage;
  if (scanned === 0) return void 0;
  const tables = sources.join(" and ");
  if (assistantRows === 0) {
    return `no readable token source: ${scanned} row(s) were scanned in the last ${days} day(s) but none matched the assistant discriminator of ${tables}, so no usage can be attributed. This is an unrecognised ledger layout, not an empty one; point PANTHEON_COST_DB at a database whose token layout this build understands.`;
  }
  if (query.sessionScope !== void 0) return void 0;
  if (!query.rows.some((row) => row.tokensInput !== 0 || row.tokensOutput !== 0) && // Cache-only usage is still usage: a turn whose whole payload was served
  // from cache has zero input/output but a real cache-read count, and
  // calling that "unreadable" would hide spend that this report can price.
  !(query.byModel ?? []).some((row) => row.tokensCacheRead !== 0 || row.tokensCacheWrite !== 0)) {
    return `no readable token source: ${assistantRows} assistant row(s) were found in ${tables} but none carried both an attributable agent and a token payload, so no usage can be attributed. This is an unrecognised ledger layout, not an empty one.`;
  }
  return void 0;
}
var MIN_DISPLAYABLE_USD = 1e-4;
function formatUsd(usd) {
  if (usd === void 0) return "\u2014";
  if (usd === 0) return "$0.00";
  if (usd < MIN_DISPLAYABLE_USD) return "< $0.0001";
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
function totalCostCell(pricedUsd, pricedRows, unpricedRows) {
  if (pricedRows === 0) return unpricedRows === 0 ? "**$0.00**" : "**\u2014** (nothing priceable)";
  const cell = `**${formatUsd(pricedUsd)}**`;
  return unpricedRows === 0 ? cell : `${cell} (partial)`;
}
function rowCostCell(usd, unpricedModels) {
  const cell = formatUsd(usd);
  return unpricedModels === void 0 || usd === void 0 ? cell : `${cell} (partial)`;
}
var MAX_SESSION_ROWS = 20;
function shortTitle(title) {
  if (title === void 0) return "\u2014";
  const flat = title.replaceAll("|", "/").replaceAll("\n", " ").trim();
  return flat.length > 48 ? `${flat.slice(0, 47)}\u2026` : flat === "" ? "\u2014" : flat;
}
function pricingNote(pricing) {
  if (pricing === void 0) {
    return [
      "Pricing: unavailable for this run \u2014 every cost reads \u2014 and no model is treated as free."
    ];
  }
  if (pricing.refused === true) {
    const detail = pricing.unavailableReason ?? "a price refresh was refused";
    const suffix = pricing.index.size === 0 ? "every cost reads \u2014 and no model is treated as free." : "costs below use the cached catalog; nothing was fetched.";
    return [`Pricing: REFUSED \u2014 ${detail}; ${suffix}`];
  }
  if (pricing.index.size === 0) {
    const detail = pricing.unavailableReason ?? "no cached catalog";
    return [
      `Pricing: unavailable (${detail}) \u2014 every cost reads \u2014 and unpriced models are EXCLUDED from totals, never priced at zero.`,
      // Never recommend a call the host has forbidden: an offline report that
      // says "run refreshPricing" is advice that cannot work.
      pricing.offline === true ? "Pricing: this host is offline (PANTHEON_COST_OFFLINE=1); no catalog can be fetched until that is cleared." : "Pricing: run pantheon_cost({ refreshPricing: true }) to fetch the models.dev catalog; that is the only path that waits on the network, bounded by a 3 s timeout."
    ];
  }
  const fetched = pricing.fetchedAt === void 0 ? "unknown date" : isoDay(pricing.fetchedAt);
  const head = `Pricing: models.dev catalog (USD per 1M tokens), cached ${fetched}`;
  if (pricing.unavailableReason !== void 0) {
    return [
      `${head} \u2014 the requested refresh failed (${pricing.unavailableReason}); costs below use cached prices.`
    ];
  }
  if (pricing.refreshing) {
    return [`${head} \u2014 stale, refreshing in the background; costs below use these cached prices.`];
  }
  if (pricing.stale) {
    const why = pricing.offline === true ? "offline, so no background refresh was scheduled" : "no background refresh was scheduled";
    return [`${head} \u2014 stale, and ${why}; costs below use cached prices.`];
  }
  return [`${head}.`];
}
function reconciliationNote(rows, byModel) {
  if (byModel === void 0) return void 0;
  const unpriced = byModel.filter((row) => row.costUsd === void 0);
  if (unpriced.length === 0) return void 0;
  const agentUsd = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const modelUsd = byModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const totalTokens = byModel.reduce((sum, row) => sum + row.tokensTotal, 0);
  const unpricedTokens = unpriced.reduce((sum, row) => sum + row.tokensTotal, 0);
  const pricedRows = byModel.length - unpriced.length;
  const totals = pricedRows === 0 ? "nothing in either table could be priced" : Math.abs(agentUsd - modelUsd) < 5e-3 ? `by-agent and by-model priced totals agree at ${formatUsd(agentUsd)}` : `by-agent ${formatUsd(agentUsd)} and by-model ${formatUsd(modelUsd)} differ by ${formatUsd(Math.abs(agentUsd - modelUsd))}`;
  return `Cost reconciliation: ${totals}; ${unpricedTokens} token(s) from ${unpriced.length} unpriced model row(s) are counted in the token columns and excluded from both dollar totals (${totalTokens - unpricedTokens} priced token(s) carry the money).`;
}
function modelTotals(byModel) {
  const groups = /* @__PURE__ */ new Map();
  for (const row of byModel) {
    const key = `${row.provider}\0${row.model}`;
    const acc = groups.get(key) ?? {
      provider: row.provider,
      model: row.model,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      tokensTotal: 0,
      usd: 0,
      priced: 0,
      unpricedModels: 0
    };
    acc.tokensInput += row.tokensInput;
    acc.tokensOutput += row.tokensOutput;
    acc.tokensCacheRead += row.tokensCacheRead;
    acc.tokensCacheWrite += row.tokensCacheWrite;
    acc.tokensTotal += row.tokensTotal;
    if (row.costUsd === void 0) {
      acc.unpricedModels += 1;
    } else {
      acc.usd += row.costUsd;
      acc.priced += 1;
    }
    groups.set(key, acc);
  }
  return [...groups.values()].map((acc) => ({
    provider: acc.provider,
    model: acc.model,
    tokensInput: acc.tokensInput,
    tokensOutput: acc.tokensOutput,
    tokensCacheRead: acc.tokensCacheRead,
    tokensCacheWrite: acc.tokensCacheWrite,
    tokensTotal: acc.tokensTotal,
    // Same rule as the by-agent table: a model bucket that spans several
    // agent/phase groups is the SUM of its priced groups, and `unpricedModels`
    // records how many groups had no usable price.
    costUsd: acc.priced === 0 ? void 0 : acc.usd,
    ...acc.priced === 0 || acc.unpricedModels === 0 ? {} : { unpricedModels: acc.unpricedModels }
  })).sort((a, b) => b.tokensTotal - a.tokensTotal);
}
function renderModelSection(byModel, days) {
  const header = `## Cost by model (last ${days} days)`;
  if (byModel === void 0) {
    return [header, "", "Unavailable: this run reports tokens only (CLI fallback path)."];
  }
  if (byModel.length === 0) return [header, "", "No model rows in this window."];
  const totals = modelTotals(byModel);
  const pricedUsd = totals.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const priced = totals.filter((row) => row.costUsd !== void 0).length;
  const unpriced = totals.filter(
    (row) => row.costUsd === void 0 || (row.unpricedModels ?? 0) > 0
  ).length;
  const totalCell = totalCostCell(pricedUsd, priced, unpriced);
  return [
    header,
    "",
    "| Provider | Model | Tokens In | Tokens Out | Cache Read | Cache Write | Cost (USD) |",
    "|----------|-------|----------:|-----------:|-----------:|------------:|-----------:|",
    ...totals.map(
      (row) => `| ${row.provider} | ${row.model} | ${row.tokensInput} | ${row.tokensOutput} | ${row.tokensCacheRead} | ${row.tokensCacheWrite} | ${rowCostCell(row.costUsd, row.unpricedModels)} |`
    ),
    `| **Total** | \u2014 | **${totals.reduce((sum, row) => sum + row.tokensInput, 0)}** | **${totals.reduce((sum, row) => sum + row.tokensOutput, 0)}** | **${totals.reduce((sum, row) => sum + row.tokensCacheRead, 0)}** | **${totals.reduce((sum, row) => sum + row.tokensCacheWrite, 0)}** | ${totalCell} |`
  ];
}
function renderSessionSection(query, days) {
  const scope = query.sessionScope;
  const header = scope === void 0 ? `## Cost by session (last ${days} days)` : `## Cost by session tree (last ${days} days) \u2014 root ${scope.rootId}`;
  if (query.bySession === void 0) {
    return [header, "", "Unavailable: this run reports tokens only (CLI fallback path)."];
  }
  const lines = [header, ""];
  if (scope !== void 0) {
    if (!scope.hierarchy) {
      lines.push(
        "Session hierarchy unavailable: this database has no session metadata table, so only rows whose session_id equals the root are counted.",
        ""
      );
    } else if (!scope.rootKnown) {
      lines.push(
        "Root session not found in this database: only rows whose session_id equals it are counted, and no descendants can be resolved.",
        ""
      );
    } else {
      lines.push(`Scope: the root session plus ${scope.ids.length - 1} descendant session(s).`, "");
    }
  }
  if (query.bySession.length === 0) {
    lines.push("No session rows in this window.");
    return lines;
  }
  const shown = query.bySession.slice(0, MAX_SESSION_ROWS);
  const hidden = query.bySession.length - shown.length;
  const pricedUsd = query.bySession.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const priced = query.bySession.filter((row) => row.costUsd !== void 0).length;
  const unpriced = query.bySession.filter(
    (row) => row.costUsd === void 0 || (row.unpricedModels ?? 0) > 0
  ).length;
  const totalCell = totalCostCell(pricedUsd, priced, unpriced);
  lines.push(
    "| Session | Title | Agent | Tokens In | Tokens Out | Cache Read | Cache Write | Tokens Total | Cost (USD) |",
    "|---------|-------|-------|----------:|-----------:|-----------:|------------:|-------------:|-----------:|",
    ...shown.map(
      (row) => `| ${row.sessionId} | ${shortTitle(row.title)} | ${row.agents.join(", ") || "\u2014"} | ${row.tokensInput} | ${row.tokensOutput} | ${row.tokensCacheRead} | ${row.tokensCacheWrite} | ${row.tokensTotal} | ${rowCostCell(row.costUsd, row.unpricedModels)} |`
    ),
    `| **${scope === void 0 ? "Total" : "Root + descendants"}** | \u2014 | \u2014 | **${query.bySession.reduce((sum, row) => sum + row.tokensInput, 0)}** | **${query.bySession.reduce((sum, row) => sum + row.tokensOutput, 0)}** | **${query.bySession.reduce((sum, row) => sum + row.tokensCacheRead, 0)}** | **${query.bySession.reduce((sum, row) => sum + row.tokensCacheWrite, 0)}** | **${query.bySession.reduce((sum, row) => sum + row.tokensTotal, 0)}** | ${totalCell} |`
  );
  if (hidden > 0) {
    lines.push("", `_+${hidden} more session(s) not listed; the totals include them._`);
  }
  return lines;
}
function renderMarkdown(query, days, pricing) {
  const { rows, coverage } = query;
  const header = `## Token and cost usage by agent and phase (last ${days} days)`;
  const reconciliation = reconciliationNote(rows, query.byModel);
  const footer = [
    formatCoverage(coverage, days),
    "Window: rolling 24-hour days from query time (not calendar days or session boundaries).",
    "Aggregation: per agent and phase (phase may be unknown on V2), per model, and per session.",
    "Attribution: a session row covers that session alone; passing session:<id> sums the root session and its descendant sessions.",
    "Limits: costs are catalog list prices (USD per 1M tokens), not a provider invoice; a row that mixes priced and unpriced models shows its priced part and is reported as partial, and an unknown model is never priced at zero.",
    ...reconciliation === void 0 ? [] : [reconciliation],
    ...pricingNote(pricing),
    `Source: opencode.db (read-only) \u2014 table families: ${coverage.sources.join(" + ")} \u2014 ${coverage.assistantRows} assistant row(s) scanned`
  ].join("\n");
  if (rows.length === 0) {
    const scope = query.sessionScope;
    const empty = scope === void 0 ? `No token records in the last ${days} days.` : `No token records in the last ${days} days for ${scope.rootId} or its descendant sessions.`;
    return [
      header,
      "",
      empty,
      "",
      ...renderModelSection(query.byModel, days),
      "",
      ...renderSessionSection(query, days),
      "",
      footer
    ].join("\n");
  }
  const total = rows.reduce(
    (acc, r) => {
      acc.tokensInput += r.tokensInput;
      acc.tokensOutput += r.tokensOutput;
      acc.tokensTotal += r.tokensTotal;
      if (r.costUsd === void 0) acc.unpriced += 1;
      else {
        acc.usd += r.costUsd;
        acc.priced += 1;
        if ((r.unpricedModels ?? 0) > 0) acc.partial += 1;
      }
      return acc;
    },
    { tokensInput: 0, tokensOutput: 0, tokensTotal: 0, usd: 0, unpriced: 0, priced: 0, partial: 0 }
  );
  const totalCost = totalCostCell(total.usd, total.priced, total.unpriced + total.partial);
  const lines = [
    header,
    "",
    "| Agent | Phase | Tokens In | Tokens Out | Tokens Total | Cost (USD) |",
    "|-------|-------|----------:|-----------:|-------------:|-----------:|",
    ...rows.map(
      (r) => `| ${r.agent} | ${r.phase} | ${r.tokensInput} | ${r.tokensOutput} | ${r.tokensTotal} | ${rowCostCell(r.costUsd, r.unpricedModels)} |`
    ),
    `| **Total** | \u2014 | **${total.tokensInput}** | **${total.tokensOutput}** | **${total.tokensTotal}** | ${totalCost} |`,
    "",
    ...renderModelSection(query.byModel, days),
    "",
    ...renderSessionSection(query, days),
    "",
    footer
  ];
  return lines.join("\n");
}
var NODE_SQLITE_MIN_VERSION = "22.5";
function defaultIsExecutable(path5) {
  try {
    accessSync(path5, constants3.X_OK);
    return statSync3(path5).isFile();
  } catch {
    return false;
  }
}
function defaultExecFile(file, args) {
  return new Promise((resolve8, reject) => {
    execFile(file, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const failure = error;
        if (typeof failure.stdout !== "string") failure.stdout = stdout;
        if (typeof failure.stderr !== "string") failure.stderr = stderr;
        reject(failure);
        return;
      }
      resolve8({ stdout, stderr });
    });
  });
}
function resolveNodeFromPath(env, isExecutable = defaultIsExecutable) {
  const pathValue = env.PATH ?? env.Path ?? "";
  if (pathValue === "") return void 0;
  const isWindows = process.platform === "win32";
  const extensions = isWindows ? (env.PATHEXT ?? ".EXE;.BAT;.CMD;.COM").split(";").filter((ext) => ext !== "") : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    for (const ext of extensions) {
      const candidate = join14(dir, `node${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return void 0;
}
function resolveNodeExecutable(env = process.env, isExecutable = defaultIsExecutable) {
  const explicit = env.PANTHEON_NODE;
  if (explicit !== void 0 && explicit.trim() !== "") {
    if (isExecutable(explicit)) return { path: explicit, source: "env" };
    throw new Error(
      `PANTHEON_NODE is set to "${explicit}" but that is not an existing executable file`
    );
  }
  const fromPath = resolveNodeFromPath(env, isExecutable);
  return fromPath === void 0 ? void 0 : { path: fromPath, source: "path" };
}
function execErrorMessage(err) {
  if (err instanceof Error) {
    const failure = err;
    const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
    if (stderr !== "") return stderr;
    return failure.message;
  }
  return String(err);
}
function tryParseJson(text2) {
  try {
    return JSON.parse(text2);
  } catch {
    return void 0;
  }
}
function truncateForError(text2) {
  const trimmed = text2.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}\u2026` : trimmed;
}
async function assertNodeSqliteSupport(nodePath, execFileAsync) {
  try {
    await execFileAsync(nodePath, ["-e", "require('node:sqlite')"]);
  } catch (err) {
    throw new Error(
      `resolved Node binary "${nodePath}" does not support node:sqlite (Node.js >= ${NODE_SQLITE_MIN_VERSION} required): ${execErrorMessage(err)}`
    );
  }
}
function extractScriptFailure(err) {
  const failure = err;
  const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
  const parsed = tryParseJson(stdout);
  if (parsed !== null && typeof parsed === "object") {
    const record2 = parsed;
    if (record2.ok === false && typeof record2.error === "string" && record2.error !== "") {
      return record2.error;
    }
  }
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  if (stderr !== "") return stderr;
  return execErrorMessage(err);
}
async function queryWithCliFallback(dbPath, days, deps) {
  const env = deps?.env ?? process.env;
  const execFileAsync = deps?.execFile ?? defaultExecFile;
  const isExecutable = deps?.isExecutable ?? defaultIsExecutable;
  const costScript = join14(__dirname, "..", "..", "scripts", "cost.mjs");
  if (!existsSync6(costScript)) {
    throw new Error(`CLI fallback script not found: ${costScript}`);
  }
  const node = resolveNodeExecutable(env, isExecutable);
  if (node === void 0) {
    throw new Error(
      `no Node.js executable found for the node:sqlite CLI fallback: set PANTHEON_NODE to a Node.js >= ${NODE_SQLITE_MIN_VERSION} binary or put "node" on PATH`
    );
  }
  await assertNodeSqliteSupport(node.path, execFileAsync);
  let stdout;
  try {
    ;
    ({ stdout } = await execFileAsync(node.path, [
      costScript,
      "--db-path",
      dbPath,
      "--days",
      String(days)
    ]));
  } catch (err) {
    throw new Error(`CLI fallback failed: ${extractScriptFailure(err)}`);
  }
  const parsed = tryParseJson(stdout);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`CLI fallback returned non-JSON output: ${truncateForError(stdout)}`);
  }
  const record2 = parsed;
  if (record2.ok !== true) {
    const detail = typeof record2.error === "string" && record2.error !== "" ? record2.error : "unexpected response shape from scripts/cost.mjs";
    throw new Error(`CLI fallback failed: ${detail}`);
  }
  if (!Array.isArray(record2.rows)) {
    throw new Error("CLI fallback failed: scripts/cost.mjs response is missing the rows array");
  }
  const coverage = record2.coverage;
  if (coverage === null || typeof coverage !== "object") {
    throw new Error(
      "CLI fallback failed: scripts/cost.mjs response is missing the coverage object; the mirror must report what it scanned"
    );
  }
  const mirror = coverage;
  return {
    rows: record2.rows,
    coverage: {
      sources: Array.isArray(mirror.sources) ? mirror.sources : [],
      scanned: numberOf(mirror.scanned) ?? 0,
      assistantRows: numberOf(mirror.assistantRows) ?? 0,
      ...numberOf(mirror.databaseStart) === void 0 ? {} : { databaseStart: numberOf(mirror.databaseStart) },
      ...numberOf(mirror.windowStart) === void 0 ? {} : { windowStart: numberOf(mirror.windowStart) }
    }
  };
}
function createCostCommand(options) {
  const loadSqlite = options?.sqliteLoader ?? (async () => await import("node:sqlite"));
  const failure = (status, detail) => `status: ${status}
pantheon_cost failed: ${detail}`;
  const diagnostic = (err) => {
    if (err instanceof Error) {
      const stderr = err.stderr;
      const suffix = typeof stderr === "string" && stderr.trim() !== "" ? `; stderr: ${stderr.trim()}` : "";
      return `${err.message}${suffix}`;
    }
    return String(err);
  };
  const statusForError = (err) => {
    const detail = diagnostic(err).toLowerCase();
    if (detail.includes("not found") || detail.includes("unknown builtin") || detail.includes("no such built-in") || detail.includes("cannot find module") || // The mirror's own "found a ledger but could not read tokens" verdict.
    // Must stay in step with scripts/cost.mjs, which emits this exact phrase.
    detail.includes("no readable token source")) {
      return "UNSUPPORTED";
    }
    if (detail.includes("not a database") || detail.includes("malformed") || detail.includes("corrupt") || detail.includes("incompatible opencode.db schema")) {
      return "CORRUPT_DATA";
    }
    return "UNAVAILABLE";
  };
  const render = (query, days, pricing) => {
    const unreadable = diagnoseUnreadableLedger(query, days);
    if (unreadable !== void 0) return failure("UNSUPPORTED", unreadable);
    return `status: OK
${renderMarkdown(query, days, pricing)}`;
  };
  const execute = async (args, _ctx) => {
    const days = args?.days ?? 7;
    try {
      const dbPath = findExistingDb(options?.dbPath);
      if (dbPath === void 0) {
        const expected = resolveCostDbPath(options);
        return failure(
          "UNAVAILABLE",
          `opencode.db not found (expected at ${expected}). No token history is available until opencode has stored session data.`
        );
      }
      const pricing = args?.refreshPricing === true ? await forceRefreshPricing(options?.pricing) : loadPricing(options?.pricing).snapshot;
      const queryOptions = {
        pricing,
        ...args?.session === void 0 ? {} : { sessionRoot: args.session }
      };
      let sqlite;
      try {
        sqlite = await loadSqlite();
      } catch (loadErr) {
        const status = statusForError(loadErr);
        if (status === "UNSUPPORTED") {
          if (args?.session !== void 0) {
            return failure(
              "UNSUPPORTED",
              `session scoping requires the node:sqlite backend, which this runtime does not provide (${diagnostic(loadErr)}). The CLI fallback reports tokens only and cannot resolve a session tree; re-run on Node.js >= ${NODE_SQLITE_MIN_VERSION} or drop "session".`
            );
          }
          try {
            return render(
              await queryWithCliFallback(dbPath, days, options?.cliFallback),
              days,
              pricing
            );
          } catch (cliErr) {
            return failure(statusForError(cliErr), diagnostic(cliErr));
          }
        }
        throw loadErr;
      }
      return render(queryWithSqlite(dbPath, days, sqlite, queryOptions), days, pricing);
    } catch (err) {
      return failure(statusForError(err), diagnostic(err));
    }
  };
  return {
    pantheon_cost: {
      description: "Report input, output, cache and total token usage together with USD cost, by agent and phase, by model, and by session, in a rolling N \xD7 24-hour window from query time (read-only). Costs come from the models.dev catalog, cached on disk; a tool call reads the cache and never waits on the network unless refreshPricing is set. An unknown or unpriced model reads \u2014 and is excluded from the totals, never priced at zero, and the total says it is partial. Pass session:<id> to aggregate that root session plus its descendant sessions. Phase may be unknown on V2. Costs are catalog list prices, not an invoice. The report states the coverage window it actually covers and whether its prices are stale.",
      args: costArgs,
      execute
    }
  };
}

// src/pantheon/deepwork/deepwork-tool.ts
import { z as z3 } from "zod";

// src/pantheon/deepwork/plan-projection.ts
import { join as join15 } from "node:path";
function generateChatProjection(plan, cwd = process.cwd()) {
  const pendingDecisions = plan.decisions_needed.filter((d) => d.status === "pending");
  const totalTasks = plan.tasks.length;
  const doneTasks = plan.tasks.filter((t) => t.state === "done").length;
  const inProgressTasks = plan.tasks.filter((t) => t.state === "in_progress");
  const blockedTasks = plan.tasks.filter((t) => t.state === "blocked");
  const readyTasks = plan.tasks.filter((t) => t.state === "ready");
  const nextTask = inProgressTasks[0] || readyTasks[0] || plan.tasks.find((t) => t.state === "pending");
  const percent = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0;
  const absPlanMd = join15(cwd, ".pantheon", "deepwork", plan.plan_id, "PLAN.md");
  const absPlanJson = join15(cwd, ".pantheon", "deepwork", plan.plan_id, "plan.json");
  const lines = [];
  lines.push(`### Deepwork: ${plan.title} (\`${plan.plan_id}\`)`);
  lines.push(
    `\u{1F517} **Deeplink:** [Abrir PLAN.md](file://${absPlanMd}) \xB7 [plan.json](file://${absPlanJson})`
  );
  if (pendingDecisions.length > 0) {
    lines.push(`\u{1F534} **Decis\xF5es necess\xE1rias (${pendingDecisions.length})**:`);
    for (const dec of pendingDecisions.slice(0, 3)) {
      lines.push(`- **[${dec.id}]** ${dec.question}`);
    }
  }
  if (nextTask) {
    lines.push(
      `\u{1F3AF} **Pr\xF3xima tarefa**: **[${nextTask.id}]** ${nextTask.title} (@${nextTask.agent} \xB7 Fase ${nextTask.phase})`
    );
  } else if (doneTasks === totalTasks && totalTasks > 0) {
    lines.push("\u{1F389} **Todas as tarefas foram conclu\xEDdas!**");
  }
  if (blockedTasks.length > 0) {
    lines.push(`\u{1F7E1} **Bloqueadas**: ${blockedTasks.length} tarefa(s) aguardando depend\xEAncias`);
  }
  lines.push(
    `\u{1F7E2} **Progresso**: ${doneTasks}/${totalTasks} conclu\xEDda(s) (${percent}%)` + (inProgressTasks.length > 0 ? ` \xB7 ${inProgressTasks.length} em andamento` : "")
  );
  return lines.join("\n");
}
function generateMermaidDag(plan) {
  if (plan.tasks.length === 0) {
    return '```mermaid\nflowchart LR\n  empty["(Sem tarefas no plano)"]\n```';
  }
  const lines = ["```mermaid", "flowchart LR"];
  for (const task of plan.tasks) {
    const cleanTitle = task.title.replace(/["\\]/g, "'");
    lines.push(`  ${task.id}["[${task.id}] ${cleanTitle}"]`);
  }
  let hasEdges = false;
  for (const task of plan.tasks) {
    for (const depId of task.depends_on) {
      if (plan.tasks.some((t) => t.id === depId)) {
        lines.push(`  ${depId} --> ${task.id}`);
        hasEdges = true;
      }
    }
  }
  if (!hasEdges && plan.tasks.length > 1) {
    for (let i = 0; i < plan.tasks.length - 1; i++) {
      const current = plan.tasks[i];
      const next = plan.tasks[i + 1];
      if (current && next) {
        lines.push(`  ${current.id} -.-> ${next.id}`);
      }
    }
  }
  lines.push("  classDef done fill:#22c55e,stroke:#15803d,color:#ffffff;");
  lines.push("  classDef in_progress fill:#3b82f6,stroke:#1d4ed8,color:#ffffff;");
  lines.push("  classDef blocked fill:#eab308,stroke:#a16207,color:#000000;");
  lines.push("  classDef failed fill:#ef4444,stroke:#b91c1c,color:#ffffff;");
  lines.push("  classDef ready fill:#64748b,stroke:#334155,color:#ffffff;");
  const byState = {
    done: [],
    in_progress: [],
    blocked: [],
    failed: [],
    ready: []
  };
  for (const task of plan.tasks) {
    const stateList = byState[task.state];
    if (stateList) {
      stateList.push(task.id);
    }
  }
  for (const [state, ids] of Object.entries(byState)) {
    if (ids.length > 0) {
      lines.push(`  class ${ids.join(",")} ${state};`);
    }
  }
  lines.push("```");
  return lines.join("\n");
}
function generateMarkdownDocument(plan) {
  const lines = [];
  lines.push(`# Deepwork: ${plan.title}`);
  lines.push("");
  lines.push(`> **ID do Plano:** \`${plan.plan_id}\`  `);
  lines.push(
    `> **Criado em:** ${plan.metadata.created_at} \xB7 **Atualizado em:** ${plan.metadata.updated_at}`
  );
  lines.push("");
  lines.push("## 1. Inten\xE7\xE3o & Objetivos");
  lines.push(plan.intent.trim());
  lines.push("");
  if (plan.done_when.length > 0) {
    lines.push("## 2. Crit\xE9rios de Conclus\xE3o (Done When)");
    for (const item of plan.done_when) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push("");
  }
  if (plan.decisions_needed.length > 0) {
    lines.push("## 3. Decis\xF5es do Plano (Needs You)");
    lines.push("| ID | Pergunta | Status | Decis\xE3o Escolhida |");
    lines.push("|---|---|---|---|");
    for (const dec of plan.decisions_needed) {
      const statusIcon = dec.status === "resolved" ? "\u2705 Resolvida" : "\u{1F534} Pendente";
      const chosen = dec.chosen ?? "*(Aguardando decis\xE3o)*";
      lines.push(`| \`${dec.id}\` | ${dec.question} | ${statusIcon} | ${chosen} |`);
    }
    lines.push("");
  }
  lines.push("## 4. Grafo de Depend\xEAncias (DAG)");
  lines.push(generateMermaidDag(plan));
  lines.push("");
  lines.push("## 5. Tarefas & Crit\xE9rios de Aceite");
  for (const task of plan.tasks) {
    const stateIcon = task.state === "done" ? "\u2705" : task.state === "in_progress" ? "\u23F3" : task.state === "blocked" ? "\u{1F6AB}" : task.state === "failed" ? "\u274C" : "\u{1F4CB}";
    lines.push(`### ${stateIcon} [${task.id}] ${task.title}`);
    lines.push(
      `- **Fase:** ${task.phase} | **Agente Respons\xE1vel:** @${task.agent} | **Estado:** \`${task.state}\``
    );
    if (task.depends_on.length > 0) {
      lines.push(`- **Depende de:** ${task.depends_on.map((d) => `\`${d}\``).join(", ")}`);
    }
    if (task.parallel_safe) {
      lines.push("- **Execu\xE7\xE3o Paralela:** Isolado em worktree (`parallel_safe: true`)");
    }
    if (task.description) {
      lines.push(`- **Descri\xE7\xE3o:** ${task.description}`);
    }
    if (task.acceptance.length > 0) {
      lines.push("- **Crit\xE9rios de Aceite (Fail-First):**");
      for (const acc of task.acceptance) {
        const mark = acc.verified ? "[x]" : "[ ]";
        const failFirst = acc.fails_now ? " *(falha antes da implementa\xE7\xE3o)*" : "";
        lines.push(`  - ${mark} \`${acc.kind}\`: ${acc.check}${failFirst}`);
        if (acc.proof) {
          lines.push(`    - *Evid\xEAncia/Receipt:* \`${acc.proof}\``);
        }
      }
    }
    if (task.result?.summary) {
      lines.push(`- **Resultado:** ${task.result.summary}`);
    }
    lines.push("");
  }
  if (plan.risks.length > 0) {
    lines.push("## 6. Riscos & Mitiga\xE7\xF5es");
    for (const r of plan.risks) {
      lines.push(`- **${r.id}:** ${r.description}`);
      if (r.mitigation) lines.push(`  - *Mitiga\xE7\xE3o:* ${r.mitigation}`);
    }
    lines.push("");
  }
  if (plan.out_of_scope.length > 0) {
    lines.push("## 7. Fora de Escopo");
    for (const item of plan.out_of_scope) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
function buildApprovalQuestion(plan) {
  return {
    question: `Deseja aprovar o plano de Deepwork "${plan.title}" (${plan.tasks.length} tarefas)?`,
    options: [
      "(Recomendado) Aprovar e iniciar execu\xE7\xE3o (Fase 1)",
      "Solicitar ajustes ou refinar tarefas",
      "Rejeitar / Cancelar plano"
    ]
  };
}

// src/pantheon/deepwork/plan-tracker.ts
import { existsSync as existsSync7 } from "node:fs";
import { appendFile as appendFile3, mkdir as mkdir6, readdir, readFile as readFile6, rename as rename5, writeFile as writeFile3 } from "node:fs/promises";
import { join as join16 } from "node:path";

// src/pantheon/deepwork/plan-schema.ts
import { z as z2 } from "zod";
var PlanAcceptanceKindSchema = z2.enum(["test", "command", "file", "manual"]);
var PlanAcceptanceCriterionSchema = z2.object({
  kind: PlanAcceptanceKindSchema,
  check: z2.string().min(1),
  fails_now: z2.boolean().default(true),
  verified: z2.boolean().default(false),
  proof: z2.string().optional()
});
var TaskStateSchema = z2.enum([
  "pending",
  "ready",
  "in_progress",
  "done",
  "failed",
  "blocked"
]);
var PlanTaskSchema = z2.object({
  id: z2.string().min(1),
  title: z2.string().min(1),
  description: z2.string().optional(),
  agent: z2.string().default("zeus"),
  phase: z2.number().int().min(0).default(1),
  state: TaskStateSchema.default("pending"),
  depends_on: z2.array(z2.string()).default([]),
  parallel_safe: z2.boolean().default(false),
  acceptance: z2.array(PlanAcceptanceCriterionSchema).default([]),
  result: z2.object({
    summary: z2.string().optional(),
    verified_at: z2.string().optional(),
    artifacts: z2.array(z2.string()).optional()
  }).optional()
});
var DecisionStatusSchema = z2.enum(["pending", "resolved"]);
var PlanDecisionSchema = z2.object({
  id: z2.string().min(1),
  question: z2.string().min(1),
  options: z2.array(z2.string()).min(2),
  chosen: z2.string().optional(),
  status: DecisionStatusSchema.default("pending")
});
var PlanRiskSchema = z2.object({
  id: z2.string().min(1),
  description: z2.string().min(1),
  mitigation: z2.string().optional()
});
var PlanMetadataSchema = z2.object({
  created_at: z2.string(),
  updated_at: z2.string(),
  version: z2.number().int().default(1)
});
var DeepworkPlanSchema = z2.object({
  plan_id: z2.string().min(1),
  title: z2.string().min(1),
  intent: z2.string().min(1),
  done_when: z2.array(z2.string()).default([]),
  decisions_needed: z2.array(PlanDecisionSchema).default([]),
  risks: z2.array(PlanRiskSchema).default([]),
  out_of_scope: z2.array(z2.string()).default([]),
  tasks: z2.array(PlanTaskSchema).default([]),
  metadata: PlanMetadataSchema
});

// src/pantheon/deepwork/plan-tracker.ts
function deepworkRootDir(cwd = process.cwd()) {
  return join16(cwd, ".pantheon", "deepwork");
}
function deepworkPlanDir(cwd = process.cwd(), slug) {
  return join16(deepworkRootDir(cwd), slug);
}
function deepworkPlanJsonPath(cwd = process.cwd(), slug) {
  return join16(deepworkPlanDir(cwd, slug), "plan.json");
}
function deepworkPlanMdPath(cwd = process.cwd(), slug) {
  return join16(deepworkPlanDir(cwd, slug), "PLAN.md");
}
function deepworkJournalPath(cwd = process.cwd(), slug) {
  return join16(deepworkPlanDir(cwd, slug), "journal.ndjson");
}
function computeTaskReadiness(plan) {
  const doneIds = new Set(plan.tasks.filter((t) => t.state === "done").map((t) => t.id));
  const updatedTasks = plan.tasks.map((task) => {
    if (task.state === "done" || task.state === "in_progress" || task.state === "failed") {
      return task;
    }
    if (task.depends_on.length === 0) {
      return task.state === "blocked" ? { ...task, state: "ready" } : task;
    }
    const allDepsDone = task.depends_on.every((dep) => doneIds.has(dep));
    if (allDepsDone && (task.state === "pending" || task.state === "blocked")) {
      return { ...task, state: "ready" };
    }
    if (!allDepsDone && (task.state === "pending" || task.state === "ready")) {
      return { ...task, state: "blocked" };
    }
    return task;
  });
  return { ...plan, tasks: updatedTasks };
}
async function readPlan(cwd = process.cwd(), slug) {
  const path5 = deepworkPlanJsonPath(cwd, slug);
  try {
    const raw = await readFile6(path5, "utf8");
    const parsed = JSON.parse(raw);
    return DeepworkPlanSchema.parse(parsed);
  } catch {
    return null;
  }
}
async function writePlan(cwd = process.cwd(), plan) {
  const dir = deepworkPlanDir(cwd, plan.plan_id);
  await mkdir6(dir, { recursive: true });
  const normalized = computeTaskReadiness({
    ...plan,
    metadata: {
      ...plan.metadata,
      updated_at: (/* @__PURE__ */ new Date()).toISOString(),
      version: (plan.metadata.version || 1) + 1
    }
  });
  const jsonPath = deepworkPlanJsonPath(cwd, plan.plan_id);
  const jsonTmp = `${jsonPath}.tmp`;
  await writeFile3(jsonTmp, `${JSON.stringify(normalized, null, 2)}
`, "utf8");
  await rename5(jsonTmp, jsonPath);
  const mdPath = deepworkPlanMdPath(cwd, plan.plan_id);
  const mdContent = generateMarkdownDocument(normalized);
  await writeFile3(mdPath, mdContent, "utf8");
}
async function appendJournal(cwd = process.cwd(), slug, event) {
  const dir = deepworkPlanDir(cwd, slug);
  await mkdir6(dir, { recursive: true });
  const journalPath = deepworkJournalPath(cwd, slug);
  const line = `${JSON.stringify(event)}
`;
  await appendFile3(journalPath, line, "utf8");
}
async function updateTaskState(cwd = process.cwd(), slug, taskId, state, result) {
  const plan = await readPlan(cwd, slug);
  if (!plan) {
    throw new Error(`Deepwork plan "${slug}" not found`);
  }
  const taskIndex = plan.tasks.findIndex((t) => t.id === taskId);
  const existingTask = plan.tasks[taskIndex];
  if (taskIndex === -1 || !existingTask) {
    throw new Error(`Task "${taskId}" not found in plan "${slug}"`);
  }
  const updatedResult = result ? { ...existingTask.result ?? {}, ...result } : existingTask.result;
  const updatedTask = {
    ...existingTask,
    state,
    ...updatedResult !== void 0 ? { result: updatedResult } : {}
  };
  const updatedTasks = [...plan.tasks];
  updatedTasks[taskIndex] = updatedTask;
  const nextPlan = { ...plan, tasks: updatedTasks };
  await writePlan(cwd, nextPlan);
  await appendJournal(cwd, slug, {
    type: "task_state_changed",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    payload: { taskId, state, result }
  });
  return await readPlan(cwd, slug) ?? nextPlan;
}
async function verifyTaskAcceptance(cwd = process.cwd(), slug, taskId, checkIndex, verified, proof) {
  const plan = await readPlan(cwd, slug);
  if (!plan) {
    throw new Error(`Deepwork plan "${slug}" not found`);
  }
  const taskIndex = plan.tasks.findIndex((t) => t.id === taskId);
  const task = plan.tasks[taskIndex];
  if (taskIndex === -1 || !task) {
    throw new Error(`Task "${taskId}" not found in plan "${slug}"`);
  }
  const currentAcc = task.acceptance[checkIndex];
  if (!currentAcc) {
    throw new Error(`Acceptance criterion index ${checkIndex} not found in task "${taskId}"`);
  }
  const updatedAcceptance = [...task.acceptance];
  const resolvedProof = proof ?? currentAcc.proof;
  updatedAcceptance[checkIndex] = {
    ...currentAcc,
    verified,
    ...resolvedProof !== void 0 ? { proof: resolvedProof } : {}
  };
  const allVerified = updatedAcceptance.every((acc) => acc.verified);
  const updatedTasks = [...plan.tasks];
  updatedTasks[taskIndex] = {
    ...task,
    acceptance: updatedAcceptance,
    state: allVerified ? "done" : task.state
  };
  const nextPlan = { ...plan, tasks: updatedTasks };
  await writePlan(cwd, nextPlan);
  await appendJournal(cwd, slug, {
    type: "acceptance_verified",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    payload: { taskId, checkIndex, verified, proof, allVerified }
  });
  return await readPlan(cwd, slug) ?? nextPlan;
}
async function resolvePlanDecision(cwd = process.cwd(), slug, decisionId, chosen) {
  const plan = await readPlan(cwd, slug);
  if (!plan) {
    throw new Error(`Deepwork plan "${slug}" not found`);
  }
  const decIndex = plan.decisions_needed.findIndex((d) => d.id === decisionId);
  const existingDec = plan.decisions_needed[decIndex];
  if (decIndex === -1 || !existingDec) {
    throw new Error(`Decision "${decisionId}" not found in plan "${slug}"`);
  }
  const updatedDecisions = [...plan.decisions_needed];
  updatedDecisions[decIndex] = {
    ...existingDec,
    chosen,
    status: "resolved"
  };
  const nextPlan = { ...plan, decisions_needed: updatedDecisions };
  await writePlan(cwd, nextPlan);
  await appendJournal(cwd, slug, {
    type: "decision_resolved",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    payload: { decisionId, chosen }
  });
  return await readPlan(cwd, slug) ?? nextPlan;
}
async function listPlans(cwd = process.cwd()) {
  const root = deepworkRootDir(cwd);
  if (!existsSync7(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const plan = await readPlan(cwd, entry.name);
      if (plan) {
        result.push({
          slug: plan.plan_id,
          title: plan.title,
          tasks_count: plan.tasks.length,
          done_count: plan.tasks.filter((t) => t.state === "done").length,
          updated_at: plan.metadata.updated_at
        });
      }
    }
  }
  return result;
}

// src/pantheon/deepwork/deepwork-tool.ts
var DeepworkToolInputSchema = z3.object({
  action: z3.enum([
    "init",
    "status",
    "update_task",
    "verify_acceptance",
    "resolve_decision",
    "list",
    "get_approval_question"
  ]).default("list"),
  slug: z3.string().optional(),
  title: z3.string().optional(),
  intent: z3.string().optional(),
  tasks: z3.array(z3.record(z3.string(), z3.unknown())).optional(),
  decisions: z3.array(z3.record(z3.string(), z3.unknown())).optional(),
  done_when: z3.array(z3.string()).optional(),
  taskId: z3.string().optional(),
  state: z3.enum(["pending", "ready", "in_progress", "done", "failed", "blocked"]).optional(),
  checkIndex: z3.number().int().min(0).optional(),
  verified: z3.boolean().optional(),
  proof: z3.string().optional(),
  decisionId: z3.string().optional(),
  choice: z3.string().optional(),
  summary: z3.string().optional()
});
function createDeepworkTool(cwd = process.cwd()) {
  return {
    name: "pantheon_deepwork",
    description: "Manage canonical Deepwork plans (.pantheon/deepwork/<slug>/plan.json, journal.ndjson, PLAN.md). Track DAG dependencies, update task states, record fail-first verification receipts, and inspect compact chat projections.",
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "init",
            "status",
            "update_task",
            "verify_acceptance",
            "resolve_decision",
            "list",
            "get_approval_question"
          ],
          description: "The Deepwork plan management action to perform."
        },
        slug: {
          type: "string",
          description: "Unique plan slug / directory name (e.g. auth-jwt, dashboard-ui)."
        },
        title: {
          type: "string",
          description: "Human-readable title of the deepwork plan (for init)."
        },
        intent: {
          type: "string",
          description: "The intent, problem description, and objectives (for init)."
        },
        tasks: {
          type: "array",
          description: "List of structured tasks with acceptance criteria (for init)."
        },
        decisions: {
          type: "array",
          description: "List of required architectural decisions (for init)."
        },
        done_when: {
          type: "array",
          description: "List of done criteria strings (for init)."
        },
        taskId: {
          type: "string",
          description: "Target task ID (e.g. T01, T02) for updates or verification."
        },
        state: {
          type: "string",
          enum: ["pending", "ready", "in_progress", "done", "failed", "blocked"],
          description: "New state for the specified task."
        },
        checkIndex: {
          type: "number",
          description: "Zero-based index of the acceptance criterion to verify."
        },
        verified: {
          type: "boolean",
          description: "Whether the acceptance criterion check passed."
        },
        proof: {
          type: "string",
          description: "Evidence snippet, command output, or test receipt."
        },
        decisionId: {
          type: "string",
          description: "Target decision ID (e.g. D01) for resolution."
        },
        choice: {
          type: "string",
          description: "The chosen option for the decision."
        },
        summary: {
          type: "string",
          description: "Summary of results or deliverable for a completed task."
        }
      },
      required: []
    },
    output: {},
    async execute(input, context) {
      const parsed = DeepworkToolInputSchema.parse(input);
      const effectiveCwd = typeof context?.directory === "string" ? context.directory : cwd;
      if (parsed.action === "list") {
        const plans = await listPlans(effectiveCwd);
        if (plans.length === 0) {
          return {
            output: "Nenhum plano de Deepwork encontrado em .pantheon/deepwork/.",
            title: "Deepwork: List"
          };
        }
        const lines = [
          "### Planos de Deepwork Dispon\xEDveis:",
          "| Slug | T\xEDtulo | Progresso | Atualizado em |",
          "|---|---|---|---|"
        ];
        for (const p of plans) {
          lines.push(
            `| \`${p.slug}\` | ${p.title} | ${p.done_count}/${p.tasks_count} tarefas | ${p.updated_at} |`
          );
        }
        return {
          output: lines.join("\n"),
          title: "Deepwork: List"
        };
      }
      const slug = parsed.slug?.trim();
      if (!slug) {
        throw new Error(`O par\xE2metro 'slug' \xE9 obrigat\xF3rio para a a\xE7\xE3o '${parsed.action}'.`);
      }
      if (parsed.action === "init") {
        const title = parsed.title?.trim() || slug;
        const intent = parsed.intent?.trim() || "Plano de deepwork estruturado.";
        const rawTasks = parsed.tasks ?? [];
        const rawDecisions = parsed.decisions ?? [];
        const doneWhen = parsed.done_when ?? [];
        const tasks = rawTasks.map((t, idx) => ({
          id: typeof t.id === "string" ? t.id : `T${String(idx + 1).padStart(2, "0")}`,
          title: typeof t.title === "string" ? t.title : `Task ${idx + 1}`,
          description: typeof t.description === "string" ? t.description : void 0,
          agent: typeof t.agent === "string" ? t.agent : "zeus",
          phase: typeof t.phase === "number" ? t.phase : 1,
          state: typeof t.state === "string" ? t.state : "pending",
          depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
          parallel_safe: Boolean(t.parallel_safe),
          acceptance: Array.isArray(t.acceptance) ? t.acceptance.map((a) => ({
            kind: a.kind || "command",
            check: a.check || "verify",
            fails_now: a.fails_now ?? true,
            verified: a.verified ?? false,
            proof: a.proof
          })) : []
        }));
        const decisions = rawDecisions.map((d, idx) => ({
          id: typeof d.id === "string" ? d.id : `D${String(idx + 1).padStart(2, "0")}`,
          question: typeof d.question === "string" ? d.question : "Decis\xE3o necess\xE1ria",
          options: Array.isArray(d.options) ? d.options : ["Sim", "N\xE3o"],
          chosen: typeof d.chosen === "string" ? d.chosen : void 0,
          status: d.chosen ? "resolved" : "pending"
        }));
        const initialPlan = computeTaskReadiness({
          plan_id: slug,
          title,
          intent,
          done_when: doneWhen,
          decisions_needed: decisions,
          risks: [],
          out_of_scope: [],
          tasks,
          metadata: {
            created_at: (/* @__PURE__ */ new Date()).toISOString(),
            updated_at: (/* @__PURE__ */ new Date()).toISOString(),
            version: 1
          }
        });
        await writePlan(effectiveCwd, initialPlan);
        await appendJournal(effectiveCwd, slug, {
          type: "plan_created",
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          payload: { slug, title, tasks_count: tasks.length }
        });
        const projection = generateChatProjection(initialPlan, effectiveCwd);
        const approvalQ = buildApprovalQuestion(initialPlan);
        const todoPayload = {
          todos: tasks.map((t) => ({
            content: `[${t.id}] ${t.title}`,
            status: t.state === "done" ? "completed" : t.state === "in_progress" ? "in_progress" : "pending"
          }))
        };
        return {
          output: [
            `\u2705 Plano de Deepwork '${title}' inicializado com sucesso em \`.pantheon/deepwork/${slug}/\`!`,
            `- \u{1F517} **Deeplink PLAN.md:** [Abrir PLAN.md](file://${deepworkPlanMdPath(effectiveCwd, slug)})`,
            `- \u{1F517} **Deeplink plan.json:** [Abrir plan.json](file://${deepworkPlanJsonPath(effectiveCwd, slug)})`,
            "",
            projection,
            "",
            "**TUI Todo Sync:** Espelhe as tarefas chamando `todowrite` com:",
            `\`\`\`json
${JSON.stringify(todoPayload, null, 2)}
\`\`\``,
            "",
            "**Pergunta de Aprova\xE7\xE3o Nativa (Gate 1):**",
            `\`${JSON.stringify(approvalQ)}\``
          ].join("\n"),
          title: `Deepwork Init: ${slug}`
        };
      }
      const currentPlan = await readPlan(effectiveCwd, slug);
      if (!currentPlan) {
        throw new Error(`Plano de Deepwork '${slug}' n\xE3o encontrado.`);
      }
      if (parsed.action === "status") {
        const projection = generateChatProjection(currentPlan, effectiveCwd);
        const dag = generateMermaidDag(currentPlan);
        return {
          output: [projection, "", "#### Grafo de Depend\xEAncias (DAG):", dag].join("\n"),
          title: `Deepwork Status: ${slug}`
        };
      }
      if (parsed.action === "get_approval_question") {
        const q = buildApprovalQuestion(currentPlan);
        return {
          output: JSON.stringify(q, null, 2),
          title: `Deepwork Approval Question: ${slug}`
        };
      }
      if (parsed.action === "update_task") {
        if (!parsed.taskId) throw new Error("Par\xE2metro 'taskId' obrigat\xF3rio para update_task.");
        if (!parsed.state) throw new Error("Par\xE2metro 'state' obrigat\xF3rio para update_task.");
        const resultMeta = {};
        if (parsed.summary !== void 0) {
          resultMeta.summary = parsed.summary;
        }
        const updated = await updateTaskState(
          effectiveCwd,
          slug,
          parsed.taskId,
          parsed.state,
          resultMeta
        );
        const projection = generateChatProjection(updated, effectiveCwd);
        return {
          output: [
            `Tarefa **[${parsed.taskId}]** atualizada para \`${parsed.state}\`.`,
            "",
            projection
          ].join("\n"),
          title: `Deepwork Task: ${parsed.taskId} -> ${parsed.state}`
        };
      }
      if (parsed.action === "verify_acceptance") {
        if (!parsed.taskId)
          throw new Error("Par\xE2metro 'taskId' obrigat\xF3rio para verify_acceptance.");
        if (parsed.checkIndex === void 0)
          throw new Error("Par\xE2metro 'checkIndex' obrigat\xF3rio para verify_acceptance.");
        if (parsed.verified === void 0)
          throw new Error("Par\xE2metro 'verified' obrigat\xF3rio para verify_acceptance.");
        const updated = await verifyTaskAcceptance(
          effectiveCwd,
          slug,
          parsed.taskId,
          parsed.checkIndex,
          parsed.verified,
          parsed.proof
        );
        const projection = generateChatProjection(updated, effectiveCwd);
        return {
          output: [
            `Crit\xE9rio de aceite #${parsed.checkIndex} da tarefa **[${parsed.taskId}]** verificado: ${parsed.verified ? "\u2705 PASS" : "\u274C FAIL"}.`,
            parsed.proof ? `*Evid\xEAncia/Receipt:* \`${parsed.proof}\`` : "",
            "",
            projection
          ].filter(Boolean).join("\n"),
          title: `Deepwork Verify: ${parsed.taskId} [${parsed.checkIndex}]`
        };
      }
      if (parsed.action === "resolve_decision") {
        if (!parsed.decisionId)
          throw new Error("Par\xE2metro 'decisionId' obrigat\xF3rio para resolve_decision.");
        if (!parsed.choice) throw new Error("Par\xE2metro 'choice' obrigat\xF3rio para resolve_decision.");
        const updated = await resolvePlanDecision(
          effectiveCwd,
          slug,
          parsed.decisionId,
          parsed.choice
        );
        const projection = generateChatProjection(updated, effectiveCwd);
        return {
          output: [
            `Decis\xE3o **[${parsed.decisionId}]** resolvida com a op\xE7\xE3o: "${parsed.choice}".`,
            "",
            projection
          ].join("\n"),
          title: `Deepwork Decision: ${parsed.decisionId}`
        };
      }
      throw new Error(`A\xE7\xE3o '${parsed.action}' n\xE3o reconhecida.`);
    }
  };
}

// src/pantheon/hashline/tool.ts
import { readFile as readFile7, rename as rename6, rm, writeFile as writeFile4 } from "node:fs/promises";
import { isAbsolute as isAbsolute4, resolve as resolve6, sep as sep4 } from "node:path";
import { z as z4 } from "zod";
var hashlineEditOpArgs = {
  op: z4.enum(["replace", "append", "prepend", "delete"]),
  ref: z4.string().min(1),
  endRef: z4.string().optional(),
  lines: z4.array(z4.string()).optional(),
  content: z4.string().optional()
};
var hashlineEditArgs = {
  file: z4.string().min(1),
  edits: z4.array(z4.object(hashlineEditOpArgs)).min(1)
};
function resolveFile(file, ctx) {
  if (isAbsolute4(file)) return { ok: true, file: resolve6(file) };
  const base = resolve6(ctx.worktree ?? ctx.directory ?? process.cwd());
  const resolved = resolve6(base, file);
  if (resolved !== base && !resolved.startsWith(base + sep4)) {
    return {
      ok: false,
      error: `hashline_edit: file "${file}" escapes the worktree (resolved to "${resolved}") \u2014 path containment denied`
    };
  }
  return { ok: true, file: resolved };
}
function resolveRef(raw, file, lines) {
  const m = HASHLINE_REF_RE.exec(raw);
  if (!m) {
    return `hashline_edit: invalid ref "${raw}" \u2014 expected "LINE#TAG" (e.g. "12#XJ")`;
  }
  const line = Number(m[1]);
  const tag = m[2];
  if (line < 1 || line > lines.length) {
    return `hashline_edit: ref "${raw}" line ${line} out of range \u2014 file has ${lines.length} line(s)`;
  }
  const actual = hashTag(lines[line - 1] ?? "", line);
  if (actual !== tag) {
    return buildMismatchError(file, raw, { line, tag: actual, content: lines[line - 1] }, lines);
  }
  return { line, tag, raw };
}
function validateEdits(args, file, lines) {
  const resolved = [];
  for (const [i, e] of args.edits.entries()) {
    const pos = resolveRef(e.ref, file, lines);
    if (typeof pos === "string") return pos;
    const edit = { op: e.op, line: pos.line, endLine: pos.line, insert: [] };
    if (e.op === "delete" && e.lines) {
      return `hashline_edit: delete edit (index ${i}) must not provide "lines"`;
    }
    if (e.op === "replace" && (!e.lines || e.lines.length === 0)) {
      return `hashline_edit: replace edit (index ${i}) requires non-empty "lines"`;
    }
    if ((e.op === "append" || e.op === "prepend") && typeof e.content !== "string") {
      return `hashline_edit: ${e.op} edit (index ${i}) requires "content"`;
    }
    if (e.endRef) {
      const end = resolveRef(e.endRef, file, lines);
      if (typeof end === "string") return end;
      if (end.line < edit.line) {
        return `hashline_edit: endRef "${e.endRef}" is before ref "${e.ref}"`;
      }
      edit.endLine = end.line;
    }
    if (e.op === "replace") {
      edit.insert = e.lines ?? [];
    } else if (e.op === "append" || e.op === "prepend") {
      edit.insert = (e.content ?? "").split("\n");
    }
    resolved.push(edit);
  }
  return resolved;
}
function createHashlineEditTool() {
  return {
    description: "Edit a file anchored by hashline refs (LINE#TAG) instead of raw line numbers. Ops: replace (ref..endRef or single ref \u2192 lines), append/prepend (anchor ref \u2192 content), delete (ref..endRef). ALL refs must be validated against the ORIGINAL file before anything is written; on mismatch the tool returns an error with a re-tagged excerpt and a Did-you-mean suggestion, and nothing is modified.",
    args: hashlineEditArgs,
    execute: async (args, ctx) => {
      const resolved = resolveFile(args.file, ctx);
      if (!resolved.ok) return resolved.error;
      const file = resolved.file;
      let original;
      try {
        original = await readFile7(file, "utf8");
      } catch {
        return `hashline_edit: cannot read "${file}" \u2014 check the path and try again`;
      }
      const hadTrailingNewline = original.endsWith("\n");
      const lines = original.split("\n");
      const edits = validateEdits(args, file, lines);
      if (typeof edits === "string") return edits;
      edits.sort((a, b) => b.line - a.line || b.endLine - a.endLine);
      const working = [...lines];
      for (const e of edits) {
        const deleteCount = e.endLine - e.line + 1;
        if (e.op === "replace") {
          working.splice(e.line - 1, deleteCount, ...e.insert);
        } else if (e.op === "delete") {
          working.splice(e.line - 1, deleteCount);
        } else if (e.op === "append") {
          working.splice(e.line, 0, ...e.insert);
        } else {
          working.splice(e.line - 1, 0, ...e.insert);
        }
      }
      let out = working.join("\n");
      if (hadTrailingNewline && !out.endsWith("\n")) out += "\n";
      const tmpPath = `${file}.tmp-${process.pid}`;
      try {
        await writeFile4(tmpPath, out, "utf8");
        await rename6(tmpPath, file);
      } catch {
        await rm(tmpPath, { force: true }).catch(() => {
        });
        return `hashline_edit: cannot write "${file}" \u2014 check permissions and try again`;
      }
      const firstChangedLine = Math.min(...edits.map((e) => e.line));
      return {
        title: "hashline_edit",
        output: `Updated ${file}: ${edits.length} edit(s) applied, first changed line ${firstChangedLine}.`,
        metadata: { firstChangedLine, changedCount: edits.length }
      };
    }
  };
}

// src/pantheon/local-decision-tool.ts
import { tool } from "@opencode-ai/plugin";

// src/pantheon/decision-points/p3-complexity.ts
var COMPLEXITY_LABEL_LEVEL = Object.freeze({ low: 1, medium: 2, high: 3 });
var GATE_STATUSES2 = /* @__PURE__ */ new Set([
  "none",
  "review_required",
  "human_approval_required",
  "unresolved"
]);
function isRecord20(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function gateOutcome(gate, label) {
  if (gate === "none") return { decision: `score.${label}`, reason: "gate.none" };
  if (gate === "review_required") {
    return { decision: `advisory.${label}`, reason: "gate.review.required" };
  }
  if (gate === "human_approval_required") {
    return { decision: "refusal", reason: "gate.human.approval.required" };
  }
  return { decision: "refusal", reason: "gate.unresolved" };
}
function evaluateComplexityPoint(input, sink) {
  const complexity = isRecord20(input) ? input.complexity : void 0;
  const rawGate = isRecord20(input) ? input.gateStatus : void 0;
  const classified = classifyLocalDecisionComplexity(
    complexity
  );
  const gateStatus = typeof rawGate === "string" && GATE_STATUSES2.has(rawGate) ? rawGate : null;
  let decision2;
  if (classified.label === "abstain") {
    decision2 = { decision: "refusal", reason: "complexity.invalid" };
  } else if (gateStatus === null) {
    decision2 = { decision: "refusal", reason: "invalid.gate" };
  } else {
    decision2 = gateOutcome(gateStatus, classified.label);
  }
  return {
    record: observeShadow("P3", input, () => decision2, sink),
    label: classified.label,
    level: classified.label === "abstain" ? null : COMPLEXITY_LABEL_LEVEL[classified.label],
    gateStatus,
    reason: decision2.reason
  };
}

// src/pantheon/local-decision-tool.ts
var TOOL_DESCRIPTION2 = "Zeus-only local advisory selector. Use selectively only when specialist routing is genuinely ambiguous; obvious work should go directly to native subagent without this tool. Accepts only structured candidate IDs, never task text. It does not dispatch, run a skill/resource, search memory, or authorize/alter grants or review gates. Provider egress is disabled; all decisions remain local.";
var gateStatuses = [
  "none",
  "review_required",
  "human_approval_required",
  "unresolved"
];
var inputShape = {
  schemaVersion: tool.schema.literal(1),
  candidateAgents: tool.schema.array(tool.schema.string().min(1)).max(14),
  domain: tool.schema.string().nullable(),
  candidateSkillIds: tool.schema.array(tool.schema.string().min(1)).max(64),
  candidateResourceIds: tool.schema.array(tool.schema.string().min(1)).max(32),
  memorySearchRelevant: tool.schema.boolean(),
  gateStatus: tool.schema.enum(
    gateStatuses
  ),
  complexity: tool.schema.object({
    boundedness: tool.schema.number().int().min(0).max(2),
    reversibility: tool.schema.number().int().min(0).max(2),
    dependencies: tool.schema.number().int().min(0).max(2),
    uncertainty: tool.schema.number().int().min(0).max(2),
    verification: tool.schema.number().int().min(0).max(2)
  }).strict()
};
function observeToolComplexity(input, sink) {
  try {
    evaluateComplexityPoint(input, sink);
  } catch {
  }
}
async function runDecision(input, callerAgent, loadPolicy) {
  if (callerAgent !== "zeus") {
    return JSON.stringify(recommendLocalOrchestration(input, callerAgent, void 0));
  }
  const policy = await loadPolicy().catch(() => void 0);
  return JSON.stringify(recommendLocalOrchestration(input, callerAgent, policy));
}
var v2InputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "candidateAgents",
    "domain",
    "candidateSkillIds",
    "candidateResourceIds",
    "memorySearchRelevant",
    "gateStatus",
    "complexity"
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    candidateAgents: { type: "array", maxItems: 14, items: { type: "string", minLength: 1 } },
    domain: { type: ["string", "null"] },
    candidateSkillIds: { type: "array", maxItems: 64, items: { type: "string", minLength: 1 } },
    candidateResourceIds: { type: "array", maxItems: 32, items: { type: "string", minLength: 1 } },
    memorySearchRelevant: { type: "boolean" },
    gateStatus: { type: "string", enum: gateStatuses },
    complexity: {
      type: "object",
      additionalProperties: false,
      required: [...LOCAL_DECISION_COMPLEXITY_DIMENSIONS],
      properties: Object.fromEntries(
        LOCAL_DECISION_COMPLEXITY_DIMENSIONS.map((dimension) => [
          dimension,
          { type: "integer", minimum: 0, maximum: 2 }
        ])
      )
    }
  }
};
function createV2LocalDecisionDefinition(options = {}) {
  const policyLoader = options.loadPolicy ?? loadLocalDecisionPolicy;
  return {
    name: "pantheon_local_decision",
    description: TOOL_DESCRIPTION2,
    input: v2InputSchema,
    output: {},
    execute: async (input, context) => {
      observeToolComplexity(input, options.sink);
      const callerAgent = context !== null && typeof context === "object" ? context.agent : void 0;
      return { output: await runDecision(input, callerAgent, policyLoader) };
    }
  };
}

// src/pantheon/model-command.ts
import { randomBytes } from "node:crypto";
import { constants as constants4 } from "node:fs";
import { lstat as lstat2, mkdir as mkdir7, open as open3, rename as rename7, unlink as unlink4 } from "node:fs/promises";
import { homedir as homedir7 } from "node:os";
import { basename as basename2, dirname as dirname9, join as join17, resolve as resolve7 } from "node:path";
import { z as z5 } from "zod";
var MODEL_REF_PATTERN2 = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
var SAFE_PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var KNOWN_AGENTS_SET2 = new Set(KNOWN_AGENTS);
var modelArgs = {
  action: z5.enum(["status", "show", "set", "reset"]).optional().describe("Operation: status/show, set, or reset. No args runs wizard."),
  agent: z5.string().optional().describe("Agent name (one of 14 canonical agents)."),
  model: z5.string().optional().describe("Model in provider/model-id format; used by set."),
  effort: z5.enum(["low", "medium", "high"]).optional().describe("Reasoning effort (variant), clamped to model capability."),
  scope: z5.enum(["project", "global"]).optional().describe("Configuration scope for active-preset.json (default project)."),
  confirm: z5.boolean().optional().describe("Explicitly confirm a mutating operation, required for global changes."),
  authorize_global: z5.boolean().optional().describe("Separate authorization for changing global configuration; not implied by -y.")
};
var ModelCommandError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelCommandError";
  }
};
var NO_FOLLOW = constants4.O_NOFOLLOW ?? 0;
var PERMISSION_MASK = 4095;
var DEFAULT_FILE_MODE = 384;
var pathLocks = /* @__PURE__ */ new Map();
function errorCode2(error) {
  return error instanceof Error && "code" in error ? error.code : void 0;
}
async function existingPath(path5) {
  try {
    return await lstat2(path5);
  } catch (error) {
    if (errorCode2(error) === "ENOENT") return void 0;
    throw error;
  }
}
function assertRegular(stats, label) {
  if (stats.isSymbolicLink()) {
    throw new ModelCommandError(`${label} must not be a symlink`);
  }
  if (!stats.isFile()) {
    throw new ModelCommandError(`${label} must be a regular file`);
  }
}
async function regularPath(path5, label) {
  const stats = await existingPath(path5);
  if (stats !== void 0) assertRegular(stats, label);
  return stats;
}
async function readRegularFile(path5, label) {
  const stats = await regularPath(path5, label);
  if (stats === void 0) return void 0;
  let file;
  try {
    file = await open3(path5, constants4.O_RDONLY | NO_FOLLOW);
    const openedStats = await file.stat();
    if (!openedStats.isFile()) throw new ModelCommandError(`${label} must be a regular file`);
    return {
      content: await file.readFile("utf8"),
      mode: openedStats.mode & PERMISSION_MASK
    };
  } catch (error) {
    if (errorCode2(error) === "ELOOP") {
      throw new ModelCommandError(`${label} must not be a symlink`);
    }
    throw error;
  } finally {
    await file?.close().catch(() => void 0);
  }
}
async function syncDirectory(path5) {
  let directory;
  try {
    directory = await open3(path5, constants4.O_RDONLY | NO_FOLLOW);
    const stats = await directory.stat();
    if (!stats.isDirectory()) {
      throw new ModelCommandError("configuration directory is not a directory");
    }
    await directory.sync();
  } catch (error) {
    if (errorCode2(error) !== "EINVAL" && errorCode2(error) !== "ENOTSUP") throw error;
  } finally {
    await directory?.close().catch(() => void 0);
  }
}
async function createTemporaryFile(path5) {
  const directory = dirname9(path5);
  const prefix = `.${basename2(path5)}.tmp-`;
  const flags = constants4.O_WRONLY | constants4.O_CREAT | constants4.O_EXCL | NO_FOLLOW;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const temporaryPath = join17(directory, `${prefix}${randomBytes(16).toString("hex")}`);
    try {
      return { path: temporaryPath, file: await open3(temporaryPath, flags, DEFAULT_FILE_MODE) };
    } catch (error) {
      if (errorCode2(error) !== "EEXIST") throw error;
    }
  }
  throw new ModelCommandError("could not allocate a unique temporary file");
}
async function atomicReplace(path5, content, mode, label, expectedExists) {
  const before = await regularPath(path5, label);
  if (before !== void 0 !== expectedExists) {
    throw new ModelCommandError(`${label} changed while it was being updated`);
  }
  let temporaryPath;
  let temporaryFile;
  let renamed = false;
  try {
    const temporary = await createTemporaryFile(path5);
    temporaryPath = temporary.path;
    temporaryFile = temporary.file;
    await temporaryFile.writeFile(content, "utf8");
    await temporaryFile.chmod(mode);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = void 0;
    const temporaryStats = await regularPath(temporaryPath, "temporary configuration file");
    if (temporaryStats === void 0) {
      throw new ModelCommandError("temporary configuration file disappeared");
    }
    const current = await regularPath(path5, label);
    if (current !== void 0 !== expectedExists) {
      throw new ModelCommandError(`${label} changed while it was being updated`);
    }
    await rename7(temporaryPath, path5);
    renamed = true;
    await syncDirectory(dirname9(path5));
  } finally {
    await temporaryFile?.close().catch(() => void 0);
    if (temporaryPath !== void 0 && !renamed) {
      await unlink4(temporaryPath).catch(() => void 0);
    }
  }
}
async function withPathLock(path5, operation) {
  const previous = pathLocks.get(path5) ?? Promise.resolve();
  let release;
  const own = new Promise((resolveRelease) => {
    release = resolveRelease;
  });
  const queued = previous.then(() => own);
  pathLocks.set(path5, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pathLocks.get(path5) === queued) pathLocks.delete(path5);
  }
}
function validateModelRef(value) {
  return typeof value === "string" && MODEL_REF_PATTERN2.test(value);
}
function envValue(options) {
  return options.env ?? process.env;
}
function projectConfigPath(options) {
  return options.projectConfigPath ?? join17(options.cwd ?? process.cwd(), "opencode.json");
}
function defaultGlobalConfigPath(options) {
  const env = envValue(options);
  const home = env.HOME?.trim() || homedir7();
  const xdg = env.XDG_CONFIG_HOME?.trim() || join17(home, ".config");
  return join17(xdg, "opencode", "opencode.json");
}
function globalConfigCandidates(options) {
  if (options.globalConfigPath !== void 0) return [options.globalConfigPath];
  const canonical = defaultGlobalConfigPath(options);
  const home = envValue(options).HOME?.trim() || homedir7();
  const legacy = join17(home, ".opencode", "opencode.json");
  return [.../* @__PURE__ */ new Set([canonical, legacy])];
}
function activePresetCandidatesList(options) {
  if (options.activePresetCandidates !== void 0) {
    return options.activePresetCandidates.map((p) => resolve7(p));
  }
  const projectPreset = join17(dirname9(projectConfigPath(options)), ".pantheon", "active-preset.json");
  const globalPresets = globalConfigCandidates(options).map(
    (p) => join17(dirname9(p), ".pantheon", "active-preset.json")
  );
  return [...new Set([projectPreset, ...globalPresets].map((p) => resolve7(p)))];
}
function presetPathForScope(options, scope) {
  const candidates = activePresetCandidatesList(options);
  if (scope === "project") {
    const first = candidates[0];
    if (!first) throw new ModelCommandError("project preset path is unavailable");
    return first;
  }
  const second = candidates[1];
  if (second) return second;
  const globalCandidates = globalConfigCandidates(options).map(
    (p) => resolve7(join17(dirname9(p), ".pantheon", "active-preset.json"))
  );
  const fallback = globalCandidates[0] ?? candidates[0];
  if (!fallback) throw new ModelCommandError("global preset path is unavailable");
  return fallback;
}
async function readActivePresetRaw(path5, label) {
  const file = await readRegularFile(path5, label);
  if (file === void 0) return { exists: false, valid: true, data: null };
  try {
    const parsed = JSON.parse(file.content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, valid: false, data: null, content: file.content, mode: file.mode };
    }
    return {
      exists: true,
      valid: true,
      data: parsed,
      content: file.content,
      mode: file.mode
    };
  } catch {
    return { exists: true, valid: false, data: null, content: file.content, mode: file.mode };
  }
}
async function readV2ActivePresetRaw(path5, label, fileSystem = {
  open: async (filePath, flags) => open3(filePath, flags)
}) {
  const noFollowFlag = constants4.O_NOFOLLOW;
  const nonBlockFlag = constants4.O_NONBLOCK;
  if (noFollowFlag === void 0 || noFollowFlag === 0 || nonBlockFlag === void 0 || nonBlockFlag === 0) {
    throw new ModelCommandError(
      `${label} cannot be read securely on this platform; configuration was not changed`
    );
  }
  let file;
  try {
    file = await fileSystem.open(path5, constants4.O_RDONLY | noFollowFlag | nonBlockFlag);
    const openedStats = await file.stat();
    if (!openedStats.isFile()) {
      throw new ModelCommandError(
        `${label} must be a regular file and must not be a symlink; configuration was not changed`
      );
    }
    const content = await file.readFile("utf8");
    try {
      const parsed = JSON.parse(content);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          exists: true,
          valid: false,
          data: null,
          content,
          mode: openedStats.mode & PERMISSION_MASK
        };
      }
      return {
        exists: true,
        valid: true,
        data: parsed,
        content,
        mode: openedStats.mode & PERMISSION_MASK
      };
    } catch {
      return {
        exists: true,
        valid: false,
        data: null,
        content,
        mode: openedStats.mode & PERMISSION_MASK
      };
    }
  } catch (error) {
    if (errorCode2(error) === "ENOENT") return { exists: false, valid: true, data: null };
    if (errorCode2(error) === "ELOOP") {
      throw new ModelCommandError(`${label} must not be a symlink; configuration was not changed`);
    }
    throw error;
  } finally {
    await file?.close().catch(() => void 0);
  }
}
function normalizeAgentName(value) {
  return value.trim().toLowerCase();
}
function validateAgent(agent) {
  const normalized = normalizeAgentName(agent);
  if (!KNOWN_AGENTS_SET2.has(normalized)) {
    throw new ModelCommandError(
      `unknown agent "${agent}"; known agents: ${KNOWN_AGENTS.join(", ")}`
    );
  }
  return normalized;
}
function isValidEffort(value) {
  return value === "low" || value === "medium" || value === "high";
}
function validateSetArgs(args) {
  if (!args.agent) throw new ModelCommandError("set requires --agent <name>");
  validateAgent(args.agent);
  if (args.model !== void 0 && !validateModelRef(args.model)) {
    throw new ModelCommandError("model must use provider/model-id format");
  }
  if (args.model === void 0) {
    throw new ModelCommandError("set requires --model <provider/model-id>");
  }
  if (args.effort !== void 0 && !isValidEffort(args.effort)) {
    throw new ModelCommandError("effort must be one of low, medium, high");
  }
  try {
    capabilityEntry(args.model);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new ModelCommandError(msg);
  }
}
function validateResetArgs(args) {
  if (!args.agent) throw new ModelCommandError("reset requires --agent <name>");
  validateAgent(args.agent);
}
function validateMutationAuthorization(args, scope) {
  if (scope !== "global") return;
  if (args.confirm !== true || args.authorize_global !== true) {
    throw new ModelCommandError(
      "global set/reset requires explicit confirmation and separate global authorization; -y is not sufficient"
    );
  }
}
async function writeActivePresetAtomically(path5, data, current) {
  const backupPath = `${path5}.bak`;
  await mkdir7(dirname9(path5), { recursive: true });
  const originalMode = current.mode ?? DEFAULT_FILE_MODE;
  const backupMode = originalMode & 384;
  const backup = await regularPath(backupPath, "configuration backup");
  if (current.exists) {
    if (current.content === void 0) {
      throw new ModelCommandError("configuration content could not be read; file preserved");
    }
    await atomicReplace(
      backupPath,
      current.content,
      backupMode,
      "configuration backup",
      backup !== void 0
    );
  }
  await atomicReplace(
    path5,
    `${JSON.stringify(data, null, 2)}
`,
    originalMode,
    "configuration file",
    current.exists
  );
}
function ensureActivePresetShape(raw, fallbackPreset) {
  const out = raw && typeof raw === "object" ? { ...raw } : {};
  if (typeof out.version !== "number") out.version = 1;
  if (fallbackPreset !== void 0 && (typeof out.preset !== "string" || out.preset.trim() === "")) {
    out.preset = fallbackPreset;
  }
  if (typeof out.source !== "string") out.source = "cli";
  out.updated_at = (/* @__PURE__ */ new Date()).toISOString();
  if (out.overrides === void 0 || out.overrides === null || typeof out.overrides !== "object" || Array.isArray(out.overrides)) {
    out.overrides = {};
  }
  const overrides = out.overrides;
  if (overrides.agents === void 0 || overrides.agents === null || typeof overrides.agents !== "object" || Array.isArray(overrides.agents)) {
    overrides.agents = {};
  }
  return out;
}
function defaultFallbackPreset() {
  try {
    const defs = loadPresetDefs();
    const first = Object.keys(defs)[0];
    if (first) return first;
  } catch {
  }
  return "go-free";
}
async function updateActivePreset(options, args, action, scope) {
  validateMutationAuthorization(args, scope);
  if (action === "set") validateSetArgs(args);
  else validateResetArgs(args);
  const path5 = presetPathForScope(options, scope);
  return withPathLock(path5, async () => {
    const current = options.v2Mode ? await readV2ActivePresetRaw(path5, "configuration file", options.v2PresetReadFileSystem) : await readActivePresetRaw(path5, "configuration file");
    if (current.exists && !current.valid) {
      throw new ModelCommandError(`${scope} preset file contains invalid JSON; file preserved`);
    }
    let fallbackPreset;
    if (!options.v2Mode) {
      const env = envValue(options);
      fallbackPreset = defaultFallbackPreset();
      const envPreset = env.PANTHEON_MODEL_PRESET?.trim();
      if (envPreset && envPreset !== "" && envPreset !== "none") {
        try {
          const defs = loadPresetDefs();
          if (Object.hasOwn(defs, envPreset)) fallbackPreset = envPreset;
        } catch {
        }
      } else if (current.data && typeof current.data === "object" && current.data.preset) {
        const existing = current.data.preset;
        if (typeof existing === "string" && existing.trim() !== "" && SAFE_PRESET_NAME.test(existing.trim())) {
          fallbackPreset = existing.trim();
        }
      }
    }
    const shaped = ensureActivePresetShape(
      current.data,
      fallbackPreset
    );
    const overrides = shaped.overrides;
    const agents = overrides.agents;
    if (typeof args.agent !== "string") {
      throw new ModelCommandError(`${action} requires --agent <name>`);
    }
    const agentKey = validateAgent(args.agent);
    if (action === "set") {
      if (typeof args.model !== "string") {
        throw new ModelCommandError("set requires --model <provider/model-id>");
      }
      const model = args.model;
      const effort = args.effort;
      let variantInfo;
      try {
        variantInfo = normalizeCapability(model, effort);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new ModelCommandError(msg);
      }
      let visionWarning = "";
      try {
        const vision = hasVision(model);
        if (!vision) {
          visionWarning = `warning: model ${model} is text-only (no vision) \u2014 image turns will use vision fallback`;
        }
      } catch {
      }
      const entry = { model };
      if (variantInfo.variant !== null) entry.variant = variantInfo.variant;
      agents[agentKey] = entry;
      if (variantInfo.clamped) {
        visionWarning = [
          visionWarning,
          `effort clamped to ${variantInfo.variant} for model ${model}`
        ].filter(Boolean).join("; ");
      }
      await writeActivePresetAtomically(path5, shaped, current);
      try {
        if (options.v2Mode) {
          const written = await readV2ActivePresetRaw(
            path5,
            "configuration file",
            options.v2PresetReadFileSystem
          );
          if (written.exists && written.content !== void 0) JSON.parse(written.content);
        } else {
          const written = await readRegularFile(path5, "configuration file");
          if (written) JSON.parse(written.content);
        }
      } catch {
        options.logger?.warn?.("health-check: active-preset.json verification failed");
      }
      const activation = options.v2Mode ? "V2 reads this override during the next agent-config transform on a subsequent OpenCode configuration load; the current session is unchanged." : "Restart OpenCode for the change to take effect.";
      const base = `Model override set (${scope}): ${agentKey} \u2192 ${model} (effort: ${variantInfo.variant ?? "none"}). ${activation}`;
      return visionWarning ? `${base}
${visionWarning}` : base;
    } else {
      if (!Object.hasOwn(agents, agentKey)) {
        return `No override to remove for agent "${agentKey}" in ${scope} preset.`;
      }
      delete agents[agentKey];
      await writeActivePresetAtomically(path5, shaped, current);
      const activation = options.v2Mode ? "V2 reads overrides during the next agent-config transform on a subsequent OpenCode configuration load; the current session is unchanged." : "Restart OpenCode for the change to take effect.";
      return `Model override removed (${scope}): ${agentKey}. ${activation}`;
    }
  });
}
async function resolvePerAgentStatus(options) {
  const env = envValue(options);
  const candidates = activePresetCandidatesList(options);
  const warnings = [];
  if (options.v2Mode) {
    const configuration = readV2ModelConfiguration({ candidates, env });
    warnings.push(...configuration.warnings);
    const agents2 = KNOWN_AGENTS.map((agent) => {
      const override = configuration.overrides[agent];
      let vision;
      if (override?.model) {
        try {
          vision = hasVision(override.model);
        } catch {
          vision = void 0;
        }
      }
      return {
        agent,
        model: override?.model,
        effort: override?.variant,
        origin: override ? "override" : "none",
        vision
      };
    });
    return {
      presetName: null,
      presetSource: null,
      legacyPresetMarker: configuration.legacyPresetMarker,
      agents: agents2,
      warnings
    };
  }
  const logger = {
    warn: (m) => warnings.push(m),
    log: () => {
    }
  };
  let resolved = null;
  try {
    resolved = resolveActivePreset({ env, candidates, logger });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    warnings.push(msg);
    resolved = null;
  }
  const agents = [];
  for (const agent of KNOWN_AGENTS) {
    const key = agent;
    let model;
    let effort;
    let origin = "none";
    let vision;
    if (resolved) {
      const merged = resolved.agents?.[key];
      if (merged?.model) {
        model = merged.model;
        effort = merged.reasoning_effort ?? merged.variant;
        const fileOverrides = resolved.overrides?.agents;
        if (resolved.source === "file" && fileOverrides && Object.hasOwn(fileOverrides, key)) {
          origin = "override";
        } else if (resolved.source === "env") {
          origin = "env";
        } else {
          origin = "preset";
        }
        try {
          if (model) vision = hasVision(model);
        } catch {
          vision = void 0;
        }
      } else {
        origin = "none";
      }
    } else {
      origin = "none";
    }
    agents.push({ agent: key, model, effort, origin, vision });
  }
  return {
    presetName: resolved?.name ?? null,
    presetSource: resolved?.source ?? null,
    legacyPresetMarker: null,
    agents,
    warnings
  };
}
async function renderStatus(options) {
  const { presetName, presetSource, legacyPresetMarker, agents, warnings } = await resolvePerAgentStatus(options);
  const lines = [];
  lines.push(
    options.v2Mode ? "Pantheon model configuration per-agent (configured values only; not a readout of the model serving a completion):" : "Pantheon model configuration per-agent (restart OpenCode after changes):"
  );
  if (options.v2Mode) {
    lines.push("V2 manual override scope: project only; global overrides are not read or applied.");
    if (legacyPresetMarker) {
      const markerSource = legacyPresetMarker.source === "env" ? "PANTHEON_MODEL_PRESET" : "active-preset.json";
      lines.push(
        `Legacy preset marker present in ${markerSource} \u2014 ignored in V2; static presets are retired.`
      );
    } else {
      lines.push("Legacy preset marker: none (static presets are retired and ignored in V2).");
    }
    lines.push("Host default remains unchanged when no manual override is set.");
    lines.push(
      "Manual project-scoped per-agent overrides are read by the V2 agent transform on the next OpenCode configuration load; the current session is unchanged."
    );
  } else if (presetName) {
    const originLabel = presetSource === "env" ? "env" : presetSource === "file" ? "preset" : presetSource;
    lines.push(`active preset: ${presetName} (${presetSource ?? "unknown"})`);
    void originLabel;
  } else {
    lines.push("active preset: none");
  }
  lines.push(`agents: ${KNOWN_AGENTS.length} canonical`);
  for (const a of agents) {
    const modelStr = a.model ?? "not configured";
    const effortStr = a.effort ?? "none";
    const visionStr = a.vision === void 0 ? "unknown" : a.vision ? "vision" : "text-only";
    lines.push(`${a.agent}: ${modelStr} (origin: ${a.origin}, effort: ${effortStr}, ${visionStr})`);
  }
  for (const w of warnings) {
    if (/api[_-]?key/i.test(w) && w.length > 80) continue;
    lines.push(`warning: ${w}`);
  }
  return lines.join("\n");
}
function buildWizardQuestions() {
  return [
    {
      header: "Agent",
      question: "Choose the agent to configure (one of the 14 canonical agents)",
      options: KNOWN_AGENTS.map((a) => ({ label: a, description: `Agent ${a}` })),
      multiSelect: false
    },
    {
      header: "Model",
      question: "Enter model in provider/model-id format (e.g. openai/gpt-5.6 or opencode-go/kimi-k2.7-code)",
      kind: "text"
    },
    {
      header: "Effort",
      question: "Choose reasoning effort",
      options: [
        { label: "low", description: "Low latency, concise responses" },
        { label: "medium", description: "Balanced cost and quality" },
        { label: "high", description: "Maximum reasoning and quality" }
      ],
      multiSelect: false
    },
    {
      header: "Scope",
      question: "Where should the override be saved?",
      options: [
        {
          label: "project",
          description: "./.pantheon/active-preset.json (project scope, safe)"
        },
        {
          label: "global",
          description: "~/.config/opencode/.pantheon/active-preset.json (global)"
        }
      ],
      multiSelect: false
    }
  ];
}
async function promptViaReadline(questions, rl) {
  const answers = {};
  const agentQ = questions[0];
  const modelQ = questions[1];
  const effortQ = questions[2];
  const scopeQ = questions[3];
  if (!agentQ || !modelQ || !effortQ || !scopeQ) {
    throw new ModelCommandError("wizard requires agent, model, effort, and scope questions");
  }
  const agentPrompt = `${agentQ.question} [${KNOWN_AGENTS.join("/")}] : `;
  const agentAns = (await rl.question(agentPrompt)).trim().toLowerCase();
  answers.agent = agentAns || KNOWN_AGENTS[0];
  const modelAns = (await rl.question(`${modelQ.question} : `)).trim();
  answers.model = modelAns;
  const effortAns = (await rl.question(`${effortQ.question} [low/medium/high] : `)).trim().toLowerCase();
  answers.effort = effortAns || "medium";
  const scopeAns = (await rl.question(`${scopeQ.question} [project/global] : `)).trim().toLowerCase();
  answers.scope = scopeAns || "project";
  return answers;
}
async function runWizard(options) {
  const questions = buildWizardQuestions();
  let answers;
  if (typeof options.ask === "function") {
    try {
      answers = await options.ask(questions);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `pantheon_model wizard canceled: ${msg}`;
    }
  } else if (options.rl) {
    answers = await promptViaReadline(questions, options.rl);
  } else {
    const { createInterface } = await import("node:readline/promises");
    const rli = createInterface({ input: process.stdin, output: process.stdout });
    try {
      answers = await promptViaReadline(questions, rli);
    } finally {
      rli.close();
    }
  }
  const agent = typeof answers.agent === "string" ? answers.agent.trim() : "";
  const model = typeof answers.model === "string" ? answers.model.trim() : "";
  const effort = typeof answers.effort === "string" ? answers.effort.trim().toLowerCase() : "";
  const scopeRaw = typeof answers.scope === "string" ? answers.scope.trim().toLowerCase() : "project";
  const scope = scopeRaw === "global" ? "global" : "project";
  if (!agent) return "pantheon_model wizard failed: agent is required";
  if (!model) return "pantheon_model wizard failed: model is required";
  const wizardArgs = {
    action: "set",
    agent,
    model,
    scope
  };
  if (effort === "low" || effort === "medium" || effort === "high") {
    wizardArgs.effort = effort;
  }
  if (scope === "global") {
    wizardArgs.confirm = true;
    wizardArgs.authorize_global = true;
  }
  try {
    return await updateActivePreset(options, wizardArgs, "set", scope);
  } catch (error) {
    if (error instanceof ModelCommandError) return `pantheon_model wizard failed: ${error.message}`;
    options.logger?.warn?.("pantheon_model wizard failed");
    return "pantheon_model wizard failed: operation could not be completed; file preserved when possible";
  }
}
function createModelCommand(options = {}) {
  const args = options.v2Mode ? {
    ...modelArgs,
    action: modelArgs.action.describe("Operation: status/show, set, or reset.")
  } : modelArgs;
  return {
    pantheon_model: {
      description: options.v2Mode ? "Show, set, or reset explicit per-agent project-scoped model overrides in active-preset.json. Global overrides are not read or written in V2; future support requires separate explicit authorization. V2 ignores static preset names and PANTHEON_MODEL_PRESET; no wizard or implicit model selection. Status reports project-scoped configured values only and never writes .env or top-level model/small_model." : "Show, set, or reset per-agent model overrides in active-preset.json (project or global). Overrides win over preset; env preset wins over file. Never writes .env or top-level model/small_model.",
      args,
      execute: async (args2, _ctx) => {
        try {
          const hasAction = args2.action !== void 0;
          const hasAgentModelEffort = args2.agent !== void 0 || args2.model !== void 0 || args2.effort !== void 0;
          if (!hasAction && !hasAgentModelEffort) {
            if (options.v2Mode) return await renderStatus(options);
            return await runWizard(options);
          }
          const action = args2.action ?? (hasAgentModelEffort ? "set" : "status");
          if (action === "status" || action === "show") return await renderStatus(options);
          const scope = args2.scope ?? "project";
          if (scope !== "project" && scope !== "global") {
            throw new ModelCommandError("scope must be project or global");
          }
          if (action === "set") {
            return await updateActivePreset(options, args2, "set", scope);
          }
          if (action === "reset") {
            return await updateActivePreset(options, args2, "reset", scope);
          }
          return `pantheon_model failed: unknown action "${action}"`;
        } catch (error) {
          if (error instanceof ModelCommandError) return `pantheon_model failed: ${error.message}`;
          options.logger?.warn?.("pantheon_model operation failed");
          return "pantheon_model failed: operation could not be completed; file preserved when possible";
        }
      }
    }
  };
}

// scripts/skill-search.mjs
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
var FIND_TIMEOUT_MS = 15e3;
var DEFAULT_LIMIT = 5;
var ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
var SKILL_LINE = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+)\s+([\d.,]+)\s*([KM]?)\s+installs$/;
var URL_LINE = /^└?\s*(https:\/\/skills\.sh\/\S+)$/;
function nameMatchScore(name, tokens) {
  const lower = String(name).toLowerCase();
  const unique = [...new Set(tokens)];
  return unique.reduce((score, token) => score + (lower.includes(token) ? 1 : 0), 0);
}
function parseInstallCount(digits, suffix) {
  const base = Number(String(digits).replaceAll(",", ""));
  if (!Number.isFinite(base)) return null;
  if (suffix === "K") return Math.round(base * 1e3);
  if (suffix === "M") return Math.round(base * 1e6);
  return Math.round(base);
}
function stripAnsi(text2) {
  return String(text2).replace(ANSI_SGR, "");
}
function parseSkillSearchOutput(raw, { limit = DEFAULT_LIMIT } = {}) {
  const lines = stripAnsi(raw).split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const found = [];
  for (const line of lines) {
    const skillMatch = line.match(SKILL_LINE);
    if (skillMatch !== null) {
      if (found.length >= limit) continue;
      found.push({
        skill: skillMatch[1],
        installs: parseInstallCount(skillMatch[2], skillMatch[3]),
        url: void 0
      });
      continue;
    }
    const urlMatch = line.match(URL_LINE);
    if (urlMatch !== null && found.length > 0) {
      const last = found[found.length - 1];
      if (last.url === void 0) last.url = urlMatch[1];
    }
  }
  return found;
}
function searchSkills(query, { limit = DEFAULT_LIMIT, owner, spawn: spawn2 = spawnSync } = {}) {
  const args = ["skills", "find", String(query)];
  if (owner !== void 0) args.push("--owner", String(owner));
  const result = spawn2("npx", args, {
    encoding: "utf8",
    timeout: FIND_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error !== void 0) {
    return { ok: false, error: `skills search failed to start: ${result.error.message}` };
  }
  const raw = `${result.stdout ?? ""}`;
  if (result.status !== 0 && raw.trim() === "") {
    return { ok: false, error: `skills search exited ${result.status}` };
  }
  const entries = parseSkillSearchOutput(raw, { limit });
  if (entries.length === 0) {
    const retry = spawn2("npx", args, {
      encoding: "utf8",
      timeout: FIND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const retryRaw = `${retry.stdout ?? ""}`;
    const retried = parseSkillSearchOutput(retryRaw, { limit });
    if (retried.length > 0)
      return { ok: true, entries: retried, raw: retryRaw, emptyIsAmbiguous: false };
    return { ok: true, entries: [], raw, emptyIsAmbiguous: true };
  }
  return { ok: true, entries, raw, emptyIsAmbiguous: false };
}
var GITHUB_TIMEOUT_MS = 1e4;
var ANTHROPIC_SKILLS_REPO = "anthropics/skills";
function searchAnthropicCatalog(query, { limit = DEFAULT_LIMIT, spawn: spawn2 = spawnSync } = {}) {
  const result = spawn2(
    "gh",
    ["api", `repos/${ANTHROPIC_SKILLS_REPO}/contents/skills`, "--jq", ".[].name"],
    { encoding: "utf8", timeout: GITHUB_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.error !== void 0 || result.status !== 0) {
    return { ok: false, error: "anthropic catalog lookup failed (gh api)" };
  }
  const tokens = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const names = String(result.stdout ?? "").split("\n").map((name) => name.trim()).filter((name) => name.length > 0);
  const scored = names.map((name) => ({
    name,
    score: nameMatchScore(name, tokens)
  }));
  const matched = scored.filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score).map((entry) => entry.name);
  return {
    ok: true,
    entries: matched.slice(0, limit).map((name) => ({
      skill: `${ANTHROPIC_SKILLS_REPO}@${name}`,
      installs: null,
      url: `https://github.com/${ANTHROPIC_SKILLS_REPO}/tree/main/skills/${name}`,
      source: "anthropic"
    }))
  };
}
function searchGithubSkills(query, { limit = DEFAULT_LIMIT, spawn: spawn2 = spawnSync } = {}) {
  const terms = String(query).split(/\s+/).filter((term) => term.length > 1).slice(0, 3).map((term) => encodeURIComponent(term)).join("+");
  if (terms === "") return { ok: true, entries: [] };
  const result = spawn2(
    "gh",
    ["api", `search/code?q=filename:SKILL.md+${terms}&per_page=${Math.min(limit, 10)}`],
    { encoding: "utf8", timeout: GITHUB_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.error !== void 0 || result.status !== 0) {
    return { ok: false, error: "github code search failed (gh api)" };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? "{}"));
  } catch {
    return { ok: false, error: "github code search returned non-JSON output" };
  }
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return {
    ok: true,
    entries: items.slice(0, limit).map((item) => {
      const repo = String(item?.repository?.full_name ?? "unknown/repo");
      const path5 = String(item?.path ?? "SKILL.md");
      const name = path5.split("/")[Math.max(0, path5.split("/").length - 2)] ?? "skill";
      return {
        skill: `${repo}@${name}`,
        installs: null,
        url: `https://github.com/${repo}/blob/main/${path5}`,
        source: "github"
      };
    })
  };
}
var SKILL_SEARCH_SOURCES = Object.freeze(["anthropic", "skills-sh", "github"]);
var SEARCH_CACHE = /* @__PURE__ */ new Map();
var CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
function searchSkillSources(query, { limit = DEFAULT_LIMIT, owner, sources = SKILL_SEARCH_SOURCES, spawn: spawn2 = spawnSync } = {}) {
  const cacheKey = JSON.stringify({
    query: String(query).toLowerCase().trim(),
    limit,
    owner,
    sources
  });
  if (spawn2 === spawnSync && SEARCH_CACHE.has(cacheKey)) {
    const cached = SEARCH_CACHE.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.result;
    }
  }
  const perTier = Math.max(1, Math.ceil(limit / sources.length));
  const out = [];
  const failures = [];
  for (const source of sources) {
    const result = source === "anthropic" ? searchAnthropicCatalog(query, { limit: perTier, spawn: spawn2 }) : source === "skills-sh" ? searchSkills(query, { limit: perTier, owner, spawn: spawn2 }) : source === "github" ? searchGithubSkills(query, { limit: perTier, spawn: spawn2 }) : { ok: false, error: `unknown source: ${source}` };
    if (result.ok) out.push(...result.entries.map((entry) => ({ ...entry, source })));
    else failures.push(`${source}: ${result.error}`);
  }
  const tokens = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const tierWeight = (source) => SKILL_SEARCH_SOURCES.indexOf(source);
  const installsWeight = (entry) => typeof entry.installs === "number" ? -entry.installs : Number.MAX_SAFE_INTEGER;
  const skillName = (entry) => String(entry.skill).split("@").at(-1) ?? "";
  out.sort((left, right) => {
    const lScore = nameMatchScore(skillName(left), tokens);
    const rScore = nameMatchScore(skillName(right), tokens);
    if (lScore !== rScore) return rScore - lScore;
    const tier = tierWeight(left.source) - tierWeight(right.source);
    if (tier !== 0) return tier;
    return installsWeight(left) - installsWeight(right);
  });
  const finalResult = {
    ok: failures.length < sources.length,
    entries: out.slice(0, limit),
    failures
  };
  if (spawn2 === spawnSync && finalResult.ok) {
    SEARCH_CACHE.set(cacheKey, { timestamp: Date.now(), result: finalResult });
  }
  return finalResult;
}
function main(args = process.argv.slice(2)) {
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : void 0;
  };
  const query = args.find((a) => !a.startsWith("--"));
  if (query === void 0) {
    console.error(
      'usage: node scripts/skill-search.mjs "<query>" [--limit 5(total, merged across tiers)] [--sources anthropic,skills-sh,github] [--owner <owner>] [--raw]'
    );
    process.exit(1);
  }
  const sourcesArg = get("--sources");
  const sources = sourcesArg === void 0 ? SKILL_SEARCH_SOURCES : sourcesArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const result = searchSkillSources(query, {
    limit: Number(get("--limit") ?? DEFAULT_LIMIT),
    owner: get("--owner"),
    sources
  });
  if (args.includes("--raw")) {
    const skillsSh = result.entries.filter((e) => e.source === "skills-sh");
    console.log(JSON.stringify(skillsSh, null, 1));
    return;
  }
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(`warning: ${failure}`);
  }
  if (result.entries.length === 0 && result.failures.length === sources.length) {
    console.error("all sources failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.entries, null, 1));
}
var invokedDirectly = process.argv[1] !== void 0 && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();

// src/pantheon/skill-search-tool.ts
var TOOL_DESCRIPTION3 = "Advisory discovery tool for skills. Queries installed Pantheon skills and external registries (Anthropic catalog, skills.sh, GitHub). Returns matched skill IDs, descriptions, install counts, and provenance tiers. Zeus uses this to recommend project-scoped skills (.agents/skills/) before proactively prompting the user via the question tool.";
var SKILL_SEARCH_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: 'Search terms to discover skills (e.g. "docker", "fastapi", "testing")'
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      default: 5,
      description: "Maximum number of results to return across all sources (default 5)"
    },
    sources: {
      type: "array",
      items: {
        type: "string",
        enum: ["installed", "anthropic", "skills-sh", "github"]
      },
      description: 'Sources to search. Defaults to ["installed", "anthropic", "skills-sh"]. Pass ["installed"] for local-only search without network egress.'
    }
  }
};
function executeSkillSearch(input) {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length === 0) {
    return { ok: false, query: "", count: 0, results: [], failures: ["query must be non-empty"] };
  }
  const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? Math.max(1, Math.min(20, Math.floor(input.limit))) : 5;
  const rawSources = Array.isArray(input.sources) ? input.sources : void 0;
  const sources = new Set(
    rawSources?.filter((s) => typeof s === "string") ?? [
      "installed",
      "anthropic",
      "skills-sh"
    ]
  );
  const results = [];
  const failures = [];
  if (sources.has("installed")) {
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    if (tokens.length > 0) {
      for (const entry of PANTHEON_SKILL_CATALOG) {
        const idLower = entry.id.toLowerCase();
        const descLower = entry.description.toLowerCase();
        const matchScore = tokens.reduce((score, t) => {
          const stem = t.length > 4 ? t.slice(0, 4) : t;
          return score + (idLower.includes(t) || descLower.includes(t) || idLower.includes(stem) || descLower.includes(stem) ? 1 : 0);
        }, 0);
        if (matchScore > 0) {
          results.push({
            skill: entry.id,
            description: entry.description,
            source: "installed",
            installed: true,
            installs: null,
            installCommand: null
          });
        }
      }
    }
  }
  const externalSources = ["anthropic", "skills-sh", "github"].filter((s) => sources.has(s));
  if (externalSources.length > 0 && results.length < limit) {
    try {
      const extLimit = limit - results.length;
      const extRes = searchSkillSources(query, {
        limit: extLimit,
        sources: externalSources
      });
      if (Array.isArray(extRes.failures)) {
        failures.push(...extRes.failures);
      }
      if (Array.isArray(extRes.entries)) {
        for (const entry of extRes.entries) {
          results.push({
            skill: entry.skill,
            description: entry.skill,
            source: entry.source,
            installed: false,
            installs: entry.installs ?? null,
            url: entry.url,
            installCommand: `npx skills add ${entry.skill} -a opencode -y`
          });
        }
      }
    } catch (err) {
      failures.push(
        `external skill search error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const bounded = results.slice(0, limit);
  return {
    ok: true,
    query,
    count: bounded.length,
    results: bounded,
    failures
  };
}
function createV2SkillSearchDefinition() {
  return {
    name: "pantheon_skill_search",
    description: TOOL_DESCRIPTION3,
    input: SKILL_SEARCH_INPUT_SCHEMA,
    output: {},
    execute: async (input) => ({
      output: JSON.stringify(executeSkillSearch(input), null, 2)
    })
  };
}

// src/pantheon/tools.ts
function toolContext(context) {
  const ctx = context ?? {};
  return {
    sessionID: typeof ctx.sessionID === "string" ? ctx.sessionID : "v2-unknown",
    // Spread rather than assign `undefined`: the project compiles with
    // exactOptionalPropertyTypes, so an explicit undefined is not assignable.
    ...typeof ctx.directory === "string" ? { directory: ctx.directory } : {},
    ...typeof ctx.worktree === "string" ? { worktree: ctx.worktree } : {},
    ...typeof ctx.agent === "string" ? { agent: ctx.agent } : {}
  };
}
function errorText(prefix, err) {
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}
var HASHLINE_EDIT_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["file", "edits"],
  properties: {
    file: {
      type: "string",
      minLength: 1,
      description: "File to edit. Absolute, or relative to the worktree."
    },
    edits: {
      type: "array",
      minItems: 1,
      description: "Edits to apply. All refs are validated against the ORIGINAL file before anything is written.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "ref"],
        properties: {
          op: { type: "string", enum: ["replace", "append", "prepend", "delete"] },
          ref: {
            type: "string",
            minLength: 1,
            description: 'Anchor ref "LINE#TAG" against the ORIGINAL snapshot.'
          },
          endRef: {
            type: "string",
            minLength: 1,
            description: 'Optional range end for replace/delete, as "LINE#TAG".'
          },
          lines: {
            type: "array",
            items: { type: "string" },
            description: "Replacement lines (replace only)."
          },
          content: {
            type: "string",
            description: "Text to insert (append/prepend); split on newlines."
          }
        }
      }
    }
  }
};
var HASHLINE_OPS = /* @__PURE__ */ new Set(["replace", "append", "prepend", "delete"]);
function isRecord21(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function coerceHashlineEditArgs(input) {
  const file = input.file;
  if (typeof file !== "string" || file.length === 0) {
    return { ok: false, error: 'hashline_edit: "file" must be a non-empty string' };
  }
  const rawEdits = input.edits;
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return { ok: false, error: 'hashline_edit: "edits" must be a non-empty array' };
  }
  const edits = [];
  for (const [i, raw] of rawEdits.entries()) {
    if (!isRecord21(raw)) {
      return { ok: false, error: `hashline_edit: edit (index ${i}) must be an object` };
    }
    const op = raw.op;
    if (typeof op !== "string" || !HASHLINE_OPS.has(op)) {
      return {
        ok: false,
        error: `hashline_edit: edit (index ${i}) "op" must be one of replace, append, prepend, delete`
      };
    }
    const ref = raw.ref;
    if (typeof ref !== "string" || ref.length === 0) {
      return {
        ok: false,
        error: `hashline_edit: edit (index ${i}) "ref" must be a non-empty string`
      };
    }
    let lines;
    if (raw.lines !== void 0) {
      if (!Array.isArray(raw.lines) || raw.lines.some((l) => typeof l !== "string")) {
        return {
          ok: false,
          error: `hashline_edit: edit (index ${i}) "lines" must be a string array`
        };
      }
      lines = raw.lines;
    }
    if (raw.content !== void 0 && typeof raw.content !== "string") {
      return { ok: false, error: `hashline_edit: edit (index ${i}) "content" must be a string` };
    }
    if (raw.endRef !== void 0 && typeof raw.endRef !== "string") {
      return { ok: false, error: `hashline_edit: edit (index ${i}) "endRef" must be a string` };
    }
    edits.push({
      op,
      ref,
      // Conditional spread: exactOptionalPropertyTypes forbids `prop: undefined`.
      ...typeof raw.endRef === "string" ? { endRef: raw.endRef } : {},
      ...lines === void 0 ? {} : { lines },
      ...typeof raw.content === "string" ? { content: raw.content } : {}
    });
  }
  return { ok: true, args: { file, edits } };
}
var hashlineEdit = createHashlineEditTool();
async function executeHashlineEdit(input, context) {
  const coerced = coerceHashlineEditArgs(input);
  if (!coerced.ok) return { output: coerced.error };
  let result;
  try {
    result = await hashlineEdit.execute(coerced.args, toolContext(context));
  } catch (err) {
    return { output: errorText("hashline_edit failed", err) };
  }
  if (typeof result === "string") return { output: result };
  return {
    output: result.output,
    ...result.title === void 0 ? {} : { title: result.title },
    ...result.metadata === void 0 ? {} : { metadata: result.metadata }
  };
}
var COST_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    days: {
      type: "integer",
      minimum: 1,
      maximum: 365,
      description: "Reporting window in days (default 7)."
    },
    session: {
      type: "string",
      minLength: 1,
      description: "Root session id. The report is scoped to that session plus every descendant session in its subtree."
    },
    refreshPricing: {
      type: "boolean",
      description: "Await a models.dev price refresh (bounded by a short timeout) instead of using the cached catalog. This is the only path that waits on the network."
    }
  }
};
function coerceDays(value) {
  if (value === void 0) return { ok: true };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 365) {
    return { ok: false, error: 'pantheon_cost: "days" must be an integer between 1 and 365' };
  }
  return { ok: true, days: value };
}
function coerceSession(value) {
  if (value === void 0) return { ok: true };
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: 'pantheon_cost: "session" must be a non-empty string' };
  }
  return { ok: true, session: value };
}
function coerceRefreshPricing(value) {
  if (value === void 0) return { ok: true };
  if (typeof value !== "boolean") {
    return { ok: false, error: 'pantheon_cost: "refreshPricing" must be a boolean' };
  }
  return { ok: true, refreshPricing: value };
}
var costCommand = createCostCommand();
async function executeCost(input, context) {
  const days = coerceDays(input.days);
  if (!days.ok) return { output: days.error };
  const session = coerceSession(input.session);
  if (!session.ok) return { output: session.error };
  const refreshPricing = coerceRefreshPricing(input.refreshPricing);
  if (!refreshPricing.ok) return { output: refreshPricing.error };
  const output = await costCommand.pantheon_cost.execute(
    {
      ...days.days === void 0 ? {} : { days: days.days },
      ...session.session === void 0 ? {} : { session: session.session },
      ...refreshPricing.refreshPricing === void 0 ? {} : { refreshPricing: refreshPricing.refreshPricing }
    },
    toolContext(context)
  );
  return { output };
}
var MODEL_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["status", "show", "set", "reset"],
      description: "Operation to perform. Defaults to status when agent/model are absent."
    },
    agent: { type: "string", description: "Agent name (one of the 14 canonical agents)." },
    model: { type: "string", description: "Model in provider/model-id format; used by set." },
    effort: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Reasoning effort (variant), clamped to model capability."
    },
    scope: {
      type: "string",
      enum: ["project"],
      description: "Project scope only; global overrides are not supported in V2."
    }
  }
};
var modelCommand = createModelCommand({ v2Mode: true });
async function executeModel(input, context) {
  if (input.scope !== void 0 && input.scope !== "project") {
    return { output: "Error: V2 pantheon_model is project-only; global scope is not supported." };
  }
  if (Object.hasOwn(input, "confirm") || Object.hasOwn(input, "authorize_global")) {
    return {
      output: "Error: V2 pantheon_model does not accept authorization flags; global authorization is not supported by this tool."
    };
  }
  const output = await modelCommand.pantheon_model.execute(
    input,
    toolContext(context)
  );
  return { output };
}
var TODOWRITE_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["todos"],
  properties: {
    todos: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["content", "status"],
        properties: {
          content: { type: "string", minLength: 1, maxLength: 500 },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] }
        }
      }
    }
  }
};
var latestSessionTodos = [];
var todowriteTool = {
  name: "todowrite",
  description: "Write the session task checklist (full replace). The TUI todo panel renders the newest list; mark each item in_progress/completed as soon as its state changes.",
  input: TODOWRITE_INPUT,
  output: {},
  execute: async (input) => {
    const rawTodos = input.todos;
    const todos = Array.isArray(rawTodos) ? rawTodos : [];
    latestSessionTodos = todos;
    return { ok: true, todos, output: JSON.stringify({ todos }) };
  }
};
var TODOREAD_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      description: "Optional filter by task status (pending, in_progress, completed, cancelled)"
    }
  }
};
var todoreadTool = {
  name: "todoread",
  description: "Read the active session task checklist. Returns the newest list of tasks written via todowrite.",
  input: TODOREAD_INPUT,
  output: {},
  execute: async (input) => {
    const statusFilter = input?.status;
    let todos = latestSessionTodos;
    if (typeof statusFilter === "string" && statusFilter.trim() !== "") {
      todos = todos.filter(
        (t) => typeof t === "object" && t !== null && t.status === statusFilter
      );
    }
    return {
      ok: true,
      todos,
      output: JSON.stringify({ todos })
    };
  }
};
var execAsync = promisify(exec);
var SHELL_INPUT = {
  type: "object",
  required: ["command"],
  properties: {
    command: {
      type: "string",
      description: "The shell command to execute in the workspace directory"
    }
  }
};
var shellTool = {
  name: "shell",
  description: "Execute a shell command in the workspace directory. Alias for bash execution.",
  input: SHELL_INPUT,
  output: {},
  execute: async (input, context) => {
    const raw = input ?? {};
    const command = String(raw.command ?? raw.cmd ?? "");
    if (!command.trim()) {
      return { output: "", ok: false, error: "Command cannot be empty" };
    }
    const toolCtx = toolContext(context);
    const cwd = toolCtx.directory || process.cwd();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash"
      });
      const output = [stdout, stderr].filter(Boolean).join("\n");
      return { output, ok: true };
    } catch (err) {
      const execError = err;
      const output = [execError.stdout, execError.stderr, execError.message].filter(Boolean).join("\n");
      return { output, ok: false, error: output };
    }
  }
};
function createV2ToolDefinitions(visionRuntime, shadow = {}, jevRuntime) {
  const definitions = [
    {
      name: "hashline_edit",
      description: "Edit a file anchored by hashline refs (LINE#TAG) instead of raw line numbers. Ops: replace (ref..endRef or single ref \u2192 lines), append/prepend (anchor ref \u2192 content), delete (ref..endRef). ALL refs must be validated against the ORIGINAL file before anything is written; on mismatch the tool returns an error with a re-tagged excerpt and a Did-you-mean suggestion, and nothing is modified.",
      input: HASHLINE_EDIT_INPUT,
      output: {},
      execute: executeHashlineEdit
    },
    {
      name: "pantheon_cost",
      description: "Report token usage and USD cost by agent and phase, by model, and by session, over the last N days from opencode.db (read-only). Costs come from the models.dev catalog cached on disk: a call reads that cache and never waits on the network unless refreshPricing is set, a stale cache is refreshed in the background and the report says so, and an unpriced model reads \u2014 and is excluded from the totals, which then say partial. Pass session=<root session id> to aggregate that session plus its descendant sessions. Phase may be unknown on V2; costs are catalog list prices, not an invoice.",
      input: COST_INPUT,
      output: {},
      execute: executeCost
    },
    {
      name: "pantheon_model",
      description: 'Show, set, or reset explicit per-agent project-scoped model overrides in active-preset.json. V2 ignores static preset names and PANTHEON_MODEL_PRESET; no wizard or implicit model selection. Global overrides are not read or written in V2; future global support requires separate explicit authorization. Pass action="status" to read project-scoped overrides. Never writes .env or top-level model/small_model.',
      input: MODEL_INPUT,
      output: {},
      execute: executeModel
    }
  ];
  definitions.push(
    createV2LocalDecisionDefinition({
      ...shadow.complexitySink === void 0 ? {} : { sink: shadow.complexitySink }
    })
  );
  definitions.push(todowriteTool);
  definitions.push(todoreadTool);
  definitions.push(shellTool);
  definitions.push(createV2SkillSearchDefinition());
  definitions.push(createDeepworkTool());
  if (visionRuntime) definitions.push(createV2VisionTool(visionRuntime));
  if (jevRuntime) definitions.push(createV2JevDecisionDefinition(jevRuntime));
  return definitions;
}

// src/pantheon/unsupported.mjs
var UNSUPPORTED_FEATURE_SEED = Object.freeze([
  "legacy-hooks",
  // `ctx.catalog` is the one domain a live 2.0.22 host does NOT have: it is
  // absent from `Object.keys(ctx)`, measured in
  // tests/canary/plugin-tool-canary.test.mjs. (`catalog` IS in the 1.18.33
  // SDK's PluginContext, so the SDK types it and the host does not provide it.)
  "catalog-transform",
  // Adapter support, NOT host availability: 2.0.22 exposes ctx.integration and
  // ctx.skill with callable transforms, and Pantheon deliberately registers
  // neither. These entries record what this plugin does not implement.
  "integration-transform",
  // The inspected SkillEditor shape has no `source()` helper — i.e. no
  // `SkillEditor.source()` — for adding a directory source. This is narrower
  // than (and distinct from) ctx.skill's host availability or callable
  // transform, which a live 2.0.22 host does provide.
  "skill-transform",
  // Adapter limitation, not a host gap: the goal loop needs a GoalStore, a
  // GoalLoopClient and a BackgroundJobBoard. V2 has no `client` to build the
  // loop's session calls, and the bridge the V2 entry injects deliberately
  // carries the board and the todo enforcer only, so
  // pantheon_goal_create/get/update stay absent from the V2 surface rather
  // than being registered as non-functional placeholders.
  "goal-tools",
  // CONDITIONAL reduction (issue #265/#267): the V2 entry DOES construct the
  // V1 TodoEnforcer and inject it through the bridge, but only when the host's
  // `session` domain exposes the four methods the enforcer uses (`todo`,
  // `messages`, `children`, `promptAsync`). The measured 2.1.4 domain exposes
  // `hook`/`get`/`list`/`create`/`remove`/`prompt`/`generate`/… and NOT the
  // four, so on that host idle continuation does not run and the enforcer is
  // not constructed — the limitation is announced here instead of being hidden
  // behind a null bridge. V1 reaches those calls through `client.session`.
  "idle-todo-enforcer",
  // Todo preservation across compaction (`todo-preserve.ts`): V1 captures the
  // session's todo list in `experimental.session.compacting`, activates the
  // snapshot on `session.compacted` and rewrites the first post-compaction
  // `todowrite`. V2 has no todo API to capture from, so the snapshot is absent
  // and the first `todowrite` is not rewritten.
  "todo-restore",
  // The `<tool_ceiling>` block fed by `handleToolCeilingEvent` on V1
  // (`message.updated`). V2's event route handles session.* events only, so
  // there is no producer for the host-reported remaining context budget and
  // the block is not injected into the compaction context.
  "tool-ceiling",
  // BackgroundJobBoard bookkeeping: the shared board INSTANCE is reachable on
  // V2 through the injected bridge, but the transitions that make it useful
  // (onTerminal audit line, terminal reports on session.idle, dispatch mirror
  // for native background tasks) are driven from V1's event hook and from
  // pantheon-hooks.ts, neither of which a V2-only install loads. The board is
  // present; nothing on V2 writes to it.
  "board-transitions"
]);

// src/plugin.ts
var V2_UNSUPPORTED_FEATURES = [...UNSUPPORTED_FEATURE_SEED];
var POLICY_MARKER = "<!-- pantheon-policy -->";
var POLICY = `${POLICY_MARKER}
Follow Pantheon routing policy: delegate implementation work to the named specialist and do not claim work was performed without verification.`;
function isTextPart(entry) {
  return typeof entry === "object" && entry !== null && typeof entry.text === "string";
}
function systemEntryText(entry) {
  try {
    if (typeof entry === "string") return entry;
    if (isTextPart(entry)) return entry.text;
    return null;
  } catch {
    return null;
  }
}
function hasPolicyMarker(arr) {
  try {
    return arr.some((s) => {
      const t = systemEntryText(s);
      return t?.includes(POLICY_MARKER) ?? false;
    });
  } catch {
    return false;
  }
}
function normalizeSystemToParts(system) {
  if (typeof system === "string") {
    return [{ type: "text", text: system }];
  }
  if (!Array.isArray(system)) return null;
  for (let i = 0; i < system.length; i++) {
    const entry = system[i];
    if (typeof entry === "string") {
      system[i] = { type: "text", text: entry };
    }
  }
  return system;
}
var compactionChannelWarned = false;
var idleEnforcerFailureLogged = false;
function appendSystemBlocks(target, blocks) {
  if (target == null || blocks.length === 0) return false;
  const normalized = normalizeSystemToParts(target.system);
  if (normalized == null) return false;
  if (typeof target.system === "string") target.system = normalized;
  for (const block of blocks) normalized.push({ type: "text", text: block });
  return true;
}
function markUnsupported(feature) {
  if (!V2_UNSUPPORTED_FEATURES.includes(feature)) {
    V2_UNSUPPORTED_FEATURES.push(feature);
  }
}
function hostDomains(context) {
  return context;
}
var idleTodoEnforcer;
var runtimeOverrides = {};
var runtimeOverridesLoaded = false;
function loadRuntimeOverrides() {
  if (runtimeOverridesLoaded) return;
  runtimeOverridesLoaded = true;
  try {
    const read = (path6) => {
      const fs = __require("node:fs");
      try {
        return fs.readFileSync(path6, "utf8");
      } catch {
        return void 0;
      }
    };
    const path5 = __require("node:path");
    const globalRaw = read(path5.join(resolveGlobalOverrideDir(), "pantheon-overrides.json"));
    const projectRaw = read(path5.join(process.cwd(), ".pantheon", "overrides.json"));
    runtimeOverrides = mergeOverrides(globalRaw, projectRaw).entries;
  } catch {
    runtimeOverrides = {};
  }
}
function resolveGlobalOverrideDir() {
  const env = process.env.XDG_CONFIG_HOME;
  const base = env?.startsWith("/") ? env : path4.join(process.env.HOME ?? "", ".config");
  return path4.join(base, "opencode");
}
function gateDisabled(behaviorId) {
  return runtimeOverrides[behaviorId]?.action === "disable";
}
var V2_TODO_CLIENT_METHODS = ["todo", "messages", "children", "promptAsync"];
function createV2TodoEnforcerClient(session) {
  if (session === void 0) return void 0;
  const methods = session;
  for (const method of V2_TODO_CLIENT_METHODS) {
    if (typeof methods[method] !== "function") return void 0;
  }
  const todo = methods.todo;
  const messages = methods.messages;
  const children = methods.children;
  const promptAsync = methods.promptAsync;
  return {
    session: {
      todo: (input) => todo.call(session, input),
      messages: (input) => messages.call(session, input),
      children: (input) => children.call(session, input),
      promptAsync: (input) => promptAsync.call(session, input)
    }
  };
}
function installV2TodoEnforcer(context) {
  const todoClient = createV2TodoEnforcerClient(hostDomains(context).session);
  if (todoClient === void 0) markUnsupported("idle-todo-enforcer");
  const board = getSharedBoard();
  const todoEnforcer = todoClient === void 0 ? void 0 : new TodoEnforcer({
    client: todoClient,
    board,
    options: { ...TODO_ENFORCER_DEFAULTS, enabled: todoEnforcerEnabledFromEnv() }
  });
  idleTodoEnforcer = todoEnforcer;
  return todoEnforcer;
}
function transformAgents(draft) {
  let agents;
  try {
    const maybeList = draft.list;
    if (typeof maybeList !== "function") {
      markUnsupported("agent-transform-list");
      return;
    }
    const result = maybeList.call(draft);
    if (result == null || typeof result[Symbol.iterator] !== "function") {
      markUnsupported("agent-transform-list");
      return;
    }
    agents = result;
  } catch {
    markUnsupported("agent-transform-list");
    return;
  }
  try {
    const modelConfiguration = readV2ModelConfiguration();
    if (modelConfiguration.warnings.length > 0) {
      markUnsupported("agent-model-overrides");
    }
    applyV2ModelOverrides(draft, modelConfiguration.overrides);
  } catch {
    markUnsupported("agent-model-overrides");
  }
  try {
    for (const agent of agents) {
      draft.update(agent.id, (current) => {
        try {
          const sys = current.system;
          if (typeof sys === "string" && sys.includes(POLICY_MARKER)) {
          } else if (typeof sys === "string" && sys) {
            current.system = `${sys}

${POLICY}`;
          } else if (sys == null || sys === "") {
            current.system = POLICY;
          } else if (typeof sys === "object") {
          } else {
            current.system = POLICY;
          }
        } catch {
        }
        if (agent.id === "zeus") current.mode = "primary";
      });
    }
  } catch {
    markUnsupported("agent-transform");
  }
}
function transformCommands(draft) {
  let commands;
  try {
    const maybeList = draft.list;
    if (typeof maybeList !== "function") {
      markUnsupported("command-transform-list");
      return;
    }
    const result = maybeList.call(draft);
    if (result == null || typeof result[Symbol.iterator] !== "function") {
      markUnsupported("command-transform-list");
      return;
    }
    commands = result;
  } catch {
    markUnsupported("command-transform-list");
    return;
  }
  try {
    for (const command of commands) {
      if (command.name.startsWith("pantheon-")) {
        draft.update(command.name, (current) => {
          current.description ??= "Pantheon orchestration command";
        });
      }
    }
  } catch {
    markUnsupported("command-transform");
  }
}
function transformReferences(draft) {
  draft.add("pantheon-agents", {
    type: "local",
    path: fileURLToPath5(new URL("../AGENTS.md", import.meta.url)),
    description: "Pantheon agent and execution policy"
  });
}
function buildV2JevRuntime(host) {
  const specialistCallers = specialistCallerAllowlist(process.env.PANTHEON_JEV_SPECIALIST_CALLERS);
  const decisionsFn = host.experimental?.generate?.decisions;
  const modelListFn = host.model?.list;
  if (typeof decisionsFn !== "function" || typeof modelListFn !== "function") return void 0;
  const decisionsOwner = host.experimental?.generate;
  const decide = decisionsFn;
  const listModels = modelListFn;
  const skillDomain = host.skill;
  const skillList = skillDomain?.list;
  const permissionAssertFn = host.permission?.assert;
  const permissionAssert = typeof permissionAssertFn === "function" ? (input) => permissionAssertFn.call(host.permission, input) : void 0;
  const j4Sink = createTelemetrySink();
  j4TelemetrySink = j4Sink;
  const j4Mirror = createJTelemetryMirror({ enabled: true });
  return {
    specialistCallers,
    // Every host method is invoked with its owning domain as receiver: the
    // canary records `ctx.model.list()` (bound) succeeding on 2.2.5 while a
    // detached reference threw in the field and surfaced only as
    // CATALOG_UNAVAILABLE. Same discipline as permissionAssert above.
    listModels: () => listModels.call(host.model),
    decide: (request) => decide.call(decisionsOwner, request),
    // Sync-or-async host skill list; absent/throwing falls back to the
    // catalog-only preset inside the tool.
    listSkills: async () => skillList?.call(skillDomain),
    ...permissionAssert === void 0 ? {} : { permissionAssert },
    shadowSink: (record2) => {
      const shadowRecord = { ...record2, mode: "shadow" };
      j4Sink.emit(shadowRecord);
      j4Mirror?.record(shadowRecord);
    }
  };
}
async function registerV2Tools(context, boundedRead, jevRuntime) {
  const host = hostDomains(context);
  const toolCtx = host.tool;
  if (!toolCtx?.transform) {
    return false;
  }
  try {
    const model = host.model;
    const modelListFn = model?.list;
    const visionReady = typeof modelListFn === "function";
    if (!visionReady) markUnsupported("vision-tool");
    const visionRuntime = visionReady ? { model } : void 0;
    const decisionsFn = host.experimental?.generate?.decisions;
    const jevReady = visionReady && typeof decisionsFn === "function";
    if (!jevReady) markUnsupported("jev-decision-tool");
    const runtime = jevRuntime ?? (jevReady ? buildV2JevRuntime(host) : void 0);
    const p3Sink = createTelemetrySink();
    p3TelemetrySink = p3Sink;
    const toolDefs = createV2ToolDefinitions(
      visionRuntime,
      {
        complexitySink: (record2) => {
          p3Sink.emit({ ...record2, mode: "shadow" });
        }
      },
      runtime
    );
    if (boundedRead !== void 0) toolDefs.push(boundedRead);
    const p11Sink = createTelemetrySink();
    p11TelemetrySink = p11Sink;
    await toolCtx.transform((draft) => {
      draft.namespace({ name: "pantheon", description: "Pantheon orchestration tools" });
      for (const def of toolDefs) {
        draft.add({
          name: def.name,
          description: def.description,
          input: def.input,
          // Required by the host contract: without this the tool fails on
          // every call with "Tool result declared output without an output
          // schema". Must stay paired with def.execute resolving to `output`.
          output: def.output,
          execute: def.execute
        });
      }
      try {
        evaluateCatalogPoint(draft, (record2) => {
          p11Sink.emit({ ...record2, mode: "shadow" });
        });
      } catch {
      }
    });
    return true;
  } catch {
    return false;
  }
}
function getP7TelemetrySinkForTests() {
  return p7TelemetrySink;
}
var p7TelemetrySink;
function getP8TelemetrySinkForTests() {
  return p8TelemetrySink;
}
var p8TelemetrySink;
function getPromptSurfaceTelemetrySinkForTests() {
  return promptSurfaceTelemetrySink;
}
var promptSurfaceTelemetrySink;
function getP3TelemetrySinkForTests() {
  return p3TelemetrySink;
}
var p3TelemetrySink;
function getP9TelemetrySinkForTests() {
  return p9TelemetrySink;
}
var p9TelemetrySink;
function getP11TelemetrySinkForTests() {
  return p11TelemetrySink;
}
var p11TelemetrySink;
function getJ1TelemetrySinkForTests() {
  return j1TelemetrySink;
}
var j1TelemetrySink;
function getJ3TelemetrySinkForTests() {
  return j3TelemetrySink;
}
var j3TelemetrySink;
function getJ4TelemetrySinkForTests() {
  return j4TelemetrySink;
}
var j4TelemetrySink;
function subscribeV2Events(context, onTurnEnd) {
  const eventCtx = hostDomains(context).event;
  if (!eventCtx?.subscribe) {
    return void 0;
  }
  const telemetrySink = createTelemetrySink();
  p7TelemetrySink = telemetrySink;
  const loopPoint = createP7LoopPoint({
    enabled: p7LoopEnabledFromEnv(),
    sink: (record2) => {
      telemetrySink.emit({ ...record2, mode: "migration" });
    }
  });
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of eventCtx.subscribe({ signal: controller.signal })) {
        await handleV2SessionEvent(event);
        try {
          loopPoint.observe(event);
        } catch {
        }
        if (event.type === "session.idle" || event.type === "session.deleted") {
          const properties = event.properties ?? {};
          const info = properties.info;
          const infoID = info !== null && typeof info === "object" ? info.id : void 0;
          const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : typeof infoID === "string" ? infoID : void 0;
          if (sessionID) onTurnEnd?.(sessionID);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      console.warn("[Pantheon V2] Event subscription error:", err);
    }
  })();
  return () => controller.abort();
}
async function handleV2SessionEvent(event) {
  switch (event.type) {
    case "session.created":
      await onSessionCreated(event);
      break;
    case "session.idle":
      await onSessionIdle(event);
      break;
    case "session.deleted":
      await onSessionDeleted(event);
      break;
    case "session.error":
      await onSessionError(event);
      break;
    case "session.compacted":
      await onSessionCompacted(event);
      break;
    default:
      break;
  }
}
async function onSessionCreated(event) {
  const payload = event;
  const properties = event.properties ?? {};
  const data = event.data !== null && typeof event.data === "object" ? event.data : {};
  const info = properties.info ?? data.info;
  const sessionInfo = info !== null && typeof info === "object" ? info : {};
  writeV2AdmissionProof("session.created", {
    eventKeys: Object.keys(payload),
    propertyKeys: Object.keys(properties),
    dataKeys: Object.keys(data),
    infoKeys: Object.keys(sessionInfo),
    id: sessionInfo.id ?? sessionInfo.sessionID ?? data.id ?? data.sessionID ?? properties.id ?? properties.sessionID ?? payload.sessionID ?? null,
    parentID: sessionInfo.parentID ?? data.parentID ?? properties.parentID ?? null,
    agent: sessionInfo.agent ?? data.agent ?? properties.agent ?? null
  });
}
async function onSessionIdle(_event) {
  const sessionID = _event.properties?.sessionID;
  if (!sessionID) return;
  const enforcer = idleTodoEnforcer;
  if (enforcer != null) {
    try {
      await enforcer.onIdle(sessionID);
    } catch {
    }
  }
}
async function onSessionDeleted(event) {
  const properties = event.properties;
  if (properties === void 0) return;
  const info = properties.info;
  const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : info !== null && typeof info === "object" ? info.id : void 0;
  if (typeof sessionID !== "string" || sessionID === "") {
    console.warn(
      "[Pantheon V2] session.deleted carried no session id (neither properties.sessionID nor properties.info.id); its read-only registration cannot be pruned and will persist."
    );
    return;
  }
  readOnlyRegistry.unregister(sessionID);
}
async function onSessionError(_event) {
}
async function onSessionCompacted(_event) {
}
var pruneSkipSessions = /* @__PURE__ */ new Set();
var PRUNE_SKIP_SESSIONS_MAX = 256;
function logContextPrune(stats, sessionID) {
  if (stats.changed) {
    appendV2HookLog(
      `[context-pruner] site=${stats.site} messages=${stats.messagesTouched} parts=${stats.partsPruned} est_tokens_saved=${stats.estimatedTokensSaved}`
    );
    return;
  }
  if (stats.skipReason === null || stats.skipReason === "not-array" || stats.skipReason === "malformed") {
    return;
  }
  const session = typeof sessionID === "string" && sessionID !== "" ? sessionID : "unknown";
  const key = `${stats.site}:${session}:${stats.skipReason}`;
  if (pruneSkipSessions.has(key)) return;
  if (pruneSkipSessions.size >= PRUNE_SKIP_SESSIONS_MAX) pruneSkipSessions.clear();
  pruneSkipSessions.add(key);
  appendV2HookLog(
    `[context-pruner] site=${stats.site} skip=${stats.skipReason} messages=${stats.messagesTouched} parts=${stats.partsPruned} est_tokens_saved=${stats.estimatedTokensSaved}`
  );
}
var pruneFailureSessions = /* @__PURE__ */ new Set();
var PRUNE_FAILURE_SESSIONS_MAX = 256;
function logPruneFailureOnce(sessionID, site, error) {
  const session = typeof sessionID === "string" && sessionID !== "" ? sessionID : "";
  const key = session !== "" ? session : `${site}:unknown`;
  if (pruneFailureSessions.has(key)) return;
  if (pruneFailureSessions.size >= PRUNE_FAILURE_SESSIONS_MAX) pruneFailureSessions.clear();
  pruneFailureSessions.add(key);
  const message = error instanceof Error ? error.message : String(error);
  appendV2HookLog(`[context-pruner] failed open site=${site} session=${key}: ${message}`);
}
function logPruneShapeIssue(stats, sessionID, site) {
  if (stats.skipReason !== "not-array" && stats.skipReason !== "malformed") return;
  const detail = stats.skipReason === "not-array" ? "not-array: payload.messages is not an array; input left unchanged" : "malformed: unexpected message shape; input left unchanged";
  logPruneFailureOnce(sessionID, site, new Error(detail));
}
var contextPrunerConfigWarned = false;
function warnContextPrunerConfigOnce(options) {
  if (contextPrunerConfigWarned) return;
  try {
    const issues = describeContextPrunerConfigIssues(options);
    if (issues.length === 0) return;
    contextPrunerConfigWarned = true;
    appendV2HookLog(
      `[context-pruner] ignored invalid context_pruner config: ${issues.join("; ")}; accepted keys: ${CONTEXT_PRUNER_CONFIG_KEYS.join(", ")}`
    );
  } catch {
    contextPrunerConfigWarned = true;
  }
}
var V2_VISION_HISTORY_TEXT = /* @__PURE__ */ new Map();
async function registerV2SessionHooks(context) {
  warnContextPrunerConfigOnce(context.options);
  const host = hostDomains(context);
  const sessionCtx = host.session;
  if (!sessionCtx?.hook) {
    return false;
  }
  const prunerConfig = resolveContextPrunerConfig(context.options);
  let registered = false;
  try {
    await sessionCtx.hook("context", (event) => {
      try {
        if (process.env.PANTHEON_HOOK_CANARY_LIFETIME_PROOF) {
          try {
            appendFileSync2(
              process.env.PANTHEON_HOOK_CANARY_LIFETIME_PROOF,
              "plugin:session.hook:context\n"
            );
          } catch {
          }
        }
        const ctx = event;
        if (ctx == null) return;
        const normalized = normalizeSystemToParts(ctx.system);
        if (normalized != null) {
          if (typeof ctx.system === "string") ctx.system = normalized;
          if (!hasPolicyMarker(normalized)) {
            normalized.push({ type: "text", text: POLICY });
          }
        }
        try {
          sanitizeVisionHistory({ messages: ctx.messages }, V2_VISION_HISTORY_TEXT);
        } catch (error) {
          logPruneFailureOnce(ctx.sessionID, "context", error);
        }
        loadRuntimeOverrides();
        if (prunerConfig.enabled && !gateDisabled("gate-context-pruner")) {
          try {
            const stats = pruneMessages(ctx.messages, prunerConfig, "context");
            logContextPrune(stats, ctx.sessionID);
            logPruneShapeIssue(stats, ctx.sessionID, "context");
          } catch (error) {
            logPruneFailureOnce(ctx.sessionID, "context", error);
          }
        }
      } catch {
      }
    });
    registered = true;
  } catch {
  }
  try {
    const promptSurfaceSink = createTelemetrySink();
    promptSurfaceTelemetrySink = promptSurfaceSink;
    await sessionCtx.hook("prompt", async (event) => {
      try {
        const admission = event;
        const prompt = admission?.prompt;
        if (!prompt || typeof prompt.text !== "string") return;
        const userRequest = prompt.text;
        if (!prompt.text.includes("<!-- pantheon-visual-context -->")) {
          const sessionID = typeof admission?.sessionID === "string" && admission.sessionID.trim() !== "" ? admission.sessionID : void 0;
          const nativeByLookup = await (async () => {
            if (sessionID === void 0) return false;
            try {
              const lookup = sessionCtx.get?.call(sessionCtx, { sessionID });
              const session = lookup instanceof Promise ? await lookup : lookup;
              const model = session?.model;
              if (!model || typeof model.modelID !== "string") return false;
              return modelAcceptsImages(model, model.providerID);
            } catch {
              return false;
            }
          })();
          if (sessionID !== void 0 && !isNativeVisionSession(sessionID) && !nativeByLookup) {
            const visualContext = buildV2VisionPromptContext(prompt.files, prompt.text, sessionID);
            if (visualContext) prompt.text = `${prompt.text}

${visualContext}`;
          }
        }
        await applyDecisionRouterToPrompt(admission, userRequest);
        observePromptSurface(admission, (record2) => {
          promptSurfaceSink.emit({ ...record2, mode: "shadow" });
        });
      } catch {
      }
    });
    registered = true;
  } catch {
  }
  return registered;
}
var SECRET_MASK_RE = /(sk-bf-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{36,}|glpat-[A-Za-z0-9_-]{20}|sk-[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]{20,}|sk_test_[a-zA-Z0-9]{20,}|xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}|bearer\s+[a-zA-Z0-9_.-]{20,}|eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)/gi;
function maskSecret(text2) {
  return text2.replace(SECRET_MASK_RE, "****");
}
var SECRET_BLOCK_MESSAGE = "[plugin] Blocked: high-confidence secret detected in tool input \u2014 see .pantheon/logs/hooks.log";
var SECRET_SCAN_UNAVAILABLE_MESSAGE = "[plugin] Blocked: the secret scanner could not complete, so this tool call was denied (fail-closed) \u2014 see .pantheon/logs/hooks.log";
function appendV2HookLog(line) {
  const masked = maskSecret(line);
  if (masked === "") return false;
  const stamp = (/* @__PURE__ */ new Date()).toISOString();
  const body = masked.split("\n").map((part) => part.trim()).filter((part) => part !== "").map((part) => `[${stamp}] ${part}`).join("\n");
  if (body === "") return false;
  try {
    const dir = path4.join(process.cwd(), ".pantheon", "logs");
    mkdirSync6(dir, { recursive: true });
    appendFileSync2(path4.join(dir, "hooks.log"), `${body}
`, "utf8");
    return true;
  } catch {
    return false;
  }
}
var BENCH_TIMING_TTL_MS = 5 * 6e4;
var BENCH_TIMING_MAX = 256;
var benchTimings = /* @__PURE__ */ new Map();
function pruneBenchTimings(now) {
  for (const [callID, startedAt] of benchTimings) {
    if (now - startedAt > BENCH_TIMING_TTL_MS) benchTimings.delete(callID);
  }
  while (benchTimings.size >= BENCH_TIMING_MAX) {
    let oldestID = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, at] of benchTimings) {
      if (at < oldestAt) {
        oldestAt = at;
        oldestID = id;
      }
    }
    if (oldestID === null) break;
    benchTimings.delete(oldestID);
  }
}
function benchEventIdentity(event) {
  if (event === null || typeof event !== "object") return { tool: "", callID: "" };
  const payload = event;
  return {
    tool: typeof payload.tool === "string" ? payload.tool : "",
    callID: typeof payload.id === "string" ? payload.id : ""
  };
}
function logBenchHookTiming(phase, event, startedAt) {
  try {
    const { tool: tool2, callID } = benchEventIdentity(event);
    const endedAt = Date.now();
    if (phase === "before") {
      if (callID !== "") {
        benchTimings.set(callID, startedAt);
        pruneBenchTimings(startedAt);
      }
      appendV2HookLog(
        `[bench] tool.execute.before end tool=${tool2} callID=${callID} started_at=${new Date(startedAt).toISOString()} duration_ms=${endedAt - startedAt}`
      );
      return;
    }
    const beforeAt = callID !== "" ? benchTimings.get(callID) : void 0;
    if (beforeAt !== void 0) benchTimings.delete(callID);
    const sinceBefore = beforeAt === void 0 ? "unavailable" : String(endedAt - beforeAt);
    appendV2HookLog(
      `[bench] tool.execute.after end tool=${tool2} callID=${callID} duration_ms=${endedAt - startedAt} since_before_ms=${sinceBefore}`
    );
  } catch {
  }
}
var SECRET_SCAN_MARKER2 = "[SECRET SCAN]";
var SCANNER_INFRA_FAILURES = [
  ["payload serialization failed:", "scanner-serialization-failure"],
  ["spawn failed:", "scanner-spawn-failure"],
  ["hook script failed to spawn:", "scanner-spawn-failure"]
];
function evaluateSecretScanResult(scan) {
  if (scan.timedOut) return { action: "fail-closed", reason: "scanner-timeout" };
  if (scan.signal !== null) return { action: "fail-closed", reason: "scanner-signal" };
  if (!Number.isInteger(scan.code)) {
    return { action: "fail-closed", reason: "scanner-malformed-output" };
  }
  for (const [signature, reason] of SCANNER_INFRA_FAILURES) {
    if (scan.stderr.startsWith(signature)) return { action: "fail-closed", reason };
  }
  if (scan.code === 0) return { action: "allow" };
  if (scan.code === 2) return { action: "block" };
  if (scan.code === 1) {
    return scan.stderr.includes(SECRET_SCAN_MARKER2) ? { action: "advisory" } : { action: "fail-closed", reason: "scanner-malformed-output" };
  }
  return { action: "fail-closed", reason: "scanner-unexpected-exit" };
}
var defaultSecretScanRunner = async (payload) => runSecretScanInProcess(payload);
var secretScanRunner = defaultSecretScanRunner;
function setV2SecretScanRunnerForTests(runner) {
  secretScanRunner = runner ?? defaultSecretScanRunner;
}
var v2EnforcementGuard = createEnforcementGuard({
  getReadOnlySessions: () => readOnlyRegistry.sessionIDs()
});
function adaptV2ExecuteBeforeEvent(event) {
  const payload = event ?? {};
  return {
    input: {
      tool: typeof payload.tool === "string" ? payload.tool : "",
      sessionID: typeof payload.sessionID === "string" ? payload.sessionID : "",
      callID: typeof payload.id === "string" ? payload.id : ""
    },
    output: { args: payload.input },
    agent: payload.agent
  };
}
function setV2ShellRunnerForTests(runner) {
  shellRunnerOverride = runner ?? void 0;
}
var shellRunnerOverride;
function resetV2IdleEnforcerForTests() {
  idleTodoEnforcer = void 0;
}
async function registerV2ToolHooks(context, subagentOrigins, boundedReadOrigins, jevRuntime) {
  const host = hostDomains(context);
  const toolCtx = host.tool;
  if (!toolCtx?.hook) {
    return { registered: false, beforeRegistered: false };
  }
  const shellHooks = createV2ShellHooks({
    ...shellRunnerOverride === void 0 ? {} : { run: shellRunnerOverride },
    onUnkeyed: appendV2HookLog
  });
  const j1Mode = j1ModeFromEnv();
  loadRuntimeOverrides();
  const j1OverrideOff = gateDisabled("gate-j1-risk-gate");
  if (j1OverrideOff) {
    appendV2HookLog(
      "[gate-j1-risk-gate] disabled by override \u2014 the J1 risk gate is off this session"
    );
  }
  let j1Observer;
  if (jevRuntime !== void 0 && j1Mode !== "off" && !j1OverrideOff) {
    const j1Sink = createTelemetrySink();
    j1TelemetrySink = j1Sink;
    j1Observer = createJ1RiskGateObserver({
      runtime: jevRuntime,
      mode: j1Mode,
      threshold: j1EnforceThresholdFromEnv(),
      sink: (record2) => {
        j1Sink.emit({ ...record2, mode: j1Mode === "enforce" ? "enforce" : "shadow" });
      }
    });
  }
  let j3Observer;
  if (jevRuntime !== void 0 && j3EscalationEnabledFromEnv()) {
    const j3Sink = createTelemetrySink();
    j3TelemetrySink = j3Sink;
    const j3Mirror = createJTelemetryMirror({ enabled: true });
    j3Observer = createJ3EscalationObserver({
      runtime: jevRuntime,
      sink: (record2) => {
        const shadowRecord = { ...record2, mode: "shadow" };
        j3Sink.emit(shadowRecord);
        j3Mirror?.record(shadowRecord);
      }
    });
  }
  const resolveGuardPath = createGuardPathResolver(host.location?.directory || process.cwd());
  let registered = false;
  let beforeRegistered = false;
  try {
    await toolCtx.hook("execute.before", async (event) => {
      const benchStartedAt = Date.now();
      const { input, output, agent } = adaptV2ExecuteBeforeEvent(event);
      try {
        syncReadOnlySession(readOnlyRegistry, input.sessionID, agent);
        zeusReadGuard(input.tool, output.args, normalizeDelegationAgent(agent), resolveGuardPath);
        await v2EnforcementGuard(input, output);
        let blockError = null;
        try {
          const payload = {
            tool_name: input.tool,
            tool_input: output.args ?? {},
            agent_id: typeof agent === "string" ? agent : "",
            session_id: input.sessionID
          };
          const scan = await secretScanRunner(payload);
          const decision2 = evaluateSecretScanResult(scan);
          if (decision2.action === "block") {
            appendV2HookLog(SECRET_BLOCK_MESSAGE);
            appendV2HookLog(scan.stderr);
            blockError = new Error(SECRET_BLOCK_MESSAGE);
          } else if (decision2.action === "advisory") {
            appendV2HookLog(scan.stderr);
          } else if (decision2.action === "fail-closed") {
            appendV2HookLog(`${SECRET_SCAN_UNAVAILABLE_MESSAGE} (${decision2.reason})`);
            blockError = new Error(SECRET_SCAN_UNAVAILABLE_MESSAGE);
          }
        } catch {
          appendV2HookLog(SECRET_SCAN_UNAVAILABLE_MESSAGE);
          blockError = new Error(SECRET_SCAN_UNAVAILABLE_MESSAGE);
        }
        if (blockError !== null) throw blockError;
        const boundedReadOrigin = boundedReadOrigins?.capture(event);
        const eventTool = event?.tool;
        if (eventTool === BOUNDED_READ_TOOL && boundedReadOrigin === void 0) {
          throw new Error("BOUND_READ_UNAUTHORIZED");
        }
        if (boundedReadOrigin !== void 0) {
          writeV2AdmissionProof("tool.execute.before bounded-read", {
            sessionID: boundedReadOrigin.sessionID,
            messageID: boundedReadOrigin.messageID,
            callID: boundedReadOrigin.callID,
            agent: boundedReadOrigin.agent
          });
        }
        const origin = subagentOrigins.capture(event);
        if (origin !== void 0) {
          writeV2AdmissionProof("tool.execute.before", { ...origin });
        }
        if (j1Observer !== void 0 && isRiskGateTarget(event.tool)) {
          if (j1Mode === "enforce") {
            const enforceEvent = event;
            const sessionID = typeof enforceEvent.sessionID === "string" ? enforceEvent.sessionID : "";
            const inputHash = approvalInputHash(enforceEvent.input);
            if (sessionID !== "" && hasApproval(sessionID, inputHash)) {
              void j1Observer(event);
              return;
            }
            const verdict = await j1Observer(event);
            if (verdict?.block === true) {
              throw new Error(
                `[J1 enforce] risco ${verdict.riskScore?.toFixed(2)} >= threshold \u2014 APROVA\xC7\xC3O EXPL\xCDCITA NECESS\xC1RIA: use a tool question com o nome "${j1ApprovalMarker(inputHash)}" perguntando ao USU\xC1RIO se aprova esta exata chamada (apresente a ferramenta e o que ela faria, sem execut\xE1-la nem contorn\xE1-la). Se ele aprovar, reintente a MESMA chamada \u2014 ela passar\xE1. Se ele recusar, siga sem o passo arriscado ou entregue a execu\xE7\xE3o manual a ele.`
              );
            }
          } else {
            void j1Observer(event);
          }
        }
        if (j3Observer !== void 0 && isSubagentDispatchEvent(event)) {
          void j3Observer(event);
        }
        await shellHooks.before(event);
      } finally {
        logBenchHookTiming("before", event, benchStartedAt);
      }
    });
    registered = true;
    beforeRegistered = true;
  } catch {
  }
  try {
    const v2ExecuteAfter = createV2ExecuteAfter({
      sandbox: resolveV2SandboxConfig(context.options)
    });
    await toolCtx.hook("execute.after", async (event) => {
      const benchStartedAt = Date.now();
      try {
        subagentOrigins.forget(event);
        boundedReadOrigins?.forget(event);
        if (j1Mode === "enforce") {
          try {
            const after = event ?? {};
            if (after.tool === "question") {
              const sessionID = typeof after.sessionID === "string" ? after.sessionID : "";
              const serialized = JSON.stringify(after.output ?? {}) ?? "";
              const markerMatch = serialized.match(/j1-approval-([0-9a-f]{12})/);
              const markerHash = markerMatch?.[1];
              if (sessionID !== "" && markerHash !== void 0) {
                const name = `j1-approval-${markerHash}`;
                if (isAffirmativeAnswer(name, serialized)) {
                  mintApproval(sessionID, markerHash);
                }
              }
            }
          } catch {
          }
        }
        await v2ExecuteAfter(event);
        await shellHooks.after(event);
      } finally {
        logBenchHookTiming("after", event, benchStartedAt);
      }
    });
    registered = true;
  } catch {
  }
  return { registered, beforeRegistered };
}
function readPermissionEffect(event) {
  try {
    if (event === null || typeof event !== "object") return null;
    const effect = event.effect;
    return typeof effect === "string" ? effect : null;
  } catch {
    return null;
  }
}
async function registerV2PermissionHook(context, subagentOrigins) {
  const domains = hostDomains(context);
  const permCtx = domains.permission;
  if (!permCtx?.hook) {
    markUnsupported("permission-hook");
    return false;
  }
  const p8Guardrail = createP8Guardrail({ enabled: p8GuardrailEnabledFromEnv() });
  const p8Sink = createTelemetrySink();
  p8TelemetrySink = p8Sink;
  const p8RegistryMode = DECISION_POINT_REGISTRY.find((point) => point.id === "P8")?.mode ?? "off";
  const recordP8 = (result, event) => {
    if (!p8Guardrail.enabled) return;
    try {
      const unconfirmed = result.narrowed && readPermissionEffect(event) !== "deny";
      p8Sink.emit({
        point: "P8",
        decision: unconfirmed ? "guardrail.keep" : result.decision,
        reason: unconfirmed ? "p8.write.unconfirmed" : result.reason,
        mode: p8RegistryMode
      });
    } catch {
    }
  };
  try {
    await permCtx.hook("evaluate", async (rawEvent) => {
      const event = rawEvent;
      const effectBefore = event?.effect;
      let origin;
      let decision2 = null;
      let callerSessionParentID;
      const writeProof = () => {
        const proofPath = process.env.PANTHEON_HOOK_CANARY_PERMISSION_PROOF;
        if (!proofPath || !event || !Array.isArray(event.resources)) return;
        try {
          appendFileSync2(
            proofPath,
            `permission.evaluate ${JSON.stringify({
              action: event.action,
              resources: event.resources,
              agent: event.agent,
              sessionID: event.sessionID,
              callerSessionParentID: callerSessionParentID ?? null,
              source: event.source,
              matchedOrigin: origin ?? null,
              decision: decision2,
              effect: event.effect,
              message: event.message,
              eventFields: ["action", "resources", "agent", "sessionID", "source", "effect"].filter(
                (key) => Object.hasOwn(event, key)
              ),
              effectBefore: effectBefore ?? null,
              effectAfter: event.effect ?? null
            })}
`
          );
        } catch {
        }
      };
      const deny = (reason) => {
        if (event === null || typeof event !== "object") {
          throw new Error(
            `permission event is unavailable; denying V2 permission evaluation (${reason})`
          );
        }
        event.effect = "deny";
        event.message = `Pantheon delegation denied: ${reason}`;
        if (event.effect !== "deny") {
          throw new Error(
            `permission event is not mutable; denying V2 permission evaluation (${reason})`
          );
        }
        writeProof();
      };
      if (event?.effect === "deny") {
        writeProof();
        return;
      }
      if (event == null) {
        deny("permission event is missing");
        return;
      }
      if (event.action === DECISION_EGRESS_ACTION) {
        writeProof();
        return;
      }
      if (!Array.isArray(event.resources) || event.resources.length === 0) {
        deny("permission resources are missing or malformed");
        return;
      }
      const targets = event.resources.map(v2ResourceTarget);
      if (targets.some((target) => target === void 0)) {
        deny("permission resource target is malformed");
        return;
      }
      const hasPantheonTarget = targets.some((target) => PANTHEON_AGENTS.has(target ?? ""));
      let session;
      if (hasPantheonTarget) {
        origin = subagentOrigins.consume(event);
        if (origin === void 0) {
          deny("matching host subagent tool origin is missing or stale");
          return;
        }
        const sessionID = typeof event.sessionID === "string" ? event.sessionID.trim() : "";
        if (!sessionID) {
          deny("caller session ID is missing");
          return;
        }
        const sessionDomain = domains.session;
        if (!sessionDomain || typeof sessionDomain.get !== "function") {
          deny("session lookup API is unavailable");
          return;
        }
        let retrieved;
        try {
          retrieved = await sessionDomain.get({ sessionID });
        } catch {
          deny("caller session lookup failed");
          return;
        }
        if (retrieved === null || retrieved === void 0) {
          deny("caller session was not found");
          return;
        }
        if (typeof retrieved !== "object" || Array.isArray(retrieved)) {
          deny("caller session lookup returned invalid data");
          return;
        }
        session = retrieved;
        callerSessionParentID = session.parentID;
      }
      decision2 = evaluateV2Delegation(event, session, event.effect, origin);
      const p8Result = p8Guardrail.apply(event);
      if (decision2 === "deny") {
        deny("caller or target is not allowed by delegation policy");
        return;
      }
      if (event.effect !== "deny") {
        evaluateAutoPermission(event, { cwd: domains.location?.directory || process.cwd() });
      }
      writeProof();
      recordP8(p8Result, event);
    });
    return true;
  } catch {
    markUnsupported("permission-hook");
    return false;
  }
}
function writeV2AdmissionProof(label, detail) {
  const proofPath = process.env.PANTHEON_HOOK_CANARY_PERMISSION_PROOF;
  if (!proofPath) return;
  try {
    appendFileSync2(proofPath, `${label} ${JSON.stringify(detail)}
`);
  } catch {
  }
}
async function prepareV2BoundedRead(context) {
  const host = hostDomains(context);
  const directory = host.location?.directory;
  const projectID = host.location?.project?.id;
  const session = host.session;
  const permission = host.permission;
  if (typeof directory !== "string" || directory.trim() === "" || typeof projectID !== "string" || projectID.trim() === "" || typeof session?.get !== "function" || typeof permission?.assert !== "function" || typeof host.event?.subscribe !== "function" || typeof host.tool?.transform !== "function" || typeof host.tool?.hook !== "function") {
    markUnsupported("bounded-read");
    return void 0;
  }
  const rootDirectory = await realpathAsync(directory).catch(() => void 0);
  if (rootDirectory === void 0) {
    markUnsupported("bounded-read");
    return void 0;
  }
  return createV2BoundedReadTool({
    rootDirectory,
    projectID,
    getSession: (sessionID) => {
      if (typeof session.get !== "function") throw new Error("session lookup unavailable");
      return session.get.call(session, { sessionID });
    },
    assertPermission: (request) => {
      if (typeof permission.assert !== "function") throw new Error("permission API unavailable");
      return permission.assert.call(permission, request);
    },
    scanContent: async ({ content, agent, sessionID, callID }) => {
      try {
        const scan = await secretScanRunner({
          tool_name: BOUNDED_READ_TOOL,
          tool_input: { content },
          agent_id: agent,
          session_id: sessionID
        });
        const decision2 = evaluateSecretScanResult(scan);
        if (decision2.action === "allow") return "allow";
        const reason = decision2.action === "fail-closed" ? decision2.reason : "content-match";
        appendV2HookLog(
          `[SECRET SCAN] bounded read withheld session=${sessionID} callID=${callID} reason=${reason}`
        );
        return decision2.action === "fail-closed" ? "unavailable" : "deny";
      } catch {
        appendV2HookLog(
          `[SECRET SCAN] bounded read withheld session=${sessionID} callID=${callID} reason=scanner-failure`
        );
        return "unavailable";
      }
    }
  });
}
var activeCleanups = [];
var plugin = define({
  id: "pantheon-opencode",
  async setup(context) {
    let idleEnforcer;
    try {
      idleEnforcer = installV2TodoEnforcer(context);
    } catch (error) {
      idleEnforcer = void 0;
      idleTodoEnforcer = void 0;
      markUnsupported("idle-todo-enforcer");
      if (!idleEnforcerFailureLogged) {
        idleEnforcerFailureLogged = true;
        const reason = error instanceof Error ? error.message : String(error);
        appendV2HookLog(
          "[idle-todo-enforcer] construction failed; continuing without idle continuation and todo context: " + reason
        );
      }
    }
    const phase1Transforms = [
      { feature: "agent-transform", register: () => context.agent.transform(transformAgents) },
      {
        feature: "command-transform",
        register: () => context.command.transform(transformCommands)
      },
      {
        feature: "reference-transform",
        register: () => context.reference.transform(transformReferences)
      }
    ];
    const phase1Results = await Promise.allSettled(
      phase1Transforms.map((t) => Promise.resolve().then(() => t.register()))
    );
    phase1Results.forEach((result, index) => {
      const feature = phase1Transforms[index].feature;
      if (result.status === "rejected") {
        markUnsupported(feature);
      }
    });
    const subagentOrigins = new V2SubagentOriginRegistry();
    const boundedRead = await prepareV2BoundedRead(context).catch(() => void 0);
    if (boundedRead === void 0) markUnsupported("bounded-read");
    await registerV2PermissionHook(context, subagentOrigins).catch(() => false);
    const eventCleanup = subscribeV2Events(context, boundedRead?.clearSession);
    if (eventCleanup) {
      activeCleanups.push(eventCleanup);
    } else {
      markUnsupported("event-stream");
    }
    const sessionHooksRegistered = await registerV2SessionHooks(context).catch(() => false);
    if (!sessionHooksRegistered) {
      markUnsupported("session-hooks");
    }
    const jevRuntime = buildV2JevRuntime(hostDomains(context));
    const toolHookResult = await registerV2ToolHooks(
      context,
      subagentOrigins,
      boundedRead?.origins,
      jevRuntime
    ).catch(() => ({ registered: false, beforeRegistered: false }));
    if (!toolHookResult.registered) {
      markUnsupported("tool-execute-hooks");
    }
    const boundedReadDefinition = toolHookResult.beforeRegistered ? boundedRead?.definition : void 0;
    if (boundedRead !== void 0 && boundedReadDefinition === void 0) {
      markUnsupported("bounded-read");
    }
    const toolsRegistered = await registerV2Tools(context, boundedReadDefinition, jevRuntime).catch(
      () => false
    );
    if (!toolsRegistered) markUnsupported("tool-transform");
    const compactionCtx = hostDomains(context).session;
    if (compactionCtx?.hook) {
      const goalStore = new GoalStore({ dir: ".pantheon/goals" });
      const p9Sink = createTelemetrySink();
      p9TelemetrySink = p9Sink;
      try {
        await compactionCtx.hook("compaction", async (event) => {
          try {
            if (process.env.PANTHEON_HOOK_CANARY_LIFETIME_PROOF) {
              try {
                appendFileSync2(
                  process.env.PANTHEON_HOOK_CANARY_LIFETIME_PROOF,
                  "plugin:session.hook:compaction\n"
                );
              } catch {
              }
            }
            const payload = event;
            const sessionID = typeof payload?.sessionID === "string" ? payload.sessionID : typeof payload?.session?.id === "string" ? payload.session.id : void 0;
            try {
              evaluateCompactionMemoryPoint({ payload }, (record2) => {
                p9Sink.emit({ ...record2, mode: "shadow" });
              });
            } catch {
            }
            const prunerConfig = resolveContextPrunerConfig(context.options);
            const goalLoopConfig = resolveGoalLoopConfig(context.options);
            loadRuntimeOverrides();
            if (gateDisabled("gate-context-pruner")) {
              logPruneFailureOnce(
                sessionID,
                "compaction",
                new Error("gate-context-pruner override")
              );
            } else {
              const stats = pruneMessages(payload?.messages, prunerConfig, "compaction");
              logContextPrune(stats, sessionID);
              logPruneShapeIssue(stats, sessionID, "compaction");
            }
            const blocks = await buildCompactionContext({
              ...sessionID === void 0 ? {} : { sessionID },
              goals: {
                // Enabled via `options.goal_loop.enabled` (beta.6): the Wave 3
                // mechanics were hard-disabled by a constant since shipping;
                // the settings window's Autonomy tab now writes this option.
                enabled: goalLoopConfig.enabled,
                list: (id) => goalStore.list(id)
              },
              ...idleEnforcer === void 0 ? {} : {
                todos: {
                  // V1's own source: `TodoEnforcer.listPendingTodos`.
                  enabled: todoEnforcerEnabledFromEnv(),
                  list: (id) => idleEnforcer.listPendingTodos(id)
                }
              }
            });
            if (blocks.length > 0 && !appendSystemBlocks(payload, blocks)) {
              if (!compactionChannelWarned) {
                compactionChannelWarned = true;
                appendV2HookLog(
                  "[compaction-context] payload.system is not a string or array; compaction context could not be injected"
                );
              }
            }
          } catch (error) {
            logPruneFailureOnce(
              event?.sessionID,
              "compaction",
              error
            );
          }
        });
      } catch {
        markUnsupported("compaction-hook");
      }
    } else {
      markUnsupported("compaction-hook");
    }
  }
});
function v2Dispose() {
  for (const cleanup of activeCleanups) {
    try {
      cleanup();
    } catch {
    }
  }
  activeCleanups.length = 0;
}
function getUnsupportedFeatures() {
  return V2_UNSUPPORTED_FEATURES;
}
var plugin_default = plugin;
export {
  V2_UNSUPPORTED_FEATURES,
  plugin_default as default,
  getJ1TelemetrySinkForTests,
  getJ3TelemetrySinkForTests,
  getJ4TelemetrySinkForTests,
  getP11TelemetrySinkForTests,
  getP3TelemetrySinkForTests,
  getP7TelemetrySinkForTests,
  getP8TelemetrySinkForTests,
  getP9TelemetrySinkForTests,
  getPromptSurfaceTelemetrySinkForTests,
  getUnsupportedFeatures,
  plugin,
  resetV2IdleEnforcerForTests,
  setV2SecretScanRunnerForTests,
  setV2ShellRunnerForTests,
  v2Dispose
};
