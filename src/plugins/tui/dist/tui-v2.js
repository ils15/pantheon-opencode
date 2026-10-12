import { createComponent, createElement, createTextNode, effect, insert, insertNode, setProp } from "@opentui/solid";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
//#region src/index-v2.tsx
/** @jsxImportSource @opentui/solid */
const SINGLETON = Symbol.for("pantheon.tui.v2.loaded");
function Sidebar(props) {
	const { context } = props;
	const [revision, setRevision] = createSignal(0);
	const location = context.location ?? context.data.location.default();
	const session = createMemo(() => {
		revision();
		return props.sessionID ? context.data.session.get(props.sessionID) : void 0;
	});
	const branch = createMemo(() => {
		revision();
		return context.data.location.vcs.info(location)?.branch?.current ?? null;
	});
	const delegations = createMemo(() => {
		revision();
		const id = props.sessionID;
		if (!id) return [];
		return (context.data.session.family(id) ?? []).filter((childID) => childID !== id).map((childID) => context.data.session.get(childID)).filter((child) => child?.parentID === id).slice(0, 6);
	});
	onMount(() => {
		const stop = [];
		for (const type of [
			"session.created",
			"session.updated",
			"session.status",
			"session.deleted"
		]) try {
			stop.push(context.data.on(type, () => setRevision((value) => value + 1)));
		} catch {}
		if (props.sessionID) context.data.session.sync(props.sessionID).then(() => setRevision((value) => value + 1));
		context.data.location.vcs.sync(location).then(() => setRevision((value) => value + 1));
		onCleanup(() => {
			for (const unsubscribe of stop) unsubscribe();
		});
	});
	const text = () => context.theme.text?.base;
	const muted = () => context.theme.text?.muted ?? text();
	return (() => {
		var _el$ = createElement("box"), _el$2 = createElement("text"), _el$3 = createElement("text");
		insertNode(_el$, _el$2);
		insertNode(_el$, _el$3);
		setProp(_el$, "flexDirection", "column");
		setProp(_el$, "width", "100%");
		setProp(_el$, "padding", 1);
		setProp(_el$2, "attributes", 1);
		insert(_el$2, `Pantheon v1.6.0-beta.9`);
		insertNode(_el$3, createTextNode(`OpenCode V2 · plugin TUI ativo`));
		insert(_el$, createComponent(Show, {
			get when() {
				return branch();
			},
			children: (value) => (() => {
				var _el$7 = createElement("text");
				insert(_el$7, () => `Branch: ${value()}`);
				effect((_$p) => setProp(_el$7, "fg", muted(), _$p));
				return _el$7;
			})()
		}), null);
		insert(_el$, createComponent(Show, {
			get when() {
				return session();
			},
			get fallback() {
				return (() => {
					var _el$8 = createElement("text");
					insertNode(_el$8, createTextNode(`Nenhuma sessão selecionada`));
					effect((_$p) => setProp(_el$8, "fg", muted(), _$p));
					return _el$8;
				})();
			},
			children: (current) => [(() => {
				var _el$0 = createElement("text");
				insert(_el$0, () => `Sessão: ${current().title || current().id}`);
				effect((_$p) => setProp(_el$0, "fg", text(), _$p));
				return _el$0;
			})(), createComponent(Show, {
				get when() {
					return current().agent;
				},
				get children() {
					var _el$1 = createElement("text");
					insert(_el$1, () => `Agente: ${current().agent}`);
					effect((_$p) => setProp(_el$1, "fg", muted(), _$p));
					return _el$1;
				}
			})]
		}), null);
		insert(_el$, createComponent(Show, {
			get when() {
				return delegations().length > 0;
			},
			get children() {
				return [(() => {
					var _el$5 = createElement("text");
					insertNode(_el$5, createTextNode(`Delegações`));
					setProp(_el$5, "attributes", 1);
					effect((_$p) => setProp(_el$5, "fg", text(), _$p));
					return _el$5;
				})(), createComponent(For, {
					get each() {
						return delegations();
					},
					children: (child) => (() => {
						var _el$10 = createElement("text");
						insert(_el$10, () => `· ${child.title || child.id}`);
						effect((_$p) => setProp(_el$10, "fg", muted(), _$p));
						return _el$10;
					})()
				})];
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
const plugin = Plugin.define({
	id: "pantheon.tui",
	setup(context) {
		const globalState = globalThis;
		if (globalState[SINGLETON]) return;
		globalState[SINGLETON] = true;
		const unregister = context.ui.slot({
			append: "sidebar.content",
			render: ({ sessionID }) => createComponent(Sidebar, {
				context,
				sessionID
			})
		});
		return () => {
			if (typeof unregister === "function") unregister();
			delete globalState[SINGLETON];
		};
	}
});
//#endregion
export { plugin as default };

//# sourceMappingURL=tui-v2.js.map
