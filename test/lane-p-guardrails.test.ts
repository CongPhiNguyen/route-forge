import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyGatewayCache } from "../src/runner/classify.ts";
import { accountAttempts, type AttemptEvent } from "../src/fault-provider/events.ts";
import { assertLanePManifest, refuseLaneP } from "../src/runner/lane-p.ts";
import { loadManifest, manifestPath } from "../src/runner/manifest.ts";
import { PaidDeniedError } from "../src/runner/paid-guard.ts";
import { repoRoot } from "../src/runner/paths.ts";
import { incrementalProviderUsd, loadPriceCard, priceUsageUsd } from "../src/runner/price.ts";
import { inspectProxyConfig } from "../src/runner/proxy-inspect.ts";
import { INVOCATION_CEILING_USD, MAX_REQUESTS, reserve, settle } from "../src/runner/reservation.ts";

const root = repoRoot();
const manifest = loadManifest(manifestPath(root, "P"));
const card = loadPriceCard(path.join(root, manifest.price_card_path));
const configText = readFileSync(path.join(root, manifest.proxy.config_path), "utf8");

test("Lane P defaults to denial and opens no paid execution in this slice", () => {
  assert.throws(() => refuseLaneP({}), (error: unknown) => {
    return error instanceof PaidDeniedError && error.message === "ROUTEFORGE_ALLOW_PAID is not 1";
  });
  for (const flag of ["", "true", "yes", "0"]) {
    assert.throws(() => refuseLaneP({ ROUTEFORGE_ALLOW_PAID: flag }), /ROUTEFORGE_ALLOW_PAID is not 1/);
  }
  assert.throws(() => refuseLaneP({ ROUTEFORGE_ALLOW_PAID: "1" }), /not part of this slice/);
});

test("Lane P manifest pins the model, output cap, request cap, and ceilings", () => {
  assertLanePManifest(manifest);
  assert.equal(manifest.model_id, "gpt-4.1-mini-2025-04-14");
  assert.deepEqual(manifest.inactive_models, ["gpt-5-nano"]);
  assert.equal(manifest.max_output_tokens, 64);
  assert.equal(manifest.limits.max_requests, MAX_REQUESTS);
  assert.equal(MAX_REQUESTS, 80);
  assert.equal(manifest.limits.max_estimated_usd, INVOCATION_CEILING_USD);
  assert.equal(INVOCATION_CEILING_USD, 1.5);
  assert.equal(manifest.limits.account_target_usd, 5);
  assert.equal(manifest.concurrency, 1);
  assert.equal(card.models["gpt-4.1-mini-2025-04-14"].cache_write_per_million, null);
  assert.throws(() => assertLanePManifest({ ...manifest, max_output_tokens: 128 }), /max_output_tokens/);
  assert.throws(() => assertLanePManifest({ ...manifest, model_id: "gpt-5-nano" }), /model pin/);
});

test("Lane P config is one OpenAI deployment with SDK retries pinned at 0", () => {
  const inspected = inspectProxyConfig(configText);
  assert.deepEqual(inspected.modelNames, ["lab-chat"]);
  assert.deepEqual(inspected.numRetries, [0, 0]);
  assert.deepEqual(inspected.deploymentMaxRetries, [0]);
  assert.equal(inspected.fallbackCount, 0);
  assert.equal(inspected.fallbacksEmpty, true);
  assert.equal(inspected.redisDb, 1);
  assert.equal(inspected.containsOpenAiHost, true);
  assert.equal(inspected.containsFaultProvider, false);
  assert.equal(inspected.cacheMode, "default_off");
  assert.equal(inspected.disablesBudgetReservation, false);
  assert.equal(inspected.allowsRequestsOnDbUnavailable, false);
  assert.equal(inspected.disablesFallbackBudget, false);
  const laneF = inspectProxyConfig(readFileSync(path.join(root, "config/litellm-lane-f.yaml"), "utf8"));
  assert.equal(laneF.redisDb, 0);
  assert.notEqual(laneF.redisDb, inspected.redisDb);
});

test("reservation uses the uncached rate and does not assume a cache discount", () => {
  const estimate = (4096 + 64) * 0.4 / 1_000_000 + 64 * 1.6 / 1_000_000;
  assert.equal(estimate, 0.0017664);
  const decision = reserve({ committedUsd: 0, sent: 0 }, estimate);
  assert.equal(decision.allowed, true);
  assert.equal(decision.committedUsd, estimate);
  const overCeiling = reserve({ committedUsd: 1.5, sent: 0 }, estimate);
  assert.equal(overCeiling.allowed, false);
  assert.equal(overCeiling.reason, "runner_ceiling_usd");
  const overCount = reserve({ committedUsd: 0, sent: 80 }, estimate);
  assert.equal(overCount.allowed, false);
  assert.equal(overCount.reason, "runner_ceiling_requests");
});

test("prompt-cache tokens are priced once and a gateway hit adds zero provider spend", () => {
  const usage = { prompt_tokens: 2176, cached_tokens: 2048, completion_tokens: 64 };
  const priced = priceUsageUsd(card, manifest.model_id, usage);
  const expected = (128 * 0.4 + 2048 * 0.1 + 64 * 1.6) / 1_000_000;
  assert.equal(priced, expected);
  assert.ok(Math.abs(priced - 0.0003584) < 1e-12);
  const doubleCounted = (2176 * 0.4 + 2048 * 0.1 + 64 * 1.6) / 1_000_000;
  assert.ok(priced < doubleCounted);
  assert.throws(
    () => priceUsageUsd(card, manifest.model_id, { prompt_tokens: 100, cached_tokens: 128, completion_tokens: 1 }),
    /cached_tokens exceed prompt_tokens/,
  );

  const gateway = classifyGatewayCache({
    cacheEnabled: true,
    cacheKeyHeader: "routeforge-lane-p:example",
    semanticSimilarityHeader: null,
    upstreamAttempts: 0,
  });
  assert.equal(gateway, "hit");
  assert.equal(incrementalProviderUsd(gateway, priced), 0);
  const estimate = 0.0017664;
  const reserved = reserve({ committedUsd: 0, sent: 0 }, estimate);
  assert.equal(settle(reserved.committedUsd, estimate, incrementalProviderUsd(gateway, priced)), 0);
  assert.equal(settle(reserved.committedUsd, estimate, incrementalProviderUsd("miss", priced)), priced);
  assert.equal(settle(reserved.committedUsd, estimate, null), estimate);
});

test("the 5 USD account target is recorded and is not enforced inside one reservation state machine", () => {
  const first = reserve({ committedUsd: 0, sent: 0 }, 1.5);
  const second = reserve({ committedUsd: 0, sent: 0 }, 1.5);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(manifest.limits.account_target_usd, 5);
});

test("append-only events attribute attempts by logical request id", () => {
  const events: AttemptEvent[] = [
    {
      attempt_id: 1,
      boot_id: "boot",
      scenario_id: "paid-shape",
      logical_request_id: "preflight-1",
      role: "primary",
      scenario: "success",
      arrived_at: "2026-10-10T00:00:00.000Z",
      completed_at: "2026-10-10T00:00:00.100Z",
      client_finished_at: "2026-10-10T00:00:00.200Z",
      status: 200,
    },
    {
      attempt_id: 2,
      boot_id: "boot",
      scenario_id: "paid-shape",
      logical_request_id: "preflight-2",
      role: "primary",
      scenario: "success",
      arrived_at: "2026-10-10T00:00:01.000Z",
      completed_at: "2026-10-10T00:00:01.100Z",
      client_finished_at: null,
      status: 200,
    },
  ];
  assert.equal(accountAttempts(events, "preflight-1").total, 1);
  assert.equal(accountAttempts(events, "preflight-2").total, 1);
  assert.equal(accountAttempts(events, "missing").total, 0);
});

test("the paid fixture and Lane P execution artifacts are not in this slice", () => {
  assert.equal(existsSync(path.join(root, "fixtures", "qa-v1.json")), false);
  const guard = readFileSync(path.join(root, "src/runner/paid-guard.ts"), "utf8");
  assert.match(guard, /Lane P execution is not part of this slice/);
  const manifestText = readFileSync(manifestPath(root, "P"), "utf8");
  assert.match(manifestText, /A-baseline/);
  assert.match(manifestText, /B-provider-cache/);
  assert.match(manifestText, /C-gateway-exact/);
});
