import { createComponent, createElement, createTextNode, effect, insert, insertNode, memo, setProp } from "@opentui/solid";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
//#region src/index-v2.tsx
/** @jsxImportSource @opentui/solid */
const SINGLETON = Symbol.for("pantheon.tui.v2.loaded");
/** How often the sidebar re-reads .pantheon/active-preset.json (V1 parity) so
*  `set-tier` changes made while opencode is open show up within ~30s. */
const PRESET_REFRESH_MS = 3e4;
/** Running delegations rendered before the "… +N more" line (V1 parity). */
const DELEGATIONS_VISIBLE_CEILING = 8;
/** Running-row spinner cadence — matches V1's animation tick. */
const SPINNER_INTERVAL_MS = 80;
/** Bounded warm-up: sync at most this many sessions at plugin load. */
const WARMUP_SESSION_LIMIT = 24;
/** Sidebar body shown while the host has not published a session yet. */
const SIDEBAR_WAITING_LABEL = "Aguardando sessão…";
/** Delegate-completion toast title. */
const TOAST_TITLE = "Pantheon";
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
	"session.deleted"
];
/** Read .pantheon/active-preset.json — first existing candidate wins; malformed
*  JSON or a `preset` that is missing, empty or "none" → null (no fall-through
*  to lower candidates). */
async function readActivePresetFile(cwd) {
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
				name,
				source: "file"
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
/** Resolve the active preset for the sidebar: env > file > default. */
async function resolvePresetForTui(env, cwd) {
	const envPreset = presetFromEnv(env);
	if (envPreset.source === "env") return envPreset;
	return await readActivePresetFile(cwd) ?? {
		name: null,
		source: null
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
/** Build a delegation row from a child session + its live status. A terminal
*  `outcome` wins when present (the only V2 primitive that surfaces a
*  delegation failure/interruption once the status is back to idle); otherwise
*  the live status decides, with the absent/idle grace window applied. Pure. */
function toDelegationView(child, status, now = Date.now()) {
	const id = typeof child?.id === "string" ? child.id : "";
	const title = typeof child?.title === "string" && child.title !== "" ? child.title : "";
	const agent = typeof child?.agent === "string" && child.agent !== "" ? child.agent : "";
	return {
		id,
		label: title !== "" ? title : agent !== "" ? agent : id.slice(0, 8),
		state: delegationStateFromOutcome(child?.outcome) ?? delegationStateFromStatus(status, child?.time, now),
		startedAt: numberOrNull(child?.time?.created),
		updatedAt: numberOrNull(child?.time?.updated)
	};
}
const DELEGATION_TONES = {
	running: "warning",
	completed: "success",
	failed: "error",
	interrupted: "warning"
};
/** Whole-row tone: red = failed, green = terminal, yellow = in flight. The
*  glyph stays a redundant channel so the state reads in monochrome. Pure. */
function delegationStateTone(state) {
	return DELEGATION_TONES[state];
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
/** Row marker (`<glyph> `): the animated spinner while running, ✓ when done,
*  ⊘ when interrupted, ✕ on failure. Pure. */
function delegationRowMarker(state, frame = 0) {
	if (state === "running") return `${spinnerFrame(frame)} `;
	if (state === "failed") return "✕ ";
	if (state === "interrupted") return "⊘ ";
	return "✓ ";
}
/** Compact single-unit elapsed label: "12s"/"3m"/"1h"/"2d". Pure. */
function fmtElapsed(ms) {
	const total = Math.max(0, Math.floor(ms / 1e3));
	const days = Math.floor(total / 86400);
	const hours = Math.floor(total % 86400 / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	const seconds = total % 60;
	if (days > 0) return `${days}d`;
	if (hours > 0) return `${hours}h`;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}
/** Elapsed label for one row: a running job ticks `now - startedAt`; a terminal
*  one is fixed at `updatedAt - startedAt` (em dash when a timestamp is
*  missing). Pure. */
function delegationElapsed(view, now) {
	if (view.state === "running") return view.startedAt === null ? "—" : fmtElapsed(now - view.startedAt);
	if (view.startedAt !== null && view.updatedAt !== null) return fmtElapsed(view.updatedAt - view.startedAt);
	return "—";
}
/** Live rows first (a running job never falls behind the cap), then by most
*  recent activity. Pure. */
function orderDelegations(views) {
	return [...views].sort((a, b) => {
		const activeA = a.state === "running" ? 1 : 0;
		const activeB = b.state === "running" ? 1 : 0;
		if (activeA !== activeB) return activeB - activeA;
		return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
	});
}
/** Cap the panel: at most `maxVisible` rows, the remainder collapsing into the
*  "… +N more" line. Pure. */
function ceilingDelegations(views, maxVisible = 8) {
	const limit = Math.max(0, maxVisible);
	const visible = views.slice(0, limit);
	return {
		visible,
		hidden: Math.max(0, views.length - visible.length)
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
	onMount(() => {
		const cwd = resolveSidebarCwd(context);
		let cancelled = false;
		const refresh = async () => {
			try {
				const info = await resolvePresetForTui(process.env, cwd);
				if (!cancelled) setPreset(info);
			} catch {}
		};
		refresh();
		const timer = setInterval(() => void refresh(), PRESET_REFRESH_MS);
		onCleanup(() => {
			cancelled = true;
			clearInterval(timer);
		});
	});
	return preset;
}
/** Reactive state the sidebar view renders. Accessors keep the view reactive
*  while the model itself stays free of JSX, so its effects are exercisable
*  without a TUI renderer. */
/** Reactive wiring behind the sidebar: refresh subscription, warm syncs, the
*  running-only spinner and the completion-toast effect. `context` stays loosely
*  typed (the host API only exists at runtime) but the refresh event names are
*  narrowed to the V2 union at the subscription site. */
function createSidebarModel(context, sessionID) {
	const [revision, setRevision] = createSignal(0);
	const [frame, setFrame] = createSignal(0);
	const location = resolveLocation(context);
	const preset = useActivePreset(context);
	let observedStates = /* @__PURE__ */ new Map();
	const refresh = () => setRevision((value) => value + 1);
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
	const allDelegations = createMemo(() => {
		revision();
		const id = activeSessionID();
		if (id === "") return [];
		let family = [];
		try {
			const result = context.data.session.family?.(id);
			if (Array.isArray(result)) family = result;
		} catch {
			return [];
		}
		const now = Date.now();
		const views = [];
		for (const childID of family) {
			if (childID === id || !isValidSessionID(childID)) continue;
			const child = context.data.session.get(childID);
			if (child?.parentID !== id) continue;
			views.push(toDelegationView(child, sessionStatusOf(context, childID), now));
		}
		return orderDelegations(views);
	});
	const delegations = createMemo(() => allDelegations().filter((view) => view.state === "running"));
	const ceiling = createMemo(() => ceilingDelegations(delegations(), 8));
	const hasRunning = createMemo(() => delegations().length > 0);
	onMount(() => {
		const stop = [];
		const data = context?.data;
		if (typeof data?.on === "function") for (const type of SIDEBAR_REFRESH_EVENTS) try {
			const unsubscribe = data.on(type, refresh);
			if (typeof unsubscribe === "function") stop.push(unsubscribe);
		} catch {}
		const id = activeSessionID();
		if (id !== "") try {
			Promise.resolve(context.data.session.sync(id)).then(refresh);
		} catch {}
		try {
			Promise.resolve(context.data.location.vcs.sync(location)).then(refresh);
		} catch {}
		createEffect(() => {
			if (!hasRunning()) return;
			const spinner = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS);
			onCleanup(() => clearInterval(spinner));
		});
		onCleanup(() => {
			for (const unsubscribe of stop) if (typeof unsubscribe === "function") unsubscribe();
		});
	});
	createEffect(() => {
		const views = allDelegations();
		if (activeSessionID() === "") {
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
		delegations,
		ceiling,
		hasRunning,
		frame,
		preset
	};
}
function Sidebar(props) {
	const { context } = props;
	const model = createSidebarModel(context, () => props.sessionID);
	const text = () => context.theme.text?.base;
	const muted = () => context.theme.text?.muted ?? text();
	const tone = (value) => context.theme?.text?.feedback?.[value]?.base ?? text();
	const open = (sessionID) => () => navigateToSession(context.ui?.router, sessionID);
	return (() => {
		var _el$ = createElement("box"), _el$2 = createElement("text"), _el$3 = createElement("text");
		insertNode(_el$, _el$2);
		insertNode(_el$, _el$3);
		setProp(_el$, "flexDirection", "column");
		setProp(_el$, "width", "100%");
		setProp(_el$, "padding", 1);
		setProp(_el$2, "attributes", 1);
		insert(_el$2, `Pantheon v1.6.0-beta.14`);
		insertNode(_el$3, createTextNode(`OpenCode V2 · plugin TUI ativo`));
		insert(_el$, createComponent(Show, {
			get when() {
				return model.branch();
			},
			children: (value) => (() => {
				var _el$8 = createElement("text");
				insert(_el$8, () => `Branch: ${value()}`);
				effect((_$p) => setProp(_el$8, "fg", muted(), _$p));
				return _el$8;
			})()
		}), null);
		insert(_el$, createComponent(Show, {
			get when() {
				return model.preset().name;
			},
			get fallback() {
				return (() => {
					var _el$9 = createElement("box"), _el$0 = createElement("text");
					insertNode(_el$9, _el$0);
					setProp(_el$9, "flexDirection", "row");
					insertNode(_el$0, createTextNode(`Preset: default`));
					effect((_$p) => setProp(_el$0, "fg", muted(), _$p));
					return _el$9;
				})();
			},
			children: (name) => (() => {
				var _el$10 = createElement("box"), _el$11 = createElement("text"), _el$13 = createElement("text"), _el$14 = createElement("text");
				insertNode(_el$10, _el$11);
				insertNode(_el$10, _el$13);
				insertNode(_el$10, _el$14);
				setProp(_el$10, "flexDirection", "row");
				insertNode(_el$11, createTextNode(`⚡ Preset: `));
				insert(_el$13, name);
				insert(_el$14, () => ` (${model.preset().source ?? ""})`);
				effect((_p$) => {
					var _v$3 = muted(), _v$4 = text(), _v$5 = muted();
					_v$3 !== _p$.e && (_p$.e = setProp(_el$11, "fg", _v$3, _p$.e));
					_v$4 !== _p$.t && (_p$.t = setProp(_el$13, "fg", _v$4, _p$.t));
					_v$5 !== _p$.a && (_p$.a = setProp(_el$14, "fg", _v$5, _p$.a));
					return _p$;
				}, {
					e: void 0,
					t: void 0,
					a: void 0
				});
				return _el$10;
			})()
		}), null);
		insert(_el$, createComponent(Show, {
			get when() {
				return memo(() => model.activeSessionID() !== "")() && model.session();
			},
			get fallback() {
				return (() => {
					var _el$15 = createElement("text");
					insert(_el$15, () => sidebarPlaceholder(props.sessionID));
					effect((_$p) => setProp(_el$15, "fg", muted(), _$p));
					return _el$15;
				})();
			},
			children: (current) => [(() => {
				var _el$16 = createElement("text");
				insert(_el$16, () => `Sessão: ${current().title || current().id}`);
				effect((_$p) => setProp(_el$16, "fg", text(), _$p));
				return _el$16;
			})(), createComponent(Show, {
				get when() {
					return current().agent;
				},
				get children() {
					var _el$17 = createElement("text");
					insert(_el$17, () => `Agente: ${current().agent}`);
					effect((_$p) => setProp(_el$17, "fg", muted(), _$p));
					return _el$17;
				}
			})]
		}), null);
		insert(_el$, createComponent(Show, {
			get when() {
				return model.delegations().length > 0;
			},
			get children() {
				return [
					(() => {
						var _el$5 = createElement("text");
						insertNode(_el$5, createTextNode(`Delegações`));
						setProp(_el$5, "attributes", 1);
						effect((_$p) => setProp(_el$5, "fg", text(), _$p));
						return _el$5;
					})(),
					createComponent(For, {
						get each() {
							return model.ceiling().visible;
						},
						children: (view) => (() => {
							var _el$18 = createElement("box"), _el$19 = createElement("text");
							insertNode(_el$18, _el$19);
							insert(_el$19, () => `${delegationRowMarker(view.state, model.frame())}${view.label} ${delegationElapsed(view, Date.now())}`);
							effect((_p$) => {
								var _v$6 = open(view.id), _v$7 = tone(delegationStateTone(view.state));
								_v$6 !== _p$.e && (_p$.e = setProp(_el$18, "onMouseDown", _v$6, _p$.e));
								_v$7 !== _p$.t && (_p$.t = setProp(_el$19, "fg", _v$7, _p$.t));
								return _p$;
							}, {
								e: void 0,
								t: void 0
							});
							return _el$18;
						})()
					}),
					createComponent(Show, {
						get when() {
							return model.ceiling().hidden > 0;
						},
						get children() {
							var _el$7 = createElement("text");
							insert(_el$7, () => `… +${model.ceiling().hidden} more`);
							effect((_$p) => setProp(_el$7, "fg", muted(), _$p));
							return _el$7;
						}
					})
				];
			}
		}), null);
		effect((_p$) => {
			var _v$ = text(), _v$2 = muted();
			_v$ !== _p$.e && (_p$.e = setProp(_el$2, "fg", _v$, _p$.e));
			_v$2 !== _p$.t && (_p$.t = setProp(_el$3, "fg", _v$2, _p$.t));
			return _p$;
		}, {
			e: void 0,
			t: void 0
		});
		return _el$;
	})();
}
/** Home-screen status contribution. The sidebar slot is session-scoped, so
*  before the first prompt the sidebar may not mount at all (Known Issue) —
*  this keeps a compact Pantheon line visible on the home footer meanwhile. */
function HomeStatus(props) {
	const preset = useActivePreset(props.context);
	const muted = () => props.context.theme?.text?.muted ?? props.context.theme?.text?.base;
	return (() => {
		var _el$20 = createElement("text");
		insert(_el$20, () => `Pantheon v1.6.0-beta.14${preset().name ? ` ⚡ ${preset().name}` : ""}`);
		effect((_$p) => setProp(_el$20, "fg", muted(), _$p));
		return _el$20;
	})();
}
const plugin = Plugin.define({
	id: "pantheon.tui",
	setup(context) {
		const globalState = globalThis;
		if (globalState[SINGLETON]) return;
		globalState[SINGLETON] = true;
		warmUpSidebarData(context, resolveLocation(context));
		const unregisterSidebar = context.ui.slot({
			append: "sidebar.content",
			render: ({ sessionID }) => createComponent(Sidebar, {
				context,
				sessionID
			})
		});
		const unregisterHome = context.ui.slot({
			append: "home.footer.status",
			render: () => createComponent(HomeStatus, { context })
		});
		return () => {
			if (typeof unregisterSidebar === "function") unregisterSidebar();
			if (typeof unregisterHome === "function") unregisterHome();
			delete globalState[SINGLETON];
		};
	}
});
//#endregion
export { DELEGATIONS_VISIBLE_CEILING, DELEGATION_CHILD_STATUS_GRACE_MS, SIDEBAR_REFRESH_EVENTS, SIDEBAR_WAITING_LABEL, ceilingDelegations, collectWarmupTargets, createSidebarModel, plugin as default, delegationElapsed, delegationRowMarker, delegationStateFromOutcome, delegationStateFromStatus, delegationStateTone, detectDelegationCompletions, fmtElapsed, isValidSessionID, navigateToSession, orderDelegations, presetFromEnv, resolvePresetForTui, sidebarPlaceholder, spinnerFrame, toDelegationView };

//# sourceMappingURL=tui-v2.js.map
