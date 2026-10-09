# ADR 001: Stock LiteLLM Proxy is the gateway

Status: Accepted (provisional, 2026-10-10)

## Context

RouteForge needs a multi-provider OpenAI-compatible proxy with exact response caching, retries, fallbacks, virtual keys, and a spend ledger. The research pass compared LiteLLM, Portkey, Kong AI Gateway, and Bifrost against current docs. See [existing-solutions.md](../research/existing-solutions.md).

## Decision

Phase 1 uses unmodified LiteLLM Proxy, open-source image, no Enterprise license key, no fork.

The proxy owns provider I/O, virtual-key auth, Redis exact cache, retries, cooldowns, fallbacks, and Postgres spend rows. The lab does not add a second proxy.

## Consequences

- The request path includes a Python service. TypeScript stays in the experiment runner and the local fault provider.
- Semantic cache, Auto Router, and `cost-based-routing` across unequal models stay disabled. Those features exist upstream and would blur the three-arm comparison.
- Proxy upgrades are image bumps. Custom single-flight or routing belongs in a later ADR if a measurement shows a gap.

## Alternatives

| Option | Why it lost |
| --- | --- |
| Portkey Gateway OSS | Strong TypeScript gateway. Budgeted keys, retention, and semantic cache sit on product plans. New air-gapped installs are closed. |
| Bifrost | Apache-2.0 and a clear cache/fallback metric model. Different spend ledger, and semantic cache is out of phase 1. |
| Kong AI Gateway | Open-source AI Proxy is single-target. The routing, semantic cache, and compression policies are Enterprise. |
| Custom Node gateway | Rebuilds adapters and failover that LiteLLM already ships. |

## Evidence

- [LiteLLM caching](https://docs.litellm.ai/docs/proxy/caching), [fallbacks](https://docs.litellm.ai/docs/proxy/reliability), [virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys), [enterprise boundary](https://docs.litellm.ai/docs/enterprise)
- License: MIT, [BerriAI/litellm](https://github.com/BerriAI/litellm)

Confidence: high on capability fit. The language split is an accepted cost.
