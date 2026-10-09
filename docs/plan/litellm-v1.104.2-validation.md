# LiteLLM v1.104.2 validation

Pinned release: `v1.104.2` (published 2026-10-08). Image: `ghcr.io/berriai/litellm:v1.104.2`. Digests are in `config/image-pins.json`.

Source checked at that tag: `litellm/caching/caching.py` (`get_cache_key`), `litellm/caching/caching_handler.py`, `litellm/proxy/common_request_processing.py` (`get_custom_headers`), `litellm/router.py` (`async_function_with_retries`, `async_function_with_fallbacks`), `litellm/router_utils/cooldown_handlers.py`.

## 1. Virtual keys do not partition the exact response cache

`get_cache_key` hashes the LLM call parameters (model, messages, and the other completion settings that are part of that key). Tenant fields (`user_api_key`, `user_api_key_team_id`, `user_api_key_org_id`) are appended only inside the semantic-cache helper. Exact Redis caching does not hash the virtual key.

Two cache-enabled callers that send the same body share one Redis entry. A virtual key cannot isolate arm B from arm C, and it cannot isolate `f-exact` from `f-nocache`.

On this tag, `mode: default_off` caches a call only when the request sets `cache.use-cache: true` (`LiteLLMCache.should_use_cache`). The key metadata does not add that flag. Lane F turns cache on in the request body. `f-nocache` omits the flag, so it neither reads nor writes the cache. The runner also sends one `f-nocache` call with the same cache-on body as `f-exact` and expects a hit. That is the check that keys do not partition.

Semantic cache stays unset.

## 2. Cache hits replay usage. The runner does not trust usage

On a hit, the caching handler copies the stored completion, sets `_hidden_params["cache_key"]` and `cache_hit=True`, and returns that object. The stored `usage` is replayed. It is not a new provider usage record.

`get_custom_headers` emits `x-litellm-cache-key` from `hidden_params.cache_key` and drops empty values. There is no `x-litellm-cache-hit` header. Spend-log `cache_hit` is not an HTTP signal.

A Lane F hit is confirmed only when both are true:

- `x-litellm-cache-key` is present and non-empty
- the fault provider has no attempt event for that logical request id

`x-litellm-semantic-similarity` must be absent. Replayed `usage` is never enough, including when `cached_tokens` is non-zero.

## 3. Retry and fallback attempt counts

`async_function_with_retries` performs one call plus `num_retries` additional attempts. With `num_retries: 2`, a failing deployment is called 3 times. After that, `async_function_with_fallbacks` moves to the next model group.

Two deployments that share one `model_name` are load-balanced (`simple-shuffle`). They are not an ordered primary and fallback. The phase-1 line "both deployments use alias `lab-chat`" cannot produce "3 primary attempts, then 1 fallback."

Lane F config adjustment, same stock proxy, no custom gateway:

| Client model | Group contents | Fallbacks entry |
| --- | --- | --- |
| `lab-chat` | primary fault deployment only | `lab-chat-fallback` |
| `lab-chat-fallback` | healthy fault deployment | none |
| `lab-chat-retry` | primary fault deployment only | none |

`fault-500` and `fault-timeout` call `lab-chat`. `fault-429` calls `lab-chat-retry` so the exhausted retries stay on the 429 and the client status stays 429. Both deployments still use model id `gpt-4.1-mini-2025-04-14`.

`allowed_fails` is a second conflict. The router default in this release is 3. Setting router `allowed_fails: 2` selects the counter in `should_cooldown_based_on_allowed_fails_policy`, which cools the deployment when failures in the window exceed 2. A cooled primary is skipped, so 20 back-to-back `fault-500` calls would not make 60 primary attempts, and 20 `fault-429` calls would not stay at amplification 3.0.

`cooldown_handlers.py` reads deployment `allowed_fails` from `model_info` only. Lane F sets `model_info.allowed_fails: 1000` on each measured deployment so the 20-call window measures the retry loop. Router `allowed_fails: 2` and `cooldown_time: 30` stay in `router_settings` and in the report, as ADR 005 requires, and they are not the effective threshold for these deployments. A single-deployment group with a generic deployment `allowed_fails` also returns before cooldown (`_should_cooldown_based_on_deployment_policy`).

The runner drains open fault-provider calls, then flushes Redis DB 0, before the next scenario. Exact-cache and stampede bodies include the run id, because a Redis flush does not clear the proxy's in-memory cache and a constant prompt would hit an entry left by an earlier run.

Stampede size is recorded and is not required to be 1. This release does not single-flight identical completion-cache fills.

## 4. Why Lane F 20261009T190606Z saw 5–7 attempts and negative counts

That run failed five scenarios. `fault-budget` passed: HTTP 422, zero upstream arrivals.

### Measurement

The runner subtracted one process-wide fault-provider total around each client call. Each long scenario then contained one negative row: `fault-429-18` was -96, `fault-500-17` was -129 (-97 primary and -32 fallback), and `fault-timeout-7` was -47. That is `arrivals since the wipe - the previous total` after the in-memory counter was cleared while a call was still open. The provider process or the WSL Docker daemon had restarted; Postgres logged `57P01 terminating connection due to administrator command`. Nothing clamped the negative to zero. The subtraction produced it.

Stampede rows were HTTP 200, `gateway_cache: miss`, and `upstream_attempts: 0`. A confirmed hit would have set `x-litellm-cache-key`. Those zeros were unattributed arrivals, not a single-flight of zero.

The fault provider now appends one event per arrival: `attempt_id`, `boot_id`, `scenario_id`, `logical_request_id`, role, arrival, completion, and client-finished time. A count only increments events for that logical id. `POST /_reset` returns 409 while a call is open. A changed `boot_id` fails the run. An arrival after the client finished stays in the count and is flagged late.

### The extra HTTP attempts

Steady rows before each counter wipe were 6 primary on 429, and 6 primary plus 2 fallback on 500 and on the first timeout call. Router `num_retries: 2` is 3 logical attempts, then one fallback group. In `litellm/llms/openai/openai.py` the handler does `inference_params.pop("max_retries", 2)`. The router's `setdefault("max_retries", 0)` does not replace a value that is already set, and the Lane F deployments did not set `max_retries`, so the OpenAI client used that default inside each router attempt. The `for _ in range(2)` loop in the same file only reformats an alternating-role 422. It re-raises a 429 or 500, so it is not a second copy of those errors.

Each deployment now sets `max_retries: 0`. `litellm_settings.num_retries` was removed. The only `num_retries` is the router value 2. ADR 005 is unchanged.

Measured after that config change, on the same pinned proxy, with the event log:

| Request | Client | Primary | Fallback | Late | Arrival timeline |
| --- | --- | --- | --- | --- | --- |
| one 429 on `lab-chat-retry` | 429 | 3 | 0 | 0 | +0ms, +1133ms, +2846ms. Client returned at 7108ms, after the third arrival |
| one 500 on `lab-chat` | 200 | 3 | 1 | 0 | primary +0ms, +1075ms, +2311ms; fallback +4735ms |

### Cache isolation

The failed exact-cache first call was already a hit: the cache-key header was set, latency was about 100ms, and that logical id had no upstream arrival. The prompt bytes were constant across runs, and flushing Redis does not clear the proxy process cache. The assertion stays "the first call of a fresh body is one upstream attempt." The body now includes the run id. The two exact-cache calls in one run still share identical bytes.

Repro `repro-20261009T200943Z`:

- first cache-on call: 1 primary, no cache-key header
- second cache-on call: 0 upstream, cache key `routeforge-lane-f:98e015e360c0a8adc7cbad65428f77c6b3a598c37d6591904df20eb5d3dd6ac5`
- `f-nocache` without the flag, same body: 1 primary, no cache-key header
- `f-nocache` with the flag, same body: 0 upstream and the same cache key

Virtual keys do not partition this cache. That is the live result, matching `get_cache_key`.

Twenty concurrent cache-on calls with a cold run-scoped body: 20 responses were HTTP 200, 12 upstream arrivals were attributed, and none were unattributed. The pass line stays "at least one upstream arrival." It does not require exactly one.

### Classification

| Scenario | What failed |
| --- | --- |
| exact-cache-repeat | Test isolation. The first call reused a warm entry. The header rule itself matched a hit. |
| fault-429 | Gateway retry nesting, plus one measurement reset |
| fault-500 | The same retry nesting (6 primary and 2 fallback), plus one measurement reset |
| fault-timeout | The same nesting on the early calls. Later one-attempt rows were a restarted counter or a cooled path, not the steady retry rule |
| fault-stampede | Measurement. The 200s were not tied to request ids |
| fault-budget | Passed. The proxy rejected the exhausted key and made no upstream call |
