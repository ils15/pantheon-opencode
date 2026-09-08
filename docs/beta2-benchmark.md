# beta2 benchmark

The beta2 benchmark is an offline, quality-first pilot for all 14 Pantheon
agents. It measures deterministic acceptance, token budget, latency, retries,
and net-token efficiency without changing production runtime or prompts.

## Checks and commands

Run these commands from the repository root:

```bash
pytest -q benchmarks/beta2
ruff check benchmarks/beta2
ruff format --check benchmarks/beta2
python3 -m compileall -q benchmarks/beta2
```

The reproducible fixture run is provider-free:

```bash
python3 -m benchmarks.beta2.runner \
  --dataset benchmarks/beta2/dataset.json \
  --mode fixture \
  --fixture benchmarks/beta2/fixtures/responses.json \
  --output-json /tmp/beta2-report.json \
  --output-markdown /tmp/beta2-report.md
```

Use `--dry-run` to validate and list the planned baseline/candidate work
without executing verification commands. CI must use `--mode fixture` (or
`--dry-run`); it must not invoke `opencode` or any LLM provider.

## Dataset and fixtures

`dataset.json` is schema `beta2.dataset.v1`. It contains one task for each of
the 14 agents, with 10 train tasks and 4 holdout tasks, deterministic
acceptance fragments, bounded verification commands, and per-task token,
latency, and retry budgets.

The versioned files under `benchmarks/beta2/fixtures/` are safe test data:

- `responses.json` contains baseline and candidate responses for every task;
  it has no credentials and is the only input needed for an offline run.
- `run.json` records the fixture-run contract and expected counts. It is a
  manifest, not a captured provider response.

Reports retain only redacted previews and SHA-256 output fingerprints. Secrets
must never be added to the dataset or fixtures.

## Quality-first metrics

Quality is evaluated before cost. A task is accepted only when every required
fragment, JSON-path assertion, and deterministic verification command passes,
and the execution stays inside its token, latency, and retry budgets.

- `total_tokens` is the sum of input, output, tool-schema, tool-output,
  retrieval, and measurement tokens.
- `net_total_tokens = total_tokens - retrieval_tokens - measurement_tokens`.
- `efficiency_accepted_per_k_tokens = accepted_tasks / (net_total_tokens / 1000)`.

The candidate cannot win by using fewer tokens when it loses quality. Reports
compare quality acceptance first, then task acceptance and net tokens.

## Holdout promotion gate

Prompt candidates are proposals only. Promotion requires all of the following:

1. The candidate meets the configured quality floor on **both** train and
   holdout; the pilot default is 100% deterministic acceptance on holdout.
2. Candidate quality does not regress against the baseline on either split.
3. The candidate improves quality or reduces net-token cost; a tie is not a
   promotion.
4. Themis reviews the report and a human approves promotion.

The benchmark never edits prompts automatically (`auto_apply` is always false).
The optional GEPA adapter only exports data, proposes deterministic local
variants, and evaluates these gates. GEPA is not a required dependency and no
LLM call is made by the adapter.

## Zeus/Apollo/Themis pilot

The pilot keeps the orchestration loop explicit: Zeus is measured on routing
without implementing, Apollo on evidence-backed read-only discovery, and
Themis on separate security and quality review gates. These tasks are included
in the same train/holdout and budget contract as the other agents so their
results remain comparable.
