# ruff: noqa: E701,E702,E741,I001,E401,RUF100,W292
"""Pantheon Codemap — lean KG for Python/TS (ast+regex), 3 tables+FTS5."""
from __future__ import annotations
import ast, hashlib, re, sqlite3
from pathlib import Path
from typing import Any
LARGE_FILE_THRESHOLD = 512 * 1024
SUPPORTED_EXTS: dict[str, str] = {".py":"python",".ts":"typescript",".tsx":"typescript",".js":"typescript",".jsx":"typescript",".mts":"typescript",".cts":"typescript"}
CODEMAP_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS code_entities (id TEXT PRIMARY KEY,file_path TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,language TEXT NOT NULL,start_line INTEGER,end_line INTEGER,signature TEXT,docstring TEXT);
CREATE INDEX IF NOT EXISTS idx_code_entities_type ON code_entities(type);
CREATE INDEX IF NOT EXISTS idx_code_entities_name ON code_entities(name);
CREATE INDEX IF NOT EXISTS idx_code_entities_path ON code_entities(file_path);
CREATE TABLE IF NOT EXISTS code_relations (id INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL,target_id TEXT NOT NULL,type TEXT NOT NULL,FOREIGN KEY(source_id) REFERENCES code_entities(id),FOREIGN KEY(target_id) REFERENCES code_entities(id));
CREATE INDEX IF NOT EXISTS idx_code_relations_source ON code_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_code_relations_target ON code_relations(target_id);
CREATE TABLE IF NOT EXISTS code_files (path TEXT PRIMARY KEY,hash TEXT NOT NULL,language TEXT NOT NULL,indexed_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE VIRTUAL TABLE IF NOT EXISTS code_entities_fts USING fts5(name,signature,docstring,content='code_entities',content_rowid='rowid',tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS code_entities_ai AFTER INSERT ON code_entities BEGIN INSERT INTO code_entities_fts(rowid,name,signature,docstring) VALUES (new.rowid,new.name,new.signature,new.docstring); END;
CREATE TRIGGER IF NOT EXISTS code_entities_ad AFTER DELETE ON code_entities BEGIN INSERT INTO code_entities_fts(code_entities_fts,rowid,name,signature,docstring) VALUES ('delete',old.rowid,old.name,old.signature,old.docstring); END;
CREATE TRIGGER IF NOT EXISTS code_entities_au AFTER UPDATE ON code_entities BEGIN INSERT INTO code_entities_fts(code_entities_fts,rowid,name,signature,docstring) VALUES ('delete',old.rowid,old.name,old.signature,old.docstring); INSERT INTO code_entities_fts(rowid,name,signature,docstring) VALUES (new.rowid,new.name,new.signature,new.docstring); END;
"""
def ensure_codemap_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(CODEMAP_SCHEMA_SQL); conn.commit()
def drop_codemap_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("DROP TRIGGER IF EXISTS code_entities_ai;DROP TRIGGER IF EXISTS code_entities_ad;DROP TRIGGER IF EXISTS code_entities_au;DROP TABLE IF EXISTS code_entities_fts;DROP TABLE IF EXISTS code_relations;DROP TABLE IF EXISTS code_entities;DROP TABLE IF EXISTS code_files;"); conn.commit()
def _hash_content(c: str) -> str: return hashlib.sha256(c.encode()).hexdigest()
def _entity_id(fp: str, name: str, tp: str) -> str: return hashlib.sha256(f"{fp}:{name}:{tp}".encode()).hexdigest()[:16]
def _parse_python_entities(fp: str, content: str) -> tuple[list[dict[str,Any]], list[dict[str,Any]]]:  # noqa: C901, PLR0912, PLR0915
    ents: list[dict[str,Any]] = []; rels: list[dict[str,Any]] = []; ph: dict[str,dict[str,Any]] = {}
    try: tree = ast.parse(content, filename=fp)
    except SyntaxError: return [], []
    file_mod: str|None = None
    def _file_mod() -> str:
        nonlocal file_mod
        if file_mod is None:
            stem = Path(fp).stem; fid=_entity_id(fp,stem,"module")
            if fid not in ph: ph[fid]={"id":fid,"file_path":fp,"name":stem,"type":"module","language":"python","start_line":1,"end_line":1,"signature":f"module {stem}","docstring":""}
            file_mod=fid
        return file_mod
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            cid=_entity_id(fp,node.name,"class"); doc=ast.get_docstring(node) or ""
            bases=[]
            for b in node.bases:
                if isinstance(b, ast.Name): bases.append(b.id)
                elif isinstance(b, ast.Attribute): bases.append(b.attr)
            sig=f"class {node.name}({', '.join(bases)})" if bases else f"class {node.name}"
            ents.append({"id":cid,"file_path":fp,"name":node.name,"type":"class","language":"python","start_line":getattr(node,"lineno",0),"end_line":getattr(node,"end_lineno",0) or getattr(node,"lineno",0),"signature":sig,"docstring":doc})
            for base in bases:
                tid=_entity_id(f"external:{base}",base,"class")
                if tid not in ph: ph[tid]={"id":tid,"file_path":f"external:{base}","name":base,"type":"class","language":"python","start_line":0,"end_line":0,"signature":f"class {base}","docstring":""}
                rels.append({"source_id":cid,"target_id":tid,"type":"inherits"})
            for item in node.body:
                if isinstance(item,(ast.FunctionDef,ast.AsyncFunctionDef)):
                    mid=_entity_id(fp,f"{node.name}.{item.name}","method"); docm=ast.get_docstring(item) or ""; args=", ".join(a.arg for a in item.args.args); sig_m=f"def {item.name}({args})"
                    ents.append({"id":mid,"file_path":fp,"name":f"{node.name}.{item.name}","type":"method","language":"python","start_line":getattr(item,"lineno",0),"end_line":getattr(item,"end_lineno",0) or getattr(item,"lineno",0),"signature":sig_m,"docstring":docm})
        elif isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)):
            fid=_entity_id(fp,node.name,"function"); doc=ast.get_docstring(node) or ""; args=", ".join(a.arg for a in node.args.args); sig=f"def {node.name}({args})"
            ents.append({"id":fid,"file_path":fp,"name":node.name,"type":"function","language":"python","start_line":getattr(node,"lineno",0),"end_line":getattr(node,"end_lineno",0) or getattr(node,"lineno",0),"signature":sig,"docstring":doc})
        elif isinstance(node, ast.Import):
            for alias in node.names:
                mod=alias.name.split(".")[0]; tid=_entity_id(f"external:{mod}",mod,"module")
                if tid not in ph: ph[tid]={"id":tid,"file_path":f"external:{mod}","name":mod,"type":"module","language":"python","start_line":0,"end_line":0,"signature":f"import {mod}","docstring":""}
                src=_file_mod(); rels.append({"source_id":src,"target_id":tid,"type":"imports"})
        elif isinstance(node, ast.ImportFrom):
            mod=(node.module or "").split(".")[0]
            if mod:
                tid=_entity_id(f"external:{mod}",mod,"module")
                if tid not in ph: ph[tid]={"id":tid,"file_path":f"external:{mod}","name":mod,"type":"module","language":"python","start_line":0,"end_line":0,"signature":f"from {mod} import ...","docstring":""}
                src=_file_mod(); rels.append({"source_id":src,"target_id":tid,"type":"imports"})
    eids={e["id"] for e in ents}
    for pid,pent in ph.items():
        if pid not in eids: ents.append(pent)
    return ents, rels
_TS_CLASS_RE=re.compile(r"^\s*(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?",re.MULTILINE)
_TS_INTERFACE_RE=re.compile(r"^\s*(?:export\s+)?interface\s+(\w+)",re.MULTILINE)
_TS_FUNC_RE=re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(",re.MULTILINE)
_TS_CONST_RE=re.compile(r"^\s*(?:export\s+)?const\s+(\w+)\s*(?:[:=])",re.MULTILINE)
_TS_IMPORT_RE=re.compile(r"^\s*import\s+.*?from\s+['\"]([^'\"]+)['\"]",re.MULTILINE)
def _parse_typescript_entities(fp: str, content: str) -> tuple[list[dict[str,Any]], list[dict[str,Any]]]:  # noqa: C901
    ents: list[dict[str,Any]]=[]; rels: list[dict[str,Any]]=[]; ph: dict[str,dict[str,Any]]={}
    def _ph(name: str, tp: str, sig: str) -> str:
        tid=_entity_id(f"external:{name}",name,tp)
        if tid not in ph: ph[tid]={"id":tid,"file_path":f"external:{name}","name":name,"type":tp,"language":"typescript","start_line":0,"end_line":0,"signature":sig,"docstring":""}
        return tid
    lines=content.splitlines()
    def _line(pat: str, name: str) -> int:
        for i,l in enumerate(lines, start=1):
            if pat in l and name in l: return i
        return 1
    for m in _TS_CLASS_RE.finditer(content):
        name=m.group(1); base=m.group(2); cid=_entity_id(fp,name,"class"); sig=f"class {name}"+(f" extends {base}" if base else "")
        ents.append({"id":cid,"file_path":fp,"name":name,"type":"class","language":"typescript","start_line":_line("class",name),"end_line":_line("class",name),"signature":sig,"docstring":""})
        if base: tid=_ph(base,"class",f"class {base}"); rels.append({"source_id":cid,"target_id":tid,"type":"inherits"})
    for m in _TS_INTERFACE_RE.finditer(content):
        name=m.group(1); iid=_entity_id(fp,name,"interface")
        ents.append({"id":iid,"file_path":fp,"name":name,"type":"interface","language":"typescript","start_line":_line("interface",name),"end_line":_line("interface",name),"signature":f"interface {name}","docstring":""})
    for m in _TS_FUNC_RE.finditer(content):
        name=m.group(1); fid=_entity_id(fp,name,"function")
        ents.append({"id":fid,"file_path":fp,"name":name,"type":"function","language":"typescript","start_line":_line("function",name),"end_line":_line("function",name),"signature":f"function {name}()","docstring":""})
    for m in _TS_CONST_RE.finditer(content):
        name=m.group(1); cid=_entity_id(fp,name,"const")
        ents.append({"id":cid,"file_path":fp,"name":name,"type":"const","language":"typescript","start_line":_line("const",name),"end_line":_line("const",name),"signature":f"const {name}","docstring":""})
    for m in _TS_IMPORT_RE.finditer(content):
        raw=m.group(1); mod=raw.split("/")[-1].replace(".js","").replace(".ts","") or raw; tid=_ph(mod,"module",f"import {raw}"); stem=Path(fp).stem; src=_entity_id(fp,stem,"module")
        if src not in {e["id"] for e in ents} and src not in ph: ph[src]={"id":src,"file_path":fp,"name":stem,"type":"module","language":"typescript","start_line":1,"end_line":1,"signature":f"module {stem}","docstring":""}
        rels.append({"source_id":src,"target_id":tid,"type":"imports"})
    eids={e["id"] for e in ents}
    for pid,pent in ph.items():
        if pid not in eids: ents.append(pent)
    return ents, rels
def _insert_entities_and_relations(conn: sqlite3.Connection, ents: list[dict[str,Any]], rels: list[dict[str,Any]]) -> None:
    for e in ents:
        conn.execute("INSERT OR REPLACE INTO code_entities (id,file_path,name,type,language,start_line,end_line,signature,docstring) VALUES (?,?,?,?,?,?,?,?,?)",[e["id"],e["file_path"],e["name"],e["type"],e["language"],e["start_line"],e["end_line"],e["signature"],e["docstring"]])
    for r in rels:
        if not conn.execute("SELECT 1 FROM code_relations WHERE source_id=? AND target_id=? AND type=?", [r["source_id"],r["target_id"],r["type"]]).fetchone():
            conn.execute("INSERT INTO code_relations (source_id,target_id,type) VALUES (?,?,?)", [r["source_id"],r["target_id"],r["type"]])
def code_index(conn: sqlite3.Connection, path: str|Path|None=None, force: bool=False) -> dict[str,Any]:  # noqa: C901, PLR0912, PLR0915
    ensure_codemap_schema(conn)
    base=Path(path) if path else Path.cwd()
    if not base.exists(): return {"error":f"Path not found: {base}","indexed":0,"skipped":0}
    files: list[Path]=[base] if base.is_file() else [p for ext in SUPPORTED_EXTS for p in base.rglob(f"*{ext}")]
    indexed=skipped=errors=large_skipped=unsupported=0
    for f in files:
        if any(p.startswith(".") for p in f.parts) and ".pantheon" not in str(f) and (".git" in f.parts or "__pycache__" in f.parts): continue
        if "node_modules" in f.parts or ".venv" in f.parts or "venv" in f.parts: continue
        ext=f.suffix.lower(); lang=SUPPORTED_EXTS.get(ext)
        if not lang: unsupported+=1; continue
        try:
            if f.stat().st_size > LARGE_FILE_THRESHOLD: large_skipped+=1; continue
            content=f.read_text(encoding="utf-8",errors="ignore")
            if not content.strip():
                h=_hash_content(content); conn.execute("INSERT OR REPLACE INTO code_files (path,hash,language) VALUES (?,?,?)",[str(f),h,lang]); conn.commit(); skipped+=1; continue
            h=_hash_content(content)
            row=conn.execute("SELECT hash FROM code_files WHERE path=?",[str(f)]).fetchone()
            if row and row[0]==h and not force: skipped+=1; continue
            ents,rels=_parse_python_entities(str(f),content) if lang=="python" else _parse_typescript_entities(str(f),content)
            if not ents and not rels:
                conn.execute("INSERT OR REPLACE INTO code_files (path,hash,language) VALUES (?,?,?)",[str(f),h,lang]); conn.commit()
                try: ast.parse(content)
                except SyntaxError: errors+=1; continue
                skipped+=1; continue
            _insert_entities_and_relations(conn,ents,rels)
            conn.execute("INSERT OR REPLACE INTO code_files (path,hash,language) VALUES (?,?,?)",[str(f),h,lang]); conn.commit(); indexed+=1
        except Exception: errors+=1; continue
    return {"indexed":indexed,"skipped":skipped,"errors":errors,"large_skipped":large_skipped,"unsupported":unsupported}
def code_query(conn: sqlite3.Connection, query: str, type_filter: str|None=None, limit: int=10) -> list[dict[str,Any]]:
    if not query or not query.strip(): return []
    limit=max(1,min(50,int(limit))); q=query.strip(); ensure_codemap_schema(conn)
    try:
        fts_q=" OR ".join(f'"{w}"*' for w in q.split() if w)
        if not fts_q: raise ValueError
        if type_filter:
            rows=conn.execute("SELECT e.id,e.file_path,e.name,e.type,e.language,e.start_line,e.end_line,e.signature,e.docstring FROM code_entities_fts f JOIN code_entities e ON e.rowid=f.rowid WHERE code_entities_fts MATCH ? AND e.type=? ORDER BY rank LIMIT ?",[fts_q,type_filter,limit]).fetchall()
        else:
            rows=conn.execute("SELECT e.id,e.file_path,e.name,e.type,e.language,e.start_line,e.end_line,e.signature,e.docstring FROM code_entities_fts f JOIN code_entities e ON e.rowid=f.rowid WHERE code_entities_fts MATCH ? ORDER BY rank LIMIT ?",[fts_q,limit]).fetchall()
        if rows: return [dict(r) for r in rows]
    except Exception: pass
    try:
        like=f"%{q}%"
        if type_filter:
            rows=conn.execute("SELECT id,file_path,name,type,language,start_line,end_line,signature,docstring FROM code_entities WHERE (name LIKE ? OR signature LIKE ? OR docstring LIKE ?) AND type=? LIMIT ?",[like,like,like,type_filter,limit]).fetchall()
        else:
            rows=conn.execute("SELECT id,file_path,name,type,language,start_line,end_line,signature,docstring FROM code_entities WHERE name LIKE ? OR signature LIKE ? OR docstring LIKE ? LIMIT ?",[like,like,like,limit]).fetchall()
        return [dict(r) for r in rows]
    except Exception: return []
def code_neighbors(conn: sqlite3.Connection, entity_id: str, depth: int=1) -> dict[str,Any]:
    ensure_codemap_schema(conn); depth=max(1,min(3,int(depth)))
    row=conn.execute("SELECT * FROM code_entities WHERE id=?",[entity_id]).fetchone()
    if not row: return {"error":"Entity not found","entity_id":entity_id}
    start=dict(row); visited: dict[str,dict[str,Any]]={entity_id:start}; queue=[(entity_id,0)]; edges=[]; seen=set()
    while queue:
        cur,d=queue.pop(0)
        if d>=depth: continue
        for r in conn.execute("SELECT * FROM code_relations WHERE source_id=? OR target_id=?",[cur,cur]).fetchall():
            rel=dict(r); key=(rel["source_id"],rel["target_id"],rel["type"])
            if key in seen: continue
            seen.add(key); edges.append(rel)
            nid=rel["target_id"] if rel["source_id"]==cur else rel["source_id"]
            if nid not in visited:
                nrow=conn.execute("SELECT * FROM code_entities WHERE id=?",[nid]).fetchone()
                visited[nid]=dict(nrow) if nrow else {"id":nid,"file_path":"external:unknown","name":nid,"type":"placeholder","language":"","start_line":0,"end_line":0,"signature":"","docstring":""}
                if d+1<depth: queue.append((nid,d+1))
    return {"entity":start,"neighbors":[v for k,v in visited.items() if k!=entity_id],"relations":edges,"depth":depth}
