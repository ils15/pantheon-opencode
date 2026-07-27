import { createComponent, createElement, createTextNode, effect, insert, insertNode, memo, setProp } from "@opentui/solid";
import { For, Show, createMemo, createResource, createSignal } from "solid-js";
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
async function fetchRecentSessions(api, sessionID) {
	try {
		const proc = api.client?.process;
		if (typeof proc?.exec !== "function") return null;
		const result = await proc.exec({
			command: "opencode",
			args: [
				"session",
				"list",
				"--format",
				"json",
				"--max-count",
				"20"
			],
			timeoutMs: 5e3
		});
		const stdout = result.stdout ?? result.output ?? "";
		const sessions = JSON.parse(stdout);
		if (!Array.isArray(sessions)) return null;
		return sessions.filter((s) => s.id !== sessionID).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, 8);
	} catch {
		return null;
	}
}
function View(props) {
	const [showCommands, setShowCommands] = createSignal(false);
	const [showAgents, setShowAgents] = createSignal(false);
	const [showConfig, setShowConfig] = createSignal(false);
	const [showSessions, setShowSessions] = createSignal(false);
	const theme = () => props.api.theme.current;
	const branch = createMemo(() => props.api.state.vcs?.branch ? `\u2387 ${props.api.state.vcs.branch}` : null);
	const totalSessions = createMemo(() => {
		try {
			return props.api.state.session.count();
		} catch {
			return 0;
		}
	});
	const memoryCount = createMemo(() => {
		const mem = props.api.state.memory;
		return safeNum(mem?.entries) || safeNum(mem?.count);
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
	const [sessions] = createResource(() => showSessions(), () => fetchRecentSessions(props.api, props.sessionID));
	const HR = () => (() => {
		var _el$8 = createElement("text");
		insertNode(_el$8, createTextNode(`────────────────────────────`));
		effect((_$p) => setProp(_el$8, "fg", theme().textMuted, _$p));
		return _el$8;
	})();
	return (() => {
		var _el$0 = createElement("box"), _el$1 = createElement("text"), _el$10 = createElement("box"), _el$11 = createElement("text"), _el$12 = createElement("text"), _el$13 = createElement("box"), _el$14 = createElement("text"), _el$15 = createElement("text"), _el$17 = createElement("box"), _el$18 = createElement("text"), _el$19 = createElement("text"), _el$21 = createElement("box"), _el$22 = createElement("text"), _el$23 = createElement("box"), _el$24 = createElement("text");
		insertNode(_el$0, _el$1);
		insertNode(_el$0, _el$10);
		insertNode(_el$0, _el$13);
		insertNode(_el$0, _el$17);
		insertNode(_el$0, _el$21);
		insertNode(_el$0, _el$23);
		setProp(_el$0, "flexDirection", "column");
		setProp(_el$0, "width", "100%");
		setProp(_el$1, "attributes", { bold: true });
		insert(_el$1, () => `Pantheon${props.version ? ` v${props.version}` : ""}`);
		insert(_el$0, createComponent(Show, {
			get when() {
				return branch();
			},
			children: (b) => (() => {
				var _el$25 = createElement("text");
				insert(_el$25, b);
				effect((_$p) => setProp(_el$25, "fg", theme().textMuted, _$p));
				return _el$25;
			})()
		}), _el$10);
		insert(_el$0, createComponent(HR, {}), _el$10);
		insert(_el$0, createComponent(ContextBar, {
			get api() {
				return props.api;
			},
			get sessionID() {
				return props.sessionID;
			}
		}), _el$10);
		insert(_el$0, createComponent(HR, {}), _el$10);
		insertNode(_el$10, _el$11);
		insertNode(_el$10, _el$12);
		setProp(_el$10, "onMouseDown", () => setShowSessions((x) => !x));
		setProp(_el$11, "attributes", { bold: true });
		insert(_el$11, () => `${showSessions() ? "▼" : "▶"} Sessions`);
		insert(_el$12, () => ` (${String(totalSessions())})`);
		insert(_el$0, createComponent(Show, {
			get when() {
				return memo(() => !!showSessions())() && sessions();
			},
			children: (s) => createComponent(Show, {
				get when() {
					return s().length > 0;
				},
				get fallback() {
					return (() => {
						var _el$27 = createElement("box"), _el$28 = createElement("text");
						insertNode(_el$27, _el$28);
						setProp(_el$27, "marginLeft", 1);
						insertNode(_el$28, createTextNode(`No recent sessions`));
						effect((_$p) => setProp(_el$28, "fg", theme().textMuted, _$p));
						return _el$27;
					})();
				},
				get children() {
					var _el$26 = createElement("box");
					setProp(_el$26, "marginLeft", 1);
					setProp(_el$26, "flexDirection", "column");
					insert(_el$26, createComponent(For, {
						get each() {
							return s();
						},
						children: (ses) => (() => {
							var _el$30 = createElement("text");
							insert(_el$30, () => `${ses.id.slice(0, 8)}... ${ses.title?.slice(0, 28) ?? "(untitled)"}`);
							effect((_$p) => setProp(_el$30, "fg", theme().textMuted, _$p));
							return _el$30;
						})()
					}));
					return _el$26;
				}
			})
		}), _el$13);
		insertNode(_el$13, _el$14);
		insertNode(_el$13, _el$15);
		setProp(_el$13, "onMouseDown", () => setShowCommands((x) => !x));
		setProp(_el$14, "attributes", { bold: true });
		insert(_el$14, () => `${showCommands() ? "▼" : "▶"} Commands`);
		insert(_el$15, () => ` (${String(COMMANDS.length)})`);
		insert(_el$0, createComponent(Show, {
			get when() {
				return showCommands();
			},
			get children() {
				var _el$16 = createElement("box");
				setProp(_el$16, "marginLeft", 1);
				setProp(_el$16, "flexDirection", "column");
				insert(_el$16, createComponent(For, {
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
				return _el$16;
			}
		}), _el$17);
		insertNode(_el$17, _el$18);
		insertNode(_el$17, _el$19);
		setProp(_el$17, "onMouseDown", () => setShowAgents((x) => !x));
		setProp(_el$18, "attributes", { bold: true });
		insert(_el$18, () => `${showAgents() ? "▼" : "▶"} Agents`);
		insert(_el$19, () => ` (${String(AGENTS.length)})`);
		insert(_el$0, createComponent(Show, {
			get when() {
				return showAgents();
			},
			get children() {
				var _el$20 = createElement("box");
				setProp(_el$20, "marginLeft", 1);
				setProp(_el$20, "flexDirection", "column");
				insert(_el$20, createComponent(For, {
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
				return _el$20;
			}
		}), _el$21);
		insertNode(_el$21, _el$22);
		setProp(_el$21, "onMouseDown", () => setShowConfig((x) => !x));
		setProp(_el$22, "attributes", { bold: true });
		insert(_el$22, () => `${showConfig() ? "▼" : "▶"} Config`);
		insert(_el$0, createComponent(Show, {
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
		}), _el$23);
		insertNode(_el$23, _el$24);
		setProp(_el$23, "marginTop", 1);
		insert(_el$24, () => `Memory: ${memoryCount() > 0 ? `${fmtInt(memoryCount())} entries` : "0 entries"}`);
		effect((_p$) => {
			var _v$3 = theme().accent, _v$4 = theme().text, _v$5 = theme().textMuted, _v$6 = theme().text, _v$7 = theme().textMuted, _v$8 = theme().text, _v$9 = theme().textMuted, _v$0 = theme().text, _v$1 = theme().textMuted;
			_v$3 !== _p$.e && (_p$.e = setProp(_el$1, "fg", _v$3, _p$.e));
			_v$4 !== _p$.t && (_p$.t = setProp(_el$11, "fg", _v$4, _p$.t));
			_v$5 !== _p$.a && (_p$.a = setProp(_el$12, "fg", _v$5, _p$.a));
			_v$6 !== _p$.o && (_p$.o = setProp(_el$14, "fg", _v$6, _p$.o));
			_v$7 !== _p$.i && (_p$.i = setProp(_el$15, "fg", _v$7, _p$.i));
			_v$8 !== _p$.n && (_p$.n = setProp(_el$18, "fg", _v$8, _p$.n));
			_v$9 !== _p$.s && (_p$.s = setProp(_el$19, "fg", _v$9, _p$.s));
			_v$0 !== _p$.h && (_p$.h = setProp(_el$22, "fg", _v$0, _p$.h));
			_v$1 !== _p$.r && (_p$.r = setProp(_el$24, "fg", _v$1, _p$.r));
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
		return _el$0;
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