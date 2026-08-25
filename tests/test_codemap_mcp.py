# ruff: noqa: PLR2004, F401
"""Tests for Deepwork Codemap Knowledge Graph — TDD >80% coverage."""
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import mcp_codemap_module as codemap
import pytest

import src.mcp.mcp_codemap_module as _codemap_src
import src.mcp.memory_mcp_server as mem


@pytest.fixture
def conn() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    codemap.ensure_codemap_schema(db)
    yield db
    db.close()


def _entity_id(fp: str, name: str, tp: str) -> str:
    return hashlib.sha256(f"{fp}:{name}:{tp}".encode()).hexdigest()[:16]


class TestSchema:
    def test_schema_forward_creates_tables(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        names = {r[0] for r in rows}
        assert "code_entities" in names
        assert "code_relations" in names
        assert "code_files" in names
        assert "code_entities_fts" in names

    def test_schema_rollback_drops_tables(self, conn: sqlite3.Connection) -> None:
        codemap.drop_codemap_schema(conn)
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        names = {r[0] for r in rows}
        assert "code_entities" not in names
        assert "code_relations" not in names
        assert "code_files" not in names
        assert "code_entities_fts" not in names

    def test_schema_idempotent(self, conn: sqlite3.Connection) -> None:
        codemap.ensure_codemap_schema(conn)
        codemap.ensure_codemap_schema(conn)
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='code_entities'"
        ).fetchall()
        assert len(rows) == 1


class TestParsePython:
    def test_parse_python_class_with_methods_and_docstring(self) -> None:
        content = 'class MyClass:\n    """My class doc"""\n    def method_one(self, x):\n        """method doc"""\n        pass\n    async def method_two(self):\n        pass\n'
        ents, _ = codemap._parse_python_entities("src/foo.py", content)
        by_name = {e["name"]: e for e in ents}
        assert "MyClass" in by_name
        cls = by_name["MyClass"]
        assert cls["type"] == "class"
        assert cls["docstring"] == "My class doc"
        assert cls["signature"] == "class MyClass"
        assert "MyClass.method_one" in by_name
        m1 = by_name["MyClass.method_one"]
        assert m1["type"] == "method"
        assert m1["docstring"] == "method doc"
        assert m1["signature"] == "def method_one(self, x)"
        assert "MyClass.method_two" in by_name

    def test_parse_python_function_and_inherits(self) -> None:
        content = "class Child(Parent):\n    pass\n\ndef my_func(a, b):\n    \"\"\"func doc\"\"\"\n    pass\n"
        ents, rels = codemap._parse_python_entities("src/bar.py", content)
        by_name = {e["name"]: e for e in ents}
        assert "my_func" in by_name
        fn = by_name["my_func"]
        assert fn["type"] == "function"
        assert fn["signature"] == "def my_func(a, b)"
        assert fn["docstring"] == "func doc"
        assert "Child" in by_name
        child_id = _entity_id("src/bar.py", "Child", "class")
        parent_id = _entity_id("external:Parent", "Parent", "class")
        assert any(r["source_id"] == child_id and r["target_id"] == parent_id and r["type"] == "inherits" for r in rels)

    def test_parse_python_imports_populates_relations(self) -> None:
        content = "import os\nimport numpy as np\nfrom pathlib import Path\n"
        ents, rels = codemap._parse_python_entities("src/app.py", content)
        mod_id = _entity_id("src/app.py", "app", "module")
        assert any(e["id"] == mod_id for e in ents)
        imports = [r for r in rels if r["type"] == "imports"]
        assert len(imports) == 3
        target_names = {e["name"] for e in ents if e["file_path"].startswith("external:")}
        assert "os" in target_names
        assert "numpy" in target_names
        assert "pathlib" in target_names

    def test_parse_python_syntax_error_returns_empty(self) -> None:
        ents, rels = codemap._parse_python_entities("bad.py", "def broken(:\n")
        assert ents == []
        assert rels == []


class TestParseTS:
    def test_parse_typescript_class_interface_function(self) -> None:
        content = "export class MyClass extends Base {}\ninterface MyIface {}\nexport async function myFunc() {}\nconst myConst = 42\n"
        ents, rels = codemap._parse_typescript_entities("src/app.ts", content)
        by_name = {e["name"]: e for e in ents}
        assert "MyClass" in by_name and by_name["MyClass"]["type"] == "class"
        assert "MyIface" in by_name and by_name["MyIface"]["type"] == "interface"
        assert "myFunc" in by_name and by_name["myFunc"]["type"] == "function"
        assert "myConst" in by_name
        child_id = _entity_id("src/app.ts", "MyClass", "class")
        base_id = _entity_id("external:Base", "Base", "class")
        assert any(r["source_id"] == child_id and r["target_id"] == base_id and r["type"] == "inherits" for r in rels)

    def test_parse_typescript_imports(self) -> None:
        content = "import { foo } from 'lodash'\nimport x from \"./utils.ts\"\nimport y from 'react'\n"
        ents, rels = codemap._parse_typescript_entities("src/app.ts", content)
        imports = [r for r in rels if r["type"] == "imports"]
        assert len(imports) == 3
        names = {e["name"] for e in ents if e["file_path"].startswith("external:")}
        assert "lodash" in names
        assert "utils" in names
        assert "react" in names


class TestIncremental:
    def test_code_index_skips_unchanged_via_hash(self, conn: sqlite3.Connection, tmp_path: Path) -> None:
        p = tmp_path / "hello.py"
        p.write_text("def foo():\n    pass\n")
        r1 = codemap.code_index(conn, path=p)
        assert r1["indexed"] == 1
        r2 = codemap.code_index(conn, path=p)
        assert r2["skipped"] == 1 and r2["indexed"] == 0

    def test_code_index_force_reparses(self, conn: sqlite3.Connection, tmp_path: Path) -> None:
        p = tmp_path / "hello.py"
        p.write_text("def foo():\n    pass\n")
        codemap.code_index(conn, path=p)
        r = codemap.code_index(conn, path=p, force=True)
        assert r["indexed"] == 1

    def test_large_file_skipped(self, conn: sqlite3.Connection, tmp_path: Path) -> None:
        p = tmp_path / "big.py"
        p.write_bytes(b"x" * (512 * 1024 + 1))
        r = codemap.code_index(conn, path=p)
        assert r["large_skipped"] == 1


class TestEdge:
    def test_empty_file_no_entities(self, conn: sqlite3.Connection, tmp_path: Path) -> None:
        p = tmp_path / "empty.py"
        p.write_text("   \n")
        r = codemap.code_index(conn, path=p)
        assert r["skipped"] == 1
        rows = conn.execute("SELECT COUNT(*) FROM code_entities WHERE file_path=?", [str(p)]).fetchone()[0]
        assert rows == 0

    def test_unsupported_extension_skipped(self, conn: sqlite3.Connection, tmp_path: Path) -> None:
        p = tmp_path / "notes.txt"
        p.write_text("hello")
        r = codemap.code_index(conn, path=p)
        assert r["unsupported"] == 1

    def test_code_query_empty_returns_empty(self, conn: sqlite3.Connection) -> None:
        assert codemap.code_query(conn, "") == []
        assert codemap.code_query(conn, "   ") == []


class TestQuery:
    def test_code_query_fts5_finds_entity(self, conn: sqlite3.Connection, tmp_path: Path) -> None:
        p = tmp_path / "mod.py"
        p.write_text("class UniqueXYZ123:\n    pass\n")
        codemap.code_index(conn, path=p)
        res = codemap.code_query(conn, "UniqueXYZ123")
        assert any(r["name"] == "UniqueXYZ123" for r in res)

    def test_code_query_filter_by_type(self, conn: sqlite3.Connection, tmp_path: Path) -> None:
        p = tmp_path / "mix.py"
        p.write_text("class MyClass:\n    pass\ndef my_func():\n    pass\n")
        codemap.code_index(conn, path=p)
        res = codemap.code_query(conn, "My", type_filter="class")
        assert len(res) > 0 and all(r["type"] == "class" for r in res)

    def test_code_query_fallback_like_when_fts_empty(self, conn: sqlite3.Connection, tmp_path: Path) -> None:
        p = tmp_path / "fallback.py"
        p.write_text("class MySpecialClass:\n    pass\n")
        codemap.code_index(conn, path=p)
        res = codemap.code_query(conn, "Spec")
        assert any("MySpecialClass" in r["name"] for r in res)


class TestNeighbors:
    def test_code_neighbors_depth1_imports(self, conn: sqlite3.Connection, tmp_path: Path) -> None:
        p = tmp_path / "app.py"
        p.write_text("import os\n")
        codemap.code_index(conn, path=p)
        mod_id = _entity_id(str(p), "app", "module")
        res = codemap.code_neighbors(conn, mod_id, depth=1)
        assert "entity" in res
        assert any(n["name"] == "os" for n in res["neighbors"])
        assert any(rel["type"] == "imports" for rel in res["relations"])

    def test_code_neighbors_depth2_transitive(self, conn: sqlite3.Connection) -> None:
        e1, e2, e3 = "e1id1234567890ab", "e2id1234567890ab", "e3id1234567890ab"
        for eid, name in [(e1, "E1"), (e2, "E2"), (e3, "E3")]:
            conn.execute(
                "INSERT OR REPLACE INTO code_entities (id,file_path,name,type,language,start_line,end_line,signature,docstring) VALUES (?,?,?,?,?,?,?,?,?)",
                [eid, f"/tmp/{name}.py", name, "class", "python", 1, 1, f"class {name}", ""],
            )
        conn.execute("INSERT INTO code_relations (source_id,target_id,type) VALUES (?,?,?)", [e1, e2, "imports"])
        conn.execute("INSERT INTO code_relations (source_id,target_id,type) VALUES (?,?,?)", [e2, e3, "imports"])
        conn.commit()
        r1 = codemap.code_neighbors(conn, e1, depth=1)
        assert len(r1["neighbors"]) == 1 and r1["neighbors"][0]["name"] == "E2"
        r2 = codemap.code_neighbors(conn, e1, depth=2)
        names = {n["name"] for n in r2["neighbors"]}
        assert "E2" in names and "E3" in names

    def test_code_neighbors_not_found_returns_empty(self, conn: sqlite3.Connection) -> None:
        res = codemap.code_neighbors(conn, "nonexistent123", depth=1)
        assert "error" in res and res["entity_id"] == "nonexistent123"

    def test_code_neighbors_import_placeholder(self, conn: sqlite3.Connection, tmp_path: Path) -> None:
        p = tmp_path / "app2.py"
        p.write_text("import os\n")
        codemap.code_index(conn, path=p)
        mod_id = _entity_id(str(p), "app2", "module")
        res = codemap.code_neighbors(conn, mod_id, depth=1)
        placeholders = [n for n in res["neighbors"] if n["file_path"].startswith("external:")]
        assert len(placeholders) > 0 and any(ph["name"] == "os" for ph in placeholders)


class TestMcpIntegration:
    """Integration via memory_mcp_server wrappers — isolated DB via _set_memory_dir."""

    def test_mcp_code_index_and_query_isolated(self, tmp_path: Path) -> None:
        mem._set_memory_dir(tmp_path / "memdb")
        p = tmp_path / "isolated.py"
        p.write_text("class IsolatedXYZ:\n    pass\n")
        r = mem.code_index(path=str(p))
        assert r["indexed"] == 1
        res = mem.code_query(query="IsolatedXYZ")
        assert any(x["name"] == "IsolatedXYZ" for x in res)

    def test_mcp_code_neighbors_isolated(self, tmp_path: Path) -> None:
        mem._set_memory_dir(tmp_path / "memdb2")
        p = tmp_path / "app_iso.py"
        p.write_text("import os\n")
        mem.code_index(path=str(p))
        mod_id = _entity_id(str(p), "app_iso", "module")
        out = mem.code_neighbors(entity_id=mod_id, depth=1)
        assert "entity" in out or "error" not in out
        if "neighbors" in out:
            assert any(n["name"] == "os" for n in out["neighbors"])
