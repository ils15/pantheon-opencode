import { createComponent, createElement, createTextNode, effect, insert, insertNode, memo, mergeProps, setProp, spread } from "@opentui/solid";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Plugin } from "@opencode/plugin/tui";
import { ErrorBoundary, For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
//#region src/mermaid-ascii.ts
function cleanLabel(raw) {
	return raw.replace(/<br\s*\/?>/gi, " / ").replace(/^["'`]|["'`]$/g, "").replace(/\s+/g, " ").trim();
}
function splitOperandsOutsideDelimiters(text) {
	const out = [];
	let cur = "";
	let quote = null;
	let bracketDepth = 0;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i] ?? "";
		if (quote) {
			if (ch === quote) quote = null;
			cur += ch;
			continue;
		}
		if (ch === "\"" || ch === "'") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === "[" || ch === "(" || ch === "{") {
			bracketDepth += 1;
			cur += ch;
			continue;
		}
		if ((ch === "]" || ch === ")" || ch === "}") && bracketDepth > 0) {
			bracketDepth -= 1;
			cur += ch;
			continue;
		}
		if (ch === "&" && bracketDepth === 0) {
			const part = cur.trim();
			if (part) out.push(part);
			cur = "";
			continue;
		}
		cur += ch;
	}
	const tail = cur.trim();
	if (tail) out.push(tail);
	return out;
}
function parseNodeToken(token) {
	const trimmed = token.trim();
	if (trimmed === "[*]") return {
		id: "__star__",
		label: "●"
	};
	const match = /^([A-Za-z0-9_.:-]+)\s*(?:\[\[([^\]]*)\]\]|\(\(([^)]*)\)\)|\(\[([^\]]*)\]\)|\{\{([^}]*)\}\}|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?$/.exec(trimmed);
	if (!match) return {
		id: trimmed.replace(/[^A-Za-z0-9_.:-]/g, "") || trimmed,
		label: cleanLabel(trimmed)
	};
	const id = match[1] ?? trimmed;
	const rawLabel = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? match[8];
	return rawLabel !== void 0 ? {
		id,
		label: cleanLabel(rawLabel)
	} : { id };
}
function truncateText(text, maxLen) {
	if (maxLen <= 1) return text.slice(0, Math.max(0, maxLen));
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen - 1)}…`;
}
function drawBox(label, maxWidth, indent = "") {
	const text = truncateText(label, Math.max(8, maxWidth - indent.length - 4));
	const bar = "─".repeat(text.length + 2);
	return [
		`${indent}╭${bar}╮`,
		`${indent}│ ${text} │`,
		`${indent}╰${bar}╯`
	];
}
const ARROW_PATTERN = String.raw`(?:(?:-->|-\.->|==>)\|([^|]+)\||--\s+([^->\n]+?)\s+-->|-\.\s*([^.]+?)\s*\.->|==\s*([^=]+?)\s*==>|-->|-\.->|==>|---)`;
const EDGE_RE = new RegExp(String.raw`^(.*?)\s+${ARROW_PATTERN}\s+(.*)$`);
function splitChainOperands(line) {
	const arrowTokenRe = new RegExp(String.raw`\s+(${ARROW_PATTERN})\s+`, "g");
	const parts = [];
	const connectors = [];
	let lastIdx = 0;
	for (const m of line.matchAll(arrowTokenRe)) {
		const idx = m.index ?? 0;
		parts.push(line.slice(lastIdx, idx).trim());
		const arrow = m[1] ?? "";
		const labelRaw = m[2] ?? m[3] ?? m[4] ?? m[5];
		connectors.push({
			label: labelRaw ? cleanLabel(labelRaw) : void 0,
			dashed: arrow.includes("-.")
		});
		lastIdx = idx + m[0].length;
	}
	parts.push(line.slice(lastIdx).trim());
	return {
		parts,
		connectors
	};
}
function parseFlowchart(lines) {
	const nodes = /* @__PURE__ */ new Map();
	const edges = [];
	let direction = "TD";
	const ensureNode = (id, label) => {
		const existing = nodes.get(id);
		if (existing) {
			if (label && existing.label === existing.id) existing.label = label;
			return;
		}
		nodes.set(id, {
			id,
			label: label ?? id
		});
	};
	for (const rawLine of lines) {
		const stripped = rawLine.trim();
		if (!stripped || stripped.startsWith("%%")) continue;
		if (/^(flowchart|graph)\s+/i.test(stripped)) {
			if (/\bLR\b|\bRL\b/i.test(stripped)) direction = "LR";
			continue;
		}
		if (/^(classDef|style|linkStyle|click|class|direction|subgraph|end)\b/i.test(stripped)) continue;
		for (const stmt of stripped.split(";")) {
			const s = stmt.trim();
			if (!s) continue;
			if (EDGE_RE.test(` ${s} `) || [
				"-->",
				"-.->",
				"==>",
				"---"
			].some((tok) => s.includes(tok))) {
				const { parts, connectors } = splitChainOperands(s);
				if (parts.length >= 2 && connectors.length === parts.length - 1) {
					for (let i = 0; i < connectors.length; i += 1) {
						const leftGroup = splitOperandsOutsideDelimiters(parts[i] ?? "");
						const rightGroup = splitOperandsOutsideDelimiters(parts[i + 1] ?? "");
						const conn = connectors[i];
						for (const lTok of leftGroup) {
							const left = parseNodeToken(lTok);
							ensureNode(left.id, left.label);
							for (const rTok of rightGroup) {
								const right = parseNodeToken(rTok);
								ensureNode(right.id, right.label);
								edges.push({
									from: left.id,
									to: right.id,
									label: conn?.label,
									dashed: Boolean(conn?.dashed)
								});
							}
						}
					}
					continue;
				}
			}
			const single = parseNodeToken(s);
			if (single.id) ensureNode(single.id, single.label);
		}
	}
	return {
		direction,
		nodes,
		edges
	};
}
function renderHorizontalChain(chain, edges, maxWidth) {
	if (chain.length < 2 || chain.length > 5) return null;
	const boxes = chain.map((n) => drawBox(n.label, 28));
	const edgeWidths = edges.map((e) => e.label ? Math.max(5, e.label.length + 4) : 4);
	if (boxes.reduce((sum, b) => sum + (b[0]?.length ?? 0), 0) + edgeWidths.reduce((sum, w) => sum + w, 0) > maxWidth) return null;
	const top = [];
	const mid = [];
	const bot = [];
	for (let i = 0; i < boxes.length; i += 1) {
		const box = boxes[i];
		if (!box) continue;
		top.push(box[0] ?? "");
		mid.push(box[1] ?? "");
		bot.push(box[2] ?? "");
		if (i < edges.length) {
			const ew = edgeWidths[i] ?? 4;
			const lbl = edges[i]?.label;
			const arrowMid = `${(edges[i]?.dashed ? "╌" : "─").repeat(ew - 1)}►`;
			const arrowTop = lbl ? ` ${lbl}`.padEnd(ew, " ") : " ".repeat(ew);
			top.push(arrowTop);
			mid.push(arrowMid);
			bot.push(" ".repeat(ew));
		}
	}
	return [
		top.join(""),
		mid.join(""),
		bot.join("")
	];
}
function renderFlowchart(lines, maxWidth) {
	const { direction, nodes, edges } = parseFlowchart(lines);
	if (nodes.size === 0) return null;
	const outEdges = /* @__PURE__ */ new Map();
	const inDegree = /* @__PURE__ */ new Map();
	const incomingSources = /* @__PURE__ */ new Map();
	for (const id of nodes.keys()) {
		outEdges.set(id, []);
		inDegree.set(id, 0);
		incomingSources.set(id, []);
	}
	for (const e of edges) {
		outEdges.get(e.from)?.push(e);
		inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
		incomingSources.get(e.to)?.push(e.from);
	}
	const isSimpleChain = edges.length === nodes.size - 1 && [...outEdges.values()].every((list) => list.length <= 1) && [...inDegree.values()].every((deg) => deg <= 1);
	if (direction === "LR" && isSimpleChain) {
		const startId = [...nodes.keys()].find((id) => (inDegree.get(id) ?? 0) === 0);
		if (startId) {
			const chain = [];
			const chainEdges = [];
			let cur = startId;
			const seen = /* @__PURE__ */ new Set();
			while (cur && !seen.has(cur)) {
				seen.add(cur);
				const node = nodes.get(cur);
				if (!node) break;
				chain.push(node);
				const nextEdge = outEdges.get(cur)?.[0];
				if (!nextEdge) break;
				chainEdges.push(nextEdge);
				cur = nextEdge.to;
			}
			const horiz = renderHorizontalChain(chain, chainEdges, maxWidth);
			if (horiz) return horiz;
		}
	}
	const out = [];
	const visited = /* @__PURE__ */ new Set();
	const renderedJoin = /* @__PURE__ */ new Set();
	const renderSubtree = (nodeId, prefix, isRoot, edgeFromParent) => {
		const node = nodes.get(nodeId);
		if (!node) return;
		const deg = inDegree.get(nodeId) ?? 0;
		if (!isRoot && deg > 1 && !renderedJoin.has(nodeId)) {
			if ((incomingSources.get(nodeId) ?? []).some((src) => !visited.has(src) && src !== edgeFromParent?.from)) {
				const lbl = edgeFromParent?.label ? ` (${edgeFromParent.label})` : "";
				out.push(`${prefix}  ╰─► converges at ${truncateText(node.label, Math.max(12, maxWidth - prefix.length - 20))}${lbl}`);
				return;
			}
			renderedJoin.add(nodeId);
		}
		if (visited.has(nodeId)) {
			const lbl = edgeFromParent?.label ? ` (${edgeFromParent.label})` : "";
			out.push(`${prefix}  ╰─► ↺ ${truncateText(node.label, Math.max(12, maxWidth - prefix.length - 10))}${lbl}`);
			return;
		}
		visited.add(nodeId);
		if (!isRoot && deg > 1) {
			const sources = (incomingSources.get(nodeId) ?? []).map((s) => nodes.get(s)?.id ?? s).filter((v, i, arr) => arr.indexOf(v) === i);
			out.push(`${prefix}  (from ${sources.join(", ")})`);
		}
		const box = drawBox(node.label, maxWidth, prefix);
		out.push(...box);
		const children = outEdges.get(nodeId) ?? [];
		if (children.length === 0) return;
		if (children.length === 1 && children[0]) {
			const child = children[0];
			const stemX = `${prefix}    `;
			const lineChar = child.dashed ? "┆" : "│";
			const lbl = child.label ? ` ${child.label}` : "";
			out.push(`${stemX}${lineChar}${lbl}`);
			out.push(`${stemX}▼`);
			renderSubtree(child.to, prefix, false, child);
			return;
		}
		for (let i = 0; i < children.length; i += 1) {
			const child = children[i];
			if (!child) continue;
			const isLast = i === children.length - 1;
			const branch = isLast ? "└──►" : "├──►";
			const edgeTag = child.label ? `[${child.label}] ` : "";
			const childPrefix = `${prefix}  ${isLast ? "    " : "│   "}`;
			out.push(`${prefix}  ${branch} ${edgeTag}${truncateText(nodes.get(child.to)?.label ?? child.to, Math.max(12, maxWidth - prefix.length - edgeTag.length - 8))}`);
			const grandChildren = outEdges.get(child.to) ?? [];
			if (!visited.has(child.to)) {
				visited.add(child.to);
				if (grandChildren.length > 0) for (let j = 0; j < grandChildren.length; j += 1) {
					const gc = grandChildren[j];
					if (!gc) continue;
					if ((inDegree.get(gc.to) ?? 0) > 1) {
						if ((incomingSources.get(gc.to) ?? []).some((s) => !visited.has(s))) {
							out.push(`${childPrefix}  ╰─► converges at ${truncateText(nodes.get(gc.to)?.label ?? gc.to, Math.max(12, maxWidth - childPrefix.length - 20))}`);
							continue;
						}
					}
					out.push(`${childPrefix}  │`);
					out.push(`${childPrefix}  ▼`);
					renderSubtree(gc.to, childPrefix, false, gc);
				}
			}
		}
	};
	const roots = [...nodes.keys()].filter((id) => (inDegree.get(id) ?? 0) === 0);
	const queue = roots.length > 0 ? roots : [...nodes.keys()].slice(0, 1);
	for (let i = 0; i < queue.length; i += 1) {
		const rootId = queue[i];
		if (!rootId || visited.has(rootId)) continue;
		if (out.length > 0) out.push("");
		renderSubtree(rootId, "", true);
	}
	for (const id of nodes.keys()) if (!visited.has(id)) {
		if (out.length > 0) out.push("");
		renderSubtree(id, "", true);
	}
	return out;
}
function renderSequence(lines, maxWidth) {
	const participants = /* @__PURE__ */ new Map();
	const messages = [];
	const addParticipant = (id, label) => {
		if (!participants.has(id)) participants.set(id, cleanLabel(label ?? id));
		else if (label) participants.set(id, cleanLabel(label));
	};
	for (const raw of lines) {
		const s = raw.trim();
		if (!s || s.startsWith("%%") || /^sequenceDiagram\b/i.test(s)) continue;
		const partMatch = /^(?:participant|actor)\s+([A-Za-z0-9_.-]+)(?:\s+as\s+(.+))?$/i.exec(s);
		if (partMatch?.[1]) {
			addParticipant(partMatch[1], partMatch[2]);
			continue;
		}
		const msgMatch = /^([A-Za-z0-9_.-]+)\s*(-->>|->>|-->|->)\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(s);
		if (msgMatch?.[1] && msgMatch[2] && msgMatch[3]) {
			addParticipant(msgMatch[1]);
			addParticipant(msgMatch[3]);
			messages.push({
				from: msgMatch[1],
				to: msgMatch[3],
				text: cleanLabel(msgMatch[4] ?? ""),
				dashed: msgMatch[2].startsWith("--")
			});
		}
	}
	if (participants.size === 0 || messages.length === 0) return null;
	const ids = [...participants.keys()];
	const count = ids.length;
	const colStep = Math.floor((maxWidth - 4) / Math.max(1, count - 1));
	if (count >= 2 && count <= 4 && colStep >= 18) {
		const centers = ids.map((_, idx) => 5 + idx * Math.min(colStep, 22));
		const totalW = (centers[count - 1] ?? 10) + 8;
		const out = [];
		const topLine = Array(totalW).fill(" ");
		const midLine = Array(totalW).fill(" ");
		const botLine = Array(totalW).fill(" ");
		for (let i = 0; i < count; i += 1) {
			const id = ids[i];
			if (!id) continue;
			const label = truncateText(participants.get(id) ?? id, 12);
			const boxW = label.length + 4;
			const start = Math.max(0, (centers[i] ?? 0) - Math.floor(boxW / 2));
			const top = `╭${"─".repeat(label.length + 2)}╮`;
			const mid = `│ ${label} │`;
			const bot = `╰${"─".repeat(label.length + 2)}╯`;
			for (let k = 0; k < boxW; k += 1) if (start + k < totalW) {
				topLine[start + k] = top[k];
				midLine[start + k] = mid[k];
				botLine[start + k] = k === (centers[i] ?? 0) - start ? "┬" : bot[k];
			}
		}
		out.push(topLine.join("").trimEnd(), midLine.join("").trimEnd(), botLine.join("").trimEnd());
		const emptyLifelines = () => {
			const arr = Array(totalW).fill(" ");
			for (const c of centers) arr[c] = "│";
			return arr;
		};
		for (const msg of messages) {
			const iFrom = ids.indexOf(msg.from);
			const iTo = ids.indexOf(msg.to);
			if (iFrom < 0 || iTo < 0) continue;
			const cFrom = centers[iFrom] ?? 0;
			const cTo = centers[iTo] ?? 0;
			const left = Math.min(cFrom, cTo);
			const right = Math.max(cFrom, cTo);
			const labelRow = emptyLifelines();
			const msgText = truncateText(msg.text, Math.max(6, right - left - 2));
			for (let k = 0; k < msgText.length; k += 1) if (left + 2 + k < totalW) labelRow[left + 2 + k] = msgText[k];
			out.push(labelRow.join("").trimEnd());
			const arrowRow = emptyLifelines();
			const wire = msg.dashed ? "┄" : "─";
			for (let x = left + 1; x < right; x += 1) arrowRow[x] = wire;
			if (cFrom < cTo) {
				arrowRow[left] = "├";
				arrowRow[right - 1] = "►";
			} else {
				arrowRow[left + 1] = "◄";
				arrowRow[right] = "┤";
			}
			out.push(arrowRow.join("").trimEnd());
		}
		out.push(emptyLifelines().join("").trimEnd());
		return out;
	}
	return messages.map((m, idx) => {
		const arrow = m.dashed ? "╌╌►" : "──►";
		const fromLbl = participants.get(m.from) ?? m.from;
		const toLbl = participants.get(m.to) ?? m.to;
		return truncateText(`${idx + 1}. [${fromLbl}] ${arrow} [${toLbl}]: ${m.text}`, maxWidth);
	});
}
function renderStateDiagram(lines, maxWidth) {
	return renderFlowchart(lines.map((line) => {
		const trimmed = line.trim();
		if (/^stateDiagram(?:-v2)?$/i.test(trimmed)) return "flowchart TD";
		const arrowWithLabel = /^(.+?)\s*-->\s*(.+?)\s*:\s*(.+)$/.exec(trimmed);
		if (arrowWithLabel?.[1] && arrowWithLabel[2] && arrowWithLabel[3]) return `${arrowWithLabel[1].trim()} -->|${arrowWithLabel[3].trim()}| ${arrowWithLabel[2].trim()}`;
		return line;
	}), maxWidth);
}
function renderMermaidToUnicode(rawLines, maxWidth = 76) {
	const firstMeaningful = rawLines.map((l) => l.trim()).find((l) => l && !l.startsWith("%%")) ?? "";
	if (/^(?:flowchart|graph)\b/i.test(firstMeaningful)) {
		const rendered = renderFlowchart(rawLines, maxWidth);
		if (rendered && rendered.length > 0) return {
			header: "[Diagram: Flowchart]",
			lines: rendered
		};
	} else if (/^sequenceDiagram\b/i.test(firstMeaningful)) {
		const rendered = renderSequence(rawLines, maxWidth);
		if (rendered && rendered.length > 0) return {
			header: "[Diagram: Sequence]",
			lines: rendered
		};
	} else if (/^stateDiagram/i.test(firstMeaningful)) {
		const rendered = renderStateDiagram(rawLines, maxWidth);
		if (rendered && rendered.length > 0) return {
			header: "[Diagram: State]",
			lines: rendered
		};
	}
	return {
		header: "[Mermaid Diagram]",
		lines: rawLines.map((l) => `  ${l.trim()}`).filter((l) => l.trim().length > 0)
	};
}
const GFM_ALERT_RE = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
function resolveArtifactRoots(workspaceDir) {
	const roots = [];
	const seen = /* @__PURE__ */ new Set();
	const pushRoot = (candidate) => {
		try {
			if (!existsSync(candidate)) return;
			const real = realpathSync(candidate);
			if (!seen.has(real)) {
				seen.add(real);
				roots.push(real);
			}
		} catch {}
	};
	pushRoot(workspaceDir);
	try {
		let cur = resolve(workspaceDir);
		for (let depth = 0; depth < 24; depth += 1) {
			const dotGit = join(cur, ".git");
			if (existsSync(dotGit)) {
				if (statSync(dotGit).isFile()) {
					const content = readFileSync(dotGit, "utf8");
					const match = /^gitdir:\s*(.+)$/m.exec(content);
					if (match?.[1]) {
						const gitDir = resolve(cur, match[1].trim());
						const commonFile = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : basename(dirname(gitDir)) === "worktrees" ? dirname(dirname(gitDir)) : null;
						if (commonGitDir && basename(commonGitDir) === ".git") pushRoot(dirname(commonGitDir));
					}
				}
				break;
			}
			const parent = dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	} catch {}
	return roots;
}
function extractTitle(content, fallbackFile) {
	for (const line of content.split(/\r?\n/)) {
		const match = /^#\s+(.+?)\s*$/.exec(line.trim());
		if (match?.[1]) return match[1].trim();
	}
	return fallbackFile.replace(/\.md$/i, "");
}
function addArtifactFile(out, seenPaths, root, filePath, kind) {
	try {
		const real = realpathSync(filePath);
		if (seenPaths.has(real)) return;
		const st = statSync(real);
		if (!st.isFile()) return;
		const raw = readFileSync(real, "utf8");
		const lineCount = raw === "" ? 0 : raw.split(/\r?\n/).length;
		const relPath = relative(root, real).replace(/\\/g, "/");
		const badge = kind === "plan" ? "PLAN" : kind === "report" ? "REPORT" : "ADR";
		seenPaths.add(real);
		out.push({
			id: real,
			kind,
			badge,
			title: extractTitle(raw, basename(real)),
			path: real,
			relPath,
			modifiedMs: st.mtimeMs,
			lineCount,
			bytes: st.size
		});
	} catch {}
}
function scanPantheonArtifacts(workspaceDir) {
	if (!workspaceDir || !existsSync(workspaceDir)) return [];
	const roots = resolveArtifactRoots(workspaceDir);
	const out = [];
	const seenPaths = /* @__PURE__ */ new Set();
	for (const root of roots) {
		const deepworkDir = join(root, ".pantheon", "deepwork");
		if (existsSync(deepworkDir)) try {
			for (const entry of readdirSync(deepworkDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const slugDir = join(deepworkDir, entry.name);
				for (const file of readdirSync(slugDir, { withFileTypes: true })) {
					if (!file.isFile() || !file.name.endsWith(".md")) continue;
					const kind = file.name.startsWith("VERIFICATION") ? "report" : "plan";
					addArtifactFile(out, seenPaths, root, join(slugDir, file.name), kind);
				}
			}
		} catch {}
		const reportsDir = join(root, ".pantheon", "reports");
		if (existsSync(reportsDir)) try {
			for (const file of readdirSync(reportsDir, { withFileTypes: true })) {
				if (!file.isFile() || !file.name.endsWith(".md")) continue;
				addArtifactFile(out, seenPaths, root, join(reportsDir, file.name), "report");
			}
		} catch {}
		for (const adrDir of [join(root, "docs", "adr"), join(root, ".pantheon", "memory-bank", "adr")]) {
			if (!existsSync(adrDir)) continue;
			try {
				for (const file of readdirSync(adrDir, { withFileTypes: true })) {
					if (!file.isFile() || !file.name.endsWith(".md")) continue;
					if (file.name.toLowerCase() === "readme.md") continue;
					addArtifactFile(out, seenPaths, root, join(adrDir, file.name), "adr");
				}
			} catch {}
		}
	}
	return out.sort((a, b) => b.modifiedMs - a.modifiedMs || a.relPath.localeCompare(b.relPath));
}
function wrapLine(text, width) {
	const max = Number.isInteger(width) && width >= 20 ? width : 76;
	if (text.length <= max) return [text];
	const rows = [];
	let rest = text;
	while (rest.length > max) {
		let split = rest.lastIndexOf(" ", max);
		if (split < Math.floor(max * .4)) split = max;
		rows.push(rest.slice(0, split).trimEnd());
		rest = rest.slice(split).trimStart();
	}
	if (rest.length > 0) rows.push(rest);
	return rows;
}
function simplifyLinks(line) {
	return line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, target) => {
		if (target.startsWith("file://")) {
			const clean = target.replace(/^file:\/\//, "");
			const hashIdx = clean.indexOf("#");
			const pathPart = hashIdx >= 0 ? clean.slice(0, hashIdx) : clean;
			const anchor = hashIdx >= 0 ? clean.slice(hashIdx) : "";
			const base = basename(pathPart);
			return base === label ? `${label}${anchor}` : `${label} (${base}${anchor})`;
		}
		return label;
	});
}
function formatArtifactLines(markdown, width = 76) {
	const max = Number.isInteger(width) && width >= 20 ? width : 76;
	const out = [];
	let inMermaid = false;
	let mermaidBuffer = [];
	let inCode = false;
	let activeAlert = null;
	for (const rawLine of markdown.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (/^```mermaid/i.test(trimmed)) {
			inMermaid = true;
			inCode = true;
			mermaidBuffer = [];
			continue;
		}
		if (/^```/.test(trimmed)) {
			if (inCode) {
				if (inMermaid) {
					const rendered = renderMermaidToUnicode(mermaidBuffer, max);
					out.push(rendered.header);
					for (const dLine of rendered.lines) out.push(dLine);
					mermaidBuffer = [];
				}
				inCode = false;
				inMermaid = false;
				out.push("");
			} else {
				inCode = true;
				const lang = trimmed.slice(3).trim();
				out.push(lang ? `[Code: ${lang}]` : "[Code]");
			}
			continue;
		}
		if (inCode) {
			if (inMermaid) mermaidBuffer.push(rawLine);
			else out.push(...wrapLine(`  ${trimmed}`, max));
			continue;
		}
		const alertMatch = GFM_ALERT_RE.exec(trimmed);
		if (alertMatch?.[1]) {
			activeAlert = alertMatch[1].toUpperCase();
			out.push(`[${activeAlert}]`);
			continue;
		}
		if (trimmed.startsWith(">")) {
			const body = simplifyLinks(trimmed.replace(/^>\s?/, ""));
			const prefix = activeAlert ? "  " : "> ";
			if (body === "") continue;
			out.push(...wrapLine(`${prefix}${body}`, max));
			continue;
		}
		activeAlert = null;
		if (trimmed === "---" || trimmed === "***") {
			out.push("─".repeat(Math.min(max, 64)));
			continue;
		}
		if (trimmed === "") {
			if (out.length > 0 && out[out.length - 1] !== "") out.push("");
			continue;
		}
		const cleaned = simplifyLinks(rawLine).replace(/\*\*/g, "");
		const hMatch = /^(#{1,3})\s+(.+)$/.exec(cleaned.trim());
		if (hMatch?.[1] && hMatch[2]) {
			const level = hMatch[1].length;
			const heading = level === 1 ? hMatch[2].toUpperCase() : hMatch[2];
			if (out.length > 0 && out[out.length - 1] !== "") out.push("");
			out.push(...wrapLine(level === 1 ? heading : `${"· ".repeat(level - 1)}${heading}`, max));
			continue;
		}
		const bulletMatch = /^[-*]\s+(.+)$/.exec(cleaned.trim());
		if (bulletMatch?.[1]) {
			out.push(...wrapLine(`• ${bulletMatch[1]}`, max));
			continue;
		}
		out.push(...wrapLine(cleaned.trimEnd(), max));
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out;
}
function paginateArtifactLines(lines, pageSize = 16) {
	const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 16;
	if (lines.length === 0) return [[]];
	const pages = [];
	for (let i = 0; i < lines.length; i += size) pages.push(lines.slice(i, i + size));
	return pages;
}
function artifactKindLabel(kind, isPt = false) {
	if (kind === "plan") return isPt ? "Plano" : "Plan";
	if (kind === "report") return isPt ? "Relatório" : "Report";
	return "ADR";
}
//#endregion
//#region src/mouse-click.ts
/** Shared mouse-event helpers for OpenTUI shortcuts and dialog controls.
*
*  Opening or closing a dialog inside `onMouseDown` lets the subsequent
*  `mouseup` event hit the newly-mounted (or underlying) surface — e.g. the
*  dialog backdrop's `onMouseUp` immediately dismisses a freshly opened modal.
*  Handling clicks on `onMouseUp` after stopping propagation on both `down`
*  and `up` keeps opened windows persistent across mouse release. */
function stopMouseEvent(event) {
	const stop = event?.stopPropagation;
	if (typeof stop === "function") stop.call(event);
}
function handleMouseClick(event, action) {
	stopMouseEvent(event);
	action?.();
}
Object.freeze([
	"auto",
	"pt-BR",
	"en"
]);
/**
* Resolve effective language: 'pt-BR' or 'en'.
* Defaults to 'pt-BR' if system locale contains 'pt', if Intl locale is pt,
* or if system timezone is Brazilian/Portuguese; otherwise 'en'.
*/
function resolveLanguage(preference = "auto", env = process.env) {
	if (preference === "pt-BR") return "pt-BR";
	if (preference === "en") return "en";
	if ((env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? env.LANGUAGE ?? "").toLowerCase().startsWith("pt")) return "pt-BR";
	try {
		if (Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("pt")) return "pt-BR";
	} catch {}
	try {
		const tz = (env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "").toLowerCase();
		if (tz.includes("sao_paulo") || tz.includes("brazil") || tz.includes("fortaleza") || tz.includes("recife") || tz.includes("manaus") || tz.includes("belem") || tz.includes("cuiaba") || tz.includes("campo_grande") || tz.includes("porto_velho") || tz.includes("rio_branco") || tz.includes("boa_vista") || tz.includes("maceio") || tz.includes("bahia") || tz.includes("noronha") || tz.includes("araguaina") || tz.includes("santarem") || tz.includes("lisbon") || tz.includes("madeira") || tz.includes("azores")) return "pt-BR";
	} catch {}
	return "en";
}
const I18N = {
	tabs: {
		decision: {
			en: "Decision (Jev)",
			pt: "Decisão (Jev)"
		},
		autonomy: {
			en: "Autonomy",
			pt: "Autonomia"
		},
		safety: {
			en: "Safety (J1)",
			pt: "Segurança (J1)"
		},
		tui: {
			en: "TUI",
			pt: "TUI"
		}
	},
	decision: {
		groupRouter: {
			en: "Decision Router (Jev Assistant)",
			pt: "Assistente de Decisão (Jev)"
		},
		groupCredentials: {
			en: "Credentials (status only — values never enter the window)",
			pt: "Credenciais (apenas status — valores protegidos)"
		},
		routerName: {
			en: "Router (Decision Assistant)",
			pt: "Assistente Jev"
		},
		routerNote: {
			en: "applies live — enables intelligent route arbitration and candidate ranking",
			pt: "aplica em tempo real — motor de arbitragem inteligente e ranking de rotas"
		},
		modelName: {
			en: "Decision model",
			pt: "Modelo de Decisão"
		},
		modelNote: {
			en: "local routes on-device (free); auto/explicit pick a remote decision model",
			pt: "local decide no seu PC (grátis); auto/explícito usa modelo nuvem (OpenRouter)"
		},
		selectionModeName: {
			en: "Selection mode",
			pt: "Modo de operação"
		},
		selectionModeNote: {
			en: "local routes on-device; auto/explicit pick a remote decision model",
			pt: "local decide no dispositivo; auto/explícito usa modelo remoto"
		},
		egressName: {
			en: "Cloud API access (Egress)",
			pt: "Acesso à Nuvem (Egress)"
		},
		egressNoteGranted: {
			en: "granted = remote decision routes may call their gateway (budget-capped)",
			pt: "permitido = rotas remotas podem consultar a API (com limite de orçamento)"
		},
		egressNoteNotGranted: {
			en: "not granted = remote routes blocked; local heuristic decisions only",
			pt: "não permitido = chamadas remotas bloqueadas; apenas heurística local"
		},
		candidatesName: {
			en: "Active candidates",
			pt: "Candidatos ativos"
		}
	},
	autonomy: {
		groupGoalLoop: {
			en: "Goal loop (multi-turn session auto-continuation)",
			pt: "Execução Contínua (Goal Loop)"
		},
		goalLoopName: {
			en: "Goal loop",
			pt: "Loop contínuo"
		},
		goalLoopNote: {
			en: "auto-continues multi-turn tasks when session goes idle · applies after OpenCode restart",
			pt: "continua tarefas de múltiplos passos automaticamente · requer reinício"
		},
		maxContinuationsName: {
			en: "Max continuations",
			pt: "Limite de turnos"
		},
		maxContinuationsNote: {
			en: "1..200 — safety ceiling to prevent runaway tasks",
			pt: "1..200 — teto de segurança contra tarefas infinitas"
		},
		cooldownName: {
			en: "Cooldown (ms)",
			pt: "Intervalo (ms)"
		},
		cooldownNote: {
			en: "delay between autonomous turns (min 1000ms)",
			pt: "tempo de espera entre turnos autônomos (mín 1000ms)"
		},
		groupBudgets: {
			en: "Decision budgets (applies live per gated call)",
			pt: "Orçamento Jev (teto financeiro de proteção)"
		},
		monthlyCapName: {
			en: "Monthly cap",
			pt: "Teto mensal (USD)"
		},
		monthlyCapNote: {
			en: "monthly USD ceiling for gated arbitrator decisions",
			pt: "teto mensal em dólares para decisões do assistente Jev"
		},
		perDecisionCapName: {
			en: "Per-decision cap",
			pt: "Teto por consulta (USD)"
		},
		perDecisionCapNote: {
			en: "price cap — gated decisions above this are refused",
			pt: "teto por decisão — consultas remotas que excederem são recusadas"
		},
		groupGradient: {
			en: "Decision gradient (reference policy · J1 owns the risk axis)",
			pt: "Níveis de Decisão & Segurança (Referência)"
		},
		soloName: {
			en: "Decide solo",
			pt: "Decisão direta"
		},
		soloNote: {
			en: "reversible & low-risk edits, routine fixes (no gate)",
			pt: "edições reversíveis e baixo risco, sem portão de bloqueio"
		},
		jevName: {
			en: "Jev decides",
			pt: "Decisão Jev"
		},
		jevNote: {
			en: "typed ambiguity & candidate ranking (budget-capped)",
			pt: "ambiguidade e ranking de skills com teto de orçamento"
		},
		humanName: {
			en: "Human decides",
			pt: "Aprovação humana"
		},
		humanNote: {
			en: "high-risk & destructive operations (J1 gate)",
			pt: "ações de alto risco e destrutivas (portão de segurança J1)"
		}
	},
	safety: {
		groupSafety: {
			en: "Safety & Risk Level (J1 Gate)",
			pt: "Nível de Proteção & Portão de Risco (J1)"
		},
		modeName: {
			en: "Protection mode",
			pt: "Modo de proteção"
		},
		thresholdName: {
			en: "Enforce threshold",
			pt: "Teto para bloqueio"
		},
		thresholdNote: {
			en: "deny at or above · 0..1 · default 0.8",
			pt: "bloqueia em ou acima de · 0..1 · padrão 0.8"
		},
		gateName: {
			en: "Safety gate",
			pt: "Portão de segurança"
		}
	},
	cockpit: {
		attentionQueue: {
			en: "Attention Queue",
			pt: "Fila de Atenção"
		},
		noAttentionItems: {
			en: "  (no pending attention items)",
			pt: "  (nenhum item pendente de atenção)"
		},
		outcomeThreads: {
			en: "Outcome Threads (Goal -> Threads -> Workstreams)",
			pt: "Threads por Objetivo (Goal -> Threads -> Workstreams)"
		},
		noThreads: {
			en: "  (no board threads recorded yet)",
			pt: "  (nenhuma thread registrada no board ainda)"
		},
		workersGantt: {
			en: "Workers & Concurrency Gantt",
			pt: "Workers & Linha do Tempo Gantt"
		},
		noSubagents: {
			en: "No subagent delegations recorded in this session yet.",
			pt: "Nenhum subagente registrado nesta sessão ainda."
		},
		tokenMeter: {
			en: "Token Meter & Context",
			pt: "Medidor de Tokens & Contexto"
		},
		runtimeSurfaces: {
			en: "Runtime Surfaces & Health",
			pt: "Superfícies de Execução & Saúde"
		},
		workMap: {
			en: "Work Map (Topology)",
			pt: "Mapa de Trabalho (Topologia)"
		},
		stepLedgerTitle: {
			en: "Step-Ledger & Active Tasks",
			pt: "Step-Ledger & Tarefas Ativas"
		},
		eventStreamTitle: {
			en: "Semantic Event Stream",
			pt: "Fluxo de Eventos Semânticos"
		},
		generalGoal: {
			en: "General",
			pt: "Geral"
		},
		catDecision: {
			en: "DECISION",
			pt: "DECISÃO"
		},
		catFailure: {
			en: "FAILURE",
			pt: "FALHA"
		},
		catReview: {
			en: "REVIEW",
			pt: "REVISÃO"
		},
		catStuck: {
			en: "STUCK",
			pt: "TRAVADO"
		},
		catQuota: {
			en: "QUOTA",
			pt: "COTA"
		}
	}
};
/** Helper to get localized text */
function t(entry, lang) {
	return lang === "pt-BR" ? entry.pt : entry.en;
}
//#endregion
//#region src/tui-prefs.ts
const PREFS_SYMBOL = Symbol.for("pantheon.tui.prefs.v1");
const DRAFT_PREVIEW_SYMBOL = Symbol.for("pantheon.tui.draft_preview.v1");
function stash() {
	return globalThis[PREFS_SYMBOL];
}
function getDraftPreviewSignal() {
	const g = globalThis;
	if (!g[DRAFT_PREVIEW_SYMBOL]) g[DRAFT_PREVIEW_SYMBOL] = createSignal(void 0);
	return g[DRAFT_PREVIEW_SYMBOL];
}
/** Set the active draft preview overlay (used by settings window to provide live preview). */
function setTuiDraftPreview(draft) {
	const [, setDraft] = getDraftPreviewSignal();
	setDraft(draft && Object.keys(draft).length > 0 ? { ...draft } : void 0);
}
/** Clear the active draft preview overlay. */
function clearTuiDraftPreview() {
	const [, setDraft] = getDraftPreviewSignal();
	setDraft(void 0);
}
/** The active draft preview accessor. */
function tuiDraftPreview() {
	const [draft] = getDraftPreviewSignal();
	return draft();
}
/** Create (or reuse) the durable prefs store. Fail-open: without host
*  storage the consumers fall back to DEFAULT_TUI_PREFS (read-only). */
function initTuiPrefs(context) {
	if (stash() !== void 0) return;
	try {
		const handle = context.storage?.store?.("tui-prefs", { initial: DEFAULT_TUI_PREFS });
		if (handle !== void 0) {
			globalThis[PREFS_SYMBOL] = handle;
			if (!handle[0]?.layout || typeof handle[0]?.sidebar?.context?.turnCost !== "boolean" || typeof handle[0]?.sidebar?.context?.tokenAnatomy !== "boolean") handle[1]((draft) => {
				if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout };
				if (draft.sidebar?.context) {
					if (typeof draft.sidebar.context.turnCost !== "boolean") draft.sidebar.context.turnCost = true;
					if (typeof draft.sidebar.context.tokenAnatomy !== "boolean") draft.sidebar.context.tokenAnatomy = true;
				}
			}).catch(() => {});
		}
	} catch {}
}
/** Deep clone and overlay staged settings draft onto base TuiPrefs. */
function previewTuiPrefs(base, draft) {
	if (!draft || Object.keys(draft).length === 0) return base;
	let hasTui = false;
	for (const k of Object.keys(draft)) if (k.startsWith("tui.")) {
		hasTui = true;
		break;
	}
	if (!hasTui) return base;
	const normalized = normalizeTuiPrefs(base);
	const effective = {
		version: 1,
		layout: { ...normalized.layout },
		...normalized.theme ? { theme: { ...normalized.theme } } : {},
		sidebar: {
			header: { ...normalized.sidebar.header },
			...normalized.sidebar.pinnedSessions ? { pinnedSessions: [...normalized.sidebar.pinnedSessions] } : {},
			blocks: { ...normalized.sidebar.blocks },
			context: { ...normalized.sidebar.context }
		},
		footer: { ...normalized.footer }
	};
	for (const [id, value] of Object.entries(draft)) if (id.startsWith("tui.")) applyTuiRow(effective, id, value);
	return effective;
}
/** The raw persisted prefs from host storage (no draft overlay). */
function savedTuiPrefs() {
	const s = stash()?.[0];
	if (!s) return DEFAULT_TUI_PREFS;
	return normalizeTuiPrefs(s);
}
/** The live reactive prefs (read properties inside memos/JSX — tracked).
*  When a settings window has an active draft, preview overlays on top
*  of durable storage in real time. */
function tuiPrefs() {
	const base = savedTuiPrefs();
	const preview = tuiDraftPreview();
	if (!preview) return base;
	return previewTuiPrefs(base, preview);
}
/** Stage a mutation against the durable store; resolves when persisted. */
function mutateTuiPrefs(mutation) {
	const handle = stash();
	if (handle === void 0) return Promise.resolve();
	return handle[1](mutation);
}
const GAUGE_STYLES = Object.freeze([
	"both",
	"bar",
	"percent",
	"off"
]);
const ENABLED_CYCLE = Object.freeze(["enabled", "disabled"]);
const BAR_SHAPES_CYCLE = Object.freeze([
	"smooth",
	"line",
	"block",
	"ascii",
	"dots",
	"braille"
]);
const BAR_WIDTHS_CYCLE = Object.freeze([
	"standard",
	"compact",
	"wide",
	"full"
]);
const LAYOUT_PRESETS_CYCLE = Object.freeze(["comfortable", "compact"]);
const SEPARATOR_STYLES_CYCLE = Object.freeze([
	"spaces",
	"pipes",
	"dots",
	"slashes"
]);
const SETTINGS_VIEW_MODES = Object.freeze([
	"docked",
	"fullscreen",
	"dialog"
]);
const LANGUAGE_CYCLE = Object.freeze([
	"auto",
	"pt-BR",
	"en"
]);
const THEME_MODES_CYCLE = Object.freeze([
	"auto",
	"dark",
	"light"
]);
const ACCENT_COLORS_CYCLE = Object.freeze([
	"host",
	"pantheon",
	"emerald",
	"cyan",
	"amber",
	"purple",
	"rose"
]);
const ACCENT_PALETTE = {
	host: {
		primary: "#fba970",
		hover: "#fdba74",
		muted: "#a1a1aa"
	},
	pantheon: {
		primary: "#fba970",
		hover: "#fdba74",
		muted: "#a1a1aa"
	},
	emerald: {
		primary: "#10b981",
		hover: "#34d399",
		muted: "#059669"
	},
	cyan: {
		primary: "#06b6d4",
		hover: "#22d3ee",
		muted: "#0891b2"
	},
	amber: {
		primary: "#f59e0b",
		hover: "#fbbf24",
		muted: "#d97706"
	},
	purple: {
		primary: "#a855f7",
		hover: "#c084fc",
		muted: "#9333ea"
	},
	rose: {
		primary: "#f43f5e",
		hover: "#fb7185",
		muted: "#e11d48"
	}
};
function resolveAccentColor(accent, contextTheme) {
	if (!accent || accent === "host") return contextTheme?.text?.feedback?.warning?.base ?? contextTheme?.text?.base ?? "#fba970";
	return ACCENT_PALETTE[accent]?.primary ?? "#fba970";
}
const DEFAULT_TUI_PREFS = {
	version: 1,
	layout: {
		preset: "comfortable",
		separator: "spaces",
		settingsView: "docked",
		language: "auto"
	},
	theme: {
		mode: "auto",
		accent: "host"
	},
	sidebar: {
		header: {
			version: true,
			preset: true,
			session: true
		},
		pinnedSessions: [],
		blocks: {
			context: true,
			git: true,
			todo: false,
			dispatch: true
		},
		context: {
			gauge: "both",
			barShape: "smooth",
			barWidth: "standard",
			evenMark: false,
			tokens: true,
			spent: true,
			modelUsage: true,
			performance: true,
			localSpend: true,
			turnCost: true,
			tokenAnatomy: true
		}
	},
	footer: {
		prompt: true,
		home: true
	}
};
function asBool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
/** Deep-merge stored JSON over the defaults; unknown keys and junk are ignored. */
function normalizeTuiPrefs(raw) {
	const stored = typeof raw === "object" && raw !== null ? raw : {};
	const layout = typeof stored.layout === "object" && stored.layout !== null ? stored.layout : {};
	const sidebar = typeof stored.sidebar === "object" && stored.sidebar !== null ? stored.sidebar : {};
	const header = typeof sidebar.header === "object" && sidebar.header !== null ? sidebar.header : {};
	const blocks = typeof sidebar.blocks === "object" && sidebar.blocks !== null ? sidebar.blocks : {};
	const context = typeof sidebar.context === "object" && sidebar.context !== null ? sidebar.context : {};
	const footer = typeof stored.footer === "object" && stored.footer !== null ? stored.footer : {};
	const rawTheme = typeof stored.theme === "object" && stored.theme !== null ? stored.theme : {};
	const themeMode = THEME_MODES_CYCLE.includes(rawTheme.mode) ? rawTheme.mode : DEFAULT_TUI_PREFS.theme?.mode ?? "auto";
	const themeAccent = ACCENT_COLORS_CYCLE.includes(rawTheme.accent) ? rawTheme.accent : DEFAULT_TUI_PREFS.theme?.accent ?? "host";
	const preset = LAYOUT_PRESETS_CYCLE.includes(layout.preset) ? layout.preset : DEFAULT_TUI_PREFS.layout.preset;
	const separator = SEPARATOR_STYLES_CYCLE.includes(layout.separator) ? layout.separator : DEFAULT_TUI_PREFS.layout.separator;
	const settingsView = SETTINGS_VIEW_MODES.includes(layout.settingsView) ? layout.settingsView : DEFAULT_TUI_PREFS.layout.settingsView;
	const language = LANGUAGE_CYCLE.includes(layout.language) ? layout.language : DEFAULT_TUI_PREFS.layout.language;
	const gauge = GAUGE_STYLES.includes(context.gauge) ? context.gauge : DEFAULT_TUI_PREFS.sidebar.context.gauge;
	const barShape = BAR_SHAPES_CYCLE.includes(context.barShape) ? context.barShape : DEFAULT_TUI_PREFS.sidebar.context.barShape;
	const barWidth = BAR_WIDTHS_CYCLE.includes(context.barWidth) ? context.barWidth : DEFAULT_TUI_PREFS.sidebar.context.barWidth;
	const evenMark = asBool(context.evenMark, DEFAULT_TUI_PREFS.sidebar.context.evenMark);
	return {
		version: 1,
		layout: {
			preset,
			separator,
			settingsView,
			language
		},
		theme: {
			mode: themeMode,
			accent: themeAccent
		},
		sidebar: {
			header: {
				version: asBool(header.version, true),
				preset: asBool(header.preset, true),
				session: asBool(header.session, true)
			},
			pinnedSessions: Array.isArray(sidebar.pinnedSessions) ? sidebar.pinnedSessions.filter((s) => typeof s === "string") : [],
			blocks: {
				context: asBool(blocks.context, true),
				git: asBool(blocks.git, true),
				todo: asBool(blocks.todo, false),
				dispatch: asBool(blocks.dispatch, true)
			},
			context: {
				gauge,
				barShape,
				barWidth,
				evenMark,
				tokens: asBool(context.tokens, true),
				spent: asBool(context.spent, true),
				modelUsage: asBool(context.modelUsage, true),
				performance: asBool(context.performance, true),
				localSpend: asBool(context.localSpend, true),
				turnCost: asBool(context.turnCost, true),
				tokenAnatomy: asBool(context.tokenAnatomy, true)
			}
		},
		footer: {
			prompt: asBool(footer.prompt, true),
			home: asBool(footer.home, true)
		}
	};
}
const onOff = ENABLED_CYCLE;
const row = (id, name, value, note) => ({
	id,
	name,
	value: value ? "enabled" : "disabled",
	cycle: onOff,
	note
});
function buildTuiTab(prefs, languagePref) {
	const isPt = resolveLanguage(languagePref ?? prefs.layout?.language) === "pt-BR";
	return {
		id: "tui",
		title: "TUI",
		groups: [
			{
				title: isPt ? "Predefinição & Layout" : "Preset & Layout",
				rows: [
					{
						id: "tui.layout.preset",
						name: isPt ? "Predefinição de layout" : "Layout preset",
						value: prefs.layout?.preset ?? DEFAULT_TUI_PREFS.layout.preset,
						cycle: LAYOUT_PRESETS_CYCLE,
						note: isPt ? "comfortable | compact — define espaçamento e bordas" : "comfortable | compact — sets spacing & borders"
					},
					{
						id: "tui.layout.separator",
						name: isPt ? "Separador" : "Separator",
						value: prefs.layout?.separator ?? DEFAULT_TUI_PREFS.layout.separator,
						cycle: SEPARATOR_STYLES_CYCLE,
						note: isPt ? "spaces | pipes | dots | slashes — glifos na linha de status" : "spaces | pipes | dots | slashes — status line glyphs"
					},
					{
						id: "tui.layout.settingsView",
						name: isPt ? "Superfície de configurações" : "Settings surface",
						value: tuiRowValue(prefs, "tui.layout.settingsView") ?? "docked",
						cycle: SETTINGS_VIEW_MODES,
						note: isPt ? "docked (acima do prompt) | fullscreen | dialog" : "docked (above prompt) | fullscreen router page | dialog overlay"
					},
					{
						id: "tui.layout.language",
						name: isPt ? "Idioma / Language" : "Language / Idioma",
						value: tuiRowValue(prefs, "tui.layout.language") ?? "auto",
						cycle: LANGUAGE_CYCLE,
						note: isPt ? "auto (detecta via fuso/locale) | pt-BR (Português) | en (English)" : "auto (detect via timezone/locale) | pt-BR (Português) | en (English)"
					}
				]
			},
			{
				title: isPt ? "Cores & Tema" : "Colors & Theme",
				rows: [{
					id: "tui.theme.mode",
					name: isPt ? "Modo do tema" : "Theme mode",
					value: tuiRowValue(prefs, "tui.theme.mode") ?? "auto",
					cycle: THEME_MODES_CYCLE,
					note: isPt ? "auto (segue o OpenCode) | dark | light" : "auto (follow OpenCode theme) | dark | light"
				}, {
					id: "tui.theme.accent",
					name: isPt ? "Cor de destaque" : "Accent color",
					value: tuiRowValue(prefs, "tui.theme.accent") ?? "host",
					cycle: ACCENT_COLORS_CYCLE,
					note: isPt ? "host (segue tema) | pantheon | emerald | cyan | amber | purple | rose" : "host (follow theme) | pantheon | emerald | cyan | amber | purple | rose"
				}]
			},
			{
				title: isPt ? "Barras & Medidores" : "Bars & Gauges",
				rows: [
					{
						id: "tui.sidebar.context.barShape",
						name: isPt ? "Formato da barra" : "Bar shape",
						value: prefs.sidebar.context.barShape,
						cycle: BAR_SHAPES_CYCLE,
						note: "line (━─) | block (▰▱) | smooth (█░) | ascii (=) | dots (●○) | braille"
					},
					{
						id: "tui.sidebar.context.barWidth",
						name: isPt ? "Largura da barra" : "Bar width",
						value: prefs.sidebar.context.barWidth,
						cycle: BAR_WIDTHS_CYCLE,
						note: isPt ? "standard (12) | compact (8) | wide (16) | full (20 células)" : "standard (12) | compact (8) | wide (16) | full (20 cells)"
					},
					row("tui.sidebar.context.evenMark", isPt ? "Marca central (50%)" : "Even-use mark", prefs.sidebar.context.evenMark, isPt ? "| indicador aos 50% nas barras de medição" : "| indicator at 50% midpoint in gauge bars"),
					{
						id: "tui.sidebar.context.gauge",
						name: isPt ? "Estilo do medidor" : "Gauge style",
						value: prefs.sidebar.context.gauge,
						cycle: GAUGE_STYLES,
						note: "both | bar | percent | off — `▰▱ 42% of 200k`"
					}
				]
			},
			{
				title: isPt ? "Cabeçalho da barra lateral" : "Sidebar header",
				rows: [
					row("tui.sidebar.header.version", isPt ? "Linha de versão" : "Version line", prefs.sidebar.header.version, isPt ? "linha `Pantheon v…`" : "the `Pantheon v…` line"),
					row("tui.sidebar.header.preset", isPt ? "Linha de preset" : "Preset line", prefs.sidebar.header.preset, isPt ? "linha `▸ preset · provider`" : "the `▸ preset · provider` line"),
					row("tui.sidebar.header.session", isPt ? "Linha de sessão" : "Session line", prefs.sidebar.header.session, isPt ? "título da sessão ativa" : "the active session title")
				]
			},
			{
				title: isPt ? "Blocos da barra lateral" : "Sidebar blocks",
				rows: [
					row("tui.sidebar.block.context", isPt ? "Bloco de contexto" : "Context block", prefs.sidebar.blocks.context, isPt ? "tokens, medidor, custo, uso de modelos" : "tokens, gauge, spend, model usage"),
					row("tui.sidebar.block.git", isPt ? "Bloco do Git" : "Git block", prefs.sidebar.blocks.git, isPt ? "branch + contagem de alterações" : "branch + working-tree counts"),
					row("tui.sidebar.block.dispatch", isPt ? "Bloco Dispatch" : "Dispatch block", prefs.sidebar.blocks.dispatch, isPt ? "delegações em tempo real" : "live delegations + rollup")
				]
			},
			{
				title: isPt ? "Detalhe do bloco de contexto" : "Context block detail",
				rows: [
					row("tui.sidebar.context.tokens", isPt ? "Linha de tokens" : "Tokens row", prefs.sidebar.context.tokens, isPt ? "contagem bruta de tokens" : "the raw token count line"),
					row("tui.sidebar.context.spent", isPt ? "Linha de custo" : "Spent row", prefs.sidebar.context.spent, isPt ? "linha `$… gastos na sessão`" : "the `$… spent in session` line"),
					row("tui.sidebar.context.modelUsage", isPt ? "Tabela de uso de modelos" : "Model usage table", prefs.sidebar.context.modelUsage, isPt ? "resumo de chamadas por modelo" : "per-model tokens/USD"),
					row("tui.sidebar.context.performance", isPt ? "Linha de desempenho" : "Performance row", prefs.sidebar.context.performance, isPt ? "tokens/segundo e latência" : "cache % + tok/s"),
					row("tui.sidebar.context.turnCost", isPt ? "Custo do turno" : "Turn cost", prefs.sidebar.context.turnCost, isPt ? "linha `Turn: $… (prev: $…)`" : "the `Turn: $… (prev: $…)` line"),
					row("tui.sidebar.context.tokenAnatomy", isPt ? "Anatomia de tokens" : "Token anatomy", prefs.sidebar.context.tokenAnatomy, isPt ? "linha `↑in ↓out ✦think`" : "the `↑in ↓out ✦think` line"),
					row("tui.sidebar.context.localSpend", isPt ? "Linha de custo local" : "Local spend row", prefs.sidebar.context.localSpend, isPt ? "totais de hoje / 30 dias" : "hoje / 30d totals")
				]
			},
			{
				title: isPt ? "Rodapés" : "Footers",
				rows: [row("tui.footer.prompt", isPt ? "Prompt inferior" : "Prompt footer", prefs.footer.prompt, isPt ? "linha `▸preset · ✦n ativos` durante delegações" : "the `▸preset · ✦n ativos` line while delegations run"), row("tui.footer.home", isPt ? "Status inicial" : "Home status", prefs.footer.home, isPt ? "linha `Pantheon v…` sob o prompt inicial" : "the `Pantheon v…` line under the home prompt")]
			}
		]
	};
}
/**
* Apply one staged row INTO a prefs draft (in place — the storage mutate
* callback hands an immer-style draft). Unknown ids or junk values are no-ops.
*/
function applyTuiRow(draft, id, value) {
	const enabled = value === "enabled";
	switch (id) {
		case "tui.layout.preset":
			if (LAYOUT_PRESETS_CYCLE.includes(value)) {
				if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout };
				draft.layout.preset = value;
			}
			return;
		case "tui.layout.separator":
			if (SEPARATOR_STYLES_CYCLE.includes(value)) {
				if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout };
				draft.layout.separator = value;
			}
			return;
		case "tui.layout.settingsView":
			if (SETTINGS_VIEW_MODES.includes(value)) {
				if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout };
				draft.layout.settingsView = value;
			}
			return;
		case "tui.layout.language":
			if (LANGUAGE_CYCLE.includes(value)) {
				if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout };
				draft.layout.language = value;
			}
			return;
		case "tui.theme.mode":
			if (THEME_MODES_CYCLE.includes(value)) {
				if (!draft.theme) draft.theme = { ...DEFAULT_TUI_PREFS.theme };
				draft.theme.mode = value;
			}
			return;
		case "tui.theme.accent":
			if (ACCENT_COLORS_CYCLE.includes(value)) {
				if (!draft.theme) draft.theme = { ...DEFAULT_TUI_PREFS.theme };
				draft.theme.accent = value;
			}
			return;
		case "tui.sidebar.context.barShape":
			if (BAR_SHAPES_CYCLE.includes(value)) draft.sidebar.context.barShape = value;
			return;
		case "tui.sidebar.context.barWidth":
			if (BAR_WIDTHS_CYCLE.includes(value)) draft.sidebar.context.barWidth = value;
			return;
		case "tui.sidebar.context.evenMark":
			draft.sidebar.context.evenMark = enabled;
			return;
		case "tui.sidebar.header.version":
			draft.sidebar.header.version = enabled;
			return;
		case "tui.sidebar.header.preset":
			draft.sidebar.header.preset = enabled;
			return;
		case "tui.sidebar.header.session":
			draft.sidebar.header.session = enabled;
			return;
		case "tui.sidebar.block.context":
			draft.sidebar.blocks.context = enabled;
			return;
		case "tui.sidebar.block.git":
			draft.sidebar.blocks.git = enabled;
			return;
		case "tui.sidebar.block.todo":
			draft.sidebar.blocks.todo = enabled;
			return;
		case "tui.sidebar.block.dispatch":
			draft.sidebar.blocks.dispatch = enabled;
			return;
		case "tui.sidebar.context.gauge":
			if (GAUGE_STYLES.includes(value)) draft.sidebar.context.gauge = value;
			return;
		case "tui.sidebar.context.tokens":
			draft.sidebar.context.tokens = enabled;
			return;
		case "tui.sidebar.context.spent":
			draft.sidebar.context.spent = enabled;
			return;
		case "tui.sidebar.context.modelUsage":
			draft.sidebar.context.modelUsage = enabled;
			return;
		case "tui.sidebar.context.performance":
			draft.sidebar.context.performance = enabled;
			return;
		case "tui.sidebar.context.localSpend":
			draft.sidebar.context.localSpend = enabled;
			return;
		case "tui.sidebar.context.turnCost":
			draft.sidebar.context.turnCost = enabled;
			return;
		case "tui.sidebar.context.tokenAnatomy":
			draft.sidebar.context.tokenAnatomy = enabled;
			return;
		case "tui.footer.prompt":
			draft.footer.prompt = enabled;
			return;
		case "tui.footer.home":
			draft.footer.home = enabled;
			return;
		default: return;
	}
}
/** Read the current pref value for a row id ('enabled'/'disabled'/gauge/custom). */
function tuiRowValue(prefs, id) {
	if (id === "tui.layout.preset") return prefs.layout?.preset ?? DEFAULT_TUI_PREFS.layout.preset;
	if (id === "tui.layout.separator") return prefs.layout?.separator ?? DEFAULT_TUI_PREFS.layout.separator;
	if (id === "tui.layout.settingsView") return prefs.layout?.settingsView ?? DEFAULT_TUI_PREFS.layout.settingsView ?? "docked";
	if (id === "tui.layout.language") return prefs.layout?.language ?? "auto";
	if (id === "tui.theme.mode") return prefs.theme?.mode ?? DEFAULT_TUI_PREFS.theme?.mode ?? "auto";
	if (id === "tui.theme.accent") return prefs.theme?.accent ?? DEFAULT_TUI_PREFS.theme?.accent ?? "host";
	if (id === "tui.sidebar.context.barShape") return prefs.sidebar.context.barShape;
	if (id === "tui.sidebar.context.barWidth") return prefs.sidebar.context.barWidth;
	if (id === "tui.sidebar.context.gauge") return prefs.sidebar.context.gauge;
	if (id === "tui.sidebar.context.evenMark") return prefs.sidebar.context.evenMark ? "enabled" : "disabled";
	const enabled = (() => {
		switch (id) {
			case "tui.sidebar.header.version": return prefs.sidebar.header.version;
			case "tui.sidebar.header.preset": return prefs.sidebar.header.preset;
			case "tui.sidebar.header.session": return prefs.sidebar.header.session;
			case "tui.sidebar.block.context": return prefs.sidebar.blocks.context;
			case "tui.sidebar.block.git": return prefs.sidebar.blocks.git;
			case "tui.sidebar.block.todo": return prefs.sidebar.blocks.todo;
			case "tui.sidebar.block.dispatch": return prefs.sidebar.blocks.dispatch;
			case "tui.sidebar.context.tokens": return prefs.sidebar.context.tokens;
			case "tui.sidebar.context.spent": return prefs.sidebar.context.spent;
			case "tui.sidebar.context.modelUsage": return prefs.sidebar.context.modelUsage;
			case "tui.sidebar.context.performance": return prefs.sidebar.context.performance;
			case "tui.sidebar.context.localSpend": return prefs.sidebar.context.localSpend;
			case "tui.sidebar.context.turnCost": return prefs.sidebar.context.turnCost;
			case "tui.sidebar.context.tokenAnatomy": return prefs.sidebar.context.tokenAnatomy;
			case "tui.footer.prompt": return prefs.footer.prompt;
			case "tui.footer.home": return prefs.footer.home;
			default: return;
		}
	})();
	return enabled === void 0 ? void 0 : enabled ? "enabled" : "disabled";
}
function isSessionPinned(sessionID) {
	if (!sessionID) return false;
	const list = tuiPrefs().sidebar.pinnedSessions;
	return Array.isArray(list) && list.includes(sessionID);
}
//#endregion
//#region src/artifacts.tsx
/** @jsxImportSource @opentui/solid */
/**
* artifacts.tsx — Interactive `/pantheon-artifacts` (and `/artifacts`) TUI dialog.
*
* Scans `.pantheon/deepwork/<slug>/*.md`, `.pantheon/reports/*.md`, and
* `docs/adr/*.md` (resolving linked git worktrees back to the main repository),
* lets users browse artifacts with keyboard or mouse, and renders paginated
* terminal-friendly views of plans, reports, and ADRs.
*/
function readArtifactContent(entry) {
	try {
		return readFileSync(entry.path, "utf8");
	} catch {
		return "";
	}
}
function lineColor(line, fg, muted, warn) {
	if (/^\[(?:IMPORTANT|WARNING|CAUTION)\]/.test(line)) return warn ?? "#fba970";
	if (/^\[(?:NOTE|TIP|Mermaid Diagram|Code)/.test(line)) return "#60a5fa";
	if (line.startsWith("• ")) return fg;
	if (line.startsWith("· ") || line === line.toUpperCase() && /[A-Z]/.test(line) && line.length > 3) return fg;
	if (line.startsWith("─")) return muted;
	return muted ?? fg;
}
function ArtifactsDialogContent(props) {
	const activeEntry = () => props.entries[props.selected()];
	const pageCount = () => Math.max(1, props.pages().length);
	const currentRows = () => props.pages()[Math.min(props.page(), pageCount() - 1)] ?? [];
	const rule = "─".repeat(76);
	return (() => {
		var _el$ = createElement("box"), _el$2 = createElement("box"), _el$3 = createElement("box"), _el$4 = createElement("box"), _el$5 = createElement("text"), _el$6 = createElement("text"), _el$7 = createElement("box"), _el$8 = createElement("text"), _el$0 = createElement("box"), _el$1 = createElement("text"), _el$12 = createElement("box"), _el$13 = createElement("text"), _el$14 = createElement("box"), _el$15 = createElement("box"), _el$23 = createElement("text"), _el$24 = createElement("box"), _el$25 = createElement("text");
		insertNode(_el$, _el$2);
		insertNode(_el$, _el$0);
		insertNode(_el$, _el$12);
		insertNode(_el$, _el$14);
		setProp(_el$, "flexDirection", "column");
		setProp(_el$, "borderStyle", "rounded");
		setProp(_el$, "paddingLeft", 2);
		setProp(_el$, "paddingRight", 2);
		setProp(_el$, "paddingTop", 1);
		setProp(_el$, "paddingBottom", 1);
		insertNode(_el$2, _el$3);
		insertNode(_el$2, _el$7);
		setProp(_el$2, "flexDirection", "row");
		setProp(_el$2, "alignItems", "center");
		setProp(_el$2, "justifyContent", "space-between");
		insertNode(_el$3, _el$4);
		insertNode(_el$3, _el$6);
		setProp(_el$3, "flexDirection", "row");
		setProp(_el$3, "alignItems", "center");
		insertNode(_el$4, _el$5);
		setProp(_el$4, "paddingLeft", 1);
		setProp(_el$4, "paddingRight", 1);
		setProp(_el$4, "marginRight", 1);
		setProp(_el$5, "fg", "#000000");
		setProp(_el$5, "attributes", 1);
		insert(_el$5, () => props.isPt ? "ARTEFATOS" : "ARTIFACTS");
		setProp(_el$6, "attributes", 1);
		insert(_el$6, (() => {
			var _c$ = memo(() => !!(props.mode() === "read" && activeEntry()));
			return () => _c$() ? activeEntry()?.title.slice(0, 52) : memo(() => !!props.isPt)() ? `Planos, Relatórios & ADRs (${props.entries.length})` : `Plans, Reports & ADRs (${props.entries.length})`;
		})());
		insertNode(_el$7, _el$8);
		setProp(_el$7, "onMouseDown", stopMouseEvent);
		setProp(_el$7, "onMouseUp", (event) => handleMouseClick(event, () => props.onClose()));
		insertNode(_el$8, createTextNode(`[ Esc / Q ]`));
		insertNode(_el$0, _el$1);
		setProp(_el$0, "flexDirection", "row");
		setProp(_el$0, "height", 1);
		setProp(_el$0, "marginTop", 1);
		setProp(_el$0, "marginBottom", 1);
		insert(_el$1, rule);
		insert(_el$, createComponent(Show, {
			get when() {
				return memo(() => props.mode() === "read")() && activeEntry() !== void 0;
			},
			get fallback() {
				return (() => {
					var _el$26 = createElement("box");
					setProp(_el$26, "flexDirection", "column");
					setProp(_el$26, "minHeight", 10);
					insert(_el$26, createComponent(Show, {
						get when() {
							return props.entries.length > 0;
						},
						get fallback() {
							return (() => {
								var _el$27 = createElement("box"), _el$28 = createElement("text"), _el$29 = createElement("text"), _el$30 = createElement("text"), _el$32 = createElement("text"), _el$34 = createElement("text");
								insertNode(_el$27, _el$28);
								insertNode(_el$27, _el$29);
								insertNode(_el$27, _el$30);
								insertNode(_el$27, _el$32);
								insertNode(_el$27, _el$34);
								setProp(_el$27, "flexDirection", "column");
								setProp(_el$28, "attributes", 1);
								insert(_el$28, () => props.isPt ? "Nenhum artefato encontrado neste workspace." : "No artifacts found in this workspace.");
								setProp(_el$29, "marginTop", 1);
								insert(_el$29, () => props.isPt ? "Onde o Pantheon salva artefatos:" : "Where Pantheon stores artifacts:");
								insertNode(_el$30, createTextNode(`• .pantheon/deepwork/&lt;slug>/PLAN.md  (/pantheon-deepwork / @athena)`));
								insertNode(_el$32, createTextNode(`• .pantheon/reports/*.md             (@apollo / @themis)`));
								insertNode(_el$34, createTextNode(`• docs/adr/*.md                      (@iris)`));
								effect((_p$) => {
									var _v$9 = props.fg, _v$0 = props.muted, _v$1 = props.muted, _v$10 = props.muted, _v$11 = props.muted;
									_v$9 !== _p$.e && (_p$.e = setProp(_el$28, "fg", _v$9, _p$.e));
									_v$0 !== _p$.t && (_p$.t = setProp(_el$29, "fg", _v$0, _p$.t));
									_v$1 !== _p$.a && (_p$.a = setProp(_el$30, "fg", _v$1, _p$.a));
									_v$10 !== _p$.o && (_p$.o = setProp(_el$32, "fg", _v$10, _p$.o));
									_v$11 !== _p$.i && (_p$.i = setProp(_el$34, "fg", _v$11, _p$.i));
									return _p$;
								}, {
									e: void 0,
									t: void 0,
									a: void 0,
									o: void 0,
									i: void 0
								});
								return _el$27;
							})();
						},
						get children() {
							return createComponent(For, {
								get each() {
									return props.entries.slice(0, 12);
								},
								children: (entry, idx) => {
									const isSelected = () => idx() === props.selected();
									const kindTag = `[${artifactKindLabel(entry.kind, props.isPt).toUpperCase()}]`.padEnd(13);
									const title = (entry.title.length > 30 ? `${entry.title.slice(0, 29)}…` : entry.title).padEnd(32);
									const pathTail = entry.relPath.length > 26 ? `…${entry.relPath.slice(-25)}` : entry.relPath;
									return (() => {
										var _el$36 = createElement("box"), _el$37 = createElement("text"), _el$38 = createElement("text"), _el$39 = createElement("text"), _el$40 = createElement("text");
										insertNode(_el$36, _el$37);
										insertNode(_el$36, _el$38);
										insertNode(_el$36, _el$39);
										insertNode(_el$36, _el$40);
										setProp(_el$36, "flexDirection", "row");
										spread(_el$36, mergeProps(() => isSelected() ? { backgroundColor: "#262626" } : {}, {
											"onMouseDown": stopMouseEvent,
											"onMouseUp": (event) => handleMouseClick(event, () => {
												if (isSelected()) props.onOpen(idx());
												else props.onSelect(idx());
											})
										}), true);
										setProp(_el$37, "attributes", 1);
										setProp(_el$37, "wrapMode", "none");
										insert(_el$37, () => isSelected() ? "▸ " : "  ");
										setProp(_el$38, "wrapMode", "none");
										insert(_el$38, kindTag);
										setProp(_el$39, "wrapMode", "none");
										spread(_el$39, mergeProps({ get fg() {
											return memo(() => !!isSelected())() ? props.fg : props.muted;
										} }, () => isSelected() ? { attributes: 1 } : {}), true);
										insert(_el$39, title);
										setProp(_el$40, "wrapMode", "none");
										insert(_el$40, () => `${pathTail} (${entry.lineCount}L)`);
										effect((_p$) => {
											var _v$12 = isSelected() ? props.warn ?? "#fba970" : props.muted, _v$13 = isSelected() ? props.warn ?? "#fba970" : "#60a5fa", _v$14 = props.muted;
											_v$12 !== _p$.e && (_p$.e = setProp(_el$37, "fg", _v$12, _p$.e));
											_v$13 !== _p$.t && (_p$.t = setProp(_el$38, "fg", _v$13, _p$.t));
											_v$14 !== _p$.a && (_p$.a = setProp(_el$40, "fg", _v$14, _p$.a));
											return _p$;
										}, {
											e: void 0,
											t: void 0,
											a: void 0
										});
										return _el$36;
									})();
								}
							});
						}
					}));
					return _el$26;
				})();
			},
			get children() {
				var _el$10 = createElement("box"), _el$11 = createElement("text");
				insertNode(_el$10, _el$11);
				setProp(_el$10, "flexDirection", "column");
				setProp(_el$10, "minHeight", 12);
				setProp(_el$11, "marginBottom", 1);
				insert(_el$11, () => `${activeEntry()?.relPath ?? ""} · ${activeEntry()?.lineCount ?? 0} ${props.isPt ? "linhas" : "lines"}`);
				insert(_el$10, createComponent(For, {
					get each() {
						return currentRows();
					},
					children: (line) => (() => {
						var _el$41 = createElement("text");
						insert(_el$41, line === "" ? " " : line);
						effect((_$p) => setProp(_el$41, "fg", lineColor(line, props.fg, props.muted, props.warn), _$p));
						return _el$41;
					})()
				}), null);
				effect((_$p) => setProp(_el$11, "fg", props.muted, _$p));
				return _el$10;
			}
		}), _el$12);
		insertNode(_el$12, _el$13);
		setProp(_el$12, "flexDirection", "row");
		setProp(_el$12, "height", 1);
		setProp(_el$12, "marginTop", 1);
		insert(_el$13, rule);
		insertNode(_el$14, _el$15);
		insertNode(_el$14, _el$24);
		setProp(_el$14, "flexDirection", "row");
		setProp(_el$14, "alignItems", "center");
		setProp(_el$14, "justifyContent", "space-between");
		setProp(_el$14, "marginTop", 1);
		insertNode(_el$15, _el$23);
		setProp(_el$15, "flexDirection", "row");
		setProp(_el$15, "alignItems", "center");
		setProp(_el$15, "flexShrink", 1);
		insert(_el$15, createComponent(Show, {
			get when() {
				return props.mode() === "read";
			},
			get children() {
				return [(() => {
					var _el$16 = createElement("box"), _el$17 = createElement("text");
					insertNode(_el$16, _el$17);
					setProp(_el$16, "backgroundColor", "#262626");
					setProp(_el$16, "paddingLeft", 1);
					setProp(_el$16, "paddingRight", 1);
					setProp(_el$16, "marginRight", 1);
					setProp(_el$16, "flexShrink", 0);
					setProp(_el$16, "onMouseDown", stopMouseEvent);
					setProp(_el$16, "onMouseUp", (event) => handleMouseClick(event, () => props.onBack()));
					setProp(_el$17, "fg", "#ffffff");
					setProp(_el$17, "wrapMode", "none");
					insert(_el$17, () => props.isPt ? "‹ Lista" : "‹ List");
					return _el$16;
				})(), createComponent(Show, {
					get when() {
						return pageCount() > 1;
					},
					get children() {
						return [
							(() => {
								var _el$18 = createElement("box"), _el$19 = createElement("text");
								insertNode(_el$18, _el$19);
								setProp(_el$18, "backgroundColor", "#262626");
								setProp(_el$18, "paddingLeft", 1);
								setProp(_el$18, "paddingRight", 1);
								setProp(_el$18, "marginRight", 1);
								setProp(_el$18, "flexShrink", 0);
								setProp(_el$18, "onMouseDown", stopMouseEvent);
								setProp(_el$18, "onMouseUp", (event) => handleMouseClick(event, () => props.onPrevPage()));
								setProp(_el$19, "fg", "#ffffff");
								setProp(_el$19, "wrapMode", "none");
								insert(_el$19, () => props.isPt ? "‹ Anterior" : "‹ Prev");
								return _el$18;
							})(),
							(() => {
								var _el$20 = createElement("text");
								setProp(_el$20, "marginRight", 1);
								setProp(_el$20, "wrapMode", "none");
								insert(_el$20, () => `${props.page() + 1}/${pageCount()}`);
								effect((_$p) => setProp(_el$20, "fg", props.muted, _$p));
								return _el$20;
							})(),
							(() => {
								var _el$21 = createElement("box"), _el$22 = createElement("text");
								insertNode(_el$21, _el$22);
								setProp(_el$21, "backgroundColor", "#262626");
								setProp(_el$21, "paddingLeft", 1);
								setProp(_el$21, "paddingRight", 1);
								setProp(_el$21, "marginRight", 1);
								setProp(_el$21, "flexShrink", 0);
								setProp(_el$21, "onMouseDown", stopMouseEvent);
								setProp(_el$21, "onMouseUp", (event) => handleMouseClick(event, () => props.onNextPage()));
								setProp(_el$22, "fg", "#ffffff");
								setProp(_el$22, "wrapMode", "none");
								insert(_el$22, () => props.isPt ? "Próxima ›" : "Next ›");
								return _el$21;
							})()
						];
					}
				})];
			}
		}), _el$23);
		setProp(_el$23, "wrapMode", "none");
		insert(_el$23, (() => {
			var _c$2 = memo(() => props.mode() === "read");
			return () => _c$2() ? props.isPt ? "b lista · n/p pág · esc" : "b list · n/p page · esc" : props.isPt ? "↑/↓ mover · enter abrir · esc fechar" : "↑/↓ move · enter open · esc close";
		})());
		insertNode(_el$24, _el$25);
		setProp(_el$24, "paddingLeft", 2);
		setProp(_el$24, "paddingRight", 2);
		setProp(_el$24, "flexShrink", 0);
		setProp(_el$24, "onMouseDown", stopMouseEvent);
		setProp(_el$24, "onMouseUp", (event) => handleMouseClick(event, () => {
			if (props.mode() === "list" && props.entries.length > 0) props.onOpen();
			else props.onClose();
		}));
		setProp(_el$25, "fg", "#000000");
		setProp(_el$25, "attributes", 1);
		setProp(_el$25, "wrapMode", "none");
		insert(_el$25, (() => {
			var _c$3 = memo(() => !!(props.mode() === "list" && props.entries.length > 0));
			return () => _c$3() ? props.isPt ? "Abrir" : "Open" : props.isPt ? "Fechar" : "Close";
		})());
		effect((_p$) => {
			var _v$ = props.warn ?? "#fba970", _v$2 = props.warn ?? "#fba970", _v$3 = props.fg, _v$4 = props.muted, _v$5 = props.muted, _v$6 = props.muted, _v$7 = props.muted, _v$8 = props.warn ?? "#fba970";
			_v$ !== _p$.e && (_p$.e = setProp(_el$, "borderColor", _v$, _p$.e));
			_v$2 !== _p$.t && (_p$.t = setProp(_el$4, "backgroundColor", _v$2, _p$.t));
			_v$3 !== _p$.a && (_p$.a = setProp(_el$6, "fg", _v$3, _p$.a));
			_v$4 !== _p$.o && (_p$.o = setProp(_el$8, "fg", _v$4, _p$.o));
			_v$5 !== _p$.i && (_p$.i = setProp(_el$1, "fg", _v$5, _p$.i));
			_v$6 !== _p$.n && (_p$.n = setProp(_el$13, "fg", _v$6, _p$.n));
			_v$7 !== _p$.s && (_p$.s = setProp(_el$23, "fg", _v$7, _p$.s));
			_v$8 !== _p$.h && (_p$.h = setProp(_el$24, "backgroundColor", _v$8, _p$.h));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0,
			o: void 0,
			i: void 0,
			n: void 0,
			s: void 0,
			h: void 0
		});
		return _el$;
	})();
}
function openArtifactsDialog(context, workspaceDir, options) {
	const entries = scanPantheonArtifacts(workspaceDir);
	const initialIndex = options?.initialArtifactId ? entries.findIndex((entry) => entry.id === options.initialArtifactId) : -1;
	const resolvedIndex = initialIndex >= 0 ? initialIndex : 0;
	const isPt = resolveLanguage(tuiPrefs().layout?.language) === "pt-BR";
	const [open, setOpen] = createSignal(false);
	const [selected, setSelected] = createSignal(resolvedIndex);
	const [mode, setMode] = createSignal(initialIndex >= 0 || entries.length === 1 ? "read" : "list");
	const [page, setPage] = createSignal(0);
	const pages = () => {
		const entry = entries[selected()];
		if (!entry) return [[]];
		return paginateArtifactLines(formatArtifactLines(readArtifactContent(entry), 76));
	};
	let dismiss = () => {};
	const openSelected = (idx) => {
		if (entries.length === 0) return;
		if (typeof idx === "number") setSelected(Math.min(Math.max(idx, 0), entries.length - 1));
		setPage(0);
		setMode("read");
	};
	try {
		context.keymap.layer(() => ({
			mode: "global",
			priority: 1,
			enabled: () => open(),
			commands: [
				{
					id: "pantheon.artifacts.close",
					title: "Close artifacts viewer",
					bind: "escape,q",
					run: () => {
						if (!open()) return false;
						dismiss();
					}
				},
				{
					id: "pantheon.artifacts.up",
					title: "Previous artifact",
					bind: "up,k",
					run: () => {
						if (!open() || mode() !== "list" || entries.length === 0) return false;
						setSelected((cur) => Math.max(0, cur - 1));
					}
				},
				{
					id: "pantheon.artifacts.down",
					title: "Next artifact",
					bind: "down,j",
					run: () => {
						if (!open() || mode() !== "list" || entries.length === 0) return false;
						setSelected((cur) => Math.min(entries.length - 1, cur + 1));
					}
				},
				{
					id: "pantheon.artifacts.open-item",
					title: "Open selected artifact",
					bind: "enter,space",
					run: () => {
						if (!open()) return false;
						if (mode() === "list" && entries.length > 0) openSelected();
						else dismiss();
					}
				},
				{
					id: "pantheon.artifacts.back",
					title: "Back to artifacts list",
					bind: "b,backspace",
					run: () => {
						if (!open()) return false;
						if (mode() === "read") setMode("list");
					}
				},
				{
					id: "pantheon.artifacts.next-page",
					title: "Next artifact page",
					bind: "n,right",
					run: () => {
						if (!open() || mode() !== "read") return false;
						setPage((cur) => Math.min(cur + 1, Math.max(0, pages().length - 1)));
					}
				},
				{
					id: "pantheon.artifacts.prev-page",
					title: "Previous artifact page",
					bind: "p,left",
					run: () => {
						if (!open() || mode() !== "read") return false;
						setPage((cur) => Math.max(0, cur - 1));
					}
				}
			]
		}));
	} catch {}
	const close = () => setOpen(false);
	dismiss = () => {
		try {
			context.ui.dialog.clear();
		} catch {}
		close();
	};
	setOpen(true);
	try {
		const theme = context.theme?.text ?? {};
		const warn = theme?.feedback?.warning?.base ?? "#fba970";
		context.ui.dialog.show(() => createComponent(ArtifactsDialogContent, {
			entries,
			selected,
			mode,
			page,
			pages,
			isPt,
			get fg() {
				return theme.base;
			},
			get muted() {
				return theme.muted;
			},
			warn,
			onSelect: (idx) => setSelected(idx),
			onOpen: (idx) => openSelected(idx),
			onBack: () => setMode("list"),
			onPrevPage: () => setPage((cur) => Math.max(0, cur - 1)),
			onNextPage: () => setPage((cur) => Math.min(cur + 1, Math.max(0, pages().length - 1))),
			onClose: dismiss
		}), close);
		context.ui.dialog.set({
			size: "large",
			centered: true
		});
	} catch {
		setOpen(false);
	}
}
//#endregion
//#region src/cockpit-state.ts
/**
* cockpit-state.ts — Pure selectors, Gantt renderers, Work Map topology, and
* Gate Matrix aggregation for the TUI Mission Control Cockpit (`Overview`,
* `Swarm`, `Flightdeck`).
*/
function formatGanttBar(startMs, endMs, minMs, maxMs, width = 24) {
	const span = Math.max(1, maxMs - minMs);
	const s = Math.max(0, Math.min(width - 1, Math.floor((startMs - minMs) / span * width)));
	const e = Math.max(s + 1, Math.min(width, Math.ceil((endMs - minMs) / span * width)));
	const cells = [];
	for (let i = 0; i < width; i += 1) cells.push(i >= s && i < e ? "█" : "░");
	return cells.join("");
}
function formatGateMatrixGlyphs(allowed, approved, waiting, blocked) {
	const cap = (n, ch) => ch.repeat(Math.min(12, Math.max(0, n)));
	const parts = [
		cap(allowed, "■"),
		cap(approved, "▣"),
		cap(waiting, "□"),
		cap(blocked, "✗")
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" ") : "■";
}
function renderWorkMapLines(counts) {
	const subs = String(counts.subagents).padStart(2, " ");
	const arts = String(counts.artifacts).padStart(2, " ");
	const stps = `${counts.stepsDone}/${counts.stepsTotal}`;
	return [
		`  [You] ────── [Zeus] ────── [Swarm (${subs})]`,
		`                 │                 │`,
		`  [Artifacts ${arts}] ─┼─ [Step Ledger ${stps}] ─ [Review & Gates]`,
		`                 │`,
		`  [FTS5 Memory] ─┴─ [AST + LSP Diagnostics]`
	];
}
function loadStepEntries(workspaceDir) {
	const ledgerPath = join(workspaceDir, ".pantheon", "ledger", "step-ledger.json");
	if (!existsSync(ledgerPath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
		return Object.values(parsed.steps ?? {}).map((s) => ({
			stepKey: String(s.stepKey ?? ""),
			objective: String(s.objective ?? ""),
			agent: String(s.agent ?? "specialist"),
			state: String(s.state ?? "pending"),
			...typeof s.taskType === "string" ? { taskType: s.taskType } : {},
			mutatedCount: Array.isArray(s.mutatedFiles) ? s.mutatedFiles.length : 0,
			...typeof s.receiptId === "string" ? { receiptId: s.receiptId } : {},
			hasBaselineTree: typeof s.baselineTree === "string" && s.baselineTree.length === 40,
			updatedAt: String(s.updatedAt ?? "")
		})).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}
function resolveSharedTelemetryRoot(workspaceDir) {
	try {
		let cur = resolve(workspaceDir);
		for (let i = 0; i < 10; i += 1) {
			const gitEntry = join(cur, ".git");
			if (existsSync(gitEntry)) {
				const statText = readFileSync(gitEntry, "utf8");
				const gitDirMatch = /^gitdir:\s*(.+)$/m.exec(statText);
				if (gitDirMatch?.[1]) {
					const gitDir = resolve(cur, gitDirMatch[1].trim());
					const commonPath = join(gitDir, "commondir");
					if (existsSync(commonPath)) {
						const commonDir = resolve(gitDir, readFileSync(commonPath, "utf8").trim());
						if (commonDir.endsWith(`${sep}.git`)) return dirname(commonDir);
					}
				}
				return cur;
			}
			const parent = dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	} catch {}
	return workspaceDir;
}
const VALID_BOARD_TAGS = /* @__PURE__ */ new Set([
	"claim",
	"handoff",
	"question",
	"rebuttal",
	"consensus",
	"deadlock",
	"done",
	"blocker",
	"alert",
	"note"
]);
const VALID_ATTENTION_CATEGORIES = /* @__PURE__ */ new Set([
	"decision",
	"failure",
	"review",
	"stuck",
	"quota"
]);
const ATTENTION_RANK = {
	decision: 1,
	failure: 2,
	review: 3,
	stuck: 4,
	quota: 5
};
function isQuotaText(text) {
	const lower = text.toLowerCase();
	return lower.includes("quota") || lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("429");
}
function parseEphemeralMeta(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const obj = raw;
	if (typeof obj.role !== "string" || typeof obj.baseAgent !== "string") return void 0;
	const status = obj.status === "running" || obj.status === "completed" || obj.status === "failed" || obj.status === "cleaned" ? obj.status : "running";
	return {
		role: obj.role,
		baseAgent: obj.baseAgent,
		status,
		...typeof obj.sessionID === "string" && obj.sessionID ? { sessionID: obj.sessionID } : {},
		...typeof obj.worktreeDir === "string" && obj.worktreeDir ? { worktreeDir: obj.worktreeDir } : {}
	};
}
function loadPersistedBoardMessages(workspaceDir) {
	try {
		const root = resolveSharedTelemetryRoot(workspaceDir);
		const filePath = join(root, ".pantheon", "board", "messages.ndjson");
		if (!existsSync(filePath)) return [];
		const lines = readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
		const out = [];
		for (const line of lines.slice(-200)) try {
			const parsed = JSON.parse(line);
			if (typeof parsed.seq !== "number" || !Number.isFinite(parsed.seq) || typeof parsed.from !== "string" || typeof parsed.body !== "string") continue;
			const tag = typeof parsed.tag === "string" && VALID_BOARD_TAGS.has(parsed.tag) ? parsed.tag : void 0;
			const ephemeral = parseEphemeralMeta(parsed.ephemeral);
			out.push({
				seq: parsed.seq,
				timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : 0,
				channel: typeof parsed.channel === "string" && parsed.channel.trim() ? parsed.channel.trim() : "swarm",
				threadId: typeof parsed.threadId === "string" && parsed.threadId.trim() ? parsed.threadId.trim() : "general",
				from: parsed.from,
				mentions: Array.isArray(parsed.mentions) ? parsed.mentions.filter((m) => typeof m === "string") : [],
				body: parsed.body,
				...typeof parsed.goal === "string" && parsed.goal.trim() ? { goal: parsed.goal.trim() } : {},
				...typeof parsed.workstream === "string" && parsed.workstream.trim() ? { workstream: parsed.workstream.trim() } : {},
				...typeof parsed.stepKey === "string" && parsed.stepKey.trim() ? { stepKey: parsed.stepKey.trim() } : {},
				...typeof parsed.replyToSeq === "number" && Number.isFinite(parsed.replyToSeq) ? { replyToSeq: parsed.replyToSeq } : {},
				...tag !== void 0 ? { tag } : {},
				...ephemeral !== void 0 ? { ephemeral } : {}
			});
		} catch {}
		return out;
	} catch {
		return [];
	}
}
function loadPersistedCockpitEvents(workspaceDir) {
	try {
		const root = resolveSharedTelemetryRoot(workspaceDir);
		const filePath = join(root, ".pantheon", "telemetry", "cockpit-events.ndjson");
		if (!existsSync(filePath)) return [];
		const lines = readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
		const out = [];
		for (const line of lines.slice(-80)) try {
			const parsed = JSON.parse(line);
			if (typeof parsed.kind === "string" && typeof parsed.detail === "string") {
				const attentionCategory = typeof parsed.attentionCategory === "string" && VALID_ATTENTION_CATEGORIES.has(parsed.attentionCategory) ? parsed.attentionCategory : void 0;
				out.push({
					kind: parsed.kind,
					timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
					agent: typeof parsed.agent === "string" ? parsed.agent : "pantheon",
					detail: parsed.detail,
					severity: parsed.severity === "ok" || parsed.severity === "warn" || parsed.severity === "error" ? parsed.severity : "info",
					...typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? { seq: parsed.seq } : {},
					...typeof parsed.threadId === "string" && parsed.threadId ? { threadId: parsed.threadId } : {},
					...typeof parsed.stepKey === "string" && parsed.stepKey ? { stepKey: parsed.stepKey } : {},
					...attentionCategory !== void 0 ? { attentionCategory } : {}
				});
			}
		} catch {}
		return out;
	} catch {
		return [];
	}
}
function buildOutcomeThreads(messages, isPt) {
	if (messages.length === 0) return {
		totalMessages: 0,
		headSeq: 0,
		groups: []
	};
	const ordered = [...messages].sort((a, b) => a.seq - b.seq);
	const headSeq = ordered[ordered.length - 1]?.seq ?? 0;
	const threadGoalMap = /* @__PURE__ */ new Map();
	const seqWorkstreamMap = /* @__PURE__ */ new Map();
	const defaultGoal = isPt ? "Geral" : "General";
	for (const m of ordered) {
		if (m.goal?.trim()) threadGoalMap.set(m.threadId, m.goal.trim());
		const inheritedWs = m.replyToSeq !== void 0 ? seqWorkstreamMap.get(m.replyToSeq) : void 0;
		const ws = m.workstream?.trim() || inheritedWs || m.stepKey?.trim() || "default";
		seqWorkstreamMap.set(m.seq, ws);
	}
	const goalBuckets = /* @__PURE__ */ new Map();
	for (const m of ordered) {
		const fallbackGoal = m.channel === "council" ? isPt ? "Conselho" : "Council" : defaultGoal;
		const goal = threadGoalMap.get(m.threadId) ?? fallbackGoal;
		const wsName = seqWorkstreamMap.get(m.seq) ?? "default";
		let threadsMap = goalBuckets.get(goal);
		if (!threadsMap) {
			threadsMap = /* @__PURE__ */ new Map();
			goalBuckets.set(goal, threadsMap);
		}
		let threadBucket = threadsMap.get(m.threadId);
		if (!threadBucket) {
			threadBucket = {
				channel: m.channel,
				goal,
				messages: [],
				workstreams: /* @__PURE__ */ new Map()
			};
			threadsMap.set(m.threadId, threadBucket);
		}
		threadBucket.messages.push(m);
		let wsList = threadBucket.workstreams.get(wsName);
		if (!wsList) {
			wsList = [];
			threadBucket.workstreams.set(wsName, wsList);
		}
		wsList.push(m);
	}
	const groups = [];
	for (const [goal, threadsMap] of goalBuckets.entries()) {
		const threads = [];
		for (const [threadId, tBucket] of threadsMap.entries()) {
			const workstreams = [];
			for (const [wsName, wsMsgs] of tBucket.workstreams.entries()) {
				const latestWsMsg = wsMsgs[wsMsgs.length - 1];
				let latestStepKey;
				let latestEphemeral;
				for (const wm of wsMsgs) {
					if (wm.stepKey) latestStepKey = wm.stepKey;
					if (wm.ephemeral) latestEphemeral = wm.ephemeral;
				}
				workstreams.push({
					workstream: wsName,
					latestSeq: latestWsMsg?.seq ?? 0,
					statusTag: latestWsMsg?.tag ?? "active",
					messages: wsMsgs,
					...latestStepKey !== void 0 ? { stepKey: latestStepKey } : {},
					...latestEphemeral !== void 0 ? { ephemeral: latestEphemeral } : {}
				});
			}
			workstreams.sort((a, b) => b.latestSeq - a.latestSeq);
			const latestThreadMsg = tBucket.messages[tBucket.messages.length - 1];
			threads.push({
				threadId,
				channel: tBucket.channel,
				goal: tBucket.goal,
				latestSeq: latestThreadMsg?.seq ?? 0,
				statusTag: latestThreadMsg?.tag ?? "active",
				workstreams,
				messages: tBucket.messages
			});
		}
		threads.sort((a, b) => b.latestSeq - a.latestSeq);
		const topThread = threads[0];
		groups.push({
			goal,
			latestSeq: topThread?.latestSeq ?? 0,
			statusTag: topThread?.statusTag ?? "active",
			threads
		});
	}
	groups.sort((a, b) => b.latestSeq - a.latestSeq);
	return {
		totalMessages: ordered.length,
		headSeq,
		groups
	};
}
function isBoardMessageResolved(msg, ordered) {
	const isResolutionTag = (tag) => tag === "consensus" || tag === "done";
	return ordered.some((other) => {
		if (other.seq <= msg.seq) return false;
		if (other.replyToSeq === msg.seq && isResolutionTag(other.tag)) return true;
		if ((msg.tag === "deadlock" || msg.tag === "question") && other.threadId === msg.threadId && other.tag === "consensus") return true;
		if (msg.tag === "blocker" && other.threadId === msg.threadId && (other.tag === "done" || other.tag === "consensus") && (!msg.stepKey || other.stepKey === msg.stepKey)) return true;
		return false;
	});
}
function inferEventAttentionCategory(ev) {
	if (ev.attentionCategory && VALID_ATTENTION_CATEGORIES.has(ev.attentionCategory)) return ev.attentionCategory;
	if (ev.kind === "review:verdict") return ev.severity === "ok" ? void 0 : "review";
	if (ev.kind === "swarm:stall:detected") return isQuotaText(ev.detail) ? "quota" : "stuck";
	if (ev.kind === "themis:reflex:escalated") return "failure";
	if (ev.kind === "step:rollback") return ev.severity === "warn" || ev.severity === "error" ? "failure" : void 0;
	if (ev.kind === "reproduction:gate") return ev.severity === "warn" || ev.severity === "error" ? "review" : void 0;
	if (ev.kind === "ephemeral:worker") return ev.severity === "error" ? "failure" : void 0;
	if (isQuotaText(`${ev.kind} ${ev.detail}`) && ev.severity !== "ok") return "quota";
	if (ev.kind === "board:message") {
		const trimmed = ev.detail.trim().toLowerCase();
		if (trimmed.startsWith("[deadlock]") || trimmed.startsWith("[question]")) return "decision";
		if (trimmed.startsWith("[blocker]")) return "failure";
		if (trimmed.startsWith("[alert]")) return "stuck";
		return ev.severity === "error" ? "failure" : void 0;
	}
	if (ev.severity === "error") return "failure";
}
function buildRankedAttentionQueue(params) {
	const { messages, events, steps, children, isPt } = params;
	const items = [];
	const seenKeys = /* @__PURE__ */ new Set();
	const pushItem = (category, title, detail, agent, timestamp, refs) => {
		const dedupKey = refs.seq !== void 0 ? `seq:${refs.seq}:${category}` : refs.stepKey !== void 0 ? `step:${refs.stepKey}:${category}:${detail}` : `ev:${category}:${agent}:${timestamp}:${detail}`;
		if (seenKeys.has(dedupKey)) return;
		seenKeys.add(dedupKey);
		items.push({
			rank: ATTENTION_RANK[category],
			category,
			title,
			detail,
			agent,
			timestamp,
			...refs.seq !== void 0 ? { seq: refs.seq } : {},
			...refs.stepKey !== void 0 ? { stepKey: refs.stepKey } : {},
			...refs.threadId !== void 0 ? { threadId: refs.threadId } : {}
		});
	};
	const resolvedSeqs = /* @__PURE__ */ new Set();
	const orderedMsgs = [...messages].sort((a, b) => a.seq - b.seq);
	for (const m of orderedMsgs) {
		if (isBoardMessageResolved(m, orderedMsgs)) {
			resolvedSeqs.add(m.seq);
			continue;
		}
		if (m.tag === "deadlock") pushItem("decision", isPt ? "Impasse no conselho" : "Council deadlock", m.body, m.from, m.timestamp, {
			seq: m.seq,
			threadId: m.threadId,
			...m.stepKey !== void 0 ? { stepKey: m.stepKey } : {}
		});
		else if (m.tag === "question") pushItem("decision", isPt ? "Decisão pendente" : "Decision needed", m.body, m.from, m.timestamp, {
			seq: m.seq,
			threadId: m.threadId,
			...m.stepKey !== void 0 ? { stepKey: m.stepKey } : {}
		});
		else if (m.tag === "blocker") pushItem("failure", isPt ? "Bloqueio reportado" : "Blocker reported", m.body, m.from, m.timestamp, {
			seq: m.seq,
			threadId: m.threadId,
			...m.stepKey !== void 0 ? { stepKey: m.stepKey } : {}
		});
		else if (m.tag === "alert") {
			const cat = isQuotaText(m.body) ? "quota" : "stuck";
			pushItem(cat, cat === "quota" ? isPt ? "Alerta de cota" : "Quota warning" : isPt ? "Alerta do watchdog" : "Watchdog alert", m.body, m.from, m.timestamp, {
				seq: m.seq,
				threadId: m.threadId,
				...m.stepKey !== void 0 ? { stepKey: m.stepKey } : {}
			});
		} else if (m.ephemeral?.status === "failed") pushItem("failure", isPt ? "Worker efêmero falhou" : "Ephemeral worker failed", `${m.ephemeral.role}: ${m.body}`, m.from, m.timestamp, {
			seq: m.seq,
			threadId: m.threadId,
			...m.stepKey !== void 0 ? { stepKey: m.stepKey } : {}
		});
	}
	for (const ev of events) {
		if (ev.seq !== void 0 && resolvedSeqs.has(ev.seq)) continue;
		const category = inferEventAttentionCategory(ev);
		if (!category) continue;
		pushItem(category, ev.kind, ev.detail, ev.agent, ev.timestamp, {
			...ev.seq !== void 0 ? { seq: ev.seq } : {},
			...ev.stepKey !== void 0 ? { stepKey: ev.stepKey } : {},
			...ev.threadId !== void 0 ? { threadId: ev.threadId } : {}
		});
	}
	for (const st of steps) if (st.state === "blocked" || st.state === "rolled_back") {
		if (!items.some((i) => i.category === "failure" && i.stepKey === st.stepKey)) {
			const parsedTs = Date.parse(st.updatedAt);
			pushItem("failure", isPt ? `Passo ${st.state}` : `Step ${st.state}`, st.objective || st.stepKey, st.agent, Number.isFinite(parsedTs) ? parsedTs : 0, { stepKey: st.stepKey });
		}
	}
	for (const ch of children) if (ch.status === "failed" || ch.status === "interrupted") pushItem("failure", isPt ? `Subagente ${ch.status}` : `Subagent ${ch.status}`, `${ch.kind} (${ch.id})`, ch.agent, ch.updatedAt, {});
	return items.sort((a, b) => {
		if (a.rank !== b.rank) return a.rank - b.rank;
		if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
		return (b.seq ?? 0) - (a.seq ?? 0);
	}).slice(0, 20);
}
function buildCockpitSnapshot(input) {
	const isPt = Boolean(input.isPt);
	const ctxTokens = Math.max(0, input.contextTokens ?? 0);
	const ctxWindow = Math.max(1, input.contextWindow ?? 2e5);
	const ctxPct = Math.min(100, Math.round(ctxTokens / ctxWindow * 100));
	const filled = Math.min(20, Math.round(ctxPct / 100 * 20));
	const gauge = `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${ctxPct}%`;
	const artifacts = input.workspaceDir ? scanPantheonArtifacts(input.workspaceDir) : [];
	const steps = input.workspaceDir ? loadStepEntries(input.workspaceDir) : [];
	const stepsDone = steps.filter((s) => s.state === "done").length;
	const runningCount = input.children.filter((c) => c.status === "running").length;
	const completedCount = input.children.filter((c) => c.status === "completed").length;
	const failedCount = input.children.filter((c) => c.status === "failed" || c.status === "interrupted").length;
	const childCost = input.children.reduce((acc, c) => acc + c.cost, 0);
	const minMs = input.children.reduce((m, c) => Math.min(m, c.startedAt), Infinity);
	const maxMs = input.children.reduce((m, c) => Math.max(m, c.updatedAt), 0);
	const safeMin = Number.isFinite(minMs) ? minMs : 0;
	const safeMax = maxMs > safeMin ? maxMs : safeMin + 1e3;
	const swarmRows = input.children.map((c) => ({
		...c,
		durationSec: Math.max(0, Math.round((c.updatedAt - c.startedAt) / 100) / 10),
		ganttBar: formatGanttBar(c.startedAt, Math.max(c.startedAt + 1, c.updatedAt), safeMin, safeMax)
	}));
	const persistedEvents = input.workspaceDir ? loadPersistedCockpitEvents(input.workspaceDir) : [];
	const mergedEvents = [...input.events ?? [], ...persistedEvents];
	const dedup = /* @__PURE__ */ new Map();
	for (const ev of mergedEvents) dedup.set(`${ev.kind}:${ev.timestamp}:${ev.agent}:${ev.seq ?? ""}:${ev.detail}`, ev);
	const events = Array.from(dedup.values()).sort((a, b) => b.timestamp - a.timestamp).slice(0, 40);
	const persistedBoard = input.workspaceDir ? loadPersistedBoardMessages(input.workspaceDir) : [];
	const boardDedup = /* @__PURE__ */ new Map();
	for (const m of [...persistedBoard, ...input.boardMessages ?? []]) boardDedup.set(m.seq, m);
	const boardMessages = Array.from(boardDedup.values()).sort((a, b) => a.seq - b.seq);
	const threads = buildOutcomeThreads(boardMessages, isPt);
	const attention = buildRankedAttentionQueue({
		messages: boardMessages,
		events,
		steps,
		children: input.children,
		isPt
	});
	const allowed = stepsDone + events.filter((e) => e.severity === "ok").length + completedCount;
	const approved = steps.filter((s) => Boolean(s.receiptId)).length;
	const waiting = steps.filter((s) => s.state === "in_progress" || s.state === "pending").length + runningCount;
	const blocked = steps.filter((s) => s.state === "blocked" || s.state === "rolled_back").length + events.filter((e) => e.severity === "error").length + failedCount;
	const velocityBlocks = input.children.length > 0 ? input.children.slice(0, 14).map((c) => c.tokens > 2e4 ? "█" : c.tokens > 1e4 ? "▆" : c.tokens > 3e3 ? "▄" : "▂").join("") : "▁▃▅▆▄▂";
	return {
		sessionTitle: input.sessionTitle?.trim() || (isPt ? "Sessão ativa" : "Active Session"),
		modelName: input.modelName?.trim() || "auto",
		overview: {
			contextTokens: ctxTokens,
			contextWindow: ctxWindow,
			contextPercent: ctxPct,
			contextGauge: gauge,
			sessionCost: input.sessionCost ?? childCost,
			cacheRate: input.cacheRate ?? 0,
			subagentCount: input.children.length,
			runningCount,
			velocityBars: velocityBlocks,
			workMap: renderWorkMapLines({
				subagents: input.children.length,
				artifacts: artifacts.length,
				stepsDone,
				stepsTotal: steps.length
			}),
			surfaces: [
				{
					label: "Native Tools (30)",
					status: "active"
				},
				{
					label: "FTS5 Memory + Worktree",
					status: "ready"
				},
				{
					label: "Step-Ledger & Checkpoints",
					status: `${stepsDone}/${steps.length} done`
				},
				{
					label: "LSP + Per-Edit Guardrails",
					status: "active"
				},
				{
					label: "Artifacts & Mermaid",
					status: `${artifacts.length} file(s)`
				}
			]
		},
		swarm: {
			activeCount: runningCount,
			completedCount,
			failedCount,
			totalCost: childCost,
			rows: swarmRows
		},
		threads,
		attention,
		flightdeck: {
			allowed,
			approved,
			waiting,
			blocked,
			gateGlyphs: formatGateMatrixGlyphs(allowed, approved, waiting, blocked),
			gateSummary: `${allowed} allowed · ${approved} receipts · ${waiting} active · ${blocked} blocked`,
			steps,
			logs: events
		}
	};
}
/**
* Render a deterministic Markdown + Mermaid Flightdeck replay trace ready for
* archival under `.pantheon/reports/` and inspection via `/pantheon-artifacts`.
*/
function formatCockpitReplayArtifact(snapshot, now = /* @__PURE__ */ new Date()) {
	const filename = `cockpit-replay-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`;
	const relPath = `.pantheon/reports/${filename}`;
	const seqLines = [
		"```mermaid",
		"sequenceDiagram",
		"  participant You",
		"  participant Zeus"
	];
	const seenAgents = /* @__PURE__ */ new Set();
	for (const row of snapshot.swarm.rows.slice(0, 12)) {
		const cleanAgent = row.agent.replace(/[^A-Za-z0-9_-]/g, "") || "specialist";
		if (!seenAgents.has(cleanAgent)) {
			seenAgents.add(cleanAgent);
			seqLines.push(`  participant ${cleanAgent}`);
		}
		seqLines.push(`  Zeus->>${cleanAgent}: ${row.kind} ($${row.cost.toFixed(3)}, ${row.durationSec}s)`);
		seqLines.push(`  ${cleanAgent}-->>Zeus: ${row.status}`);
	}
	if (snapshot.swarm.rows.length === 0) {
		seqLines.push("  You->>Zeus: active session telemetry snapshot");
		seqLines.push("  Zeus-->>You: Flightdeck gate check");
	}
	seqLines.push("```");
	const ganttRows = snapshot.swarm.rows.length > 0 ? snapshot.swarm.rows.map((r) => `| \`@${r.agent}\` | ${r.status} | \`${r.ganttBar}\` | ${r.durationSec}s | $${r.cost.toFixed(4)} |`).join("\n") : "| _none_ | — | `░░░░░░░░░░░░` | 0s | $0.0000 |";
	const stepLines = snapshot.flightdeck.steps.length > 0 ? snapshot.flightdeck.steps.map((s) => `- **${s.stepKey}** (\`${s.state}\`, \`@${s.agent}\`) — ${s.objective}`).join("\n") : "- No step-ledger entries recorded.";
	const eventLines = snapshot.flightdeck.logs.length > 0 ? snapshot.flightdeck.logs.map((e) => `- \`[${e.kind}]\` **@${e.agent}**: ${e.detail}`).join("\n") : "- No semantic bus events recorded.";
	const attentionLines = snapshot.attention.length > 0 ? snapshot.attention.map((a) => {
		const refs = [a.seq !== void 0 ? `#${a.seq}` : void 0, a.stepKey ? `\`${a.stepKey}\`` : void 0].filter(Boolean).join(" · ");
		return `- **[${a.category.toUpperCase()}]**${refs ? ` (${refs})` : ""} **@${a.agent}**: ${a.detail}`;
	}).join("\n") : "- No pending attention items.";
	const threadLines = snapshot.threads.groups.length > 0 ? snapshot.threads.groups.flatMap((g) => [`- **${g.goal}** (#${g.latestSeq}, \`${g.statusTag}\`)`, ...g.threads.map((t) => `  - \`${t.channel}/${t.threadId}\` (#${t.latestSeq}, \`${t.statusTag}\`, ${t.workstreams.length} workstreams)`)]).join("\n") : "- No board threads recorded.";
	return {
		filename,
		relPath,
		markdown: [
			`# Pantheon Cockpit Flightdeck Replay`,
			"",
			`- **Session:** ${snapshot.sessionTitle}`,
			`- **Model:** ${snapshot.modelName}`,
			`- **Captured At:** ${now.toISOString()}`,
			`- **Spend / Context:** $${snapshot.overview.sessionCost.toFixed(4)} · ${snapshot.overview.contextTokens} tokens (${snapshot.overview.contextPercent}%)`,
			`- **Gate Matrix:** ${snapshot.flightdeck.gateSummary}`,
			"",
			"## Execution Replay Diagram",
			"",
			...seqLines,
			"",
			"## Ranked Attention Queue",
			"",
			attentionLines,
			"",
			"## Outcome Threads",
			"",
			threadLines,
			"",
			"## Swarm Concurrency Timeline",
			"",
			"| Agent | Status | Gantt Window | Duration | Cost |",
			"|---|---|---|---|---|",
			ganttRows,
			"",
			"## Step-Ledger Checkpoints",
			"",
			stepLines,
			"",
			"## Semantic Event Stream",
			"",
			eventLines,
			""
		].join("\n")
	};
}
/** Confined export helper writing a Cockpit replay trace under `<workspaceDir>/.pantheon/reports/`. */
function writeCockpitReplayArtifact(workspaceDir, snapshot, now = /* @__PURE__ */ new Date()) {
	const reportsDir = join(workspaceDir, ".pantheon", "reports");
	mkdirSync(reportsDir, { recursive: true });
	const canonicalReports = realpathSync(reportsDir);
	const artifact = formatCockpitReplayArtifact(snapshot, now);
	const target = resolve(canonicalReports, artifact.filename);
	const prefix = canonicalReports.endsWith(sep) ? canonicalReports : `${canonicalReports}${sep}`;
	if (!target.startsWith(prefix)) throw new Error("Cockpit replay target escaped .pantheon/reports");
	writeFileSync(target, artifact.markdown, "utf8");
	return artifact.relPath;
}
//#endregion
//#region src/cockpit.tsx
/** @jsxImportSource @opentui/solid */
/**
* cockpit.tsx — High-Density TUI Mission Control Cockpit (Overview, Swarm,
* Flightdeck) rendered natively on `@opentui/solid` via `ui.router.register`.
*/
const ROUTE_NAME$1 = "pantheon.cockpit";
const ROUTE_MODE$1 = "pantheon-cockpit";
const TABS = [
	{
		id: "overview",
		label: "1 Overview",
		key: "1"
	},
	{
		id: "swarm",
		label: "2 Swarm",
		key: "2"
	},
	{
		id: "flightdeck",
		label: "3 Flightdeck",
		key: "3"
	}
];
let routerReady = false;
let cockpitController;
const [cockpitOpen, setCockpitOpen] = createSignal(false);
function collectLiveChildren(context, rootSessionID) {
	try {
		const rawList = context?.data?.session?.list?.();
		if (!Array.isArray(rawList)) return [];
		return rawList.filter((s) => s && typeof s.id === "string" && (!rootSessionID || s.parentID === rootSessionID)).slice(0, 20).map((s) => {
			const statusRaw = context?.data?.session?.status?.(s.id);
			const status = statusRaw === "busy" || statusRaw === "running" ? "running" : statusRaw === "error" ? "failed" : statusRaw === "interrupted" ? "interrupted" : "completed";
			const created = typeof s.time?.created === "number" ? s.time.created : Date.now();
			const updated = typeof s.time?.updated === "number" ? s.time.updated : created;
			return {
				id: s.id,
				agent: String(s.agent ?? s.title ?? "specialist").split(/\s+/)[0] ?? "specialist",
				kind: String(s.kind ?? "task"),
				status,
				cost: typeof s.cost === "number" ? s.cost : 0,
				startedAt: created,
				updatedAt: updated,
				tokens: typeof s.tokens?.input === "number" ? s.tokens.input + (s.tokens?.output ?? 0) : 0,
				model: typeof s.model === "string" ? s.model : void 0
			};
		});
	} catch {
		return [];
	}
}
function collectHostLogs() {
	const g = globalThis;
	if (!Array.isArray(g.__pantheonCockpitLogs)) return [];
	return g.__pantheonCockpitLogs;
}
function collectSessionTelemetry(context, sessionID) {
	const sInfo = sessionID ? context?.data?.session?.info?.(sessionID) : void 0;
	const messages = sessionID ? context?.data?.session?.messages?.(sessionID) ?? [] : [];
	let contextTokens = typeof sInfo?.tokens?.input === "number" ? sInfo.tokens.input : 0;
	let modelName = typeof sInfo?.model === "string" ? sInfo.model : void 0;
	let totalCost = typeof sInfo?.cost === "number" ? sInfo.cost : 0;
	let sawMsgCost = false;
	if (Array.isArray(messages) && messages.length > 0) {
		for (const msg of messages) {
			if (!msg || typeof msg !== "object") continue;
			if (typeof msg.cost === "number" && Number.isFinite(msg.cost)) {
				totalCost += msg.cost;
				sawMsgCost = true;
			}
		}
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.role === "assistant" || msg?.type === "assistant") {
				const t = msg.tokens;
				if (t && typeof t === "object") {
					const total = (Number(t.input) || 0) + (Number(t.output) || 0) + (Number(t.reasoning) || 0) + (Number(t.cache?.read) || 0) + (Number(t.cache?.write) || 0);
					if (total > 0) {
						contextTokens = total;
						if (!modelName && typeof msg.modelID === "string") modelName = msg.modelID;
						break;
					}
				}
			}
		}
	}
	const modelsCatalog = context?.data?.provider?.models?.() ?? [];
	let contextWindow = 1e6;
	if (Array.isArray(modelsCatalog) && modelName) {
		const hit = modelsCatalog.find((m) => m?.id === modelName || m?.modelID === modelName);
		if (typeof hit?.limit?.context === "number" && hit.limit.context > 0) contextWindow = hit.limit.context;
	}
	return {
		title: typeof sInfo?.title === "string" ? sInfo.title : void 0,
		modelName,
		contextTokens,
		contextWindow,
		sessionCost: sawMsgCost || typeof sInfo?.cost === "number" ? totalCost : void 0
	};
}
function CockpitView(props) {
	const lang = () => resolveLanguage(tuiPrefs().layout?.language);
	const isPt = () => lang() === "pt-BR";
	const [tab, setTab] = createSignal("overview");
	const [selectedRow, setSelectedRow] = createSignal(0);
	const [showDetail, setShowDetail] = createSignal(false);
	const [exportNote, setExportNote] = createSignal(null);
	const [tick, setTick] = createSignal(0);
	const formatAttentionBadge = (category) => {
		const l = lang();
		if (category === "decision") return t(I18N.cockpit.catDecision, l);
		if (category === "failure") return t(I18N.cockpit.catFailure, l);
		if (category === "review") return t(I18N.cockpit.catReview, l);
		if (category === "stuck") return t(I18N.cockpit.catStuck, l);
		return t(I18N.cockpit.catQuota, l);
	};
	const activeSid = () => props.sessionID ?? (props.context?.ui?.router?.current?.()?.type === "session" ? props.context.ui.router.current().sessionID : void 0);
	const snapshot = () => {
		tick();
		const sid = activeSid();
		const telemetry = collectSessionTelemetry(props.context, sid);
		return buildCockpitSnapshot({
			workspaceDir: props.workspaceDir,
			sessionTitle: telemetry.title,
			modelName: telemetry.modelName,
			contextTokens: telemetry.contextTokens,
			contextWindow: telemetry.contextWindow,
			sessionCost: telemetry.sessionCost,
			children: collectLiveChildren(props.context, sid),
			events: collectHostLogs(),
			isPt: isPt()
		});
	};
	const fg = () => props.context?.theme?.text?.base;
	const muted = () => props.context?.theme?.text?.muted ?? fg();
	const accent = () => resolveAccentColor(tuiPrefs().theme?.accent, props.context?.theme);
	const success = () => props.context?.theme?.text?.feedback?.success?.base ?? accent();
	const errFg = () => props.context?.theme?.text?.feedback?.error?.base ?? accent();
	onMount(() => {
		setCockpitOpen(true);
		let popMode;
		try {
			popMode = props.context?.keymap?.mode?.push?.(ROUTE_MODE$1);
		} catch {}
		const timer = setInterval(() => setTick((t) => t + 1), 1500);
		cockpitController = {
			setTab: (id) => {
				setTab(id);
				setSelectedRow(0);
			},
			nextTab: () => {
				const idx = TABS.findIndex((t) => t.id === tab());
				const next = TABS[(idx + 1) % TABS.length];
				if (next) setTab(next.id);
			},
			prevTab: () => {
				const idx = TABS.findIndex((t) => t.id === tab());
				const prev = TABS[(idx - 1 + TABS.length) % TABS.length];
				if (prev) setTab(prev.id);
			},
			moveRow: (delta) => {
				const snap = snapshot();
				const max = tab() === "swarm" ? snap.swarm.rows.length : tab() === "flightdeck" ? Math.max(snap.flightdeck.steps.length, snap.flightdeck.logs.length) : 0;
				if (max <= 0) return;
				setSelectedRow((cur) => Math.max(0, Math.min(max - 1, cur + delta)));
			},
			toggleDetail: () => setShowDetail((v) => !v),
			exportReplay: () => {
				try {
					const relPath = writeCockpitReplayArtifact(props.workspaceDir, snapshot());
					setExportNote(relPath);
					setTick((t) => t + 1);
				} catch {
					setExportNote("export_failed");
				}
			},
			refresh: () => setTick((t) => t + 1),
			close: props.onClose
		};
		onCleanup(() => {
			clearInterval(timer);
			cockpitController = void 0;
			setCockpitOpen(false);
			try {
				popMode?.();
			} catch {}
		});
	});
	return (() => {
		var _el$ = createElement("box"), _el$2 = createElement("box"), _el$3 = createElement("box"), _el$4 = createElement("text"), _el$6 = createElement("text"), _el$7 = createElement("box"), _el$8 = createElement("text"), _el$0 = createElement("box"), _el$1 = createElement("text"), _el$39 = createElement("text"), _el$41 = createElement("text");
		insertNode(_el$, _el$2);
		insertNode(_el$, _el$0);
		insertNode(_el$, _el$1);
		insertNode(_el$, _el$39);
		insertNode(_el$, _el$41);
		setProp(_el$, "flexDirection", "column");
		setProp(_el$, "paddingLeft", 2);
		setProp(_el$, "paddingRight", 2);
		setProp(_el$, "paddingTop", 1);
		setProp(_el$, "paddingBottom", 1);
		insertNode(_el$2, _el$3);
		insertNode(_el$2, _el$7);
		setProp(_el$2, "flexDirection", "row");
		setProp(_el$2, "justifyContent", "space-between");
		insertNode(_el$3, _el$4);
		insertNode(_el$3, _el$6);
		setProp(_el$3, "flexDirection", "row");
		insertNode(_el$4, createTextNode(`◈ PANTHEON COCKPIT `));
		setProp(_el$4, "attributes", 1);
		insert(_el$6, () => `· ${snapshot().sessionTitle} (${snapshot().modelName})`);
		insertNode(_el$7, _el$8);
		setProp(_el$7, "onMouseDown", stopMouseEvent);
		setProp(_el$7, "onMouseUp", (event) => handleMouseClick(event, props.onClose));
		insertNode(_el$8, createTextNode(`[ Esc / Q ]`));
		setProp(_el$0, "flexDirection", "row");
		setProp(_el$0, "marginTop", 1);
		setProp(_el$0, "gap", 2);
		insert(_el$0, createComponent(For, {
			each: TABS,
			children: (t) => {
				const active = () => tab() === t.id;
				return (() => {
					var _el$43 = createElement("box"), _el$44 = createElement("text");
					insertNode(_el$43, _el$44);
					setProp(_el$43, "onMouseDown", stopMouseEvent);
					setProp(_el$43, "onMouseUp", (event) => handleMouseClick(event, () => setTab(t.id)));
					insert(_el$44, () => `[${t.label}]`);
					effect((_p$) => {
						var _v$19 = active() ? accent() : muted(), _v$20 = active() ? 1 : 0;
						_v$19 !== _p$.e && (_p$.e = setProp(_el$44, "fg", _v$19, _p$.e));
						_v$20 !== _p$.t && (_p$.t = setProp(_el$44, "attributes", _v$20, _p$.t));
						return _p$;
					}, {
						e: void 0,
						t: void 0
					});
					return _el$43;
				})();
			}
		}));
		insertNode(_el$1, createTextNode(`────────────────────────────────────────────────────────────────────────`));
		insert(_el$, createComponent(Show, {
			get when() {
				return tab() === "overview";
			},
			get children() {
				var _el$11 = createElement("box"), _el$12 = createElement("text"), _el$13 = createElement("text"), _el$14 = createElement("box"), _el$15 = createElement("text"), _el$16 = createElement("box"), _el$17 = createElement("text");
				insertNode(_el$11, _el$12);
				insertNode(_el$11, _el$13);
				insertNode(_el$11, _el$14);
				insertNode(_el$11, _el$16);
				setProp(_el$11, "flexDirection", "column");
				setProp(_el$11, "marginTop", 1);
				setProp(_el$12, "attributes", 1);
				insert(_el$12, () => t(I18N.cockpit.tokenMeter, lang()));
				insert(_el$13, () => `Velocity: ${snapshot().overview.velocityBars}   Context: ${snapshot().overview.contextGauge}   Spend: $${snapshot().overview.sessionCost.toFixed(4)}`);
				insertNode(_el$14, _el$15);
				setProp(_el$14, "marginTop", 1);
				setProp(_el$14, "flexDirection", "column");
				setProp(_el$15, "attributes", 1);
				insert(_el$15, () => t(I18N.cockpit.runtimeSurfaces, lang()));
				insert(_el$14, createComponent(For, {
					get each() {
						return snapshot().overview.surfaces;
					},
					children: (item) => (() => {
						var _el$45 = createElement("text");
						insert(_el$45, () => `  ● ${item.label.padEnd(28)} ${item.status}`);
						effect((_$p) => setProp(_el$45, "fg", fg(), _$p));
						return _el$45;
					})()
				}), null);
				insertNode(_el$16, _el$17);
				setProp(_el$16, "marginTop", 1);
				setProp(_el$16, "flexDirection", "column");
				setProp(_el$17, "attributes", 1);
				insert(_el$17, () => t(I18N.cockpit.workMap, lang()));
				insert(_el$16, createComponent(For, {
					get each() {
						return snapshot().overview.workMap;
					},
					children: (line) => (() => {
						var _el$46 = createElement("text");
						insert(_el$46, line);
						effect((_$p) => setProp(_el$46, "fg", muted(), _$p));
						return _el$46;
					})()
				}), null);
				effect((_p$) => {
					var _v$ = accent(), _v$2 = fg(), _v$3 = accent(), _v$4 = accent();
					_v$ !== _p$.e && (_p$.e = setProp(_el$12, "fg", _v$, _p$.e));
					_v$2 !== _p$.t && (_p$.t = setProp(_el$13, "fg", _v$2, _p$.t));
					_v$3 !== _p$.a && (_p$.a = setProp(_el$15, "fg", _v$3, _p$.a));
					_v$4 !== _p$.o && (_p$.o = setProp(_el$17, "fg", _v$4, _p$.o));
					return _p$;
				}, {
					e: void 0,
					t: void 0,
					a: void 0,
					o: void 0
				});
				return _el$11;
			}
		}), _el$39);
		insert(_el$, createComponent(Show, {
			get when() {
				return tab() === "swarm";
			},
			get children() {
				var _el$18 = createElement("box"), _el$19 = createElement("text"), _el$20 = createElement("box"), _el$21 = createElement("text"), _el$22 = createElement("box"), _el$23 = createElement("text"), _el$24 = createElement("box"), _el$25 = createElement("text");
				insertNode(_el$18, _el$19);
				insertNode(_el$18, _el$20);
				insertNode(_el$18, _el$22);
				insertNode(_el$18, _el$24);
				setProp(_el$18, "flexDirection", "column");
				setProp(_el$18, "marginTop", 1);
				setProp(_el$19, "attributes", 1);
				insert(_el$19, () => `● ${snapshot().swarm.activeCount} active  ✓ ${snapshot().swarm.completedCount} done  ✗ ${snapshot().swarm.failedCount} failed  · $${snapshot().swarm.totalCost.toFixed(4)}  · ${snapshot().threads.totalMessages} msgs (#${snapshot().threads.headSeq})  · ${snapshot().attention.length} attn`);
				insertNode(_el$20, _el$21);
				setProp(_el$20, "marginTop", 1);
				setProp(_el$20, "flexDirection", "column");
				setProp(_el$21, "attributes", 1);
				insert(_el$21, () => t(I18N.cockpit.attentionQueue, lang()));
				insert(_el$20, createComponent(Show, {
					get when() {
						return snapshot().attention.length > 0;
					},
					get fallback() {
						return (() => {
							var _el$47 = createElement("text");
							insert(_el$47, () => t(I18N.cockpit.noAttentionItems, lang()));
							effect((_$p) => setProp(_el$47, "fg", muted(), _$p));
							return _el$47;
						})();
					},
					get children() {
						return createComponent(For, {
							get each() {
								return snapshot().attention.slice(0, 6);
							},
							children: (item) => {
								const refs = [item.seq !== void 0 ? `#${item.seq}` : void 0, item.stepKey ? `step=${item.stepKey}` : void 0].filter(Boolean).join(" ");
								const badge = formatAttentionBadge(item.category);
								const tone = item.category === "decision" || item.category === "failure" ? errFg() : accent();
								return (() => {
									var _el$48 = createElement("text");
									setProp(_el$48, "fg", tone);
									insert(_el$48, () => `  [${badge}] ${refs ? `${refs} ` : ""}@${item.agent}: ${item.detail.slice(0, 56)}`);
									return _el$48;
								})();
							}
						});
					}
				}), null);
				insertNode(_el$22, _el$23);
				setProp(_el$22, "marginTop", 1);
				setProp(_el$22, "flexDirection", "column");
				setProp(_el$23, "attributes", 1);
				insert(_el$23, () => t(I18N.cockpit.outcomeThreads, lang()));
				insert(_el$22, createComponent(Show, {
					get when() {
						return snapshot().threads.groups.length > 0;
					},
					get fallback() {
						return (() => {
							var _el$49 = createElement("text");
							insert(_el$49, () => t(I18N.cockpit.noThreads, lang()));
							effect((_$p) => setProp(_el$49, "fg", muted(), _$p));
							return _el$49;
						})();
					},
					get children() {
						return createComponent(For, {
							get each() {
								return snapshot().threads.groups.slice(0, 4);
							},
							children: (group) => (() => {
								var _el$50 = createElement("box"), _el$51 = createElement("text");
								insertNode(_el$50, _el$51);
								setProp(_el$50, "flexDirection", "column");
								setProp(_el$51, "attributes", 1);
								insert(_el$51, () => `  ▸ ${group.goal} [#${group.latestSeq} · ${group.statusTag}]`);
								insert(_el$50, createComponent(For, {
									get each() {
										return group.threads.slice(0, 3);
									},
									children: (thread) => (() => {
										var _el$52 = createElement("box"), _el$53 = createElement("text");
										insertNode(_el$52, _el$53);
										setProp(_el$52, "flexDirection", "column");
										insert(_el$53, () => `    ├─ ${thread.channel}/${thread.threadId} (#${thread.latestSeq} · ${thread.statusTag})`);
										insert(_el$52, createComponent(For, {
											get each() {
												return thread.workstreams.slice(0, 3);
											},
											children: (ws) => {
												const latestMsg = ws.messages[ws.messages.length - 1];
												const ephBadge = ws.ephemeral ? ` [eph:${ws.ephemeral.role}->${ws.ephemeral.baseAgent}:${ws.ephemeral.status}]` : "";
												const stepRef = ws.stepKey ? ` step=${ws.stepKey}` : "";
												const bodyPreview = latestMsg ? ` #${latestMsg.seq} @${latestMsg.from}: ${latestMsg.body.slice(0, 32)}` : "";
												return (() => {
													var _el$54 = createElement("text");
													insert(_el$54, () => `    │  • ${ws.workstream}${stepRef}${ephBadge} [${ws.statusTag}]${bodyPreview}`);
													effect((_$p) => setProp(_el$54, "fg", fg(), _$p));
													return _el$54;
												})();
											}
										}), null);
										effect((_$p) => setProp(_el$53, "fg", muted(), _$p));
										return _el$52;
									})()
								}), null);
								effect((_$p) => setProp(_el$51, "fg", fg(), _$p));
								return _el$50;
							})()
						});
					}
				}), null);
				insertNode(_el$24, _el$25);
				setProp(_el$24, "marginTop", 1);
				setProp(_el$24, "flexDirection", "column");
				setProp(_el$25, "attributes", 1);
				insert(_el$25, () => t(I18N.cockpit.workersGantt, lang()));
				insert(_el$24, createComponent(Show, {
					get when() {
						return snapshot().swarm.rows.length > 0;
					},
					get fallback() {
						return (() => {
							var _el$55 = createElement("text");
							insert(_el$55, () => t(I18N.cockpit.noSubagents, lang()));
							effect((_$p) => setProp(_el$55, "fg", muted(), _$p));
							return _el$55;
						})();
					},
					get children() {
						return createComponent(For, {
							get each() {
								return snapshot().swarm.rows.slice(0, 12);
							},
							children: (row, idx) => {
								const sel = () => idx() === selectedRow();
								const marker = row.status === "running" ? "●" : row.status === "failed" ? "✗" : "✓";
								return (() => {
									var _el$56 = createElement("box"), _el$57 = createElement("text");
									insertNode(_el$56, _el$57);
									setProp(_el$56, "flexDirection", "column");
									setProp(_el$56, "onMouseDown", stopMouseEvent);
									setProp(_el$56, "onMouseUp", (event) => handleMouseClick(event, () => {
										setSelectedRow(idx());
										setShowDetail((v) => !v);
									}));
									insert(_el$57, () => `${sel() ? "▸" : " "} ${marker} @${row.agent.padEnd(11)} ${row.ganttBar}  ${String(row.durationSec).padStart(5)}s  $${row.cost.toFixed(3)}`);
									insert(_el$56, createComponent(Show, {
										get when() {
											return memo(() => !!sel())() && showDetail();
										},
										get children() {
											var _el$58 = createElement("text");
											insert(_el$58, () => `    id=${row.id} kind=${row.kind} tokens=${row.tokens} model=${row.model ?? "inherited"}`);
											effect((_$p) => setProp(_el$58, "fg", muted(), _$p));
											return _el$58;
										}
									}), null);
									effect((_$p) => setProp(_el$57, "fg", sel() ? accent() : fg(), _$p));
									return _el$56;
								})();
							}
						});
					}
				}), null);
				effect((_p$) => {
					var _v$5 = fg(), _v$6 = accent(), _v$7 = accent(), _v$8 = accent();
					_v$5 !== _p$.e && (_p$.e = setProp(_el$19, "fg", _v$5, _p$.e));
					_v$6 !== _p$.t && (_p$.t = setProp(_el$21, "fg", _v$6, _p$.t));
					_v$7 !== _p$.a && (_p$.a = setProp(_el$23, "fg", _v$7, _p$.a));
					_v$8 !== _p$.o && (_p$.o = setProp(_el$25, "fg", _v$8, _p$.o));
					return _p$;
				}, {
					e: void 0,
					t: void 0,
					a: void 0,
					o: void 0
				});
				return _el$18;
			}
		}), _el$39);
		insert(_el$, createComponent(Show, {
			get when() {
				return tab() === "flightdeck";
			},
			get children() {
				var _el$26 = createElement("box"), _el$27 = createElement("text"), _el$29 = createElement("text"), _el$30 = createElement("text"), _el$31 = createElement("box"), _el$32 = createElement("text"), _el$33 = createElement("box"), _el$34 = createElement("text"), _el$35 = createElement("box"), _el$36 = createElement("box"), _el$37 = createElement("text");
				insertNode(_el$26, _el$27);
				insertNode(_el$26, _el$29);
				insertNode(_el$26, _el$30);
				insertNode(_el$26, _el$31);
				insertNode(_el$26, _el$33);
				insertNode(_el$26, _el$35);
				setProp(_el$26, "flexDirection", "column");
				setProp(_el$26, "marginTop", 1);
				insertNode(_el$27, createTextNode(`GATE (Safety, Guardrails &amp; Step-Ledger)`));
				setProp(_el$27, "attributes", 1);
				insert(_el$29, () => `  ${snapshot().flightdeck.gateGlyphs}`);
				insert(_el$30, () => `  ${snapshot().flightdeck.gateSummary}`);
				insertNode(_el$31, _el$32);
				setProp(_el$31, "marginTop", 1);
				setProp(_el$31, "flexDirection", "column");
				setProp(_el$32, "attributes", 1);
				insert(_el$32, () => t(I18N.cockpit.stepLedgerTitle, lang()));
				insert(_el$31, createComponent(Show, {
					get when() {
						return snapshot().flightdeck.steps.length > 0;
					},
					get fallback() {
						return (() => {
							var _el$59 = createElement("text");
							insertNode(_el$59, createTextNode(`  (no active step-ledger entries)`));
							effect((_$p) => setProp(_el$59, "fg", muted(), _$p));
							return _el$59;
						})();
					},
					get children() {
						return createComponent(For, {
							get each() {
								return snapshot().flightdeck.steps.slice(0, 6);
							},
							children: (st) => (() => {
								var _el$61 = createElement("text");
								insert(_el$61, () => `  ▸ ${st.stepKey.padEnd(20)} [${st.state.padEnd(11)}] @${st.agent}  ${st.objective.slice(0, 36)}`);
								effect((_$p) => setProp(_el$61, "fg", st.state === "blocked" || st.state === "rolled_back" ? errFg() : success(), _$p));
								return _el$61;
							})()
						});
					}
				}), null);
				insertNode(_el$33, _el$34);
				setProp(_el$33, "marginTop", 1);
				setProp(_el$33, "flexDirection", "column");
				setProp(_el$34, "attributes", 1);
				insert(_el$34, () => t(I18N.cockpit.eventStreamTitle, lang()));
				insert(_el$33, createComponent(Show, {
					get when() {
						return snapshot().flightdeck.logs.length > 0;
					},
					get fallback() {
						return (() => {
							var _el$62 = createElement("text");
							insertNode(_el$62, createTextNode(`  (no bus telemetry events captured yet)`));
							effect((_$p) => setProp(_el$62, "fg", muted(), _$p));
							return _el$62;
						})();
					},
					get children() {
						return createComponent(For, {
							get each() {
								return snapshot().flightdeck.logs.slice(0, 8);
							},
							children: (ev) => (() => {
								var _el$64 = createElement("text");
								insert(_el$64, () => `  [${ev.kind}] @${ev.agent}: ${ev.detail.slice(0, 56)}`);
								effect((_$p) => setProp(_el$64, "fg", ev.severity === "error" ? errFg() : muted(), _$p));
								return _el$64;
							})()
						});
					}
				}), null);
				insertNode(_el$35, _el$36);
				setProp(_el$35, "marginTop", 1);
				setProp(_el$35, "flexDirection", "row");
				setProp(_el$35, "gap", 2);
				insertNode(_el$36, _el$37);
				setProp(_el$36, "onMouseDown", stopMouseEvent);
				setProp(_el$36, "onMouseUp", (event) => handleMouseClick(event, () => cockpitController?.exportReplay()));
				insertNode(_el$37, createTextNode(`[ x Export Replay Trace ]`));
				setProp(_el$37, "attributes", 1);
				insert(_el$35, createComponent(Show, {
					get when() {
						return exportNote();
					},
					children: (note) => (() => {
						var _el$65 = createElement("text");
						insert(_el$65, () => `✓ ${note()}`);
						effect((_$p) => setProp(_el$65, "fg", success(), _$p));
						return _el$65;
					})()
				}), null);
				effect((_p$) => {
					var _v$9 = accent(), _v$0 = fg(), _v$1 = muted(), _v$10 = accent(), _v$11 = accent(), _v$12 = accent();
					_v$9 !== _p$.e && (_p$.e = setProp(_el$27, "fg", _v$9, _p$.e));
					_v$0 !== _p$.t && (_p$.t = setProp(_el$29, "fg", _v$0, _p$.t));
					_v$1 !== _p$.a && (_p$.a = setProp(_el$30, "fg", _v$1, _p$.a));
					_v$10 !== _p$.o && (_p$.o = setProp(_el$32, "fg", _v$10, _p$.o));
					_v$11 !== _p$.i && (_p$.i = setProp(_el$34, "fg", _v$11, _p$.i));
					_v$12 !== _p$.n && (_p$.n = setProp(_el$37, "fg", _v$12, _p$.n));
					return _p$;
				}, {
					e: void 0,
					t: void 0,
					a: void 0,
					o: void 0,
					i: void 0,
					n: void 0
				});
				return _el$26;
			}
		}), _el$39);
		insertNode(_el$39, createTextNode(`────────────────────────────────────────────────────────────────────────`));
		setProp(_el$39, "marginTop", 1);
		insertNode(_el$41, createTextNode(`1-3 tabs · Tab/Shift+Tab switch · ↑↓ select · Enter detail · x replay · r refresh · Esc/q close`));
		effect((_p$) => {
			var _v$13 = accent(), _v$14 = fg(), _v$15 = muted(), _v$16 = muted(), _v$17 = muted(), _v$18 = muted();
			_v$13 !== _p$.e && (_p$.e = setProp(_el$4, "fg", _v$13, _p$.e));
			_v$14 !== _p$.t && (_p$.t = setProp(_el$6, "fg", _v$14, _p$.t));
			_v$15 !== _p$.a && (_p$.a = setProp(_el$8, "fg", _v$15, _p$.a));
			_v$16 !== _p$.o && (_p$.o = setProp(_el$1, "fg", _v$16, _p$.o));
			_v$17 !== _p$.i && (_p$.i = setProp(_el$39, "fg", _v$17, _p$.i));
			_v$18 !== _p$.n && (_p$.n = setProp(_el$41, "fg", _v$18, _p$.n));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0,
			o: void 0,
			i: void 0,
			n: void 0
		});
		return _el$;
	})();
}
function plainReturnRoute(cur) {
	if (!cur || typeof cur.type !== "string") return void 0;
	if (cur.type === "session" && typeof cur.sessionID === "string") return {
		type: "session",
		sessionID: cur.sessionID
	};
	if (cur.type === "home") return { type: "home" };
}
function setupPantheonCockpit(context, resolveCwd) {
	const ui = context?.ui;
	if (typeof ui?.router?.register === "function") try {
		ui.router.register({
			name: ROUTE_NAME$1,
			render: ({ data }) => {
				const ret = data?.returnRoute;
				const onClose = () => {
					if (ret) ui.router.navigate(ret);
					else ui.router.navigate({ type: "home" });
				};
				return createComponent(CockpitView, {
					context,
					get workspaceDir() {
						return resolveCwd();
					},
					get sessionID() {
						return memo(() => !!(ret && ret.type === "session"))() ? ret.sessionID : void 0;
					},
					onClose
				});
			}
		});
		routerReady = true;
	} catch {
		routerReady = false;
	}
	const routeGated = () => {
		try {
			const r = ui?.router?.current?.();
			return r?.type === "plugin" && r.name === ROUTE_NAME$1;
		} catch {
			return false;
		}
	};
	const commands = [
		{
			id: "pantheon.cockpit.tab1",
			title: "Overview tab",
			bind: "1",
			run: () => {
				cockpitController?.setTab("overview");
			}
		},
		{
			id: "pantheon.cockpit.tab2",
			title: "Swarm tab",
			bind: "2",
			run: () => {
				cockpitController?.setTab("swarm");
			}
		},
		{
			id: "pantheon.cockpit.tab3",
			title: "Flightdeck tab",
			bind: "3",
			run: () => {
				cockpitController?.setTab("flightdeck");
			}
		},
		{
			id: "pantheon.cockpit.next",
			title: "Next Cockpit tab",
			bind: "tab",
			run: () => {
				cockpitController?.nextTab();
			}
		},
		{
			id: "pantheon.cockpit.prev",
			title: "Previous Cockpit tab",
			bind: "shift+tab",
			run: () => {
				cockpitController?.prevTab();
			}
		},
		{
			id: "pantheon.cockpit.up",
			title: "Previous row",
			bind: "up,k",
			run: () => {
				cockpitController?.moveRow(-1);
			}
		},
		{
			id: "pantheon.cockpit.down",
			title: "Next row",
			bind: "down,j",
			run: () => {
				cockpitController?.moveRow(1);
			}
		},
		{
			id: "pantheon.cockpit.detail",
			title: "Toggle row detail",
			bind: "enter",
			run: () => {
				cockpitController?.toggleDetail();
			}
		},
		{
			id: "pantheon.cockpit.export",
			title: "Export Flightdeck replay trace",
			bind: "x",
			run: () => {
				cockpitController?.exportReplay();
			}
		},
		{
			id: "pantheon.cockpit.refresh",
			title: "Refresh Cockpit",
			bind: "r",
			run: () => {
				cockpitController?.refresh();
			}
		},
		{
			id: "pantheon.cockpit.close",
			title: "Close Cockpit",
			bind: "escape,q",
			run: () => {
				cockpitController?.close();
			}
		}
	];
	try {
		context.keymap?.layer?.(() => ({
			mode: ROUTE_MODE$1,
			priority: 1,
			enabled: () => routeGated() || cockpitOpen(),
			commands
		}));
		context.keymap?.layer?.(() => ({
			mode: "global",
			priority: 1,
			enabled: () => cockpitOpen(),
			commands
		}));
	} catch {}
}
function openPantheonCockpit(context, workspaceDir) {
	const ui = context?.ui;
	if (routerReady && typeof ui?.router?.navigate === "function") {
		let returnRoute;
		try {
			const cur = ui.router.current();
			if (!(cur?.type === "plugin" && cur.name === ROUTE_NAME$1)) returnRoute = plainReturnRoute(cur);
		} catch {
			returnRoute = void 0;
		}
		ui.router.navigate({
			type: "plugin",
			name: ROUTE_NAME$1,
			...returnRoute ? { data: { returnRoute } } : {}
		});
		return;
	}
	try {
		const curSid = ui?.router?.current?.()?.type === "session" ? ui.router.current().sessionID : void 0;
		ui?.dialog?.show?.(() => createComponent(CockpitView, {
			context,
			workspaceDir,
			sessionID: curSid,
			onClose: () => ui?.dialog?.clear?.()
		}), () => {});
		ui?.dialog?.set?.({
			size: "large",
			centered: true
		});
	} catch {}
}
//#endregion
//#region src/context-gauge.ts
const CONTEXT_BAR_CELLS = 12;
const CONTEXT_BAR_FILLED_CELL = "▰";
const CONTEXT_BAR_EMPTY_CELL = "▱";
const BAR_SHAPES = {
	block: {
		filled: "▰",
		empty: "▱",
		mark: "│"
	},
	line: {
		filled: "━",
		empty: "─",
		mark: "┼"
	},
	smooth: {
		filled: "█",
		empty: "░",
		mark: "┆"
	},
	ascii: {
		filled: "=",
		empty: "-",
		mark: "|"
	},
	dots: {
		filled: "●",
		empty: "○",
		mark: "│"
	},
	braille: {
		filled: "⣿",
		empty: "⣀",
		mark: "⡇"
	}
};
function numberOrNull$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function contextUsageTone(percent) {
	if (percent > 90) return "error";
	if (percent > 50) return "warning";
	if (percent > 25) return "success";
	return "info";
}
function formatTokenCount(tokens) {
	const value = numberOrNull$1(tokens);
	if (value === null || value < 0) return null;
	return Math.round(value).toLocaleString("en-US");
}
function formatContextWindow(limit) {
	const value = numberOrNull$1(limit);
	if (value === null || value <= 0) return null;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${Math.floor(value / 1e3)}K`;
	return `${Math.floor(value)}`;
}
function contextBarFilled(percent, cells = 12) {
	const total = Math.max(1, Math.floor(cells));
	const filled = Math.round(percent / 100 * total);
	if (!Number.isFinite(filled)) return 0;
	return Math.min(total, Math.max(0, filled));
}
function contextBar(percent, options = 12) {
	const value = numberOrNull$1(percent);
	if (value === null) return null;
	const total = Math.max(1, Math.floor(typeof options === "number" ? options : options?.cells ?? 12));
	const shapeKey = typeof options === "object" && options?.shape && options.shape in BAR_SHAPES ? options.shape : "block";
	const glyphs = BAR_SHAPES[shapeKey] ?? BAR_SHAPES.block;
	const evenMark = typeof options === "object" ? Boolean(options?.evenMark) : false;
	const filledCount = contextBarFilled(value, total);
	const emptyCount = total - filledCount;
	if (!evenMark || total < 4) return {
		filled: glyphs.filled.repeat(filledCount),
		empty: glyphs.empty.repeat(emptyCount)
	};
	const mid = Math.floor(total / 2);
	const mark = glyphs.mark ?? "|";
	if (filledCount <= mid) {
		const emptyBefore = mid - filledCount;
		const emptyAfter = Math.max(0, emptyCount - emptyBefore - 1);
		return {
			filled: glyphs.filled.repeat(filledCount),
			empty: `${glyphs.empty.repeat(emptyBefore)}${mark}${glyphs.empty.repeat(emptyAfter)}`
		};
	}
	const filledBefore = mid;
	const filledAfter = Math.max(0, filledCount - filledBefore - 1);
	return {
		filled: `${glyphs.filled.repeat(filledBefore)}${mark}${glyphs.filled.repeat(filledAfter)}`,
		empty: glyphs.empty.repeat(emptyCount)
	};
}
function formatSpent(cost) {
	const value = numberOrNull$1(cost);
	if (value === null || value < 0) return null;
	return `$${value.toFixed(2)}`;
}
//#endregion
//#region src/model-usage-limits.ts
/** Shared bounds for cached recent model-usage aggregation. */
const MODEL_USAGE_VISIBLE_CEILING = 3;
const MODEL_USAGE_MESSAGE_LIMIT = 400;
const MODEL_USAGE_SESSION_LIMIT = 8;
//#endregion
//#region src/autonomy-state.ts
const DEFAULT_GOAL_LOOP_PREFS = {
	enabled: false,
	cooldownMs: 5e3,
	maxContinuations: 25
};
const GOAL_LOOP_ENABLED_CYCLE = Object.freeze(["enabled", "disabled"]);
const MAX_CONTINUATIONS_CYCLE = Object.freeze([
	"10",
	"25",
	"50",
	"100",
	"200"
]);
const COOLDOWN_MS_CYCLE = Object.freeze([
	"1000",
	"2000",
	"5000",
	"10000"
]);
const DEFAULT_DECISION_BUDGETS = {
	monthlyUsd: 5,
	perDecisionUsd: .1
};
/** Format USD compactly for a cycler cell ("$5", "$0.10"). */
function formatUsd(value) {
	return `$${value < 1 ? value.toFixed(2) : String(Math.round(value))}`;
}
/** Build the USD step ladder used by the budget cyclers. */
const MONTHLY_USD_CYCLE = Object.freeze([
	1,
	2,
	5,
	10,
	20,
	50,
	100
].map((value) => formatUsd(value)));
const PER_DECISION_USD_CYCLE = Object.freeze([
	.01,
	.025,
	.05,
	.1,
	.25,
	.5,
	1
].map((value) => formatUsd(value)));
/** Parse a staged USD cell back to a number; junk keeps the input. */
function parseUsd(cell) {
	const value = Number(cell.replace("$", ""));
	return Number.isFinite(value) && value > 0 ? value : null;
}
function buildAutonomyTab(input) {
	const isPt = input.languagePref === "pt-BR";
	return {
		id: "autonomy",
		title: isPt ? "Autonomia" : "Autonomy",
		groups: [
			{
				title: isPt ? "Loop Contínuo (auto-continuação de sessões multi-turn)" : "Auto-Continue Loop (multi-turn session auto-continuation)",
				rows: [
					{
						id: "autonomy.goal_loop.enabled",
						name: isPt ? "Loop Contínuo" : "Auto-Continue Loop",
						value: input.goalLoop.enabled ? "enabled" : "disabled",
						cycle: GOAL_LOOP_ENABLED_CYCLE,
						note: isPt ? "continua tarefas multi-turn quando a sessão fica ociosa" + (input.goalLoopRestartPending ? " · [!] reinício necessário para aplicar (restart)" : " · aplicado após reiniciar o OpenCode") : "auto-continues multi-turn tasks when session goes idle" + (input.goalLoopRestartPending ? " · [!] restart required to apply" : " · applies after OpenCode restart")
					},
					{
						id: "autonomy.goal_loop.maxContinuations",
						name: isPt ? "Limite continuações" : "Max continuations",
						value: String(input.goalLoop.maxContinuations),
						cycle: MAX_CONTINUATIONS_CYCLE,
						note: isPt ? "1..200 — teto de segurança contra loops infinitos" : "1..200 — safety ceiling to prevent runaway tasks"
					},
					{
						id: "autonomy.goal_loop.cooldownMs",
						name: isPt ? "Pausa entre turnos (ms)" : "Cooldown (ms)",
						value: String(input.goalLoop.cooldownMs),
						cycle: COOLDOWN_MS_CYCLE,
						note: isPt ? "intervalo entre turnos autônomos (mín 1000ms)" : "delay between autonomous turns (min 1000ms)"
					}
				]
			},
			{
				title: isPt ? "Orçamentos de Decisão (Jev)" : "Decision Budgets (Jev)",
				rows: [{
					id: "autonomy.budget.monthly",
					name: isPt ? "Teto Mensal (USD)" : "Monthly Budget Cap",
					value: formatUsd(input.budgets.monthlyUsd),
					cycle: MONTHLY_USD_CYCLE,
					note: isPt ? "teto mensal em USD para arbitragem do Jev" : "monthly USD ceiling for gated arbitrator decisions"
				}, {
					id: "autonomy.budget.perDecision",
					name: isPt ? "Teto por Consulta" : "Per-Decision Cap",
					value: formatUsd(input.budgets.perDecisionUsd),
					cycle: PER_DECISION_USD_CYCLE,
					note: isPt ? "teto de custo por decisão — acima disso é recusada" : "price cap — gated decisions above this are refused"
				}]
			},
			{
				title: isPt ? "Gradiente de Decisão (política de referência · governado por J1 e Orçamentos)" : "Decision Gradient (reference policy · governed by J1 & Budgets)",
				rows: [
					{
						id: "autonomy.gradient.solo",
						name: isPt ? "Decisão solo" : "Decide solo",
						value: isPt ? "autônomo" : "autonomous",
						note: isPt ? "ações rotineiras de baixo risco · reversível sem travas (sem portão)" : "reversible & low-risk edits, routine fixes (no gate)"
					},
					{
						id: "autonomy.gradient.jev",
						name: isPt ? "Decisão Jev" : "Jev decides",
						value: isPt ? "arbitrado" : "arbitrated",
						note: isPt ? "ambiguidade de tipos e rotas · configurado nos Tetos de Orçamento acima" : "typed ambiguity & candidate ranking · configured via Budgets above"
					},
					{
						id: "autonomy.gradient.human",
						name: isPt ? "Aprovação humana" : "Human decides",
						value: isPt ? "revisão humana" : "human review",
						note: isPt ? "ações destrutivas e de alto risco · configurado no limiar do Portão J1" : "high-risk & destructive operations · configured via J1 Gate"
					}
				]
			}
		]
	};
}
//#endregion
//#region src/decision-router-state.ts
/**
* decision-router-state.ts — the Decision Model section of the settings window.
*
* TUI-local replica of the user-level decision-router config
* (scripts/install/decision-router-config.mjs — the bundle must stay
* self-contained); tests/tui-decision-router-state.test.mjs pins the schema
* version, the exact key set and the provider matrix against that source.
*
* The runtime re-reads this file on EVERY gated call (jev-decision-tool.ts),
* so a write here applies live — no restart. The strict exact-key schema is
* load-bearing: any unknown key fail-closes the runtime to disabled/local,
* so the writer validates before persisting.
*
* Egress consent is CLI-owned: the window never writes `egress_consent`, and
* refuses to enable the router while remote candidates exist without it.
*/
const DECISION_ENABLED_CYCLE = Object.freeze(["enabled", "disabled"]);
/** Exact top-level key set — anything else fail-closes the runtime. */
const DECISION_CONFIG_KEYS = Object.freeze([
	"egress_consent",
	"enabled",
	"enabled_candidates",
	"schema_version",
	"selection"
]);
const DEFAULT_DECISION_CONFIG = Object.freeze({
	schema_version: 2,
	enabled: false,
	selection: Object.freeze({ mode: "local" }),
	egress_consent: false,
	enabled_candidates: Object.freeze([])
});
/** The runtime's provider→model matrix (drift-pinned against the installer source). */
const DECISION_KNOWN_PROVIDERS = Object.freeze([
	"openai-decisions",
	"typesafe-jev",
	"opencode-console-jev",
	"openrouter-jev",
	"vercel-gateway-jev",
	"cloudflare-workers-jev"
]);
const DECISION_CONSENT_CYCLE = Object.freeze(["not granted", "granted"]);
/** provider → model, straight from the runtime matrix (drift-pinned in tests). */
const DECISION_KNOWN_MODELS = Object.freeze({
	"openai-decisions": "gpt-6-luna",
	"typesafe-jev": "jev-1.14.0",
	"opencode-console-jev": "jev-1.13",
	"openrouter-jev": "typesafe/jev-1.13",
	"vercel-gateway-jev": "typesafe-ai/jev",
	"cloudflare-workers-jev": "clef"
});
/**
* Credential surface per provider: the ENV VAR the host provider entry reads
* (`{env:VAR}` indirection — the window NEVER holds key values) plus the setup
* note. Drift-pinned against the installer/runtime sources in tests.
*/
const DECISION_PROVIDER_CREDENTIALS = Object.freeze({
	"openai-decisions": {
		note: "host-configured model — provision via `decision-router setup-model openai-decisions`",
		notePt: "modelo do host — configure via `decision-router setup-model openai-decisions`"
	},
	"typesafe-jev": {
		env: "TYPESAFE_API_KEY",
		note: "export TYPESAFE_API_KEY=… then restart",
		notePt: "export TYPESAFE_API_KEY=… e depois reinicie"
	},
	"opencode-console-jev": {
		note: "rides your OpenCode login — no separate key",
		notePt: "utiliza login do OpenCode — sem chave separada"
	},
	"openrouter-jev": {
		env: "OPENROUTER_API_KEY",
		note: "export OPENROUTER_API_KEY=… then restart",
		notePt: "export OPENROUTER_API_KEY=… e depois reinicie"
	},
	"vercel-gateway-jev": {
		env: "AI_GATEWAY_API_KEY",
		note: "export AI_GATEWAY_API_KEY=… then restart",
		notePt: "export AI_GATEWAY_API_KEY=… e depois reinicie"
	},
	"cloudflare-workers-jev": {
		env: "CLOUDFLARE_API_TOKEN",
		note: "needs accountId (setup-model --account-id=…) + CLOUDFLARE_API_TOKEN",
		notePt: "requer accountId (setup-model --account-id=…) + CLOUDFLARE_API_TOKEN"
	}
});
const DECISION_TARGET_CYCLE = Object.freeze(DECISION_KNOWN_PROVIDERS.map((provider) => `${provider}/${DECISION_KNOWN_MODELS[provider]}`));
function decisionRouterConfigPath(env = process.env) {
	const xdg = env.XDG_CONFIG_HOME;
	const home = env.HOME ?? "";
	const root = xdg ?? join(home, ".config");
	return join(root, "pantheon", "decision-router.json");
}
/** Fail-open read: a missing file is the default; an invalid one is reported, not guessed. */
function readDecisionRouterConfig(env = process.env) {
	let raw;
	try {
		raw = JSON.parse(readFileSync(decisionRouterConfigPath(env), "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return {
			config: cloneDefault(),
			corrupt: false
		};
		return {
			config: cloneDefault(),
			corrupt: true
		};
	}
	if (isValidDecisionConfig(raw)) return {
		config: raw,
		corrupt: false
	};
	return {
		config: cloneDefault(),
		corrupt: true
	};
}
function cloneDefault() {
	return {
		schema_version: DEFAULT_DECISION_CONFIG.schema_version,
		enabled: DEFAULT_DECISION_CONFIG.enabled,
		selection: { ...DEFAULT_DECISION_CONFIG.selection },
		egress_consent: DEFAULT_DECISION_CONFIG.egress_consent,
		enabled_candidates: [...DEFAULT_DECISION_CONFIG.enabled_candidates]
	};
}
/** The exact-key, exact-shape validation the runtime applies (fail-closed otherwise). */
function isValidDecisionConfig(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value;
	const keys = Object.keys(record).sort();
	if (keys.length !== DECISION_CONFIG_KEYS.length) return false;
	for (const key of DECISION_CONFIG_KEYS) if (!keys.includes(key)) return false;
	if (record.schema_version !== 2) return false;
	if (typeof record.enabled !== "boolean") return false;
	if (typeof record.egress_consent !== "boolean") return false;
	if (!isValidSelection(record.selection)) return false;
	if (!Array.isArray(record.enabled_candidates)) return false;
	for (const candidate of record.enabled_candidates) {
		if (typeof candidate !== "object" || candidate === null) return false;
		const entry = candidate;
		if (typeof entry.provider !== "string" || typeof entry.model !== "string") return false;
		if (Object.keys(entry).length !== 2) return false;
	}
	return true;
}
function isValidSelection(value) {
	if (typeof value !== "object" || value === null) return false;
	const selection = value;
	if (selection.mode !== "local" && selection.mode !== "auto" && selection.mode !== "explicit") return false;
	const keys = Object.keys(selection).sort();
	for (const key of keys) if (key !== "mode" && key !== "provider" && key !== "model") return false;
	if (selection.provider !== void 0 && typeof selection.provider !== "string") return false;
	if (selection.model !== void 0 && typeof selection.model !== "string") return false;
	return true;
}
/** Stable serializer: exact keys in sorted order, 2-space, trailing newline. */
function serializeDecisionConfig(config) {
	const ordered = {
		egress_consent: config.egress_consent,
		enabled: config.enabled,
		enabled_candidates: config.enabled_candidates.map((candidate) => ({
			model: candidate.model,
			provider: candidate.provider
		})),
		schema_version: config.schema_version,
		selection: {
			mode: config.selection.mode,
			...config.selection.model !== void 0 ? { model: config.selection.model } : {},
			...config.selection.provider !== void 0 ? { provider: config.selection.provider } : {}
		}
	};
	return `${JSON.stringify(ordered, null, 2)}\n`;
}
/**
* Enable/disable the router in a config copy. The guard mirrors the runtime's
* fail-close: with remote candidates and no egress consent, an enabled flag
* would be a lie — enabling requires consent, or a local-only selection.
* Never touches `egress_consent` (CLI-owned).
*/
function setDecisionEnabled(config, enabled) {
	if (enabled) {
		if (!(config.selection.mode === "local" || config.enabled_candidates.length === 0) && !config.egress_consent) return {
			ok: false,
			reason: "remote candidates need egress consent — toggle Egress consent in this tab, then enable"
		};
	}
	return {
		ok: true,
		config: {
			...config,
			enabled
		}
	};
}
/** Atomic-ish write mirroring the canonical writer's privacy posture (0600). */
function writeDecisionRouterConfig(config, env = process.env) {
	if (!isValidDecisionConfig(config)) throw new TypeError("Refusing to persist an invalid decision-router configuration");
	const path = decisionRouterConfigPath(env);
	mkdirSync(dirname(path), {
		recursive: true,
		mode: 448
	});
	const temp = `${path}.tui.tmp`;
	writeFileSync(temp, serializeDecisionConfig(config), { mode: 384 });
	renameSync(temp, path);
	chmodSync(path, 384);
}
const DECISION_SELECTION_CYCLE = Object.freeze([
	"local",
	"auto",
	"explicit"
]);
/** Stage a selection/consent row into a config copy; unknown rows are no-ops. */
function applyDecisionRow(config, id, value) {
	const next = {
		...config,
		selection: { ...config.selection },
		enabled_candidates: [...config.enabled_candidates]
	};
	switch (id) {
		case "decision.selection.mode": {
			const mode = value;
			if (mode !== "local" && mode !== "auto" && mode !== "explicit") return config;
			next.selection.mode = mode;
			if (mode === "local") next.enabled_candidates = [];
			return next;
		}
		case "decision.selection.target": {
			const separator = value.indexOf("/");
			if (separator <= 0) return config;
			const provider = value.slice(0, separator);
			const model = value.slice(separator + 1);
			if (!DECISION_KNOWN_PROVIDERS.includes(provider)) return config;
			if (DECISION_KNOWN_MODELS[provider] !== model) return config;
			next.selection = {
				mode: "explicit",
				provider,
				model
			};
			next.enabled_candidates = [{
				provider,
				model
			}];
			return next;
		}
		case "decision.consent":
			next.egress_consent = value === "granted";
			return next;
		default: return config;
	}
}
/** Provider ids as they appear in the host auth store / config providers. */
const PROVIDER_AUTH_NAMES = Object.freeze({
	"openai-decisions": Object.freeze(["openai"]),
	"typesafe-jev": Object.freeze(["typesafe-ai"]),
	"opencode-console-jev": Object.freeze([]),
	"openrouter-jev": Object.freeze(["openrouter"]),
	"vercel-gateway-jev": Object.freeze(["vercel-ai-gateway", "vercel"]),
	"cloudflare-workers-jev": Object.freeze(["cloudflare-workers-ai"])
});
/**
* TWO recognition forms (field feedback beta.6: keys registered via
* `opencode auth login` showed MISSING because only env vars were checked):
* env var set → 'env'; provider present in the host auth store → 'auth
* store'; provider entry in opencode.json providers → 'config'. Values are
* NEVER read — existence only.
*/
function credentialStatus(provider, env, authProviders, configProviders) {
	const credential = DECISION_PROVIDER_CREDENTIALS[provider];
	if (credential?.env !== void 0 && env[credential.env]) return "env";
	for (const name of PROVIDER_AUTH_NAMES[provider] ?? []) if (authProviders.has(name)) return "auth store";
	for (const name of PROVIDER_AUTH_NAMES[provider] ?? []) if (configProviders.has(name)) return "config";
	if (provider === "opencode-console-jev") return "auth store";
	return "missing";
}
function buildDecisionTab(read, env = process.env, authProviders = /* @__PURE__ */ new Set(), configProviders = /* @__PURE__ */ new Set(), languagePref) {
	const isPt = languagePref === "pt-BR";
	const { config, corrupt } = read;
	const rows = [{
		id: "decision.enabled",
		name: isPt ? "Assistente Jev" : "Jev Assistant",
		value: config.enabled ? "enabled" : "disabled",
		...corrupt ? {} : { cycle: DECISION_ENABLED_CYCLE },
		note: corrupt ? isPt ? "config inválida — runtime fail-closes; repare via `decision-router setup-model`" : "config unreadable/invalid — runtime fail-closes; repair via `decision-router setup-model`" : isPt ? "aplica em tempo real — arbitragem de decisões relida a cada chamada" : "applies live — the runtime re-reads this on every gated call"
	}, {
		id: "decision.selection.mode",
		name: isPt ? "Modo de Operação" : "Operation Mode",
		value: config.selection.mode,
		...corrupt ? {} : { cycle: DECISION_SELECTION_CYCLE },
		note: isPt ? "local = no seu PC (grátis); auto/explícito = modelo nuvem (OpenRouter)" : "local routes on-device; auto/explicit pick a remote decision model"
	}];
	const explicitTarget = config.selection.provider ? `${config.selection.provider}/${config.selection.model ?? ""}` : DECISION_TARGET_CYCLE[0] ?? "openrouter-jev/typesafe/jev-1.13";
	rows.push({
		id: "decision.selection.target",
		name: isPt ? "Modelo de Decisão" : "Decision Model",
		value: config.selection.mode === "local" ? config.selection.provider ? `${config.selection.provider}/${config.selection.model ?? ""}` : "local (on-device)" : explicitTarget,
		...corrupt ? {} : { cycle: DECISION_TARGET_CYCLE },
		note: isPt ? config.selection.mode === "local" ? "ciclar seleciona modelo remoto e ativa modo explícito" : "provedor/modelo ativo — define candidato para arbitragem" : config.selection.mode === "local" ? "cycle to select a remote model and activate explicit mode" : "provider/model — sets the candidate list"
	});
	if ((config.enabled_candidates?.length ?? 0) > 0) rows.push({
		id: "decision.candidates",
		name: isPt ? "Candidatos ativos" : "Candidates",
		value: String(config.enabled_candidates.length),
		note: config.egress_consent ? config.enabled_candidates.map((candidate) => `${candidate.provider}/${candidate.model}`).join(", ") : isPt ? "egress consent NÃO concedido — rotas remotas bloqueadas" : "egress consent NOT granted — remote routes fail closed"
	});
	rows.push({
		id: "decision.consent",
		name: isPt ? "Acesso à Nuvem" : "Cloud API Access",
		value: config.egress_consent ? "granted" : "not granted",
		...corrupt ? {} : { cycle: DECISION_CONSENT_CYCLE },
		note: isPt ? config.egress_consent ? "granted = rotas remotas podem consultar gateway de API (com teto de custo)" : "not granted = chamadas remotas bloqueadas; requer granted para nuvem" : config.egress_consent ? "granted = remote decision routes may call their gateway (budget-capped)" : "not granted = remote routes fail closed; grant to allow cloud calls"
	});
	return {
		id: "decision",
		title: isPt ? "Decisão" : "Decision",
		groups: [{
			title: isPt ? "Assistente de Decisão (Jev)" : "Decision Assistant (Jev)",
			rows
		}, {
			title: isPt ? "Credenciais (status apenas — valores nunca gravados na janela)" : "Credentials (status only — values never enter the window)",
			rows: DECISION_KNOWN_PROVIDERS.map((provider) => {
				const status = credentialStatus(provider, env, authProviders, configProviders);
				const credential = DECISION_PROVIDER_CREDENTIALS[provider] ?? { note: "" };
				return {
					id: `decision.key.${provider}`,
					name: provider,
					value: status === "missing" ? "MISSING" : status,
					note: isPt ? credential.notePt ?? credential.note : credential.note
				};
			})
		}]
	};
}
//#endregion
//#region src/pantheon-settings-state.ts
/** Mirrors routing.yml `behaviors:` — drift-pinned by the registry test. */
const SETTINGS_BEHAVIORS = Object.freeze([
	{
		id: "skill-auto-continue",
		kind: "install",
		title: "Auto-continue skill",
		description: "Continue multi-step todos while keeping safety gates."
	},
	{
		id: "skill-tdd-with-agents",
		kind: "install",
		title: "TDD with agents skill",
		description: "RED, GREEN, REFACTOR test-driven implementation."
	},
	{
		id: "skill-code-review-checklist",
		kind: "install",
		title: "Code review checklist skill",
		description: "Systematic code review and quality gates."
	},
	{
		id: "skill-prompt-refinery",
		kind: "install",
		title: "Prompt refinery skill",
		description: "Vague requests refined — silent adjust, >> full contract."
	},
	{
		id: "gate-idle-todo-enforcer",
		kind: "runtime",
		title: "Idle todo enforcer",
		description: "Continues pending todos when a session goes idle."
	},
	{
		id: "gate-context-pruner",
		kind: "runtime",
		title: "Context pruner",
		description: "Prunes repeated tool output before summarization."
	},
	{
		id: "gate-j1-risk-gate",
		kind: "runtime",
		title: "J1 risk gate",
		description: "High-risk tool calls demand explicit human approval."
	}
]);
new Set(SETTINGS_BEHAVIORS.map((b) => b.id));
function isBehaviorDisabled(effective, id) {
	return effective[id]?.action === "disable";
}
const TOGGLE_REASON = "toggled in /pantheon-settings";
/**
* Toggle (a targeted write keeps the toggle semantics: a `replace` entry is
* never destroyed — disabling keeps its `content`, re-enabling restores the
* replace; a settings-written disable is removed outright, no toggle noise).
*/
function toggledOverrides(effective, id, reason = TOGGLE_REASON) {
	const next = { ...effective };
	const entry = next[id];
	if (entry?.action === "disable") {
		if (entry.content !== void 0) next[id] = entry.reason === reason ? {
			action: "replace",
			content: entry.content
		} : {
			action: "replace",
			content: entry.content,
			...entry.reason !== void 0 ? { reason: entry.reason } : {}
		};
		else delete next[id];
	} else next[id] = entry?.content !== void 0 ? {
		action: "disable",
		reason,
		content: entry.content
	} : {
		action: "disable",
		reason
	};
	return next;
}
/** Set an explicit on/off target (the cycler's save path) via the toggle semantics. */
function setOverrideState(effective, id, target, reason = TOGGLE_REASON) {
	const disabled = isBehaviorDisabled(effective, id);
	if (target === "disabled" === disabled) return effective;
	return toggledOverrides(effective, id, reason);
}
function serializeOverrides(effective) {
	const ordered = {};
	for (const id of Object.keys(effective).sort()) ordered[id] = effective[id];
	return `${JSON.stringify(ordered, null, 2)}\n`;
}
/** Merge for DISPLAY only, mirroring the runtime precedence: project wins per id. */
function mergedOverrides(load) {
	return {
		...load.global,
		...load.project
	};
}
function canWriteOverrides(load) {
	return !load.corruptGlobal;
}
/** Neutral tab for out-of-range indexes (noUncheckedIndexedAccess guard). */
const EMPTY_TAB = {
	id: "empty",
	title: "",
	groups: []
};
/** Flat, in-order rows of a tab (the up/down navigation space). */
function tabRows(tab) {
	return tab.groups.flatMap((group) => group.rows);
}
function findRow(tab, id) {
	return tabRows(tab).find((row) => row.id === id);
}
/** Step through the cycle with wrap-around; non-cyclable rows return the input. */
function cycleValue(value, cycle, direction) {
	if (cycle.length === 0) return value;
	const index = cycle.indexOf(value);
	if (index === -1) return cycle[0] ?? value;
	return cycle[(index + direction + cycle.length) % cycle.length] ?? value;
}
function stageValue(draft, row, direction) {
	if (row.cycle === void 0) return draft;
	const staged = cycleValue(draft[row.id] ?? row.value, row.cycle, direction);
	if (staged === row.value) {
		if (draft[row.id] === void 0) return draft;
		const next = { ...draft };
		delete next[row.id];
		return next;
	}
	return {
		...draft,
		[row.id]: staged
	};
}
/** Stage an explicit target value for one row (the Defaults action path). */
function stageRowToValue(draft, row, target) {
	if (!row.cycle?.includes(target)) return draft;
	if (target === row.value) {
		if (draft[row.id] === void 0) return draft;
		const next = { ...draft };
		delete next[row.id];
		return next;
	}
	return {
		...draft,
		[row.id]: target
	};
}
/**
* Stage every cyclable row's DEFAULT value of a tab. Rows already at their
* default have their staged entry dropped; rows staged elsewhere keep it
* until the Defaults action targets them.
*/
function stageDefaults(draft, tab) {
	let next = draft;
	for (const row of tabRows(tab)) {
		if (row.cycle === void 0 || row.def === void 0) continue;
		const candidate = next[row.id] ?? row.value;
		if (candidate === row.def) {
			if (next[row.id] !== void 0) {
				const copy = { ...next };
				delete copy[row.id];
				next = copy;
			}
			continue;
		}
		next = stageRowToValue(next, {
			...row,
			value: candidate
		}, row.def);
	}
	return next;
}
/** Drop every staged entry of one tab (ctrl+r). */
function resetTab(draft, tab) {
	const ids = new Set(tabRows(tab).map((row) => row.id));
	const next = {};
	for (const [id, value] of Object.entries(draft)) if (!ids.has(id)) next[id] = value;
	return next;
}
function draftCount(draft) {
	return Object.keys(draft).length;
}
function draftDirty(draft) {
	return draftCount(draft) > 0;
}
function tabDirty(draft, tab) {
	return tabRows(tab).some((row) => draft[row.id] !== void 0);
}
/** Apply every staged entry; failures are collected, never thrown. */
function applyDraft(draft, writer) {
	const applied = [];
	const failed = [];
	for (const [id, value] of Object.entries(draft)) {
		const result = writer(id, value);
		if (result.ok) applied.push(id);
		else failed.push({
			id,
			reason: result.reason ?? "write failed"
		});
	}
	return {
		applied,
		failed
	};
}
/** The rows that succeeded and are still in the draft (failed ones stay staged). */
function settledDraft(draft, applied) {
	const next = {};
	for (const [id, value] of Object.entries(draft)) if (!applied.includes(id)) next[id] = value;
	return next;
}
const GATES_ENABLED_CYCLE = Object.freeze(["enabled", "disabled"]);
const OVERRIDES_SCOPE_CYCLE = Object.freeze(["global", "project"]);
function buildGatesTab(load, languagePref, overridesScope) {
	const isPt = languagePref === "pt-BR";
	const merged = mergedOverrides(load);
	const editingProject = overridesScope === "project";
	const rowFor = (behavior) => {
		const fromProject = load.project[behavior.id] !== void 0;
		const effective = editingProject ? isBehaviorDisabled({
			...load.global,
			...load.project
		}, behavior.id) : isBehaviorDisabled(load.global, behavior.id);
		const writable = editingProject ? true : !fromProject && canWriteOverrides(load);
		return {
			id: `gate.${behavior.id}`,
			name: fromProject ? `${behavior.title} (${isPt ? "projeto" : "project"})` : behavior.title,
			value: (editingProject ? effective : isBehaviorDisabled(merged, behavior.id)) ? "disabled" : "enabled",
			...writable ? { cycle: GATES_ENABLED_CYCLE } : {},
			note: !editingProject && fromProject ? isPt ? "arquivo do projeto tem precedência · edite .pantheon/overrides.json" : "project file wins at runtime — edit .pantheon/overrides.json" : editingProject ? isPt ? "salva em .pantheon/overrides.json (escopo do projeto)" : "saves to .pantheon/overrides.json (project scope)" : behavior.description
		};
	};
	const install = SETTINGS_BEHAVIORS.filter((behavior) => behavior.kind === "install");
	const runtime = SETTINGS_BEHAVIORS.filter((behavior) => behavior.kind === "runtime");
	const groups = [];
	if (overridesScope !== void 0) groups.push({
		title: isPt ? "Escopo das regras" : "Rules Scope",
		rows: [{
			id: "gates.scope",
			name: isPt ? "Escopo de edição" : "Edit scope",
			value: overridesScope,
			cycle: OVERRIDES_SCOPE_CYCLE,
			note: isPt ? "alterne entre global (~/.config/opencode) e projeto (.pantheon)" : "switch between global (~/.config/opencode) and project (.pantheon)"
		}]
	});
	groups.push({
		title: isPt ? "Skills instaladas" : "Install skills",
		rows: install.map(rowFor)
	}, {
		title: isPt ? "Portões de execução" : "Runtime gates",
		rows: runtime.map(rowFor)
	});
	return {
		id: "gates",
		title: "Gates",
		groups
	};
}
function buildAboutTab(version, extra) {
	const isPt = extra?.languagePref === "pt-BR";
	const sysRows = [{
		id: "about.version",
		name: isPt ? "Versão" : "Version",
		value: `v${version}`,
		note: isPt ? "OpenCode 2.x nativo — contrato V1 descontinuado" : "OpenCode 2.x only — the V1 contract is removed"
	}, {
		id: "about.behaviors",
		name: isPt ? "Comportamentos" : "Behaviors",
		value: String(SETTINGS_BEHAVIORS.length),
		note: isPt ? "portões e skills de governança registradas" : "registered governance gates and skills"
	}];
	if (extra?.nodeVersion) sysRows.push({
		id: "about.runtime",
		name: "Runtime Node.js",
		value: `v${extra.nodeVersion}`,
		note: extra.platform ? `${isPt ? "plataforma" : "platform"}: ${extra.platform}` : ""
	});
	const govRows = [
		{
			id: "about.preset",
			name: isPt ? "Predefinição" : "Active Preset",
			value: extra?.preset ?? "none",
			note: isPt ? "modelo global ativo do Pantheon" : "global model preset active in Pantheon"
		},
		{
			id: "about.decision",
			name: isPt ? "Assistente Jev" : "Decision Router",
			value: extra?.decisionEnabled ? isPt ? "ativado" : "enabled" : isPt ? "desativado" : "disabled",
			note: isPt ? "arbitragem de modelos e candidatos" : "model and candidate arbitration"
		},
		{
			id: "about.j1",
			name: isPt ? "Portão J1" : "J1 Risk Gate",
			value: extra?.j1Mode ?? "shadow",
			note: isPt ? "portão de risco de segurança operacional" : "operational safety risk score gate"
		}
	];
	const refRows = [{
		id: "about.license",
		name: isPt ? "Licença" : "License",
		value: "MIT",
		note: "Open source · Pantheon Project"
	}, {
		id: "about.repo",
		name: isPt ? "Repositório" : "Repository",
		value: "ils15/pantheon-opencode",
		note: "github.com/ils15/pantheon-opencode"
	}];
	const toolRows = [
		{
			id: "about.tools.memory",
			name: isPt ? "Memória FTS5" : "FTS5 Memory",
			value: isPt ? "ativo · 6 tools" : "active · 6 tools",
			note: "memory_store, memory_recall, memory_search, memory_forget, memory_list, memory_stats"
		},
		{
			id: "about.tools.persistence",
			name: isPt ? "Checkpoints & Metas" : "Checkpoints & Goals",
			value: isPt ? "ativo · 6 tools" : "active · 6 tools",
			note: "context_save, context_get, goal_create, goal_get, goal_update, goal_done"
		},
		{
			id: "about.tools.codemap",
			name: isPt ? "Codemap & AST" : "Codemap & AST",
			value: isPt ? "ativo · 5 tools" : "active · 5 tools",
			note: "code_index, code_query, code_neighbors, ast_search, ast_rewrite"
		},
		{
			id: "about.tools.edit",
			name: isPt ? "Edição & Execução" : "Edit & Execution",
			value: isPt ? "ativo · 4 tools" : "active · 4 tools",
			note: "hashline_edit, shell, todowrite, todoread"
		},
		{
			id: "about.tools.governance",
			name: isPt ? "Orquestração & Custos" : "Orchestration & Cost",
			value: isPt ? "ativo · 9 tools" : "active · 9 tools",
			note: "pantheon_cost, pantheon_model, pantheon_skill_search, pantheon_deepwork, pantheon_step_ledger, pantheon_agent_forge, pantheon_local_decision, pantheon_review_verdict, pantheon_worktree"
		}
	];
	const groups = [{
		title: isPt ? "Sistema & Plataforma" : "System & Platform",
		rows: sysRows
	}];
	if (extra?.preset !== void 0 || extra?.decisionEnabled !== void 0) groups.push({
		title: isPt ? "Governança & Roteamento" : "Governance & Routing",
		rows: govRows
	});
	groups.push({
		title: isPt ? "Projeto & Referências" : "Project & References",
		rows: refRows
	});
	groups.push({
		title: isPt ? "Ferramentas Nativas (30)" : "Native Tools (30)",
		rows: toolRows
	});
	return {
		id: "about",
		title: isPt ? "Sobre" : "About",
		groups
	};
}
function buildChangelogTab(version, items = [], languagePref) {
	const isPt = languagePref === "pt-BR";
	const rows = [];
	if (items.length > 0) items.forEach((item, index) => {
		rows.push({
			id: `changelog.item.${index + 1}`,
			name: item.title.slice(0, 26),
			value: "",
			note: item.detail
		});
	});
	else rows.push({
		id: "changelog.info",
		name: isPt ? "Versão" : "Release",
		value: `v${version}`,
		note: isPt ? "veja o histórico completo no CHANGELOG.md ou no GitHub" : "view full history in CHANGELOG.md or GitHub releases"
	});
	return {
		id: "changelog",
		title: isPt ? "Changelog" : "Changelog",
		groups: [{
			title: isPt ? `Novidades na versão v${version}` : `What's New in v${version}`,
			rows
		}, {
			title: isPt ? "Referências de Versão" : "Release References",
			rows: [{
				id: "changelog.docs",
				name: isPt ? "Documentação" : "Documentation",
				value: "CHANGELOG.md",
				note: isPt ? "incluído na raiz do plugin e do repositório" : "shipped at plugin root and repository root"
			}, {
				id: "changelog.repo",
				name: isPt ? "Repositório GitHub" : "GitHub Repository",
				value: "ils15/pantheon-opencode",
				note: isPt ? "versões, pull requests e discussões" : "releases, pull requests and discussion"
			}]
		}]
	};
}
//#endregion
//#region src/update-notice.ts
/**
* Update notifier core (TUI-local copy — the bundle must stay self-contained,
* same precedent as cost-data.ts/model-pricing.ts).
*
* Pin + notify, never silent auto-update: one notice per newer version,
* TTL-cached, offline-safe, and a stable install is never advertised a beta
* (the update guard owns that crossing). docs/design/2.0-settings-and-install.md
*/
const UPDATE_CHECK_TTL_MS = 216e5;
const isBetaOrRc = (version) => /-(?:beta|rc)\.\d+$/.test(String(version).trim());
/** True when `latestVersion` is strictly newer and compatible with `currentVersion` channel. */
function isNewerUpdateAvailable(currentVersion, latestVersion) {
	const current = String(currentVersion).trim();
	const latest = String(latestVersion).trim();
	if (!current || !latest) return false;
	if (!isBetaOrRc(current) && isBetaOrRc(latest)) return false;
	return comparePantheonVersions(latest, current) > 0;
}
/** Package specifier matching the running release line (`@beta` on prereleases). */
function packageSpecForVersion(version) {
	return isBetaOrRc(version) ? "pantheon-opencode@beta" : "pantheon-opencode";
}
/** Format a bilingual toast title + message for a newly discovered update. */
function formatUpdateToast(currentVersion, latestVersion, isPt = false) {
	const spec = packageSpecForVersion(currentVersion);
	if (isPt) return {
		title: `Pantheon v${latestVersion} disponível`,
		message: `Atualize em /pantheon-settings (Atualizações) ou \`opencode plugin update ${spec}\``
	};
	return {
		title: `Pantheon v${latestVersion} available`,
		message: `Update in /pantheon-settings (Updates) or \`opencode plugin update ${spec}\``
	};
}
/** Compact persistent badge rendered in Home footer and Sidebar header when an update exists. */
function formatUpdateBadge(currentVersion, latestVersion, options = {}) {
	if (!latestVersion || !isNewerUpdateAvailable(currentVersion, latestVersion)) return null;
	const version = latestVersion.trim().replace(/^v/i, "");
	if (options.compact) return `↑ v${version} (/pantheon-settings)`;
	return options.isPt ? `↑ v${version} disponível · /pantheon-settings` : `↑ v${version} available · /pantheon-settings`;
}
/** Resolve cached newer version from persisted check state (no network call needed). */
function resolveCachedAvailableUpdate(currentVersion, state) {
	if (!state) return null;
	const candidate = state.lastKnownLatestVersion ?? state.lastNotifiedVersion;
	if (!candidate) return null;
	return isNewerUpdateAvailable(currentVersion, candidate) ? candidate : null;
}
/** Stamp `lastKnownLatestVersion` onto an `UpdateCheckState` without altering TTL/notice fields. */
function withKnownLatest(state, latestVersion) {
	if (!latestVersion) return state;
	return {
		...state,
		lastKnownLatestVersion: latestVersion
	};
}
let availableUpdateState = null;
const availableUpdateListeners = /* @__PURE__ */ new Set();
function getAvailableUpdateVersion() {
	return availableUpdateState;
}
function setAvailableUpdateVersion(version) {
	const normalized = version && version.trim() !== "" ? version.trim() : null;
	if (normalized === availableUpdateState) return;
	availableUpdateState = normalized;
	for (const listener of availableUpdateListeners) try {
		listener(availableUpdateState);
	} catch {}
}
function subscribeAvailableUpdate(listener) {
	availableUpdateListeners.add(listener);
	return () => {
		availableUpdateListeners.delete(listener);
	};
}
/** Semver-ish compare for X.Y.Z[-(beta|rc).N]; prereleases sort before their release. */
function comparePantheonVersions(left, right) {
	const parse = (version) => {
		const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)\.(\d+))?$/);
		if (!match) return null;
		const [, major = "", minor = "", patch = "", stage = "", stageNum = ""] = match;
		const stageRank = stage === "beta" ? 1 : stage === "rc" ? 2 : 3;
		return {
			core: [
				+major,
				+minor,
				+patch
			],
			stageRank,
			stageNum: stage !== "" ? +stageNum : Number.POSITIVE_INFINITY
		};
	};
	const a = parse(left);
	const b = parse(right);
	if (!a || !b) return 0;
	const [aMajor, aMinor, aPatch] = a.core;
	const [bMajor, bMinor, bPatch] = b.core;
	if (aMajor !== bMajor) return aMajor - bMajor;
	if (aMinor !== bMinor) return aMinor - bMinor;
	if (aPatch !== bPatch) return aPatch - bPatch;
	if (a.stageRank !== b.stageRank) return a.stageRank - b.stageRank;
	return a.stageNum - b.stageNum;
}
function pickUpdateNotice(input) {
	const { currentVersion, latestVersion, state = {}, nowMs = Date.now(), isPt = false } = input;
	const ttlMs = input.ttlMs ?? 216e5;
	if (nowMs - (state.lastCheckMs ?? 0) < ttlMs) return null;
	if (state.lastNotifiedVersion === latestVersion) return null;
	if (!isNewerUpdateAvailable(currentVersion, latestVersion)) return null;
	return {
		version: latestVersion,
		message: formatUpdateToast(currentVersion, latestVersion, isPt).message
	};
}
/** The state to persist after a check (notified or not) for the TTL. */
function nextCheckState(previous, notice, nowMs) {
	const lastNotifiedVersion = notice?.version ?? previous.lastNotifiedVersion;
	return {
		lastCheckMs: nowMs,
		...lastNotifiedVersion !== void 0 ? { lastNotifiedVersion } : {}
	};
}
//#endregion
//#region src/doctor-state.ts
/**
* doctor-state.ts — the Doctor section of the settings window (read-only).
*
* TUI-local replica (the bundle must stay self-contained — the installed copy
* physically lacks the repo tree, so doctor.mjs itself is unreachable). Only
* the FILE-DERIVABLE checks are mirrored here; everything that spawns
* processes, reads the network, or writes (MCP smoke, python validators, git,
* venv pins, --fix quarantines) stays in the CLI and the section says so.
*
* The install-state path mirrors doctor's checkInstallVersionDrift
* (`<config>/opencode/.pantheon/install-state.json`); the Node floor is
* drift-pinned against scripts/node-engine-policy.mjs by
* tests/tui-doctor-state.test.mjs.
*/
/** Drift-pinned against scripts/node-engine-policy.mjs MIN_SUPPORTED_NODE_VERSION. */
const MIN_SUPPORTED_NODE_VERSION = "26.4.0";
function opencodePantheonDir(env = process.env) {
	const xdg = env.XDG_CONFIG_HOME;
	const home = env.HOME ?? "";
	const root = xdg ?? join(home, ".config");
	return join(root, "opencode", ".pantheon");
}
/**
* H2: the installed package version (install-state) vs the running one.
* Fail-open: a missing/unreadable state file means "unknown", not a failure —
* pre-2.0 installs may not have one.
*/
function classifyInstallVersion(runningVersion, env = process.env) {
	let installed = null;
	try {
		const path = join(opencodePantheonDir(env), "install-state.json");
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (typeof raw?.pantheon_version === "string" && raw.pantheon_version !== "") installed = raw.pantheon_version;
	} catch {
		installed = null;
	}
	if (installed === null) return {
		status: "unknown",
		installed: null
	};
	const compared = comparePantheonVersions(installed, runningVersion);
	if (compared === 0) return {
		status: "ok",
		installed
	};
	return {
		status: compared < 0 ? "older" : "newer",
		installed
	};
}
function isSupportedNodeFloor(version) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+([\w.-]+))?$/.exec(String(version));
	const minimum = /^v?(\d+)\.(\d+)\.(\d+)/.exec(MIN_SUPPORTED_NODE_VERSION);
	if (!match || !minimum) return false;
	const [, major = "", minor = "", patch = "", prerelease = ""] = match;
	if (prerelease !== "") return false;
	const [, minMajor = "0", minMinor = "0", minPatch = "0"] = minimum;
	const currentParts = [
		+major,
		+minor,
		+patch
	];
	const minimumParts = [
		+minMajor,
		+minMinor,
		+minPatch
	];
	for (let index = 0; index < 3; index += 1) {
		const currentPart = currentParts[index] ?? 0;
		const minimumPart = minimumParts[index] ?? 0;
		if (currentPart !== minimumPart) return currentPart > minimumPart;
	}
	return true;
}
/** K: validate both overrides files against the window's registry. */
function classifyOverridesHealth(load) {
	if (load.corruptGlobal) return {
		status: "corrupt",
		unknownIds: []
	};
	const known = new Set(SETTINGS_BEHAVIORS.map((behavior) => behavior.id));
	const unknownIds = Object.keys({
		...load.global,
		...load.project
	}).filter((id) => !known.has(id));
	return {
		status: unknownIds.length > 0 ? "unknown-ids" : "clean",
		unknownIds
	};
}
function classifyDecisionConfigHealth(env = process.env) {
	if (!existsSync(join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? "", ".config"), "pantheon", "decision-router.json"))) return { status: "absent" };
	return readDecisionRouterConfig(env).corrupt ? { status: "corrupt" } : { status: "ok" };
}
function buildDoctorTab(input) {
	const env = input.env ?? process.env;
	const rows = [];
	const version = classifyInstallVersion(input.runningVersion, env);
	rows.push({
		id: "doctor.version",
		name: "Install version",
		value: version.status === "ok" ? `v${version.installed} — matches` : version.status === "older" ? `v${version.installed} older` : version.status === "newer" ? `v${version.installed} newer` : "unknown",
		note: version.status === "older" ? "refresh with `pantheon-opencode update`" : "read from <config>/opencode/.pantheon/install-state.json"
	});
	const nodeOk = isSupportedNodeFloor(input.nodeVersion);
	rows.push({
		id: "doctor.node",
		name: "Node runtime",
		value: input.nodeVersion.replace(/^v/, ""),
		note: nodeOk ? `meets the >= ${MIN_SUPPORTED_NODE_VERSION} floor` : `below the >= ${MIN_SUPPORTED_NODE_VERSION} floor — tooling may refuse`
	});
	const overrides = classifyOverridesHealth(input.load);
	rows.push({
		id: "doctor.overrides",
		name: "Overrides",
		value: overrides.status === "clean" ? "valid" : overrides.status === "corrupt" ? "unreadable" : `${overrides.unknownIds.length} unknown id(s)`,
		note: overrides.status === "unknown-ids" ? `${overrides.unknownIds.join(", ")} — harmless; repair with doctor --fix` : overrides.status === "corrupt" ? "writes are refused until repaired (doctor --fix)" : "both files parse against the behavior registry"
	});
	const decision = classifyDecisionConfigHealth(env);
	rows.push({
		id: "doctor.decision",
		name: "Decision config",
		value: decision.status === "ok" ? "valid" : decision.status === "corrupt" ? "corrupt" : "absent",
		note: decision.status === "corrupt" ? "runtime fail-closes to disabled · read from <config>/pantheon/decision-router.json" : "read from <config>/pantheon/decision-router.json"
	});
	return {
		id: "doctor",
		title: "Doctor",
		groups: [{
			title: "Health (file-derived)",
			rows
		}, { rows: [{
			id: "doctor.cli",
			name: "Full check",
			value: "Settings -> Updates -> Legacy & Drift",
			note: "Scan & clean obsolete files/MCPs or purge Pantheon stores in-app"
		}] }]
	};
}
//#endregion
//#region src/j1-gate-status.ts
const J1_FLAG_ENV = "PANTHEON_J1_RISK_SCORE";
const J1_THRESHOLD_ENV = "PANTHEON_J1_ENFORCE_THRESHOLD";
const J1_THRESHOLD_DEFAULT = .8;
/** `1`/`on`/`true` map to `shadow` for back-compatibility with the shipped setup. */
const FLAG_ON = /* @__PURE__ */ new Set([
	"1",
	"on",
	"true",
	"shadow"
]);
function j1ModeFromEnv(env = process.env) {
	const raw = (env["PANTHEON_J1_RISK_SCORE"] ?? "").trim().toLowerCase();
	if (raw === "enforce") return "enforce";
	if (raw === "warn") return "warn";
	return FLAG_ON.has(raw) ? "shadow" : "off";
}
/** Invalid or out-of-range values fall back to the default — a typo must not disable the gate. */
function j1ThresholdFromEnv(env = process.env) {
	const text = (env["PANTHEON_J1_ENFORCE_THRESHOLD"] ?? "").trim();
	if (text === "") return J1_THRESHOLD_DEFAULT;
	const raw = Number(text);
	if (!Number.isFinite(raw) || raw < 0 || raw > 1) return J1_THRESHOLD_DEFAULT;
	return raw;
}
const MODE_DESCRIPTION_EN = {
	off: "nothing fires (hard zero)",
	shadow: "observe + record; invisible in the session",
	warn: "RESERVED — behaves as shadow in this release",
	enforce: "high-risk scores DENY the tool call (fail-open on gate unavailability)"
};
const MODE_DESCRIPTION_PT = {
	off: "desativado (hard zero)",
	shadow: "observa + registra telemetria (modo silencioso)",
	warn: "RESERVADO (RESERVED) — comporta-se como shadow nesta versão",
	enforce: "alto risco bloqueia a ferramenta (fail-open se indisponível)"
};
function buildJ1Tab(env, disabledByOverride, languagePref) {
	const isPt = resolveLanguage(languagePref) === "pt-BR";
	const mode = j1ModeFromEnv(env);
	const threshold = j1ThresholdFromEnv(env);
	const gateState = disabledByOverride ? "disabled via overrides" : mode === "off" ? "off (env unset)" : "active";
	const desc = isPt ? MODE_DESCRIPTION_PT[mode] : MODE_DESCRIPTION_EN[mode];
	return {
		id: "j1",
		title: isPt ? "Segurança J1" : "J1 Safety",
		groups: [{
			title: isPt ? "Portão de Segurança (J1)" : "Safety Risk Gate (J1)",
			rows: [
				{
					id: "j1.mode",
					name: isPt ? "Modo de Operação" : "Operation Mode",
					value: mode,
					note: `${desc} · ${isPt ? "reinício necessário (restart applies)" : "restart applies"}`
				},
				{
					id: "j1.threshold",
					name: isPt ? "Limiar de bloqueio" : "Enforce threshold",
					value: String(threshold),
					note: isPt ? "bloqueia em ou acima · 0..1 · padrão 0.8" : "deny at or above · 0..1 · default 0.8"
				},
				{
					id: "j1.gate",
					name: isPt ? "Portão de Segurança" : "Safety Risk Gate",
					value: gateState,
					note: `${J1_FLAG_ENV} / ${J1_THRESHOLD_ENV} · ${isPt ? "lido na inicialização" : "read once at startup"}`
				}
			]
		}]
	};
}
//#endregion
//#region src/legacy-audit.ts
/**
* legacy-audit.ts — Self-contained Legacy & Drift Auditor for the TUI Settings panel.
*
* Scans global (~/.config/opencode) and workspace (<project>) scopes for:
*   - Dead V1 hooks/files (pantheon-hooks.*, tiers.json, fastembed_cache, .migration-checkpoint)
*   - Unmigrated legacy stores (memory.db, persistence/{global,project}.db, goals.json)
*   - Redundant copied canonical Pantheon assets shadowed by native plugin transforms
*   - Drifted copied TUI plugins (plugins/pantheon-tui version != running plugin version)
*   - Old configuration backup sidecars (opencode.json.bak*, active-preset.json.bak*)
*
* Always migrates unmigrated legacy context/memory/goals BEFORE deleting obsolete stores,
* and NEVER touches user-created custom agents or custom user skills.
*/
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const CANONICAL_AGENT_MD_FILES = Object.freeze([
	"aphrodite.md",
	"apollo.md",
	"artemis.md",
	"athena.md",
	"demeter.md",
	"gaia.md",
	"hephaestus.md",
	"hermes.md",
	"iris.md",
	"mnemosyne.md",
	"nyx.md",
	"prometheus.md",
	"talos.md",
	"themis.md",
	"zeus.md"
]);
const CANONICAL_COMMAND_MD_FILES = Object.freeze([
	"pantheon.md",
	"pantheon-audit.md",
	"pantheon-consolidate.md",
	"pantheon-deepwork.md",
	"pantheon-focus.md",
	"pantheon-forge.md",
	"pantheon-model.md",
	"pantheon-optimize.md",
	"pantheon-settings.md",
	"pantheon-vision.md"
]);
const CANONICAL_SKILL_IDS = Object.freeze([
	"agent-coordination",
	"agent-forge",
	"artifact-management",
	"auto-continue",
	"clonedeps",
	"code-review-checklist",
	"codemap",
	"context-compression",
	"council-agora",
	"fast-path-execution",
	"git-workflow-and-versioning",
	"incremental-implementation",
	"instruction-forge",
	"loop-engineering",
	"memory-bank",
	"prompt-refinery",
	"reflect",
	"security-hardening",
	"session-goal",
	"simplify",
	"spec-driven-development",
	"tdd-with-agents",
	"test-slicing",
	"verification-planning",
	"visual-review-pipeline",
	"worktrees"
]);
const LEGACY_INSTRUCTION_FILES = Object.freeze([
	"zeus-execution-rules.instructions.md",
	"zeus-orchestration.instructions.md",
	"zeus-workflow.instructions.md"
]);
const PANTHEON_LEGACY_MCP_NAMES = /* @__PURE__ */ new Set([
	"pantheon-resources",
	"pantheon-code-mode",
	"pantheon-memory",
	"pantheon-persistence",
	"pantheon-vision"
]);
const LEGACY_PYTHON_MCP_SCRIPTS = /* @__PURE__ */ new Set([
	"mcp_resources.py",
	"mcp_resources_server.py",
	"code_mode.py",
	"code_mode_server.py",
	"memory_mcp.py",
	"memory_mcp_server.py",
	"mcp_persistence.py",
	"mcp_persistence_server.py",
	"pantheon_vision.py",
	"pantheon_vision_server.py"
]);
const LEGACY_PYTHON_RUNTIME_SCRIPTS = Object.freeze([
	...LEGACY_PYTHON_MCP_SCRIPTS,
	"_pantheon_paths.py",
	"eval_store.py",
	"mcp_codemap_module.py",
	"themis_heuristic_scan.py",
	"scrub-secrets.py"
]);
function isPlainRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stripJsonCommentsAndTrailingCommas(raw) {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && raw[i + 1] === "/") {
			while (i < raw.length && raw[i] !== "\n") i += 1;
			if (i < raw.length) out += "\n";
			continue;
		}
		if (ch === "/" && raw[i + 1] === "*") {
			i += 2;
			while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
			i += 1;
			continue;
		}
		out += ch;
	}
	return out.replace(/,\s*([}\]])/g, "$1");
}
function isPantheonMcpServer(name, entry) {
	if (PANTHEON_LEGACY_MCP_NAMES.has(name)) return true;
	if (!isPlainRecord(entry)) return false;
	return [
		"managed-by",
		"managedBy",
		"owner"
	].some((k) => typeof entry[k] === "string" && /^pantheon(?:-|$)/i.test(String(entry[k])));
}
function isLegacyOrBrokenPantheonMcp(name, entry, configDir) {
	if (!isPantheonMcpServer(name, entry) || !isPlainRecord(entry)) return {
		remove: false,
		isPython: false
	};
	const cmdList = Array.isArray(entry.command) ? entry.command.filter((x) => typeof x === "string") : typeof entry.command === "string" ? [entry.command] : [];
	const argList = Array.isArray(entry.args) ? entry.args.filter((x) => typeof x === "string") : [];
	const parts = [...cmdList, ...argList];
	const isPythonScript = parts.some((p) => LEGACY_PYTHON_MCP_SCRIPTS.has(basename(p.replaceAll("\\", "/"))));
	const exe = parts[0];
	const isPythonBin = typeof exe === "string" && /(?:^|[\\/])python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(exe);
	const isVenvPath = parts.some((p) => /(?:^|[\\/])\.venv(?:[\\/]|$)/.test(p));
	const isPython = isPythonScript || isPythonBin || isVenvPath;
	const cwd = typeof entry.cwd === "string" && entry.cwd.trim() !== "" ? resolve(configDir, entry.cwd) : configDir;
	const hasMissingExe = typeof exe === "string" && (exe.includes("/") || exe.includes("\\")) && !existsSync(isAbsolute(exe) ? exe : resolve(cwd, exe));
	const hasMissingScript = parts.slice(1).some((p) => {
		if (!/\.(?:py|mjs|js|ts)$/i.test(p) || p.startsWith("-")) return false;
		return !existsSync(isAbsolute(p) ? p : resolve(cwd, p));
	});
	const isBrokenLocal = (entry.type === "local" || entry.type === "stdio" || entry.type === void 0) && (hasMissingExe || hasMissingScript);
	return {
		remove: isPython || isBrokenLocal,
		isPython
	};
}
function getAuditPluginRef(entry) {
	if (typeof entry === "string") return entry;
	if (isPlainRecord(entry) && typeof entry.package === "string") return entry.package;
	return null;
}
function isAuditPantheonPluginRef(ref) {
	if (!ref) return false;
	const norm = ref.replaceAll("\\", "/");
	return /^pantheon-opencode(?:\/.*)?$/i.test(norm) || /^pantheon-tui$/i.test(norm) || /^plugins\/pantheon-tui$/i.test(norm) || /pantheon-hooks(?:\.(?:ts|js|mjs))?$/i.test(norm) || /(?:^|\/)src\/plugin\.ts$/i.test(norm) || /(?:^|\/)pantheon-opencode\/src\/plugin$/i.test(norm) || /(?:^|\/)plugins\/pantheon-tui$/i.test(norm);
}
function isAuditLegacyPluginEntry(entry, configDir, singularKey, hasNpmNativePlugin) {
	const ref = getAuditPluginRef(entry);
	if (!ref || !isAuditPantheonPluginRef(ref)) return false;
	if (singularKey) return true;
	const norm = ref.replaceAll("\\", "/");
	if (/pantheon-hooks(?:\.(?:ts|js|mjs))?$/i.test(norm)) return true;
	if (/(?:^|\/)src\/plugin\.ts$/i.test(norm)) return true;
	if (hasNpmNativePlugin && (/^pantheon-tui$/i.test(norm) || /^plugins\/pantheon-tui$/i.test(norm) || /(?:^|\/)plugins\/pantheon-tui$/i.test(norm))) return true;
	if (!(norm === "pantheon-opencode" || norm === "pantheon-opencode/plugin" || norm === "pantheon-opencode/tui") && (norm.startsWith("/") || norm.startsWith(".") || norm.includes("/"))) {
		const targetPath = isAbsolute(ref) ? ref : resolve(configDir, ref);
		if (!existsSync(targetPath)) return true;
	}
	return false;
}
function inspectAuditConfigFile(filePath, configDir) {
	if (!existsSync(filePath)) return null;
	try {
		const st = lstatSync(filePath);
		if (st.isSymbolicLink() || !st.isFile()) return null;
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(filePath.endsWith(".jsonc") ? stripJsonCommentsAndTrailingCommas(raw) : raw);
		if (!isPlainRecord(parsed)) return null;
		const legacyMcps = [];
		if (basename(filePath) !== "tui.json" && isPlainRecord(parsed.mcp)) {
			const servers = isPlainRecord(parsed.mcp.servers) ? parsed.mcp.servers : null;
			if (servers) {
				for (const [name, entry] of Object.entries(servers)) if (isLegacyOrBrokenPantheonMcp(name, entry, configDir).remove) legacyMcps.push({
					layout: "v2",
					name
				});
			}
			for (const [name, entry] of Object.entries(parsed.mcp)) {
				if (servers && name === "servers") continue;
				if (isLegacyOrBrokenPantheonMcp(name, entry, configDir).remove) legacyMcps.push({
					layout: "v1",
					name
				});
			}
		}
		const hasNpmNativePlugin = (Array.isArray(parsed.plugins) ? parsed.plugins : []).some((e) => {
			const ref = getAuditPluginRef(e)?.trim();
			return ref === "pantheon-opencode" || ref === "pantheon-opencode/plugin";
		});
		const legacyPlugins = [];
		if (Array.isArray(parsed.plugin)) parsed.plugin.forEach((entry, index) => {
			if (isAuditLegacyPluginEntry(entry, configDir, true, hasNpmNativePlugin)) legacyPlugins.push({
				key: "plugin",
				index
			});
		});
		if (Array.isArray(parsed.plugins)) parsed.plugins.forEach((entry, index) => {
			if (isAuditLegacyPluginEntry(entry, configDir, false, hasNpmNativePlugin)) legacyPlugins.push({
				key: "plugins",
				index
			});
		});
		return {
			filePath,
			raw,
			parsed,
			legacyMcps,
			legacyPlugins
		};
	} catch {
		return null;
	}
}
function cleanAuditConfigFile(filePath, configDir, backupScopeRoot) {
	const inspected = inspectAuditConfigFile(filePath, configDir);
	if (!inspected || inspected.legacyMcps.length === 0 && inspected.legacyPlugins.length === 0) return;
	const cfg = structuredClone(inspected.parsed);
	if (isPlainRecord(cfg.mcp)) {
		const mcpObj = cfg.mcp;
		for (const item of inspected.legacyMcps) if (item.layout === "v2" && isPlainRecord(mcpObj.servers)) delete mcpObj.servers[item.name];
		else if (item.layout === "v1") delete mcpObj[item.name];
		if (isPlainRecord(mcpObj.servers) && Object.keys(mcpObj.servers).length === 0) delete mcpObj.servers;
		if (Object.keys(mcpObj).length === 0) delete cfg.mcp;
	}
	for (const key of ["plugin", "plugins"]) {
		if (!Array.isArray(cfg[key])) continue;
		const drop = new Set(inspected.legacyPlugins.filter((p) => p.key === key).map((p) => p.index));
		if (drop.size === 0) continue;
		cfg[key] = cfg[key].filter((_, i) => !drop.has(i));
		if (cfg[key].length === 0 && (key === "plugin" || basename(filePath) === "tui.json" || basename(filePath) === "cli.json")) delete cfg[key];
	}
	const next = `${JSON.stringify(cfg, null, 2)}\n`;
	if (next === inspected.raw) return;
	try {
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const bdir = join(backupScopeRoot, ".pantheon", "backups", `legacy-migration-${stamp}`);
		mkdirSync(bdir, {
			recursive: true,
			mode: 448
		});
		chmodSync(bdir, 448);
		const bfile = join(bdir, basename(filePath));
		writeFileSync(bfile, inspected.raw, {
			encoding: "utf8",
			mode: 384
		});
		chmodSync(bfile, 384);
	} catch {}
	if ((basename(filePath) === "tui.json" || basename(filePath) === "cli.json") && Object.keys(cfg).length === 0) {
		rmSync(filePath, { force: true });
		return;
	}
	const st = lstatSync(filePath);
	const tmpPath = `${filePath}.tmp-${process.pid}`;
	writeFileSync(tmpPath, next, {
		encoding: "utf8",
		mode: st.mode & 511
	});
	renameSync(tmpPath, filePath);
}
function resolveAuditCacheDir(env = process.env) {
	if (env.NODE_TEST_CONTEXT) return void 0;
	if (env.XDG_CACHE_HOME?.trim()) return join(resolve(env.XDG_CACHE_HOME.trim()), "opencode", "npm");
	const home = env.HOME?.trim();
	return home ? join(resolve(home), ".cache", "opencode", "npm") : void 0;
}
function readCachedPackageVersion(candidateDir) {
	for (const manifest of [join(candidateDir, "node_modules", "pantheon-opencode", "package.json"), join(candidateDir, "package.json")]) try {
		if (!existsSync(manifest)) continue;
		const parsed = JSON.parse(readFileSync(manifest, "utf8"));
		if (typeof parsed.version === "string" && parsed.version.trim() !== "") return parsed.version.trim();
	} catch {}
	return null;
}
function isUnderPath(parentDir, targetPath) {
	try {
		const parentReal = realpathSync(parentDir);
		const targetReal = realpathSync(targetPath);
		return targetReal === parentReal || targetReal.startsWith(`${parentReal}/`);
	} catch {
		return false;
	}
}
function collectCacheAudit(cacheNpmDir, options) {
	const items = [];
	if (!existsSync(cacheNpmDir) || cacheNpmDir === "/") return items;
	const activeBundlePath = options.activeBundlePath ?? "";
	const runningVersion = options.runningVersion ? String(options.runningVersion).trim() : "";
	const runningIsStable = runningVersion !== "" && !/-(?:beta|rc)\./i.test(runningVersion);
	const seen = /* @__PURE__ */ new Set();
	const pushCacheItem = (targetPath, reason) => {
		const resolved = resolve(targetPath);
		if (seen.has(resolved) || !existsSync(resolved)) return;
		if (activeBundlePath && isUnderPath(resolved, activeBundlePath)) return;
		seen.add(resolved);
		items.push({
			path: resolved,
			scope: "global",
			category: "drift",
			reason,
			bytes: measurePathBytes(resolved)
		});
	};
	let channelEntries = [];
	try {
		channelEntries = readdirSync(cacheNpmDir, { withFileTypes: true });
	} catch {
		return items;
	}
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		if (entry.name !== "pantheon-opencode" && !entry.name.startsWith("pantheon-opencode@")) continue;
		const channelDir = join(cacheNpmDir, entry.name);
		if (runningIsStable && entry.name === "pantheon-opencode@beta") {
			pushCacheItem(channelDir, "Stale @beta plugin cache coexisting with stable install");
			continue;
		}
		try {
			const revisions = readdirSync(channelDir, { withFileTypes: true }).filter((sub) => sub.isDirectory() && sub.name !== "node_modules" && !sub.name.startsWith(".")).map((sub) => {
				const full = join(channelDir, sub.name);
				let mtime = 0;
				try {
					mtime = statSync(full).mtimeMs;
				} catch {}
				return {
					path: full,
					mtime,
					active: Boolean(activeBundlePath && isUnderPath(full, activeBundlePath))
				};
			});
			if (revisions.length > 1) {
				revisions.sort((a, b) => Number(b.active) - Number(a.active) || b.mtime - a.mtime);
				for (const stale of revisions.slice(1)) {
					const ver = readCachedPackageVersion(stale.path);
					pushCacheItem(stale.path, ver ? `Stale cached Pantheon plugin revision (v${ver})` : "Stale cached Pantheon plugin revision");
				}
			}
		} catch {}
	}
	return items;
}
function resolveAuditGlobalDir(env = process.env) {
	if (env.PANTHEON_HOME?.trim()) return resolve(env.PANTHEON_HOME.trim());
	if (env.XDG_CONFIG_HOME?.trim()) return join(resolve(env.XDG_CONFIG_HOME.trim()), "opencode");
	if (env.NODE_TEST_CONTEXT) return void 0;
	const home = env.HOME?.trim();
	return home ? join(resolve(home), ".config", "opencode") : void 0;
}
function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1048576).toFixed(2)} MB`;
}
function toSafeSegment(raw, fallback = "default") {
	const str = String(raw ?? "").trim().replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128);
	if (!str || str === "." || str === ".." || !SAFE_SEGMENT_RE.test(str)) return fallback;
	return str;
}
function measurePathBytes(targetPath, depth = 0) {
	if (depth > 8) return 0;
	try {
		const st = statSync(targetPath);
		if (st.isFile()) return st.size;
		if (!st.isDirectory()) return 0;
		let total = 0;
		for (const entry of readdirSync(targetPath, { withFileTypes: true })) total += measurePathBytes(join(targetPath, entry.name), depth + 1);
		return total;
	} catch {
		return 0;
	}
}
function samePath(a, b) {
	if (resolve(a) === resolve(b)) return true;
	if (!existsSync(a) || !existsSync(b)) return false;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}
function isConfinedWithin(rootDir, targetPath) {
	try {
		const realRoot = realpathSync(rootDir);
		const parentReal = realpathSync(dirname(targetPath));
		return parentReal === realRoot || parentReal.startsWith(`${realRoot}/`);
	} catch {
		return false;
	}
}
function countTableRows(db, tableName) {
	try {
		const row = db.prepare(`SELECT count(*) AS cnt FROM "${tableName.replace(/"/g, "\"\"")}"`).get();
		return Number(row?.cnt ?? 0);
	} catch {
		return 0;
	}
}
function tableExists(db, name) {
	try {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
		return Boolean(row?.name);
	} catch {
		return false;
	}
}
function collectScopeAudit(scope, baseRoot, configRoot, options) {
	const items = [];
	const seen = /* @__PURE__ */ new Set();
	let unmigratedStores = 0;
	const addItem = (filePath, category, reason) => {
		const resolved = resolve(filePath);
		if (seen.has(resolved) || !existsSync(resolved)) return;
		seen.add(resolved);
		items.push({
			path: resolved,
			scope,
			category,
			reason,
			bytes: measurePathBytes(resolved)
		});
	};
	for (const hookName of [
		"pantheon-hooks.ts",
		"pantheon-hooks.js",
		"pantheon-hooks.mjs"
	]) addItem(join(configRoot, "plugins", hookName), "hooks", "Obsolete OpenCode V1 hook plugin");
	addItem(join(configRoot, "tiers.json"), "v1Obsolete", "Obsolete V1 model tiers registry");
	addItem(join(baseRoot, "tiers.json"), "v1Obsolete", "Obsolete V1 model tiers registry");
	const configCandidates = /* @__PURE__ */ new Set();
	for (const dir of [baseRoot, configRoot]) for (const fileName of [
		"opencode.json",
		"opencode.jsonc",
		"tui.json"
	]) configCandidates.add(resolve(join(dir, fileName)));
	let removedPythonMcpInConfig = false;
	for (const cfgPath of configCandidates) {
		const inspected = inspectAuditConfigFile(cfgPath, dirname(cfgPath));
		if (!inspected) continue;
		for (const mcp of inspected.legacyMcps) {
			removedPythonMcpInConfig = true;
			items.push({
				path: `${cfgPath}#legacy-mcp:${mcp.name}`,
				scope,
				category: "v1Obsolete",
				reason: `Legacy or broken MCP entry (${mcp.name}) in ${basename(cfgPath)}`,
				bytes: 0
			});
		}
		if (inspected.legacyPlugins.length > 0) items.push({
			path: `${cfgPath}#legacy-plugin`,
			scope,
			category: "hooks",
			reason: `Legacy or broken Pantheon plugin entry in ${basename(cfgPath)}`,
			bytes: 0
		});
	}
	if (!(existsSync(join(configRoot, "src", "mcp", "code_mode.py")) && existsSync(join(configRoot, "package.json"))) && existsSync(configRoot)) {
		const scriptsDir = join(configRoot, "scripts");
		const hasPyScripts = existsSync(scriptsDir) && LEGACY_PYTHON_RUNTIME_SCRIPTS.some((name) => existsSync(join(scriptsDir, name)));
		if (existsSync(scriptsDir)) for (const name of LEGACY_PYTHON_RUNTIME_SCRIPTS) addItem(join(scriptsDir, name), "v1Obsolete", "Obsolete legacy Python MCP script (replaced by native tools / Node MCP)");
		const reqVision = join(configRoot, "requirements-vision.txt");
		addItem(reqVision, "v1Obsolete", "Obsolete Python vision requirements file");
		const configVenv = join(configRoot, ".venv");
		if (existsSync(configVenv) && (hasPyScripts || existsSync(reqVision) || removedPythonMcpInConfig)) addItem(configVenv, "v1Obsolete", "Obsolete Python virtual environment for legacy MCPs");
	}
	const pantheonDir = join(baseRoot, ".pantheon");
	addItem(join(pantheonDir, "fastembed_cache"), "v1Obsolete", "Unused legacy fastembed cache");
	addItem(join(pantheonDir, ".fastembed"), "v1Obsolete", "Unused legacy fastembed cache");
	addItem(join(baseRoot, "fastembed_cache"), "v1Obsolete", "Unused legacy fastembed cache");
	addItem(join(pantheonDir, ".migration-checkpoint"), "v1Obsolete", "Stale migration checkpoint file");
	for (const bakDir of [configRoot, pantheonDir]) {
		if (!existsSync(bakDir)) continue;
		try {
			for (const name of readdirSync(bakDir)) if (name.startsWith("opencode.json.bak") || name.startsWith("active-preset.json.bak")) addItem(join(bakDir, name), "backup", "Old configuration backup sidecar");
		} catch {}
	}
	const legacyFlatMemDb = join(pantheonDir, "memory.db");
	if (existsSync(legacyFlatMemDb)) {
		unmigratedStores += 1;
		addItem(legacyFlatMemDb, "legacyStore", "Unmigrated flat .pantheon/memory.db");
	}
	const canonicalMemDb = join(pantheonDir, "memory", "memory.db");
	if (existsSync(canonicalMemDb)) try {
		const db = new DatabaseSync(canonicalMemDb, { readOnly: true });
		const hasLegacyVec = [
			"memories_vec",
			"vec_memories",
			"memory_embeddings",
			"memory_vectors"
		].some((t) => tableExists(db, t));
		db.close();
		if (hasLegacyVec) {
			unmigratedStores += 1;
			items.push({
				path: `${canonicalMemDb}#legacy-vec`,
				scope,
				category: "legacyStore",
				reason: "Legacy vector tables pending cleanup in memory.db",
				bytes: 0
			});
		}
	} catch {}
	for (const dbName of ["global.db", "project.db"]) {
		const persDbPath = join(pantheonDir, "persistence", dbName);
		if (existsSync(persDbPath)) {
			unmigratedStores += 1;
			addItem(persDbPath, "legacyStore", `Unmigrated persistence/${dbName}`);
		}
	}
	const legacyGoalsJson = join(pantheonDir, "goals.json");
	if (existsSync(legacyGoalsJson)) {
		unmigratedStores += 1;
		addItem(legacyGoalsJson, "legacyStore", "Unmigrated legacy goals.json");
	}
	if (options.includeRedundantCopiedAssets !== false) {
		for (const agentFile of CANONICAL_AGENT_MD_FILES) {
			addItem(join(configRoot, "agents", agentFile), "redundantAsset", "Canonical Pantheon agent copy shadowed by native plugin transform");
			addItem(join(configRoot, "agent", agentFile), "redundantAsset", "Legacy singular agent copy shadowed by native plugin transform");
			addItem(join(configRoot, "prompts", agentFile), "redundantAsset", "Legacy prompt template copy provided in package");
		}
		for (const cmdFile of CANONICAL_COMMAND_MD_FILES) {
			addItem(join(configRoot, "commands", cmdFile), "redundantAsset", "Canonical Pantheon command copy shadowed by native plugin transform");
			addItem(join(configRoot, "command", cmdFile), "redundantAsset", "Legacy singular command directory copy");
		}
		for (const instr of LEGACY_INSTRUCTION_FILES) addItem(join(configRoot, "instructions", instr), "redundantAsset", "Legacy instruction file superseded by AGENTS.global.md");
		for (const skillId of CANONICAL_SKILL_IDS) addItem(join(configRoot, "skills", skillId), "redundantAsset", "Bundled Pantheon skill directory provided natively by plugin");
		const tuiCopyDir = join(configRoot, "plugins", "pantheon-tui");
		if (existsSync(tuiCopyDir)) {
			let copiedVersion = "";
			try {
				copiedVersion = String(JSON.parse(readFileSync(join(tuiCopyDir, "package.json"), "utf8")).version ?? "");
			} catch {
				copiedVersion = "";
			}
			const runningVersion = options.runningVersion ? String(options.runningVersion) : "";
			const drifted = Boolean(runningVersion && copiedVersion && copiedVersion !== runningVersion);
			addItem(tuiCopyDir, drifted ? "drift" : "redundantAsset", drifted ? `Copied TUI plugin v${copiedVersion} drifts from v${runningVersion}` : "Copied TUI directory superseded by npm package export");
		}
		const routingPath = join(configRoot, "routing.yml");
		if (existsSync(routingPath)) try {
			if (/pantheon|zeus:|athena:|apollo:/i.test(readFileSync(routingPath, "utf8"))) addItem(routingPath, "redundantAsset", "Copied routing.yml superseded by bundled roster");
		} catch {}
		const isRepoRoot = existsSync(join(baseRoot, "package.json")) && existsSync(join(baseRoot, "src", "plugin.ts")) && existsSync(join(baseRoot, "src", "agents", "roster.json"));
		const statePaths = [join(configRoot, ".pantheon", "install-state.json")];
		if (!isRepoRoot) statePaths.push(join(pantheonDir, "install-state.json"));
		for (const statePath of statePaths) addItem(statePath, "redundantAsset", "Legacy CLI installer manifest");
		const codeModeDirs = [join(configRoot, ".pantheon", "code-mode")];
		if (!isRepoRoot && join(pantheonDir, "code-mode") !== codeModeDirs[0]) codeModeDirs.push(join(pantheonDir, "code-mode"));
		for (const cmDir of codeModeDirs) {
			if (!existsSync(cmDir)) continue;
			try {
				for (const entry of readdirSync(cmDir)) if (entry.endsWith(".py") || entry.endsWith(".sh") || entry === "manifest.json") addItem(join(cmDir, entry), "v1Obsolete", "Obsolete Python code-mode script (replaced by native tools)");
			} catch {}
		}
	}
	return {
		items,
		unmigratedStores
	};
}
function ensureCanonicalMemoryDb(dbPath) {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL DEFAULT 'default',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      UNIQUE(namespace, key)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      key, value, namespace,
      content='memories',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, key, value, namespace) VALUES (new.id, new.key, new.value, new.namespace);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, key, value, namespace) VALUES('delete', old.id, old.key, old.value, old.namespace);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, key, value, namespace) VALUES('delete', old.id, old.key, old.value, old.namespace);
      INSERT INTO memories_fts(rowid, key, value, namespace) VALUES (new.id, new.key, new.value, new.namespace);
    END;
  `);
	return db;
}
function migrateScopeBeforeDelete(baseRoot) {
	const pantheonDir = join(baseRoot, ".pantheon");
	if (!existsSync(pantheonDir)) return 0;
	let migrated = 0;
	const nowIso = (/* @__PURE__ */ new Date()).toISOString();
	const flatMemDbPath = join(pantheonDir, "memory.db");
	const canonicalMemPath = join(pantheonDir, "memory", "memory.db");
	if (existsSync(flatMemDbPath)) try {
		const src = new DatabaseSync(flatMemDbPath, { readOnly: true });
		const dst = ensureCanonicalMemoryDb(canonicalMemPath);
		if (tableExists(src, "memories")) {
			const rows = src.prepare("SELECT namespace, key, value, created_at FROM memories").all();
			const insert = dst.prepare("INSERT OR IGNORE INTO memories (namespace, key, value, importance, created_at) VALUES (?, ?, ?, ?, ?)");
			dst.exec("BEGIN IMMEDIATE");
			try {
				for (const r of rows) {
					insert.run(String(r.namespace ?? "default"), String(r.key ?? ""), String(r.value ?? ""), .5, String(r.created_at ?? nowIso));
					migrated += 1;
				}
				dst.exec("COMMIT");
			} catch (txErr) {
				try {
					dst.exec("ROLLBACK");
				} catch {}
				throw txErr;
			}
		}
		src.close();
		dst.close();
	} catch {}
	if (existsSync(canonicalMemPath)) try {
		const db = ensureCanonicalMemoryDb(canonicalMemPath);
		for (const trig of [
			"memories_vec_ai",
			"memories_vec_ad",
			"memories_vec_au"
		]) db.exec(`DROP TRIGGER IF EXISTS ${trig}`);
		for (const tbl of [
			"memories_vec",
			"vec_memories",
			"memory_embeddings",
			"memory_vectors"
		]) if (tableExists(db, tbl)) {
			db.exec(`DROP TABLE IF EXISTS ${tbl}`);
			migrated += 1;
		}
		db.close();
	} catch {}
	const persDir = join(pantheonDir, "persistence");
	for (const dbName of ["global.db", "project.db"]) {
		const dbPath = join(persDir, dbName);
		if (!existsSync(dbPath)) continue;
		try {
			const db = new DatabaseSync(dbPath, { readOnly: true });
			for (const tbl of [
				"kv",
				"kv_store",
				"context",
				"checkpoints",
				"sessions"
			]) {
				if (!tableExists(db, tbl) || countTableRows(db, tbl) === 0) continue;
				const cols = db.prepare(`PRAGMA table_info(${tbl})`).all();
				const colNames = new Set(cols.map((c) => c.name));
				const keyCol = colNames.has("key") ? "key" : colNames.has("id") ? "id" : colNames.has("session_id") ? "session_id" : null;
				const valCol = colNames.has("value") ? "value" : colNames.has("data") ? "data" : colNames.has("content") ? "content" : null;
				if (!keyCol || !valCol) continue;
				const nsSelect = colNames.has("namespace") ? "namespace" : `'${tbl === "checkpoints" || tbl === "sessions" ? "checkpoints" : "default"}' AS namespace`;
				const rows = db.prepare(`SELECT ${nsSelect}, ${keyCol} AS k, ${valCol} AS v FROM ${tbl}`).all();
				for (const r of rows) {
					const ns = toSafeSegment(r.namespace, "default");
					const key = toSafeSegment(r.k, "");
					if (!key) continue;
					const targetDir = join(persDir, ns);
					const targetFile = join(targetDir, `${key}.json`);
					if (!existsSync(targetFile)) {
						mkdirSync(targetDir, { recursive: true });
						writeFileSync(targetFile, JSON.stringify({
							key,
							namespace: ns,
							value: String(r.v ?? ""),
							updated_at: nowIso
						}, null, 2), "utf8");
						migrated += 1;
					}
				}
			}
			db.close();
		} catch {}
	}
	const legacyGoalsPath = join(pantheonDir, "goals.json");
	if (existsSync(legacyGoalsPath)) try {
		const parsed = JSON.parse(readFileSync(legacyGoalsPath, "utf8"));
		const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed.goals) ? parsed.goals ?? [] : [];
		const goalsDir = join(pantheonDir, "goals");
		for (const item of list) {
			if (!item || typeof item !== "object") continue;
			const rec = item;
			const safeId = toSafeSegment(rec.id ?? rec.goal_id, "");
			if (!safeId) continue;
			const target = join(goalsDir, `${safeId}.json`);
			if (!existsSync(target)) {
				mkdirSync(goalsDir, { recursive: true });
				writeFileSync(target, JSON.stringify({
					id: safeId,
					title: String(rec.title ?? rec.description ?? ""),
					criteria: Array.isArray(rec.criteria) ? rec.criteria.map(String) : [],
					status: String(rec.status ?? "active"),
					created_at: typeof rec.created_at === "string" ? rec.created_at : nowIso,
					updated_at: typeof rec.updated_at === "string" ? rec.updated_at : nowIso
				}, null, 2), "utf8");
				migrated += 1;
			}
		}
	} catch {}
	return migrated;
}
function scanLegacyArtifacts(options = {}) {
	const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : void 0;
	const globalConfigDir = options.globalConfigDir ? resolve(options.globalConfigDir) : resolveAuditGlobalDir(options.env);
	const cacheNpmDir = options.cacheDir ? resolve(options.cacheDir) : resolveAuditCacheDir(options.env);
	const items = [];
	let unmigratedStores = 0;
	if (globalConfigDir && existsSync(globalConfigDir) && globalConfigDir !== "/") {
		const res = collectScopeAudit("global", globalConfigDir, globalConfigDir, options);
		items.push(...res.items);
		unmigratedStores += res.unmigratedStores;
	}
	if (cacheNpmDir && existsSync(cacheNpmDir) && cacheNpmDir !== "/") items.push(...collectCacheAudit(cacheNpmDir, options));
	if (workspaceDir && existsSync(workspaceDir) && workspaceDir !== "/" && (!globalConfigDir || !samePath(workspaceDir, globalConfigDir))) {
		const res = collectScopeAudit("project", workspaceDir, join(workspaceDir, ".opencode"), options);
		items.push(...res.items);
		unmigratedStores += res.unmigratedStores;
	}
	const byScope = {
		global: 0,
		project: 0
	};
	const byCategory = {};
	let totalBytes = 0;
	for (const item of items) {
		byScope[item.scope] = (byScope[item.scope] ?? 0) + 1;
		byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
		totalBytes += item.bytes;
	}
	return {
		items,
		summary: {
			total: items.length,
			totalBytes,
			unmigratedStores,
			byScope,
			byCategory
		}
	};
}
function cleanLegacyArtifacts(options = {}) {
	const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : void 0;
	const globalConfigDir = options.globalConfigDir ? resolve(options.globalConfigDir) : resolveAuditGlobalDir(options.env);
	const cacheNpmDir = options.cacheDir ? resolve(options.cacheDir) : resolveAuditCacheDir(options.env);
	const scopeFilter = options.scope && options.scope !== "all" ? options.scope : null;
	const scan = scanLegacyArtifacts(options);
	let migratedRecords = 0;
	if (scopeFilter !== "project" && globalConfigDir && existsSync(globalConfigDir) && globalConfigDir !== "/") migratedRecords += migrateScopeBeforeDelete(globalConfigDir);
	if (scopeFilter !== "global" && workspaceDir && existsSync(workspaceDir) && workspaceDir !== "/" && (!globalConfigDir || !samePath(workspaceDir, globalConfigDir))) migratedRecords += migrateScopeBeforeDelete(workspaceDir);
	const removed = [];
	const errors = [];
	let reclaimedBytes = 0;
	const cleanedConfigs = /* @__PURE__ */ new Set();
	for (const item of scan.items) {
		if (scopeFilter && item.scope !== scopeFilter) continue;
		if (item.path.endsWith("#legacy-vec")) {
			removed.push(item.path);
			continue;
		}
		if (item.path.includes("#legacy-mcp:") || item.path.endsWith("#legacy-plugin")) {
			const cfgPath = item.path.split("#")[0] ?? "";
			const scopeRoot = item.scope === "global" ? globalConfigDir : workspaceDir;
			if (!cfgPath || !scopeRoot || !isConfinedWithin(scopeRoot, cfgPath)) {
				errors.push({
					path: item.path,
					reason: "Path escapes target scope root"
				});
				continue;
			}
			try {
				if (!cleanedConfigs.has(cfgPath)) {
					cleanedConfigs.add(cfgPath);
					cleanAuditConfigFile(cfgPath, dirname(cfgPath), scopeRoot);
				}
				removed.push(item.path);
			} catch (err) {
				errors.push({
					path: item.path,
					reason: err instanceof Error ? err.message : String(err)
				});
			}
			continue;
		}
		const scopeRoot = item.scope === "global" ? globalConfigDir : workspaceDir;
		const confineRoot = item.scope === "global" && cacheNpmDir && isConfinedWithin(cacheNpmDir, item.path) ? cacheNpmDir : scopeRoot;
		if (!confineRoot || !isConfinedWithin(confineRoot, item.path)) {
			errors.push({
				path: item.path,
				reason: "Path escapes target scope root"
			});
			continue;
		}
		try {
			if (existsSync(item.path)) {
				rmSync(item.path, {
					recursive: true,
					force: true
				});
				removed.push(item.path);
				reclaimedBytes += item.bytes;
			}
			if (item.path.endsWith(".db")) for (const suffix of [
				"-wal",
				"-shm",
				"-journal"
			]) {
				const sidecar = `${item.path}${suffix}`;
				if (existsSync(sidecar) && isConfinedWithin(confineRoot, sidecar)) {
					const sidecarBytes = measurePathBytes(sidecar);
					rmSync(sidecar, { force: true });
					removed.push(sidecar);
					reclaimedBytes += sidecarBytes;
				}
			}
		} catch (err) {
			errors.push({
				path: item.path,
				reason: err instanceof Error ? err.message : String(err)
			});
		}
	}
	return {
		removed,
		reclaimedBytes,
		migratedRecords,
		errors
	};
}
function purgeAllPantheonData(options = {}) {
	const dryRun = options.dryRun === true;
	const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : void 0;
	const globalConfigDir = options.globalConfigDir ? resolve(options.globalConfigDir) : resolveAuditGlobalDir(options.env);
	const scopeFilter = options.scope && options.scope !== "all" ? options.scope : null;
	const scan = scanLegacyArtifacts({
		...options,
		includeRedundantCopiedAssets: true
	});
	const removed = [];
	const errors = [];
	let reclaimedBytes = 0;
	if (!dryRun) {
		const cleanRes = cleanLegacyArtifacts({
			...options,
			includeRedundantCopiedAssets: true
		});
		removed.push(...cleanRes.removed);
		reclaimedBytes += cleanRes.reclaimedBytes;
		errors.push(...cleanRes.errors);
	}
	const purgeRoot = (rootDir, configRoot) => {
		if (!rootDir || rootDir === "/" || !existsSync(rootDir)) return;
		if (existsSync(join(rootDir, "src", "mcp", "code_mode.py")) && existsSync(join(rootDir, "package.json"))) return;
		for (const store of [join(rootDir, ".pantheon"), join(configRoot, ".pantheon")]) {
			if (!existsSync(store) || !isConfinedWithin(rootDir, store)) continue;
			const bytes = measurePathBytes(store);
			try {
				if (!dryRun) rmSync(store, {
					recursive: true,
					force: true
				});
				removed.push(store);
				reclaimedBytes += bytes;
			} catch (err) {
				errors.push({
					path: store,
					reason: err instanceof Error ? err.message : String(err)
				});
			}
		}
	};
	if (scopeFilter !== "project" && globalConfigDir) purgeRoot(globalConfigDir, globalConfigDir);
	if (scopeFilter !== "global" && workspaceDir && (!globalConfigDir || !samePath(workspaceDir, globalConfigDir))) purgeRoot(workspaceDir, join(workspaceDir, ".opencode"));
	if (dryRun) {
		for (const item of scan.items) removed.push(item.path);
		reclaimedBytes += scan.summary.totalBytes;
	}
	return {
		removed: [...new Set(removed)],
		reclaimedBytes,
		migratedRecords: 0,
		errors
	};
}
//#endregion
//#region src/preset-state.ts
/**
* preset-state.ts — the Model Preset section of the settings window.
*
* TUI-local replica (the bundle must stay self-contained). The preset NAMES
* mirror routing.yml's `presets:` and are drift-pinned by
* tests/tui-preset-state.test.mjs against `loadPresetDefs()`. The marker file
* shape mirrors scripts/install/model-picker.mjs's `buildActivePresetFile`
* (version 1), and the readers (`resolveActivePreset`, vision.ts candidates)
* only consult `.preset`, so the window writes `source: 'tui-settings'`.
*
* Scope note: the window writes the GLOBAL marker only
* (`<config-dir>/opencode/.pantheon/active-preset.json`). A project marker
* wins (it precedes the global path in every runtime candidate list), so it
* is displayed read-only. `none` DELETES the marker with a .bak backup — the
* same contract as the CLI's `set-tier none`.
*/
/** Mirrors routing.yml `presets:` — drift-pinned against loadPresetDefs(). */
const PRESET_NAMES = Object.freeze([
	"go-free",
	"go-fast",
	"go-premium",
	"go-hybrid",
	"anthropic",
	"openai"
]);
function globalActivePresetPath(env = process.env) {
	const xdg = env.XDG_CONFIG_HOME;
	const home = env.HOME ?? "";
	const root = xdg ?? join(home, ".config");
	return join(root, "opencode", ".pantheon", "active-preset.json");
}
function projectActivePresetPath() {
	return join(process.cwd(), ".pantheon", "active-preset.json");
}
/** Fail-open read: missing/corrupt marker = no active preset. */
function readActivePresetMarker(path) {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (typeof raw?.preset !== "string" || raw.preset === "" || raw.preset === "none") return null;
		return {
			name: raw.preset,
			updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : ""
		};
	} catch {
		return null;
	}
}
function writeMarkerAtomically(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tui.tmp`;
	writeFileSync(temp, content);
	renameSync(temp, path);
}
/** Select a preset globally: .bak backup, atomic write, version-1 marker. */
function writeActivePreset(path, name, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
	if (!PRESET_NAMES.includes(name)) throw new TypeError(`Refusing to persist unknown preset "${name}"`);
	backupMarker(path);
	writeMarkerAtomically(path, `${JSON.stringify({
		version: 1,
		preset: name,
		source: "tui-settings",
		updated_at: nowIso
	}, null, 2)}\n`);
}
/** Clear the global marker (the `none` contract): .bak backup, then remove. */
function clearActivePreset(path) {
	backupMarker(path);
	rmSync(path, { force: true });
}
function backupMarker(path) {
	if (!existsSync(path)) return;
	mkdirSync(dirname(path), { recursive: true });
	copyFileSync(path, `${path}.bak`);
}
const VISION_MODEL_OPTIONS = Object.freeze([
	"auto",
	"opencode-go/mimo-v2.6-flash",
	"google/gemini-2.5-flash",
	"openai/gpt-5-mini",
	"anthropic/claude-3-5-haiku",
	"opencode-go/mimo-v2.5"
]);
function visionConfigPaths(cwd = process.cwd(), env = process.env) {
	const home = env.HOME ?? "";
	const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
	return [join(cwd, ".opencode", "opencode-vision.json"), join(xdg, "opencode", "opencode-vision.json")];
}
function readConfiguredVisionModel(cwd = process.cwd(), env = process.env) {
	for (const path of visionConfigPaths(cwd, env)) try {
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (typeof parsed?.visionModel === "string" && parsed.visionModel.trim()) return parsed.visionModel.trim();
		}
	} catch {}
	return "auto";
}
function writeConfiguredVisionModel(model, cwd = process.cwd(), env = process.env) {
	const home = env.HOME ?? "";
	const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
	const projectDir = join(cwd, ".opencode");
	const targetPath = existsSync(projectDir) ? join(projectDir, "opencode-vision.json") : join(xdg, "opencode", "opencode-vision.json");
	let current = {};
	try {
		if (existsSync(targetPath)) current = JSON.parse(readFileSync(targetPath, "utf8"));
	} catch {
		current = {};
	}
	if (model === "auto" || !model.trim()) delete current.visionModel;
	else current.visionModel = model.trim();
	mkdirSync(dirname(targetPath), { recursive: true });
	const temp = `${targetPath}.tui.tmp`;
	writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
	renameSync(temp, targetPath);
}
const PRESET_CYCLE = Object.freeze(["none", ...PRESET_NAMES]);
function buildPresetTab(input, languagePref) {
	const isPt = languagePref === "pt-BR";
	const rows = [{
		id: "preset",
		name: isPt ? "Predefinição" : "Preset",
		value: input.globalName ?? "none",
		cycle: PRESET_CYCLE,
		note: isPt ? "marcador global · gravação atômica, backup .bak · none = padrão OpenCode" : "global marker · atomic write, .bak backup · none = opencode defaults"
	}];
	if (input.projectName !== null) rows.push({
		id: "preset.project",
		name: isPt ? "Projeto" : "Project",
		value: input.projectName,
		note: isPt ? `${projectActivePresetPath()} tem precedência sobre o global — somente leitura aqui` : `${projectActivePresetPath()} wins over the global marker — read-only here`
	});
	if (input.visionModel !== void 0) rows.push({
		id: "preset.vision_model",
		name: isPt ? "Modelo de Visão" : "Vision Model",
		value: input.visionModel || "auto",
		cycle: VISION_MODEL_OPTIONS,
		note: isPt ? "modelo para inspeção de imagens (vision_describe) · salvo em opencode-vision.json" : "model for image inspection (vision_describe) · saved in opencode-vision.json"
	});
	return {
		id: "preset",
		title: "Preset",
		groups: [{
			title: isPt ? "Predefinição de modelo" : "Model preset",
			rows
		}]
	};
}
//#endregion
//#region src/update-status.ts
/**
* update-status.ts — the Updates section of the settings window.
*
* TUI-local; derives rows from the update-notice.ts primitives. The registry
* fetch and state persistence stay in the .tsx glue (host side) — this module
* only classifies the channel and builds rows from injected state, so the
* whole thing is testable without network.
*/
/** The running version's channel: a `-beta.N` suffix rides the beta dist-tag. */
function updateChannelFor(version) {
	return /-beta\.\d+$/.test(version) ? "beta" : "stable";
}
/** The npm dist-tag the registry check should query for the channel. */
function registryTagForChannel(channel) {
	return channel === "beta" ? "beta" : "latest";
}
function registryUrlForChannel(channel) {
	return `https://registry.npmjs.org/pantheon-opencode/${registryTagForChannel(channel)}`;
}
function formatAgo(ms, isPt = false) {
	if (ms < 6e4) return isPt ? "agora mesmo" : "just now";
	if (ms < 36e5) return isPt ? `há ${Math.floor(ms / 6e4)}m` : `${Math.floor(ms / 6e4)}m ago`;
	if (ms < 864e5) return isPt ? `há ${Math.floor(ms / 36e5)}h` : `${Math.floor(ms / 36e5)}h ago`;
	return isPt ? `há ${Math.floor(ms / 864e5)}d` : `${Math.floor(ms / 864e5)}d ago`;
}
function buildUpdatesTab(input) {
	const isPt = input.languagePref === "pt-BR";
	const nowMs = input.nowMs ?? Date.now();
	const channel = input.selectedChannel ?? updateChannelFor(input.currentVersion);
	const lastCheckMs = input.state.lastCheckMs;
	const latest = input.lastCheckedVersion ?? input.state.lastNotifiedVersion;
	const stable = (version) => !/-beta\.\d+$/.test(version);
	const newer = latest !== void 0 && comparePantheonVersions(latest, input.currentVersion) > 0 && !(stable(input.currentVersion) && !stable(latest));
	const rows = [{
		id: "update.channel",
		name: isPt ? "Canal" : "Channel",
		value: channel,
		cycle: ["stable", "beta"],
		note: isPt ? "stable segue npm `latest`; beta segue npm `beta`" : "stable tracks npm `latest`; beta tracks npm `beta`"
	}, {
		id: "update.check",
		name: isPt ? "Verificar agora" : "Check now",
		value: input.checking ? isPt ? "verificando…" : "checking…" : lastCheckMs ? isPt ? `verificado ${formatAgo(nowMs - lastCheckMs, true)}` : `last check ${formatAgo(nowMs - lastCheckMs, false)}` : isPt ? "nunca verificado" : "never checked",
		action: "update-check",
		note: isPt ? "enter consulta o registro npm para o canal ativo" : "enter probes the registry for the running channel"
	}];
	const pluginCommand = `opencode plugin update ${channel === "beta" ? "pantheon-opencode@beta" : "pantheon-opencode"}`;
	if (latest) {
		rows.push({
			id: "update.latest",
			name: isPt ? "Registro (npm)" : "Registry",
			value: newer ? `v${latest} ${isPt ? "disponível" : "available"}` : isPt ? "atualizado" : "up to date",
			...newer ? { action: "update-run" } : {},
			note: newer ? isPt ? `enter atualiza agora · ou rode \`${pluginCommand}\`` : `enter updates now · or run \`${pluginCommand}\`` : isPt ? "nenhuma versão mais recente compatível" : "no newer compatible version"
		});
		rows.push({
			id: "update.run",
			name: isPt ? "Atualizar plugin" : "Update plugin",
			value: input.updating ? isPt ? "atualizando…" : "updating…" : newer ? `${isPt ? "atualizar" : "update"} v${latest}` : isPt ? "reinstalar plugin" : "refresh plugin",
			action: "update-run",
			note: newer ? isPt ? `enter executa \`${pluginCommand}\` + reload` : `enter runs \`${pluginCommand}\` + reload` : isPt ? "enter força atualização do plugin instalado" : "enter refreshes the installed plugin"
		});
	}
	rows.push({
		id: "update.command",
		name: isPt ? "Comando no terminal" : "CLI Command",
		value: "opencode plugin update",
		note: isPt ? `rode \`${pluginCommand} && opencode reload\` (sem npx)` : `run \`${pluginCommand} && opencode reload\` (no npx)`
	});
	const audit = input.legacyAudit;
	const legacyRows = [
		{
			id: "legacy.status",
			name: isPt ? "Auditoria legada" : "Legacy & Drift",
			value: input.legacyScanning ? isPt ? "escaneando…" : "scanning…" : audit === void 0 || audit === null ? isPt ? "não escaneado" : "not scanned" : audit.total === 0 ? isPt ? "limpo (0 obsoletos)" : "clean (0 obsolete)" : isPt ? `${audit.total} item(ns) (${formatBytes(audit.totalBytes)})` : `${audit.total} item(s) (${formatBytes(audit.totalBytes)})`,
			note: input.legacyNotice ? input.legacyNotice : audit && audit.total > 0 ? isPt ? `global: ${audit.byScope.global} · projeto: ${audit.byScope.project}${audit.unmigratedStores > 0 ? ` · ${audit.unmigratedStores} store(s) p/ migrar` : ""}` : `global: ${audit.byScope.global} · project: ${audit.byScope.project}${audit.unmigratedStores > 0 ? ` · ${audit.unmigratedStores} store(s) to migrate` : ""}` : isPt ? "verifica caches npm antigos, hooks V1, bancos e cópias redundantes" : "checks stale npm caches, V1 hooks, unmigrated stores & copied files"
		},
		{
			id: "legacy.scan",
			name: isPt ? "Escanear obsoletos" : "Scan legacy & drift",
			value: input.legacyScanning ? isPt ? "escaneando…" : "scanning…" : isPt ? "escanear agora" : "scan global + project",
			action: "legacy-scan",
			note: isPt ? "enter verifica global, projeto e cache npm sem apagar nada" : "enter scans global, project & npm cache read-only"
		},
		{
			id: "legacy.clean",
			name: isPt ? "Migrar & limpar" : "Migrate & clean obsolete",
			value: input.legacyCleaning ? isPt ? "limpando…" : "cleaning…" : audit && audit.total > 0 ? isPt ? `limpar ${audit.total} (${formatBytes(audit.totalBytes)})` : `remove ${audit.total} (${formatBytes(audit.totalBytes)})` : isPt ? "nada a remover" : "nothing to remove",
			action: "legacy-clean",
			note: isPt ? "migra memória/contexto/goals antes; preserva agentes/skills custom" : "migrates memory/context/goals first · preserves custom agents/skills"
		},
		{
			id: "legacy.purge",
			name: isPt ? "Apagar dados (.pantheon)" : "Purge Pantheon data",
			value: input.confirmPurge ? isPt ? "CONFIRMAR: Enter apaga tudo" : "CONFIRM: Enter deletes stores" : isPt ? "resetar dados locais" : "reset local stores",
			action: "legacy-purge",
			note: input.confirmPurge ? isPt ? "pressione Enter de novo para apagar .pantheon (memória, goals, backups); mude de linha para cancelar" : "press Enter again to erase .pantheon (memory, goals, backups); move selection to cancel" : isPt ? "remove .pantheon/ (memória, goals, backups) + configs legadas; desinstale o plugin com `opencode plugin remove pantheon-opencode`" : "removes .pantheon/ (memory, goals, backups) + legacy configs; remove plugin via `opencode plugin remove pantheon-opencode`"
		}
	];
	return {
		id: "updates",
		title: isPt ? "Atualizações" : "Updates",
		groups: [{
			title: isPt ? "Atualizações do Plugin" : "Plugin Updates",
			rows
		}, {
			title: isPt ? "Legados, Drift & Limpeza" : "Legacy, Drift & Cleanup",
			rows: legacyRows
		}]
	};
}
/** Prefix of the "+N more" line appended when the bullet budget is exceeded. */
const WHATS_NEW_MORE_PREFIX = "… +";
const EMPTY_HIGHLIGHTS = {
	version: null,
	found: false,
	groups: [],
	totalItems: 0,
	truncated: false
};
/** Escape regex metacharacters so a version like 1.0.0 matches literally. */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
* Extract the body of a version section from changelog text — inline replica
* of scripts/changelog-extract.mjs `extractSection` (see that file for the
* full contract: `## [<version>] - YYYY-MM-DD`, leading `v` and the date
* optional, `## [Unreleased]` never matched).
*/
function extractSection(changelogText, version) {
	const normalized = String(version).trim().replace(/^v/i, "");
	if (!normalized || /^unreleased$/i.test(normalized)) return {
		found: false,
		body: null
	};
	const escaped = escapeRegExp(normalized);
	const match = new RegExp(`^##[ \\t]+\\[v?${escaped}\\](?:[ \\t]*-[ \\t]*\\d{4}-\\d{2}-\\d{2})?(?=[ \\t]|$)`, "m").exec(changelogText);
	if (!match) return {
		found: false,
		body: null
	};
	const newline = changelogText.indexOf("\n", match.index);
	const start = newline === -1 ? changelogText.length : newline + 1;
	const nextHeading = /^##[ \t]+\[/m.exec(changelogText.slice(start));
	const end = nextHeading ? start + nextHeading.index : changelogText.length;
	return {
		found: true,
		body: changelogText.slice(start, end).trim()
	};
}
/**
* Reduce one markdown line to plain text: links keep their label, emphasis
* and inline-code markers are dropped, HTML comment fragments are removed,
* and whitespace collapses. Deliberately simple — the input is our own
* CHANGELOG (lint-capped at 200 chars per bullet), not hostile input.
*/
function stripMarkdown(text) {
	return text.replace(/<!--[\s\S]*?-->/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
}
/** Strip the leading H3 marker (`### Added` → `Added`). */
function stripHeading(text) {
	return text.replace(/^#{1,6}[ \t]+/, "").trim();
}
/**
* Extract the curated summary block (`### 🆕 What's New` or `## 🆕 What's New`)
* from a section body: its bullets only, each truncated to
* WHATS_NEW_ITEM_MAX_CHARS, capped to WHATS_NEW_SUMMARY_MAX_ITEMS. Null when
* the section carries no summary block (the full-section fallback applies).
*/
function extractWhatsNewSummary(body) {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => /^#{2,3}[ \t]+.*What'?s New/i.test(line.trim()));
	if (start === -1) return null;
	const items = [];
	for (const rawLine of lines.slice(start + 1)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("<!--")) continue;
		if (/^#{1,6}[ \t]/.test(line)) break;
		if (!/^[-*][ \t]/.test(line)) continue;
		if (items.length >= 6) break;
		const content = stripMarkdown(line.replace(/^[-*][ \t]+/, ""));
		if (content === "") continue;
		items.push(content.length > 140 ? `${content.slice(0, 139)}…` : content);
	}
	return items.length > 0 ? items : null;
}
/**
* Extract the release highlights for `version`. When the section carries a
* curated `🆕 What's New` summary block, THE WINDOW SHOWS ONLY THAT (the
* full Added/Changed/Fixed walls are for the CHANGELOG readers, not the
* dialog); otherwise it falls back to the H3-group extraction bounded to
* WHATS_NEW_MAX_ITEMS bullets. A missing section, a bullet-less section or a
* blank changelog all return EMPTY_HIGHLIGHTS (no window).
*/
function extractHighlights(changelogText, version) {
	const { found, body } = extractSection(changelogText ?? "", version ?? "");
	if (!found || !body) return { ...EMPTY_HIGHLIGHTS };
	const summary = extractWhatsNewSummary(body);
	if (summary !== null) return {
		version: String(version).trim().replace(/^v/i, ""),
		found: true,
		groups: [{
			heading: null,
			items: summary
		}],
		totalItems: summary.length,
		truncated: false
	};
	const groups = [];
	let totalItems = 0;
	let truncated = false;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("<!--")) continue;
		if (/^#{1,6}[ \t]/.test(line)) {
			const heading = stripMarkdown(stripHeading(line));
			if (heading === "") continue;
			if (groups.at(-1)?.items.length === 0) groups.pop();
			groups.push({
				heading,
				items: []
			});
			continue;
		}
		if (totalItems >= 12) {
			if (/^[-*][ \t]/.test(line)) totalItems += 1;
			continue;
		}
		const isBullet = /^[-*][ \t]/.test(line);
		const continuation = (groups.at(-1)?.items.length ?? 0) > 0;
		if (!isBullet && !continuation) continue;
		const content = stripMarkdown(isBullet ? line.replace(/^[-*][ \t]+/, "") : line);
		if (content === "") continue;
		const bounded = content.length > 140 ? `${content.slice(0, 139)}…` : content;
		const group = groups.at(-1);
		if (group === void 0) groups.push({
			heading: null,
			items: [bounded]
		});
		else if (isBullet || group.items.length === 0) group.items.push(bounded);
		else group.items[group.items.length - 1] = `${group.items.at(-1)} ${bounded}`.trim();
		if (isBullet) totalItems += 1;
	}
	const kept = groups.filter((group) => group.items.length > 0);
	truncated = totalItems > 12;
	return {
		version: found ? String(version).trim().replace(/^v/i, "") : null,
		found,
		groups: kept,
		totalItems,
		truncated
	};
}
/** Window title — mirrors the sidebar's `Pantheon v<version>` convention. */
function whatsNewTitle(version) {
	return `O que há de novo — Pantheon v${String(version).trim().replace(/^v/i, "")}`;
}
/** Flat display lines for the window: group headings, `• ` bullets, `+N more`. */
function whatsNewLines(highlights) {
	const lines = [];
	for (const group of highlights.groups) {
		if (group.heading !== null) lines.push(group.heading);
		for (const item of group.items) lines.push(`• ${item}`);
	}
	if (highlights.truncated) {
		const hidden = Math.max(0, highlights.totalItems - 12);
		if (hidden > 0) lines.push(`${WHATS_NEW_MORE_PREFIX}${hidden} mais`);
	}
	return lines;
}
/**
* Candidate CHANGELOG.md locations for a bundle, first readable wins:
*   1. the plugin copy root (`<configDir>/plugins/pantheon-tui/CHANGELOG.md`,
*      shipped by both installers next to package.json);
*   2. the package root (dev checkout; also an npm-package install when the
*      bundle runs from `<pkg>/src/plugins/tui/dist/`).
*/
function changelogCandidates(bundlePath) {
	const dist = dirname(bundlePath);
	const copyRoot = dirname(dist);
	const packageRoot = dirname(dirname(dirname(copyRoot)));
	return [join(copyRoot, "CHANGELOG.md"), join(packageRoot, "CHANGELOG.md")];
}
/** Read the first existing candidate; null when none is readable (no window). */
async function readChangelogForBundle(bundleUrl) {
	try {
		const bundlePath = fileURLToPath(bundleUrl);
		for (const candidate of changelogCandidates(bundlePath)) try {
			return await readFile(candidate, "utf8");
		} catch {}
		return null;
	} catch {
		return null;
	}
}
/** The ambient build-time version, or null outside a tsdown build. */
function embeddedVersion() {
	return "2.2.2";
}
/**
* Resolve the running Pantheon version for the what's-new window: the plugin
* copy's own package.json first (the copy root two levels above the bundle,
* then the package root four levels above — the same legs as the V1 sidebar's
* detectVersion try 0a/0b), falling back to the tsdown build embed. Null when
* nothing resolves → no window (fail-open).
*/
async function resolveRunningVersion$1(bundleUrl, embedded = embeddedVersion()) {
	try {
		const bundlePath = fileURLToPath(bundleUrl);
		const dist = dirname(bundlePath);
		for (const root of [dirname(dist), dirname(dirname(dirname(dist)))]) try {
			const raw = await readFile(join(root, "package.json"), "utf8");
			const parsed = JSON.parse(raw);
			if (typeof parsed.version === "string" && parsed.version.trim() !== "") return parsed.version;
		} catch {}
	} catch {}
	return embedded;
}
//#endregion
//#region src/pantheon-settings.tsx
/** @jsxImportSource @opentui/solid */
/**
* pantheon-settings.tsx — the /pantheon-settings window (2.0.0-beta.4).
*
* A FULL-SCREEN settings window in the OpenCode Quota shape: a tab header,
* grouped setting rows with ←/→ value cyclers, a note column, and a
* save/reset footer. The surface is a ROUTER PAGE (`ui.router.register` +
* `navigate({type:'plugin'})`) — true full-screen, reachable from the home
* route AND sessions, no focus dance (binary-verified precedent: the host's
* own opencode.diffs plugin). Hosts without a router fall back to the old
* dialog with the same commands (fail-open).
*
* Edits stage into a DRAFT: ←/→ cycles a row's value, `ctrl+s` saves every
* staged row through the per-surface guards, `ctrl+r` resets the current
* tab, `esc`/`q` confirms before discarding. The disk never changes before
* save, and every refusal surfaces in the notice line — never silent.
*
* The keymap layer is registered ONCE at setup with `priority: 1` (the host
* resolves bind conflicts by priority then registration order — a stale
* dispatch-panel layer must never win while this window is open; field
* report beta.2: navigation "stopped working" was exactly that theft).
*/
const ROUTE_NAME = "pantheon-settings";
/** The input mode the page pushes while mounted (composer layers sleep). */
const ROUTE_MODE = "pantheon-settings";
/** Loose local shape of a host route (the real Route lives in the host typings). */
/**
* Strip a LIVE route object down to the plain shape the route store expects.
* `router.current()` returns the host's live data (reactive proxies, location
* objects with cycles) and the host's navigate deep-clones via JSON.stringify
* — passing the live object through throws "cyclic structures" and the
* window could never close (field report beta.5, root cause).
*/
function plainRoute(route) {
	if (route === void 0) return { type: "home" };
	if (route.type === "session" && "sessionID" in route && typeof route.sessionID === "string") return {
		type: "session",
		sessionID: route.sessionID
	};
	if (route.type === "plugin" && typeof route.name === "string") return {
		type: "plugin",
		name: route.name
	};
	return { type: "home" };
}
const [blocking, setBlocking] = createSignal(false);
/** True while a Pantheon settings surface (page or fallback dialog) is open. */
function pantheonSettingsBlocking() {
	return blocking();
}
let routerAvailable = false;
function resolveWorkspaceDir(context) {
	try {
		const dataLoc = context.data?.location;
		const def = dataLoc?.default?.();
		const candidate = (def ? dataLoc?.info?.(def) : void 0)?.directory ?? def?.directory ?? def?.worktree;
		if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
	} catch {}
	return process.cwd();
}
function globalOverridesPath() {
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
	return join(xdgConfig, "opencode", "pantheon-overrides.json");
}
function projectOverridesPath(workspaceDir = process.cwd()) {
	return join(workspaceDir, ".pantheon", "overrides.json");
}
function readOneOverrides(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {
			value: {},
			corrupt: true
		};
		return {
			value: parsed,
			corrupt: false
		};
	} catch (error) {
		return {
			value: {},
			corrupt: error?.code !== "ENOENT"
		};
	}
}
function readOverridesLoad(workspaceDir = process.cwd()) {
	const globalRead = readOneOverrides(globalOverridesPath());
	const projectRead = readOneOverrides(projectOverridesPath(workspaceDir));
	return {
		global: globalRead.value,
		project: projectRead.value,
		corruptGlobal: globalRead.corrupt
	};
}
function writeOverridesToDisk(load) {
	const target = globalOverridesPath();
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, serializeOverrides(load.global), "utf8");
}
function writeProjectOverridesToDisk(workspaceDir, overrides) {
	const target = projectOverridesPath(workspaceDir);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, serializeOverrides(overrides), "utf8");
}
function userOpenCodeConfigPath() {
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
	return join(xdgConfig, "opencode", "opencode.json");
}
/** Read options.goal_loop from the user's opencode.json (fail-open). */
function readGoalLoopPrefs() {
	const fallback = { ...DEFAULT_GOAL_LOOP_PREFS };
	try {
		const raw = JSON.parse(readFileSync(userOpenCodeConfigPath(), "utf8"))?.options?.goal_loop;
		if (raw && typeof raw === "object") return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
			cooldownMs: typeof raw.cooldownMs === "number" && raw.cooldownMs >= 1e3 ? Math.floor(raw.cooldownMs) : fallback.cooldownMs,
			maxContinuations: typeof raw.maxContinuations === "number" && raw.maxContinuations >= 1 ? Math.min(200, Math.floor(raw.maxContinuations)) : fallback.maxContinuations
		};
	} catch {}
	return fallback;
}
/** Read the decision budgets from decision-router.json's `budget` envelope (fail-open). */
function readDecisionBudgets() {
	const fallback = { ...DEFAULT_DECISION_BUDGETS };
	try {
		const path = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"), "pantheon", "decision-router.json");
		const raw = JSON.parse(readFileSync(path, "utf8"))?.budget;
		if (raw && typeof raw === "object") return {
			monthlyUsd: typeof raw.monthlyUsd === "number" && raw.monthlyUsd > 0 ? raw.monthlyUsd : fallback.monthlyUsd,
			perDecisionUsd: typeof raw.perDecisionUsd === "number" && raw.perDecisionUsd > 0 ? raw.perDecisionUsd : fallback.perDecisionUsd
		};
	} catch {}
	return fallback;
}
/**
* Surgically set one key under `options` in the user's opencode.json
* (preserving every other key). Startup-applied options live here — the
* runtime resolves them once at plugin setup.
*/
function writeUserOption(key, value) {
	const path = userOpenCodeConfigPath();
	let doc = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) doc = parsed;
	} catch {}
	const options = typeof doc.options === "object" && doc.options !== null && !Array.isArray(doc.options) ? { ...doc.options } : {};
	options[key] = value;
	doc.options = options;
	writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}
/** Merge the `budget` envelope into decision-router.json (0600 preserved). */
function writeDecisionBudget(budgets) {
	const path = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"), "pantheon", "decision-router.json");
	let doc = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) doc = parsed;
	} catch {
		throw new Error("decision-router.json unreadable — repair via `decision-router setup-model`");
	}
	doc.budget = { ...budgets };
	const temp = `${path}.tui.tmp`;
	writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 384 });
	renameSync(temp, path);
}
function decisionAuthStorePath() {
	const xdgData = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share");
	return join(xdgData, "opencode", "auth.json");
}
/** Provider ids registered in the host auth store (existence only — never values). */
function readAuthProviders() {
	const names = /* @__PURE__ */ new Set();
	try {
		const parsed = JSON.parse(readFileSync(decisionAuthStorePath(), "utf8"));
		for (const key of Object.keys(parsed)) names.add(key);
	} catch {}
	return names;
}
/** Provider ids present in opencode.json `providers` (the config copy the host reads). */
function readConfigProviders() {
	const names = /* @__PURE__ */ new Set();
	try {
		const parsed = JSON.parse(readFileSync(userOpenCodeConfigPath(), "utf8"));
		for (const key of Object.keys(parsed?.providers ?? {})) names.add(key);
	} catch {}
	return names;
}
function updateCheckStatePath() {
	const stateDir = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local", "state");
	return join(stateDir, "pantheon", "update-check.json");
}
function readUpdateCheckState() {
	try {
		return JSON.parse(readFileSync(updateCheckStatePath(), "utf8"));
	} catch {
		return {};
	}
}
async function fetchLatestForChannel(channel) {
	try {
		const response = await fetch(registryUrlForChannel(channel), { signal: AbortSignal.timeout(5e3) });
		return String((await response.json())?.version ?? "") || null;
	} catch {
		return null;
	}
}
function persistUpdateCheckState(previous, latest) {
	try {
		const path = updateCheckStatePath();
		mkdirSync(join(path, ".."), { recursive: true });
		const next = withKnownLatest(nextCheckState(previous, latest ? {
			version: latest,
			message: ""
		} : null, Date.now()), latest);
		writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	} catch {}
}
function resolveRunningVersion() {
	return "2.2.2";
}
const VALUE_WIDTH = 32;
function SettingsWindow(props) {
	const isPt = () => resolveLanguage(tuiPrefs().layout?.language) === "pt-BR";
	const formatValueDisplay = (val) => {
		if (!isPt()) return val;
		switch (val) {
			case "enabled": return "ativado";
			case "disabled": return "desativado";
			case "granted": return "permitido";
			case "not granted": return "não permitido";
			case "explicit": return "explícito";
			case "auto": return "automático";
			case "local": return "local";
			case "autonomous": return "autônomo";
			case "arbitrated": return "arbitrado";
			case "human review": return "revisão humana";
			case "MISSING":
			case "missing": return "PENDENTE";
			case "auth store": return "login opencode";
			case "env": return "variável env";
			case "config": return "configuração";
			case "never checked": return "nunca verificado";
			case "up to date": return "atualizado";
			case "none": return "nenhum";
			default: return val;
		}
	};
	const tab = () => props.tabs()[props.page()] ?? props.tabs()[0] ?? EMPTY_TAB;
	return (() => {
		var _el$ = createElement("box"), _el$2 = createElement("box"), _el$3 = createElement("text"), _el$4 = createElement("b"), _el$6 = createElement("span"), _el$7 = createElement("box"), _el$8 = createElement("box"), _el$9 = createElement("box"), _el$0 = createElement("text"), _el$10 = createElement("box"), _el$11 = createElement("scrollbox");
		insertNode(_el$, _el$2);
		insertNode(_el$, _el$10);
		spread(_el$, mergeProps(() => props.boxRef !== void 0 ? { ref: props.boxRef } : {}, {
			"focusable": true,
			"flexDirection": "column",
			"width": "100%"
		}, () => props.isDialog ? { minWidth: 80 } : {}, () => props.height !== void 0 ? { height: props.height } : {
			flexGrow: 1,
			flexBasis: 0
		}, {
			"minHeight": 0,
			get border() {
				return !props.isDialog;
			}
		}, () => props.isDialog ? {} : { borderStyle: "rounded" }, {
			get borderColor() {
				return memo(() => !!props.isDialog)() ? void 0 : memo(() => !!props.hasKeyboard?.())() ? props.warn ?? "#fba970" : props.muted ?? "#52525b";
			},
			"paddingLeft": 1,
			"paddingRight": 1,
			"paddingTop": 0,
			"paddingBottom": 0
		}, () => props.onMouseDown !== void 0 ? { onMouseDown: props.onMouseDown } : {}), true);
		insertNode(_el$2, _el$3);
		insertNode(_el$2, _el$7);
		insertNode(_el$2, _el$8);
		insertNode(_el$2, _el$9);
		setProp(_el$2, "flexDirection", "row");
		setProp(_el$2, "flexWrap", "wrap");
		setProp(_el$2, "alignItems", "center");
		setProp(_el$2, "flexShrink", 0);
		setProp(_el$2, "marginBottom", 1);
		setProp(_el$2, "rowGap", 1);
		insertNode(_el$3, _el$4);
		insertNode(_el$3, _el$6);
		setProp(_el$3, "attributes", 1);
		setProp(_el$3, "wrapMode", "none");
		insertNode(_el$4, createTextNode(`Pantheon`));
		insert(_el$6, () => ` v${props.version}`);
		setProp(_el$7, "width", 2);
		setProp(_el$8, "flexDirection", "row");
		setProp(_el$8, "flexWrap", "wrap");
		setProp(_el$8, "flexGrow", 1);
		setProp(_el$8, "flexShrink", 1);
		setProp(_el$8, "minWidth", 0);
		setProp(_el$8, "columnGap", 1);
		setProp(_el$8, "rowGap", 1);
		insert(_el$8, createComponent(For, {
			get each() {
				return props.tabs();
			},
			children: (t, index) => {
				const isActive = () => index() === props.page();
				return (() => {
					var _el$27 = createElement("box"), _el$28 = createElement("text");
					insertNode(_el$27, _el$28);
					setProp(_el$27, "onMouseDown", () => props.onJumpTab?.(index()));
					setProp(_el$27, "paddingLeft", 1);
					setProp(_el$27, "paddingRight", 1);
					setProp(_el$27, "flexShrink", 0);
					spread(_el$27, mergeProps(() => isActive() ? { backgroundColor: "#262626" } : {}), true);
					setProp(_el$28, "wrapMode", "none");
					spread(_el$28, mergeProps({ get fg() {
						return memo(() => !!isActive())() ? props.warn ?? "#fba970" : props.muted;
					} }, () => isActive() ? { attributes: 1 } : {}), true);
					insert(_el$28, () => `${t.title}${tabDirty(props.draft(), t) ? " ●" : ""}`);
					return _el$27;
				})();
			}
		}));
		insertNode(_el$9, _el$0);
		setProp(_el$9, "onMouseDown", stopMouseEvent);
		setProp(_el$9, "onMouseUp", (event) => handleMouseClick(event, props.onClose));
		setProp(_el$9, "paddingLeft", 1);
		setProp(_el$9, "flexShrink", 0);
		insertNode(_el$0, createTextNode(`esc`));
		setProp(_el$0, "wrapMode", "none");
		insertNode(_el$10, _el$11);
		setProp(_el$10, "flexDirection", "column");
		setProp(_el$10, "flexGrow", 1);
		setProp(_el$10, "flexBasis", 0);
		setProp(_el$10, "minHeight", 0);
		setProp(_el$10, "overflow", "hidden");
		setProp(_el$11, "flexGrow", 1);
		setProp(_el$11, "flexBasis", 0);
		setProp(_el$11, "minHeight", 0);
		spread(_el$11, mergeProps(() => props.maxHeight !== void 0 ? { maxHeight: props.maxHeight } : {}), true);
		insert(_el$11, createComponent(For, {
			get each() {
				return tab().groups;
			},
			children: (group) => (() => {
				var _el$29 = createElement("box");
				setProp(_el$29, "flexDirection", "column");
				setProp(_el$29, "marginBottom", 1);
				insert(_el$29, createComponent(Show, {
					get when() {
						return group.title !== void 0;
					},
					get children() {
						var _el$30 = createElement("text");
						setProp(_el$30, "attributes", 1);
						insert(_el$30, () => group.title);
						effect((_$p) => setProp(_el$30, "fg", props.warn ?? props.fg, _$p));
						return _el$30;
					}
				}), null);
				insert(_el$29, createComponent(For, {
					get each() {
						return group.rows;
					},
					children: (row) => {
						const isSelected = () => row.id === props.selectedId();
						const display = () => props.draft()[row.id] ?? row.value;
						const staged = () => props.draft()[row.id] !== void 0;
						const gutter = () => isSelected() ? "▸ " : "  ";
						const valueCell = () => {
							const formatted = formatValueDisplay(display());
							const raw = row.cycle !== void 0 ? `< ${formatted} >` : row.action !== void 0 ? `[ ${formatted} ]` : row.id.startsWith("autonomy.gradient.") ? `[ref] ${formatted}` : formatted;
							const maxLen = VALUE_WIDTH - (staged() ? 2 : 0);
							return raw.length > maxLen ? `${raw.slice(0, maxLen - 1)}…` : raw;
						};
						return (() => {
							var _el$31 = createElement("box"), _el$32 = createElement("box"), _el$33 = createElement("text"), _el$34 = createElement("box");
							insertNode(_el$31, _el$32);
							insertNode(_el$31, _el$34);
							setProp(_el$31, "flexDirection", "row");
							spread(_el$31, mergeProps(() => isSelected() ? { backgroundColor: "#262626" } : {}, { "onMouseDown": () => {
								props.onSelectRow?.(row.id);
							} }), true);
							insertNode(_el$32, _el$33);
							setProp(_el$32, "width", 26);
							setProp(_el$32, "flexShrink", 0);
							setProp(_el$33, "wrapMode", "none");
							spread(_el$33, mergeProps({ get fg() {
								return memo(() => !!isSelected())() ? props.warn ?? "#fba970" : props.fg;
							} }, () => isSelected() ? { attributes: 1 } : {}), true);
							insert(_el$33, () => `${gutter()}${row.name}`.padEnd(26));
							setProp(_el$34, "width", 2);
							setProp(_el$34, "flexShrink", 0);
							insert(_el$31, createComponent(Show, {
								get when() {
									return memo(() => row.value !== "")() && row.value !== void 0;
								},
								get children() {
									return [(() => {
										var _el$35 = createElement("box"), _el$36 = createElement("text");
										insertNode(_el$35, _el$36);
										setProp(_el$35, "width", 32);
										setProp(_el$35, "flexShrink", 0);
										setProp(_el$35, "onMouseDown", () => {
											props.onSelectRow?.(row.id);
											props.onCycleValue?.(row.id, 1);
										});
										setProp(_el$36, "wrapMode", "none");
										spread(_el$36, mergeProps({ get fg() {
											return memo(() => !!isSelected())() ? "#ffffff" : memo(() => !!staged())() ? props.warn ?? props.fg : props.muted;
										} }, () => isSelected() || staged() ? { attributes: 1 } : {}), true);
										insert(_el$36, () => `${valueCell()}${staged() ? " ●" : ""}`.padEnd(VALUE_WIDTH));
										return _el$35;
									})(), (() => {
										var _el$37 = createElement("box");
										setProp(_el$37, "width", 2);
										setProp(_el$37, "flexShrink", 0);
										return _el$37;
									})()];
								}
							}), null);
							insert(_el$31, createComponent(Show, {
								get when() {
									return row.note !== void 0;
								},
								get children() {
									var _el$38 = createElement("box"), _el$39 = createElement("text");
									insertNode(_el$38, _el$39);
									setProp(_el$38, "flexGrow", 1);
									setProp(_el$38, "flexShrink", 1);
									insert(_el$39, () => row.note);
									effect((_$p) => setProp(_el$39, "fg", isSelected() ? "#e5e7eb" : props.muted, _$p));
									return _el$38;
								}
							}), null);
							return _el$31;
						})();
					}
				}), null);
				return _el$29;
			})()
		}));
		insert(_el$, createComponent(Show, {
			get when() {
				return props.notice() !== void 0;
			},
			get children() {
				var _el$12 = createElement("text");
				insert(_el$12, (() => {
					var _c$ = memo(() => !!(props.notice()?.startsWith("[OK]") || props.notice()?.startsWith("saved")));
					return () => _c$() ? props.notice() : `[WARN] ${props.notice()}`;
				})());
				effect((_$p) => setProp(_el$12, "fg", props.notice()?.startsWith("[OK]") || props.notice()?.startsWith("saved") ? props.fg : props.warn ?? props.muted, _$p));
				return _el$12;
			}
		}), null);
		insert(_el$, createComponent(Show, {
			get when() {
				return props.confirmExit?.();
			},
			get fallback() {
				return (() => {
					var _el$40 = createElement("box"), _el$54 = createElement("text");
					insertNode(_el$40, _el$54);
					setProp(_el$40, "flexDirection", "column");
					insert(_el$40, createComponent(Show, {
						get when() {
							return draftDirty(props.draft());
						},
						get fallback() {
							return (() => {
								var _el$55 = createElement("box"), _el$56 = createElement("box"), _el$57 = createElement("text"), _el$59 = createElement("text"), _el$61 = createElement("box"), _el$62 = createElement("text"), _el$64 = createElement("text"), _el$66 = createElement("box"), _el$67 = createElement("text"), _el$69 = createElement("box"), _el$70 = createElement("text");
								insertNode(_el$55, _el$56);
								insertNode(_el$55, _el$59);
								insertNode(_el$55, _el$61);
								insertNode(_el$55, _el$64);
								insertNode(_el$55, _el$66);
								insertNode(_el$55, _el$69);
								insertNode(_el$55, _el$70);
								setProp(_el$55, "flexDirection", "row");
								setProp(_el$55, "flexWrap", "wrap");
								setProp(_el$55, "alignItems", "center");
								setProp(_el$55, "flexShrink", 0);
								setProp(_el$55, "rowGap", 1);
								insertNode(_el$56, _el$57);
								setProp(_el$56, "backgroundColor", "#262626");
								setProp(_el$56, "flexShrink", 0);
								setProp(_el$56, "onMouseDown", stopMouseEvent);
								setProp(_el$56, "onMouseUp", (event) => handleMouseClick(event, props.onClose));
								insertNode(_el$57, createTextNode(` Close `));
								setProp(_el$57, "fg", "#ffffff");
								insertNode(_el$59, createTextNode(`  `));
								setProp(_el$59, "flexShrink", 0);
								insertNode(_el$61, _el$62);
								setProp(_el$61, "backgroundColor", "#262626");
								setProp(_el$61, "flexShrink", 0);
								setProp(_el$61, "onMouseDown", () => props.onResetPage?.());
								insertNode(_el$62, createTextNode(` Reset page `));
								setProp(_el$62, "fg", "#ffffff");
								insertNode(_el$64, createTextNode(`  `));
								setProp(_el$64, "flexShrink", 0);
								insertNode(_el$66, _el$67);
								setProp(_el$66, "backgroundColor", "#262626");
								setProp(_el$66, "flexShrink", 0);
								setProp(_el$66, "onMouseDown", () => props.onStageDefaults?.());
								insertNode(_el$67, createTextNode(` Defaults `));
								setProp(_el$67, "fg", "#ffffff");
								setProp(_el$69, "flexGrow", 1);
								setProp(_el$69, "minWidth", 1);
								setProp(_el$70, "flexShrink", 0);
								insert(_el$70, () => isPt() ? "sem alterações pendentes" : "no staged changes");
								effect((_p$) => {
									var _v$11 = props.muted, _v$12 = props.muted, _v$13 = props.muted;
									_v$11 !== _p$.e && (_p$.e = setProp(_el$59, "fg", _v$11, _p$.e));
									_v$12 !== _p$.t && (_p$.t = setProp(_el$64, "fg", _v$12, _p$.t));
									_v$13 !== _p$.a && (_p$.a = setProp(_el$70, "fg", _v$13, _p$.a));
									return _p$;
								}, {
									e: void 0,
									t: void 0,
									a: void 0
								});
								return _el$55;
							})();
						},
						get children() {
							var _el$41 = createElement("box"), _el$42 = createElement("box"), _el$43 = createElement("text"), _el$44 = createElement("text"), _el$46 = createElement("box"), _el$47 = createElement("text"), _el$48 = createElement("text"), _el$50 = createElement("box"), _el$51 = createElement("text"), _el$52 = createElement("box"), _el$53 = createElement("text");
							insertNode(_el$41, _el$42);
							insertNode(_el$41, _el$44);
							insertNode(_el$41, _el$46);
							insertNode(_el$41, _el$48);
							insertNode(_el$41, _el$50);
							insertNode(_el$41, _el$52);
							insertNode(_el$41, _el$53);
							setProp(_el$41, "flexDirection", "row");
							setProp(_el$41, "flexWrap", "wrap");
							setProp(_el$41, "alignItems", "center");
							setProp(_el$41, "flexShrink", 0);
							setProp(_el$41, "rowGap", 1);
							insertNode(_el$42, _el$43);
							setProp(_el$42, "flexShrink", 0);
							setProp(_el$42, "onMouseDown", () => props.onSave?.());
							setProp(_el$43, "fg", "#000000");
							insert(_el$43, () => isPt() ? " Salvar " : " Save ");
							insertNode(_el$44, createTextNode(`  `));
							setProp(_el$44, "flexShrink", 0);
							insertNode(_el$46, _el$47);
							setProp(_el$46, "backgroundColor", "#262626");
							setProp(_el$46, "flexShrink", 0);
							setProp(_el$46, "onMouseDown", () => props.onDiscard?.());
							setProp(_el$47, "fg", "#ffffff");
							insert(_el$47, () => isPt() ? " Descartar " : " Discard ");
							insertNode(_el$48, createTextNode(`  `));
							setProp(_el$48, "flexShrink", 0);
							insertNode(_el$50, _el$51);
							setProp(_el$50, "backgroundColor", "#262626");
							setProp(_el$50, "flexShrink", 0);
							setProp(_el$50, "onMouseDown", () => props.onResetPage?.());
							setProp(_el$51, "fg", "#ffffff");
							insert(_el$51, () => isPt() ? " Redefinir página " : " Reset page ");
							setProp(_el$52, "flexGrow", 1);
							setProp(_el$52, "minWidth", 1);
							setProp(_el$53, "flexShrink", 0);
							insert(_el$53, () => isPt() ? "alterações não salvas" : "unsaved changes");
							effect((_p$) => {
								var _v$9 = props.warn ?? "#fba970", _v$0 = props.muted, _v$1 = props.muted, _v$10 = props.warn ?? "#f59e0b";
								_v$9 !== _p$.e && (_p$.e = setProp(_el$42, "backgroundColor", _v$9, _p$.e));
								_v$0 !== _p$.t && (_p$.t = setProp(_el$44, "fg", _v$0, _p$.t));
								_v$1 !== _p$.a && (_p$.a = setProp(_el$48, "fg", _v$1, _p$.a));
								_v$10 !== _p$.o && (_p$.o = setProp(_el$53, "fg", _v$10, _p$.o));
								return _p$;
							}, {
								e: void 0,
								t: void 0,
								a: void 0,
								o: void 0
							});
							return _el$41;
						}
					}), _el$54);
					insert(_el$54, () => {
						const currentRow = findRow(tab(), props.selectedId() ?? "");
						if (currentRow?.cycle !== void 0) return isPt() ? "clique ou ›/←/→ alterar · ↑↓ selecionar · tab próxima aba · ctrl+s salvar · ctrl+r redefinir · esc fechar" : "click or ›/←/→ change · ↑↓ select · tab next tab · ctrl+s save · ctrl+r reset page · esc close";
						if (currentRow?.action !== void 0) return isPt() ? "enter ou espaço executar · ↑↓ selecionar · tab próxima aba · ctrl+s salvar · ctrl+r redefinir · esc fechar" : "enter or space run action · ↑↓ select · tab next tab · ctrl+s save · ctrl+r reset page · esc close";
						return isPt() ? "[ref] política de referência (somente leitura) · ↑↓ selecionar · tab próxima aba · esc fechar" : "[ref] documented reference (read-only) · ↑↓ select · tab next tab · esc close";
					});
					effect((_$p) => setProp(_el$54, "fg", props.muted, _$p));
					return _el$40;
				})();
			},
			get children() {
				var _el$13 = createElement("box"), _el$14 = createElement("box"), _el$15 = createElement("text"), _el$16 = createElement("box"), _el$17 = createElement("text"), _el$18 = createElement("text"), _el$20 = createElement("box"), _el$21 = createElement("text"), _el$22 = createElement("text"), _el$24 = createElement("box"), _el$25 = createElement("text"), _el$26 = createElement("text");
				insertNode(_el$13, _el$14);
				insertNode(_el$13, _el$26);
				setProp(_el$13, "flexDirection", "column");
				insertNode(_el$14, _el$15);
				insertNode(_el$14, _el$16);
				insertNode(_el$14, _el$18);
				insertNode(_el$14, _el$20);
				insertNode(_el$14, _el$22);
				insertNode(_el$14, _el$24);
				setProp(_el$14, "flexDirection", "row");
				setProp(_el$15, "attributes", 1);
				insert(_el$15, () => isPt() ? "Deseja salvar as alterações?  " : "Keep your changes?  ");
				insertNode(_el$16, _el$17);
				setProp(_el$16, "onMouseDown", stopMouseEvent);
				setProp(_el$16, "onMouseUp", (event) => handleMouseClick(event, props.onSave));
				setProp(_el$17, "fg", "#000000");
				insert(_el$17, () => isPt() ? " Salvar " : " Save ");
				insertNode(_el$18, createTextNode(`  `));
				insertNode(_el$20, _el$21);
				setProp(_el$20, "backgroundColor", "#262626");
				setProp(_el$20, "onMouseDown", stopMouseEvent);
				setProp(_el$20, "onMouseUp", (event) => handleMouseClick(event, props.onDiscard));
				setProp(_el$21, "fg", "#ffffff");
				insert(_el$21, () => isPt() ? " Descartar " : " Discard ");
				insertNode(_el$22, createTextNode(`  `));
				insertNode(_el$24, _el$25);
				setProp(_el$24, "backgroundColor", "#262626");
				setProp(_el$24, "onMouseDown", stopMouseEvent);
				setProp(_el$24, "onMouseUp", (event) => handleMouseClick(event, props.onCancelExit));
				setProp(_el$25, "fg", "#ffffff");
				insert(_el$25, () => isPt() ? " Continuar editando " : " Keep editing ");
				insert(_el$26, () => isPt() ? "ctrl+s salvar · d descartar alterações · esc continuar editando" : "ctrl+s save · d discard the changes · esc keep editing");
				effect((_p$) => {
					var _v$ = props.warn ?? "#f59e0b", _v$2 = props.warn ?? "#fba970", _v$3 = props.muted, _v$4 = props.muted, _v$5 = props.muted;
					_v$ !== _p$.e && (_p$.e = setProp(_el$15, "fg", _v$, _p$.e));
					_v$2 !== _p$.t && (_p$.t = setProp(_el$16, "backgroundColor", _v$2, _p$.t));
					_v$3 !== _p$.a && (_p$.a = setProp(_el$18, "fg", _v$3, _p$.a));
					_v$4 !== _p$.o && (_p$.o = setProp(_el$22, "fg", _v$4, _p$.o));
					_v$5 !== _p$.i && (_p$.i = setProp(_el$26, "fg", _v$5, _p$.i));
					return _p$;
				}, {
					e: void 0,
					t: void 0,
					a: void 0,
					o: void 0,
					i: void 0
				});
				return _el$13;
			}
		}), null);
		effect((_p$) => {
			var _v$6 = props.fg, _v$7 = { fg: props.muted }, _v$8 = props.muted;
			_v$6 !== _p$.e && (_p$.e = setProp(_el$3, "fg", _v$6, _p$.e));
			_v$7 !== _p$.t && (_p$.t = setProp(_el$6, "style", _v$7, _p$.t));
			_v$8 !== _p$.a && (_p$.a = setProp(_el$0, "fg", _v$8, _p$.a));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0
		});
		return _el$;
	})();
}
let pageApi;
let pendingInitialTabId;
function createWindowController(context, exit) {
	const currentVersion = resolveRunningVersion();
	const workspaceDir = resolveWorkspaceDir(context);
	const initialLoad = readOverridesLoad(workspaceDir);
	const [page, setPage] = createSignal(0);
	const [selected, setSelected] = createSignal(0);
	const [load, setLoad] = createSignal(initialLoad);
	const [overridesScope, setOverridesScope] = createSignal(Object.keys(initialLoad.project).length > 0 ? "project" : "global");
	const [decision, setDecision] = createSignal(readDecisionRouterConfig());
	const [goalLoop, setGoalLoop] = createSignal(readGoalLoopPrefs());
	const [budgets, setBudgets] = createSignal(readDecisionBudgets());
	const [autonomyRestartPending, setAutonomyRestartPending] = createSignal(false);
	const [presetTick, setPresetTick] = createSignal(0);
	const [selectedChannel, setSelectedChannel] = createSignal(updateChannelFor(currentVersion));
	const [lastChecked, setLastChecked] = createSignal(void 0);
	const [checking, setChecking] = createSignal(false);
	const [updating, setUpdating] = createSignal(false);
	const [legacyAudit, setLegacyAudit] = createSignal(null);
	const [legacyScanning, setLegacyScanning] = createSignal(false);
	const [legacyCleaning, setLegacyCleaning] = createSignal(false);
	const [legacyNotice, setLegacyNotice] = createSignal(void 0);
	const [confirmPurge, setConfirmPurge] = createSignal(false);
	const [changelogItems, setChangelogItems] = createSignal([]);
	const [draft, setDraft] = createSignal({});
	const [notice, setNotice] = createSignal(void 0);
	const [confirmExit, setConfirmExit] = createSignal(false);
	const activeBundlePath = (() => {
		try {
			return fileURLToPath(import.meta.url);
		} catch {
			return;
		}
	})();
	queueMicrotask(() => {
		try {
			const scan = scanLegacyArtifacts({
				workspaceDir,
				runningVersion: currentVersion,
				...activeBundlePath ? { activeBundlePath } : {}
			});
			setLegacyAudit(scan.summary);
		} catch {}
	});
	createEffect(() => {
		setTuiDraftPreview(draft());
	});
	readChangelogForBundle(import.meta.url).then((text) => {
		if (!text) return;
		const hl = extractHighlights(text, currentVersion);
		if (hl.found) {
			const items = [];
			for (const group of hl.groups) for (const item of group.items) {
				const colon = item.indexOf(": ");
				const emdash = item.indexOf("—");
				const sep = colon !== -1 ? colon : emdash;
				const title = sep !== -1 ? item.slice(0, sep).trim() : item.slice(0, 26);
				const detail = sep !== -1 ? item.slice(sep + (colon !== -1 ? 2 : 1)).trim() : item;
				items.push({
					title,
					detail,
					group: group.heading ?? void 0
				});
			}
			setChangelogItems(items);
		}
	});
	const presetInput = () => {
		presetTick();
		return {
			globalName: readActivePresetMarker(globalActivePresetPath())?.name ?? null,
			projectName: readActivePresetMarker(projectActivePresetPath())?.name ?? null,
			visionModel: readConfiguredVisionModel()
		};
	};
	const updatesInput = () => {
		const noticeMsg = legacyNotice();
		const input = {
			currentVersion,
			state: readUpdateCheckState(),
			selectedChannel: selectedChannel(),
			checking: checking(),
			updating: updating(),
			legacyAudit: legacyAudit(),
			legacyScanning: legacyScanning(),
			legacyCleaning: legacyCleaning(),
			confirmPurge: confirmPurge(),
			...noticeMsg !== void 0 ? { legacyNotice: noticeMsg } : {},
			nowMs: Date.now()
		};
		const seen = lastChecked();
		if (seen !== void 0) input.lastCheckedVersion = seen;
		return input;
	};
	const tabs = () => {
		const rawLang = tuiPrefs().layout?.language;
		const lang = resolveLanguage(rawLang);
		const activeScope = draft()["gates.scope"] ?? overridesScope();
		return [
			buildGatesTab(load(), lang, activeScope),
			buildDecisionTab(decision(), process.env, readAuthProviders(), readConfigProviders(), lang),
			buildPresetTab(presetInput(), lang),
			buildTuiTab(tuiPrefs(), lang),
			buildAutonomyTab({
				goalLoop: goalLoop(),
				budgets: budgets(),
				goalLoopRestartPending: autonomyRestartPending(),
				languagePref: lang
			}),
			buildJ1Tab(process.env, isBehaviorDisabled(mergedOverrides(load()), "gate-j1-risk-gate"), lang),
			buildUpdatesTab({
				...updatesInput(),
				languagePref: lang
			}),
			buildChangelogTab(currentVersion, changelogItems(), lang),
			buildDoctorTab({
				runningVersion: currentVersion,
				nodeVersion: process.versions.node,
				load: load()
			}),
			buildAboutTab(currentVersion, {
				nodeVersion: process.versions.node,
				platform: process.platform,
				preset: readActivePresetMarker(globalActivePresetPath())?.name ?? null,
				decisionEnabled: decision().config.enabled,
				j1Mode: process.env.PANTHEON_J1_RISK_SCORE ?? "shadow",
				languagePref: lang
			})
		];
	};
	if (pendingInitialTabId !== void 0) {
		const requestedTab = pendingInitialTabId;
		pendingInitialTabId = void 0;
		const targetIdx = tabs().findIndex((tab) => tab.id === requestedTab);
		if (targetIdx >= 0) setPage(targetIdx);
	}
	const rows = () => tabRows(tabs()[page()] ?? tabs()[0] ?? EMPTY_TAB);
	const move = (delta) => {
		if (confirmExit()) setConfirmExit(false);
		if (confirmPurge()) setConfirmPurge(false);
		const list = rows();
		if (list.length === 0) return;
		setSelected((current) => Math.min(Math.max(current + delta, 0), list.length - 1));
	};
	const step = (direction) => {
		if (confirmExit()) setConfirmExit(false);
		const row = rows()[selected()];
		if (row === void 0) return;
		setNotice(void 0);
		setDraft(stageValue(draft(), row, direction));
	};
	const checkUpdatesNow = (targetChannel = selectedChannel()) => {
		if (checking()) return;
		setChecking(true);
		setNotice(void 0);
		fetchLatestForChannel(targetChannel).then((latest) => {
			if (latest) {
				setLastChecked(latest);
				setAvailableUpdateVersion(isNewerUpdateAvailable(currentVersion, latest) ? latest : null);
				persistUpdateCheckState(readUpdateCheckState(), latest);
			}
		}).catch(() => {}).finally(() => setChecking(false));
	};
	const runUpdateNow = () => {
		if (updating()) return;
		const pkgSpec = selectedChannel() === "beta" ? "pantheon-opencode@beta" : "pantheon-opencode";
		const finishSuccess = () => {
			setUpdating(false);
			setAvailableUpdateVersion(null);
			setNotice("[OK] plugin updated — restart OpenCode to reload");
			execFile("opencode", ["reload"], {
				cwd: workspaceDir,
				timeout: 15e3
			}, () => {});
			try {
				context.ui.toast?.show?.({
					variant: "info",
					message: "Pantheon plugin updated! Restart OpenCode if the TUI footer does not refresh."
				});
			} catch {}
		};
		setUpdating(true);
		setNotice(`updating plugin (${pkgSpec})…`);
		execFile("opencode", [
			"plugin",
			"update",
			pkgSpec
		], {
			cwd: workspaceDir,
			timeout: 6e4
		}, (err) => {
			if (!err) {
				finishSuccess();
				return;
			}
			execFile("opencode", [
				"plugin",
				"add",
				pkgSpec
			], {
				cwd: workspaceDir,
				timeout: 6e4
			}, (addErr) => {
				if (!addErr) {
					finishSuccess();
					return;
				}
				execFile("npm", [
					"install",
					"-g",
					pkgSpec
				], { timeout: 6e4 }, (npmErr) => {
					setUpdating(false);
					if (npmErr) {
						setNotice(`run in terminal: opencode plugin update ${pkgSpec}`);
						try {
							context.ui.toast?.show?.({
								variant: "warning",
								message: `Update requires terminal permissions: run \`opencode plugin update ${pkgSpec}\``
							});
						} catch {}
					} else {
						setAvailableUpdateVersion(null);
						setNotice("[OK] update complete — restart OpenCode to reload the plugin");
						try {
							context.ui.toast?.show?.({
								variant: "info",
								message: "Pantheon updated successfully!"
							});
						} catch {}
					}
				});
			});
		});
	};
	const scanLegacyNow = () => {
		if (legacyScanning() || legacyCleaning()) return;
		setLegacyScanning(true);
		setLegacyNotice(void 0);
		try {
			const scan = scanLegacyArtifacts({
				workspaceDir,
				runningVersion: currentVersion,
				...activeBundlePath ? { activeBundlePath } : {}
			});
			setLegacyAudit(scan.summary);
			const isPt = resolveLanguage(tuiPrefs().layout?.language) === "pt-BR";
			setNotice(scan.summary.total === 0 ? isPt ? "[OK] nenhum arquivo legado ou obsoleto encontrado" : "[OK] no legacy or obsolete files detected" : isPt ? `${scan.summary.total} arquivo(s) legado(s)/obsoleto(s) (${formatBytes(scan.summary.totalBytes)})` : `found ${scan.summary.total} legacy/obsolete file(s) (${formatBytes(scan.summary.totalBytes)})`);
		} catch {
			setNotice("legacy scan failed");
		} finally {
			setLegacyScanning(false);
		}
	};
	const cleanLegacyNow = () => {
		if (legacyCleaning() || legacyScanning()) return;
		setLegacyCleaning(true);
		const isPt = resolveLanguage(tuiPrefs().layout?.language) === "pt-BR";
		try {
			const auditOpts = {
				workspaceDir,
				runningVersion: currentVersion,
				...activeBundlePath ? { activeBundlePath } : {}
			};
			const res = cleanLegacyArtifacts(auditOpts);
			const after = scanLegacyArtifacts(auditOpts);
			setLegacyAudit(after.summary);
			setLoad(readOverridesLoad(workspaceDir));
			const summaryMsg = isPt ? `limpos ${res.removed.length} item(ns) (${formatBytes(res.reclaimedBytes)}), ${res.migratedRecords} registro(s) migrado(s)` : `removed ${res.removed.length} item(s) (${formatBytes(res.reclaimedBytes)}), ${res.migratedRecords} record(s) migrated`;
			setLegacyNotice(summaryMsg);
			setNotice(`[OK] ${summaryMsg}`);
			try {
				context.ui.toast?.show?.({
					variant: res.errors.length > 0 ? "warning" : "info",
					message: summaryMsg
				});
			} catch {}
		} catch {
			setNotice(isPt ? "falha ao limpar arquivos legados" : "legacy cleanup failed");
		} finally {
			setLegacyCleaning(false);
		}
	};
	const purgeLegacyNow = () => {
		if (legacyCleaning() || legacyScanning()) return;
		const isPt = resolveLanguage(tuiPrefs().layout?.language) === "pt-BR";
		if (!confirmPurge()) {
			setConfirmPurge(true);
			setNotice(isPt ? "⚠️ Confirmação armada: pressione Enter de novo em \"Apagar dados (.pantheon)\" para confirmar" : "⚠️ Armed: press Enter again on \"Purge Pantheon data\" to erase local .pantheon stores");
			return;
		}
		setConfirmPurge(false);
		setLegacyCleaning(true);
		try {
			const auditOpts = {
				workspaceDir,
				runningVersion: currentVersion,
				...activeBundlePath ? { activeBundlePath } : {}
			};
			const res = purgeAllPantheonData(auditOpts);
			const after = scanLegacyArtifacts(auditOpts);
			setLegacyAudit(after.summary);
			setLoad(readOverridesLoad(workspaceDir));
			const msg = isPt ? `purgados ${res.removed.length} item(ns) (${formatBytes(res.reclaimedBytes)}) — use \`opencode plugin remove pantheon-opencode\` para desinstalar` : `purged ${res.removed.length} item(s) (${formatBytes(res.reclaimedBytes)}) — run \`opencode plugin remove pantheon-opencode\` to uninstall`;
			setLegacyNotice(msg);
			setNotice(`[OK] ${msg}`);
			try {
				context.ui.toast?.show?.({
					variant: res.errors.length > 0 ? "warning" : "info",
					message: msg
				});
			} catch {}
		} catch {
			setNotice(isPt ? "falha ao apagar dados do Pantheon" : "Pantheon data purge failed");
		} finally {
			setLegacyCleaning(false);
		}
	};
	const dispatchWrite = (id, value) => {
		if (id === "update.channel") {
			if (value === "stable" || value === "beta") {
				setSelectedChannel(value);
				checkUpdatesNow(value);
				return { ok: true };
			}
			return {
				ok: false,
				reason: "unknown channel"
			};
		}
		if (id === "gates.scope") {
			if (value === "global" || value === "project") {
				setOverridesScope(value);
				return { ok: true };
			}
			return {
				ok: false,
				reason: "unknown scope"
			};
		}
		if (id.startsWith("gate.")) {
			const behaviorId = id.slice(5);
			if ((draft()["gates.scope"] ?? overridesScope()) === "project") {
				const nextProject = setOverrideState(load().project, behaviorId, value === "disabled" ? "disabled" : "enabled");
				if (nextProject === load().project) return { ok: true };
				try {
					writeProjectOverridesToDisk(workspaceDir, nextProject);
					setLoad({
						...load(),
						project: nextProject
					});
					return { ok: true };
				} catch {
					return {
						ok: false,
						reason: "project overrides disk write failed"
					};
				}
			}
			if (!canWriteOverrides(load())) return {
				ok: false,
				reason: "overrides file unreadable — repair with `doctor --fix`"
			};
			const nextGlobal = setOverrideState(load().global, behaviorId, value === "disabled" ? "disabled" : "enabled");
			if (nextGlobal === load().global) return { ok: true };
			try {
				writeOverridesToDisk({
					...load(),
					global: nextGlobal
				});
				setLoad({
					...load(),
					global: nextGlobal
				});
				return { ok: true };
			} catch {
				return {
					ok: false,
					reason: "overrides disk write failed"
				};
			}
		}
		if (id === "decision.enabled") {
			const current = decision();
			if (current.corrupt) return {
				ok: false,
				reason: "decision-router.json unreadable — repair via `decision-router setup-model`"
			};
			const guarded = setDecisionEnabled(current.config, value === "enabled");
			if (!guarded.ok) return {
				ok: false,
				reason: guarded.reason
			};
			try {
				writeDecisionRouterConfig(guarded.config);
				setDecision({
					config: guarded.config,
					corrupt: false
				});
				return { ok: true };
			} catch {
				return {
					ok: false,
					reason: "decision-router disk write failed"
				};
			}
		}
		if (id === "decision.selection.mode" || id === "decision.selection.target" || id === "decision.consent") {
			const current = decision();
			if (current.corrupt) return {
				ok: false,
				reason: "decision-router.json unreadable — repair via `decision-router setup-model`"
			};
			const staged = applyDecisionRow(current.config, id, value);
			if (staged === current.config) return {
				ok: false,
				reason: "unknown or invalid value"
			};
			try {
				writeDecisionRouterConfig(staged);
				setDecision({
					config: staged,
					corrupt: false
				});
				return { ok: true };
			} catch {
				return {
					ok: false,
					reason: "decision-router disk write failed"
				};
			}
		}
		if (id === "preset") try {
			if (value === "none") clearActivePreset(globalActivePresetPath());
			else writeActivePreset(globalActivePresetPath(), value);
			setPresetTick((tick) => tick + 1);
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : "preset marker write failed"
			};
		}
		if (id === "preset.vision_model") try {
			writeConfiguredVisionModel(value);
			setPresetTick((tick) => tick + 1);
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : "vision model config write failed"
			};
		}
		if (id.startsWith("autonomy.goal_loop.")) {
			const next = { ...goalLoop() };
			if (id === "autonomy.goal_loop.enabled") next.enabled = value === "enabled";
			else if (id === "autonomy.goal_loop.maxContinuations") {
				const parsed = Number(value);
				if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) return {
					ok: false,
					reason: "max continuations must be 1..200"
				};
				next.maxContinuations = Math.floor(parsed);
			} else if (id === "autonomy.goal_loop.cooldownMs") {
				const parsed = Number(value);
				if (!Number.isFinite(parsed) || parsed < 1e3) return {
					ok: false,
					reason: "cooldown must be >= 1000ms"
				};
				next.cooldownMs = Math.floor(parsed);
			}
			try {
				writeUserOption("goal_loop", next);
				setGoalLoop(next);
				setAutonomyRestartPending(true);
				return { ok: true };
			} catch {
				return {
					ok: false,
					reason: "opencode.json write failed"
				};
			}
		}
		if (id === "autonomy.budget.monthly" || id === "autonomy.budget.perDecision") {
			const parsed = parseUsd(value);
			if (parsed === null) return {
				ok: false,
				reason: "invalid USD value"
			};
			const next = { ...budgets() };
			if (id === "autonomy.budget.monthly") next.monthlyUsd = parsed;
			else next.perDecisionUsd = parsed;
			try {
				writeDecisionBudget(next);
				setBudgets(next);
				return { ok: true };
			} catch {
				return {
					ok: false,
					reason: "budget write failed"
				};
			}
		}
		if (id.startsWith("tui.")) try {
			mutateTuiPrefs((prefsDraft) => applyTuiRow(prefsDraft, id, value)).then(() => setNotice(void 0)).catch(() => setNotice("tui prefs: persist failed — the change is active for this session only"));
			return { ok: true };
		} catch {
			return {
				ok: false,
				reason: "tui prefs storage unavailable"
			};
		}
		return {
			ok: false,
			reason: "unknown staged row"
		};
	};
	const save = () => {
		const isPt = resolveLanguage(tuiPrefs().layout?.language) === "pt-BR";
		if (!draftDirty(draft())) {
			setNotice(isPt ? "nada pendente — ←/→ altera um valor primeiro" : "nothing staged — ←/→ stages a change first");
			return;
		}
		const writer = dispatchWrite;
		const { applied, failed } = applyDraft(draft(), writer);
		if (applied.length > 0) {
			setDraft(settledDraft(draft(), applied));
			setLoad(readOverridesLoad(workspaceDir));
			setDecision(readDecisionRouterConfig());
			setPresetTick((tick) => tick + 1);
		}
		if (failed.length > 0) setNotice(`${failed.map((f) => `${f.id}: ${f.reason}`).join(" · ")} — ${isPt ? "alterações mantidas" : "staged changes kept"}`);
		else {
			setNotice(isPt ? `salva(s) ${applied.length} alteração(ões)` : `saved ${applied.length} change${applied.length === 1 ? "" : "s"}`);
			if (confirmExit()) exit();
		}
	};
	const resetPage = () => {
		if (confirmExit()) setConfirmExit(false);
		const tab = tabs()[page()];
		if (tab === void 0) return;
		setDraft(resetTab(draft(), tab));
		setNotice(void 0);
	};
	const stageDefaultsPage = () => {
		if (confirmExit()) setConfirmExit(false);
		const tab = tabs()[page()];
		if (tab === void 0) return;
		setNotice(void 0);
		setDraft(stageDefaults(draft(), tab));
	};
	const nextTab = () => {
		if (confirmExit()) setConfirmExit(false);
		setPage((current) => (current + 1) % tabs().length);
		setSelected(0);
	};
	const close = () => {
		const staged = draftCount(draft());
		if (staged > 0 && !confirmExit()) {
			setConfirmExit(true);
			return;
		}
		if (staged > 0) {
			clearTuiDraftPreview();
			setDraft({});
			try {
				context.ui.toast?.show?.({
					variant: "info",
					message: `settings: ${staged} staged change${staged === 1 ? "" : "s"} discarded`
				});
			} catch {}
		}
		exit();
	};
	const discard = () => {
		const staged = draftCount(draft());
		clearTuiDraftPreview();
		setDraft({});
		setConfirmExit(false);
		if (staged > 0) try {
			context.ui.toast?.show?.({
				variant: "info",
				message: `settings: ${staged} staged change${staged === 1 ? "" : "s"} discarded`
			});
		} catch {}
		exit();
	};
	const cancelExit = () => {
		setConfirmExit(false);
	};
	const selectedId = () => rows()[selected()]?.id;
	const selectById = (id) => {
		if (confirmExit()) setConfirmExit(false);
		const index = rows().findIndex((r) => r.id === id);
		if (index !== -1) setSelected(index);
	};
	const cycleRowById = (id, direction) => {
		if (confirmExit()) setConfirmExit(false);
		const list = rows();
		const index = list.findIndex((r) => r.id === id);
		if (index !== -1) {
			setSelected(index);
			const row = list[index];
			if (row?.action === "update-check") checkUpdatesNow();
			else if (row?.action === "update-run") runUpdateNow();
			else if (row?.action === "legacy-scan") {
				setConfirmPurge(false);
				scanLegacyNow();
			} else if (row?.action === "legacy-clean") {
				setConfirmPurge(false);
				cleanLegacyNow();
			} else if (row?.action === "legacy-purge") purgeLegacyNow();
			else if (row) {
				setNotice(void 0);
				setDraft(stageValue(draft(), row, direction));
			}
		}
	};
	return {
		tabs,
		page,
		selectedId,
		draft,
		notice,
		confirmExit: () => confirmExit(),
		api: {
			move,
			step,
			selectById,
			cycleRowById,
			actuate: () => {
				if (confirmExit()) setConfirmExit(false);
				const row = rows()[selected()];
				if (row?.action === "update-check") checkUpdatesNow();
				else if (row?.action === "update-run") runUpdateNow();
				else if (row?.action === "legacy-scan") {
					setConfirmPurge(false);
					scanLegacyNow();
				} else if (row?.action === "legacy-clean") {
					setConfirmPurge(false);
					cleanLegacyNow();
				} else if (row?.action === "legacy-purge") purgeLegacyNow();
				else step(1);
			},
			nextTab,
			prevTab: () => {
				if (confirmExit()) setConfirmExit(false);
				const count = tabs().length;
				if (count > 0) {
					setPage((current) => (current - 1 + count) % count);
					setSelected(0);
				}
			},
			jumpTab: (index) => {
				if (confirmExit()) setConfirmExit(false);
				if (index >= 0 && index < tabs().length) {
					setPage(index);
					setSelected(0);
				}
			},
			save,
			resetPage,
			stageDefaults: stageDefaultsPage,
			close,
			discard,
			cancelExit,
			confirmExit: () => confirmExit()
		},
		cleanup: () => {
			clearTuiDraftPreview();
			pageApi = void 0;
			setBlocking(false);
		}
	};
}
function SettingsPage(props) {
	const returnRoute = props.data?.returnRoute;
	const context = props.context;
	const controller = createWindowController(context, () => navigateBack(context, returnRoute !== void 0 ? { returnRoute } : {}));
	const theme = context.theme?.text ?? {};
	const accent = () => resolveAccentColor(tuiPrefs().theme?.accent, context.theme);
	const warn = () => accent();
	try {
		const popMode = context.keymap?.mode?.push?.(ROUTE_MODE);
		if (popMode !== void 0) onCleanup(() => popMode());
	} catch {}
	onCleanup(controller.cleanup);
	setBlocking(true);
	pageApi = controller.api;
	const window = () => createComponent(SettingsWindow, {
		get version() {
			return resolveRunningVersion();
		},
		get tabs() {
			return controller.tabs;
		},
		get page() {
			return controller.page;
		},
		get selectedId() {
			return controller.selectedId;
		},
		get draft() {
			return controller.draft;
		},
		get notice() {
			return controller.notice;
		},
		get confirmExit() {
			return controller.confirmExit;
		},
		get fg() {
			return theme.base;
		},
		get muted() {
			return theme.muted;
		},
		get warn() {
			return warn();
		},
		onJumpTab: (idx) => controller.api.jumpTab(idx),
		onSelectRow: (id) => controller.api.selectById?.(id),
		onCycleValue: (id, dir) => controller.api.cycleRowById?.(id, dir),
		onSave: () => controller.api.save(),
		onResetPage: () => controller.api.resetPage(),
		onStageDefaults: () => controller.api.stageDefaults(),
		onClose: () => controller.api.close(),
		onDiscard: () => controller.api.discard?.(),
		onCancelExit: () => controller.api.cancelExit?.()
	});
	const sidebar = () => props.renderSidebar ? props.renderSidebar(context) : null;
	return createComponent(Show, {
		get when() {
			return sidebar();
		},
		get fallback() {
			return window();
		},
		get children() {
			var _el$71 = createElement("box"), _el$72 = createElement("box"), _el$73 = createElement("box");
			insertNode(_el$71, _el$72);
			insertNode(_el$71, _el$73);
			setProp(_el$71, "flexDirection", "row");
			setProp(_el$71, "flexGrow", 1);
			setProp(_el$71, "flexBasis", 0);
			setProp(_el$71, "minHeight", 0);
			setProp(_el$71, "width", "100%");
			setProp(_el$72, "flexDirection", "column");
			setProp(_el$72, "flexGrow", 1);
			setProp(_el$72, "flexBasis", 0);
			setProp(_el$72, "minHeight", 0);
			setProp(_el$72, "minWidth", 0);
			insert(_el$72, window);
			setProp(_el$73, "width", 32);
			setProp(_el$73, "flexShrink", 0);
			setProp(_el$73, "border", true);
			setProp(_el$73, "borderStyle", "single");
			insert(_el$73, sidebar);
			effect((_$p) => setProp(_el$73, "borderColor", theme.muted ?? "#333333", _$p));
			return _el$71;
		}
	});
}
function navigateBack(context, data) {
	try {
		context.ui.router.navigate(data?.returnRoute ?? { type: "home" });
	} catch {}
}
const [dialogOpen, setDialogOpen] = createSignal(false);
let dialogDismiss = () => {};
function openSettingsDialog(context) {
	const controller = createWindowController(context, () => dialogDismiss());
	const theme = context.theme?.text ?? {};
	const accent = () => resolveAccentColor(tuiPrefs().theme?.accent, context.theme);
	const warn = () => accent();
	controller.cleanup = () => {
		pageApi = void 0;
		setBlocking(false);
		setDialogOpen(false);
	};
	const close = () => {
		controller.cleanup();
	};
	dialogDismiss = () => {
		try {
			context.ui.dialog.clear();
		} catch {}
		close();
	};
	setBlocking(true);
	setDialogOpen(true);
	pageApi = controller.api;
	const rendererHeight = () => context.renderer?.height ?? 30;
	const maxHeight = () => Math.min(28, Math.max(14, Math.floor(rendererHeight() * .78)));
	try {
		context.ui.dialog.show(() => createComponent(SettingsWindow, {
			get version() {
				return resolveRunningVersion();
			},
			get tabs() {
				return controller.tabs;
			},
			get page() {
				return controller.page;
			},
			get selectedId() {
				return controller.selectedId;
			},
			get draft() {
				return controller.draft;
			},
			get notice() {
				return controller.notice;
			},
			get confirmExit() {
				return controller.confirmExit;
			},
			get fg() {
				return theme.base;
			},
			get muted() {
				return theme.muted;
			},
			get warn() {
				return warn();
			},
			isDialog: true,
			get maxHeight() {
				return maxHeight();
			},
			onJumpTab: (idx) => controller.api.jumpTab(idx),
			onSelectRow: (id) => controller.api.selectById?.(id),
			onCycleValue: (id, dir) => controller.api.cycleRowById?.(id, dir),
			onSave: () => controller.api.save(),
			onResetPage: () => controller.api.resetPage(),
			onStageDefaults: () => controller.api.stageDefaults(),
			onClose: () => controller.api.close(),
			onDiscard: () => controller.api.discard?.(),
			onCancelExit: () => controller.api.cancelExit?.()
		}), close);
		context.ui.dialog.set({
			size: "large",
			centered: true
		});
	} catch {}
}
const [settingsOpen, setSettingsOpen] = createSignal(false);
const [activeSessionId, setActiveSessionId] = createSignal();
function routeSessionID(context) {
	try {
		const route = context?.ui?.router?.current?.();
		return route?.type === "session" ? route?.sessionID : void 0;
	} catch {
		return;
	}
}
function closePantheonSettings() {
	if (pageApi) {
		pageApi.close();
		if (pageApi.confirmExit?.()) return;
	}
	setSettingsOpen(false);
	setBlocking(false);
}
function PantheonSettingsSlot(props) {
	onMount(() => {
		setActiveSessionId(props.sessionID);
	});
	onCleanup(() => {
		if (activeSessionId() === props.sessionID) setActiveSessionId(void 0);
	});
	return createComponent(Show, {
		get when() {
			return memo(() => !!settingsOpen())() && (activeSessionId() === props.sessionID || !activeSessionId());
		},
		get children() {
			return createComponent(InSessionSettingsWindow, {
				get context() {
					return props.context;
				},
				get sessionID() {
					return props.sessionID;
				}
			});
		}
	});
}
function InSessionSettingsWindow(props) {
	let windowBox;
	const context = props.context;
	const initialRoom = () => Math.max(14, (context.renderer?.height ?? 30) - 10);
	const [roomHeight, setRoomHeight] = createSignal(initialRoom());
	const [hasKeyboard, setHasKeyboard] = createSignal(false);
	function measureRoom() {
		const box = windowBox;
		if (!box || box.isDestroyed) return;
		let child = box;
		for (let parent = box.parent; parent; child = parent, parent = parent.parent) {
			const siblings = parent.getChildren?.() ?? [];
			const messages = siblings[0];
			if (messages === child || !messages?.getChildren?.().some((item) => "scrollChildIntoView" in item)) continue;
			const otherRows = siblings.filter((item) => item !== child && item !== messages).reduce((total, item) => total + (item.height ?? 0), 0);
			const room = Math.max(12, (parent.height ?? 24) - 1 - otherRows - ((child.height ?? 0) - (box.height ?? 0)));
			if (room !== roomHeight()) queueMicrotask(() => setRoomHeight(room));
			return;
		}
	}
	onMount(() => {
		try {
			context.renderer?.root?.on?.("layout-changed", measureRoom);
			context.renderer?.on?.("resize", measureRoom);
			onCleanup(() => {
				try {
					context.renderer?.root?.off?.("layout-changed", measureRoom);
					context.renderer?.off?.("resize", measureRoom);
				} catch {}
			});
		} catch {}
		measureRoom();
		setTimeout(() => {
			try {
				windowBox?.focus?.();
			} catch {}
		}, 50);
	});
	try {
		const popMode = context.keymap?.mode?.push?.(ROUTE_MODE);
		if (popMode !== void 0) onCleanup(() => popMode());
	} catch {}
	const controller = createWindowController(context, () => {
		setSettingsOpen(false);
		setBlocking(false);
	});
	onCleanup(controller.cleanup);
	pageApi = controller.api;
	const theme = context.theme?.text ?? {};
	const accent = () => resolveAccentColor(tuiPrefs().theme?.accent, context.theme);
	const warn = () => accent();
	return createComponent(SettingsWindow, {
		boxRef: (el) => {
			windowBox = el;
			if (el) {
				el.on?.("focused", () => setHasKeyboard(true));
				el.on?.("blurred", () => setHasKeyboard(false));
			}
		},
		get height() {
			return roomHeight();
		},
		get version() {
			return resolveRunningVersion();
		},
		get tabs() {
			return controller.tabs;
		},
		get page() {
			return controller.page;
		},
		get selectedId() {
			return controller.selectedId;
		},
		get draft() {
			return controller.draft;
		},
		get notice() {
			return controller.notice;
		},
		get confirmExit() {
			return controller.confirmExit;
		},
		get fg() {
			return theme.base;
		},
		get muted() {
			return theme.muted;
		},
		get warn() {
			return warn();
		},
		hasKeyboard,
		onJumpTab: (idx) => controller.api.jumpTab(idx),
		onSelectRow: (id) => controller.api.selectById?.(id),
		onCycleValue: (id, dir) => controller.api.cycleRowById?.(id, dir),
		onSave: () => controller.api.save(),
		onResetPage: () => controller.api.resetPage(),
		onStageDefaults: () => controller.api.stageDefaults(),
		onClose: () => closePantheonSettings(),
		onDiscard: () => controller.api.discard?.(),
		onCancelExit: () => controller.api.cancelExit?.(),
		onMouseDown: () => {
			try {
				windowBox?.focus?.();
			} catch {}
		}
	});
}
let registeredSidebarRenderer;
function setupPantheonSettings(context, options) {
	registeredSidebarRenderer = options?.renderSidebar;
	try {
		context.ui.router?.register?.({
			name: ROUTE_NAME,
			render: ({ data }) => createComponent(SettingsPage, mergeProps({
				context,
				data
			}, registeredSidebarRenderer ? { renderSidebar: registeredSidebarRenderer } : {}))
		});
		routerAvailable = true;
	} catch {
		routerAvailable = false;
	}
	const routeGated = () => {
		try {
			const route = context.ui?.router?.current?.();
			return route?.type === "plugin" && route.name === "pantheon-settings";
		} catch {
			return false;
		}
	};
	const commands = [
		{
			id: "pantheon.settings.close",
			title: "Close settings",
			bind: "escape,q",
			run: () => {
				if (pageApi === void 0) {
					closePantheonSettings();
					return;
				}
				if (pageApi.confirmExit?.()) {
					pageApi.cancelExit?.();
					return;
				}
				closePantheonSettings();
			}
		},
		{
			id: "pantheon.settings.discard",
			title: "Discard staged changes and exit",
			bind: "d",
			run: () => {
				if (pageApi?.confirmExit?.()) {
					pageApi.discard?.();
					return;
				}
			}
		},
		{
			id: "pantheon.settings.down",
			title: "Select next row",
			bind: "down,j",
			run: () => {
				pageApi?.move(1);
			}
		},
		{
			id: "pantheon.settings.up",
			title: "Select previous row",
			bind: "up,k",
			run: () => {
				pageApi?.move(-1);
			}
		},
		{
			id: "pantheon.settings.cycle.next",
			title: "Stage the next value",
			bind: "right,l",
			run: () => {
				pageApi?.step(1);
			}
		},
		{
			id: "pantheon.settings.cycle.prev",
			title: "Stage the previous value",
			bind: "left,h",
			run: () => {
				pageApi?.step(-1);
			}
		},
		{
			id: "pantheon.settings.actuate",
			title: "Apply / act on the row",
			bind: "enter,space",
			run: () => {
				pageApi?.actuate();
			}
		},
		{
			id: "pantheon.settings.next.tab",
			title: "Next settings tab",
			bind: "tab,]",
			run: () => {
				pageApi?.nextTab();
			}
		},
		{
			id: "pantheon.settings.prev.tab",
			title: "Previous settings tab",
			bind: "shift+tab,[",
			run: () => {
				pageApi?.prevTab?.();
			}
		},
		{
			id: "pantheon.settings.save",
			title: "Save staged changes",
			bind: "ctrl+s",
			run: () => {
				pageApi?.save();
			}
		},
		{
			id: "pantheon.settings.reset.page",
			title: "Reset this tab",
			bind: "ctrl+r",
			run: () => {
				pageApi?.resetPage();
			}
		},
		{
			id: "pantheon.settings.defaults",
			title: "Stage defaults for this tab",
			bind: "ctrl+d",
			run: () => {
				pageApi?.stageDefaults();
			}
		},
		...Array.from({ length: 9 }, (_, index) => ({
			id: `pantheon.settings.tab.${index + 1}`,
			title: `Jump to tab ${index + 1}`,
			bind: String(index + 1),
			run: () => {
				pageApi?.jumpTab(index);
			}
		}))
	];
	try {
		context.keymap.layer(() => ({
			mode: ROUTE_MODE,
			priority: 1,
			enabled: () => routeGated() || settingsOpen(),
			commands
		}));
	} catch {}
	try {
		context.keymap.layer(() => ({
			mode: "global",
			priority: 1,
			enabled: () => dialogOpen() || settingsOpen(),
			commands
		}));
	} catch {}
}
async function openPantheonSettings(context, options = {}) {
	if (options.initialTab) pendingInitialTabId = options.initialTab;
	const sessionID = context?.sessionID ?? routeSessionID(context) ?? activeSessionId();
	try {
		const viewMode = tuiPrefs().layout?.settingsView ?? "docked";
		if (viewMode !== "dialog" && (viewMode === "fullscreen" || !sessionID) && routerAvailable && context.ui?.router?.navigate) {
			let returnRoute;
			try {
				const current = context.ui.router.current();
				if (!(current.type === "plugin" && current.name === "pantheon-settings")) returnRoute = plainRoute(current);
			} catch {
				returnRoute = void 0;
			}
			context.ui.router.navigate({
				type: "plugin",
				name: ROUTE_NAME,
				...returnRoute !== void 0 ? { data: { returnRoute } } : {}
			});
			return;
		}
		if (viewMode === "dialog") {
			openSettingsDialog(context);
			return;
		}
	} catch {}
	if (!sessionID) {
		openSettingsDialog(context);
		return;
	}
	if (settingsOpen()) {
		if (options.initialTab && pageApi) {
			const targetIdx = [
				"gates",
				"decision",
				"preset",
				"tui",
				"autonomy",
				"j1",
				"updates",
				"changelog",
				"doctor",
				"about"
			].indexOf(options.initialTab);
			if (targetIdx >= 0) {
				pendingInitialTabId = void 0;
				pageApi.jumpTab(targetIdx);
				return;
			}
		}
		closePantheonSettings();
		return;
	}
	setSettingsOpen(true);
	setBlocking(true);
}
//#endregion
//#region src/sidebar-width.ts
const GRAPHEMES = new Intl.Segmenter(void 0, { granularity: "grapheme" });
/** A grapheme the host draws two cells wide: emoji presentation, an extended
*  pictograph (a bare `❤` counts too, exactly as the host's `emoji-regex`
*  does) and a regional-indicator pair (a flag). */
const EMOJI_GLYPH = /\p{Emoji_Presentation}|\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
/** VS16 asks for emoji presentation; without it `1` is one cell, with it the
*  keycap sequence is drawn as one two-cell glyph. */
const EMOJI_PRESENTATION_SELECTOR = "️";
/** Unicode default-ignorable code points carry no width of their own. */
const IGNORABLE_GLYPH = /^\p{Default_Ignorable_Code_Point}$/u;
/** East Asian Wide/Fullwidth ranges — two cells, never the ambiguous width
*  (the host measures ambiguous as narrow, so `▸`/`✓`/`—` stay one cell).
*  Generated from the host's own measurement (`string-width` over every code
*  point, emoji excluded), so this table can be regenerated verbatim when the
*  host upgrades its Unicode data instead of being hand-edited. */
const CELL_WIDE_RANGES = [
	[4352, 4446],
	[9001, 9002],
	[9776, 9783],
	[9866, 9871],
	[11904, 11929],
	[11931, 12019],
	[12032, 12245],
	[12272, 12335],
	[12337, 12348],
	[12350, 12350],
	[12353, 12438],
	[12441, 12543],
	[12549, 12591],
	[12593, 12643],
	[12645, 12686],
	[12688, 12773],
	[12783, 12830],
	[12832, 12871],
	[12880, 12950],
	[12952, 12952],
	[12954, 42124],
	[42128, 42182],
	[43360, 43388],
	[44032, 55203],
	[63744, 64255],
	[65040, 65049],
	[65072, 65106],
	[65108, 65126],
	[65128, 65131],
	[65281, 65376],
	[65504, 65510],
	[94176, 94180],
	[94192, 94198],
	[94208, 101594],
	[101631, 101664],
	[101760, 101874],
	[101888, 102801],
	[102816, 102866],
	[110576, 110579],
	[110581, 110587],
	[110589, 110590],
	[110592, 110888],
	[110898, 110898],
	[110928, 110930],
	[110933, 110933],
	[110948, 110952],
	[110960, 111355],
	[119552, 119638],
	[119648, 119670],
	[127488, 127488],
	[127504, 127513],
	[127515, 127534],
	[127536, 127537],
	[127547, 127547],
	[127552, 127560],
	[127584, 127589],
	[131072, 196605],
	[196608, 262141]
];
/** One code point the terminal draws no cell for: control characters, the
*  zero-width joiners/marks, combining marks and variation selectors. */
function isZeroWidthCodePoint(code, glyph) {
	if (code <= 31 || code >= 127 && code <= 159) return true;
	if (code >= 8203 && code <= 8207) return true;
	if (code === 65279) return true;
	if (code >= 768 && code <= 879) return true;
	if (code >= 6832 && code <= 6911) return true;
	if (code >= 7616 && code <= 7679) return true;
	if (code >= 8400 && code <= 8447) return true;
	if (code >= 65024 && code <= 65039) return true;
	if (code >= 65056 && code <= 65071) return true;
	if (code >= 917760 && code <= 917999) return true;
	if (code >= 55296 && code <= 57343) return true;
	return IGNORABLE_GLYPH.test(glyph);
}
function isWideCodePoint(code) {
	for (const [low, high] of CELL_WIDE_RANGES) {
		if (code < low) return false;
		if (code <= high) return true;
	}
	return false;
}
/** Cells one grapheme occupies. */
function graphemeWidth(segment) {
	if (EMOJI_GLYPH.test(segment)) return 2;
	if (segment.length > 1 && segment.includes(EMOJI_PRESENTATION_SELECTOR)) return 2;
	let width = 0;
	for (const glyph of segment) {
		const code = glyph.codePointAt(0) ?? 0;
		if (isZeroWidthCodePoint(code, glyph)) continue;
		width += isWideCodePoint(code) ? 2 : 1;
	}
	return width;
}
/** Terminal cells `value` occupies — the unit every column in this plugin is
*  measured in. Mirrors the host (that is how `@opentui/core` sizes a text
*  run): emoji count as two cells, East Asian Wide/Fullwidth as two, East
*  Asian Ambiguous as one, combining marks and variation selectors as none.
*  Pure. */
function cellWidth(value) {
	let width = 0;
	for (const { segment } of GRAPHEMES.segment(value)) width += graphemeWidth(segment);
	return width;
}
//#endregion
//#region src/whats-new-state.ts
/**
* whats-new-state.ts — last-seen version for the one-time "What's new" window.
*
* The TUI shows a dismissable release-highlights dialog once per Pantheon
* version. Whether a version was already seen is persisted next to the other
* opencode-level Pantheon state: `<configDir>/.pantheon/whats-new.json`, the
* same directory that already holds `install-state.json` (scripts/install/
* state.mjs) and the active-preset file the sidebar reads. There is no
* established persistent TUI KV store (the host `api.kv` is per-process), so
* the plugin owns one small JSON file with the atomic-write discipline used
* across the repo (unique tmp + rename, mirrors scripts/install/verify.mjs).
*
* Fail-open everywhere: a missing or corrupt file reads as "never seen" (the
* window may show), a failed write is silent (the window may show again) —
* neither can ever block TUI startup.
*/
/** State file name, kept next to `install-state.json` in `<configDir>/.pantheon/`. */
const WHATS_NEW_STATE_FILENAME = "whats-new.json";
/** Parse a state file body; null when unreadable as the expected shape. */
function parseWhatsNewState(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const record = parsed;
		const seen = record.seenVersion;
		if (typeof seen !== "string" && seen !== null) return null;
		return {
			seenVersion: seen,
			updatedAt: String(record.updatedAt ?? "")
		};
	} catch {
		return null;
	}
}
/** Read the persisted state; null when missing or corrupt (never throws). */
async function readWhatsNewState(statePath) {
	try {
		return parseWhatsNewState(await readFile(statePath, "utf8"));
	} catch {
		return null;
	}
}
/**
* Whether the one-time window should show for `version`: any version change
* since the last dismissal (including downgrades). A falsy version — the
* resolver failed — never shows.
*/
async function shouldShowWhatsNew(version, statePath) {
	if (typeof version !== "string" || version.trim() === "") return false;
	return (await readWhatsNewState(statePath))?.seenVersion !== version;
}
/**
* Persist `version` as seen (atomic tmp + rename, 0o600). Never throws: a
* failed write leaves the state untouched and the window may show again —
* the same fail-open contract as the rest of the plugin.
*/
async function markSeenWhatsNew(version, statePath) {
	if (typeof version !== "string" || version.trim() === "") return false;
	const previous = await readWhatsNewState(statePath);
	const next = {
		seenVersion: version,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	const tmpPath = `${statePath}.tmp-${process.pid}`;
	try {
		await mkdir(dirname(statePath), { recursive: true });
		await writeFile(tmpPath, `${JSON.stringify({
			...previous,
			...next
		}, null, 2)}\n`, {
			encoding: "utf8",
			mode: 384
		});
		await rename(tmpPath, statePath);
		return true;
	} catch {
		try {
			await unlink(tmpPath);
		} catch {}
		return false;
	}
}
/** `stat`-based existence probe (async I/O discipline). */
async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
/**
* Default state path: `<configDir>/.pantheon/whats-new.json`, resolving the
* OpenCode config directory exactly like src/pantheon/tui-version-check.ts
* (`$XDG_CONFIG_HOME/opencode` → `~/.opencode`), defaulting to the XDG
* location `init` creates when neither exists yet.
*/
async function defaultWhatsNewStatePath(env = process.env, home = homedir()) {
	const xdgConfig = env.XDG_CONFIG_HOME || join(home, ".config");
	const primary = join(xdgConfig, "opencode");
	if (await pathExists(primary)) return join(primary, ".pantheon", WHATS_NEW_STATE_FILENAME);
	const legacy = join(home, ".opencode");
	if (await pathExists(legacy)) return join(legacy, ".pantheon", WHATS_NEW_STATE_FILENAME);
	return join(primary, ".pantheon", WHATS_NEW_STATE_FILENAME);
}
//#endregion
//#region src/whats-new-open.ts
/**
* whats-new-open.ts — the show-once decision for the "What's new" window.
*
* Plain data in, plain data out: the entrypoints (index.tsx / index-v2.tsx)
* resolve the running version and the shipped CHANGELOG.md, then hand this
* module a `show` callback that renders the view data through the host's
* dialog API. Keeping the decision JSX-free makes the whole one-time flow
* testable offline (node strips the types natively) — the Solid glue lives in
* whats-new.tsx.
*
* Contract (pinned by tests/tui-whats-new.test.mjs):
*   - shows at most once per version: dismissal marks the version seen;
*   - nothing to show (no version, missing CHANGELOG, empty section) → no
*     window AND no pin — the next start may still show it;
*   - never throws on its own inputs; I/O failures inside the state module
*     are fail-open there.
*/
/** Muted footer hint teaching the dismiss bind. */
const WHATS_NEW_CLOSE_HINT = "esc/q close";
/** Hint variant when the highlights span more than one page. */
const WHATS_NEW_PAGES_HINT = "esc/q close · n next · p back";
/** Hard-wrap one display line into rows of at most `width` columns (>= 10). */
function wrapWhatsNewLine(line, width) {
	const bounded = Number.isInteger(width) && width > 10 ? width : 76;
	const text = String(line);
	if (text.length <= bounded) return [text];
	const rows = [];
	let rest = text;
	while (rest.length > bounded) {
		rows.push(rest.slice(0, bounded));
		rest = rest.slice(bounded);
	}
	if (rest.length > 0) rows.push(rest);
	return rows;
}
/** Slice display lines into fixed-size pages (>= 1 page, empty-safe). */
function paginateWhatsNewLines(lines, pageSize = 14) {
	const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 14;
	if (lines.length === 0) return [[]];
	const pages = [];
	for (let i = 0; i < lines.length; i += size) pages.push(lines.slice(i, i + size));
	return pages;
}
/**
* Open the one-time window when the version changed and highlights exist.
* Returns true when the window was shown; the caller's `onClose` callback
* (both host-initiated and local close binds) must funnel into marking seen.
*/
async function openWhatsNew(input) {
	const { version, statePath, changelogText, show, force = false } = input;
	if (typeof version !== "string" || version.trim() === "") return false;
	if (!force && !await shouldShowWhatsNew(version, statePath)) return false;
	const lines = whatsNewLines(changelogText ? extractHighlights(changelogText, version) : { ...EMPTY_HIGHLIGHTS });
	if (lines.length === 0) return false;
	const pages = paginateWhatsNewLines(lines);
	const data = {
		version,
		title: whatsNewTitle(version),
		lines,
		pages,
		hint: pages.length > 1 ? WHATS_NEW_PAGES_HINT : WHATS_NEW_CLOSE_HINT
	};
	show(() => data, () => {
		markSeenWhatsNew(version, statePath);
	});
	return true;
}
//#endregion
//#region src/whats-new.tsx
/** @jsxImportSource @opentui/solid */
/**
* whats-new.tsx — the one-time "What's new" window (per Pantheon version).
*
* When the running Pantheon version changed since the last TUI start, the V2
* entrypoint fires {@link maybeShowWhatsNew} (fire-and-forget, never
* awaited — startup must never block). The decision lives in
* whats-new-open.ts; this file is only the host glue + view:
* `context.ui.dialog.show` plus a keymap layer gated on the open signal so
* `escape`/`q` dismiss and `n`/`p` flip pages while (and only while) the
* window is up — the same gated-layer pattern as the dispatch panel.
*
* The window shows the curated 🆕 What's New summary (whats-new-highlights
* prefers it), hard-wrapped to the window width and sliced into fixed-size
* pages — a big changelog can never overflow the terminal; the footer points
* at the complete CHANGELOG.md.
*
* Deliberately V2-only: the two dist entries are self-contained (the V1
* sidebar mirrors the preset resolver rather than importing it) because any
* module shared by both entries becomes a content-hashed chunk in dist/,
* changing the artifact shape the byte-reproducible-dist gate pins. The V1
* generation (OpenCode 1.x, legacy) does not show the window; the pure
* modules here are generation-agnostic, so a V1 mirror can follow the
* documented inline-replica precedent if it is ever wanted.
*
* Dismissal always funnels into `markSeenWhatsNew` (idempotent), so the window
* is shown exactly once per version. Every failure path is silent: missing
* CHANGELOG.md, unreadable state, a host API that throws — the window simply
* does not show (fail-open, like the rest of the plugin).
*/
/** Window body: title, rule, the current page (wrapped), footer action bar with OK button. */
function WhatsNewContent(props) {
	const isPt = () => props.isPt ?? resolveLanguage(tuiPrefs().layout?.language) === "pt-BR";
	const rows = () => {
		const current = props.data.pages[Math.min(props.page(), props.pageCount() - 1)] ?? [];
		const wrapped = [];
		for (const line of current) wrapped.push(...wrapWhatsNewLine(line, 72));
		return wrapped;
	};
	return (() => {
		var _el$ = createElement("box"), _el$2 = createElement("box"), _el$3 = createElement("box"), _el$4 = createElement("box"), _el$5 = createElement("text"), _el$7 = createElement("text"), _el$8 = createElement("box"), _el$9 = createElement("text"), _el$1 = createElement("box"), _el$10 = createElement("text"), _el$12 = createElement("box"), _el$13 = createElement("box"), _el$14 = createElement("text"), _el$16 = createElement("box"), _el$17 = createElement("box"), _el$23 = createElement("text"), _el$24 = createElement("box"), _el$25 = createElement("text");
		insertNode(_el$, _el$2);
		insertNode(_el$, _el$1);
		insertNode(_el$, _el$12);
		insertNode(_el$, _el$13);
		insertNode(_el$, _el$16);
		setProp(_el$, "flexDirection", "column");
		setProp(_el$, "borderStyle", "rounded");
		setProp(_el$, "paddingLeft", 2);
		setProp(_el$, "paddingRight", 2);
		setProp(_el$, "paddingTop", 1);
		setProp(_el$, "paddingBottom", 1);
		insertNode(_el$2, _el$3);
		insertNode(_el$2, _el$8);
		setProp(_el$2, "flexDirection", "row");
		setProp(_el$2, "alignItems", "center");
		setProp(_el$2, "justifyContent", "space-between");
		insertNode(_el$3, _el$4);
		insertNode(_el$3, _el$7);
		setProp(_el$3, "flexDirection", "row");
		setProp(_el$3, "alignItems", "center");
		insertNode(_el$4, _el$5);
		setProp(_el$4, "paddingLeft", 1);
		setProp(_el$4, "paddingRight", 1);
		setProp(_el$4, "marginRight", 1);
		setProp(_el$4, "flexShrink", 0);
		insertNode(_el$5, createTextNode(`NOVIDADES`));
		setProp(_el$5, "fg", "#000000");
		setProp(_el$5, "attributes", 1);
		setProp(_el$5, "wrapMode", "none");
		setProp(_el$7, "attributes", 1);
		setProp(_el$7, "wrapMode", "none");
		insert(_el$7, () => props.data.title);
		insertNode(_el$8, _el$9);
		setProp(_el$8, "flexShrink", 0);
		setProp(_el$8, "onMouseDown", stopMouseEvent);
		setProp(_el$8, "onMouseUp", (event) => handleMouseClick(event, props.onClose));
		insertNode(_el$9, createTextNode(`[ Esc / Q ]`));
		setProp(_el$9, "wrapMode", "none");
		insertNode(_el$1, _el$10);
		setProp(_el$1, "flexDirection", "row");
		setProp(_el$1, "height", 1);
		setProp(_el$1, "marginTop", 1);
		setProp(_el$1, "marginBottom", 1);
		insertNode(_el$10, createTextNode(`────────────────────────────────────────────────────────────────────────`));
		setProp(_el$12, "flexDirection", "column");
		setProp(_el$12, "minHeight", 8);
		insert(_el$12, createComponent(For, {
			get each() {
				return rows();
			},
			children: (line) => {
				const isBullet = line.startsWith("• ");
				return (() => {
					var _el$26 = createElement("text");
					spread(_el$26, mergeProps({ get fg() {
						return isBullet ? props.fg : props.muted;
					} }, isBullet ? { attributes: 1 } : {}), true);
					insert(_el$26, line);
					return _el$26;
				})();
			}
		}));
		insertNode(_el$13, _el$14);
		setProp(_el$13, "flexDirection", "row");
		setProp(_el$13, "height", 1);
		setProp(_el$13, "marginTop", 1);
		insertNode(_el$14, createTextNode(`────────────────────────────────────────────────────────────────────────`));
		insertNode(_el$16, _el$17);
		insertNode(_el$16, _el$24);
		setProp(_el$16, "flexDirection", "row");
		setProp(_el$16, "alignItems", "center");
		setProp(_el$16, "justifyContent", "space-between");
		setProp(_el$16, "marginTop", 1);
		insertNode(_el$17, _el$23);
		setProp(_el$17, "flexDirection", "row");
		setProp(_el$17, "alignItems", "center");
		insert(_el$17, createComponent(Show, {
			get when() {
				return props.pageCount() > 1;
			},
			get children() {
				return [
					(() => {
						var _el$18 = createElement("box"), _el$19 = createElement("text");
						insertNode(_el$18, _el$19);
						setProp(_el$18, "backgroundColor", "#262626");
						setProp(_el$18, "paddingLeft", 1);
						setProp(_el$18, "paddingRight", 1);
						setProp(_el$18, "marginRight", 1);
						setProp(_el$18, "onMouseDown", stopMouseEvent);
						setProp(_el$18, "onMouseUp", (event) => handleMouseClick(event, props.onPrev));
						setProp(_el$19, "fg", "#ffffff");
						insert(_el$19, () => isPt() ? "‹ Anterior" : "‹ Prev");
						return _el$18;
					})(),
					(() => {
						var _el$20 = createElement("text");
						setProp(_el$20, "marginRight", 1);
						insert(_el$20, () => `${props.page() + 1} / ${props.pageCount()}`);
						effect((_$p) => setProp(_el$20, "fg", props.muted, _$p));
						return _el$20;
					})(),
					(() => {
						var _el$21 = createElement("box"), _el$22 = createElement("text");
						insertNode(_el$21, _el$22);
						setProp(_el$21, "backgroundColor", "#262626");
						setProp(_el$21, "paddingLeft", 1);
						setProp(_el$21, "paddingRight", 1);
						setProp(_el$21, "marginRight", 1);
						setProp(_el$21, "onMouseDown", stopMouseEvent);
						setProp(_el$21, "onMouseUp", (event) => handleMouseClick(event, props.onNext));
						setProp(_el$22, "fg", "#ffffff");
						insert(_el$22, () => isPt() ? "Próxima ›" : "Next ›");
						return _el$21;
					})()
				];
			}
		}), _el$23);
		insert(_el$23, () => isPt() ? "Enter / Esc / Q fechar" : "Enter / Esc / Q close");
		insertNode(_el$24, _el$25);
		setProp(_el$24, "paddingLeft", 2);
		setProp(_el$24, "paddingRight", 2);
		setProp(_el$24, "onMouseDown", stopMouseEvent);
		setProp(_el$24, "onMouseUp", (event) => handleMouseClick(event, props.onClose));
		setProp(_el$25, "fg", "#000000");
		setProp(_el$25, "attributes", 1);
		insert(_el$25, () => isPt() ? "OK, Entendido" : "OK, Got it");
		effect((_p$) => {
			var _v$ = props.warn ?? "#fba970", _v$2 = props.warn ?? "#fba970", _v$3 = props.fg, _v$4 = props.muted, _v$5 = props.muted, _v$6 = props.muted, _v$7 = props.muted, _v$8 = props.warn ?? "#fba970";
			_v$ !== _p$.e && (_p$.e = setProp(_el$, "borderColor", _v$, _p$.e));
			_v$2 !== _p$.t && (_p$.t = setProp(_el$4, "backgroundColor", _v$2, _p$.t));
			_v$3 !== _p$.a && (_p$.a = setProp(_el$7, "fg", _v$3, _p$.a));
			_v$4 !== _p$.o && (_p$.o = setProp(_el$9, "fg", _v$4, _p$.o));
			_v$5 !== _p$.i && (_p$.i = setProp(_el$10, "fg", _v$5, _p$.i));
			_v$6 !== _p$.n && (_p$.n = setProp(_el$14, "fg", _v$6, _p$.n));
			_v$7 !== _p$.s && (_p$.s = setProp(_el$23, "fg", _v$7, _p$.s));
			_v$8 !== _p$.h && (_p$.h = setProp(_el$24, "backgroundColor", _v$8, _p$.h));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0,
			o: void 0,
			i: void 0,
			n: void 0,
			s: void 0,
			h: void 0
		});
		return _el$;
	})();
}
/**
* Entry glue: resolve version + shipped CHANGELOG.md, then show the window
* through the host dialog stack once (or on demand when `options.force` is set).
* Never throws.
*/
async function maybeShowWhatsNew(context, options = {}) {
	try {
		const version = await resolveRunningVersion$1(import.meta.url);
		if (!version) return;
		const statePath = await defaultWhatsNewStatePath();
		const changelogText = await readChangelogForBundle(import.meta.url);
		const [open, setOpen] = createSignal(false);
		const [page, setPage] = createSignal(0);
		let viewData;
		const pageCount = () => Math.max(1, Math.ceil(viewData?.pages.length ?? 1));
		let dismiss = () => {};
		try {
			context.keymap.layer(() => ({
				mode: "global",
				enabled: () => open(),
				commands: [
					{
						id: "pantheon.whats-new.confirm",
						title: "Confirm and close what is new",
						bind: "enter,space",
						run: () => {
							if (!open()) return false;
							dismiss();
						}
					},
					{
						id: "pantheon.whats-new.close",
						title: "Close what is new",
						bind: "escape,q",
						run: () => {
							if (!open()) return false;
							dismiss();
						}
					},
					{
						id: "pantheon.whats-new.next",
						title: "Próxima página",
						bind: "n,right",
						run: () => {
							if (!open()) return false;
							setPage((current) => Math.min(current + 1, pageCount() - 1));
						}
					},
					{
						id: "pantheon.whats-new.prev",
						title: "Página anterior",
						bind: "p,left",
						run: () => {
							if (!open()) return false;
							setPage((current) => Math.max(current - 1, 0));
						}
					}
				]
			}));
		} catch {}
		await openWhatsNew({
			version,
			statePath,
			changelogText,
			force: options.force === true,
			show: (render, onClose) => {
				const close = () => {
					setOpen(false);
					onClose();
				};
				dismiss = () => {
					try {
						context.ui.dialog.clear();
					} catch {}
					close();
				};
				viewData = render();
				setPage(0);
				setOpen(true);
				try {
					const theme = context.theme?.text ?? {};
					const warn = theme?.feedback?.warning?.base ?? "#fba970";
					context.ui.dialog.show(() => createComponent(WhatsNewContent, {
						data: viewData,
						page,
						pageCount,
						get fg() {
							return theme.base;
						},
						get muted() {
							return theme.muted;
						},
						warn,
						onClose: dismiss,
						onNext: () => setPage((current) => Math.min(current + 1, pageCount() - 1)),
						onPrev: () => setPage((current) => Math.max(current - 1, 0))
					}), close);
					context.ui.dialog.set({
						size: "large",
						centered: true
					});
				} catch {}
			}
		});
	} catch {}
}
//#endregion
//#region src/index.tsx
/** @jsxImportSource @opentui/solid */
const SINGLETON = Symbol.for("pantheon.tui.v2.loaded");
/** How often the sidebar re-reads .pantheon/active-preset.json (V1 parity) so
*  `set-tier` changes made while opencode is open show up within ~30s. */
const PRESET_REFRESH_MS = 3e4;
/** Running-row spinner cadence — matches V1's animation tick. */
const SPINNER_INTERVAL_MS = 80;
/** Bounded warm-up: sync at most this many sessions at plugin load. */
const WARMUP_SESSION_LIMIT = 24;
/** Sidebar body shown while the host has not published a session yet. */
const SIDEBAR_WAITING_LABEL = "Waiting for session…";
/** Delegate-completion toast title. */
const TOAST_TITLE = "Pantheon";
/** Marker before the preset label (fixed header, home status, prompt footer).
*  `▸` U+25B8 is one cell; the previous bolt (U+26A1) carries
*  Emoji_Presentation and is measured as two cells, which misaligned the line. */
const PRESET_MARKER = "▸";
/** Git ahead / behind arrows (U+2191 / U+2193), one cell each — the glyphs the
*  reference sidebars use for `↑ahead ↓behind`. */
const GIT_ARROW_UP = "↑";
const GIT_ARROW_DOWN = "↓";
/** One event name the host publishes on `data.on` — the OpenCode V2 union. */
/** V2 events that refresh the sidebar. V1 also listened to `session.updated`,
*  but that name is absent from the OpenCode V2 event union (verified against
*  `@opencode/client`'s `OpenCodeEvent`), so the valid events that carry the
*  same state changes are used instead: `session.renamed` /
*  `session.metadata.updated` / `session.moved` (the mutations `session.updated`
*  used to stand for) and `session.idle` (a child finishing). `satisfies` keeps
*  the literals while making a name outside the union a type error (surfaced by
*  `tsc -p tsconfig.build.json`), and the sidebar test asserts the same names
*  against the installed union at runtime. */
const SIDEBAR_REFRESH_EVENTS = [
	"session.created",
	"session.renamed",
	"session.metadata.updated",
	"session.moved",
	"session.idle",
	"session.status",
	"session.deleted",
	"session.execution.started",
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
	"session.message.content.updated",
	"session.tool.input.started",
	"session.tool.called",
	"session.tool.success",
	"session.tool.failed",
	"session.step.ended",
	"session.usage.updated",
	"session.permissions"
];
/** One `overrides.agents[<agent>]` entry from active-preset.json. */
/** The override map the CLI wrote into active-preset.json. */
/** A preset plus the explicit overrides stored next to it. */
function emptyOverrides() {
	return { agents: {} };
}
/** Keep only well-formed per-agent overrides: unknown keys are ignored and a
*  non-string model/variant is dropped instead of leaking into the render. */
function parsePresetOverrides(value) {
	const overrides = emptyOverrides();
	if (!value || typeof value !== "object") return overrides;
	const agents = value.agents;
	if (!agents || typeof agents !== "object") return overrides;
	for (const [agent, entry] of Object.entries(agents)) {
		if (agent === "" || !entry || typeof entry !== "object") continue;
		const model = entry.model;
		const variant = entry.variant;
		const override = {};
		if (typeof model === "string" && model !== "") override.model = model;
		if (typeof variant === "string" && variant !== "") override.variant = variant;
		if (override.model !== void 0 || override.variant !== void 0) overrides.agents[agent] = override;
	}
	return overrides;
}
/** Read .pantheon/active-preset.json — first existing candidate wins; malformed
*  JSON or a `preset` that is missing, empty or "none" → null (no fall-through
*  to lower candidates). The explicit per-agent overrides stored in the same
*  file come along so the sidebar can mark them with `*`. */
async function readActivePresetDetail(cwd) {
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	const candidates = [
		join(cwd, ".pantheon", "active-preset.json"),
		join(xdgConfig, "opencode", ".pantheon", "active-preset.json"),
		join(homedir(), ".opencode", ".pantheon", "active-preset.json")
	];
	for (const candidate of candidates) {
		let raw;
		try {
			raw = await readFile(candidate, "utf8");
		} catch {
			continue;
		}
		try {
			const parsed = JSON.parse(raw);
			const name = parsed && typeof parsed === "object" ? parsed.preset : void 0;
			if (typeof name !== "string" || name.length === 0 || name === "none") return null;
			return {
				info: {
					name,
					source: "file"
				},
				overrides: parsePresetOverrides(parsed.overrides)
			};
		} catch {
			return null;
		}
	}
	return null;
}
/** Env leg of resolution: PANTHEON_MODEL_PRESET set and !== 'none' wins. */
function presetFromEnv(env) {
	const name = env.PANTHEON_MODEL_PRESET;
	if (name !== void 0 && name !== "" && name !== "none") return {
		name,
		source: "env"
	};
	return {
		name: null,
		source: null
	};
}
/** Resolve the active preset plus its per-agent overrides: env > file > default.
*  An env-selected preset has no file overrides by construction. */
async function resolveActivePresetForTui(env, cwd) {
	const envPreset = presetFromEnv(env);
	if (envPreset.source === "env") return {
		info: envPreset,
		overrides: emptyOverrides()
	};
	return await readActivePresetDetail(cwd) ?? {
		info: {
			name: null,
			source: null
		},
		overrides: emptyOverrides()
	};
}
/** `SessionInfo.id` is always a `ses…` handle. Guarded so a placeholder or a
*  foreign id never reaches the status/navigate APIs. */
function isValidSessionID(id) {
	return typeof id === "string" && id.startsWith("ses");
}
function numberOrNull(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
/** Model reference shapes the host publishes: `ModelRef` objects, bare ids, or
*  `provider/model` strings. Returns the id part, never throws. */
function modelRefID(ref) {
	if (typeof ref === "string") return ref === "" ? null : ref;
	if (ref && typeof ref === "object") {
		const id = ref.id;
		if (typeof id === "string" && id !== "") return id;
	}
	return null;
}
/** Short display id: the segment after the last `/` (`opencode-go/kimi-k3` →
*  `kimi-k3`), truncated so a long id never wraps the sidebar. */
function shortModelID(ref, max = 24) {
	const id = modelRefID(ref);
	if (id === null) return null;
	const segment = id.slice(id.lastIndexOf("/") + 1);
	if (segment === "") return null;
	return segment.length > max ? `${segment.slice(0, Math.max(1, max - 1))}…` : segment;
}
/** `providerID` of a model reference, trimmed; null when absent/blank. Derived
*  only from what the host already published — never a lookup table. */
function providerIDFromRef(ref) {
	if (ref === null || typeof ref !== "object") return null;
	const providerID = ref.providerID;
	return typeof providerID === "string" && providerID.trim() !== "" ? providerID.trim() : null;
}
/** Provider for a bare-string model reference: match its id (or bare segment)
*  in the host model list. Null when the list cannot answer. */
function providerIDFromModels(models, ref) {
	if (!Array.isArray(models)) return null;
	const id = modelRefID(ref);
	if (id === null) return null;
	const segment = id.slice(id.lastIndexOf("/") + 1);
	for (const model of models) {
		if (!model || typeof model !== "object") continue;
		const modelID = typeof model.modelID === "string" ? model.modelID : "";
		const rowID = typeof model.id === "string" ? model.id : "";
		if (modelID !== id && rowID !== id && modelID !== segment && rowID !== segment) continue;
		const providerID = providerIDFromRef(model);
		if (providerID !== null) return providerID;
	}
	return null;
}
/** Resolve `model.limit.context` for a model reference. Match order: the
*  provider-qualified id, then the bare id (the host's `id`/`modelID` fields).
*  Absent/ambiguous models degrade to null so the gauge is simply omitted. */
function resolveContextLimit(models, ref) {
	const id = modelRefID(ref);
	if (id === null) return null;
	const providerID = ref && typeof ref === "object" ? ref.providerID : void 0;
	const segment = id.slice(id.lastIndexOf("/") + 1);
	const matches = models.filter((model) => {
		if (!model || typeof model !== "object") return false;
		const modelID = typeof model.modelID === "string" ? model.modelID : "";
		const rowID = typeof model.id === "string" ? model.id : "";
		if (!(modelID === id || rowID === id || modelID === segment || rowID === segment)) return false;
		if (typeof providerID !== "string" || providerID === "") return true;
		return model.providerID === providerID;
	});
	const candidates = matches.length > 0 ? matches : models.filter((model) => {
		const modelID = typeof model?.modelID === "string" ? model.modelID : "";
		const rowID = typeof model?.id === "string" ? model.id : "";
		return modelID === segment || rowID === segment;
	});
	for (const model of candidates) {
		const limit = model?.limit?.context;
		if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) return limit;
	}
	return null;
}
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
function modelID(ref) {
	const record = asRecord(ref);
	const id = typeof ref === "string" ? ref : record?.id ?? record?.modelID;
	return typeof id === "string" && id.trim() !== "" ? id : null;
}
function messageModelRef(message) {
	return message.model ?? message;
}
function modelProvider(ref, models) {
	const direct = asRecord(ref)?.providerID;
	if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
	const id = modelID(ref);
	if (id === null) return null;
	const segment = id.slice(id.lastIndexOf("/") + 1);
	const providers = /* @__PURE__ */ new Set();
	for (const candidate of models) {
		const item = asRecord(candidate);
		if (!item) continue;
		if (item.id !== id && item.modelID !== id && item.id !== segment && item.modelID !== segment) continue;
		if (typeof item.providerID === "string" && item.providerID.trim() !== "") providers.add(item.providerID.trim());
	}
	const explicitProvider = id.includes("/") ? id.slice(0, id.indexOf("/")) : null;
	if (explicitProvider && providers.has(explicitProvider)) return explicitProvider;
	return providers.size === 1 ? [...providers][0] ?? null : null;
}
function modelIdentity(ref, models) {
	const id = modelID(ref);
	if (id === null) return null;
	const providerID = modelProvider(ref, models);
	const segment = id.slice(id.lastIndexOf("/") + 1);
	return {
		key: `${providerID ?? ""}\u0000${id}`,
		id,
		providerID,
		label: segment || id
	};
}
function tokenCount(message) {
	const tokens = asRecord(message.tokens);
	if (!tokens) return null;
	const cache = asRecord(tokens.cache);
	const reported = [
		tokens.input,
		tokens.output,
		tokens.reasoning,
		cache?.read,
		cache?.write
	].filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
	return reported.length === 0 ? null : reported.reduce((sum, value) => sum + value, 0);
}
function contextLimit(ref, models) {
	const id = modelID(ref);
	if (id === null) return null;
	const providerID = modelProvider(ref, models);
	if (providerID === null) return null;
	const segment = id.slice(id.lastIndexOf("/") + 1);
	const matches = models.filter((value) => {
		const model = asRecord(value);
		if (!model) return false;
		return (model.id === id || model.modelID === id || model.id === segment || model.modelID === segment) && model.providerID === providerID;
	});
	const limits = /* @__PURE__ */ new Set();
	for (const candidate of matches) {
		const limit = asRecord(asRecord(candidate)?.limit)?.context;
		if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) limits.add(limit);
	}
	return limits.size === 1 ? [...limits][0] ?? null : null;
}
function liveTranscriptWindow(messages, revertMessageID) {
	let end = messages.length;
	if (revertMessageID) {
		const boundary = messages.findIndex((message) => asRecord(message)?.id === revertMessageID);
		if (boundary >= 0) end = boundary;
	}
	let start = 0;
	for (let index = end - 1; index >= 0; index -= 1) if (asRecord(messages[index])?.type === "compaction") {
		start = index + 1;
		break;
	}
	return {
		start,
		end
	};
}
function latestContext(messages, modelRef, models, revertMessageID) {
	const target = modelIdentity(modelRef, models);
	if (target === null || target.providerID === null) return null;
	const limit = contextLimit(modelRef, models);
	if (limit === null || limit <= 0) return null;
	const { start, end } = liveTranscriptWindow(messages, revertMessageID);
	for (let index = end - 1; index >= start; index -= 1) {
		const message = asRecord(messages[index]);
		if (message?.type !== "assistant") continue;
		const identity = modelIdentity(messageModelRef(message), models);
		if (identity?.id !== target.id || identity.providerID !== target.providerID) continue;
		const tokens = tokenCount(message);
		if (tokens === null || tokens <= 0) continue;
		return {
			tokens,
			percent: Math.round(tokens / limit * 100),
			limit
		};
	}
	return null;
}
/** Snapshot for one exact model identity in the bounded active transcript. */
function resolveModelContextSnapshot(messages, modelRef, models, revertMessageID) {
	return latestContext(messages.slice(-400), modelRef, models, revertMessageID);
}
/** Select the pinned chat model before transcript or configured-agent fallbacks. */
function resolveActiveModelRef(sessionModel, activeMessages, fallbackModel = null) {
	if (modelID(sessionModel) !== null) return sessionModel;
	const firstMessage = Math.max(0, activeMessages.length - 400);
	for (let index = activeMessages.length - 1; index >= firstMessage; index -= 1) {
		const message = asRecord(activeMessages[index]);
		if (message?.type !== "assistant") continue;
		const ref = messageModelRef(message);
		if (modelID(ref) !== null) return ref;
	}
	return modelID(fallbackModel) === null ? null : fallbackModel;
}
/** Native token total: input + output + reasoning + cache read + cache write. */
function messageTokensTotal(tokens) {
	const cacheRead = numberOrNull(tokens?.cache?.read) ?? 0;
	const cacheWrite = numberOrNull(tokens?.cache?.write) ?? 0;
	return (numberOrNull(tokens?.input) ?? 0) + (numberOrNull(tokens?.output) ?? 0) + (numberOrNull(tokens?.reasoning) ?? 0) + cacheRead + cacheWrite;
}
/** The part of a transcript that still counts: everything before the revert
*  boundary (when a revert is active), then after the last compaction. Both
*  derived numbers that read "the last assistant with usage" — the context
*  gauge and the cache hit rate — share this window, so a reverted-away or
*  compacted-away message can never feed either one. Pure. */
function transcriptWindow(messages, revertMessageID) {
	let end = messages.length;
	if (typeof revertMessageID === "string" && revertMessageID !== "") {
		const boundary = messages.findIndex((message) => message?.id === revertMessageID);
		if (boundary >= 0) end = boundary;
	}
	let start = 0;
	for (let index = end - 1; index >= 0; index--) if (messages[index]?.type === "compaction") {
		start = index + 1;
		break;
	}
	return {
		start,
		end
	};
}
/** Context usage for a message list. Scope: the live window (see
*  `transcriptWindow`). The last assistant message carrying `tokens` in that
*  window wins. Null when there is no limit or no such message — the caller
*  then omits the block. */
function computeContextUsage(messages, contextLimit, revertMessageID) {
	const limit = numberOrNull(contextLimit);
	if (limit === null || limit <= 0) return null;
	if (!Array.isArray(messages) || messages.length === 0) return null;
	const { start, end } = transcriptWindow(messages, revertMessageID);
	for (let index = end - 1; index >= start; index--) {
		const message = messages[index];
		if (message?.type !== "assistant" || !message.tokens) continue;
		const tokens = messageTokensTotal(message.tokens);
		if (!Number.isFinite(tokens) || tokens <= 0) continue;
		return {
			tokens,
			percent: Math.round(tokens / limit * 100),
			limit
		};
	}
	return null;
}
/** Color for one gauge stage. Filled cells and the percent value both come from
*  this one call, so the bar and its number can never disagree. `theme` is the
*  host's resolved theme (loosely typed at runtime); a missing token falls back
*  to the theme's base text instead of an unstyled cell. Pure. */
function contextProgressColor(stage, theme) {
	return theme?.text?.feedback?.[stage]?.base ?? theme?.text?.base;
}
/** The muted extra line under the gauge: `cache 92% · 42.3 tok/s`. Either half
*  may be missing (no cache read, no measurable turn); no data at all yields
*  null so no empty line is rendered. The speed keeps the host's own one
*  decimal and `tok/s` label. Pure. */
function contextPerformanceLine(performance) {
	if (!performance) return null;
	const parts = [];
	const cacheHit = numberOrNull(performance.cacheHit);
	if (cacheHit !== null) parts.push(`cache ${Math.round(cacheHit)}%`);
	const tokensPerSecond = numberOrNull(performance.tokensPerSecond);
	if (tokensPerSecond !== null) parts.push(`${tokensPerSecond.toFixed(1)} tok/s`);
	return parts.length === 0 ? null : parts.join(SPEND_LINE_SEPARATOR);
}
/** Cache hit rate of one message: `cache.read / (input + cache.read)` as a
*  percentage. The denominator must be > 0, otherwise the ratio is meaningless
*  (a message that only wrote to the cache has no input to hit). Null when the
*  numbers are absent. Pure. */
function cacheHitPercent(tokens) {
	const read = numberOrNull(tokens?.cache?.read);
	const input = numberOrNull(tokens?.input);
	if (read === null || input === null) return null;
	const denominator = input + read;
	if (!(denominator > 0)) return null;
	return read / denominator * 100;
}
/** The message the cache hit rate comes from: the last assistant of the live
*  window (see `transcriptWindow`) that actually carries `tokens`. Later
*  messages without usage — a streaming placeholder that the host publishes
*  before any step completes, a step that reports no usage — are skipped
*  instead of blanking a ratio the previous message already measured. Null
*  when nothing in the window has usage. Pure. */
function lastAssistantWithTokens(messages, revertMessageID) {
	if (!Array.isArray(messages) || messages.length === 0) return null;
	const { start, end } = transcriptWindow(messages, revertMessageID);
	for (let index = end - 1; index >= start; index--) {
		const message = messages[index];
		if (message?.type !== "assistant" || !message.tokens) continue;
		return message;
	}
	return null;
}
/** Tokens per second of the current turn. Mirrors the host's
*  `turnTokensPerSecond` (anomalyco/opencode v2.0.30,
*  `packages/tui/src/routes/session/rows.ts`) so the sidebar and the native
*  session footer can never disagree: the numerator is `output + reasoning`
*  summed over every assistant step of the turn and the denominator is the
*  summed active streaming time `max(0, time.streamed - time.created)`, so the
*  division happens once, after aggregating — each step weighs by its own
*  duration instead of each step voting equally. `completed` is never used; a
*  turn with a step that has no `time.streamed` has no measurable speed. The
*  turn starts after the last `user` message; with no user message only the
*  last assistant step counts (degraded: there is no boundary to group by).
*  Pure and fail-open. */
function turnTokensPerSecond(messages, position) {
	if (!Array.isArray(messages) || messages.length === 0) return null;
	let anchor = -1;
	if (typeof position === "number" && Number.isInteger(position) && position >= 0 && position < messages.length) anchor = position;
	else for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.type === "assistant") {
		anchor = index;
		break;
	}
	if (anchor === -1 || messages[anchor]?.type !== "assistant") return null;
	let start = -1;
	for (let index = anchor - 1; index >= 0; index--) if (messages[index]?.type === "user") {
		start = index;
		break;
	}
	const steps = start === -1 ? [messages[anchor]] : messages.slice(start + 1, anchor + 1).filter((item) => item?.type === "assistant");
	if (steps.length === 0) return null;
	let output = 0;
	let duration = 0;
	for (const step of steps) {
		output += (numberOrNull(step?.tokens?.output) ?? 0) + (numberOrNull(step?.tokens?.reasoning) ?? 0);
		const created = numberOrNull(step?.time?.created);
		const streamed = numberOrNull(step?.time?.streamed);
		if (created === null || streamed === null) return null;
		duration += Math.max(0, streamed - created);
	}
	if (output <= 0 || duration <= 0) return null;
	const rate = output / (duration / 1e3);
	return Number.isFinite(rate) && rate > 0 ? rate : null;
}
/** Last-message telemetry the Context block renders in muted text. Both halves
*  are optional; the block renders no line when neither is available. */
/** One rendered context row. `lead` and `tail` carry the gauge bar when the row
*  has one (`lead` is toned with the value, `tail` is muted), so the 12 cells
*  stay contiguous while the empty half still reads as background. */
/** The `Context` block's data rows; null rows are not rendered. */
/** Rows for the `Context` block:
*  `<tokens> tokens` / `▰▰▰▰▰▱▱▱▱▱▱▱ <percent>% of <window>` /
*  `$<spent> spent`. The percentage row carries the only semantic tone, the
*  gauge bar (12 cells) and is omitted entirely when the percentage is
*  unavailable (never `undefined%`). A block with neither tokens nor cost
*  yields null. `gaugeStyle` (the TUI tab's pref) picks the percent-row
*  shape: `both` (default), `bar`, `percent`, or `off` (row omitted). Pure. */
function contextBlockRows(usage, cost, gaugeStyle = "both", barOptions) {
	const spentValue = formatSpent(cost);
	const spent = spentValue === null ? null : {
		lead: null,
		value: spentValue,
		tail: null,
		suffix: " spent in session",
		tone: null
	};
	if (usage === null) return spent === null ? null : {
		tokens: null,
		percent: null,
		spent
	};
	const tokensValue = formatTokenCount(usage.tokens);
	const tokens = tokensValue === null ? null : {
		lead: null,
		value: tokensValue,
		tail: null,
		suffix: " tokens",
		tone: null
	};
	const percentValue = numberOrNull(usage.percent);
	const window = formatContextWindow(usage.limit);
	const bar = contextBar(percentValue, barOptions ?? 12);
	let percent = null;
	if (gaugeStyle !== "off" && bar !== null && percentValue !== null) {
		const suffix = window === null ? null : ` of ${window}`;
		const tone = contextUsageTone(percentValue);
		if (gaugeStyle === "bar") percent = {
			lead: bar.filled,
			value: "",
			tail: bar.empty,
			suffix,
			tone
		};
		else if (gaugeStyle === "percent") percent = {
			lead: null,
			value: ` ${Math.round(percentValue)}%`,
			tail: null,
			suffix: null,
			tone
		};
		else percent = {
			lead: bar.filled,
			value: ` ${Math.round(percentValue)}%`,
			tail: bar.empty,
			suffix,
			tone
		};
	}
	if (tokens === null && percent === null && spent === null) return null;
	return {
		tokens,
		percent,
		spent
	};
}
/** Custo do último turno do assistente e do turno anterior. Pure. */
function latestTurnCost(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return null;
	let current = null;
	let previous = null;
	let anchor = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.type !== "assistant") continue;
		const cost = numberOrNull(message.cost);
		if (cost !== null && cost >= 0) {
			current = cost;
			anchor = index;
			break;
		}
	}
	if (current === null || anchor === -1) return null;
	for (let index = anchor - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.type !== "assistant") continue;
		const cost = numberOrNull(message.cost);
		if (cost !== null && cost >= 0) {
			previous = cost;
			break;
		}
	}
	return {
		current,
		previous
	};
}
function formatTurnCostUSD(cost) {
	const value = numberOrNull(cost);
	if (value === null || value < 0) return null;
	if (value === 0) return "$0.00";
	if (value >= 1) return `$${value.toFixed(2)}`;
	if (value >= .1) return `$${value.toFixed(2)}`;
	const val3 = value.toFixed(3);
	if (val3.endsWith("0") && value >= .01) return `$${value.toFixed(2)}`;
	return `$${val3}`;
}
function formatTurnCostLine(summary) {
	if (!summary || summary.current === null || summary.current < 0) return null;
	const curr = formatTurnCostUSD(summary.current);
	if (!curr) return null;
	if (summary.previous !== null && summary.previous >= 0) {
		const prev = formatTurnCostUSD(summary.previous);
		if (prev) return `Turn: ${curr} (prev: ${prev})`;
	}
	return `Turn: ${curr}`;
}
/** Extrai desdobramento de tokens (input, output, reasoning/thinking). Pure. */
function extractTokenAnatomy(tokens) {
	if (!tokens || typeof tokens !== "object") return null;
	const input = Math.max(0, numberOrNull(tokens.input) ?? 0);
	const output = Math.max(0, numberOrNull(tokens.output) ?? 0);
	const reasoning = Math.max(0, numberOrNull(tokens.reasoning) ?? numberOrNull(tokens.thinking) ?? 0);
	if (input === 0 && output === 0 && reasoning === 0) return null;
	return {
		input,
		output,
		reasoning
	};
}
function formatTokenAnatomyLine(anatomy) {
	if (!anatomy) return null;
	const parts = [];
	if (anatomy.input > 0) parts.push(`↑${formatContextWindow(anatomy.input)}`);
	if (anatomy.output > 0) parts.push(`↓${formatContextWindow(anatomy.output)}`);
	if (anatomy.reasoning > 0) parts.push(`✦${formatContextWindow(anatomy.reasoning)} think`);
	return parts.length === 0 ? null : parts.join(" ");
}
function formatTokenAnatomySplit(anatomy) {
	if (!anatomy) return null;
	const inOutParts = [];
	if (anatomy.input > 0) inOutParts.push(`↑${formatContextWindow(anatomy.input)}`);
	if (anatomy.output > 0) inOutParts.push(`↓${formatContextWindow(anatomy.output)}`);
	const inOut = inOutParts.length > 0 ? inOutParts.join(" · ") : null;
	const think = anatomy.reasoning > 0 ? `✦ ${formatContextWindow(anatomy.reasoning)} think` : null;
	if (!inOut && !think) return null;
	return {
		inOut,
		think
	};
}
const TOOL_DOMAIN_ORDER = [
	"mem",
	"ctx",
	"code",
	"edit",
	"read",
	"shell",
	"agent",
	"mcp"
];
function normalizeToolName(part) {
	return (typeof part?.name === "string" ? part.name : typeof part?.tool === "string" ? part.tool : "").trim();
}
/** Extrai chamadas `tools.<nome>(...)` de dentro do Code Mode (`execute` / `search`)
*  para revelar a tool real do Pantheon/OpenCode usada. Pure. */
function resolveEffectiveToolNames(part) {
	const outer = normalizeToolName(part);
	if (outer === "") return [];
	if (outer.toLowerCase() === "execute") {
		const code = part?.state?.input?.code;
		if (typeof code === "string" && code !== "") {
			const inner = [];
			for (const match of code.matchAll(/\btools\.([a-zA-Z0-9_]+)\s*\(/g)) if (match[1]) inner.push(match[1]);
			if (inner.length > 0) return inner;
		}
	}
	return [outer];
}
function extractToolFilePaths(part) {
	const found = [];
	const input = part?.state?.input && typeof part.state.input === "object" ? part.state.input : null;
	if (!input) return found;
	for (const candidate of [
		input.file,
		input.path,
		input.filePath,
		input.target
	]) {
		const base = fileBasename(candidate);
		if (base && !found.includes(base)) found.push(base);
	}
	if (typeof input.code === "string" && input.code !== "") for (const match of input.code.matchAll(/\b(?:file|path|filePath|target)\s*:\s*["']([^"']+)["']/g)) {
		const base = fileBasename(match[1]);
		if (base && !found.includes(base)) found.push(base);
	}
	return found;
}
function isToolFailureState(state) {
	return state?.status === "error" || state?.status === "failed" || state?.error !== void 0 || typeof state?.exitCode === "number" && state.exitCode !== 0;
}
function isToolActiveState(state) {
	return state?.status === "running" || state?.status === "pending" || state?.status === "streaming";
}
/** Classifica uma tool (nativa, OpenCode ou MCP externa) em domínio curto e
*  verbo de 3–4 caracteres para Sidebar/Dispatch. Pure. */
function classifyToolPart(rawName) {
	const name = typeof rawName === "string" ? rawName.trim().toLowerCase() : "";
	if (name === "") return {
		domain: "agent",
		verb: "tool"
	};
	if (name === "question") return {
		domain: "agent",
		verb: "ask"
	};
	if (name.startsWith("memory_")) return {
		domain: "mem",
		verb: "mem"
	};
	if (name.startsWith("context_") || name.startsWith("goal_") || name === "pantheon_step_ledger" || name === "todowrite" || name === "todoread") return {
		domain: "ctx",
		verb: name.startsWith("todo") ? "todo" : "ctx"
	};
	if (name.startsWith("code_")) return {
		domain: "code",
		verb: "code"
	};
	if (name === "hashline_edit" || name === "edit" || name === "edit_file" || name === "write" || name === "write_file" || name === "patch") return {
		domain: "edit",
		verb: "edit"
	};
	if (name === "read" || name === "read_file" || name === "glob" || name === "grep" || name === "list") return {
		domain: "read",
		verb: "read"
	};
	if (name === "shell" || name === "bash" || name === "run_command" || name === "execute") return {
		domain: "shell",
		verb: name === "execute" ? "exec" : "bash"
	};
	if (name === "pantheon_deepwork") return {
		domain: "agent",
		verb: "plan"
	};
	if (name === "subagent" || name.startsWith("pantheon_") || name === "vision" || name === "webfetch" || name === "websearch" || name === "search") return {
		domain: "agent",
		verb: name.startsWith("web") ? "web" : "agnt"
	};
	if (name.includes("_") && !name.startsWith("pantheon_")) return {
		domain: "mcp",
		verb: "mcp"
	};
	return {
		domain: "agent",
		verb: "tool"
	};
}
/** Resume chamadas de ferramentas por domínio nativo + tool em execução. Pure. */
function summarizeToolDomains(messages) {
	const byDomain = {};
	if (!Array.isArray(messages)) return {
		total: 0,
		failures: 0,
		byDomain,
		activeTool: null
	};
	let total = 0;
	let failures = 0;
	let activeTool = null;
	for (const message of messages) {
		if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part?.type !== "tool") continue;
			total++;
			const state = part.state;
			if (isToolFailureState(state)) failures++;
			const effectiveNames = resolveEffectiveToolNames(part);
			for (const toolName of effectiveNames) {
				const { domain } = classifyToolPart(toolName);
				byDomain[domain] = (byDomain[domain] ?? 0) + 1;
			}
			if (isToolActiveState(state) && effectiveNames.length > 0) activeTool = effectiveNames[effectiveNames.length - 1] ?? null;
		}
	}
	return {
		total,
		failures,
		byDomain,
		activeTool
	};
}
/** Conta chamadas de ferramentas e eventuais falhas/erros. Pure. */
function countToolCalls(messages) {
	const { total, failures } = summarizeToolDomains(messages);
	return {
		total,
		failures
	};
}
/** Formata a quebra compacta por domínio (`mem:2 ctx:1 code:1 · ✦ memory_search`)
*  para caber na largura da sidebar. Retorna null sem dados. Pure. */
function formatToolDomainLine(summary, max = 34) {
	if (!summary) return null;
	const chunks = [];
	for (const domain of TOOL_DOMAIN_ORDER) {
		const count = summary.byDomain?.[domain] ?? 0;
		if (count > 0) chunks.push(`${domain}:${count}`);
	}
	const active = typeof summary.activeTool === "string" && summary.activeTool.trim() !== "" ? `\u2726 ${summary.activeTool.trim()}` : null;
	if (chunks.length === 0 && !active) return null;
	const joined = chunks.join(" ");
	const raw = active ? joined ? `${joined} \u00B7 ${active}` : active : joined;
	if (cellWidth(raw) <= max) return raw;
	if (active) {
		const activeFit = truncateLabel(active, max);
		const remaining = max - cellWidth(activeFit) - 3;
		if (remaining >= 5 && joined !== "") return `${truncateLabel(joined, remaining)} \u00B7 ${activeFit}`;
		return activeFit;
	}
	return truncateLabel(raw, max);
}
function formatToolCallLine(summary, locale = "en") {
	if (!summary || summary.total === 0) return null;
	const isPt = locale === "pt-BR" || locale === "pt";
	if (summary.failures > 0) {
		const errText = isPt ? summary.failures === 1 ? "1 falha" : `${summary.failures} falhas` : `${summary.failures} err`;
		return `tools: ${summary.total} (${errText})`;
	}
	const zeroText = isPt ? "0 falhas" : "0 err";
	return `tools: ${summary.total} (${zeroText})`;
}
/** Extrai contagem de compactações e estimativa de tokens podados. Pure. */
function extractCompactionInfo(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return {
		count: 0,
		prunedTokens: 0
	};
	let count = 0;
	let prunedTokens = 0;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg?.type === "compaction") {
			count++;
			const directPruned = numberOrNull(msg?.pruned) ?? numberOrNull(msg?.tokens?.pruned) ?? numberOrNull(msg?.data?.pruned);
			if (directPruned !== null && directPruned > 0) prunedTokens += directPruned;
			else {
				let beforeSum = 0;
				for (let j = 0; j < i; j++) {
					const prev = messages[j];
					if (prev?.type === "assistant" && prev?.tokens) beforeSum += messageTokensTotal(prev.tokens);
				}
				if (beforeSum > 0) prunedTokens = Math.max(prunedTokens, beforeSum);
			}
		}
	}
	return {
		count,
		prunedTokens
	};
}
/** Conta quantas vezes a sessão sofreu compactação nativa. Pure. */
function countSessionCompactions(messages) {
	if (!Array.isArray(messages)) return 0;
	let count = 0;
	for (const message of messages) if (message?.type === "compaction") count++;
	return count;
}
function formatCompactionBadge(info) {
	if (typeof info === "number") {
		if (info <= 0) return null;
		return `${info}x compact`;
	}
	if (!info || info.count <= 0) return null;
	if (info.prunedTokens > 0) return `${info.count}x compact (-${formatContextWindow(info.prunedTokens)})`;
	return `${info.count}x compact`;
}
/** Conta mensagens do usuário para mensurar turnos da sessão. Pure. */
function countUserTurns(messages) {
	if (!Array.isArray(messages)) return 0;
	let count = 0;
	for (const message of messages) if (message?.type === "user") count++;
	return count;
}
function formatTurnsBadge(count, locale = "en") {
	if (count <= 0) return null;
	if (locale === "pt-BR" || locale === "pt") return count === 1 ? "↻ 1 turno" : `↻ ${count} turnos`;
	return `↻ ${count} turn${count === 1 ? "" : "s"}`;
}
function resolveGateStatus(env = process.env) {
	const mode = (env.PANTHEON_J1_RISK_SCORE ?? "").trim().toLowerCase();
	if (mode === "enforce") return "✓ Gate: enforce";
	if (mode === "warn") return "✓ Gate: warn";
	if (mode === "shadow" || mode === "1" || mode === "true" || mode === "on") return "✓ Gate: active";
	return "✓ Gate: shadow";
}
/** Column widths for one model row (labels are muted, numbers right-aligned). */
const MODEL_USAGE_MODEL_WIDTH = 12;
const MODEL_USAGE_TOKEN_WIDTH = 6;
const MODEL_USAGE_COST_WIDTH = 8;
/** Session events arrive in bursts; model rows are recomputed at most once
*  per window (same cadence as the git-count revalidation). */
const MODEL_USAGE_DEBOUNCE_MS = 400;
/** Real usage for one model, summed across the assistant messages that used it. */
/** Totals per model from assistant messages: sums `cost` and `tokens`, drops
*  models whose real cost is 0/absent, and orders by cost (then tokens, then
*  name). `providerID` participates in the key so two providers exposing the
*  same bare id are not merged. Pure. */
function collectModelUsage(messages) {
	if (!Array.isArray(messages)) return [];
	const totals = /* @__PURE__ */ new Map();
	for (const message of messages) {
		if (message?.type !== "assistant") continue;
		const id = modelRefID(message.model);
		const model = shortModelID(message.model, 12);
		if (id === null || model === null) continue;
		const key = `${typeof message.model?.providerID === "string" ? message.model.providerID : ""}\u0000${id}`;
		const tokensTotal = message.tokens ? messageTokensTotal(message.tokens) : 0;
		const cost = numberOrNull(message.cost) ?? 0;
		const current = totals.get(key);
		if (current) {
			current.tokens += Math.max(0, tokensTotal);
			current.cost += Math.max(0, cost);
		} else totals.set(key, {
			model,
			tokens: Math.max(0, tokensTotal),
			cost: Math.max(0, cost)
		});
	}
	return [...totals.values()].filter((row) => row.cost > 0).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.model.localeCompare(b.model));
}
/** Visible rows plus the aggregate of the models that did not fit. Pure. */
/** Cap the model list at `maxVisible`; the rest is aggregated (still real
*  totals) for the `… +N` line. Pure. */
function ceilingModelUsage(rows, maxVisible = 3) {
	const limit = Math.max(0, maxVisible);
	const visible = rows.slice(0, limit);
	const rest = rows.slice(visible.length);
	return {
		visible,
		hidden: rest.length,
		hiddenCost: rest.reduce((sum, row) => sum + row.cost, 0),
		hiddenTokens: rest.reduce((sum, row) => sum + row.tokens, 0)
	};
}
/** Compact tokens for a model row (`80,000` → `80K`); `0` stays explicit. Pure. */
function formatUsageTokens(tokens) {
	const value = numberOrNull(tokens);
	if (value === null || value <= 0) return "0";
	return formatContextWindow(value) ?? String(Math.round(value));
}
/** Real per-model cost with adaptive precision: cents for `>= $0.01`, up to
*  four decimals below that (a real `$0.0031` must not render as `$0.00`), and
*  an explicit `< $0.0001` for the remainder. Pure. */
function formatUsageCost(cost) {
	const value = numberOrNull(cost);
	if (value === null || value < 0) return null;
	if (value === 0) return "$0.00";
	if (value >= .01) return `$${value.toFixed(2)}`;
	if (value >= 1e-4) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
	return "<$0.0001";
}
/** One formatted model row: truncated label + compact tokens + real cost. */
/** Format the visible model rows for rendering. Labels are already short ids
*  (12 chars); the second truncation only guards host drift. Pure. */
function modelUsageRows(rows) {
	return rows.map((row) => ({
		model: truncateLabel(row.model, 12),
		tokens: formatUsageTokens(row.tokens),
		cost: formatUsageCost(row.cost) ?? "$0.00"
	}));
}
/** Exact single-line text of a model row, with numbers right-aligned. Pure. */
function modelUsageRowText(row) {
	return `${row.model.padEnd(12)}  ${row.tokens.padStart(6)}  ${row.cost.padStart(8)}`;
}
/** Wrap on grapheme boundaries, measuring terminal cells rather than code units.
*  (Body moved verbatim from the removed quota module's `quotaTextLines`.) */
function wrapTextLines(text, width, indent) {
	const max = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (max < 1) return [];
	const padding = " ".repeat(Math.min(Math.max(0, indent), Math.max(0, max - 2)));
	const lines = [];
	let line = padding;
	const segmenter = new Intl.Segmenter();
	for (const word of text.trim().split(/\s+/)) {
		if (!word) continue;
		if (line.trim() && cellWidth(line) + 1 + cellWidth(word) > max) {
			lines.push(line.trimEnd());
			line = padding;
		}
		if (line.trim()) line += " ";
		for (const { segment } of segmenter.segment(word)) {
			const glyphWidth = cellWidth(segment);
			if (glyphWidth > max) continue;
			if (cellWidth(line) + glyphWidth > max) {
				if (line.trim()) lines.push(line.trimEnd());
				line = glyphWidth + cellWidth(padding) <= max ? padding : "";
			}
			line += segment;
		}
	}
	if (line.trim()) lines.push(line.trimEnd());
	return lines;
}
/** Wrap sidebar text by terminal cells, preserving the complete values. */
function sidebarTextLines(value) {
	return wrapTextLines(value, 34, 0);
}
/** Align a monetary value when it fits, otherwise preserve it on a new line. */
function sidebarMoneyLines(label, value) {
	const gap = 34 - cellWidth(label) - cellWidth(value);
	return gap >= 1 ? [`${label}${" ".repeat(gap)}${value}`] : [...sidebarTextLines(label), ...sidebarTextLines(value)];
}
/** Keep the existing OpenCode periods together when possible. */
function contextSpendLines(value) {
	const match = /^(.*\S)\s+(<?\$\S+)$/.exec(value);
	return match?.[1] && match[2] && cellWidth(value) <= 34 ? sidebarMoneyLines(match[1], match[2]) : sidebarTextLines(value);
}
/** Keep ordinary rows aligned; give oversized values their own lines. */
function modelUsageRowLines(row) {
	const single = modelUsageRowText(row);
	if (cellWidth(single) <= 34) return [single];
	return [
		...sidebarTextLines(row.model),
		...sidebarTextLines(`Tokens ${row.tokens}`),
		...sidebarTextLines(`USD ${row.cost}`)
	];
}
/** Muted aggregate line for the models beyond the cap (`… +2  $0.03`). Null
*  when every model fits. Pure. */
function hiddenModelUsageText(hidden, hiddenCost) {
	if (!Number.isFinite(hidden) || hidden <= 0) return null;
	const cost = formatUsageCost(hiddenCost);
	return cost === null ? `… +${hidden}` : `… +${hidden}  ${cost}`;
}
/** Bucket for a session the host published without an agent id. */
const UNKNOWN_AGENT = "?";
/** Agent key of a session or message: the trimmed id when it is a non-empty
*  string, else the `?` bucket — never `undefined`. Pure. */
function agentKey(value) {
	if (typeof value !== "string") return "?";
	const text = value.trim();
	return text === "" ? "?" : text;
}
/** One rendered todo row. `priority` is carried by the tool but not rendered:
*  the reference block uses a single marker column. */
/** Rows rendered before the `… +N` line. */
const TODO_VISIBLE_CEILING = 6;
/** Content width before the ellipsis — the block has ~30-34 usable columns. */
const TODO_TEXT_WIDTH = 28;
/** Row markers (`•` in progress, `−` cancelled with U+2212, as in the git row). */
const TODO_MARKERS = {
	in_progress: "[•]",
	pending: "[ ]",
	completed: "[x]",
	cancelled: "[−]"
};
/** Group order: live work first, then open, then closed. */
const TODO_STATUS_ORDER = [
	"in_progress",
	"pending",
	"completed",
	"cancelled"
];
/** Narrow a loose `status` value to the tool's four states. */
function isTodoStatus(value) {
	return value === "in_progress" || value === "pending" || value === "completed" || value === "cancelled";
}
function parseJsonValue(raw) {
	if (typeof raw !== "string") return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
function extractTodoArray(payload) {
	const parsed = parseJsonValue(payload);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const rec = parsed;
		if (Array.isArray(rec.todos)) return rec.todos;
		if (rec.output !== void 0) {
			const nested = extractTodoArray(rec.output);
			if (nested !== null) return nested;
		}
	}
	return null;
}
function extractTodoArrayFromCode(code) {
	if (typeof code !== "string" || code === "") return null;
	const callRe = /\btools\.todowrite\s*\(/g;
	let lastFound = null;
	for (const match of code.matchAll(callRe)) {
		const startIdx = (match.index ?? 0) + match[0].length;
		const openBrace = code.indexOf("{", startIdx);
		if (openBrace < 0) continue;
		let depth = 0;
		let quote = null;
		let escaped = false;
		let endBrace = -1;
		for (let i = openBrace; i < code.length; i += 1) {
			const ch = code[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (quote !== null) {
				if (ch === "\\") escaped = true;
				else if (ch === quote) quote = null;
				continue;
			}
			if (ch === "\"" || ch === "'" || ch === "`") {
				quote = ch;
				continue;
			}
			if (ch === "{") depth += 1;
			else if (ch === "}") {
				depth -= 1;
				if (depth === 0) {
					endBrace = i;
					break;
				}
			}
		}
		if (endBrace < 0) continue;
		const snippet = code.slice(openBrace, endBrace + 1);
		const direct = parseJsonValue(snippet);
		if (direct && typeof direct === "object" && Array.isArray(direct.todos)) {
			lastFound = direct.todos;
			continue;
		}
		const normalized = parseJsonValue(snippet.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, "$1\"$2\":"));
		if (normalized && typeof normalized === "object" && Array.isArray(normalized.todos)) lastFound = normalized.todos;
	}
	return lastFound;
}
/** Items from a `todowrite` `input` payload. A missing/malformed `input`,
*  absent `todos`, an unknown `status` or an empty/missing `content` drops the
*  entry instead of throwing; a list with nothing readable yields `[]`. Pure. */
function parseTodoItems(input) {
	const raw = extractTodoArray(input);
	if (!Array.isArray(raw)) return [];
	const items = [];
	for (const entry of raw) {
		const content = entry?.content;
		const status = entry?.status;
		if (typeof content !== "string" || content.trim() === "") continue;
		if (!isTodoStatus(status)) continue;
		items.push({
			content: content.trim(),
			status
		});
	}
	return items;
}
/** Newest completed `todowrite` in a transcript. The tool replaces the list
*  wholesale, so the last write wins; a write with `todos: []` returns null
*  (the block disappears rather than showing the previous list) and a
*  not-yet-completed write is ignored. Null when the transcript carries no
*  such part, so the block never renders a guess. Pure. */
function latestTodoItems(messages) {
	if (!Array.isArray(messages)) return null;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
		const parts = message.content;
		for (let position = parts.length - 1; position >= 0; position--) {
			const part = parts[position];
			if (part?.type !== "tool") continue;
			if (part?.state?.status !== "completed") continue;
			const toolName = normalizeToolName(part).toLowerCase();
			if (toolName === "todowrite") {
				const items = parseTodoItems(part.state.input);
				return items.length === 0 ? null : items;
			}
			if (toolName === "execute" && resolveEffectiveToolNames(part).includes("todowrite")) {
				const rawTodos = extractTodoArray(part.state.output) ?? extractTodoArrayFromCode(part.state.input?.code);
				if (rawTodos !== null) {
					const items = parseTodoItems({ todos: rawTodos });
					return items.length === 0 ? null : items;
				}
			}
		}
	}
	return null;
}
/** Stable group order (in_progress → pending → completed → cancelled); within a
*  group the transcript order is preserved. Pure. */
function orderTodoItems(items) {
	return [...items].sort((a, b) => TODO_STATUS_ORDER.indexOf(a.status) - TODO_STATUS_ORDER.indexOf(b.status));
}
/** Row color channel: `accent` for live work, `muted` for closed items, base
*  for pending. Kept separate from the theme so it is testable. Pure. */
/** Tone for one status — no rainbow, a single accent. Pure. */
function todoTone(status) {
	if (status === "in_progress") return "accent";
	if (status === "completed" || status === "cancelled") return "muted";
	return "base";
}
/** Exact rendered text of one row: `[•] <content truncated to 28>`. Pure. */
function todoRowText(item) {
	return `${TODO_MARKERS[item.status]} ${truncateLabel(item.content, 28)}`;
}
/** Ordered rows capped for the sidebar, plus how many did not fit. Pure. */
/** Order then cap the list at `maxVisible`. Pure. */
function ceilingTodoItems(items, maxVisible = 6) {
	const ordered = orderTodoItems(items);
	const visible = ordered.slice(0, Math.max(0, maxVisible));
	return {
		visible,
		hidden: Math.max(0, ordered.length - visible.length)
	};
}
/** Overflow line (`… +3`); null when every item fits. Pure. */
function hiddenTodoText(hidden) {
	if (!Number.isFinite(hidden) || hidden <= 0) return null;
	return `… +${Math.round(hidden)}`;
}
/** Narrow a `VcsFileStatus["status"]` value read off a loose payload. */
function isGitChangeStatus(value) {
	return value === "added" || value === "modified" || value === "deleted";
}
/** Files per status from a `VcsFileStatus[]` payload. Unknown statuses and
*  malformed entries are ignored. Pure. */
function countGitChanges(files) {
	const counts = {
		added: 0,
		modified: 0,
		deleted: 0
	};
	if (!Array.isArray(files)) return counts;
	for (const entry of files) {
		const status = entry?.status;
		if (isGitChangeStatus(status)) counts[status] += 1;
	}
	return counts;
}
/** `+1 ±2 −3` for the file counts; each zero term is omitted, and an empty
*  change set returns null so the row is not rendered at all. Pure. */
function formatGitChanges(files) {
	const { added, modified, deleted } = countGitChanges(files);
	const parts = [];
	if (added > 0) parts.push(`+${added}`);
	if (modified > 0) parts.push(`±${modified}`);
	if (deleted > 0) parts.push(`\u2212${deleted}`);
	return parts.length === 0 ? null : parts.join(" ");
}
/** Wall-clock ceiling for one git call. A stuck git (index lock, network
*  filesystem) is killed instead of holding the row forever. */
const GIT_CLI_TIMEOUT_MS = 2e3;
/** Session events arrive in bursts; a git probe is scheduled at most once per
*  window instead of once per event. */
const GIT_CLI_DEBOUNCE_MS = 1e3;
/** Minimum spacing between two probe starts. Five seconds keeps a chatty event
*  stream from spawning a git process per step while staying fresh enough to
*  show a file appearing mid-turn. */
const GIT_CLI_MIN_INTERVAL_MS = 5e3;
/** Stdout ceiling for one git call. `status --porcelain=v1 -uall` lists every
*  untracked file, so a large worktree easily passes the 1 MB `execFile`
*  default — which would reject and silently hand the row back to the
*  `vcs.status` fallback. 4 MB is far above a realistic porcelain listing. */
const GIT_CLI_MAX_BUFFER = 4194304;
/** One `execFile` call: `(file, args, options) → { stdout }`. Injectable so the
*  parsing/gating logic is testable without spawning processes. */
/** Default runner: the promisified `node:child_process.execFile`. A non-zero
*  exit (no repository, no upstream) rejects and the caller decides. */
const defaultGitExec = (file, args, options) => new Promise((resolve, reject) => {
	execFile(file, [...args], {
		cwd: options.cwd,
		timeout: options.timeout,
		windowsHide: options.windowsHide,
		maxBuffer: options.maxBuffer
	}, (error, stdout) => {
		if (error) reject(error);
		else resolve({ stdout: typeof stdout === "string" ? stdout : String(stdout ?? "") });
	});
});
/** Files per status from `git status --porcelain=v1 -uall`, including the two
*  columns the protocol cannot report. Each line starts with `XY` (index and
*  worktree state); a rename prints `R  old -> new`, and `??` / `!!` are
*  untracked / ignored. Precedence per file: deleted > added > modified, so
*  `AM` counts once as added and `AD` once as deleted. Renames, copies and
*  unmerged entries count as modified. Pure. */
/** Parse porcelain v1 output into file counts. Empty/malformed output yields
*  zero counts (a clean tree), never a throw. Pure. */
function parseGitStatusPorcelain(output) {
	const counts = {
		added: 0,
		modified: 0,
		deleted: 0,
		untracked: 0
	};
	if (typeof output !== "string" || output === "") return counts;
	for (const line of output.split("\n")) {
		if (line.length < 2) continue;
		const index = line[0];
		const worktree = line[1];
		if (index === "!" && worktree === "!") continue;
		if (index === "?" && worktree === "?") {
			counts.untracked += 1;
			continue;
		}
		if (index === " " && worktree === " ") continue;
		if (index === "D" || worktree === "D") counts.deleted += 1;
		else if (index === "A" || worktree === "A") counts.added += 1;
		else counts.modified += 1;
	}
	return counts;
}
/** `git rev-list --count --left-right @{upstream}...HEAD` prints two numbers:
*  commits only on the upstream (behind) then commits only on HEAD (ahead).
*  Null when the output is not that pair — e.g. the command failed because the
*  branch has no upstream, in which case the arrows are simply omitted. Pure. */
function parseGitAheadBehind(output) {
	if (typeof output !== "string") return null;
	const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(output);
	if (match === null) return null;
	const behind = Number(match[1]);
	const ahead = Number(match[2]);
	if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
	return {
		ahead,
		behind
	};
}
/** One git observation: file counts plus the upstream distance (either arrow
*  may be unknown when the branch has no upstream). */
/** One probe: `git status --porcelain=v1 -uall` for the counts, then
*  `git rev-list --count --left-right @{upstream}...HEAD` for the arrows (a
*  failure there only drops the arrows). A status failure rejects — the caller
*  then falls back to `client.vcs.status`. */
async function readGitSnapshot(directory, exec = defaultGitExec) {
	const options = {
		cwd: directory,
		timeout: GIT_CLI_TIMEOUT_MS,
		windowsHide: true,
		maxBuffer: GIT_CLI_MAX_BUFFER
	};
	const changes = parseGitStatusPorcelain((await exec("git", [
		"status",
		"--porcelain=v1",
		"-uall"
	], options))?.stdout);
	let ahead = null;
	let behind = null;
	try {
		const parsed = parseGitAheadBehind((await exec("git", [
			"rev-list",
			"--count",
			"--left-right",
			"@{upstream}...HEAD"
		], options))?.stdout);
		if (parsed !== null) {
			ahead = parsed.ahead;
			behind = parsed.behind;
		}
	} catch {}
	return {
		changes,
		ahead,
		behind
	};
}
/** Rendered git row: `+1 ±2 −1 ?2 ↑3 ↓1`, zero terms omitted. Null when the
*  tree is clean and in sync, so the block keeps only its branch line. Pure. */
function formatGitSnapshot(snapshot) {
	if (!snapshot?.changes) return null;
	const { added, modified, deleted, untracked } = snapshot.changes;
	const parts = [];
	if (added > 0) parts.push(`+${added}`);
	if (modified > 0) parts.push(`±${modified}`);
	if (deleted > 0) parts.push(`\u2212${deleted}`);
	if (untracked > 0) parts.push(`?${untracked}`);
	if ((snapshot.ahead ?? 0) > 0) parts.push(`↑${snapshot.ahead}`);
	if ((snapshot.behind ?? 0) > 0) parts.push(`↓${snapshot.behind}`);
	return parts.length === 0 ? null : parts.join(" ");
}
/** Whether a new probe may start. An in-flight probe always wins (no queue), and
*  the previous start must be older than the cooldown. Pure. */
function gitProbeAllowed(state, cooldownMs = GIT_CLI_MIN_INTERVAL_MS) {
	if (state.inFlight) return false;
	if (state.lastRunAt === null) return true;
	const elapsed = state.now - state.lastRunAt;
	return !Number.isFinite(elapsed) || elapsed >= cooldownMs;
}
/** Spend window labels, in render order. */
const SPEND_TODAY_LABEL = "hoje";
const SPEND_30D_LABEL = "30d";
/** Separator between the two windows on the Context footer line. */
const SPEND_LINE_SEPARATOR = " · ";
/** `30d` window: 30 × 24 h, measured back from "now". */
const SPEND_30D_MS = 2592e6;
/** Probe window: one hour, narrow enough that a unit mix-up cannot line up. */
const SPEND_PROBE_WINDOW_MS = 36e5;
/** The echoed `range` may be rounded server-side; 120 s absorbs that. */
const SPEND_PROBE_TOLERANCE_MS = 12e4;
/** Session events arrive in bursts — same 400 ms window as the other blocks. */
const SPEND_REFRESH_DEBOUNCE_MS = 400;
/** Spend per window in USD. Either side may be unknown (kept `null`). */
/** `from`/`to` unit accepted by the route. `SessionStatsInput` declares both as
*  bare `number` and does not say which unit, so it is measured once per
*  process (`ms` unless the server echoes seconds) instead of guessed. */
/** Resolved unit for this process; `null` until the mount probe answers. */
let spendUnit = null;
/** In-flight probe, so two refreshes cannot each burn the 2-call budget. */
let spendProbe = null;
/** Test-only: forget the process-wide unit resolution. Never called at runtime. */
function resetSpendUnit() {
	spendUnit = null;
	spendProbe = null;
}
/** Resolved unit (`ms` / `s` / `unavailable`) or null while still unknown. */
function resolvedSpendUnit() {
	return spendUnit;
}
/** Local midnight for `now`: `new Date()` with the clock fields zeroed in the
*  current timezone (DST-safe, unlike subtracting hours). Pure. */
function startOfLocalDay(now) {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}
/** The two windows the block shows: `hoje` (local midnight → now) and `30d`
*  (now − 30 days → now). Pure. */
function spendWindows(now) {
	return {
		today: {
			from: startOfLocalDay(now),
			to: now
		},
		thirtyDays: {
			from: now - SPEND_30D_MS,
			to: now
		}
	};
}
/** USD with two decimals (`$0.42`), four for a positive sub-cent amount
*  (`$0.0031`), and `<$0.0001` when even four decimals would read `$0.0000`.
*  `0` prints `$0.00`. Null for a missing/negative/non-finite value. Pure. */
function formatSpendUSD(cost) {
	const value = numberOrNull(cost);
	if (value === null || value < 0) return null;
	if (value === 0) return "$0.00";
	if (value >= .01) return `$${value.toFixed(2)}`;
	const cents = value.toFixed(2);
	if (cents !== "0.00") return `$${cents}`;
	const cents4 = value.toFixed(4);
	return cents4 === "0.0000" ? "<$0.0001" : `$${cents4}`;
}
/** `cost` off a `SessionStatsInfo` (`MoneyUSD` = number) or null when the
*  payload is malformed/negative, so a bad value never reaches a row. Pure. */
function statsCost(result) {
	const cost = numberOrNull(result?.cost);
	return cost !== null && cost >= 0 ? cost : null;
}
/** True when the server echoed the window we sent, within 120 s. `scale` is how
*  many milliseconds one unit of the sent window is worth (`1` for `ms`, `1000`
*  for `s`). The echo is accepted either as the same numbers we sent (the route
*  keeps the caller's unit) or converted to millisecond epoch (`DateTime.Utc`),
*  so the probe pins the unit without assuming which of the two it gets. Pure. */
function statsRangeMatches(range, sent, scale) {
	const from = numberOrNull(range?.from);
	const to = numberOrNull(range?.to);
	if (from === null || to === null) return false;
	const tolerance = SPEND_PROBE_TOLERANCE_MS / scale;
	const sameUnit = Math.abs(from - sent.from) <= tolerance && Math.abs(to - sent.to) <= tolerance;
	const asMilliseconds = Math.abs(from - sent.from * scale) <= 12e4 && Math.abs(to - sent.to * scale) <= 12e4;
	return sameUnit || asMilliseconds;
}
/** The `Context` block's last line: OpenCode stats source and both spend windows
*  on one muted row (`OpenCode · hoje $0.42 · 30d $9.80`). A window without a
*  usable amount is omitted, and no usable window at all yields null so the
*  line (and not the block) is dropped. Pure. */
function contextSpendLine(totals) {
	if (totals === null) return null;
	const parts = [];
	const today = formatSpendUSD(totals.today);
	if (today !== null) parts.push(`${SPEND_TODAY_LABEL} ${today}`);
	const thirtyDays = formatSpendUSD(totals.thirtyDays);
	if (thirtyDays !== null) parts.push(`30d ${thirtyDays}`);
	return parts.length === 0 ? null : `OpenCode${SPEND_LINE_SEPARATOR}${parts.join(SPEND_LINE_SEPARATOR)}`;
}
/** Grapheme iterator: a cut never splits a surrogate pair, a combining mark
*  from its base or a ZWJ emoji sequence, so truncation stays cell-exact. */
/** Clamp a free-form label to `max` terminal cells without wrapping. The width
*  is measured in display cells, never in UTF-16 code units: a CJK or emoji
*  label used to overflow the column it was cut for (`計画の移行` is 5 code
*  units but 10 cells, `🚀` is 2 units and 2 cells). Pure. */
function truncateLabel(value, max = 28) {
	const text = value.trim();
	const budget = Math.max(1, Math.floor(numberOrNull(max) ?? 1));
	if (cellWidth(text) <= budget) return text;
	const ellipsis = "…";
	const room = budget - cellWidth(ellipsis);
	let cut = "";
	let used = 0;
	for (const { segment } of GRAPHEMES.segment(text)) {
		const width = cellWidth(segment);
		if (used + width > room) break;
		cut += segment;
		used += width;
	}
	return `${cut.replace(/\s+$/, "")}${ellipsis}`;
}
/** Right-pad `value` with spaces to exactly `cells` display columns (a wider
*  value is truncated first). `padEnd` counts code units, so it under-pads a
*  CJK/emoji cell and the next column drifts. Pure. */
function padCell(value, cells) {
	const width = Math.max(0, Math.floor(numberOrNull(cells) ?? 0));
	if (width === 0) return "";
	const text = truncateLabel(value, width);
	return `${text}${" ".repeat(Math.max(0, width - cellWidth(text)))}`;
}
/** Columns the fixed header may use before it would wrap the sidebar. */
const HEADER_MAX_WIDTH = 34;
/** Preset row of the fixed header: `▸ <preset> · <provider>`. The provider is
*  cut first when the row overflows, so the preset name is never the casualty;
*  a missing provider leaves the preset alone (no `unknown` placeholder). */
function presetHeaderLine(presetName, providerID) {
	const base = `▸ ${presetName.trim() === "" ? "default" : presetName.trim()}`;
	const provider = providerID === null ? "" : providerID.trim();
	if (provider === "") return truncateLabel(base, HEADER_MAX_WIDTH);
	const room = HEADER_MAX_WIDTH - `${base} · `.length;
	if (room < 2) return truncateLabel(base, HEADER_MAX_WIDTH);
	return `${base} · ${truncateLabel(provider, room)}`;
}
/** One classification plus the evidence that produced it. */
/** Bracketed description prefix → short label (`[council]` → `coun`). */
const DISPATCH_PREFIX_KINDS = [
	["council", "coun"],
	["discovery", "disc"],
	["ephemeral", "eph"],
	["hotfix", "eph"],
	["plan", "plan"],
	["review", "revw"],
	["swarm", "swm"]
];
/** Agent → kind, consulted only when the description declares no prefix.
*  `council` is deliberately absent — see the section comment. */
const DISPATCH_AGENT_KINDS = {
	apollo: "disc",
	athena: "plan",
	themis: "revw"
};
/** Kind declared by a leading `[prefix]` on the description: case-insensitive
*  and tolerant of spaces inside the brackets. Null when none is declared. */
function dispatchKindFromPrefix(description) {
	if (typeof description !== "string") return null;
	const match = /^\s*\[\s*([a-z]+)\s*\]/i.exec(description);
	if (match === null) return null;
	const token = (match[1] ?? "").toLowerCase();
	for (const [word, kind] of DISPATCH_PREFIX_KINDS) if (word === token) return kind;
	return null;
}
/** Kind implied by the child's agent, null for an agent that implies none. */
function dispatchKindFromAgent(agent) {
	if (typeof agent !== "string") return null;
	return DISPATCH_AGENT_KINDS[agent.trim().toLowerCase()] ?? null;
}
/** Classify one dispatch. The description prefix always wins over the agent;
*  otherwise the agent decides, and anything else is `oth` (a real dispatch we
*  simply cannot name). A missing call is the only `unavailable` outcome. Pure. */
function classifyDispatchKind(call) {
	if (call === null || call === void 0) return {
		kind: null,
		origin: "unavailable"
	};
	const fromPrefix = dispatchKindFromPrefix(call.description);
	if (fromPrefix !== null) return {
		kind: fromPrefix,
		origin: "prefix"
	};
	return {
		kind: dispatchKindFromAgent(call.agent) ?? "oth",
		origin: "agent"
	};
}
/** A `subagent` tool call the parent made, as its own transcript records it. */
/** Host tool that spawns a child (V2 name; it is not `task`). */
const SUBAGENT_TOOL = "subagent";
/** The tool result also names its child: `<subagent sessionID="ses_…" …>`. */
const SUBAGENT_SESSION_PATTERN = /sessionID="([^"]+)"/;
/** Text of a tool `content` payload, joined; tolerant of the string form. */
function toolContentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const chunks = [];
	for (const part of content) {
		const text = part?.text;
		if (typeof text === "string") chunks.push(text);
	}
	return chunks.join("\n");
}
/** Child session id of one `subagent` call: the exact `metadata.sessionID`
*  first, then an `output`/`result` id, then the `<subagent sessionID="…">` tag
*  in the result text. Null when the call has not produced a child yet. */
function subagentSessionID(state) {
	const direct = [
		state?.metadata?.sessionID,
		state?.output?.sessionID,
		state?.result?.sessionID
	];
	for (const candidate of direct) if (typeof candidate === "string" && candidate !== "") return candidate;
	return SUBAGENT_SESSION_PATTERN.exec(toolContentText(state?.content))?.[1] ?? null;
}
/** Correlate the parent transcript's `subagent` calls with the children they
*  spawned: child session id → `{ agent, description, background }`. One pass
*  over the list the sidebar already holds — no request, no `message.sync` on
*  the child. `streaming`/`pending` states carry their input as *partial JSON
*  text*, so they are skipped rather than parsed. Fail-open: a malformed part
*  contributes nothing. Pure. */
function collectSubagentCalls(messages) {
	const calls = /* @__PURE__ */ new Map();
	if (!Array.isArray(messages)) return calls;
	for (const message of messages) {
		if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part?.type !== "tool" || part?.name !== SUBAGENT_TOOL) continue;
			const state = part.state;
			if (state === null || typeof state !== "object") continue;
			if (state.status === "streaming" || state.status === "pending") continue;
			const sessionID = subagentSessionID(state);
			if (!isValidSessionID(sessionID)) continue;
			const input = state.input !== null && typeof state.input === "object" ? state.input : {};
			const agent = typeof input.agent === "string" ? input.agent : "";
			const description = typeof input.description === "string" ? input.description : "";
			calls.set(sessionID, {
				sessionID,
				agent,
				description,
				background: input.background === true
			});
		}
	}
	return calls;
}
/** Atividade em tempo real extraída das mensagens em cache de um subagente. */
function fileBasename(raw) {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const parts = trimmed.replaceAll("\\", "/").split("/").filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] ?? null : null;
}
/** Extrai atividade ao vivo, alertas de bloqueio e histórico recente de um filho
*  a partir de suas mensagens em cache. Pure, fail-open. */
function extractChildActivity(messages, status, hostAttention) {
	let activeTool = null;
	let activeVerb = null;
	let latestTool = null;
	let latestVerb = null;
	let attention = hostAttention?.permission ? "permission" : hostAttention?.question ? "question" : status === "error" || status === "failed" ? "error" : null;
	const recentTools = [];
	const filesTouched = [];
	let lastSnippet = null;
	if (Array.isArray(messages)) for (const message of messages) {
		if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part?.type === "text" && typeof part.text === "string") {
				const clean = part.text.replace(/\s+/g, " ").trim();
				if (clean !== "") lastSnippet = clean;
				continue;
			}
			if (part?.type !== "tool") continue;
			const effectiveNames = resolveEffectiveToolNames(part);
			if (effectiveNames.length === 0) continue;
			const name = effectiveNames[effectiveNames.length - 1] ?? "";
			const state = part.state;
			const { verb } = classifyToolPart(name);
			latestTool = name;
			latestVerb = verb;
			for (const toolName of effectiveNames) {
				const existingIdx = recentTools.indexOf(toolName);
				if (existingIdx !== -1) recentTools.splice(existingIdx, 1);
				recentTools.unshift(toolName);
				if (recentTools.length > 4) recentTools.pop();
			}
			for (const base of extractToolFilePaths(part)) if (!filesTouched.includes(base)) {
				filesTouched.unshift(base);
				if (filesTouched.length > 3) filesTouched.pop();
			}
			if (isToolActiveState(state)) {
				activeTool = name;
				activeVerb = verb;
				if (name.toLowerCase() === "question") attention = "question";
			} else if (attention === null && isToolFailureState(state) && (status === "error" || status === "failed" || status === "retry")) attention = "error";
		}
	}
	if (attention === "question" || attention === "permission") activeVerb = "ask";
	else if (attention === "error") activeVerb = "err";
	else if (activeVerb === null && (status === "running" || status === "busy")) {
		activeVerb = latestVerb;
		activeTool = latestTool;
	}
	if (activeVerb === null && activeTool === null && attention === null && recentTools.length === 0 && filesTouched.length === 0 && lastSnippet === null) return null;
	return {
		activeVerb,
		activeTool,
		attention,
		recentTools,
		filesTouched,
		lastSnippet
	};
}
/** Grace window for a child that has not started yet. V2's `session.status()`
*  returns `idle` both for "created but not started" and for "finished", so an
*  idle/unknown/absent child whose own last activity (`time.updated`, falling
*  back to `time.created`) is this recent still reads as running — otherwise a
*  just-spawned child renders a premature ✓. Trade-off (V1 parity: it had the
*  same window for its absent statuses): a child that finished within the window
*  and reports no `outcome` reads as running until the window closes, at which
*  point it turns terminal and its completion toast fires. A child that reports
*  a terminal `outcome` is never held back by the window. */
const DELEGATION_CHILD_STATUS_GRACE_MS = 6e4;
/** One delegated child job as the sidebar renders it. */
/** Map the host's live session status to a display state. V2 exposes only
*  `"idle" | "running"` through the TUI context (the client union adds `retry`
*  and `busy`); `error`/`failed` are handled defensively for host drift.
*  `idle`, `retry` and unknown/absent statuses are terminal only once the
*  child's own activity is older than the grace window — within it the child
*  reads as running (see `DELEGATION_CHILD_STATUS_GRACE_MS`). An interruption is
*  not part of this union: it arrives as a terminal `outcome`. Pure. */
function delegationStateFromStatus(status, time, now = Date.now(), graceMs = DELEGATION_CHILD_STATUS_GRACE_MS) {
	switch (status) {
		case "running":
		case "busy": return "running";
		case "error":
		case "failed": return "failed";
		default: {
			const lastActivity = Math.max(time?.updated ?? 0, time?.created ?? 0);
			if (lastActivity > 0 && now - lastActivity < graceMs) return "running";
			return "completed";
		}
	}
}
/** Map a V2 child `outcome` to a display state. `interrupted` (user abort,
*  shutdown, superseded, inactivity) is distinct from both success and failure,
*  so an aborted child never renders the ✓ of a completed one. Returns null for
*  an absent/unrecognised outcome so the live status decides. Pure. */
function delegationStateFromOutcome(outcome) {
	switch (outcome) {
		case "succeeded": return "completed";
		case "failed": return "failed";
		case "interrupted": return "interrupted";
		default: return null;
	}
}
/** Build a delegation row from a child session + its live status, plus the
*  `subagent` call that spawned it (when the parent transcript had one). A
*  terminal `outcome` wins when present (the only V2 primitive that surfaces a
*  delegation failure/interruption once the status is back to idle); otherwise
*  the live status decides, with the absent/idle grace window applied. The
*  `call` only ever *adds* the purpose and the background flag — an absent one
*  leaves the row fully renderable. Pure. */
function toDelegationView(child, status, now = Date.now(), call) {
	const id = typeof child?.id === "string" ? child.id : "";
	const title = typeof child?.title === "string" && child.title !== "" ? child.title : "";
	const agent = typeof child?.agent === "string" && child.agent !== "" ? child.agent : "";
	const label = title !== "" ? title : agent !== "" ? agent : id.slice(0, 8);
	const state = delegationStateFromOutcome(child?.outcome) ?? delegationStateFromStatus(status, child?.time, now);
	const classification = classifyDispatchKind(call);
	return {
		id,
		label,
		state,
		startedAt: numberOrNull(child?.time?.created),
		updatedAt: numberOrNull(child?.time?.updated),
		agent: agent !== "" ? agent : null,
		model: shortModelID(child?.model),
		cost: numberOrNull(child?.cost),
		kind: classification.kind,
		kindOrigin: classification.origin,
		background: call?.background === true
	};
}
const SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏"
];
/** Spinner glyph for a frame counter (incremented every ~80ms while any job is
*  running). Pure. */
function spinnerFrame(frame) {
	const index = Math.abs(Math.floor(frame)) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}
/** Shared order: live work first, then most recent activity. One comparator for
*  every consumer of the dispatch tree (sidebar block and panel list), so the
*  two views can never disagree about which child comes first. Pure. */
function compareDelegations(a, b) {
	const activeA = a.state === "running" ? 1 : 0;
	const activeB = b.state === "running" ? 1 : 0;
	if (activeA !== activeB) return activeB - activeA;
	return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}
/** Token totals published on `SessionInfo.tokens`, one entry per counter. */
/** One child of the dispatch tree: the delegation row plus the fields only the
*  panel's detail view needs (`SessionInfo.title`/`parentID`/`tokens` and the
*  spawning call's description). */
/** Optional inputs of `collectDispatch`: a fixed clock (tests/render ticks) and
*  an already-computed `agent` map, so a caller that walked the parent
*  transcript anyway never pays for a second walk. */
/** `message.list` of one session, degrades to an empty list. The host's list is
*  a cached directory read, not a request. */
function readSessionMessages(context, sessionID) {
	try {
		const result = context?.data?.session?.message?.list?.(sessionID);
		return Array.isArray(result) ? result : [];
	} catch {
		return [];
	}
}
/** Token counters of a child, null when the host published none of them. Pure. */
function dispatchTokens(tokens) {
	if (tokens === null || typeof tokens !== "object") return null;
	const source = tokens;
	const cache = source.cache !== null && typeof source.cache === "object" ? source.cache : {};
	const totals = {
		input: numberOrNull(source.input),
		output: numberOrNull(source.output),
		reasoning: numberOrNull(source.reasoning),
		cacheRead: numberOrNull(cache.read),
		cacheWrite: numberOrNull(cache.write)
	};
	return [
		totals.input,
		totals.output,
		totals.reasoning,
		totals.cacheRead,
		totals.cacheWrite
	].every((value) => value === null) ? null : totals;
}
/** One child `SessionInfo` + its live status → `DispatchEntry`. The call only
*  ever adds the kind and the description; an absent one leaves the entry fully
*  renderable. Pure. */
function toDispatchEntry(child, status, now = Date.now(), call, activity) {
	const title = typeof child?.title === "string" && child.title !== "" ? child.title : null;
	const parentID = typeof child?.parentID === "string" && child.parentID !== "" ? child.parentID : null;
	const description = typeof call?.description === "string" && call.description !== "" ? call.description : null;
	const baseView = toDelegationView(child, status, now, call);
	return {
		view: activity ? {
			...baseView,
			activity
		} : baseView,
		title,
		description,
		parentID,
		tokens: dispatchTokens(child?.tokens)
	};
}
/** The delegation tree of `sessionID` — every child `session.family` returns,
*  root excluded, each enriched from `session.get`/`session.status` and the
*  parent's `subagent` calls. Empty when the family API is unavailable or the
*  session id is not a real handle (never falls back to the root). Ordered by
*  the shared `compareDelegations`, so callers render the same list in the same
*  order. A family that repeats an id yields one row per child: the id is
*  deduplicated before the walk, so a duplicate can never double a row or its
*  cost. */
function collectDispatch(context, sessionID, options = {}) {
	if (!isValidSessionID(sessionID)) return [];
	let family = [];
	try {
		const result = context?.data?.session?.family?.(sessionID);
		if (Array.isArray(result)) family = result;
	} catch {
		return [];
	}
	const now = numberOrNull(options.now) ?? Date.now();
	const calls = options.calls ?? collectSubagentCalls(readSessionMessages(context, sessionID));
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const childID of family) {
		if (childID === sessionID || !isValidSessionID(childID)) continue;
		if (seen.has(childID)) continue;
		seen.add(childID);
		let child;
		try {
			child = context.data.session.get(childID);
		} catch {
			continue;
		}
		if (!child) continue;
		const status = sessionStatusOf(context, childID);
		let hasPerm = false;
		let hasQuest = false;
		try {
			const perms = context?.data?.session?.permission?.(childID);
			if (Array.isArray(perms) && perms.length > 0) hasPerm = true;
		} catch {}
		try {
			const quests = context?.data?.session?.question?.(childID);
			if (Array.isArray(quests) && quests.length > 0) hasQuest = true;
		} catch {}
		let activity = options.activities?.get(childID) ?? null;
		if (activity === null && options.includeChildActivity === true) activity = extractChildActivity(readSessionMessages(context, childID), status, {
			permission: hasPerm,
			question: hasQuest
		});
		else if (hasPerm || hasQuest) activity = extractChildActivity(void 0, status, {
			permission: hasPerm,
			question: hasQuest
		}) ?? activity;
		entries.push(toDispatchEntry(child, status, now, calls.get(childID) ?? null, activity));
	}
	return entries.sort((a, b) => compareDelegations(a.view, b.view));
}
/** Enrich pre-collected dispatch entries with live child activity from cached
*  child transcripts (used by the full-width dispatch panel). */
function enrichDispatchEntries(context, entries) {
	return entries.map((entry) => {
		if (entry.view.activity) return entry;
		const activity = extractChildActivity(readSessionMessages(context, entry.view.id), sessionStatusOf(context, entry.view.id));
		return activity ? {
			...entry,
			view: {
				...entry.view,
				activity
			}
		} : entry;
	});
}
/** Sidebar blocks in render order. Spacing is derived from this list instead of
*  from the view, so a hidden block can never leave an empty gap behind.
*  Note: The custom Todo block was removed from the sidebar composition because
*  OpenCode 2.x natively renders the Todo panel when `todowrite` is used. */
/** One rendered block: its key, and whether a blank line precedes it. */
/** Header glyph per block — one codepoint each, rendered muted before the bold
*  label. The fixed header (version/preset/session) takes none.
*  Measured as one terminal cell by the host (`@opentui/core` counts
*  `emoji-regex` matches as two): ▤ U+25A4 (EAW=A), ◆ U+25C6 (A),
*  ◈ U+25C8 (A). `⌁` U+2301 (the old Dispatch glyph) was replaced by the host's
*  own Notice glyph. */
const BLOCK_ICONS = {
	context: "▤",
	git: "◆",
	dispatch: "◈"
};
/** Tag every block that has content with its spacer: never before the first
*  (the view puts a single blank line after the fixed header instead), one
*  blank line before every later block. A repeated key collapses instead of
*  stacking spacers, so an absent optional block can never leave a double gap.
*  Pure. */
function withBlockSpacers(keys) {
	const seen = /* @__PURE__ */ new Set();
	const blocks = [];
	for (const key of keys) {
		if (seen.has(key)) continue;
		seen.add(key);
		blocks.push({
			key,
			spacer: blocks.length > 0
		});
	}
	return blocks;
}
/** Live children rendered one row each; the rest collapse into `… +N rodando`. */
const DISPATCH_RUNNING_CEILING = 3;
/** Agent rollup rows rendered before the `… +K  $<soma>` line. */
const DISPATCH_AGENT_CEILING = 3;
/** Hard cap on the block's rendered rows, header included. The sidebar is
*  short; live work is served first, then the finished rollup. */
const DISPATCH_MAX_LINES = 8;
/** Marker of the aggregated "finished" section. */
const DISPATCH_DONE_MARKER = "✓";
/** Column width of the agent (or of its title/id fallback). */
const DISPATCH_AGENT_WIDTH = 12;
/** Narrowest agent column a row may fall back to before the cost is kept whole
*  and the label truncates further. */
const DISPATCH_MIN_AGENT_WIDTH = 8;
/** Column width of the short model id — the model is dropped before the agent
*  or the cost so a row always fits. */
const DISPATCH_MODEL_WIDTH = 7;
/** Column width of the per-dispatch cost (`$0.04`; a sub-cent cost widens it). */
const DISPATCH_COST_WIDTH = 5;
/** Column width of the duration (`12.7s` / `1m04s` / `820ms`). */
const DISPATCH_DURATION_WIDTH = 5;
/** Column width of the `×<count>` cell of an agent rollup row. */
const DISPATCH_COUNT_WIDTH = 3;
/** Column width of an agent rollup cost (`$0.0051` still fits). */
const DISPATCH_GROUP_COST_WIDTH = 7;
/** Hard column budget for one row — a Dispatch line never wraps:
*  marker(2) + agent(12) + model(7) + cost(5) + duration(5) + 3 spaces = 34.
*  The kind suffix (`·disc`, `·disc~`) is wider evidence than the model, so a
*  classified row spends the model's columns first: marker(2) + agent(≤12) +
*  suffix(≤6) + cost(5) + duration(5) + 2 spaces ≤ 32, still inside 34. */
const DISPATCH_MAX_WIDTH = 34;
/** Middle dot used between a label and its kind (`apollo·disc`). */
const DISPATCH_KIND_SEPARATOR = "·";
/** Background marker: the parent asked the child to run in the background. */
const DISPATCH_BACKGROUND_MARKER = "~";
/** Kind suffix glued to a row's label: `·disc`, `·disc~` for a background run,
*  and empty when the child could not be classified (the row then reads exactly
*  as before). Pure. */
function dispatchKindSuffix(kind, background) {
	if (kind === null || kind === void 0) return "";
	const text = `${DISPATCH_KIND_SEPARATOR}${kind}`;
	return background === true ? `${text}${DISPATCH_BACKGROUND_MARKER}` : text;
}
/** Header summary: `2 rodando · $3.49`. The live count is omitted when nothing
*  runs, and the total spend is always printed (the header only renders while
*  the tree has children, so `$0.00` is a real answer). Pure. */
function dispatchHeaderSummary(running, cost) {
	const parts = [];
	const live = numberOrNull(running) ?? 0;
	if (live > 0) parts.push(`${Math.round(live)} rodando`);
	const formatted = formatSpendUSD(numberOrNull(cost) ?? 0);
	if (formatted !== null) parts.push(formatted);
	return parts.length === 0 ? null : parts.join(SPEND_LINE_SEPARATOR);
}
/** Compact duration without an internal space: `820` → `820ms`, `12_400` →
*  `12.4s`, `64_000` → `1m04s`, `3_780_000` → `1h03m`, `172_800_000` → `2d`.
*  An absent or negative value renders an em dash, never `NaN`s. Pure. */
function formatDispatchDuration(ms) {
	const value = numberOrNull(ms);
	if (value === null || value < 0) return "—";
	if (value < 1e3) return `${Math.round(value)}ms`;
	const seconds = value / 1e3;
	if (seconds < 59.95) return `${seconds.toFixed(1)}s`;
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	if (hours >= 24) return `${Math.floor(hours / 24)}d`;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
}
/** Elapsed label for one row: a live child measures `now - created`, a finished
*  one freezes at `updated - created` (em dash when a timestamp is missing).
*  Pure. */
function dispatchElapsed(view, now = Date.now()) {
	if (view.startedAt === null) return "—";
	if (view.state === "running") return formatDispatchDuration(now - view.startedAt);
	if (view.updatedAt === null) return "—";
	return formatDispatchDuration(view.updatedAt - view.startedAt);
}
/** Name column: the agent when the host published one, else the child title,
*  else the short id — never `undefined`. Truncated to the column width. Pure. */
function dispatchAgentText(view, max = 12) {
	const agent = typeof view.agent === "string" ? view.agent.trim() : "";
	const label = typeof view.label === "string" ? view.label.trim() : "";
	const id = typeof view.id === "string" ? view.id.trim() : "";
	const name = agent !== "" ? agent : label !== "" ? label : id;
	return name === "" ? "—" : truncateLabel(name, max);
}
/** Model column, empty when the host published none. Pure. */
function dispatchModelText(view) {
	const model = typeof view.model === "string" ? view.model.trim() : "";
	return model === "" ? "" : truncateLabel(model, 7);
}
/** Cost column: the child's real `SessionInfo.cost` with two decimals (up to
*  four below a cent, so `$0.0031` never collapses to `$0.00`), `$0.00` for a
*  zero cost, and an em dash when the host published no numeric cost. Pure. */
function formatDispatchCost(cost) {
	return formatUsageCost(cost) ?? "—";
}
/** Total spend of every child (live + finished), `0` when none published a
*  numeric cost. Pure. */
function dispatchTotalCost(views) {
	let total = 0;
	for (const view of views ?? []) {
		const cost = numberOrNull(view?.cost);
		if (cost !== null && cost >= 0) total += cost;
	}
	return total;
}
function effectiveChildPresentation(view, frame = 0) {
	const act = view.activity;
	const attention = act?.attention ?? null;
	const tone = attention === "error" ? "error" : attention === "question" || attention === "permission" ? "warning" : "success";
	const marker = attention === "error" ? "! " : attention === "question" || attention === "permission" ? "? " : `${spinnerFrame(frame)} `;
	let suffix = dispatchKindSuffix(view.kind, view.background);
	if (attention === "question" || attention === "permission") suffix = `${DISPATCH_KIND_SEPARATOR}ask${view.background === true ? DISPATCH_BACKGROUND_MARKER : ""}`;
	else if (attention === "error") suffix = `${DISPATCH_KIND_SEPARATOR}err${view.background === true ? DISPATCH_BACKGROUND_MARKER : ""}`;
	else if ((view.kind === null || view.kind === "oth") && act?.activeVerb) suffix = `${DISPATCH_KIND_SEPARATOR}${act.activeVerb}${view.background === true ? DISPATCH_BACKGROUND_MARKER : ""}`;
	return {
		marker,
		suffix,
		tone
	};
}
/** One live child: `⠸ <agent 12>·<kind> <custo> <duração>`, with the model as a
*  fourth column only when the row still fits and the child is unclassified —
*  the kind is the stronger evidence at this width, so it takes the model's
*  columns. The kind rides glued to the label (never a column of its own) and
*  disappears with the label's truncation; then the agent column shrinks (never
*  below `DISPATCH_MIN_AGENT_WIDTH`); the cost is always present — `$0.00` for a
*  zero cost, an em dash for a missing one. Pure. */
function runningChildRowText(view, now = Date.now(), frame = 0, max = 34) {
	const { marker, suffix } = effectiveChildPresentation(view, frame);
	const duration = dispatchElapsed(view, now).padStart(5);
	const cost = formatDispatchCost(view.cost).padStart(5);
	const model = dispatchModelText(view);
	const limit = Math.max(1, max);
	const row = (agentWidth, withModel, withSuffix = true) => {
		const kind = withSuffix ? suffix : "";
		const name = dispatchAgentText(view, agentWidth);
		const cell = kind === "" ? name.padEnd(agentWidth) : `${name}${kind}`;
		const tail = withModel ? `${model.padEnd(7)} ${cost} ${duration}` : `${cost} ${duration}`;
		return `${marker}${cell} ${tail}`;
	};
	if (model !== "" && suffix === "") {
		const withModel = row(12, true);
		if (withModel.length <= limit) return withModel;
	}
	const full = row(12, false);
	if (full.length <= limit) return full;
	for (let width = 11; width >= 8; width -= 1) {
		const narrowed = row(width, false);
		if (narrowed.length <= limit) return narrowed;
	}
	if (suffix !== "") return row(8, false, false);
	return row(8, false);
}
/** Sessions and spend attributed to one agent in the finished section. `kind`
*  is only set when every finished session of the group agrees on it — a mixed
*  group carries no single purpose, so the row omits it rather than picking one.
*  `background` follows the same rule (all of them background). */
/** Rollup of the finished children by agent: `×count` sessions and the summed
*  `SessionInfo.cost`. Failed and interrupted children are included (they are
*  finished); running ones are not. The group's kind survives only when the
*  whole group agrees, so an aggregate row never claims a purpose it cannot
*  prove. Ordered by cost, then count, then name. Pure. */
function collectChildAgentUsage(views) {
	const totals = /* @__PURE__ */ new Map();
	for (const view of views ?? []) {
		if (!view || view.state === "running") continue;
		const agent = agentKey(view.agent);
		const current = totals.get(agent) ?? {
			agent,
			count: 0,
			cost: 0,
			kinds: /* @__PURE__ */ new Set(),
			background: true
		};
		current.count += 1;
		current.kinds.add(view.kind ?? null);
		if (view.background !== true) current.background = false;
		const cost = numberOrNull(view.cost);
		if (cost !== null && cost >= 0) current.cost += cost;
		totals.set(agent, current);
	}
	return [...totals.values()].map((entry) => {
		const shared = entry.kinds.size === 1 ? [...entry.kinds][0] ?? null : null;
		return {
			agent: entry.agent,
			count: entry.count,
			cost: entry.cost,
			kind: shared,
			background: entry.background
		};
	}).sort((a, b) => b.cost - a.cost || b.count - a.count || a.agent.localeCompare(b.agent));
}
/** One agent rollup row: `<agent 12> ×<count 3>·<kind> <custo 7>`. The kind is
*  glued to the count (the row's only label) and omitted for a mixed group; the
*  agent column shrinks (never below the minimum) before the cost, which is
*  what the row is for. Pure. */
function childAgentRowText(row, max = 34) {
	const suffix = dispatchKindSuffix(row?.kind, row?.background);
	const count = `\u00D7${String(Math.max(0, Math.round(numberOrNull(row?.count) ?? 0))).padStart(3)}`;
	const cost = formatDispatchCost(row?.cost).padStart(7);
	const limit = Math.max(1, max);
	const text = (agentWidth, withSuffix = true) => {
		const kind = withSuffix ? suffix : "";
		return `${truncateLabel(agentKey(row?.agent), agentWidth).padEnd(agentWidth)} ${count}${kind} ${cost}`;
	};
	const full = text(12);
	if (full.length <= limit) return full;
	for (let width = 11; width >= 8; width -= 1) {
		const narrowed = text(width);
		if (narrowed.length <= limit) return narrowed;
	}
	if (suffix !== "") return text(8, false);
	return text(8);
}
/** The `… +K  $<soma>` line for agents beyond the rollup cap. Null when every
*  agent fits. Pure. */
function hiddenChildAgentsText(hidden, hiddenCost) {
	const count = numberOrNull(hidden) ?? 0;
	if (count <= 0) return null;
	const cost = formatSpendUSD(numberOrNull(hiddenCost) ?? 0);
	return cost === null ? `\u2026 +${Math.round(count)}` : `\u2026 +${Math.round(count)}  ${cost}`;
}
/** Summary of the finished section: `✓ 70 · $3.40 · 9 agentes`. `· $<soma>` is
*  omitted when nothing was spent and `· 1 agente` when a single agent owns
*  every finished child; `✓ <total>` always prints. Null when nothing finished.
*  Pure. */
function completedSummaryText(completed, cost, agents) {
	const total = numberOrNull(completed) ?? 0;
	if (total <= 0) return null;
	const parts = [`✓ ${Math.round(total)}`];
	const spend = numberOrNull(cost) ?? 0;
	if (spend > 0) {
		const formatted = formatSpendUSD(spend);
		if (formatted !== null) parts.push(formatted);
	}
	const groups = Math.round(numberOrNull(agents) ?? 0);
	if (groups > 1) parts.push(`${groups} agentes`);
	return parts.join(SPEND_LINE_SEPARATOR);
}
/** The `· <F> falhas` suffix of the finished summary, null when nothing failed.
*  Pure. */
function failedSuffixText(failures) {
	const count = numberOrNull(failures) ?? 0;
	if (count <= 0) return null;
	const rounded = Math.round(count);
	return `${rounded} ${rounded === 1 ? "falha" : "falhas"}`;
}
/** One rendered live row: its text, attention tone and session id. */
/** Everything the `Dispatch` block renders, already joined and capped. */
/** Newest activity first, so the live rows that just moved lead the section.
*  Pure. */
function lastActivity(view) {
	return Math.max(numberOrNull(view?.updatedAt) ?? 0, numberOrNull(view?.startedAt) ?? 0);
}
/** Build the whole block from the child set. Null when there is no child, so
*  the block (and its spacer) never renders empty. Live work is capped at
*  `DISPATCH_RUNNING_CEILING` and the finished rollup at
*  `DISPATCH_AGENT_CEILING`, with the rollup giving up rows first to keep the
*  block inside `DISPATCH_MAX_LINES`. Pure. */
function buildDispatchBlock(views, now = Date.now(), frame = 0, max = 34) {
	const list = Array.isArray(views) ? views.filter((view) => view && typeof view.id === "string") : [];
	if (list.length === 0) return null;
	const running = list.filter((view) => view.state === "running").sort((a, b) => lastActivity(b) - lastActivity(a));
	const finished = list.filter((view) => view.state !== "running");
	const groups = collectChildAgentUsage(finished);
	const finishedCost = groups.reduce((sum, group) => sum + group.cost, 0);
	const failures = finished.filter((view) => view.state === "failed").length;
	const totalCost = dispatchTotalCost(list);
	const runningSlots = Math.min(3, running.length);
	const runningHidden = running.length - runningSlots;
	const runningLines = running.map((view) => ({
		id: view.id,
		text: runningChildRowText(view, now, frame, max),
		tone: effectiveChildPresentation(view, frame).tone
	}));
	const summary = completedSummaryText(finished.length, finishedCost, groups.length);
	const runningRows = runningSlots + (runningHidden > 0 ? 1 : 0);
	const room = Math.max(0, 7 - runningRows - (summary === null ? 0 : 1));
	const wanted = Math.min(3, groups.length);
	const agentSlots = groups.length > wanted ? Math.min(wanted, Math.max(0, room - 1)) : Math.min(wanted, room);
	const visibleAgents = groups.slice(0, agentSlots);
	const hiddenAgents = groups.slice(agentSlots);
	return {
		runningCount: running.length,
		completedCount: finished.length,
		agentCount: groups.length,
		failures,
		totalCost,
		running: runningLines.slice(0, runningSlots),
		runningHidden,
		summary,
		agents: visibleAgents,
		agentsHidden: hiddenAgents.length,
		agentsHiddenCost: hiddenAgents.reduce((sum, group) => sum + group.cost, 0)
	};
}
/** Panel content name, registered by the `session.panel` claim and passed to
*  `ui.panel.open`. */
const DISPATCH_PANEL_NAME = "pantheon.dispatch";
/** Toast shown when `ui.panel.open` refuses (no session route is active). The
*  panel only exists inside a session, so there is no alternative route. */
const DISPATCH_PANEL_TOAST = "Open a session to view Dispatch";
/** Panel title marker — the same glyph the sidebar block header uses. */
const DISPATCH_PANEL_HEADER_MARKER = "◈";
/** Selected-row gutter marker (`▸`, one cell). */
const DISPATCH_PANEL_SELECTION_MARKER = "▸";
/** Cells the selection gutter occupies before a row's own text. */
const DISPATCH_PANEL_SELECTION_GUTTER = 2;
/** Column of the horizontal rule under the header. */
const DISPATCH_PANEL_RULE_CHAR = "─";
/** Em dash for any datum the host did not publish. */
const DISPATCH_PANEL_DASH = "—";
/** Body of an empty panel (the claim still renders, the list is just empty). */
const DISPATCH_PANEL_EMPTY_TEXT = "No delegated sessions";
/** Width at or above which the list and the detail sit side by side. */
const DISPATCH_PANEL_WIDE_MIN_WIDTH = 72;
/** Rows the viewport holds; pageup/pagedown move by exactly this many rows. */
const DISPATCH_PANEL_PAGE_SIZE = 10;
/** Panel row columns: marker(2) + agent(12) + kind(4) + cost(≥7) + duration(8).
*  The cost column is at least this wide; a sub-cent cost widens it per row. */
const DISPATCH_PANEL_AGENT_WIDTH = 12;
const DISPATCH_PANEL_MIN_AGENT_WIDTH = 6;
const DISPATCH_PANEL_KIND_WIDTH = 4;
const DISPATCH_PANEL_COST_WIDTH = 7;
const DISPATCH_PANEL_DURATION_WIDTH = 8;
/** Title column budget (`◈ Dispatch — <sessão>`). */
const DISPATCH_PANEL_TITLE_WIDTH = 44;
/** Badge appended to the title while the host presents the panel full screen. */
const DISPATCH_PANEL_FULLSCREEN_BADGE = "[fullscreen]";
/** Columns a row spends before the agent cell, cost column excluded
*  (2 marker + 1 + 4 kind + 1 + 8 duration). The cost is measured per row
*  because `<$0.0001` is one cell wider than `DISPATCH_PANEL_COST_WIDTH`. */
const DISPATCH_PANEL_ROW_FIXED_WIDTH = 16;
/** Human labels of a kind's evidence, as the detail line prints them. */
const DISPATCH_KIND_ORIGIN_LABELS = {
	prefix: "prefixo",
	agent: "agente",
	unavailable: "indisponível"
};
/** Entries in row order: live work first, then most recent activity — the same
*  comparator the sidebar block uses. Pure. */
function orderDispatchEntries(entries) {
	return [...entries].sort((a, b) => compareDelegations(a.view, b.view));
}
/** `◈ Dispatch — <sessão>`, with the session title truncated (never wrapped),
*  plus the `[fullscreen]` badge while the host presents the panel full screen.
*  An absent title leaves the marker and the name alone. Pure. */
function dispatchPanelTitle(sessionTitle, max = 44, presentation) {
	const base = `◈ Dispatch`;
	const badge = presentation === "fullscreen" ? ` ${DISPATCH_PANEL_FULLSCREEN_BADGE}` : "";
	const title = typeof sessionTitle === "string" ? sessionTitle.trim() : "";
	if (title === "") return `${base}${badge}`;
	return `${base} — ${truncateLabel(title, Math.max(4, max))}${badge}`;
}
/** Header counters: `2 rodando · 70 concluídos · 1 falha · $3.59`. A zero
*  counter is omitted (never `0 rodando`); the total spend is printed whenever
*  the tree has a child, because `$0.00` is then a real answer. Null for an
*  empty tree, so the header renders no counter line at all. Pure. */
function dispatchPanelHeader(entries) {
	const list = Array.isArray(entries) ? entries.filter((entry) => entry?.view) : [];
	if (list.length === 0) return null;
	let running = 0;
	let completed = 0;
	let failed = 0;
	for (const entry of list) switch (entry.view.state) {
		case "running":
			running += 1;
			break;
		case "completed":
			completed += 1;
			break;
		case "failed": failed += 1;
	}
	const parts = [];
	if (running > 0) parts.push(`${running} rodando`);
	if (completed > 0) parts.push(`${completed} ${completed === 1 ? "concluído" : "concluídos"}`);
	if (failed > 0) parts.push(`${failed} ${failed === 1 ? "falha" : "falhas"}`);
	const cost = formatSpendUSD(dispatchTotalCost(list.map((entry) => entry.view)));
	if (cost !== null) parts.push(cost);
	return parts.length === 0 ? null : parts.join(SPEND_LINE_SEPARATOR);
}
/** Horizontal rule under the header, clamped to the panel's own width. Pure. */
function dispatchPanelRule(width, max = 200) {
	const columns = Math.max(0, Math.min(max, Math.floor(numberOrNull(width) ?? 0)));
	return "─".repeat(columns);
}
/** Row marker: animated spinner while running, `✓` done, `✗` failed, `○`
*  cancelled/interrupted, `?` for a state the host never publishes. Every glyph
*  is one cell wide and `?` is the only fallback, so an unknown state is visible
*  instead of silently rendering as success. Pure. */
function dispatchPanelMarker(state, frame = 0) {
	switch (state) {
		case "running": return `${spinnerFrame(frame)} `;
		case "completed": return "✓ ";
		case "failed": return "✗ ";
		case "interrupted": return "○ ";
		default: return "? ";
	}
}
/** One padded, truncated cell: an absent/blank value becomes the em dash, and
*  the value is cut to the cell's own width (never to the line's length, so one
*  long cell cannot squeeze its neighbours out of alignment). Pure. */
function dispatchPanelCell(value, width) {
	const cells = Math.max(1, Math.floor(numberOrNull(width) ?? 1));
	const text = typeof value === "string" ? value.trim() : "";
	return padCell(text === "" ? "—" : text, cells);
}
/** One list row: `⠋ hermes       plan   $0.09  14m34s`. The agent cell absorbs
*  the width difference (down to `DISPATCH_PANEL_MIN_AGENT_WIDTH`), so a narrow
*  panel truncates the label rather than the numbers; the cost column grows by
*  itself for a sub-cent value so the row never spends more than its budget.
*  Pure. */
function dispatchPanelRowText(entry, options = {}) {
	const view = entry?.view;
	if (!view) return "";
	const now = numberOrNull(options.now) ?? Date.now();
	const frame = numberOrNull(options.frame) ?? 0;
	const width = Math.floor(numberOrNull(options.max) ?? 35);
	const costText = formatDispatchCost(view.cost);
	const costWidth = Math.max(7, cellWidth(costText));
	const agentWidth = Math.max(6, Math.min(12, width - (DISPATCH_PANEL_ROW_FIXED_WIDTH + costWidth)));
	return `${view.activity?.attention === "error" ? "! " : view.activity?.attention === "question" || view.activity?.attention === "permission" ? "? " : dispatchPanelMarker(view.state, frame)}${dispatchPanelCell(dispatchAgentText(view, 12), agentWidth)} ${dispatchPanelCell(view.activity?.attention === "question" || view.activity?.attention === "permission" ? "ask" : view.activity?.attention === "error" ? "err" : (view.kind === null || view.kind === "oth") && view.activity?.activeVerb ? view.activity.activeVerb : view.kind, 4)} ${costText.padStart(costWidth)}${truncateLabel(dispatchElapsed(view, now), 8).padStart(8)}`;
}
/** `ses_ab12cd`, short enough for a detail line. Full id when it already fits. */
function shortSessionID(id, max = 10) {
	const text = typeof id === "string" ? id.trim() : "";
	if (text === "") return "—";
	return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}\u2026`;
}
/** Token counters of one child on a single line (`in 1.2K · out 430 · r 120 ·
*  cache 8K/1K`), or `tokens —` when the host published none. Pure. */
function dispatchTokenLine(tokens) {
	if (!tokens) return `tokens —`;
	const value = (token) => token === null ? "—" : formatContextWindow(token) ?? String(token);
	return [
		`in ${value(tokens.input)}`,
		`out ${value(tokens.output)}`,
		`r ${value(tokens.reasoning)}`,
		`cache ${value(tokens.cacheRead)}/${value(tokens.cacheWrite)}`
	].join(SPEND_LINE_SEPARATOR);
}
/** Detail lines of the selected child: heading (title, else the spawning
*  description, else the row label), short id + model, token counters, and the
*  kind plus its evidence and the parent id. Two to four lines; `expanded:
*  false` keeps only the heading. Every missing datum prints `—`. Pure. */
function dispatchPanelDetail(entry, options = {}) {
	if (!entry?.view) return ["—"];
	const max = Math.max(8, Math.floor(numberOrNull(options.max) ?? 60));
	const view = entry.view;
	const lines = [truncateLabel(entry.title ?? entry.description ?? (typeof view.label === "string" && view.label !== "" ? view.label : null) ?? view.id, max)];
	if (options.expanded === false) return lines;
	lines.push(truncateLabel(`${shortSessionID(view.id)}${SPEND_LINE_SEPARATOR}${view.model ?? "—"}`, max));
	lines.push(truncateLabel(dispatchTokenLine(entry.tokens), max));
	const origin = DISPATCH_KIND_ORIGIN_LABELS[view.kindOrigin] ?? DISPATCH_KIND_ORIGIN_LABELS.unavailable;
	lines.push(truncateLabel(`kind ${view.kind ?? "—"} (${origin})${SPEND_LINE_SEPARATOR}parent ${entry.parentID ?? "—"}`, max));
	const activity = view.activity;
	if (activity) {
		if (activity.attention === "question") lines.push(truncateLabel("status ? aguardando resposta do usuário", max));
		else if (activity.attention === "permission") lines.push(truncateLabel("status ? aguardando permissão", max));
		else if (activity.attention === "error") lines.push(truncateLabel("status ! erro na execução", max));
		else if (activity.activeTool) lines.push(truncateLabel(`status \u2726 ${activity.activeTool}`, max));
		const toolsText = activity.recentTools.length > 0 ? activity.recentTools.join(", ") : "";
		const filesText = activity.filesTouched.length > 0 ? activity.filesTouched.join(", ") : "";
		if (toolsText || filesText) {
			const joined = [toolsText, filesText].filter(Boolean).join(SPEND_LINE_SEPARATOR);
			lines.push(truncateLabel(`tools ${joined}`, max));
		}
		if (activity.lastSnippet) lines.push(truncateLabel(`\u21B3 ${activity.lastSnippet}`, max));
	}
	return lines;
}
/** Panel geometry for its input width: wide (≥72) puts the detail in a second
*  column, narrow stacks it under the list. `rowWidth` is what a list row may
*  spend after the selection gutter. Pure. */
function dispatchPanelLayout(width) {
	const columns = Math.max(20, Math.floor(numberOrNull(width) ?? 0));
	if (columns >= 72) {
		const listWidth = Math.max(40, Math.min(64, columns - 26));
		return {
			mode: "wide",
			listWidth,
			detailWidth: Math.max(24, columns - listWidth - 2),
			rowWidth: listWidth - 2
		};
	}
	return {
		mode: "narrow",
		listWidth: columns,
		detailWidth: columns,
		rowWidth: columns - 2
	};
}
/** Viewport of the list: the page holding the selection, scrolled so the
*  selected row stays visible with its predecessors. Bounded, so a 71-child
*  tree renders ten rows, never all of them. Pure. */
function dispatchPanelWindow(total, selectedIndex, pageSize = 10) {
	const count = Math.max(0, Math.floor(numberOrNull(total) ?? 0));
	const size = Math.max(1, Math.floor(numberOrNull(pageSize) ?? 10));
	if (count === 0) return {
		start: 0,
		end: 0,
		size
	};
	const index = Math.min(count - 1, Math.max(0, Math.floor(numberOrNull(selectedIndex) ?? 0)));
	const start = Math.min(Math.max(0, index - size + 1), Math.max(0, count - size));
	return {
		start,
		end: Math.min(count, start + size),
		size
	};
}
/** `1-10 de 71` while the list is longer than one page; null when everything
*  fits (and for an empty list), so the footer never pads itself. Pure. */
function dispatchPanelRangeText(start, end, total) {
	const count = Math.max(0, Math.floor(numberOrNull(total) ?? 0));
	const first = Math.max(0, Math.floor(numberOrNull(start) ?? 0));
	const last = Math.min(count, Math.floor(numberOrNull(end) ?? 0));
	if (count === 0 || first === 0 && last >= count) return null;
	return `${first + 1}-${last} de ${count}`;
}
/** One rendered list row, selection resolved by the view against the model's
*  selected id. */
/** Every entry as a row, ordered by the shared comparator. Pure. */
function dispatchPanelRows(entries, options = {}) {
	return orderDispatchEntries(Array.isArray(entries) ? entries.filter((entry) => entry?.view && typeof entry.view.id === "string") : []).map((entry) => ({
		id: entry.view.id,
		state: entry.view.state,
		text: dispatchPanelRowText(entry, options)
	}));
}
/** Panel action, one per command. */
/** One namespaced command: stable id, explicit binding, and the action it runs. */
/** The panel's whole keymap, in table order. `bind` is explicit for every
*  command (no auto-binding), and every id is namespaced, so a `k`/`q`/`f`
*  binding can never collide with the host's own keys. */
const DISPATCH_PANEL_COMMANDS = [
	{
		action: "up",
		id: "pantheon.dispatch.up",
		title: "Dispatch: select previous",
		bind: "k,up"
	},
	{
		action: "down",
		id: "pantheon.dispatch.down",
		title: "Dispatch: select next",
		bind: "j,down"
	},
	{
		action: "home",
		id: "pantheon.dispatch.home",
		title: "Dispatch: first",
		bind: "home"
	},
	{
		action: "end",
		id: "pantheon.dispatch.end",
		title: "Dispatch: last",
		bind: "end"
	},
	{
		action: "pageup",
		id: "pantheon.dispatch.pageup",
		title: "Dispatch: page up",
		bind: "pageup"
	},
	{
		action: "pagedown",
		id: "pantheon.dispatch.pagedown",
		title: "Dispatch: page down",
		bind: "pagedown"
	},
	{
		action: "toggle",
		id: "pantheon.dispatch.toggle",
		title: "Dispatch: expand detail",
		bind: "enter"
	},
	{
		action: "fullscreen",
		id: "pantheon.dispatch.fullscreen",
		title: "Dispatch: fullscreen",
		bind: "f"
	},
	{
		action: "close",
		id: "pantheon.dispatch.close",
		title: "Dispatch: close",
		bind: "escape,q"
	}
];
/** Run one action against the model and the host-owned panel input. Kept apart
*  from the keymap so the whole command surface is testable without a renderer.
*/
function performDispatchPanelAction(action, model, panel) {
	switch (action) {
		case "up":
			model.move(-1);
			return;
		case "down":
			model.move(1);
			return;
		case "home":
			model.first();
			return;
		case "end":
			model.last();
			return;
		case "pageup":
			model.pageUp();
			return;
		case "pagedown":
			model.pageDown();
			return;
		case "toggle":
			model.toggle();
			return;
		case "fullscreen":
			panel.toggleFullscreen();
			return;
		case "close":
			panel.close();
			return;
		default: return;
	}
}
/** Footer: the keys the host reports for each command (`keymap.shortcuts`) with
*  an em dash whenever a command has no binding, so the hint can never advertise
*  a key that does nothing. Pure. */
function dispatchPanelFooter(shortcutsOf) {
	const keys = (id) => {
		let list = [];
		try {
			const result = shortcutsOf(id);
			list = Array.isArray(result) ? result : [];
		} catch {
			list = [];
		}
		const text = list.map((key) => String(key ?? "").trim()).filter((key) => key !== "").join("/");
		return text === "" ? "—" : text;
	};
	return [
		`${keys("pantheon.dispatch.up")} ${keys("pantheon.dispatch.down")} move`,
		`${keys("pantheon.dispatch.toggle")} detail`,
		`${keys("pantheon.dispatch.fullscreen")} fullscreen`,
		`${keys("pantheon.dispatch.close")} close`
	].join(SPEND_LINE_SEPARATOR);
}
/** The subset of `PanelInput` the model reads, so tests can drive it with a
*  plain object. */
/** `keymap.shortcuts` of one command; empty when the keymap is unavailable. */
function keymapShortcuts(context, id) {
	try {
		const list = context?.keymap?.shortcuts?.(id);
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}
/** Open the panel from the command palette / slash command. `ui.panel.open`
*  only accepts a `session` route, so a refusal (no session open) is answered
*  with a toast — never a fallback route, never a silent no-op. Returns whether
*  the panel opened. */
function openDispatchPanel(context) {
	let opened = false;
	try {
		opened = context?.ui?.panel?.open?.(DISPATCH_PANEL_NAME) === true;
	} catch {
		opened = false;
	}
	if (opened) return true;
	try {
		context?.ui?.toast?.show?.({
			message: DISPATCH_PANEL_TOAST,
			variant: "warning"
		});
	} catch {}
	return false;
}
/** Reactive state the panel view renders. Selection is held by session id, so
*  it survives list updates; the index is derived (and falls back to the first
*  row when the selected child disappears). */
/** Model behind the panel. Mounted only while the panel claim renders (the
*  `Show` in `session.panel`), so the 80 ms tick it arms exists exactly while
*  the panel is open; it also stops on `isOpen()` going false and on dispose.
*  It performs no `message.sync`, writes no `session.metadata` and makes no
*  request: `collectDispatch` reads only host-cached state. */
function createDispatchPanelModel(context, panel) {
	const [revision, setRevision] = createSignal(0);
	const [frame, setFrame] = createSignal(0);
	const [expanded, setExpanded] = createSignal(true);
	const [selectedID, setSelectedID] = createSignal(null);
	const isOpen = () => panel().name === DISPATCH_PANEL_NAME;
	const activeSessionID = () => {
		const id = panel().sessionID;
		return isValidSessionID(id) ? id : "";
	};
	const entries = createMemo(() => {
		revision();
		if (!isOpen()) return [];
		return enrichDispatchEntries(context, collectDispatch(context, activeSessionID()));
	});
	const layout = createMemo(() => dispatchPanelLayout(panel().width));
	const rows = createMemo(() => {
		const mode = layout();
		return dispatchPanelRows(entries(), {
			now: Date.now(),
			frame: frame(),
			max: mode.rowWidth
		});
	});
	const selectedIndex = createMemo(() => {
		const list = rows();
		if (list.length === 0) return 0;
		const id = selectedID();
		if (id === null) return 0;
		const index = list.findIndex((row) => row.id === id);
		return index === -1 ? 0 : index;
	});
	const selectedIDAccessor = createMemo(() => rows()[selectedIndex()]?.id ?? null);
	const selectedEntry = createMemo(() => entries()[selectedIndex()] ?? null);
	const session = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return void 0;
		try {
			return context.data.session.get(id);
		} catch {
			return;
		}
	});
	const title = createMemo(() => dispatchPanelTitle(session()?.title, 44, panel().presentation));
	const header = createMemo(() => dispatchPanelHeader(entries()));
	const detail = createMemo(() => dispatchPanelDetail(selectedEntry(), {
		expanded: expanded(),
		max: layout().detailWidth
	}));
	const visible = createMemo(() => {
		const list = rows();
		const window = dispatchPanelWindow(list.length, selectedIndex());
		return {
			start: window.start,
			rows: list.slice(window.start, window.end)
		};
	});
	const hasRunning = createMemo(() => rows().some((row) => row.state === "running"));
	const footer = createMemo(() => {
		const list = rows();
		const window = dispatchPanelWindow(list.length, selectedIndex());
		const range = dispatchPanelRangeText(window.start, window.end, list.length);
		const hints = dispatchPanelFooter((id) => keymapShortcuts(context, id));
		return range === null ? hints : `${range}${SPEND_LINE_SEPARATOR}${hints}`;
	});
	const select = (index) => {
		const list = rows();
		if (list.length === 0) return;
		const clamped = Math.min(list.length - 1, Math.max(0, Math.round(index)));
		setSelectedID(list[clamped]?.id ?? null);
	};
	onMount(() => {
		onCleanup(subscribeSidebarRefresh(context, () => setRevision((value) => value + 1)));
	});
	createEffect(() => {
		if (!isOpen() || !hasRunning()) return;
		const spinner = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS);
		onCleanup(() => clearInterval(spinner));
	});
	return {
		entries,
		rows,
		title,
		header,
		detail,
		layout,
		visible,
		selectedID: selectedIDAccessor,
		selectedIndex,
		expanded,
		hasRunning,
		frame,
		footer,
		move: (delta) => select(selectedIndex() + (numberOrNull(delta) ?? 0)),
		first: () => select(0),
		last: () => select(rows().length - 1),
		pageUp: () => select(selectedIndex() - 10),
		pageDown: () => select(selectedIndex() + 10),
		toggle: () => setExpanded((value) => !value)
	};
}
/** Session ids to eagerly sync at load (deduped, bounded). Pure. */
function collectWarmupTargets(sessions, limit = WARMUP_SESSION_LIMIT) {
	const ids = [];
	for (const session of sessions) {
		if (!isValidSessionID(session?.id) || ids.includes(session.id)) continue;
		ids.push(session.id);
		if (ids.length >= limit) break;
	}
	return ids;
}
/** Body a sidebar instance renders when the host has not published a real
*  session id yet. OpenCode V2 scopes the `sidebar.content` slot to a session
*  (`SlotMap["sidebar.content"] = { sessionID: string }`), so before the first
*  prompt the slot may not mount at all — see the `home.footer.status`
*  contribution for the pre-prompt degradation. Pure. */
function sidebarPlaceholder(sessionID) {
	return isValidSessionID(sessionID) ? null : SIDEBAR_WAITING_LABEL;
}
/** Navigate to a session through the V2 router. Fail-open: an absent router or
*  a removed session must never break the sidebar. Returns whether a valid
*  navigation was dispatched. Pure. */
function navigateToSession(router, sessionID) {
	if (typeof router?.navigate !== "function" || !isValidSessionID(sessionID)) return false;
	try {
		router.navigate({
			type: "session",
			sessionID
		});
		return true;
	} catch {
		return false;
	}
}
/** Diff two delegation observations: entries that were `running` and are no
*  longer running count as completions, fired once per transition. Returns the
*  next snapshot so callers can keep a single tracker. First observation never
*  reports a completion (no toast spam on mount). Pure. */
function detectDelegationCompletions(previous, current) {
	const snapshot = /* @__PURE__ */ new Map();
	const completed = [];
	for (const entry of current) {
		snapshot.set(entry.id, entry.state);
		if (previous.get(entry.id) === "running" && entry.state !== "running") completed.push(entry);
	}
	return {
		completed,
		snapshot
	};
}
function resolveLocation(context) {
	try {
		return context?.location ?? context?.data?.location?.default();
	} catch {
		return;
	}
}
function resolveSidebarCwd(context) {
	const location = resolveLocation(context);
	if (location && typeof location.directory === "string" && location.directory !== "") return location.directory;
	return process.cwd();
}
function sessionStatusOf(context, sessionID) {
	try {
		const status = context?.data?.session?.status?.(sessionID);
		return typeof status === "string" ? status : void 0;
	} catch {
		return;
	}
}
/** Subscribe `refresh` to every V2 event that can change sidebar state. Returns
*  a disposer that releases exactly the subscriptions the host handed out. The
*  event names come from the V2 union; the cast turns an unknown name into a
*  compile error instead of a silent no-op subscription. */
function subscribeSidebarRefresh(context, refresh) {
	const stop = [];
	const data = context?.data;
	if (typeof data?.on === "function") for (const type of SIDEBAR_REFRESH_EVENTS) try {
		const unsubscribe = data.on(type, refresh);
		if (typeof unsubscribe === "function") stop.push(unsubscribe);
	} catch {}
	return () => {
		for (const unsubscribe of stop) if (typeof unsubscribe === "function") unsubscribe();
	};
}
/** Reactive signal tracking whether a newer Pantheon version is available on the active channel. */
function useAvailableUpdate(currentVersion) {
	const [latest, setLatest] = createSignal((() => {
		const candidate = getAvailableUpdateVersion();
		return candidate && isNewerUpdateAvailable(currentVersion, candidate) ? candidate : null;
	})());
	onMount(() => {
		const sync = (candidate) => {
			setLatest(candidate && isNewerUpdateAvailable(currentVersion, candidate) ? candidate : null);
		};
		sync(getAvailableUpdateVersion());
		onCleanup(subscribeAvailableUpdate(sync));
	});
	return latest;
}
function updateCheckStateFile() {
	const stateDir = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local", "state");
	const statePath = join(stateDir, "pantheon", "update-check.json");
	const readState = () => {
		try {
			return JSON.parse(readFileSync(statePath, "utf8"));
		} catch {
			return {};
		}
	};
	return {
		statePath,
		readState
	};
}
/** One update check per boot + periodic TTL interval: hydrates cached badge
*  immediately, queries the registry at most once per TTL, announces once per
*  version via toast, and keeps the persistent Home/Sidebar badge updated. */
async function checkForPantheonUpdate(context) {
	const { statePath, readState } = updateCheckStateFile();
	const currentVersion = "2.2.2";
	const initialState = readState();
	setAvailableUpdateVersion(resolveCachedAvailableUpdate(currentVersion, initialState));
	const nowMs = Date.now();
	if (nowMs - (initialState.lastCheckMs ?? 0) < 216e5) return;
	const persist = (notice, latest) => {
		mkdirSync(join(statePath, ".."), { recursive: true });
		const next = withKnownLatest(nextCheckState(readState(), notice, nowMs), latest);
		writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
	};
	const response = await fetch(registryUrlForChannel(updateChannelFor(currentVersion)), { signal: AbortSignal.timeout(5e3) });
	const latest = String((await response.json())?.version ?? "");
	if (!latest) return;
	setAvailableUpdateVersion(isNewerUpdateAvailable(currentVersion, latest) ? latest : null);
	const isPt = resolveLanguage(tuiPrefs().layout?.language) === "pt-BR";
	const notice = pickUpdateNotice({
		currentVersion,
		latestVersion: latest,
		state: readState(),
		nowMs,
		isPt
	});
	persist(notice, latest);
	if (!notice) return;
	const toast = formatUpdateToast(currentVersion, latest, isPt);
	context?.ui?.toast?.show?.({
		title: toast.title,
		message: toast.message,
		variant: "info"
	});
}
/** Populate the cached data at load so the sidebar has content before the first
*  prompt (Known Issue guard). Fire-and-forget: a missing API or a failed sync
*  degrades silently and the sidebar still renders its static header. */
function warmUpSidebarData(context, location) {
	try {
		Promise.resolve(context?.data?.location?.vcs?.sync?.(location)).catch(() => {});
	} catch {}
	let listed = [];
	try {
		const result = context?.data?.session?.list?.();
		if (Array.isArray(result)) listed = result;
	} catch {}
	for (const id of collectWarmupTargets(listed)) try {
		Promise.resolve(context?.data?.session?.sync?.(id)).catch(() => {});
	} catch {}
}
function showDelegationToast(context, done) {
	const variant = done.state === "failed" ? "error" : done.state === "interrupted" ? "warning" : "success";
	const verb = done.state === "failed" ? "falhou" : done.state === "interrupted" ? "interrompida" : "concluída";
	try {
		context?.ui?.toast?.show?.({
			title: TOAST_TITLE,
			message: `${done.label} ${verb}`,
			variant,
			sessionID: done.id
		});
	} catch {}
}
/** Active preset signal with mount + 30s refresh. Shared by the sidebar and the
*  home-screen status contribution. */
function useActivePreset(context) {
	const [preset, setPreset] = createSignal(presetFromEnv(process.env));
	const [overrides, setOverrides] = createSignal(emptyOverrides());
	onMount(() => {
		const cwd = resolveSidebarCwd(context);
		let cancelled = false;
		const refresh = async () => {
			try {
				const detail = await resolveActivePresetForTui(process.env, cwd);
				if (!cancelled) {
					setPreset(detail.info);
					setOverrides(detail.overrides);
				}
			} catch {}
		};
		refresh();
		const timer = setInterval(() => void refresh(), PRESET_REFRESH_MS);
		onCleanup(() => {
			cancelled = true;
			clearInterval(timer);
		});
	});
	const effectivePreset = () => {
		const preview = tuiDraftPreview();
		if (preview && "preset" in preview) {
			const stagedName = preview.preset;
			return {
				...preset(),
				name: stagedName === "none" ? null : stagedName
			};
		}
		return preset();
	};
	return {
		preset: effectivePreset,
		overrides
	};
}
/** Debounce for the git file-count revalidation. `vcs.status` is an HTTP call;
*  session events arrive in bursts, so the row is refreshed at most once per
*  window instead of on every event. */
const GIT_CHANGES_DEBOUNCE_MS = 400;
/** `context.client.vcs.status(input?, requestOptions?)` →
*  `Promise<{ data: VcsFileStatus[] }>` (`GET /api/vcs/status`). Returns the
*  callable or null when the host does not expose it, so callers degrade to
*  the branch-only row instead of throwing. */
function vcsStatusCall(context) {
	const status = context?.client?.vcs?.status;
	return typeof status === "function" ? status.bind(context.client.vcs) : null;
}
/** `context.client.session.stats(input?, requestOptions?)` →
*  `Promise<SessionStatsInfo>` (`GET /api/experimental/session/stats`), served
*  by the local process. Returns the callable or null when the host does not
*  expose it, so the Context spend line simply does not render. */
function statsCall(context) {
	const stats = context?.client?.session?.stats;
	return typeof stats === "function" ? stats.bind(context.client.session) : null;
}
/** Local IANA zone for the stats call (`America/Sao_Paulo`); omitted when the
*  runtime cannot resolve one. */
function localTimezone() {
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return typeof zone === "string" && zone !== "" ? zone : void 0;
	} catch {
		return;
	}
}
/** Fields every stats call sends. `tools: 'none'` skips the tool aggregation
*  the block never renders; `project` is omitted (no cheap id in hand) rather
*  than guessed. */
function statsInput() {
	const timezone = localTimezone();
	return timezone === void 0 ? { tools: "none" } : {
		tools: "none",
		timezone
	};
}
/** Convert a millisecond instant to the unit the route accepted. */
function spendInstant(ms, unit) {
	return unit === "s" ? Math.floor(ms / 1e3) : ms;
}
/** Measure the `from`/`to` unit once: millisecond epoch first, then a single
*  seconds attempt. Bounded to two calls and never throws; anything the route
*  rejects (mismatch, throw, malformed echo) ends as `unavailable`, which hides
*  the block for the rest of the process instead of retrying forever. */
async function probeSpendUnit(call) {
	const now = Date.now();
	const fromMs = now - SPEND_PROBE_WINDOW_MS;
	const attempts = [{
		sent: {
			from: fromMs,
			to: now
		},
		scale: 1,
		unit: "ms"
	}, {
		sent: {
			from: Math.floor(fromMs / 1e3),
			to: Math.floor(now / 1e3)
		},
		scale: 1e3,
		unit: "s"
	}];
	for (const attempt of attempts) try {
		if (statsRangeMatches((await call({
			...statsInput(),
			...attempt.sent
		}))?.range, attempt.sent, attempt.scale)) return attempt.unit;
	} catch {}
	return "unavailable";
}
/** Resolve (and cache) the unit for this process. Concurrent callers share one
*  probe, so a burst of refreshes cannot spend more than two calls on it. */
function ensureSpendUnit(call) {
	if (spendUnit !== null) return Promise.resolve(spendUnit);
	if (spendProbe === null) spendProbe = probeSpendUnit(call).then((unit) => {
		spendUnit = unit;
		spendProbe = null;
		return unit;
	}, () => {
		spendUnit = "unavailable";
		spendProbe = null;
		return "unavailable";
	});
	return spendProbe;
}
/** Reactive state the sidebar view renders. Accessors keep the view reactive
*  while the model itself stays free of JSX, so its effects are exercisable
*  without a TUI renderer. */
/** Reactive wiring behind the sidebar: refresh subscription, warm syncs, the
*  running-only spinner and the completion-toast effect. `context` stays loosely
*  typed (the host API only exists at runtime) but the refresh event names are
*  narrowed to the V2 union at the subscription site. */
function createSidebarModel(context, sessionID, gitExec = defaultGitExec) {
	const [revision, setRevision] = createSignal(0);
	const [metricsRevision, setMetricsRevision] = createSignal(0);
	const [frame, setFrame] = createSignal(0);
	const location = resolveLocation(context);
	const activePreset = useActivePreset(context);
	const preset = activePreset.preset;
	const presetOverrides = activePreset.overrides;
	let observedStates = /* @__PURE__ */ new Map();
	let metricsDebounce;
	const scheduleMetrics = () => {
		if (metricsDebounce !== void 0) clearTimeout(metricsDebounce);
		metricsDebounce = setTimeout(() => {
			metricsDebounce = void 0;
			setMetricsRevision((value) => value + 1);
		}, 400);
	};
	const refresh = () => {
		setRevision((value) => value + 1);
		scheduleMetrics();
	};
	const activeSessionID = () => {
		const id = sessionID();
		return isValidSessionID(id) ? id : "";
	};
	const session = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return void 0;
		try {
			return context.data.session.get(id);
		} catch {
			return;
		}
	});
	const branch = createMemo(() => {
		revision();
		try {
			return context.data.location.vcs.info(location)?.branch?.current ?? null;
		} catch {
			return null;
		}
	});
	const [gitChangesRead, setGitChangesRead] = createSignal({
		session: activeSessionID(),
		text: null
	});
	const [gitCliRead, setGitCliRead] = createSignal({
		session: activeSessionID(),
		snapshot: null
	});
	const gitChanges = createMemo(() => {
		const read = gitChangesRead();
		return read.session === activeSessionID() ? read.text : null;
	});
	const gitCli = createMemo(() => {
		const read = gitCliRead();
		return read.session === activeSessionID() ? read.snapshot : null;
	});
	let gitRequest = 0;
	let gitDebounce;
	let gitProbeDebounce;
	let gitProbeSessionID = activeSessionID();
	let gitProbeStartedAt = null;
	let gitProbeInFlight = false;
	let disposed = false;
	const loadGitChanges = async () => {
		const status = vcsStatusCall(context);
		if (status === null) return;
		const session = activeSessionID();
		const request = ++gitRequest;
		try {
			const result = await status({ location: { directory: resolveSidebarCwd(context) } });
			if (request !== gitRequest || session !== activeSessionID()) return;
			const files = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
			setGitChangesRead({
				session,
				text: formatGitChanges(files)
			});
		} catch {}
	};
	const runGitProbe = async () => {
		const session = activeSessionID();
		if (session !== gitProbeSessionID) {
			gitProbeSessionID = session;
			gitProbeStartedAt = null;
			gitProbeInFlight = false;
		}
		if (!gitProbeAllowed({
			now: Date.now(),
			lastRunAt: gitProbeStartedAt,
			inFlight: gitProbeInFlight
		})) return;
		gitProbeInFlight = true;
		gitProbeStartedAt = Date.now();
		try {
			const snapshot = await readGitSnapshot(resolveSidebarCwd(context), gitExec);
			if (!disposed && session === activeSessionID()) setGitCliRead({
				session,
				snapshot
			});
		} catch {} finally {
			if (session === gitProbeSessionID) gitProbeInFlight = false;
		}
	};
	const scheduleGitChanges = () => {
		if (vcsStatusCall(context) === null) return;
		if (gitCli() !== null) return;
		if (gitDebounce !== void 0) clearTimeout(gitDebounce);
		gitDebounce = setTimeout(() => {
			gitDebounce = void 0;
			loadGitChanges();
		}, 400);
	};
	const scheduleGitProbe = () => {
		if (gitProbeDebounce !== void 0) clearTimeout(gitProbeDebounce);
		gitProbeDebounce = setTimeout(() => {
			gitProbeDebounce = void 0;
			runGitProbe();
		}, GIT_CLI_DEBOUNCE_MS);
	};
	const gitLine = createMemo(() => {
		const snapshot = gitCli();
		if (snapshot !== null) return formatGitSnapshot(snapshot);
		return gitChanges();
	});
	createEffect(on(activeSessionID, (id) => {
		if (disposed || id === "") return;
		runGitProbe();
		loadGitChanges();
	}, { defer: true }));
	const [spend, setSpend] = createSignal(null);
	let spendTotals = {
		today: null,
		thirtyDays: null
	};
	let spendRequest = 0;
	let spendDebounce;
	const loadSpend = async () => {
		const stats = statsCall(context);
		if (stats === null) return;
		try {
			const unit = await ensureSpendUnit(stats);
			if (unit === "unavailable") return;
			const request = ++spendRequest;
			const windows = spendWindows(Date.now());
			const settled = await Promise.allSettled([stats({
				...statsInput(),
				from: spendInstant(windows.today.from, unit),
				to: spendInstant(windows.today.to, unit)
			}), stats({
				...statsInput(),
				from: spendInstant(windows.thirtyDays.from, unit),
				to: spendInstant(windows.thirtyDays.to, unit)
			})]);
			if (request !== spendRequest) return;
			const next = { ...spendTotals };
			for (const [index, key] of ["today", "thirtyDays"].entries()) {
				const result = settled[index];
				if (result === void 0 || result.status !== "fulfilled") continue;
				const cost = statsCost(result.value);
				if (cost === null) continue;
				next[key] = cost;
			}
			spendTotals = next;
			setSpend(next);
		} catch {}
	};
	const scheduleSpend = () => {
		if (statsCall(context) === null) return;
		if (spendDebounce !== void 0) clearTimeout(spendDebounce);
		spendDebounce = setTimeout(() => {
			spendDebounce = void 0;
			loadSpend();
		}, 400);
	};
	const messages = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return [];
		try {
			const result = context.data.session.message?.list?.(id);
			return Array.isArray(result) ? result : [];
		} catch {
			return [];
		}
	});
	const familySessionIDs = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return [];
		const ids = [id];
		try {
			const result = context.data.session.family?.(id);
			if (Array.isArray(result)) for (const childID of result) {
				if (!isValidSessionID(childID) || ids.includes(childID)) continue;
				ids.push(childID);
				if (ids.length >= 8) break;
			}
		} catch {}
		return ids;
	});
	const transcript = createMemo(() => {
		metricsRevision();
		const rootID = activeSessionID();
		const collected = [];
		let todo = [];
		const activities = /* @__PURE__ */ new Map();
		for (const id of familySessionIDs()) {
			let list = [];
			try {
				const result = context.data.session.message?.list?.(id);
				if (Array.isArray(result)) list = result;
			} catch {}
			collected.push(...list.slice(-400));
			if (id === rootID) todo = latestTodoItems(list) ?? [];
			else {
				const activity = extractChildActivity(list, sessionStatusOf(context, id));
				if (activity) activities.set(id, activity);
			}
		}
		return {
			messages: collected,
			todo,
			activities
		};
	});
	const usageMessages = createMemo(() => transcript().messages);
	const todo = createMemo(() => ceilingTodoItems(transcript().todo, 6));
	const messageCostTotal = createMemo(() => {
		let total = 0;
		for (const message of usageMessages()) {
			if (message?.type !== "assistant") continue;
			const cost = numberOrNull(message.cost);
			if (cost !== null && cost > 0) total += cost;
		}
		return total;
	});
	const cost = createMemo(() => {
		revision();
		const ids = familySessionIDs();
		if (ids.length === 0) return null;
		let total = 0;
		let found = false;
		for (const id of ids) {
			let value;
			try {
				value = context.data.session.cost?.(id);
			} catch {
				value = void 0;
			}
			let resolved = numberOrNull(value);
			if (resolved === null) try {
				resolved = numberOrNull(context.data.session.get(id)?.cost);
			} catch {
				resolved = null;
			}
			if (resolved !== null && resolved >= 0) {
				total += resolved;
				found = true;
			}
		}
		if (found) return Math.max(total, messageCostTotal());
		const fallback = messageCostTotal();
		return fallback > 0 ? fallback : null;
	});
	const modelUsage = createMemo(() => {
		metricsRevision();
		return ceilingModelUsage(collectModelUsage(usageMessages()), 3);
	});
	const modelRefs = createMemo(() => {
		revision();
		const current = session();
		const agent = typeof current?.agent === "string" && current.agent !== "" ? current.agent : "";
		let agentRef;
		if (agent !== "") try {
			const agents = context.data.location?.agent?.list?.(location);
			if (Array.isArray(agents)) agentRef = agents.find((entry) => entry?.id === agent)?.model;
		} catch {}
		const override = agent === "" ? void 0 : presetOverrides().agents[agent]?.model;
		return {
			agent,
			sessionRef: current?.model,
			agentRef,
			override: typeof override === "string" && override !== "" ? override : null
		};
	});
	const agentModel = createMemo(() => {
		const { agent, sessionRef, agentRef, override } = modelRefs();
		const model = shortModelID(override) ?? shortModelID(sessionRef) ?? shortModelID(agentRef);
		if (model === null) return null;
		return {
			agent,
			model,
			overridden: override !== null
		};
	});
	const provider = createMemo(() => {
		revision();
		const fromSession = providerIDFromRef(session()?.model);
		if (fromSession !== null) return fromSession;
		const list = messages();
		for (let index = list.length - 1; index >= 0; index -= 1) {
			const message = list[index];
			if (message?.type !== "assistant") continue;
			const fromMessage = providerIDFromRef(message.model);
			if (fromMessage !== null) return fromMessage;
		}
		const { agentRef } = modelRefs();
		const fromAgent = providerIDFromRef(agentRef);
		if (fromAgent !== null) return fromAgent;
		try {
			return providerIDFromModels(context.data.location?.model?.list?.(location), agentRef);
		} catch {
			return null;
		}
	});
	const contextUsage = createMemo(() => {
		const list = messages().slice(-400);
		if (list.length === 0) return null;
		const refs = modelRefs();
		const ref = resolveActiveModelRef(refs.sessionRef, list, refs.agentRef);
		if (ref === null) return null;
		let models = [];
		try {
			const result = context.data.location?.model?.list?.(location);
			if (Array.isArray(result)) models = result;
		} catch {}
		return resolveModelContextSnapshot(list, ref, models, session()?.revert?.messageID);
	});
	const cachePerformance = createMemo(() => {
		const message = lastAssistantWithTokens(messages(), session()?.revert?.messageID);
		return message === null ? null : cacheHitPercent(message.tokens);
	});
	const turnPerformance = createMemo(() => {
		const list = messages();
		let anchor = -1;
		for (let index = list.length - 1; index >= 0; index--) if (list[index]?.type === "assistant") {
			anchor = index;
			break;
		}
		return anchor === -1 ? null : turnTokensPerSecond(list, anchor);
	});
	const performance = createMemo(() => {
		const cacheHit = cachePerformance();
		const tokensPerSecond = turnPerformance();
		if (cacheHit === null && tokensPerSecond === null) return null;
		return {
			cacheHit,
			tokensPerSecond
		};
	});
	const subagentCalls = createMemo(() => collectSubagentCalls(messages()));
	const dispatchEntries = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return [];
		return collectDispatch(context, id, {
			now: Date.now(),
			calls: subagentCalls(),
			activities: transcript().activities
		});
	});
	/** What the sidebar block renders: the collector's rows, nothing else. */
	const allDelegations = createMemo(() => dispatchEntries().map((entry) => entry.view));
	const hasRunning = createMemo(() => allDelegations().some((view) => view.state === "running"));
	const dispatch = createMemo(() => {
		frame();
		return buildDispatchBlock(allDelegations(), Date.now(), frame());
	});
	const turnCost = createMemo(() => latestTurnCost(messages()));
	const turnCostLine = createMemo(() => formatTurnCostLine(turnCost()));
	const tokenAnatomy = createMemo(() => {
		const message = lastAssistantWithTokens(messages(), session()?.revert?.messageID);
		return message === null ? null : extractTokenAnatomy(message.tokens);
	});
	const tokenAnatomyLine = createMemo(() => formatTokenAnatomyLine(tokenAnatomy()));
	const tokenAnatomySplit = createMemo(() => formatTokenAnatomySplit(tokenAnatomy()));
	const toolCalls = createMemo(() => summarizeToolDomains(messages()));
	const toolCallsLine = createMemo(() => formatToolCallLine(toolCalls(), tuiPrefs().layout.language));
	const toolCallsDetailLine = createMemo(() => formatToolDomainLine(toolCalls(), 34));
	const compactions = createMemo(() => extractCompactionInfo(messages()));
	const compactionBadge = createMemo(() => {
		const badge = formatCompactionBadge(compactions());
		if (badge) return badge;
		return "compact";
	});
	const userTurns = createMemo(() => countUserTurns(messages()));
	const turnsBadge = createMemo(() => formatTurnsBadge(userTurns(), tuiPrefs().layout.language));
	const performanceSplit = createMemo(() => {
		const perf = performance();
		if (!perf) return null;
		let cacheText = null;
		if (perf.cacheHit !== null) cacheText = `Cache: ${Math.round(perf.cacheHit)}%`;
		const speedText = perf.tokensPerSecond !== null ? `Speed: ${perf.tokensPerSecond.toFixed(0)} t/s` : null;
		if (!cacheText && !speedText) return null;
		return {
			cache: cacheText,
			speed: speedText
		};
	});
	const contextRatioLine = createMemo(() => {
		const usage = contextUsage();
		if (!usage) return null;
		return `${formatTokenCount(usage.tokens)} / ${formatContextWindow(usage.limit)}`;
	});
	const gateStatus = createMemo(() => resolveGateStatus());
	const isPinned = createMemo(() => isSessionPinned(activeSessionID()));
	const blocks = createMemo(() => {
		const prefs = tuiPrefs();
		const present = [];
		if (prefs.sidebar.blocks.context && (contextBlockRows(contextUsage(), cost(), prefs.sidebar.context.gauge) !== null || prefs.sidebar.context.localSpend && contextSpendLine(spend()) !== null || prefs.sidebar.context.turnCost && turnCostLine() !== null || prefs.sidebar.context.tokenAnatomy && tokenAnatomyLine() !== null)) present.push("context");
		if (prefs.sidebar.blocks.git && (branch() !== null || gitLine() !== null)) present.push("git");
		if (prefs.sidebar.blocks.dispatch && dispatch() !== null) present.push("dispatch");
		return withBlockSpacers(present);
	});
	onMount(() => {
		const unsubscribeAll = subscribeSidebarRefresh(context, () => {
			refresh();
			scheduleGitChanges();
			scheduleGitProbe();
			scheduleSpend();
		});
		const id = activeSessionID();
		if (id !== "") {
			try {
				Promise.resolve(context.data.session.sync(id)).then(refresh);
			} catch {}
			try {
				Promise.resolve(context.data.session.message?.sync?.(id)).then(refresh);
			} catch {}
		}
		try {
			Promise.resolve(context.data.location.vcs.sync(location)).then(refresh);
		} catch {}
		loadGitChanges();
		runGitProbe();
		loadSpend();
		createEffect(() => {
			if (!hasRunning()) return;
			const spinner = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS);
			onCleanup(() => clearInterval(spinner));
		});
		onCleanup(() => {
			disposed = true;
			if (gitDebounce !== void 0) clearTimeout(gitDebounce);
			if (gitProbeDebounce !== void 0) clearTimeout(gitProbeDebounce);
			if (spendDebounce !== void 0) clearTimeout(spendDebounce);
			if (metricsDebounce !== void 0) clearTimeout(metricsDebounce);
		});
		onCleanup(unsubscribeAll);
	});
	let observedSessionID = activeSessionID();
	createEffect(() => {
		const id = activeSessionID();
		const views = allDelegations();
		if (id !== observedSessionID) {
			observedSessionID = id;
			observedStates = /* @__PURE__ */ new Map();
		}
		if (id === "") {
			observedStates = /* @__PURE__ */ new Map();
			return;
		}
		const { completed, snapshot } = detectDelegationCompletions(observedStates, views.map((view) => ({
			id: view.id,
			label: view.label,
			state: view.state
		})));
		observedStates = snapshot;
		for (const done of completed) showDelegationToast(context, done);
	});
	return {
		activeSessionID,
		session,
		branch,
		gitChanges,
		gitLine,
		gitCli,
		performance,
		dispatch,
		blocks,
		hasRunning,
		frame,
		preset,
		provider,
		presetOverrides,
		cost,
		modelUsage,
		todo,
		spend,
		contextUsage,
		agentModel,
		turnCost,
		turnCostLine,
		tokenAnatomyLine,
		toolCallsLine,
		toolCallsDetailLine,
		compactionBadge,
		turnsBadge,
		tokenAnatomySplit,
		performanceSplit,
		contextRatioLine,
		gateStatus,
		isPinned
	};
}
/** One `Context` row: an optional toned lead segment (the gauge's filled
*  cells), the value, the muted gauge tail (empty cells) and the muted unit
*  suffix (`tokens` / `of 200K` / `spent`). */
function ContextRowView(props) {
	const fullWidth = () => cellWidth(`${props.row.lead ?? ""}${props.row.tail ?? ""}${props.row.value}${props.row.suffix ?? ""}`);
	return createComponent(Show, {
		get when() {
			return props.row.suffix !== " spent in session";
		},
		get fallback() {
			return (() => {
				var _el$3 = createElement("box");
				setProp(_el$3, "flexDirection", "column");
				insert(_el$3, createComponent(For, {
					get each() {
						return sidebarMoneyLines("spent in session", props.row.value);
					},
					children: (line) => (() => {
						var _el$4 = createElement("text");
						insert(_el$4, line);
						effect((_$p) => setProp(_el$4, "fg", props.fg, _$p));
						return _el$4;
					})()
				}));
				return _el$3;
			})();
		},
		get children() {
			return createComponent(Show, {
				get when() {
					return fullWidth() <= 34;
				},
				get fallback() {
					return (() => {
						var _el$5 = createElement("box");
						setProp(_el$5, "flexDirection", "column");
						insert(_el$5, createComponent(For, {
							get each() {
								return sidebarTextLines(`${props.row.value.trim()}${props.row.suffix ?? ""}`);
							},
							children: (line) => (() => {
								var _el$6 = createElement("text");
								insert(_el$6, line);
								effect((_$p) => setProp(_el$6, "fg", props.fg, _$p));
								return _el$6;
							})()
						}));
						return _el$5;
					})();
				},
				get children() {
					var _el$ = createElement("box"), _el$2 = createElement("text");
					insertNode(_el$, _el$2);
					setProp(_el$, "flexDirection", "row");
					insert(_el$, createComponent(Show, {
						get when() {
							return props.row.lead;
						},
						children: (lead) => (() => {
							var _el$7 = createElement("text");
							insert(_el$7, lead);
							effect((_$p) => setProp(_el$7, "fg", props.fg, _$p));
							return _el$7;
						})()
					}), _el$2);
					insert(_el$, createComponent(Show, {
						get when() {
							return props.row.tail;
						},
						children: (tail) => (() => {
							var _el$8 = createElement("text");
							insert(_el$8, tail);
							effect((_$p) => setProp(_el$8, "fg", props.muted, _$p));
							return _el$8;
						})()
					}), _el$2);
					insert(_el$2, () => props.row.value);
					insert(_el$, createComponent(Show, {
						get when() {
							return props.row.suffix;
						},
						children: (suffix) => (() => {
							var _el$9 = createElement("text");
							insert(_el$9, suffix);
							effect((_$p) => setProp(_el$9, "fg", props.muted, _$p));
							return _el$9;
						})()
					}), null);
					effect((_$p) => setProp(_el$2, "fg", props.fg, _$p));
					return _el$;
				}
			});
		}
	});
}
/** Block title: a muted single-width glyph, then the bold label. The fixed
*  header at the top of the sidebar deliberately renders no icon. `summary` is
*  the muted tail some blocks carry (`· 2 rodando · $0.47`), so the header
*  stays one line. */
function BlockHeader(props) {
	return (() => {
		var _el$0 = createElement("box"), _el$1 = createElement("box"), _el$10 = createElement("text"), _el$11 = createElement("text");
		insertNode(_el$0, _el$1);
		setProp(_el$0, "flexDirection", "row");
		setProp(_el$0, "justifyContent", "space-between");
		setProp(_el$0, "width", "100%");
		insertNode(_el$1, _el$10);
		insertNode(_el$1, _el$11);
		setProp(_el$1, "flexDirection", "row");
		insert(_el$10, () => `${props.icon} `);
		setProp(_el$11, "attributes", 1);
		insert(_el$11, () => props.label);
		insert(_el$1, createComponent(Show, {
			get when() {
				return props.summary;
			},
			children: (summary) => (() => {
				var _el$12 = createElement("text");
				insert(_el$12, () => `${SPEND_LINE_SEPARATOR}${summary()}`);
				effect((_$p) => setProp(_el$12, "fg", props.muted, _$p));
				return _el$12;
			})()
		}), null);
		insert(_el$0, createComponent(Show, {
			get when() {
				return props.right;
			},
			get children() {
				return props.right;
			}
		}), null);
		effect((_p$) => {
			var _v$ = props.iconFg ?? props.muted, _v$2 = props.fg;
			_v$ !== _p$.e && (_p$.e = setProp(_el$10, "fg", _v$, _p$.e));
			_v$2 !== _p$.t && (_p$.t = setProp(_el$11, "fg", _v$2, _p$.t));
			return _p$;
		}, {
			e: void 0,
			t: void 0
		});
		return _el$0;
	})();
}
function Sidebar(props) {
	const text = () => props.context.theme?.text?.base ?? "#ffffff";
	const muted = () => props.context.theme?.text?.muted ?? "#888888";
	return createComponent(ErrorBoundary, {
		fallback: (err) => (() => {
			var _el$13 = createElement("box"), _el$14 = createElement("text"), _el$15 = createElement("text");
			insertNode(_el$13, _el$14);
			insertNode(_el$13, _el$15);
			setProp(_el$13, "flexDirection", "column");
			setProp(_el$13, "paddingLeft", 1);
			setProp(_el$13, "paddingRight", 1);
			setProp(_el$14, "attributes", 1);
			insert(_el$14, `Pantheon v2.2.2`);
			insert(_el$15, () => `Erro no painel: ${err?.message ?? "desconhecido"}`);
			effect((_p$) => {
				var _v$3 = text(), _v$4 = muted();
				_v$3 !== _p$.e && (_p$.e = setProp(_el$14, "fg", _v$3, _p$.e));
				_v$4 !== _p$.t && (_p$.t = setProp(_el$15, "fg", _v$4, _p$.t));
				return _p$;
			}, {
				e: void 0,
				t: void 0
			});
			return _el$13;
		})(),
		get children() {
			return createComponent(SidebarInner, props);
		}
	});
}
function SidebarInner(props) {
	const { context } = props;
	const model = createSidebarModel(context, () => props.sessionID);
	const text = () => context.theme.text?.base;
	const muted = () => context.theme.text?.muted ?? text();
	const accent = () => resolveAccentColor(tuiDraftPreview()?.theme?.accent ?? tuiPrefs().theme?.accent, context.theme);
	const tone = (value) => context.theme?.text?.feedback?.[value]?.base ?? text();
	const open = (sessionID) => () => navigateToSession(context.ui?.router, sessionID);
	const block = (key) => model.blocks().find((entry) => entry.key === key);
	const spacer = (key) => block(key)?.spacer === true;
	const usageHidden = () => hiddenModelUsageText(model.modelUsage().hidden, model.modelUsage().hiddenCost);
	const contextRows = () => {
		const prefs = tuiPrefs();
		const barCells = prefs.sidebar.context.barWidth === "compact" ? 8 : prefs.sidebar.context.barWidth === "wide" ? 16 : prefs.sidebar.context.barWidth === "full" ? 20 : 12;
		const rows = contextBlockRows(model.contextUsage(), model.cost(), prefs.sidebar.context.gauge, {
			shape: prefs.sidebar.context.barShape,
			cells: barCells,
			evenMark: prefs.sidebar.context.evenMark
		});
		if (rows === null) return null;
		return {
			tokens: prefs.sidebar.context.tokens ? rows.tokens : null,
			percent: rows.percent,
			spent: prefs.sidebar.context.spent ? rows.spent : null
		};
	};
	const spendLine = () => tuiPrefs().sidebar.context.localSpend ? contextSpendLine(model.spend()) : null;
	const usageRows = () => tuiPrefs().sidebar.context.modelUsage ? modelUsageRows(model.modelUsage().visible) : [];
	const gaugeFg = (row) => contextProgressColor(row.tone ?? "warning", context.theme);
	const dispatchView = () => model.dispatch();
	const dispatchSummary = () => {
		const view = dispatchView();
		return view === null ? null : dispatchHeaderSummary(view.runningCount, view.totalCost);
	};
	const failedSuffix = () => failedSuffixText(dispatchView()?.failures);
	const header = () => tuiPrefs().sidebar.header;
	const availableUpdate = useAvailableUpdate("2.2.2");
	const isPt = () => resolveLanguage(tuiPrefs().layout?.language) === "pt-BR";
	const updateBadge = () => formatUpdateBadge("2.2.2", availableUpdate(), { isPt: isPt() });
	const artifacts = useWorkspaceArtifacts(context);
	const activePlan = () => artifacts().find((entry) => entry.kind === "plan");
	return (() => {
		var _el$16 = createElement("box"), _el$17 = createElement("box"), _el$19 = createElement("box");
		insertNode(_el$16, _el$17);
		setProp(_el$16, "flexDirection", "column");
		setProp(_el$16, "width", "100%");
		setProp(_el$16, "paddingLeft", 1);
		setProp(_el$16, "paddingRight", 1);
		insertNode(_el$17, _el$19);
		setProp(_el$17, "flexDirection", "row");
		setProp(_el$17, "justifyContent", "space-between");
		insert(_el$17, createComponent(Show, {
			get when() {
				return header().version;
			},
			get children() {
				var _el$18 = createElement("text");
				setProp(_el$18, "attributes", 1);
				insert(_el$18, `Pantheon v2.2.2`);
				effect((_$p) => setProp(_el$18, "fg", text(), _$p));
				return _el$18;
			}
		}), _el$19);
		setProp(_el$19, "flexDirection", "row");
		insert(_el$19, createComponent(Show, {
			get when() {
				return model.turnsBadge();
			},
			children: (turns) => (() => {
				var _el$41 = createElement("text");
				insert(_el$41, turns);
				effect((_$p) => setProp(_el$41, "fg", muted(), _$p));
				return _el$41;
			})()
		}), null);
		insert(_el$19, createComponent(Show, {
			get when() {
				return model.isPinned();
			},
			get children() {
				var _el$20 = createElement("text");
				insertNode(_el$20, createTextNode(` 📌 fixada`));
				effect((_$p) => setProp(_el$20, "fg", accent(), _$p));
				return _el$20;
			}
		}), null);
		insert(_el$16, createComponent(Show, {
			get when() {
				return memo(() => !!header().version)() && updateBadge();
			},
			children: (badge) => (() => {
				var _el$42 = createElement("box"), _el$43 = createElement("text");
				insertNode(_el$42, _el$43);
				setProp(_el$42, "onMouseDown", stopMouseEvent);
				setProp(_el$42, "onMouseUp", (event) => handleMouseClick(event, () => {
					openPantheonSettings(context, { initialTab: "updates" });
				}));
				insert(_el$43, badge);
				effect((_$p) => setProp(_el$43, "fg", accent(), _$p));
				return _el$42;
			})()
		}), null);
		insert(_el$16, createComponent(Show, {
			get when() {
				return header().preset;
			},
			children: () => {
				const badge = () => model.compactionBadge() ? `[${model.compactionBadge()}]` : null;
				const leftPreset = () => {
					const b = badge();
					const maxCols = b ? Math.max(10, 31 - cellWidth(b) - 1) : HEADER_MAX_WIDTH;
					return truncateLabel(presetHeaderLine(model.preset().name ?? "", model.provider()), maxCols);
				};
				let compactInFlight = false;
				const triggerCompaction = () => {
					if (compactInFlight) return;
					compactInFlight = true;
					try {
						context.ui?.toast?.show?.({
							title: "Pantheon",
							message: "Iniciando compactação de contexto...",
							variant: "info"
						});
						const id = model.activeSessionID();
						if (id) {
							const compactCall = context.client?.session?.compact;
							const commandCall = context.client?.session?.command;
							const p = typeof compactCall === "function" ? compactCall.call(context.client.session, { sessionID: id }) : typeof commandCall === "function" ? commandCall.call(context.client.session, {
								sessionID: id,
								name: "compact",
								text: ""
							}) : Promise.reject(/* @__PURE__ */ new Error("compact indisponível"));
							Promise.resolve(p).then(() => {
								context.ui?.toast?.show?.({
									title: "Pantheon",
									message: "Contexto compactado com sucesso!",
									variant: "success"
								});
							}).catch((err) => {
								context.ui?.toast?.show?.({
									title: "Pantheon",
									message: `Erro na compactação: ${err?.message ?? "falhou"}`,
									variant: "error"
								});
							}).finally(() => {
								compactInFlight = false;
							});
						} else compactInFlight = false;
					} catch {
						compactInFlight = false;
					}
				};
				return (() => {
					var _el$44 = createElement("box"), _el$45 = createElement("text");
					insertNode(_el$44, _el$45);
					setProp(_el$44, "flexDirection", "row");
					setProp(_el$44, "justifyContent", "space-between");
					insert(_el$45, leftPreset);
					insert(_el$44, createComponent(Show, {
						get when() {
							return badge();
						},
						children: (b) => (() => {
							var _el$46 = createElement("box"), _el$47 = createElement("text");
							insertNode(_el$46, _el$47);
							setProp(_el$46, "onMouseDown", triggerCompaction);
							setProp(_el$46, "flexShrink", 0);
							setProp(_el$47, "attributes", 1);
							insert(_el$47, b);
							effect((_$p) => setProp(_el$47, "fg", accent(), _$p));
							return _el$46;
						})()
					}), null);
					effect((_$p) => setProp(_el$45, "fg", muted(), _$p));
					return _el$44;
				})();
			}
		}), null);
		insert(_el$16, createComponent(Show, {
			get when() {
				return memo(() => !!(header().session && model.activeSessionID() !== ""))() && model.session();
			},
			get fallback() {
				return createComponent(Show, {
					get when() {
						return header().session;
					},
					get fallback() {
						return (() => {
							var _el$49 = createElement("box");
							setProp(_el$49, "height", 0);
							return _el$49;
						})();
					},
					get children() {
						var _el$48 = createElement("text");
						insert(_el$48, () => sidebarPlaceholder(props.sessionID));
						effect((_$p) => setProp(_el$48, "fg", muted(), _$p));
						return _el$48;
					}
				});
			},
			children: (current) => (() => {
				var _el$50 = createElement("box"), _el$51 = createElement("text"), _el$53 = createElement("text"), _el$55 = createElement("text");
				insertNode(_el$50, _el$51);
				insertNode(_el$50, _el$53);
				insertNode(_el$50, _el$55);
				setProp(_el$50, "flexDirection", "row");
				insertNode(_el$51, createTextNode(`● `));
				setProp(_el$51, "fg", "#22c55e");
				insertNode(_el$53, createTextNode(`Session: `));
				setProp(_el$55, "attributes", 1);
				insert(_el$55, () => truncateLabel(current().title || current().id, 18));
				effect((_p$) => {
					var _v$7 = muted(), _v$8 = text();
					_v$7 !== _p$.e && (_p$.e = setProp(_el$53, "fg", _v$7, _p$.e));
					_v$8 !== _p$.t && (_p$.t = setProp(_el$55, "fg", _v$8, _p$.t));
					return _p$;
				}, {
					e: void 0,
					t: void 0
				});
				return _el$50;
			})()
		}), null);
		insert(_el$16, createComponent(Show, {
			get when() {
				return model.blocks().length > 0;
			},
			get children() {
				var _el$22 = createElement("box");
				setProp(_el$22, "height", 1);
				return _el$22;
			}
		}), null);
		insert(_el$16, createComponent(Show, {
			get when() {
				return block("context");
			},
			get children() {
				var _el$23 = createElement("box"), _el$25 = createElement("text"), _el$27 = createElement("box"), _el$28 = createElement("text");
				insertNode(_el$23, _el$25);
				insertNode(_el$23, _el$27);
				setProp(_el$23, "flexDirection", "column");
				insert(_el$23, createComponent(Show, {
					get when() {
						return spacer("context");
					},
					get children() {
						var _el$24 = createElement("box");
						setProp(_el$24, "height", 1);
						return _el$24;
					}
				}), _el$25);
				insert(_el$23, createComponent(BlockHeader, {
					get icon() {
						return BLOCK_ICONS.context;
					},
					iconFg: "#38bdf8",
					label: "Context",
					get fg() {
						return text();
					},
					get muted() {
						return muted();
					},
					get right() {
						return createComponent(Show, {
							get when() {
								return memo(() => !!tuiPrefs().sidebar.context.turnCost)() && model.turnCostLine();
							},
							children: (line) => {
								const display = () => {
									const l = line();
									if (cellWidth(l) + 11 > 31) {
										const cost = model.turnCost();
										return cost ? `Turn: ${formatTurnCostUSD(cost.current)}` : l;
									}
									return l;
								};
								return (() => {
									var _el$56 = createElement("box"), _el$57 = createElement("text"), _el$59 = createElement("text");
									insertNode(_el$56, _el$57);
									insertNode(_el$56, _el$59);
									setProp(_el$56, "flexDirection", "row");
									insertNode(_el$57, createTextNode(`Turn: `));
									setProp(_el$59, "fg", "#34d399");
									setProp(_el$59, "attributes", 1);
									insert(_el$59, () => display().replace(/^Turn:\s*/, ""));
									effect((_$p) => setProp(_el$57, "fg", muted(), _$p));
									return _el$56;
								})();
							}
						});
					}
				}), _el$25);
				insert(_el$23, createComponent(Show, {
					get when() {
						return contextRows();
					},
					children: (rows) => (() => {
						var _el$60 = createElement("box");
						setProp(_el$60, "flexDirection", "column");
						insert(_el$60, createComponent(Show, {
							get when() {
								return rows().percent;
							},
							children: (row) => (() => {
								var _el$61 = createElement("box");
								setProp(_el$61, "flexDirection", "row");
								setProp(_el$61, "justifyContent", "space-between");
								insert(_el$61, createComponent(ContextRowView, {
									get row() {
										return memo(() => !!model.contextRatioLine())() ? {
											...row(),
											suffix: null
										} : row();
									},
									get fg() {
										return gaugeFg(row());
									},
									get muted() {
										return muted();
									}
								}), null);
								insert(_el$61, createComponent(Show, {
									get when() {
										return model.contextRatioLine();
									},
									children: (ratio) => {
										const parts = ratio().split(" / ");
										return (() => {
											var _el$62 = createElement("box"), _el$63 = createElement("text"), _el$64 = createElement("text");
											insertNode(_el$62, _el$63);
											insertNode(_el$62, _el$64);
											setProp(_el$62, "flexDirection", "row");
											setProp(_el$63, "fg", "#f1f5f9");
											setProp(_el$63, "attributes", 1);
											insert(_el$63, () => parts[0]);
											insert(_el$64, () => ` / ${parts[1] ?? ""}`);
											effect((_$p) => setProp(_el$64, "fg", muted(), _$p));
											return _el$62;
										})();
									}
								}), null);
								return _el$61;
							})()
						}), null);
						insert(_el$60, createComponent(Show, {
							get when() {
								return memo(() => !!rows().tokens)() && !rows().percent;
							},
							children: (row) => createComponent(ContextRowView, {
								get row() {
									return row();
								},
								get fg() {
									return text();
								},
								get muted() {
									return muted();
								}
							})
						}), null);
						insert(_el$60, createComponent(Show, {
							get when() {
								return rows().spent;
							},
							children: (row) => createComponent(ContextRowView, {
								get row() {
									return row();
								},
								get fg() {
									return text();
								},
								get muted() {
									return muted();
								}
							})
						}), null);
						return _el$60;
					})()
				}), _el$25);
				insert(_el$23, createComponent(Show, {
					get when() {
						return memo(() => !!tuiPrefs().sidebar.context.tokenAnatomy)() && model.tokenAnatomySplit();
					},
					children: (anatomy) => (() => {
						var _el$65 = createElement("box"), _el$66 = createElement("box"), _el$67 = createElement("text"), _el$69 = createElement("text");
						insertNode(_el$65, _el$66);
						setProp(_el$65, "flexDirection", "row");
						setProp(_el$65, "justifyContent", "space-between");
						insertNode(_el$66, _el$67);
						insertNode(_el$66, _el$69);
						setProp(_el$66, "flexDirection", "row");
						insertNode(_el$67, createTextNode(`↑`));
						setProp(_el$67, "fg", "#60a5fa");
						insert(_el$69, () => anatomy().inOut?.split(" · ")[0]?.replace(/^↑\s*/, "") ?? "");
						insert(_el$66, createComponent(Show, {
							get when() {
								return anatomy().inOut?.includes(" · ");
							},
							get children() {
								return [
									(() => {
										var _el$70 = createElement("text");
										insertNode(_el$70, createTextNode(` · `));
										effect((_$p) => setProp(_el$70, "fg", muted(), _$p));
										return _el$70;
									})(),
									(() => {
										var _el$72 = createElement("text");
										insertNode(_el$72, createTextNode(`↓`));
										setProp(_el$72, "fg", "#4ade80");
										return _el$72;
									})(),
									(() => {
										var _el$74 = createElement("text");
										insert(_el$74, () => anatomy().inOut?.split(" · ")[1]?.replace(/^↓\s*/, "") ?? "");
										effect((_$p) => setProp(_el$74, "fg", muted(), _$p));
										return _el$74;
									})()
								];
							}
						}), null);
						insert(_el$65, createComponent(Show, {
							get when() {
								return anatomy().think;
							},
							children: (think) => (() => {
								var _el$75 = createElement("text");
								setProp(_el$75, "fg", "#c084fc");
								setProp(_el$75, "attributes", 1);
								insert(_el$75, think);
								return _el$75;
							})()
						}), null);
						effect((_$p) => setProp(_el$69, "fg", muted(), _$p));
						return _el$65;
					})()
				}), _el$25);
				insert(_el$23, createComponent(Show, {
					get when() {
						return memo(() => !!tuiPrefs().sidebar.context.performance)() && model.performanceSplit();
					},
					children: (perf) => (() => {
						var _el$76 = createElement("box"), _el$77 = createElement("box"), _el$78 = createElement("text"), _el$80 = createElement("text"), _el$81 = createElement("box"), _el$82 = createElement("text"), _el$84 = createElement("text");
						insertNode(_el$76, _el$77);
						insertNode(_el$76, _el$81);
						setProp(_el$76, "flexDirection", "row");
						setProp(_el$76, "justifyContent", "space-between");
						insertNode(_el$77, _el$78);
						insertNode(_el$77, _el$80);
						setProp(_el$77, "flexDirection", "row");
						insertNode(_el$78, createTextNode(`Cache: `));
						setProp(_el$80, "fg", "#34d399");
						insert(_el$80, () => perf().cache?.replace(/^Cache:\s*/, "") ?? "");
						insertNode(_el$81, _el$82);
						insertNode(_el$81, _el$84);
						setProp(_el$81, "flexDirection", "row");
						insertNode(_el$82, createTextNode(`Speed: `));
						setProp(_el$84, "fg", "#38bdf8");
						insert(_el$84, () => perf().speed?.replace(/^Speed:\s*/, "") ?? "");
						effect((_p$) => {
							var _v$9 = muted(), _v$0 = muted();
							_v$9 !== _p$.e && (_p$.e = setProp(_el$78, "fg", _v$9, _p$.e));
							_v$0 !== _p$.t && (_p$.t = setProp(_el$82, "fg", _v$0, _p$.t));
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$76;
					})()
				}), _el$25);
				insertNode(_el$25, createTextNode(`──────────────────────────────`));
				setProp(_el$25, "fg", "#374151");
				insertNode(_el$27, _el$28);
				setProp(_el$27, "flexDirection", "row");
				setProp(_el$27, "justifyContent", "space-between");
				insert(_el$27, createComponent(Show, {
					get when() {
						return model.toolCallsLine();
					},
					get fallback() {
						return (() => {
							var _el$85 = createElement("text");
							insertNode(_el$85, createTextNode(`tools: 0 (0 err)`));
							effect((_$p) => setProp(_el$85, "fg", muted(), _$p));
							return _el$85;
						})();
					},
					children: (line) => (() => {
						var _el$87 = createElement("text");
						insert(_el$87, line);
						effect((_$p) => setProp(_el$87, "fg", muted(), _$p));
						return _el$87;
					})()
				}), _el$28);
				setProp(_el$28, "fg", "#22c55e");
				setProp(_el$28, "attributes", 1);
				insert(_el$28, () => model.gateStatus());
				insert(_el$23, createComponent(Show, {
					get when() {
						return model.toolCallsDetailLine();
					},
					children: (line) => (() => {
						var _el$88 = createElement("text");
						insert(_el$88, line);
						effect((_$p) => setProp(_el$88, "fg", muted(), _$p));
						return _el$88;
					})()
				}), null);
				insert(_el$23, createComponent(Show, {
					get when() {
						return memo(() => !!tuiPrefs().sidebar.context.modelUsage)() && usageRows().length > 0;
					},
					get children() {
						return [
							(() => {
								var _el$29 = createElement("text");
								insertNode(_el$29, createTextNode(`Session · reported cost`));
								effect((_$p) => setProp(_el$29, "fg", muted(), _$p));
								return _el$29;
							})(),
							(() => {
								var _el$31 = createElement("text");
								insertNode(_el$31, createTextNode(`Model         Tokens       USD`));
								effect((_$p) => setProp(_el$31, "fg", muted(), _$p));
								return _el$31;
							})(),
							createComponent(For, {
								get each() {
									return usageRows();
								},
								children: (row) => (() => {
									var _el$89 = createElement("box");
									setProp(_el$89, "flexDirection", "column");
									insert(_el$89, createComponent(For, {
										get each() {
											return modelUsageRowLines(row);
										},
										children: (line) => (() => {
											var _el$90 = createElement("text");
											insert(_el$90, line);
											effect((_$p) => setProp(_el$90, "fg", text(), _$p));
											return _el$90;
										})()
									}));
									return _el$89;
								})()
							}),
							createComponent(Show, {
								get when() {
									return usageHidden();
								},
								children: (line) => createComponent(For, {
									get each() {
										return sidebarTextLines(line());
									},
									children: (part) => (() => {
										var _el$91 = createElement("text");
										insert(_el$91, part);
										effect((_$p) => setProp(_el$91, "fg", muted(), _$p));
										return _el$91;
									})()
								})
							})
						];
					}
				}), null);
				insert(_el$23, createComponent(Show, {
					get when() {
						return spendLine();
					},
					children: (line) => createComponent(For, {
						get each() {
							return contextSpendLines(line());
						},
						children: (part) => (() => {
							var _el$92 = createElement("text");
							insert(_el$92, part);
							effect((_$p) => setProp(_el$92, "fg", muted(), _$p));
							return _el$92;
						})()
					})
				}), null);
				return _el$23;
			}
		}), null);
		insert(_el$16, createComponent(Show, {
			get when() {
				return block("git");
			},
			get children() {
				var _el$33 = createElement("box"), _el$35 = createElement("box");
				insertNode(_el$33, _el$35);
				setProp(_el$33, "flexDirection", "column");
				insert(_el$33, createComponent(Show, {
					get when() {
						return spacer("git");
					},
					get children() {
						var _el$34 = createElement("box");
						setProp(_el$34, "height", 1);
						return _el$34;
					}
				}), _el$35);
				insert(_el$33, createComponent(BlockHeader, {
					get icon() {
						return BLOCK_ICONS.git;
					},
					iconFg: "#f59e0b",
					label: "Git status",
					get fg() {
						return text();
					},
					get muted() {
						return muted();
					}
				}), _el$35);
				setProp(_el$35, "flexDirection", "row");
				setProp(_el$35, "justifyContent", "space-between");
				insert(_el$35, createComponent(Show, {
					get when() {
						return model.branch();
					},
					children: (value) => (() => {
						var _el$93 = createElement("box"), _el$94 = createElement("text"), _el$96 = createElement("text");
						insertNode(_el$93, _el$94);
						insertNode(_el$93, _el$96);
						setProp(_el$93, "flexDirection", "row");
						insertNode(_el$94, createTextNode(`⎇ `));
						setProp(_el$94, "fg", "#38bdf8");
						setProp(_el$96, "attributes", 1);
						insert(_el$96, () => truncateLabel(value(), 24));
						effect((_$p) => setProp(_el$96, "fg", text(), _$p));
						return _el$93;
					})()
				}), null);
				insert(_el$35, createComponent(Show, {
					get when() {
						return model.gitLine();
					},
					children: (line) => (() => {
						var _el$97 = createElement("text");
						setProp(_el$97, "fg", "#f59e0b");
						insert(_el$97, line);
						return _el$97;
					})()
				}), null);
				return _el$33;
			}
		}), null);
		insert(_el$16, createComponent(Show, {
			get when() {
				return block("dispatch");
			},
			get children() {
				var _el$36 = createElement("box");
				setProp(_el$36, "flexDirection", "column");
				insert(_el$36, createComponent(Show, {
					get when() {
						return spacer("dispatch");
					},
					get children() {
						var _el$37 = createElement("box");
						setProp(_el$37, "height", 1);
						return _el$37;
					}
				}), null);
				insert(_el$36, createComponent(Show, {
					get when() {
						return dispatchView();
					},
					children: (view) => (() => {
						var _el$98 = createElement("box");
						setProp(_el$98, "flexDirection", "column");
						insert(_el$98, createComponent(BlockHeader, {
							get icon() {
								return BLOCK_ICONS.dispatch;
							},
							iconFg: "#c084fc",
							label: "Dispatch",
							get fg() {
								return memo(() => view().runningCount > 0)() ? tone("success") : muted();
							},
							get muted() {
								return muted();
							},
							get summary() {
								return dispatchSummary();
							}
						}), null);
						insert(_el$98, createComponent(For, {
							get each() {
								return view().running;
							},
							children: (row) => (() => {
								var _el$100 = createElement("box"), _el$101 = createElement("text");
								insertNode(_el$100, _el$101);
								setProp(_el$100, "flexShrink", 0);
								insert(_el$101, () => row.text);
								effect((_p$) => {
									var _v$1 = open(row.id), _v$10 = tone(row.tone ?? "success");
									_v$1 !== _p$.e && (_p$.e = setProp(_el$100, "onMouseDown", _v$1, _p$.e));
									_v$10 !== _p$.t && (_p$.t = setProp(_el$101, "fg", _v$10, _p$.t));
									return _p$;
								}, {
									e: void 0,
									t: void 0
								});
								return _el$100;
							})()
						}), null);
						insert(_el$98, createComponent(Show, {
							get when() {
								return view().runningHidden > 0;
							},
							get children() {
								var _el$99 = createElement("text");
								insert(_el$99, () => `\u2026 +${view().runningHidden} rodando`);
								effect((_$p) => setProp(_el$99, "fg", muted(), _$p));
								return _el$99;
							}
						}), null);
						insert(_el$98, createComponent(Show, {
							get when() {
								return view().summary;
							},
							children: (line) => (() => {
								var _el$102 = createElement("box"), _el$103 = createElement("text");
								insertNode(_el$102, _el$103);
								setProp(_el$102, "flexDirection", "row");
								setProp(_el$102, "flexShrink", 0);
								insert(_el$103, line);
								insert(_el$102, createComponent(Show, {
									get when() {
										return failedSuffix();
									},
									children: (suffix) => (() => {
										var _el$104 = createElement("text");
										insert(_el$104, () => `${SPEND_LINE_SEPARATOR}${suffix()}`);
										effect((_$p) => setProp(_el$104, "fg", tone("error"), _$p));
										return _el$104;
									})()
								}), null);
								effect((_$p) => setProp(_el$103, "fg", muted(), _$p));
								return _el$102;
							})()
						}), null);
						insert(_el$98, createComponent(For, {
							get each() {
								return view().agents;
							},
							children: (row) => (() => {
								var _el$105 = createElement("text");
								insert(_el$105, () => childAgentRowText(row));
								effect((_$p) => setProp(_el$105, "fg", muted(), _$p));
								return _el$105;
							})()
						}), null);
						insert(_el$98, createComponent(Show, {
							get when() {
								return hiddenChildAgentsText(view().agentsHidden, view().agentsHiddenCost);
							},
							children: (line) => (() => {
								var _el$106 = createElement("text");
								insert(_el$106, line);
								effect((_$p) => setProp(_el$106, "fg", muted(), _$p));
								return _el$106;
							})()
						}), null);
						return _el$98;
					})()
				}), null);
				return _el$36;
			}
		}), null);
		insert(_el$16, createComponent(Show, {
			get when() {
				return artifacts().length > 0;
			},
			get children() {
				var _el$38 = createElement("box"), _el$39 = createElement("box"), _el$40 = createElement("text");
				insertNode(_el$38, _el$39);
				setProp(_el$38, "flexDirection", "column");
				setProp(_el$38, "marginTop", 1);
				insert(_el$38, createComponent(Show, {
					get when() {
						return activePlan();
					},
					children: (plan) => (() => {
						var _el$107 = createElement("box"), _el$108 = createElement("text");
						insertNode(_el$107, _el$108);
						setProp(_el$107, "onMouseDown", stopMouseEvent);
						setProp(_el$107, "onMouseUp", (event) => handleMouseClick(event, () => {
							openArtifactsDialog(context, resolveSidebarCwd(context), { initialArtifactId: plan().id });
						}));
						setProp(_el$107, "flexShrink", 0);
						insert(_el$108, () => `▸ Plan: ${truncateLabel(plan().title, 22)}`);
						effect((_$p) => setProp(_el$108, "fg", accent(), _$p));
						return _el$107;
					})()
				}), _el$39);
				insertNode(_el$39, _el$40);
				setProp(_el$39, "onMouseDown", stopMouseEvent);
				setProp(_el$39, "onMouseUp", (event) => handleMouseClick(event, () => {
					openArtifactsDialog(context, resolveSidebarCwd(context));
				}));
				setProp(_el$39, "flexShrink", 0);
				insert(_el$40, (() => {
					var _c$ = memo(() => !!isPt());
					return () => _c$() ? `◈ Artefatos (${artifacts().length})` : `◈ Artifacts (${artifacts().length})`;
				})());
				effect((_$p) => setProp(_el$40, "fg", muted(), _$p));
				return _el$38;
			}
		}), null);
		effect((_p$) => {
			var _v$5 = tuiPrefs().layout.preset === "compact" ? 0 : 1, _v$6 = tuiPrefs().layout.preset === "compact" ? 0 : 1;
			_v$5 !== _p$.e && (_p$.e = setProp(_el$16, "paddingTop", _v$5, _p$.e));
			_v$6 !== _p$.t && (_p$.t = setProp(_el$16, "paddingBottom", _v$6, _p$.t));
			return _p$;
		}, {
			e: void 0,
			t: void 0
		});
		return _el$16;
	})();
}
/** Panel actions that only make sense with a row selected. A panel over an
*  empty tree still owns `f`/`escape`, but the navigation keys fall through
*  instead of being swallowed by a no-op. */
const DISPATCH_PANEL_ROW_ACTIONS = /* @__PURE__ */ new Set([
	"up",
	"down",
	"home",
	"end",
	"pageup",
	"pagedown",
	"toggle"
]);
/** One command: runs only while the panel owns the keyboard, and reports
*  `false` (the host keeps the key) when it cannot act. `undefined` means the
*  key was consumed. */
function runDispatchPanelCommand(action, panel, model) {
	if (panel.focused !== true) return false;
	if (DISPATCH_PANEL_ROW_ACTIONS.has(action) && model.rows().length === 0) return false;
	performDispatchPanelAction(action, model, panel);
}
/** Keymap layer of the panel, as data. It is registered inside the
*  `session.panel` claim, but the host mounts the effects of *every* panel
*  contribution, so the layer itself is not proof of focus: without `enabled`
*  the `j/k/f/q/enter/escape` bindings were consumed while the panel was not
*  focused and the composer lost its keys. `enabled` (the documented gate) makes
*  the whole layer inert until `panel.focused` is true. Pure. */
function dispatchPanelKeymapLayer(panel, model) {
	const focused = () => panel.focused === true && !pantheonSettingsBlocking();
	return {
		mode: "global",
		enabled: focused,
		commands: DISPATCH_PANEL_COMMANDS.map((spec) => ({
			id: spec.id,
			title: spec.title,
			bind: spec.bind,
			run: () => focused() ? runDispatchPanelCommand(spec.action, panel, model) : false
		}))
	};
}
/** Keymap layer of the panel. Created inside the `session.panel` claim, so the
*  host removes it with the panel; it renders nothing. */
function DispatchPanelKeymap(props) {
	props.context.keymap.layer(() => dispatchPanelKeymapLayer(props.panel, props.model));
	return null;
}
/** The full-width dispatch panel: header counters, one row per child session,
*  the detail of the selected child and the key hints. Wide panels put the
*  detail beside the list; narrow ones stack it under the list and every cell is
*  truncated to its own column instead of wrapping. */
function DispatchPanel(props) {
	const model = createDispatchPanelModel(props.context, () => props.panel);
	const text = () => props.context.theme.text?.base;
	const muted = () => props.context.theme.text?.muted ?? text();
	const tone = (value) => props.context.theme?.text?.feedback?.[value]?.base ?? text();
	const rowFg = (state) => {
		if (state === "failed") return tone("error");
		if (state === "running") return tone("success");
		if (state === "interrupted") return tone("warning");
		return text();
	};
	const selected = (id) => id === model.selectedID();
	const rows = () => createComponent(For, {
		get each() {
			return model.visible().rows;
		},
		children: (row) => (() => {
			var _el$109 = createElement("box"), _el$110 = createElement("text"), _el$111 = createElement("text");
			insertNode(_el$109, _el$110);
			insertNode(_el$109, _el$111);
			setProp(_el$109, "flexDirection", "row");
			setProp(_el$109, "flexShrink", 0);
			insert(_el$110, () => selected(row.id) ? `▸ ` : "  ");
			insert(_el$111, () => row.text);
			effect((_p$) => {
				var _v$11 = selected(row.id) ? text() : muted(), _v$12 = rowFg(row.state), _v$13 = selected(row.id) ? 1 : 0;
				_v$11 !== _p$.e && (_p$.e = setProp(_el$110, "fg", _v$11, _p$.e));
				_v$12 !== _p$.t && (_p$.t = setProp(_el$111, "fg", _v$12, _p$.t));
				_v$13 !== _p$.a && (_p$.a = setProp(_el$111, "attributes", _v$13, _p$.a));
				return _p$;
			}, {
				e: void 0,
				t: void 0,
				a: void 0
			});
			return _el$109;
		})()
	});
	const detail = () => createComponent(For, {
		get each() {
			return model.detail();
		},
		children: (line, index) => (() => {
			var _el$112 = createElement("text");
			insert(_el$112, line);
			effect((_$p) => setProp(_el$112, "fg", index() === 0 ? text() : muted(), _$p));
			return _el$112;
		})()
	});
	const empty = () => (() => {
		var _el$113 = createElement("text");
		insertNode(_el$113, createTextNode(`No delegated sessions`));
		effect((_$p) => setProp(_el$113, "fg", muted(), _$p));
		return _el$113;
	})();
	return (() => {
		var _el$115 = createElement("box"), _el$116 = createElement("text"), _el$117 = createElement("text"), _el$121 = createElement("box"), _el$122 = createElement("text");
		insertNode(_el$115, _el$116);
		insertNode(_el$115, _el$117);
		insertNode(_el$115, _el$121);
		insertNode(_el$115, _el$122);
		setProp(_el$115, "flexDirection", "column");
		setProp(_el$115, "width", "100%");
		setProp(_el$115, "padding", 1);
		insert(_el$115, createComponent(DispatchPanelKeymap, {
			get context() {
				return props.context;
			},
			get panel() {
				return props.panel;
			},
			model
		}), _el$116);
		setProp(_el$116, "attributes", 1);
		insert(_el$116, () => model.title());
		insert(_el$115, createComponent(Show, {
			get when() {
				return model.header();
			},
			children: (line) => (() => {
				var _el$123 = createElement("text");
				insert(_el$123, line);
				effect((_$p) => setProp(_el$123, "fg", muted(), _$p));
				return _el$123;
			})()
		}), _el$117);
		insert(_el$117, () => dispatchPanelRule(props.panel.width - 2));
		insert(_el$115, createComponent(Show, {
			get when() {
				return model.layout().mode === "wide";
			},
			get fallback() {
				return (() => {
					var _el$124 = createElement("box");
					setProp(_el$124, "flexDirection", "column");
					insert(_el$124, createComponent(Show, {
						get when() {
							return model.rows().length > 0;
						},
						get fallback() {
							return empty();
						},
						get children() {
							var _el$125 = createElement("box");
							setProp(_el$125, "flexDirection", "column");
							insert(_el$125, rows);
							return _el$125;
						}
					}), null);
					insert(_el$124, createComponent(Show, {
						get when() {
							return model.selectedID();
						},
						get children() {
							var _el$126 = createElement("box"), _el$127 = createElement("box");
							insertNode(_el$126, _el$127);
							setProp(_el$126, "flexDirection", "column");
							setProp(_el$127, "height", 1);
							insert(_el$126, detail, null);
							return _el$126;
						}
					}), null);
					return _el$124;
				})();
			},
			get children() {
				var _el$118 = createElement("box"), _el$119 = createElement("box");
				insertNode(_el$118, _el$119);
				setProp(_el$118, "flexDirection", "row");
				setProp(_el$119, "flexDirection", "column");
				insert(_el$119, createComponent(Show, {
					get when() {
						return model.rows().length > 0;
					},
					get fallback() {
						return empty();
					},
					get children() {
						return rows();
					}
				}));
				insert(_el$118, createComponent(Show, {
					get when() {
						return model.selectedID();
					},
					get children() {
						var _el$120 = createElement("box");
						setProp(_el$120, "flexDirection", "column");
						insert(_el$120, detail);
						effect((_$p) => setProp(_el$120, "width", model.layout().detailWidth, _$p));
						return _el$120;
					}
				}), null);
				effect((_$p) => setProp(_el$119, "width", model.layout().listWidth, _$p));
				return _el$118;
			}
		}), _el$121);
		setProp(_el$121, "height", 1);
		insert(_el$122, () => model.footer());
		effect((_p$) => {
			var _v$14 = text(), _v$15 = muted(), _v$16 = muted();
			_v$14 !== _p$.e && (_p$.e = setProp(_el$116, "fg", _v$14, _p$.e));
			_v$15 !== _p$.t && (_p$.t = setProp(_el$117, "fg", _v$15, _p$.t));
			_v$16 !== _p$.a && (_p$.a = setProp(_el$122, "fg", _v$16, _p$.a));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0
		});
		return _el$115;
	})();
}
/** App-level command claim: the only way into the panel. It registers the
*  `pantheon.dispatch.open` command (palette + `/dispatch`) and renders nothing;
*  the panel itself lives behind its own `session.panel` claim. */
function DispatchCommandLayer(props) {
	props.context.keymap.layer(() => ({
		mode: "global",
		commands: [{
			id: "pantheon.dispatch.open",
			title: "Pantheon: Dispatch",
			group: "Pantheon",
			palette: true,
			slash: {
				name: "dispatch",
				aliases: ["pantheon-dispatch"]
			},
			run: () => {
				openDispatchPanel(props.context);
			}
		}]
	}));
	return null;
}
/** Command layer for the settings window: palette + `/pantheon-settings`
*  entry, deliberately with no raw keybind — the host already owns a native
*  `/settings` surface (verified against the host command list), so a blind
*  bind would fight it. The window's in-dialog binds stay gated by
*  `enabled: () => open()` inside pantheon-settings.tsx. */
function PantheonSettingsCommandLayer(props) {
	props.context.keymap.layer(() => ({
		mode: "global",
		commands: [
			{
				id: "pantheon.settings.open",
				title: "Pantheon: Settings",
				group: "Pantheon",
				palette: true,
				slash: { name: "pantheon-settings" },
				run: () => {
					openPantheonSettings(props.context);
				}
			},
			{
				id: "pantheon.updates.open",
				title: "Pantheon: Updates & Cleanup",
				group: "Pantheon",
				palette: true,
				slash: { name: "pantheon-updates" },
				run: () => {
					openPantheonSettings(props.context, { initialTab: "updates" });
				}
			},
			{
				id: "pantheon.whats-new.open",
				title: "Pantheon: What's New",
				group: "Pantheon",
				palette: true,
				slash: {
					name: "pantheon-whats-new",
					aliases: ["whats-new"]
				},
				run: () => {
					maybeShowWhatsNew(props.context, { force: true });
				}
			},
			{
				id: "pantheon.artifacts.open",
				title: "Pantheon: Artifacts",
				group: "Pantheon",
				palette: true,
				slash: {
					name: "pantheon-artifacts",
					aliases: ["artifacts"]
				},
				run: () => {
					openArtifactsDialog(props.context, resolveSidebarCwd(props.context));
				}
			},
			{
				id: "pantheon.cockpit.open",
				title: "Pantheon: Mission Control Cockpit",
				group: "Pantheon",
				palette: true,
				slash: {
					name: "pantheon-cockpit",
					aliases: ["cockpit"]
				},
				run: () => {
					openPantheonCockpit(props.context, resolveSidebarCwd(props.context));
				}
			}
		]
	}));
	return null;
}
function useWorkspaceArtifacts(context) {
	const [entries, setEntries] = createSignal(scanPantheonArtifacts(resolveSidebarCwd(context)));
	let lastScan = Date.now();
	const refresh = () => {
		const now = Date.now();
		if (now - lastScan < 1500) return;
		lastScan = now;
		setEntries(scanPantheonArtifacts(resolveSidebarCwd(context)));
	};
	onMount(() => {
		setEntries(scanPantheonArtifacts(resolveSidebarCwd(context)));
		const stop = subscribeSidebarRefresh(context, refresh);
		onCleanup(stop);
	});
	return entries;
}
/** Home-screen status contribution. The sidebar slot is session-scoped, so
*  before the first prompt the sidebar may not mount at all (Known Issue) —
*  this keeps a compact Pantheon line visible on the home footer meanwhile. */
function HomeStatus(props) {
	const preset = useActivePreset(props.context).preset;
	const availableUpdate = useAvailableUpdate("2.2.2");
	const artifacts = useWorkspaceArtifacts(props.context);
	const activePlan = () => artifacts().find((entry) => entry.kind === "plan");
	const isPt = () => resolveLanguage(tuiPrefs().layout?.language) === "pt-BR";
	const accent = () => resolveAccentColor(tuiDraftPreview()?.theme?.accent ?? tuiPrefs().theme?.accent, props.context.theme);
	const muted = () => props.context.theme?.text?.muted ?? props.context.theme?.text?.base;
	const updateBadge = () => formatUpdateBadge("2.2.2", availableUpdate(), {
		isPt: isPt(),
		compact: true
	});
	return createComponent(Show, {
		get when() {
			return tuiPrefs().footer.home;
		},
		get children() {
			var _el$128 = createElement("box"), _el$129 = createElement("text"), _el$132 = createElement("box"), _el$133 = createElement("text");
			insertNode(_el$128, _el$129);
			insertNode(_el$128, _el$132);
			setProp(_el$128, "flexDirection", "row");
			insert(_el$129, () => `Pantheon v2.2.2${preset().name ? ` ▸ ${preset().name}` : ""}`);
			insert(_el$128, createComponent(Show, {
				get when() {
					return updateBadge();
				},
				children: (badge) => (() => {
					var _el$135 = createElement("box"), _el$136 = createElement("text");
					insertNode(_el$135, _el$136);
					setProp(_el$135, "onMouseDown", stopMouseEvent);
					setProp(_el$135, "onMouseUp", (event) => handleMouseClick(event, () => {
						openPantheonSettings(props.context, { initialTab: "updates" });
					}));
					insert(_el$136, () => ` · ${badge()}`);
					effect((_$p) => setProp(_el$136, "fg", accent(), _$p));
					return _el$135;
				})()
			}), _el$132);
			insert(_el$128, createComponent(Show, {
				get when() {
					return activePlan();
				},
				children: (plan) => (() => {
					var _el$137 = createElement("box"), _el$138 = createElement("text");
					insertNode(_el$137, _el$138);
					setProp(_el$137, "onMouseDown", stopMouseEvent);
					setProp(_el$137, "onMouseUp", (event) => handleMouseClick(event, () => {
						openArtifactsDialog(props.context, resolveSidebarCwd(props.context), { initialArtifactId: plan().id });
					}));
					insert(_el$138, () => ` · ▸ Plan: ${truncateLabel(plan().title, 20)}`);
					effect((_$p) => setProp(_el$138, "fg", accent(), _$p));
					return _el$137;
				})()
			}), _el$132);
			insert(_el$128, createComponent(Show, {
				get when() {
					return artifacts().length > 0;
				},
				get children() {
					var _el$130 = createElement("box"), _el$131 = createElement("text");
					insertNode(_el$130, _el$131);
					setProp(_el$130, "onMouseDown", stopMouseEvent);
					setProp(_el$130, "onMouseUp", (event) => handleMouseClick(event, () => {
						openArtifactsDialog(props.context, resolveSidebarCwd(props.context));
					}));
					insert(_el$131, (() => {
						var _c$2 = memo(() => !!isPt());
						return () => _c$2() ? ` · Artefatos (${artifacts().length})` : ` · Artifacts (${artifacts().length})`;
					})());
					effect((_$p) => setProp(_el$131, "fg", muted(), _$p));
					return _el$130;
				}
			}), _el$132);
			insertNode(_el$132, _el$133);
			setProp(_el$132, "onMouseDown", stopMouseEvent);
			setProp(_el$132, "onMouseUp", (event) => handleMouseClick(event, () => {
				openPantheonCockpit(props.context, resolveSidebarCwd(props.context));
			}));
			insertNode(_el$133, createTextNode(` · ◈ Cockpit`));
			effect((_p$) => {
				var _v$17 = muted(), _v$18 = muted();
				_v$17 !== _p$.e && (_p$.e = setProp(_el$129, "fg", _v$17, _p$.e));
				_v$18 !== _p$.t && (_p$.t = setProp(_el$133, "fg", _v$18, _p$.t));
				return _p$;
			}, {
				e: void 0,
				t: void 0
			});
			return _el$128;
		}
	});
}
/** Lean footer model: only the preset label and the live delegation count. It
*  deliberately does not reuse `createSidebarModel` — that model owns the
*  completion toasts and the spinner, and a second instance would double-toast.
*  No session id in the slot input is a graceful no-op (count 0). */
function createFooterModel(context, sessionID) {
	const [revision, setRevision] = createSignal(0);
	const preset = useActivePreset(context).preset;
	const activeSessionID = () => {
		const id = sessionID();
		return isValidSessionID(id) ? id : "";
	};
	const running = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return 0;
		let family = [];
		try {
			const result = context.data.session.family?.(id);
			if (Array.isArray(result)) family = result;
		} catch {
			return 0;
		}
		const now = Date.now();
		let count = 0;
		for (const childID of family) {
			if (childID === id || !isValidSessionID(childID)) continue;
			try {
				const child = context.data.session.get(childID);
				if (child?.parentID !== id) continue;
				if (toDelegationView(child, sessionStatusOf(context, childID), now).state === "running") count += 1;
			} catch {}
		}
		return count;
	});
	onMount(() => {
		onCleanup(subscribeSidebarRefresh(context, () => setRevision((value) => value + 1)));
	});
	return {
		preset,
		running
	};
}
/** Prompt-footer contribution: `▸<preset> · ✦<n> ativos`, appended next to the
*  native line (never replacing it) and only while a delegation is running. */
function PromptFooter(props) {
	const model = createFooterModel(props.context, () => props.sessionID);
	const muted = () => props.context.theme?.text?.muted ?? props.context.theme?.text?.base;
	return createComponent(Show, {
		get when() {
			return memo(() => !!tuiPrefs().footer.prompt)() && model.running() > 0;
		},
		get children() {
			var _el$139 = createElement("text");
			insert(_el$139, () => `▸${model.preset().name ?? "default"} · ✦${model.running()} ativos`);
			effect((_$p) => setProp(_el$139, "fg", muted(), _$p));
			return _el$139;
		}
	});
}
const plugin = Plugin.define({
	id: "pantheon.tui",
	setup(context) {
		const globalState = globalThis;
		if (globalState[SINGLETON]) return;
		globalState[SINGLETON] = true;
		initTuiPrefs(context);
		warmUpSidebarData(context, resolveLocation(context));
		const unregisterSidebar = context.ui.slot({
			append: "sidebar.content",
			render: (slotProps) => createComponent(Sidebar, {
				context,
				get sessionID() {
					return slotProps?.sessionID;
				}
			})
		});
		const unregisterHome = context.ui.slot({
			append: "home.footer.status",
			render: () => createComponent(HomeStatus, { context })
		});
		setAvailableUpdateVersion(resolveCachedAvailableUpdate("2.2.2", updateCheckStateFile().readState()));
		const updateNoticeTimer = setTimeout(() => {
			checkForPantheonUpdate(context).catch(() => {});
		}, 3e3);
		const updateNoticeInterval = setInterval(() => {
			checkForPantheonUpdate(context).catch(() => {});
		}, UPDATE_CHECK_TTL_MS);
		const unregisterPromptFooter = context.ui.slot({
			append: "prompt.footer",
			render: (slotProps) => createComponent(PromptFooter, {
				context,
				get sessionID() {
					return slotProps?.sessionID;
				}
			})
		});
		const unregisterPanel = context.ui.slot({
			append: "session.panel",
			render: (panel) => createComponent(Show, {
				get when() {
					return panel.name === DISPATCH_PANEL_NAME;
				},
				get children() {
					return createComponent(DispatchPanel, {
						context,
						panel
					});
				}
			})
		});
		const unregisterCommands = context.ui.slot({
			append: "app",
			render: () => createComponent(DispatchCommandLayer, { context })
		});
		const unregisterSettingsCommands = context.ui.slot({
			append: "app",
			render: () => createComponent(PantheonSettingsCommandLayer, { context })
		});
		try {
			setupPantheonSettings(context, { renderSidebar: (ctx) => createComponent(Sidebar, { context: ctx }) });
		} catch {}
		try {
			setupPantheonCockpit(context, () => resolveSidebarCwd(context));
		} catch {}
		const unregisterSettingsSlot = context.ui.slot({
			append: "session.composer.top",
			render: (slotProps) => createComponent(PantheonSettingsSlot, {
				context,
				get sessionID() {
					return slotProps?.sessionID ?? "";
				}
			})
		});
		maybeShowWhatsNew(context);
		return () => {
			clearTimeout(updateNoticeTimer);
			clearInterval(updateNoticeInterval);
			if (typeof unregisterSidebar === "function") unregisterSidebar();
			if (typeof unregisterHome === "function") unregisterHome();
			if (typeof unregisterPromptFooter === "function") unregisterPromptFooter();
			if (typeof unregisterPanel === "function") unregisterPanel();
			if (typeof unregisterSettingsSlot === "function") unregisterSettingsSlot();
			if (typeof unregisterCommands === "function") unregisterCommands();
			if (typeof unregisterSettingsCommands === "function") unregisterSettingsCommands();
			delete globalState[SINGLETON];
		};
	}
});
//#endregion
export { BLOCK_ICONS, CONTEXT_BAR_CELLS, CONTEXT_BAR_EMPTY_CELL, CONTEXT_BAR_FILLED_CELL, DELEGATION_CHILD_STATUS_GRACE_MS, DISPATCH_AGENT_CEILING, DISPATCH_AGENT_WIDTH, DISPATCH_COST_WIDTH, DISPATCH_COUNT_WIDTH, DISPATCH_DONE_MARKER, DISPATCH_DURATION_WIDTH, DISPATCH_GROUP_COST_WIDTH, DISPATCH_KIND_ORIGIN_LABELS, DISPATCH_MAX_LINES, DISPATCH_MAX_WIDTH, DISPATCH_MIN_AGENT_WIDTH, DISPATCH_MODEL_WIDTH, DISPATCH_PANEL_AGENT_WIDTH, DISPATCH_PANEL_COMMANDS, DISPATCH_PANEL_COST_WIDTH, DISPATCH_PANEL_DASH, DISPATCH_PANEL_DURATION_WIDTH, DISPATCH_PANEL_EMPTY_TEXT, DISPATCH_PANEL_FULLSCREEN_BADGE, DISPATCH_PANEL_HEADER_MARKER, DISPATCH_PANEL_KIND_WIDTH, DISPATCH_PANEL_MIN_AGENT_WIDTH, DISPATCH_PANEL_NAME, DISPATCH_PANEL_PAGE_SIZE, DISPATCH_PANEL_RULE_CHAR, DISPATCH_PANEL_SELECTION_GUTTER, DISPATCH_PANEL_SELECTION_MARKER, DISPATCH_PANEL_TITLE_WIDTH, DISPATCH_PANEL_TOAST, DISPATCH_PANEL_WIDE_MIN_WIDTH, DISPATCH_RUNNING_CEILING, GIT_ARROW_DOWN, GIT_ARROW_UP, GIT_CHANGES_DEBOUNCE_MS, GIT_CLI_DEBOUNCE_MS, GIT_CLI_MAX_BUFFER, GIT_CLI_MIN_INTERVAL_MS, GIT_CLI_TIMEOUT_MS, HEADER_MAX_WIDTH, MODEL_USAGE_COST_WIDTH, MODEL_USAGE_DEBOUNCE_MS, MODEL_USAGE_MESSAGE_LIMIT, MODEL_USAGE_MODEL_WIDTH, MODEL_USAGE_SESSION_LIMIT, MODEL_USAGE_TOKEN_WIDTH, MODEL_USAGE_VISIBLE_CEILING, PRESET_MARKER, SIDEBAR_REFRESH_EVENTS, SIDEBAR_WAITING_LABEL, SPEND_30D_LABEL, SPEND_30D_MS, SPEND_LINE_SEPARATOR, SPEND_PROBE_TOLERANCE_MS, SPEND_PROBE_WINDOW_MS, SPEND_REFRESH_DEBOUNCE_MS, SPEND_TODAY_LABEL, TODO_TEXT_WIDTH, TODO_VISIBLE_CEILING, UNKNOWN_AGENT, agentKey, buildDispatchBlock, cacheHitPercent, ceilingModelUsage, ceilingTodoItems, cellWidth, childAgentRowText, classifyDispatchKind, classifyToolPart, collectChildAgentUsage, collectDispatch, collectModelUsage, collectSubagentCalls, collectWarmupTargets, completedSummaryText, computeContextUsage, contextBar, contextBarFilled, contextBlockRows, contextPerformanceLine, contextProgressColor, contextSpendLine, contextSpendLines, contextUsageTone, countGitChanges, countSessionCompactions, countToolCalls, countUserTurns, createDispatchPanelModel, createFooterModel, createSidebarModel, plugin as default, defaultGitExec, delegationStateFromOutcome, delegationStateFromStatus, detectDelegationCompletions, dispatchAgentText, dispatchElapsed, dispatchHeaderSummary, dispatchKindFromAgent, dispatchKindFromPrefix, dispatchKindSuffix, dispatchModelText, dispatchPanelCell, dispatchPanelDetail, dispatchPanelFooter, dispatchPanelHeader, dispatchPanelKeymapLayer, dispatchPanelLayout, dispatchPanelMarker, dispatchPanelRangeText, dispatchPanelRowText, dispatchPanelRows, dispatchPanelRule, dispatchPanelTitle, dispatchPanelWindow, dispatchTokenLine, dispatchTokens, dispatchTotalCost, enrichDispatchEntries, extractChildActivity, extractCompactionInfo, extractTokenAnatomy, failedSuffixText, formatCompactionBadge, formatContextWindow, formatDispatchCost, formatDispatchDuration, formatGitChanges, formatGitSnapshot, formatSpendUSD, formatSpent, formatTokenAnatomyLine, formatTokenAnatomySplit, formatTokenCount, formatToolCallLine, formatToolDomainLine, formatTurnCostLine, formatTurnCostUSD, formatTurnsBadge, formatUsageCost, formatUsageTokens, gitProbeAllowed, hiddenChildAgentsText, hiddenModelUsageText, hiddenTodoText, isTodoStatus, isValidSessionID, lastAssistantWithTokens, latestTodoItems, latestTurnCost, messageTokensTotal, modelRefID, modelUsageRowLines, modelUsageRowText, modelUsageRows, navigateToSession, openDispatchPanel, orderDispatchEntries, orderTodoItems, padCell, parseGitAheadBehind, parseGitStatusPorcelain, parsePresetOverrides, parseTodoItems, performDispatchPanelAction, presetFromEnv, presetHeaderLine, providerIDFromModels, providerIDFromRef, readGitSnapshot, resetSpendUnit, resolveActiveModelRef, resolveActivePresetForTui, resolveContextLimit, resolveGateStatus, resolveModelContextSnapshot, resolvedSpendUnit, runDispatchPanelCommand, runningChildRowText, shortModelID, shortSessionID, sidebarMoneyLines, sidebarPlaceholder, sidebarTextLines, spendWindows, spinnerFrame, startOfLocalDay, statsCost, statsRangeMatches, summarizeToolDomains, toDelegationView, toDispatchEntry, todoRowText, todoTone, transcriptWindow, truncateLabel, turnTokensPerSecond, withBlockSpacers };

//# sourceMappingURL=tui.js.map
