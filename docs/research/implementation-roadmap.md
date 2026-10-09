# Implementation roadmap

Status: decisions locked on 2026-10-10. The executable plan is [docs/plan/phase-1.md](../plan/phase-1.md). ADRs are in [docs/adr/](../adr/). This file remains the research record. Where sample size or arm ids disagree, the Phase 1 plan wins.

Research date: 2026-10-10. This roadmap stops at the boundary the task set: no dependencies, no scaffold, no application code. The phases describe what a later implementation pass is allowed to build after the five decisions at the end are approved.

## Recommendation

Ship one vertical slice: a local LiteLLM proxy with Redis and Postgres, a mock fault lane, and a capped paid comparison of baseline versus exact-cache plus stable prefix. Everything else is a sequenced follow-on that starts only if that report is believable.

Evidence: the slice uses only features documented as open-source LiteLLM proxy behavior, plus k6 and a price card. See [existing-solutions.md](existing-solutions.md), [architecture-options.md](architecture-options.md), and [benchmark-design.md](benchmark-design.md).

Alternatives: starting with Auto Router, semantic cache, or a TypeScript reimplementation of the proxy. Those delay the first measured dollar and add quality risk before the harness exists.

Rationale: the project's claim is measurable trade-offs. A slice that cannot print tokens, USD, percentiles, errors, and a quality delta is a demo, not a lab.

Confidence: **high** on the cut line. **Medium** on phase lengths, which assume one person and a small paid budget.

## Phase 0 — decisions and pins

No runtime. Exit when the five decisions below are written down as a short ADR (one page is enough) and a price card lists the chosen model ids, token classes, and rates with a source URL and date.

Also pin:

- LiteLLM image tag policy: digest recorded at pull time, not `latest`.
- Redis as the cache backend even for a single container.
- Prompts excluded from Postgres spend logs.
- `enforce_fallback_budget` left at the default true.

## Phase 1 — vertical slice

Allowed to exist after approval:

| Piece | Role |
| --- | --- |
| Docker Compose | LiteLLM proxy, Redis, Postgres, OTel collector |
| Proxy config | One model alias, exact cache default off, one fallback, small `num_retries`, timeouts, cooldowns |
| Mock upstream | Scripted 200, 429, 500, delay |
| TypeScript runner | Prompt-set hash, arms P0–P2, price ceiling, JSONL results, report |
| k6 scenarios | Lane F only: cache hit, stampede, 429 amplification, budget fail-closed |
| Frozen prompt set | Single-shot, shared long prefix, exact repeats, paraphrases, broken-prefix ablation |
| Docs of the run | The benchmark table from [benchmark-design.md](benchmark-design.md), filled in |

Not allowed in phase 1: semantic cache, Auto Router, a second programming language on the request path, Kong, Portkey cloud, a judge model, streaming, tools, Kubernetes, Enterprise license, prompt compression.

### Exit criteria

Copied from the benchmark gates, summarized:

- Lane F: exact repeats hit and match bytes; retry amplification stays within the configured cap; exhausted budget does not call a fallback; stampede upstream count is reported even if it is ugly.
- Lane P: `usd` and `usd_proxy` agree within the gate; P1 shows more provider cache-read tokens than the broken-prefix ablation; quality versus the answer key stays inside the approved allowance; the runner stops at the ceiling.
- The report lists image digest, price-card hash, prompt-set hash, TTL, and concurrency.

If Lane P cannot be funded, phase 1 still finishes Lane F and a price-card unit check against fixture usage JSON. The README of the report must say that real API cost was not measured. Do not backfill Lane P with a free-tier provider.

### Suggested order inside the slice

1. Proxy plus Redis plus Postgres, health and `/cache/ping` only.
2. Mock upstream and one cached repeat, confirmed with response headers.
3. Runner results row, including token classes and `usd_delta`.
4. Frozen set and arms P0, P1, P2 on the mock (synthetic USD).
5. k6 fault scenarios and the amplification and budget gates.
6. Paid ceiling and a single Lane P run of P0 versus P1 versus P2.
7. Write the report. Stop.

## Phase 2 — only after the phase 1 report

Pick at most one theme per iteration.

| Theme | Why it might be next | Stop if |
| --- | --- | --- |
| Same-tier failover on Lane F, then a tiny paid smoke | Completes the fallback-success column with a second mock | The fallback shares fate with the primary (same key, same host) |
| Single-flight on identical misses | Only if phase 1 stampede count is near N and that matters for the story | The patch requires forking LiteLLM. Prefer a request coalescer in the runner for the demo, and describe it as client-side |
| Heuristic Auto Router as `lab-routed` | Beta, but it is the documented cost/quality classifier and adds no extra model call in heuristic mode | Quality on the answer key drops past the allowance, or the config keys shift under the pin |
| Second paid provider, same model family | Makes failover real | Price card cannot express both usage schemas |

## Phase 3 — explicit research slices

Each one is a new arm, not a silent change to P2.

| Slice | Method | Main risk |
| --- | --- | --- |
| Semantic cache | LiteLLM `redis-semantic` or Bifrost, paraphrase slice, `end_user` scope | Wrong answers and cross-user hits. Embedding USD can erase the savings |
| Prompt compression | LLMLingua-2 on the shared document only, not on the question or a schema | Quality loss the paper did not measure on this task. Extra process to operate |
| Learned router | RouteLLM-style offline eval against the phase 1 baseline, using LiteLLM only as the caller | 2024 checkpoints do not transfer. Training a router is a different project |
| Streaming | TTFT, and usage that arrives at the end of the stream | Client disconnects after billable generation |
| Agent loop | Exact cache only, semantic cache forced off per the LiteLLM guide | Retry amplification inside the agent plus the proxy |

## Effort shape

Rough, for one engineer who already knows Docker. These are planning bounds, not a quote.

| Phase | Calendar | Paid spend |
| --- | --- | --- |
| 0 | A decision meeting | $0 |
| 1 Lane F | A few days once approved | $0 |
| 1 Lane P | One day of runs after Lane F is green | Decision 2's ceiling, spent once plus one rerun |
| 2 | One small PR each | Smoke dollars only |
| 3 | A project per row | A new ceiling per slice |

## Review checklist before any implementation PR

- The PR does not add a provider SDK call outside the proxy.
- The PR does not enable semantic cache, `cost-based-routing` across unequal models, or `budget_fallbacks` onto a weaker model.
- Lane P is unreachable from CI.
- Results files with real prompts are gitignored.
- The report can be regenerated from JSONL plus the price card without calling a model.

## Five decisions required before implementation

These are the approval gates. The recommendation is the option to start from. A different choice changes the phase 1 design, so implementation should wait.

### 1. Which gateway is the base?

| Option | Recommendation | Consequence |
| --- | --- | --- |
| A. LiteLLM Proxy OSS | **Start here.** | Python process inside Docker. TypeScript stays in the runner. Postgres spend ledger is included. |
| B. Portkey Gateway OSS | Choose this only if a single TypeScript process matters more than the ledger. | You accept a thinner budget story or you build the ledger. Semantic cache and long retention are plan-gated. Product direction is Prisma AIRS. |
| C. Bifrost | Choose this if semantic-cache metrics are in phase 1, which this roadmap says they are not. | Go binary, Apache-2.0, different spend model. |

Confidence in A: **medium-high**. The capability fit is high. The language preference is the part only you can weigh.

### 2. What is the paid model pair and the hard ceiling?

Need a primary model id, an optional same-tier fallback id, a price-card source, and a maximum USD for all Lane P runs in phase 1 (including one rerun).

Constraints:

- The account must be billed. Gemini free tier and Groq's unguaranteed free capacity are smoke tests only.
- The shared prefix must be long enough for that provider's prompt cache (1,024 tokens on current OpenAI models).
- Output price should be in the card before the run, because output tokens can dominate.

This research pass does not pick a dollar ceiling or a model. Both depend on your key and your budget.

Confidence that some paid ceiling is required: **high**.

### 3. Is the phase 1 workload single-shot with a stable prefix?

| Option | Recommendation | Consequence |
| --- | --- | --- |
| A. Single-shot Q&A, shared document, no tools | **Start here.** | Exact cache, provider cache, and an automatic answer key all work. |
| B. Multi-turn or tool-calling agent | Defer. | Semantic cache is documented as unsafe. Failover can drop reasoning items. Quality scoring becomes a project. |

Confidence in A: **high**.

### 4. What quality drop is acceptable, and how is it scored?

Phase 1's optimized arm should not change the model, so the expected drop versus baseline is about zero, aside from cache freezing the first sample.

Please set:

- The metric: normalized match against a hand-written answer key (recommended for phase 1), or a pinned judge with its own budget.
- The allowance: for example, match rate at least as high as baseline minus 0 points, because the model is unchanged. Any later router or compressor slice needs a non-zero allowance you state in advance (for example, no more than a 2 point drop on the answer key).

Confidence that an answer key is the right phase 1 judge: **high**. The numeric allowance for later slices is yours.

### 5. May a failed request fall back to a weaker, cheaper model?

| Option | Recommendation | Consequence |
| --- | --- | --- |
| A. Fallback only to a deployment you treat as the same quality tier, or to a mock in Lane F | **Start here.** | Fallback success means availability. Quality stays comparable. |
| B. Fallback to a cheaper model, including `budget_fallbacks` | Defer to a named phase 2 arm. | Median cost falls and the failure cohort gets worse answers. Those rows must not be averaged away. |

Confidence in A: **high**.

## Stop line

Implementation starts only after decisions 1 through 5 are answered. Until then the repository should contain this `docs/research/` set and nothing else required to boot a gateway.
