import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { InactiveModelError, assertModelActive, estimateReservationUsd, incrementalProviderUsd, loadPriceCard, priceUsageUsd } from "../src/runner/price.ts";
import { repoRoot } from "../src/runner/paths.ts";

const card = loadPriceCard(path.join(repoRoot(), "prices", "openai-standard-2026-10-10.json"));

test("price card rejects inactive gpt-5-nano", () => {
  assert.equal(card.id, "openai-standard-2026-10-10");
  assert.equal(card.fetched_on, "2026-10-10");
  assert.throws(() => assertModelActive(card, "gpt-5-nano"), InactiveModelError);
});

test("reservation estimate uses the uncached input rate", () => {
  const estimate = estimateReservationUsd(card, "gpt-4.1-mini-2025-04-14", 4160, 64);
  assert.ok(Math.abs(estimate - 0.0017664) < 1e-9);
});

test("usage price splits cached input and does not bill a gateway hit by itself", () => {
  const priced = priceUsageUsd(card, "gpt-4.1-mini-2025-04-14", {
    prompt_tokens: 12,
    cached_tokens: 0,
    completion_tokens: 4,
  });
  assert.ok(Math.abs(priced - (12 * 0.4 + 4 * 1.6) / 1_000_000) < 1e-12);
  assert.equal(incrementalProviderUsd("hit", priced), 0);
  assert.equal(incrementalProviderUsd("miss", priced), priced);
});
