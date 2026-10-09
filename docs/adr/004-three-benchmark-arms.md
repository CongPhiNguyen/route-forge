# ADR 004: Three benchmark arms

Status: Accepted (provisional, 2026-10-10)

## Context

The research draft used four arms (baseline, prefix, exact cache, failover) and about 150 calls each. The locked workload is single-shot Q&A with one stable long prefix and a variable suffix. Failover is not a paid arm. The comparison has to separate provider prompt caching from gateway exact caching.

## Decision

Lane P runs three arms, concurrency 1, temperature 0, seed `20261010`:

| Arm | Gateway exact cache | Prompt shape | What it measures |
| --- | --- | --- | --- |
| `A-baseline` | Off | Unique leading nonce, so the prefix cannot match a previous request | Full uncached input price |
| `B-provider-cache` | Off | Identical stable prefix, variable suffix, one `prompt_cache_key` | Provider `cached_tokens` after a warmup call |
| `C-gateway-exact` | On | Same bytes as B on the repeat slice | Gateway hit, billable USD 0, body identical to the first response |

A two-call broken-prefix diagnostic sits inside arm B and is excluded from the headline savings. It is not a fourth arm.

GPT-5 nano, semantic cache, compression, and a custom router are absent.

## Consequences

- Arm A and arm B are different strings. Quality is scored against the answer key, not by string-equality between arms.
- Arm B and arm C share bytes on the repeat slice. The only request-path difference is the virtual key: cache disabled versus cache enabled. That keeps the gateway-cache variable off the prompt.
- Gateway hits replay the cached HTTP body, including the original `usage` object. Billable USD for a hit is 0. Summing replayed usage would double-count.
- Warmup calls are rows in the arm, marked `phase: warmup`, and are excluded from the steady-state rate.

## Alternatives

| Option | Why it lost |
| --- | --- |
| One "optimized" arm with prefix and gateway cache together | Savings cannot be attributed. |
| Baseline that uses the same stable prefix | The first call is cold and later calls become a provider-cache arm. That collapses A into B. |
| Paid failover arm | No second real deployment of the same model. Faults stay on the local lane. |

## Evidence

- Exact cache hashes the whole request. [LiteLLM caching](https://docs.litellm.ai/docs/proxy/caching)
- Provider cache needs an exact prefix and, before GPT-5.6, a stable `prompt_cache_key` as a routing hint, not a guarantee. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- Per-scenario cache opt-in via `mode: default_off`. [Semantic caching](https://docs.litellm.ai/docs/proxy/caching_semantic) (the default-off control is documented there)

Confidence: high on the isolation design. Medium on hit rates until the preflight.
