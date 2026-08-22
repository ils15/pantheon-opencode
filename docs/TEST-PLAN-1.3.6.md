# Beta 1.3.6 — Manual Test Plan

> Human-readable checklist for the 1.3.6-beta release. Each item is a concrete
> command or step that can be verified in <2 minutes.

---

## Memory Decay

- [ ] `memory_search` without `decay_days` → backward compatible (same results as before)
- [ ] `memory_search(query="test", decay_days=30)` → newer memories rank higher than older ones with similar content
- [ ] Store 2 memories with same content, different dates → decay ranking correct

```bash
# Step 2: store two memories with identical content but far-apart timestamps
pantheon-memory_memory_store --key "decay-test-old" --value "test content alpha" --metadata '{"created_at": "2025-01-01T00:00:00"}'
pantheon-memory_memory_store --key "decay-test-new" --value "test content alpha" --metadata '{"created_at": "2026-08-20T00:00:00"}'

# Step 3: search with decay — new one should rank first
pantheon-memory_memory_search --query "test content" --decay_days 30
```

---

## Comment Checker

- [ ] Create a skill with excessive comments (`# increment i`, `# set x = 5`) → Themis flags it
- [ ] Create a skill with clean code → Themis passes

```bash
# Step 1: create a noisy skill
mkdir -p /tmp/skill-noisy
cat > /tmp/skill-noisy/SKILL.md <<'EOF'
# Noisy Skill
```python
# increment i
i = i + 1
# set x = 5
x = 5
# compute result
result = x + i
```
EOF

# Step 2: run Themis on it (should flag excessive comments)
# In OpenCode: @themis Review /tmp/skill-noisy/SKILL.md for comment noise

# Step 3: create a clean skill
mkdir -p /tmp/skill-clean
cat > /tmp/skill-clean/SKILL.md <<'EOF'
# Clean Skill
```python
i = i + 1
x = 5
result = x + i
```
EOF
# In OpenCode: @themis Review /tmp/skill-clean/SKILL.md for comment noise (should pass)
```

---

## Persistence TTL

- [ ] `kv_store` with TTL=5 → `kv_get` after 6s returns null (previously broken same-day)
- [ ] `purge_expired` actually removes expired entries

```bash
# Step 1: store with short TTL
pantheon-persistence_kv_store --namespace "test" --key "ttl-test" --value "ephemeral" --ttl 5

# Step 2: verify it exists immediately
pantheon-persistence_kv_get --namespace "test" --key "ttl-test"
# → should return "ephemeral"

# Step 3: wait 6 seconds, then check
sleep 6
pantheon-persistence_kv_get --namespace "test" --key "ttl-test"
# → should return null

# Step 4: purge and verify
pantheon-persistence_purge_expired --dry_run
# → should show 1 entry to purge
pantheon-persistence_purge_expired
pantheon-persistence_kv_stats
# → expired count should decrease
```

---

## Code-mode

- [ ] Script with `# timeout: 2` in frontmatter → killed at ~2s
- [ ] `execute_code_script` with `json_output=True` → structured JSON response
- [ ] Script with `# allowed_args: [foo, bar]` → rejected with `baz`

```bash
# Step 1: create a slow script with 2s timeout
cat > .pantheon/code-mode/slow-test.sh <<'EOF'
#!/bin/bash
# timeout: 2
sleep 10
echo "should not reach here"
EOF
chmod +x .pantheon/code-mode/slow-test.sh

# Step 2: run it — should be killed at ~2s
pantheon-code-mode_execute_code_script --script_name "slow-test.sh"
# → should timeout, output never reaches "should not reach here"

# Step 3: create a script with allowed_args
cat > .pantheon/code-mode/args-test.sh <<'EOF'
#!/bin/bash
# allowed_args: [foo, bar]
echo "arg: $1"
EOF
chmod +x .pantheon/code-mode/args-test.sh

# Step 4: run with allowed arg (should pass)
pantheon-code-mode_execute_code_script --script_name "args-test.sh" --args '["foo"]'

# Step 5: run with disallowed arg (should reject)
pantheon-code-mode_execute_code_script --script_name "args-test.sh" --args '["baz"]'
# → should error: "baz" not in allowed_args [foo, bar]
```

---

## Routing R1/R4/O5

- [ ] Provider returning 401 → 0 retries (auth error)
- [ ] Provider returning 429 → 3 retries with exponential backoff
- [ ] Agent at max_steps → forced summarize-and-stop
- [ ] Deny glob `"bash(rm -rf *): *"` → agent removed from delegate tool description

```bash
# R1: 401 auth error — no retries
# Set a provider with invalid API key, dispatch a task
# Observe in logs: single attempt, no retry, immediate failure

# R4: 429 rate limit — 3 retries with backoff
# Use a provider with rate limiting enabled
# Observe in logs: 3 retries with increasing delays

# O5: max_steps forced stop
# Dispatch agent with max_steps=2
# Agent should summarize and stop after 2 steps, not continue

# Deny glob test
# Add to routing.yml under an agent:
#   deny:
#     - "bash(rm -rf *): *"
# Dispatch task requiring that tool
# Agent should not have the denied tool in its delegate description
```

---

## Plugin-eval

- [ ] `python .pantheon/code-mode/eval-static.py <skill-dir>` → JSON with checks + score
- [ ] `python .pantheon/code-mode/eval-monte-carlo.py <skill-dir> --runs 5` → reliability 0-100
- [ ] `python .pantheon/code-mode/eval-run.py <skill-dir> --skip-llm` → overall verdict
- [ ] `pantheon://eval` resource shows scored plugins

```bash
# Step 1: static eval
python .pantheon/code-mode/eval-static.py ~/.config/opencode/skills/memory-bank/
# → JSON output with checks array and numeric score

# Step 2: monte carlo eval
python .pantheon/code-mode/eval-monte-carlo.py ~/.config/opencode/skills/memory-bank/ --runs 5
# → JSON with reliability score (0-100)

# Step 3: full eval (skip LLM for fast check)
python .pantheon/code-mode/eval-run.py ~/.config/opencode/skills/memory-bank/ --skip-llm
# → JSON with overall verdict (pass/fail)

# Step 4: check pantheon://eval resource
# In OpenCode: read pantheon://eval
# → should list scored plugins with their scores
```

---

## S1 Deny-first

- [ ] User-level deny overrides project-level allow
- [ ] Hook exit 2 → hard block
- [ ] Missing hook → fail-open

```bash
# Step 1: set project-level allow, user-level deny
# In .opencode/permissions.json:
#   { "allow": ["bash(git *): *"] }
# In ~/.config/opencode/permissions.json:
#   { "deny": ["bash(git *): *"] }
# → git commands should be blocked (deny wins)

# Step 2: hook exit 2 = hard block
cat > .opencode/hooks/test-block.sh <<'EOF'
#!/bin/bash
exit 2
EOF
chmod +x .opencode/hooks/test-block.sh
# Trigger the hook (e.g. run a task that activates it)
# → task should be blocked, not just warned

# Step 3: missing hook = fail-open
# Reference a hook in config that doesn't exist on disk
# → operation should proceed without error (fail-open behavior)
```

---

## Code-mode Sandbox

- [ ] Script subprocess inherits only 10 allowlisted env vars (not full env)
- [ ] On Linux: prlimit applied (check with `cat /proc/self/status | grep Vm`)

```bash
# Step 1: create a script that dumps env vars
cat > .pantheon/code-mode/env-test.sh <<'EOF'
#!/bin/bash
env | wc -l
env | sort
EOF
chmod +x .pantheon/code-mode/env-test.sh

# Step 2: run it — should show ≤10 env vars, not the full environment
pantheon-code-mode_execute_code_script --script_name "env-test.sh"
# → count should be ≤10 (allowlisted vars only)

# Step 3: check memory limits (Linux only)
cat > .pantheon/code-mode/mem-test.sh <<'EOF'
#!/bin/bash
cat /proc/self/status | grep Vm
EOF
chmod +x .pantheon/code-mode/mem-test.sh

pantheon-code-mode_execute_code_script --script_name "mem-test.sh"
# → VmRSS and VmSize should show prlimit-capped values
```

---

## Hooks

- [ ] `validate-post-conditions.sh` runs without abort when no REVIEW-* files exist
- [ ] `format-multi-language.sh` triggers on lowercase `edit`/`write` (not just `Edit`/`Write`)
- [ ] `on-subagent-delegation-start.sh` no warning spam when routing.yml not found

```bash
# Step 1: run validate-post-conditions with no REVIEW files
# Ensure no REVIEW-* files exist in the working directory
bash .pantheon/hooks/validate-post-conditions.sh
# → should complete without abort (exit 0 or skip message)

# Step 2: test format-multi-language with lowercase tool names
# Simulate a hook invocation with tool="edit" (lowercase)
TOOL=edit bash .pantheon/hooks/format-multi-language.sh
# → should trigger formatting (previously only triggered on "Edit")

TOOL=write bash .pantheon/hooks/format-multi-language.sh
# → should trigger formatting

# Step 3: test delegation start hook without routing.yml
# Temporarily rename routing.yml
mv .pantheon/routing.yml .pantheon/routing.yml.bak 2>/dev/null
bash .pantheon/hooks/on-subagent-delegation-start.sh "test-agent" "test prompt"
# → should not produce warning spam
mv .pantheon/routing.yml.bak .pantheon/routing.yml 2>/dev/null
```
