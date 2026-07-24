# Test 11: Level 2 Context Compression Pipeline

Verify the full Level 2 context compression pipeline is correctly documented and implemented across the system, from priority scoring through memory bank updates.

## Impact Assessment

What this means for Pantheon users:
- **Priority-aware compression** — CRITICAL entries always expanded, LOW aggressively trimmed
- **Downstream-aware field masks** — Themis gets full context; Mnemosyne gets minimal
- **Budget allocation** — 100-line cap prevents unbounded memory bank growth
- **Cross-references** — Entity IDs (E/M/D/C) survive sprint boundaries
- **Security scrubbing** — 2 layers protect against credential leakage
- **Atomic writes** — Crash-safe updates to memory bank files

## Pre-conditions
- `skills/context-compression/SKILL.md` exists
- `skills/artifact-management/SKILL.md` exists
- Agent files in `agents/*.agent.md`

---

## TC-56: Priority Scoring — 5 Dimensions Documented

**What to verify:**
The SKILL.md specifies all 5 scoring dimensions with correct weights: Impact (0.30), Risk (0.25), Novelty (0.20), Blockers (0.15), Downstream relevance (0.10).

**How to test:**
```bash
grep -A15 "Scoring Dimensions" skills/context-compression/SKILL.md | head -25
```

**Expected result:**
5 dimensions listed with weights: Impact 0.30, Risk 0.25, Novelty 0.20, Blockers 0.15, Downstream relevance 0.10. Range 0.0–1.0.

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
grep -q "Impact.*0.30" "$SKILL" && echo "✅ Impact=0.30" || echo "❌ Impact missing"
grep -q "Risk.*0.25" "$SKILL" && echo "✅ Risk=0.25" || echo "❌ Risk missing"
grep -q "Novelty.*0.20" "$SKILL" && echo "✅ Novelty=0.20" || echo "❌ Novelty missing"
grep -q "Blockers.*0.15" "$SKILL" && echo "✅ Blockers=0.15" || echo "❌ Blockers missing"
grep -q "Downstream relevance.*0.10" "$SKILL" && echo "✅ Downstream=0.10" || echo "❌ Downstream missing"
```

**Status:** ✅

---

## TC-57: Keyword Scoring Map With All Priority Bands

**What to verify:**
The SKILL.md contains keyword-to-score mappings across all 4 priority bands (CRITICAL, HIGH, MEDIUM, LOW).

**How to test:**
```bash
grep -A40 "Keyword / Pattern" skills/context-compression/SKILL.md | head -45
```

**Expected result:**
Keyword scoring table with at least entries for: schema, migration, auth, login, JWT, token, endpoint, service, refactor, CSS, typo. Each with Impact, Risk, Novelty scores. CRITICAL keywords (schema, auth, login) have scores >= 0.75 total. LOW keywords (CSS, typo) have scores < 0.25.

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
ok=true
for kw in schema migration auth login JWT token endpoint service refactor CSS typo; do
  if grep -qi "$kw.*1.0\|$kw.*0.[89]" "$SKILL" 2>/dev/null; then
    echo "✅ keyword: $kw"
  elif grep -qi "$kw" "$SKILL" 2>/dev/null; then
    echo "⚠️  keyword: $kw (found but check scores)"
  else
    echo "❌ MISSING keyword: $kw"; ok=false
  fi
done
$ok && echo "✅ TC-57: keyword map complete" || echo "❌ TC-57: keyword map has gaps"
```

**Status:** ✅

---

## TC-58: Priority Bands — CRITICAL/HIGH/MEDIUM/LOW Thresholds

**What to verify:**
The SKILL.md defines priority bands with score ranges and storage modes.

**How to test:**
```bash
grep -A10 "Priority Bands" skills/context-compression/SKILL.md | head -15
```

**Expected result:**
CRITICAL ≥ 0.75 (Expanded 3 lines), HIGH ≥ 0.50 (2 lines), MEDIUM ≥ 0.25 (1 line), LOW < 0.25 (aggressive).

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
grep -q "CRITICAL.*0.75" "$SKILL" && echo "✅ CRITICAL≥0.75" || { echo "❌ CRITICAL"; all=false; }
grep -q "HIGH.*0.50" "$SKILL" && echo "✅ HIGH≥0.50" || { echo "❌ HIGH"; all=false; }
grep -q "MEDIUM.*0.25" "$SKILL" && echo "✅ MEDIUM≥0.25" || { echo "❌ MEDIUM"; all=false; }
grep -q "LOW.*0.25" "$SKILL" && echo "✅ LOW<0.25" || { echo "❌ LOW"; all=false; }
$all && echo "✅ TC-58: all priority bands defined" || echo "❌ TC-58: priority bands missing"
```

**Status:** ✅

---

## TC-59: Downstream-Aware Field Masks

**What to verify:**
The SKILL.md defines field masks for each (from_agent, to_agent) pair, specifying which fields survive compression.

**How to test:**
```bash
grep -A30 "Field Masks Per Agent Pair" skills/context-compression/SKILL.md | head -35
```

**Expected result:**
Field masks table covering: Hermes→Aphrodite, Hermes→Demeter, Demeter→Hermes, Aphrodite→Hermes, Themis→*, *→Themis (*→Themis preserves ALL fields). Each mask specifies which fields are preserved.

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
for pair in "hermes → aphrodite" "hermes → demeter" "demeter → hermes" "themis → \*" "\* → themis" "\* → mnemosyne"; do
  if grep -qi "$pair" "$SKILL" 2>/dev/null; then
    echo "✅ pair: $pair"
  else
    echo "❌ MISSING pair: $pair"; all=false
  fi
done
grep -q "preserve ALL" "$SKILL" && echo "✅ *→Themis preserves ALL" || { echo "❌ *→Themis"; all=false; }
$all && echo "✅ TC-59: field masks complete" || echo "❌ TC-59: field masks missing"
```

**Status:** ✅

---

## TC-60: Budget Allocation — 100-Line Cap + Greedy Algorithm

**What to verify:**
The SKILL.md specifies the budget allocation algorithm: TOTAL_BUDGET = 100 lines, priority-greedy, CRITICAL always expanded, carryover for unused budget.

**How to test:**
```bash
grep -A25 "Budget Allocation Algorithm" skills/context-compression/SKILL.md | head -30
```

**Expected result:**
TOTAL_BUDGET = 100 lines. PER_PHASE_BUDGET = TOTAL/estimated_phases (floor 5). CRITICAL always expanded (non-negotiable). Priority-greedy: sort by score, allocate CRITICAL first, then HIGH, MEDIUM, LOW. 20% of unused budget carries forward.

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
grep -q "TOTAL_BUDGET" "$SKILL" && echo "✅ TOTAL_BUDGET" || { echo "❌ TOTAL_BUDGET"; all=false; }
grep -q "100 lines" "$SKILL" && echo "✅ 100-line cap" || { echo "❌ 100-line cap"; all=false; }
grep -q "Priority-Greedy" "$SKILL" && echo "✅ greedy algorithm" || { echo "❌ greedy"; all=false; }
grep -q "carryover\|carry forward\|Carryover" "$SKILL" && echo "✅ carryover" || { echo "❌ carryover"; all=false; }
$all && echo "✅ TC-60: budget allocation complete" || echo "❌ TC-60: budget allocation missing"
```

**Status:** ✅

---

## TC-61: Cross-Reference Mechanism — Entity IDs (E/M/D/C)

**What to verify:**
The SKILL.md defines cross-reference IDs for entities: E{NNNN} endpoints, M{NNNN} migrations, D{NNNN} decisions, C{NNNN} components. Auto-generated in `_xref/index.md`.

**How to test:**
```bash
grep -A15 "Reference ID Format" skills/context-compression/SKILL.md | head -20
```

**Expected result:**
E{NNNN} for endpoints, M{NNNN} for migrations, D{NNNN} for decisions, C{NNNN} for components. IDs are monotonic from `_xref/_next_id.json`. Cross-ref file updated when CRITICAL entry mentions endpoints/tables.

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
for entity in "E{NNNN}" "M{NNNN}" "D{NNNN}" "C{NNNN}"; do
  grep -q "$entity" "$SKILL" && echo "✅ entity: $entity" || { echo "❌ MISSING: $entity"; all=false; }
done
grep -q "_xref/index.md" "$SKILL" && echo "✅ xref index" || { echo "❌ xref index"; all=false; }
$all && echo "✅ TC-61: cross-references defined" || echo "❌ TC-61: cross-references missing"
```

**Status:** ✅

---

## TC-62: ZZ Artifact Format

**What to verify:**
The SKILL.md specifies the ZZ-phase{N}-context.md artifact format that bridges phases. It lives in `.tmp/` and is injected into next phase agent prompts.

**How to test:**
```bash
grep -A30 "ZZ Artifact Format" skills/context-compression/SKILL.md | head -35
```

**Expected result:**
Format includes: Phase N → Phase N+1 header, Budget section (allocated/used/carried), Priority Entries with CRITICAL (expanded 3 lines), HIGH (2 lines), STANDARD (1 line), Cross-References section.

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
grep -q "ZZ-phase" "$SKILL" && echo "✅ ZZ artifact" || { echo "❌ ZZ artifact"; all=false; }
grep -q "Priority Entries" "$SKILL" && echo "✅ priority entries" || { echo "❌ priority entries"; all=false; }
grep -q "Cross-References" "$SKILL" && echo "✅ cross-refs section" || { echo "❌ cross-refs section"; all=false; }
grep -q "injected into the next" "$SKILL" && echo "✅ injected into prompts" || { echo "❌ injected"; all=false; }
$all && echo "✅ TC-62: ZZ artifact format OK" || echo "❌ TC-62: ZZ artifact missing"
```

**Status:** ✅

---

## TC-63: Safety Preflight — Never Compress Active Work

**What to verify:**
The SKILL.md defines strict safety rules: never compress in_progress/escalated/blocked, never compress REVIEW with NEEDS_REVISION/FAILED, never compress ADRs.

**How to test:**
```bash
grep -A30 "Safety Rules" skills/context-compression/SKILL.md | head -35
```

**Expected result:**
5 safety rules: (1) in_progress/escalated/blocked → skip, (2) NEEDS_REVISION/FAILED → skip, (3) active PLAN → skip, (4) ADR notes → NEVER touch, (5) active blockers → skip. Escalate to Zeus on skipped items.

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
grep -q "NEVER compress" "$SKILL" && echo "✅ NEVER compress rule" || { echo "❌ NEVER compress"; all=false; }
grep -q "in_progress" "$SKILL" && echo "✅ protects in_progress" || { echo "❌ in_progress"; all=false; }
grep -q "NEEDS_REVISION\|FAILED" "$SKILL" && echo "✅ protects review failures" || { echo "❌ review failures"; all=false; }
grep -q "ADR" "$SKILL" && echo "✅ protects ADRs" || { echo "❌ ADRs"; all=false; }
$all && echo "✅ TC-63: safety rules complete" || echo "❌ TC-63: safety rules missing"
```

**Status:** ✅

---

## TC-64: Security Scrubbing — 2-Layer Protection

**What to verify:**
The SKILL.md specifies 2-layer security scrubbing: Layer 1 (structural — metadata only), Layer 2 (regex — API keys, tokens, passwords, private keys).

**How to test:**
```bash
grep -A30 "Security Scrubbing" skills/context-compression/SKILL.md | head -35
```

**Expected result:**
Layer 1: only promote structured metadata (file paths, status, verdicts, dates). Never promote raw stdout, test output, stack traces, env vars. Layer 2: regex patterns for api_key, token, secret, password, auth_token, PRIVATE KEY, GitHub PATs, OpenAI keys.

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
grep -q "Layer 1" "$SKILL" && echo "✅ Layer 1 structural" || { echo "❌ Layer 1"; all=false; }
grep -q "Layer 2" "$SKILL" && echo "✅ Layer 2 regex" || { echo "❌ Layer 2"; all=false; }
grep -q 'api\[_-]?key' "$SKILL" && echo "✅ api_key pattern" || { echo "❌ api_key"; all=false; }
grep -q "PRIVATE" "$SKILL" && echo "✅ private key pattern" || { echo "❌ private key"; all=false; }
grep -q "github_pat\|ghp_" "$SKILL" && echo "✅ GitHub PAT" || { echo "❌ GitHub PAT"; all=false; }
$all && echo "✅ TC-64: scrubbing layers complete" || echo "❌ TC-64: scrubbing missing"
```

**Status:** ✅

---

## TC-65: Atomic Write Protocol

**What to verify:**
The SKILL.md specifies atomic writes for all memory bank updates: write to .tmp, fsync, validate (>0 bytes, has heading), os.rename(.tmp, target).

**How to test:**
```bash
grep -A20 "Transactional Write\|atomic_write\|Atomic Write" skills/context-compression/SKILL.md | head -25
```

**Expected result:**
4-step protocol: (1) Write to .tmp file, (2) fsync(), (3) Validate (>0 bytes, has heading), (4) os.rename(). Crash recovery: stale .tmp cleaned on next startup (>5 min old).

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
grep -q "fsync\|fsync" "$SKILL" && echo "✅ fsync" || { echo "❌ fsync"; all=false; }
grep -q "os.rename\|atomic rename" "$SKILL" && echo "✅ atomic rename" || { echo "❌ rename"; all=false; }
grep -q "\.tmp" "$SKILL" && echo "✅ .tmp intermediate" || { echo "❌ .tmp"; all=false; }
$all && echo "✅ TC-65: atomic write protocol OK" || echo "❌ TC-65: atomic write missing"
```

**Status:** ✅

---

## TC-66: Idempotency — Content Hashing Prevents Duplicates

**What to verify:**
The SKILL.md specifies idempotency rules for all compression targets: entries are keyed by (date, phase, agent) + content hash. Same key + same hash → skip. Same key + different hash → overwrite.

**How to test:**
```bash
grep -A30 "Idempotency" skills/context-compression/SKILL.md | head -35
```

**Expected result:**
Idempotency table covering: 01-active-context.md (date+phase+agent+hash), 02-progress-log.md (section heading), _xref/index.md (E/M/D/C ID), .tmp deletion. Content hash = SHA256(canonical key)[:16].

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
grep -q "Idempotency" "$SKILL" && echo "✅ idempotency defined" || { echo "❌ idempotency"; all=false; }
grep -q "content hash\|Content Hash\|sha256\|SHA256" "$SKILL" && echo "✅ content hashing" || { echo "❌ content hash"; all=false; }
$all && echo "✅ TC-66: idempotency OK" || echo "❌ TC-66: idempotency missing"
```

**Status:** ✅

---

## TC-67: Wisdom Bridge — Learning Extraction Between Phases

**What to verify:**
The SKILL.md specifies the Wisdom Bridge: learning extraction happens BEFORE compression, non-blocking failures. Surviving learnings promoted to atomic facts at sprint close.

**How to test:**
```bash
grep -A25 "Wisdom Bridge" skills/context-compression/SKILL.md | head -30
```

**Expected result:**
Phase N Themis APPROVED → Extract learnings → Compression fires → Next agent dispatched with ZZ artifact + learnings. Extraction is advisory, compression is mandatory. Surviving learnings promoted to `/memories/repo/` at sprint close.

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
grep -q "Wisdom Bridge" "$SKILL" && echo "✅ Wisdom Bridge" || { echo "❌ Wisdom Bridge"; all=false; }
grep -q "learnings" "$SKILL" && echo "✅ learnings extraction" || { echo "❌ learnings"; all=false; }
grep -q "sprint close\|sprint.*close" "$SKILL" && echo "✅ sprint close handling" || { echo "❌ sprint close"; all=false; }
$all && echo "✅ TC-67: Wisdom Bridge OK" || echo "❌ TC-67: Wisdom Bridge missing"
```

**Status:** ✅

---

## TC-68: Zeus Loads context-compression Skill

**What to verify:**
Zeus's `.agent.md` lists `context-compression` in its skills, meaning the compression instructions are loaded into his context.

**How to test:**
```bash
grep -A5 "skills:" agents/zeus.agent.md | head -8
```

**Expected result:**
`context-compression` is in Zeus's skills list, alongside agent-coordination, artifact-management, auto-continue, internet-search, orchestration-workflow.

**Validation command:**
```bash
grep -q "context-compression" agents/zeus.agent.md && echo "✅ Zeus has context-compression skill" || echo "❌ Zeus missing context-compression skill"
```

**Status:** ✅

---

## TC-69: Mnemosyne Manages Compression Artifacts

**What to verify:**
Mnemosyne's agent file includes instructions for creating/archiving compression artifacts (ZZ artifacts, cross-refs, memory bank updates).

**How to test:**
```bash
grep -c "compression\|ZZ-phase\|archive\|compress\|xref\|cross.ref" agents/mnemosyne.agent.md
```

**Expected result:**
Mnemosyne has compression-related instructions. The compression pipeline involves Mnemosyne writing files.

**Validation command:**
```bash
COUNT=$(grep -ci "compress\|zz-phase\|archive\|xref" agents/mnemosyne.agent.md)
[ "$COUNT" -ge 3 ] && echo "✅ Mnemosyne has compression instructions ($COUNT refs)" || echo "❌ Mnemosyne missing compression instructions (only $COUNT refs)"
```

**Status:** ✅

---

## TC-70: Artifact Protocol Defines Temp Folder + Lifecycle

**What to verify:**
`skills/artifact-management/SKILL.md` defines the .tmp/ folder for ephemeral artifacts, the artifact lifecycle, and cleanup on sprint close.

**How to test:**
```bash
grep -A10 "Temp Folder\|Core Concept: Temp\|\.tmp/" skills/artifact-management/SKILL.md | head -15
```

**Expected result:**
All ephemeral artifacts (PLAN, IMPL, REVIEW, DISC) go to `.pantheon/memory-bank/.tmp/`. This folder is gitignored, wiped on sprint close. Only ADR notes (`_notes/`) are permanent.

**Validation command:**
```bash
AP=skills/artifact-management/SKILL.md
all=true
grep -q "\.tmp/" "$AP" && echo "✅ .tmp/ folder defined" || { echo "❌ .tmp/"; all=false; }
grep -q "sprint close\|Close sprint" "$AP" && echo "✅ sprint close cleanup" || { echo "❌ sprint close"; all=false; }
grep -q "ephemeral\|Ephemeral" "$AP" && echo "✅ ephemeral artifacts" || { echo "❌ ephemeral"; all=false; }
$all && echo "✅ TC-70: artifact protocol OK" || echo "❌ TC-70: artifact protocol missing"
```

**Status:** ✅

---

## TC-71: Budget Guardrails — CRITICAL Floor + Overflow

**What to verify:**
The SKILL.md specifies budget guardrails: CRITICAL always expanded (non-negotiable), overflow detection (>5 CRITICAL → flag Zeus), exceed budget (CRITICAL > 100 lines → escalate), C7 trim (LOW first).

**How to test:**
```bash
grep -A25 "Budget Guardrails" skills/context-compression/SKILL.md | head -30
```

**Expected result:**
Guardrails: CRITICAL floor (always expanded), Overflow flag (>5 CRITICAL per phase), Exceed budget (CRITICAL > 100 lines → escalate), Carryover (20% of unused), Ceiling (100 lines hard cap), C7 trim (LOW first, then MEDIUM to 0.5 lines).

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
grep -q "CRITICAL floor\|CRITICAL.*always expanded" "$SKILL" && echo "✅ CRITICAL floor" || { echo "❌ CRITICAL floor"; all=false; }
grep -q "Overflow\|overflow" "$SKILL" && echo "✅ overflow detection" || { echo "❌ overflow"; all=false; }
grep -q "Carryover\|carryover" "$SKILL" && echo "✅ carryover" || { echo "❌ carryover"; all=false; }
grep -q "C7 trim\|C7.*trim" "$SKILL" && echo "✅ C7 trim" || { echo "❌ C7 trim"; all=false; }
$all && echo "✅ TC-71: budget guardrails OK" || echo "❌ TC-71: budget guardrails missing"
```

**Status:** ✅

---

## TC-72: Concurrency — Zeus Batches Parallel Compressions

**What to verify:**
The SKILL.md specifies concurrency handling: Zeus batches parallel phase completions into a single compression call. Lockfile safety net.

**How to test:**
```bash
grep -A15 "Concurrency\|batches.*parallel\|lockfile" skills/context-compression/SKILL.md | head -20
```

**Expected result:**
Batching rule: Zeus collects all subtask_summaries from parallel phases, dispatches single compression to Mnemosyne. Lockfile at `.pantheon/memory-bank/.tmp/compress.lock` with `flock`.

**Validation command:**
```bash
SKILL=skills/context-compression/SKILL.md
all=true
grep -q "batches\|batching\|batch" "$SKILL" && echo "✅ batch compression" || { echo "❌ batching"; all=false; }
grep -q "lockfile\|compress.lock" "$SKILL" && echo "✅ lockfile" || { echo "❌ lockfile"; all=false; }
$all && echo "✅ TC-72: concurrency OK" || echo "❌ TC-72: concurrency missing"
```

**Status:** ✅

---

## Results

| Test | Description | Status |
|------|-------------|--------|
| TC-56 | Priority scoring 5 dimensions | ✅ |
| TC-57 | Keyword scoring map with all bands | ✅ |
| TC-58 | Priority band thresholds (≥0.75, ≥0.50, ≥0.25) | ✅ |
| TC-59 | Downstream-aware field masks per agent pair | ✅ |
| TC-60 | Budget allocation: 100-line cap, greedy, carryover | ✅ |
| TC-61 | Cross-references: E/M/D/C entity IDs | ✅ |
| TC-62 | ZZ artifact format (Phase N→N+1) | ✅ |
| TC-63 | Safety preflight: never compress active work | ✅ |
| TC-64 | Security scrubbing: 2-layer (structural + regex) | ✅ |
| TC-65 | Atomic write protocol (.tmp → fsync → rename) | ✅ |
| TC-66 | Idempotency: content hashing prevents duplicates | ✅ |
| TC-67 | Wisdom Bridge: learning extraction before compression | ✅ |
| TC-68 | Zeus loads context-compression skill | ✅ |
| TC-69 | Mnemosyne manages compression artifacts | ✅ |
| TC-70 | Artifact protocol defines temp folder + lifecycle | ✅ |
| TC-71 | Budget guardrails: CRITICAL floor, overflow, C7 trim | ✅ |
| TC-72 | Concurrency: Zeus batches, lockfile safety | ✅ |
