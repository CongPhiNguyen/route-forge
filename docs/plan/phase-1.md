# Phase 1 implementation plan

Status: plan only. No application code in this pass.
Date: 2026-10-10.
Supersedes sample size and arm ids in [implementation-roadmap.md](../research/implementation-roadmap.md). Decisions: [ADR 001](../adr/001-gateway-litellm-oss.md) through [ADR 006](../adr/006-phase-1-scope-boundary.md).

## Locked choices

| Item | Value |
| --- | --- |
| Gateway | Stock LiteLLM Proxy OSS, one replica |
| Lab code | TypeScript runner and TypeScript fault provider |
| Stores | Redis (cache and router state), PostgreSQL (keys and spend) |
| Packaging | Docker Compose |
| Paid model | `gpt-4.1-mini-2025-04-14` |
| Inactive cohort | `gpt-5-nano`, price card only |
| Account target | 5.00 USD of real API spend for the whole phase |
| Per-invocation runner ceiling | 1.50 USD |
| Workload | Single-shot Q&A, stable shared prefix, variable suffix |
| Fallback | Same model id, local fault lane only |
| Excluded | Semantic cache, custom router, compression, Kubernetes, UI |

## What to build, in order

The minimum runnable slice is steps 1–4. Steps 5–7 are the paid benchmark. Do not start step 5 until Lane F acceptance passes.

| Step | Produce | Done when |
| --- | --- | --- |
| 1 | Compose file, pinned image digests, price card, proxy config with cache `mode: default_off` | `/health` and `/cache/ping` succeed. Postgres has no prompt bodies |
| 2 | Fault provider with attempt counter | A direct call returns the scripted status and increments the counter |
| 3 | Runner: manifest, reservation, JSONL row, report | Dry-run prints the plan and sends nothing |
| 4 | Lane F scenarios | Acceptance table below is green, `billable_usd` is 0 |
| 5 | Fixture of 12 extractive questions plus tokenizer count | Prefix token count is recorded and at least 2,048 |
| 6 | Paid preflight, two calls | Second call has `cached_tokens > 0`, or the prefix is lengthened once to 4,096 and retried once |
| 7 | Arms A, B, C under the ceiling | Report written, spend reservation released to actuals |

OpenTelemetry and k6 are tasks after step 7. They are not on the critical path.

## Runtime shape

```text
runner (TypeScript)
  reads manifest
  reserves worst-case USD
  stops if the next call would cross the ceiling or the request cap
  POST /v1/chat/completions
        |
        v
LiteLLM  -- Redis exact cache (off unless the arm's virtual key enables it)
        -- Postgres key and spend
        |
        +-- Lane P: one deployment, api_base OpenAI, num_retries 0, no fallback
        +-- Lane F: deployment "primary" and deployment "fallback"
                    both api_base = fault provider
                    num_retries 2
```

Lanes use different Compose profiles or different proxy config files so a Lane F fallback cannot point at OpenAI. The runner refuses Lane P unless `ROUTEFORGE_ALLOW_PAID=1` and the loaded proxy config has `num_retries: 0` and a single deployment.

Public model alias: `lab-chat`. Both deployments in Lane F use model id `gpt-4.1-mini-2025-04-14` in `model_info` so logs show the same id. `api_base` is the fault provider. Lane P uses that same model id against OpenAI and no second deployment.

Virtual keys:

| Key alias | Cache | Lane |
| --- | --- | --- |
| `f-nocache` | off | F arms that must miss |
| `f-exact` | on, TTL 3600s | F exact-repeat |
| `f-budget` | off, spend limit already exhausted | F budget scenario |
| `p-nocache` | off | Arms A and B |
| `p-exact` | on, TTL 3600s | Arm C |

Confirm the per-key cache field against the pinned LiteLLM version before coding it. The research docs describe `mode: default_off` and per-key `cache.no-cache`. The implementation task is to map those docs onto the pinned version, not to invent a body field.

Redis logical DB 0 is Lane F. DB 1 is Lane P. Flushing one arm flushes that DB, which is why arms inside a lane run sequentially and arm C starts with a flush.

## Three arms

Shared request settings: `model: lab-chat`, `temperature: 0`, `seed: 20261010`, `max_tokens: 64`, no tools, no images, no `response_format`. Those extras change OpenAI's cache floor on earlier models. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

| Arm | Key | Messages | `prompt_cache_key` | Calls |
| --- | --- | --- | --- | --- |
| `A-baseline` | `p-nocache` | Leading nonce, then instructions, then document, then question | Unique per call | 12, one per item |
| `B-provider-cache` | `p-nocache` | Instructions, then document, then question | `routeforge-phase1` | 12 warmup + 12 steady + 2 broken-prefix diagnostics |
| `C-gateway-exact` | `p-exact` | Same bytes as B's stable shape | `routeforge-phase1` | 12 misses + 12 exact repeats + 4 paraphrases |

### How the variables stay separate

| Variable | Held constant | Changed in |
| --- | --- | --- |
| Model, temperature, seed, max_tokens | All arms | Nowhere in phase 1 |
| Gateway cache | A and B off | C on, via the key, body unchanged versus B |
| Prefix eligibility | B and C share one prefix | A puts a new nonce in the first tokens of every call |
| Warmup versus steady | Same body within B | `phase` column. Warmup is the first call of each item. Steady is the immediate second call |
| Gateway hit versus provider cache | C repeats are byte-identical, so the gateway returns before OpenAI | B repeats are byte-different in the suffix, so the gateway must miss and OpenAI may cache the prefix |
| Broken prefix | Diagnostic only | Two B calls place the question before the document. Excluded from the savings numerator |

`prompt_cache_key` is a routing hint on models before GPT-5.6. It does not guarantee a hit. Arm A's unique key is extra separation. The nonce is what makes a shared prefix impossible. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

### Warmup and retention

GPT-4.1 mini falls in the guide's "other earlier models" row:

- Implicit caching only. No explicit breakpoints.
- No separate cache-write charge. The price card's cache-write cell is empty.
- `cached_tokens` excludes hidden system tokens and is rounded down to a multiple of 128.
- The published minimum of 1,024 tokens is the archived pre-5.6 cookbook. The current guide says the floor varies with request settings. Phase 1 therefore targets 2,048 tokens of visible prefix and treats a zero on the preflight as "not yet eligible."
- The 24-hour retention list names `gpt-4.1` and does not name `gpt-4.1-mini`. Assume `in_memory`: typically 5–10 minutes of inactivity, up to one hour.

Procedure:

1. Flush Lane P Redis.
2. Preflight: two stable-prefix calls, different suffixes, gap under 30 seconds. Record `cached_tokens`.
3. If the second is 0, rebuild the fixture at 4,096 prefix tokens and run the two-call preflight once more. Stop if it is still 0. Do not keep lengthening inside the paid loop.
4. Arm B sends item `i` warmup and item `i` steady back to back, then the next item. Record the gap. If a gap exceeds 4 minutes, mark the steady row `retention_risk: true` and exclude it from the cache-read gate.
5. Arm C flushes Redis, then sends each exact body twice. The second row must be a gateway hit even if the provider cache has expired.

### Hit and miss behavior

| Observation | Arm A | Arm B steady | Arm C first | Arm C repeat | Arm C paraphrase |
| --- | --- | --- | --- | --- | --- |
| Gateway | miss | miss | miss | hit | miss |
| Provider called | yes | yes | yes | no | yes |
| `cached_tokens` | 0 | > 0 and a multiple of 128, if the preflight passed | 0 or small | ignored, body is replayed | may be > 0 because the prefix matches B/C |
| Billable USD | full input | cached rate on the prefix | full or partial | 0 | partial input likely |

A gateway hit is identified by LiteLLM's cache response header (`x-litellm-cache-key` on a cached response). `x-litellm-semantic-similarity` must be absent. [Caching](https://docs.litellm.ai/docs/proxy/caching).

### Token accounting

OpenAI chat usage for this model:

```text
prompt_tokens = uncached_input_tokens + cached_tokens
```

There is no cache-write token class to bill. A write is billed as ordinary input.

```text
uncached_input_tokens = prompt_tokens - cached_tokens
billable_usd =
    uncached_input_tokens * 0.40 / 1_000_000
  + cached_tokens           * 0.10 / 1_000_000
  + completion_tokens       * 1.60 / 1_000_000
```

On `gateway_cache = hit`:

- `provider_called = false`
- `billable_usd = 0`
- `counterfactual_usd` prices the replayed usage object and is labeled not billed

`usd_proxy` is the `x-litellm-response-cost` header on provider calls, and 0 on gateway hits if the proxy still echoes a cost from the stored body. The cost-identity gate compares `billable_usd` to `usd_proxy` on provider calls only.

`reasoning_tokens` stays a column and must be 0 for this model. A non-zero value fails the row.

Tokenizer check before any paid call: count the prefix with `o200k_base` and store `prefix_tokens_estimated`. Billed `prompt_tokens` is authoritative. A gap is reported, not patched by adding padding inside the loop.

## Quality rubric

No judge model. The fixture is extractive: each answer is a verbatim span from the document.

Normalize by Unicode trim, casefold, collapse internal whitespace, and strip one trailing period.

| Check | Pass | Applies to |
| --- | --- | --- |
| `fact` | Normalized answer equals `expected_answer` | Every graded call |
| `format` | One line, no role label, character length fits `max_tokens` | Every graded call |
| `nonce_echo` | Arm A answer does not contain that call's nonce | Arm A |
| `cache_identity` | Repeat body equals the first body byte for byte | Arm C exact repeats |

Score for an arm is `fact` passes / graded calls. Warmup and steady are both graded. Exact repeats are graded once for `fact` and again for `cache_identity`.

Phase 1 gate: `fact` rate at least 11/12 on each arm, and `cache_identity` 12/12 on arm C. The model is unchanged across arms, so a large gap between A and B means the nonce or the message order changed the task. That fails the run and the fixture gets edited. It is not a license to drop the bar.

Paraphrases are graded for `fact` and must be gateway misses. They are not part of the 11/12 denominator if the wording is harder. Report them as `slice: paraphrase`.

## Fixture format

File: `fixtures/qa-v1.json`.

```json
{
  "schema_version": 1,
  "fixture_id": "qa-v1",
  "model_id": "gpt-4.1-mini-2025-04-14",
  "encoding": "o200k_base",
  "prefix_token_target": 2048,
  "instructions": "Answer with the span from the document and nothing else.",
  "document": "A synthetic handbook long enough to hit prefix_token_target. Facts are planted as single spans.",
  "items": [
    {
      "id": "q01",
      "question": "What is the dock code for Pier North?",
      "expected_answer": "PN-17",
      "paraphrase": "Which code does Pier North use?"
    }
  ]
}
```

Twelve items. The document is synthetic and committed. Questions sit after the document in arms B and C. Arm A prepends `Trace {nonce}.` where `nonce` is `item_id-call_index-seed`, so it is reproducible.

The broken-prefix diagnostic uses items `q01` and `q02` with the question message before the document message.

`prefix_tokens_estimated` is written into the manifest at load time. The fixture fails closed if the estimate is under 2,048.

## Metrics schema

One JSON object per line in `artifacts/<run_id>/requests.jsonl`.

| Field | Type | Rule |
| --- | --- | --- |
| `schema_version` | 1 | |
| `run_id` | string | UTC timestamp plus short random |
| `lane` | `F` or `P` | |
| `arm` | string | `A-baseline`, `B-provider-cache`, `C-gateway-exact`, or a Lane F scenario id |
| `phase` | `warmup`, `steady`, `diagnostic`, `fault` | |
| `slice` | `unique`, `repeat`, `paraphrase`, `broken_prefix` | |
| `item_id` | string | |
| `seed` | 20261010 | |
| `model_id_requested` | string | Manifest pin |
| `model_id_served` | string | From the response or `x-litellm-model-id` |
| `prompt_cache_key` | string | |
| `prefix_tokens_estimated` | int | |
| `prompt_tokens` | int | |
| `cached_tokens` | int | From `usage.prompt_tokens_details.cached_tokens`, else 0 |
| `uncached_input_tokens` | int | Difference. Negative fails the row |
| `completion_tokens` | int | |
| `reasoning_tokens` | int | |
| `gateway_cache` | `miss`, `hit`, `bypass` | |
| `provider_called` | bool | False on gateway hit |
| `billable_usd` | number | 0 on gateway hit and on Lane F |
| `counterfactual_usd` | number | |
| `usd_proxy` | number | Header, else null |
| `usd_delta` | number | Provider calls only |
| `latency_ms` | int | Client send to full body |
| `status` | int | |
| `error_class` | `none`, `429`, `5xx`, `timeout`, `budget`, `other_4xx` | |
| `upstream_attempts` | int | Fault-provider counter. Null on Lane P |
| `fallback_used` | bool | |
| `retention_risk` | bool | |
| `response_sha256` | string | Of the message content |
| `fact_pass` | bool | |
| `cache_identity_pass` | bool or null | |

Lane F rows set `billable_usd` to 0 and may set `synthetic_usd` from the scripted usage and the price card. `synthetic_usd` is never added to the paid total.

Aggregate `report.json` per arm: `n`, token sums, `billable_usd`, p50/p95/p99 of `latency_ms` on successes, error rate, wall-clock rps, fact rate, gateway hit rate on the repeat slice, provider-cache hit rate on B steady (`cached_tokens > 0`), fallback success, amplification.

p99 on Lane P is printed with `n`. It is not a gate. Lane F is where percentiles have enough samples.

## Experiment manifest

File: `manifests/phase1-lane-p.yaml` and `manifests/phase1-lane-f.yaml`.

```yaml
schema_version: 1
experiment_id: phase1-three-arms
lane: P
seed: 20261010
model_id: gpt-4.1-mini-2025-04-14
inactive_models: [gpt-5-nano]
price_card_id: openai-standard-2026-10-10
fixture_id: qa-v1
concurrency: 1
temperature: 0
max_output_tokens: 64
limits:
  max_requests: 80
  max_estimated_usd: 1.50
  account_target_usd: 5.00
proxy:
  num_retries: 0
  request_timeout_seconds: 30
  fallbacks: []
arms:
  - id: A-baseline
    key_alias: p-nocache
    prefix_mode: unique_nonce
    prompt_cache_key_mode: unique
  - id: B-provider-cache
    key_alias: p-nocache
    prefix_mode: stable
    prompt_cache_key: routeforge-phase1
    calls_per_item: [warmup, steady]
    diagnostics: [broken_prefix]
  - id: C-gateway-exact
    key_alias: p-exact
    prefix_mode: stable
    prompt_cache_key: routeforge-phase1
    calls_per_item: [miss, exact_repeat]
    paraphrases: 4
```

The Lane F manifest sets `num_retries: 2`, `request_timeout_seconds: 2`, `allowed_fails: 2`, `cooldown_time_seconds: 30`, and lists scenarios instead of A/B/C.

The runner copies the manifest, the proxy config, the price card, and `docker compose config` output into `artifacts/<run_id>/snapshot/`.

## Price card

`prices/openai-standard-2026-10-10.json`:

| model_id | input / 1M | cached input / 1M | cache write / 1M | output / 1M | status |
| --- | --- | --- | --- | --- | --- |
| `gpt-4.1-mini-2025-04-14` | 0.40 | 0.10 | none | 1.60 | active |
| `gpt-5-nano` | 0.05 | 0.005 | none | 0.40 | inactive |

Source URL and fetch date sit next to the rates. The runner refuses a card whose date is missing or whose active model is inactive.

## Cost guardrails

These are ordered. None of them, alone, is an OpenAI hard cap.

### 1. Runner reservation

Before each send:

```text
estimate = (prefix_tokens + suffix_tokens) * 0.40 / 1e6
         + max_output_tokens * 1.60 / 1e6
```

Use the uncached input rate. If `committed + estimate > 1.50`, or `sent + 1 > 80`, do not send. Write a final row `error_class: budget` with `status: 0` and reason `runner_ceiling`.

After a provider response, replace that call's estimate with `billable_usd`. After a gateway hit, replace it with 0. After a transport error with no usage object, leave the estimate committed. The provider may have generated anyway.

### 2. Request and output caps

`max_tokens` in the payload is 64. The process exits if the manifest, the fixture, or the proxy config would allow more. This is the control that keeps a bug inside the account target: 80 requests at the model's 32,768-token output ceiling would be about 4.20 USD of output before input, and retries would pass 5 USD.

### 3. Proxy configuration

Lane P: `num_retries: 0`, no fallback, `disable_budget_reservation` left false, `allow_requests_on_db_unavailable` left false, `enforce_fallback_budget` left true. The runner hashes the config snapshot and aborts if those knobs differ.

A virtual key `max_budget` of 5.00 USD for the phase is a backstop inside LiteLLM's cost map. Validate only this behavior, on Lane F: a key whose spend is already over the limit produces a budget error and the fault provider's attempt counter stays 0. That shows the proxy can refuse. It does not show that OpenAI will refuse, that the cost map matches the invoice, or that a timed-out generation is unbilled.

LiteLLM's reservation is pre-request and can be turned off. Concurrent calls can pass a budget that was checked too early. Lane P concurrency is 1, which keeps that race out of the paid run. [Config settings](https://docs.litellm.ai/docs/proxy/config_settings).

Spend-log inserts can be batched. The runner must not poll Postgres to decide the next call. The local reservation is the stop.

### 4. Operator account limit

Set an OpenAI project usage limit of 5 USD before the first paid call. This plan does not validate how fast that limit propagates or whether in-flight requests are killed. Call it an operator control.

### Planned spend

Worst case uses a 4,096-token prefix, a 64-token suffix, 64 output tokens, no cache discount, and a live provider call.

```text
per live call = (4096 + 64) * 0.40 / 1e6 + 64 * 1.60 / 1e6
              = 0.001766 USD
```

| Step | Live calls | Worst-case USD |
| --- | --- | --- |
| Preflight, including one lengthening | 4 | 0.007 |
| Arm A | 12 | 0.021 |
| Arm B, with 2 diagnostics | 26 | 0.046 |
| Arm C provider calls (12 misses + 4 paraphrases) | 16 | 0.028 |
| Arm C exact repeats | 12 gateway hits | 0 |
| One scored invocation | 58 | 0.10 |
| One full rerun | 58 | 0.10 |
| Sum of planned paid work | | 0.20 |

At the 2,048-token prefix the same grid is about 0.11 USD. Expected arm B steady calls cost less than the worst case because cached input is 0.10 USD per 1M instead of 0.40.

The gap from 0.20 USD to the 5.00 USD target is margin for a failed preflight, a manual rerun, and a mistake that the runner ceiling cuts at 1.50 USD. Three invocations at the ceiling would be 4.50 USD. A fourth should wait for a human.

Lane F adds 0 USD.

## Lane F fault benchmark

The fault provider listens for OpenAI-shaped `POST /v1/chat/completions` and `GET /_stats`.

Script header `x-routeforge-scenario`. Body is still a normal chat request so LiteLLM's cache key behaves.

| Scenario id | Upstream behavior | Proxy settings | Pass |
| --- | --- | --- | --- |
| `exact-cache-repeat` | 200, fixed body and usage | cache key on, 1 client request then the same body | Second client call is a gateway hit. Upstream attempts equal 1. Bodies match |
| `fault-429` | Every call is 429 with `Retry-After: 1` | `num_retries: 2`, no fallback, 20 client calls | Client status 429. Amplification = 3.0. Upper bound `1 + num_retries` |
| `fault-500` | Primary always 500. Fallback deployment returns 200 | `num_retries: 2`, fallback configured, 20 client calls | Client 200, `fallback_used` true. Primary attempts = 60. Fallback attempts = 20 |
| `fault-timeout` | Primary sleeps 5s | `request_timeout` 2s, fallback 200, 10 client calls | Client 200 from fallback. Primary attempts equal `10 * (1 + num_retries)` |
| `fault-stampede` | 200 after 200ms | 20 concurrent identical bodies, cache flushed | Report upstream attempts. No pass line at 1 |
| `fault-budget` | 200 | Key already over `max_budget` | Client budget error. Upstream attempts = 0 |

The runner does not retry. A client-side retry would make amplification look like a proxy bug.

Timeout rows can still be billed on a real provider. That is why this scenario is local. The report says so.

Cooldown: after `fault-429`, a following call in the same minute may skip the cooled deployment. Give `fault-429` its own run id so it does not poison `fault-500`.

## Reproducibility

Each `artifacts/<run_id>/report.md` header includes:

| Pin | Source |
| --- | --- |
| Git commit | `git rev-parse HEAD`, or `dirty` if the tree is dirty |
| LiteLLM image digest | `docker image inspect` |
| Redis and Postgres image digests | Same |
| Node version | `process.version` |
| Seed | `20261010` |
| Model id | `gpt-4.1-mini-2025-04-14` |
| Price card | id, sha256, date `2026-10-10` |
| Fixture sha256 | Of `qa-v1.json` |
| Manifest sha256 | |
| Proxy config sha256 | The file actually mounted |
| Cache TTL, retries, timeout, allowed_fails, cooldown | From the snapshot |
| Redis flush | Boolean and logical DB |
| Concurrency | 1 on Lane P |
| Start and end timestamps | UTC |
| Gap statistics | Max seconds between B warmup and steady |

Temperature 0 and `seed` are necessary and not sufficient for bitwise identity across days. Arm C identity is against the first response in the same run.

Rebuild the markdown report from `requests.jsonl` and the price card with no network.

## Acceptance

### Minimum slice (Lane F)

- Compose comes up with pinned digests.
- `exact-cache-repeat`, `fault-429`, `fault-500`, `fault-timeout`, and `fault-budget` meet the table.
- `fault-stampede` writes an upstream count and does not fail the process for being greater than 1.
- Report header contains the pins.
- A Lane P dry-run with the allow flag unset exits non-zero before any socket to the proxy's OpenAI base.
- `gpt-5-nano` in a manifest exits non-zero.

### Paid slice (manual)

- Preflight shows `cached_tokens > 0` on the second call, or the run stops after the single lengthening attempt.
- Arms A, B, and C complete under 1.50 USD reserved, actual `billable_usd` reported.
- Arm C repeats are gateway hits, byte-identical, `billable_usd` 0.
- Arm B steady `cached_tokens` exceed arm A and exceed the broken-prefix diagnostic.
- Fact rate at least 11/12 per arm.
- Median absolute `usd_delta` on provider calls is under 1% of `billable_usd` or 0.0001 USD, whichever is larger.
- Sum of `billable_usd` across the phase's artifacts is under 5.00 USD.

## Backend value beyond stock LiteLLM

LiteLLM already caches, retries, prices a call, and stores spend. Phase 1 does not reimplement those.

The lab demonstrates the controls around them:

1. **Two caches, separated.** A gateway hit and a provider cache read are different bills. The three arms make that visible. A stock proxy will happily add them together.
2. **A price card that can disagree with the proxy.** `usd_delta` is a test of the cost map, not a log line to ignore.
3. **A stop that does not trust the gateway budget.** Reservation, request cap, and output cap sit in the client. The proxy limit is tested on a mock and described as a cost-map gate.
4. **Replay accounting.** Cached HTTP bodies contain old usage. The ledger zeroes them.
5. **Retry amplification as a measured ratio.** The fault provider is the only upstream counter. The client does not retry, so the ratio is the proxy's policy.
6. **An explicit non-result.** Stampede width, OpenAI's account limit, and GPT-4.1 mini cache eligibility are reported as measured or unvalidated, not implied by a feature flag.
7. **A cheaper model kept out.** GPT-5 nano is priced and rejected by the runner, so a future cohort cannot silently enter the baseline.

That is the engineering argument: policy, attribution, and fail-closed spend control around an unmodified gateway.

## Unresolved risks

| Risk | Why it is still open | Mitigation in this plan |
| --- | --- | --- |
| Cache floor on `gpt-4.1-mini` varies, and 24h retention is not listed for the mini id | Current guide versus the archived 1,024-token cookbook | 2,048-token target, one escalation to 4,096, 4-minute gap limit |
| `cached_tokens` rounds to 128 and omits hidden system tokens | [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) | Assert `> 0` and multiple of 128, not a specific count |
| `prompt_cache_key` does not pin a machine | Same guide | Nonce on arm A. Expect some B misses. Gate is "B steady greater than A", not 100% |
| Seed and temperature 0 are not a determinism contract | OpenAI best-effort seed | Grade the answer key. Require byte identity only within one arm C run |
| LiteLLM `max_budget` uses its cost map and can lag or race | [Config settings](https://docs.litellm.ai/docs/proxy/config_settings) | Runner reservation is the paid stop. Lane F proves refuse-when-exhausted only |
| OpenAI's 5 USD project limit is unvalidated | Not measured here | Operator sets it. The plan does not call it a hard cap |
| A client timeout on a real provider can still be billed | Generation may continue upstream | Timeouts are Lane F. Lane P timeout is 30s and retries are 0 |
| Snapshot `gpt-4.1-mini-2025-04-14` can be retired | Model lifecycle | Pin it. A 404 stops the run. Do not fall through to another model |
| Tokenizer estimate can differ from billed tokens | Hidden system prefix, message framing | Billed usage wins. Estimate is eligibility planning only |
| Gateway stampede behavior is unspecified | Spend-query coordinator is a different cache | Report Lane F upstream count |
| Fact rate depends on a small extractive set | 12 items, one model | 11/12 gate. A miss is a fixture or model failure, not a router result |
| Cents of savings look trivial next to a gateway product | Prefix is a few thousand tokens | Publish token classes and hit behavior. Do not advertise a percentage without the column split |

Confidence in the plan: high for the control design and the arithmetic. Medium for provider-cache hit rate until step 6.
