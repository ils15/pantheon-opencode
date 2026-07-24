// src/index.tsx
import { createMemo, createSignal, Show, For } from "solid-js";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
async function readVersion(api) {
  try {
    const wt = api.state.path?.worktree ?? "";
    const fp = wt ? `${wt}/package.json` : "package.json";
    const r = await api.client.file.read({ query: { path: fp } });
    const m = String(r?.content ?? "").match(/"version":\s*"([^"]+)"/);
    if (m?.[1]) return m[1];
  } catch {
  }
  return "5.0.0";
}
var AGENTS = [
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
var CMDS = [
  "/pantheon",
  "/pantheon-status",
  "/pantheon-audit",
  "/pantheon-bg",
  "/pantheon-deepwork",
  "/pantheon-focus",
  "/pantheon-remember",
  "/pantheon-search",
  "/pantheon-forget"
];
function PantheonPanel(props) {
  const [showSub, setShowSub] = createSignal(false);
  const [showCmd, setShowCmd] = createSignal(false);
  const [showAg, setShowAg] = createSignal(false);
  const [showCfg, setShowCfg] = createSignal(false);
  const [showMem, setShowMem] = createSignal(false);
  const branch = createMemo(() => {
    const b = props.api.state.vcs?.branch;
    return b ? `\u2387 ${b}` : null;
  });
  return /* @__PURE__ */ jsxs("box", { flexDirection: "column", width: "100%", children: [
    /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.accent, attributes: { bold: true }, children: [
      "Pantheon v",
      props.version
    ] }),
    /* @__PURE__ */ jsx(Show, { when: branch(), children: (b) => /* @__PURE__ */ jsx("box", { marginTop: 1, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: b() }) }) }),
    /* @__PURE__ */ jsxs("box", { marginTop: 0, onMouseDown: () => setShowSub((x) => !x), children: [
      /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.text, attributes: { bold: true }, children: [
        showSub() ? "\u25BC " : "\u25B6 ",
        "Subagents"
      ] }),
      /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.textMuted, children: [
        " (",
        props.api.state.session.count(),
        ")"
      ] })
    ] }),
    /* @__PURE__ */ jsx(Show, { when: showSub(), children: /* @__PURE__ */ jsx("box", { marginLeft: 1, children: /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.textMuted, children: [
      "sessions: ",
      props.api.state.session.count()
    ] }) }) }),
    /* @__PURE__ */ jsxs("box", { marginTop: 0, onMouseDown: () => setShowCmd((x) => !x), children: [
      /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.text, attributes: { bold: true }, children: [
        showCmd() ? "\u25BC " : "\u25B6 ",
        "Commands"
      ] }),
      /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.textMuted, children: [
        " (",
        CMDS.length,
        ")"
      ] })
    ] }),
    /* @__PURE__ */ jsx(Show, { when: showCmd(), children: /* @__PURE__ */ jsx("box", { marginLeft: 1, flexDirection: "column", children: /* @__PURE__ */ jsx(For, { each: CMDS, children: (cmd) => /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.textMuted, children: [
      "\xB7",
      " ",
      cmd
    ] }) }) }) }),
    /* @__PURE__ */ jsxs("box", { marginTop: 0, onMouseDown: () => setShowAg((x) => !x), children: [
      /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.text, attributes: { bold: true }, children: [
        showAg() ? "\u25BC " : "\u25B6 ",
        "Agents"
      ] }),
      /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.textMuted, children: [
        " (",
        AGENTS.length,
        ")"
      ] })
    ] }),
    /* @__PURE__ */ jsx(Show, { when: showAg(), children: /* @__PURE__ */ jsx("box", { marginLeft: 1, flexDirection: "column", children: /* @__PURE__ */ jsx(For, { each: AGENTS, children: (a) => /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.textMuted, children: [
      "\xB7",
      " ",
      a
    ] }) }) }) }),
    /* @__PURE__ */ jsx("box", { marginTop: 0, onMouseDown: () => setShowCfg((x) => !x), children: /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.text, attributes: { bold: true }, children: [
      showCfg() ? "\u25BC " : "\u25B6 ",
      "Config"
    ] }) }),
    /* @__PURE__ */ jsx(Show, { when: showCfg(), children: /* @__PURE__ */ jsxs("box", { marginLeft: 1, flexDirection: "column", children: [
      /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.textMuted, children: [
        "MCPs: ",
        props.api.state.config?.mcp ? Object.keys(props.api.state.config.mcp).length : 0
      ] }),
      /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.textMuted, children: [
        "Compaction: ",
        props.api.state.config?.compaction?.auto ? "ON" : "OFF"
      ] })
    ] }) }),
    /* @__PURE__ */ jsx("box", { marginTop: 0, onMouseDown: () => setShowMem((x) => !x), children: /* @__PURE__ */ jsxs("text", { fg: props.api.theme.current.text, attributes: { bold: true }, children: [
      showMem() ? "\u25BC " : "\u25B6 ",
      "Memory"
    ] }) }),
    /* @__PURE__ */ jsx(Show, { when: showMem(), children: /* @__PURE__ */ jsx("box", { marginLeft: 1, children: /* @__PURE__ */ jsx("text", { fg: props.api.theme.current.textMuted, children: props.api.state.memory?.entries > 0 ? `Entries: ${props.api.state.memory.entries}` : "(no data)" }) }) })
  ] });
}
function createSlot(api) {
  const version = createMemo(() => readVersion(api));
  return {
    order: 900,
    slots: {
      sidebar_content(_ctx, input) {
        return /* @__PURE__ */ jsx(PantheonPanel, { api, version: version() });
      }
    }
  };
}
var tui = async (api) => {
  api.slots.register(createSlot(api));
};
var index_default = { id: "pantheon.tui", tui };
export {
  index_default as default
};
