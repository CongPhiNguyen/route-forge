import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256Text } from "./hash.ts";
import { loadManifest, manifestPath, type Manifest } from "./manifest.ts";
import { assertPaidLane } from "./paid-guard.ts";
import { repoRoot } from "./paths.ts";
import { assertModelActive, loadPriceCard } from "./price.ts";
import { inspectProxyConfig } from "./proxy-inspect.ts";
import { INVOCATION_CEILING_USD, MAX_REQUESTS } from "./reservation.ts";

export function assertLanePManifest(manifest: Manifest): void {
  if (manifest.lane !== "P") throw new Error("Lane P manifest required");
  if (manifest.max_output_tokens !== 64) throw new Error("max_output_tokens must stay 64");
  if (manifest.concurrency !== 1) throw new Error("Lane P concurrency must stay 1");
  if (manifest.temperature !== 0) throw new Error("temperature must stay 0");
  if (manifest.seed !== 20261010) throw new Error("seed must stay 20261010");
  if (manifest.model_id !== "gpt-4.1-mini-2025-04-14") throw new Error("Lane P model pin drifted");
  if (manifest.limits.max_requests !== MAX_REQUESTS) throw new Error("max_requests drifted from the reservation cap");
  if (manifest.limits.max_estimated_usd !== INVOCATION_CEILING_USD) {
    throw new Error("max_estimated_usd drifted from the reservation ceiling");
  }
  if (manifest.limits.account_target_usd !== 5) throw new Error("account_target_usd must stay 5");
  if (manifest.proxy.num_retries !== 0) throw new Error("Lane P manifest num_retries must stay 0");
  if (manifest.proxy.fallbacks.length !== 0) throw new Error("Lane P manifest fallbacks must stay empty");
}

export function refuseLaneP(env: NodeJS.ProcessEnv = process.env): void {
  const root = repoRoot();
  const manifest = loadManifest(manifestPath(root, "P"));
  assertLanePManifest(manifest);
  const card = loadPriceCard(path.join(root, manifest.price_card_path));
  if (card.id !== manifest.price_card_id) throw new Error("Price card id does not match the manifest");
  for (const inactive of manifest.inactive_models) {
    const model = card.models[inactive];
    if (!model || model.status !== "inactive") throw new Error(`${inactive} must be inactive`);
  }
  assertModelActive(card, manifest.model_id);
  const configText = readFileSync(path.join(root, manifest.proxy.config_path), "utf8");
  const inspected = inspectProxyConfig(configText);
  if (inspected.disablesBudgetReservation || inspected.allowsRequestsOnDbUnavailable || inspected.disablesFallbackBudget) {
    throw new Error("Lane P must fail closed on budget reservation, database loss, and fallback budget");
  }
  if (inspected.semanticCacheConfigured || inspected.storePrompts !== false || inspected.cacheMode !== "default_off") {
    throw new Error("Lane P cache settings drifted");
  }
  if (inspected.redisDb !== 1 || inspected.containsFaultProvider) {
    throw new Error("Lane P must use Redis DB 1 and must not point at the fault provider");
  }
  assertPaidLane({
    lane: manifest.lane,
    allowPaid: env.ROUTEFORGE_ALLOW_PAID,
    configHash: sha256Text(configText),
    expectedHash: manifest.proxy.config_sha256,
    numRetries: inspected.numRetries,
    deploymentCount: inspected.modelNames.length,
    fallbackCount: inspected.fallbackCount,
    containsOpenAiHost: inspected.containsOpenAiHost,
    deploymentMaxRetries: inspected.deploymentMaxRetries,
  });
}
