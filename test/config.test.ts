import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadManifest, manifestPath } from "../src/runner/manifest.ts";
import { repoRoot } from "../src/runner/paths.ts";
import { inspectProxyConfig } from "../src/runner/proxy-inspect.ts";
import { sha256File } from "../src/runner/hash.ts";

const root = repoRoot();

test("Lane F and Lane P configs match their manifest hashes and cannot be mixed", () => {
  const laneF = loadManifest(manifestPath(root, "F"));
  const laneP = loadManifest(manifestPath(root, "P"));
  const fText = readFileSync(path.join(root, laneF.proxy.config_path), "utf8");
  const pText = readFileSync(path.join(root, laneP.proxy.config_path), "utf8");
  assert.equal(sha256File(path.join(root, laneF.proxy.config_path)), laneF.proxy.config_sha256);
  assert.equal(sha256File(path.join(root, laneP.proxy.config_path)), laneP.proxy.config_sha256);
  assert.notEqual(laneF.proxy.config_sha256, laneP.proxy.config_sha256);

  const f = inspectProxyConfig(fText);
  assert.deepEqual(f.numRetries, [2]);
  assert.equal([...fText.matchAll(/max_retries:\s*0/g)].length, 3);
  assert.equal(f.cacheMode, "default_off");
  assert.equal(f.storePrompts, false);
  assert.equal(f.semanticCacheConfigured, false);
  assert.equal(f.containsFaultProvider, true);
  assert.equal(f.containsOpenAiHost, false);
  assert.equal(f.redisDb, 0);
  assert.equal(f.fallbackCount, 1);
  assert.deepEqual(f.deploymentAllowedFails, [1000, 1000, 1000]);
  assert.equal(f.routerAllowedFails, 2);

  const p = inspectProxyConfig(pText);
  assert.deepEqual(p.modelNames, ["lab-chat"]);
  assert.deepEqual(p.numRetries, [0, 0]);
  assert.equal(p.fallbackCount, 0);
  assert.equal(p.fallbacksEmpty, true);
  assert.equal(p.containsOpenAiHost, true);
  assert.equal(p.containsFaultProvider, false);
  assert.equal(p.redisDb, 1);
  assert.deepEqual(p.deploymentMaxRetries, [0]);
  assert.equal(p.disablesBudgetReservation, false);
  assert.equal(p.allowsRequestsOnDbUnavailable, false);
  assert.equal(p.disablesFallbackBudget, false);
  assert.equal(p.cacheMode, "default_off");
  assert.equal(p.storePrompts, false);
  assert.equal(p.semanticCacheConfigured, false);
});

test("compose image references match the pin file", () => {
  const pins = JSON.parse(readFileSync(path.join(root, "config", "image-pins.json"), "utf8")) as {
    images: Record<string, string>;
  };
  const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const dockerfile = readFileSync(path.join(root, "Dockerfile.fault-provider"), "utf8");
  assert.match(compose, new RegExp(pins.images.litellm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(compose, new RegExp(pins.images.redis.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(compose, new RegExp(pins.images.postgres.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(dockerfile, new RegExp(pins.images.fault_provider_base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
