import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { amplification, classifyGatewayCache } from "./classify.ts";
import { sha256File, sha256Text } from "./hash.ts";
import { loadManifest, manifestPath, type Manifest } from "./manifest.ts";
import { repoRoot } from "./paths.ts";
import { assertModelActive, estimateReservationUsd, loadPriceCard, priceUsageUsd, type PriceCard } from "./price.ts";
import { inspectProxyConfig } from "./proxy-inspect.ts";
import { flushRedisDb } from "./redis.ts";
import { contentSha256, errorClass, percentile, renderReport, type RequestRow, type ScenarioSummary } from "./report.ts";
import { reserve, settle, type ReservationState } from "./reservation.ts";
import { accountAttempts, formatTimeline, type AttemptEvent } from "../fault-provider/events.ts";

const PROMPT_MARKER = "ROUTEFORGE_PROMPT_MARKER_do_not_log";
const SEED = 20261010;

interface Totals {
  total: number;
  primary: number;
  fallback: number;
}

interface ChatResult {
  status: number;
  body: string;
  latencyMs: number;
  cacheKey: string | null;
  semantic: string | null;
  modelId: string | null;
  responseCost: number | null;
  attemptedFallbacks: string | null;
  delta: Totals;
  late: number;
  timeline: string;
}

interface LaneContext {
  root: string;
  manifest: Manifest;
  card: PriceCard;
  proxyUrl: string;
  faultUrl: string;
  masterKey: string;
  keys: Record<string, string>;
  rows: RequestRow[];
  state: ReservationState;
  runId: string;
  notes: string[];
}

export async function runLaneF(options: { dryRun: boolean }): Promise<{ exitCode: number; runId: string; reportPath: string }> {
  const root = repoRoot();
  const manifestFile = manifestPath(root, "F");
  const manifest = loadManifest(manifestFile);
  const card = loadPriceCard(path.join(root, manifest.price_card_path));
  assertLaneFReady(root, manifest, card);
  const runId = `${options.dryRun ? "dry-run" : "lane-f"}-${timestamp()}`;
  const runDir = path.join(root, "artifacts", runId);
  mkdirSync(path.join(runDir, "snapshot"), { recursive: true });
  const configPath = path.join(root, manifest.proxy.config_path);
  const pins = JSON.parse(readText(path.join(root, "config", "image-pins.json")));
  copyFileSync(manifestFile, path.join(runDir, "snapshot", "manifest.yaml"));
  copyFileSync(configPath, path.join(runDir, "snapshot", "proxy.yaml"));
  copyFileSync(path.join(root, manifest.price_card_path), path.join(runDir, "snapshot", "price-card.json"));
  copyFileSync(path.join(root, "config", "image-pins.json"), path.join(runDir, "snapshot", "image-pins.json"));
  writeFileSync(path.join(runDir, "snapshot", "docker-compose-config.txt"), dockerComposeConfig(root), "utf8");

  const startedAt = new Date().toISOString();
  const scenarios: ScenarioSummary[] = [];
  const notes = [
    "Lane F billable_usd is 0. synthetic_usd is not added to the paid total.",
    "A gateway hit requires x-litellm-cache-key and zero new fault-provider attempts. Replayed usage is ignored.",
    "Stampede upstream attempts are recorded and are not required to equal 1.",
    "Router allowed_fails is 2. Measured deployments use model_info.allowed_fails 1000 so the retry loop is what the counters measure.",
    "lab-chat and lab-chat-fallback are separate model groups. lab-chat-retry has no fallback.",
    "Attempt counts come from append-only fault-provider events for one logical request id. Global counter deltas are not used.",
  ];
  let exitCode = 0;
  if (!options.dryRun) {
    const ctx = await connect(root, manifest, card, runId, notes);
    for (const id of [
      "exact-cache-repeat",
      "fault-429",
      "fault-500",
      "fault-timeout",
      "fault-stampede",
      "fault-budget",
    ] as const) {
      scenarios.push(await runScenario(ctx, id));
    }
    writeFileSync(path.join(runDir, "requests.jsonl"), ctx.rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    if (scenarios.some((scenario) => !scenario.pass)) exitCode = 1;
  } else {
    writeFileSync(path.join(runDir, "requests.jsonl"), "", "utf8");
    notes.push("Dry-run sent no requests.");
  }

  const report = renderReport({
    runId,
    lane: "F",
    startedAt,
    finishedAt: new Date().toISOString(),
    gitCommit: gitCommit(root),
    nodeVersion: process.version,
    pins,
    seed: manifest.seed,
    modelId: manifest.model_id,
    priceCardId: card.id,
    priceCardSha256: sha256File(path.join(root, manifest.price_card_path)),
    manifestSha256: sha256File(manifestFile),
    configSha256: sha256File(configPath),
    configPath: manifest.proxy.config_path,
    numRetries: manifest.proxy.num_retries,
    requestTimeoutSeconds: manifest.proxy.request_timeout_seconds,
    allowedFails: manifest.proxy.allowed_fails,
    effectiveDeploymentAllowedFails: manifest.proxy.effective_deployment_allowed_fails,
    cooldownSeconds: manifest.proxy.cooldown_time_seconds,
    redisFlushed: !options.dryRun,
    concurrency: manifest.concurrency,
    sendCount: options.dryRun ? 0 : scenarios.reduce((sum, scenario) => sum + scenario.client_requests, 0),
    billableUsd: 0,
    committedUsd: 0,
    scenarios,
    notes,
  });
  const reportPath = path.join(runDir, "report.md");
  writeFileSync(reportPath, report, "utf8");
  writeFileSync(
    path.join(runDir, "report.json"),
    JSON.stringify({ run_id: runId, billable_usd: 0, scenarios }, null, 2),
    "utf8",
  );
  process.stdout.write(`run_id=${runId}\nreport=${reportPath}\nsend_count=${options.dryRun ? 0 : scenarios.reduce((sum, scenario) => sum + scenario.client_requests, 0)}\n`);
  return { exitCode, runId, reportPath };
}

export function assertLaneFReady(root: string, manifest: Manifest, card: PriceCard): void {
  if (manifest.lane !== "F") throw new Error("Lane F manifest required");
  if (manifest.max_output_tokens !== 64) throw new Error("max_output_tokens must stay 64");
  if (manifest.seed !== SEED) throw new Error("seed must stay 20261010");
  if (card.id !== manifest.price_card_id) throw new Error("Price card id does not match the manifest");
  if (!card.fetched_on) throw new Error("Price card is missing fetched_on");
  for (const inactive of manifest.inactive_models) {
    const model = card.models[inactive];
    if (!model || model.status !== "inactive") throw new Error(`${inactive} must be inactive`);
  }
  assertModelActive(card, manifest.model_id);
  const configPath = path.join(root, manifest.proxy.config_path);
  const configText = readText(configPath);
  const hash = sha256Text(configText);
  if (hash !== manifest.proxy.config_sha256) {
    throw new Error(`Lane F config hash mismatch: ${hash}`);
  }
  const inspected = inspectProxyConfig(configText);
  if (inspected.numRetries.length !== 1 || inspected.numRetries[0] !== 2) {
    throw new Error("Lane F router num_retries must be the only retry setting and it must be 2");
  }
  const sdkRetries = [...configText.matchAll(/max_retries:\s*(\d+)/g)].map((match) => Number(match[1]));
  if (sdkRetries.length !== 3 || sdkRetries.some((value) => value !== 0)) {
    throw new Error("Each Lane F deployment must set max_retries: 0 so the OpenAI client does not retry inside the router loop");
  }
  if (!inspected.containsFaultProvider || inspected.containsOpenAiHost) {
    throw new Error("Lane F config must point at the fault provider only");
  }
  if (inspected.cacheMode !== "default_off" || inspected.storePrompts !== false || inspected.semanticCacheConfigured) {
    throw new Error("Lane F cache settings drifted");
  }
  if (inspected.redisDb !== 0 || inspected.fallbackCount < 1) throw new Error("Lane F router settings drifted");
  if (!inspected.modelNames.includes("lab-chat") || !inspected.modelNames.includes("lab-chat-fallback")) {
    throw new Error("Lane F model groups drifted");
  }
  if (!inspected.modelNames.includes("lab-chat-retry")) throw new Error("Lane F retry group is missing");
}

async function connect(
  root: string,
  manifest: Manifest,
  card: PriceCard,
  runId: string,
  notes: string[],
): Promise<LaneContext> {
  const proxyUrl = process.env.PROXY_URL ?? "http://127.0.0.1:4000";
  const faultUrl = process.env.FAULT_URL ?? "http://127.0.0.1:8080";
  const masterKey = process.env.LITELLM_MASTER_KEY ?? "sk-routeforge-local-master";
  const keys = JSON.parse(readText(process.env.KEYS_FILE ?? path.join(root, ".secrets", "keys.json"))) as Record<
    string,
    string
  >;
  for (const alias of ["f-nocache", "f-exact", "f-budget"]) {
    if (!keys[alias]) throw new Error(`Missing virtual key ${alias}. Run npm run bootstrap-keys.`);
  }
  const health = await fetch(`${proxyUrl}/health/liveliness`);
  if (!health.ok) throw new Error(`LiteLLM health returned ${health.status}`);
  const ping = await fetch(`${proxyUrl}/cache/ping`, { headers: { authorization: `Bearer ${masterKey}` } });
  if (!ping.ok) throw new Error(`LiteLLM /cache/ping returned ${ping.status}: ${await ping.text()}`);
  const fault = await fetch(`${faultUrl}/health`);
  if (!fault.ok) throw new Error(`Fault provider health returned ${fault.status}`);
  notes.push(`cache ping: ${(await ping.text()).slice(0, 300)}`);
  return {
    root,
    manifest,
    card,
    proxyUrl,
    faultUrl,
    masterKey,
    keys,
    rows: [],
    state: { committedUsd: 0, sent: 0 },
    runId,
    notes,
  };
}

async function runScenario(
  ctx: LaneContext,
  id: "exact-cache-repeat" | "fault-429" | "fault-500" | "fault-timeout" | "fault-stampede" | "fault-budget",
): Promise<ScenarioSummary> {
  await prepare(ctx, id === "fault-429" ? "429" : id === "fault-500" ? "500" : id === "fault-timeout" ? "timeout" : id === "fault-stampede" ? "stampede" : "success");
  if (id === "exact-cache-repeat") return exactCache(ctx);
  if (id === "fault-429") return repeated(ctx, id, { model: "lab-chat-retry", count: 20, expectStatus: 429, primary: 3, fallback: 0 });
  if (id === "fault-500") return repeated(ctx, id, { model: "lab-chat", count: 20, expectStatus: 200, primary: 3, fallback: 1 });
  if (id === "fault-timeout") return repeated(ctx, id, { model: "lab-chat", count: 10, expectStatus: 200, primary: 3, fallback: 1 });
  if (id === "fault-stampede") return stampede(ctx);
  return budget(ctx);
}

async function prepare(ctx: LaneContext, scenario: string): Promise<void> {
  await drainFaultProvider(ctx, 8000);
  const redisHost = process.env.REDIS_HOST ?? "127.0.0.1";
  const redisPort = Number(process.env.REDIS_PORT ?? "6379");
  await flushRedisDb(redisHost, redisPort, 0);
  const reset = await fetch(`${ctx.faultUrl}/_reset`, { method: "POST" });
  if (reset.status === 409) throw new Error(`Fault reset refused: ${await reset.text()}`);
  if (!reset.ok) throw new Error(`Fault reset failed: ${reset.status}`);
  const control = await fetch(`${ctx.faultUrl}/_control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario, scenario_id: `${ctx.runId}:${scenario}` }),
  });
  if (!control.ok) throw new Error(`Fault control failed: ${control.status}`);
}

async function exactCache(ctx: LaneContext): Promise<ScenarioSummary> {
  const failures: string[] = [];
  const content = `${PROMPT_MARKER} ${ctx.runId} Answer with the fixed token.`;
  const first = await send(ctx, {
    arm: "exact-cache-repeat",
    itemId: "exact-1",
    slice: "unique",
    model: "lab-chat",
    key: ctx.keys["f-exact"],
    requestId: "exact-1",
    user: "exact-cache-user",
    content,
    useCache: true,
  });
  const second = await send(ctx, {
    arm: "exact-cache-repeat",
    itemId: "exact-2",
    slice: "repeat",
    model: "lab-chat",
    key: ctx.keys["f-exact"],
    requestId: "exact-2",
    user: "exact-cache-user",
    content,
    useCache: true,
  });
  const spend = await fetch(`${ctx.proxyUrl}/spend/logs`, {
    headers: { authorization: `Bearer ${ctx.masterKey}` },
  });
  const spendBody = await spend.text();
  if (spendBody.includes(PROMPT_MARKER)) failures.push("spend logs contain the prompt marker");
  else ctx.notes.push(`spend logs status ${spend.status}; prompt marker absent`);

  check(first.status === 200 && first.delta.total === 1 && first.delta.primary === 1, "first exact call was not one primary attempt", failures);
  check(second.status === 200 && second.delta.total === 0, "repeat was not a zero-upstream call", failures);
  check(Boolean(second.cacheKey), "repeat did not return x-litellm-cache-key", failures);
  const hit = classifyGatewayCache({
    cacheEnabled: true,
    cacheKeyHeader: second.cacheKey,
    semanticSimilarityHeader: second.semantic,
    upstreamAttempts: second.delta.total,
  });
  check(hit === "hit", `repeat classified as ${hit}`, failures);
  check(assistantContent(first.body) === assistantContent(second.body) && assistantContent(second.body).length > 0, "cached bodies differ", failures);

  const nocacheA = await send(ctx, {
    arm: "exact-cache-repeat",
    itemId: "nocache-1",
    slice: "unique",
    model: "lab-chat",
    key: ctx.keys["f-nocache"],
    requestId: "nocache-1",
    user: "nocache-user-1",
    content,
    useCache: false,
  });
  const nocacheB = await send(ctx, {
    arm: "exact-cache-repeat",
    itemId: "nocache-2",
    slice: "unique",
    model: "lab-chat",
    key: ctx.keys["f-nocache"],
    requestId: "nocache-2",
    user: "nocache-user-2",
    content,
    useCache: false,
  });
  check(nocacheA.delta.total === 1 && nocacheB.delta.total === 1, "f-nocache without opt-in did not call upstream twice", failures);

  const shared = await send(ctx, {
    arm: "exact-cache-repeat",
    itemId: "shared-key",
    slice: "repeat",
    model: "lab-chat",
    key: ctx.keys["f-nocache"],
    requestId: "shared-key",
    user: "exact-cache-user",
    content,
    useCache: true,
  });
  check(shared.delta.total === 0 && Boolean(shared.cacheKey), "a second virtual key did not share the exact cache entry", failures);

  return summary("exact-cache-repeat", [first, second, nocacheA, nocacheB, shared], failures, "cache hit plus key-partition probe");
}

async function repeated(
  ctx: LaneContext,
  id: string,
  expected: { model: string; count: number; expectStatus: number; primary: number; fallback: number },
): Promise<ScenarioSummary> {
  const failures: string[] = [];
  const calls: ChatResult[] = [];
  for (let index = 0; index < expected.count; index += 1) {
    const call = await send(ctx, {
      arm: id,
      itemId: `${id}-${index + 1}`,
      slice: "unique",
      model: expected.model,
      key: ctx.keys["f-nocache"],
      requestId: `${id}-${index + 1}`,
      user: `${id}-user`,
      content: `${id} call ${index + 1}`,
      useCache: false,
    });
    calls.push(call);
    if (call.status !== expected.expectStatus) failures.push(`${id} call ${index + 1} status ${call.status}`);
    if (call.late > 0) {
      failures.push(`${id} call ${index + 1} continued upstream after the client finished: ${call.timeline}`);
    }
    if (call.delta.primary !== expected.primary || call.delta.fallback !== expected.fallback) {
      failures.push(
        `${id} call ${index + 1} attempts primary=${call.delta.primary} fallback=${call.delta.fallback}; ${call.timeline}`,
      );
    }
  }
  const primary = calls.reduce((sum, call) => sum + call.delta.primary, 0);
  const ratio = amplification(primary, calls.length);
  if (ratio !== expected.primary) failures.push(`${id} amplification ${ratio}`);
  return summary(id, calls, failures, `expected primary ${expected.primary} and fallback ${expected.fallback} per call`);
}

async function stampede(ctx: LaneContext): Promise<ScenarioSummary> {
  const failures: string[] = [];
  const content = `stampede ${ctx.runId}`;
  const calls = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      send(ctx, {
        arm: "fault-stampede",
        itemId: `stampede-${index + 1}`,
        slice: "repeat",
        model: "lab-chat",
        key: ctx.keys["f-exact"],
        requestId: `stampede-${index + 1}`,
        user: "stampede-user",
        content,
        useCache: true,
      }),
    ),
  );
  const upstream = calls.reduce((sum, call) => sum + call.delta.total, 0);
  if (calls.some((call) => call.semantic)) failures.push("stampede returned x-litellm-semantic-similarity");
  if (calls.some((call) => call.status !== 200)) failures.push("stampede client status was not all 200");
  if (calls.some((call) => call.late > 0)) failures.push(`stampede continued after the client finished; ${calls.find((call) => call.late > 0)?.timeline}`);
  if (upstream < 1) failures.push(`stampede recorded no upstream attempts; ${calls[0]?.timeline ?? "no timeline"}`);
  ctx.notes.push(`fault-stampede upstream attempts: ${upstream}. No single-flight assumption.`);
  return summary("fault-stampede", calls, failures, `upstream ${upstream}`);
}

async function budget(ctx: LaneContext): Promise<ScenarioSummary> {
  const failures: string[] = [];
  const call = await send(ctx, {
    arm: "fault-budget",
    itemId: "budget-1",
    slice: "unique",
    model: "lab-chat",
    key: ctx.keys["f-budget"],
    requestId: "budget-1",
    user: "budget-user",
    content: "budget should stop before upstream",
    useCache: false,
  });
  if (call.delta.total !== 0) failures.push(`budget call reached upstream ${call.delta.total} times`);
  if (!/budget/i.test(call.body)) failures.push(`budget call body was ${call.body.slice(0, 240)}`);
  if (call.status < 400) failures.push(`budget call status ${call.status}`);
  return summary("fault-budget", [call], failures, "pre-exhausted key");
}

async function send(
  ctx: LaneContext,
  input: {
    arm: string;
    itemId: string;
    slice: "unique" | "repeat";
    model: string;
    key: string;
    requestId: string;
    user: string;
    content: string;
    useCache: boolean;
  },
): Promise<ChatResult> {
  const estimateTokens = Math.ceil(input.content.length / 4);
  const estimate = estimateReservationUsd(ctx.card, ctx.manifest.model_id, estimateTokens, ctx.manifest.max_output_tokens);
  const decision = reserve(ctx.state, estimate);
  if (!decision.allowed) {
    throw new Error(`Runner ceiling stopped ${input.itemId}: ${decision.reason}`);
  }
  ctx.state.sent += 1;
  ctx.state.committedUsd = decision.committedUsd;
  const payload: Record<string, unknown> = {
    model: input.model,
    temperature: 0,
    seed: SEED,
    max_tokens: ctx.manifest.max_output_tokens,
    user: input.user,
    messages: [{ role: "user", content: input.content }],
  };
  if (input.useCache) payload.cache = { "use-cache": true };
  const started = Date.now();
  const response = await fetch(`${ctx.proxyUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.key}`,
      "content-type": "application/json",
      "x-routeforge-scenario": "ignored-when-control-set",
      "x-routeforge-scenario-id": `${ctx.runId}:${input.arm}`,
      "x-routeforge-request-id": input.requestId,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  const latencyMs = Date.now() - started;
  const finishedAt = new Date().toISOString();
  await fetch(`${ctx.faultUrl}/_client-finished`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ logical_request_id: input.requestId, finished_at: finishedAt }),
  });
  const events = await waitForAttempts(ctx, input.requestId);
  const accounted = accountAttempts(events, input.requestId);
  const delta = { total: accounted.total, primary: accounted.primary, fallback: accounted.fallback };
  const timeline = formatTimeline(events, input.requestId);
  const cacheKey = response.headers.get("x-litellm-cache-key");
  const semantic = response.headers.get("x-litellm-semantic-similarity");
  const usage = readUsage(body);
  const synthetic = usage
    ? priceUsageUsd(ctx.card, ctx.manifest.model_id, usage)
    : 0;
  ctx.state.committedUsd = settle(ctx.state.committedUsd, estimate, 0);
  const content = assistantContent(body);
  const row: RequestRow = {
    schema_version: 1,
    run_id: ctx.runId,
    lane: "F",
    arm: input.arm,
    phase: "fault",
    slice: input.slice,
    item_id: input.itemId,
    seed: SEED,
    model_id_requested: ctx.manifest.model_id,
    model_id_served: response.headers.get("x-litellm-model-id"),
    prompt_cache_key: "",
    prefix_tokens_estimated: estimateTokens,
    prompt_tokens: usage?.prompt_tokens ?? 0,
    cached_tokens: usage?.cached_tokens ?? 0,
    uncached_input_tokens: usage ? usage.prompt_tokens - usage.cached_tokens : 0,
    completion_tokens: usage?.completion_tokens ?? 0,
    reasoning_tokens: 0,
    gateway_cache: classifyGatewayCache({
      cacheEnabled: input.useCache,
      cacheKeyHeader: cacheKey,
      semanticSimilarityHeader: semantic,
      upstreamAttempts: delta.total,
    }),
    provider_called: delta.total > 0,
    billable_usd: 0,
    synthetic_usd: synthetic,
    counterfactual_usd: synthetic,
    usd_proxy: numberHeader(response.headers.get("x-litellm-response-cost")),
    usd_delta: null,
    latency_ms: latencyMs,
    status: response.status,
    error_class: errorClass(response.status, body),
    upstream_attempts: delta.total,
    fallback_used: delta.fallback > 0,
    retention_risk: false,
    response_sha256: contentSha256(content),
    fact_pass: null,
    cache_identity_pass: null,
  };
  ctx.rows.push(row);
  return {
    status: response.status,
    body,
    latencyMs,
    cacheKey,
    semantic,
    modelId: row.model_id_served,
    responseCost: row.usd_proxy,
    attemptedFallbacks: response.headers.get("x-litellm-attempted-fallbacks"),
    delta,
    late: accounted.late,
    timeline,
  };
}

async function waitForAttempts(ctx: LaneContext, logicalRequestId: string): Promise<AttemptEvent[]> {
  const deadline = Date.now() + 2000;
  let events = await readEvents(ctx);
  while (Date.now() < deadline) {
    const open = events.some(
      (event) => event.logical_request_id === logicalRequestId && event.completed_at === null,
    );
    if (!open) return events;
    await new Promise((resolve) => setTimeout(resolve, 100));
    events = await readEvents(ctx);
  }
  return events;
}

async function readEvents(ctx: LaneContext): Promise<AttemptEvent[]> {
  const response = await fetch(`${ctx.faultUrl}/_events`);
  if (!response.ok) throw new Error(`Fault events returned ${response.status}`);
  const body = (await response.json()) as { boot_id: string; events: AttemptEvent[] };
  if (ctx.notes.includes(`fault_boot_id=${body.boot_id}`) === false) {
    if (ctx.notes.some((note) => note.startsWith("fault_boot_id="))) {
      throw new Error(`Fault provider restarted during the run. Previous counts are not comparable. boot_id=${body.boot_id}`);
    }
    ctx.notes.push(`fault_boot_id=${body.boot_id}`);
  }
  return body.events;
}

async function drainFaultProvider(ctx: LaneContext, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${ctx.faultUrl}/_events`);
    if (!response.ok) throw new Error(`Fault events returned ${response.status}`);
    const body = (await response.json()) as { in_flight: number };
    if (body.in_flight === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Fault provider still has upstream calls open from the previous scenario");
}

function summary(id: string, calls: ChatResult[], failures: string[], detail: string): ScenarioSummary {
  const primary = calls.reduce((sum, call) => sum + call.delta.primary, 0);
  const fallback = calls.reduce((sum, call) => sum + call.delta.fallback, 0);
  const upstream = calls.reduce((sum, call) => sum + call.delta.total, 0);
  return {
    id,
    pass: failures.length === 0,
    client_requests: calls.length,
    upstream_attempts: upstream,
    primary_attempts: primary,
    fallback_attempts: fallback,
    amplification: calls.length === 0 ? null : amplification(upstream, calls.length),
    statuses: calls.map((call) => call.status),
    latency_ms_p50: percentile(calls.map((call) => call.latencyMs), 50),
    detail: failures.length === 0 ? detail : `${detail}; ${failures.join("; ")}`,
  };
}

function check(condition: boolean, message: string, failures: string[]): void {
  if (!condition) failures.push(message);
}

function assistantContent(body: string): string {
  try {
    const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> };
    return parsed.choices?.[0]?.message?.content ?? "";
  } catch {
    return "";
  }
}

function readUsage(body: string): { prompt_tokens: number; cached_tokens: number; completion_tokens: number } | null {
  try {
    const parsed = JSON.parse(body) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    if (!parsed.usage) return null;
    return {
      prompt_tokens: parsed.usage.prompt_tokens ?? 0,
      completion_tokens: parsed.usage.completion_tokens ?? 0,
      cached_tokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
    };
  } catch {
    return null;
  }
}

function numberHeader(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readText(file: string): string {
  return readFileSync(file, "utf8");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function gitCommit(root: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return "not-a-git-repo";
  return result.stdout.trim();
}

function dockerComposeConfig(root: string): string {
  const result = spawnSync("docker", ["compose", "config"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    return `docker compose config unavailable\n${result.stderr || result.stdout || "docker not on PATH"}`;
  }
  return result.stdout;
}
