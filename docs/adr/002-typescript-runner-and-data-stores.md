# ADR 002: TypeScript runner, Redis, PostgreSQL, Docker

Status: Accepted (provisional, 2026-10-10)

## Context

The lab has to schedule arms, isolate caches, stop before a spend ceiling, score answers, and write a report. LiteLLM already stores keys and spend in Postgres and already requires Redis for a shared response cache. See [architecture-options.md](../research/architecture-options.md).

## Decision

- Docker Compose runs LiteLLM, Redis, PostgreSQL, and a local fault provider.
- One proxy replica. Redis is still configured for the response cache and router state, matching LiteLLM's multi-worker rule.
- PostgreSQL is the proxy's system of record. `store_prompts_in_spend_logs` stays off.
- The experiment runner is TypeScript. It calls the proxy with an OpenAI-compatible client. It does not call OpenAI directly.
- The results JSONL file is the benchmark ledger. An OpenTelemetry collector is a later task, not a gate for the first run.
- k6 is deferred. The runner issues Lane F traffic so retry policy lives in one place: the proxy.

## Consequences

- A paid run is unreachable unless the process is started with an explicit allow flag. CI runs Lane F only.
- Lanes F and P use separate virtual keys and must not share a Redis logical database.
- Reports can be rebuilt from JSONL plus the price card without another model call.

## Alternatives

| Option | Why it lost |
| --- | --- |
| Runner inside the LiteLLM container | Mixes lab code with upstream upgrades. |
| k6 as the only client | Good for arrival rate, poor for price reservation and answer keys. |
| OTel as the cost ledger | A dropped span drops a dollar. Traces explain outliers after the ledger exists. |

## Evidence

- [What Needs Redis](https://docs.litellm.ai/docs/proxy/redis_requirements)
- [Database sizing](https://docs.litellm.ai/docs/proxy/db_sizing)
- [OpenTelemetry v2](https://docs.litellm.ai/docs/observability/opentelemetry_v2)

Confidence: high.
