import assert from "node:assert/strict";
import test from "node:test";
import { createFaultServer } from "../src/fault-provider/server.ts";
import type { AddressInfo } from "node:net";

test("direct fault-provider call increments the request counter", async () => {
  const server = createFaultServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fetch(`${base}/_control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "429", latency_ms: 0 }),
    });
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-routeforge-request-id": "direct-1",
        "x-routeforge-role": "primary",
      },
      body: JSON.stringify({ model: "gpt-4.1-mini-2025-04-14", messages: [{ role: "user", content: "ping" }] }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "1");
    const stats = (await (await fetch(`${base}/_events`)).json()) as {
      boot_id: string;
      events: { attempt_id: number; logical_request_id: string; role: string; status: number }[];
      requests: { "direct-1": { total: number; primary: number } };
    };
    assert.equal(typeof stats.boot_id, "string");
    assert.equal(stats.events.length, 1);
    assert.equal(stats.events[0]?.logical_request_id, "direct-1");
    assert.equal(stats.events[0]?.status, 429);
    assert.equal(stats.requests["direct-1"].total, 1);
    assert.equal(stats.requests["direct-1"].primary, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
