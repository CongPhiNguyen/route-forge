# Existing solutions

Research date: 2026-10-10. Sources are official product docs unless a paper or repository is named. Model names in vendor examples (`gpt-5.6-luna`, `claude-opus-5`, and similar) are the names those docs used on the fetch date. Pin model IDs in a lab price card. Do not copy example names into a benchmark and expect them to stay valid.

## Recommendation

Use the open-source LiteLLM Proxy as the gateway. Keep provider adapters, exact-match response caching, failover, budgets, and spend logs inside that proxy. Build the lab's own experiment runner, price-card accounting, and input-prefix policy around it.

Evidence: LiteLLM documents those capabilities on the open-source gateway image. Enterprise is a license key on the same image and adds SSO, audit logs, secret managers, and some guardrail integrations. It is not required for virtual keys, budgets, load balancing, or caching. [LiteLLM Enterprise](https://docs.litellm.ai/docs/enterprise), [Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys), [Caching](https://docs.litellm.ai/docs/proxy/caching).

Alternatives considered below: Portkey Gateway, Bifrost, Kong AI Gateway, Cloudflare AI Gateway, RouteLLM, Redis LangCache, GPTCache.

Rationale: the lab's measurable work is token class accounting, cache policy, fallback behavior, and quality cost. Those sit on top of a gateway. Reimplementing provider translation and failover would spend the project on a solved problem.

Confidence: **high** for the capability inventory below. **Medium** for "LiteLLM is the best base," because Portkey matches the TypeScript preference more closely and Bifrost is a credible Apache-2.0 alternative. That choice is decision 1.

## What "gateway" already means

A mature AI gateway in 2026 already covers:

| Concern | Typical product feature | Lab should rebuild it? |
| --- | --- | --- |
| One OpenAI-compatible API across providers | Universal / proxy API | No |
| Retries, timeouts, cooldowns, fallbacks | Router reliability | No |
| Exact response cache | Redis or edge cache | No |
| Per-key spend and RPM/TPM | Virtual keys + Postgres/Redis | No |
| Provider prompt-cache token fields | Pass-through usage + cost helper | No, but the lab must read the fields |
| Semantic response cache | Embedding + vector lookup | No for v1. Unsafe on multi-turn traffic |
| Complexity / cost-quality routing | Heuristic, classifier, or learned router | Not in v1. Beta or research-grade |
| Prompt compression | Separate model (LLMLingua-class) | Not in v1 |
| Benchmarks, price cards, quality sets | Rarely a product | Yes. This is the lab |

## LiteLLM Proxy

License: MIT, repository [BerriAI/litellm](https://github.com/BerriAI/litellm). Docker images are cosign-signed. Enterprise features use a separate commercial license key on the same image. [Enterprise overview](https://docs.litellm.ai/docs/enterprise).

### Reuse as-is

| Capability | What the docs say | Source |
| --- | --- | --- |
| Exact response cache | `redis`, `s3`, `gcs`, `local`, `disk`. Key is a hash of the whole request. Any conversation change is a miss. Redis is required once more than one worker exists, because an in-memory cache is per process. | [Caching](https://docs.litellm.ai/docs/proxy/caching), [What Needs Redis](https://docs.litellm.ai/docs/proxy/redis_requirements) |
| Semantic response cache | `redis-semantic`, `qdrant-semantic`, `valkey-semantic`. Serves the nearest prompt above `similarity_threshold`. Embedding lookup is inline and abandoned after a timeout (default 5s) so a dead embedder becomes a miss, not a hung request. | [Semantic caching](https://docs.litellm.ai/docs/proxy/caching_semantic) |
| Fallbacks | In order, after `num_retries`. Separate chains for general errors (including 429), context-window errors, and content-policy errors. Budget is re-checked on each fallback target when `enforce_fallback_budget` is true (default). | [Fallbacks](https://docs.litellm.ai/docs/proxy/reliability) |
| Retry and cooldown | Example config: `num_retries`, `request_timeout`, `allowed_fails`, `cooldown_time`. A deployment that fails too often in a minute is cooled down. | [Fallbacks](https://docs.litellm.ai/docs/proxy/reliability) |
| Load balancing | `simple-shuffle` (default, recommended), `usage-based-routing-v2`, `latency-based-routing`, `least-busy`, `cost-based-routing`, custom strategy, per-model routing groups. Usage-based routing is documented as adding Redis latency and is not the production default. | [Router](https://docs.litellm.ai/docs/routing) |
| `cost-based-routing` | Among healthy deployments under their RPM/TPM, pick the lowest entry in the cost map. A model missing from the map is priced at `$1` so it loses to known cheap models. | [Router](https://docs.litellm.ai/docs/routing) |
| Session / prompt-cache affinity | `session_affinity` and `PromptCachingDeploymentCheck` pin a conversation or a cacheable prefix to the deployment that can hit provider-side cache. Pins live in the router cache and need Redis to be shared across instances. | [Router](https://docs.litellm.ai/docs/routing), [Prompt cache routing](https://docs.litellm.ai/docs/tutorials/claude_code_prompt_cache_routing) |
| Budgets | Provider budgets in Redis over a time window. Per-key `model_max_budget` can fall back to another model via `budget_fallbacks` instead of returning `budget_exceeded`. Postgres is required for virtual keys and usage tracking. | [Provider budget routing](https://docs.litellm.ai/docs/proxy/provider_budget_routing), [Budget fallbacks](https://docs.litellm.ai/docs/proxy/budget_fallbacks), [Database sizing](https://docs.litellm.ai/docs/proxy/db_sizing) |
| Prompt-cache cost | `completion_cost()` understands cache read and cache write. Response header `x-litellm-response-cost`. | [Prompt caching](https://docs.litellm.ai/docs/completion/prompt_caching) |
| Tracing | OpenTelemetry v2: one trace per request, GenAI semantic conventions, optional histograms for latency, tokens, and cost. | [OpenTelemetry v2](https://docs.litellm.ai/docs/observability/opentelemetry_v2) |

### Do not treat as done

Semantic caching embeds the whole `messages` array, including the system prompt. On multi-turn or tool-calling traffic, each new turn is almost the same text as the last, so embeddings land near 0.99 and the proxy replays a stale tool call. The docs say raising the threshold does not reliably fix this. Exact-match cache is the documented alternative. Default semantic scope is the virtual key, team, and org, so end users behind one key share a bucket unless `semantic_cache_scope: end_user` is set. [Semantic caching](https://docs.litellm.ai/docs/proxy/caching_semantic).

`cost-based-routing` chooses the cheapest deployment that shares a `model_name`. Putting a frontier model and a small model under one alias sends all traffic to the cheap model. That is a quality decision, not a reliability feature. Use it only when the deployments are acceptable substitutes.

Auto routing (`auto_router/complexity_router`) classifies a request into SIMPLE / MEDIUM / COMPLEX / REASONING and can pin sessions or prompt-cache prefixes. It is documented as **beta**, shipping in the v1.94.x line, with config keys that can still change. The heuristic scorer is sub-millisecond and makes no extra model call. An LLM or custom classifier adds a hop and, for replaced rubrics, can require an Enterprise custom-classifier capability. [Auto routing](https://docs.litellm.ai/docs/proxy/auto_routing). LiteLLM's own benchmark post claims router-plus-provider-cache was 37% to 69% cheaper than caching alone on one frontier model, across five datasets. Treat that as vendor measurement, not a result this lab has reproduced. [Benchmark post](https://docs.litellm.ai/blog/auto-router-prompt-caching-benchmark).

Cache-stampede protection that showed up in a public pull request (`EventDrivenCacheCoordinator`, [PR 20030](https://github.com/BerriAI/litellm/pull/20030)) coordinates the **global spend** database read. It is not documentation that identical completion calls are single-flighted. The lab should measure response-cache stampedes directly.

Postgres write load is the accounting path (`LiteLLM_SpendLogs`), not auth. Storing prompts in spend logs multiplies row size. The sizing guide recommends batching spend writes and a retention window. [Database sizing](https://docs.litellm.ai/docs/proxy/db_sizing).

Confidence: **high** on documented behavior. **Medium** on stampede behavior of the response cache, because the coordinator PR is a different cache.

## Portkey AI Gateway

Open-source gateway: MIT, [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway). The README describes a lightweight gateway for routing, retries, fallbacks, load balancing, conditional routing, caching, guardrails, and an OpenAI-compatible API. Local run is `npx @portkey-ai/gateway`.

The hosted product docs list the same strategies as JSON configs: simple and semantic cache, fallbacks, conditional routing, retries, circuit breaker (`failure_threshold`, `cooldown_interval` minimum 30s), load balancing, canaries, timeouts, budgets, and rate limits. [AI Gateway](https://portkey.ai/docs/product/ai-gateway), [Config object](https://docs.portkey.ai/docs/api-reference/inference-api/config-object).

Plan boundaries, from the feature comparison page (markdown conversion dropped checkbox glyphs, so empty cells are not treated as proof of absence):

| Item | What the comparison page states |
| --- | --- |
| Request allowance | Open source: no Portkey-hosted request cap. Dev: 10k requests/month. Pro: 100k, then overage. |
| Simple cache | Dev noted as 1-day TTL. Pro and Enterprise noted as unlimited TTL and stream-from-cache. |
| Semantic cache | Noted on Pro and Enterprise as unlimited TTL and stream-from-cache. The cache doc says simple cache is on all plans and semantic cache needs a vector database and is on select Enterprise plans, with a self-host setup that still requires an embedding provider and an OpenAI-compatible model. |
| Key management with budgets and rate limits | Called out on the Enterprise column. |
| Log retention | Dev 3 days, Pro 30 days, Enterprise custom. |
| New fully air-gapped deploys | No longer offered. Hybrid keeps the data plane in your VPC and the control plane at Portkey, which requires outbound HTTPS to `control.portkey.ai`. |

Sources: [Feature comparison](https://docs.portkey.ai/docs/product/product-feature-comparison), [Cache](https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic), [Hybrid](https://docs.portkey.ai/docs/enterprise/hybrid), [Self-hosted cache behavior](https://docs.portkey.ai/docs/self-hosting/cache-behavior).

The docs banner states that Portkey is now Prisma AIRS AI Gateway (Palo Alto Networks). That is a strategic dependency, not a technical defect. A learning lab that vendors the control plane inherits that product direction.

Why it is the strongest alternative: the gateway is TypeScript, which matches the proposed application language, and the config object is a clean place to express fallback and circuit-breaker policy.

Why it is not the default: spend accounting, virtual keys, and Postgres are first-class on LiteLLM's open-source proxy. On Portkey, the durable control plane, long retention, semantic cache, and budgeted key management sit on paid or hybrid plans. Rebuilding that ledger in the lab would duplicate LiteLLM.

Confidence: **high** on MIT license, config strategies, and the air-gap / hybrid statements. **Medium** on the exact open-source checkbox matrix, because the comparison table's glyphs did not survive fetch.

## Kong AI Gateway

Two generations are documented.

Kong Gateway plugins:

| Plugin | Availability in the fetched docs | What it does |
| --- | --- | --- |
| AI Proxy | Open-source Kong Gateway path. One configured provider. Translates an OpenAI-shaped request and can pass native formats. | [AI Proxy](https://developer.konghq.com/plugins/ai-proxy/) |
| AI Proxy Advanced | "AI Gateway Enterprise." Multiple targets. Algorithms include round-robin, consistent-hash, least-connections, lowest-latency, lowest-usage, semantic, and priority failover. | [AI Proxy Advanced](https://developer.konghq.com/plugins/ai-proxy-advanced/) |
| AI Semantic Cache | Enterprise. Redis (RediSearch + RedisJSON, or Valkey Search) or, on the 2.x policy, PostgreSQL/pgvector. Exact check is optional. Docs warn that most LLM origins send `Cache-Control: no-cache`, so honoring cache-control bypasses the cache. | [Policy](https://developer.konghq.com/ai-gateway/policies/ai-semantic-cache/), [Plugin](https://developer.konghq.com/plugins/ai-semantic-cache/) |
| AI Prompt Compressor | Enterprise. Separate container using LLMLingua 2. Compress by ratio or target token count. Selective regions via tags. | [AI Prompt Compressor](https://developer.konghq.com/plugins/ai-prompt-compressor/) |
| AI Rate Limiting Advanced | Policy on AI Gateway. `local`, `cluster`, or `redis`. Windows: fixed, sliding, calendar. Token strategies include a cost strategy. Limits can key on consumer, model, and provider. | [AI Rate Limiting Advanced](https://developer.konghq.com/ai-gateway/policies/ai-rate-limiting-advanced/) |

AI Gateway 2.x moves this onto a Konnect control plane: AI Providers, AI Models, and AI Policies replace hand-built Services, Routes, and plugins. [Concepts](https://developer.konghq.com/ai-gateway/ai-gateway-v2-concepts/).

Kong is the wrong base for this lab. The open-source plugin is a single-target translator. The features that match the project (multi-target routing, semantic cache, prompt compression, token-aware rate limits) are Enterprise and assume Kong operations. The compression idea is still useful later, via the public LLMLingua-2 method, without the plugin.

Confidence: **high**.

## Bifrost

Apache-2.0, Go, [maximhq/bifrost](https://github.com/maximhq/bifrost). Official docs describe:

- Direct (hash) cache and semantic cache in one plugin. Semantic search runs only after a direct miss. A semantic miss pays an embedding call plus the LLM call. Direct-only mode should use Redis or Valkey. Qdrant, Pinecone, and Weaviate are documented as unsuitable for direct-only because they require a real vector. [Semantic caching](https://docs.getbifrost.ai/features/semantic-caching)
- A cache key is mandatory (`x-bf-cache-key` or a default). Virtual keys partition the cache automatically.
- Governance routing: weights, provider allow-lists, and fallback chains. Each fallback re-runs plugins, including cache and governance. [Routing](https://docs.getbifrost.ai/features/governance/routing), [Retries and fallbacks](https://docs.getbifrost.ai/features/retries-and-fallbacks)
- Prometheus metrics for cache hits by type, routing-engine trail, fallback index, and embedding cost of semantic routing. [Telemetry](https://docs.getbifrost.ai/features/telemetry)

Bifrost is the cleanest open-source alternative if the lab wants semantic cache and fallback metrics without an enterprise license. It drops the TypeScript gateway and LiteLLM's Postgres spend model. Vendor latency claims (microseconds of overhead at thousands of RPS) are marketing until this lab measures them.

Confidence: **high** on license and documented cache/fallback behavior. **Low** on published overhead numbers.

## Other relevant pieces

### Provider prompt caches (not a gateway cache)

These still call the model. They discount a stable prefix. They are the largest honest saving on multi-turn traffic, and they break if the gateway sprays a prefix across deployments.

| Provider | Mechanics verified this session | Source |
| --- | --- | --- |
| Anthropic | Cache write 1.25× base input for a 5-minute TTL, 2× for 1 hour. Cache read 0.1× base input, except 0.025× on Claude Fable 5.1 and Claude Mythos 5.1. A 5-minute cache pays off after one full read. Breakpoints are explicit or automatic. | [Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching), [Pricing](https://docs.anthropic.com/en/docs/about-claude/pricing) |
| OpenAI | Automatic on eligible models. Minimum cacheable prefix 1,024 tokens (up to 2,048 on older models). For GPT-5.6 and later, writes are 1.25× uncached input and reads are 0.1× (0.05× on GPT-6.1 Sol). Cached input still counts toward tokens-per-minute. `prompt_cache_key` is a routing hint, not a correctness guarantee. | [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Pricing](https://developers.openai.com/api/docs/pricing) |
| Groq | Automatic, no write fee, 50% off cached input, 2-hour idle expiry. Cached tokens do not count toward rate limits, but a parallel burst can still 429 before the subtraction. Exact org limits are on the account limits page, not a stable public SLO. | [Prompt caching](https://console.groq.com/docs/prompt-caching), [Rate limits](https://console.groq.com/docs/rate-limits) |

### Cloudflare AI Gateway

Managed. Exact cache for identical text and image requests. TTL from 60 seconds to one month. Cache is volatile: two identical requests at once may both miss. Custom cache key via `cf-aig-cache-key`. Core caching and rate limiting are free; log storage is capped on the free plan (100,000 logs per account). Unified Billing is limited to 200 requests per 60 seconds per gateway. Bring-your-own-key traffic is outside that cap. [Caching](https://developers.cloudflare.com/ai-gateway/features/caching/), [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/), [Pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/).

Useful as a comparison point for "identical request" caching. It does not give the lab a local failure-injection surface or a Postgres ledger.

### RouteLLM

LMSYS research framework, [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM). The July 2024 post reports routers that kept about 95% of GPT-4 quality while cutting cost by over 85% on MT-Bench, 45% on MMLU, and 35% on GSM8K, using Arena preference data. The framework calls models through LiteLLM. [Blog](https://www.lmsys.org/blog/2024-07-01-routellm/), [paper 2406.18665](https://arxiv.org/abs/2406.18665).

Those numbers are tied to a GPT-4-versus-cheaper pair and to benchmarks that are not this lab's workload. Use the evaluation idea (strong-model baseline, quality threshold, cost on the x-axis). Do not drop the 2024 routers in as a production policy.

Confidence: **high** that the paper's claims are as cited. **Low** that the same ratios hold for 2026 models.

### Redis LangCache and GPTCache

LangCache is a semantic-cache service (managed public preview on Redis Cloud, self-managed Kubernetes as a private preview). It owns embeddings and exposes REST and SDKs. Preview status means behavior can change. [LangCache](https://redis.io/docs/latest/develop/ai/context-engine/langcache/).

GPTCache is a Python library (embedding + vector store + eviction) rather than a gateway. Secondary write-ups place the last tagged release at 0.1.44 in August 2024. Do not adopt it as the cache of record while gateway caches are maintained. Confidence on the release date: **medium** (not re-verified against PyPI in this session).

### LLMLingua-2

Findings of ACL 2024. Extractive token classification aimed at task-agnostic compression. The paper reports 2×–5× compression and 1.6×–2.9× end-to-end speedup on MeetingBank, LongBench, ZeroSCROLLS, GSM8K, and BBH, and says the small model is 3×–6× faster than earlier compressors. [ACL Anthology](https://aclanthology.org/2024.findings-acl.57/). Kong's Enterprise compressor is a packaged form of this idea.

This is the right reference if a later slice compresses retrieved context. It is a quality experiment with a GPU or CPU model in the path, not a gateway config flag. Code and tool schemas are outside the paper's main claim.

## Free-tier providers are not a capacity tier

Google's Gemini rate-limit doc says specified limits are not guaranteed and actual capacity may vary. Free-tier quotas are per model (RPM, TPM, RPD) and are separate from paid tiers, which add spend caps. Free-tier prompts and responses may be used to improve Google products. Moving to paid tiers is how the docs describe stronger privacy and higher limits. [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [Billing](https://ai.google.dev/gemini-api/docs/billing), [Pricing](https://ai.google.dev/gemini-api/docs/pricing).

Groq publishes per-model RPM/RPD/TPM tables and says the account limits page is authoritative, with exceptions. A 429 is the overload signal. [Rate limits](https://console.groq.com/docs/rate-limits).

Implication: a $0 token price makes cost-optimization math undefined. A shared free pool makes latency and error rate unreproducible. Free providers are allowed as a smoke test that the proxy can reach an API. They are not the baseline for the cost or reliability benchmark.

## Comparison for this lab

| Option | Self-host without a paid gateway license | Exact cache | Semantic cache | Spend ledger | Failover | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| LiteLLM Proxy OSS | Yes (MIT) | Redis | Yes, with documented multi-turn hazards | Postgres + virtual keys | Retries, cooldown, typed fallbacks | Default base |
| Portkey Gateway OSS | Yes (MIT) | Yes, in the gateway | Plan- and vector-db-gated for the product cache | Control plane is the product | Strong config, including circuit breaker | Best if the team insists on a TypeScript gateway and will accept a thinner ledger |
| Bifrost | Yes (Apache-2.0) | Redis/Valkey direct mode | Yes, after direct miss | Governance plugin, not the LiteLLM Postgres model | Yes, per-attempt plugin rerun | Best if semantic-cache metrics matter before v1's workload is chosen |
| Kong AI Gateway | AI Proxy only | Enterprise semantic cache | Enterprise | Kong analytics | Enterprise multi-target | Poor fit |
| Cloudflare AI Gateway | Managed | Identical requests only | Not in the cache doc | Cloudflare logs, capped | Not the lab's failure surface | Reference, not the core |
| RouteLLM | Library | No | No | No | No | Offline router eval only |
