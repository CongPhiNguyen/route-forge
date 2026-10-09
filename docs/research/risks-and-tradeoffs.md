# Risks and trade-offs

Research date: 2026-10-10. Failure modes are design constraints for the first slice. They are not an invitation to build a chaos platform.

## Recommendation

Treat reliability as a small set of injected faults in front of a mock, plus a paid lane that is forbidden from exploring those faults at high QPS. Cap retries at a number you can multiply by the price card. Keep semantic cache and learned routing out until exact-cache and prefix-cache numbers exist.

Evidence: LiteLLM already implements retries, cooldowns, typed fallbacks, and budget checks, and it documents the semantic-cache failure on agent traffic. Provider docs document that free-tier or published rate limits are not capacity contracts. Citations are inline below.

Confidence: **high** on the failure modes that vendor docs name. **Medium** on response-cache stampede behavior, which is not specified as single-flight and has to be measured.

## Failure modes

### Provider 429

A 429 is backpressure. Retrying it immediately multiplies load on the provider that is already refusing.

LiteLLM can retry, then fall back, then cool down a deployment after `allowed_fails` inside a minute for `cooldown_time`. [Fallbacks](https://docs.litellm.ai/docs/proxy/reliability). That is the right shape if `num_retries` is small and `Retry-After` is honored. It is the wrong shape if every client also retries.

OpenAI counts cached prompt tokens toward TPM, so a prompt-cache hit does not create extra headroom on that limit. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). Groq excludes cached tokens from the limit but can still 429 a parallel burst before subtraction. [Prompt caching](https://console.groq.com/docs/prompt-caching).

Lab rule: one retry layer. The runner and k6 do not retry. The proxy does, with a recorded cap. Lane F asserts `upstream_attempts / requests <= 1 + num_retries`.

### Provider 5xx and timeout

Timeouts are the expensive error. The client may have given up while the provider still generates billable output. A short `request_timeout` reduces hung slots and can increase billed-but-abandoned work.

Fallbacks add another full generation. Bifrost's docs are explicit that each fallback is a new request and plugins run again. [Bifrost retries](https://docs.getbifrost.ai/features/retries-and-fallbacks). LiteLLM's fallback is the same economic event even if the description is shorter: a second model call.

Lab rule: timeout budget is `request_timeout * (num_retries + 1) * fallback_depth`, and the runner's spend projection uses that worst case, not the happy path.

### Retry amplification

Amplification is the product of client retries, proxy retries, fallback depth, and cache stampedes. A default of three proxy retries and two client retries is six upstream calls per user retry wave, before fallbacks.

Usage-based routing adds Redis reads on the select path. LiteLLM tells operators not to use it as the production default because of that latency. [Router](https://docs.litellm.ai/docs/routing). Under overload, a slower router holds slots longer and reduces goodput.

Lab rule: v1 strategy is `simple-shuffle` with one primary, or a single deployment so the strategy does not matter. Measure amplification in Lane F before raising `num_retries` above 1 or 2.

### Cache stampede

Many identical misses at once all call the provider, then all write the cache. The second wave hits. The first wave pays N times.

LiteLLM added an in-process coordinator so concurrent **global spend** lookups share one database read. [PR 20030](https://github.com/BerriAI/litellm/pull/20030). That does not document single-flight for completion cache fills. Cloudflare's cache doc states the analogous race directly: two identical requests at once may both miss. [Cloudflare caching](https://developers.cloudflare.com/ai-gateway/features/caching/).

Lab rule: Lane F sends a burst of identical posts and records upstream attempts. If the number is far above 1, the report says so. A single-flight lock is a later, measured patch, not a presumed feature. Semantic cache makes the race worse because the embedding call is paid on every miss. [Bifrost semantic cache](https://docs.getbifrost.ai/features/semantic-caching), [LiteLLM semantic cache](https://docs.litellm.ai/docs/proxy/caching_semantic).

### Overload of the proxy

Postgres spend inserts, not auth reads, are the documented scaling cliff. Turning on prompt storage in spend logs multiplies row size. [Database sizing](https://docs.litellm.ai/docs/proxy/db_sizing). Redis is required for a correct shared cache and for shared cooldowns. Without it, each worker has a private cache and a private view of who is healthy. [What Needs Redis](https://docs.litellm.ai/docs/proxy/redis_requirements).

`allow_requests_on_db_unavailable` and disabling budget reservation are availability switches that let spend run past the cap. Leave them off in this lab so a database outage fails closed on budgeted keys. The config reference documents both switches. [Config settings](https://docs.litellm.ai/docs/proxy/config_settings).

Lab rule: one proxy replica in v1, Redis still configured, prompts not stored in Postgres, a k6 run in Lane F that watches proxy CPU and Postgres write latency. Do not tune for 1,000 RPS until Lane P has a cost result worth protecting.

### Provider outage

Cooldown should remove a dead deployment. A fallback that is the same provider does not help. A fallback that is a different provider helps availability and can change quality, tool format, and the prompt cache (a new provider has a cold prefix).

LiteLLM drops encrypted reasoning items the fallback cannot decrypt, so a multi-turn reasoning conversation is not a transparent failover. [Fallbacks](https://docs.litellm.ai/docs/proxy/reliability). v1 has no reasoning items. The limitation is recorded so a later agent slice does not assume failover is free.

Lab rule: fallback target is a second deployment you can actually reach. Lane F proves the chain with a mock that fails the primary. Lane P does not include a long outage drill.

### Budget exhaustion

Provider-level budgets in Redis skip a provider over its window and error when every provider is over budget. [Provider budget routing](https://docs.litellm.ai/docs/proxy/provider_budget_routing). Per-key `budget_fallbacks` silently move traffic to the next model that still has per-model budget. That is a quality change during an incident. [Budget fallbacks](https://docs.litellm.ai/docs/proxy/budget_fallbacks).

A zero-cost primary is exempt from the first budget check. The proxy re-checks the fallback so a free model cannot fail open onto a paid one, unless `enforce_fallback_budget` is turned off. [Fallbacks](https://docs.litellm.ai/docs/proxy/reliability). Keep the default.

Lab rule: Lane P ceiling lives in the runner and is tighter than the key budget. The key budget is the backstop. `budget_fallbacks` onto a cheaper model stays off unless decision 5 says otherwise. Lane F asserts that an exhausted key does not call the fallback provider.

### Semantic cache and tenant bleed

Separate from stampede. A semantic hit can return another user's tool call when end users share a virtual key. The mitigation is `semantic_cache_scope: end_user`, and requests with no end-user id fall back to the shared bucket. [Semantic caching](https://docs.litellm.ai/docs/proxy/caching_semantic). Bifrost partitions by virtual key automatically, which is safer and still not safe across users of one key if the cache key is shared. [Bifrost](https://docs.getbifrost.ai/features/semantic-caching).

Lab rule: semantic cache disabled in v1. Any later enablement is a named arm with the paraphrase slice from the benchmark design, plus a test where two user ids must not see each other's responses.

### Quality failure that still returns 200

The costly outage for this project is a cheap, fast, wrong answer. RouteLLM showed that a preference router can hold a bar on 2024 benchmarks. [LMSYS](https://www.lmsys.org/blog/2024-07-01-routellm/). `cost-based-routing` will not. It selects the lowest price among healthy deployments sharing an alias, and an unknown model is treated as `$1`. [Router](https://docs.litellm.ai/docs/routing).

Compression has the same shape. LLMLingua-2's paper reports 2×–5× compression with end-to-end speedups on its datasets. [ACL](https://aclanthology.org/2024.findings-acl.57/). Those datasets are not a JSON tool schema. Kong's compressor is Enterprise and still uses that method. [Plugin](https://developer.konghq.com/plugins/ai-prompt-compressor/).

Lab rule: no model downgrade and no compressor in v1. Quality is an exact or normalized match against the frozen key, compared with the baseline arm.

## Trade-offs to keep visible

| Choice | Gain | Cost |
| --- | --- | --- |
| Exact gateway cache | Repeated identical calls stop billing and drop latency | Stale answers until TTL. Temperature-0 samples freeze. Unique traffic gets no hit and still pays Redis |
| Provider prompt cache | Large input discount without changing the answer | Writes can cost 1.25× or 2×. Needs a stable prefix, a minimum length, and the same deployment. Time-limited |
| Same-tier fallback | Availability | Extra latency and a second bill on the failure path. Format drift |
| Cheaper fallback or router | Lower median bill | Quality falls on the hardest or the unluckiest calls. Hard to see if those calls are averaged into one score |
| Fewer retries | Less amplification | More user-visible errors |
| Fail closed on Postgres loss | Budgets hold | The lab is down when Postgres is down |
| Store prompts | Easier debugging | Privacy and Postgres growth. Leave off |
| Free-tier upstream | $0 | Unreproducible 429s, no cost signal, and on Gemini a data-use term that paid tiers are documented to avoid |
| Forking the gateway | Custom single-flight or router | Upgrade tax. The lab stops being about measurement |
| OTel as the ledger | One system | A dropped span drops a dollar. The results file is the ledger. Traces explain it |

## Assumptions challenged

1. **"The proposed stack should be built as a TypeScript gateway that includes LiteLLM."** LiteLLM is the gateway. TypeScript should score and drive it. A second proxy in Node duplicates retries and splits the budget.

2. **"Caching is one feature."** Gateway response cache and provider prompt cache stack, and they fail differently. Reporting one "cached tokens" column will invent savings or hide a write premium.

3. **"A cheaper model is an optimization of the same task."** It is a different system. Publish it as its own arm or leave it out.

4. **"Free tiers are enough to demonstrate cost optimization."** A zero price cannot demonstrate cost. Google also says capacity is not guaranteed. [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

5. **"Vendor router savings transfer."** LiteLLM's 37–69% and RouteLLM's 85% / 45% / 35% are real publications about their workloads and model pairs. They are hypotheses for this lab, not acceptance tests.

6. **"Semantic cache is how you cut tokens."** On identical traffic, exact cache is stricter and safer. On paraphrase traffic, semantic cache cuts tokens by risking the answer. On agent traffic, LiteLLM says it is the wrong tool.

7. **"p99 from a 50-call paid run is a reliability result."** It is an anecdote. Lane F supplies the percentile with enough samples. Lane P supplies the dollar figure.

8. **"Enterprise Kong or Portkey would save implementation time."** Kong's relevant AI policies are licensed. Portkey's semantic cache, long retention, and budgeted control plane sit on paid or hybrid plans, and new air-gapped installs are closed. [Portkey comparison](https://docs.portkey.ai/docs/product/product-feature-comparison). Using them would teach license boundaries more than cache math.

## Scope creep to refuse until the first slice has a report

- A home-grown provider adapter layer.
- Semantic cache, Auto Router, or a trained RouteLLM checkpoint.
- LLMLingua in the request path.
- Multi-tenant SSO, audit logs, or a LiteLLM Enterprise license. SSO for up to five Admin UI users is free and still unnecessary here. [Enterprise](https://docs.litellm.ai/docs/enterprise).
- Streaming, tools, images, and agent loops.
- Kubernetes, multi-region, and an SLO dashboard.
- Head-to-head bake-off of LiteLLM, Portkey, Bifrost, and Kong on the same traffic. That is a second project. Decision 1 picks one base.
- Prompt storage, a vector database, and a judge model on every call.
- Load tests against a paid endpoint "just to see p99."

## Security and privacy notes that affect the benchmark

Virtual keys belong in the proxy so provider keys stay in the proxy environment. [Virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys). The runner's results file will contain prompts and answers if quality scoring needs them. That file is local lab data. Do not ship it to a hosted trace vendor by default. OTel content capture should stay off until someone chooses a place to store it.

Gemini's free tier is documented as eligible for product improvement. A paid tier is the one to use if the frozen set is anything other than public sample text. [Billing](https://ai.google.dev/gemini-api/docs/billing).

Confidence: **high**.
