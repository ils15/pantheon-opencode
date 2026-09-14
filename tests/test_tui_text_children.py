from pathlib import Path

SRC_DIR = Path("src/plugins/tui/src")
BUNDLE = Path("src/plugins/tui/dist/tui.js")
LEGACY_RAW = Path("src/plugins/tui/dist/tui.tsx")

# Scan the whole source tree, not just index.tsx: the entry may be split into
# relative-imported modules (the bundle inlines them, so the loader is fine).
SOURCE_FILES = sorted(SRC_DIR.rglob("*.tsx"))


def test_tui_reactive_effect_is_imported_in_source_and_runtime_bundle() -> None:
    """The delegation refresh effect must not be emitted as an unresolved global."""
    for plugin_file in SOURCE_FILES:
        content = plugin_file.read_text()
        assert "createEffect(() =>" in content, f"createEffect call missing in {plugin_file}"
        assert "createEffect," in content
        assert "from 'solid-js'" in content

    runtime_dist = BUNDLE.read_text()
    runtime_import = next(line for line in runtime_dist.splitlines() if 'from "solid-js"' in line)
    assert "createEffect" in runtime_import


def test_tui_loads_only_from_the_bundle_not_a_raw_tsx_copy() -> None:
    """The loader consumes the bundled dist/tui.js; no raw TSX copy is shipped.

    The former `cp src/index.tsx dist/tui.tsx` forced a single self-contained
    file (relative imports would not resolve). Its absence is what unblocks
    splitting the entry into modules.
    """
    assert BUNDLE.is_file(), "bundled TUI entry must exist"
    assert not LEGACY_RAW.exists(), "raw dist/tui.tsx must not be produced"


def test_tui_numeric_text_children_are_stringified() -> None:
    """OpenTUI text nodes reject numbers, so renderer-boundary values stay strings."""
    forbidden_children = (
        "{props.api.state.session.count()}",
        "{CMDS.length}",
        "{COMMANDS.length}",
        "{AGENTS.length}",
        "{cfg().mcpCount}",
        "{mem().entries}",
    )

    for plugin_file in SOURCE_FILES:
        content = plugin_file.read_text()
        for child in forbidden_children:
            assert child not in content, f"numeric OpenTUI child remains in {plugin_file}: {child}"
