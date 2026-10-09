import { sha256Text } from "./hash.ts";
import type { GatewayCache } from "./classify.ts";

export interface RequestRow {
  schema_version: 1;
  run_id: string;
  lane: "F" | "P";
  arm: string;
  phase: "fault";
  slice: "unique" | "repeat";
  item_id: string;
  seed: 20261010;
  model_id_requested: string;
  model_id_served: string | null;
  prompt_cache_key: string;
  prefix_tokens_estimated: number;
  prompt_tokens: number;
  cached_tokens: number;
  uncached_input_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  gateway_cache: GatewayCache;
  provider_called: boolean;
  billable_usd: number;
  synthetic_usd: number;
  counterfactual_usd: number;
  usd_proxy: number | null;
  usd_delta: number | null;
  latency_ms: number;
  status: number;
  error_class: "none" | "429" | "5xx" | "timeout" | "budget" | "other_4xx";
  upstream_attempts: number;
  fallback_used: boolean;
  retention_risk: false;
  response_sha256: string;
  fact_pass: null;
  cache_identity_pass: boolean | null;
}

export interface ScenarioSummary {
  id: string;
  pass: boolean;
  client_requests: number;
  upstream_attempts: number;
  primary_attempts: number;
  fallback_attempts: number;
  amplification: number | null;
  statuses: number[];
  latency_ms_p50: number | null;
  detail: string;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function errorClass(status: number, body: string): RequestRow["error_class"] {
  if (/budget/i.test(body)) return "budget";
  if (status === 429) return "429";
  if (status >= 500) return "5xx";
  if (status === 408 || /timeout|timed out/i.test(body)) return "timeout";
  if (status >= 400) return "other_4xx";
  return "none";
}

export function contentSha256(content: string): string {
  return sha256Text(content);
}

export function renderReport(input: {
  runId: string;
  lane: string;
  startedAt: string;
  finishedAt: string;
  gitCommit: string;
  nodeVersion: string;
  pins: unknown;
  seed: number;
  modelId: string;
  priceCardId: string;
  priceCardSha256: string;
  manifestSha256: string;
  configSha256: string;
  configPath: string;
  numRetries: number;
  requestTimeoutSeconds: number;
  allowedFails: number;
  effectiveDeploymentAllowedFails: number;
  cooldownSeconds: number;
  redisFlushed: boolean;
  concurrency: number;
  sendCount: number;
  billableUsd: number;
  committedUsd: number;
  scenarios: ScenarioSummary[];
  notes: string[];
}): string {
  const lines = [
    `# RouteForge ${input.runId}`,
    "",
    "## Pins",
    "",
    `- Git commit: ${input.gitCommit}`,
    `- Node: ${input.nodeVersion}`,
    `- Started: ${input.startedAt}`,
    `- Finished: ${input.finishedAt}`,
    `- Lane: ${input.lane}`,
    `- Seed: ${input.seed}`,
    `- Model id: ${input.modelId}`,
    `- Price card: ${input.priceCardId} \`${input.priceCardSha256}\``,
    `- Manifest sha256: \`${input.manifestSha256}\``,
    `- Proxy config: ${input.configPath} \`${input.configSha256}\``,
    `- num_retries: ${input.numRetries}`,
    `- request_timeout_seconds: ${input.requestTimeoutSeconds}`,
    `- router allowed_fails: ${input.allowedFails}`,
    `- effective deployment allowed_fails: ${input.effectiveDeploymentAllowedFails}`,
    `- cooldown_time_seconds: ${input.cooldownSeconds}`,
    `- Redis flushed between scenarios: ${input.redisFlushed}`,
    `- Concurrency: ${input.concurrency}`,
    `- Client sends: ${input.sendCount}`,
    `- billable_usd: ${input.billableUsd}`,
    `- committed_usd: ${input.committedUsd}`,
    "",
    "Image pins:",
    "",
    "```json",
    JSON.stringify(input.pins, null, 2),
    "```",
    "",
    "## Scenarios",
    "",
    "| Scenario | Pass | Clients | Upstream | Primary | Fallback | Amplification | p50 latency ms | Statuses |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const scenario of input.scenarios) {
    lines.push(
      `| ${scenario.id} | ${scenario.pass ? "pass" : "fail"} | ${scenario.client_requests} | ${scenario.upstream_attempts} | ${scenario.primary_attempts} | ${scenario.fallback_attempts} | ${formatAmp(scenario.amplification)} | ${scenario.latency_ms_p50 ?? ""} | ${scenario.statuses.join(",")} |`,
    );
  }
  lines.push("", "## Notes", "");
  for (const note of input.notes) lines.push(`- ${note}`);
  if (input.scenarios.length === 0) lines.push("- No client requests were sent.");
  lines.push("");
  return lines.join("\n");
}

function formatAmp(value: number | null): string {
  if (value === null) return "";
  return Number.isInteger(value) ? value.toFixed(1) : String(Math.round(value * 1000) / 1000);
}
