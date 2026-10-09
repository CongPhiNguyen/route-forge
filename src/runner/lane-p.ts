import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256Text } from "./hash.ts";
import { loadManifest, manifestPath } from "./manifest.ts";
import { assertPaidLane } from "./paid-guard.ts";
import { repoRoot } from "./paths.ts";
import { inspectProxyConfig } from "./proxy-inspect.ts";

export function refuseLaneP(env: NodeJS.ProcessEnv = process.env): void {
  const root = repoRoot();
  const manifest = loadManifest(manifestPath(root, "P"));
  const configText = readFileSync(path.join(root, manifest.proxy.config_path), "utf8");
  const inspected = inspectProxyConfig(configText);
  assertPaidLane({
    lane: manifest.lane,
    allowPaid: env.ROUTEFORGE_ALLOW_PAID,
    configHash: sha256Text(configText),
    expectedHash: manifest.proxy.config_sha256,
    numRetries: inspected.numRetries,
    deploymentCount: inspected.modelNames.length,
    fallbackCount: inspected.fallbackCount,
    containsOpenAiHost: inspected.containsOpenAiHost,
  });
}
