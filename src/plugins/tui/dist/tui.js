import { createComponent, createElement, createTextNode, effect, insert, insertNode, memo, setProp } from "@opentui/solid";
import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
//#region src/index.tsx
/** @jsxImportSource @opentui/solid */
const BAR_WIDTH = 20;
const COMMANDS = [
	{
		name: "/pantheon",
		desc: "Council synthesis"
	},
	{
		name: "/pantheon-status",
		desc: "System status"
	},
	{
		name: "/pantheon-audit",
		desc: "Full audit"
	},
	{
		name: "/pantheon-bg",
		desc: "List background tasks"
	},
	{
		name: "/pantheon-cancel",
		desc: "Cancel task"
	},
	{
		name: "/pantheon-deepwork",
		desc: "Deep work mode"
	},
	{
		name: "/pantheon-focus",
		desc: "Focus on scope"
	},
	{
		name: "/pantheon-remember",
		desc: "Memory store/recall"
	},
	{
		name: "/pantheon-search",
		desc: "Memory search"
	},
	{
		name: "/pantheon-consolidate",
		desc: "Merge memories"
	},
	{
		name: "/pantheon-forget",
		desc: "Compress memories"
	}
];
const AGENTS = [
	{
		name: "zeus",
		tier: "default",
		role: "Orchestrator"
	},
	{
		name: "athena",
		tier: "premium",
		role: "Strategic planner"
	},
	{
		name: "apollo",
		tier: "fast",
		role: "Codebase discovery"
	},
	{
		name: "hermes",
		tier: "default",
		role: "Backend"
	},
	{
		name: "aphrodite",
		tier: "default",
		role: "Frontend"
	},
	{
		name: "demeter",
		tier: "default",
		role: "Database"
	},
	{
		name: "themis",
		tier: "premium",
		role: "Quality & security"
	},
	{
		name: "prometheus",
		tier: "default",
		role: "Infrastructure"
	},
	{
		name: "hephaestus",
		tier: "default",
		role: "AI pipelines"
	},
	{
		name: "nyx",
		tier: "fast",
		role: "Observability"
	},
	{
		name: "gaia",
		tier: "fast",
		role: "Remote sensing"
	},
	{
		name: "iris",
		tier: "fast",
		role: "GitHub operations"
	},
	{
		name: "mnemosyne",
		tier: "fast",
		role: "Memory bank"
	},
	{
		name: "talos",
		tier: "fast",
		role: "Hotfixes"
	}
];
function safeNum(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function fmtInt(n) {
	return Intl.NumberFormat("en-US").format(Math.max(0, Math.round(n)));
}
function fmtCost(v) {
	if (v <= 0) return "";
	if (v < .01) return "<$0.01";
	return `$${v.toFixed(2)}`;
}
function msgTokens(msg) {
	const t = msg?.tokens ?? msg?.info?.tokens ?? {};
	return safeNum(t.input) + safeNum(t.output) + safeNum(t.reasoning) + safeNum(t?.cache?.read) + safeNum(t?.cache?.write);
}
function msgCost(src) {
	for (const c of [
		src?.cost,
		src?.info?.cost,
		src?.usage?.cost
	]) if (typeof c === "number" && c > 0) return c;
	return 0;
}
function buildBar(pct) {
	const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(Math.max(0, Math.min(100, pct)) / 100 * BAR_WIDTH)));
	return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}
async function detectVersion(api) {
	try {
		const wt = api.state.path?.worktree ?? "";
		const fp = wt ? `${wt}/package.json` : "package.json";
		const result = await api.client.file.read({ query: { path: fp } });
		const match = String(result?.content ?? "").match(/"version":\s*"([^"]+)"/);
		if (match?.[1]) return match[1];
	} catch {}
	try {
		const proc = api.client?.process;
		if (typeof proc?.exec === "function") {
			const r = await proc.exec({
				command: "git",
				args: [
					"describe",
					"--tags",
					"--always"
				],
				timeoutMs: 3e3
			});
			const tag = (r.stdout ?? r.output ?? "").trim().replace(/^v/, "").replace(/-\d+-g[0-9a-f]+$/, "");
			if (tag && tag !== "5.0.0") return tag;
		}
	} catch {}
	try {
		const proc = api.client?.process;
		if (typeof proc?.exec === "function") {
			const r = await proc.exec({
				command: "opencode",
				args: ["--version"],
				timeoutMs: 3e3
			});
			const ver = (r.stdout ?? r.output ?? "").trim().replace(/^v/, "");
			if (ver) return ver;
		}
	} catch {}
	return null;
}
function ContextBar(props) {
	const messages = createMemo(() => {
		try {
			return props.api.state.session.messages(props.sessionID) ?? [];
		} catch {
			return [];
		}
	});
	const usage = createMemo(() => {
		const lastAssistant = [...messages()].reverse().find((m) => {
			return (m?.role ?? m?.info?.role) === "assistant" && safeNum(m?.tokens?.output) > 0;
		});
		if (!lastAssistant) return null;
		const tokens = msgTokens(lastAssistant);
		const pid = lastAssistant?.providerID ?? lastAssistant?.info?.providerID;
		const mid = lastAssistant?.modelID ?? lastAssistant?.info?.modelID;
		const ctxLimit = safeNum((pid ? (props.api.state.provider ?? []).find((p) => p.id === pid) : null)?.models?.[mid ?? ""]?.limit?.context);
		return {
			tokens,
			limit: ctxLimit > 0 ? ctxLimit : 2e5,
			percent: ctxLimit > 0 ? Math.round(tokens / ctxLimit * 100) : 0
		};
	});
	const totalCost = createMemo(() => {
		const state = props.api.state.session?.get?.(props.sessionID);
		const fromState = msgCost(state);
		if (fromState > 0) return fromState;
		return messages().reduce((sum, m) => sum + msgCost(m), 0);
	});
	const theme = () => props.api.theme.current;
	return createComponent(Show, {
		get when() {
			return usage();
		},
		children: (u) => {
			const pct = u().percent;
			const c = theme();
			const barColor = pct >= 90 ? c.error : pct >= 70 ? c.warning : c.accent;
			const costStr = fmtCost(totalCost());
			return (() => {
				var _el$ = createElement("box"), _el$2 = createElement("box"), _el$3 = createElement("text"), _el$5 = createElement("text"), _el$6 = createElement("text"), _el$7 = createElement("text");
				insertNode(_el$, _el$2);
				insertNode(_el$, _el$7);
				setProp(_el$, "flexDirection", "column");
				insertNode(_el$2, _el$3);
				insertNode(_el$2, _el$5);
				insertNode(_el$2, _el$6);
				setProp(_el$2, "flexDirection", "row");
				setProp(_el$2, "gap", 1);
				insertNode(_el$3, createTextNode(`Context`));
				setProp(_el$3, "attributes", { bold: true });
				setProp(_el$5, "fg", barColor);
				insert(_el$5, () => buildBar(pct));
				setProp(_el$6, "fg", barColor);
				insert(_el$6, `${pct}%`);
				insert(_el$7, () => `${fmtInt(u().tokens)} / ${fmtInt(u().limit)} tok${costStr ? `  ${costStr}` : ""}`);
				effect((_p$) => {
					var _v$ = c.text, _v$2 = c.textMuted;
					_v$ !== _p$.e && (_p$.e = setProp(_el$3, "fg", _v$, _p$.e));
					_v$2 !== _p$.t && (_p$.t = setProp(_el$7, "fg", _v$2, _p$.t));
					return _p$;
				}, {
					e: void 0,
					t: void 0
				});
				return _el$;
			})();
		}
	});
}
function SessionRow(props) {
	const theme = () => props.api.theme.current;
	const status = createMemo(() => {
		try {
			const s = props.api.state.session?.status?.(props.session.id);
			if (s?.type) return s.type;
		} catch {}
		return null;
	});
	const statusIcon = createMemo(() => {
		switch (status()) {
			case "busy": return "● ";
			case "retry": return "⚠ ";
			default: return "";
		}
	});
	return (() => {
		var _el$8 = createElement("text");
		insert(_el$8, () => `${statusIcon()}${props.session?.id?.slice(0, 8) ?? "????"}... ${props.session?.title?.slice(0, 26) ?? "(untitled)"}`);
		effect((_$p) => setProp(_el$8, "fg", theme().textMuted, _$p));
		return _el$8;
	})();
}
function View(props) {
	const [showCommands, setShowCommands] = createSignal(false);
	const [showAgents, setShowAgents] = createSignal(false);
	const [showConfig, setShowConfig] = createSignal(false);
	const [showSessions, setShowSessions] = createSignal(false);
	const theme = () => props.api.theme.current;
	const branch = createMemo(() => props.api.state.vcs?.branch ? `\u2387 ${props.api.state.vcs.branch}` : null);
	const [sessionList, { refetch: refetchSessions }] = createResource(async () => {
		try {
			return await props.api.client?.session?.list?.({ limit: 100 }) ?? { data: [] };
		} catch {
			return { data: [] };
		}
	});
	const totalSessions = createMemo(() => {
		const result = sessionList();
		if (!result) return 0;
		const data = result.data ?? result;
		if (!Array.isArray(data)) return 0;
		return data.filter((s) => !s.parentID).length;
	});
	const recentSessions = createMemo(() => {
		const result = sessionList();
		if (!result) return [];
		const data = result.data ?? result;
		if (!Array.isArray(data)) return [];
		return data.filter((s) => !s.parentID && s.id !== props.sessionID).sort((a, b) => {
			const ta = a.time?.updated ?? a.updated ?? 0;
			return (b.time?.updated ?? b.updated ?? 0) - ta;
		}).slice(0, 8);
	});
	const [memoryCount, setMemoryCount] = createSignal(null);
	onMount(() => {
		const cleanup = [];
		try {
			cleanup.push(props.api.event.on("session.status", refetchSessions));
			cleanup.push(props.api.event.on("session.created", refetchSessions));
			cleanup.push(props.api.event.on("session.updated", refetchSessions));
			cleanup.push(props.api.event.on("session.deleted", refetchSessions));
		} catch {}
		try {
			const ev = props.api.event;
			if (typeof ev?.on === "function") {
				cleanup.push(ev.on("memory.created", () => setMemoryCount((c) => c !== null ? c + 1 : 1)));
				cleanup.push(ev.on("memory.deleted", () => setMemoryCount((c) => c !== null ? Math.max(0, c - 1) : 0)));
			}
		} catch {}
		onCleanup(() => cleanup.forEach((fn) => fn()));
	});
	const configSummary = createMemo(() => {
		const cfg = props.api.state.config;
		if (!cfg) return null;
		return {
			mcpCount: cfg.mcp ? Object.keys(cfg.mcp).length : 0,
			pluginCount: Array.isArray(cfg.plugin) ? cfg.plugin.length : 0,
			autoCompaction: cfg.compaction?.auto === true
		};
	});
	const HR = () => (() => {
		var _el$9 = createElement("text");
		insertNode(_el$9, createTextNode(`────────────────────────────`));
		effect((_$p) => setProp(_el$9, "fg", theme().textMuted, _$p));
		return _el$9;
	})();
	return (() => {
		var _el$1 = createElement("box"), _el$10 = createElement("text"), _el$11 = createElement("box"), _el$12 = createElement("text"), _el$13 = createElement("text"), _el$15 = createElement("box"), _el$16 = createElement("text"), _el$17 = createElement("text"), _el$19 = createElement("box"), _el$20 = createElement("text"), _el$21 = createElement("text"), _el$23 = createElement("box"), _el$24 = createElement("text"), _el$25 = createElement("box"), _el$26 = createElement("text");
		insertNode(_el$1, _el$10);
		insertNode(_el$1, _el$11);
		insertNode(_el$1, _el$15);
		insertNode(_el$1, _el$19);
		insertNode(_el$1, _el$23);
		insertNode(_el$1, _el$25);
		setProp(_el$1, "flexDirection", "column");
		setProp(_el$1, "width", "100%");
		setProp(_el$10, "attributes", { bold: true });
		insert(_el$10, () => `Pantheon${props.version ? ` v${props.version}` : ""}`);
		insert(_el$1, createComponent(Show, {
			get when() {
				return branch();
			},
			children: (b) => (() => {
				var _el$27 = createElement("text");
				insert(_el$27, b);
				effect((_$p) => setProp(_el$27, "fg", theme().textMuted, _$p));
				return _el$27;
			})()
		}), _el$11);
		insert(_el$1, createComponent(HR, {}), _el$11);
		insert(_el$1, createComponent(ContextBar, {
			get api() {
				return props.api;
			},
			get sessionID() {
				return props.sessionID;
			}
		}), _el$11);
		insert(_el$1, createComponent(HR, {}), _el$11);
		insertNode(_el$11, _el$12);
		insertNode(_el$11, _el$13);
		setProp(_el$11, "onMouseDown", () => setShowSessions((x) => !x));
		setProp(_el$12, "attributes", { bold: true });
		insert(_el$12, () => `${showSessions() ? "▼" : "▶"} Sessions`);
		insert(_el$13, () => ` (${String(totalSessions())})`);
		insert(_el$1, createComponent(Show, {
			get when() {
				return showSessions();
			},
			get children() {
				return createComponent(Show, {
					get when() {
						return recentSessions().length > 0;
					},
					get fallback() {
						return (() => {
							var _el$28 = createElement("box"), _el$29 = createElement("text");
							insertNode(_el$28, _el$29);
							setProp(_el$28, "marginLeft", 1);
							insertNode(_el$29, createTextNode(`No recent sessions`));
							effect((_$p) => setProp(_el$29, "fg", theme().textMuted, _$p));
							return _el$28;
						})();
					},
					get children() {
						var _el$14 = createElement("box");
						setProp(_el$14, "marginLeft", 1);
						setProp(_el$14, "flexDirection", "column");
						insert(_el$14, createComponent(For, {
							get each() {
								return recentSessions();
							},
							children: (ses) => createComponent(SessionRow, {
								get api() {
									return props.api;
								},
								session: ses
							})
						}));
						return _el$14;
					}
				});
			}
		}), _el$15);
		insertNode(_el$15, _el$16);
		insertNode(_el$15, _el$17);
		setProp(_el$15, "onMouseDown", () => setShowCommands((x) => !x));
		setProp(_el$16, "attributes", { bold: true });
		insert(_el$16, () => `${showCommands() ? "▼" : "▶"} Commands`);
		insert(_el$17, () => ` (${String(COMMANDS.length)})`);
		insert(_el$1, createComponent(Show, {
			get when() {
				return showCommands();
			},
			get children() {
				var _el$18 = createElement("box");
				setProp(_el$18, "marginLeft", 1);
				setProp(_el$18, "flexDirection", "column");
				insert(_el$18, createComponent(For, {
					each: COMMANDS,
					children: (cmd) => (() => {
						var _el$31 = createElement("box"), _el$32 = createElement("text"), _el$33 = createElement("text");
						insertNode(_el$31, _el$32);
						insertNode(_el$31, _el$33);
						setProp(_el$31, "onMouseDown", (e) => {
							e.stopPropagation();
							try {
								const cmdApi = props.api.command;
								const cmdName = cmd.name.replace("/", "");
								if (cmdApi?.trigger?.(cmdName)) return;
							} catch {}
							props.api.ui?.toast?.({
								title: "Command",
								message: `Type ${cmd.name} in chat`
							});
						});
						insert(_el$32, () => cmd.name);
						insert(_el$33, () => ` \u2014 ${cmd.desc}`);
						effect((_p$) => {
							var _v$10 = cmd.name === "/pantheon" ? theme().accent : theme().textMuted, _v$11 = theme().textMuted;
							_v$10 !== _p$.e && (_p$.e = setProp(_el$32, "fg", _v$10, _p$.e));
							_v$11 !== _p$.t && (_p$.t = setProp(_el$33, "fg", _v$11, _p$.t));
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$31;
					})()
				}));
				return _el$18;
			}
		}), _el$19);
		insertNode(_el$19, _el$20);
		insertNode(_el$19, _el$21);
		setProp(_el$19, "onMouseDown", () => setShowAgents((x) => !x));
		setProp(_el$20, "attributes", { bold: true });
		insert(_el$20, () => `${showAgents() ? "▼" : "▶"} Agents`);
		insert(_el$21, () => ` (${String(AGENTS.length)})`);
		insert(_el$1, createComponent(Show, {
			get when() {
				return showAgents();
			},
			get children() {
				var _el$22 = createElement("box");
				setProp(_el$22, "marginLeft", 1);
				setProp(_el$22, "flexDirection", "column");
				insert(_el$22, createComponent(For, {
					each: AGENTS,
					children: (agent) => (() => {
						var _el$34 = createElement("box"), _el$35 = createElement("text"), _el$36 = createElement("text");
						insertNode(_el$34, _el$35);
						insertNode(_el$34, _el$36);
						insert(_el$35, () => `${agent.tier === "premium" ? "✦ " : "· "}${agent.name}`);
						insert(_el$36, () => ` \u2014 ${agent.role}`);
						effect((_p$) => {
							var _v$12 = agent.tier === "premium" ? theme().accent : theme().textMuted, _v$13 = theme().textMuted;
							_v$12 !== _p$.e && (_p$.e = setProp(_el$35, "fg", _v$12, _p$.e));
							_v$13 !== _p$.t && (_p$.t = setProp(_el$36, "fg", _v$13, _p$.t));
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$34;
					})()
				}));
				return _el$22;
			}
		}), _el$23);
		insertNode(_el$23, _el$24);
		setProp(_el$23, "onMouseDown", () => setShowConfig((x) => !x));
		setProp(_el$24, "attributes", { bold: true });
		insert(_el$24, () => `${showConfig() ? "▼" : "▶"} Config`);
		insert(_el$1, createComponent(Show, {
			get when() {
				return showConfig();
			},
			get children() {
				return createComponent(Show, {
					get when() {
						return configSummary();
					},
					get fallback() {
						return (() => {
							var _el$37 = createElement("box"), _el$38 = createElement("text");
							insertNode(_el$37, _el$38);
							setProp(_el$37, "marginLeft", 1);
							insertNode(_el$38, createTextNode(`No config data`));
							effect((_$p) => setProp(_el$38, "fg", theme().textMuted, _$p));
							return _el$37;
						})();
					},
					children: (cfg) => (() => {
						var _el$40 = createElement("box"), _el$41 = createElement("text"), _el$42 = createElement("text");
						insertNode(_el$40, _el$41);
						insertNode(_el$40, _el$42);
						setProp(_el$40, "marginLeft", 1);
						setProp(_el$40, "flexDirection", "column");
						insert(_el$41, () => `MCP: ${String(cfg().mcpCount)}  Plugins: ${String(cfg().pluginCount)}`);
						insert(_el$42, () => `Auto-compaction: ${cfg().autoCompaction ? "ON" : "OFF"}`);
						effect((_p$) => {
							var _v$14 = theme().textMuted, _v$15 = theme().textMuted;
							_v$14 !== _p$.e && (_p$.e = setProp(_el$41, "fg", _v$14, _p$.e));
							_v$15 !== _p$.t && (_p$.t = setProp(_el$42, "fg", _v$15, _p$.t));
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$40;
					})()
				});
			}
		}), _el$25);
		insertNode(_el$25, _el$26);
		setProp(_el$25, "marginTop", 1);
		insert(_el$26, (() => {
			var _c$ = memo(() => memoryCount() !== null);
			return () => _c$() ? `Memory: ${fmtInt(memoryCount())} entries` : "Memory: N/A";
		})());
		effect((_p$) => {
			var _v$3 = theme().accent, _v$4 = theme().text, _v$5 = theme().textMuted, _v$6 = theme().text, _v$7 = theme().textMuted, _v$8 = theme().text, _v$9 = theme().textMuted, _v$0 = theme().text, _v$1 = theme().textMuted;
			_v$3 !== _p$.e && (_p$.e = setProp(_el$10, "fg", _v$3, _p$.e));
			_v$4 !== _p$.t && (_p$.t = setProp(_el$12, "fg", _v$4, _p$.t));
			_v$5 !== _p$.a && (_p$.a = setProp(_el$13, "fg", _v$5, _p$.a));
			_v$6 !== _p$.o && (_p$.o = setProp(_el$16, "fg", _v$6, _p$.o));
			_v$7 !== _p$.i && (_p$.i = setProp(_el$17, "fg", _v$7, _p$.i));
			_v$8 !== _p$.n && (_p$.n = setProp(_el$20, "fg", _v$8, _p$.n));
			_v$9 !== _p$.s && (_p$.s = setProp(_el$21, "fg", _v$9, _p$.s));
			_v$0 !== _p$.h && (_p$.h = setProp(_el$24, "fg", _v$0, _p$.h));
			_v$1 !== _p$.r && (_p$.r = setProp(_el$26, "fg", _v$1, _p$.r));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0,
			o: void 0,
			i: void 0,
			n: void 0,
			s: void 0,
			h: void 0,
			r: void 0
		});
		return _el$1;
	})();
}
const tui = async (api, _options, _meta) => {
	const version = await detectVersion(api);
	api.slots.register({
		order: 900,
		slots: { sidebar_content(_ctx, props) {
			return createComponent(View, {
				api,
				get sessionID() {
					return props.session_id;
				},
				version
			});
		} }
	});
};
const plugin = {
	id: "pantheon.tui",
	tui
};
//#endregion
export { plugin as default };

//# sourceMappingURL=tui.js.map