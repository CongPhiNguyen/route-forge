# ADR 003: GPT-4.1 mini baseline, five-dollar target, runner stop

Status: Accepted (provisional, 2026-10-10)

## Context

Phase 1 has to show real token prices. Free-tier capacity is not a cost baseline. The account target is 5 USD for all real API experiments in this phase, including one rerun and a short preflight.

## Decision

- Paid model id: `gpt-4.1-mini-2025-04-14`. The alias `gpt-4.1-mini` is not the pin. Default snapshot on the model page fetched 2026-10-10 is that dated id. [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini).
- Price card `openai-standard-2026-10-10`, standard tier, per 1M tokens: input 0.40 USD, cached input 0.10 USD, cache write none, output 1.60 USD. [Pricing](https://developers.openai.com/api/docs/pricing).
- `gpt-5-nano` is on the same card as an inactive future cohort (input 0.05, cached input 0.005, output 0.40 per 1M). The runner rejects any manifest that selects it.
- Lane P runner ceiling is 1.50 USD per invocation. Planned live calls reserve about 0.10 USD at the escalated prefix. The 5 USD figure is the account target across invocations, not the per-run ceiling.
- Lane P `num_retries` is 0. Fault amplification is Lane F only.
- `max_tokens` is 64. The runner refuses to start if the manifest says otherwise.
- Max client requests per Lane P invocation: 80.
- Reservation uses the uncached input rate plus the full output cap. Cache discounts are not assumed.
- A LiteLLM virtual-key spend limit of 5 USD is a second layer. It is not an OpenAI invoice cap. See the guardrail section in [phase-1.md](../plan/phase-1.md).

## Consequences

- Dollar savings on this fixture will be cents. The result that matters is the token-class split and a zero bill on gateway hits.
- A proxy cost map that disagrees with the price card shows up as `usd_delta` and fails the cost-identity gate.
- GPT-4.1 mini is an "earlier model" in OpenAI's prompt-cache guide: no cache-write premium, implicit caching only, and `cached_tokens` rounded down to a multiple of 128. The extended-retention footnote names `gpt-4.1` and does not name `gpt-4.1-mini`. Phase 1 assumes in-memory lifetime (typically 5–10 minutes idle). [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Alternatives

| Option | Why it lost |
| --- | --- |
| GPT-5 nano as the baseline | Locked as a future cheaper cohort. Mixing it into arm A changes the model, which is a different experiment. |
| A 150-call-per-arm paid design from the research draft | Still cheap on this model, and it spends the rerun margin if `max_tokens` or retries leak. The smaller manifest keeps the method and the ceiling. |
| Treating `max_budget` as a hard invoice stop | Unvalidated. The provider can bill work the proxy never records. |

## Evidence

Pricing and cache rules fetched 2026-10-10 from the two OpenAI pages above. Cookbook 201 (archived, pre-GPT-5.6) describes a 1,024-token floor and 128-token increments. The current guide says the floor for earlier models varies by request settings, so eligibility is a preflight, not an assumption. [Cookbook](https://developers.openai.com/cookbook/examples/prompt_caching_201).

Confidence: high on the published rates. Medium on cache eligibility until the two-call preflight returns `cached_tokens > 0`.
