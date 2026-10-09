import { readFileSync } from "node:fs";
import path from "node:path";
import { accountAttempts, formatTimeline, type AttemptEvent } from "../src/fault-provider/events.ts";
import { flushRedisDb } from "../src/runner/redis.ts";
import { repoRoot } from "../src/runner/paths.ts";

const mode = process.argv[2];
const proxy = process.env.LITELLM_BASE_URL ?? "http://127.0.0.1:4000";
const fault = process.env.FAULT_PROVIDER_URL ?? "http://127.0.0.1:8080";
const runId = `repro-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;

interface Keys {
  "f-exact": string;
  "f-nocache": string;
}

async function main(): Promise<void> {
  if (mode !== "429" && mode !== "cache" && mode !== "stampede") {
    throw new Error("usage: scripts/repro.ts 429|cache|stampede");
  }
  const keys = JSON.parse(readFileSync(path.join(repoRoot(), ".secrets", "keys.json"), "utf8")) as Keys;
  await drain();
  await flushRedisDb(process.env.REDIS_HOST ?? "127.0.0.1", Number(process.env.REDIS_PORT ?? "6379"), 0);
  const reset = await fetch(`${fault}/_reset`, { method: "POST" });
  if (!reset.ok) throw new Error(`reset ${reset.status}: ${await reset.text()}`);
  if (mode === "429") await run429(keys["f-exact"]);
  if (mode === "cache") await runCache(keys);
  if (mode === "stampede") await runStampede(keys["f-exact"]);
}

async function run429(key: string): Promise<void> {
  await control("429");
  const id = `${runId}-429`;
  const started = Date.now();
  const response = await chat(key, "lab-chat-retry", id, `${runId} one 429`, false);
  const finishedAt = new Date().toISOString();
  await finished(id, finishedAt);
  const events = await eventsFor(id);
  const count = accountAttempts(events, id);
  const timeline = formatTimeline(events, id);
  process.stdout.write(
    `status=${response.status} latency_ms=${Date.now() - started} primary=${count.primary} fallback=${count.fallback} late=${count.late}\n${timeline}\n`,
  );
  if (response.status !== 429 || count.primary !== 3 || count.fallback !== 0 || count.late !== 0) {
    throw new Error("single 429 did not make exactly 3 primary arrivals");
  }
}

async function runCache(keys: Keys): Promise<void> {
  await control("success");
  const body = `${runId} exact cache body`;
  const first = await chat(keys["f-exact"], "lab-chat", `${runId}-exact-1`, body, true);
  await finished(`${runId}-exact-1`, new Date().toISOString());
  const second = await chat(keys["f-exact"], "lab-chat", `${runId}-exact-2`, body, true);
  await finished(`${runId}-exact-2`, new Date().toISOString());
  const plain = await chat(keys["f-nocache"], "lab-chat", `${runId}-plain`, body, false);
  await finished(`${runId}-plain`, new Date().toISOString());
  const shared = await chat(keys["f-nocache"], "lab-chat", `${runId}-shared`, body, true);
  await finished(`${runId}-shared`, new Date().toISOString());
  const events = await allEvents();
  const lines = ["exact-1", "exact-2", "plain", "shared"].map((name) => {
    const id = `${runId}-${name}`;
    const count = accountAttempts(events, id);
    return `${name} status_header_cache=${name === "exact-1" ? first.cache : name === "exact-2" ? second.cache : name === "plain" ? plain.cache : shared.cache} upstream=${count.total} ${formatTimeline(events, id)}`;
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  const firstCount = accountAttempts(events, `${runId}-exact-1`).total;
  const secondCount = accountAttempts(events, `${runId}-exact-2`).total;
  const plainCount = accountAttempts(events, `${runId}-plain`).total;
  const sharedCount = accountAttempts(events, `${runId}-shared`).total;
  if (first.status !== 200 || firstCount !== 1 || secondCount !== 0 || !second.cache || plainCount !== 1 || sharedCount !== 0 || !shared.cache) {
    throw new Error("exact cache isolation did not match one upstream, one confirmed hit, one bypass, and one shared-key hit");
  }
}

async function runStampede(key: string): Promise<void> {
  await control("stampede");
  const body = `${runId} stampede body`;
  const calls = await Promise.all(
    Array.from({ length: 20 }, (_, index) => chat(key, "lab-chat", `${runId}-stampede-${index + 1}`, body, true)),
  );
  await Promise.all(calls.map((call) => finished(call.id, new Date().toISOString())));
  const events = await allEvents();
  const total = events.filter((event) => event.logical_request_id.startsWith(`${runId}-stampede-`)).length;
  const unattributed = events.filter((event) => event.logical_request_id === "unattributed").length;
  process.stdout.write(`clients=${calls.length} statuses=${calls.map((call) => call.status).join(",")} upstream=${total} unattributed=${unattributed}\n`);
  if (calls.some((call) => call.status !== 200) || total < 1 || unattributed !== 0) {
    throw new Error("stampede did not record attributed upstream arrivals");
  }
}

async function control(scenario: string): Promise<void> {
  const response = await fetch(`${fault}/_control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario, scenario_id: runId }),
  });
  if (!response.ok) throw new Error(`control ${response.status}`);
}

async function chat(
  key: string,
  model: string,
  id: string,
  content: string,
  useCache: boolean,
): Promise<{ id: string; status: number; cache: string | null }> {
  const response = await fetch(`${proxy}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-routeforge-request-id": id,
      "x-routeforge-scenario-id": runId,
    },
    body: JSON.stringify({
      model,
      user: "repro-user",
      temperature: 0,
      max_tokens: 64,
      messages: [{ role: "user", content }],
      ...(useCache ? { cache: { "use-cache": true } } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  await response.text();
  return { id, status: response.status, cache: response.headers.get("x-litellm-cache-key") };
}

async function finished(id: string, finishedAt: string): Promise<void> {
  await fetch(`${fault}/_client-finished`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ logical_request_id: id, finished_at: finishedAt }),
  });
}

async function eventsFor(id: string): Promise<AttemptEvent[]> {
  const deadline = Date.now() + 2000;
  let events = await allEvents();
  while (Date.now() < deadline && events.some((event) => event.logical_request_id === id && event.completed_at === null)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    events = await allEvents();
  }
  return events;
}

async function allEvents(): Promise<AttemptEvent[]> {
  const response = await fetch(`${fault}/_events`);
  if (!response.ok) throw new Error(`events ${response.status}`);
  const body = (await response.json()) as { events: AttemptEvent[] };
  return body.events;
}

async function drain(): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const response = await fetch(`${fault}/_events`);
    if (!response.ok) throw new Error(`events ${response.status}`);
    const body = (await response.json()) as { in_flight: number };
    if (body.in_flight === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("fault provider still has open calls");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
