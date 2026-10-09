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
- the fault-provider attempt counter did not increase for that client call

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

The runner flushes Redis DB 0 between scenarios so a cooldown or cache entry from one scenario cannot change the next.

Stampede size is recorded and is not required to be 1. This release does not single-flight identical completion-cache fills.
