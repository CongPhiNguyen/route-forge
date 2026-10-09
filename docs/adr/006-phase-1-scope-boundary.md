# ADR 006: Phase 1 scope boundary

Status: Accepted (provisional, 2026-10-10)

## Context

The research list of later slices (semantic cache, Auto Router, LLMLingua-2, streaming, agents, Kubernetes) is large enough to hide the absence of a measured result.

## Decision

Phase 1 does not include:

- Semantic cache, embeddings, or a vector database
- Auto Router, RouteLLM, `cost-based-routing`, or any call to `gpt-5-nano`
- Prompt compression
- Kubernetes, a UI, SSO, or an Enterprise license
- Streaming, tools, images, or multi-turn conversations
- A judge model
- Direct provider calls from the runner
- Load tests against the paid endpoint

The first runnable slice is Lane F: exact-cache repeat, 429 amplification, 500 fallback, timeout, and a pre-exhausted key. Lane P is implemented behind `ROUTEFORGE_ALLOW_PAID=1` and is a manual step.

## Consequences

- The portfolio claim for phase 1 is measurement and control of two caches plus retry amplification, on top of an unmodified gateway.
- A feature that needs one of the excluded items waits for a new ADR.

## Alternatives

Starting with the router or the compressor would spend the budget before the harness can explain a token column.

## Evidence

[implementation-roadmap.md](../research/implementation-roadmap.md), locked decisions in the Phase 1 request.

Confidence: high.
