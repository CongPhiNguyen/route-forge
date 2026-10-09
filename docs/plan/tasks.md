# Phase 1 task list

Status: not started. Do not implement from this list until you want code. The spec is [phase-1.md](phase-1.md).

Priority is top to bottom. A task does not start while the one above it is red, except P2 and P3, which wait until the paid report exists.

## P0 — minimum runnable slice

| ID | Task | Acceptance |
| --- | --- | --- |
| P0.1 | Pin Redis, Postgres, and a LiteLLM release by digest. Record the digests in the Compose file after the first pull. Add the price card `openai-standard-2026-10-10` with `gpt-5-nano` marked inactive | `docker compose config` is stable. The runner rejects the inactive model |
| P0.2 | Proxy config: one replica, Redis for cache and router state, Postgres, `store_prompts_in_spend_logs` off, cache `mode: default_off`, semantic cache unset | `/cache/ping` is healthy. A spend row does not contain prompt text |
| P0.3 | Virtual keys `f-nocache`, `f-exact`, `f-budget`, `p-nocache`, `p-exact`. Confirm cache opt-in against the pinned LiteLLM docs | `f-exact` caches a repeat. `f-nocache` does not |
| P0.4 | TypeScript fault provider: 200, 429 plus `Retry-After`, 500, sleep, `GET /_stats` keyed by client request id | Direct curl sees the status and the counter |
| P0.5 | Lane F proxy config: two deployments, same model id, `num_retries: 2`, timeout 2s, fallback to the healthy deployment. Lane P config: one OpenAI deployment, `num_retries: 0`, no fallback | The two config files cannot be mixed by the runner's hash check |
| P0.6 | Runner skeleton: load manifest, copy snapshot, reserve USD, write JSONL, render `report.md`. Default path sends no traffic | Dry-run exit 0 and an empty send count |
| P0.7 | Lane F scenarios `exact-cache-repeat`, `fault-429`, `fault-500`, `fault-timeout`, `fault-stampede`, `fault-budget` | Gates in the Phase 1 fault table |
| P0.8 | Refuse Lane P unless `ROUTEFORGE_ALLOW_PAID=1` and the Lane P config hash matches | Unset flag exits before a provider socket |

## P1 — paid benchmark

| ID | Task | Acceptance |
| --- | --- | --- |
| P1.1 | Fixture `qa-v1.json`, 12 extractive items, `o200k_base` count, fail if prefix under 2,048 | Token count stored in the manifest snapshot |
| P1.2 | Message builder for nonce, stable prefix, broken prefix, paraphrase | Unit checks on byte equality of B and C stable bodies |
| P1.3 | Usage parser and price formula, including gateway-hit `billable_usd = 0` | Fixture usage JSON matches hand-computed USD |
| P1.4 | Quality checks: fact, format, nonce echo, cache identity | Known-answer fixtures pass without a model |
| P1.5 | Preflight procedure, one optional lengthening to 4,096 | Documented stop if `cached_tokens` stays 0 |
| P1.6 | Execute A, B, C once. Write the report | Paid acceptance list in [phase-1.md](phase-1.md) |
| P1.7 | Sum `billable_usd` across artifacts and stop the runner if the account target of 5 USD would be crossed by the next invocation | A fourth 1.50 USD invocation cannot start |

## P2 — after the first paid report

| ID | Task | Why it waits |
| --- | --- | --- |
| P2.1 | OpenTelemetry collector and a note that maps LiteLLM spans onto the JSONL `run_id` | The ledger already explains cost. Traces explain a slow row |
| P2.2 | Record Lane F stampede upstream count in the report narrative | Only interesting once the number is real |
| P2.3 | GPT-5 nano cohort arm, new ADR, new ceiling | Changes the model. Out of the first benchmark |

## P3 — not this phase

k6 constant-arrival scenarios, semantic cache, Auto Router, compression, Kubernetes, UI, streaming, tools, multi-turn.

## Review rule for every PR

- No provider SDK call outside the proxy.
- No semantic cache, no `gpt-5-nano` request, no `budget_fallbacks`.
- Lane P is not invoked from CI.
- `artifacts/` is gitignored. A redacted report may be committed later by hand.
- The report regenerates from JSONL and the price card offline.
