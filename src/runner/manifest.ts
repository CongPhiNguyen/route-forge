import { readFileSync } from "node:fs";
import path from "node:path";
import { parseYaml, type Yaml } from "./yaml.ts";

export interface Manifest {
  schema_version: number;
  experiment_id: string;
  lane: "F" | "P";
  seed: number;
  model_id: string;
  inactive_models: string[];
  price_card_id: string;
  price_card_path: string;
  concurrency: number;
  temperature: number;
  max_output_tokens: number;
  limits: {
    max_requests: number;
    max_estimated_usd: number;
    account_target_usd: number;
  };
  proxy: {
    config_path: string;
    config_sha256: string;
    num_retries: number;
    request_timeout_seconds: number;
    allowed_fails: number;
    effective_deployment_allowed_fails: number;
    cooldown_time_seconds: number;
    fallbacks: string[];
  };
}

export function loadManifest(file: string): Manifest {
  const parsed = parseYaml(readFileSync(file, "utf8"));
  const proxy = asMap(parsed.proxy, "proxy");
  const limits = asMap(parsed.limits, "limits");
  const lane = String(parsed.lane);
  if (lane !== "F" && lane !== "P") throw new Error(`Unsupported lane ${lane}`);
  return {
    schema_version: asNumber(parsed.schema_version, "schema_version"),
    experiment_id: String(parsed.experiment_id),
    lane,
    seed: asNumber(parsed.seed, "seed"),
    model_id: String(parsed.model_id),
    inactive_models: asStringList(parsed.inactive_models),
    price_card_id: String(parsed.price_card_id),
    price_card_path: String(parsed.price_card_path),
    concurrency: asNumber(parsed.concurrency, "concurrency"),
    temperature: asNumber(parsed.temperature, "temperature"),
    max_output_tokens: asNumber(parsed.max_output_tokens, "max_output_tokens"),
    limits: {
      max_requests: asNumber(limits.max_requests, "max_requests"),
      max_estimated_usd: asNumber(limits.max_estimated_usd, "max_estimated_usd"),
      account_target_usd: asNumber(limits.account_target_usd, "account_target_usd"),
    },
    proxy: {
      config_path: String(proxy.config_path),
      config_sha256: String(proxy.config_sha256),
      num_retries: asNumber(proxy.num_retries, "num_retries"),
      request_timeout_seconds: asNumber(proxy.request_timeout_seconds, "request_timeout_seconds"),
      allowed_fails: asNumber(proxy.allowed_fails, "allowed_fails"),
      effective_deployment_allowed_fails: asNumber(
        proxy.effective_deployment_allowed_fails ?? 0,
        "effective_deployment_allowed_fails",
      ),
      cooldown_time_seconds: asNumber(proxy.cooldown_time_seconds, "cooldown_time_seconds"),
      fallbacks: asStringList(proxy.fallbacks),
    },
  };
}

export function manifestPath(root: string, lane: "F" | "P"): string {
  return path.join(root, "manifests", lane === "F" ? "phase1-lane-f.yaml" : "phase1-lane-p.yaml");
}

function asMap(value: Yaml | undefined, label: string): { [key: string]: Yaml } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a map`);
  }
  return value;
}

function asNumber(value: Yaml | undefined, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number`);
  return value;
}

function asStringList(value: Yaml | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}
