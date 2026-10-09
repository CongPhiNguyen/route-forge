# Architecture options

Research date: 2026-10-10. This document chooses a shape. It does not add code, Compose files, or dependencies.

## Recommendation

Run a hybrid:

- **LiteLLM Proxy (open source)** owns provider I/O, authentication, exact response cache, retries, cooldowns, fallbacks, virtual-key budgets, and spend rows.
- **Redis** is the shared response cache and the shared router state (cooldowns, affinity pins, usage counters if a usage-aware strategy is enabled).
- **PostgreSQL** is the system of record for keys, teams, and spend logs.
- **A small TypeScript experiment runner** owns scenarios, the pinned price card, budget kill-switches, and the report. It calls the proxy with the OpenAI SDK. It does not reimplement routing.
- **OpenTelemetry** is exported from the proxy to a local collector. The runner also writes a row-level results file so a benchmark can be graded without a tracing backend.
- **Python** stays inside the LiteLLM container. A later compression or RouteLLM slice may add a Python job. That job is not on the v1 request path.
- **k6** generates load against the proxy for the reliability lane. It does not score answer quality.

Evidence for the split is in [existing-solutions.md](existing-solutions.md). LiteLLM's own sizing guide already separates Redis (shared state and cache) from Postgres (auth reads and spend writes). [What Needs Redis](https://docs.litellm.ai/docs/proxy/redis_requirements), [Database sizing](https://docs.litellm.ai/docs/proxy/db_sizing), [OpenTelemetry v2](https://docs.litellm.ai/docs/observability/opentelemetry_v2).

Alternatives:

| Shape | What you gain | What you pay |
| --- | --- | --- |
| Portkey OSS gateway as the data plane, TypeScript only | One language. Config-native circuit breaker. | Budgets, retention, and semantic cache lean on Portkey plans or a ledger you then have to build. Hybrid control plane calls `control.portkey.ai`. |
| Bifrost as the data plane | Apache-2.0 semantic cache and fallback index metrics in one binary. | Go operations. Different spend model. Vendor overhead numbers unverified. |
| Custom Node proxy in front of provider SDKs | Full control of every header. | Rebuilding adapters, retries, and cost maps. This fails the "do not reinvent the gateway" test. |
| Kong in front of LiteLLM | Familiar edge policy, if the team already runs Kong. | Two proxies, and the AI policies that matter are Enterprise. |

Rationale: the proposed stack already names LiteLLM, Redis, Postgres, Docker, k6, and OpenTelemetry. The TypeScript half belongs on the experiment and reporting side, where the lab's original work is. Putting business logic inside a fork of LiteLLM would make every upstream upgrade a merge.

Confidence: **high** that this split matches current docs. **Medium** that it is preferable to Bifrost, pending decision 1.

## Component responsibilities

| Component | Owns | Must not own |
| --- | --- | --- |
| Client / k6 / runner | Scenario id, idempotency key, cache mode for that run, max in-flight, spend ceiling | Provider API keys, fallback order |
| Input policy (v1, tiny) | Stable prefix order, history cap, `max_tokens`, cache-control metadata passed into the proxy | A second model call, embedding, or learned router |
| LiteLLM Proxy | Virtual-key auth, budget reservation, exact cache, deployment pick, retry, cooldown, fallback, usage normalization, `x-litellm-response-cost` | The benchmark score, the price-card version, quality labels |
| Redis | Exact-cache entries, router cooldown and affinity, optional rate counters | The only copy of spend (Redis can miss a flush; Postgres is the ledger) |
| PostgreSQL | Keys, spend logs, budget counters | Prompt bodies, unless a run explicitly opts in |
| Price card (file in the runner) | USD per token class per pinned model id, dated | Live scraping of vendor pricing during a run |
| Quality scorer (offline) | Compare frozen tasks to a baseline answer or a rubric | The hot path |
| OTel collector | Spans and GenAI metrics for latency breakdown | The official cost number, until reconciled to usage fields |
| Mock provider | Deterministic 200, 429, 500, and slow responses for the reliability lane | Any number labeled "real API cost" |

## Request flow

```text
runner or k6
  |  Authorization: virtual key
  |  metadata: scenario, run_id, cache mode
  v
LiteLLM Proxy
  |  1. Authenticate key (Postgres, cached)
  |  2. Reserve / check budget
  |  3. Exact-cache lookup in Redis
  |     hit  -> return cached body, record hit, do not call a provider
  |     miss -> continue
  |  4. Pick a deployment (v1: one primary, simple-shuffle only if two equal deployments)
  |  5. Call provider with a prefix ordered for provider prompt cache
  |  6. On timeout, 429, or 5xx:
  |        retry up to a small cap on that deployment
  |        cooldown the deployment after allowed_fails
  |        try the next fallback if still inside budget
  |  7. Write spend from provider usage (input, output, cache write, cache read)
  |  8. Emit one OTel trace (auth, cache, provider, spend)
  v
runner
  |  read usage, response cost header, model id, cache headers, status
  |  stop the run if projected spend crosses the ceiling
  v
offline
  |  price-card recomputation
  |  quality score on the frozen set
  |  report
```

Cache lookup stays in front of routing so a hit cannot trigger a fallback or a second provider bill. Fallback stays behind the cache so a cached success is not "fallback success."

Provider prompt cache is not step 3. Step 5 can still return `cache_read_input_tokens` on a gateway-cache miss. The report must keep those token classes in separate columns. Adding them into one "cached tokens" number makes the optimization uninterpretable.

## v1 routing policy

One public model name, `lab-chat`, mapped to:

1. A single primary deployment on a paid model.
2. One fallback deployment, used only after the primary fails its retry budget.

Do not enable `cost-based-routing` across unequal models. The router will prefer the cheap deployment whenever it is healthy, which collapses the quality comparison. [Router](https://docs.litellm.ai/docs/routing).

Do not enable Auto Router in v1. It is beta, and its savings claims are the vendor's. A later slice can turn on the heuristic classifier behind a second model name, `lab-routed`, and compare it with `lab-chat` on the same frozen set. [Auto routing](https://docs.litellm.ai/docs/proxy/auto_routing).

Fallback budget checks are already on by default (`enforce_fallback_budget`). Keep them on so a zero-price primary cannot fail open onto an uncapped paid fallback. [Fallbacks](https://docs.litellm.ai/docs/proxy/reliability).

## v1 cache policy

Exact Redis cache, opt-in per scenario (`mode: default_off`, then the runner enables it for the optimization arm). Local and disk caches are documented as single-worker development tools. [Caching](https://docs.litellm.ai/docs/proxy/caching).

Semantic cache stays off. The docs describe stale tool-call replay on agentic traffic and shared buckets across end users of one key. Even the recommended single-shot workload should not turn it on until exact-cache numbers exist, because a semantic hit changes the answer. [Semantic caching](https://docs.litellm.ai/docs/proxy/caching_semantic).

TTL is part of the experiment, not an infinite default. A long TTL inflates hit rate and hides staleness. Publish the TTL next to the hit rate.

## Token optimization, both ends

### Input and context

Ordered from smallest blast radius to largest:

| Lever | Mechanism | Quality effect | v1? |
| --- | --- | --- | --- |
| Prefix stability | Put the system prompt, tool definitions, and shared document before the user turn. Keep that byte prefix identical across calls. On OpenAI this is what makes a prefix eligible (1,024+ tokens). On Anthropic this is what a cache breakpoint covers. | None, if the prefix is actually shared. A rewritten system prompt is a cache miss and can change behavior. | Yes |
| Deployment affinity | `PromptCachingDeploymentCheck` or session affinity so the prefix returns to the deployment that wrote it. Load balancing across two accounts without this splits the cache. | None for answer text. A cooled-down deployment correctly breaks the pin and may miss the cache. | Yes, if more than one deployment of the same model exists |
| Output cap | `max_tokens` sized to the task. | Truncation. Structured output fails closed when the cap cuts JSON. Measure invalid-output rate. | Yes, with a cap above the task's real answer length |
| History window | Drop or summarize turns older than N. | Lost facts, broken references. Summaries are themselves a model call and must be counted. | Cap only. No summary model in v1 |
| Retrieval budget | Fewer or shorter chunks. | Missing evidence. This is a product RAG choice. | Out of scope until a corpus exists |
| Extractive compression | LLMLingua-2 class model, 2×–5× on the paper's datasets. | Deletes tokens. Code, JSON schemas, and citations are easy to damage. Adds compressor latency and a machine to run it. Kong packages this as an Enterprise sidecar. | Later slice |
| Semantic response cache | Skip the model when a nearby prompt exists. | Wrong answer, cross-user leakage, stale agent turns. Embedding call on every lookup. | Off |

Provider cache reads are cheap and still call the model, so latency improves less than a gateway hit and quality stays the model's quality. Gateway exact hits are near-cache latency and repeat one sampled completion. At temperature above 0, that repeat is a specific sample, not a fresh draw. Benchmarks that need diversity must disable the gateway cache or include temperature in the cache key (LiteLLM's exact cache already hashes the request, so temperature is already part of the key).

### Output and model selection

| Lever | Mechanism | Quality effect | v1? |
| --- | --- | --- | --- |
| Same-tier failover | Fallback to another region or provider of a model you have priced as equivalent. | Small. Tool-call and reasoning-item formats can still differ. LiteLLM documents dropping encrypted reasoning the target cannot decrypt. | Preferred fallback |
| Cheaper model on failure | `budget_fallbacks` or an explicit fallback chain. | Quality drop exactly when the system is already unhealthy. Report this cohort separately. | Only if decision 5 allows a weaker fallback |
| Cheaper model by default | `cost-based-routing` or Auto Router. | Every request moves down market. RouteLLM's 2024 paper is the existence proof that a router can hold a quality bar, on old model pairs. | No |
| Shorter generations | Stop sequences, lower `max_tokens`, "answer in one sentence" instructions. | The instruction itself changes the task. Count it as a different arm, not as the same answer with fewer tokens. | Separate arm, optional |

Output tokens dominate many invoices because output prices are several times input prices (see current OpenAI and Anthropic price tables). A router that saves input tokens and lengthens the answer can increase the bill. The price card has to multiply each class by its own rate, including cache writes, which can be 1.25× or 2× input. [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Anthropic pricing](https://docs.anthropic.com/en/docs/about-claude/pricing).

## Two lanes, one architecture

The same proxy binary serves both lanes. The runner selects the lane. The lanes do not share Redis logical databases or virtual keys.

| | Lane F, free and local | Lane P, paid and capped |
| --- | --- | --- |
| Upstream | Mock provider that returns scripted status codes, bodies, and `usage` | One paid provider account |
| What it can claim | Gateway overhead, cache-hit latency, retry counts, fallback success, stampede shape, error rate under injected faults | Real token counts, real USD from usage, real p50/p95/p99 to that provider, quality on a frozen set |
| What it must not claim | Production provider latency or a dollar figure called "API cost" | A throughput SLO. N is small on purpose |
| Load tool | k6, including fault scenarios | A sequential or low-concurrency runner with a hard stop on projected spend |
| Redis / Postgres | Isolated from Lane P | Isolated from Lane F |

Gemini's docs say free-tier capacity is not guaranteed. Groq's public tables are organization-specific and can 429. Neither account is Lane P. A Gemini or Groq key may be used once, outside the scored runs, to prove the proxy config parses a live URL. [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [Groq rate limits](https://console.groq.com/docs/rate-limits).

## Observability contract

LiteLLM OTel v2 already nests auth, guardrails, the model call, and database or cache work in one trace and can emit latency, token, and cost histograms. [OpenTelemetry v2](https://docs.litellm.ai/docs/observability/opentelemetry_v2). The GenAI semantic conventions are the attribute names to prefer (`gen_ai.request.model`, token usage, operation duration). They are still moving. The runner's results file is the source of truth for the benchmark. Traces explain a slow request. They do not replace the results file.

Do not store raw prompts in spend logs by default. The sizing guide calls out `store_prompts_in_spend_logs` as a multiplier on row size and gateway memory. [Database sizing](https://docs.litellm.ai/docs/proxy/db_sizing). Quality scoring should read the runner's local artifacts, which are easier to delete than a Postgres table.

## What is custom, in order

1. **Price card and report.** Dated rates for input, output, cache write, cache read, and reasoning tokens. Recompute USD from provider `usage`. Compare to `x-litellm-response-cost`. A mismatch is a finding, not something to hide.
2. **Scenario harness.** Baseline arm and optimization arm, same prompts, same seeds where the provider allows, isolated caches.
3. **Prefix policy.** A pure function that orders messages so the stable prefix is a prefix. No model call.
4. **Fault profiles for the mock.** 429 with `Retry-After`, 500, timeout, and a burst of identical prompts.
5. **Offline quality.** Exact match or a short rubric on the frozen set. Judge cost, if any, is a separate line.

Out of the first slice: semantic cache, Auto Router, LLMLingua, multi-tenant SSO, Kong, a second proxy, streaming token accounting, and any agent loop.

## Deployment shape for the lab

One Docker Compose project is enough: proxy, Redis, Postgres, and an OpenTelemetry collector. k6 and the runner execute from the host or a one-shot container. Kubernetes, multi-region, and a license key are scope creep until a measurement says the single proxy is the bottleneck.

LiteLLM documents that multi-instance spend and response-cache hit rate are wrong without Redis. The Compose file should set Redis for both the cache block and router state even on one replica, so the configuration matches the production rule the lab is teaching. [What Needs Redis](https://docs.litellm.ai/docs/proxy/redis_requirements).

Confidence: **high** for the flow and the v1 cuts. **Medium** for OTel attribute stability, because the conventions and LiteLLM's exporter will both move.
