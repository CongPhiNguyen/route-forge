# RouteForge

Local reliability lab for a stock LiteLLM Proxy. This slice runs Lane F only: Redis exact-cache behavior, retries, fallback, timeout, stampede measurement, and a pre-exhausted virtual key. It does not call a paid provider.

The gateway is LiteLLM `v1.104.2`. The runner and the fault provider are TypeScript. Lane P is a config file and a deny path. `ROUTEFORGE_ALLOW_PAID=1` is required before that path will even consider a paid config, and this slice still does not send Lane P.

## Stack

| Service | Pin |
| --- | --- |
| LiteLLM Proxy | `ghcr.io/berriai/litellm:v1.104.2` |
| Redis | `redis:7.4.7-alpine` |
| PostgreSQL | `postgres:16.11-alpine` |
| Fault provider base | `node:22.22.2-bookworm-slim` |

Digests are in `config/image-pins.json` and `docker-compose.yml`. Node on the host needs to be 22.22 or newer.

## Start

From the repo root, with Docker available:

```powershell
docker compose up -d --build
npm run bootstrap-keys
npm test
npm run lane-f
```

`npm run dry-run` writes `artifacts/<run_id>/report.md` and does not send a request.

Bootstrap talks only to the local proxy. It writes `.secrets/keys.json` (gitignored) for `f-nocache`, `f-exact`, `f-budget`, `p-nocache`, and `p-exact`. `f-budget` is updated so `spend` is already above `max_budget`.

Lane F listens on `http://127.0.0.1:4000`. The fault provider listens on `http://127.0.0.1:8080`. Redis is DB 0. Lane P would use Redis DB 1 and is not started.

If Docker is the engine inside WSL rather than on the Windows PATH:

```powershell
wsl -d Ubuntu -- bash -lc "cd /mnt/c/phi-nguyen/route-forge && docker compose up -d --build"
npm run bootstrap-keys
npm run lane-f
```

## What Lane F checks

| Scenario | Pass |
| --- | --- |
| `exact-cache-repeat` | Second identical cache-on call is a hit: `x-litellm-cache-key` is set and the fault provider records no new attempt. Bodies match. `f-nocache` without the opt-in flag calls upstream both times. |
| `fault-429` | 20 client calls, each status 429, each with 3 upstream attempts. Amplification 3.0. No fallback. |
| `fault-500` | 20 client calls, each 200 from the fallback. Primary attempts 60, fallback attempts 20. |
| `fault-timeout` | 10 client calls. Primary sleeps 5s with a 2s deployment timeout. Primary attempts 30, fallback attempts 10, client 200. |
| `fault-stampede` | 20 concurrent identical cache-on calls after a Redis flush. The upstream count is reported. It is not required to be 1. |
| `fault-budget` | `f-budget` is already over `max_budget`. The client gets a budget error and the fault provider stays at 0 attempts. |

The report is `artifacts/<run_id>/report.md` plus `requests.jsonl`. `billable_usd` is 0. `synthetic_usd` is not added to a paid total.

A hit is never inferred from replayed `usage`. The runner requires the cache-key header and a zero attempt delta together.

## Config conflict recorded for v1.104.2

Details are in [docs/plan/litellm-v1.104.2-validation.md](docs/plan/litellm-v1.104.2-validation.md).

- Exact Redis cache keys do not include the virtual key. Cache opt-in is the request field `cache.use-cache` because the proxy cache mode is `default_off`.
- Two deployments under one `model_name` are load-balanced. Lane F uses model group `lab-chat` with fallback group `lab-chat-fallback`. `fault-429` calls `lab-chat-retry`, which has no fallback, so the client stays on 429.
- Router `allowed_fails` stays 2, matching ADR 005. Each measured deployment sets `model_info.allowed_fails: 1000` so a 20-call window measures the retry loop instead of cooling the only primary off the rotation. The report prints both numbers.

## Direct fault provider

```powershell
curl.exe -D - http://127.0.0.1:8080/v1/chat/completions -H "content-type: application/json" -H "x-routeforge-scenario: 429" -H "x-routeforge-request-id: demo" -d "{\"model\":\"gpt-4.1-mini-2025-04-14\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"
curl.exe http://127.0.0.1:8080/_stats
```

`POST /_control` with `{"scenario":"500","latency_ms":0}` sets the mode used when the proxy does not forward the scenario header. `GET /_stats` is keyed by `x-routeforge-request-id`.

## Paid lane

```powershell
npm run lane-p
```

Unset `ROUTEFORGE_ALLOW_PAID` exits 2 before any socket. Setting it to `1` still exits 2 in this slice: Lane P execution is not implemented. Do not put a real `OPENAI_API_KEY` in the environment for these commands.

## Out of scope

Lane P traffic, semantic cache, custom model routing, OpenTelemetry, k6, Kubernetes, and a UI.
