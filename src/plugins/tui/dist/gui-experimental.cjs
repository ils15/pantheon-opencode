let solid_js_web = require("solid-js/web");
let node_fs = require("node:fs");
let node_path = require("node:path");
let _opencode_plugin_gui = require("@opencode/plugin/gui");
let effect = require("effect");
let solid_js = require("solid-js");
//#region src/gui.tsx
/** @jsxImportSource solid-js */
/**
* gui.tsx — Native OpenCode Desktop GUI plugin (`./gui-experimental`).
*
* Provides:
* - Side Panel (`Pantheon Cockpit`) with Olympus Topology (DAG + Timeline/Gantt
*   + replay scrubber), Agora Board (`#seq` stream), Ephemeral & Bots, Settings.
* - Native `SettingsPage` (`Pantheon`) in Desktop Settings.
* - Slash commands `/pantheon-cockpit` and `/pantheon-settings`.
* - Electron `main(ctx)` IPC bridge reading `.pantheon/` state files safely.
*/
var _tmpl$ = /*#__PURE__*/ (0, solid_js_web.template)(`<svg viewBox="0 0 640 200"style=width:100%;height:200px><title>Olympus Topology DAG</title><rect x=245 y=10 width=150 height=36 rx=6 fill=none stroke=#fba970 stroke-width=2></rect><text x=320 y=32 text-anchor=middle fill=currentColor font-size=12 font-weight=600>zeus (root)`);
var _tmpl$2 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:10px><div style=display:flex;justify-content:space-between;align-items:center><div style=display:flex;align-items:center;gap:8px><input type=range min=0><span style=opacity:0.75></span></div><div style=display:flex;gap:6px><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);cursor:pointer">DAG Pillars</button><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);cursor:pointer">Timeline`);
var _tmpl$3 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:6px>`);
var _tmpl$4 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:8px>`);
var _tmpl$5 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:8px><div></div><div style=opacity:0.75>Open Desktop Settings → Pantheon for full configuration, or use /pantheon-settings in TUI.`);
var _tmpl$6 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:10px;padding:12px;font-size:12px;height:100%;overflow:auto><div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border-weak-base, #2e2e32);padding-bottom:8px"><div style=display:flex;align-items:center;gap:8px><span style=font-weight:600>Pantheon Cockpit</span><span style=opacity:0.7>v2.3.3</span></div><div style=display:flex;align-items:center;gap:10px><span style=opacity:0.8></span><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:transparent;color:inherit;cursor:pointer">Refresh</button></div></div><div style="display:flex;gap:12px;border-bottom:1px solid var(--border-weak-base, #2e2e32)">`);
var _tmpl$7 = /*#__PURE__*/ (0, solid_js_web.template)(`<button type=button style="padding:4px 2px 8px;border:none;background:transparent;color:inherit;cursor:pointer">`);
var _tmpl$8 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;align-items:center;gap:8px><span style=width:96px;font-family:monospace></span><div style=flex:1;height:10px;background:rgba(128,128,128,0.18);border-radius:4px;overflow:hidden><div style=height:100%>`);
var _tmpl$9 = /*#__PURE__*/ (0, solid_js_web.template)(`<svg><g><path fill=none stroke=#38bdf8 stroke-width=1.5></path><rect y=104 width=110 height=40 rx=6 fill=none stroke=#38bdf8 stroke-width=1.4></rect><text y=128 text-anchor=middle fill=currentColor font-size=11></svg>`, false, true, false);
var _tmpl$0 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=opacity:0.6>No board messages recorded yet.`);
var _tmpl$1 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="padding:8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32)"><div style=display:flex;justify-content:space-between;opacity:0.75><span></span><span></span></div><div style=margin-top:4px>`);
var _tmpl$10 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=opacity:0.6>No active background jobs.`);
var _tmpl$11 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="display:flex;justify-content:space-between;padding:8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32)"><span></span><span>`);
var _tmpl$12 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=opacity:0.8>`);
var _tmpl$13 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=padding:16px;display:flex;flex-direction:column;gap:12px><h2 style=font-size:16px;font-weight:600>Pantheon v2.3.3</h2><p style=font-size:13px;opacity:0.8>Olympus Topology, Agora Board, and Ephemeral Worker telemetry are active in the Pantheon side panel.`);
const PantheonBridge = _opencode_plugin_gui.Ipc.define({
	id: "pantheon-opencode.bridge",
	methods: { snapshot: {
		input: effect.Schema.String,
		output: effect.Schema.String
	} }
});
function readNdjsonLines(filePath, limit = 80) {
	if (!(0, node_fs.existsSync)(filePath)) return [];
	try {
		const slice = (0, node_fs.readFileSync)(filePath, "utf8").trim().split("\n").filter(Boolean).slice(-limit);
		const parsed = [];
		for (const line of slice) try {
			parsed.push(JSON.parse(line));
		} catch {}
		return parsed;
	} catch {
		return [];
	}
}
function readSnapshotFromDisk(directory) {
	const root = directory.trim() || process.cwd();
	const messages = readNdjsonLines((0, node_path.join)(root, ".pantheon", "board", "messages.ndjson"), 80);
	const events = readNdjsonLines((0, node_path.join)(root, ".pantheon", "telemetry", "cockpit-events.ndjson"), 100);
	const activeJobs = [];
	const statePath = (0, node_path.join)(root, ".pantheon", "board", "state.json");
	if ((0, node_fs.existsSync)(statePath)) try {
		const state = JSON.parse((0, node_fs.readFileSync)(statePath, "utf8"));
		if (state.jobs && typeof state.jobs === "object") for (const [id, job] of Object.entries(state.jobs)) activeJobs.push({
			id,
			agent: job.agent ?? "specialist",
			status: job.status ?? "unknown",
			cost: typeof job.cost === "number" ? job.cost : 0
		});
	} catch {}
	let overridesCount = 0;
	const overridesPath = (0, node_path.join)(root, ".pantheon", "overrides.json");
	if ((0, node_fs.existsSync)(overridesPath)) try {
		const ov = JSON.parse((0, node_fs.readFileSync)(overridesPath, "utf8"));
		overridesCount = Object.keys(ov).length;
	} catch {}
	return {
		messages,
		events,
		activeJobs,
		overridesCount
	};
}
function PantheonCockpitView(props) {
	const [subTab, setSubTab] = (0, solid_js.createSignal)("topology");
	const [topoView, setTopoView] = (0, solid_js.createSignal)("dag");
	const [snapshot, setSnapshot] = (0, solid_js.createSignal)({
		messages: [],
		events: [],
		activeJobs: [],
		overridesCount: 0
	});
	const [scrubberSeq, setScrubberSeq] = (0, solid_js.createSignal)(null);
	const refresh = async () => {
		try {
			const raw = await props.ctx.main(PantheonBridge).snapshot(props.directory());
			const parsed = JSON.parse(raw);
			setSnapshot(parsed);
		} catch {}
	};
	(0, solid_js.createEffect)(() => {
		props.directory();
		refresh();
		const timer = setInterval(() => void refresh(), 3e3);
		(0, solid_js.onCleanup)(() => clearInterval(timer));
	});
	const maxSeq = (0, solid_js.createMemo)(() => {
		const msgs = snapshot().messages;
		return msgs.length > 0 ? msgs[msgs.length - 1]?.seq ?? 0 : 0;
	});
	const visibleMessages = (0, solid_js.createMemo)(() => {
		const cap = scrubberSeq();
		const msgs = snapshot().messages;
		return cap === null ? msgs : msgs.filter((m) => m.seq <= cap);
	});
	const ephemeralWorkers = (0, solid_js.createMemo)(() => visibleMessages().filter((m) => m.ephemeral !== void 0));
	const uniqueAgents = (0, solid_js.createMemo)(() => {
		const set = /* @__PURE__ */ new Set(["zeus"]);
		for (const m of visibleMessages()) if (m.from) set.add(m.from);
		for (const j of snapshot().activeJobs) if (j.agent) set.add(j.agent);
		return [...set].slice(0, 6);
	});
	const totalCost = (0, solid_js.createMemo)(() => snapshot().activeJobs.reduce((sum, j) => sum + (Number.isFinite(j.cost) ? j.cost : 0), 0));
	return (() => {
		var _el$ = _tmpl$6(), _el$2 = _el$.firstChild, _el$3 = _el$2.firstChild;
		_el$3.firstChild.nextSibling;
		var _el$7 = _el$3.nextSibling.firstChild, _el$8 = _el$7.nextSibling, _el$9 = _el$2.nextSibling;
		(0, solid_js_web.insert)(_el$7, () => `${snapshot().activeJobs.filter((j) => j.status === "running").length} active · $${totalCost().toFixed(2)}`);
		_el$8.$$click = () => void refresh();
		(0, solid_js_web.insert)(_el$9, () => [
			["topology", "Topology & Timeline"],
			["board", `Agora Board (${snapshot().messages.length})`],
			["ephemeral", `Ephemeral & Bots (${snapshot().activeJobs.length})`],
			["settings", "Settings"]
		].map(([id, label]) => (() => {
			var _el$25 = _tmpl$7();
			_el$25.$$click = () => setSubTab(id);
			(0, solid_js_web.insert)(_el$25, label);
			(0, solid_js_web.effect)((_p$) => {
				var _v$6 = subTab() === id ? "2px solid #fba970" : "2px solid transparent", _v$7 = subTab() === id ? 1 : .65, _v$8 = subTab() === id ? 600 : 400;
				_v$6 !== _p$.e && (0, solid_js_web.setStyleProperty)(_el$25, "border-bottom", _p$.e = _v$6);
				_v$7 !== _p$.t && (0, solid_js_web.setStyleProperty)(_el$25, "opacity", _p$.t = _v$7);
				_v$8 !== _p$.a && (0, solid_js_web.setStyleProperty)(_el$25, "font-weight", _p$.a = _v$8);
				return _p$;
			}, {
				e: void 0,
				t: void 0,
				a: void 0
			});
			return _el$25;
		})()));
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "topology";
			},
			get children() {
				var _el$0 = _tmpl$2(), _el$10 = _el$0.firstChild.firstChild, _el$11 = _el$10.firstChild, _el$12 = _el$11.nextSibling, _el$14 = _el$10.nextSibling.firstChild, _el$15 = _el$14.nextSibling;
				_el$11.$$input = (e) => {
					const val = Number(e.currentTarget.value);
					setScrubberSeq(val >= maxSeq() ? null : val);
				};
				(0, solid_js_web.insert)(_el$12, (() => {
					var _c$ = (0, solid_js_web.memo)(() => scrubberSeq() === null);
					return () => _c$() ? `#${maxSeq()} · Live` : `#${scrubberSeq()} / ${maxSeq()} · Replay`;
				})());
				_el$14.$$click = () => setTopoView("dag");
				_el$15.$$click = () => setTopoView("gantt");
				(0, solid_js_web.insert)(_el$0, (0, solid_js_web.createComponent)(solid_js.Show, {
					get when() {
						return topoView() === "dag";
					},
					get fallback() {
						return (() => {
							var _el$26 = _tmpl$3();
							(0, solid_js_web.insert)(_el$26, (0, solid_js_web.createComponent)(solid_js.For, {
								get each() {
									return uniqueAgents();
								},
								children: (agent, idx) => (() => {
									var _el$27 = _tmpl$8(), _el$28 = _el$27.firstChild, _el$30 = _el$28.nextSibling.firstChild;
									(0, solid_js_web.insert)(_el$28, agent);
									(0, solid_js_web.setStyleProperty)(_el$30, "background", agent === "zeus" ? "#fba970" : "#38bdf8");
									(0, solid_js_web.effect)((_$p) => (0, solid_js_web.setStyleProperty)(_el$30, "width", `${Math.max(20, 95 - idx() * 15)}%`));
									return _el$27;
								})()
							}));
							return _el$26;
						})();
					},
					get children() {
						var _el$16 = _tmpl$();
						_el$16.firstChild.nextSibling.nextSibling;
						(0, solid_js_web.insert)(_el$16, (0, solid_js_web.createComponent)(solid_js.For, {
							get each() {
								return uniqueAgents().filter((a) => a !== "zeus");
							},
							children: (agent, idx) => {
								const count = Math.max(1, uniqueAgents().length - 1);
								const x = 20 + idx() * 600 / count;
								const cx = x + 55;
								return (() => {
									var _el$31 = _tmpl$9(), _el$32 = _el$31.firstChild, _el$33 = _el$32.nextSibling, _el$34 = _el$33.nextSibling;
									(0, solid_js_web.setAttribute)(_el$32, "d", `M 320 46 C 320 78, ${cx} 72, ${cx} 104`);
									(0, solid_js_web.setAttribute)(_el$33, "x", x);
									(0, solid_js_web.setAttribute)(_el$34, "x", cx);
									(0, solid_js_web.insert)(_el$34, agent);
									return _el$31;
								})();
							}
						}), null);
						return _el$16;
					}
				}), null);
				(0, solid_js_web.effect)((_p$) => {
					var _v$ = Math.max(1, maxSeq()), _v$2 = topoView() === "dag" ? "#fba970" : "transparent", _v$3 = topoView() === "dag" ? "#111" : "inherit", _v$4 = topoView() === "gantt" ? "#fba970" : "transparent", _v$5 = topoView() === "gantt" ? "#111" : "inherit";
					_v$ !== _p$.e && (0, solid_js_web.setAttribute)(_el$11, "max", _p$.e = _v$);
					_v$2 !== _p$.t && (0, solid_js_web.setStyleProperty)(_el$14, "background", _p$.t = _v$2);
					_v$3 !== _p$.a && (0, solid_js_web.setStyleProperty)(_el$14, "color", _p$.a = _v$3);
					_v$4 !== _p$.o && (0, solid_js_web.setStyleProperty)(_el$15, "background", _p$.o = _v$4);
					_v$5 !== _p$.i && (0, solid_js_web.setStyleProperty)(_el$15, "color", _p$.i = _v$5);
					return _p$;
				}, {
					e: void 0,
					t: void 0,
					a: void 0,
					o: void 0,
					i: void 0
				});
				(0, solid_js_web.effect)(() => _el$11.value = scrubberSeq() ?? maxSeq());
				return _el$0;
			}
		}), null);
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "board";
			},
			get children() {
				var _el$20 = _tmpl$3();
				(0, solid_js_web.insert)(_el$20, (0, solid_js_web.createComponent)(solid_js.For, {
					get each() {
						return [...visibleMessages()].reverse().slice(0, 20);
					},
					get fallback() {
						return _tmpl$0();
					},
					children: (msg) => (() => {
						var _el$36 = _tmpl$1(), _el$37 = _el$36.firstChild, _el$38 = _el$37.firstChild, _el$39 = _el$38.nextSibling, _el$40 = _el$37.nextSibling;
						(0, solid_js_web.insert)(_el$38, () => `#${msg.seq} ${msg.from}${msg.mentions.length ? ` → ${msg.mentions.join(", ")}` : ""}`);
						(0, solid_js_web.insert)(_el$39, () => msg.tag ?? "");
						(0, solid_js_web.insert)(_el$40, () => msg.body);
						return _el$36;
					})()
				}));
				return _el$20;
			}
		}), null);
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "ephemeral";
			},
			get children() {
				var _el$21 = _tmpl$4();
				(0, solid_js_web.insert)(_el$21, (0, solid_js_web.createComponent)(solid_js.For, {
					get each() {
						return snapshot().activeJobs;
					},
					get fallback() {
						return _tmpl$10();
					},
					children: (job) => (() => {
						var _el$42 = _tmpl$11(), _el$43 = _el$42.firstChild, _el$44 = _el$43.nextSibling;
						(0, solid_js_web.insert)(_el$43, () => `${job.agent} (${job.id.slice(0, 8)})`);
						(0, solid_js_web.insert)(_el$44, () => `${job.status} · $${job.cost.toFixed(3)}`);
						return _el$42;
					})()
				}), null);
				(0, solid_js_web.insert)(_el$21, (0, solid_js_web.createComponent)(solid_js.For, {
					get each() {
						return ephemeralWorkers().slice(-6);
					},
					children: (msg) => (() => {
						var _el$45 = _tmpl$12();
						(0, solid_js_web.insert)(_el$45, () => `◈ ${msg.ephemeral?.role ?? msg.from} [${msg.ephemeral?.status ?? "active"}]`);
						return _el$45;
					})()
				}), null);
				return _el$21;
			}
		}), null);
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "settings";
			},
			get children() {
				var _el$22 = _tmpl$5(), _el$23 = _el$22.firstChild;
				_el$23.nextSibling;
				(0, solid_js_web.insert)(_el$23, () => `Project overrides: ${snapshot().overridesCount}`);
				return _el$22;
			}
		}), null);
		return _el$;
	})();
}
var gui_default = _opencode_plugin_gui.Plugin.define({
	main(ctx) {
		ctx.provide(PantheonBridge, { snapshot: (directory) => JSON.stringify(readSnapshotFromDisk(directory)) });
	},
	setup(ctx) {
		const cockpitTab = {
			id: "pantheon-cockpit",
			title: "Pantheon",
			icon: "pantheon",
			pinned: true
		};
		ctx.add(_opencode_plugin_gui.Panel, () => ({
			id: "cockpit",
			region: "side",
			wide: true,
			list: () => [cockpitTab],
			render: (props) => (0, solid_js_web.createComponent)(PantheonCockpitView, {
				ctx,
				directory: () => props.session()?.location?.directory ?? ""
			})
		}));
		ctx.add(_opencode_plugin_gui.SettingsPage, () => ({
			id: "pantheon",
			title: "Pantheon",
			entries: [{
				id: "pantheon.overview",
				title: "Pantheon Orchestration",
				description: "Multi-agent Olympus Topology, Ephemeral Workers, and Cockpit Settings",
				keywords: "pantheon cockpit swarm ephemeral todo"
			}],
			render: () => (() => {
				var _el$46 = _tmpl$13();
				_el$46.firstChild.nextSibling;
				return _el$46;
			})()
		}));
		ctx.add(_opencode_plugin_gui.Command, () => ({
			id: "cockpit",
			title: "Open Pantheon Cockpit",
			description: "Open Olympus Topology, Agora Board, and Ephemeral Workers",
			slash: { name: "pantheon-cockpit" },
			run: () => {
				const screen = ctx.screen.current();
				if (screen) screen.panel.open({ tab: "pantheon-cockpit" });
			}
		}));
		ctx.add(_opencode_plugin_gui.Command, () => ({
			id: "settings",
			title: "Open Pantheon Settings",
			description: "Open Pantheon Desktop Settings page",
			slash: { name: "pantheon-settings" },
			run: () => {
				ctx.layout.settings("pantheon");
			}
		}));
	}
});
(0, solid_js_web.delegateEvents)(["click", "input"]);
//#endregion
module.exports = gui_default;
