# ADR 005: Same-model fallback only, exercised on a local fault lane

Status: Accepted (provisional, 2026-10-10)

## Context

A cheaper fallback changes answer quality on the failure path. Phase 1 has one OpenAI deployment of `gpt-4.1-mini-2025-04-14`. There is no independent same-model deployment to fail over to. LiteLLM no longer honors `mock_testing_fallbacks` on proxy requests as of v1.85.0, so failover has to be a real HTTP error from an upstream. [Fallbacks](https://docs.litellm.ai/docs/proxy/reliability).

## Decision

- Lane P has one deployment. `fallbacks` is empty. `num_retries` is 0.
- Lane F points the same model alias at a TypeScript fault provider. A second deployment of that alias is the healthy fallback, still the local process, still labeled as the same model id.
- The fault provider emits 429 with `Retry-After`, 500, a delayed timeout, and 200 with a fixed `usage` object. It counts upstream attempts per client request id.
- The runner and any future k6 script do not retry. Amplification is `upstream_attempts / client_requests` and must stay at or under `1 + num_retries` for the deployment under test.
- `budget_fallbacks` onto GPT-5 nano is off.
- `enforce_fallback_budget` stays at the default true.

Lane F `num_retries` is 2, `request_timeout` is 2 seconds, `allowed_fails` is 2, `cooldown_time` is 30 seconds. Those values are part of the manifest and the report.

## Consequences

- Fallback success is an availability result on the mock. It is not a claim about OpenAI region failover.
- A Lane F 200 from the fallback is success for availability and a separate row for which deployment answered.
- Stampede size is reported, not gated. Nothing in the LiteLLM docs states that identical completion misses are single-flighted.

## Alternatives

| Option | Why it lost |
| --- | --- |
| Paid 429 drill | Burns the 5 USD target and confuses provider rate limits with proxy policy. |
| Fallback to GPT-5 nano | Quality change during failure. Locked out of the first benchmark. |
| k6 in the first slice | A second client can add its own retries and spoil the amplification ratio. |

## Evidence

[Fallbacks](https://docs.litellm.ai/docs/proxy/reliability), [risks-and-tradeoffs.md](../research/risks-and-tradeoffs.md).

Confidence: high.
