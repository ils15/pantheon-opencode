# Offline evaluation protocol: routing and complexity

**Status (2026-10-29): protocol only.** This document specifies a future offline
evaluation; it reports no benchmark results. No local dataset or benchmark has
been established, no model calls were made, no provider was selected, and no
transfer of data to a provider was authorized. “Offline” means scoring a frozen
set of task cases separately from live routing; it does not make a remote model
request local or private.

## Questions and candidates

Compare four candidates on the same held-out cases, but treat these as two
independent tasks:

1. **Agent selection/routing:** identify the appropriate action (inline, agent,
   or coordinated actions), or abstain.
2. **Complexity classification:** label the task low, medium, or high,
   or abstain. Do not use a routing decision as the complexity label.

| Candidate | Evaluation role | Primary reference |
|---|---|---|
| Current dispatcher / baseline track | Incumbent dispatch is qualitative. A deterministic rule baseline is not yet defined or approved, so this track has no scoreable baseline output. | [`src/agents/zeus.md`](https://github.com/ils15/pantheon-opencode/blob/main/src/agents/zeus.md); [Architecture](../ARCHITECTURE.md#agent-flow) |
| TypeSafe Jev 1.14 | Candidate model | [TypeSafe models](https://docs.typesafe.ai/models) |
| OpenAI Decisions / GPT-6 Luna | Candidate model | [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) |
| Cloudflare Clef-Flash | Candidate model | [Cloudflare Clef-Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) |

The three model entries are candidates, not endorsements, compatibility claims,
or a provider choice. Vendor specifications, pricing, and latency are vendor
claims, not independent evidence; evaluate quality and measure latency/cost on
the same authorized run rather than using catalog claims as results.

## Baselines and labels

### Incumbent dispatcher and rule-baseline prerequisite

Pantheon's documented dispatcher is qualitative: self-contained work may stay
inline; expertise, uncertainty, dependencies, risk, and verifiability inform
specialist selection; independent fronts may be dispatched separately; and
planning, discovery, or review is added when scope and risk call for it. It does
not specify a complete role-to-task mapping, thresholds for ambiguity, or a
tie-break rule. It is an incumbent policy reference, **not a deterministic
baseline**, and no performance for it has been measured.

A separate deterministic rule baseline can be scored only after its role map,
route/action rules, ambiguity/abstention rule, and treatment of optional review
or supporting dispatches are explicitly written and approved as product policy.
The current docs do not supply these decisions. This protocol does not invent
them: until approval, a deterministic baseline and the empirical candidate
comparison must wait. Do not report a qualitative dispatcher judgment as a
deterministic baseline result.

### Reproducible evaluation protocol (prerequisites; not yet run)

Before annotation or scoring, freeze the relevant agent-role descriptions,
routing instructions, and approved evaluation rubric. Record the source commit
SHA, freeze date, and hashes of the frozen files in the evaluation record; any
change requires a new versioned evaluation. No evaluation snapshot is frozen by
this document.

For each case, two independently assigned raters annotate the gold route and
complexity while blinded to model and baseline outputs. Resolve disagreements
with a third, pre-named **routing-policy adjudicator** who records the rationale
and final decision. The raters and adjudicator have not been assigned. If no
adjudicator or approved role map is available, do not score that case or claim a
benchmark.

Represent the route as required action slots, not one forced winner. Each slot
contains the adjudicated set of acceptable role/action alternatives; a
multi-front task may have multiple required slots. A prediction satisfies a
slot if it selects one member of that slot's accepted set, with each predicted
action matched at most once. Unfilled slots are misses; unsupported extra
dispatches are false positives. Report slot-level precision/recall/F1 and exact
route-set accuracy. Keep optional supporting actions in separate adjudicated
slots; do not add alternatives or resolve ties after seeing model outputs. If
raters cannot agree on acceptable alternatives after adjudication, mark the
case unresolved, exclude it from the primary score, and report it separately.

The following is a **proposed evaluation rubric, not existing Pantheon policy**;
its approval is a prerequisite to any empirical run. Independently score each
dimension as 0, 1, or 2 using the frozen task context:

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Boundedness | Localized, explicit scope | Bounded but spans components | Broad, unclear, or unbounded scope |
| Reversibility | Straightforward rollback | Reversible with planned migration/coordination | Hard to reverse or materially irreversible |
| Dependencies | None or direct | Known local sequencing | Cross-front, sequential, or unknown dependencies |
| Uncertainty | Requirements and context clear | Limited, bounded unknowns | Material unresolved requirements/context |
| Verification | Direct focused check | Several component-level checks | Broad integration or extensive independent verification |
| Sensitive-gate status | No security/auth/data-integrity gate identified | Required review gate | Explicit human authorization required or gate status unresolved |

Assign **low** only when all dimensions are 0; **medium** when no dimension is
2 and at least one is 1; **high** when any dimension is 2. If required context is
missing, retain the uncertainty score and mark the case for adjudication rather
than guessing. Record sensitive-gate status separately alongside the complexity
label. These labels never remove or relax a gate, authorize work, grant shell, or
change approval requirements; security and authorization remain orthogonal
controls for every label.

There is no local annotated dataset, approved task-to-role routing map, assigned
rater/adjudicator, or approved rubric at present. These are open prerequisites,
not completed work.

## Dataset and run protocol

1. **Curate only after authorization.** No local dataset currently exists.
   Prefer synthetic or explicitly approved, non-sensitive task summaries. Do
   not include source code, secrets, personal data, private repository details,
   or full conversation history unless separately reviewed and authorized.
2. **Create labels before model evaluation.** Follow the blinded two-rater and
   named-adjudicator procedure above. Record evidence for each label, acceptable
   route sets, gate status, and reviewer agreement. Keep any approved rule
   baseline output separate from gold labels.
3. **Hold out by group, not by random prompt.** Keep related issues, tasks from
   the same project/family, and near-duplicates in one split. Use a development
   set for prompt/schema iteration and confidence thresholds; seal a final
   holdout by project/family or time. Do not tune against holdout results. Report
   actual counts and class balance; if there are too few independent groups or
   examples, report the evaluation as exploratory, not conclusive.
4. **Freeze the interface.** Give every candidate the same minimal task text,
   relevant documented agent-role descriptions, rubric, and output schema.
   Freeze prompts/adapters before holdout evaluation. Require structured output
   with route/label, concise evidence, and abstention reason; reject invalid
   output and send it to human review rather than repairing it silently. Use a
   deterministic fallback only if a rule baseline has been separately approved.
5. **Keep tracks separate.** Score routing against adjudicated route slots and
   score complexity against its independent labels. Only after the rule baseline
   is approved, run it and each model on identical cases; randomize case order
   and avoid carrying conversation state between cases.
6. **Log one reproducible record per case:** anonymized case ID and split,
   prompt/schema hash, model/provider identifier and immutable version or
   snapshot (where offered), API version, SDK/runtime version, date/region,
   generation settings, response validity, abstention/fallback, measured
   latency, and measured token/cost fields when available. Mark unavailable
   fields; do not infer them from marketing material.

For provider-hosted candidates, an evaluation run still sends request data to
that provider. It requires a separate explicit decision on data scope, provider,
region, retention, credentials, and call budget before any calls. Use no
credentials or network calls as part of this protocol-only change.

## Metrics and decision rules

Report per candidate and per track, with raw counts and confusion matrices;
include uncertainty intervals grouped by project/task family where sample size
permits. Do not combine routing and complexity into one score.

| Track | Primary measures | Error/coverage measures |
|---|---|---|
| Routing | Required-slot precision/recall/F1; exact route-set accuracy | Per-agent confusion; unnecessary/missed supporting dispatches; abstention and invalid-output rates; selective error among non-abstained cases |
| Complexity | Macro-F1 and balanced accuracy | Ordinal weighted agreement and mean absolute ordinal error; over/under-classification; abstention and invalid-output rates |

Report task-level latency (median and p95), measured token usage and cost per
case, failure/retry rates, and quality-versus-cost trade-offs alongside quality;
do not substitute embedding similarity for either routing correctness or
complexity. Treat self-reported confidence as uncalibrated. If a candidate
returns a probability/confidence score, assess calibration (for example Brier
score or expected calibration error) on development data and report its
limitations; otherwise do not use self-reported confidence to set a threshold.
Set any abstention thresholds on development data only, report coverage against
error, and route low-confidence, malformed, or out-of-distribution cases to
human review or the approved deterministic rule baseline, if one exists. Do not
silently convert abstentions into confident labels.

Pre-register acceptance criteria before unsealing the holdout. A candidate is
not suitable merely because its aggregate score is higher: examine per-class
errors and high-impact cases, and require no model output to bypass human
approval or existing gates. Publish sample counts and limitations; if the
holdout is underpowered or results are inconclusive, report no winner. If no
approved deterministic baseline exists, do not run or publish the empirical
candidate comparison.

## Safety and current non-authorization

- **JEV remains disabled by default and opt-in only.** This protocol does not
  enable it, change runtime behavior, or authorize its use.
- **Bifrost is research-only here, not an evaluation or production runtime.**
- Model output may be an advisory label only. It cannot change grants, invoke
  shell, approve work, alter permissions/policy, or dispatch automatically.
- No provider has been selected. Any future live evaluation, credentials,
  dataset transfer, or rollout needs its own authorization and appropriate
  privacy/security review.

## Primary references

Official vendor documentation supplied for this protocol; checked as references
on 2026-10-29. Vendor documentation is not independent benchmark evidence:

- [TypeSafe models](https://docs.typesafe.ai/models)
- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)
- [Cloudflare Workers AI: Clef-Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
