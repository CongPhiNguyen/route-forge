# Benchmark design

Research date: 2026-10-10. No benchmark was executed in this research pass. The design is what a later implementation should run, unchanged, so two people can get comparable tables.

## Recommendation

Score two arms on one frozen prompt set:

- **Baseline.** One paid model, gateway response cache off, messages in whatever order the fixture shipped, no fallback.
- **Optimized.** Same model and same fixtures, exact Redis cache on, stable prefix ordered in front, `max_tokens` set from the fixture, one same-tier fallback after a small retry budget.

Report tokens by class, USD from a pinned price card, latency percentiles, error rate, achieved throughput, quality against the baseline arm, and fallback success. Keep a separate local-fault lane that is not allowed to publish a real dollar cost.

Evidence that these arms are implementable with stock LiteLLM: exact cache on/off, fallbacks after `num_retries`, and `x-litellm-response-cost` plus provider usage fields. [Caching](https://docs.litellm.ai/docs/proxy/caching), [Fallbacks](https://docs.litellm.ai/docs/proxy/reliability), [Prompt caching](https://docs.litellm.ai/docs/completion/prompt_caching).

Alternatives rejected for v1:

| Alternative | Why it waits |
| --- | --- |
| Semantic-cache arm | Changes answers. Docs warn it replays stale turns on agent traffic. Needs its own quality review after exact-cache numbers exist. |
| Auto Router arm | Beta, and the 37–69% figure is LiteLLM's measurement against an all-frontier baseline. Worth a later A/B, not the first baseline. [Post](https://docs.litellm.ai/blog/auto-router-prompt-caching-benchmark) |
| k6 as the only tool | k6 is the right load generator and a poor quality judge. Quality is a frozen set scored offline. |
| Free-tier model as the baseline | $0 price and unguaranteed quota. See Lane F versus Lane P. |
| LLM-as-judge on the hot path | Judge tokens dominate a small bill and the judge drifts. If used, pin the judge model and put its USD on its own line. |

Rationale: a portfolio benchmark is credible when the baseline is something a skeptic would actually ship (one good model, provider prompt cache available, no strawman that disables every discount). LiteLLM's own router write-up makes this point: a router with provider caching disabled looked about 4× more expensive than caching one fixed model. [Prompt caching and auto router](https://docs.litellm.ai/docs/auto_router/prompt_caching).

Confidence: **high** on the metric definitions. **Medium** on sample sizes below, which are planning numbers, not a power analysis.

## Lanes

### Lane F — local, free, not a cost claim

Upstream is a mock that can sleep, return 429 with `Retry-After`, return 500, and emit a fixed `usage` object. LiteLLM's proxy no longer honors `mock_testing_fallbacks` on incoming requests as of v1.85.0, so fallback tests should hit a real error from the mock, not that flag. [Fallbacks](https://docs.litellm.ai/docs/proxy/reliability).

Lane F measures:

- Proxy overhead on a cache miss versus a cache hit (p50/p95/p99).
- Retry amplification: upstream attempts divided by client-visible requests.
- Fallback success under injected 429 and 500.
- Stampede: N identical in-flight misses. Record upstream attempts. A number near N means no single-flight. Do not assume the spend-query coordinator covers this. [PR 20030](https://github.com/BerriAI/litellm/pull/20030) is the spend read, not the completion cache.
- Budget exhaustion: a key with a tiny `max_budget` stops new calls and does not fall through to a paid model.

Synthetic USD may be computed from the mock `usage` and the price card. Label the column `synthetic_usd`. Never add it to Lane P totals.

k6 fits this lane: scenarios, constant arrival rate, and thresholds. Thresholds fail the process when p95 or the error rate regresses. [k6 thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/). Keep thresholds on gateway metrics. A threshold on "quality" does not belong in k6.

### Lane P — paid, capped, the only real cost

One provider account with billing enabled. A hard ceiling in the runner (for example a few dollars per full comparison, exact number is decision 2) aborts before the next request when projected spend, using the price card and worst-case output tokens, would cross the ceiling.

Lane P is not a stress test. Concurrency stays at 1 for the quality set, then a short low-concurrency pass (2–4) for latency percentiles. Provider rate limits and prompt-cache locality both change with concurrency. OpenAI still counts cached input toward TPM, so a "cache should remove the limit" assumption is false there. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). Groq does not count cached tokens the same way, which is another reason not to mix providers inside one latency table. [Groq prompt caching](https://console.groq.com/docs/prompt-caching).

Gemini free tier and Groq free-capacity plans do not qualify as Lane P. Google states that specified rate limits are not guaranteed. [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

## Frozen set

One task family for v1: single-shot question answering with a shared system prompt and a shared reference document long enough to clear the provider's cache minimum (1,024 tokens on current OpenAI models). Questions are independent. No tools, no multi-turn, no images.

Build the set so the arms disagree on purpose:

| Slice of the set | Intent | Expected exact-cache behavior |
| --- | --- | --- |
| 20 prompts × 5 exact repeats | Hit rate and hit latency | Repeat 2–5 hit on the optimized arm. Baseline misses every time if the gateway cache is off. Provider cache may still hit on the baseline. |
| 20 paraphrases of those prompts | Show that exact cache does not fire | Miss. If a later semantic arm is added, this slice is its quality risk. |
| 10 prompts that share only the prefix | Provider prompt-cache read, gateway miss | `cache_read_input_tokens` > 0 on call 2+, gateway cache miss |
| 10 prompts with the user text placed before the document | Broken prefix, ablation | Provider cache read collapses relative to the stable-prefix arm |

About 150 calls per arm before retries. At a small paid model this is a coffee-budget run. At a frontier model it may not be, which is why decision 2 picks the model before anyone runs Lane P.

Temperature 0 and a fixed seed if the provider accepts one. Treat outputs as stable enough for grading, not as bitwise reproducible. Record the response id.

Store the set as content-addressed JSON in the repo later. The benchmark report includes the set's hash. Changing a prompt is a new experiment, not a rerun.

## Arms

| Arm id | Gateway exact cache | Message order | max_tokens | Fallback |
| --- | --- | --- | --- | --- |
| `P0-baseline` | off | fixture order | provider default or a high cap, recorded | off |
| `P1-prefix` | off | stable prefix | same cap as P0 | off |
| `P2-exact-cache` | on, TTL recorded | stable prefix | task cap | off |
| `P3-failover` | on | stable prefix | task cap | one same-tier fallback, retries recorded |

P1 isolates provider prompt cache from gateway cache. P2 adds exact cache. P3 adds failover and is scored on the fault lane as well as a short paid smoke (a handful of forced errors is optional and easy to waste money on; prefer Lane F for failover counts).

Skipping P1 and only publishing P0 versus P2 mixes three effects (prefix, gateway cache, output cap). The report may still lead with P0 versus P2, and it has to include the ablation table.

## Metrics

Every client-visible request produces one row.

| Metric | Definition | Notes |
| --- | --- | --- |
| `input_tokens` | Uncached input, excluding cache read and cache write if the provider splits them | Do not sum classes first |
| `cache_write_tokens` | Tokens billed as a cache write | Often 1.25× or 2× input |
| `cache_read_tokens` | Tokens billed as a cache read | Often 0.1× input. Still a provider call |
| `output_tokens` | Completion tokens, including reasoning tokens if that is how the provider bills | Split reasoning out when the usage object does |
| `gateway_cache` | `miss`, `hit`, or `bypass` from proxy headers (`x-litellm-cache-key` on a hit) | Semantic similarity header must stay absent in v1 |
| `usd` | Sum of class × price-card rate | Also store `x-litellm-response-cost` as `usd_proxy` |
| `usd_delta` | `usd - usd_proxy` | Non-zero is a price-card or cost-map bug |
| `latency_ms` | Client clock, request send to full body | Non-streaming in v1 |
| `ttft_ms` | Unset in v1 | Streaming is a later slice. Do not invent TTFT from a buffered body |
| `status` | Client-visible HTTP status | |
| `upstream_attempts` | From proxy logs or attempt metadata | Retry amplification = attempts / requests |
| `fallback_used` | True when the serving deployment is not the primary | |
| `model_id` | Serving deployment id | Catches accidental cheap-model routing |
| `error_class` | `none`, `429`, `5xx`, `timeout`, `budget`, `other_4xx` | |

Aggregate per arm:

| Aggregate | Estimator |
| --- | --- |
| Tokens and USD | Sum, plus mean per successful request |
| Latency | p50, p95, p99 of successful requests. Report n. With n under a few hundred, p99 is a handful of points; print that caveat beside the number |
| Error rate | Unsuccessful client responses / requests. Timeouts count as errors |
| Throughput | Successful responses / wall clock. State concurrency. Lane P throughput is descriptive, not an SLO |
| Quality | Fraction of items within the decision-4 bar versus `P0-baseline` on the first successful sample of each unique prompt. Exact-cache repeats are not extra quality evidence |
| Fallback success | Primary failures that then returned 200 from the fallback / primary failures. Publish quality of that subset on its own row |
| Cache hit rate | Gateway hits / requests, on the repeat slice only. A hit rate computed on a set of unique prompts is structurally zero and must not be quoted |

Error rate and latency percentiles use the same success rule: a fallback 200 is a success for availability and a separate cohort for quality and cost.

## Quality

v1 tasks need an automatic check that does not call a model:

- The frozen set includes a short expected fact or a normalized answer for each question.
- Score exact or normalized match against that answer.
- Also record a cheap structural check: non-empty, within `max_tokens`, valid UTF-8.

If decision 4 requires a graded rubric, use one pinned judge model, temperature 0, a written rubric in the repo, and a judge-USD column. Do not use the system under test as the judge. Do not let judge cost hide inside the optimization savings.

A gateway cache hit repeats the first sample. Grade unique prompts, then check that repeat hits are text-identical to the stored first response. A hit that is not identical is a cache-key bug.

Paraphrase items are graded too. They are expected gateway misses. They keep a later semantic-cache experiment honest.

## Reproducibility checklist

Each report header includes:

- Git commit of the lab (once the lab exists) and the LiteLLM image digest.
- Price-card date and hash.
- Prompt-set hash.
- Redis TTL, `num_retries`, `request_timeout`, `allowed_fails`, `cooldown_time`.
- Model IDs and regions.
- Concurrency, lane, and whether Redis was flushed at the start.
- Wall-clock start. Provider caches are time-dependent (OpenAI on the order of 30 minutes for current models, Anthropic 5 minutes or 1 hour by breakpoint, Groq up to 2 hours idle). A "warm" run must state the gap since the previous call. [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching), [Groq](https://console.groq.com/docs/prompt-caching).

Runs:

1. Cold: flush gateway cache. First call of each prefix is a provider-cache write.
2. Warm, inside the provider TTL: same process, no flush. This is the number that represents a chat product.
3. Warm, gateway flush only: shows provider cache without gateway hits.

Publish all three for P1 and P2. Publishing only the warm gateway-hit number overstates savings for any workload that does not repeat byte-identical requests.

## Pass and fail

These are lab gates, not vendor SLOs. They should be edited when decision 2 and decision 4 land. Suggested starting gates:

| Gate | Lane | Starting bar |
| --- | --- | --- |
| Report completeness | Both | Every metric column populated, n printed, image digest printed |
| Cost identity | P | Median absolute `usd_delta` under 1% of `usd` or $0.0001, whichever is larger |
| Exact-cache correctness | F and P | 100% of exact repeats after the first are gateway hits and byte-identical |
| Prefix ablation | P | P1 cache-read tokens on the shared-prefix slice exceed the broken-prefix slice |
| No retry storm | F | Under a 30% 429 injection, upstream attempts / client requests stays under 1 + configured `num_retries` |
| Fallback | F | Injected primary 500s return 200 from the fallback on at least 99% of trials, with the fallback's own error rate excluded |
| Budget | F | Over-budget key returns the budget error and shows zero fallback provider calls |
| Quality | P | Match rate versus the answer key does not fall by more than the decision-4 allowance relative to P0 |
| Spend ceiling | P | Runner stops with no request whose projected cost crosses the ceiling |

p95 latency is reported, not gated, on Lane P. Provider variance will dominate proxy overhead. Lane F can gate p95 of cache-hit latency against cache-miss latency (hit should be clearly lower; the ratio is an outcome, not a target copied from a vendor blog).

## How k6 and the runner divide the work

| Tool | Job |
| --- | --- |
| k6 | Lane F arrival processes, thresholds on `http_req_duration` and `http_req_failed`, stampede and 429 scenarios |
| TypeScript runner | Lane P sequencing, price ceiling, results JSONL, price-card math, quality score, markdown or CSV report |
| OTel | Explain outliers. Attributes should follow GenAI conventions where LiteLLM emits them. [OTel v2](https://docs.litellm.ai/docs/observability/opentelemetry_v2) |

k6 thresholds that fail a CI job belong to Lane F only. A red CI job that calls a paid model is an unbounded invoice.

## Sample report skeleton

The implementation should emit one table per lane. Illustrative columns:

| arm | n | input | cache_write | cache_read | output | usd | p50 ms | p95 ms | p99 ms | err | rps | quality | fallback_success | gw_hit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | | | | | | | | | | | | | | |
| P1 | | | | | | | | | | | | | | |
| P2 | | | | | | | | | | | | | | |

Empty cells are intentional. This research pass did not run the benchmark.

Confidence: **high** that the column split is required to avoid false savings. **Medium** on the numeric gates, which exist so the first implementation has a stop condition and should be revised after one Lane F shakedown.
