from pathlib import Path

PLUGIN_FILES = (
    Path("src/plugins/tui/src/index.tsx"),
    Path("src/plugins/tui/dist/tui.tsx"),
)


def test_tui_reactive_effect_is_imported_in_source_and_runtime_bundle() -> None:
    """The delegation refresh effect must not be emitted as an unresolved global."""
    source = Path("src/plugins/tui/src/index.tsx").read_text()
    raw_dist = Path("src/plugins/tui/dist/tui.tsx").read_text()
    runtime_dist = Path("src/plugins/tui/dist/tui.js").read_text()

    for content in (source, raw_dist):
        assert "createEffect(() =>" in content
        assert "createEffect," in content
        assert "from 'solid-js'" in content

    runtime_import = next(line for line in runtime_dist.splitlines() if 'from "solid-js"' in line)
    assert "createEffect" in runtime_import


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

    for plugin_file in PLUGIN_FILES:
        content = plugin_file.read_text()
        for child in forbidden_children:
            assert child not in content, f"numeric OpenTUI child remains in {plugin_file}: {child}"
